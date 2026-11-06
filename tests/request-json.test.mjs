import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, REQUEST_JSON_TIMEOUT_MS } from '../src/worker/request-json.mjs';
import { REQUEST_DEADLINE_MS } from '../src/worker/request-deadline.mjs';
const request = body => ({ headers: new Headers(), body });
const encode = value => new TextEncoder().encode(value);

test('request JSON reader preserves streamed JSON, byte caps and fixed malformed errors', async () => {
  // Inside the 8 s request deadline, so a stalled body is still a 408 (2026-10-17 reliability audit).
  assert.equal(REQUEST_JSON_TIMEOUT_MS, 7000);
  assert.ok(REQUEST_JSON_TIMEOUT_MS < REQUEST_DEADLINE_MS);
  const body = new ReadableStream({ start(c) { c.enqueue(encode('{"name":')); c.enqueue(encode('"é"}')); c.close(); } });
  assert.deepEqual(await readJson(request(body), 32), { body: { name: 'é' } });
  assert.deepEqual(await readJson({ headers: new Headers({ 'content-length': '33' }), body: null }, 32), { error: 'too_large' });
  assert.deepEqual(await readJson(request(null), 32), { error: 'not_json' });
  assert.deepEqual(await readJson(request(new ReadableStream({ start(c) { c.enqueue(encode('not JSON')); c.close(); } })), 32), { error: 'not_json' });
});

test('request JSON reader bounds stalled first read independently of abort/cancellation', { timeout: 1000 }, async () => {
  const started = performance.now(); let cancelled = 0;
  const body = { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancelled++; return new Promise(() => {}); } }) };
  assert.deepEqual(await readJson(request(body), 32, { timeoutMs: 20 }), { error: 'request_timeout' });
  assert.ok(performance.now() - started < 250); assert.equal(cancelled, 1);
});

test('request JSON reader whole deadline bounds a stall after an accepted chunk', { timeout: 1000 }, async () => {
  const started = performance.now();
  let reads = 0;
  const body = { getReader: () => ({ read: () => reads++ === 0 ? Promise.resolve({ done: false, value: encode('{') }) : new Promise(() => {}), cancel: () => new Promise(() => {}) }) };
  assert.deepEqual(await readJson(request(body), 32, { timeoutMs: 20 }), { error: 'request_timeout' });
  assert.ok(performance.now() - started < 250);
});

test('request JSON reader oversized UTF-8 body returns immediately despite held/rejected cancellation', { timeout: 1000 }, async () => {
  for (const cancel of [() => new Promise(() => {}), () => Promise.reject(Error('fixed fixture cleanup'))]) {
    const body = new ReadableStream({ start(c) { c.enqueue(encode('é'.repeat(17))); }, cancel });
    const started = performance.now();
    assert.deepEqual(await readJson(request(body), 32, { timeoutMs: 25 }), { error: 'too_large' });
    assert.ok(performance.now() - started < 250);
  }
});

test('request JSON reader does not consume a late chunk after its deadline', async () => {
  let release, accesses = 0, cancelled = 0, reads = 0;
  const held = new Promise(resolve => { release = resolve; });
  const body = { getReader: () => ({ read: () => reads++ === 0 ? held : Promise.resolve({ done: true }), cancel: () => { cancelled++; return Promise.resolve(); } }) };
  assert.deepEqual(await readJson(request(body), 32, { timeoutMs: 10 }), { error: 'request_timeout' });
  release({ done: false, get value() { accesses++; return encode('{}'); } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(accesses, 0); assert.equal(cancelled, 1);
});
