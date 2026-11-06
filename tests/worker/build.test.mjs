import { SELF, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids.mjs';

const BASE = 'https://case.test';
it('[AS-074] public build provenance is exact and stamped on Worker and DO-originated HTTP responses', async () => {
  const response = await SELF.fetch(`${BASE}/api/v1/version`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ build: 'a'.repeat(40), env: 'local', wire: 1 });
  expect(response.headers.get('x-case-build')).toBe('a'.repeat(40));
  for (const [path, status] of [['/missing', 404], ['/api/v1/sessions', 404], ['/api/v1/check/ws', 426], ['/api/v1/check/poll?wait=0', 200]]) {
    const result = await SELF.fetch(`${BASE}${path}`); expect(result.status).toBe(status); expect(result.headers.get('x-case-build')).toBe('a'.repeat(40));
  }
  const room = env.ROOM.get(env.ROOM.idFromName(uuidv7()));
  const refused = await room.fetch(`${BASE}/ws`); expect(refused.status).toBe(426); expect(refused.headers.get('x-case-build')).toBe('a'.repeat(40));
  const directory = await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-codes-Q')).fetch(`${BASE}/`);
  expect(directory.status).toBe(404); expect(directory.headers.get('x-case-build')).toBe('a'.repeat(40));
  const upgrade = await SELF.fetch(`${BASE}/api/v1/check/ws`, { headers: { upgrade: 'websocket' } });
  expect(upgrade.status).toBe(101); expect(upgrade.headers.get('x-case-build')).toBe('a'.repeat(40));
  upgrade.webSocket.accept(); upgrade.webSocket.close(1000);
});
