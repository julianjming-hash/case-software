// One rounding for the advisory timer on every screen (src/shared/timer.mjs; walkthrough bug 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timerRemainingS, timerWords, timerClock } from '../src/shared/timer.mjs';

test('[RT2] the console clock and the room\'s words describe the same seconds (1:15 is about 1 minute everywhere)', () => {
  const now = Date.parse('2026-10-01T09:00:00Z');
  const endsAt = new Date(now + 75_000).toISOString();
  const facilitatorTimer = { durationS: 120, startedAt: new Date(now - 45_000).toISOString(), remainingS: null };
  const publicTimer = { paused: false, endsAt };
  assert.equal(timerRemainingS(facilitatorTimer, now), 75);
  assert.equal(timerRemainingS(publicTimer, now), 75);
  assert.equal(timerClock(75), '1:15');
  assert.equal(timerWords(75), 'About 1 minute left');
  assert.equal(timerRemainingS({ paused: true, remainingS: 75 }, now), 75);
  // Part-seconds round up, so the clock never reads 0:00 before the words say "Time is up".
  assert.equal(timerRemainingS(publicTimer, now + 74_500), 1);
  assert.equal(timerRemainingS(publicTimer, now + 80_000), 0);
});

test('[RT2] timer words round to the nearest minute, with fixed short thresholds', () => {
  const table = [[0, 'Time is up'], [-3, 'Time is up'], [9, '10 seconds left'], [10, '10 seconds left'], [25, 'Less than 30 seconds left'],
    [31, 'About 1 minute left'], [60, 'About 1 minute left'], [89, 'About 1 minute left'], [90, 'About 2 minutes left'], [149, 'About 2 minutes left'], [150, 'About 3 minutes left']];
  for (const [s, words] of table) assert.equal(timerWords(s), words, String(s));
});

test('[RT2] the projector and the phone use the shared timer words, not their own rounding', () => {
  for (const page of ['prototypes/room/display.html', 'prototypes/room/phone.html', 'prototypes/room/facilitator.html']) {
    const src = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/src\/shared\/timer\.mjs'/, `${page} imports the shared timer`);
    assert.ok(!/function timerText\(/.test(src) && !/Math\.ceil\(r \/ 60\)/.test(src), `${page} has no private timer rounding`);
  }
});
