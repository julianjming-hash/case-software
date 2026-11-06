// Selected semantic events retain separate identities while sharing the original material PCM.
import { createCuePlayer } from './room-cues.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { ROOM_EFFECTS } from './room-audio-map.mjs';
const field = name => Object.freeze(Object.fromEntries(Object.entries(ROOM_EFFECTS).map(([event, cue]) => [event, cue[name]])));
export const CUE_FOR_EVENT = field('semantic');
export const CUE_SOURCE = field('source');
export const CUE_EVENT_GAIN = field('gain');
export function roomCueForChange(previous, next, presented = false) {
  if (!previous || !next || next.replay || next.manual || next.phase === 'ended'
    || next.publication?.correctionOf || next.publication?.checkpointOf
    || (presented && previous.phase === 'waiting')) return null;
  const before = previous.publication?.occurrenceId, after = next.publication?.occurrenceId;
  const fresh = isUuidV7(after) && before !== after;
  if (next.phase === 'decision_open' && (previous.phase !== 'decision_open' || fresh)) return 'decision_open';
  if (next.phase === 'live' && next.surface?.timelineKind === 'live'
    && (fresh || !isUuidV7(after) && previous.surface?.surfaceId !== next.surface.surfaceId)) return 'reveal';
  return null;
}
function tone(ctx, _kind, level, ended) {
  let oscillator, gain, finished = false;
  const attempt = fn => { try { fn(); } catch { /* Stop remains useful on interrupted devices. */ } };
  const finish = () => { if (finished) return; finished = true; if (oscillator) oscillator.onended = null; attempt(() => oscillator?.disconnect()); attempt(() => gain?.disconnect()); ended?.(); };
  const stop = () => { attempt(() => oscillator?.stop()); finish(); };
  try {
    oscillator = ctx.createOscillator(); gain = ctx.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = 330;
    gain.gain.setValueAtTime(0, ctx.currentTime); gain.gain.linearRampToValueAtTime(.035 * level, ctx.currentTime + .02);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + .16);
    oscillator.connect(gain); gain.connect(ctx.destination); oscillator.onended = finish;
    oscillator.start(); oscillator.stop(ctx.currentTime + .18); return stop;
  } catch { stop(); throw Error('sound_unavailable'); }
}
export const createRoomCuePlayer = options => createCuePlayer({ map: CUE_SOURCE, eventGain: CUE_EVENT_GAIN, fallback: tone, ...options });
