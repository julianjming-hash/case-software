// Card 30 (CASE-168 (3), docs/PERMISSIONS.md P-12, P-18 to P-20, E14, E16): the group routes. The SQL
// behaviour (uniqueness, the composite foreign key, archive dispositions, audit) is db/tests/case-groups.test.sql;
// here the Worker passes only the verified subject and cleaned fields, authorizes through the one core before any
// group RPC, demands the session's admin elevation for an admin archive, and maps refusals to fixed errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { mintElevation } from '../src/worker/admin/stepup.mjs';
import { GROUP_TINTS, cleanGroupName, validCatalogueGroupRow, cleanGroupDescription, validGroupRow } from '../src/shared/groups.mjs';

import { GROUPS } from '../src/shared/mosaic-geometry.mjs';
import { readFileSync } from 'node:fs';

const WS = uuidv7(), OTHER = uuidv7(), GROUP = uuidv7(), MOVE = uuidv7(), CASE = uuidv7(), SESSION = uuidv7();
const SECRET = newCapabilityToken(), ADMIN = 'groups-admin@example.org';
const PEOPLE = { owner: uuidv7(), author: uuidv7(), facilitator: uuidv7(), outsider: uuidv7(), admin: uuidv7() };
const ROLE = { [PEOPLE.owner]: 'owner', [PEOPLE.author]: 'author', [PEOPLE.facilitator]: 'facilitator' };
const env = { ADMIN_EMAILS: ADMIN, STEPUP_SECRET: SECRET };
const email = who => who === 'admin' ? ADMIN : `${who}@example.org`;

function setup(who, handlers = {}) {
  const calls = [];
  const rpc = { call: async (name, args) => {
    if (name === 'admin_account_active') return { ok: true, data: true };
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === 'get_me') {
      const role = args.p_admin ? 'admin' : ROLE[args.p_user_id];
      const rows = args.p_admin ? [WS, OTHER].map(id => ({ workspace_id: id, role }))
        : role ? [{ workspace_id: WS, role }] : args.p_user_id === PEOPLE.outsider ? [{ workspace_id: OTHER, role: 'owner' }] : [];
      return { ok: true, data: [{ user_id: args.p_user_id, display_name: 'G', next_after: null, admin: args.p_admin === true,
        memberships: rows.filter(row => args.p_workspace_id === null || row.workspace_id === args.p_workspace_id) }] };
    }
    if (name === 'list_groups') return { ok: true, data: [{ id: GROUP, name: 'Emergency', description: null, tint: 'petrol', revision: 3, case_count: 2 }] };
    if (name === 'create_group') return { ok: true, data: [{ id: GROUP, revision: 0 }] };
    if (name === 'edit_group') return { ok: true, data: [{ id: GROUP, revision: args.p_expected_revision + 1 }] };
    if (name === 'archive_group') return { ok: true, data: [{ id: GROUP, revision: args.p_expected_revision + 1, moved: 2 }] };
    if (name === 'assign_case_group') return { ok: true, data: [{ case_id: CASE, group_id: args.p_group_id, group_revision: args.p_expected_revision + 1 }] };
    return { ok: true, data: null };
  } };
  const user = who === 'signedOut' ? null : { userId: PEOPLE[who], email: email(who), sessionId: SESSION };
  return { calls, deps: { rpc, env, onAlert() {}, verifyUser: async () => user } };
}
const send = (run, path, method = 'GET', body, headers = {}) => handleFacilitatorApi(new Request(`https://case.test/api/v1${path}`, {
  method, headers: { authorization: 'Bearer jwt', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) }), run.deps);
const WRITES = [
  ['create', `/workspaces/${WS}/groups`, 'POST', { name: 'Paediatrics', description: 'Children', tint: 'sage' }, 'create_group'],
  ['edit', `/workspaces/${WS}/groups/${GROUP}`, 'PUT', { expectedRevision: 3, name: 'Emergency', description: null, tint: 'coral' }, 'edit_group'],
  ['archive', `/workspaces/${WS}/groups/${GROUP}/archive`, 'POST', { expectedRevision: 3, confirmName: 'Emergency', moveTo: MOVE }, 'archive_group'],
  ['assign', `/workspaces/${WS}/cases/${CASE}/group`, 'PUT', { expectedRevision: 0, groupId: GROUP }, 'assign_case_group'],
];

test('[C30-routes] the ten tints are the renderer\'s ten, and the SQL allow-list names the same ten', () => {
  assert.deepEqual([...GROUP_TINTS].sort(), Object.keys(GROUPS).sort());
  const sql = readFileSync(new URL('../db/supabase/migrations/20261009000000_case_groups.sql', import.meta.url), 'utf8');
  const listed = /p_tint in \(([^)]*)\)/.exec(sql)[1].split(',').map(item => item.trim().replace(/'/g, ''));
  assert.deepEqual(listed.sort(), [...GROUP_TINTS].sort());
});

test('[C30-routes] an owner lists, creates, edits, archives and assigns with the verified subject and cleaned fields', async () => {
  const run = setup('owner');
  const listed = await send(run, `/workspaces/${WS}/groups`);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { groups: [{ id: GROUP, name: 'Emergency', description: null, tint: 'petrol', revision: 3, caseCount: 2 }] });
  assert.deepEqual(run.calls.find(c => c.name === 'list_groups').args, { p_user_id: PEOPLE.owner, p_workspace_id: WS, p_admin: false, p_admin_email: null });
  const statuses = [];
  for (const [, path, method, body] of WRITES) statuses.push((await send(run, path, method, body)).status);
  assert.deepEqual(statuses, [201, 200, 200, 200]);
  const args = name => run.calls.find(c => c.name === name).args;
  assert.deepEqual(args('create_group'), { p_user_id: PEOPLE.owner, p_workspace_id: WS, p_name: 'Paediatrics', p_description: 'Children',
    p_tint: 'sage', p_admin: false, p_admin_email: null });
  assert.deepEqual(args('edit_group'), { p_user_id: PEOPLE.owner, p_workspace_id: WS, p_group_id: GROUP, p_expected_revision: 3,
    p_name: 'Emergency', p_description: null, p_tint: 'coral', p_admin: false, p_admin_email: null });
  // An owner archives with the typed name only (PERMISSIONS §4: no step-up for P-19's owner cell).
  assert.deepEqual(args('archive_group'), { p_user_id: PEOPLE.owner, p_workspace_id: WS, p_group_id: GROUP, p_expected_revision: 3,
    p_confirm_name: 'Emergency', p_move_to: MOVE, p_admin: false, p_admin_email: null, p_elevation_id: null });
  assert.deepEqual(args('assign_case_group'), { p_user_id: PEOPLE.owner, p_workspace_id: WS, p_case_id: CASE, p_expected_revision: 0,
    p_group_id: GROUP, p_admin: false, p_admin_email: null });
  // Names and descriptions are cleaned as every human string is (cleanText); an empty description is none.
  const clean = setup('owner');
  await send(clean, `/workspaces/${WS}/groups`, 'POST', { name: '  Night\t   shift\u0007 ', description: '', tint: 'plum' });
  assert.deepEqual(clean.calls.find(c => c.name === 'create_group').args.p_name, 'Night shift');
  assert.equal(clean.calls.find(c => c.name === 'create_group').args.p_description, null);
  // An invisible character (here a bidi override, Default_Ignorable) is refused, never cleaned into a lookalike.
  const hidden = setup('owner');
  assert.equal((await send(hidden, `/workspaces/${WS}/groups`, 'POST', { name: 'Night\u202eshift', description: null, tint: 'plum' })).status, 400);
  assert.equal(hidden.calls.some(c => c.name === 'create_group'), false);
});

test('[PM-16] an author, a facilitator and an owner of another workspace are refused every group write before any group RPC', async () => {
  for (const who of ['author', 'facilitator', 'outsider']) {
    for (const [label, path, method, body, rpc] of WRITES) {
      const run = setup(who);
      const response = await send(run, path, method, body);
      assert.equal(response.status, 403, `${who} ${label}`);
      assert.equal(run.calls.some(c => c.name === rpc), false, `${who} ${label} reached ${rpc}`);
    }
    // Reading groups (P-12) is every member's; an outsider is refused.
    const read = setup(who);
    assert.equal((await send(read, `/workspaces/${WS}/groups`)).status, who === 'outsider' ? 403 : 200, who);
  }
  const signedOut = setup('signedOut');
  for (const [, path, method, body] of WRITES) assert.equal((await send(signedOut, path, method, body)).status, 401);
  assert.equal(signedOut.calls.length, 0);
});

test('[C30-routes] an admin writes any workspace\'s groups; archive needs this session\'s admin elevation, named to SQL', async () => {
  for (const [label, path, method, body, rpc] of WRITES.filter(([label]) => label !== 'archive')) {
    const run = setup('admin');
    assert.ok((await send(run, path, method, body)).status < 300, label);
    const call = run.calls.find(c => c.name === rpc).args;
    assert.equal(call.p_admin, true); assert.equal(call.p_admin_email, ADMIN);
  }
  const [, path, method, body] = WRITES[2];
  const bare = setup('admin');
  assert.equal((await send(bare, path, method, body)).status, 403);
  assert.equal(bare.calls.some(c => c.name === 'archive_group'), false);
  const elsewhere = await mintElevation(ADMIN, uuidv7(), SECRET);
  const replayed = setup('admin');
  assert.equal((await send(replayed, path, method, body, { 'x-admin-elevation': elsewhere.token })).status, 403, 'another session\'s elevation');
  const minted = await mintElevation(ADMIN, SESSION, SECRET);
  const elevated = setup('admin');
  const response = await send(elevated, path, method, body, { 'x-admin-elevation': minted.token });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { group: { id: GROUP, revision: 4 }, moved: 2 });
  assert.equal(elevated.calls.find(c => c.name === 'archive_group').args.p_elevation_id, minted.jti);
  // An owner's request never forwards an elevation, even one it sends.
  const owner = setup('owner');
  await send(owner, path, method, body, { 'x-admin-elevation': minted.token });
  assert.equal(owner.calls.find(c => c.name === 'archive_group').args.p_elevation_id, null);
});

test('[C30-routes] malformed bodies are 400 before any group RPC; SQL refusals map to fixed errors', async () => {
  const bad = [
    [`/workspaces/${WS}/groups`, 'POST', { name: '   ', description: null, tint: 'sage' }],
    [`/workspaces/${WS}/groups`, 'POST', { name: 'n'.repeat(61), description: null, tint: 'sage' }],
    [`/workspaces/${WS}/groups`, 'POST', { name: 'Fine', description: 'd'.repeat(201), tint: 'sage' }],
    [`/workspaces/${WS}/groups`, 'POST', { name: 'Fine', description: null, tint: 'teal' }],
    [`/workspaces/${WS}/groups`, 'POST', { name: 'Fine', description: null, tint: 'sage', workspaceId: OTHER }],
    [`/workspaces/${WS}/groups/${GROUP}`, 'PUT', { expectedRevision: -1, name: 'Fine', description: null, tint: 'sage' }],
    [`/workspaces/${WS}/groups/${GROUP}/archive`, 'POST', { expectedRevision: 1, confirmName: 'Fine', moveTo: 'nope' }],
    [`/workspaces/${WS}/groups/${GROUP}/archive`, 'POST', { expectedRevision: 1, moveTo: null }],
    [`/workspaces/${WS}/cases/${CASE}/group`, 'PUT', { expectedRevision: 0, groupId: 'Emergency' }],
    [`/workspaces/${WS}/cases/${CASE}/group`, 'PUT', { groupId: null }],
  ];
  for (const [path, method, body] of bad) {
    const run = setup('owner');
    assert.equal((await send(run, path, method, body)).status, 400, JSON.stringify(body));
    assert.equal(run.calls.some(c => /group/.test(c.name)), false);
  }
  const refusal = code => () => ({ ok: false, kind: code === '40001' ? 'conflict' : code === '23505' ? 'unique' : code === 'P0002' ? 'not_found' : 'bad_request', status: 400, code });
  const cases = [
    [WRITES[0], 'create_group', '23505', 409, 'name_taken'], [WRITES[1], 'edit_group', '40001', 409, 'conflict'],
    [WRITES[1], 'edit_group', 'P0002', 404, 'not_found'], [WRITES[2], 'archive_group', '23514', 422, 'confirm_mismatch'],
    [WRITES[0], 'create_group', '23514', 422, 'invalid_group'], [WRITES[3], 'assign_case_group', 'P0002', 404, 'not_found'],
  ];
  for (const [[, path, method, body], name, code, status, error] of cases) {
    const run = setup('owner', { [name]: refusal(code) });
    const response = await send(run, path, method, body);
    assert.equal(response.status, status, `${name} ${code}`);
    assert.deepEqual(await response.json(), { error });
  }
  // A malformed answer is unavailable, never passed on.
  const odd = setup('owner', { list_groups: () => ({ ok: true, data: [{ id: GROUP, name: 'E', description: null, tint: 'magenta', revision: 0, case_count: 0 }] }) });
  assert.equal((await send(odd, `/workspaces/${WS}/groups`)).status, 503);
});

test('[C30-routes] shared validators: names and descriptions follow cleanText, rows are exact', () => {
  assert.equal(cleanGroupName(' Critical\tcare '), 'Critical care');
  assert.equal(cleanGroupName('x'.repeat(61)), null);
  assert.equal(cleanGroupName(7), null);
  assert.equal(cleanGroupDescription(''), null);
  assert.equal(cleanGroupDescription(null), null);
  assert.equal(cleanGroupDescription('d'.repeat(201)), undefined);
  assert.equal(validGroupRow({ id: GROUP, name: 'E', description: null, tint: 'sky', revision: 0, caseCount: 0 }), true);
  assert.equal(validGroupRow({ id: GROUP, name: 'E', description: null, tint: 'sky', revision: 0, caseCount: 0, workspace: WS }), false);
  assert.equal(validCatalogueGroupRow({ id: null, name: null, tint: 'neutral', count: 3 }), true);
  assert.equal(validCatalogueGroupRow({ id: null, name: 'Ungrouped', tint: 'neutral', count: 3 }), false);
});

test('[C30-routes] the Groups screen refreshes only when nothing is being edited, and names every refusal', async () => {
  const { mayRefresh, groupMessage } = await import('../src/client/groups-screen.mjs');
  const idle = { editing: false, dialogOpen: false, busy: false, drafting: false, focusInForm: false };
  assert.equal(mayRefresh(idle), true);
  for (const key of Object.keys(idle)) assert.equal(mayRefresh({ ...idle, [key]: true }), false, key);
  for (const code of ['name_taken', 'conflict', 'not_found', 'confirm_mismatch', 'invalid_group', 'forbidden'])
    assert.notEqual(groupMessage(code), groupMessage('something_else'), code);
  assert.match(groupMessage(null), /Nothing was changed/);
});

test('[C30-routes] invisible characters (Default_Ignorable_Code_Point) are refused in names and descriptions, and SQL refuses the same set', () => {
  for (const ch of ['​', '‍', '⁠', '­', '͏', '᠎', '️', '\u{E0041}', 'ㅤ'])
    { assert.equal(cleanGroupName(`Emer${ch}gency`), null, ch.codePointAt(0).toString(16)); assert.equal(cleanGroupDescription(`A${ch}B`), undefined); }
  assert.equal(cleanGroupName('Emergency'), 'Emergency');
  assert.equal(cleanGroupName('Еmergency'), 'Еmergency', 'a cross-script lookalike is accepted (Julian, red-team ruling)');
  // The SQL check names exactly the Default_Ignorable_Code_Point set, as ranges in one bracket class.
  const sql = readFileSync(new URL('../db/supabase/migrations/20261009000000_case_groups.sql', import.meta.url), 'utf8');
  const cls = /-- DEFAULT_IGNORABLE\n\s*'\[([^\]]*)\]'/.exec(sql)[1];
  const listed = new Set();
  for (const [, a, b] of cls.matchAll(/\\[uU]([0-9a-f]+)(?:-\\[uU]([0-9a-f]+))?/gi))
    for (let cp = parseInt(a, 16); cp <= parseInt(b ?? a, 16); cp++) listed.add(cp);
  const expected = new Set();
  for (let cp = 0; cp <= 0x10ffff; cp++) if (!(cp >= 0xd800 && cp <= 0xdfff) && /\p{Default_Ignorable_Code_Point}/u.test(String.fromCodePoint(cp))) expected.add(cp);
  assert.deepEqual([...listed].sort((x, y) => x - y), [...expected].sort((x, y) => x - y));
});
