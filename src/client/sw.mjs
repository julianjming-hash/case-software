// Shell list: code, styles, public HTML. No case data.
const CACHE_NAME = '__CACHE_NAME__';
const SHELL = /*__SHELL__*/[];
const SHELL_SET = new Set(SHELL);
let acceptedUpdate = false;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'ACTIVATE_UPDATE') return;
  acceptedUpdate = true;
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('case-shell-') && key !== CACHE_NAME) await caches.delete(key);
    if (acceptedUpdate) await self.clients.claim();
  })());
});
function shellKey(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/admin') return '/admin.html';
  if (url.pathname === '/check') return '/check.html';
  if (/^\/(?:join|privacy|help|cases|present|create|sessions|history|account|i\/?)?$/.test(url.pathname) ||
      (/^\/cases\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/v\/[1-9][0-9]*|\/edit(?:\/(?:overview|workflows|preview))?|\/map)?$/.test(url.pathname)||url.pathname==='/create/new') || (/^\/[JjFfDdPp]\//.test(url.pathname)||/^\/sessions\/[^/]+\/(?:facilitate|display|play|recap)$/.test(url.pathname)||/^\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(url.pathname))) return '/index.html';
  return SHELL_SET.has(url.pathname) ? url.pathname : null;
}
async function boundedFetch(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try { return await fetch(request, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const key = shellKey(request);
  if (!key) return; // not the shell
  event.respondWith((async () => {
    let cache;
    try { cache = await caches.open(CACHE_NAME); } catch { /* optional online */ }
    const readCache = async () => { try { return await cache?.match(key); } catch { return undefined; } };
    if (key.startsWith('/assets/')) {
      const cached = await readCache(); if (cached) return cached;
    }
    let response;
    try { response = await boundedFetch(request); }
    catch (error) {
      if (!['TypeError', 'AbortError'].includes(error?.name)) throw error;
      const cached = await readCache();
      return cached ?? new Response('This shell is unavailable offline.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-case-offline': '1' } });
    }
    const path = new URL(request.url).pathname;
    // Entry documents (/join, /J/<code>, /F/<code>) carry their own CSP: always network-first, never cached as the shell.
    const joinEntry = path === '/join' || /^\/[JjFf]\//.test(path);
    if (!joinEntry && response.ok && response.type === 'basic') {
      try { await cache?.put(key, response.clone()); } catch { /* storage failure is not offline */ }
    }
    return response; // a real 4xx/5xx is never replaced by an old success
  })());
});
