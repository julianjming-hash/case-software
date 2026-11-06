// Card 28 (CASE-164): the art descriptor on the ACTUAL network payloads of the real Worker and RoomDO
// in workerd. Supabase is the in-memory PostgREST fake (hard rule 12). Asserts that the descriptor is
// the only new field, carries no string and no id-shaped token, survives into a live room unchanged,
// and that the publish route refuses a tampered descriptor before the RPC.
import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { describeCase, withSolution, artPrivacyViolations } from '../../src/shared/art-descriptor.mjs';
import { knownAccountFake } from '../helpers/admin-account-fixture.mjs';

const ORIGIN = 'https://case.test';
const SECRET = 'test-only-secret-not-for-production';
const workspaceId = uuidv7(), versionId = uuidv7(), userId = uuidv7(), caseId = uuidv7();
const localEnv = { ...env, SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: 'sb_secret_test_only' };
const jwt = () => signTestJwt({ sub: userId, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
const ART = withSolution(describeCase(fixture), { attempt: 2, summarised: false });
const api = (path, { method = 'GET', token, body } = {}) => worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}), localEnv);
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function fakeWith(art) {
  const fake = knownAccountFake({ actors: [userId], origin: 'https://postgrest.test', versions: [{
    version_id: versionId, case_id: caseId, title: 'Published case', version_no: 1,
    published_at: new Date().toISOString(), content_sha256: `\\x${'a'.repeat(64)}`, art }] });
  const text = JSON.stringify(fixture);
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  fake.replies.set('get_me', [{ user_id: userId, display_name: 'Facilitator', memberships: [{ workspace_id: workspaceId, role: 'owner' }], next_after: null, admin: false }]);
  fake.replies.set('get_case_version_for_workspace', [{ case_id: caseId, version_no: 1, schema_version: 1,
    document_text: text, document: fixture, content_sha256: `\\x${hash}`, art }]);
  fake.replies.set('get_case_authoring_access', [{ case_id: caseId, workspace_id: workspaceId, role: 'owner' }]);
  fake.replies.set('get_draft', [{ revision: 4, schema_version: 1, document: fixture, updated_at: new Date().toISOString() }]);
  fake.replies.set('publish_draft_with_art', [{ version_id: versionId, version_no: 2, content_sha256: `\\x${hash}` }]);
  return fake;
}

/** The art field of a raw JSON body, checked as the network carried it. */
function assertNumbersOnly(text, art) {
  expect(art).toEqual(ART);
  expect(artPrivacyViolations(art)).toEqual([]);
  const raw = JSON.stringify(art);
  expect(text).toContain(`"art":${raw}`);
  expect(raw).not.toMatch(/:"/);            // no string value anywhere inside it
  expect(raw).not.toMatch(UUIDISH);
  for (const leak of [fixture.title, fixture.summary, ...fixture.decisions.flatMap(d => d.paths.map(p => p.label))])
    expect(raw).not.toContain(leak);
}

async function startRoom(fake) {
  vi.stubGlobal('fetch', fake.fetchImpl);
  const started = await api('/sessions', { method: 'POST', token: await jwt(), body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(started.status).toBe(201);
  const room = await started.json();
  const joined = await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, displayName: 'Sam', avatarId: 'shadows-01' } });
  expect(joined.status).toBe(201);
  const participant = await joined.json();
  const pair = await (await api('/display-pairs', { method: 'POST' })).json();
  expect((await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code } })).status).toBe(200);
  const display = await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json();
  const read = async token => (await api(`/sessions/${room.sessionId}/snapshot`, { token })).text();
  return { room, participant, display, read };
}

afterEach(() => vi.unstubAllGlobals());

it('[CASE-164] the facilitator version list, participant and projector payloads carry the numbers-only descriptor', async () => {
  const fake = await fakeWith(ART);
  vi.stubGlobal('fetch', fake.fetchImpl);
  const listed = await (await api(`/workspaces/${workspaceId}/versions`, { token: await jwt() })).text();
  assertNumbersOnly(listed, JSON.parse(listed).versions[0].art);

  const { participant, display, read, room } = await startRoom(fake);
  for (const token of [participant.token, display.token]) {
    const text = await read(token);
    assertNumbersOnly(text, JSON.parse(text).view.art);
  }
  // Live rooms keep the version's descriptor: a later change to the stored row does not reach the room.
  fake.replies.set('get_case_version_for_workspace', [{ ...fake.replies.get('get_case_version_for_workspace')[0], art: { ...ART, attempt: 9 } }]);
  expect(JSON.parse(await read(participant.token)).view.art).toEqual(ART);
  expect(JSON.parse(await read(room.facilitatorToken)).view.art).toEqual(ART);
});

it('[CASE-164] art is the only new field: a version without art yields the same payload keys with art null', async () => {
  const withArt = await startRoom(await fakeWith(ART));
  vi.unstubAllGlobals();
  const without = await startRoom(await fakeWith(null));
  for (const role of ['participant', 'display']) {
    const a = JSON.parse(await withArt.read(withArt[role].token)).view;
    const b = JSON.parse(await without.read(without[role].token)).view;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(b.art).toBeNull();
  }
});

it('[CASE-164] a stored descriptor carrying text is never delivered', async () => {
  const fake = await fakeWith({ ...ART, label: fixture.title });
  vi.stubGlobal('fetch', fake.fetchImpl);
  const listed = await (await api(`/workspaces/${workspaceId}/versions`, { token: await jwt() })).text();
  expect(listed).not.toContain(fixture.title);
  expect(JSON.parse(listed).versions[0].art).toBeNull();
  const { participant, read } = await startRoom(fake);
  const text = await read(participant.token);
  expect(JSON.parse(text).view.art).toBeNull();
});

it('[CASE-164] the legacy direct-publish route refuses drafts; Builder review is required', async () => {
  const fake = await fakeWith(ART);
  vi.stubGlobal('fetch', fake.fetchImpl);
  const tampered = { ...ART, decisions: ART.decisions.map((d, i) => (i ? d : { ...d, resets: d.resets + 1 })) };
  const refused = await api(`/cases/${caseId}/publish`, { method: 'POST', token: await jwt(), body: { expectedRevision: 4, assetIds: [], art: tampered } });
  // An owner now reaches P-15 (CASE-338), so the legacy route answers its own refusal: Builder review is required.
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: 'review_required' });
  expect(fake.requests.some(request => request.name === 'publish_draft_with_art')).toBe(false);
  const accepted = await api(`/cases/${caseId}/publish`, { method: 'POST', token: await jwt(), body: { expectedRevision: 4, assetIds: [], art: ART } });
  expect(accepted.status).toBe(409);
  expect(await accepted.json()).toEqual({ error: 'review_required' });
  const stored = fake.requests.filter(request => request.name === 'publish_draft_with_art');
  expect(stored).toHaveLength(0);
});
