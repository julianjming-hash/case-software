import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, applySegment, project } from '../src/shared/room-machine.mjs';
import { suggestPath } from '../src/shared/case-document.mjs';
import { parseCommandEnvelope, parseManualSegment, buildEvent } from '../src/shared/wire.mjs';
import { compactRoomState, readRoundEvidence, hydrateRoomPresentation, verifyLegacyEvidence, verifyCompactEvidence, EvidenceIncomplete } from '../src/worker/room-evidence.mjs';
import { writeArchiveState, archiveBatch, acknowledgeBatch } from '../src/worker/room-archive.mjs';
import { acceptDisplayView, acceptLocalFrame } from '../src/client/projector-view.mjs';
import { acceptDisplayView as oldDisplay, acceptLocalFrame as oldFrame } from './helpers/legacy-projector-view-83158a8.mjs';
import { validateCaseDocument as validateCase } from '../src/shared/case-document.mjs';
import { validateCaseDocument as oldCase } from './helpers/legacy-case-document-83158a8.mjs';
import { ConsoleManualRoom } from '../src/client/console-manual.mjs';
import { interpretRoomTrace } from '../src/shared/room-interpretation.mjs';
import { undoDescriptor, recordTeachingAction, MAX_TEACHING_BYTES, MAX_TEACHING_ACTIONS } from '../src/shared/room-corrections.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { recordSummary } from '../src/client/record-summary.mjs';
import { legacyPausedState } from './helpers/legacy-pause.mjs';
import { PrivateEvidence, requireBudget, stateBytes, bytes } from './helpers/live-correction-spike.mjs';

function authority(configure = () => {}) {
  const fixture = miniCase(), evidence = new PrivateEvidence();
  configure(fixture);
  let state = compactRoomState(initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: fixture.doc }));
  const ledger = new Map(); let now = Date.parse('2026-10-08T08:00:00Z');
  const api = { ...fixture, evidence, ledger, get state() { return state; },
    command(type, payload = {}, actor = { role: 'facilitator', id: 'facilitator' }) {
      const envelope = { v: 1, type, epoch: state.epoch, clientEventId: uuidv7(),
        ...(['advance', 'reveal_path', 'undo'].includes(type) ? { expectRevision: state.revision } : {}), ...payload };
      const parsed = parseCommandEnvelope(envelope, actor.role); assert.equal(parsed.ok, true, JSON.stringify(parsed));
      const event = buildEvent(parsed.envelope, { actor, at: new Date(now += 1000).toISOString(), newId: uuidv7 });
      if (type === 'undo' && !state.manual) {
        const action = state.teachingActions?.at(-1);
        event.sourceRound = readRoundEvidence(evidence.sql, action?.roundId);
        event.seedResponseIds = Object.fromEntries(Object.keys(event.sourceRound?.responses ?? {}).map(pid => [pid, uuidv7()]));
        event.expiresAtMs = now + (api.expiresAfterMs ?? 60000);
      }
      const result = evidence.transaction(() => {
        const staged = new Map();
        const result = dispatch(hydrateRoomPresentation(evidence.sql, state), event,
          { get: key => staged.get(key) ?? ledger.get(key), set: (key, value) => staged.set(key, value) });
        const compact = compactRoomState(result.state); requireBudget(compact);
        evidence.write(result.state);
        for (const effect of result.effects.filter(e => e.type === 'journal')) evidence.db.prepare(
          'INSERT INTO journal(seq,event_id,epoch,kind,payload,occurred_at) VALUES(?,?,?,?,?,?)'
        ).run(effect.seq, uuidv7(), effect.epoch, effect.kind, JSON.stringify(effect.payload), effect.at);
        for (const [key, value] of staged) ledger.set(key, value);
        const { caseDoc, ...stored } = compact;
        state = { ...JSON.parse(JSON.stringify(stored)), caseDoc: fixture.doc };
        return { ...result, state };
      });
      return { ...result, event, envelope, receipt: result.effects.find(e => e.type === 'receipt') };
    },
    /** A room persisted while paused before CASE-255 retired Pause for discussion. */
    legacyPause() { state = legacyPausedState(state, new Date(now += 1000).toISOString()); },
    undo() { return api.command('undo', { targetEventId: state.teachingActions.at(-1).id }); },
    own(pid) { return project(hydrateRoomPresentation(evidence.sql, state, pid), 'participant', pid); },
    close() { evidence.close(); },
  };
  // Serialize round trips between commands, as an evicted DO does.
  api.command('start'); api.command('advance'); api.command('advance');
  return api;
}

test('[AS-113] runtime atomic Reveal and repeated correction keep exact evidence with fresh editable choices', () => {
  const a = authority();
  try {
    const pid = uuidv7();
    // Real room reducer and archive credentials; arbitrary private state is not fabricated.
    a.command('join', { displayName: 'Tension Tamer', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.decompress } }, { role: 'participant', id: pid });
    const originalId = a.state.round.id;
    const originalResponse = a.evidence.db.prepare('SELECT * FROM responses WHERE round_id=?').get(originalId);
    const locked = a.command('lock');
    a.command('show_lobby', { on: true });
    const preRevealOccurrenceId = a.state.revealed.at(-1).occurrenceId;
    const reveal = a.command('reveal_path', { pathId: a.p.decompress });
    assert.equal(reveal.receipt.receipt, 'accepted');
    const originalRound = a.evidence.db.prepare('SELECT * FROM rounds WHERE id=?').get(originalId);
    const disclosure = a.state.revealed.at(-1);
    assert.equal(disclosure.occurrenceId, reveal.event.clientEventId);
    assert.equal(a.state.display.lobby, false); assert.equal(a.state.resultsShown, false);
    const corrected = a.undo(); assert.equal(corrected.receipt.receipt, 'accepted');
    assert.equal(a.state.phase, 'responses_locked'); assert.equal(a.state.selectedPathId, null);
    assert.notEqual(a.state.round.id, originalId);
    assert.equal(project(a.state, 'facilitator').round.seededStatus, 'locked');
    assert.equal(project(a.state, 'facilitator').round.correctionEventId, corrected.event.clientEventId);
    assert.equal(a.state.revealed.at(-1).correctionOf, reveal.event.clientEventId);
    assert.ok(a.state.revealed.some(entry => entry.occurrenceId === disclosure.occurrenceId));
    assert.equal(a.state.teachingActions.at(-1).id, locked.event.clientEventId);
    assert.deepEqual(a.evidence.db.prepare('SELECT * FROM rounds WHERE id=?').get(originalId), originalRound);
    assert.deepEqual(a.evidence.db.prepare('SELECT * FROM responses WHERE round_id=?').get(originalId), originalResponse);
    a.undo();
    assert.equal(a.state.phase, 'responses_open');
    assert.equal(project(a.state, 'facilitator').round.seededStatus, 'open');
    assert.deepEqual(a.own(pid).decision.yourResponse, { option_id: a.o.decompress });
    assert.equal(a.state.round.responses[pid].clientEventId, originalResponse.last_client_event_id);
    const delayed = a.command('vote', { roundId: originalId, response: { option_id: a.o.image } }, { role: 'participant', id: pid });
    assert.equal(delayed.receipt.receipt, 'locked');
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.image } }, { role: 'participant', id: pid });
    a.command('lock');
    assert.equal(project(a.state, 'facilitator').round.seededStatus, 'open');
    assert.equal(project(a.state, 'facilitator').round.status, 'locked');
    const second = a.command('reveal_path', { pathId: a.p.image });
    assert.equal(second.receipt.receipt, 'accepted');
    assert.equal(a.state.rounds.at(-1).consequenceOccurrenceId, second.event.clientEventId);
    assert.equal(a.own(pid).lastResult.whatHappened, 'Worse while imaging');
    const trace = interpretRoomTrace(a.state);
    assert.equal(trace.complete, true);
    assert.ok(trace.detours.includes(disclosure.occurrenceId));
    assert.equal(trace.resolutions.find(round => round.roundId === originalId).status, 'replaced');
    assert.equal(trace.resolutions.at(-1).occurrenceId, second.event.clientEventId);
    assert.equal(trace.resolutions.at(-1).retained, true);
    const publicView = project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display');
    assert.ok(acceptDisplayView(publicView)); assert.ok(oldDisplay(publicView));
    const raw = JSON.stringify(publicView);
    assert.ok(!raw.includes(pid)); assert.ok(!raw.includes('Tension Tamer')); assert.ok(!raw.includes('Treats tension.'));
    assert.ok(!raw.includes('seededStatus')); assert.ok(!raw.includes('seedSourceRoundId'));
    const privateView = project(hydrateRoomPresentation(a.evidence.sql, a.state), 'facilitator');
    assert.equal(privateView.publicTimeline.length, a.state.revealed.length);
    const correction = privateView.publicTimeline.find(row => row.publication?.correctionOf === reveal.event.clientEventId);
    assert.ok(correction, 'chronological public tile identifies the exact correction');
    assert.equal(correction.publication.restoresOccurrenceId, preRevealOccurrenceId);
    assert.deepEqual(Object.keys(correction.publication).sort(), ['correctionOf','occurrenceId','restoresOccurrenceId','v']);
    assert.ok(!JSON.stringify(privateView.publicTimeline).includes('Treats tension.'));
    assert.ok(!raw.includes('publicTimeline'));
  } finally { a.close(); }
});

test('runtime Undo retry is idempotent, wrong target refuses, removed people never return', () => {
  const a = authority();
  try {
    const pid = uuidv7(); a.command('join', { displayName: 'Tension Tamer', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.decompress } }, { role: 'participant', id: pid });
    a.command('lock'); a.command('remove_participant', { participantId: pid });
    const refused = a.command('undo', { targetEventId: uuidv7() });
    assert.equal(refused.receipt.reason, 'stale_undo_target');
    const undo = a.undo(); assert.equal(undo.receipt.receipt, 'accepted');
    assert.deepEqual(a.state.round.responses, {}); assert.ok(a.state.participants[pid].removedAt);
    const before = a.state;
    const duplicate = dispatch(before, undo.event, a.ledger);
    assert.equal(duplicate.effects[0].receipt, 'already_accepted'); assert.equal(duplicate.state, before);
  } finally { a.close(); }
});

test('real manual local saved segment replays atomic Reveal/correction with stable identities despite online revision growth', () => {
  const a = authority();
  try {
    const online = a.state;
    const store = new Map(), storage = { setItem: (key, value) => store.set(key, value), getItem: key => store.get(key) ?? null, removeItem: key => store.delete(key) };
    const channel = { postMessage() {} };
    const manual = new ConsoleManualRoom(online, a.doc, { storage, channel });
    assert.equal(manual.enter().receipt, 'accepted');
    assert.equal(manual.command('reveal_path', { pathId: a.p.decompress }).receipt, 'accepted');
    const first = manual.state.revealed.at(-1).occurrenceId;
    assert.equal(manual.command('undo', { targetEventId: manual.state.teachingActions.at(-1).id }).receipt, 'accepted');
    assert.equal(manual.state.round, null); assert.equal(manual.state.phase, 'surface_live');
    const saved = ConsoleManualRoom.saved(a.state.sessionId, storage); assert.ok(saved);
    const restored = ConsoleManualRoom.restore(online, a.doc, saved, { storage, channel }); assert.ok(restored);
    assert.deepEqual(restored.state.revealed, manual.state.revealed);
    const interpretation = interpretRoomTrace(manual.state);
    assert.equal(interpretation.complete, true);
    assert.equal(interpretation.manualResolutions.length, 1);
    assert.equal(interpretation.manualResolutions[0].roundId, null);
    assert.equal(interpretation.manualResolutions[0].retained, false);
    assert.equal(interpretation.manualResolutions[0].occurrenceId, first);
    const pid = uuidv7(); a.command('join', { displayName: 'Tension Tamer', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.image } }, { role: 'participant', id: pid });
    const body = parseManualSegment(manual.segmentBody()); assert.equal(body.ok, true);
    const events = body.events.map(({ envelope, at }) => buildEvent(envelope,
      { actor: { role: 'facilitator', id: 'facilitator' }, at, newId: uuidv7 }));
    const applied = applySegment(a.state, events, new Map());
    assert.equal(applied.ok, true, applied.reason); assert.equal(applied.state.round, null);
    assert.ok(applied.state.revealed.some(entry => entry.occurrenceId === first));
    const withoutNormalizedTime = entries => entries.map(({ at, ...entry }) => entry);
    assert.deepEqual(withoutNormalizedTime(applied.state.revealed), withoutNormalizedTime(manual.state.revealed));
    assert.ok(applied.state.revealed.slice(-2).every(entry => Date.parse(entry.at) >= Date.parse(a.state.lastAt)));
  } finally { a.close(); }
});

test('all rule-based tie outcomes are deterministic under permutation and labelled fallback', () => {
  const { o, p } = miniCase();
  const decision = { interaction: { type: 'multi_select', options: [] }, fallback_path_id: p.intubate,
    rules: [{ when: { includes_all: [o.decompress] }, path_id: p.decompress },
      { when: { includes_all: [o.image] }, path_id: p.image }] };
  const responses = [{ option_ids: [o.decompress] }, { option_ids: [o.image] }];
  const one = suggestPath(decision, responses), two = suggestPath(decision, responses.toReversed());
  assert.deepEqual(one, two); assert.equal(one.kind, 'tie'); assert.equal(one.path_id, p.intubate);
  const overlap = [{ option_ids: [o.decompress, o.image] }];
  const normal = suggestPath(decision, overlap);
  const reversed = suggestPath({ ...decision, rules: decision.rules.toReversed() }, overlap);
  assert.deepEqual(normal, reversed); assert.equal(normal.path_id, p.intubate);
});

test('Undo scopes current teaching context and restores absence of checkpoint without deleting disclosures', () => {
  const a = authority();
  try {
    a.command('lock');
    delete a.state.checkpoints[a.b.d1];
    const revealed = a.command('reveal_path', { pathId: a.p.decompress });
    // Simulate a forward control checkpoint introduced after the captured inverse.
    a.state.checkpoints[a.b.d1] = { flags: ['forward_only'] };
    const disclosed = a.state.revealed.at(-1).occurrenceId;
    const corrected = a.undo(); assert.equal(corrected.receipt.receipt, 'accepted');
    assert.equal(a.state.checkpoints[a.b.d1], undefined);
    assert.ok(a.state.revealed.some(entry => entry.occurrenceId === disclosed));
    a.command('reveal_path', { pathId: a.p.decompress });
    const target = a.state.teachingActions.at(-1).id;
    a.command('advance');
    assert.deepEqual(undoDescriptor(a.state), { available: false, reason: 'teaching_context_changed' });
    const refused = a.command('undo', { targetEventId: target });
    assert.equal(refused.receipt.reason, 'teaching_context_changed');
    assert.ok(a.state.revealed.some(entry => entry.occurrenceId === revealed.event.clientEventId));
  } finally { a.close(); }
});

test('actual 300 long-answer runtime correction cycles fit compact whole state and retain original SQL', t => {
  const a = authority(fixture => {
    const decision = fixture.doc.decisions[0];
    decision.interaction = { type: 'free_text', max_length: 500 };
    decision.paths.forEach(path => { delete path.option_ids; });
    decision.rules = [{ when: { keywords: ['answer'] }, path_id: fixture.p.decompress }];
  });
  try {
    for (let i = 0; i < 300; i++) {
      const pid = uuidv7();
      a.command('join', { displayName: `Learner ${i}`, avatarId: 'shadows-01' }, { role: 'participant', id: pid });
      a.command('vote', { roundId: a.state.round.id, response: { text: '界'.repeat(500) } }, { role: 'participant', id: pid });
    }
    const original = a.state.round.id;
    const rows = a.evidence.db.prepare('SELECT * FROM responses WHERE round_id=? ORDER BY id').all(original);
    let maximum = stateBytes(a.state);
    for (let cycle = 0; cycle < 12; cycle++) {
      a.command('lock'); a.command('reveal_path', { pathId: a.p.decompress });
      a.undo(); a.undo();
      assert.equal(Object.keys(a.state.round.responses).length, 300);
      maximum = Math.max(maximum, stateBytes(a.state)); requireBudget(a.state);
    }
    assert.deepEqual(a.evidence.db.prepare('SELECT * FROM responses WHERE round_id=? ORDER BY id').all(original), rows);
    assert.ok(a.state.rounds.every(round => round.evidenceRef === 1 && !round.answers && !round.aggregate));
    t.diagnostic(JSON.stringify({ runtimeCycles: 12, people: 300, answerChars: 500, answerUtf8Bytes: new TextEncoder().encode('界'.repeat(500)).length, closedRounds: a.state.rounds.length, maximumWholeStateUtf8: maximum }));
  } finally { a.close(); }
});

test('production teaching-action chain prunes both count and UTF8 bytes without deleting disclosure history', () => {
  const a = authority();
  try {
    let state = a.state;
    for (let i = 0; i < 80; i++) state = recordTeachingAction(state, state, { clientEventId: uuidv7(), at: state.lastAt }, 'lock');
    assert.equal(state.teachingActions.length, MAX_TEACHING_ACTIONS); assert.ok(bytes(state.teachingActions) <= MAX_TEACHING_BYTES);
    const disclosures = state.revealed;
    state = { ...state, flags: Array.from({ length: 80 }, () => uuidv7()) };
    for (let i = 0; i < 80; i++) state = recordTeachingAction(state, state, { clientEventId: uuidv7(), at: state.lastAt }, 'reveal');
    assert.ok(state.teachingActions.length < MAX_TEACHING_ACTIONS); assert.ok(bytes(state.teachingActions) <= MAX_TEACHING_BYTES);
    assert.equal(state.revealed, disclosures); assert.equal(state.undoPruned, true);
  } finally { a.close(); }
});

test('actual authored reflection/wrap_up raw display frames are legacy-compatible while old authoring rejects safely', () => {
  for (const kind of ['reflection', 'wrap_up']) {
    const a = authority(fixture => { fixture.doc.surfaces.find(surface => surface.id === fixture.s.partial).kind = kind; });
    try {
      assert.equal(validateCase(a.doc).ok, true);
      const original = JSON.stringify(a.doc), old = oldCase(a.doc);
      assert.equal(old.ok, false); assert.ok(old.errors.some(error => error.code === 'enum'));
      assert.equal(JSON.stringify(a.doc), original);
      a.command('lock'); a.command('reveal_path', { pathId: a.p.decompress });
      const view = project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display');
      const frame = JSON.parse(JSON.stringify({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }));
      const raw = JSON.stringify(frame);
      assert.equal(frame.view.surface.kind, kind);
      assert.ok(!raw.includes('Treats tension.')); assert.ok(!raw.includes('caseDoc')); assert.ok(!raw.includes('publicTimeline'));
      assert.ok(oldDisplay(frame.view)); assert.ok(oldFrame(frame, a.state.sessionId));
      assert.deepEqual(acceptLocalFrame(frame, a.state.sessionId), frame);
      assert.equal(acceptDisplayView({ ...view, publication: { ...view.publication, notes: 'PRIVATE SENTINEL' } }), null);
      a.state.revealed.at(-1).notes = 'PRIVATE SENTINEL';
      assert.ok(!JSON.stringify(project(a.state, 'display')).includes('PRIVATE SENTINEL'));
    } finally { a.close(); }
  }
});

test('authored checkpoint restoration carries an exact bounded suppression marker across old rawframe acceptance', () => {
  const a = authority();
  try {
    const contextId = a.state.revealed.at(-1).occurrenceId;
    a.command('lock'); a.command('reveal_path', { pathId: a.p.intubate });
    a.command('reset_checkpoint');
    const view = project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display');
    assert.equal(view.publication.checkpointOf, contextId);
    assert.ok(oldDisplay(view)); assert.ok(acceptDisplayView(view));
    assert.ok(!JSON.stringify(view).includes('PPV on untreated tension'));
    const trace = interpretRoomTrace(a.state); assert.equal(trace.complete, true);
    assert.equal(trace.resolutions.at(-1).retained, false);
  } finally { a.close(); }
});

test('actual facilitator projection advertises atomic Reveal and applicable Undo across overlays, groups and manual boundaries', () => {
  const a = authority(), view = () => project(hydrateRoomPresentation(a.evidence.sql, a.state), 'facilitator');
  try {
    assert.ok(!view().actions.includes('reveal_path'));
    a.command('lock');
    assert.ok(view().actions.includes('reveal_path')); assert.ok(view().actions.includes('undo'));
    assert.equal(view().undo.targetEventId, a.state.teachingActions.at(-1).id);
    assert.equal(view().revision, a.state.revision);
    a.command('replay', { entryIndex: 0 }); a.command('show_lobby', { on: true });
    assert.ok(view().actions.includes('reveal_path')); assert.ok(view().actions.includes('undo'));
    assert.ok(!view().actions.includes('reveal'));
    const reveal = a.command('reveal_path', { pathId: a.p.decompress }); assert.equal(reveal.receipt.receipt, 'accepted');
    assert.equal(view().display.cursor, null); assert.equal(view().display.lobby, false);
    assert.ok(view().actions.includes('undo'));
    a.legacyPause(); assert.ok(!view().actions.includes('undo')); assert.ok(!view().actions.includes('reveal_path'));
    a.command('resume'); a.undo();
    const context = a.state.revealed.at(-1); context.groupsShown = 0;
    assert.ok(!view().actions.includes('reveal_path'));
    context.groupsShown = 1;
    a.command('enter_manual', { segmentId: uuidv7() });
    assert.ok(view().actions.includes('reveal_path')); assert.ok(!view().actions.includes('undo'));
    a.command('select_path', { pathId: a.p.decompress });
    assert.equal(a.state.round, null); assert.ok(view().actions.includes('reveal_path'));
    assert.equal(a.command('reveal_path', { pathId: a.p.image }).receipt.reason, 'selected_path_mismatch');
    assert.equal(a.command('reveal_path', { pathId: a.p.decompress }).receipt.receipt, 'accepted');
    assert.ok(view().actions.includes('undo'));
    a.undo(); assert.equal(a.state.round, null); assert.equal(a.state.selectedPathId, null);
    assert.equal(a.state.phase, 'surface_live');
    a.command('end'); assert.deepEqual(view().actions, []); assert.equal(view().undo.available, false);
  } finally { a.close(); }
});

test('D4 already committed selection must match exact atomic Reveal path/revision without partial chart dismissal', () => {
  const a = authority();
  try {
    a.command('lock'); a.command('select_path', { pathId: a.p.decompress });
    const before = a.state, chart = before.resultsShown;
    const rejected = a.command('reveal_path', { pathId: a.p.image });
    assert.equal(rejected.receipt.reason, 'selected_path_mismatch');
    assert.equal(a.state.selectedPathId, a.p.decompress); assert.equal(a.state.resultsShown, chart);
    assert.equal(a.state.revealed.length, before.revealed.length); assert.equal(a.state.revision, before.revision);
    a.undo();
    assert.equal(a.state.phase, 'responses_locked'); assert.equal(a.state.selectedPathId, null);
    assert.equal(a.command('reveal_path', { pathId: a.p.image }).receipt.receipt, 'accepted');
  } finally { a.close(); }
});

test('actual Lock Undo restores captured finite timer and clamps zero expiry to untimed editing', () => {
  const a = authority();
  try {
    a.command('set_timer', { seconds: 10 }); a.command('lock');
    const captured = a.state.teachingActions.at(-1).remainingS;
    assert.equal(captured, 9);
    a.undo(); assert.equal(a.state.timer.durationS, captured);
    assert.equal(a.state.timer.remainingS, null); assert.equal(a.state.round.status, 'open');
    a.command('lock'); a.expiresAfterMs = 0; a.undo();
    assert.equal(a.state.timer, null); assert.equal(a.state.phase, 'responses_open');
  } finally { a.close(); }
});

test('legacy and compact evidence reject missing genuine metadata, mismatched control and corrupted JSON before discarding answers', () => {
  const a = authority();
  try {
    const pid = uuidv7(); a.command('join', { displayName: 'Learner', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.decompress } }, { role: 'participant', id: pid });
    const rid = a.state.round.id; a.command('lock'); a.command('reveal_path', { pathId: a.p.decompress });
    const original = readRoundEvidence(a.evidence.sql, rid);
    const legacy = { ...a.state, evidenceStateVersion: undefined, rounds: a.state.rounds.map(round => {
      const { evidenceRef, ...rest } = round;
      return { ...rest, aggregate: original.aggregate, answers: { [pid]: original.responses[pid].response } };
    }) };
    assert.equal(verifyLegacyEvidence(a.evidence.sql, legacy), true);
    const untouched = JSON.stringify(legacy);
    for (const mutation of [
      () => a.evidence.db.prepare("UPDATE responses SET last_client_event_id='' WHERE round_id=?").run(rid),
      () => a.evidence.db.prepare('UPDATE rounds SET decision_id=? WHERE id=?').run(uuidv7(), rid),
      () => a.evidence.db.prepare("UPDATE responses SET response='bad JSON' WHERE round_id=?").run(rid),
      () => a.evidence.db.prepare('DELETE FROM responses WHERE round_id=?').run(rid),
    ]) {
      assert.throws(() => a.evidence.transaction(() => { mutation(); assert.equal(verifyLegacyEvidence(a.evidence.sql, legacy), false);
        assert.equal(verifyCompactEvidence(a.evidence.sql, a.state), false); throw new Error('rollback fixture'); }), /rollback fixture/);
      assert.equal(JSON.stringify(legacy), untouched);
    }
    assert.throws(() => a.evidence.transaction(() => {
      a.evidence.db.prepare('DELETE FROM responses WHERE round_id=?').run(rid);
      assert.throws(() => hydrateRoomPresentation(a.evidence.sql, a.state, pid), EvidenceIncomplete);
      throw new Error('rollback fixture');
    }), /rollback fixture/);
  } finally { a.close(); }
});

test('durable aggregate corruption fails closed before cold verification or public presentation can expose stored values', () => {
  const a = authority();
  try {
    const pid = uuidv7(); a.command('join', { displayName: 'Learner', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.decompress } }, { role: 'participant', id: pid });
    const rid = a.state.round.id; a.command('lock'); a.command('reveal_path', { pathId: a.p.decompress });
    a.command('show_results', { on: true }); assert.equal(a.state.round, null);
    const original = readRoundEvidence(a.evidence.sql, rid).aggregate;
    assert.equal(project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display').responseResult.counts[0].count, 1);
    const unchanged = JSON.stringify(a.state), sentinel = 'PRIVATE_CORRUPTION_SENTINEL';
    const corrupt = [
      ...[sentinel, { text: sentinel }, [sentinel], null, -1, 0.5, 2, Number.MAX_SAFE_INTEGER].map(count => ({ total: 1, counts: { [a.o.decompress]: count } })),
      ...[-1, 0.5, 301, Number.MAX_SAFE_INTEGER, sentinel].map(total => ({ total, counts: {} })),
      { total: 1, counts: { [sentinel]: 1 } },
      { ...original, privateText: sentinel },
    ];
    for (const aggregate of corrupt) {
      a.evidence.db.prepare('UPDATE rounds SET aggregate=? WHERE id=?').run(JSON.stringify(aggregate), rid);
      assert.equal(readRoundEvidence(a.evidence.sql, rid), null, JSON.stringify(aggregate));
      assert.equal(verifyCompactEvidence(a.evidence.sql, a.state), false);
      assert.throws(() => hydrateRoomPresentation(a.evidence.sql, a.state), EvidenceIncomplete);
      assert.equal(JSON.stringify(a.state), unchanged);
      assert.equal(a.evidence.db.prepare('SELECT aggregate FROM rounds WHERE id=?').get(rid).aggregate, JSON.stringify(aggregate));
    }
    a.evidence.db.prepare('UPDATE rounds SET aggregate=? WHERE id=?').run(JSON.stringify(original), rid);
    assert.equal(verifyCompactEvidence(a.evidence.sql, a.state), true);
    assert.ok(!JSON.stringify(project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display')).includes(sentinel));
  } finally { a.close(); }
});

test('durable aggregates preserve old marginal-only, sparse, multi-select and current complete ranking closures', () => {
  for (const type of ['single_choice', 'multi_select', 'ranking', 'free_text']) {
    const a = authority(({ doc, o, p }) => {
      const decision = doc.decisions[0]; decision.interaction.type = type;
      if (type === 'single_choice') return;
      decision.paths.forEach(path => { delete path.option_ids; });
      decision.rules = type === 'multi_select' ? [{ when: { includes_any: [o.decompress] }, path_id: p.decompress }]
        : type === 'ranking' ? [{ when: { top: [o.decompress] }, path_id: p.decompress }]
        : [{ when: { keywords: ['tension'] }, path_id: p.decompress }];
      if (type === 'ranking') decision.interaction.rank_count = 2;
      if (type === 'free_text') { delete decision.interaction.options; decision.interaction.max_length = 280; }
    });
    try {
      const pid = uuidv7(); a.command('join', { displayName: 'Learner', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
      const response = type === 'single_choice' ? { option_id: a.o.decompress } : type === 'multi_select'
        ? { option_ids: [a.o.decompress, a.o.image] } : type === 'ranking' ? { order: [a.o.decompress, a.o.image] } : { text: 'tension' };
      a.command('vote', { roundId: a.state.round.id, response }, { role: 'participant', id: pid });
      const rid = a.state.round.id; a.command('lock'); a.command('reveal_path', { pathId: a.p.decompress });
      const original = readRoundEvidence(a.evidence.sql, rid).aggregate;
      for (const aggregate of [original, { total: original.total, counts: original.counts }, { total: 0, counts: {} },
        ...(type === 'ranking' ? [{ total: original.total, counts: original.counts, positionCounts: original.positionCounts }] : []),
        ...(type === 'ranking' ? [{ total: 0, counts: Object.fromEntries(Object.keys(original.counts).map(id => [id, 0])),
          rankCount: 0, eligibleOptionIds: [], positionCounts: Object.fromEntries(Object.keys(original.counts).map(id => [id, []])), completeOrders: [] }] : [])]) {
        a.evidence.db.prepare('UPDATE rounds SET aggregate=? WHERE id=?').run(JSON.stringify(aggregate), rid);
        assert.deepEqual(readRoundEvidence(a.evidence.sql, rid).aggregate, aggregate, type);
        assert.equal(verifyCompactEvidence(a.evidence.sql, a.state), true, type);
        assert.deepEqual(hydrateRoomPresentation(a.evidence.sql, a.state).rounds.at(-1).aggregate, aggregate, type);
      }
      if (type === 'ranking') {
        for (const aggregate of [
          { ...original, rankCount: 'PRIVATE_CORRUPTION_SENTINEL' },
          { ...original, eligibleOptionIds: ['PRIVATE_CORRUPTION_SENTINEL'] },
          { ...original, eligibleOptionIds: [a.o.decompress, a.o.decompress] },
          { ...original, positionCounts: { [a.o.decompress]: ['PRIVATE_CORRUPTION_SENTINEL', 0] } },
          { ...original, positionCounts: { [a.o.decompress]: [2, 0] } },
          { ...original, positionCounts: { [a.o.decompress]: [0] } },
          { ...original, completeOrders: [['01', 'PRIVATE_CORRUPTION_SENTINEL']] },
          { ...original, completeOrders: [['77', 1]] },
          { ...original, completeOrders: [['07', 1]] },
        ]) {
          a.evidence.db.prepare('UPDATE rounds SET aggregate=? WHERE id=?').run(JSON.stringify(aggregate), rid);
          assert.equal(verifyCompactEvidence(a.evidence.sql, a.state), false);
          assert.throws(() => hydrateRoomPresentation(a.evidence.sql, a.state), EvidenceIncomplete);
        }
      }
    } finally { a.close(); }
  }
});

test('legacy recap uses unique exact chronology and labels an ambiguous disclosure gap without inventing occurrence IDs', () => {
  const a = authority();
  try {
    const pid = uuidv7(); a.command('join', { displayName: 'Learner', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.decompress } }, { role: 'participant', id: pid });
    a.command('lock'); a.command('reveal_path', { pathId: a.p.decompress }); a.command('end');
    const legacy = hydrateRoomPresentation(a.evidence.sql, a.state, pid);
    legacy.rounds = legacy.rounds.map(({ consequenceOccurrenceId, ...round }) => round);
    legacy.revealed = legacy.revealed.map(({ occurrenceId, ...entry }) => entry);
    const before = JSON.stringify(legacy), recap = project(legacy, 'participant', pid).recap;
    assert.equal(recap.rounds[0].whatHappened, 'Partial response');
    assert.equal(recap.rounds[0].publicationEvidence, 'legacy_unique_chronology');
    assert.equal(JSON.stringify(legacy), before);
    legacy.revealed.push({ ...legacy.revealed.at(-1), variant: -1 });
    const ambiguous = project(legacy, 'participant', pid).recap;
    assert.equal(ambiguous.rounds[0].whatHappened, null);
    assert.equal(ambiguous.rounds[0].publicationEvidence, 'legacy_publication_reference_missing');
  } finally { a.close(); }
});

test('archive defers inverted-ID seeds until source ACK across real batch boundary and cache-free retry', () => {
  const a = authority();
  try {
    const pid = uuidv7(); a.command('join', { displayName: 'Learner', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    a.command('vote', { roundId: a.state.round.id, response: { option_id: a.o.decompress } }, { role: 'participant', id: pid });
    const original = a.state.round.id; a.command('lock'); a.undo();
    const seed = a.state.round.responses[pid], source = a.evidence.db.prepare('SELECT id FROM responses WHERE round_id=?').get(original);
    const inverted = '01900000-0000-7000-8000-000000000001';
    assert.ok(inverted < source.id);
    a.evidence.db.prepare('UPDATE responses SET id=? WHERE id=?').run(inverted, seed.id);
    a.evidence.db.exec('UPDATE participants SET archived=1; UPDATE rounds SET archived=1; UPDATE journal SET archived=1;');
    const first = archiveBatch(a.evidence.sql, a.state);
    assert.deepEqual(first.batch.responses.map(row => row.id), [source.id]);
    assert.deepEqual(archiveBatch(a.evidence.sql, a.state).batch.responses.map(row => row.id), [source.id]);
    acknowledgeBatch(a.evidence.sql, first.marks);
    const second = archiveBatch(a.evidence.sql, a.state);
    assert.deepEqual(second.batch.responses.map(row => row.id), [inverted]);
    assert.equal(second.batch.responses[0].source_response_id, source.id);
  } finally { a.close(); }
});

test('raw replay frames identify latest live publication while selecting historical public surface silently', () => {
  const a = authority();
  try {
    a.command('lock'); const published = a.command('reveal_path', { pathId: a.p.decompress });
    a.command('replay', { entryIndex: 0 });
    const view = project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display');
    assert.equal(view.replay, true); assert.equal(view.surface.surfaceId, a.s.open);
    assert.equal(view.publication.occurrenceId, published.event.clientEventId);
    const frame = JSON.parse(JSON.stringify({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }));
    assert.ok(oldFrame(frame, a.state.sessionId)); assert.deepEqual(acceptLocalFrame(frame, a.state.sessionId), frame);
    const raw = JSON.stringify(frame); assert.ok(!raw.includes('Treats tension.')); assert.ok(!raw.includes('pathId'));
  } finally { a.close(); }
});


test('atomic Reveal retains the matching closed ranked page through hidden publication, restored chart and fresh paging', () => {
  const a = authority(({ doc, o, p }) => {
    const decision = doc.decisions[0];
    decision.interaction.type = 'ranking'; decision.interaction.rank_count = 8;
    while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: `Additional option ${decision.interaction.options.length + 1}` });
    decision.paths.forEach(path => { delete path.option_ids; });
    decision.rules = [{ when: { top: [o.decompress] }, path_id: p.decompress }];
  });
  try {
    // CASE-327: five positions a page, so an 8-rank ranking pages at 0 and 5.
    const ids = a.doc.decisions[0].interaction.options.map(option => option.id), participants = [];
    const orders = [ids, [ids[1], ids[0], ...ids.slice(2)], [ids[2], ids[0], ids[1], ...ids.slice(3)], [ids[3], ids[0], ids[1], ids[2], ...ids.slice(4)]];
    for (const [index, order] of orders.entries()) {
      const id = uuidv7(); participants.push(id);
      assert.equal(a.command('join', { displayName: `Private Ranker ${index}`, avatarId: 'shadows-01' }, { role: 'participant', id }).receipt.receipt, 'accepted');
      assert.equal(a.command('vote', { roundId: a.state.round.id, response: { order } }, { role: 'participant', id }).receipt.receipt, 'accepted');
    }
    assert.equal(a.command('lock').receipt.receipt, 'accepted');
    const roundId = a.state.round.id, roundNo = a.state.round.no;
    const display = () => project(hydrateRoomPresentation(a.evidence.sql, a.state), 'display');
    assert.equal(a.command('results_page', { page: 1 }).receipt.receipt, 'accepted');
    const page = (group, position, closedRoundId = roundId) => a.command('ranked_page', { group, position, closedRoundId, expectRevision: a.state.revision });
    assert.equal(page(2, 5).receipt.receipt, 'accepted');
    const before = display().responseResult;
    assert.equal(before.roundNo, roundNo); assert.equal(before.decisionId, a.doc.decisions[0].id);
    assert.equal(before.ranked.groupStart, 2); assert.equal(before.ranked.positionStart, 5);
    assert.equal(a.command('reveal_path', { pathId: a.p.decompress }).receipt.receipt, 'accepted');
    assert.equal(a.state.resultsShown, false); assert.equal(display().responseResult, null);
    assert.deepEqual(a.state.rankedSelection, { group: 2, position: 5 });
    assert.equal(a.state.resultsPage, 1);
    assert.equal(a.state.rounds.at(-1).id, roundId); assert.equal(a.state.rounds.at(-1).status, 'resolved');
    assert.equal(a.command('show_results', { on: true }).receipt.receipt, 'accepted');
    assert.deepEqual(display().responseResult.ranked, before.ranked);
    assert.deepEqual(display().responseResult.counts, before.counts);
    assert.equal(display().responseResult.roundNo, roundNo);
    assert.equal(page(2, 0).receipt.receipt, 'accepted');
    assert.equal(display().responseResult.ranked.groupStart, 2); assert.equal(display().responseResult.ranked.positionStart, 0);
    const raw = JSON.stringify(display());
    for (const marker of ['Private Ranker ', 'Treats tension.', 'completeOrders', 'publicTimeline', ...participants]) assert.ok(!raw.includes(marker), marker);
    assert.equal(page(0, 0, uuidv7()).receipt.reason, 'stale_closed_round');
    assert.deepEqual(a.state.rankedSelection, { group: 2, position: 0 });
    assert.equal(a.undo().receipt.receipt, 'accepted');
    assert.notEqual(a.state.round.id, roundId); assert.equal(a.state.round.status, 'locked');
    assert.deepEqual(a.state.rankedSelection, { group: 0, position: 0 }); assert.equal(a.state.resultsPage, 0);
    assert.equal(a.command('reopen').receipt.receipt, 'accepted');
    assert.equal(a.state.round.status, 'open');
    assert.deepEqual(a.state.rankedSelection, { group: 0, position: 0 }); assert.equal(a.state.resultsPage, 0);
  } finally { a.close(); }
});

test('[AS-193] a phone at Debrief has its own answer to every compacted round, as at End', () => {
  const a = authority();
  try {
    const pid = uuidv7(); a.command('join', { displayName: 'Learner', avatarId: 'shadows-01' }, { role: 'participant', id: pid });
    const answer = (option, path) => {
      for (let n = 0; n < 15 && a.state.phase !== 'responses_open'; n++) a.command('advance');
      a.command('vote', { roundId: a.state.round.id, response: { option_id: option } }, { role: 'participant', id: pid });
      a.command('lock'); a.command('reveal_path', { pathId: path });
    };
    answer(a.o.decompress, a.p.decompress); answer(a.o.fast, a.p.fast);
    // The first round is compacted into SQL; the phone's view must load it back (1 Nov: Debrief showed 1 of 7).
    assert.ok(a.state.rounds[0].evidenceRef);
    assert.equal(a.command('debrief').receipt.receipt, 'accepted');
    const both = ['Decompress the right chest', 'Repeat primary survey + eFAST'];
    assert.deepEqual(a.own(pid).recap.rounds.map(r => r.yourAnswer), both);
    assert.deepEqual(recordSummary(a.own(pid)).decisions, { made: 2, total: 2 });
    a.command('end');
    assert.deepEqual(a.own(pid).recap.rounds.map(r => r.yourAnswer), both);
  } finally { a.close(); }
});
