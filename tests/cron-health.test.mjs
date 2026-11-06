import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEALTH_THRESHOLDS, evaluateHeartbeats, shouldCatchUp, alertSince, runHourlyCatchup, runWeeklyCheck } from '../src/worker/cron-health.mjs';

const day = 86_400_000;
const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
const heartbeat = (job, ageMs) => ({ job, ran_at: new Date(nowMs - ageMs).toISOString(), rows: 0 });

test('hourly catch-up starts only after six days since the last successful ping', () => {
  assert.equal(HEALTH_THRESHOLDS.catchUpAfterMs, 6 * day);
  assert.equal(shouldCatchUp(nowMs - 6 * day, nowMs), false);
  assert.equal(shouldCatchUp(nowMs - 6 * day - 1, nowMs), true);
  assert.equal(shouldCatchUp(null, nowMs), true);
});

test('healthy purge and keepalive heartbeats produce no alert', () => {
  const result = evaluateHeartbeats([heartbeat('purge_participant_data', 10 * 60_000), heartbeat('keepalive', day)], nowMs);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.lastSuccessMs, nowMs - day);
  assert.equal(alertSince(result.lastSuccessMs), new Date(nowMs - day).toISOString());
});

test('[AS-075] a two-hour-old purge heartbeat alerts once with safe job and age only', () => {
  const result = evaluateHeartbeats([heartbeat('purge_participant_data', 2 * 60 * 60_000), heartbeat('keepalive', day)], nowMs);
  assert.deepEqual(result.alerts, [{ job: 'purge_participant_data', ageS: 7200 }]);
});

test('keepalive has a two-week staleness threshold and missing rows are explicit', () => {
  assert.equal(HEALTH_THRESHOLDS.keepaliveStaleAfterMs, 14 * day);
  const stale = evaluateHeartbeats([heartbeat('purge_participant_data', 1_000), heartbeat('keepalive', 14 * day + 1)], nowMs);
  assert.deepEqual(stale.alerts, [{ job: 'keepalive', ageS: 14 * 24 * 3600 }]);
  const missing = evaluateHeartbeats([], nowMs);
  assert.deepEqual(missing.alerts, [{ job: 'purge_participant_data', ageS: null }, { job: 'keepalive', ageS: null }]);
  assert.equal(alertSince(missing.lastSuccessMs), '1970-01-01T00:00:00.000Z');
});

test('malformed heartbeat rows fail closed without echoing row contents', () => {
  assert.throws(() => evaluateHeartbeats([{ job: 'keepalive', ran_at: 'patient data' }], nowMs), { name: 'HealthDataError', message: 'Invalid heartbeat data' });
});

test('bounded DB clock skew is accepted; gross future timestamps still fail closed', () => {
  const slight = evaluateHeartbeats([heartbeat('purge_participant_data', -60_000), heartbeat('keepalive', 1_000)], nowMs);
  assert.deepEqual(slight.alerts, []);
  assert.throws(() => evaluateHeartbeats([heartbeat('purge_participant_data', -6 * 60_000)], nowMs), { name: 'HealthDataError' });
});

const healthUrl = 'https://health.invalid/opaque-check-id';
const fakeRun = (overrides = {}) => {
  const calls = [], alerts = [], fetches = [], logs = [];
  const data = [heartbeat('purge_participant_data', 1_000), heartbeat('keepalive', 6 * day + 1)];
  const rpc = { call: async (name, args) => {
    calls.push({ name, args });
    return { ok: true, data: name === 'heartbeats' ? data : name === 'lockdown_alerts_since' ? [] : new Date(nowMs).toISOString() };
  } };
  const input = {
    rpc, nowMs, healthcheckUrl: healthUrl,
    fetchImpl: async (url, options) => { fetches.push({ url, options }); return new Response('ok'); },
    onAlert: async event => { alerts.push(event); }, log: kind => { logs.push(kind); },
    ...overrides,
  };
  return { input, calls, alerts, fetches, logs };
};

test('hourly cron reads heartbeats and does nothing while the last ping is recent', async () => {
  const run = fakeRun();
  run.input.rpc.call = async (name, args) => { run.calls.push({ name, args }); return { ok: true, data: [heartbeat('purge_participant_data', 1_000), heartbeat('keepalive', day)] }; };
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: true, skipped: true });
  assert.deepEqual(run.calls.map(call => call.name), ['heartbeats']);
  assert.deepEqual(run.fetches, []);
  assert.deepEqual(run.alerts, []);
});

test('hourly no-op needs only the heartbeat read, even before a dead-man URL is configured', async () => {
  const run = fakeRun({ healthcheckUrl: undefined });
  run.input.rpc.call = async name => {
    run.calls.push(name);
    return { ok: true, data: [heartbeat('purge_participant_data', 1_000), heartbeat('keepalive', day)] };
  };
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: true, skipped: true });
  assert.deepEqual(run.calls, ['heartbeats']);
  assert.deepEqual(run.fetches, []);
});

test('due hourly cron calls heartbeats, ping and one bounded alert page, then dead-man', async () => {
  const run = fakeRun();
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: true, skipped: false });
  assert.deepEqual(run.calls.map(call => call.name), ['heartbeats', 'ping', 'lockdown_alerts_since']);
  assert.deepEqual(run.calls[2].args, { p_since: new Date(nowMs - 6 * day - 1).toISOString(), p_limit: 1, p_after: null });
  assert.equal(run.fetches.length, 1);
  assert.equal(run.fetches[0].url, healthUrl);
  assert.equal(run.fetches[0].options.redirect, 'manual');
  assert.deepEqual(run.alerts, []);
});

test('weekly cron reads previous keepalive before ping and uses it as the alert cursor', async () => {
  const run = fakeRun();
  run.input.rpc.call = async (name, args) => {
    run.calls.push({ name, args });
    return { ok: true, data: name === 'heartbeats'
      ? [heartbeat('purge_participant_data', 1_000), heartbeat('keepalive', day)]
      : name === 'ping' ? new Date(nowMs).toISOString() : [] };
  };
  assert.deepEqual(await runWeeklyCheck(run.input), { ok: true, skipped: false });
  assert.deepEqual(run.calls.map(call => call.name), ['heartbeats', 'ping', 'lockdown_alerts_since']);
  assert.equal(run.calls.length, 3);
  assert.equal(run.calls[2].args.p_since, new Date(nowMs - day).toISOString());
  assert.equal(run.fetches.length, 1);
});

test('[AS-075] weekly stale keepalive raises an age-only alert', async () => {
  const run = fakeRun();
  run.input.rpc.call = async name => ({ ok: true, data: name === 'heartbeats'
    ? [heartbeat('purge_participant_data', 1_000), heartbeat('keepalive', 14 * day + 1)]
    : name === 'ping' ? new Date(nowMs).toISOString() : [] });
  assert.equal((await runWeeklyCheck(run.input)).ok, true);
  assert.deepEqual(run.alerts, [{ job: 'keepalive', ageS: 14 * 24 * 3600 }]);
});

test('reported staleness uses the ping server clock after the prior cursor is captured', async () => {
  const run = fakeRun();
  run.input.rpc.call = async (name, args) => {
    run.calls.push({ name, args });
    return { ok: true, data: name === 'heartbeats'
      ? [heartbeat('purge_participant_data', 29 * 60_000), heartbeat('keepalive', day)]
      : name === 'ping' ? new Date(nowMs + 2 * 60_000).toISOString() : [] };
  };
  assert.equal((await runWeeklyCheck(run.input)).ok, true);
  assert.deepEqual(run.alerts, [{ job: 'purge_participant_data', ageS: 31 * 60 }]);
  assert.equal(run.calls[2].args.p_since, new Date(nowMs - day).toISOString());
});

test('stale purge raises one safe alert before dead-man', async () => {
  const run = fakeRun();
  const original = run.input.rpc.call;
  run.input.rpc.call = (name, args) => name === 'heartbeats'
    ? Promise.resolve({ ok: true, data: [heartbeat('purge_participant_data', 2 * 60 * 60_000), heartbeat('keepalive', 6 * day + 1)] })
    : original(name, args);
  const result = await runHourlyCatchup(run.input);
  assert.equal(result.ok, true);
  assert.deepEqual(run.alerts, [{ job: 'purge_participant_data', ageS: 7200 }]);
  assert.equal(run.fetches.length, 1);
});

test('Supabase failure alerts immediately and never reaches dead-man', async () => {
  const run = fakeRun({ rpc: { call: async () => ({ ok: false, kind: 'unavailable', status: 503, code: null }) } });
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'supabase_unreachable' });
  assert.deepEqual(run.alerts, [{ kind: 'supabase_unreachable' }]);
  assert.deepEqual(run.fetches, []);
  assert.deepEqual(run.logs, ['supabase_unreachable']);
});

test('a thrown RPC also becomes a safe Supabase failure', async () => {
  const run = fakeRun({ rpc: { call: async () => { throw Error('sensitive RPC text'); } } });
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'supabase_unreachable' });
  assert.deepEqual(run.alerts, [{ kind: 'supabase_unreachable' }]);
  assert.deepEqual(run.logs, ['supabase_unreachable']);
  assert.deepEqual(run.fetches, []);
});

test('an invalid dead-man URL fails as config without reaching fetch', async () => {
  const run = fakeRun({ healthcheckUrl: 'not a URL' });
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'config' });
  assert.deepEqual(run.fetches, []);
  assert.deepEqual(run.logs, ['config']);
});

test('a failed alert hook prevents dead-man and logs only a fixed kind', async () => {
  const run = fakeRun({ onAlert: async () => { throw Error('sensitive hook text'); } });
  const original = run.input.rpc.call;
  run.input.rpc.call = (name, args) => name === 'lockdown_alerts_since'
    ? Promise.resolve({ ok: true, data: [{ id: 'irrelevant', detail: 'sensitive row' }] })
    : original(name, args);
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'alert_hook_failed' });
  assert.deepEqual(run.fetches, []);
  assert.deepEqual(run.logs, ['alert_hook_failed']);
});

test('a malformed ping timestamp cannot confirm success or reach dead-man', async () => {
  const run = fakeRun();
  const original = run.input.rpc.call;
  run.input.rpc.call = (name, args) => name === 'ping'
    ? Promise.resolve({ ok: true, data: { unsafe: 'not a timestamp' } })
    : original(name, args);
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'invalid_ping_data' });
  assert.deepEqual(run.calls.map(call => call.name), ['heartbeats']);
  assert.deepEqual(run.alerts, [{ kind: 'invalid_ping_data' }]);
  assert.deepEqual(run.fetches, []);
});

test('a hung RPC and a hung dead-man body settle within the deadline', async () => {
  const hung = fakeRun({ rpc: { call: async () => new Promise(() => {}) }, deadlineMs: 30 });
  const start = performance.now();
  assert.deepEqual(await runHourlyCatchup(hung.input), { ok: false, kind: 'timeout' });
  assert.ok(performance.now() - start < 300);
  assert.deepEqual(hung.fetches, []);
  assert.deepEqual(hung.alerts, [{ kind: 'supabase_unreachable' }]);

  const body = fakeRun({ deadlineMs: 30, fetchImpl: async (url, options) => {
    body.fetches.push({ url, options });
    return { ok: true, text: async () => new Promise(() => {}) };
  } });
  assert.deepEqual(await runHourlyCatchup(body.input), { ok: false, kind: 'timeout' });
  assert.equal(body.fetches.length, 1);
  assert.deepEqual(body.logs, ['timeout']);
});

test('a hung ping alerts immediately within the run budget and never calls dead-man', async () => {
  const run = fakeRun({ deadlineMs: 40 });
  const original = run.input.rpc.call;
  run.input.rpc.call = (name, args) => name === 'ping' ? new Promise(() => {}) : original(name, args);
  const start = performance.now();
  assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'timeout' });
  assert.ok(performance.now() - start < 300);
  assert.deepEqual(run.alerts, [{ kind: 'supabase_unreachable' }]);
  assert.deepEqual(run.fetches, []);
});

test('dead-man fetch, response, body and alert failures are contained', async () => {
  for (const fetchImpl of [
    async () => { throw Error('secret fetch text'); },
    async () => ({ ok: false, text: async () => 'bad' }),
    async () => ({ ok: true }),
    async () => ({ ok: true, text: async () => { throw Error('secret body text'); } }),
  ]) {
    const run = fakeRun({ fetchImpl });
    assert.deepEqual(await runHourlyCatchup(run.input), { ok: false, kind: 'healthcheck_failed' });
    assert.deepEqual(run.alerts, [{ kind: 'healthcheck_failed' }]);
    assert.deepEqual(run.logs, ['healthcheck_failed']);
  }
  const hook = fakeRun({ deadlineMs: 30, onAlert: async () => new Promise(() => {}) });
  hook.input.rpc.call = async name => ({ ok: true, data: name === 'heartbeats'
    ? [heartbeat('purge_participant_data', 2 * 60 * 60_000), heartbeat('keepalive', 6 * day + 1)]
    : name === 'ping' ? new Date(nowMs).toISOString() : [] });
  assert.deepEqual(await runHourlyCatchup(hook.input), { ok: false, kind: 'timeout' });
  assert.deepEqual(hook.fetches, []);
});
