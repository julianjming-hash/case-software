// Card 29 (CASE-166): the catalogue query contract and its Worker routes. The SQL behaviour (whole-set
// sort and filter, bounded pages, membership) is proved in db/tests/case-catalogue.test.sql; here the
// Worker passes only the verified subject and a validated query, refuses another workspace before any
// catalogue RPC, and serves public library fields only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { parseCatalogueQuery, catalogueSearch, validCatalogueRow, CATALOGUE_PAGE_MAX } from '../src/shared/catalogue.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { catalogueCase } from '../src/client/case-detail.mjs';

const userId = uuidv7(), workspaceId = uuidv7(), otherWorkspace = uuidv7(), caseId = uuidv7(), versionId = uuidv7(), groupId = uuidv7();
const digest = `\\x${'b'.repeat(64)}`;
const art = withSolution(describeCase(miniCase().doc), { attempt: 1, summarised: false });
const row = (over = {}) => ({ version_id: versionId, case_id: caseId, title: 'Sepsis', summary: 'A summary',
  audience: 'Junior doctors', setting: 'Emergency department', duration_min: 15, version_no: 2,
  published_at: '2026-10-01T00:00:00+00:00', content_sha256: digest, art, group_id: null, group_name: null, tint: 'neutral',
  total_count: 7, ...over });
const olderVersion = uuidv7();
const VERSIONS = [{ version_id: versionId, version_no: 2, published_at: '2026-10-01T00:00:00+00:00', content_sha256: digest },
  { version_id: olderVersion, version_no: 1, published_at: '2026-09-01T00:00:00+00:00', content_sha256: digest }];
const request = (path, token = 'Bearer jwt') => new Request(`https://case.test/api/v1${path}`, {
  headers: token ? { authorization: token } : {} });
function setup(handlers = {}, env = {}) {
  const calls = [];
  const rpc = { call: async (name, args) => {
    if (name === 'admin_account_active') return { ok: true, data: true };
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === 'get_me') return { ok: true, data: [{ user_id: userId, display_name: 'F',
      memberships: args.p_workspace_id === workspaceId || args.p_workspace_id === null
        ? [{ workspace_id: workspaceId, role: args.p_admin ? 'admin' : 'facilitator' }] : [], next_after: null, admin: args.p_admin === true }] };
    if (name === 'list_case_catalogue_current') return { ok: true, data: [row()] };
    if (name === 'list_case_catalogue_audiences') return { ok: true, data: [{ audience: 'Nurses', case_count: 3 }] };
    if (name === 'get_catalogue_case_history') return { ok: true, data: [{ workspace_id: workspaceId, role: 'author', ...row(),
      learning_objectives: ['Recognise it'], versions: VERSIONS }].map(({ total_count, group_id, group_name, tint, ...rest }) => rest) };
    if (name === 'get_case_group') return { ok: true, data: [{ case_id: caseId, workspace_id: workspaceId, group_id: groupId,
      group_name: 'Emergency', tint: 'petrol', group_revision: 4 }] };
    if (name === 'list_case_catalogue_groups') return { ok: true, data: [{ group_id: groupId, name: 'Emergency', tint: 'petrol', case_count: 5 },
      { group_id: null, name: null, tint: 'neutral', case_count: 2 }] };
    return { ok: true, data: null };
  } };
  return { calls, deps: { rpc, env, onAlert() {}, verifyUser: async token => token === 'jwt'
    ? { userId, email: 'owner@example.invalid' } : null } };
}

test('[AS-101] catalogue query contract: defaults, bounds and refusals are shared by client and Worker', () => {
  assert.deepEqual(parseCatalogueQuery(new URLSearchParams()), { sort: 'title', descending: false, query: '',
    duration: null, audience: null, group: null, limit: 24, offset: 0 });
  const full = catalogueSearch({ sort: 'length', descending: true, query: '  sepsis ', duration: 45, audience: 'Nurses', limit: 10, offset: 20 });
  assert.deepEqual(parseCatalogueQuery(full), { sort: 'length', descending: true, query: 'sepsis', duration: 45,
    audience: 'Nurses', group: null, limit: 10, offset: 20 });
  // Card 30: the group filter is a live group's id or Ungrouped; the board and table sort by group.
  assert.deepEqual(parseCatalogueQuery(catalogueSearch({ sort: 'group', group: groupId })), { sort: 'group', descending: false,
    query: '', duration: null, audience: null, group: groupId, limit: 24, offset: 0 });
  assert.equal(parseCatalogueQuery(catalogueSearch({ group: 'ungrouped' })).group, 'ungrouped');
  for (const bad of ['sort=beats', 'order=up', `limit=${CATALOGUE_PAGE_MAX + 1}`, 'limit=0', 'offset=10001', 'offset=-1',
    'length=17', `q=${'x'.repeat(81)}`, 'audience=', 'sort=title&sort=length', 'workspace=x', 'limit=1e2',
    'group=Emergency', 'group=', `group=${groupId}&group=ungrouped`])
    assert.equal(parseCatalogueQuery(new URLSearchParams(bad)), null, bad);
  assert.throws(() => catalogueSearch({ limit: 500 }));
  assert.equal(validCatalogueRow((({ total_count, ...rest }) => rest)(row())), true);
  assert.equal(validCatalogueRow((({ total_count, ...rest }) => ({ ...rest, beats: [] }))(row())), false);
  assert.equal(validCatalogueRow((({ total_count, ...rest }) => ({ ...rest, duration_min: 17 }))(row())), false);
  assert.equal(validCatalogueRow((({ total_count, ...rest }) => ({ ...rest, group_id: groupId, group_name: 'Emergency', tint: 'petrol' }))(row())), true);
  for (const over of [{ tint: 'teal' }, { tint: null }, { group_id: groupId, group_name: null, tint: 'petrol' },
    { group_id: null, group_name: 'Emergency', tint: 'neutral' }, { group_id: null, group_name: null, tint: 'sky' }])
    assert.equal(validCatalogueRow((({ total_count, ...rest }) => ({ ...rest, ...over }))(row())), false, JSON.stringify(over));
});

test('[AS-101] GET catalogue passes the verified subject and the validated query; total is the whole set', async () => {
  const run = setup();
  const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue?sort=length&order=desc&q=sep&length=15&audience=Nurses&limit=10&offset=6`), run.deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  const call = run.calls.find(c => c.name === 'list_case_catalogue_current');
  assert.deepEqual(call.args, { p_user_id: userId, p_workspace_id: workspaceId, p_sort: 'length', p_descending: true,
    p_query: 'sep', p_duration: 15, p_audience: 'Nurses', p_limit: 10, p_offset: 6, p_group_id: null, p_ungrouped: false,
    p_admin: false, p_admin_email: null });
  assert.equal(body.total, 7); assert.equal(body.offset, 6);
  assert.equal(body.cases.length, 1);
  assert.equal(validCatalogueRow(body.cases[0]), true, 'served rows carry public library fields only');
  assert.equal('total_count' in body.cases[0], false);
  assert.ok(Object.hasOwn(body, 'pilotPin'));
});

test('[AS-101] another workspace is refused before any catalogue RPC; malformed queries are 400 before any RPC', async () => {
  const run = setup();
  for (const path of [`/workspaces/${otherWorkspace}/catalogue`, `/workspaces/${otherWorkspace}/catalogue/audiences`]) {
    const response = await handleFacilitatorApi(request(path), run.deps);
    assert.equal(response.status, 403, path);
  }
  assert.equal(run.calls.some(c => c.name.startsWith('list_case_catalogue_current')), false);
  const before = run.calls.length;
  for (const query of ['sort=beats', 'limit=100', 'offset=10001', 'length=17', 'extra=1']) {
    const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue?${query}`), run.deps);
    assert.equal(response.status, 400, query);
  }
  assert.equal(run.calls.length, before);
  for (const token of [null, 'Bearer forged']) {
    const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue`, token), run.deps);
    assert.equal(response.status, 401);
  }
});

test('[AS-101] the Worker refuses a catalogue row with any field beyond the public library fields', async () => {
  for (const bad of [row({ beats: [{ text: 'private' }] }), row({ duration_min: 17 }), row({ version_id: 'x' }),
    row({ summary: 'x'.repeat(1201) }), row({ total_count: 'many' })]) {
    const run = setup({ list_case_catalogue_current: () => ({ ok: true, data: [bad] }) });
    const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue`), run.deps);
    assert.equal(response.status, 503);
  }
  const run = setup({ list_case_catalogue_current: () => ({ ok: true, data: Array.from({ length: 11 }, () => row()) }) });
  assert.equal((await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue?limit=10`), run.deps)).status, 503,
    'a page larger than the requested limit is refused');
});

test('[C30-catalogue] the group filter runs on the server; group rows and counts are served exactly', async () => {
  const filtered = setup({ list_case_catalogue_current: () => ({ ok: true, data: [row({ group_id: groupId, group_name: 'Emergency', tint: 'petrol' })] }) });
  const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue?sort=group&group=${groupId}`), filtered.deps);
  assert.equal(response.status, 200);
  const call = filtered.calls.find(c => c.name === 'list_case_catalogue_current').args;
  assert.equal(call.p_sort, 'group'); assert.equal(call.p_group_id, groupId); assert.equal(call.p_ungrouped, false);
  const body = await response.json();
  assert.deepEqual([body.cases[0].group_id, body.cases[0].group_name, body.cases[0].tint], [groupId, 'Emergency', 'petrol']);
  const ungrouped = setup();
  await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue?group=ungrouped`), ungrouped.deps);
  const args = ungrouped.calls.find(c => c.name === 'list_case_catalogue_current').args;
  assert.equal(args.p_group_id, null); assert.equal(args.p_ungrouped, true);
  for (const bad of [row({ tint: 'magenta' }), row({ group_id: groupId, group_name: '', tint: 'sky' }), row({ group_name: 'Leaked', tint: 'neutral' })]) {
    const run = setup({ list_case_catalogue_current: () => ({ ok: true, data: [bad] }) });
    assert.equal((await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue`), run.deps)).status, 503);
  }
  const groups = setup();
  const listed = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue/groups`), groups.deps);
  assert.deepEqual(await listed.json(), { groups: [{ id: groupId, name: 'Emergency', tint: 'petrol', count: 5 }, { id: null, name: null, tint: 'neutral', count: 2 }] });
  assert.deepEqual(groups.calls.find(c => c.name === 'list_case_catalogue_groups').args, { p_user_id: userId, p_workspace_id: workspaceId, p_admin: false, p_admin_email: null });
  assert.equal((await handleFacilitatorApi(request(`/workspaces/${otherWorkspace}/catalogue/groups`), setup().deps)).status, 403);
  // Over the cap (a race the database now serialises, or a legacy row): the filter degrades to the first 100
  // named groups and Ungrouped instead of failing the library.
  const many = Array.from({ length: 102 }, (_, n) => ({ group_id: uuidv7(), name: `Group ${String(n).padStart(3, '0')}`, tint: 'sky', case_count: 0 }));
  const over = setup({ list_case_catalogue_groups: () => ({ ok: true, data: [...many, { group_id: null, name: null, tint: 'neutral', case_count: 2 }] }) });
  const degraded = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue/groups`), over.deps);
  assert.equal(degraded.status, 200);
  const kept = (await degraded.json()).groups;
  assert.equal(kept.length, 101); assert.equal(kept.at(-1).id, null); assert.equal(kept[99].name, 'Group 099');
  const noUngrouped = setup({ list_case_catalogue_groups: () => ({ ok: true, data: [{ group_id: groupId, name: 'Emergency', tint: 'petrol', case_count: 5 }] }) });
  assert.equal((await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue/groups`), noUngrouped.deps)).status, 503);
});

test('[AS-101] audiences and case detail: bounded, public fields only, 404 outside the caller\'s workspaces', async () => {
  const run = setup();
  const audiences = await (await handleFacilitatorApi(request(`/workspaces/${workspaceId}/catalogue/audiences`), run.deps)).json();
  assert.deepEqual(audiences, { audiences: [{ audience: 'Nurses', count: 3 }] });
  const detail = await handleFacilitatorApi(request(`/cases/${caseId}/versions/2`), run.deps);
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.deepEqual(run.calls.find(c => c.name === 'get_catalogue_case_history').args, { p_user_id: userId, p_case_id: caseId, p_version_no: 2, p_admin: false, p_admin_email: null });
  assert.equal(body.case.workspace_id, workspaceId); assert.equal(body.case.role, 'author');
  assert.deepEqual(body.case.learning_objectives, ['Recognise it']);
  assert.deepEqual(body.case.versions, VERSIONS, 'detail lists every published version, so an older one stays startable');
  // Card 30: detail carries the case's group (its cover tint and the assignment revision for Change group).
  assert.deepEqual(body.case.group, { id: groupId, name: 'Emergency', tint: 'petrol', revision: 4 });
  assert.deepEqual(run.calls.find(c => c.name === 'get_case_group').args, { p_user_id: userId, p_case_id: caseId, p_admin: false, p_admin_email: null });
  const foreign = setup({ get_case_group: () => ({ ok: true, data: [{ case_id: caseId, workspace_id: otherWorkspace, group_id: null,
    group_name: null, tint: 'neutral', group_revision: 0 }] }) });
  assert.equal((await handleFacilitatorApi(request(`/cases/${caseId}/versions/2`), foreign.deps)).status, 503);
  for (const bad of [[{ ...VERSIONS[0], document: {} }], [{ ...VERSIONS[0], version_no: 0 }], Array.from({ length: 51 }, () => VERSIONS[0]), 'x']) {
    const refused = setup({ get_catalogue_case_history: () => ({ ok: true, data: [{ workspace_id: workspaceId, role: 'author',
      ...(({ total_count, ...rest }) => rest)(row()), learning_objectives: [], versions: bad }] }) });
    assert.equal((await handleFacilitatorApi(request(`/cases/${caseId}/versions/2`), refused.deps)).status, 503);
  }
  assert.equal(JSON.stringify(body).includes('beats'), false);
  const missing = setup({ get_catalogue_case_history: () => ({ ok: true, data: [] }) });
  assert.equal((await handleFacilitatorApi(request(`/cases/${caseId}/versions/2`), missing.deps)).status, 404);
  for (const path of [`/cases/${caseId}/versions/0`, `/cases/${caseId}/versions/x`, `/cases/not-a-uuid/versions/1`])
    assert.equal((await handleFacilitatorApi(request(path), run.deps))?.status ?? 404, path.includes('not-a-uuid') ? 404 : 400, path);
});

test('[AS-104] GET /me names the account and whether it is entitled to Administration; signed in is not admin', async () => {
  const plain = setup();
  const me = await (await handleFacilitatorApi(request('/me'), plain.deps)).json();
  assert.deepEqual(me.account, { email: 'owner@example.invalid', administration: false });
  const admin = setup({}, { ADMIN_EMAILS: 'owner@example.invalid' });
  assert.deepEqual((await (await handleFacilitatorApi(request('/me'), admin.deps)).json()).account,
    { email: 'owner@example.invalid', administration: true });
});

test('[AS-105] GET /me flags workspaces that may not start rooms here, so the picker labels them as operators\'', async () => {
  const run = setup({}, { CASE_REFUSED_ROOM_WORKSPACES: workspaceId });
  const me = await (await handleFacilitatorApi(request('/me'), run.deps)).json();
  assert.equal(me.memberships[0].rooms_refused, true);
  const plain = await (await handleFacilitatorApi(request('/me'), setup().deps)).json();
  assert.equal('rooms_refused' in plain.memberships[0], false);
});

test('schema3 catalogue duration 60 is accepted end to end', () => {
  assert.equal(parseCatalogueQuery(catalogueSearch({ duration: 60 })).duration, 60);
  const { total_count, ...published } = row({ duration_min: 60 });
  assert.equal(validCatalogueRow(published), true);
});

test('edition history keeps deployed version rows compatible and validates marker identities', async () => {
  const run = setup({ get_catalogue_case_history: () => ({ ok: true, data: [{ workspace_id: workspaceId, role: 'author',
    ...(({ total_count, group_id, group_name, tint, ...rest }) => rest)(row()), learning_objectives: ['Recognise it'],
    versions: VERSIONS.map((version, index) => ({ ...version, edition: index === 0 })) }] }) });
  const response = await handleFacilitatorApi(request(`/cases/${caseId}/versions/2`), run.deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.case.versions, VERSIONS, 'already-open clients require the original four-field version rows');
  assert.deepEqual(body.case.edition_version_ids, [versionId]);
  const parsed = catalogueCase(body, caseId, 2);
  assert.equal(parsed.versions[0].edition, true);
  assert.equal(parsed.versions[1].edition, false);
  for (const ids of [[uuidv7()], [versionId, versionId], 'invalid'])
    assert.throws(() => catalogueCase({ ...body, case: { ...body.case, edition_version_ids: ids } }, caseId, 2), /invalid_case/);
});
