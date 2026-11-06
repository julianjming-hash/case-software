import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, reduce, dispatch, applySegment, project } from '../src/shared/room-machine.mjs';
import { acceptDisplayView, acceptLocalFrame } from './helpers/legacy-projector-view-83158a8.mjs';
import { acknowledgeBatch, archiveBatch } from '../src/worker/room-archive.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { PrivateEvidence, compactRound, remainingAtLock, stateBytes, bytes, pushAction, ACTION_LIMIT,
  ACTION_BYTES, TOTAL_LIMIT, requireBudget, atomicRevealTrial, exactConsequence, manualRevealCorrection, undoTargetTrial } from './helpers/live-correction-spike.mjs';

const at = '2026-10-08T08:00:00.000Z';
const later = '2026-10-08T08:00:10.000Z';
function sample({ people = 3, text = false } = {}) {
  const fixture = miniCase();
  const doc = structuredClone(fixture.doc);
  if (text) doc.decisions[0].interaction = { type: 'free_text' };
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const send = (type, payload = {}) => { state = reduce(state, { type, ...payload,
    actor: { role: 'facilitator', id: 'facilitator' }, epoch: state.epoch, at,
    clientEventId: uuidv7(), roundId: uuidv7() }).state; };
  send('start'); send('advance'); send('advance');
  assert.equal(state.phase, 'responses_open');
  for (let i = 0; i < people; i++) {
    const pid = uuidv7();
    state.participants[pid] = { name: 'Participant', joinedAt: at, removedAt: null };
    state.round.responses[pid] = { id: uuidv7(), clientEventId: uuidv7(), firstAt: at, lastAt: at,
      response: text ? { text: '界'.repeat(280) } : { option_id: fixture.o.decompress } };
  }
  state.arrivalCount = people;
  send('lock');
  return { state, ...fixture, doc };
}
function action(source) {
  return { targetEventId: uuidv7(), kind: 'lock', roundId: source.id,
    contextOccurrenceId: uuidv7(), timerRemainingS: 15, mode: 'online' };
}

test('fresh seed retains genuine event/time, allocates rows, excludes removed/ineligible people and fences old votes', () => {
  const { state, o } = sample();
  const evidence = new PrivateEvidence();
  try {
    evidence.write(state);
    const source = structuredClone(state.round);
    const pids = Object.keys(source.responses);
    state.participants[pids[1]].removedAt = later;
    // Third participant now has an ineligible authored choice. Original row remains truthful.
    evidence.db.prepare('UPDATE responses SET response=? WHERE participant_id=?').run(JSON.stringify({ option_id: o.image }), pids[2]);
    state.disabledOptions[source.decisionId] = [o.image];
    const priorRows = evidence.db.prepare('SELECT * FROM responses ORDER BY id').all();
    const priorRound = evidence.db.prepare('SELECT * FROM rounds WHERE id=?').get(source.id);
    const eventId = uuidv7();
    const seeded = evidence.transaction(() => {
      const next = evidence.seed(state, source, { at: later, eventId, remainingS: 15,
        expiresAt: '2026-10-08T08:00:18.000Z' });
      next.rounds = [compactRound(source)];
      evidence.write(next); requireBudget(next); return next;
    });
    const fresh = seeded.round.responses[pids[0]];
    assert.equal(Object.keys(seeded.round.responses).length, 1);
    assert.notEqual(fresh.id, source.responses[pids[0]].id);
    assert.notEqual(seeded.round.id, source.id);
    assert.equal(fresh.clientEventId, source.responses[pids[0]].clientEventId);
    assert.equal(fresh.firstAt, at); assert.equal(fresh.lastAt, at);
    assert.equal(seeded.timer.durationS, 8); // correction time, room-expiry clamp
    assert.deepEqual(evidence.db.prepare('SELECT * FROM responses WHERE round_id=? ORDER BY id').all(source.id), priorRows);
    assert.deepEqual(evidence.db.prepare('SELECT * FROM rounds WHERE id=?').get(source.id), priorRound);
    const provenance = evidence.db.prepare('SELECT * FROM spike_seeds WHERE response_id=?').get(fresh.id);
    assert.equal(provenance.source_client_event_id, fresh.clientEventId);
    assert.equal(provenance.seeded_at, later); assert.equal(provenance.correction_event_id, eventId);
    const oldVote = reduce(seeded, { type: 'vote', roundId: source.id, response: { option_id: o.image },
      responseId: uuidv7(), clientEventId: uuidv7(), epoch: seeded.epoch, at: later,
      actor: { role: 'participant', id: pids[0] } });
    assert.equal(oldVote.state, seeded);
    assert.equal(oldVote.effects[0].receipt, 'locked');
    // Inherited choice is an own accepted choice but never an invented participant receipt/journal.
    assert.deepEqual(project(seeded, 'participant', pids[0]).decision.yourResponse, fresh.response);
    assert.equal(evidence.db.prepare("SELECT count(*) AS n FROM journal WHERE kind='response_recorded'").get().n, 0);
    const edit = reduce(seeded, { type: 'vote', roundId: seeded.round.id, response: { option_id: o.decompress },
      responseId: uuidv7(), clientEventId: uuidv7(), epoch: seeded.epoch, at: later,
      actor: { role: 'participant', id: pids[0] } });
    assert.equal(edit.effects[0].receipt, 'accepted');
    assert.notEqual(edit.state.round.responses[pids[0]].clientEventId, fresh.clientEventId);
  } finally { evidence.close(); }
});

test('locked seeded correction recomputes aggregate from eligible seeds without clearing original evidence', () => {
  const { state, o } = sample(); const evidence = new PrivateEvidence();
  try {
    evidence.write(state); const source = structuredClone(state.round);
    const before = evidence.db.prepare('SELECT * FROM rounds WHERE id=?').get(source.id);
    const pids = Object.keys(state.participants);
    state.participants[pids[1]].removedAt = later;
    state.participants[pids[2]].removedAt = later;
    const next = evidence.transaction(() => {
      const seeded = evidence.seed(state, source, { at: later, eventId: uuidv7(), status: 'locked' });
      seeded.rounds = [compactRound(source)]; evidence.write(seeded); return seeded;
    });
    assert.equal(next.round.aggregate.total, 1);
    assert.equal(next.round.aggregate.counts[o.decompress], 1);
    assert.equal(JSON.parse(before.aggregate).total, 3);
    assert.deepEqual(evidence.db.prepare('SELECT * FROM rounds WHERE id=?').get(source.id), before);
  } finally { evidence.close(); }
});

test('SQLite durable evidence survives close/reopen and held archive ACK cannot clear fresh edits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'case-correction-'));
  const file = join(directory, 'room.sqlite');
  let evidence = new PrivateEvidence(file);
  try {
    const { state } = sample(); evidence.write(state);
    const source = structuredClone(state.round);
    evidence.close(); evidence = new PrivateEvidence(file);
    const next = evidence.transaction(() => {
      const seeded = evidence.seed(state, source, { at: later, eventId: uuidv7() });
      seeded.rounds = [compactRound(source)]; evidence.write(seeded); return seeded;
    });
    const sent = archiveBatch(evidence.sql, next);
    const pid = Object.keys(next.round.responses)[0];
    next.round.responses[pid].lastAt = '2026-10-08T08:00:11.000Z';
    next.round.responses[pid].clientEventId = uuidv7();
    evidence.write(next);
    acknowledgeBatch(evidence.sql, sent.marks);
    const row = evidence.db.prepare('SELECT * FROM responses WHERE id=?').get(next.round.responses[pid].id);
    assert.equal(row.archived, 0); assert.equal(row.row_version, 2);
    assert.equal(evidence.ownAnswer(source.id, pid).option_id, next.round.responses[pid].response.option_id);
  } finally { evidence.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('compact stored answers hydrate from actual durable evidence with byte-identical current own recap', () => {
  const { state, p } = sample(); const evidence = new PrivateEvidence();
  try {
    evidence.write(state);
    const revealed = atomicRevealTrial(state, { pathId: p.decompress, expectRevision: state.revision, at: later }).state;
    evidence.write(revealed);
    const ended = reduce(revealed, { type: 'end', epoch: revealed.epoch, at: later,
      clientEventId: uuidv7(), actor: { role: 'facilitator', id: 'facilitator' } }).state;
    const compact = { ...ended, rounds: ended.rounds.map(compactRound) };
    for (const pid of Object.keys(state.participants)) {
      assert.deepEqual(project(evidence.hydrateOwn(compact, pid), 'participant', pid), project(ended, 'participant', pid));
      assert.deepEqual(project(evidence.hydrateOwn({ ...compact, phase: 'consequence_revealed' }, pid), 'participant', pid),
        project({ ...ended, phase: 'consequence_revealed' }, 'participant', pid));
    }
    assert.ok(compact.rounds.every(round => !round.answers && !round.aggregate));
  } finally { evidence.close(); }
});

test('reusing a response primary key demonstrably reassigns original SQLite evidence', () => {
  const { state } = sample({ people: 1 }); const evidence = new PrivateEvidence();
  try {
    evidence.write(state); const source = structuredClone(state.round);
    const pid = Object.keys(source.responses)[0];
    const bad = { ...state, rounds: [compactRound(source)], round: { ...source, id: uuidv7(), no: 2 } };
    evidence.write(bad);
    assert.deepEqual(evidence.responses(source.id), {});
    assert.equal(evidence.responses(bad.round.id)[pid].id, source.responses[pid].id);
  } finally { evidence.close(); }
});

test('lock timer inverse freezes finite remaining; zero remaining reopens untimed', () => {
  const { state } = sample(); const evidence = new PrivateEvidence();
  try {
    evidence.write(state);
    assert.equal(remainingAtLock({ durationS: 20, startedAt: at, remainingS: null }, later), 10);
    assert.equal(remainingAtLock({ durationS: 20, startedAt: at, remainingS: 7 }, later), 7);
    assert.equal(remainingAtLock({ durationS: 5, startedAt: at, remainingS: null }, later), 0);
    const next = evidence.transaction(() => evidence.seed(state, state.round, { at: later, eventId: uuidv7(), remainingS: 0 }));
    assert.equal(next.timer, null);
    const locked = evidence.transaction(() => evidence.seed(state, state.round, { at: later, eventId: uuidv7(), status: 'locked', remainingS: 10 }));
    assert.equal(locked.timer, null);
  } finally { evidence.close(); }
});

test('whole-state cost fails naive retained answers but compact private-evidence references fit 256 cycles', t => {
  const { state } = sample({ people: 300, text: true });
  const source = state.round;
  const naive = structuredClone(state), compact = structuredClone(state);
  naive.rounds = []; compact.rounds = []; compact.undoActions = [];
  let naiveFailureAt = null;
  for (let cycle = 0; cycle < 256; cycle++) {
    const round = { ...source, id: uuidv7(), no: cycle + 1, status: 'resolved', closedAt: later };
    naive.rounds.push({ ...compactRound(round), answers: Object.fromEntries(Object.entries(source.responses).map(([pid, r]) => [pid, r.response])) });
    compact.rounds.push(compactRound(round));
    compact.undoActions = pushAction(compact.undoActions, action(round));
    compact.revealed.push({ ...state.revealed.at(-1), occurrenceId: uuidv7(), at: later });
    if (!naiveFailureAt && stateBytes(naive) > TOTAL_LIMIT) naiveFailureAt = cycle + 1;
  }
  assert.equal(compact.undoActions.length, ACTION_LIMIT);
  assert.ok(bytes(compact.undoActions) <= ACTION_BYTES);
  assert.ok(naiveFailureAt <= 4); assert.ok(stateBytes(compact) < TOTAL_LIMIT);
  requireBudget(compact);
  t.diagnostic(JSON.stringify({ people: 300, answerUtf8Bytes: bytes(source.responses[Object.keys(source.responses)[0]].response),
    naiveFailureAt, naive256Bytes: stateBytes(naive), compact256Bytes: stateBytes(compact),
    actionCount: compact.undoActions.length, actionBytes: bytes(compact.undoActions) }));
});

test('64 KiB inverse cap prunes only action references; metadata, history and evidence are not erased', () => {
  const { state } = sample();
  const history = structuredClone(state.revealed);
  let stack = [];
  for (let i = 0; i < 64; i++) stack = pushAction(stack, { ...action(state.round), flags: Array.from({ length: 80 }, () => uuidv7()) });
  assert.ok(stack.length < 64); assert.ok(bytes(stack) <= ACTION_BYTES);
  assert.deepEqual(state.revealed, history); assert.equal(Object.keys(state.round.responses).length, 3);
});

test('exact Undo target consumes reveal/selection lineage then original lock; new action and takeover fence old targets', () => {
  const { state } = sample();
  const lock = action(state.round), selection = { ...action(state.round), kind: 'selection' };
  const reveal = { ...action(state.round), kind: 'reveal', coversSelectionEventId: selection.targetEventId };
  state.undoActions = [lock, selection, reveal];
  const command = { actor: { role: 'facilitator' }, epoch: state.epoch,
    expectRevision: state.revision, targetEventId: reveal.targetEventId };
  const undoReveal = undoTargetTrial(state, command);
  assert.deepEqual(undoReveal.remaining, [lock]);
  state.undoActions = undoReveal.remaining;
  assert.equal(undoTargetTrial(state, { ...command, targetEventId: lock.targetEventId }).target, lock);
  state.undoActions = pushAction(state.undoActions, { ...action(state.round), kind: 'reveal' });
  assert.equal(undoTargetTrial(state, { ...command, targetEventId: lock.targetEventId }).reason, 'stale_undo_target');
  state.epoch++;
  assert.equal(undoTargetTrial(state, { ...command, targetEventId: state.undoActions.at(-1).targetEventId }).reason, 'stale_epoch');
  const newConsole = { ...command, epoch: state.epoch, targetEventId: state.undoActions.at(-1).targetEventId };
  assert.ok(undoTargetTrial(state, newConsole).target);
  state.revision++; // accepted vote/presence cannot consume teaching actions, but refreshes the revision fence
  assert.equal(undoTargetTrial(state, newConsole).reason, 'stale_revision');
  assert.equal(state.undoActions.length, 2);
});

test('whole-state refusal rolls back provenance and new response/round rows together', () => {
  const { state } = sample(); const evidence = new PrivateEvidence();
  try {
    evidence.write(state); const source = structuredClone(state.round);
    const counts = () => ['rounds', 'responses', 'spike_seeds'].map(table => evidence.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
    const before = counts();
    assert.throws(() => evidence.transaction(() => {
      const next = evidence.seed(state, source, { at: later, eventId: uuidv7() });
      next.rounds = [compactRound(source)]; evidence.write(next);
      next.controlPadding = '界'.repeat(TOTAL_LIMIT); requireBudget(next);
    }), /room_state_too_large/);
    assert.deepEqual(counts(), before);
  } finally { evidence.close(); }
});

test('atomic Reveal trial dismisses chart/overlays, reveals only allowed group, rejects without partial mutation', () => {
  const { state, p } = sample(); state.display.lobby = true; state.display.cursor = 0;
  const trial = atomicRevealTrial(state, { pathId: p.decompress, expectRevision: state.revision, at: later });
  assert.equal(trial.reason, undefined); assert.equal(trial.state.phase, 'consequence_revealed');
  assert.equal(trial.state.display.lobby, false); assert.equal(trial.state.display.cursor, null);
  assert.equal(trial.state.resultsShown, false); assert.equal(trial.state.revealed.at(-1).groupsShown, 1);
  for (const input of [ { pathId: uuidv7(), expectRevision: state.revision },
    { pathId: p.decompress, expectRevision: state.revision - 1 } ]) {
    assert.equal(atomicRevealTrial(state, { ...input, at: later }).state, state);
  }
  const paused = { ...state, phase: 'discussion_paused' };
  assert.equal(atomicRevealTrial(paused, { pathId: p.decompress, expectRevision: state.revision, at: later }).state, paused);
});

test('manual Reveal and its correction remain roundless; exact context and groups are restored', () => {
  const { state, p } = sample();
  const entered = reduce(state, { type: 'enter_manual', segmentId: uuidv7(), clientEventId: uuidv7(),
    epoch: state.epoch, at: later, actor: { role: 'facilitator', id: 'facilitator' } }).state;
  assert.equal(entered.round, null);
  const context = { ...entered.revealed.at(-1), occurrenceId: uuidv7() };
  entered.revealed[entered.revealed.length - 1] = context;
  const trial = atomicRevealTrial(entered, { pathId: p.decompress, expectRevision: entered.revision, at: later });
  assert.equal(trial.reason, undefined); assert.equal(trial.state.round, null);
  const inverse = { mode: 'manual', decisionId: entered.decisionId, beatId: entered.beatId,
    nextBeatId: entered.nextBeatId, flags: entered.flags, terminalPathId: entered.terminalPathId,
    context, targetEventId: uuidv7() };
  const corrected = manualRevealCorrection(trial.state, inverse, later);
  assert.equal(corrected.round, null); assert.equal(corrected.selectedPathId, null);
  assert.equal(corrected.phase, 'surface_live'); assert.equal(corrected.decisionId, entered.decisionId);
  assert.equal(corrected.revealed.at(-1).groupsShown, context.groupsShown);
  assert.equal(corrected.revealed.at(-1).restoresOccurrenceId, context.occurrenceId);
  assert.equal(corrected.revealed.length, entered.revealed.length + 2);
  const fullContext = entered.caseDoc.surfaces.find(s => s.id === context.surfaceId);
  fullContext.points.push('A still-unrevealed context group');
  // Existing point grouping may combine points; inject an invalid group count boundary directly.
  entered.revealed.at(-1).groupsShown = 0;
  assert.equal(atomicRevealTrial(entered, { pathId: p.decompress, expectRevision: entered.revision, at: later }).state, entered);
});

test('actual current manual replay is atomic, idempotent and epoch-fenced', () => {
  const { state, p } = sample(); const ledger = new Map();
  const events = [];
  let scratch = state;
  for (const [type, payload] of [['enter_manual', { segmentId: uuidv7() }], ['select_path', { pathId: p.decompress }], ['reveal', {}]]) {
    const event = { type, ...payload, epoch: scratch.epoch, at: later, clientEventId: uuidv7(), actor: { role: 'facilitator', id: 'facilitator' } };
    scratch = reduce(scratch, event).state; events.push(event);
  }
  const valid = applySegment(state, events, ledger); assert.equal(valid.ok, true);
  const repeated = applySegment(valid.state, events, ledger);
  assert.equal(repeated.ok, true); assert.equal(repeated.state, valid.state);
  const failed = applySegment(state, [...events.slice(0, 2), { ...events[2], epoch: -1 }], new Map());
  assert.equal(failed.ok, false); assert.equal(failed.state, state); assert.deepEqual(failed.effects, []);
});

test('same authored path twice uses exact publication occurrence, not first path match', () => {
  const { state, p, s } = sample();
  const one = { ...state.revealed.at(-1), pathId: p.decompress, surfaceId: s.partial,
    occurrenceId: uuidv7(), variant: -1, groupsShown: 1 };
  const two = { ...one, occurrenceId: uuidv7(), variant: 0, groupsShown: 2 };
  state.revealed.push(one, two);
  const round = { selectedPathId: p.decompress, consequenceOccurrenceId: two.occurrenceId };
  assert.equal(state.revealed.find(e => e.pathId === round.selectedPathId), one);
  assert.equal(exactConsequence(state, round), two);
});

test('old projector accepts bounded root occurrence metadata, strict nested metadata fails; trimming does not prove raw privacy', () => {
  const { state } = sample(); const { publication: _newMetadata, decisionBranches, music, ...raw } = project(state, 'display');
  const meta = { v: 1, occurrenceId: uuidv7(), mode: 'correction', correctionOf: uuidv7() };
  const accepted = acceptDisplayView({ ...raw, publication: meta });
  assert.deepEqual(accepted, raw);
  // CASE-313: the branch badge is a root key too, so this projector drops it and keeps showing the question.
  assert.equal(decisionBranches, true);
  assert.deepEqual(acceptDisplayView({ ...raw, decisionBranches }), raw);
  // CASE-334: the room music is a root key too; this projector drops it and plays its own (older) music.
  assert.deepEqual(music, { choice: 'auto', intensity: 70, playing: true, volume: 60, effects: true, transport: null });
  assert.deepEqual(acceptDisplayView({ ...raw, music }), raw);
  const frame = { t: 'local_snapshot', epoch: raw.epoch, revision: raw.revision,
    displayRevision: raw.displayRevision, view: { ...raw, publication: meta } };
  assert.ok(acceptLocalFrame(frame, state.sessionId));
  assert.equal(acceptDisplayView({ ...raw, surface: { ...raw.surface, publication: meta } }), null);
  const dangerous = { ...raw, publication: { ...meta, rationale: 'PRIVATE SENTINEL' } };
  assert.deepEqual(acceptDisplayView(dangerous), raw);
  assert.ok(JSON.stringify(dangerous).includes('PRIVATE SENTINEL'));
  // A future authority allowlist must reject nested private fields before transmission.
  const allowed = ['v', 'occurrenceId', 'mode', 'correctionOf'];
  assert.ok(Object.keys(dangerous.publication).some(key => !allowed.includes(key)));
});
