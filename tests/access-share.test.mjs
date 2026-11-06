// Facilitator-UX A6 (plan §3 A6; CASE-336, CASE-337, CASE-342): the Worker side of Share and "Shared with you". Who may read a
// case's access list and end a grant, what the dialog may offer each holder, the signed-in person's own shared cases, a
// case-only holder's case detail (no workspace-only group read), and the case place's image details (description and tick
// required, credit optional, the failing field named). Fakes only (hard rule 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCaseAccessApi, shareFacts } from '../src/worker/case-access.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { POLICIES } from '../src/shared/permissions.mjs';
import { assetDetails } from '../src/shared/media.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const WS = uuidv7(), CASE = uuidv7(), OTHER_CASE = uuidv7(), USER = uuidv7(), GRANT = uuidv7(), VERSION = uuidv7();
const ADMIN_EMAIL = 'admin@example.org';
const env = { ADMIN_EMAILS: ADMIN_EMAIL };
const verifyUser = async token => token === 'admin' ? { userId: USER, email: ADMIN_EMAIL, sessionId: uuidv7() } : token === 'jwt' ? { userId: USER, email: 'sam@example.org', sessionId: uuidv7() } : null;
const policies = (over = {}) => ({ ...POLICIES, ...over });

/** One person's facts on CASE as get_access answers them: a workspace role, a grant level, or both. */
function facts({ member = null, grant = null, pol = policies() } = {}) {
  const role = grant === 'edit' && member !== 'owner' ? 'author' : member ?? (grant === 'edit' ? 'author' : grant === 'run' ? 'facilitator' : null);
  return [{ case_id: CASE, workspace_id: WS, member_role: member, grant_level: grant, role, scope: member && !grant ? 'workspace' : 'case', policies: pol }];
}
function rpc({ who = {}, replies = {} } = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push([name, args]);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (replies[name]) return replies[name](args);
    if (name === 'get_access') return { ok: true, data: args.p_case_id === CASE ? facts(who) : [] };
    if (name === 'get_me') return { ok: true, data: [{ user_id: USER, display_name: 'Sam', memberships: who.member ? [{ workspace_id: WS, name: 'Northern ICU', role: who.member, policies: who.pol ?? policies() }] : [],
      grants: who.grant ? [{ case_id: CASE, workspace_id: WS, workspace_name: 'Northern ICU', title: 'Asthma', level: who.grant, policies: who.pol ?? policies() }] : [], next_after: null, admin: args.p_admin === true }] };
    return { ok: false, kind: 'bad_request', status: 400, code: null };
  } };
}
const accessList = { caseId: CASE, workspaceId: WS,
  members: [{ userId: uuidv7(), name: 'Julian Ming', role: 'owner' }],
  grants: [{ grantId: GRANT, userId: uuidv7(), name: 'Sam', level: 'run', grantedAt: '2026-11-02T00:00:00Z' }],
  invitations: [{ invitationId: uuidv7(), email: 'new@example.org', level: 'edit', createdAt: '2026-11-02T00:00:00Z', expiresAt: '2027-01-31T00:00:00Z', sendState: 'sent' }] };
const call = (token, method, path, fake, body) => handleCaseAccessApi(new Request(`https://case.test${path}`, { method, headers: { authorization: `Bearer ${token}`,
  ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), { env, rpc: fake, verifyUser, onAlert() {} });

test('[AS-205] [AS-214] Share lists who holds a case and what is pending, and offers each holder only what will work', async () => {
  const owner = rpc({ who: { member: 'owner' }, replies: { list_case_access: () => ({ ok: true, data: accessList }) } });
  const response = await call('jwt', 'GET', `/api/v1/cases/${CASE}/access`, owner);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.you, { levels: ['run', 'edit'], workspaceWide: true, manageInvitations: true, revoke: true });
  assert.deepEqual(body.grants.map(g => [g.name, g.level]), [['Sam', 'run']]);
  assert.deepEqual(body.invitations.map(i => [i.email, i.level]), [['new@example.org', 'edit']]);
  assert.deepEqual(owner.calls.find(([n]) => n === 'list_case_access')[1], { p_user_id: USER, p_case_id: CASE, p_admin: false, p_admin_email: null });
  // A runner shares only under runners_share (default off), and then only Can run; they never end a grant.
  const closed = rpc({ who: { member: 'facilitator' }, replies: { list_case_access: () => ({ ok: true, data: accessList }) } });
  assert.equal((await call('jwt', 'GET', `/api/v1/cases/${CASE}/access`, closed)).status, 403);
  assert.ok(!closed.calls.some(([n]) => n === 'list_case_access'), 'SQL is not even asked');
  const open = rpc({ who: { member: 'facilitator', pol: policies({ runners_share: true }) }, replies: { list_case_access: () => ({ ok: true, data: accessList }) } });
  const runner = await (await call('jwt', 'GET', `/api/v1/cases/${CASE}/access`, open)).json();
  assert.deepEqual(runner.you, { levels: ['run'], workspaceWide: false, manageInvitations: false, revoke: false });
  // The administrator path.
  const admin = rpc({ who: { member: 'owner' }, replies: { list_case_access: () => ({ ok: true, data: accessList }), get_access: () => ({ ok: true, data: [{ case_id: CASE, workspace_id: WS, member_role: null, grant_level: null, role: 'admin', scope: 'workspace', policies: policies() }] }) } });
  assert.equal((await (await call('admin', 'GET', `/api/v1/cases/${CASE}/access`, admin)).json()).you.revoke, true);
  // Anything else about the answer is refused whole.
  for (const bad of [{ ...accessList, grants: [{ ...accessList.grants[0], level: 'manage' }] }, { ...accessList, caseId: OTHER_CASE }, { ...accessList, members: 'x' }]) {
    const refused = rpc({ who: { member: 'owner' }, replies: { list_case_access: () => ({ ok: true, data: bad }) } });
    assert.equal((await call('jwt', 'GET', `/api/v1/cases/${CASE}/access`, refused)).status, 503);
  }
  assert.equal((await call('nobody', 'GET', `/api/v1/cases/${CASE}/access`, owner)).status, 401);
  assert.equal((await call('jwt', 'GET', `/api/v1/cases/${CASE}/access?x=1`, owner)).status, 400);
});

test('[AS-205] Share accepts provider UUID account IDs while Case identities remain UUIDv7', async () => {
  const providerId = '550e8400-e29b-41d4-a716-446655440000';
  const data = structuredClone(accessList);
  data.members[0].userId = providerId;
  data.grants[0].userId = providerId;
  const read = value => call('jwt', 'GET', `/api/v1/cases/${CASE}/access`, rpc({ who: { member: 'owner' },
    replies: { list_case_access: () => ({ ok: true, data: value }) } }));
  const response = await read(data);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.members[0].userId, providerId);
  assert.equal(body.grants[0].userId, providerId);
  for (const field of ['members', 'grants']) {
    const invalid = structuredClone(data); invalid[field][0].userId = 'invalid';
    assert.equal((await read(invalid)).status, 503);
  }
  data.grants[0].grantId = providerId;
  assert.equal((await read(data)).status, 503);
});

test('[AS-205] a case-only editor may read Share only under the policy, and shares Can run only', () => {
  // The same facts the case page carries: a grant alone, no membership.
  const editorOnly = { ok: true, role: 'author', scope: 'case', policies: policies({ runners_share: true }), held: { role: null, grant: 'edit', policies: policies({ runners_share: true }) } };
  assert.deepEqual(shareFacts(editorOnly), { levels: ['run'], workspaceWide: false, manageInvitations: false, revoke: false });
  assert.equal(shareFacts({ ok: false }), null);
});

test('[AS-205] only a manager or an administrator ends a grant, and the grant is named in the path of its own case', async () => {
  const owner = rpc({ who: { member: 'owner' }, replies: { revoke_case_grant: () => ({ ok: true, data: { outcome: 'revoked', grantId: GRANT } }) } });
  const done = await call('jwt', 'POST', `/api/v1/cases/${CASE}/access/${GRANT}/revoke`, owner, {});
  assert.equal(done.status, 200); assert.deepEqual(await done.json(), { outcome: 'revoked' });
  assert.deepEqual(owner.calls.find(([n]) => n === 'revoke_case_grant')[1], { p_user_id: USER, p_grant_id: GRANT, p_admin: false, p_admin_email: null });
  const runner = rpc({ who: { member: 'facilitator', pol: policies({ runners_share: true }) } });
  assert.equal((await call('jwt', 'POST', `/api/v1/cases/${CASE}/access/${GRANT}/revoke`, runner, {})).status, 403);
  assert.ok(!runner.calls.some(([n]) => n === 'revoke_case_grant'));
  assert.equal((await call('jwt', 'POST', `/api/v1/cases/${CASE}/access/${GRANT}/revoke`, owner, { reason: 'x' })).status, 400);
  assert.equal(await call('jwt', 'GET', `/api/v1/cases/${CASE}/access/${GRANT}/revoke`, owner), null);
});

test('[AS-214] Shared with you is the caller\'s own live grants, validated whole', async () => {
  const row = { grant_id: GRANT, case_id: CASE, workspace_id: WS, workspace_name: 'Bondi SLSC', title: 'Spinal on the beach', level: 'run', member_role: null,
    version_id: VERSION, version_no: 3, withdrawn: false, has_draft: false, granted_at: '2026-11-02T00:00:00Z' };
  const fake = rpc({ replies: { list_shared_cases: () => ({ ok: true, data: [row, { ...row, grant_id: uuidv7(), case_id: uuidv7(), title: 'Gone', version_id: null, version_no: null, withdrawn: true }] }) } });
  const response = await call('jwt', 'GET', '/api/v1/shared-cases', fake);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.cases.map(c => [c.title, c.level, c.versionNo, c.withdrawn, c.workspaceName]), [['Spinal on the beach', 'run', 3, false, 'Bondi SLSC'], ['Gone', 'run', null, true, 'Bondi SLSC']]);
  assert.deepEqual(fake.calls.find(([n]) => n === 'list_shared_cases')[1], { p_user_id: USER });
  for (const bad of [{ ...row, level: 'manage' }, { ...row, title: 5 }, { ...row, version_id: 'x' }]) {
    assert.equal((await call('jwt', 'GET', '/api/v1/shared-cases', rpc({ replies: { list_shared_cases: () => ({ ok: true, data: [bad] }) } }))).status, 503);
  }
  assert.equal((await call('nobody', 'GET', '/api/v1/shared-cases', fake)).status, 401);
});

test('[AS-205] [AS-207] a case-only holder\'s case detail skips the workspace-only group read and says what they may do', async () => {
  const detail = { workspace_id: WS, role: 'facilitator', version_id: VERSION, case_id: CASE, title: 'Asthma', summary: 'S', audience: 'A', setting: 'E', duration_min: 15,
    learning_objectives: [], version_no: 1, published_at: '2026-10-01T00:00:00+00:00', content_sha256: `\\x${'b'.repeat(64)}`, art: null,
    versions: [{ version_id: VERSION, version_no: 1, published_at: '2026-10-01T00:00:00+00:00', content_sha256: `\\x${'b'.repeat(64)}` }] };
  const fake = rpc({ who: { grant: 'run' }, replies: { get_catalogue_case_history: () => ({ ok: true, data: [detail] }),
    get_case_group: () => ({ ok: false, kind: 'forbidden', status: 403, code: '42501' }) } });
  const response = await handleFacilitatorApi(new Request(`https://case.test/api/v1/cases/${CASE}/versions/1`, { headers: { authorization: 'Bearer jwt' } }), { rpc: fake, env, onAlert() {}, verifyUser });
  assert.equal(response.status, 200);
  const body = (await response.json()).case;
  assert.ok(!fake.calls.some(([n]) => n === 'get_case_group'), 'no group read for a person who holds the case alone');
  assert.deepEqual(body.group, { id: null, name: null, tint: 'neutral', revision: 0 });
  assert.equal(body.scope, 'case'); assert.equal(body.share, null, 'a case-only runner has no Share while runners_share is off');
  // The same person under the policy is offered Share (Can run only).
  const open = rpc({ who: { grant: 'run', pol: policies({ runners_share: true }) }, replies: { get_catalogue_case_history: () => ({ ok: true, data: [detail] }) } });
  const shared = (await (await handleFacilitatorApi(new Request(`https://case.test/api/v1/cases/${CASE}/versions/1`, { headers: { authorization: 'Bearer jwt' } }), { rpc: open, env, onAlert() {}, verifyUser })).json()).case;
  assert.deepEqual(shared.share, { levels: ['run'], workspaceWide: false, manageInvitations: false, revoke: false });
});

test('[AS-213] the case place takes a description and the tick; the credit is one optional line; a refusal names the field', () => {
  const ok = assetDetails({ alt: 'Chest X-ray, PA', attested: true }, { relaxed: true });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.value.alt, ok.value.evidenceKind, ok.value.licence, ok.value.rightsBasis, ok.value.attribution, ok.value.attested], ['Chest X-ray, PA', null, null, null, '', true]);
  assert.equal(assetDetails({ alt: 'ECG', credit: 'Dr A. Kaur', evidenceKind: 'ecg', attested: true }, { relaxed: true }).value.attribution, 'Dr A. Kaur');
  assert.deepEqual(assetDetails({ alt: '  ', attested: true }, { relaxed: true }), { ok: false, field: 'alt' });
  assert.deepEqual(assetDetails({ alt: 'x', credit: 'c'.repeat(301), attested: true }, { relaxed: true }), { ok: false, field: 'credit' });
  assert.deepEqual(assetDetails({ alt: 'x', evidenceKind: 'selfie', attested: true }, { relaxed: true }), { ok: false, field: 'evidenceKind' });
  assert.deepEqual(assetDetails({ alt: 'x', attested: 'yes' }, { relaxed: true }), { ok: false, field: 'attested' });
  // The workspace place (the deployed Builder) keeps every detail it always required, and has no credit key.
  assert.deepEqual(assetDetails({ alt: 'x', attested: true }), { ok: false, field: 'evidenceKind' });
  assert.deepEqual(assetDetails({ alt: 'x', credit: 'c', evidenceKind: 'photo', source: 'own' }), { ok: false, field: 'body' });
});

test('[AS-213] a case upload with only a description and the tick registers; the credit lands as the attribution; a bad field is named', async () => {
  const { readFileSync } = await import('node:fs');
  const { handleMediaApi } = await import('../src/worker/media-api.mjs');
  const { cleanJpeg } = await import('../src/shared/media.mjs');
  const jpeg = cleanJpeg(new Uint8Array(readFileSync(new URL('./fixtures/media/clean-300x200.jpg', import.meta.url))));
  const objects = new Map();
  const store = { async put(key, bytes, options) { objects.set(key, { bytes, ...options }); return {}; },
    async head(key) { const found = objects.get(key); return found ? { size: found.bytes.byteLength, customMetadata: found.customMetadata } : null; },
    async get() { return null; }, async delete() {} };
  const fake = rpc({ who: { grant: 'edit' }, replies: { builder_case_media_put_allowance: () => ({ ok: true, data: true }), media_known_keys: () => ({ ok: true, data: [] }),
    builder_create_case_asset: args => ({ ok: true, data: { asset_id: uuidv7(), status: 'quarantined', created: true, details: args.p_details } }) } });
  const send = (method, path, body, type) => handleMediaApi(new Request(`https://case.test/api/v1/builder/cases/${CASE}/${path}`, { method, body, duplex: 'half',
    headers: { authorization: 'Bearer jwt', ...(type ? { 'content-type': type } : {}) } }), { rpc: fake, env: { ...env, MEDIA: store }, verifyUser });
  const { sha256 } = await (await send('PUT', 'media/display', jpeg, 'image/jpeg')).json();
  const register = details => send('POST', 'assets', JSON.stringify({ display: { sha256 }, phone: { sha256 }, details }), 'application/json');
  const made = await register({ alt: 'Chest X-ray, PA', credit: 'Dr A. Kaur', attested: true });
  assert.equal(made.status, 201);
  const sent = fake.calls.find(([name]) => name === 'builder_create_case_asset')[1].p_details;
  assert.deepEqual([sent.alt_text, sent.attribution, sent.attested, sent.licence, sent.rights_basis, sent.evidence_kind], ['Chest X-ray, PA', 'Dr A. Kaur', true, null, null, null]);
  for (const [details, error] of [[{ alt: 'x', credit: 'c'.repeat(301), attested: true }, 'invalid_details:credit'], [{ alt: ' ', attested: true }, 'invalid_details:alt'], [{ alt: 'x' }, 'invalid_details:attested'],
    [{ alt: 'x', attested: false }, 'invalid_details:attested'], [{ alt: 'x', evidenceKind: 'selfie', attested: true }, 'invalid_details:evidenceKind']]) {
    const refused = await register(details);
    assert.equal(refused.status, 422); assert.equal((await refused.json()).error, error);
  }
});
