// Isolated design spike. This module is never imported by a served client or Worker.
// Uses the real archive schema/adapter to test the proposed private evidence boundary.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { normaliseResponse, reduce } from '../../src/shared/room-machine.mjs';
import { suggestPath } from '../../src/shared/case-document.mjs';
import { writeArchiveState, migrateArchive } from '../../src/worker/room-archive.mjs';

export const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const stateBytes = ({ caseDoc, ...state }) => bytes(state);
export const TOTAL_LIMIT = 1_000_000;
export const ACTION_LIMIT = 64;
export const ACTION_BYTES = 64 * 1024;

export function remainingAtLock(timer, lockAt) {
  if (!timer) return 0;
  return Math.max(0, timer.remainingS ?? Math.round(timer.durationS - (Date.parse(lockAt) - Date.parse(timer.startedAt)) / 1000));
}

export function compactRound(round) {
  // Historical answers AND aggregate inventories live in durable evidence, not control state.
  const { responses, answers, aggregate, suggestion, ...control } = round;
  return { ...control, evidenceVersion: 1 };
}
export function pushAction(stack, action) {
  const next = [...stack, action];
  while (next.length && (next.length > ACTION_LIMIT || bytes(next) > ACTION_BYTES)) next.shift();
  return next;
}
export function requireBudget(state) {
  if (stateBytes(state) > TOTAL_LIMIT) throw new Error('room_state_too_large');
  return state;
}

export function undoTargetTrial(state, command) {
  const stack = state.undoActions ?? [];
  const top = stack.at(-1);
  if (command.actor?.role !== 'facilitator') return { reason: 'forbidden' };
  if (state.phase === 'ended') return { reason: 'room_ended' };
  if (command.epoch !== state.epoch) return { reason: 'stale_epoch' };
  if (command.expectRevision !== state.revision) return { reason: 'stale_revision' };
  if (!top || command.targetEventId !== top.targetEventId) return { reason: 'stale_undo_target' };
  const consumed = new Set([top.targetEventId, ...(top.coversSelectionEventId ? [top.coversSelectionEventId] : [])]);
  return { target: top, remaining: stack.filter(action => !consumed.has(action.targetEventId)) };
}

export class PrivateEvidence {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(readFileSync(new URL('../../db/durable-object/room-schema.sql', import.meta.url), 'utf8'));
    this.sql = { exec: (query, ...args) => ({ toArray: () => this.db.prepare(query).all(...args) }) };
    migrateArchive(this.sql);
    // PROPOSED additive personal provenance. No existing schema file is changed.
    this.db.exec(`CREATE TABLE IF NOT EXISTS spike_seeds (
      response_id TEXT PRIMARY KEY, source_response_id TEXT NOT NULL,
      source_round_id TEXT NOT NULL, source_client_event_id TEXT NOT NULL,
      correction_event_id TEXT NOT NULL, seeded_at TEXT NOT NULL
    ) STRICT`);
  }
  transaction(run) {
    this.db.exec('BEGIN');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  write(state, at = Date.parse(state.lastAt)) {
    for (const id of Object.keys(state.participants)) this.db.prepare(
      'INSERT OR IGNORE INTO credentials(token_sha256,role,participant_id,issued_at) VALUES(?,?,?,?)'
    ).run(id.replaceAll('-', '').padEnd(64, '0'), 'participant', id, state.participants[id].joinedAt);
    // A control reference is not an archive row update: absent aggregate is not SQL NULL.
    // Production writer must own this discriminator before compact states reach it.
    writeArchiveState(this.sql, { ...state, rounds: state.rounds.filter(round => round.evidenceVersion !== 1) }, at);
  }
  responses(roundId) {
    return Object.fromEntries(this.db.prepare('SELECT * FROM responses WHERE round_id=?').all(roundId).map(row =>
      [row.participant_id, { id: row.id, response: JSON.parse(row.response), clientEventId: row.last_client_event_id,
        firstAt: row.first_submitted_at, lastAt: row.last_submitted_at }]));
  }
  seed(state, source, { at, eventId, status = 'open', expiresAt = '2100-01-01T00:00:00Z', remainingS = 0 }) {
    if (state.manual) throw new Error('manual_round_seed_forbidden');
    const decision = state.caseDoc.decisions.find(d => d.id === source.decisionId);
    const responses = {};
    const round = { id: uuidv7(), decisionId: source.decisionId,
      no: Math.max(source.no, ...state.rounds.filter(r => r.decisionId === source.decisionId).map(r => r.no)) + 1,
      status, openedAt: at, lockedAt: status === 'locked' ? at : null,
      responses, aggregate: status === 'locked' ? source.aggregate : null,
      suggestion: status === 'locked' ? source.suggestion : null };
    for (const [pid, prior] of Object.entries(this.responses(source.id))) {
      if (!state.participants[pid] || state.participants[pid].removedAt) continue;
      const response = normaliseResponse(decision, prior.response, state.disabledOptions[source.decisionId] ?? []);
      if (!response) continue;
      const id = uuidv7();
      // Original participant event and timestamps are genuine, not the correction event/time.
      responses[pid] = { ...prior, id, response };
      this.db.prepare('INSERT INTO spike_seeds VALUES(?,?,?,?,?,?)').run(
        id, prior.id, source.id, prior.clientEventId, eventId, at);
    }
    if (status === 'locked') {
      const suggestion = suggestPath(decision, Object.values(responses).map(row => row.response));
      round.aggregate = { counts: suggestion.counts, total: suggestion.total };
      round.suggestion = { pathId: suggestion.path_id, reason: suggestion.reason, kind: suggestion.kind };
    }
    const untilExpiry = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.parse(at)) / 1000));
    const finiteRemaining = Math.min(Math.max(0, remainingS), untilExpiry);
    return { ...state, round, selectedPathId: null, resolutionKind: null,
      phase: status === 'open' ? 'responses_open' : 'responses_locked',
      resultsShown: false, namesShown: false,
      timer: status === 'open' && finiteRemaining > 0
        ? { durationS: finiteRemaining, startedAt: at, remainingS: null } : null };
  }
  ownAnswer(roundId, participantId) { return this.responses(roundId)[participantId]?.response ?? null; }
  hydrateOwn(state, participantId) {
    // Existing pure project() can be supplied a private, nonpersisted derivation state.
    return { ...state, rounds: state.rounds.map(round => {
      const row = this.db.prepare('SELECT aggregate FROM rounds WHERE id=?').get(round.id);
      return { ...round, aggregate: row?.aggregate ? JSON.parse(row.aggregate) : null,
        answers: { [participantId]: this.ownAnswer(round.id, participantId) } };
    }) };
  }
  close() { this.db.close(); }
}

// Trial uses current reducer guards to show what one authority command must accomplish.
// Production implementation must share internal select/reveal helpers, not issue chained commands.
export function atomicRevealTrial(before, { pathId, expectRevision, at, clientEventId = uuidv7() }) {
  if (before.revision !== expectRevision) return { state: before, reason: 'stale_revision' };
  if (before.phase === 'discussion_paused') return { state: before, reason: 'resume_first' };
  const current = before.revealed.at(-1);
  const decision = before.caseDoc.decisions.find(d => d.id === before.decisionId);
  const path = decision?.paths.find(p => p.id === pathId);
  const manualPending = before.manual && before.phase === 'surface_live' && before.decisionId;
  if (!path || before.exploredTerminal.includes(pathId)) return { state: before, reason: 'invalid_path' };
  if (!manualPending && !(before.round?.status === 'locked' && ['responses_locked', 'path_selected'].includes(before.phase)))
    return { state: before, reason: 'not_locked_or_manual' };
  let state = structuredClone(before);
  state.display = { ...state.display, lobby: false, cursor: null };
  state.resultsShown = false;
  state.namesShown = false;
  state.resultsPage = 0;
  state.rankedSelection = { group: 0, position: 0 };
  const send = (type, payload = {}) => {
    const result = reduce(state, { type, actor: { role: 'facilitator', id: 'facilitator' },
      at, epoch: state.epoch, clientEventId, ...payload });
    const receipt = result.effects.find(e => e.type === 'receipt');
    if (receipt.receipt !== 'accepted') return receipt.reason;
    state = result.state;
    return null;
  };
  if (state.phase === 'path_selected' && state.selectedPathId !== pathId)
    return { state: before, reason: 'selected_path_mismatch' };
  let reason = state.phase === 'path_selected' ? null : send('select_path', { pathId });
  if (!reason) reason = send('reveal');
  if (reason) return { state: before, reason };
  return { state, context: current };
}

export function exactConsequence(state, round) {
  return state.revealed.find(entry => entry.occurrenceId === round.consequenceOccurrenceId) ?? null;
}

export function manualRevealCorrection(state, inverse, at) {
  if (!state.manual || inverse.mode !== 'manual' || state.round) throw new Error('manual_context_mismatch');
  return { ...state, phase: 'surface_live', selectedPathId: null, resolutionKind: null,
    decisionId: inverse.decisionId, beatId: inverse.beatId, nextBeatId: inverse.nextBeatId,
    flags: [...inverse.flags], terminalPathId: inverse.terminalPathId,
    liveSurfaceId: inverse.context.surfaceId, timer: null,
    revealed: [...state.revealed, { ...inverse.context, at, occurrenceId: uuidv7(),
      restoresOccurrenceId: inverse.context.occurrenceId, correctionOf: inverse.targetEventId }],
    display: { ...state.display, lobby: false, cursor: null } };
}
