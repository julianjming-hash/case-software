// CASE-334/335: the console's timer clock and Build words, and the projector countdown, all from the authoritative deadline with
// the shared rounding. The projector shows digits only, pulses at 60 s and 30 s, pops each of the final ten seconds, and turns
// into a Time up chip at zero while answers stay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdownState, refreshCountdown, COUNTDOWN_MILESTONES } from '../src/client/projector-render.mjs';
import { timerClockParts, buildWords } from '../src/client/console-room-tab.mjs';
import { timerLine, timerWords } from '../src/shared/timer.mjs';

const endsAt = '2026-11-01T09:01:30.000Z', at = s => Date.parse(endsAt) - s * 1000;
const view = { timer: { paused: false, endsAt }, timerTotalS: 90 };

test('[AS-201] the projector countdown is digits from the deadline, then a Time up chip', () => {
  assert.deepEqual(countdownState(view, at(48)), { remaining: 48, words: 'About 1 minute left', state: 'run', text: '0:48', fraction: 48 / 90 });
  assert.deepEqual(countdownState(view, at(10.4)), { remaining: 11, words: 'Less than 30 seconds left', state: 'run', text: '0:11', fraction: 11 / 90 }, 'rounded up: 10.4 s reads 0:11');
  assert.deepEqual(countdownState(view, at(6.2)), { remaining: 7, words: '10 seconds left', state: 'final', text: '0:07', fraction: 7 / 90 });
  assert.deepEqual(countdownState(view, at(0)), { remaining: 0, words: 'Time is up · answers still open', state: 'up', text: 'Time up', fraction: 0 });
  assert.equal(countdownState({ timer: { paused: true, remainingS: 20 } }, 0).fraction, null, 'no length, no ring');
  assert.equal(timerWords(0), 'Time is up', 'announcements keep the short words');
  assert.equal(timerLine(0, 'phone'), 'Time is up · you can still answer');
});

test('[AS-201] milestones pulse once as they are crossed and each final second pops once', () => {
  const dataset = {}, line = { textContent: '', closest: () => ({ dataset }) }, style = { values: {}, setProperty(k, v) { this.values[k] = v; } };
  const doc = { getElementById: id => id === 'timerLine' ? line : id === 'timerRing' ? { style } : null };
  const pulses = [], ticks = [];
  for (let s = 75; s >= -1; s--) { refreshCountdown(doc, view, at(s)); pulses.push(dataset.pulse); ticks.push(dataset.tick); }
  assert.deepEqual(COUNTDOWN_MILESTONES, [60, 30]);
  assert.equal(new Set(pulses.filter(Boolean)).size, 2, 'two milestone pulses (60 s and 30 s)');
  assert.equal(pulses.findIndex(Boolean), 75 - 60, 'the first pulse lands at 60 s');
  const flips = ticks.filter((t, i) => t && t !== ticks[i - 1]).length;
  assert.equal(flips, 10, 'one pop for each of the final ten seconds');
  assert.equal(line.textContent, 'Time up'); assert.equal(dataset.state, 'up');
  refreshCountdown(doc, view, at(-2)); assert.equal(line.textContent, 'Time up', 'the chip stays without new animation');
});

test('[AS-201] the console clock reads the same deadline, and the Build words say what the dial does', () => {
  const timer = { durationS: 90, startedAt: '2026-11-01T09:00:00.000Z', remainingS: null, totalS: 90 };
  const nowMs = Date.parse('2026-11-01T09:00:42.300Z');
  assert.deepEqual(timerClockParts(timer, nowMs), { clock: '0:48', detail: 'of 1:30', fraction: 48 / 90, up: false });
  assert.equal(countdownState(view, nowMs).remaining, 48, 'console and projector agree on the second');
  assert.deepEqual(timerClockParts(timer, Date.parse('2026-11-01T09:01:31Z')), { clock: 'Time up', detail: 'Answers still open', fraction: 0, up: true });
  assert.equal(buildWords(0), 'Stays calm: no build.');
  assert.equal(buildWords(70), 'Builds to most of the full peak at time-up.');
  assert.equal(buildWords(150), 'Full peak, then fuller and faster near time-up (+12% tempo, same pitch).');
});
