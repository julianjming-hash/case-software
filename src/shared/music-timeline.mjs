// src/shared/music-timeline.mjs: the room music's public timeline, shared by the room machine and the projector (CASE-334).
//
// Every projector must play the same track, tempo profile and bar from public room state alone, whenever it joins and
// however slowly its audio loads. So nothing here reads a clock or a device: the room machine stores a transport
// anchor `{ atMs, tier, originMs }` whenever the music's inputs change (a round opens, the timer or the music changes,
// Undo reopens a round), and `musicSegments` derives every later tempo handover from that anchor and the public timer.
// A projector that loads late seeks into the same timeline instead of starting its own.
//
// Behaviour is ported from the approved round8 reference engine (prototypes/sound-stage/engine.mjs, CASE-333):
// the 40%-capped-at-90 s energy curve, intensity scaling, two-bar tempo forecast and harmonic-bar handover. Music derives
// only from public room state and facilitator choices: never votes, correctness or anything private.

import { MUSIC_DECISION_TRACKS, MUSIC_TEMPO } from './music-catalogue.mjs';
export { MUSIC_DECISION_TRACKS, MUSIC_TRACK_NAMES, MUSIC_TEMPO, MUSIC_INTENSITY_DEFAULT, MUSIC_INTENSITY_MAX, MUSIC_VOLUME_DEFAULT, MUSIC_CHOICES, validMusicChoice, validMusicIntensity, validMusicVolume } from './music-catalogue.mjs';

/** Automatic energy, 0.15–1: flat, then rising over the final 40% of the timer (at most 90 s) to 1 at zero. */
export function energyCurve(remainingS, totalS) {
  if (remainingS === null || remainingS === undefined) return .15;
  const windowS = Math.min(90, Math.max(0, totalS) * .4);
  if (remainingS <= 0) return 1;
  if (!windowS || remainingS >= windowS) return .15;
  return .15 + .85 * (1 - remainingS / windowS);
}
/** Intensity (0–1.5) scales only the build above the calm floor: 0 stays calm, 1 is the approved peak. */
export function scaledEnergy(energy, intensity) {
  return Math.min(energy, .15) + Math.max(0, energy - .15) * Math.max(0, intensity - .15) / .85;
}
/** The tempo profile a forecast energy asks for: faster profiles only above the full peak. */
export const tierForEnergy = energy => energy > 1.25 ? 2 : energy > 1 ? 1 : 0;

export const loopMs = (trackId, tier) => MUSIC_TEMPO[trackId].loopS[tier] * 1000;
export const barMs = (trackId, tier) => loopMs(trackId, tier) / MUSIC_TEMPO[trackId].bars;

function seedNumber(seed) {
  if (Number.isInteger(seed)) return seed >>> 0 || 1;
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(String(seed))) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash || 1;
}
/** Seeded shuffle in whole cycles: every theme plays once per cycle, and no theme repeats across a cycle boundary. */
export function shuffledTracks(seed, ids, count) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw TypeError('Unique track ids required');
  if (!Number.isInteger(count) || count < 0 || count > 10000) throw TypeError('Decision count must be 0–10000');
  const result = []; let state = seedNumber(seed);
  const draw = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  while (result.length < count) {
    const cycle = [...ids];
    for (let i = cycle.length - 1; i > 0; i--) { const j = Math.floor(draw() * (i + 1)); [cycle[i], cycle[j]] = [cycle[j], cycle[i]]; }
    if (ids.length > 1 && cycle[0] === result.at(-1)) cycle.push(cycle.shift());
    result.push(...cycle);
  }
  return result.slice(0, count);
}
/** The theme a decision plays: the facilitator's pick, or the room's shuffle at this decision's draw. */
export function musicTrackFor(choice, seed, draw) {
  if (choice !== 'auto') return MUSIC_DECISION_TRACKS.includes(choice) ? choice : null;
  return Number.isInteger(draw) && draw >= 0 && draw < 10000 ? shuffledTracks(seed, MUSIC_DECISION_TRACKS, draw + 1)[draw] : null;
}

/** The tier the music wants at `atMs`, looking two base bars ahead so a handover lands before the energy needs it. */
function wantedTier(trackId, intensity, timer, atMs) {
  if (intensity <= 1 || !timer) return 0;
  const aheadS = barMs(trackId, 0) * 2 / 1000;
  const remainingS = timer.paused ? timer.remainingS : Math.max(0, (timer.deadlineMs - atMs) / 1000 - aheadS);
  return tierForEnergy(scaledEnergy(energyCurve(remainingS, timer.totalS), intensity));
}

/**
 * Tempo segments from a transport anchor: `[{ tier, startMs, originMs }]`, the first being the anchor itself.
 * A handover happens only on a bar line of the current profile, before the deadline, and keeps the harmonic bar:
 * the new origin puts the same bar of the loop at the handover. Nothing is queued after zero, and paused or
 * untimed music changes tier at most once. Inputs: `trackId`, `intensity` 0–1.5, `anchor`, and `timer`
 * `{ deadlineMs, totalS, paused, remainingS }` or null.
 */
export function musicSegments({ trackId, intensity, anchor, timer }) {
  if (!MUSIC_TEMPO[trackId] || !anchor) return [];
  const bars = MUSIC_TEMPO[trackId].bars;
  let current = { tier: anchor.tier, startMs: anchor.atMs, originMs: anchor.originMs };
  const segments = [current];
  const handover = (at, tier) => {
    const n = Math.round((at - current.originMs) / barMs(trackId, current.tier));
    current = { tier, startMs: at, originMs: at - (((n % bars) + bars) % bars) * barMs(trackId, tier) };
    segments.push(current);
  };
  // The first bar line strictly after `after`; the epsilon keeps a time already on a bar line from repeating it.
  const nextBar = after => { const bar = barMs(trackId, current.tier); return current.originMs + (Math.floor((after - current.originMs) / bar + 1e-6) + 1) * bar; };
  if (!timer || timer.paused) {
    const tier = wantedTier(trackId, intensity, timer, anchor.atMs);
    if (tier !== current.tier) handover(nextBar(anchor.atMs), tier);
    return segments;
  }
  for (let at = nextBar(anchor.atMs), guard = 0; at < timer.deadlineMs && guard < 2000; guard++) {
    const tier = wantedTier(trackId, intensity, timer, at);
    if (tier !== current.tier) handover(at, tier);
    at = nextBar(at);
  }
  return segments;
}
/** The segment playing at `atMs`. */
export function segmentAt(segments, atMs) {
  let found = segments[0] ?? null;
  for (const segment of segments) if (segment.startMs <= atMs) found = segment;
  return found;
}
/**
 * A fresh transport for a round that starts (or restarts after Undo) at `atMs`. With a timer, the loop is placed so a
 * whole loop ends exactly at the deadline, as the approved engine does, at the tier the music wants right now.
 */
export function freshAnchor({ trackId, intensity, timer, atMs }) {
  const tier = wantedTier(trackId, intensity, timer, atMs);
  if (!timer || timer.paused) return { atMs, tier, originMs: atMs };
  const loop = loopMs(trackId, tier);
  return { atMs, tier, originMs: timer.deadlineMs - Math.ceil(Math.max(0, timer.deadlineMs - atMs) / loop) * loop };
}
/** Re-anchor at `atMs` without a restart: whatever tier and bar the old timeline plays then, continues. */
export function continuedAnchor({ trackId, intensity, anchor, timer, atMs }) {
  const playing = segmentAt(musicSegments({ trackId, intensity, anchor, timer }), atMs);
  return playing ? { atMs, tier: playing.tier, originMs: playing.originMs } : null;
}
/** A theme change lands on the next bar line at least `leadMs` ahead, so every projector can hear it start together. */
export function changedTrackAnchor({ fromTrackId, fromSegment, toTrackId, intensity, timer, atMs, leadMs = 1500 }) {
  let startMs = atMs + leadMs;
  if (fromSegment && MUSIC_TEMPO[fromTrackId]) {
    const bar = barMs(fromTrackId, fromSegment.tier);
    startMs = fromSegment.originMs + Math.ceil((atMs + leadMs - fromSegment.originMs) / bar) * bar;
  }
  return { atMs: startMs, tier: wantedTier(toTrackId, intensity, timer, startMs), originMs: startMs };
}
