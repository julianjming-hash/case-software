// GET /api/v1/health (2026-10-17 reliability audit): a public probe for an external uptime monitor.
// One bounded read-only RPC and the sign-in keys. Fixed answers only: no build, timing, rows or upstream detail.
// `heartbeats` only reads; `ping` would refresh the keepalive and hide a dead weekly cron (cron-health.mjs).
export const HEALTH_RPC_TIMEOUT_MS = 2_500;

const answer = (status, body, headers = {}) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

export async function handleHealth({ limited, rpc, keysReady }) {
  if (await limited()) return answer(429, { ok: false, reason: 'rate_limited' }, { 'retry-after': '60' });
  const database = (async () => {
    try { const result = await rpc().call('heartbeats'); return result?.ok === true && Array.isArray(result.data); }
    catch { return false; }
  })();
  const [db, keys] = await Promise.all([database, keysReady()]);
  if (!db) return answer(503, { ok: false, reason: 'database' });
  if (!keys) return answer(503, { ok: false, reason: 'auth_keys' });
  return answer(200, { ok: true });
}
