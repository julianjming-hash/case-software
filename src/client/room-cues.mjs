// Gesture-gated, on-demand room effects and console tones. User/master volume and semantic event
// gain share one path for samples and fallback. Active nodes and pending callbacks cancel together.
export function createCuePlayer({ urls = {}, fetchImpl = (...a) => fetch(...a), enabled, reduced, hidden,
  getContext, map, fallback, volume = () => 1, eventGain = {} }) {
  const buffers = new Map(), active = new Set();
  let generation = {};
  const level = kind => Math.max(0, Math.min(1, Number(volume()) || 0)) * (eventGain[kind] ?? 1);
  const ready = kind => { const ctx = getContext(); return enabled() && level(kind) > 0 && !reduced() && !hidden() && ctx?.state === 'running' && ctx; };
  const attempt = fn => { try { fn(); } catch { /* Interrupted audio still cleans up. */ } };
  return {
    cancel() { generation = {}; for (const stop of active) stop(); active.clear(); },
    async play(kind) {
      const started = generation, cue = map[kind];
      let ctx;
      try { ctx = Object.hasOwn(map, kind) && ready(kind); } catch { return null; }
      if (!ctx) return null;
      let pending = buffers.get(cue);
      if (!pending) {
        pending = (async () => {
          const response = urls[cue] && await fetchImpl(urls[cue], { credentials: 'omit' });
          if (!response?.ok || Number(response.headers?.get('content-length') || 0) > 60_000) throw new Error();
          const bytes = await response.arrayBuffer(); if (bytes.byteLength > 60_000) throw new Error();
          return ctx.decodeAudioData(bytes);
        })();
        pending.catch(() => buffers.delete(cue)); buffers.set(cue, pending);
      }
      const buffer = await pending.catch(() => null);
      try {
        if (started !== generation || !(ctx = ready(kind))) return null;
        if (!buffer) {
          if (!fallback) return null;
          let stop; stop = fallback(ctx, kind, level(kind), () => active.delete(stop));
          if (typeof stop === 'function') active.add(stop);
          return 'tone';
        }
        let source, gain, finished = false;
        const finish = () => { if (finished) return; finished = true; if (source) source.onended = null; attempt(() => source?.disconnect()); attempt(() => gain?.disconnect()); active.delete(stop); };
        const stop = () => { attempt(() => source?.stop()); finish(); };
        try {
          source = ctx.createBufferSource(); gain = ctx.createGain(); source.buffer = buffer;
          gain.gain.value = level(kind); source.connect(gain); gain.connect(ctx.destination);
          source.onended = finish; active.add(stop); source.start(); return 'sample';
        } catch { stop(); return null; }
      } catch { return null; }
    },
  };
}
