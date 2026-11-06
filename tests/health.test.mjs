// GET /api/v1/health (2026-10-17 reliability audit): a public probe for an external uptime monitor. One bounded
// database read and the sign-in keys, fixed answers only, never a hang. Real Worker in local workerd, fake upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeUpstreamWorker as start, es256Signer, FAKE_ORIGIN } from './helpers/fake-upstream-worker.mjs';
import { handleHealth } from '../src/worker/health.mjs';

const JWKS = { SUPABASE_JWKS_URL: `${FAKE_ORIGIN}/auth/v1/.well-known/jwks.json` };
async function probe(origin) {
  const started = Date.now();
  const response = await fetch(`${origin}/api/v1/health`);
  return { status: response.status, body: await response.json(), ms: Date.now() - started,
    cache: response.headers.get('cache-control'), retryAfter: response.headers.get('retry-after') };
}

test('health answers ok from one read of the database and the sign-in keys, and says nothing else', async () => {
  const { jwk } = await es256Signer();
  const calls = [];
  const worker = await start(async name => { calls.push(name); return name === 'jwks.json' ? Response.json({ keys: [jwk] }) : Response.json([]); }, JWKS);
  try {
    const first = await probe(worker.origin);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.equal(first.cache, 'no-store');
    // `heartbeats` only reads; `ping` would write the keepalive and hide a dead weekly cron.
    assert.deepEqual(calls.sort(), ['heartbeats', 'jwks.json']);
    calls.length = 0;
    assert.equal((await probe(worker.origin)).status, 200);
    assert.deepEqual(calls, ['heartbeats'], 'the sign-in keys come from the shared cache');
  } finally { await worker.stop(); }
});

test('a hanging database or missing sign-in keys answer a fixed 503 within the probe budget', async () => {
  const { jwk } = await es256Signer();
  const worker = await start(async name => {
    if (name === 'jwks.json') return Response.json({ keys: [jwk] });
    return new Promise(() => {}); // the database never answers
  }, JWKS);
  try {
    const hung = await probe(worker.origin);
    assert.equal(hung.status, 503);
    assert.deepEqual(hung.body, { ok: false, reason: 'database' });
    assert.ok(hung.ms < 3_500, `answered in ${hung.ms} ms`);
    const other = await start(async name => name === 'jwks.json' ? new Response('down', { status: 503 }) : Response.json([]), JWKS);
    try {
      const keyless = await probe(other.origin);
      assert.equal(keyless.status, 503);
      assert.deepEqual(keyless.body, { ok: false, reason: 'auth_keys' });
    } finally { await other.stop(); }
  } finally { await worker.stop(); }
});

test('health is rate-limited before any backend call', async () => {
  // The Worker passes the same CHECK_ATTEMPTS limiter and address prefix as /api/v1/check/*.
  let calls = 0;
  const refused = await handleHealth({ limited: async () => true, rpc: () => { calls++; return { call: async () => ({ ok: true, data: [] }) }; },
    keysReady: async () => { calls++; return true; } });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { ok: false, reason: 'rate_limited' });
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal(calls, 0);
});
