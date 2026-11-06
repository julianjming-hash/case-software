// Acceptance scenarios (docs/ACCEPTANCE-SCENARIOS.md) that the shared reducer can prove on its own,
// and that no other unit test already proves. Browser-level proofs with independent clients live in
// e2e/room-lab.spec.mjs; tests/acceptance-coverage.test.mjs keeps every AS id honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { legacyPausedState } from './helpers/legacy-pause.mjs';

function room(doc) {
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const ledger = new Map();
  const journal = [];
  let t = Date.parse('2026-10-01T09:00:00Z');
  const fac = { role: 'facilitator', id: 'fac' };
  const send = (type, payload, actor) => {
    t += 1000;
    const r = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(t).toISOString(), clientEventId: uuidv7(), ...payload }, ledger);
    state = r.state;
    journal.push(...r.effects.filter((e) => e.type === 'journal'));
    return r.effects.find((e) => e.type === 'receipt');
  };
  const api = {
    get state() { return state; },
    journal,
    /** A room persisted while paused before CASE-255 retired Pause for discussion. */
    legacyPause() { t += 1000; state = legacyPausedState(state, new Date(t).toISOString()); },
    f: (type, payload = {}) => send(type, ['start', 'advance', 'reopen', 'reset_checkpoint'].includes(type) ? { roundId: uuidv7(), ...payload } : payload, fac),
    join(name) { const id = uuidv7(); send('join', { displayName: name }, { role: 'participant', id }); return id; },
    vote: (pid, response, roundId = state.round?.id) => send('vote', { roundId, response, responseId: uuidv7() }, { role: 'participant', id: pid }),
  };
  api.toOpenRound = () => {
    for (let n = 0; n < 15 && state.phase !== 'responses_open'; n++) api.f('advance');
    assert.equal(state.phase, 'responses_open', 'all decision context is shown before voting');
  };
  return api;
}

test('[AS-004] two reveals in a row: each surface reaches every screen in turn and both stay in the timeline', () => {
  const { doc, b, s } = miniCase();
  // Insert a second plain surface (a blood gas after the arrival handover) before decision 1.
  const gas = { id: uuidv7(), kind: 'update', title: 'Blood gas', points: ['pH 7.21 · lactate 4.8.'] };
  const beat = { id: uuidv7(), kind: 'surface', title: 'Blood gas', surface_id: gas.id, next_beat_id: b.d1 };
  doc.surfaces.push(gas);
  doc.beats.find((x) => x.id === b.open).next_beat_id = beat.id;
  doc.beats.push(beat);
  assert.deepEqual(validateCaseDocument(doc).errors, []);
  const r = room(doc);
  const a = r.join('A');
  r.f('start');
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(project(r.state, 'display').surface.surfaceId, s.open);
  assert.equal(r.f('advance').receipt, 'accepted');
  assert.equal(r.state.phase, 'surface_live', 'surface_live → surface_live');
  assert.equal(project(r.state, 'display').surface.title, 'Blood gas');
  const phone = project(r.state, 'participant', a);
  assert.equal(phone.liveSurface.title, 'Blood gas', 'phones auto-follow');
  assert.deepEqual(phone.timeline.map((x) => x.title), ['Arrival', 'Blood gas']);
  assert.ok(project(r.state, 'facilitator').actions.includes('advance'), 'the next action opens the decision');
});

test('[AS-013] void round: the journal keeps only the abandoned closure; a vote for it is refused round_voided', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join('A');
  r.f('start'); r.toOpenRound();
  const voided = r.state.round.id;
  r.vote(a, { option_id: o.image });
  r.f('lock');
  const before = r.journal.length;
  assert.equal(r.f('void_round').receipt, 'accepted', 'a locked round can be voided too');
  const added = r.journal.slice(before);
  assert.deepEqual(added.map((e) => [e.kind, e.payload.status]), [['round_closed', 'abandoned']]);
  assert.ok(!JSON.stringify(added).includes(o.image), 'no answer reaches the journal');
  assert.deepEqual(r.state.rounds[0], { ...r.state.rounds[0], status: 'abandoned', aggregate: null, answers: {} });
  const res = r.vote(a, { option_id: o.decompress }, voided);
  assert.deepEqual([res.receipt, res.reason], ['rejected', 'round_voided']);
  const display = project(r.state, 'display');
  assert.equal(display.decision, null, 'the projector returns to the current surface');
  assert.equal(display.lastResult, null);
  const phone = project(r.state, 'participant', a);
  assert.equal(phone.decision, null, 'answers are disabled');
  assert.equal(phone.lastRound.status, 'abandoned', 'phones are told the round was cancelled');
  r.f('end');
  assert.deepEqual(project(r.state, 'participant', a).recap.rounds, [], 'a voided round never reaches the recap');
});

test('[AS-038] replay while the room advances: votes and lock carry on, the projector stays on replay until Live surface', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join('A');
  r.f('start'); r.toOpenRound();
  const arrival = r.state.revealed[0].surfaceId;
  r.f('replay', { surfaceId: arrival });
  r.vote(a, { option_id: o.decompress });
  r.f('lock');
  let display = project(r.state, 'display');
  assert.equal(r.state.phase, 'responses_locked', 'the live phase continued');
  assert.equal(display.replay, true, 'replay banner remains');
  assert.equal(display.surface.surfaceId, arrival);
  assert.notEqual(project(r.state, 'participant', a).liveSurface.surfaceId, arrival, 'phones follow the live room');
  r.f('replay', { surfaceId: null });
  display = project(r.state, 'display');
  assert.equal(display.replay, false);
  assert.equal(display.surface.surfaceId, r.state.liveSurfaceId);
});

function manualFromInsideADecision(setups) {
  for (const setup of setups) {
    const { doc, o } = miniCase();
    const r = room(doc);
    const a = r.join('A');
    r.f('start'); r.toOpenRound();
    r.vote(a, { option_id: o.decompress });
    setup(r);
    const before = r.journal.length;
    assert.equal(r.f('enter_manual', { segmentId: uuidv7() }).receipt, 'accepted', `from ${r.state.phase}`);
    assert.deepEqual(r.journal.slice(before).map((e) => e.kind), ['round_closed', 'manual_entered'], 'no separate void_round');
    assert.equal(r.state.rounds.at(-1).status, 'abandoned');
    assert.equal(r.state.epoch, 1);
  }
}

test('[AS-031] manual mode from inside a decision is one command in an open or locked round', () => {
  manualFromInsideADecision([(r) => r, (r) => { r.f('lock'); return r; }]);
});

test('[CASE-255] manual mode is one command from a legacy room paused in an open or locked round', () => {
  manualFromInsideADecision([(r) => { r.legacyPause(); return r; }, (r) => { r.f('lock'); r.legacyPause(); return r; }]);
});
