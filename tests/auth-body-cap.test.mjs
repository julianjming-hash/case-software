import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../src/client/auth.mjs';

const encoder = new TextEncoder();
const config = () => ({
  supabaseUrl: 'https://auth.example.invalid',
  publishableKey: `sb_publishable_${crypto.randomUUID()}`,
});
const store = () => {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: i => [...values.keys()][i],
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: k => values.delete(k),
  };
};

function auth(response) {
  return createAuth({
    origin: 'https://case.test',
    fetchImpl: async () => response,
    sessionStorage: store(),
    localStorage: store(),
    schedule: () => 0,
    clearSchedule: () => {},
  });
}

function streamed(chunks, { cancel = () => {} } = {}) {
  let reads = 0, cancels = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      const part = chunks[reads++];
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
    cancel() {
      cancels++;
      return cancel();
    },
  }, { highWaterMark: 0 }));
  return { response, reads: () => reads, cancels: () => cancels };
}

const bounded = async promise => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('auth_reader_did_not_return')), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test('Auth response byte cap stops a fast multi-chunk body before its unread tail', async () => {
  const run = streamed(['x'.repeat(20000), 'x'.repeat(20000), 'UNREAD_TAIL']);
  await assert.rejects(auth(run.response).publicConfig(), { message: 'auth_unavailable' });
  assert.equal(run.reads(), 2, 'oversize response consumed its unread tail');
});

test('Auth response limit counts UTF-8 bytes rather than JavaScript characters', async () => {
  const text = JSON.stringify({ ...config(), padding: 'é'.repeat(18000) });
  assert.ok(text.length < 32768);
  assert.ok(encoder.encode(text).byteLength > 32768);
  await assert.rejects(auth(new Response(text)).publicConfig(), { message: 'auth_unavailable' });
});

test('Auth oversize refusal contains a stalled stream cancellation without awaiting it', async () => {
  const run = streamed(['x'.repeat(32769)], { cancel: () => new Promise(() => {}) });
  await bounded(assert.rejects(auth(run.response).publicConfig(), { message: 'auth_unavailable' }));
  assert.equal(run.cancels(), 1, 'oversize body was not cancelled');
});

test('Auth whole-request deadline aborts and cancels an ignored-abort held body read', async () => {
  const original = setTimeout;
  let trigger, readReady, cancels = 0, signal;
  const ready = new Promise(resolve => { readReady = resolve; });
  const response = new Response(new ReadableStream({
    pull() {
      readReady();
      return new Promise(() => {});
    },
    cancel() {
      cancels++;
      return new Promise(() => {});
    },
  }, { highWaterMark: 0 }));
  globalThis.setTimeout = (callback, ms, ...args) => ms === 10000
    ? (trigger = callback, original(() => {}, 60000))
    : original(callback, ms, ...args);
  try {
    const client = createAuth({
      origin: 'https://case.test',
      fetchImpl: async (_url, init) => { signal = init.signal; return response; },
      sessionStorage: store(),
      localStorage: store(),
    });
    const pending = client.publicConfig();
    const refused = assert.rejects(pending, { message: 'auth_unavailable' });
    await ready;
    assert.equal(typeof trigger, 'function', 'original whole-request deadline was not armed');
    trigger();
    await bounded(refused);
    assert.equal(signal.aborted, true, 'deadline did not abort fetch');
    assert.equal(cancels, 1, 'deadline did not cancel the held body');
  } finally {
    globalThis.setTimeout = original;
  }
});
