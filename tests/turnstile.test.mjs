import test from 'node:test';
import assert from 'node:assert/strict';
import { newCapabilityToken } from '../src/shared/ids.mjs';
import { verifyTurnstile } from '../src/worker/turnstile.mjs';

const setup = () => ({ token: newCapabilityToken(), env: { CASE_ENV: 'staging', TURNSTILE_SECRET_KEY: newCapabilityToken() } });
const valid = () => Response.json({ success: true, hostname: 'case-staging.iatrogenic.app', action: 'join' });

test('Turnstile verifier sends credentials only in fixed POST body and validates exact hostname/action', async () => {
  const { token, env } = setup(); let calls = 0;
  const result = await verifyTurnstile(token, '192.0.2.1', env, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: '192.0.2.1' });
    assert.ok(options.signal instanceof AbortSignal); return valid();
  } });
  assert.deepEqual(result, { ok: true, reason: 'verified' }); assert.equal(calls, 1);
});

test('Turnstile verifier refuses malformed tokens before any provider call', async () => {
  const { env } = setup(); let calls = 0;
  for (const token of ['', null, 12, 'x'.repeat(2049), 'a\nb']) {
    assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl: async () => { calls++; return valid(); } }), { ok: false, reason: 'invalid' });
  }
  assert.equal(calls, 0);
});

test('Turnstile verifier rejects duplicate/invalid provider verdict without raw error reflection', async () => {
  const { token, env } = setup(); const privateMarker = newCapabilityToken();
  const fetchImpl = async () => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'], detail: privateMarker });
  assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl }), { ok: false, reason: 'invalid' });
});

test('Turnstile verifier refuses success from another hostname or action', async () => {
  const { token, env } = setup();
  for (const body of [{ success: true, hostname: 'foreign.test', action: 'join' }, { success: true, hostname: 'case-staging.iatrogenic.app', action: 'other' }]) {
    assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl: async () => Response.json(body) }), { ok: false, reason: 'invalid' });
  }
});

test('Turnstile verifier fails open on unavailable provider with one fixed metric and no reflected data', async () => {
  const { token, env } = setup(); const metrics = []; const marker = newCapabilityToken();
  for (const fetchImpl of [async () => { throw Error(marker); }, async () => new Response(marker, { status: 503 }), async () => new Response(null, { status: 302, headers: { location: 'https://foreign.test/' } }), async () => Response.json({ success: false, 'error-codes': ['internal-error'] }), async () => Response.json({ success: 'yes' })]) {
    const before = metrics.length;
    assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl, onMetric: x => metrics.push(x) }), { ok: true, reason: 'unavailable' });
    assert.equal(metrics.length, before + 1); assert.deepEqual(metrics.at(-1), { event: 'turnstile_failopen' });
  }
});

test('Turnstile verifier whole deadline bounds held headers and held response body despite ignored abort/cancel', { timeout: 1000 }, async () => {
  const { token, env } = setup();
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }))]) {
    const metrics = []; const started = performance.now();
    assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl, timeoutMs: 25, onMetric: x => metrics.push(x) }), { ok: true, reason: 'unavailable' });
    assert.ok(performance.now() - started < 250); assert.deepEqual(metrics, [{ event: 'turnstile_failopen' }]);
  }
});

test('Turnstile verifier caps streamed UTF-8 bytes and contains cancellation and metric failures', async () => {
  const { token, env } = setup(); let cancelled = false;
  const started = performance.now();
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('é'.repeat(32769))); }, cancel() { cancelled = true; return Promise.reject(Error('fixed fixture cancellation')); } });
  assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl: async () => new Response(stream), onMetric: () => Promise.reject(Error('fixed fixture metrics')) }), { ok: true, reason: 'unavailable' });
  assert.equal(cancelled, true); assert.ok(performance.now() - started < 250);
});

test('Turnstile verifier missing environment configuration fails open without sending credentials', async () => {
  const { token, env } = setup(); let calls = 0; const metrics = [];
  for (const config of [{}, { ...env, TURNSTILE_SECRET_KEY: '' }, { ...env, CASE_ENV: 'other' }]) {
    assert.deepEqual(await verifyTurnstile(token, '', config, { fetchImpl: async () => { calls++; return valid(); }, onMetric: x => metrics.push(x) }), { ok: true, reason: 'unavailable' });
  }
  assert.equal(calls, 0); assert.equal(metrics.length, 3);
});

test('Turnstile verifier ignores late provider completion after fail-open and emits exactly one metric', async () => {
  const { token, env } = setup(); const metrics = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  assert.deepEqual(await verifyTurnstile(token, '', env, { fetchImpl: () => held, timeoutMs: 10, onMetric: x => metrics.push(x) }), { ok: true, reason: 'unavailable' });
  release(new Response(null, { status: 503 })); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(metrics, [{ event: 'turnstile_failopen' }]);
});
