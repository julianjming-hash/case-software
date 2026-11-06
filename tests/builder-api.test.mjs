import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleBuilderApi } from '../src/worker/builder-api.mjs';

const CASE = '0199a000-0000-7000-8000-00000000c421';
const ACTOR = '0199a000-0000-7000-8000-00000000c422';
const OP = '0199a000-0000-7000-8000-00000000c423';
const CHECKPOINT = '0199a000-0000-7000-8000-00000000c424';
const DOC = { schema_version: 2, title: 'Synthetic incomplete draft', surfaces: [] };
const META = { metadata_version: 1, sources: [], provenance: [] };

function harness({ replies = {}, user = { userId: ACTOR, email: 'author@example.org', sessionId: 'session' },
  role = 'author', env = { ADMIN_EMAILS: '' }, validators = true } = {}) {
  const calls = [];
  const rpc = { async call(name, args) {
    calls.push({ name, args });
    const answer = replies[name];
    return typeof answer === 'function' ? answer(args, calls) : answer ?? { ok: true, data: [] };
  } };
  const accessRow = { title: 'Synthetic incomplete draft', source_version_id: null, source_version_no: null, case_id: CASE, workspace_id: '0199a000-0000-7000-8000-00000000c425', role };
  const client = {
    async verifyUser() { return user; },
    parseJson(text, options) {
      try {
        if (text.includes('"document":') && text.includes('"\\u0064ocument":'))
          return { ok: false, error: { code: 'duplicate_key', at: '/document' } };
        const value = JSON.parse(text);
        if (new TextEncoder().encode(text).byteLength > options.maxBytes)
          return { ok: false, error: { code: 'too_large', at: '' } };
        return { ok: true, value };
      } catch { return { ok: false, error: { code: 'not_json', at: '' } }; }
    },
    validateDraft(document, metadata) {
      if (!validators) return { ok: false, errors: [{ code: 'unavailable', at: '' }] };
      return document?.schema_version in { 1: true, 2: true } && metadata?.metadata_version === 1
        ? { ok: true, errors: [] } : { ok: false, errors: [{ code: 'invalid', at: '' }] };
    },
    hashSources: async metadata => metadata?.sources?.every(source => source.sha256 === 'a'.repeat(64)) ?? false,
    responseHeaders: {},
  };
  replies.get_case_authoring_access ??= { ok: true, data: [accessRow] };
  replies.admin_account_active ??= { ok: true, data: true };
  return { calls, rpc, client, env };
}

function request(path, method = 'GET', value, raw = null) {
  return new Request(`https://case.example${path}`, {
    method, headers: { authorization: 'Bearer test', ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
    ...(method !== 'GET' ? { body: raw ?? JSON.stringify(value) } : {}),
  });
}
function builderRequest(path, method = 'GET', value, raw) {
  return request(`/api/v1/builder/cases/${CASE}${path}`, method, value, raw);
}
async function call(req, options = {}) {
  const h = harness(options);
  const response = await handleBuilderApi(req, {
    rpc: h.rpc, env: h.env, verifyUser: h.client.verifyUser,
    parseJson: h.client.parseJson, validateDraft: h.client.validateDraft,
    hashSources: options.hashSources === null ? undefined : options.hashSources ?? h.client.hashSources, nowMs: options.nowMs ?? (() => 1_800_000_000_000),
  });
  return { h, response, body: response ? await response.json() : null };
}

test('GET is entitled and read-only; it returns the paired digest without inventing legacy metadata', async () => {
  const { h, response, body } = await call(builderRequest('/draft'), {
    replies: { builder_get_draft: { ok: true, data: [{ revision: 7, schema_version: 2, document: DOC, authoring_metadata: null, updated_at: '2026-10-09T00:00:00Z', intent_digest: `\\x${'a'.repeat(64)}` }] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.case,{caseId:CASE,workspaceId:'0199a000-0000-7000-8000-00000000c425',role:'author',title:'Synthetic incomplete draft',capabilities:['slide_composition'],sourceVersion:null,publishes:false});
  assert.equal(body.draft.authoringMetadata, null);
  assert.equal(body.draft.intentDigest, `\\x${'a'.repeat(64)}`);
  assert.deepEqual(h.calls.map(x => x.name), ['admin_account_active', 'get_case_authoring_access', 'builder_get_draft', 'get_access']);
  assert.equal(h.calls.some(x => /window|save|checkpoint/i.test(x.name)), false);
});

test('[AS-149] GET returns a saved schema-3 slide draft and grants slide_composition (CASE-214)', async () => {
  const SLIDES = { ...DOC, schema_version: 3, blocks: [], compositions: [] };
  const { response, body } = await call(builderRequest('/draft'), {
    replies: { builder_get_draft: { ok: true, data: [{ revision: 4, schema_version: 3, document: SLIDES, authoring_metadata: null, updated_at: '2026-10-11T00:00:00Z', intent_digest: `\\x${'c'.repeat(64)}` }] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.case.capabilities, ['slide_composition']);
  assert.equal(body.draft.schemaVersion, 3);
  assert.deepEqual(body.draft.document, SLIDES);
});

test('GET represents a newly created case with no draft as revision zero', async () => {
  const { response, body } = await call(builderRequest('/draft'), {
    replies: { builder_get_draft: { ok: true, data: [{ revision: 0, schema_version: null, document: null, authoring_metadata: null, updated_at: null, intent_digest: null }] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { case:{caseId:CASE,workspaceId:'0199a000-0000-7000-8000-00000000c425',role:'author',title:'Synthetic incomplete draft',capabilities:['slide_composition'],sourceVersion:null,publishes:false}, draft: null, revision: 0 });
});

test('window issuance is explicit, base-revision-bound, and returns only the server-issued operation ID', async () => {
  const { h, response, body } = await call(builderRequest('/save-windows', 'POST', { baseRevision: 7 }), {
    replies: { builder_open_save_window: { ok: true, data: [{ operation_id: OP, base_revision: 7, expires_at: '2026-10-10T00:00:00Z' }] } },
    nowMs: () => 1_791_576_000_000,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(body, { operationId: OP, baseRevision: 7, expiresAt: '2026-10-10T00:00:00Z' });
  assert.equal(h.calls.at(-1).args.p_operation_id, undefined, 'client cannot choose the window UUID');
});

test('a save-window quota refusal is named save_quota (429); other refusals keep their mapping (CASE-240)', async () => {
  const quota = await call(builderRequest('/save-windows', 'POST', { baseRevision: 7 }), {
    replies: { builder_open_save_window: { ok: false, kind: 'bad_request', status: 400, code: '23514' } },
  });
  assert.equal(quota.response.status, 429);
  assert.deepEqual(quota.body, { error: 'save_quota' });
  const conflict = await call(builderRequest('/save-windows', 'POST', { baseRevision: 7 }), {
    replies: { builder_open_save_window: { ok: false, kind: 'conflict', status: 409, code: '40001' } },
  });
  assert.equal(conflict.response.status, 409);
  const invalid = await call(builderRequest('/save-windows', 'POST', { baseRevision: 7 }), {
    replies: { builder_open_save_window: { ok: false, kind: 'bad_request', status: 400, code: '22023' } },
  });
  assert.equal(invalid.response.status, 400);
});

test('PUT parses duplicate decoded keys before ordinary parsing and refuses without any write RPC', async () => {
  const raw = `{"operationId":"${OP}","document":{},"\\u0064ocument":{},"authoringMetadata":{}}`;
  const { h, response } = await call(builderRequest('/draft', 'PUT', null, raw));
  assert.equal(response.status, 400);
  assert.equal(h.calls.some(x => x.name === 'builder_save_draft'), false);
});

test('PUT checks schema and source digests, then sends the exact paired value to one CAS RPC', async () => {
  const source = { id: '0199a000-0000-7000-8000-00000000c426', title: 'Synthetic', text: 'No clinical content', sha256: 'a'.repeat(64), rights_status: 'unknown' };
  const metadata = { ...META, sources: [source] };
  const payload = { operationId: OP, document: DOC, authoringMetadata: metadata };
  const { h, response, body } = await call(builderRequest('/draft', 'PUT', payload), {
    replies: { builder_save_draft: { ok: true, data: [{ operation_id: OP, revision: 8, intent_digest: '\\x' + 'b'.repeat(64), status: 'saved' }] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { operationId: OP, revision: 8, intentDigest: '\\x' + 'b'.repeat(64), status: 'saved' });
  const save = h.calls.at(-1);
  assert.equal(save.name, 'builder_save_draft');
  assert.deepEqual(save.args.p_document, DOC);
  assert.deepEqual(save.args.p_authoring_metadata, metadata);
  assert.equal(save.args.p_user_id, ACTOR);
});

test('Worker recomputes source digests with Web Crypto when no helper adapter is supplied', async () => {
  const text = 'Synthetic source text';
  const source = { id: '0199a000-0000-7000-8000-00000000c426', title: 'Synthetic', text,
    sha256: createHash('sha256').update(text).digest('hex'), rights_status: 'unknown' };
  const payload = { operationId: OP, document: DOC, authoringMetadata: { ...META, sources: [source] } };
  const { response } = await call(builderRequest('/draft', 'PUT', payload), { hashSources: null,
    replies: { builder_save_draft: { ok: true, data: [{ operation_id: OP, revision: 8, intent_digest: '\\x' + 'b'.repeat(64), status: 'saved' }] } },
  });
  assert.equal(response.status, 200);
});

test('bad source digest and unknown/unavailable validator refuse before save', async () => {
  const badMetadata = { ...META, sources: [{ id: '0199a000-0000-7000-8000-00000000c426', title: 'Synthetic', text: 'x', sha256: '0'.repeat(64), rights_status: 'unknown' }] };
  for (const options of [
    { replies: {}, client: { hashSources: async () => false } },
    { validators: false },
  ]) {
    const payload = { operationId: OP, document: DOC, authoringMetadata: badMetadata };
    const { h, response } = await call(builderRequest('/draft', 'PUT', payload), options);
    assert.ok(response.status === 400 || response.status === 422);
    assert.equal(h.calls.some(x => x.name === 'builder_save_draft'), false);
  }
});

test('receipt lookup is scoped to current entitlement and never returns document content', async () => {
  const { h, response, body } = await call(builderRequest(`/save-windows/${OP}`), {
    replies: { builder_get_save_receipt: { ok: true, data: [{ operation_id: OP, base_revision: 7, revision: 8, intent_digest: '\\x' + 'c'.repeat(64), status: 'saved', committed_at: '2026-10-09T00:00:00Z' }] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { operationId: OP, baseRevision: 7, revision: 8, intentDigest: '\\x' + 'c'.repeat(64), status: 'saved', committedAt: '2026-10-09T00:00:00Z' });
  assert.equal(JSON.stringify(body).includes('document'), false);
  assert.equal(h.calls[0].name, 'admin_account_active');
});

test('receipt lookup reports a still-open server-issued window without inventing a save result', async () => {
  const { response, body } = await call(builderRequest(`/save-windows/${OP}`), {
    replies: { builder_get_save_receipt: { ok: true, data: [{ operation_id: OP, base_revision: 7, revision: null, intent_digest: null,
      status: 'issued', committed_at: null, expires_at: '2026-10-10T00:00:00Z' }] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { operationId: OP, baseRevision: 7, status: 'issued', expiresAt: '2026-10-10T00:00:00Z' });
});

test('D12: a fourth checkpoint is named checkpoint_limit (409); a bad name keeps its 400', async () => {
  const full = await call(builderRequest('/checkpoints', 'POST', { name: 'Fourth', expectedRevision: 3 }), {
    replies: { builder_create_checkpoint: { ok: false, kind: 'bad_request', status: 400, code: '23514' } },
  });
  assert.equal(full.response.status, 409);
  assert.deepEqual(full.body, { error: 'checkpoint_limit' });
  const named = await call(builderRequest('/checkpoints', 'POST', { name: 'Fourth', expectedRevision: 3 }), {
    replies: { builder_create_checkpoint: { ok: false, kind: 'bad_request', status: 400, code: '22023' } },
  });
  assert.equal(named.response.status, 400);
});

test('checkpoint restore uses an operation window and SQL result must advance revision even for an identical snapshot', async () => {
  const { h, response, body } = await call(builderRequest(`/checkpoints/${CHECKPOINT}/restore`, 'POST', { operationId: OP }), {
    replies: { builder_restore_checkpoint: { ok: true, data: [{ operation_id: OP, revision: 9, intent_digest: '\\x' + 'd'.repeat(64), status: 'restored' }] } },
  });
  assert.equal(response.status, 200);
  assert.equal(body.revision, 9);
  const restore = h.calls.at(-1);
  assert.equal(restore.name, 'builder_restore_checkpoint');
  assert.equal(restore.args.p_operation_id, OP);
  assert.equal(restore.args.p_checkpoint_id, CHECKPOINT);
});

test('revoked workspace membership is refused before any Builder data call', async () => {
  const { h, response } = await call(builderRequest('/draft'), {
    replies: { get_case_authoring_access: { ok: true, data: [] } },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(h.calls.map(x => x.name), ['admin_account_active', 'get_case_authoring_access']);
});

test('admin access is accepted without workspace membership when the verified identity is an admin', async () => {
  const admin = { userId: ACTOR, email: 'admin@example.org', sessionId: 'session' };
  const { h, response } = await call(builderRequest('/draft'), {
    user: admin, env: { ADMIN_EMAILS: 'admin@example.org' },
    replies: {
      get_case_authoring_access: { ok: true, data: [{ title: 'Synthetic incomplete draft', source_version_id: null, source_version_no: null, case_id: CASE, workspace_id: '0199a000-0000-7000-8000-00000000c425', role: 'admin' }] },
      builder_get_draft: { ok: true, data: [{ revision: 1, schema_version: 2, document: DOC, authoring_metadata: null, updated_at: '2026-10-09T00:00:00Z', intent_digest: `\\x${'b'.repeat(64)}` }] },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(h.calls.find(x => x.name === 'get_case_authoring_access').args.p_admin, true);
});

test('checkpoint creation forwards only an explicit acknowledged revision and refuses the unbound legacy body', async () => {
  const invalid = await call(builderRequest('/checkpoints', 'POST', { name: 'Visible revision' }));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.h.calls.some(x => x.name === 'builder_create_checkpoint'), false);
  const valid = await call(builderRequest('/checkpoints', 'POST', { name: 'Visible revision', expectedRevision: 7 }), {
    replies: { builder_create_checkpoint: { ok: true, data: [{ id: CHECKPOINT, name: 'Visible revision', revision: 7, created_at: '2026-10-09T00:00:00Z' }] } },
  });
  assert.equal(valid.response.status, 201);
  assert.equal(valid.h.calls.at(-1).args.p_expected_revision, 7);
});

test('direct edit source context is server-bound and incomplete migration responses fail closed', async () => {
  const access = { case_id:CASE,workspace_id:'0199a000-0000-7000-8000-00000000c425',role:'author',title:'Original title',source_version_id:CHECKPOINT,source_version_no:3 };
  const empty = { revision:0,schema_version:null,document:null,authoring_metadata:null,updated_at:null,intent_digest:null };
  const replies = { get_case_authoring_access:{ok:true,data:[access]},builder_get_draft:{ok:true,data:[empty]} };
  const valid = await call(builderRequest('/draft'), {replies});
  assert.equal(valid.response.status,200);
  assert.deepEqual(valid.body.case.sourceVersion,{versionId:CHECKPOINT,versionNo:3});
  delete access.source_version_no;
  const missing = await call(builderRequest('/draft'), {replies});
  assert.equal(missing.response.status,503);
  assert.equal(missing.h.calls.some(x=>x.name==='builder_get_draft'),false);
});

test('[AS-185] an owner archives a never-published draft with its exact title; the Worker sends one RPC and names refusals (CASE-316)', async () => {
  const archived = { ok: true, data: [{ case_id: CASE, outcome: 'archived' }] };
  const { h, response, body } = await call(builderRequest('/archive', 'POST', { confirmTitle: 'Synthetic incomplete draft' }), { role: 'owner', replies: { builder_archive_case: archived } });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { caseId: CASE, archived: true });
  const sent = h.calls.find(x => x.name === 'builder_archive_case');
  assert.deepEqual(sent.args, { p_case_id: CASE, p_user_id: ACTOR, p_admin: false, p_admin_email: null, p_confirm_title: 'Synthetic incomplete draft' });
  for (const [outcome, error] of [['published', 'case_published'], ['in_review', 'review_open'], ['title_mismatch', 'title_mismatch']]) {
    const refused = await call(builderRequest('/archive', 'POST', { confirmTitle: 'x' }), { role: 'owner', replies: { builder_archive_case: { ok: true, data: [{ case_id: CASE, outcome }] } } });
    assert.equal(refused.response.status, 409, outcome);
    assert.equal(refused.body.error, error);
  }
  // A row for another case, or an outcome the Worker does not know, is never reported as archived.
  for (const row of [{ case_id: OP, outcome: 'archived' }, { case_id: CASE, outcome: 'gone' }]) {
    const odd = await call(builderRequest('/archive', 'POST', { confirmTitle: 'x' }), { role: 'owner', replies: { builder_archive_case: { ok: true, data: [row] } } });
    assert.equal(odd.response.status, 503);
  }
});

test('[AS-185] an author is refused before any archive RPC; an admin archives without step-up; malformed bodies are refused (CASE-316)', async () => {
  const author = await call(builderRequest('/archive', 'POST', { confirmTitle: 'Synthetic incomplete draft' }), { role: 'author' });
  assert.equal(author.response.status, 403);
  assert.equal(author.h.calls.some(x => x.name === 'builder_archive_case'), false);
  const admin = { userId: ACTOR, email: 'admin@example.org', sessionId: 'session' };
  const byAdmin = await call(builderRequest('/archive', 'POST', { confirmTitle: 'Synthetic incomplete draft' }), {
    user: admin, env: { ADMIN_EMAILS: 'admin@example.org' }, role: 'admin',
    replies: { builder_archive_case: { ok: true, data: [{ case_id: CASE, outcome: 'archived' }] } } });
  assert.equal(byAdmin.response.status, 200);
  assert.equal(byAdmin.h.calls.find(x => x.name === 'builder_archive_case').args.p_admin, true);
  for (const value of [{}, { confirmTitle: 1 }, { confirmTitle: 'x', extra: true }, { confirmTitle: 'x'.repeat(201) }]) {
    const bad = await call(builderRequest('/archive', 'POST', value), { role: 'owner' });
    assert.equal(bad.response.status, 400, JSON.stringify(value).slice(0, 40));
    assert.equal(bad.h.calls.some(x => x.name === 'builder_archive_case'), false);
  }
  const get = await call(builderRequest('/archive'), { role: 'owner' });
  assert.equal(get.response.status, 405);
});

test('[AS-211] GET says whether this person publishes: an owner always, an editor only while editors_publish is on', async () => {
  const WS = '0199a000-0000-7000-8000-00000000c425';
  const draft = { ok: true, data: [{ revision: 0, schema_version: null, document: null, authoring_metadata: null, updated_at: null, intent_digest: null }] };
  const access = (role, member, policies) => ({ ok: true, data: [{ case_id: CASE, workspace_id: WS, member_role: member, grant_level: null, role, scope: 'workspace', policies }] });
  const off = { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true }, on = { ...off, editors_publish: true };
  for (const [role, policies, expected] of [['owner', off, true], ['author', off, false], ['author', on, true]]) {
    const { response, body } = await call(builderRequest('/draft'), { role, replies: { builder_get_draft: draft, get_access: access(role, role, policies) } });
    assert.equal(response.status, 200); assert.equal(body.case.publishes, expected, `${role} with editors_publish ${policies.editors_publish}`);
  }
});
