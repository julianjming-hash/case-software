import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchResult } from '../src/client/net.mjs';
test('offline is only a fetch TypeError or the marked service-worker 503, never a real server error', async () => {
  assert.equal((await fetchResult('/api', {}, async () => { throw new TypeError('network'); })).offline, true);
  assert.equal((await fetchResult('/api', {}, async () => new Response('', { status: 503, headers: { 'x-case-offline': '1' } }))).offline, true);
  assert.equal((await fetchResult('/api', {}, async () => new Response('', { status: 503 }))).offline, false);
  await assert.rejects(fetchResult('/api', {}, async () => { throw new Error('bug'); }), /bug/);
  await assert.rejects(fetchResult('/api', {}, async () => { throw new DOMException('aborted', 'AbortError'); }), /aborted/);
});
