// AS-203 (facilitator-UX A4, discovery §1): the deployed configuration supplies every variable and binding the Worker
// reads, per environment. The invite defect was a Worker read of CASE_TEACHING_WORKSPACE_ID that no environment ever
// deployed, and unit tests always injected it. Here every `env.NAME` read in src/worker is either declared in that
// environment's wrangler.toml section (vars and bindings), a modelled secret (set with `wrangler secret put`, named in
// docs/SETUP-SECRETS.md), an intended absence for that environment, or a test-only switch. Then the invite runs in a real
// workerd with exactly the production vars wrangler.toml deploys, and a fake for every outbound host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { uuidv7 } from '../src/shared/ids.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
const secretsDoc = readFileSync(join(ROOT, 'docs/SETUP-SECRETS.md'), 'utf8');

/** A minimal reader for the shapes wrangler.toml uses: [table], [[array.of.tables]], and key = "string" | other. */
function parseToml(text) {
  const tables = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const header = /^(\[\[?)([A-Za-z0-9_.-]+)\]\]?$/.exec(line);
    if (header) { current = { path: header[2], array: header[1] === '[[', values: {} }; tables.push(current); continue; }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current.values[pair[1]] = /^"([^"]*)"$/.exec(pair[2])?.[1] ?? pair[2];
  }
  return tables;
}
const TABLES = parseToml(toml);

/** What one deployed environment declares: its vars (name → value) and its binding names. */
function declared(envName) {
  const prefix = `env.${envName}.`;
  const vars = Object.fromEntries(Object.entries(TABLES.find(t => t.path === `${prefix}vars`)?.values ?? {}));
  const bindings = new Set();
  for (const table of TABLES) {
    if (!table.path.startsWith(prefix)) continue;
    const kind = table.path.slice(prefix.length);
    if (kind === 'ratelimits' || kind === 'durable_objects.bindings') bindings.add(table.values.name);
    if (['r2_buckets', 'analytics_engine_datasets', 'assets'].includes(kind)) bindings.add(table.values.binding);
  }
  return { vars, bindings };
}

/**
 * Secrets Julian sets per environment (docs/SETUP-SECRETS.md §1). `required` ones must exist before that environment
 * works at all; the rest are optional features that degrade to a stated fallback when unset.
 */
const SECRETS = Object.freeze({
  production: { required: ['SUPABASE_SECRET_KEY', 'STEPUP_SECRET'],
    optional: ['DEPLOY_GUARD_TOKEN', 'TURNSTILE_SECRET_KEY', 'ALERT_EMAIL_TO', 'RESEND_ALERT_API_KEY', 'HEALTHCHECK_PING_URL', 'RESEND_INVITE_API_KEY'] },
  staging: { required: ['SUPABASE_SECRET_KEY'],
    optional: ['STEPUP_SECRET', 'DEPLOY_GUARD_TOKEN', 'TURNSTILE_SECRET_KEY', 'ALERT_EMAIL_TO', 'RESEND_ALERT_API_KEY', 'HEALTHCHECK_PING_URL', 'RESEND_INVITE_API_KEY'] },
});
/** Deliberately not deployed in that environment, with why. The Worker must treat each as "off". */
const ABSENT = Object.freeze({
  production: {},
  staging: {
    INCIDENT_ADMIN_EMAILS: 'no restricted incident administrator designated',
    ADMIN_EMAILS: 'staging admins are a separate, deliberate choice (CASE-137); none yet',
    CASE_REFUSED_ROOM_WORKSPACES: 'the Load testing workspace may start rooms on staging (AS-100)',
  },
});
/** Local tests and dev only; never deployed (tests/wrangler-config.test.mjs and SETUP-SECRETS). */
const TEST_ONLY = Object.freeze({ CASE_ALLOW_HS256: 'local HS256 tokens', SUPABASE_JWT_SECRET: 'local HS256 tokens',
  CASE_REQUEST_DEADLINE_MS: 'a shorter local request deadline for tests' });

function workerFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? workerFiles(path) : name.endsWith('.mjs') ? [path] : [];
  });
}
/** Every NAME the Worker reads as env.NAME / env?.NAME / this.env.NAME, with the files that read it. */
function workerReads() {
  const reads = new Map();
  for (const file of workerFiles(join(ROOT, 'src/worker'))) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)\b/g)) {
      if (!reads.has(name)) reads.set(name, new Set());
      reads.get(name).add(file.slice(ROOT.length));
    }
  }
  return reads;
}

test('[AS-203] every variable and binding the Worker reads is deployed, a modelled secret, or a stated absence, per environment', () => {
  const reads = workerReads();
  assert.ok(reads.size > 20, 'the scan finds the Worker\'s reads');
  for (const envName of ['production', 'staging']) {
    const { vars, bindings } = declared(envName);
    const secrets = new Set([...SECRETS[envName].required, ...SECRETS[envName].optional]);
    for (const [name, files] of reads) {
      const known = Object.hasOwn(vars, name) || bindings.has(name) || secrets.has(name) || Object.hasOwn(ABSENT[envName], name) || Object.hasOwn(TEST_ONLY, name);
      assert.ok(known, `${envName}: the Worker reads env.${name} (${[...files].join(', ')}) but ${envName} neither deploys it, models it as a secret, nor states its absence`);
      assert.ok(!(Object.hasOwn(vars, name) && secrets.has(name)), `${envName}: ${name} is both a committed var and a secret (a deploy would blank the secret)`);
      assert.ok(!(Object.hasOwn(TEST_ONLY, name) && Object.hasOwn(vars, name)), `${envName}: test-only ${name} is deployed`);
    }
    // A stated absence is really absent, and every modelled secret is never a committed var.
    for (const name of Object.keys(ABSENT[envName])) assert.ok(!Object.hasOwn(vars, name), `${envName}: ${name} is declared absent but deployed`);
  }
});

test('[AS-203] every modelled secret is named in docs/SETUP-SECRETS.md, and the retired teaching workspace is read nowhere', () => {
  for (const name of new Set([...SECRETS.production.required, ...SECRETS.production.optional, ...SECRETS.staging.optional]))
    assert.match(secretsDoc, new RegExp(`\`${name}\``), `docs/SETUP-SECRETS.md does not name ${name}`);
  assert.ok(!workerReads().has('CASE_TEACHING_WORKSPACE_ID'), 'CASE-339 retired CASE_TEACHING_WORKSPACE_ID: invitations name their workspace');
  // The invitation page's peek limiter is a binding in both environments, in Case's namespace range.
  for (const envName of ['production', 'staging']) assert.ok(declared(envName).bindings.has('INVITE_PEEK'), `${envName} lacks INVITE_PEEK`);
});

// ── The invite under exactly the production vars (discovery §1 repro) ──────────────────────────────────────────────
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function es256Token(claims) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'deploy-config', alg: 'ES256', use: 'sig' };
  const input = `${encode({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return { jwk, token: `${input}.${Buffer.from(signature).toString('base64url')}` };
}

async function deployedWorker({ secrets }) {
  const { vars } = declared('production');
  const supabase = new URL(vars.SUPABASE_URL).origin;
  const admin = vars.ADMIN_EMAILS.split(',')[0].trim(), adminId = uuidv7(), workspaceId = uuidv7(), invitationId = uuidv7();
  const { jwk, token } = await es256Token({ sub: adminId, email: admin, aud: 'authenticated', role: 'authenticated', iss: vars.SUPABASE_JWT_ISSUER,
    session_id: uuidv7(), exp: Math.floor(Date.now() / 1000) + 3600 });
  const seen = [], emails = [];
  const outbound = async request => {
    const url = new URL(request.url);
    if (url.href === vars.SUPABASE_JWKS_URL) return Response.json({ keys: [jwk] });
    if (url.origin === 'https://api.resend.com' && url.pathname === '/emails') { emails.push(await request.json()); return Response.json({ id: 'fake' }); }
    if (url.origin !== supabase) throw new Error(`unexpected outbound host ${url.origin}`);
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'GET') return Response.json({ users: [] });
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') { const body = await request.json(); seen.push('createUser');
      return Response.json({ id: uuidv7(), email: body.email, email_confirmed_at: new Date().toISOString() }); }
    const name = url.pathname.replace('/rest/v1/rpc/', ''), args = await request.json();
    seen.push(name);
    if (name === 'admin_account_active') return Response.json(true);
    if (name === 'get_me') return Response.json([{ user_id: adminId, display_name: 'Julian', next_after: null, admin: true, facilitator_role: null,
      label_confirmed_at: null, memberships: [{ workspace_id: workspaceId, slug: 'ws', name: 'Northern ICU', role: 'admin', policies: {} }], grants: [] }]);
    if (name === 'create_invitation') return Response.json({ outcome: 'created', invitationId, email: args.p_email, level: args.p_level, workspaceId,
      workspaceName: 'Northern ICU', caseId: null, caseTitle: null, inviterName: 'Julian Ming', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    if (name === 'record_invitation_delivery') return Response.json({ outcome: 'recorded', sendState: args.p_outcome });
    return Response.json({ code: 'PGRST202', message: 'not in this fake' }, { status: 404 });
  };
  const bundled = await build({ entryPoints: [join(ROOT, 'src/worker/index.mjs')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    write: false, external: ['cloudflare:workers'], loader: { '.sql': 'text' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, rootPath: ROOT, script: bundled.outputFiles[0].text, modules: true,
    compatibilityDate: '2026-08-22', bindings: { ...vars, BUILD_SHA: 'a'.repeat(40), ...secrets },
    durableObjects: { ROOM: { className: 'RoomDO', useSQLite: true }, DIRECTORY: { className: 'DirectoryDO', useSQLite: true }, ALERTS: { className: 'AlertDO', useSQLite: true } },
    outboundService: outbound }));
  const origin = vars.CASE_PUBLIC_ORIGIN;
  const invite = () => mf.dispatchFetch(`${origin}/api/v1/invitations`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin },
    body: JSON.stringify({ workspaceId, level: 'run', email: 'new.person@example.org' }) });
  return { mf, invite, seen, emails };
}

test('[AS-203] an administrator invites under exactly the production vars: saved and sent, or saved with Resend offered when the invite key is unset', { timeout: 60_000 }, async () => {
  const required = { SUPABASE_SECRET_KEY: 'sb_secret_test', STEPUP_SECRET: 'deploy-config-only-stepup-secret-32bytes!!' };
  for (const [label, secrets, outcome] of [['without RESEND_INVITE_API_KEY', required, 'email_not_configured'],
    ['with RESEND_INVITE_API_KEY', { ...required, RESEND_INVITE_API_KEY: 're_deploy_config_only' }, 'sent']]) {
    const worker = await deployedWorker({ secrets });
    try {
      const response = await worker.invite();
      const body = await response.json();
      assert.equal(response.status, 201, `${label}: ${JSON.stringify(body)}`);
      assert.equal(body.outcome, outcome, label);
      assert.deepEqual(worker.seen.filter(name => ['create_invitation', 'createUser', 'record_invitation_delivery'].includes(name)),
        ['create_invitation', 'createUser', 'record_invitation_delivery'], label);
      assert.equal(worker.emails.length, outcome === 'sent' ? 1 : 0, label);
      if (outcome === 'sent') assert.match(worker.emails[0].html, /https:\/\/software\.example\.invalid\/i\/#[A-Za-z0-9_-]{43}/);
    } finally { await worker.mf.dispose(); }
  }
});

test('beta release config designates only the verified production admin and gives staging its own write origin', () => {
  const production=declared('production').vars,staging=declared('staging').vars;
  assert.equal(production.INCIDENT_ADMIN_EMAILS,'owner@example.invalid');
  assert.ok(production.ADMIN_EMAILS.split(',').map(s=>s.trim()).includes(production.INCIDENT_ADMIN_EMAILS));
  assert.equal(staging.CASE_PUBLIC_ORIGIN,'https://staging.example.invalid');
  assert.equal(staging.ADMIN_EMAILS,undefined,'integration must not silently grant staging administration');
  assert.equal(staging.INCIDENT_ADMIN_EMAILS,undefined,'staging incidents remain closed without an approved admin');
});
