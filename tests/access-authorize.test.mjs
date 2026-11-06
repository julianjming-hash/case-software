// Facilitator-UX A3 (plan §3 A3, CASE-336, CASE-337): the Worker's authorize reads membership, grant and policies once
// per request and answers the existing role vocabulary plus scope; console mints use the case the room was started
// from; /me/profile admits a membership or a grant. Fake RPC clients only (hard rule 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, holds, onCase, mayMintConsole } from '../src/worker/authorize.mjs';
import { ACTIONS, POLICIES } from '../src/shared/permissions.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const WS = uuidv7(), OTHER_WS = uuidv7(), CASE_A = uuidv7(), CASE_B = uuidv7(), USER = uuidv7();
const actor = Object.freeze({ userId: USER, email: null, admin: false });
const admin = Object.freeze({ userId: USER, email: 'admin@example.org', admin: true });
const OFF = Object.freeze({ managers_invite: false, editors_publish: false, runners_share: false, managers_see_records: false });

/** A client whose get_me answers `role` in WS (or none) and `grants` [{ case_id, level }] in WS, with `policies`. */
function client({ role = null, grants = [], policies = POLICIES, access = null } = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push([name, args]);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'get_me') {
      const memberships = args.p_admin ? [{ workspace_id: WS, slug: 'ws', name: 'WS', role: 'admin', policies }]
        : role ? [{ workspace_id: WS, slug: 'ws', name: 'WS', role, policies }] : [];
      return { ok: true, data: [{ user_id: args.p_user_id, display_name: 'Fay', next_after: null, admin: args.p_admin === true,
        memberships: memberships.filter(row => args.p_workspace_id === null || row.workspace_id === args.p_workspace_id),
        grants: grants.map(g => ({ workspace_id: WS, workspace_name: 'WS', title: 'T', policies, ...g }))
          .filter(row => args.p_workspace_id === null || row.workspace_id === args.p_workspace_id) }] };
    }
    if (name === 'get_access') return { ok: true, data: access ? [access(args)] : [] };
    if (name === 'set_own_facilitator_label') return { ok: true, data: [{ display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: new Date().toISOString() }] };
    return { ok: false, kind: 'bad_request', status: 400, code: null };
  } };
}

test('[AS-206] a workspace place is decided by the membership alone, in one read, with scope workspace', async () => {
  const author = client({ role: 'author', grants: [{ case_id: CASE_A, level: 'edit' }] });
  const { held, ...answer } = await authorize(author, actor, WS, ACTIONS.draft);
  assert.deepEqual(answer, { ok: true, role: 'author', scope: 'workspace', workspaceId: WS,
    policies: POLICIES, profile: { userId: USER, displayName: 'Fay', role: null, labelConfirmed: null } });
  assert.equal(held.role, 'author'); assert.equal(held.grant, null, 'a workspace place carries no case grant');
  assert.equal(author.calls.filter(([name]) => name === 'get_me').length, 1);
  // A case grant never reaches a workspace action: a case-only editor cannot create a case or read settings.
  const caseOnly = client({ grants: [{ case_id: CASE_A, level: 'edit' }] });
  for (const action of [ACTIONS.createCase, ACTIONS.readSettings, ACTIONS.seeWorkspace, ACTIONS.draft])
    assert.equal((await authorize(caseOnly, actor, WS, action)).status, 403, action);
});

test('[AS-206] a case place counts the grant on that case only; the highest level wins and never lowers a role', async () => {
  const caseOnly = client({ grants: [{ case_id: CASE_A, level: 'edit' }] });
  const onA = await authorize(caseOnly, actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.draft);
  assert.equal(onA.ok, true); assert.equal(onA.role, 'author'); assert.equal(onA.scope, 'case');
  assert.equal((await authorize(caseOnly, actor, { workspaceId: WS, caseId: CASE_B }, ACTIONS.draft)).status, 403, 'a grant reached another case');
  assert.equal((await authorize(caseOnly, actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.createCase)).status, 403);
  // A workspace runner with Can edit on A edits A (as author, scope case) and still runs B (as facilitator).
  const runner = client({ role: 'facilitator', grants: [{ case_id: CASE_A, level: 'edit' }] });
  assert.deepEqual(pick(await authorize(runner, actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.draft)), { ok: true, role: 'author', scope: 'case' });
  assert.equal((await authorize(runner, actor, { workspaceId: WS, caseId: CASE_B }, ACTIONS.draft)).status, 403);
  assert.deepEqual(pick(await authorize(runner, actor, { workspaceId: WS, caseId: CASE_B }, ACTIONS.startRoom)), { ok: true, role: 'facilitator', scope: 'workspace' });
  // An owner with a Can run grant stays owner; an author with Can edit ties and keeps the workspace.
  assert.deepEqual(pick(await authorize(client({ role: 'owner', grants: [{ case_id: CASE_A, level: 'run' }] }), actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.startRoom)),
    { ok: true, role: 'owner', scope: 'workspace' });
  assert.deepEqual(pick(await authorize(client({ role: 'author', grants: [{ case_id: CASE_A, level: 'edit' }] }), actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.draft)),
    { ok: true, role: 'author', scope: 'workspace' });
  // A case-only runner starts their case and nothing else.
  const caseRunner = client({ grants: [{ case_id: CASE_A, level: 'run' }] });
  assert.deepEqual(pick(await authorize(caseRunner, actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.startRoom)), { ok: true, role: 'facilitator', scope: 'case' });
  assert.equal((await authorize(caseRunner, actor, { workspaceId: WS, caseId: CASE_A }, ACTIONS.draft)).status, 403);
  assert.equal((await authorize(caseRunner, actor, { workspaceId: WS, caseId: CASE_B }, ACTIONS.startRoom)).status, 403);
});

test('[AS-210] each policy decides its own cells per request: only a literal true is on', async () => {
  // P-03 owner (managers_invite), P-15 author and case author (editors_publish), P-43 runner (runners_share).
  const cases = [
    [{ role: 'owner' }, WS, ACTIONS.inviteMember, 'managers_invite'],
    [{ role: 'author' }, { workspaceId: WS, caseId: CASE_A }, ACTIONS.publish, 'editors_publish'],
    [{ grants: [{ case_id: CASE_A, level: 'edit' }] }, { workspaceId: WS, caseId: CASE_A }, ACTIONS.publish, 'editors_publish'],
    [{ grants: [{ case_id: CASE_A, level: 'edit' }] }, { workspaceId: WS, caseId: CASE_A }, ACTIONS.approveReview, 'editors_publish'],
    [{ role: 'facilitator' }, { workspaceId: WS, caseId: CASE_A }, ACTIONS.shareCase, 'runners_share'],
    [{ grants: [{ case_id: CASE_A, level: 'run' }] }, { workspaceId: WS, caseId: CASE_A }, ACTIONS.shareCase, 'runners_share'],
  ];
  for (const [who, place, action, key] of cases) {
    assert.equal((await authorize(client({ ...who, policies: { ...OFF, [key]: true } }), actor, place, action)).ok, true, `${action} ${key} on`);
    assert.equal((await authorize(client({ ...who, policies: OFF }), actor, place, action)).status, 403, `${action} ${key} off`);
    assert.equal((await authorize(client({ ...who, policies: { ...OFF, [key]: 'true' } }), actor, place, action)).status, 403, `${action} ${key} as a string`);
    // Another policy on does not open this one.
    const others = Object.fromEntries(Object.keys(OFF).map(name => [name, name !== key]));
    assert.equal((await authorize(client({ ...who, policies: others }), actor, place, action)).status, 403, `${action} with only other policies on`);
  }
  // Owners always approve and release (CASE-338), whatever editors_publish says.
  for (const action of [ACTIONS.publish, ACTIONS.approveReview])
    assert.equal((await authorize(client({ role: 'owner', policies: OFF }), actor, { workspaceId: WS, caseId: CASE_A }, action)).ok, true);
  // A database before the access migration sends no policies: every policy cell fails closed, nothing else changes.
  const legacy = { async call(name, args) {
    if (name === 'get_me') return { ok: true, data: [{ user_id: args.p_user_id, display_name: null, next_after: null, admin: false, memberships: [{ workspace_id: WS, role: 'owner' }] }] };
    return { ok: true, data: true };
  } };
  assert.equal((await authorize(legacy, actor, WS, ACTIONS.inviteMember)).status, 403);
  assert.equal((await authorize(legacy, actor, WS, ACTIONS.draft)).ok, true);
  assert.equal((await authorize(legacy, actor, WS, ACTIONS.readRoomHistory)).ok, true, 'own+pol is at least own');
});

test('[AS-207] a workspace record list admits a case-only runner (their own rooms; SQL filters) but no other workspace read', async () => {
  const caseRunner = client({ grants: [{ case_id: CASE_A, level: 'run' }] });
  assert.deepEqual(pick(await authorize(caseRunner, actor, { workspaceId: WS, anyCase: true }, ACTIONS.readRoomHistory)), { ok: true, role: 'facilitator', scope: 'case' });
  assert.equal((await authorize(caseRunner, actor, WS, ACTIONS.readRoomHistory)).status, 403, 'without anyCase the grant does not count');
  assert.equal((await authorize(caseRunner, actor, { workspaceId: WS, anyCase: true }, ACTIONS.readSettings)).status, 403);
  assert.equal((await authorize(client(), actor, { workspaceId: WS, anyCase: true }, ACTIONS.readRoomHistory)).status, 403);
});

test('[AS-207] a start is pre-checked on the workspace (any grant there), then decided on the version\'s own case from the same read', async () => {
  const caseRunner = client({ grants: [{ case_id: CASE_A, level: 'run' }] });
  const pre = await authorize(caseRunner, actor, { workspaceId: WS, anyCase: true }, ACTIONS.startRoom);
  assert.equal(pre.ok, true);
  assert.deepEqual(onCase(pre, CASE_A, ACTIONS.startRoom), { ok: true, role: 'facilitator', scope: 'case' });
  assert.deepEqual(onCase(pre, CASE_B, ACTIONS.startRoom), { ok: false, error: 'forbidden', status: 403 });
  assert.deepEqual(onCase(pre, null, ACTIONS.startRoom), { ok: false, error: 'forbidden', status: 403 }, 'a version with no case is not a grant\'s');
  assert.equal(caseRunner.calls.filter(([name]) => name === 'get_me').length, 1);
  const member = await authorize(client({ role: 'facilitator' }), actor, { workspaceId: WS, anyCase: true }, ACTIONS.startRoom);
  assert.deepEqual(onCase(member, CASE_B, ACTIONS.startRoom), { ok: true, role: 'facilitator', scope: 'workspace' });
  assert.equal((await authorize(client(), actor, { workspaceId: WS, anyCase: true }, ACTIONS.startRoom)).status, 403, 'nothing held: refused before the version');
  assert.deepEqual(onCase(await authorize(client(), admin, { workspaceId: WS, anyCase: true }, ACTIONS.startRoom), CASE_B, ACTIONS.startRoom), { ok: true, role: 'admin', scope: 'workspace' });
});

test('[AS-206] a case place without its workspace reads get_access once; the workspace comes from the case row', async () => {
  const rows = { [CASE_A]: { workspace_id: WS, member_role: null, grant_level: 'edit', role: 'author', scope: 'case', policies: POLICIES } };
  const fake = client({ access: args => ({ case_id: args.p_case_id, ...rows[args.p_case_id] }) });
  const found = await authorize(fake, actor, { caseId: CASE_A }, ACTIONS.draft);
  assert.deepEqual(pick(found), { ok: true, role: 'author', scope: 'case' }); assert.equal(found.workspaceId, WS);
  assert.deepEqual(fake.calls.map(([name]) => name), ['get_access']);
  assert.equal(fake.calls[0][1].p_workspace_id, null);
  assert.equal((await authorize(client(), actor, { caseId: CASE_B }, ACTIONS.draft)).status, 403, 'nothing held is forbidden');
  assert.equal((await authorize(client(), admin, { caseId: CASE_B }, ACTIONS.draft)).status, 404, 'an admin is told the case is missing');
  // A malformed row is an outage, never a decision.
  const odd = client({ access: args => ({ case_id: args.p_case_id, workspace_id: OTHER_WS, member_role: 'boss', grant_level: null, policies: {} }) });
  assert.equal((await authorize(odd, actor, { caseId: CASE_A }, ACTIONS.draft)).status, 503);
});

test('[AS-206] holds() mirrors the shared decision: strongest allowed principal, tie keeps the workspace', () => {
  assert.deepEqual(holds(ACTIONS.draft, { role: 'facilitator', grant: 'edit', policies: POLICIES }), { role: 'author', scope: 'case' });
  assert.deepEqual(holds(ACTIONS.startRoom, { role: 'author', grant: 'run', policies: POLICIES }), { role: 'author', scope: 'workspace' });
  assert.equal(holds(ACTIONS.createCase, { grant: 'edit', policies: POLICIES }), null);
  assert.equal(holds(ACTIONS.draft, { grant: 'manage', policies: POLICIES }), null, 'Can manage is never a grant');
  assert.equal(holds('P-99', { role: 'owner' }), null);
});

test('[AS-207] a console mint uses the case the room was started from: a case-only starter re-mints, a grant on another case does not', async () => {
  const room = { ok: true, workspaceId: WS, caseId: CASE_A, ownerAdminDigest: null, inlineDev: false };
  assert.deepEqual(await mayMintConsole(client({ grants: [{ case_id: CASE_A, level: 'run' }] }), actor, room, ACTIONS.mintConsole, {}), { ok: true });
  assert.deepEqual(await mayMintConsole(client({ grants: [{ case_id: CASE_A, level: 'run' }] }), actor, room, ACTIONS.approveSharedPc, {}), { ok: true });
  assert.equal((await mayMintConsole(client({ grants: [{ case_id: CASE_B, level: 'run' }] }), actor, room, ACTIONS.mintConsole, {})).status, 403);
  assert.equal((await mayMintConsole(client(), actor, room, ACTIONS.mintConsole, {})).status, 403, 'a revoked grant mints nothing');
  // A room that recorded no case (started before this Worker) is decided by the membership, as before.
  const legacy = { ok: true, workspaceId: WS, ownerAdminDigest: null, inlineDev: false };
  assert.equal((await mayMintConsole(client({ grants: [{ case_id: CASE_A, level: 'run' }] }), actor, legacy, ACTIONS.mintConsole, {})).status, 403);
  assert.deepEqual(await mayMintConsole(client({ role: 'facilitator' }), actor, legacy, ACTIONS.mintConsole, {}), { ok: true });
  // A malformed recorded case is an outage.
  assert.equal((await mayMintConsole(client({ role: 'facilitator' }), actor, { ...room, caseId: 'nope' }, ACTIONS.mintConsole, {})).status, 503);
});

test('[AS-207] /me/profile admits an account with a membership or a grant, and refuses one with neither', async () => {
  const put = fake => handleFacilitatorApi(new Request('https://case.test/api/v1/me/profile', { method: 'PUT',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fay Runner', role: 'ICU registrar' }) }),
  { env: {}, rpc: fake, verifyUser: async () => ({ userId: USER, email: 'fay@example.org', sessionId: uuidv7() }) });
  assert.equal((await put(client({ grants: [{ case_id: CASE_A, level: 'run' }] }))).status, 200);
  assert.equal((await put(client({ role: 'facilitator' }))).status, 200);
  const none = client();
  assert.equal((await put(none)).status, 403);
  assert.ok(!none.calls.some(([name]) => name === 'set_own_facilitator_label'));
});

function pick(result) { return result.ok ? { ok: true, role: result.role, scope: result.scope } : result; }
