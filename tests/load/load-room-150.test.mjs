// Manual 150-phone local load gate (CASE-154): run `npm run test:load150` before a release.
// Kept out of `npm test`/CI by Julian's ruling: hosted runners cannot meet the local harness's
// compressed 1 s request deadline at 150 phones. Assertions are unchanged from the CI version.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions, runLoad } from '../../scripts/load-room.mjs';

test('[AS-093] 150 local phones preserve every receipt and report measured fan-out', { timeout: 180_000 }, async t => {
  const report = await runLoad(parseOptions(['--clients', '150']), { signal: t.signal });
  console.log(JSON.stringify(report));
  assert.equal(report.clients, 150);
  assert.equal(report.expected_votes, 150);
  assert.equal(report.receipted_votes, 150);
  assert.equal(report.lost_votes, 0);
  assert.ok(Number.isFinite(report.acknowledgement_ms.p99));
  assert.ok(Number.isFinite(report.fanout_lag_ms.p99));
  assert.equal(report.response_loss_injected, true);
  assert.equal(report.replay_same_event, true);
  assert.equal(report.injected_vote_latency_ms, 8);
  assert.ok(report.injected_vote_requests >= 151);
  assert.ok(Object.values(report.transport_modes).reduce((a, b) => a + b, 0) === 150);
});
