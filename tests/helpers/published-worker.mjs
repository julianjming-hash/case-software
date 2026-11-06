// A real local workerd with a Node-side outbound PostgREST fake for browser tests.
// All outgoing hosts are refused except the in-memory fake; no Supabase project is contacted.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { knownAccountFake } from './admin-account-fixture.mjs';
import { FIXTURE, TEST_JWT_SECRET } from './local-worker.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

export async function startPublishedWorker({ authOrigin = null, publishableKey = true, admin = null,
  caseDocument = FIXTURE, pilotPin = false, secondVersion = false, catalogue = [], art = null, media = null,
  // Facilitator-UX A4: more known accounts, extra bindings, the JWT's email, and a hook for other local outbound hosts.
  actors = [], bindings = {}, email = null, outbound = null } = {}) {
  const userId = uuidv7(), workspaceId = uuidv7(), versionId = uuidv7(), caseId = uuidv7();
  const secondVersionId = secondVersion ? uuidv7() : null;
  const documentText = JSON.stringify(caseDocument);
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentText)));
  // Catalogue fields (card 29) come from the case document, as the SQL reads them.
  const library = { summary: caseDocument.summary ?? null, audience: caseDocument.audience ?? null,
    setting: caseDocument.setting ?? null, duration_min: [15, 45].includes(caseDocument.duration_min) ? caseDocument.duration_min : null,
    learning_objectives: caseDocument.learning_objectives ?? [], workspace_id: workspaceId };
  const fake = knownAccountFake({ actors:[userId, ...actors], origin: authOrigin ?? 'https://postgrest.test', versions: [{
    version_id: versionId, case_id: caseId, title: 'Published case', version_no: 1,
    published_at: new Date().toISOString(), content_sha256: `\\x${hash}`, ...library,
  }, ...(secondVersion ? [{ version_id: secondVersionId, case_id: uuidv7(),
    title: 'Other published case', version_no: 1,
    published_at: new Date(Date.now() - 1000).toISOString(), content_sha256: `\\x${hash}`, ...library }] : []),
    // Extra catalogue rows (card 29 library tests): public library fields only, in this workspace.
    ...catalogue.map(row => ({ workspace_id: workspaceId, content_sha256: `\\x${hash}`, ...row }))] });
  // get_me answers the admin flag the Worker asked with (card 35): an admin sees the workspace as 'admin'.
  fake.replies.set('get_me', args => [{ user_id: userId, display_name: 'Facilitator',
    memberships: [{ workspace_id: workspaceId, role: args.p_admin ? 'admin' : 'owner' }], next_after: null, admin: args.p_admin === true }]);
  fake.replies.set('get_case_version_for_workspace', [{ case_id: caseId, version_no: 1,
    schema_version: caseDocument.schema_version ?? 1, document_text: documentText, document: caseDocument,
    content_sha256: `\\x${hash}`, art }]);
  const bundle = await build({ entryPoints: [`${ROOT}/src/worker/index.mjs`], bundle: true,
    format: 'esm', platform: 'neutral', target: 'es2022', write: false,
    external: ['cloudflare:workers'], loader: { '.sql': 'text' } });
  // Port 0: workerd binds an OS-assigned port and reports it. A probed-then-released port can be taken first
  // ("bind(): Address already in use" on main CI, 2026-10-16).
  const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, rootPath: ROOT,
    script: bundle.outputFiles[0].text, modules: true,
    compatibilityDate: '2026-08-22',
    bindings: { BUILD_SHA: 'a'.repeat(40), SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
      CASE_ALLOW_HS256: '1', CASE_DEV_INLINE_CASES: '0', BROADCAST_COALESCE_MS: '0', LOCK_GRACE_MS: '0', AUTO_LOCK_MS: '0',
      ...(pilotPin ? { CASE_PILOT_VERSION_ID: versionId, CASE_PILOT_CONTENT_SHA256: `\\x${hash}` } : {}),
      ...(admin ? {ADMIN_EMAILS:admin.email,STEPUP_SECRET:admin.stepupSecret,CASE_PUBLIC_ORIGIN:admin.origin} : {}),
      SUPABASE_URL: authOrigin ?? 'https://postgrest.test/', SUPABASE_SECRET_KEY: 'sb_secret_test_only',
      ...(authOrigin ? { SUPABASE_JWT_ISSUER: `${authOrigin}/auth/v1`,
        SUPABASE_JWKS_URL: `${authOrigin}/auth/v1/.well-known/jwks.json`,
        ...(publishableKey ? { SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' } : {}) } : {}), ...bindings },
    // Card 59 M3: a locally simulated MEDIA bucket (never a Cloudflare account).
    r2Buckets: ['MEDIA'],
    durableObjects: { ROOM: { className: 'RoomDO', useSQLite: true },
      DIRECTORY: { className: 'DirectoryDO', useSQLite: true } },
    outboundService: async request => {
      const extra = outbound ? await outbound(request) : null;
      if (extra) return extra;
      if (new URL(request.url).origin !== (authOrigin ?? 'https://postgrest.test'))
        throw new Error('Unexpected outbound host in published Worker test');
      return fake.fetchImpl(request.url, { method: request.method, headers: request.headers,
        body: await request.text(), signal: request.signal, redirect: request.redirect });
    },
  }));
  try {
    const origin = (await mf.ready).origin;
    if (media) {
      fake.replies.set('room_media_manifest', media.rows(workspaceId));
      const bucket = await mf.getR2Bucket('MEDIA');
      for (const [key, bytes] of Object.entries(media.objects(workspaceId))) await bucket.put(key, bytes);
    }
    const sessionId = uuidv7();
    const jwt = await signTestJwt({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: sessionId,
      email: email ?? admin?.email ?? 'owner@example.invalid',
      ...(authOrigin ? { iss: `${authOrigin}/auth/v1` } : {}),
      exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_JWT_SECRET);
    return { origin, userId, sessionId, workspaceId, versionId, caseId, secondVersionId,
      contentSha256: `\\x${hash}`, jwt, fake, stop: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
