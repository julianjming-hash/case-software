import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { handleRoomHistory } from '../src/worker/room-history.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000', OTHER = '550e8400-e29b-41d4-a716-446655440001';
const W = uuidv7();
const row = (at = '2026-10-08T01:00:00.123456+00:00') => ({ session_id: uuidv7(), case_version_id: uuidv7(),
  title: 'Pinned case', version_no: 1, status: 'ended', created_at: at, started_at: null,
  ended_at: '2026-10-08T02:00:00Z', expires_at: '2026-10-09T01:00:00Z', archive_state: 'pending', own: true });
function setup({ rows = [], active = true, member = true, userId = USER, admin = false, result = null } = {}) {
  const calls = [], env = admin ? { ADMIN_EMAILS: 'admin@example.org' } : {};
  const deps = { env, verifyUser: async token => token === 'jwt' ? { userId, email: 'admin@example.org' } : null,
    rpc: { async call(name, args) { calls.push({ name, args });
      if (name === 'admin_account_active') return { ok: true, data: active };
      if (name === 'get_me') return { ok: true, data: [{ user_id: userId, display_name: null, admin,
        next_after: null, memberships: member ? [{ workspace_id: W, role: admin ? 'admin' : 'author' }] : [] }] };
      return result ?? { ok: true, data: rows };
    } } };
  const request = (query = '', workspace = W, token = 'jwt', method = 'GET') => new Request(
    `https://case.test/api/v1/workspaces/${workspace}/history${query}`, {
      method, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return { deps, calls, request };
}

test('[AS-118] history returns bounded summary fields, removes private upstream data and never mints a console', async () => {
  const record = { ...row(), display_name: 'PRIVATE NAME', join_code: 'ABC123', response: 'PRIVATE ANSWER', document: 'PRIVATE PACK' };
  const h = setup({ rows: [record] });
  const response = await handleRoomHistory(h.request(), h.deps), body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body.rooms[0]).sort(), ['sessionId','caseVersionId','title','versionNo','status','createdAt','startedAt','endedAt','expiresAt','archiveState','own'].sort());
  assert.equal(body.nextAfter, null);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|ABC123/);
  assert.deepEqual(h.calls.map(c => c.name), ['admin_account_active','get_me','list_room_history']);
  assert.deepEqual(h.calls.at(-1).args, { p_user_id: USER, p_workspace_id: W, p_filter: 'all', p_limit: 20,
    p_after_at: null, p_after_id: null, p_admin: false, p_admin_email: null });
});

test('history cursor binds actor/workspace/filter, contains no raw actor and preserves SQL microseconds', async () => {
  const first = row(), h = setup({ rows: [first] });
  const body = await (await handleRoomHistory(h.request('?limit=1'), h.deps)).json();
  assert.ok(body.nextAfter.length < 512);
  const claim = JSON.parse(Buffer.from(body.nextAfter, 'base64url').toString());
  assert.doesNotMatch(JSON.stringify(claim), new RegExp(USER));
  assert.equal(claim.t, first.created_at);
  const second = { ...row('2026-10-08T01:00:00.123455+00:00'), session_id: 'ffffffff-ffff-7fff-bfff-ffffffffffff' };
  h.deps.rpc.call = async (name, args) => {
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'get_me') return { ok: true, data: [{ user_id: USER, admin: false, display_name: null, next_after: null, memberships: [{ workspace_id: W, role: 'author' }] }] };
    assert.equal(args.p_after_at, first.created_at); assert.equal(args.p_after_id, first.session_id);
    return { ok: true, data: [second] };
  };
  assert.equal((await handleRoomHistory(h.request(`?after=${body.nextAfter}`), h.deps)).status, 200);
  for (const [run, suffix] of [[setup({ userId: OTHER }), ''], [setup(), '&filter=running']]) {
    const req = run.request(`?after=${body.nextAfter}${suffix}`);
    assert.equal((await handleRoomHistory(req, run.deps)).status, 400);
    assert.equal(run.calls.length, 0);
  }
  assert.equal((await handleRoomHistory(h.request(`?after=${body.nextAfter}`, uuidv7()), h.deps)).status, 400);
});

test('history refuses malformed/repeated/oversized queries before RPC and wrong methods', async () => {
  const h = setup();
  for (const q of ['?limit=0','?limit=101','?limit=1&limit=2','?filter=bad','?admin=true','?after=','?after='+ 'A'.repeat(513)])
    assert.equal((await handleRoomHistory(h.request(q), h.deps)).status, 400);
  assert.equal((await handleRoomHistory(h.request('', W, 'jwt', 'POST'), h.deps)).status, 405);
  assert.equal(h.calls.length, 0);
});

test('history rechecks account and current membership on every page and rejects capability-only callers', async () => {
  const disabled = setup({ active: false });
  assert.equal((await handleRoomHistory(disabled.request(), disabled.deps)).status, 403);
  assert.deepEqual(disabled.calls.map(c => c.name), ['admin_account_active']);
  const removed = setup({ member: false });
  assert.equal((await handleRoomHistory(removed.request(), removed.deps)).status, 403);
  assert.ok(!removed.calls.some(c => c.name === 'list_room_history'));
  const cap = setup(); assert.equal((await handleRoomHistory(cap.request('', W, 'room-capability'), cap.deps)).status, 401);
});

test('history administrative reach comes only from verified email, other authors never receive foreign own=false summaries', async () => {
  const a = setup({ admin: true, rows: [{ ...row(), own: false }] });
  assert.equal((await handleRoomHistory(a.request(), a.deps)).status, 200);
  assert.equal(a.calls.at(-1).args.p_admin, true);
  const member = setup({ rows: [{ ...row(), own: false }] });
  assert.equal((await handleRoomHistory(member.request(), member.deps)).status, 503);
});

test('history rejects fabricated completion, duplicate or unordered rows and safely returns RPC faults', async () => {
  const r = row();
  for (const rows of [[{ ...r, archive_state: 'complete' }], [r, r], [row('2026-10-08T02:00:00Z'),row('2026-10-08T03:00:00Z')], [{ ...r, created_at: 'infinity' }]]) {
    const h = setup({ rows }); assert.equal((await handleRoomHistory(h.request(), h.deps)).status, 503);
  }
  const fault = setup({ result: { ok: false, kind: 'unavailable' } });
  assert.equal((await handleRoomHistory(fault.request(), fault.deps)).status, 503);
});
