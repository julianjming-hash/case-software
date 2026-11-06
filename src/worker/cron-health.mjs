const minute = 60_000;
const day = 24 * 60 * minute;

export const HEALTH_CRONS = Object.freeze({ weekly: '37 3 * * 1', hourly: '17 * * * *' });

export const HEALTH_THRESHOLDS = Object.freeze({
  purgeStaleAfterMs: 30 * minute,
  keepaliveStaleAfterMs: 14 * day,
  catchUpAfterMs: 6 * day,
  serverClockSkewMs: 5 * minute,
  runDeadlineMs: 10_000,
  rpcTimeoutMs: 2_500,
  alertPageLimit: 1,
});

export class HealthDataError extends Error {
  constructor() { super('Invalid heartbeat data'); this.name = 'HealthDataError'; }
}

const validClock = value => Number.isFinite(value) && value >= 0;

export function shouldCatchUp(lastSuccessMs, nowMs) {
  if (!validClock(nowMs) || (lastSuccessMs !== null && !validClock(lastSuccessMs))) throw new HealthDataError();
  return lastSuccessMs === null || nowMs - lastSuccessMs > HEALTH_THRESHOLDS.catchUpAfterMs;
}

export function alertSince(lastSuccessMs) {
  if (lastSuccessMs !== null && !validClock(lastSuccessMs)) throw new HealthDataError();
  return new Date(lastSuccessMs ?? 0).toISOString();
}

export function evaluateHeartbeats(rows, nowMs) {
  if (!Array.isArray(rows) || !validClock(nowMs)) throw new HealthDataError();
  const known = new Map();
  for (const row of rows) {
    if (!row || typeof row.job !== 'string' || typeof row.ran_at !== 'string') throw new HealthDataError();
    if (row.job !== 'purge_participant_data' && row.job !== 'keepalive') continue;
    const atMs = Date.parse(row.ran_at);
    if (!validClock(atMs) || atMs - nowMs > HEALTH_THRESHOLDS.serverClockSkewMs || known.has(row.job)) throw new HealthDataError();
    known.set(row.job, atMs);
  }
  const alerts = [];
  for (const [job, threshold] of [
    ['purge_participant_data', HEALTH_THRESHOLDS.purgeStaleAfterMs],
    ['keepalive', HEALTH_THRESHOLDS.keepaliveStaleAfterMs],
  ]) {
    const atMs = known.get(job);
    const ageMs = atMs === undefined ? null : Math.max(0, nowMs - atMs);
    if (ageMs === null || ageMs > threshold) alerts.push(Object.freeze({ job, ageS: ageMs === null ? null : Math.floor(ageMs / 1000) }));
  }
  return Object.freeze({ lastSuccessMs: known.get('keepalive') ?? null, alerts });
}

class HealthRunError extends Error {
  constructor(kind) { super(kind); this.name = 'HealthRunError'; this.kind = kind; }
}

const safeKind = error => error instanceof HealthRunError ? error.kind : 'unavailable';

async function runHealth(mode, {
  rpc, nowMs = Date.now(), healthcheckUrl, fetchImpl = fetch,
  onAlert = async () => {}, log = () => {}, deadlineMs = HEALTH_THRESHOLDS.runDeadlineMs,
} = {}) {
  const controller = new AbortController();
  const limitMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? Math.min(deadlineMs, HEALTH_THRESHOLDS.runDeadlineMs) : HEALTH_THRESHOLDS.runDeadlineMs;
  const reserveMs = Math.max(1, Math.min(1_000, Math.floor(limitMs / 4)));
  let workTimer, totalTimer, phase = 'start';
  const workExpired = new Promise((_, reject) => {
    workTimer = setTimeout(() => { controller.abort(); reject(new HealthRunError('timeout')); }, limitMs - reserveMs);
  });
  const totalExpired = new Promise((_, reject) => {
    totalTimer = setTimeout(() => reject(new HealthRunError('timeout')), limitMs);
  });
  const bounded = task => Promise.race([Promise.resolve().then(task), workExpired]);
  const emit = async event => {
    phase = 'hook';
    try { await bounded(() => onAlert(Object.freeze(event))); }
    catch (error) { throw error instanceof HealthRunError && error.kind === 'timeout' ? error : new HealthRunError('alert_hook_failed'); }
  };
  const call = async (name, args = {}) => {
    phase = 'rpc';
    let result;
    try { result = await bounded(() => rpc.call(name, args)); }
    catch (error) {
      if (error instanceof HealthRunError && error.kind === 'timeout') throw error;
      throw new HealthRunError('supabase_unreachable');
    }
    if (!result?.ok) throw new HealthRunError('supabase_unreachable');
    return result.data;
  };
  try {
    if (!rpc || typeof rpc.call !== 'function' || typeof fetchImpl !== 'function' || typeof onAlert !== 'function' || typeof log !== 'function') throw new HealthRunError('config');
    const heartbeatRows = await call('heartbeats');
    const observed = evaluateHeartbeats(heartbeatRows, nowMs);
    if (mode === 'hourly' && !shouldCatchUp(observed.lastSuccessMs, nowMs)) return { ok: true, skipped: true };
    let url;
    try { url = new URL(healthcheckUrl); } catch { throw new HealthRunError('config'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new HealthRunError('config');
    const pingAt = await call('ping');
    const pingMs = typeof pingAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(pingAt)
      ? Date.parse(pingAt) : NaN;
    if (!validClock(pingMs) || Math.abs(pingMs - nowMs) > HEALTH_THRESHOLDS.serverClockSkewMs) throw new HealthRunError('invalid_ping_data');
    const state = evaluateHeartbeats(heartbeatRows, pingMs);
    const alerts = await call('lockdown_alerts_since', {
      p_since: alertSince(state.lastSuccessMs), p_limit: HEALTH_THRESHOLDS.alertPageLimit, p_after: null,
    });
    if (!Array.isArray(alerts) || alerts.length > HEALTH_THRESHOLDS.alertPageLimit) throw new HealthRunError('invalid_alert_data');
    for (const event of state.alerts) await emit(event);
    if (alerts.length) await emit({ kind: 'lockdown_alert' });
    phase = 'deadman';
    let response;
    try {
      response = await bounded(() => fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal }));
      if (!response?.ok || typeof response.text !== 'function') throw new HealthRunError('healthcheck_failed');
      await bounded(() => response.text());
    } catch (error) {
      if (error instanceof HealthRunError) throw error;
      throw new HealthRunError('healthcheck_failed');
    }
    return { ok: true, skipped: false };
  } catch (error) {
    const kind = error instanceof HealthDataError ? 'invalid_heartbeat' : safeKind(error);
    const eventKind = kind === 'timeout' && phase === 'rpc' ? 'supabase_unreachable'
      : kind === 'timeout' && phase === 'deadman' ? 'healthcheck_failed' : kind;
    if (phase !== 'hook' && kind !== 'alert_hook_failed') {
      try { await Promise.race([Promise.resolve().then(() => onAlert(Object.freeze({ kind: eventKind }))), totalExpired]); }
      catch { /* the dead-man stays silent */ }
    }
    try { log(kind); } catch { /* logging cannot escape scheduled */ }
    return { ok: false, kind };
  } finally {
    clearTimeout(workTimer);
    clearTimeout(totalTimer);
    controller.abort();
  }
}

export const runHourlyCatchup = options => runHealth('hourly', options);
export const runWeeklyCheck = options => runHealth('weekly', options);
