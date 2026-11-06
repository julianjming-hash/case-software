import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestConsolePair } from '../src/client/console-pair-request.mjs';

test('[AS-080] PC pair request deadline covers stalled headers and a body that ignores abort', async () => {
  for (const stage of ['headers', 'body']) {
    let signal;
    const fetchImpl = async (_url, init) => {
      signal = init.signal;
      return stage === 'headers' ? new Promise(() => {}) : {
        ok: true, status: 200, text: () => new Promise(() => {}),
      };
    };
    const request = requestConsolePair({ origin: 'https://case.test', parts: ['console-pairs'],
      fetchImpl, timeoutMs: 15 });
    await assert.rejects(Promise.race([request, new Promise((_, reject) => setTimeout(() =>
      reject(new Error('unbounded_pair_request')), 100))]), /pair_unavailable/);
    assert.equal(signal.aborted, true, stage);
  }
});

test('[AS-080] PC pair request refuses redirects and returns only bounded JSON', async () => {
  const request = options => requestConsolePair({ origin: 'https://case.test', parts: ['console-pairs'],
    fetchImpl: async (_url, init) => { assert.equal(init.redirect, 'manual'); return options; } });
  await assert.rejects(request({ ok: false, status: 302, text: async () => '{}' }), /pair_unavailable/);
  await assert.rejects(request({ ok: true, status: 200, text: async () => 'x'.repeat(1025) }), /pair_unavailable/);
  assert.deepEqual(await request({ ok: true, status: 200, text: async () => '{"pending":true}' }), { pending: true });
});
