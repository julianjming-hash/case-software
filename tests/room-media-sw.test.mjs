// Card 59 M3 (red-team S9): the service worker never answers, caches or replays an image route, room or Builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { roomMediaPath, builderAssetRenditionPath } from '../src/shared/urls.mjs';

test('[AS-168] media routes bypass the service worker: no respondWith, nothing written to the shell cache', async () => {
  const handlers = {}, puts = [];
  const self = { location: new URL('http://case.test/sw.mjs'), addEventListener: (type, handler) => { handlers[type] = handler; } };
  const code = readFileSync(new URL('../src/client/sw.mjs', import.meta.url), 'utf8').replace('/*__SHELL__*/[]', JSON.stringify(['/index.html']));
  runInNewContext(code, { self, caches: { open: async () => ({ match: async () => undefined, put: async key => puts.push(key) }) }, URL, Request, Response, Set, Promise,
    AbortController, setTimeout, clearTimeout, fetch: async () => new Response('x', { headers: { 'content-type': 'image/jpeg' } }) });
  const id = '01a13f1d-eefc-72fe-88e7-4e8e09cae2e6', other = '01a13f1d-eefc-72fe-88e7-4e8e09cae2e7';
  for (const path of [roomMediaPath(id, other, 'display'), roomMediaPath(id, other, 'phone'), builderAssetRenditionPath(id, other, 'display')]) {
    let answered = false;
    handlers.fetch({ request: new Request(`http://case.test${path}`), respondWith: () => { answered = true; } });
    assert.equal(answered, false, path);
  }
  assert.deepEqual(puts, []);
});
