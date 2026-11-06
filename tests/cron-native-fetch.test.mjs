import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function nativeHealthWorker(outbound) {
  const result = await build({
    stdin: { contents: `
      import { runWeeklyCheck, runHourlyCatchup } from './src/worker/cron-health.mjs';
      export default { async fetch(request) {
        const { mode } = await request.json();
        const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
        const calls = [], alerts = [], logs = [];
        const rpc = { call: async (name, args) => {
          calls.push({ name, args });
          return { ok: true, data: name === 'heartbeats' ? [
            { job: 'purge_participant_data', ran_at: new Date(nowMs - 1000).toISOString() },
            { job: 'keepalive', ran_at: new Date(nowMs - 6 * 86400000 - 1).toISOString() },
          ] : name === 'ping' ? new Date(nowMs).toISOString() : [] };
        } };
        const run = mode === 'weekly' ? runWeeklyCheck : runHourlyCatchup;
        const result = await run({ rpc, nowMs, healthcheckUrl: 'https://deadman.invalid/check',
          onAlert: async event => { alerts.push(event); }, log: kind => { logs.push(kind); } });
        return Response.json({ result, calls, alerts, logs });
      } };`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  return new Miniflare(convertV4MiniflareOptions({
    script: result.outputFiles[0].text, modules: true, compatibilityDate: '2026-08-22',
    // Native workerd fetch reaches this local-only hook; no request is forwarded to DNS.
    outboundService: request => {
      assert.equal(new URL(request.url).origin, 'https://deadman.invalid');
      assert.equal(request.method, 'GET');
      return outbound(request);
    },
  }));
}

async function run(mf, mode) {
  const response = await mf.dispatchFetch('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
  });
  assert.equal(response.status, 200); // The health runner contains failures instead of throwing.
  return response.json();
}

const assertRpcContract = calls => {
  assert.deepEqual(calls.map(call => call.name), ['heartbeats', 'ping', 'lockdown_alerts_since']);
  assert.deepEqual(calls[2].args, { p_since: '2026-10-02T11:59:59.999Z', p_limit: 1, p_after: null });
};

test('[AS-075] native weekly and due hourly health checks successfully ping the dead-man', async () => {
  const paths = [];
  const mf = await nativeHealthWorker(request => {
    paths.push(new URL(request.url).pathname);
    return new Response('ok');
  });
  try {
    for (const mode of ['weekly', 'hourly']) {
      const result = await run(mf, mode);
      assert.deepEqual(result.result, { ok: true, skipped: false });
      assertRpcContract(result.calls);
      assert.deepEqual(result.alerts, []);
      assert.deepEqual(result.logs, []);
    }
    assert.deepEqual(paths, ['/check', '/check']);
  } finally { await mf.dispose(); }
});

test('native dead-man redirects are refused without following and emit only healthcheck_failed', async () => {
  const paths = [];
  let status = 302;
  const mf = await nativeHealthWorker(request => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return path === '/check'
      ? new Response(null, { status, headers: { location: 'https://deadman.invalid/redirected' } })
      : new Response('ok');
  });
  try {
    for (const mode of ['weekly', 'hourly']) {
      const result = await run(mf, mode);
      assert.deepEqual(result.result, { ok: false, kind: 'healthcheck_failed' });
      assertRpcContract(result.calls);
      assert.deepEqual(result.alerts, [{ kind: 'healthcheck_failed' }]);
      assert.deepEqual(result.logs, ['healthcheck_failed']);
      status = 307;
    }
    assert.deepEqual(paths, ['/check', '/check']);
  } finally { await mf.dispose(); }
});
