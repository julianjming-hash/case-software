import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { RoomDO } from '../../src/worker/room-do.mjs';
import { roomFor } from '../../src/worker/directory-do.mjs';
import { withSecurityHeaders } from '../../src/worker/headers.mjs';

import {nativeAccountFetch} from './admin-fixtures.mjs';
const BASE = 'https://case.test';
function headers(response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  expect(response.headers.get('permissions-policy')).toBe('camera=(), screen-wake-lock=(self), window-management=(self)');
  expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
}
it('[AS-072] every Worker route and Durable Object HTTP refusal carries security headers', async () => {
  const actor=uuidv7();
  const jwt = await signTestJwt({ sub: actor, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000)+600 }, 'test-only-secret-not-for-production');
  const created = await nativeAccountFetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify({ caseDocument: fixture }) },[actor]);
  expect(created.status).toBe(201); headers(created);
  const room = await created.json();
  const auth = { authorization: `Bearer ${room.facilitatorToken}` };
  const paths = [
    ['/missing', 'GET', 404], ['/sessions', 'POST', 401], ['/join', 'POST', 400],
    ['/check/ws', 'GET', 426], ['/check/poll?wait=0', 'GET', 200], ['/check/missing', 'GET', 404],
    ['/ops/live-rooms', 'GET', 404], ['/ops/retention-status', 'POST', 404], ['/display-pairs', 'POST', 201], [`/display-pairs/${uuidv7()}`, 'GET', 404],
    ...['snapshot', 'updates?wait=0', 'case-pack'].map(p => [`/sessions/${room.sessionId}/${p}`, 'GET', 200, auth]),
    ...['commands', 'manual-segment', 'display-pairs/approve'].map(p => [`/sessions/${room.sessionId}/${p}`, 'POST', 400, auth]),
    [`/sessions/${room.sessionId}/display-pairs/revoke`, 'POST', 200, auth],
    [`/sessions/${room.sessionId}/facilitator-token`, 'POST', 401], [`/sessions/${room.sessionId}/ws`, 'GET', 426],
    ['/join', 'POST', 413, { 'content-length': '20000' }],
  ];
  for (const [path, method, status, extra = {}] of paths) {
    const response = await SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: extra });
    expect(response.status, path).toBe(status); headers(response);
  }
  for (let n = 0; n < 20; n++) await SELF.fetch(`${BASE}/api/v1/join`, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.244', 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, code: 'ZZZZZZ', displayName: 'Sam', avatarId: 'shadows-01' }) });
  const rate = await SELF.fetch(`${BASE}/api/v1/join`, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.244', 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, code: 'ZZZZZZ', displayName: 'Sam', avatarId: 'shadows-01' }) });
  expect(rate.status).toBe(429); headers(rate); expect(rate.headers.get('retry-after')).toBe('60');
  const stub = env.ROOM.get(env.ROOM.idFromName(uuidv7()));
  for (const [extra, status] of [[{}, 426], [{ upgrade: 'websocket' }, 404]]) {
    const response = await stub.fetch(`${BASE}/ws`, { headers: extra }); expect(response.status).toBe(status); headers(response);
  }
  await runInDurableObject(roomFor(env, room.sessionId), async instance => {
    expect(instance).toBeInstanceOf(RoomDO);
    // Native RoomDO receiver and maintenance path; only socket occupancy is controlled.
    const sockets = vi.spyOn(instance.ctx, 'getWebSockets').mockReturnValue(Array(1000));
    try {
      const full = await instance.fetch(new Request(`${BASE}/ws`, { headers: { upgrade: 'websocket' } }));
      expect(full.status).toBe(503); headers(full); expect(full.headers.get('retry-after')).toBe('5');
      expect(sockets).toHaveBeenCalledTimes(1);
    } finally { sockets.mockRestore(); }
  });
  const directory = await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-codes-Q')).fetch(`${BASE}/`);
  expect(directory.status).toBe(404); headers(directory);
});
it('security header wrapping preserves an actual workerd WebSocket 101 and echo', async () => {
  const response = withSecurityHeaders(await SELF.fetch(`${BASE}/api/v1/check/ws`, { headers: { upgrade: 'websocket' } }), 'json');
  expect(response.status).toBe(101); headers(response);
  const ws = response.webSocket; ws.accept();
  const echoed = new Promise(resolve => ws.addEventListener('message', event => resolve(event.data), { once: true }));
  ws.send('header-check'); expect(await echoed).toBe('header-check'); ws.close(1000);
});
