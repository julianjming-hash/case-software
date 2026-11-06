// prototypes/room/shell-sw.mjs: the offline app shell for the room windows (spec red team 2, P1-2;
// AS-061). A classic service worker script (no import or export), registered by lib/device.mjs for
// real rooms only.
//
// What it caches: the SHELL below and nothing else, the code and styles every room window needs to
// start. What it never caches: anything under /api/ (snapshots, receipts, the case pack, joins), the
// case fixtures, the lab page, or any response that is not a shell file. Case data only ever lives in
// memory (facilitator, CASE-092) or arrives as the role's projection; a cached copy on a shared
// hospital PC would outlive the room.
//
// Strategy: network first, so a deploy is picked up at once; the cached shell only when the network
// fails or is slower than NETWORK_TIMEOUT_MS. That is what makes a reload during a total outage still
// open the console, which then explains what it can and cannot do offline.
const VERSION = 'case-shell-v6';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  './facilitator.html', './display.html', './phone.html', './pair-display.html', './check.html', './privacy.html',
  './lib/link.mjs', './lib/bus.mjs', './lib/local-authority.mjs', './lib/marks.mjs', './lib/qr.mjs',
  './lib/device.mjs', './lib/tokens.css', './lib/avatar.mjs', './lib/dom.mjs', './lib/avatar-picker.mjs', './lib/join-code.mjs',
  // Self-hosted fonts and the vendored avatars (CASE-112, CASE-120): a reload offline still draws them.
  './lib/fonts/montserrat-latin.woff2', './lib/fonts/montserrat-latin-ext.woff2', './lib/fonts/jetbrains-mono-latin.woff2',
  ...Array.from({ length: 16 }, (_, i) => `./lib/avatars/shadows-${String(i + 1).padStart(2, '0')}.svg`),
  ...Array.from({ length: 16 }, (_, i) => ['wine', 'brown', 'olive', 'green', 'teal', 'blue', 'purple', 'charcoal'].map((color) => `./lib/avatars/shadows-${String(i + 1).padStart(2, '0')}-${color}.svg`)).flat(),
  '../../src/client/transport.mjs', '../../src/client/telemetry.mjs', '../../src/client/api-origin.mjs',
  '../../src/client/storage-policy.mjs', '../../src/client/vote-policy.mjs', '../../src/client/vote-store.mjs',
  '../../src/client/idb.mjs', '../../src/client/storage-barrier.mjs', '../../src/client/storage-generation.mjs',
  '../../src/client/presentation-nav.mjs', '../../src/client/keymap.mjs',
  '../../src/client/console-ranking.mjs', '../../src/client/lobby-arrivals.mjs', '../../src/client/response-summary.mjs', '../../src/client/projector-result.mjs', '../../src/client/projector-marks.mjs',
  '../../src/client/phone-ranking.mjs', '../../src/client/phone-dom.mjs', '../../src/client/authored-text.mjs', '../../src/client/formatted-text.mjs',
  '../../src/shared/participant.mjs',
  '../../src/shared/ids.mjs', '../../src/shared/wire.mjs', '../../src/shared/vote-envelope.mjs', '../../src/shared/urls.mjs',
  '../../src/shared/room-corrections.mjs', '../../src/shared/room-interpretation.mjs',
  '../../src/shared/room-machine.mjs', '../../src/shared/debrief-pages.mjs', '../../src/shared/ranked-groups.mjs', '../../src/shared/ranked-presentation.mjs', '../../src/shared/ranked-page-view.mjs', '../../src/shared/case-document.mjs', '../../src/shared/builder-format.mjs', '../../src/shared/presentation-groups.mjs', '../../src/shared/presentation-order.mjs', '../../src/shared/slide-hero.mjs', '../../src/shared/slide-themes.mjs',
  '../../src/shared/content-limits.mjs',
  '../../src/shared/identifiers.mjs', '../../src/shared/timer.mjs', '../../src/shared/music-timeline.mjs', '../../src/shared/music-catalogue.mjs', '../../src/shared/text-pages.mjs', '../../src/shared/text.mjs', '../../src/shared/art-descriptor.mjs', '../../src/shared/tints.mjs',
  '../../src/shared/decision-branches.mjs', '../../src/shared/slide-gas-view.mjs',
].map((p) => new URL(p, self.location).href);
const SHELL_SET = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'no-store' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('case-shell-') && key !== VERSION) await caches.delete(key);
  })());
});

/** The shell entry for a request, ignoring the query string (`facilitator.html?api=…&session=…`). */
function shellKey(request) {
  const u = new URL(request.url);
  if (u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return null;
  u.search = '';
  u.hash = '';
  return SHELL_SET.has(u.href) ? u.href : null;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const key = shellKey(request);
  if (!key) return; // not ours: /api/, case data, the lab, anything else goes straight to the network
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const response = await Promise.race([
        fetch(request, { cache: 'no-store' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), NETWORK_TIMEOUT_MS)),
      ]);
      if (response.ok && response.type === 'basic') await cache.put(key, response.clone());
      return response;
    } catch {
      const cached = await cache.match(key);
      return cached ?? new Response('Offline, and this page is not available offline.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});
