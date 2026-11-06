// Facilitator-UX A5 (plan §3 A5, AS-212): the Worker side of the reorganised Administration. A wrong or expired step-up
// code, a rate limit and an outage answer differently (GoTrue verify and the handler); an admin sets a workspace's
// policies and image quota against the policy revision (P-45); the storage read carries the policies; People carries
// each account's roles and grants; the workspace audit accepts every actor kind the database now records.
// Fakes only (hard rule 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminRequest } from '../src/worker/admin/handler.mjs';
import { matchAdminRoute } from '../src/worker/admin/routes.mjs';
import { gotrueAdminClient } from '../src/worker/admin/gotrue.mjs';
import { workbenchRow } from '../src/shared/admin-workbench.mjs';
import { newCapabilityToken, uuidv7 } from '../src/shared/ids.mjs';

const email = 'admin@example.test', SESSION = uuidv7(), secret = newCapabilityToken(), WS = uuidv7();
const env = { ADMIN_EMAILS: email, CASE_PUBLIC_ORIGIN: 'https://case.invalid', STEPUP_SECRET: secret };
const POLICIES = { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true };
const post = (path, body = {}) => new Request(`https://case.invalid${path}`, { method: 'POST',
  headers: { authorization: 'Bearer t', origin: env.CASE_PUBLIC_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = path => new Request(`https://case.invalid${path}`, { headers: { authorization: 'Bearer t' } });
function deps({ rows = {}, verified = { ok: true }, otp = { ok: true }, users } = {}) {
  const actorId = uuidv7(), calls = [];
  return { calls, actorId, env,
    verifyUser: async token => token ? { userId: actorId, email, sessionId: SESSION } : null,
    rpc: { call: async (name, args) => {
      calls.push([name, args]);
      if (name === 'admin_account_active') return { ok: true, data: true };
      if (name === 'claim_admin_stepup_attempt' || name === 'record_admin_elevation') return { ok: true, data: true };
      if (rows[name]) return rows[name](args);
      return { ok: true, data: [] };
    } },
    gotrue: { startStepUp: async () => otp, verifyStepUp: async () => verified, listUsers: async () => users ?? { ok: true, users: [], nextPage: null } } };
}

// ── Step-up errors ────────────────────────────────────────────────────────────────────────────────────────────
const config = { SUPABASE_URL: 'https://auth.invalid', SUPABASE_SECRET_KEY: `sb_secret_${newCapabilityToken()}` };
const gotrueAnswering = response => gotrueAdminClient(config, { fetchImpl: async () => response() });

test('[AS-212] GoTrue verify: a rejected code, a rate limit and an outage are three different answers', async () => {
  const expired = Response.json({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, { status: 403 });
  assert.deepEqual(await gotrueAnswering(() => expired.clone()).verifyStepUp(email, '123456'), { ok: false, kind: 'code_rejected' });
  assert.deepEqual(await gotrueAnswering(() => Response.json({}, { status: 422 })).verifyStepUp(email, '123456'), { ok: false, kind: 'code_rejected' });
  assert.deepEqual(await gotrueAnswering(() => Response.json({}, { status: 429 })).verifyStepUp(email, '123456'), { ok: false, kind: 'rate_limited' });
  for (const status of [500, 502, 503]) assert.deepEqual(await gotrueAnswering(() => Response.json({}, { status })).verifyStepUp(email, '123456'), { ok: false, kind: 'unavailable' }, String(status));
  const down = gotrueAdminClient(config, { fetchImpl: async () => { throw new Error('network'); } });
  assert.deepEqual(await down.verifyStepUp(email, '123456'), { ok: false, kind: 'unavailable' });
  // Sending a code keeps its own reading: a refusal there is not "a wrong code".
  assert.deepEqual(await gotrueAnswering(() => Response.json({}, { status: 403 })).startStepUp(email), { ok: false, kind: 'unavailable' });
});

test('[AS-212] the step-up handler says code_rejected (422), rate_limited (429) or admin_unavailable (503), never one for all', async () => {
  const run = async (verified, path = '/api/v1/admin/stepup', body = { code: '123456' }) => {
    const d = deps({ verified, otp: verified });
    const response = await handleAdminRequest(post(path, body), d);
    return [response.status, (await response.json()).error];
  };
  assert.deepEqual(await run({ ok: false, kind: 'code_rejected' }), [422, 'code_rejected']);
  assert.deepEqual(await run({ ok: false, kind: 'rate_limited' }), [429, 'rate_limited']);
  assert.deepEqual(await run({ ok: false, kind: 'unavailable' }), [503, 'admin_unavailable']);
  assert.deepEqual(await run({ ok: false, kind: 'forbidden' }), [403, 'forbidden']);
  assert.deepEqual(await run({ ok: false, kind: 'rate_limited' }, '/api/v1/admin/stepup/start', {}), [429, 'rate_limited']);
  // The handler's own attempt limiter keeps its name.
  const limited = deps(); const base = limited.rpc.call;
  limited.rpc.call = async (name, args) => name === 'claim_admin_stepup_attempt' ? { ok: true, data: false } : base(name, args);
  assert.equal((await handleAdminRequest(post('/api/v1/admin/stepup', { code: '123456' }), limited)).status, 429);
});

// ── Policies, quota (P-45) and the storage read ──────────────────────────────────────────────────────────────
test('[AS-212] POST …/settings sets the four policies and the image quota against the policy revision (admins only)', async () => {
  assert.equal(matchAdminRoute(`/api/v1/admin/workspaces/${WS}/settings`, 'POST').key, 'workspace_settings_set');
  const d = deps({ rows: { admin_set_workspace_policies: args => ({ ok: true, data: { ...POLICIES, runners_share: true, revision: args.p_expected_revision + 1, mediaQuotaBytes: args.p_media_quota_bytes ?? 2e9 } }) } });
  const path = `/api/v1/admin/workspaces/${WS}/settings`;
  const ok = await handleAdminRequest(post(path, { expectedRevision: 3, policies: { runners_share: true }, mediaQuotaBytes: 4000000000 }), d);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { policies: { ...POLICIES, runners_share: true }, revision: 4, mediaQuotaBytes: 4000000000 });
  const call = d.calls.find(([name]) => name === 'admin_set_workspace_policies')[1];
  assert.deepEqual(call, { p_user_id: d.actorId, p_workspace_id: WS, p_expected_revision: 3, p_policies: { runners_share: true }, p_media_quota_bytes: 4000000000, p_admin: true, p_admin_email: email });
  // Policies alone leave the quota alone (null), and an empty policy object is allowed (quota only).
  const quotaOnly = await handleAdminRequest(post(path, { expectedRevision: 4, policies: {}, mediaQuotaBytes: 1000000000 }), d);
  assert.equal(quotaOnly.status, 200);
  const policyOnly = await handleAdminRequest(post(path, { expectedRevision: 4, policies: { editors_publish: true }, mediaQuotaBytes: null }), d);
  assert.equal(policyOnly.status, 200);
  assert.equal(d.calls.filter(([name]) => name === 'admin_set_workspace_policies').at(-1)[1].p_media_quota_bytes, null);
  // Shape: only booleans for the four keys; a bounded whole-number quota; a revision.
  for (const body of [{ policies: {}, mediaQuotaBytes: null }, { expectedRevision: -1, policies: {}, mediaQuotaBytes: null },
    { expectedRevision: 0, policies: { runners_share: 'true' }, mediaQuotaBytes: null }, { expectedRevision: 0, policies: { made_up: true }, mediaQuotaBytes: null },
    { expectedRevision: 0, policies: {}, mediaQuotaBytes: 1e10 + 1 }, { expectedRevision: 0, policies: {}, mediaQuotaBytes: 1.5 },
    { expectedRevision: 0, policies: {}, mediaQuotaBytes: -1 }, { expectedRevision: 0, policies: {}, mediaQuotaBytes: null, admin: true }, { expectedRevision: 0, policies: [] , mediaQuotaBytes: null }])
    assert.equal((await handleAdminRequest(post(path, body), d)).status, 400, JSON.stringify(body));
  // Refusals read as the database gives them.
  const conflict = deps({ rows: { admin_set_workspace_policies: () => ({ ok: false, kind: 'conflict', status: 409, code: '40001' }) } });
  assert.equal((await handleAdminRequest(post(path, { expectedRevision: 1, policies: {}, mediaQuotaBytes: null }), conflict)).status, 409);
  const denied = deps({ rows: { admin_set_workspace_policies: () => ({ ok: false, kind: 'forbidden', status: 403, code: '42501' }) } });
  assert.equal((await handleAdminRequest(post(path, { expectedRevision: 1, policies: {}, mediaQuotaBytes: null }), denied)).status, 403);
  // Not an admin: refused before any service.
  const outsider = deps(); outsider.verifyUser = async () => ({ userId: uuidv7(), email: 'other@example.test', sessionId: SESSION });
  assert.equal((await handleAdminRequest(post(path, { expectedRevision: 0, policies: {}, mediaQuotaBytes: null }), outsider)).status, 403);
  assert.ok(!outsider.calls.some(([name]) => name === 'admin_set_workspace_policies'));
});

test('[AS-212] the storage read carries the workspace policies and their revision', async () => {
  const asset = uuidv7();
  const d = deps({ rows: { admin_workspace_storage: args => ({ ok: true, data: { workspaceId: args.p_workspace_id, usedBytes: 1500, quotaBytes: 2e9, unusedBytes: 400,
    policies: POLICIES, policyRevision: 3, unused: [{ assetId: asset, kind: 'image', mediaType: 'image/jpeg', altText: 'Spare', createdAt: '2026-11-01T00:00:00Z', bytes: 400 }] } }) } });
  const read = await handleAdminRequest(get(`/api/v1/admin/workspaces/${WS}/storage`), d);
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.deepEqual(body.policies, POLICIES); assert.equal(body.policyRevision, 3);
  // A missing or malformed policy block is an outage, not a screen of unchecked boxes.
  for (const policies of [undefined, { ...POLICIES, runners_share: 'yes' }, { managers_invite: true }]) {
    const bad = deps({ rows: { admin_workspace_storage: args => ({ ok: true, data: { workspaceId: args.p_workspace_id, usedBytes: 1, quotaBytes: 2e9, unusedBytes: 0, policies, policyRevision: 0, unused: [] } }) } });
    assert.equal((await handleAdminRequest(get(`/api/v1/admin/workspaces/${WS}/storage`), bad)).status, 503, JSON.stringify(policies));
  }
});

// ── People: roles and grants beside each account ────────────────────────────────────────────────────────────────
test('[AS-212] the account list carries each account\'s workspace roles and case grants, null when they cannot be read', async () => {
  const id = uuidv7(), other = uuidv7(), caseId = uuidv7();
  const state = { user_id: id, disabled_at: null, soft_deleted_at: null, delete_due_at: null, admin_revision: 1 };
  const rows = { admin_read_profiles: () => ({ ok: true, data: [state] }), admin_read_facilitator_labels: () => ({ ok: true, data: [] }),
    admin_read_access: () => ({ ok: true, data: [
      { userId: id, kind: 'member', workspaceId: WS, workspaceName: 'Northern ICU', role: 'author', caseId: null, caseTitle: null },
      { userId: id, kind: 'grant', workspaceId: WS, workspaceName: 'Northern ICU', role: 'run', caseId, caseTitle: 'Every Breath You Take' }] }) };
  const users = { ok: true, users: [{ id, email: 'a@example.test' }, { id: other, email: 'b@example.test' }], nextPage: null };
  const d = deps({ rows, users });
  const response = await handleAdminRequest(get('/api/v1/admin/facilitators'), d);
  const body = await response.json();
  assert.deepEqual(body.users[0].access, { memberships: [{ workspaceId: WS, workspaceName: 'Northern ICU', role: 'author' }],
    grants: [{ caseId, caseTitle: 'Every Breath You Take', workspaceId: WS, workspaceName: 'Northern ICU', level: 'run' }] });
  assert.deepEqual(body.users[1].access, { memberships: [], grants: [] }, 'an account with nothing holds nothing');
  assert.deepEqual(d.calls.find(([name]) => name === 'admin_read_access')[1], { p_user_ids: [id, other] });
  // Unreadable (outage, malformed row, a row for an unlisted account): access is unknown, never "no access".
  for (const read of [() => ({ ok: false, kind: 'unavailable', status: 503 }), () => ({ ok: true, data: [{ userId: uuidv7(), kind: 'member', workspaceId: WS, workspaceName: 'X', role: 'owner', caseId: null, caseTitle: null }] }),
    () => ({ ok: true, data: [{ userId: id, kind: 'member', workspaceId: WS, workspaceName: 'X', role: 'emperor', caseId: null, caseTitle: null }] })]) {
    const bad = deps({ rows: { ...rows, admin_read_access: read }, users });
    const out = await (await handleAdminRequest(get('/api/v1/admin/facilitators'), bad)).json();
    assert.deepEqual(out.users.map(u => u.access), [null, null]);
    assert.equal(out.users.length, 2, 'the list itself still loads');
  }
});

// ── Activity: every recorded actor kind validates ────────────────────────────────────────────────────────────
test('[AS-212] the workspace audit row accepts the author and facilitator actor kinds the database now records', () => {
  const row = kind => ({ id: uuidv7(), action: 'case_grant_revoke', actor_kind: kind, actor_email: null, target_type: 'grant', target_id: uuidv7(), revision: null,
    at: '2026-11-03T00:00:00Z', before_state: {}, after_state: {} });
  for (const kind of ['admin', 'owner', 'author', 'facilitator', 'system']) assert.ok(workbenchRow('audit', { ...row(kind), actor_email: kind === 'admin' ? 'a@example.test' : null }), kind);
  assert.equal(workbenchRow('audit', row('robot')), false);
  for (const target of ['invitation', 'grant', 'asset', 'workspace', 'case']) assert.ok(workbenchRow('audit', { ...row('owner'), target_type: target }), target);
});
