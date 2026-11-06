// Room music on the projector (CASE-334): the approved round8 library, played from public room state only.
// Lazy: this module, the engine and every asset load only after the projector's own gesture and a deliberate music level.
// Generation fences survive uncancellable decoding; a load that exceeds ten seconds reports `unavailable`, never a fallback alarm.
// Scenes, the timer and Build come from the public view (room-audio-state.mjs); the engine follows the room's shared transport.
import { musicSceneForView, musicTimerForView } from './room-audio-state.mjs';
import { MUSIC_LIBRARY } from './music-assets.mjs';
import { createRoomSound } from './room-sound-engine.mjs';
const URL_SHAPE = /^\/assets\/[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{64}\.mp3$/;
export function createRoomMusic({ library = MUSIC_LIBRARY, fetchImpl = (...args) => fetch(...args), selectScene = musicSceneForView,
  enabled, reduced, hidden, getContext, volume, report = () => {}, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, setTick = setInterval, clearTick = clearInterval, createEngine = createRoomSound }) {
  let engine = null, master = null, ctxSeen = null, closed = false, desired = null, intensity = null, timerKey = null, status = 'silent', watchdog = null, ticker = null, generation = 0;
  const attempt = fn => { try { return fn(); } catch { return undefined; } };
  const notify = value => { if (value !== status) { status = value; attempt(() => report(value)); } };
  const level = () => { const value = volume(); return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0; };
  const ready = () => { const ctx = getContext(); return !closed && enabled() && !reduced() && !hidden() && level() > 0 && ctx?.state === 'running' ? ctx : null; };
  async function bytes(response, max) {
    if (!response.ok || Number(response.headers?.get('content-length') || max) !== max) throw Error('music_unavailable');
    const reader = response.body?.getReader();
    if (!reader) { const data = await response.arrayBuffer(); if (data.byteLength !== max) throw Error('music_unavailable'); return data; }
    const chunks = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > max) throw Error('music_unavailable'); chunks.push(part.value); }
      if (size !== max) throw Error('music_unavailable');
      const all = new Uint8Array(size); let at = 0; for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; } return all.buffer;
    } finally { attempt(() => { void reader.cancel().catch(() => {}); }); }
  }
  /** Fetch exactly the recorded bytes of a hashed same-origin asset, then decode; durations must match the manifest. */
  async function load(asset, { signal }) {
    if (typeof asset?.url !== 'string' || !URL_SHAPE.test(asset.url) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 1_048_576) throw Error('music_unavailable');
    const response = await fetchImpl(asset.url, { credentials: 'omit', cache: 'force-cache', signal });
    const data = await bytes(response, asset.bytes);
    if (signal.aborted) throw Error('music_unavailable');
    const decoded = await getContext().decodeAudioData(data);
    if (!decoded || !Number.isFinite(decoded.duration) || Math.abs(decoded.duration - asset.durationS) > .06) throw Error('music_unavailable');
    return decoded;
  }
  function teardown() {
    generation++; desired = null; intensity = null; timerKey = null;
    clearTimer(watchdog); watchdog = null; clearTick(ticker); ticker = null;
    if (engine) attempt(() => engine.close()); engine = null;
    if (master) attempt(() => master.disconnect()); master = null; ctxSeen = null;
  }
  function stop() { teardown(); notify('silent'); }
  function ensureEngine(ctx) {
    if (engine && ctxSeen === ctx) return engine;
    teardown();
    master = ctx.createGain(); master.gain.value = level(); master.connect(ctx.destination); ctxSeen = ctx;
    engine = createEngine({ context: ctx, destination: master, assets: library, load });
    ticker = setTick(() => { if (engine && !closed) attempt(() => engine.tick(now())); }, 250);
    return engine;
  }
  function watch(key) {
    clearTimer(watchdog);
    const ticket = generation;
    watchdog = setTimer(() => { if (ticket === generation && desired === key && engine && !engine.clock().started) { stop(); notify('unavailable'); } }, 10_000);
  }
  return {
    reconcile(view) {
      const ctx = attempt(ready);
      if (!ctx) { if (engine) stop(); return; }
      const scene = selectScene(view);
      if (!scene) { if (engine) { stop(); } return; }
      const sound = ensureEngine(ctx), nowMs = now();
      attempt(() => { master.gain.value = level(); });
      try {
        const nextIntensity = scene.kind === 'decision' ? Math.min(150, Math.max(0, view.music?.intensity ?? 70)) / 100 : 1;
        if (nextIntensity !== intensity) { intensity = nextIntensity; sound.control({ intensity }); }
        const timer = musicTimerForView(view, nowMs), nextTimerKey = JSON.stringify(timer && { ...timer, nowMs: undefined });
        if (nextTimerKey !== timerKey) { timerKey = nextTimerKey; sound.setTimer(timer); }
        // The closing window and a lock release the music; Keep open resumes the same public transport.
        const engineScene = scene.closing ? { kind: 'locked' } : { ...scene, nowMs };
        const key = JSON.stringify(engineScene.kind === 'locked' ? engineScene : { ...engineScene, nowMs: undefined });
        if (key === desired) return;
        desired = key;
        const ticket = generation;
        if (engineScene.kind !== 'locked') watch(key);
        void sound.setScene(engineScene).then(() => {
          if (ticket !== generation || desired !== key) return;
          if (engineScene.kind !== 'locked') { clearTimer(watchdog); notify('playing'); }
        }, () => { if (ticket === generation && desired === key) { stop(); notify('unavailable'); } });
      } catch { stop(); notify('unavailable'); }
    },
    baseline() { stop(); },
    stop,
    close() { closed = true; stop(); },
  };
}
