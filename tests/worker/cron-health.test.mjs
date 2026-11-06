import { newCapabilityToken } from '../../src/shared/ids.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.mjs';

afterEach(() => vi.unstubAllGlobals());

it('[AS-075] mounts both scheduled crons and reaches only fake PostgREST and dead-man hosts', async () => {
  const calls = [];
  vi.stubGlobal('fetch', async (url, options) => {
    const target = new URL(url);
    calls.push({ host: target.host, path: target.pathname, method: options?.method });
    if (target.host === 'deadman.invalid') return new Response('ok');
    if (target.host !== 'postgrest.invalid') throw Error('unexpected host');
    if (target.pathname.endsWith('/heartbeats')) return Response.json([
      { job: 'purge_participant_data', ran_at: new Date(Date.now() - 60_000).toISOString(), rows: 0 },
      { job: 'keepalive', ran_at: new Date(Date.now() - 86_400_000).toISOString(), rows: 0 },
    ]);
    if (target.pathname.endsWith('/ping')) return Response.json(new Date().toISOString());
    if (target.pathname.endsWith('/lockdown_alerts_since')) return Response.json([]);
    throw Error('unexpected RPC');
  });
  const env = {
    SUPABASE_URL: 'https://postgrest.invalid/', SUPABASE_SECRET_KEY: `sb_secret_${newCapabilityToken()}`,
    HEALTHCHECK_PING_URL: 'https://deadman.invalid/opaque-check-id',
  };
  await worker.scheduled({ cron: '37 3 * * 1' }, env, { waitUntil: () => {} });
  expect(calls.map(call => call.path)).toEqual([
    '/rest/v1/rpc/heartbeats', '/rest/v1/rpc/ping', '/rest/v1/rpc/lockdown_alerts_since', '/opaque-check-id',
  ]);
  expect(new Set(calls.map(call => call.host))).toEqual(new Set(['postgrest.invalid', 'deadman.invalid']));
  calls.length = 0;
  await worker.scheduled({ cron: '17 * * * *' }, env, { waitUntil: () => {} });
  expect(calls.map(call => call.path)).toEqual(['/rest/v1/rpc/heartbeats']);
});

it('the mounted RPC client times out a hung PostgREST call before the run budget', async () => {
  vi.stubGlobal('fetch', async () => new Promise(() => {}));
  const env = {
    SUPABASE_URL: 'https://postgrest.invalid/', SUPABASE_SECRET_KEY: `sb_secret_${newCapabilityToken()}`,
    HEALTHCHECK_PING_URL: 'https://deadman.invalid/opaque-check-id',
  };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const start = Date.now();
    await worker.scheduled({ cron: '37 3 * * 1' }, env, { waitUntil: () => {} });
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'cron_health', reason: 'supabase_unreachable' }));
  } finally { log.mockRestore(); }
}, 7_000);
