import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePilotTarget } from '../scripts/pilot-target.mjs';
import * as loadRoom from '../scripts/load-room.mjs';
import { uuidv7, newCapabilityToken, newJoinCode } from '../src/shared/ids.mjs';
import { signTestJwt } from '../src/worker/auth.mjs';
const { runLoad } = loadRoom;

test('pilot load defaults to an owned local Worker without a deployed target', () => {
  assert.deepEqual(resolvePilotTarget({}), { kind: 'local', origin: null });
});

test('pilot load admits only the exact staging origin with explicit ownership', () => {
  assert.deepEqual(resolvePilotTarget({ target: 'https://case-staging.iatrogenic.app', own: true }),
    { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' });
  assert.throws(() => resolvePilotTarget({ target: 'https://case-staging.iatrogenic.app' }), /ownership/);
  assert.throws(() => resolvePilotTarget({ own: true }), /target/);
});

test('pilot load refuses production and target lookalikes before network access', () => {
  for (const target of [
    'https://case.iatrogenic.app', 'https://case.iatrogenic.app:443',
    'https://case-staging.iatrogenic.app.evil.invalid', 'https://case-staging.iatrogenic.app/path',
    'https://case-staging.iatrogenic.app?token=x', 'https://user@case-staging.iatrogenic.app',
    'https://case-staging.iatrogenic.app.', 'https://case-staging.iatrogenic.app:444',
    'https://other.workers.dev', 'http://case-staging.iatrogenic.app',
  ]) assert.throws(() => resolvePilotTarget({ target, own: true }), /target refused/);
});

test('staging load fails closed on missing owner inputs before any request', async () => {
  let calls = 0;
  await assert.rejects(runLoad({ target: { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' }, clients: 50, rounds: 1 },
    { environment: {}, fetchImpl: () => { calls++; throw Error('unexpected request'); } }), /staging_unconfigured/);
  assert.equal(calls, 0);
});

test('direct load calls cannot bypass production admission', async () => {
  let calls = 0;
  await assert.rejects(runLoad({ target: { kind: 'staging', origin: 'https://case.iatrogenic.app' }, clients: 50, rounds: 1 },
    { environment: new Proxy({}, { get() { throw Error('credentials read'); } }),
      fetchImpl: () => { calls++; throw Error('unexpected request'); } }), /target refused/);
  assert.equal(calls, 0);
});

test('invalid staging bearer syntax is refused before the version request', async () => {
  let calls = 0;
  await assert.rejects(runLoad({ target: { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' }, clients: 50, rounds: 1 },
    { environment: { CASE_LOAD_AUTH_TOKEN: `${'x'.repeat(30)}\n`, CASE_LOAD_CASE_VERSION_ID: uuidv7(),
      CASE_LOAD_WORKSPACE_ID: uuidv7() },
      fetchImpl: () => { calls++; throw Error('unexpected request'); } }), /staging_unconfigured/);
  assert.equal(calls, 0);
});

test('staging preflight refuses a production-reported Worker before room creation', async () => {
  const token = await signTestJwt({ sub: uuidv7(), aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 60 }, newCapabilityToken());
  const paths = [];
  await assert.rejects(runLoad({ target: { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' }, clients: 50, rounds: 1 },
    { environment: { CASE_LOAD_AUTH_TOKEN: token, CASE_LOAD_CASE_VERSION_ID: uuidv7(),
      CASE_LOAD_WORKSPACE_ID: uuidv7() },
      fetchImpl: (url) => { paths.push(new URL(url).pathname);
        return Promise.resolve(new Response(JSON.stringify({ env: 'production', build: 'a'.repeat(40) }), { status: 200 })); } }),
  /staging_version_unverified/);
  assert.deepEqual(paths, ['/api/v1/version']);
});

test('staging preflight refuses a malformed build marker before room creation', async () => {
  const token = await signTestJwt({ sub: uuidv7(), aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 60 }, newCapabilityToken());
  const paths = [];
  await assert.rejects(runLoad({ target: { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' }, clients: 50, rounds: 1 },
    { environment: { CASE_LOAD_AUTH_TOKEN: token, CASE_LOAD_CASE_VERSION_ID: uuidv7(),
      CASE_LOAD_WORKSPACE_ID: uuidv7() },
      fetchImpl: (url) => { paths.push(new URL(url).pathname);
        return Promise.resolve(new Response(JSON.stringify({ env: 'staging', build: 'bogus' }), { status: 200 })); } }),
  /staging_version_unverified/);
  assert.deepEqual(paths, ['/api/v1/version']);
});

async function fakeStageRoom(room) {
  const token = await signTestJwt({ sub: uuidv7(), aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 60 }, newCapabilityToken());
  const paths = [];
  const response = await loadRoom.stageRoom('https://case-staging.iatrogenic.app',
    { CASE_LOAD_AUTH_TOKEN: token, CASE_LOAD_CASE_VERSION_ID: uuidv7(), CASE_LOAD_WORKSPACE_ID: uuidv7() },
    url => { paths.push(new URL(url).pathname);
      return Promise.resolve(new Response(JSON.stringify(paths.length === 1
        ? { env: 'staging', build: 'a'.repeat(40) } : room), { status: paths.length === 1 ? 200 : 201 })); }, { own: true });
  return { response, paths };
}

test('staging room refuses a noncanonical join code before opening transport', async () => {
  await assert.rejects(fakeStageRoom({ sessionId: uuidv7(), joinCode: 'bad-code',
    facilitatorToken: newCapabilityToken() }), /staging_room_invalid/);
});

test('staging room refuses a malformed facilitator capability before opening transport', async () => {
  await assert.rejects(fakeStageRoom({ sessionId: uuidv7(), joinCode: newJoinCode(),
    facilitatorToken: 'not-a-capability' }), /staging_room_invalid/);
});

test('direct staging helper refuses production and missing ownership before credentials or network', async () => {
  let calls = 0;
  const environment = new Proxy({}, { get() { throw Error('credentials touched'); } });
  const fetchImpl = () => { calls++; throw Error('network touched'); };
  await assert.rejects(loadRoom.stageRoom('https://case.iatrogenic.app', environment, fetchImpl, { own: true }), /target refused/);
  await assert.rejects(loadRoom.stageRoom('https://case-staging.iatrogenic.app', environment, fetchImpl), /ownership/);
  assert.equal(calls, 0);
});

function fakeStagingLoad({ startReceipt = 'accepted', endReceipt = 'accepted', endPending = false,
  failConnect = false, voteReceiptIdentity = 'valid', voteReceipt = 'accepted' } = {}) {
  const roundId = uuidv7(), optionId = uuidv7();
  const room = { sessionId: uuidv7(), joinCode: newJoinCode(), facilitatorToken: newCapabilityToken() };
  const calls = { paths: [], commands: [], closed: 0, dropped: 0 };
  let snapshotHandler;
  const facilitator = {
    snapshot: { revision: 0, epoch: 1,
      view: { phase: 'lobby', participants: Array.from({ length: 50 }, () => ({})), round: null },
      mirror: { round: { responses: Object.fromEntries(Array.from({ length: 50 }, () => [uuidv7(), {}])) } } },
    on(event, handler) { if (event === 'snapshot') snapshotHandler = handler; },
    async send(type) {
      calls.commands.push(type);
      if (type === 'end') return endPending ? new Promise(() => {}) : { receipt: endReceipt };
      if (type === 'start' && startReceipt !== 'accepted') return { receipt: startReceipt };
      if (type === 'start') this.snapshot.view.phase = 'surface_live';
      if (type === 'advance') { this.snapshot.view.phase = 'responses_open'; this.snapshot.view.round = { id: roundId }; }
      this.snapshot.revision++;
      snapshotHandler?.(this.snapshot);
      return { receipt: 'accepted', revision: this.snapshot.revision };
    },
    dropPending() { calls.dropped++; },
    close() { calls.closed++; },
  };
  const fakeFetch = (url, init) => {
    const path = new URL(url).pathname;
    calls.paths.push(path);
    if (path === '/api/v1/version') return Promise.resolve(new Response(JSON.stringify({ env: 'staging', build: 'a'.repeat(40) })));
    if (path === '/api/v1/sessions') {
      calls.ttlMinutes = JSON.parse(init.body).ttlMinutes;
      return Promise.resolve(new Response(JSON.stringify(room), { status: 201 }));
    }
    throw Error('unexpected fake request');
  };
  const connectImpl = ({ role }) => {
    if (failConnect) throw Error('fake_connect_failed');
    if (role === 'facilitator') return facilitator;
    return {
      snapshot: null,
      async join() { this.snapshot = { epoch: 1, view: { decision: { roundId, interaction: { options: [{ id: optionId }] } } } }; return { ok: true }; },
      async sendFrame(frame) {
        facilitator.snapshot.revision++;
        snapshotHandler?.(facilitator.snapshot);
        const identity = voteReceiptIdentity === 'missing' ? {} : {
          clientEventId: voteReceiptIdentity === 'foreign' ? uuidv7() : frame.clientEventId,
        };
        return { receipt: voteReceipt, revision: facilitator.snapshot.revision, ...identity };
      },
      close() { calls.closed++; },
      get mode() { return 'ws'; },
    };
  };
  return { calls, fakeFetch, connectImpl };
}

async function fakeStagingOptions() {
  const token = await signTestJwt({ sub: uuidv7(), aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 60 }, newCapabilityToken());
  return { target: { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' }, clients: 50, rounds: 1,
    environment: { CASE_LOAD_AUTH_TOKEN: token, CASE_LOAD_CASE_VERSION_ID: uuidv7(), CASE_LOAD_WORKSPACE_ID: uuidv7() } };
}

test('successful owner staging load confirms an end before reporting success', async () => {
  const { target, clients, rounds, environment } = await fakeStagingOptions();
  const fake = fakeStagingLoad();
  const report = await runLoad({ target, clients, rounds }, { environment, fetchImpl: fake.fakeFetch, connectImpl: fake.connectImpl });
  assert.equal(report.lost_votes, 0);
  assert.equal(fake.calls.commands.filter(type => type === 'end').length, 1);
  assert.equal(fake.calls.closed, 51);
  assert.deepEqual(fake.calls.paths, ['/api/v1/version', '/api/v1/sessions']);
  assert.equal(fake.calls.ttlMinutes, 60);
});

test('failed staging load retains its original failure and reports unconfirmed end', async () => {
  const { target, clients, rounds, environment } = await fakeStagingOptions();
  const fake = fakeStagingLoad({ startReceipt: 'rejected', endReceipt: 'rejected' });
  await assert.rejects(runLoad({ target, clients, rounds },
    { environment, fetchImpl: fake.fakeFetch, connectImpl: fake.connectImpl }), error => {
    assert.equal(error.message, 'load_staging_end_unconfirmed');
    assert.equal(error.errors?.[0]?.message, 'load_start_refused');
    return true;
  });
  assert.equal(fake.calls.commands.filter(type => type === 'end').length, 1);
  assert.equal(fake.calls.closed, 51);
});

test('staging load failure before facilitator setup reports the 60-minute TTL fallback', async () => {
  const { target, clients, rounds, environment } = await fakeStagingOptions();
  const fake = fakeStagingLoad({ failConnect: true });
  await assert.rejects(runLoad({ target, clients, rounds },
    { environment, fetchImpl: fake.fakeFetch, connectImpl: fake.connectImpl }), error => {
    assert.equal(error.message, 'load_staging_room_ttl_fallback');
    assert.equal(error.errors?.[0]?.message, 'fake_connect_failed');
    return true;
  });
  assert.deepEqual(fake.calls.paths, ['/api/v1/version', '/api/v1/sessions']);
  assert.equal(fake.calls.ttlMinutes, 60);
});

test('ambiguous staging create response preserves validation failure and TTL fallback', async () => {
  const { target, clients, rounds, environment } = await fakeStagingOptions();
  const fake = fakeStagingLoad();
  const malformed = { sessionId: uuidv7(), joinCode: 'bad-code', facilitatorToken: newCapabilityToken() };
  await assert.rejects(runLoad({ target, clients, rounds }, {
    environment,
    fetchImpl: url => {
      const path = new URL(url).pathname;
      fake.calls.paths.push(path);
      return Promise.resolve(new Response(JSON.stringify(path === '/api/v1/version'
        ? { env: 'staging', build: 'a'.repeat(40) } : malformed), { status: path === '/api/v1/version' ? 200 : 201 }));
    },
    connectImpl: () => { throw Error('must not connect'); },
  }), error => {
    assert.equal(error.message, 'load_staging_room_ttl_fallback');
    assert.equal(error.errors?.[0]?.message, 'staging_room_invalid');
    return true;
  });
  assert.deepEqual(fake.calls.paths, ['/api/v1/version', '/api/v1/sessions']);
});

test('staging end cleanup has a whole ten-second default and can stop a stalled receipt', async () => {
  const { target, clients, rounds, environment } = await fakeStagingOptions();
  const fake = fakeStagingLoad({ endPending: true });
  const started = performance.now();
  await assert.rejects(runLoad({ target, clients, rounds },
    { environment, fetchImpl: fake.fakeFetch, connectImpl: fake.connectImpl, cleanupDeadlineMs: 25 }),
  /staging_end_unconfirmed/);
  assert.ok(performance.now() - started < 500);
  assert.equal(fake.calls.dropped, 1);
  assert.equal(fake.calls.closed, 51);
});


test('load caller refuses foreign accepted and replayed receipt identities before success', async () => {
  for (const voteReceipt of ['accepted', 'already_accepted']) {
    const { target, clients, rounds, environment } = await fakeStagingOptions();
    const fake = fakeStagingLoad({ voteReceiptIdentity: 'foreign', voteReceipt });
    await assert.rejects(runLoad({ target, clients, rounds },
      { environment, fetchImpl: fake.fakeFetch, connectImpl: fake.connectImpl }),
    { message: 'load_receipt_identity_mismatch' });
    assert.equal(fake.calls.commands.filter(type => type === 'end').length, 1);
    assert.equal(fake.calls.closed, 51);
  }
});


test('load caller refuses missing accepted and replayed receipt identities before success', async () => {
  for (const voteReceipt of ['accepted', 'already_accepted']) {
    const { target, clients, rounds, environment } = await fakeStagingOptions();
    const fake = fakeStagingLoad({ voteReceiptIdentity: 'missing', voteReceipt });
    await assert.rejects(runLoad({ target, clients, rounds },
      { environment, fetchImpl: fake.fakeFetch, connectImpl: fake.connectImpl }),
    { message: 'load_receipt_identity_mismatch' });
    assert.equal(fake.calls.commands.filter(type => type === 'end').length, 1);
    assert.equal(fake.calls.closed, 51);
  }
});
