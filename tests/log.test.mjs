import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/worker/log.mjs';

test('log emits fixed structured event and reason without arbitrary fields', () => {
  const writes = [], sink = record => writes.push(record);
  assert.equal(log('worker_error', { reason:'internal' }, sink), true);
  assert.equal(log('room_expiry_end_failed', {}, sink), true);
  assert.deepEqual(writes, ['{"event":"worker_error","reason":"internal"}', '{"event":"room_expiry_end_failed"}']);
  for (const fields of [{ token:'private' }, { name:'private' }, { answer:'private' },
    { error:new Error('private') }, { reason:'private' }, { reason:'internal', url:'private' }])
    assert.equal(log('worker_error', fields, sink), false);
  assert.equal(writes.length, 2);
});
test('log rejects unknown events and contains failing output sinks', () => {
  let calls = 0;
  assert.equal(log('private', {}, () => calls++), false);
  assert.equal(calls, 0);
  assert.equal(log('worker_error', { reason:'internal' }, () => { throw new Error('private'); }), false);
  assert.equal(log('worker_error', null, () => calls++), false);
});
