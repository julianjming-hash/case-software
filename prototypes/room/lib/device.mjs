// prototypes/room/lib/device.mjs: what the room windows need from the device they run on (spec red
// team 2, P1-2, P1-3 and P1-6). Hospital PCs dim their screens, block pop-ups, run in Windows
// "Duplicate" mode and lose the network; each helper here degrades quietly when the browser lacks
// the feature, and never needs a token or personal data.
//
//   registerShell()              the offline app shell (shell-sw.mjs): real rooms only, never the lab
//   keepScreenAwake()            Screen Wake Lock, re-acquired when the tab is visible again
//   singleScreen()               true when the browser reports exactly one screen (screen.isExtended === false)
//   announceProjector(channel)   the projector window says it is open, over BroadcastChannel
//   watchProjector(channel, fn)  the console hears it (window.open with noopener returns no handle)

/** Register the shell service worker for a real room. Lab pages (no `?api=`) never register one. */
export function registerShell({ real }) {
  if (!real) return;
  try {
    if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) return;
    // No clients.claim(): the page that registers stays uncontrolled; the NEXT load (a reload during an
    // outage, say) is served from the shell cache. The worker never caches /api/ or case data.
    navigator.serviceWorker.register(new URL('../shell-sw.mjs', import.meta.url), { scope: new URL('../', import.meta.url).pathname }).catch(() => { /* blocked by policy: online only */ });
  } catch { /* unsupported */ }
}

/**
 * Keep the screen on while this window is visible (console and projector). The request is refused on
 * battery saver or by policy; that is tolerated. The browser drops the lock whenever the tab is hidden,
 * so it is taken again on `visibilitychange`.
 */
export function keepScreenAwake() {
  let lock = null;
  let asking = false;
  const take = async () => {
    if (lock || asking || document.visibilityState !== 'visible' || !navigator.wakeLock?.request) return;
    asking = true;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener?.('release', () => { lock = null; });
    } catch { lock = null; /* refused: the screensaver note in the pre-session checklist covers it */ } finally { asking = false; }
  };
  document.addEventListener('visibilitychange', take);
  take();
  return { get held() { return Boolean(lock); } };
}

/** True when the browser says this PC shows one screen (or mirrors it): Windows "Duplicate" mode, or no projector yet. */
export function singleScreen() {
  try { return globalThis.screen?.isExtended === false; } catch { return false; }
}

/** The projector window announces itself now and every few seconds, so the console knows it is open. */
export function announceProjector(channel, everyMs = 4000) {
  const say = () => { try { channel.postMessage({ t: 'projector_hello' }); } catch { /* closed */ } };
  say();
  return setInterval(say, everyMs);
}

/** The console hears the projector. `fn(atMs)` on each hello. */
export function watchProjector(channel, fn) {
  channel.addEventListener('message', ({ data }) => { if (data?.t === 'projector_hello') fn(Date.now()); });
}
