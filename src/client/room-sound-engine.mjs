// The room music engine (CASE-334), ported from the approved round8 reference (prototypes/sound-stage/engine.mjs, CASE-333).
// It keeps the reference's mixing, crest, melodic time-up cue and two-bar release exactly, and changes three things:
//   1. Tempo profiles come from the room's public transport (src/shared/music-timeline.mjs), never from a local guess, so every
//      projector hands over on the same bar. A projector whose audio arrives late seeks into the same timeline.
//   2. The public clock is tracked with hysteresis: only a real correction (over 50 ms) moves the musical origin.
//   3. Only the shipped control remains: Build intensity. Hold, Drop, Cue, Next, Fade, Cut and Duck stay in the audition lab.
// Only public scene, timer and intensity reach it. The caller owns the AudioContext, its gesture and the master level.
import { energyCurve, scaledEnergy, musicSegments, segmentAt } from '../shared/music-timeline.mjs';
const clamp = n => Math.max(0, Math.min(1, n));
/** Correlated full mixes at the same musical phase: convex crossfades avoid a +3 dB bump. */
export function sectionMix(energy) {
  const t = clamp(energy) * 2;
  return t <= 1 ? [1 - t, t, 0] : [0, 2 - t, t - 1];
}
export function resolutionEnvelope(intensity = 1) { const level = .55 + .1 * Math.min(1.5, Math.max(0, intensity)); return [[0, 0], [.04, level], [.7, level * .65], [2, 0]]; }
export function envelopeValue(points, time) {
  let previous = { time: 0, value: 0 };
  for (const point of points) {
    if (point.time > time) {
      if (point.type === 'ramp' && point.time > previous.time) return previous.value + (point.value - previous.value) * (time - previous.time) / (point.time - previous.time);
      return previous.value;
    }
    previous = point;
  }
  return previous.value;
}
// Scheduled-envelope bookkeeping: a hold reads the value this engine scheduled, never an AudioParam's intrinsic default.
function setGain(voice, value, time) {
  voice.gain.gain.setValueAtTime(value, time);
  voice.envelope = voice.envelope.filter(p => p.time !== time); voice.envelope.push({ time, value, type: 'set' }); voice.envelope.sort((a, b) => a.time - b.time);
}
function rampGain(voice, value, time) {
  voice.gain.gain.linearRampToValueAtTime(value, time);
  voice.envelope = voice.envelope.filter(p => p.time !== time); voice.envelope.push({ time, value, type: 'ramp' }); voice.envelope.sort((a, b) => a.time - b.time);
}
function holdGain(voice, time) {
  const value = envelopeValue(voice.envelope, time); voice.gain.gain.cancelScheduledValues(time);
  voice.envelope = voice.envelope.filter(p => p.time < time).slice(-96); setGain(voice, value, time); return value;
}
/** A decoded buffer's identity: its hashed URL in the shipped library, its content hash in tests. */
const idOf = asset => asset?.url ?? asset?.sha256;
const LOOKAHEAD_MS = 3000, PRELOAD_MS = 20_000, CLOCK_STEP_MS = 50;
export function createRoomSound({ context, destination, assets, load }) {
  if (!context || !destination || !Array.isArray(assets?.tracks) || typeof load !== 'function') throw TypeError('Context, destination, library and lazy loader required');
  const library = assets.tracks;
  const bus = context.createGain(); bus.gain.value = 0; bus.connect(destination);
  const busVoice = { gain: bus, envelope: [{ time: context.currentTime, value: 0, type: 'set' }] };
  const cache = new Map(), shots = new Set(), sources = new Set(); let clockOffsetMs = 0, hasPublicClock = false;
  let closed = false, generation = 0, controller = null, pending = null, requestedKey = null, preloading = null;
  let scene = null, playableScene = null, track = null, voices = [], zero = null, timer = null, origin = context.currentTime, transition = null;
  let locked = false, zeroHandled = false, intensity = 1, releaseAt = null, releaseFrom = null, releaseBase = 1;
  const assertOpen = () => { if (closed) throw Error('Room sound is closed'); };
  const now = () => context.currentTime;
  const nowMs = () => now() * 1000 + clockOffsetMs;
  const toContext = ms => (ms - clockOffsetMs) / 1000;
  const remaining = () => !timer ? null : timer.paused ? timer.remainingS : Math.max(0, timer.deadline - now());
  const scaled = value => scaledEnergy(value, intensity);
  const sectionWeights = value => sectionMix(value / (track?.tempoTier === 2 ? 1.5 : track?.tempoTier === 1 ? 1.25 : 1));
  const releaseSeconds = () => 2 * (60 / (track?.bpm || 120)) * (track?.meter || 4);
  /** A public room clock reading. Only a correction beyond 50 ms moves the offset, so tiny jitter never re-seeks music. */
  function syncClock(ms) {
    if (!Number.isFinite(ms)) return;
    const offset = ms - now() * 1000;
    if (!hasPublicClock || Math.abs(offset - clockOffsetMs) > CLOCK_STEP_MS) clockOffsetMs = offset;
    hasPublicClock = true;
  }
  function releaseEnergy(at, from) { const t = clamp((at - (releaseAt ?? timer?.deadline ?? at)) / releaseSeconds()); return from * (1 - t * t * (3 - 2 * t)); }
  function settle() {
    if (!locked && timer && !timer.paused && now() >= timer.deadline && !zeroHandled) {
      releaseAt = timer.deadline; releaseBase = 1; releaseFrom = scaled(releaseBase); zeroHandled = true;
    }
  }
  function energy() {
    settle();
    if (zeroHandled) return releaseEnergy(now(), releaseFrom ?? scaled(1));
    return scaled(energyCurve(remaining(), timer?.totalS || 60));
  }
  function cancelZero(force = false) {
    if (zero && (force || (zero.finishAt ?? zero.at) > now())) {
      const deadline = zero.finishAt ?? zero.at;
      retire(zero, .015, now(), deadline > now() ? deadline : Infinity);
    }
    zero = null;
  }
  function retire(voice, seconds = .04, at = now(), hardStop = Infinity) {
    // Cancelled one-shots keep their earliest stop. A still-audible loop may move its queued transition later.
    const retimingLoop = voice.node.loop && at > now() && (voice.stopAt ?? Infinity) > now();
    const stopAt = Math.min(at + seconds + .002, hardStop, retimingLoop ? Infinity : voice.stopAt ?? Infinity); voice.stopAt = stopAt;
    const start = Math.min(at, stopAt), end = Math.max(start, stopAt - .002);
    holdGain(voice, start); rampGain(voice, 0, end);
    try { voice.node.stop(stopAt); } catch { /* already stopped */ }
  }
  function cancelLoad() { generation++; if (controller) controller.abort(); controller = null; pending = null; }
  function level(seconds = .15) { holdGain(busVoice, now()); rampGain(busVoice, locked ? 0 : 1, now() + seconds); }
  function makeVoice(buffer, at, offset, loopS = null) {
    const node = context.createBufferSource(), gain = context.createGain();
    node.buffer = buffer; node.loop = Boolean(loopS); if (loopS) { node.loopStart = 0; node.loopEnd = loopS; }
    gain.gain.value = 0; node.connect(gain); gain.connect(bus);
    const voice = { node, gain, at, envelope: [{ time: now(), value: 0, type: 'set' }] };
    setGain(voice, 0, now());
    sources.add(voice); if (!loopS) shots.add(voice);
    node.onended = () => { node.disconnect(); gain.disconnect(); shots.delete(voice); sources.delete(voice); };
    node.start(at, offset); return voice;
  }
  async function buffer(asset, signal) {
    const id = idOf(asset);
    if (cache.has(id)) { const hit = cache.get(id); cache.delete(id); cache.set(id, hit); return hit; }
    const decoded = await load(asset, { signal });
    if (signal.aborted) throw Error('Load cancelled');
    // Bounded decoded memory: the playing profile and the next one (four buffers each), least recently used first out.
    while (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(id, decoded); return decoded;
  }
  function finishDuck(at, deadline) { const t = at - deadline; if (t < -.12 || t >= 2) return 1; if (t < 0) return .78 - .22 * t / .12; return t < .7 ? .78 : .78 + .22 * (t - .7) / 1.3; }
  function automateFinish(voice, deadline) {
    const start = Math.max(now(), deadline); holdGain(voice, start); if (start === deadline) setGain(voice, 0, start);
    for (const [seconds, value] of resolutionEnvelope(intensity).slice(1)) { const at = deadline + seconds; if (at > start) rampGain(voice, value, at); }
  }
  function automate() {
    const start = Math.max(now(), voices[0]?.at || now()), rem = timer && !timer.paused ? Math.max(0, timer.deadline - start) : remaining();
    const initial = track?.kind === 'decision' ? sectionWeights(energy()) : [1, 0, 0];
    const terminal = releaseFrom ?? scaled(1);
    for (const [index, voice] of voices.entries()) {
      holdGain(voice, start); const deadlineNow = zeroHandled ? releaseAt : timer && !timer.paused ? timer.deadline : null; const mixLevel = deadlineNow === null ? 1 : finishDuck(start, deadlineNow); rampGain(voice, (initial[index] ?? 0) * mixLevel, start + .15);
      if (track?.kind !== 'decision') continue;
      if (timer && !timer.paused && rem > 0 && !zeroHandled) {
        const buildS = Math.min(90, timer.totalS * .4), begin = Math.max(.15, rem - buildS), end = rem, steps = 48;
        if (end > begin) for (let step = 0; step <= steps; step++) {
          const ahead = begin + (end - begin) * step / steps;
          rampGain(voice, sectionWeights(scaled(energyCurve(Math.max(0, rem - ahead), timer.totalS)))[index] * finishDuck(start + ahead, timer.deadline), start + ahead);
        }
      }
      // Keep every loop running: crest at zero, then ease its density down over two bars.
      const deadline = zeroHandled ? releaseAt : timer && !timer.paused ? timer.deadline : null;
      if (deadline === null) continue;
      if (deadline - .12 > start + .15) { const before = scaled(energyCurve(.12, timer?.totalS || 60)); rampGain(voice, sectionWeights(before)[index], deadline - .12); }
      const duration = releaseSeconds();
      for (let step = 0; step <= 32; step++) {
        const at = deadline + duration * step / 32; if (at < start + .15) continue;
        const t = step / 32, value = terminal * (1 - t * t * (3 - 2 * t)); rampGain(voice, sectionWeights(value)[index] * finishDuck(at, deadline), at);
      }
    }
  }
  function scheduleZero() {
    if (zero && timer && !timer.paused && !locked && zero.finishAt === timer.deadline && zero.assetId === idOf(track?.assets.zero)) return;
    cancelZero();
    if (!track || !voices.length || track.kind !== 'decision' || locked || !timer || timer.paused || zeroHandled) return;
    const rem = remaining();
    if (rem <= .005) { zeroHandled = true; automate(); return; }
    const finishTrack = transition && timer.deadline < transition.at ? transition.previous : track;
    const decoded = cache.get(idOf(finishTrack.assets.zero)); if (!decoded) return;
    const at = timer.deadline, offset = (finishTrack.assets.zero.leadInS || 0) + (finishTrack.assets.zero.attackSkipS ?? .15);
    const voice = makeVoice(decoded, at, offset);
    automateFinish(voice, at);
    zero = Object.assign(voice, { finishAt: timer.deadline, startAt: at, assetId: idOf(finishTrack.assets.zero) });
    if (transition && at < transition.at) retire(voice, .12, transition.at);
  }
  function profileFor(base, tier) {
    const profile = tier ? (base.boosts || [])[tier - 1] : null;
    return { ...(profile || base), id: base.id, variantId: profile?.id || base.id, tempoTier: profile ? tier : 0 };
  }
  function publicTimer() {
    if (!timer) return null;
    return timer.paused ? { paused: true, remainingS: timer.remainingS, totalS: timer.totalS } : { paused: false, deadlineMs: timer.deadline * 1000 + clockOffsetMs, totalS: timer.totalS };
  }
  /** Where the public transport says this decision's music is now, and what it plays next. */
  function timeline(transport, base) {
    const segments = musicSegments({ trackId: base.id, intensity, anchor: transport, timer: publicTimer() });
    const at = nowMs(), playing = segmentAt(segments, at), next = segments.find(segment => segment.startMs > at) ?? null;
    return { playing, next };
  }
  function sceneFor(nextScene) {
    if (nextScene.kind !== 'decision' || !nextScene.transport || !hasPublicClock) return nextScene;
    const base = library.find(item => item.id === nextScene.trackId && item.kind === 'decision');
    if (!base) return nextScene;
    const { playing, next } = timeline(nextScene.transport, base);
    // A queued handover within the look-ahead is scheduled now, on its own bar; otherwise play (or seek into) the current one.
    const target = next && next.startMs - nowMs() < LOOKAHEAD_MS ? next : playing;
    return { ...nextScene, tempoTier: target.tier, effectiveAtMs: target.originMs, startAtMs: target.startMs > nowMs() ? target.startMs : undefined };
  }
  /** Follow the public timeline: schedule the next tempo handover a few seconds ahead and preload it well before. */
  function syncTempo() {
    if (closed || locked || zeroHandled || !voices.length || track?.kind !== 'decision' || !playableScene?.transport || !hasPublicClock || pending) return;
    const target = sceneFor(playableScene);
    const originNow = Number.isFinite(target.effectiveAtMs) ? toContext(target.effectiveAtMs) : origin;
    if (target.tempoTier !== (track.tempoTier || 0) || Math.abs(originNow - origin) > .02) void setScene({ ...playableScene, nowMs: undefined, tempoOnly: true }).catch(() => {});
    const base = library.find(item => item.id === track.id), { next } = timeline(playableScene.transport, base);
    if (next && next.startMs - nowMs() < PRELOAD_MS && preloading !== `${base.id}:${next.tier}`) {
      preloading = `${base.id}:${next.tier}`; const signal = new AbortController().signal, profile = profileFor(base, next.tier);
      void Promise.all(['low', 'mid', 'peak', 'zero'].map(part => buffer(profile.assets[part], signal))).catch(() => { preloading = null; });
    }
  }
  function selectedTrack(nextScene) {
    if (nextScene.kind === 'decision') {
      const found = library.find(item => item.id === nextScene.trackId && item.kind === 'decision');
      if (!found) throw TypeError('Track is unavailable in this scene');
      return profileFor(found, nextScene.tempoTier ?? 0);
    }
    return library.find(item => item.kind === nextScene.kind) || null;
  }
  function playback() {
    if (transition && now() < transition.at) return { track: transition.previous, voices: transition.oldVoices, origin: transition.origin };
    return { track: transition?.nextTrack || track, voices, origin };
  }
  async function setScene(input) {
    assertOpen();
    if (!input || typeof input.kind !== 'string') throw TypeError('Scene kind required');
    if (['locked', 'silent', 'ended'].includes(input.kind)) { scene = { ...input }; lock(); if (input.kind === 'ended') cache.clear(); return; }
    syncClock(input.nowMs);
    const nextScene = sceneFor(input);
    const requestedOrigin = Number.isFinite(nextScene.effectiveAtMs) && hasPublicClock ? toContext(nextScene.effectiveAtMs) : null;
    const requestedStart = Number.isFinite(nextScene.startAtMs) && hasPublicClock ? toContext(nextScene.startAtMs) : null;
    const nextTrack = selectedTrack(nextScene);
    if (!nextTrack) { stop(); scene = { ...input }; return; }
    const key = `${nextScene.decisionId || nextScene.kind}:${nextTrack.variantId || nextTrack.id}:${nextScene.effectiveAtMs ?? ''}:${nextScene.startAtMs ?? ''}`;
    if (pending && requestedKey === key) return pending;
    const same = scene?.decisionId === nextScene.decisionId && track?.id === nextTrack.id && (track?.variantId || track?.id) === (nextTrack.variantId || nextTrack.id) && !locked && (requestedOrigin === null || Math.abs(requestedOrigin - origin) < .02);
    if (same && voices.length && !pending) { scene = { ...input }; playableScene = { ...input, tempoOnly: false }; return; }
    const changedDecision = playableScene?.decisionId !== nextScene.decisionId;
    cancelLoad(); if (!nextScene.tempoOnly) cancelZero();
    scene = { ...input }; playableScene = { ...input, tempoOnly: false }; locked = false; requestedKey = key;
    if (changedDecision) { zeroHandled = Boolean(timer && remaining() <= 0); if (!zeroHandled) { releaseAt = null; releaseFrom = null; } preloading = null; }
    const ticket = generation, signal = (controller = new AbortController()).signal;
    const task = (async () => {
      const parts = nextTrack.kind === 'decision' ? ['low', 'mid', 'peak', 'zero'] : ['low'];
      const live = playback(), sameLive = (live.track?.variantId || live.track?.id) === (nextTrack.variantId || nextTrack.id);
      const decoded = await Promise.all(parts.map((part, index) => sameLive && index < live.voices.length ? live.voices[index].node.buffer : buffer(nextTrack.assets[part], signal)));
      if (ticket !== generation || signal.aborted || closed || nextScene.tempoOnly && timer && !timer.paused && now() >= timer.deadline) return;
      const previous = playback(), oldVoices = previous.voices;
      const quantize = !changedDecision && oldVoices.length && previous.track?.kind === 'decision' && nextTrack.kind === 'decision' && (previous.track.id !== nextTrack.id || (previous.track.variantId || previous.track.id) !== (nextTrack.variantId || nextTrack.id));
      // A late load seeks into the public timeline at once; an early one waits for its bar.
      let at = now() + .02;
      if (requestedStart !== null) at = Math.max(at, requestedStart);
      else if (requestedOrigin === null && quantize) { const barS = 60 / previous.track.bpm * previous.track.meter; at = previous.origin + Math.ceil((now() + .08 - previous.origin) / barS) * barS; }
      if (nextScene.tempoOnly && timer && !timer.paused && at >= timer.deadline) return;
      // Replacing a queued change cancels its not-yet-audible sources, not the audible group.
      if (transition && now() < transition.at) for (const voice of voices) retire(voice, .005);
      for (const voice of oldVoices) { holdGain(voice, now()); retire(voice, .15, at); }
      const tempoChange = oldVoices.length && previous.track?.id === nextTrack.id && previous.track.bpm !== nextTrack.bpm;
      const tempoOrigin = tempoChange ? at - (at - previous.origin) / (60 / previous.track.bpm * previous.track.meter) * (60 / nextTrack.bpm * nextTrack.meter) : null;
      const sameProfile = oldVoices.length && previous.track?.id === nextTrack.id && previous.track.bpm === nextTrack.bpm;
      const nextOrigin = requestedOrigin ?? (sameProfile ? previous.origin : tempoOrigin) ?? (!oldVoices.length && timer && !timer.paused && remaining() > 0 ? timer.deadline - Math.ceil(remaining() / nextTrack.loopS) * nextTrack.loopS : at);
      transition = oldVoices.length ? { at, previous: previous.track, nextTrack, oldVoices, origin: previous.origin } : null;
      track = nextTrack; origin = nextOrigin;
      const offset = ((at - origin) % nextTrack.loopS + nextTrack.loopS) % nextTrack.loopS;
      for (const shot of shots) if (shot !== zero || zero.assetId !== idOf(nextTrack.assets.zero)) retire(shot, .12, at);
      voices = decoded.slice(0, nextTrack.kind === 'decision' ? 3 : 1).map(item => makeVoice(item, at, offset, nextTrack.loopS));
      level(); automate(); scheduleZero();
    })();
    pending = task;
    try { await task; } catch (error) { if (!signal.aborted && ticket === generation) throw error; }
    finally { if (ticket === generation) { pending = null; requestedKey = null; } }
  }
  function setTimer(value) {
    assertOpen();
    if (value === null) { timer = null; zeroHandled = false; releaseAt = null; releaseFrom = null; cancelZero(); automate(); syncTempo(); return; }
    if (!Number.isFinite(value.totalS) || value.totalS < 10 || value.totalS > 600) throw TypeError('Timer total must be 10–600 seconds');
    syncClock(value.nowMs);
    const rem = value.endsAtMs !== undefined ? (value.endsAtMs - nowMs()) / 1000 : value.remainingS;
    if (!Number.isFinite(rem)) throw TypeError('Timer remaining time required');
    const next = { totalS: value.totalS, paused: Boolean(value.paused), remainingS: Math.max(0, rem), deadline: now() + rem };
    if (timer && timer.totalS === next.totalS && timer.paused === next.paused && (next.paused ? timer.remainingS === next.remainingS : Math.abs(timer.deadline - next.deadline) < .02)) return;
    const wasPast = remaining() === 0;
    timer = next;
    if ((wasPast || zeroHandled) && next.remainingS > 0) { zeroHandled = false; releaseAt = null; releaseFrom = null; }
    if (next.remainingS === 0) { if (!zeroHandled) { releaseBase = 1; releaseFrom = scaled(releaseBase); releaseAt = next.deadline; } zeroHandled = true; }
    automate(); scheduleZero(); syncTempo();
  }
  function lock() {
    assertOpen();
    const audible = playback(); if (audible.track) { track = audible.track; origin = audible.origin; }
    locked = true; cancelLoad(); cancelZero(true); for (const voice of sources) retire(voice, .04); voices = []; transition = null; level(.04);
  }
  async function unlock() {
    assertOpen(); if (!locked) return;
    locked = false;
    if (playableScene) await setScene({ ...playableScene, nowMs: undefined, tempoOnly: false });
  }
  function control(command) {
    assertOpen(); settle();
    if (Object.hasOwn(command, 'intensity')) {
      if (!Number.isFinite(command.intensity) || command.intensity < 0 || command.intensity > 1.5) throw TypeError('Intensity must be 0–1.5');
      if (command.intensity === intensity) return;
      intensity = command.intensity; if (zeroHandled) releaseFrom = scaled(releaseBase); if (zero) automateFinish(zero, zero.finishAt);
    }
    automate(); syncTempo();
  }
  /** Called on the caller's tick with the public clock: keeps the tempo timeline and clock offset current. */
  function tick(publicNowMs) { if (closed) return; syncClock(publicNowMs); settle(); syncTempo(); }
  function clock() {
    settle();
    const audible = playback().track;
    const audibleOrigin = transition && now() < transition.at ? transition.origin : origin;
    const bpm = audible?.bpm || 120, meter = audible?.meter || 4, beats = Math.max(0, now() - audibleOrigin) * bpm / 60;
    const rem = remaining();
    return { started: playback().voices.length > 0 && now() >= (playback().voices[0]?.at || 0) && !locked, trackId: audible?.id || null, variantId: audible?.variantId || audible?.id || null,
      pendingTrackId: transition && now() < transition.at ? track?.variantId || track?.id : null, tempoTier: audible?.tempoTier || 0, intensity,
      transportStartedAtMs: hasPublicClock ? audibleOrigin * 1000 + clockOffsetMs : null, bar: Math.floor(beats / meter) + 1, beat: Math.floor(beats) % meter + 1, beatPhase: beats % 1, bpm,
      section: locked ? 'locked' : track?.kind !== 'decision' ? track?.kind || 'silent' : rem === 0 ? 'after-zero' : energy() < .35 ? 'settle' : energy() < .8 ? 'build' : 'peak',
      energy: track?.kind === 'decision' ? energy() : .15, toZeroS: rem, cached: cache.size };
  }
  function stop() { assertOpen(); cancelLoad(); cancelZero(true); for (const voice of sources) retire(voice, .02); voices = []; transition = null; holdGain(busVoice, now()); rampGain(busVoice, 0, now() + .02); }
  function close() { if (closed) return; stop(); cache.clear(); bus.disconnect(); closed = true; }
  return { setScene, setTimer, lock, unlock, control, tick, clock, stop, close };
}
