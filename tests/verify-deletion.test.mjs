import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { apiUrl } from '../src/shared/urls.mjs';
import { resolveDeletionTarget, verifyDeletion } from '../scripts/verify-deletion.mjs';

const local = 'http://127.0.0.1:4173';
const staging = 'https://case-staging.iatrogenic.app';
const token = `local-${uuidv7()}`;
const sessionId = uuidv7();
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
const confirmed = () => {
  const now = Date.now(), ended = now - 24.5 * 60 * 60 * 1000;
  return { sessionId, status: 'current_absence_timely',
  observedAt: new Date(now).toISOString(), sqlObservedAt: new Date(now - 100).toISOString(),
  doObservedAt: new Date(now).toISOString(), endedAt: new Date(ended).toISOString(),
  archivedRoomEndedAt: new Date(ended - 1).toISOString(),
  personalDeleteAt: new Date(ended + 24 * 60 * 60 * 1000).toISOString(),
  retentionPurgedAt: new Date(now - 60_000).toISOString(), responseCount: 0, participantCount: 1,
  namedParticipantCount: 0, tokenParticipantCount: 0,
  currentSqlPersonalAbsent: true, currentDoStoreEmpty: true,
  archivedEndCorroborated: true, observedWithin25h: true,
  providerRecoveryHistoryVerified: false };
};

test('[AS-094] Card 20 deletion verifier admits only explicit loopback or owned exact staging and always refuses production', async () => {
  assert.deepEqual(resolveDeletionTarget(local), { origin: local, kind: 'local' });
  assert.deepEqual(resolveDeletionTarget(staging, { own: true }), { origin: staging, kind: 'staging' });
  let calls = 0;
  for (const target of [undefined, 'https://case.iatrogenic.app',
    'https://case.iatrogenic.app:443', 'https://case-staging.iatrogenic.app.evil.invalid',
    'https://case-staging.iatrogenic.app/path', 'https://case-staging.iatrogenic.app?x=1',
    'http://127.0.0.1', 'http://localhost:4173', 'http://127.0.0.1:4173/path']) {
    await assert.rejects(verifyDeletion({ target, own: true, sessionId },
      { environment: new Proxy({}, { get() { throw Error('credential read'); } }),
        fetchImpl: () => { calls++; throw Error('network call'); } }), /target_refused/);
  }
  await assert.rejects(verifyDeletion({ target: staging, sessionId },
    { environment: new Proxy({}, { get() { throw Error('credential read'); } }),
      fetchImpl: () => { calls++; throw Error('network call'); } }), /target_refused/);
  assert.equal(calls, 0);
});

test('[AS-094] Card 20 deletion verifier refuses missing token or invalid UUID before a request', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw Error('unexpected request'); };
  await assert.rejects(verifyDeletion({ target: local, sessionId: 'not-a-uuid' },
    { environment: new Proxy({}, { get() { throw Error('credential read'); } }), fetchImpl }), /invalid_session/);
  await assert.rejects(verifyDeletion({ target: local, sessionId },
    { environment: {}, fetchImpl }), /operator_unconfigured/);
  await assert.rejects(verifyDeletion({ target: local, sessionId },
    { environment: { DEPLOY_GUARD_TOKEN: `${token}\n` }, fetchImpl }), /operator_unconfigured/);
  assert.equal(calls, 0);
});

test('[AS-094] Card 20 verifier sends token only in header and accepts only scoped current timely absence', async () => {
  const calls = [];
  const result = await verifyDeletion({ target: local, sessionId }, {
    environment: { DEPLOY_GUARD_TOKEN: token },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(confirmed()), { status: 200,
        headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(result, { ok: true, code: 'current_private_store_absence',
    observedAt: result.observedAt, providerRecoveryHistoryVerified: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, apiUrl(local, 'ops', 'retention-status'));
  assert.equal(calls[0].url.includes(token) || calls[0].url.includes(sessionId), false);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId });
  assert.equal(calls[0].init.redirect, 'manual');
});

test('[AS-094] Card 20 verifier never treats 404, 410, SQL-only, residual data or late absence as timely deletion', async () => {
  for (const response of [new Response('{}', { status: 404 }),
    new Response('{}', { status: 410 }),
    jsonResponse({ ...confirmed(), currentDoStoreEmpty: false }),
    jsonResponse({ ...confirmed(), namedParticipantCount: 1 }),
    jsonResponse({ ...confirmed(), status: 'current_absence_late', observedWithin25h: false })]) {
    const result = await verifyDeletion({ target: local, sessionId }, {
      environment: { DEPLOY_GUARD_TOKEN: token }, fetchImpl: async () => response,
    });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(sessionId), false);
  }
});

test('[AS-094] Card 20 verifier refuses a false timely claim after either earlier end marker expires', async () => {
  const now = Date.now(), early = new Date(now - 26 * 60 * 60 * 1000).toISOString();
  const late = new Date(now - 24.5 * 60 * 60 * 1000).toISOString();
  for (const [sqlEnd, journalEnd] of [[late, early], [early, late]]) {
    const falseClaim = { ...confirmed(), endedAt: sqlEnd, archivedRoomEndedAt: journalEnd,
      personalDeleteAt: new Date(Date.parse(sqlEnd) + 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = await verifyDeletion({ target: local, sessionId }, {
      environment: { DEPLOY_GUARD_TOKEN: token },
      fetchImpl: async () => jsonResponse(falseClaim),
    });
    assert.deepEqual(result, { ok: false, code: 'not_confirmed' });
  }
});

test('[AS-094] Card 20 verifier bounds ignored abort and hostile response bodies without echoing them', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { status: 200,
      headers: { 'content-type': 'application/json' } }),
    async () => new Response(JSON.stringify({ secret: 'private marker' }), { status: 302,
      headers: { location: 'https://attacker.invalid/collect' } }),
    async () => new Response('x'.repeat(5000), { status: 200,
      headers: { 'content-type': 'application/json' } })]) {
    const started = Date.now();
    const result = await verifyDeletion({ target: local, sessionId }, {
      environment: { DEPLOY_GUARD_TOKEN: token }, fetchImpl, timeoutMs: 20,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unavailable');
    assert.ok(Date.now() - started < 250);
    assert.equal(JSON.stringify(result).includes('private marker'), false);
  }
});


test('[AS-094] Card 20 verifier cancels a late abort-ignoring fetch without acquiring its reader', async () => {
  let release, signal;
  const started = performance.now();
  const pending = verifyDeletion({ target: local, sessionId }, {
    environment: { DEPLOY_GUARD_TOKEN: token }, timeoutMs: 20,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise(resolve => { release = resolve; });
    },
  });
  assert.deepEqual(await pending, { ok: false, code: 'unavailable' });
  assert.ok(performance.now() - started < 500);
  assert.equal(signal.aborted, true);
  let cancellations = 0, pulls = 0;
  const body = new ReadableStream({
    pull() { pulls++; return new Promise(() => {}); },
    cancel() { cancellations++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  release(new Response(body, { headers: { 'content-type': 'application/json' } }));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1, 'late verifier body is cancelled exactly once');
  assert.equal(body.locked, false, 'late verifier body never acquires a reader');
  assert.equal(pulls, 0, 'late verifier body is never pulled');
});
