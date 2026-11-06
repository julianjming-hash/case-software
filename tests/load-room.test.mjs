import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../src/shared/ids.mjs';
import * as loadRoom from '../scripts/load-room.mjs';
const { parseOptions, percentile, summarizeLoad, assertLoadGate, fetchFixedJson } = loadRoom;

test('load harness reports nearest-rank percentiles', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
});

test('load harness bounds simulated room size to the supported 50 to 200 clients', () => {
  assert.equal(parseOptions(['--clients', '50']).clients, 50);
  assert.equal(parseOptions(['--clients', '150']).clients, 150);
  assert.throws(() => parseOptions(['--clients', '49']), /50 to 200/);
  assert.throws(() => parseOptions(['--client', '60']), /unknown option --client/);
});

test('load CLI selects local by default and refuses unsafe targets before running', () => {
  assert.deepEqual(parseOptions([]), { target: { kind: 'local', origin: null }, clients: 50, rounds: 1 });
  assert.throws(() => parseOptions(['--target', 'https://case.iatrogenic.app', '--i-own-this-origin']), /target refused/);
  assert.throws(() => parseOptions(['--target', 'https://case-staging.iatrogenic.app']), /ownership/);
  assert.deepEqual(parseOptions(['--target', 'https://case-staging.iatrogenic.app', '--i-own-this-origin']).target,
    { kind: 'staging', origin: 'https://case-staging.iatrogenic.app' });
  assert.throws(() => parseOptions(['--base-url', 'http://127.0.0.1:8787']), /unknown option/);
});

test('the CLI refuses unsafe arguments before opening a Worker', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/load-room.mjs', import.meta.url)), '--target', 'https://case.iatrogenic.app'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /load:room — target refused/);
});

test('load report counts a missing receipt as lost rather than a successful vote', () => {
  const first = uuidv7(), second = uuidv7();
  const report = summarizeLoad({ clients: 50, rounds: 1, expectedIds: [first, second],
    receipts: [{ clientEventId: first, receipt: 'accepted', elapsedMs: 12 }], fanoutLagMs: [18] });
  assert.equal(report.lost_votes, 1);
  assert.equal(report.acknowledgement_ms.p95, 12);
  assert.throws(() => assertLoadGate(report), /lost_votes/);
  const refused = summarizeLoad({ clients: 50, rounds: 1, expectedIds: [first, second],
    receipts: [{ clientEventId: first, receipt: 'accepted', elapsedMs: 12 },
      { clientEventId: first, receipt: 'already_accepted', elapsedMs: 5000 },
      { clientEventId: second, receipt: 'rejected', elapsedMs: 0 },
      { clientEventId: uuidv7(), receipt: 'accepted', elapsedMs: 1 }], fanoutLagMs: [18] });
  assert.equal(refused.receipted_votes, 1, 'duplicate, foreign and terminal refusal are not extra successful votes');
  assert.equal(refused.lost_votes, 1, 'a delivered refusal cannot satisfy expected saved-answer accounting');
  assert.equal(refused.acknowledgement_ms.p95, 12);
  assert.throws(() => assertLoadGate(refused), /lost_votes/);
});

test('load report requires observed fan-out samples and enforces the 50-phone p95', () => {
  const eventId = uuidv7();
  assert.throws(() => summarizeLoad({ clients: 50, rounds: 1, expectedIds: [eventId],
    receipts: [{ clientEventId: eventId, receipt: 'accepted', elapsedMs: 10 }], fanoutLagMs: [] }), /fan.out/);
  const report = summarizeLoad({ clients: 50, rounds: 1, expectedIds: [eventId],
    receipts: [{ clientEventId: eventId, receipt: 'already_accepted', elapsedMs: 1000 }], fanoutLagMs: [3] });
  assert.equal(report.lost_votes, 0);
  // CASE-161: a failed gate names what it measured, so a near miss is distinguishable from a stall.
  assert.throws(() => assertLoadGate(report), /p95 exceeded 1000ms \(p50=1000ms p95=1000ms p99=1000ms\)/);
});

test('staging preflight bounds an abort-ignoring body and does not await stalled cancellation', async () => {
  let signal;
  const stream = new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel: () => new Promise(() => {}),
  });
  const started = performance.now();
  await assert.rejects(fetchFixedJson((_url, options) => {
    signal = options.signal;
    return Promise.resolve(new Response(stream));
  }, 'https://case-staging.iatrogenic.app/api/v1/version', { deadlineMs: 25 }), /load_deadline/);
  assert.ok(performance.now() - started < 500);
  assert.equal(signal.aborted, true);
});

test('staging preflight refuses an oversized JSON body before retaining it', async () => {
  await assert.rejects(fetchFixedJson(() => Promise.resolve(new Response(new Uint8Array(65_537))),
    'https://case-staging.iatrogenic.app/api/v1/version'), /load_body_too_large/);
});

test('150-phone setup bounds simultaneous joins to 25 while retaining all 150 results', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await loadRoom.joinPhonesInWaves(Array.from({ length: 150 }, (_, index) => index), async index => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return { ok: true, index };
  }, 25);
  assert.equal(results.length, 150);
  assert.deepEqual(results.map(result => result.index), Array.from({ length: 150 }, (_, index) => index));
  assert.ok(peak <= 25, `peak ${peak} exceeded 25`);
  assert.equal(peak, 25);
});

test('join failure report refuses untrusted lowercase labels instead of echoing them', () => {
  assert.equal(loadRoom.safeJoinFailureCode('network'), 'network');
  assert.equal(loadRoom.safeJoinFailureCode('rate_limited'), 'rate_limited');
  assert.equal(loadRoom.safeJoinFailureCode('patient_private_name'), 'unknown');
  assert.equal(loadRoom.safeJoinFailureCode('unauthorised\nsecret'), 'unknown');
});


test('staging preflight cancels a late abort-ignoring fetch without acquiring its reader', async () => {
  let release, signal;
  const started = performance.now();
  const pending = fetchFixedJson((_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  }, 'https://case-staging.iatrogenic.app/api/v1/version', { deadlineMs: 25 });
  await assert.rejects(pending, /load_deadline/);
  assert.ok(performance.now() - started < 500);
  assert.equal(signal.aborted, true);
  let cancellations = 0, pulls = 0;
  const body = new ReadableStream({
    pull() { pulls++; return new Promise(() => {}); },
    cancel() { cancellations++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  release(new Response(body));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1, 'late preflight body is cancelled exactly once');
  assert.equal(body.locked, false, 'late preflight body never acquires a reader');
  assert.equal(pulls, 0, 'late preflight body is never pulled');
});

// Proposed pure local callback fixture. It deliberately scripts request calls, not the
// production transport's rejection retry policy. No Worker, socket or external request starts.
function fakeLocalLossSelection({ initialReceipt = 'rejected', initialReason = 'rate_limited' } = {}) {
  const origin = 'http://127.0.0.1:43219';
  const roundId = uuidv7(), optionId = uuidv7(), sessionId = uuidv7();
  const observations = { firstPhone: [], requestIds: [], closed: 0, stopped: 0 };
  let handler;
  const facilitator = {
    snapshot: { revision: 0, epoch: 1,
      view: { phase: 'lobby', participants: Array.from({ length: 50 }, () => ({})), round: null },
      mirror: { round: { responses: {} } } },
    on(event, callback) { if (event === 'snapshot') handler = callback; },
    async send(type) {
      assert.equal(type, 'start');
      this.snapshot.view.phase = 'responses_open';
      this.snapshot.view.round = { id: roundId };
      this.snapshot.revision++;
      handler?.(this.snapshot);
      return { receipt: 'accepted', revision: this.snapshot.revision };
    },
    close() { observations.closed++; },
  };
  const committed = new Set();
  let firstPhoneRequests = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(String(url)).origin, origin);
    assert.equal(new URL(String(url)).pathname, `/api/v1/sessions/${sessionId}/commands`);
    assert.equal(init.method, 'POST');
    const frame = JSON.parse(init.body);
    assert.equal(frame.type, 'vote');
    const firstPhone = init.headers['x-fixture-phone'] === 'first';
    if (firstPhone) observations.requestIds.push(frame.clientEventId);
    let receipt = committed.has(frame.clientEventId) ? 'already_accepted' : 'accepted';
    let reason;
    if (firstPhone && ++firstPhoneRequests === 1) {
      receipt = initialReceipt;
      reason = initialReason;
    }
    if (['accepted', 'already_accepted'].includes(receipt)) {
      if (!committed.has(frame.clientEventId)) {
        committed.add(frame.clientEventId);
        facilitator.snapshot.mirror.round.responses[frame.clientEventId] = {};
        facilitator.snapshot.revision++;
        handler?.(facilitator.snapshot);
      }
    }
    return new Response(JSON.stringify({ receipt: { v: 1, t: 'receipt', receipt,
      clientEventId: frame.clientEventId, epoch: frame.epoch,
      revision: facilitator.snapshot.revision, ...(reason ? { reason } : {}) } }), { status: 200 });
  };
  const connectImpl = ({ role, slot, fetchImpl: phoneFetch }) => {
    if (role === 'facilitator') return facilitator;
    const firstPhone = slot === 'load-0';
    return {
      snapshot: null,
      async join() {
        this.snapshot = { epoch: 1, view: { decision: {
          roundId, interaction: { options: [{ id: optionId }] } } } };
        return { ok: true };
      },
      async sendFrame(frame) {
        // Explicit script: rejected admission, accepted response loss, idempotent replay.
        // This loop is test-owned callback sequencing; it does not change production retries.
        for (let step = 0; step < (firstPhone ? 3 : 1); step++) {
          try {
            const response = await phoneFetch(`${origin}/api/v1/sessions/${sessionId}/commands`, {
              method: 'POST', headers: { 'x-fixture-phone': firstPhone ? 'first' : 'other' },
              body: JSON.stringify(frame), signal: new AbortController().signal });
            const receipt = (await response.json()).receipt;
            if (firstPhone) observations.firstPhone.push(receipt.receipt);
            if (receipt.receipt === 'rejected') continue;
            return receipt;
          } catch (error) {
            assert.equal(error.message, 'local_injected_response_loss');
            if (firstPhone) observations.firstPhone.push('http_response_lost');
          }
        }
        throw Error('fixture_sequence_incomplete');
      },
      close() { observations.closed++; },
      get mode() { return 'ws'; },
    };
  };
  return { observations, fetchImpl, connectImpl,
    startLocal: async () => ({ origin, async stop() { observations.stopped++; } }),
    createLocalRoom: async () => ({ sessionId }) };
}

test('local load loss selects a matching accepted receipt after a HTTP200 rejection without hiding that rejection', async () => {
  const fixture = fakeLocalLossSelection();
  const report = await loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 }, fixture);
  assert.deepEqual(fixture.observations.firstPhone, ['rejected', 'http_response_lost', 'already_accepted']);
  assert.equal(fixture.observations.requestIds.length, 3);
  assert.equal(new Set(fixture.observations.requestIds).size, 1);
  assert.equal(report.response_loss_injected, true);
  assert.equal(report.replay_same_event, true);
  assert.equal(report.receipted_votes, 50);
  assert.equal(report.lost_votes, 0);
  assert.equal(report.injected_vote_requests, 52);
  assert.equal(fixture.observations.closed, 51);
  assert.equal(fixture.observations.stopped, 1);
});


// Public runLoad callback probes. These are controlled local responses, never real retry policy.
function localLossProbe({ firstResponse, exerciseFirst }) {
  const origin = 'http://127.0.0.1:43220';
  const roundId = uuidv7(), optionId = uuidv7(), sessionId = uuidv7();
  const calls = { firstRequests: 0, closed: 0, stopped: 0 };
  let handler;
  const committed = new Set();
  const cleanup = [];
  const facilitator = {
    snapshot: { revision: 0, epoch: 1,
      view: { phase: 'lobby', participants: Array.from({ length: 50 }, () => ({})), round: null },
      mirror: { round: { responses: {} } } },
    on(event, callback) { if (event === 'snapshot') handler = callback; },
    async send(type) {
      assert.equal(type, 'start');
      this.snapshot.view.phase = 'responses_open'; this.snapshot.view.round = { id: roundId };
      this.snapshot.revision++; handler?.(this.snapshot);
      return { receipt: 'accepted', revision: this.snapshot.revision };
    },
    close() { calls.closed++; },
  };
  const positive = (frame, kind = 'accepted') => ({ receipt: {
    v: 1, t: 'receipt', receipt: kind, clientEventId: frame.clientEventId,
    epoch: frame.epoch, revision: facilitator.snapshot.revision,
  } });
  const commit = frame => {
    if (committed.has(frame.clientEventId)) return;
    committed.add(frame.clientEventId);
    facilitator.snapshot.mirror.round.responses[frame.clientEventId] = {};
    facilitator.snapshot.revision++; handler?.(facilitator.snapshot);
  };
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(String(url)).origin, origin);
    assert.equal(new URL(String(url)).pathname, `/api/v1/sessions/${sessionId}/commands`);
    const frame = JSON.parse(init.body);
    const first = init.headers['x-fixture-phone'] === 'first';
    if (first && ++calls.firstRequests === 1) return firstResponse({ frame, positive, commit, cleanup });
    const kind = committed.has(frame.clientEventId) ? 'already_accepted' : 'accepted';
    commit(frame);
    return new Response(JSON.stringify(positive(frame, kind)));
  };
  const connectImpl = ({ role, slot, fetchImpl: phoneFetch }) => {
    if (role === 'facilitator') return facilitator;
    const first = slot === 'load-0';
    return {
      snapshot: null,
      async join() { this.snapshot = { epoch: 1, view: { decision: {
        roundId, interaction: { options: [{ id: optionId }] } } } }; return { ok: true }; },
      async sendFrame(frame) {
        const controller = new AbortController();
        const invoke = () => phoneFetch(`${origin}/api/v1/sessions/${sessionId}/commands`, {
          method: 'POST', headers: { 'x-fixture-phone': first ? 'first' : 'other' },
          body: JSON.stringify(frame), signal: controller.signal });
        if (first) return exerciseFirst({ invoke, controller, frame, cleanup });
        return (await (await invoke()).json()).receipt;
      },
      close() { calls.closed++; },
      get mode() { return 'ws'; },
    };
  };
  return { calls, cleanup, options: { fetchImpl, connectImpl,
    startLocal: async () => ({ origin, async stop() { calls.stopped++; } }),
    createLocalRoom: async () => ({ sessionId }) } };
}

async function runLocalLossProbe(probe) {
  try { return await loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 }, probe.options); }
  finally { for (const release of probe.cleanup) release(); }
}

// Test-owned observation watchdog only; unchanged transport and inspection deadlines still apply.
async function lossProbePromptly(operation, message) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({ message })), 500);
    })]);
  } finally { clearTimeout(timer); }
}

const lossForwardCases = [
  ['rejected', body => { body.receipt.receipt = 'rejected'; body.receipt.reason = 'rate_limited'; return JSON.stringify(body); }],
  ['unknown', body => { body.receipt.receipt = 'unexpected'; return JSON.stringify(body); }],
  ['wrong event', body => { body.receipt.clientEventId = uuidv7(); return JSON.stringify(body); }],
  ['wrong epoch', body => { body.receipt.epoch++; return JSON.stringify(body); }],
  ['wrong version', body => { body.receipt.v = 2; return JSON.stringify(body); }],
  ['wrong type', body => { body.receipt.t = 'snapshot'; return JSON.stringify(body); }],
  ['negative revision', body => { body.receipt.revision = -1; return JSON.stringify(body); }],
  ['fractional revision', body => { body.receipt.revision = 1.5; return JSON.stringify(body); }],
  ['malformed JSON', body => JSON.stringify(body) + '#invalid-json'],
  ['malformed UTF8', body => {
    const prefix = new TextEncoder().encode(JSON.stringify(body).slice(0, -1) + ',"padding":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix); bytes[prefix.length] = 255; bytes.set(suffix, prefix.length + 1);
    return bytes;
  }],
  ['oversize body', body => {
    body.padding = '';
    body.padding = 'x'.repeat(65537 - new TextEncoder().encode(JSON.stringify(body)).length);
    return JSON.stringify(body);
  }],
];

for (const [label, encode] of lossForwardCases) {
  test(`local response-loss inspection forwards ${label} original bytes without injecting a loss`, async () => {
    let original, bytes;
    const probe = localLossProbe({
      firstResponse({ frame, positive }) {
        const encoded = encode(positive(frame));
        bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded;
        original = new Response(bytes);
        return original;
      },
      async exerciseFirst({ invoke }) {
        let returned;
        await assert.doesNotReject(async () => { returned = await invoke(); }, `unselected ${label} response must remain visible`);
        assert.strictEqual(returned, original, `unselected ${label} response preserves original identity`);
        assert.equal(returned.bodyUsed, false, `unselected ${label} original body remains unread`);
        assert.deepEqual(new Uint8Array(await returned.arrayBuffer()), bytes, `unselected ${label} original bytes stay readable`);
        throw Error('fixture_unselected_response_observed');
      },
    });
    await assert.rejects(runLocalLossProbe(probe), /^Error: fixture_unselected_response_observed$/);
    assert.equal(probe.calls.closed, 51);
    assert.equal(probe.calls.stopped, 1);
  });
}

test('local response-loss inspection selects an exact64KiB positive body without awaiting native sibling cancellation', async () => {
  let readerCancels = 0, originalCancels = 0;
  const probe = localLossProbe({
    firstResponse({ frame, positive, commit, cleanup }) {
      commit(frame);
      const body = positive(frame); body.padding = '';
      body.padding = 'x'.repeat(65536 - new TextEncoder().encode(JSON.stringify(body)).length);
      const response = new Response(JSON.stringify(body));
      const actualClone = response.clone.bind(response);
      response.clone = () => {
        const clone = actualClone(), actualReader = clone.body.getReader.bind(clone.body);
        // Native clone tees and replaces response.body; instrument its new original sibling.
        const actualCancel = response.body.cancel.bind(response.body);
        cleanup.push(() => { void actualCancel().catch(() => {}); });
        response.body.cancel = () => { originalCancels++; void actualCancel().catch(() => {}); return new Promise(() => {}); };
        clone.body.getReader = () => {
          const reader = actualReader(); cleanup.push(() => { void reader.cancel().catch(() => {}); });
          return { read: () => reader.read(), cancel: () => {
            readerCancels++; void reader.cancel().catch(() => {}); return new Promise(() => {});
          } };
        };
        return clone;
      };
      return response;
    },
    async exerciseFirst({ invoke }) {
      await lossProbePromptly(() => assert.rejects(invoke(), /^TypeError: local_injected_response_loss$/),
        'native sibling cancellation must not delay qualified loss');
      return (await (await invoke()).json()).receipt;
    },
  });
  const report = await runLocalLossProbe(probe);
  assert.equal(readerCancels, 1, 'qualified native clone cancel starts once');
  assert.equal(originalCancels, 1, 'qualified native original sibling cancel starts once');
  assert.equal(report.response_loss_diagnostic?.selected_receipt, 'accepted', 'exact64KiB body remains eligible');
  assert.equal(report.response_loss_diagnostic?.last?.body_consumed, true);
  assert.equal(report.replay_same_event, true);
  assert.equal(report.lost_votes, 0);
});

test('local response-loss inspection honestly selects already_accepted and requires the same event replay', async () => {
  const probe = localLossProbe({
    firstResponse({ frame, positive, commit }) { commit(frame); return new Response(JSON.stringify(positive(frame, 'already_accepted'))); },
    async exerciseFirst({ invoke }) {
      await assert.rejects(invoke(), /^TypeError: local_injected_response_loss$/);
      return (await (await invoke()).json()).receipt;
    },
  });
  const report = await runLocalLossProbe(probe);
  assert.equal(report.response_loss_diagnostic?.selected_receipt, 'already_accepted', 'already_accepted selection is reported honestly');
  assert.equal(report.replay_same_event, true);
  assert.equal(report.lost_votes, 0);
  assert.equal(probe.calls.firstRequests, 2);
});

test('local response-loss inspection refuses a pre-aborted request without cloning or pulling its original body', async () => {
  let cloneCalls = 0, pulls = 0, cancels = 0;
  const probe = localLossProbe({
    firstResponse({ frame, positive }) {
      const bytes = new TextEncoder().encode(JSON.stringify(positive(frame)));
      const response = new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(bytes); controller.close(); },
        cancel() { cancels++; return new Promise(() => {}); },
      }, { highWaterMark: 0 }));
      const actualClone = response.clone.bind(response);
      response.clone = () => { cloneCalls++; return actualClone(); };
      return response;
    },
    async exerciseFirst({ invoke, controller }) {
      controller.abort();
      await lossProbePromptly(() => assert.rejects(invoke(), /^TypeError: local_response_inspection_aborted$/),
        'pre-aborted refusal must not await original cancellation');
      assert.equal(cloneCalls, 0, 'pre-aborted response is never cloned');
      assert.equal(pulls, 0, 'pre-aborted original body is never pulled');
      assert.equal(cancels, 1, 'pre-aborted original cancellation starts once');
      throw Error('fixture_preaborted_observed');
    },
  });
  await assert.rejects(runLocalLossProbe(probe), /^Error: fixture_preaborted_observed$/);
});

test('local response-loss inspection rejects abort during a native read and fences a late positive result despite never-settling cancellation', async () => {
  let abortRequest, releaseLate, readStartedResolve;
  const readStarted = new Promise(resolve => { readStartedResolve = resolve; });
  let readerReads = 0, readerCancels = 0, originalCancels = 0, lateResultReturned = false;
  const probe = localLossProbe({
    firstResponse({ frame, positive, cleanup }) {
      const response = new Response(JSON.stringify(positive(frame)));
      const actualClone = response.clone.bind(response);
      response.clone = () => {
        const clone = actualClone(), actualReader = clone.body.getReader.bind(clone.body);
        // Native clone tees and replaces response.body; instrument its new original sibling.
        const actualCancel = response.body.cancel.bind(response.body);
        cleanup.push(() => { void actualCancel().catch(() => {}); });
        response.body.cancel = () => { originalCancels++; void actualCancel().catch(() => {}); return new Promise(() => {}); };
        clone.body.getReader = () => {
          const reader = actualReader(); cleanup.push(() => { void reader.cancel().catch(() => {}); });
          return {
            async read() {
              readerReads++;
              const result = await reader.read();
              readStartedResolve();
              await new Promise(resolve => { releaseLate = resolve; });
              lateResultReturned = true;
              return result;
            },
            cancel() { readerCancels++; void reader.cancel().catch(() => {}); return new Promise(() => {}); },
          };
        };
        return clone;
      };
      return response;
    },
    async exerciseFirst({ invoke, controller }) {
      abortRequest = () => controller.abort();
      const pending = invoke();
      void pending.catch(() => {}); // handler attached immediately; the exact rejection is still asserted below.
      try {
        await lossProbePromptly(() => readStarted, 'native read must start before injected request abort');
        abortRequest();
        await lossProbePromptly(() => assert.rejects(pending, /^TypeError: local_response_inspection_aborted$/),
          'request abort must not await clone cancellation or late read');
        assert.equal(readerReads, 1, 'only the original native read begins before abort');
        assert.equal(readerCancels, 1, 'aborted native clone cancellation starts once');
        assert.equal(originalCancels, 1, 'aborted native original cancellation starts once');
        releaseLate();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(lateResultReturned, true, 'the withheld actual native read result was released');
        assert.equal(readerReads, 1, 'late positive read cannot begin another read or inject loss');
        assert.equal(readerCancels, 1, 'late continuation cannot restart clone cancellation');
        assert.equal(originalCancels, 1, 'late continuation cannot restart original cancellation');
      } finally { abortRequest(); releaseLate?.(); }
      throw Error('fixture_aborted_late_read_observed');
    },
  });
  await assert.rejects(runLocalLossProbe(probe), /^Error: fixture_aborted_late_read_observed$/);
});

// Controlled public-runLoad diagnostics only; these callbacks do not model real retry policy.
test('local load diagnostics count fixed HTTP status buckets before receipt inspection', async () => {
  const probe = localLossProbe({
    firstResponse({ frame, commit }) {
      commit(frame);
      return new Response('fixture temporary failure', { status: 503 });
    },
    async exerciseFirst({ invoke }) {
      const first = await invoke();
      assert.equal(first.status, 503);
      assert.equal(await first.text(), 'fixture temporary failure');
      await assert.rejects(invoke(), /^TypeError: local_injected_response_loss$/);
      return (await (await invoke()).json()).receipt;
    },
  });
  const report = await runLocalLossProbe(probe);
  assert.deepEqual(report.response_loss_diagnostic.http_status_counts, {
    ok200: 2, other2xx: 0, redirect3xx: 0, retry408: 0, retry429: 0,
    other4xx: 0, server5xx: 1, other: 0,
  }, 'actual non200 status must be observed before the eligible200 inspection branch');
  assert.equal(report.response_loss_diagnostic.fetch_errors, 0);
  assert.deepEqual(report.response_loss_diagnostic.last_http, {
    request_ordinal: 3, status: 'ok200', request_aborted: false,
  });
  assert.deepEqual(report.response_loss_diagnostic.final_receipt, {
    receipt: 'already_accepted', event_match: true,
  });
  assert.equal(report.response_loss_injected, true);
  assert.equal(report.replay_same_event, true);
  assert.equal(report.lost_votes, 0);
});

test('local load diagnostics count fetch errors without changing the original error or exposing its text', async () => {
  const sentinel = new Error('untrusted-fetch-diagnostic-marker');
  const probe = localLossProbe({
    firstResponse({ frame, commit }) { commit(frame); throw sentinel; },
    async exerciseFirst({ invoke }) {
      await assert.rejects(invoke(), error => error === sentinel);
      await assert.rejects(invoke(), /^TypeError: local_injected_response_loss$/);
      return (await (await invoke()).json()).receipt;
    },
  });
  const report = await runLocalLossProbe(probe);
  assert.equal(report.response_loss_diagnostic.fetch_errors, 1,
    'a fetch rejection must be counted without being converted into an inspected receipt');
  assert.deepEqual(report.response_loss_diagnostic.http_status_counts, {
    ok200: 2, other2xx: 0, redirect3xx: 0, retry408: 0, retry429: 0,
    other4xx: 0, server5xx: 0, other: 0,
  });
  assert.equal(report.response_loss_diagnostic.inspected, 1);
  assert.deepEqual(report.response_loss_diagnostic.final_receipt, {
    receipt: 'already_accepted', event_match: true,
  });
  assert.equal(JSON.stringify(report.response_loss_diagnostic).includes(sentinel.message), false);
  assert.equal(report.replay_same_event, true);
  assert.equal(report.lost_votes, 0);
});

test('local load failure diagnostics retain a fixed final receipt and no-inspection HTTP evidence', async () => {
  const privateMarker = 'untrusted-response-and-reason-marker';
  const probe = localLossProbe({
    firstResponse({ frame, commit }) {
      commit(frame);
      return new Response(privateMarker, { status: 503 });
    },
    async exerciseFirst({ invoke, frame }) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await invoke();
        assert.equal(response.status, 503);
        assert.equal(await response.text(), privateMarker);
      }
      return { receipt: 'timeout', clientEventId: frame.clientEventId, reason: privateMarker };
    },
  });
  const actualFetch = probe.options.fetchImpl;
  probe.options.fetchImpl = async (url, init) => {
    const response = await actualFetch(url, init);
    if (init.headers['x-fixture-phone'] === 'first' && response.status === 200) {
      await response.arrayBuffer(); // finite test-owned body, not diagnostic content
      return new Response(privateMarker, { status: 503 });
    }
    return response;
  };
  const errors = [];
  const originalError = console.error;
  console.error = value => errors.push(value);
  try {
    await assert.rejects(runLocalLossProbe(probe), /^Error: load_loss_replay_missing$/);
  } finally { console.error = originalError; }
  assert.equal(errors.length, 1);
  const diagnostic = JSON.parse(errors[0]);
  assert.deepEqual(diagnostic.final_receipt, { receipt: 'timeout', event_match: true },
    'failure evidence must classify the actual final receipt without inventing acceptance');
  assert.deepEqual(diagnostic.http_status_counts, {
    ok200: 0, other2xx: 0, redirect3xx: 0, retry408: 0, retry429: 0,
    other4xx: 0, server5xx: 2, other: 0,
  });
  assert.equal(diagnostic.fetch_errors, 0);
  assert.deepEqual(diagnostic.last_http, {
    request_ordinal: 2, status: 'server5xx', request_aborted: false,
  });
  assert.equal(diagnostic.inspected, 0);
  assert.equal(diagnostic.last, null);
  assert.deepEqual(diagnostic.replay_predicates, {
    response_dropped: false, requests_repeated: true, request_ids_equal: true,
    matching_replay_receipt: false,
  });
  assert.equal(errors[0].includes(privateMarker), false);
  assert.deepEqual(Object.keys(diagnostic.final_receipt).sort(), ['event_match', 'receipt']);
  assert.equal(probe.calls.closed, 51);
  assert.equal(probe.calls.stopped, 1);
});

// Optional local Node:test cancellation; no new timer or production retry policy.
test('local load cancellation refuses a pre-aborted signal before acquiring any Worker or link', async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = fakeLocalLossSelection();
  await assert.rejects(loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 },
    { ...fixture, signal: controller.signal }), /^Error: load_aborted$/,
    'an already cancelled local load must refuse before any owned acquisition');
  assert.equal(fixture.observations.closed, 0);
  assert.equal(fixture.observations.stopped, 0);
  assert.equal(fixture.observations.requestIds.length, 0);
});

test('local load cancellation closes registered links and the Worker before accepting a late pending vote', async () => {
  const controller = new AbortController();
  let entered, release, othersHeld, releaseOthers, heldOtherPhones = 0, settled = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const othersReady = new Promise(resolve => { othersHeld = resolve; });
  const othersReleased = new Promise(resolve => { releaseOthers = resolve; });
  const probe = localLossProbe({
    firstResponse({ frame, commit }) { commit(frame); return new Response('temporary', { status: 503 }); },
    async exerciseFirst({ invoke, frame }) {
      const response = await invoke();
      assert.equal(response.status, 503);
      await response.text();
      entered();
      return new Promise(resolve => { release = () => resolve({ v: 1, t: 'receipt', receipt: 'accepted',
        clientEventId: frame.clientEventId, epoch: frame.epoch, revision: 1 }); });
    },
  });
  const connect = probe.options.connectImpl;
  probe.options.connectImpl = options => {
    const link = connect(options);
    if (options.role === 'participant' && options.slot !== 'load-0') {
      const send = link.sendFrame.bind(link);
      link.sendFrame = async frame => {
        const receipt = await send(frame);
        if (++heldOtherPhones === 49) othersHeld();
        await othersReleased;
        return receipt;
      };
    }
    return link;
  };
  const pending = loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 },
    { ...probe.options, signal: controller.signal });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.all([ready, othersReady]);
  assert.equal(heldOtherPhones, 49, 'all other phone callbacks remain held after receiving their receipts');
  assert.equal(settled, false, 'all vote callbacks remain pending before abort');
  try {
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probe.calls.closed, 51, 'abort closes every registered link exactly once');
    assert.equal(probe.calls.stopped, 1, 'known Worker stops before late vote settlement');
  } finally {
    release();
    releaseOthers();
    await pending.catch(() => {});
  }
  await assert.rejects(pending, /^Error: load_aborted$/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probe.calls.closed, 51);
  assert.equal(probe.calls.stopped, 1);
});

test('local load cancellation retains ownership until a late Worker is stopped without creating a room', async () => {
  const controller = new AbortController();
  let entered, release, settled = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const calls = { stopped: 0, rooms: 0, connected: 0 };
  const pending = loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 }, {
    signal: controller.signal,
    startLocal: () => { entered(); return new Promise(resolve => { release = resolve; }); },
    createLocalRoom: () => { calls.rooms++; throw Error('unexpected_room_after_abort'); },
    connectImpl: () => { calls.connected++; throw Error('unexpected_connect_after_abort'); },
  });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await ready;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'unknown startup ownership cannot be declared terminal');
  release({ origin: 'http://127.0.0.1:43220', async stop() { calls.stopped++; } });
  await assert.rejects(pending, /^Error: load_aborted$/);
  assert.deepEqual(calls, { stopped: 1, rooms: 0, connected: 0 },
    'late Worker is stopped before any post-acquisition phase can begin');
});

test('local load cancellation prevents a new join wave after aborted joins settle late', async () => {
  const controller = new AbortController();
  const fixture = fakeLocalLossSelection();
  const originalConnect = fixture.connectImpl;
  let entered, joins = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const releases = [];
  fixture.connectImpl = options => {
    const link = originalConnect(options);
    if (options.role === 'participant') link.join = () => {
      joins++;
      if (joins > 25) return Promise.resolve({ ok: false, error: 'network' });
      const pending = new Promise(resolve => { releases.push(() => resolve({ ok: true })); });
      if (joins === 25) entered();
      return pending;
    };
    return link;
  };
  const pending = loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 150, rounds: 1 },
    { ...fixture, signal: controller.signal });
  pending.catch(() => {});
  await ready;
  controller.abort();
  for (const release of releases) release();
  await assert.rejects(pending, /^Error: load_aborted$/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(joins, 25, 'aborted setup must never start the next join wave');
  assert.equal(fixture.observations.closed, 151);
  assert.equal(fixture.observations.stopped, 1);
});

test('local load cancellation removes its signal handler after successful owned cleanup', async () => {
  const controller = new AbortController();
  let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, ...args) => { if (type === 'abort') added++; return add(type, ...args); };
  controller.signal.removeEventListener = (type, ...args) => { if (type === 'abort') removed++; return remove(type, ...args); };
  const fixture = fakeLocalLossSelection();
  const report = await loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 },
    { ...fixture, signal: controller.signal });
  assert.equal(report.lost_votes, 0);
  assert.equal(report.replay_same_event, true);
  assert.equal(added, 1);
  assert.equal(removed, 1, 'completed load must remove its external abort listener');
  controller.abort();
  assert.equal(fixture.observations.closed, 51);
  assert.equal(fixture.observations.stopped, 1);

  const stoppingController = new AbortController();
  const stoppingFixture = fakeLocalLossSelection();
  const start = stoppingFixture.startLocal;
  let enteredStop, releaseStop, settled = false;
  const stopEntered = new Promise(resolve => { enteredStop = resolve; });
  const stopRelease = new Promise(resolve => { releaseStop = resolve; });
  stoppingFixture.startLocal = async () => {
    const worker = await start();
    const stop = worker.stop.bind(worker);
    worker.stop = async () => { await stop(); enteredStop(); await stopRelease; };
    return worker;
  };
  const stopping = loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 },
    { ...stoppingFixture, signal: stoppingController.signal });
  stopping.then(() => { settled = true; }, () => { settled = true; });
  await stopEntered;
  stoppingController.abort();
  assert.equal(settled, false, 'finite owned stop must settle before caller refusal');
  releaseStop();
  await assert.rejects(stopping, /^Error: load_aborted$/,
    'abort during owned cleanup must refuse a successful load report');
  assert.equal(stoppingFixture.observations.closed, 51);
  assert.equal(stoppingFixture.observations.stopped, 1);
});

test('local load cancellation refuses success on an owned close failure while still stopping the Worker', async () => {
  const controller = new AbortController();
  const fixture = fakeLocalLossSelection();
  const connect = fixture.connectImpl;
  fixture.connectImpl = options => {
    const link = connect(options);
    if (options.slot === 'load-0') {
      const close = link.close.bind(link);
      link.close = () => { close(); throw Error('untrusted-close-failure-marker'); };
    }
    return link;
  };
  await assert.rejects(loadRoom.runLoad({ target: { kind: 'local', origin: null }, clients: 50, rounds: 1 },
    { ...fixture, signal: controller.signal }), /^Error: load_link_cleanup_failed$/,
    'failed owned cleanup cannot be reported as a successful load');
  assert.equal(fixture.observations.closed, 51);
  assert.equal(fixture.observations.stopped, 1);
});
