// The facilitator's Name & role (Julian, 2026-10-18): the shared rules, the self write (P-40), the room's label fixed at
// start (override for one session only), the admin correction (P-41, step-up and audit without the words), and the
// ended-only projection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { labelProblem, parseLabelFields, composeLabel, validLabel, normaliseLabelField, LABEL_MAX } from '../src/shared/facilitator-label.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { readMe, startPublishedRoom, roomFacilitatorLabel, parseFacilitatorOverride } from '../src/worker/published-rooms.mjs';
import { handleAdminRequest } from '../src/worker/admin/handler.mjs';
import { mintElevation } from '../src/worker/admin/stepup.mjs';
import { initialState, project } from '../src/shared/room-machine.mjs';

test('[AS-178] the shared rules: both fields required, trimmed and collapsed, 80 code points each; the label is exactly "Name, Role"', () => {
  assert.deepEqual(labelProblem('', 'Registrar'), { field: 'name', problem: 'required' });
  assert.deepEqual(labelProblem('Julian Ming', '  '), { field: 'role', problem: 'required' });
  assert.deepEqual(labelProblem('é'.repeat(81), 'Registrar'), { field: 'name', problem: 'too_long' });
  assert.equal(labelProblem('😀'.repeat(80), 'Registrar'), null, 'code points, as Postgres counts them');
  assert.equal(normaliseLabelField('  Julian \n‮ Ming '), 'Julian Ming');
  assert.deepEqual(parseLabelFields({ name: ' Julian  Ming ', role: 'Emergency registrar' }), { ok: true, name: 'Julian Ming', role: 'Emergency registrar' });
  for (const bad of [null, [], { name: 'A' }, { name: 1, role: 'B' }, { name: 'A', role: 'x'.repeat(400) }]) assert.equal(parseLabelFields(bad).ok, false);
  assert.equal(composeLabel('Julian Ming', 'Emergency registrar'), 'Julian Ming, Emergency registrar');
  assert.equal(validLabel('Julian Ming, Emergency registrar'), true);
  for (const bad of ['', ' padded', 'two  spaces', 'x'.repeat(LABEL_MAX + 1), 7, null]) assert.equal(validLabel(bad), false);
});

// ─── the self write ──────────────────────────────────────────────────────────────────────────────────────────
const userId = uuidv7(), workspaceId = uuidv7();
const member = { workspace_id: workspaceId, slug: 'fsh-icu', name: 'FSH ICU', role: 'facilitator' };
const meRow = (extra = {}) => ({ user_id: userId, display_name: 'Facilitator', memberships: [member], next_after: null, admin: false,
  facilitator_role: null, label_confirmed_at: null, ...extra });
const service = (handlers = {}) => {
  const calls = [];
  return { calls, call: async (name, args) => {
    if (name === 'admin_account_active') return { ok: true, data: true };
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === 'get_me') return { ok: true, data: [meRow()] };
    if (name === 'set_own_facilitator_label') return { ok: true, data: [{ display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: '2026-10-18T01:00:00Z' }] };
    return { ok: true, data: null };
  } };
};
const put = (body, path = '/me/profile') => new Request(`https://case.test/api/v1${path}`, { method: 'PUT',
  headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) });
const verifyUser = async () => ({ userId, email: 'f@example.org' });

test('[P-40] /me reads the Name & role and whether they were confirmed; an old database reads as unknown, never as unconfirmed', async () => {
  assert.deepEqual((await readMe(service(), userId)).profile, { userId, displayName: 'Facilitator', role: null, labelConfirmed: false });
  const confirmed = service({ get_me: () => ({ ok: true, data: [meRow({ display_name: 'Julian Ming', facilitator_role: 'Registrar', label_confirmed_at: '2026-10-18T01:00:00Z' })] }) });
  assert.deepEqual((await readMe(confirmed, userId)).profile, { userId, displayName: 'Julian Ming', role: 'Registrar', labelConfirmed: true });
  const { facilitator_role, label_confirmed_at, ...old } = meRow();
  assert.equal((await readMe(service({ get_me: () => ({ ok: true, data: [old] }) }), userId)).profile.labelConfirmed, null);
  assert.equal((await readMe(service({ get_me: () => ({ ok: true, data: [meRow({ facilitator_role: 7 })] }) }), userId)).ok, false);
});

test('[P-40] PUT /me/profile writes only the JWT subject\'s normalised Name & role and confirms them', async () => {
  const rpc = service();
  const response = await handleFacilitatorApi(put({ name: ' Julian  Ming ', role: 'Emergency registrar' }), { rpc, env: {}, verifyUser });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: { userId, displayName: 'Julian Ming', role: 'Emergency registrar', labelConfirmed: true } });
  assert.deepEqual(rpc.calls.at(-1), { name: 'set_own_facilitator_label', args: { p_user_id: userId, p_name: 'Julian Ming', p_role: 'Emergency registrar' } });
  for (const body of [{ name: 'Julian', role: '' }, { name: 'Julian', role: 'Registrar', userId: uuidv7() }, { name: 'Julian' }]) {
    const refused = service();
    assert.equal((await handleFacilitatorApi(put(body), { rpc: refused, env: {}, verifyUser })).status, 400);
    assert.equal(refused.calls.some(c => c.name === 'set_own_facilitator_label'), false);
  }
  const outsider = service({ get_me: () => ({ ok: true, data: [meRow({ memberships: [] })] }) });
  assert.equal((await handleFacilitatorApi(put({ name: 'A B', role: 'Intern' }), { rpc: outsider, env: {}, verifyUser })).status, 403);
  assert.equal((await handleFacilitatorApi(put({ name: 'A B', role: 'Intern' }), { rpc: service(), env: {}, verifyUser: async () => null })).status, 401);
});

// ─── the room's label ────────────────────────────────────────────────────────────────────────────────────────
test('the room\'s label: a this-session override wins; else only a confirmed profile names anyone', () => {
  const profile = { displayName: 'Julian Ming', role: 'Emergency registrar', labelConfirmed: true };
  assert.equal(roomFacilitatorLabel(profile), 'Julian Ming, Emergency registrar');
  assert.equal(roomFacilitatorLabel({ ...profile, labelConfirmed: false }), null, 'the placeholder is never a name');
  assert.equal(roomFacilitatorLabel({ ...profile, labelConfirmed: null }), null);
  assert.equal(roomFacilitatorLabel({ ...profile, labelConfirmed: false }, { name: 'Sam Lee', role: 'Consultant' }), 'Sam Lee, Consultant');
  assert.deepEqual(parseFacilitatorOverride(undefined), { ok: true, value: null });
  assert.deepEqual(parseFacilitatorOverride({ name: ' Sam  Lee', role: 'Consultant' }), { ok: true, value: { name: 'Sam Lee', role: 'Consultant' } });
  for (const bad of [{ name: 'Sam' }, { name: 'Sam', role: 'C', extra: 1 }, 'Sam Lee, Consultant']) assert.equal(parseFacilitatorOverride(bad).ok, false);
});

const documentText = JSON.stringify(miniCase().doc);
const hex = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
async function start({ me = meRow(), override = null } = {}) {
  const rooms = [], versionId = uuidv7(), sessionId = uuidv7();
  const rpc = service({ get_me: () => ({ ok: true, data: [me] }),
    get_case_version_for_workspace: async () => ({ ok: true, data: [{ case_id: uuidv7(), version_no: 1, schema_version: 1, document: {},
      document_text: documentText, content_sha256: `\\x${await hex(documentText)}` }] }),
    create_session: args => ({ ok: true, data: args.p_session_id }), set_session_facilitator_label: () => ({ ok: true, data: true }) });
  const result = await startPublishedRoom({ rpc, actor: { userId, email: null, admin: false }, workspaceId, caseVersionId: versionId, ttlMs: 60_000, sessionId,
    directory: { register: async () => true, release: async () => {} }, newCode: () => 'ABC123', facilitatorOverride: override,
    room: { create: async input => { rooms.push(input); return { facilitatorToken: 't', expiresAt: '2026-10-19T00:00:00Z' }; }, abortCreate: async () => {} } });
  return { result, rpc, room: rooms[0], sessionId };
}

test('Start room fixes the label on the session row and in the room; an unconfirmed placeholder starts a room with none', async () => {
  const run = await start({ me: meRow({ display_name: 'Julian Ming', facilitator_role: 'Emergency registrar', label_confirmed_at: '2026-10-18T01:00:00Z' }) });
  assert.equal(run.result.ok, true);
  assert.equal(run.room.facilitatorLabel, 'Julian Ming, Emergency registrar');
  assert.deepEqual(run.rpc.calls.find(c => c.name === 'set_session_facilitator_label').args, { p_session_id: run.sessionId, p_label: 'Julian Ming, Emergency registrar' });
  const names = run.rpc.calls.map(c => c.name);
  assert.ok(names.indexOf('create_session') < names.indexOf('set_session_facilitator_label'), 'written for the room just created');
  const placeholder = await start();
  assert.equal(placeholder.room.facilitatorLabel, null);
  assert.equal(placeholder.rpc.calls.some(c => c.name === 'set_session_facilitator_label'), false);
  const override = await start({ override: { name: 'Sam Lee', role: 'Consultant' } });
  assert.equal(override.room.facilitatorLabel, 'Sam Lee, Consultant');
  assert.equal(override.rpc.calls.some(c => ['set_own_facilitator_label', 'ensure_profile'].includes(c.name) && c.args.p_name), false, 'the override never touches the profile');
});

test('[AS-178] the room shows its label only on an ended phone\'s recap, never on the display or before End', () => {
  const doc = miniCase().doc, sid = uuidv7(), pid = 'p1';
  const live = { ...initialState({ sessionId: sid, caseDoc: doc, facilitatorLabel: 'Julian Ming, Emergency registrar' }),
    participants: { [pid]: { name: 'Ann', avatarId: null, joinedAt: '2026-10-19T08:00:00.000Z', removedAt: null } } };
  assert.equal(live.facilitatorLabel, 'Julian Ming, Emergency registrar');
  const text = view => JSON.stringify(view);
  assert.equal(text(project(live, 'participant', pid)).includes('Julian'), false);
  assert.equal(text(project(live, 'display')).includes('Julian'), false);
  const ended = { ...live, phase: 'ended', endedAt: '2026-10-19T09:00:00.000Z' };
  assert.equal(project(ended, 'participant', pid).recap.facilitator, 'Julian Ming, Emergency registrar');
  assert.equal(text(project(ended, 'display')).includes('Julian'), false);
  assert.equal(project({ ...ended, facilitatorLabel: null }, 'participant', pid).recap.facilitator, undefined, 'a room with none has no key');
  assert.equal(initialState({ sessionId: sid, caseDoc: doc, facilitatorLabel: 7 }).facilitatorLabel, null);
});

// ─── the admin correction ────────────────────────────────────────────────────────────────────────────────────
const adminEmail = 'admin@example.test', SESSION = uuidv7(), secret = newCapabilityToken();
const adminEnv = { ADMIN_EMAILS: adminEmail, CASE_PUBLIC_ORIGIN: 'https://case.invalid', STEPUP_SECRET: secret };
const target = uuidv7();
const adminRpc = (handlers = {}) => {
  const calls = [];
  return { calls, call: async (name, args) => {
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'admin_read_profiles') return { ok: true, data: [{ user_id: target, disabled_at: null, soft_deleted_at: null, delete_due_at: null, admin_revision: 4 }] };
    if (name === 'admin_read_facilitator_labels') return { ok: true, data: [{ user_id: target, display_name: 'Facilitator', facilitator_role: null, label_confirmed_at: null }] };
    if (name === 'admin_set_facilitator_label') return { ok: true, data: [{ user_id: target, admin_revision: args.p_expected_revision + 1,
      display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: null }] };
    if (name === 'write_admin_audit') return { ok: true, data: args.p_event_id };
    return { ok: true, data: null };
  } };
};
const adminPost = async (body, rpc, { elevated = true } = {}) => handleAdminRequest(new Request(`https://case.invalid/api/v1/admin/facilitators/${target}/label`, {
  method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer local', origin: adminEnv.CASE_PUBLIC_ORIGIN, 'content-type': 'application/json',
    ...(elevated ? { 'x-admin-elevation': (await mintElevation(adminEmail, SESSION, secret)).token } : {}) } }),
  { env: adminEnv, rpc, verifyUser: async () => ({ userId: uuidv7(), email: adminEmail, sessionId: SESSION }) });

test('[P-41] an admin correction needs a step-up, checks the revision and audits the revision only, never the words', async () => {
  const body = { expectedRevision: 4, name: 'Sam  Lee', role: 'Registrar' };
  const unelevated = adminRpc();
  assert.equal((await adminPost(body, unelevated, { elevated: false })).status, 403);
  assert.equal(unelevated.calls.some(c => c.name === 'admin_set_facilitator_label'), false);
  assert.equal((await adminPost({ ...body, expectedRevision: 3 }, adminRpc())).status, 409);
  assert.equal((await adminPost({ ...body, role: '' }, adminRpc())).status, 400);
  const rpc = adminRpc(), response = await adminPost(body, rpc);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { label: { userId: target, adminRevision: 5, name: 'Sam Lee', role: 'Registrar', confirmed: false } });
  assert.deepEqual(rpc.calls.find(c => c.name === 'admin_set_facilitator_label').args,
    { p_user_id: target, p_expected_revision: 4, p_name: 'Sam Lee', p_role: 'Registrar', p_admin: true, p_admin_email: adminEmail });
  const audit = rpc.calls.filter(c => c.name === 'write_admin_audit').map(c => c.args);
  assert.deepEqual(audit.map(a => [a.p_phase, a.p_action, a.p_target_id, a.p_before, a.p_after]), [
    ['intent', 'facilitator_label_edit', target, { admin_revision: 4 }, {}],
    ['outcome', 'facilitator_label_edit', target, { admin_revision: 4 }, { admin_revision: 5 }]]);
  assert.equal(JSON.stringify(audit).includes('Sam'), false, 'no free text in the audit (CASE-075)');
});

test('[P-41] a lost audit outcome undoes the write to the earlier complete Name & role, and a placeholder needs the operator', async () => {
  let outcomes = 0;
  const failingOutcome = args => args.p_phase === 'outcome' && ++outcomes ? { ok: false, kind: 'unavailable' } : { ok: true, data: args.p_event_id };
  const complete = adminRpc({ write_admin_audit: failingOutcome,
    admin_read_facilitator_labels: () => ({ ok: true, data: [{ user_id: target, display_name: 'Ann Ho', facilitator_role: 'Consultant', label_confirmed_at: null }] }) });
  const undone = await adminPost({ expectedRevision: 4, name: 'Sam Lee', role: 'Registrar' }, complete);
  assert.equal(undone.status, 500);
  assert.equal((await undone.json()).error, 'change_reverted_audit_unavailable');
  assert.deepEqual(complete.calls.filter(c => c.name === 'admin_set_facilitator_label').map(c => [c.args.p_expected_revision, c.args.p_name, c.args.p_role]),
    [[4, 'Sam Lee', 'Registrar'], [5, 'Ann Ho', 'Consultant']]);
  const placeholder = await adminPost({ expectedRevision: 4, name: 'Sam Lee', role: 'Registrar' }, adminRpc({ write_admin_audit: failingOutcome }));
  assert.equal((await placeholder.json()).error, 'manual_reconciliation_needed');
});
