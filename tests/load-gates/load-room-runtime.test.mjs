// CI load gate (CASE-161): runs only in the `load-gates` job (`npm run test:load-gates`), never in
// `npm test`, so the 1 s p95 budget measures its own runner and not the unit suite's. Budget unchanged.
// Real local Worker/RoomDO/transport load. No deployed origin or credential is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions, runLoad } from '../../scripts/load-room.mjs';

test('[AS-093] Card20 50 local phones receive every vote receipt under 1s p95 with observed fan-out', { timeout: 120_000 }, async t => {
  const report = await runLoad(parseOptions(['--clients', '50']), { signal: t.signal });
  console.log(JSON.stringify(report));
  assert.equal(report.clients, 50);
  assert.equal(report.expected_votes, 50);
  assert.equal(report.receipted_votes, 50);
  assert.equal(report.lost_votes, 0);
  assert.ok(report.acknowledgement_ms.p95 < 1000);
  assert.ok(Number.isFinite(report.fanout_lag_ms.p95));
  assert.equal(report.response_loss_injected, true);
  assert.equal(report.replay_same_event, true, 'lost response resends the exact accepted vote envelope');
  assert.equal(report.injected_vote_latency_ms, 8);
  assert.ok(report.injected_vote_requests >= 51);
  assert.ok(Object.values(report.transport_modes).reduce((a, b) => a + b, 0) === 50);
});
