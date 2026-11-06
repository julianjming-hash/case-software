// The 2026-10-17 15:01 deployment: signed-in requests sat unanswered until the client gave up at 10 s
// (`canceled`, ~0 ms CPU, nothing in Workers Logs). Each upstream await has its own deadline, but they compose
// serially past the client's. These run the real Worker in local workerd against a fake upstream whose delays
// the test controls; no Supabase project is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { REQUEST_DEADLINE_MS, requestDeadlineMs } from '../src/worker/request-deadline.mjs';
import { TIMINGS } from '../src/client/transport.mjs';
import { startFakeUpstreamWorker as start, fakeJwt, es256Signer, FAKE_ORIGIN as ORIGIN } from './helpers/fake-upstream-worker.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const userId = uuidv7();
const jwt = () => fakeJwt(userId);
const healthy = name => name === 'admin_account_active' ? Response.json(true)
  : name === 'get_me' ? Response.json([{ user_id: userId, display_name: 'F', memberships: [], next_after: null, admin: false }])
    : Response.json([]);
async function timed(url, init) {
  const started = Date.now();
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json(), ms: Date.now() - started };
}

test('the request deadline sits inside every client deadline that abandons a signed-in or room request', () => {
  // accountRequest (src/client/auth-ui.mjs) and one room transport attempt both stop at 10 s, body included.
  assert.equal(TIMINGS.REQUEST_TIMEOUT_MS, 10_000);
  assert.ok(REQUEST_DEADLINE_MS <= TIMINGS.REQUEST_TIMEOUT_MS - 2_000, 'two seconds stay for the response to travel');
  const at = (path, method = 'GET', env = {}) => requestDeadlineMs(new Request(`https://case.test${path}`, { method }), env);
  const room = `/api/v1/sessions/${uuidv7()}`;
  assert.equal(at('/api/v1/me'), REQUEST_DEADLINE_MS);
  assert.equal(at(`${room}/commands`, 'POST'), REQUEST_DEADLINE_MS);
  assert.equal(at(`${room}/updates`), null, 'long-poll waits by design');
  assert.equal(at(`${room}/ws`), null);
  assert.equal(at('/api/v1/check/poll'), null);
  assert.equal(at(`/api/v1/builder/workspaces/${uuidv7()}/media/display`, 'PUT'), null, 'image upload keeps its 20 s client deadline');
  assert.equal(at('/J/ABCD'), null);
  // A local override may only shorten it, and never applies to a deployed environment.
  assert.equal(at('/api/v1/me', 'GET', { CASE_REQUEST_DEADLINE_MS: '1500' }), 1500);
  assert.equal(at('/api/v1/me', 'GET', { CASE_REQUEST_DEADLINE_MS: '60000' }), REQUEST_DEADLINE_MS);
  assert.equal(at('/api/v1/me', 'GET', { CASE_ENV: 'production', CASE_REQUEST_DEADLINE_MS: '1500' }), REQUEST_DEADLINE_MS);
});

test('slow upstream calls that each beat their own deadline still answer before the request deadline, and say why', async () => {
  // Two RPCs of 1 s each: under the 5 s per-call deadline, over a 1.5 s request deadline.
  const worker = await start(async name => { await sleep(1_000); return healthy(name); }, { CASE_REQUEST_DEADLINE_MS: '1500' });
  try {
    const answer = await timed(`${worker.origin}/api/v1/me`, { headers: { authorization: `Bearer ${await jwt()}` } });
    assert.equal(answer.status, 503);
    assert.deepEqual(answer.body, { error: 'request_timeout' });
    assert.ok(answer.ms < 1_900, `answered in ${answer.ms} ms`);
    assert.deepEqual(await worker.logs(), [{ event: 'request_deadline', reason: 'rpc' }]);
  } finally { await worker.stop(); }
});

test('a stall before any RPC is reported as such, and exempt waits are untouched', async () => {
  const { jwk, sign } = await es256Signer();
  // JWKS answers in 2.5 s: inside its own 3 s deadline, outside a 1.5 s request deadline.
  const worker = await start(async name => { if (name === 'jwks.json') { await sleep(2_500); return Response.json({ keys: [jwk] }); } return healthy(name); },
    { CASE_REQUEST_DEADLINE_MS: '1500', SUPABASE_JWKS_URL: `${ORIGIN}/auth/v1/.well-known/jwks.json` });
  const token = await sign({ sub: userId, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  try {
    const answer = await timed(`${worker.origin}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(answer.status, 503);
    assert.ok(answer.ms < 1_900, `answered in ${answer.ms} ms`);
    const check = await timed(`${worker.origin}/api/v1/check/poll?wait=2`);
    assert.equal(check.status, 200);
    assert.ok(check.ms >= 2_000);
    assert.deepEqual(await worker.logs(), [{ event: 'request_deadline', reason: 'before_rpc' }]);
  } finally { await worker.stop(); }
});

test('RPC failures and slow RPCs reach Workers Logs, not only Analytics Engine', async () => {
  let mode = 'slow';
  const worker = await start(async name => {
    if (mode === 'slow') { await sleep(2_100); return healthy(name); }
    return new Response('{"message":"upstream"}', { status: 502 });
  });
  try {
    const slow = await timed(`${worker.origin}/api/v1/me`, { headers: { authorization: `Bearer ${await jwt()}` } });
    assert.equal(slow.status, 200, 'two 2.1 s calls fit inside the 8 s request deadline');
    mode = 'down';
    const down = await timed(`${worker.origin}/api/v1/me`, { headers: { authorization: `Bearer ${await jwt()}` } });
    assert.equal(down.status, 503);
    assert.deepEqual(await worker.logs(), [{ event: 'rpc_slow' }, { event: 'rpc_slow' }, { event: 'rpc_failure', reason: 'unavailable' }]);
  } finally { await worker.stop(); }
});
