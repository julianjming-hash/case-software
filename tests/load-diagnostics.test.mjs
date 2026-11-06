import test from 'node:test';
import assert from 'node:assert/strict';
import { voteDiagnostics } from '../scripts/load-diagnostics.mjs';

test('vote timing separates network, disclosure inspection and receipt delivery without changing the clock', () => {
  let tick = 0; const d = voteDiagnostics(() => tick);
  d.begin('private-event', 7, 2);
  tick = 5; const a = d.attempt('private-event');
  tick = 25; a.headers(200); tick = 40; a.inspected(); tick = 45; a.finish();
  tick = 60; d.receipt('private-event');
  assert.deepEqual(d.report(), [{ phone: 7, round: 2, elapsed_ms: 60, receipt_tail_ms: 15,
    attempts: [{ headers_ms: 20, inspection_ms: 15, elapsed_ms: 40, status: 200, aborted: false, failed: false }] }]);
});

test('lost-response replay remains in the elapsed measurement with both attempts preserved', () => {
  let tick = 0; const d = voteDiagnostics(() => tick); d.begin('same-event', 0, 1);
  const first = d.attempt('same-event'); tick = 20; first.headers(200); tick = 30; first.inspected(); first.finish({ failed: true });
  tick = 2030; const second = d.attempt('same-event'); tick = 2050; second.headers(200); second.inspected(); second.finish();
  tick = 2055; d.receipt('same-event');
  const row = d.report()[0]; assert.equal(row.elapsed_ms, 2055); assert.equal(row.receipt_tail_ms, 5);
  assert.equal(row.attempts.length, 2); assert.equal(row.attempts[0].failed, true); assert.equal(row.attempts[1].failed, false);
});

test('unfinished and aborted attempts stay incomplete, and diagnostics never serialize identities or arbitrary fields', () => {
  let tick = 0; const d = voteDiagnostics(() => tick);
  d.begin('CAPABILITY_MUST_STAY_PRIVATE', 1, 3); const a = d.attempt('CAPABILITY_MUST_STAY_PRIVATE');
  tick = 12; a.finish({ aborted: true, failed: true, token: 'PRIVATE_TOKEN', body: 'PRIVATE_TEXT' });
  const report = d.report(); assert.equal(report[0].elapsed_ms, null); assert.equal(report[0].receipt_tail_ms, null);
  assert.deepEqual(report[0].attempts, [{ headers_ms: null, inspection_ms: null, elapsed_ms: 12, status: null, aborted: true, failed: true }]);
  assert.doesNotMatch(JSON.stringify(report), /CAPABILITY|PRIVATE|token|body/);
  report[0].attempts[0].elapsed_ms = 999; assert.equal(d.report()[0].attempts[0].elapsed_ms, 12);
  assert.throws(() => d.begin('x', 'private-name', 1), /ordinal/); assert.throws(() => d.begin('x', 0, 0), /ordinal/);
  assert.throws(() => d.attempt('missing'), /vote_missing/); assert.throws(() => d.receipt('missing'), /vote_missing/);
});
