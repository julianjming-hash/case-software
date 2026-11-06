// scripts/load-room.mjs: owner-invoked pilot load harness. Local is the default; staging is opt-in.
// This script never permits the production origin and tests never call a deployed origin.
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../src/client/transport.mjs';
import { uuidv7, isUuidV7, normalizeCode, JOIN_CODE_LENGTH } from '../src/shared/ids.mjs';
import { apiUrl } from '../src/shared/urls.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';
import { resolvePilotTarget } from './pilot-target.mjs';

export function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1)];
}

export function parseOptions(args) {
  const options = { target: null, own: false, clients: 50, rounds: 1 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--i-own-this-origin') { options.own = true; continue; }
    if (!['--target', '--clients', '--rounds'].includes(flag)) throw new Error(`unknown option ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--target') options.target = value;
    else if (flag === '--clients') options.clients = Number(value);
    else options.rounds = Number(value);
  }
  const target = resolvePilotTarget(options);
  if (!Number.isInteger(options.clients) || options.clients < 50 || options.clients > 200) throw new Error('--clients must be an integer from 50 to 200');
  if (!Number.isInteger(options.rounds) || options.rounds < 1) throw new Error('--rounds must be a positive integer');
  return { target, clients: options.clients, rounds: options.rounds };
}

export function summarizeLoad({ clients, rounds, expectedIds, receipts, fanoutLagMs }) {
  if (!Array.isArray(fanoutLagMs) || !fanoutLagMs.length ||
      fanoutLagMs.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('fan-out was not observed');
  const expected = new Set(expectedIds);
  const successful = new Set();
  const elapsed = [];
  for (const item of receipts) {
    if (!expected.has(item.clientEventId) || successful.has(item.clientEventId) ||
        !['accepted', 'already_accepted'].includes(item.receipt) ||
        !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0) continue;
    successful.add(item.clientEventId);
    elapsed.push(item.elapsedMs);
  }
  return {
    clients, rounds, expected_votes: expected.size, receipted_votes: successful.size,
    lost_votes: expected.size - successful.size,
    acknowledgement_ms: Object.fromEntries([50, 95, 99].map(p => [`p${p}`, percentile(elapsed, p)])),
    fanout_lag_ms: Object.fromEntries([50, 95, 99].map(p => [`p${p}`, percentile(fanoutLagMs, p)])),
  };
}

/** Measured latencies for a failed gate: a bare "exceeded" cannot tell a near miss from a stall. */
export const latencySummary = ms => ['p50', 'p95', 'p99'].map(key => `${key}=${Number.isFinite(ms?.[key]) ? Math.round(ms[key]) : 'none'}ms`).join(' ');

export function assertLoadGate(report) {
  if (report.lost_votes !== 0) throw new Error('load:room lost_votes');
  if (report.clients === 50 && !(report.acknowledgement_ms.p95 < 1000))
    throw new Error(`load:room 50-phone p95 exceeded 1000ms (${latencySummary(report.acknowledgement_ms)})`);
  return report;
}

/** Bound only the 150-phone admission burst; all admitted phones remain live for concurrent votes. */
export async function joinPhonesInWaves(phones, joinOne, waveSize) {
  const results = [];
  for (let start = 0; start < phones.length; start += waveSize) {
    results.push(...await Promise.all(phones.slice(start, start + waveSize).map((phone, offset) => joinOne(phone, start + offset))));
  }
  return results;
}

const JOIN_FAILURE_CODES = new Set([
  'network', 'closed', 'rate_limited', 'challenge_required', 'challenge_failed',
  'unknown_code', 'unknown_room', 'room_full', 'room_ended', 'room_expired',
  'http_429', 'http_500', 'http_503',
]);
export function safeJoinFailureCode(value) {
  return JOIN_FAILURE_CODES.has(value) ? value : 'unknown';
}

const DEADLINE_MS = 10_000;
const MAX_JSON_BYTES = 64 * 1024;
const LOCAL_VOTE_LATENCY_MS = 8;

function isRoomCapability(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  try {
    const bytes = atob(token.replace(/-/g, '+').replace(/_/g, '/') + '=');
    return bytes.length === 32 && btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === token;
  } catch { return false; }
}

export async function fetchFixedJson(fetchImpl, url, { deadlineMs = DEADLINE_MS, ...init } = {}) {
  const controller = new AbortController();
  let reader;
  let timer;
  let terminal = false, cancellationStarted = false;
  const cancel = body => {
    const target = reader ?? body;
    if (!target || cancellationStarted) return;
    cancellationStarted = true;
    try { void target.cancel().catch(() => {}); } catch { /* already closed */ }
  };
  const requireActive = () => {
    if (terminal) { cancel(); throw new Error('load_deadline'); }
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { terminal = true; controller.abort();
      cancel();
      reject(new Error('load_deadline')); }, deadlineMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
      if (terminal) { cancel(response.body); throw new Error('load_deadline'); }
      if (!response.ok) { cancel(response.body);
        throw new Error(`load_http_${response.status}`); }
      if (!response.body) throw new Error('load_empty_body');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        requireActive();
        const { done, value } = await reader.read();
        requireActive();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JSON_BYTES) throw new Error('load_body_too_large');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let cursor = 0;
      for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    })(), deadline]);
  } finally {
    clearTimeout(timer);
    terminal = true;
    controller.abort();
    cancel();
  }
}

// Inspect only a clone of the one local loss candidate. Forward unselected original bodies.
// Clone inspection uses the harness 64KiB/10s constants; the actual request abort wins sooner.
async function inspectLocalLossReceipt(response, command, requestSignal) {
  const observation = { inspection: 'not_started', receipt: 'other',
    version_match: false, type_match: false, event_match: false, epoch_match: false,
    revision_valid: false, body_consumed: false, qualified: false };
  if (requestSignal?.aborted) return { ...observation, inspection: 'request_aborted' };
  let clone, reader, timer, terminal = false, terminalCode = 'request_aborted', cancellationStarted = false;
  let rejectTerminal;
  const cancel = () => {
    const target = reader ?? clone?.body;
    if (!target || cancellationStarted) return;
    cancellationStarted = true;
    try { void target.cancel().catch(() => {}); } catch { /* already closed */ }
  };
  const terminate = code => {
    if (terminal) return;
    terminal = true;
    terminalCode = code;
    cancel();
    rejectTerminal(new Error(code));
  };
  const requireActive = () => {
    if (requestSignal?.aborted) terminate('request_aborted');
    if (terminal) throw new Error(terminalCode);
  };
  const aborted = () => terminate('request_aborted');
  const terminalPromise = new Promise((_, reject) => { rejectTerminal = reject; });
  requestSignal?.addEventListener('abort', aborted, { once: true });
  timer = setTimeout(() => terminate('deadline'), DEADLINE_MS);
  try {
    const body = await Promise.race([(async () => {
      requireActive();
      clone = response.clone();
      requireActive();
      if (!clone.body) throw new Error('invalid_body');
      reader = clone.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        requireActive();
        const { done, value } = await reader.read();
        requireActive();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JSON_BYTES) throw new Error('body_too_large');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let cursor = 0;
      for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
      observation.body_consumed = true;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    })(), terminalPromise]);
    requireActive();
    const receipt = body?.receipt;
    observation.inspection = 'ok';
    observation.receipt = ['accepted', 'already_accepted', 'rejected'].includes(receipt?.receipt)
      ? receipt.receipt : 'other';
    observation.version_match = receipt?.v === 1;
    observation.type_match = receipt?.t === 'receipt';
    observation.event_match = isUuidV7(receipt?.clientEventId) && receipt.clientEventId === command.clientEventId;
    observation.epoch_match = Number.isInteger(receipt?.epoch) && receipt.epoch === command.epoch;
    observation.revision_valid = Number.isInteger(receipt?.revision) && receipt.revision >= 0;
    observation.qualified = ['accepted', 'already_accepted'].includes(observation.receipt) &&
      observation.version_match && observation.type_match && observation.event_match &&
      observation.epoch_match && observation.revision_valid;
  } catch (error) {
    observation.inspection = ['request_aborted', 'deadline', 'body_too_large'].includes(error?.message)
      ? error.message : 'invalid_body';
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener('abort', aborted);
    terminal = true;
    cancel();
  }
  return observation;
}

async function until(predicate, code, ms = 30_000, signal = null) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (signal?.aborted) throw new Error('load_aborted');
    const result = predicate();
    if (signal?.aborted) throw new Error('load_aborted');
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (signal?.aborted) throw new Error('load_aborted');
  throw new Error(code);
}

/** The Name & role a staging load room starts with ("Facilitator on record (this session)"), so the disclosure oracle knows the
 *  exact label an ended phone's recap must carry and that nothing shows before End. */
export const LOAD_FACILITATOR = Object.freeze({ name: 'Load test', role: 'Simulation' });

export async function stageRoom(origin, environment, fetchImpl, { own = false } = {}) {
  if (resolvePilotTarget({ target: origin, own }).kind !== 'staging') throw new Error('target refused');
  // Target admission happens before this function. Never print, persist or put these in a URL.
  const token = environment.CASE_LOAD_AUTH_TOKEN;
  const caseVersionId = environment.CASE_LOAD_CASE_VERSION_ID;
  const workspaceId = environment.CASE_LOAD_WORKSPACE_ID;
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
      !isUuidV7(caseVersionId) || !isUuidV7(workspaceId)) throw new Error('staging_unconfigured');
  const version = await fetchFixedJson(fetchImpl, apiUrl(origin, 'version'), { method: 'GET' });
  if (version?.env !== 'staging' || !/^[0-9a-f]{40}$/.test(version.build ?? ''))
    throw new Error('staging_version_unverified');
  let response;
  try {
    response = await fetchFixedJson(fetchImpl, apiUrl(origin, 'sessions'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ caseVersionId, workspaceId, ttlMinutes: 60, facilitator: LOAD_FACILITATOR }),
    });
  } catch (error) {
    // A timed-out or malformed response cannot prove that room creation did not commit.
    error.stagePostAttempted = true;
    throw error;
  }
  if (!isUuidV7(response?.sessionId) || typeof response?.joinCode !== 'string' ||
      normalizeCode(response.joinCode, JOIN_CODE_LENGTH) !== response.joinCode ||
      !isRoomCapability(response?.facilitatorToken)) {
    const error = new Error('staging_room_invalid');
    error.stagePostAttempted = true;
    throw error;
  }
  return response;
}

async function openFirstDecision(facilitator, awaitPhase, signal) {
  const start = await awaitPhase(() => facilitator.send('start'));
  if (start.receipt !== 'accepted') throw new Error('load_start_refused');
  await awaitPhase(() => until(() => facilitator.snapshot?.revision >= start.revision, 'load_start_snapshot_missing', undefined, signal));
  for (let step = 0; step < 24; step += 1) {
    if (facilitator.snapshot?.view?.phase === 'responses_open' && facilitator.snapshot.view.round?.id) return;
    if (facilitator.snapshot?.view?.phase !== 'surface_live') throw new Error('load_decision_unavailable');
    const next = await awaitPhase(() => facilitator.send('advance'));
    if (next.receipt !== 'accepted') throw new Error('load_context_refused');
    await awaitPhase(() => until(() => facilitator.snapshot?.revision >= next.revision, 'load_context_snapshot_missing', undefined, signal));
  }
  throw new Error('load_context_limit');
}

async function confirmStagingEnd(facilitator, deadlineMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('staging_end_unconfirmed')), deadlineMs);
  });
  try {
    const receipt = await Promise.race([facilitator.send('end'), deadline]);
    if (!['accepted', 'already_accepted'].includes(receipt?.receipt)) throw new Error('staging_end_unconfirmed');
  } finally {
    clearTimeout(timer);
    try { facilitator.dropPending?.(); } catch { /* closing */ }
  }
}

/** Actual Worker and client transport, with one deterministic lost HTTP vote response locally. */
export async function runLoad({ target, clients, rounds }, { environment = process.env,
  fetchImpl = globalThis.fetch.bind(globalThis), connectImpl = connect, startLocal, createLocalRoom,
  cleanupDeadlineMs = DEADLINE_MS, signal = null } = {}) {
  const selected = resolvePilotTarget({ target: target?.origin ?? null, own: target?.kind === 'staging' });
  if (signal && selected.kind !== 'local') throw new Error('load_abort_signal_local_only');
  if (!Number.isInteger(clients) || clients < 50 || clients > 200 || !Number.isInteger(rounds) || rounds < 1)
    throw new Error('load_options_invalid');
  let worker;
  let localHelpers;
  let facilitator;
  let stagingRoomCreated = false;
  let primaryError = null;
  const links = [];
  const closedLinks = new Set();
  let closeFailures = 0;
  let startingWorker = null;
  let origin;
  const aborted = new Error('load_aborted');
  let rejectAbort;
  const cancellation = new Promise((_, reject) => { rejectAbort = reject; });
  // An abort can arrive between phases; observing it must not create an unhandled rejection.
  cancellation.catch(() => {});
  const requireActive = () => { if (signal?.aborted) throw aborted; };
  const closeOwnedLinks = () => {
    for (const link of links) if (!closedLinks.has(link)) {
      closedLinks.add(link);
      try { link.close(); } catch { closeFailures++; }
    }
  };
  const onAbort = () => { closeOwnedLinks(); rejectAbort(aborted); };
  const ownLink = link => {
    links.push(link);
    if (signal?.aborted) { closeOwnedLinks(); throw aborted; }
    return link;
  };
  const awaitPhase = async invoke => {
    requireActive();
    const pending = invoke();
    const result = await (signal ? Promise.race([pending, cancellation]) : pending);
    requireActive();
    return result;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    requireActive();
    let room;
    if (selected.kind === 'local') {
      localHelpers = await awaitPhase(() => import('../tests/helpers/local-worker.mjs'));
      // Direct workerd, without wrangler dev's ProxyWorker, which drops connections under vote bursts (AS-097).
      const { startDirectWorker } = await awaitPhase(() => import('../tests/helpers/direct-worker.mjs'));
      worker = await awaitPhase(() => {
        startingWorker = Promise.resolve((startLocal ?? startDirectWorker)())
          .then(created => { worker = created; return created; });
        return startingWorker;
      });
      origin = worker.origin;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('local_worker_origin_invalid');
      room = await awaitPhase(() => (createLocalRoom ?? localHelpers.createRoom)(origin));
    } else {
      origin = selected.origin;
      room = await stageRoom(origin, environment, fetchImpl, { own: true });
      stagingRoomCreated = true;
    }
    const guardedFetch = (url, init = {}) => {
      requireActive();
      if (new URL(String(url)).origin !== origin) throw new Error('load_cross_origin_refused');
      return fetchImpl(url, { ...init, redirect: 'manual' });
    };
    facilitator = ownLink(connectImpl({ role: 'facilitator', api: origin, sessionId: room.sessionId,
      // Real product timings (CASE-154): a compressed 1 s request deadline caused retry storms on slow hosts.
      token: room.facilitatorToken, fetchImpl: guardedFetch, timeScale: 1 }));
    let observed = { revision: -1, at: performance.now() };
    facilitator.on('snapshot', snapshot => { observed = { revision: snapshot.revision, at: performance.now() }; });
    await awaitPhase(() => until(() => facilitator.snapshot?.view, 'load_facilitator_unavailable', undefined, signal));

    let droppedResponse = false;
    let injectedVoteRequests = 0;
    let firstPhoneVoteId = null;
    const firstPhoneVoteIds = [];
    const lossObservations = { inspected: 0, selected_receipt: 'other',
      last: null, request_aborted: 0, inspection_deadline: 0,
      http_status_counts: { ok200: 0, other2xx: 0, redirect3xx: 0, retry408: 0, retry429: 0,
        other4xx: 0, server5xx: 0, other: 0 }, fetch_errors: 0, last_http: null, final_receipt: null };
    const phones = Array.from({ length: clients }, (_, index) => {
      const phoneFetch = async (url, init = {}) => {
        const command = selected.kind === 'local' && init.method === 'POST' &&
          new URL(String(url)).pathname.endsWith('/commands') ? JSON.parse(init.body) : null;
        let firstVoteRequestOrdinal = null;
        if (command?.type === 'vote') {
          injectedVoteRequests++;
          if (index === 0) {
            firstPhoneVoteId ??= command.clientEventId;
            if (command.clientEventId === firstPhoneVoteId) {
              firstPhoneVoteIds.push(command.clientEventId);
              firstVoteRequestOrdinal = firstPhoneVoteIds.length;
            }
          }
          await new Promise(resolve => setTimeout(resolve, LOCAL_VOTE_LATENCY_MS));
        }
        let result;
        try { result = await guardedFetch(url, init); }
        catch (error) {
          if (firstVoteRequestOrdinal !== null) {
            lossObservations.fetch_errors++;
            lossObservations.last_http = { request_ordinal: firstVoteRequestOrdinal,
              status: 'fetch_error', request_aborted: init.signal?.aborted === true };
          }
          throw error;
        }
        if (firstVoteRequestOrdinal !== null) {
          const statusBucket = result.status === 200 ? 'ok200' : result.status === 408 ? 'retry408' :
            result.status === 429 ? 'retry429' : result.status >= 200 && result.status < 300 ? 'other2xx' :
            result.status >= 300 && result.status < 400 ? 'redirect3xx' :
            result.status >= 400 && result.status < 500 ? 'other4xx' :
            result.status >= 500 && result.status < 600 ? 'server5xx' : 'other';
          lossObservations.http_status_counts[statusBucket]++;
          lossObservations.last_http = { request_ordinal: firstVoteRequestOrdinal,
            status: statusBucket, request_aborted: init.signal?.aborted === true };
        }
        if (index === 0 && command?.type === 'vote' && command.clientEventId === firstPhoneVoteId &&
            !droppedResponse && result.status === 200) {
          const observation = await inspectLocalLossReceipt(result, command, init.signal);
          lossObservations.inspected++;
          lossObservations.last = { request_ordinal: firstVoteRequestOrdinal, ...observation };
          if (observation.inspection === 'request_aborted' || init.signal?.aborted || observation.inspection === 'deadline') {
            if (observation.inspection === 'deadline') lossObservations.inspection_deadline++;
            else lossObservations.request_aborted++;
            try { void result.body?.cancel().catch(() => {}); } catch { /* already closed */ }
            throw new TypeError('local_response_inspection_aborted');
          }
          if (observation.qualified) {
            droppedResponse = true;
            lossObservations.selected_receipt = observation.receipt;
            // The actual native clone was fully consumed and validated. Cancel its original
            // sibling without waiting; never let tee cancellation delay the intended loss.
            try { void result.body?.cancel().catch(() => {}); } catch { /* already closed */ }
            throw new TypeError('local_injected_response_loss');
          }
        }
        return result;
      };
      const phone = ownLink(connectImpl({ role: 'participant', slot: `load-${index}`, api: origin,
        fetchImpl: phoneFetch, timeScale: 1 }));
      return phone;
    });
    const joinOne = (phone, index) => {
      requireActive();
      return phone.join(room.joinCode,
        `Phone ${String(index + 1).padStart(3, '0')}`, AVATAR_IDS[index % AVATAR_IDS.length]);
    };
    const joined = await awaitPhase(() => clients === 150
      ? joinPhonesInWaves(phones, joinOne, 25) : Promise.all(phones.map(joinOne)));
    if (joined.some(result => !result.ok)) {
      const counts = {};
      for (const result of joined) if (!result.ok) {
        const code = safeJoinFailureCode(result.error);
        counts[code] = (counts[code] ?? 0) + 1;
      }
      throw new Error(`load_join_failed:${JSON.stringify(counts)}`);
    }
    try {
      await awaitPhase(() => until(() => facilitator.snapshot?.view?.participants?.length === clients, 'load_join_fanout_missing', undefined, signal));
    } catch (error) {
      if (selected.kind !== 'local' || error.message !== 'load_join_fanout_missing') throw error;
      const authoritative = await localHelpers.serverMirror(origin, room);
      throw new Error(`load_join_fanout_missing:observed=${facilitator.snapshot?.view?.participants?.length ?? 0}:authoritative=${Object.keys(authoritative.participants).length}:mode=${facilitator.mode}`);
    }
    await awaitPhase(() => openFirstDecision(facilitator, awaitPhase, signal));
    await awaitPhase(() => until(() => phones.every(phone => phone.snapshot?.view?.decision?.roundId === facilitator.snapshot.view.round.id),
      'load_decision_fanout_missing', undefined, signal));

    const expectedIds = [];
    const receipts = [];
    const fanoutLagMs = [];
    for (let round = 0; round < rounds; round += 1) {
      const results = await awaitPhase(() => Promise.all(phones.map(async (phone, index) => {
        const view = phone.snapshot.view;
        const clientEventId = uuidv7();
        expectedIds.push(clientEventId);
        const started = performance.now();
        const receipt = await awaitPhase(() => phone.sendFrame({ v: 1, t: 'command', type: 'vote',
          epoch: phone.snapshot.epoch, clientEventId, roundId: view.decision.roundId,
          response: { option_id: view.decision.interaction.options[round % view.decision.interaction.options.length].id } }));
        const elapsedMs = performance.now() - started;
        if (index === 0 && clientEventId === firstPhoneVoteId) {
          lossObservations.final_receipt = {
            receipt: ['accepted', 'already_accepted', 'rejected', 'timeout', 'dropped'].includes(receipt?.receipt)
              ? receipt.receipt : 'other',
            event_match: receipt?.clientEventId === clientEventId,
          };
        }
        if (['accepted', 'already_accepted'].includes(receipt.receipt) && receipt.clientEventId !== clientEventId)
          throw new Error('load_receipt_identity_mismatch');
        if (!['accepted', 'already_accepted'].includes(receipt.receipt)) return { clientEventId: receipt.clientEventId, receipt: receipt.receipt, elapsedMs };
        const receivedAt = performance.now();
        await awaitPhase(() => until(() => observed.revision >= receipt.revision, 'load_vote_fanout_missing', undefined, signal));
        // A snapshot may arrive before the HTTP receipt. Zero then means genuinely observed by
        // the facilitator before receipt, not a fabricated missing-data fallback.
        fanoutLagMs.push(Math.max(0, observed.at - receivedAt));
        return { clientEventId: receipt.clientEventId, receipt: receipt.receipt, elapsedMs };
      })));
      receipts.push(...results);
      await awaitPhase(() => until(() => facilitator.snapshot?.mirror?.round &&
        Object.keys(facilitator.snapshot.mirror.round.responses).length === clients,
      'load_recorded_vote_count_mismatch', undefined, signal));
    }
    const report = summarizeLoad({ clients, rounds, expectedIds, receipts, fanoutLagMs });
    const replayPredicates = { response_dropped: droppedResponse, requests_repeated: firstPhoneVoteIds.length >= 2,
      request_ids_equal: firstPhoneVoteIds.every(id => id === firstPhoneVoteIds[0]),
      matching_replay_receipt: receipts.some(item => item.clientEventId === firstPhoneVoteIds[0] && item.receipt === 'already_accepted') };
    const replaySameEvent = selected.kind === 'local' && Object.values(replayPredicates).every(Boolean);
    const lossDiagnostic = { ...lossObservations,
      http_status_counts: { ...lossObservations.http_status_counts }, replay_predicates: replayPredicates };
    if (selected.kind === 'local' && !replaySameEvent) {
      console.error(JSON.stringify({ event: 'load_loss_replay_missing', ...lossDiagnostic }));
      throw new Error('load_loss_replay_missing');
    }
    const transportModes = {};
    for (const phone of phones) transportModes[phone.mode] = (transportModes[phone.mode] ?? 0) + 1;
    return assertLoadGate({ ...report, response_loss_injected: droppedResponse,
      replay_same_event: replaySameEvent, response_loss_diagnostic: selected.kind === 'local' ? lossDiagnostic : null, injected_vote_latency_ms: selected.kind === 'local' ? LOCAL_VOTE_LATENCY_MS : 0,
      injected_vote_requests: injectedVoteRequests, transport_modes: transportModes });
  } catch (error) {
    if (selected.kind === 'staging' && error?.stagePostAttempted) stagingRoomCreated = true;
    primaryError = error;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    let cleanupFailure = null;
    if (selected.kind === 'staging' && stagingRoomCreated) {
      if (facilitator) {
        try { await confirmStagingEnd(facilitator,
          Number.isInteger(cleanupDeadlineMs) && cleanupDeadlineMs > 0 ? cleanupDeadlineMs : DEADLINE_MS); }
        catch { cleanupFailure = 'staging_end_unconfirmed'; }
      } else cleanupFailure = 'staging_room_ttl_fallback';
    }
    closeOwnedLinks();
    // Acquisition is owned until it settles. A late Worker must be stopped before caller settlement.
    if (startingWorker && !worker) {
      try { await startingWorker; } catch { /* factory retains its existing failure cleanup */ }
    }
    await worker?.stop();
    if (signal && closeFailures) cleanupFailure ??= 'link_cleanup_failed';
    if (cleanupFailure) {
      const fixed = new Error(`load_${cleanupFailure}`);
      if (primaryError) throw new AggregateError([primaryError, fixed], fixed.message);
      throw fixed;
    }
    if (!primaryError) requireActive();
  }
}

// `import.meta.main` exists only from Node 22.18 / 24.2; package.json allows 22.5, where it is undefined
// and the CLI silently did nothing and exited 0.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const args=process.argv.slice(2);
    if(args.includes('--rounds'))return runLoad(parseOptions(args));
    const {parseSimulation,admitSimulation,runSimulatedRooms}=await import('./simulated-rooms.mjs');
    const options=parseSimulation(args);
    admitSimulation(options);
    let environment=process.env;
    if(options.target.kind==='staging'){
      const {stdinToken}=await import('./usage-window.mjs');
      environment={...process.env,CASE_LOAD_AUTH_TOKEN:await stdinToken()};
    }
    return runSimulatedRooms(options,{environment});
  }).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(`load:room — ${/^load_|^staging_|^target |^ownership |^missing /.test(error.message) ? error.message : 'load_failed'}`);
    process.exitCode = 1;
  });
}
