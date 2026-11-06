import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { handleOwnedRooms } from '../src/worker/owned-rooms.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000'; // valid Supabase Auth UUIDv4 subject
function harness({ jwt = true, rows = [], result = null } = {}) {
  const calls = [], alerts = [], authorityCalls = [];
  const dependencies = { env: {}, onAlert: event => alerts.push(event),
    verifyUser: async token => jwt && token === 'test-jwt' ? { userId: USER } : null,
    rpc: { async call(name, args) { if(name==='admin_account_active'){authorityCalls.push({name,args});return {ok:true,data:Object.keys(args).length===1 && args.p_user_id===USER};} calls.push({ name, args }); return result ?? { ok: true, data: rows }; } } };
  const request = (query = '', token = 'test-jwt') => new Request(`https://case.test/api/v1/me/rooms${query}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { dependencies, request, calls, alerts, authorityCalls };
}

test('[AS-080] owned-room endpoint pages verified caller sessions and strips every extra database field', async () => {
  const id = uuidv7(), run = harness({ rows: [{ session_id: id, join_code: 'K90001',
    expires_at: '2026-10-03T00:00:00Z', case_id: uuidv7(), display_name: 'Private name' }] });
  const response = await handleOwnedRooms(run.request('?limit=1'), run.dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(run.authorityCalls,[{name:'admin_account_active',args:{p_user_id:USER}}]);
  assert.deepEqual(await response.json(), { rooms: [{ sessionId: id, joinCode: 'K90001',
    expiresAt: '2026-10-03T00:00:00Z' }], nextAfter: id });
  assert.deepEqual(run.calls, [{ name: 'list_owned_active_sessions',
    args: { p_user_id: USER, p_limit: 1, p_after: null, p_admin: false, p_admin_email: null } }]);
});

test('[AS-080] owned-room endpoint rejects missing JWT and malformed pagination before any RPC', async () => {
  const run = harness();
  assert.equal((await handleOwnedRooms(run.request('', null), run.dependencies)).status, 401);
  for (const query of ['?limit=0', '?limit=101', '?limit=not-a-number', '?after=not-a-uuid']) {
    assert.equal((await handleOwnedRooms(run.request(query), run.dependencies)).status, 400);
  }
  assert.deepEqual(run.calls, []);
});

test('[AS-080] owned-room endpoint treats privilege drift as a safe 500 alert and malformed rows as unavailable', async () => {
  const denied = harness({ result: { ok: false, kind: 'forbidden', status: 500, code: '42501' } });
  const failure = await handleOwnedRooms(denied.request(), denied.dependencies);
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: 'internal_error' });
  assert.deepEqual(denied.alerts, [{ kind: 'rpc_forbidden', name: 'list_owned_active_sessions' }]);
  const malformed = harness({ rows: [{ session_id: uuidv7(), join_code: 'K90001', expires_at: 'bad-time' }] });
  assert.equal((await handleOwnedRooms(malformed.request(), malformed.dependencies)).status, 503);
});
