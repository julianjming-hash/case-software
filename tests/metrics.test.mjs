import { RECEIPTS } from '../src/shared/room-machine.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metric, METRIC_EVENTS } from '../src/worker/metrics.mjs';

const env = { CASE_ENV: 'staging', BUILD_SHA: 'a'.repeat(40) };
test('metrics writes every fixed event with anonymous environment and build dimensions', () => {
  const writes = [], bindings = { ...env, METRICS: { writeDataPoint: point => writes.push(point) } };
  const events = ['room_created','room_ended','join_ok','join_fail','transport_mode','transport_pin',
    'sync_timeout','receipt','archive_lag_s','archive_fail','delete_before_archive','turnstile_failopen',
    'supabase_unavailable','rpc_forbidden','console_revoked'];
  assert.deepEqual([...METRIC_EVENTS], events);
  for (const event of events) assert.equal(metric(bindings, { event, value: 2 }), true);
  assert.deepEqual(writes, events.map(event => ({ blobs: [event,'staging','a'.repeat(40),'',''], doubles: [2], indexes: ['staging'] })));
});
test('metrics refuses identifiers, arbitrary labels, invalid numbers and unexpected fields before writing', () => {
  const writes = [], bindings = { ...env, METRICS: { writeDataPoint: point => writes.push(point) } };
  for (const bad of [
    { event:'join_ok', token:'private' }, { event:'join_ok', sessionId:'private' },
    { event:'join_ok', name:'private' }, { event:'join_ok', ip:'private' },
    { event:'join_ok', answer:'private' }, { event:'unknown' },
    { event:'receipt', reason:'private' }, { event:'transport_mode', transport:'private' },
    { event:'room_created', value:NaN }, { event:'room_created', value:-1 },
    { event:'room_created', value:Infinity }, { event:'room_created', value:'2' }, null,
  ]) assert.equal(metric(bindings, bad), false);
  assert.deepEqual(writes, []);
});
test('metrics keeps fixed transport and receipt labels and contains unavailable backend failures', () => {
  const writes = [], bindings = { ...env, METRICS: { writeDataPoint: point => writes.push(point) } };
  for (const transport of ['ws','long-poll','poll']) assert.equal(metric(bindings, { event:'transport_mode', transport }), true);
  for (const reason of RECEIPTS) assert.equal(metric(bindings, { event:'receipt', reason }), true);
  assert.deepEqual(writes.map(point => point.blobs.slice(3)), [['ws',''],['long-poll',''],['poll',''],...RECEIPTS.map(kind=>['',kind])]);
  assert.equal(metric({}, { event:'join_ok' }), false);
  assert.equal(metric({ METRICS: { writeDataPoint() { throw new Error('private'); } } }, { event:'join_ok' }), false);
});
test('metric provenance never emits malformed configuration or caller supplied dimensions', () => {
  let point;
  const bindings = { CASE_ENV:'private', BUILD_SHA:'a'.repeat(40)+'\n', METRICS:{writeDataPoint: p => { point=p; }} };
  assert.equal(metric(bindings, { event:'join_ok' }), true);
  assert.deepEqual(point.blobs, ['join_ok','local','unconfigured','','']);
  assert.equal(metric(bindings, { event:'join_ok', env:'production', build:'private' }), false);
});
