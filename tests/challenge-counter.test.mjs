import test from 'node:test';
import assert from 'node:assert/strict';
import { CHALLENGE_WINDOW_MS, CHALLENGE_STRIKES, challengeRequired, recordChallengeFailure, resetChallenge } from '../src/worker/challenge-counter.mjs';

test('challenge counter requires exactly three failed codes within a ten-minute fixed window', () => {
  assert.equal(CHALLENGE_WINDOW_MS, 600000); assert.equal(CHALLENGE_STRIKES, 3);
  let row = null;
  for (let i = 1; i <= 3; i++) {
    row = recordChallengeFailure(row, 1000 + i);
    assert.equal(challengeRequired(row, 1000 + i), i === 3);
  }
  assert.equal(row.windowStart, 1001); assert.equal(row.expiresAt, 601001);
});

test('challenge counter expires at the exact server window boundary and restarts without stale strikes', () => {
  const row = { windowStart: 1000, expiresAt: 601000, n: 3 };
  assert.equal(challengeRequired(row, 600999), true);
  assert.equal(challengeRequired(row, 601000), false);
  assert.deepEqual(recordChallengeFailure(row, 601000), { windowStart: 601000, expiresAt: 1201000, n: 1 });
});

test('verified challenge resets strikes instead of exempting later wrong codes for ten minutes', () => {
  const row = resetChallenge({ windowStart: 1000, expiresAt: 601000, n: 3 });
  assert.equal(row, null); assert.equal(challengeRequired(row, 1001), false);
  assert.deepEqual(recordChallengeFailure(row, 1001), { windowStart: 1001, expiresAt: 601001, n: 1 });
});

test('challenge counter saturates at three with bounded fields and TTL despite repeated wrong codes', () => {
  let row = null;
  for (let i = 0; i < 10000; i++) row = recordChallengeFailure(row, 1000 + i);
  assert.deepEqual(row, { windowStart: 1000, expiresAt: 601000, n: 3 });
});
