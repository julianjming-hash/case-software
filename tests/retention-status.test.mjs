import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { handleRetentionStatus } from '../src/worker/retention-status.mjs';

const operator = `local-${uuidv7()}`;
const url = 'https://case.test/api/v1/ops/retention-status';
const request = (body, token = operator) => new Request(url, {
  method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body),
});
const row = (sessionId, now = Date.now()) => {
  const ended = new Date(now - 24.5 * 60 * 60 * 1000).toISOString();
  return {
    session_id: sessionId, status: 'ended', created_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
    started_at: null, ended_at: ended, expires_at: new Date(now + 60_000).toISOString(),
    personal_data_delete_at: new Date(Date.parse(ended) + 24 * 60 * 60 * 1000).toISOString(),
    retention_purged_at: new Date(now - 60_000).toISOString(), server_time: new Date(now).toISOString(),
    response_count: 0, participant_count: 1, named_participant_count: 0,
    token_participant_count: 0, archived_event_count: 1,
    archived_room_ended_count: 1,
    archived_room_ended_at: new Date(Date.parse(ended) - 1).toISOString(),
  };
};
const probe = sessionId => ({ sessionId, storeEmpty: true, tableCount: 0,
  kvPresent: false, alarmPresent: false, statePresent: false,
  observedAt: new Date().toISOString() });
function fixture(result, evidence = probe) {
  const sessionId = uuidv7(), calls = [];
  const rpc = { call: async (name, args) => { calls.push(['rpc', name, args]);
    return result === null ? { ok: true, data: [] }
      : { ok: true, data: [result ?? row(sessionId)] }; } };
  const roomFor = id => { calls.push(['room', id]); return {
    retentionEvidence: async expected => { calls.push(['probe', expected]); return evidence(expected); },
  }; };
  const options = { env: { DEPLOY_GUARD_TOKEN: operator },
    compareSecret: async (given, expected) => given === expected, rpc, roomFor,
    budgetMs: 100 };
  return { sessionId, calls, options };
}

test('[AS-094] Card 20 retention ops refuses missing or wrong operator secret and malformed body before RPC or DO', async () => {
  const f = fixture();
  for (const req of [request({ sessionId: f.sessionId }, 'wrong'),
    request({ sessionId: 'not-a-uuid' }), request({ sessionId: f.sessionId, private: 'never' })]) {
    const response = await handleRetentionStatus(req, f.options);
    assert.equal(response.status, req.headers.get('authorization')?.endsWith('wrong') ? 404 : 400);
    assert.equal(JSON.stringify(await response.json()).includes('never'), false);
  }
  assert.deepEqual(f.calls, []);
});

test('[AS-094] Card 20 SQL unknown, compensated creation or foreign end never addresses a DO', async () => {
  const unknown = fixture(null);
  assert.equal((await handleRetentionStatus(request({ sessionId: unknown.sessionId }), unknown.options)).status, 404);
  assert.equal(unknown.calls.some(call => call[0] === 'room'), false);
  const incomplete = fixture(undefined);
  incomplete.options.rpc.call = async (name, args) => {
    incomplete.calls.push(['rpc', name, args]);
    return { ok: true, data: [{ ...row(incomplete.sessionId),
      archived_room_ended_count: 0, archived_room_ended_at: null }] };
  };
  const response = await handleRetentionStatus(request({ sessionId: incomplete.sessionId }), incomplete.options);
  assert.equal(response.status, 409);
  assert.equal(incomplete.calls.some(call => call[0] === 'room'), false);
  assert.deepEqual(incomplete.calls[0], ['rpc', 'retention_status', { p_session_id: incomplete.sessionId }]);
  const foreign = fixture();
  foreign.options.rpc.call = async (name, args) => {
    foreign.calls.push(['rpc', name, args]);
    return { ok: true, data: [{ ...row(foreign.sessionId), session_id: uuidv7() }] };
  };
  assert.equal((await handleRetentionStatus(request({ sessionId: foreign.sessionId }), foreign.options)).status, 503);
  assert.equal(foreign.calls.some(call => call[0] === 'room'), false, 'foreign SQL scope never addresses the requested DO');
});

test('[AS-094] Card 20 retention status distinguishes timely current absence, late observation and residual private data', async () => {
  const f = fixture();
  const response = await handleRetentionStatus(request({ sessionId: f.sessionId }), f.options);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'current_absence_timely');
  assert.equal(body.currentSqlPersonalAbsent, true);
  assert.equal(body.currentDoStoreEmpty, true);
  assert.equal(body.providerRecoveryHistoryVerified, false);
  assert.deepEqual(f.calls.map(call => call[0]), ['rpc', 'room', 'probe']);
  assert.equal(JSON.stringify(body).includes('Private fixture'), false);

  const late = fixture();
  late.options.rpc.call = async () => ({ ok: true,
    data: [row(late.sessionId, Date.now() - 2 * 60 * 60 * 1000)] });
  const lateResponse = await handleRetentionStatus(request({ sessionId: late.sessionId }), late.options);
  assert.equal((await lateResponse.json()).status, 'current_absence_late');

  const residue = fixture();
  residue.options.rpc.call = async () => ({ ok: true,
    data: [{ ...row(residue.sessionId), named_participant_count: 1 }] });
  const residueResponse = await handleRetentionStatus(request({ sessionId: residue.sessionId }), residue.options);
  assert.equal((await residueResponse.json()).status, 'not_confirmed');
});

test('[AS-094] Card 20 a DO observation before personal cutoff never becomes timely from a later SQL clock', async () => {
  const f = fixture();
  f.options.roomFor = id => ({ retentionEvidence: async () => ({
    ...probe(id), observedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  }) });
  const response = await handleRetentionStatus(request({ sessionId: f.sessionId }), f.options);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'not_confirmed');
  assert.equal(body.observedWithin25h, false);
  assert.equal(body.currentSqlPersonalAbsent, true);
  assert.equal(body.currentDoStoreEmpty, true);
  assert.ok(Date.parse(body.doObservedAt) < Date.parse(body.personalDeleteAt));
  assert.ok(Date.parse(body.sqlObservedAt) > Date.parse(body.personalDeleteAt));
});

test('[AS-094] Card 20 current-store timing uses the earlier corroborated end in either marker order', async () => {
  const now = Date.now(), early = new Date(now - 26 * 60 * 60 * 1000).toISOString();
  const late = new Date(now - 24.5 * 60 * 60 * 1000).toISOString();
  for (const [sqlEnd, journalEnd] of [[late, early], [early, late]]) {
    const f = fixture();
    f.options.rpc.call = async () => ({ ok: true, data: [{ ...row(f.sessionId, now),
      ended_at: sqlEnd, archived_room_ended_at: journalEnd,
      personal_data_delete_at: new Date(Date.parse(sqlEnd) + 24 * 60 * 60 * 1000).toISOString(),
    }] });
    const response = await handleRetentionStatus(request({ sessionId: f.sessionId }), f.options);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'current_absence_late');
    assert.equal(body.observedWithin25h, false);
  }
});

test('[AS-094] Card 20 retention status bounds stalled SQL and DO and refuses malformed evidence', async () => {
  const f = fixture();
  f.options.budgetMs = 15;
  f.options.rpc.call = () => new Promise(() => {});
  const start = Date.now();
  assert.equal((await handleRetentionStatus(request({ sessionId: f.sessionId }), f.options)).status, 503);
  assert.ok(Date.now() - start < 500);
  f.options.rpc.call = async () => ({ ok: true, data: [row(f.sessionId)] });
  f.options.roomFor = () => ({ retentionEvidence: () => new Promise(() => {}) });
  assert.equal((await handleRetentionStatus(request({ sessionId: f.sessionId }), f.options)).status, 503);
  f.options.roomFor = () => ({ retentionEvidence: async () => ({ ...probe(f.sessionId),
    tableCount: 1, storeEmpty: true }) });
  assert.equal((await handleRetentionStatus(request({ sessionId: f.sessionId }), f.options)).status, 503);
});
