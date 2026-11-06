import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
function worker() {
  const events = {}; const stored = new Map(); const names = new Set(['case-shell-wire0-old', 'unrelated-cache']); let skips = 0; let claims = 0; let requests = 0;
  const cache = { async addAll(list) { for (const key of list) stored.set(typeof key === 'string' ? key : key.url, new Response('shell')); }, async put(key, value) { stored.set(key, value); }, async match(key) { return stored.get(key)?.clone(); } };
  const self = { location: new URL('http://case.test/sw.mjs'), addEventListener(type, fn) { events[type] = fn; }, async skipWaiting() { skips++; }, clients: { async claim() { claims++; } } };
  const caches = { async open(name) { names.add(name); return cache; }, async keys() { return [...names]; }, async delete(name) { return names.delete(name); } };
  let fetchImpl = async () => { requests++; return new Response('fresh', { headers: { 'content-type': 'text/html' } }); };
  const code = readFileSync(new URL('../src/client/sw.mjs', import.meta.url), 'utf8').replace('__CACHE_NAME__', 'case-shell-wire1-new').replace('/*__SHELL__*/[]', JSON.stringify(['/index.html', '/check.html', '/assets/code.123.mjs', '/manifest.webmanifest']));
  runInNewContext(code, { self, caches, URL, Request, Response, Set, Promise, AbortController, setTimeout, clearTimeout, fetch: (...args) => fetchImpl(...args) });
  const lifecycle = async (type, data) => { let wait; events[type]({ data, waitUntil(value) { wait = value; } }); await wait; };
  const request = async (path, method = 'GET') => { let response; events.fetch({ request: new Request(`http://case.test${path}`, { method }), respondWith(value) { response = value; } }); return response === undefined ? undefined : await response; };
  return { stored, names, lifecycle, request, cache, caches, setFetch(fn) { fetchImpl = fn; }, get skips() { return skips; }, get claims() { return claims; }, get requests() { return requests; } };
}
test('service worker precaches shell only and never intercepts API, case data or mutations', async () => {
  const w = worker(); await w.lifecycle('install');
  for (const path of ['/api/v1/version', '/api/v1/workspaces/0199a000-0000-7000-8000-000000000001/versions/0199a000-0000-7000-8000-000000000002/pack', '/api/v1/sessions/room/case-pack', '/cases/patient.json', '/fixtures/case.json']) for (const method of ['GET', 'POST', 'HEAD']) assert.equal(await w.request(path, method), undefined);
  assert.ok([...w.stored.keys()].every(key => !/api|cases|fixtures/.test(key)));
  // CASE-356: exact editor/version bookmarks recover the shell; JSON and arbitrary descendants never do.
  for (const path of ['/cases/0199a000-0000-7000-8000-000000000001/v/2.json', '/cases/0199a000-0000-7000-8000-000000000001/edit/patient.json']) assert.equal(await w.request(path, 'GET'), undefined);
  for(const path of ['/present','/create','/create/new','/sessions','/cases/0199a000-0000-7000-8000-000000000001/edit','/cases/0199a000-0000-7000-8000-000000000001/v/2'])assert.equal((await w.request(path)).status,200);
  assert.equal(w.skips, 0);
});
test('activation purges old wire/build caches and claims clients only after explicit update acceptance', async () => {
  const w = worker(); await w.lifecycle('install'); await w.lifecycle('activate');
  assert.ok(!w.names.has('case-shell-wire0-old')); assert.ok(w.names.has('unrelated-cache')); assert.equal(w.claims, 0);
  await w.lifecycle('message', { type: 'ACTIVATE_UPDATE' }); assert.equal(w.skips, 1);
  await w.lifecycle('activate'); assert.equal(w.claims, 1);
});
test('HTML is network-first, immutable assets are cache-first, real 5xx is never synthetic offline', async () => {
  const w = worker(); await w.lifecycle('install');
  assert.equal(await (await w.request('/sessions/room/facilitate')).text(), 'fresh');
  const before = w.requests; assert.equal(await (await w.request('/assets/code.123.mjs')).text(), 'shell'); assert.equal(w.requests, before);
  w.cache.put = async () => { throw new Error('storage unavailable'); };
  w.setFetch(async () => { const response = new Response('online despite storage failure'); Object.defineProperty(response, 'type', { value: 'basic' }); return response; });
  assert.equal(await (await w.request('/check')).text(), 'online despite storage failure');
  w.setFetch(async () => new Response('server failure', { status: 503 }));
  const error = await w.request('/check'); assert.equal(error.status, 503); assert.equal(error.headers.get('x-case-offline'), null);
  w.setFetch(async () => { throw new TypeError('network'); }); assert.equal((await w.request('/check')).status, 200);
  w.stored.clear(); const offline = await w.request('/check'); assert.equal(offline.status, 503); assert.equal(offline.headers.get('x-case-offline'), '1');
});

for (const failure of ['open', 'match']) test(`optional shell cache ${failure} failure preserves a fresh online response`, async () => {
    const w = worker(); await w.lifecycle('install');
    (failure === 'open' ? w.caches : w.cache)[failure] = async () => { throw new Error('storage unavailable'); };
    assert.equal(await (await w.request('/assets/code.123.mjs')).text(), 'fresh', failure);
});
test('unexpected fetch exceptions surface without synthetic offline classification', async () => {
  const w = worker(); await w.lifecycle('install');
  w.setFetch(async () => { throw new Error('unexpected_failure'); });
  await assert.rejects(w.request('/check'), /unexpected_failure/);
});

test('participant join and privacy routes recover only the public shell offline while API recovery is excluded', async () => {
  const w = worker(); await w.lifecycle('install');
  w.setFetch(async () => { throw new TypeError('network'); });
  for (const path of ['/join', '/privacy', '/help', '/J/ABCDEF', '/F/ABCDEF']) assert.equal(await (await w.request(path)).text(), 'shell', path);
  for (const path of ['/api/v1/join/recover', '/privacy/personal.json', '/join/private']) assert.equal(await w.request(path), undefined, path);
  assert.deepEqual([...w.stored.keys()].sort(), ['/assets/code.123.mjs', '/check.html', '/index.html', '/manifest.webmanifest'].sort());
});


test('join-entry network HTML never replaces the strict shared shell used by offline playback or recap', async()=>{
 const w=worker();await w.lifecycle('install');
 const strict=new Response('strict shell',{headers:{'content-security-policy':"script-src 'self'; trusted-types case-default"}});w.stored.set('/index.html',strict);
 // CASE-284: the participant feedback page is an entry document too: network-first, never cached as the shell.
 for(const path of ['/join','/J/ABCDEF','/j/abcdef','/F/ABCDEF','/f/abcdef']){
  w.setFetch(async()=>{const response=new Response('join document',{headers:{'content-security-policy':"script-src 'self' https://challenges.cloudflare.com; trusted-types case-default case-turnstile"}});Object.defineProperty(response,'type',{value:'basic'});return response;});
  assert.equal(await (await w.request(path)).text(),'join document');
  assert.equal(await w.stored.get('/index.html').clone().text(),'strict shell');
 }
 w.setFetch(async()=>{throw new TypeError('network');});
 for(const path of ['/sessions/room/play','/sessions/room/recap']){const response=await w.request(path);assert.equal(await response.text(),'strict shell');assert.equal(response.headers.get('content-security-policy'),"script-src 'self'; trusted-types case-default");}
});
