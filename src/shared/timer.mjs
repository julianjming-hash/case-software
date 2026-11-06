// src/shared/timer.mjs: ONE rounding for the advisory decision timer on every screen.
//
// The walkthrough found the console at 1:15, the projector at "About 1 minute" and a phone at "About 2
// minutes" for the same timer: each window computed and rounded the time on its own. Every surface
// now takes the remaining seconds from `timerRemainingS` and the words from `timerWords`, so the
// console's clock and the room's words always describe the same number.
//
//   timerRemainingS(view.timer, Date.now())  → whole seconds left (never negative)
//   timerWords(75)                           → 'About 1 minute left'   (projector and phones)
//   timerClock(75)                           → '1:15'                  (facilitator console)
//
// Pure: the clock is passed in. Accepts both timer shapes in the projections:
//   display/participant  { paused: true, remainingS } | { paused: false, endsAt }
//   facilitator (state)  { durationS, startedAt, remainingS: null | n }

/** Whole seconds left on an advisory timer at `nowMs`, rounded UP (a timer reads 0 only when it is up). */
export function timerRemainingS(timer, nowMs = Date.now()) {
  if (!timer) return null;
  if (Number.isFinite(timer.remainingS)) return Math.max(0, Math.ceil(timer.remainingS));
  const end = timer.endsAt ? Date.parse(timer.endsAt) : Date.parse(timer.startedAt) + Number(timer.durationS) * 1000;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - nowMs) / 1000));
}

/** The words the room sees. Minutes are rounded to the NEAREST minute, never up. */
export function timerWords(remainingS) {
  const r = Number(remainingS);
  if (!Number.isFinite(r) || r <= 0) return 'Time is up';
  if (r <= 10) return '10 seconds left';
  if (r <= 30) return 'Less than 30 seconds left';
  const minutes = Math.max(1, Math.round(r / 60));
  return minutes === 1 ? 'About 1 minute left' : `About ${minutes} minutes left`;
}

/** The console's clock for the same number of seconds, `m:ss`. */
export function timerClock(remainingS) {
  const r = Math.max(0, Math.floor(Number(remainingS) || 0));
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

/** CASE-334: zero means time is up and responses stay open, so the line a screen shows says so; announcements keep the short
 *  `timerWords`. The projector speaks to the room, a phone to the person holding it. */
export function timerLine(remainingS, audience = 'room') {
  const r = Number(remainingS);
  if (Number.isFinite(r) && r > 0) return timerWords(r);
  return audience === 'phone' ? 'Time is up · you can still answer' : 'Time is up · answers still open';
}

/** Polite announcement thresholds, in seconds; the words come from `timerWords` too. */
export const TIMER_ANNOUNCE_AT = Object.freeze([60, 10, 0]);

/** CASE-320: the console's timer slider, 10 s to 5 min: 5 s steps to a minute, 15 s to two, 30 s to five (21 stops). */
export const TIMER_STOPS = Object.freeze([
  ...Array.from({ length: 11 }, (_, i) => 10 + i * 5),
  ...Array.from({ length: 4 }, (_, i) => 75 + i * 15),
  ...Array.from({ length: 6 }, (_, i) => 150 + i * 30),
]);

/** The stop nearest to `seconds` (an unknown or stored value lands on a real stop). */
export function nearestTimerStop(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return 90;
  return TIMER_STOPS.reduce((best, x) => Math.abs(x - s) < Math.abs(best - s) ? x : best, TIMER_STOPS[0]);
}

/** Spoken form for a slider's aria-valuetext: '1 minute 30 seconds'. */
export function timerSpoken(seconds) {
  const m = Math.floor(seconds / 60), r = seconds % 60;
  return [m ? `${m} minute${m === 1 ? '' : 's'}` : '', r ? `${r} seconds` : ''].filter(Boolean).join(' ');
}
