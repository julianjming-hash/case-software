import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBuilderListApi } from '../src/worker/builder-list-api.mjs';

const WORKSPACE = '0199a000-0000-7000-8000-00000000c910';
const AUTHOR = '0199a000-0000-7000-8000-00000000c911';
const CASE_A = '0199a000-0000-7000-8000-00000000c912';
const CASE_B = '0199a000-0000-7000-8000-00000000c913';
const row = (case_id, revision, title = 'Saved case') => ({ case_id, title, revision, updated_at: '2026-10-09T12:00:00.000Z' });

function harness({ rows = [row(CASE_A, 3), row(CASE_B, 4)], membership = 'author', user = { userId: AUTHOR, email: 'author@example.org', sessionId: 'session' }, env = { ADMIN_EMAILS: '' }, listResult = null } = {}) {
  const calls = [];
  const rpc = { async call(name, args) {
    calls.push({ name, args });
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'get_me') return { ok: true, data: [{ user_id: user.userId, display_name: 'Test',
      memberships: membership ? [{ workspace_id: WORKSPACE, role: membership }] : [],
      admin: args.p_admin, next_after: null }] };
    if (name === 'builder_list_drafts'||name==='builder_list_draft_summaries') return listResult ?? { ok: true, data: rows };
    return { ok: true, data: [] };
  } };
  const request = (query = '') => new Request(`https://case.example/api/v1/builder/workspaces/${WORKSPACE}/drafts${query}`, { headers: { authorization: 'Bearer test' } });
  return { calls, rpc, env, verifyUser: async token => token === 'test' ? user : null, request };
}

async function call(h, req = h.request()) {
  const response = await handleBuilderListApi(req, { rpc: h.rpc, env: h.env, verifyUser: h.verifyUser });
  return { response, body: response ? await response.json() : null };
}

test('P-14 authorized list returns only bounded summary values with a next-page signal', async () => {
  const h = harness({ rows: [row(CASE_A, 3, '<text-only>'), row(CASE_B, 4)] });
  const { response, body } = await call(h, h.request('?limit=1&offset=8'));
  assert.equal(response.status, 200);
  assert.deepEqual(body, { workspaceId: WORKSPACE, drafts: [{ caseId: CASE_A, title: '<text-only>', revision: 3, updatedAt: '2026-10-09T12:00:00.000Z' }], limit: 1, offset: 8, hasMore: true, nextOffset: 9 });
  assert.deepEqual(h.calls.map(item => item.name), ['admin_account_active', 'get_me', 'builder_list_drafts']);
  assert.deepEqual(h.calls.at(-1).args, { p_workspace_id: WORKSPACE, p_limit: 1, p_offset: 8, p_user_id: AUTHOR, p_admin: false, p_admin_email: null });
  assert.doesNotMatch(JSON.stringify(body), /document|source|metadata/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('workspace authorization refuses facilitators and unknown memberships before the list RPC', async () => {
  for (const membership of ['facilitator', null]) {
    const h = harness({ membership });
    const { response } = await call(h);
    assert.equal(response.status, 403);
    assert.equal(h.calls.some(item => item.name === 'builder_list_drafts'), false);
  }
});

test('page parameters are unique, strict and bounded before authenticated database work', async () => {
  for (const query of ['?limit=51', '?limit=0', '?offset=10001', '?offset=-1', '?offset=x', '?limit=1&limit=2', '?cursor=x']) {
    const h = harness(); const { response } = await call(h, h.request(query));
    assert.equal(response.status, 400, query);
    assert.deepEqual(h.calls, [], query);
  }
  const h = harness(); const { response } = await call(h, new Request(`https://case.example/api/v1/builder/workspaces/${WORKSPACE}/drafts`, { method: 'POST' }));
  assert.equal(response.status, 405);
});

test('SQL failure or malformed summary fails closed; unexpected content columns are never returned', async () => {
  const failed = harness({ listResult: { ok: false, kind: 'unavailable', status: 503 } });
  assert.equal((await call(failed)).response.status, 503);
  const invalid = harness({ rows: [{ ...row(CASE_A, 3), revision: Number.MAX_SAFE_INTEGER + 1, document: { secret: 'sentinel' } }] });
  assert.equal((await call(invalid)).response.status, 503);
  const extra = harness({ rows: [{ ...row(CASE_A, 3), document: { secret: 'sentinel' }, source_text: 'hidden' }] });
  const { body } = await call(extra);
  assert.doesNotMatch(JSON.stringify(body), /secret|sentinel|source_text|document/);
});

test('verified admin flag is recomputed and sent to both workspace and SQL authorization', async () => {
  const adminId = '0199a000-0000-7000-8000-00000000c914';
  const h = harness({ user: { userId: adminId, email: 'admin@example.org', sessionId: 'session' }, env: { ADMIN_EMAILS: 'admin@example.org' } });
  const { response } = await call(h);
  assert.equal(response.status, 200);
  assert.equal(h.calls.find(item => item.name === 'get_me').args.p_admin, true);
  assert.equal(h.calls.find(item => item.name === 'builder_list_drafts').args.p_admin_email, 'admin@example.org');
});

test('v2 summary strips private columns and binds review/publication evidence without altering legacy rows',async()=>{
 const rich={...row(CASE_A,9),audience:'Registrars',duration_min:30,art_structure:{v:1,stops:2,decisions:[],secret:'PRIVATE'},publication_version:2,publication_at:'2026-11-01T00:00:00Z',publication_state:'changed',review_status:'pending',document:{secret:'NEVER'},authoring_metadata:{secret:'NEVER'}};
 const h=harness({rows:[rich]}),{response,body}=await call(h,h.request('?v=2'));
 assert.equal(response.status,200);assert.equal(body.summaryVersion,2);assert.equal(h.calls.at(-1).name,'builder_list_draft_summaries');assert.equal(body.drafts[0].publicationState,'changed');assert.deepEqual(body.drafts[0].artStructure,{v:1,stops:2,decisions:[]});assert.doesNotMatch(JSON.stringify(body),/PRIVATE|NEVER|secret|authoring_metadata|document/);
 for(const mutation of [{review_status:'ready'},{publication_version:null,publication_state:'unchanged'},{duration_min:999},{art_structure:{v:1,stops:2,decisions:[{stop:0,strands:[],resets:0,ends:0,secret:'x'}]}}])assert.equal((await call(harness({rows:[{...rich,...mutation}]}),h.request('?v=2'))).response.status,503);
});
test('v2 summary remains under the same authorisation and strict query bounds',async()=>{
 for(const membership of ['facilitator',null]){const h=harness({membership});assert.equal((await call(h,h.request('?v=2'))).response.status,403);assert.equal(h.calls.some(x=>x.name==='builder_list_draft_summaries'),false);}
 for(const query of ['?v=1','?v=2&v=2','?v=3']){const h=harness();assert.equal((await call(h,h.request(query))).response.status,400);assert.deepEqual(h.calls,[]);}
});
