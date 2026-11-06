import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { describeCase, withSolution, artPrivacyViolations } from '../src/shared/art-descriptor.mjs';

const userId = uuidv7(), workspaceId = uuidv7(), caseId = uuidv7(), versionId = uuidv7();
const contentSha256 = `\\x${'a'.repeat(64)}`;
const membership = { workspace_id: workspaceId, slug: 'fsh-icu', name: 'FSH ICU', role: 'owner' };
const bearer = 'Bearer test-only-jwt';
const draftDocument = miniCase().doc;
const art = withSolution(describeCase(draftDocument), { attempt: 3, summarised: false });
const request = (path, { method = 'GET', body, token = bearer } = {}) => new Request(`https://case.test/api/v1${path}`, {
  method, headers: token ? { authorization: token } : {}, body: body === undefined ? undefined : JSON.stringify(body),
});
const setup = (handlers = {}) => {
  const calls = [], alerts = [], verified = [], authorityCalls = [];
  const rpc = { call: async (name, args) => {
    if (name === 'admin_account_active') {
      authorityCalls.push({name,args});
      return handlers[name] ? handlers[name](args) : {ok:true,data:Object.keys(args).length===1 && args.p_user_id===userId};
    }
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === 'get_me') return { ok: true, data: [{ user_id: userId, display_name: 'Owner', memberships: args.p_admin ? [{ ...membership, role: 'admin' }] : [membership], next_after: null, admin: args.p_admin === true }] };
    if (name === 'get_case_authoring_access') return { ok: true, data: [{ case_id: caseId, workspace_id: workspaceId, role: 'owner' }] };
    if (name === 'bootstrap_workspace') return { ok: true, data: workspaceId };
    if (name === 'list_published_versions') return { ok: true, data: [{ version_id: versionId, case_id: caseId, title: 'Case' }] };
    if (name === 'create_case') return { ok: true, data: caseId };
    if (name === 'save_draft') return { ok: true, data: 1 };
    if (name === 'get_draft') return { ok: true, data: [{ revision: 1, schema_version: 1, document: draftDocument, updated_at: new Date().toISOString() }] };
    if (name === 'publish_draft_with_art') return { ok: true, data: [{ version_id: versionId, version_no: 1, content_sha256: contentSha256 }] };
    return { ok: true, data: null };
  } };
  const dependencies = { rpc, env: {}, onAlert: event => alerts.push(event),
    verifyUser: async (token) => { verified.push(token); return token === 'test-only-jwt' ? { userId, email: 'owner@example.invalid' } : null; } };
  return { dependencies, calls, alerts, verified, authorityCalls };
};

test('every facilitator route uses only the bearer subject; missing or forged JWT is 401 before RPC', async () => {
  const run = setup();
  for (const [path, method, body] of [
    ['/me', 'GET'], [`/workspaces/${workspaceId}/versions`, 'GET'],
    ['/workspaces', 'POST', { slug: 'pilot-icu', name: 'Pilot ICU' }],
    ['/cases', 'POST', { workspaceId, title: 'Case' }],
    [`/cases/${caseId}/draft`, 'PUT', { expectedRevision: 0, schemaVersion: 1, document: miniCase().doc }],
    [`/cases/${caseId}/publish`, 'POST', { expectedRevision: 1, assetIds: [], art }],
  ]) {
    for (const token of [null, 'Bearer forged']) {
      const response = await handleFacilitatorApi(request(path, { method, token, body }), run.dependencies);
      assert.equal(response.status, 401);
    }
  }
  assert.equal(run.calls.length, 0);
  assert.equal(run.verified.every(value => value !== userId), true);
});

test('[AS-078] GET /me returns one bounded own membership page without a caller-supplied user id', async () => {
  const run = setup();
  const after = uuidv7();
  const response = await handleFacilitatorApi(request(`/me?limit=25&after=${after}`), run.dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: { userId, displayName: 'Owner', role: null, labelConfirmed: null }, memberships: [membership], grants: [], nextAfter: null, joined: [],
    account: { email: 'owner@example.invalid', administration: false } });
  assert.deepEqual(run.authorityCalls,[{name:'admin_account_active',args:{p_user_id:userId}}]);
  assert.deepEqual(run.calls, [{ name: 'get_me', args: { p_user_id: userId, p_limit: 25, p_after: after, p_workspace_id: null, p_admin: false, p_admin_email: null } }]);
  assert.equal((await handleFacilitatorApi(request('/me?limit=101'), run.dependencies)).status, 400);
});

test('GET workspace versions preflights membership and returns only a bounded published page', async () => {
  const run = setup();
  const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/versions?limit=20`), run.dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { versions: [{ version_id: versionId, case_id: caseId, title: 'Case', art: null }], pilotPin: null, nextAfter: null });
  assert.deepEqual(run.calls.map(call => call.name), ['get_me', 'list_published_versions']);
  assert.equal(run.calls[1].args.p_user_id, userId);
  assert.equal(run.calls[1].args.p_workspace_id, workspaceId);

  const absent = setup({ get_me: async () => ({ ok: true, data: [{ user_id: userId, display_name: 'Owner', memberships: [], next_after: null, admin: false }] }) });
  assert.equal((await handleFacilitatorApi(request(`/workspaces/${workspaceId}/versions`), absent.dependencies)).status, 403);
  assert.deepEqual(absent.calls.map(call => call.name), ['get_me']);
});

test('[AS-095] Card20 pilot pin appears only on an authenticated member version page and fails closed when unconfigured', async () => {
  const row = { version_id: versionId, case_id: caseId, title: 'Case', content_sha256: contentSha256 };
  const run = setup({ list_published_versions: async () => ({ ok: true, data: [row] }) });
  run.dependencies.env = { CASE_PILOT_VERSION_ID: versionId, CASE_PILOT_CONTENT_SHA256: contentSha256 };
  const path = `/workspaces/${workspaceId}/versions`;
  const configured = await handleFacilitatorApi(request(path), run.dependencies);
  assert.equal(configured.status, 200);
  assert.deepEqual((await configured.json()).pilotPin, { versionId, contentSha256 });
  assert.deepEqual(run.calls.map(call => call.name), ['get_me', 'list_published_versions']);

  const before = run.calls.length;
  assert.equal((await handleFacilitatorApi(request(path, { token: 'Bearer forged' }), run.dependencies)).status, 401);
  assert.equal(run.calls.length, before);
  const nonmember = setup({ get_me: async () => ({ ok: true, data: [{ user_id: userId,
    display_name: 'Owner', memberships: [], next_after: null, admin: false }] }) });
  nonmember.dependencies.env = run.dependencies.env;
  assert.equal((await handleFacilitatorApi(request(path), nonmember.dependencies)).status, 403);
  assert.deepEqual(nonmember.calls.map(call => call.name), ['get_me']);

  run.dependencies.env = { CASE_PILOT_VERSION_ID: versionId, CASE_PILOT_CONTENT_SHA256: '' };
  const unconfigured = await handleFacilitatorApi(request(path), run.dependencies);
  assert.equal(unconfigured.status, 200);
  assert.equal((await unconfigured.json()).pilotPin, null);
});

test('a genuine 42501 on the version list stays 500 and emits a fixed safe alert', async () => {
  const run = setup({ list_published_versions: async () => ({ ok: false, kind: 'forbidden', status: 500, code: '42501' }) });
  const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/versions`), run.dependencies);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal_error' });
  assert.deepEqual(run.alerts, [{ kind: 'rpc_forbidden', name: 'list_published_versions' }]);
});

test('POST /cases uses verified subject and only owner/author workspace membership', async () => {
  const run = setup();
  const response = await handleFacilitatorApi(request('/cases', { method: 'POST', body: { workspaceId, title: '  Mini case  ', userId: uuidv7() } }), run.dependencies);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { caseId });
  assert.deepEqual(run.calls.map(call => call.name), ['get_me', 'ensure_profile', 'create_case']);
  assert.deepEqual(run.calls[2].args, { p_user_id: userId, p_workspace_id: workspaceId, p_title: 'Mini case', p_admin: false, p_admin_email: null });
  const facilitator = setup({ get_me: async () => ({ ok: true, data: [{ user_id: userId, display_name: 'Facilitator', memberships: [{ ...membership, role: 'facilitator' }], next_after: null, admin: false }] }) });
  assert.equal((await handleFacilitatorApi(request('/cases', { method: 'POST', body: { workspaceId, title: 'Case' } }), facilitator.dependencies)).status, 403);
  assert.equal(facilitator.calls.some(call => call.name === 'create_case'), false);
});

async function expectStalledBodyTimeout(initialChunk) {
  const run = setup();
  let cancels = 0;
  const stream = new ReadableStream({
    start(controller) { if (initialChunk) controller.enqueue(new TextEncoder().encode('{"workspaceId":')); },
    pull() { return new Promise(() => {}); },
    cancel() { cancels += 1; return new Promise(() => {}); },
  });
  const stalled = new Request('https://case.test/api/v1/cases', {
    method: 'POST', headers: { authorization: bearer }, body: stream, duplex: 'half',
  });
  const result = await Promise.race([
    handleFacilitatorApi(stalled, { ...run.dependencies, bodyTimeoutMs: 20 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('body read exceeded test watchdog')), 150)),
  ]);
  assert.equal(result.status, 408);
  assert.deepEqual(await result.json(), { error: 'request_timeout' });
  assert.equal(cancels, 1);
  assert.deepEqual(run.calls, []);
}

test('POST /cases times out a body stalled before its first chunk without awaiting cancellation', async () => {
  await expectStalledBodyTimeout(false);
});

test('POST /cases times out a body stalled after one chunk without awaiting cancellation', async () => {
  await expectStalledBodyTimeout(true);
});

test('PUT draft validates body and expected revision before save_draft; oversized body is 413', async () => {
  const run = setup();
  const document = miniCase().doc;
  const url = `/cases/${caseId}/draft`;
  const response = await handleFacilitatorApi(request(url, { method: 'PUT', body: { expectedRevision: 0, schemaVersion: 1, document } }), run.dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1 });
  assert.deepEqual(run.calls.map(call => call.name), ['get_case_authoring_access', 'save_draft']);
  assert.deepEqual(run.calls[1].args, { p_case_id: caseId, p_expected_revision: 0, p_schema_version: 1, p_document: document, p_user_id: userId, p_admin: false, p_admin_email: null });
  assert.equal((await handleFacilitatorApi(request(url, { method: 'PUT', body: { expectedRevision: -1, schemaVersion: 1, document } }), run.dependencies)).status, 400);
  assert.equal((await handleFacilitatorApi(request(url, { method: 'PUT', body: { expectedRevision: 0, schemaVersion: 1, document: {} } }), run.dependencies)).status, 422);
  const large = request(url, { method: 'PUT', body: { expectedRevision: 0, schemaVersion: 1, document: { padding: 'x'.repeat(1_048_576) } } });
  assert.equal((await handleFacilitatorApi(large, run.dependencies)).status, 413);
  assert.equal(run.calls.filter(call => call.name === 'save_draft').length, 1);
});

test('legacy POST publish refuses members and admin with a route to Pending, never calling the first-publication RPC', async () => {
  // An author is not entitled to P-15 while editors_publish is off: refused outright.
  const member = setup({ get_case_authoring_access: async () => ({ ok: true, data: [{ case_id: caseId, workspace_id: workspaceId, role: 'author' }] }) });
  const memberResponse = await handleFacilitatorApi(request(`/cases/${caseId}/publish`, { method: 'POST', body: { expectedRevision: 1, assetIds: [], art } }), member.dependencies);
  assert.equal(memberResponse.status, 403);
  assert.deepEqual(member.calls.map(call => call.name), ['get_case_authoring_access']);

  // An owner is entitled to P-15 (CASE-338), and is routed to Pending like the admin.
  const owner = setup();
  const ownerResponse = await handleFacilitatorApi(request(`/cases/${caseId}/publish`, { method: 'POST', body: { expectedRevision: 1, assetIds: [], art } }), owner.dependencies);
  assert.equal(ownerResponse.status, 409);
  assert.deepEqual(await ownerResponse.json(), { error: 'review_required' });
  assert.deepEqual(owner.calls.map(call => call.name), ['get_case_authoring_access']);

  const admin = setup({ get_case_authoring_access: async () => ({ ok: true, data: [{ case_id: caseId, workspace_id: workspaceId, role: 'admin' }] }) });
  admin.dependencies.env = { ADMIN_EMAILS: 'owner@example.invalid' };
  const adminResponse = await handleFacilitatorApi(request(`/cases/${caseId}/publish`, { method: 'POST', body: { expectedRevision: 1, assetIds: [], art } }), admin.dependencies);
  assert.equal(adminResponse.status, 409);
  assert.deepEqual(await adminResponse.json(), { error: 'review_required' });
  assert.deepEqual(admin.calls.map(call => call.name), ['get_case_authoring_access']);
  assert.equal(admin.calls.some(call => call.name === 'publish_draft_with_art'), false);
});

test('[CASE-164] the version list carries only a sanitised numbers-only art field per row', async () => {
  const rows = [
    { version_id: versionId, case_id: caseId, title: 'Case', art },
    { version_id: uuidv7(), case_id: caseId, title: 'Legacy', art: null },
    { version_id: uuidv7(), case_id: caseId, title: 'Tampered', art: { ...art, label: 'Tension pneumothorax' } },
  ];
  const run = setup({ list_published_versions: async () => ({ ok: true, data: rows }) });
  const response = await handleFacilitatorApi(request(`/workspaces/${workspaceId}/versions`), run.dependencies);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.versions.map(row => row.art), [art, null, null]);
  assert.deepEqual(artPrivacyViolations(body.versions[0].art), []);
});

test('admin legacy publish refuses malformed or forged content without calling the publisher', async () => {
  const run = setup({ get_case_authoring_access: async () => ({ ok: true, data: [{ case_id: caseId, workspace_id: workspaceId, role: 'admin' }] }) });
  run.dependencies.env = { ADMIN_EMAILS: 'owner@example.invalid' };
  const response = await handleFacilitatorApi(request(`/cases/${caseId}/publish`, { method: 'POST',
    body: { expectedRevision: 'bad', assetIds: [uuidv7()], art: { html: '<script>' }, userId: uuidv7() } }), run.dependencies);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'review_required' });
  assert.deepEqual(run.calls.map(call => call.name), ['get_case_authoring_access']);
  assert.equal(run.calls.some(call => call.name === 'publish_draft_with_art'), false);
});

test('draft and publish deny a nonauthor before write RPC using a verified UUIDv4 Auth subject', async () => {
  const authSubject = '550e8400-e29b-41d4-a716-446655440000';
  const run = setup({ admin_account_active: async args => ({ok:true,data:Object.keys(args).length===1 && args.p_user_id===authSubject}), get_case_authoring_access: async () => ({ ok: true, data: [] }) });
  run.dependencies.verifyUser = async () => ({ userId: authSubject });
  const draft = await handleFacilitatorApi(request(`/cases/${caseId}/draft`, { method: 'PUT',
    body: { expectedRevision: 0, schemaVersion: 1, document: miniCase().doc } }), run.dependencies);
  const publish = await handleFacilitatorApi(request(`/cases/${caseId}/publish`, { method: 'POST',
    body: { expectedRevision: 1, assetIds: [], art } }), run.dependencies);
  assert.equal(draft.status, 403);
  assert.equal(publish.status, 403);
  assert.deepEqual(run.calls.map(call => call.name), ['get_case_authoring_access', 'get_case_authoring_access']);
  assert.deepEqual(run.calls.map(call => call.args.p_user_id), [authSubject, authSubject]);
});

test('author-access RPC 42501 remains 500 with a fixed safe alert before draft or publish writes', async () => {
  const run = setup({ get_case_authoring_access: async () => ({ ok: false, kind: 'forbidden', status: 500, code: '42501' }) });
  const draft = await handleFacilitatorApi(request(`/cases/${caseId}/draft`, { method: 'PUT',
    body: { expectedRevision: 0, schemaVersion: 1, document: miniCase().doc } }), run.dependencies);
  const publish = await handleFacilitatorApi(request(`/cases/${caseId}/publish`, { method: 'POST',
    body: { expectedRevision: 1, assetIds: [], art } }), run.dependencies);
  assert.equal(draft.status, 500);
  assert.equal(publish.status, 500);
  assert.deepEqual(await draft.json(), { error: 'internal_error' });
  assert.deepEqual(await publish.json(), { error: 'internal_error' });
  assert.deepEqual(run.calls.map(call => call.name), ['get_case_authoring_access', 'get_case_authoring_access']);
  assert.deepEqual(run.alerts, [
    { kind: 'rpc_forbidden', name: 'get_case_authoring_access' },
    { kind: 'rpc_forbidden', name: 'get_case_authoring_access' },
  ]);
});

const ADMIN_ENV = { ADMIN_EMAILS: 'owner@example.invalid' };
test('[PM-19] a signed-in non-admin cannot create a workspace: 403 before the body or any RPC', async () => {
  const run = setup();
  const refused = await handleFacilitatorApi(request('/workspaces', { method: 'POST',
    body: { slug: 'pilot-icu', name: 'Pilot ICU', admin: true, isAdmin: true, p_admin: true } }), run.dependencies);
  assert.equal(refused.status, 403);
  assert.deepEqual(run.calls, []);
});

test('JWT workspace bootstrap cleans names, uses verified subject, and returns only the new workspace id', async () => {
  const run = setup();
  run.dependencies.env = ADMIN_ENV;
  const created = await handleFacilitatorApi(request('/workspaces', { method: 'POST',
    body: { slug: 'pilot-icu', name: '  Pilot ICU  ', userId: uuidv7() } }), run.dependencies);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { workspaceId });
  assert.deepEqual(run.calls.map(call => call.name), ['get_me', 'ensure_profile', 'bootstrap_workspace']);
  assert.deepEqual(run.calls[1].args, { p_user_id: userId, p_display_name: 'Owner' });
  assert.deepEqual(run.calls[2].args, { p_user_id: userId, p_slug: 'pilot-icu', p_name: 'Pilot ICU', p_admin: true, p_admin_email: 'owner@example.invalid' });
});

test('workspace bootstrap rejects invalid human fields and an existing slug without granting membership', async () => {
  const invalid = setup();
  invalid.dependencies.env = ADMIN_ENV;
  for (const body of [{ slug: 'Pilot ICU', name: 'Pilot' }, { slug: 'pilot-icu', name: '\u0001' },
    { slug: 'pilot-icu', name: 'x'.repeat(121) }]) {
    const response = await handleFacilitatorApi(request('/workspaces', { method: 'POST', body }), invalid.dependencies);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(invalid.calls, []);
  const collision = setup({ bootstrap_workspace: async () => ({ ok: false, kind: 'unique', status: 409, code: '23505' }) });
  collision.dependencies.env = ADMIN_ENV;
  const response = await handleFacilitatorApi(request('/workspaces', { method: 'POST',
    body: { slug: 'pilot-icu', name: 'Another ICU' } }), collision.dependencies);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'conflict' });
  assert.deepEqual(collision.calls.map(call => call.name), ['get_me', 'ensure_profile', 'bootstrap_workspace']);
});

test('bootstrap keeps an existing display name and uses a clean bounded fallback for a new profile', async () => {
  const run = setup({ get_me: async () => ({ ok: true, data: [
    { user_id: userId, display_name: null, memberships: [], next_after: null, admin: true },
  ] }) });
  run.dependencies.env = ADMIN_ENV;
  const created = await handleFacilitatorApi(request('/workspaces', { method: 'POST',
    body: { slug: 'pilot-icu', name: 'Pilot ICU' } }), run.dependencies);
  assert.equal(created.status, 201);
  assert.deepEqual(run.calls[1], { name: 'ensure_profile', args: { p_user_id: userId, p_display_name: 'Facilitator' } });
});
