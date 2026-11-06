// Console layout v2 (Julian, 2026-10-18): Debrief is a reversible room phase before End. It is entered at a shown slide,
// never inside a round or in manual mode; it stops joining (restored on Back to the case), gives phones their recap and the
// projector its public debrief and feedback QR, accepts only review, membership, Back to the case and End.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, facilitatorActions } from '../src/shared/room-machine.mjs';
import { parseCommandEnvelope } from '../src/shared/wire.mjs';
import { miniCase } from './helpers/mini-case.mjs';

function room(doc = miniCase().doc) {
  let state = { ...initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), feedbackCode: '7K3QX9' };
  const ledger = new Map();
  let t = Date.parse('2026-10-18T09:00:00Z');
  const fac = { role: 'facilitator', id: 'fac' };
  const api = {
    get state() { return state; },
    send(type, payload = {}, actor = fac) {
      t += 1000;
      const r = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(t).toISOString(), clientEventId: uuidv7(), ...payload }, ledger);
      state = r.state;
      return r;
    },
    f(type, payload = {}) {
      if (['start', 'advance', 'reopen', 'reset_checkpoint'].includes(type)) payload = { roundId: uuidv7(), ...payload };
      return api.send(type, payload);
    },
    join(name = 'Learner') { const id = uuidv7(); api.send('join', { displayName: name }, { role: 'participant', id }); return id; },
    receipt: r => r.effects.find(e => e.type === 'receipt'),
  };
  return api;
}
/** Open the first decision, vote, lock and reveal its recommended route: a consequence is on screen. */
function afterFirstReveal() {
  const { doc, o, p } = miniCase(), r = room(doc), a = r.join('Ana');
  r.f('start');
  for (let n = 0; n < 15 && r.state.phase !== 'responses_open'; n++) r.f('advance');
  r.send('vote', { roundId: r.state.round.id, response: { option_id: o.decompress }, responseId: uuidv7() }, { role: 'participant', id: a });
  r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal');
  assert.equal(r.state.phase, 'consequence_revealed');
  return { r, a, doc };
}

test('Debrief starts at a shown slide: phase, joining stopped, projector cleared, journal and a broadcast to every role', () => {
  const { r } = afterFirstReveal();
  r.f('replay', { entryIndex: 0 });
  assert.ok(facilitatorActions(r.state).includes('debrief'));
  const res = r.f('debrief');
  assert.equal(r.receipt(res).receipt, 'accepted');
  assert.equal(r.state.phase, 'debrief');
  assert.equal(r.state.joiningClosed, true);
  assert.equal(r.state.display.cursor, null);
  assert.deepEqual({ resumePhase: r.state.debrief.resumePhase, joiningClosed: r.state.debrief.joiningClosed, page: r.state.debrief.page },
    { resumePhase: 'consequence_revealed', joiningClosed: false, page: 0 });
  assert.ok(res.effects.some(e => e.type === 'journal' && e.kind === 'debrief_started'));
  assert.deepEqual(res.effects.find(e => e.type === 'broadcast').roles.sort(), ['display', 'facilitator', 'participant']);
});

test('Back to the case restores the phase and joining exactly; joining closed before Debrief stays closed', () => {
  const { r } = afterFirstReveal();
  r.f('debrief'); r.f('back_to_case');
  assert.equal(r.state.phase, 'consequence_revealed');
  assert.equal(r.state.joiningClosed, false);
  assert.equal(r.state.debrief, null);
  r.f('close_joining', { closed: true }); r.f('debrief'); r.f('back_to_case');
  assert.equal(r.state.joiningClosed, true);
});

test('Debrief is refused inside a round, in the lobby and in manual room mode', () => {
  const { doc } = miniCase(), r = room(doc);
  assert.equal(r.receipt(r.f('debrief')).reason, 'not_at_a_slide'); // lobby
  r.f('start');
  for (let n = 0; n < 15 && r.state.phase !== 'responses_open'; n++) r.f('advance');
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(facilitatorActions(r.state).includes('debrief'), false);
  assert.equal(r.receipt(r.f('debrief')).reason, 'not_at_a_slide');
  r.f('lock');
  assert.equal(r.receipt(r.f('debrief')).reason, 'not_at_a_slide');
  const m = room(doc); m.f('start'); m.f('enter_manual', { segmentId: uuidv7() });
  assert.equal(m.receipt(m.f('debrief')).reason, 'manual_room');
});

test('In Debrief only review, membership, Back to the case and End are accepted; joining and votes are refused', () => {
  const { r } = afterFirstReveal();
  r.f('debrief');
  for (const [type, payload] of [['advance', {}], ['show_lobby', { on: true }], ['close_joining', { closed: false }], ['show_names', { on: true }], ['debrief', {}]])
    assert.equal(r.receipt(r.f(type, payload)).reason, 'in_debrief', type);
  assert.equal(r.receipt(r.send('join', { displayName: 'Late' }, { role: 'participant', id: uuidv7() })).reason, 'joining_closed');
  assert.equal(r.receipt(r.f('replay', { entryIndex: 0 })).receipt, 'accepted');
  assert.equal(r.state.display.cursor, 0);
  // The last slide replays by its index too: in Debrief a null cursor is the debrief page, not the live slide.
  const last = r.state.revealed.length - 1;
  r.f('replay', { entryIndex: last });
  assert.equal(r.state.display.cursor, last);
  assert.equal(project(r.state, 'display').surface.surfaceId, r.state.revealed[last].surfaceId);
  assert.deepEqual(facilitatorActions(r.state).sort(), ['back_to_case', 'debrief_page', 'end', 'remove_participant', 'rename', 'replay', 'takeover']);
});

test('debrief_page clamps to the pages there are, clears a replayed slide and is a display-only change', () => {
  const { r } = afterFirstReveal();
  r.f('debrief'); r.f('replay', { entryIndex: 0 });
  const before = r.state.revision, res = r.f('debrief_page', { page: 99 });
  const pages = project(r.state, 'facilitator').debrief.public.results.length + 1;
  assert.equal(r.state.debrief.page, pages - 1);
  assert.equal(r.state.display.cursor, null);
  assert.equal(r.state.revision, before, 'no journal');
  assert.ok(res.effects.some(e => e.type === 'display'));
  assert.equal(r.receipt(r.f('debrief_page', { page: -1 })).reason, 'bad_payload');
});

test('projections in Debrief: the projector gets the public debrief and its QR, a slide only while replayed; phones get their recap', () => {
  const { r, a, doc } = afterFirstReveal();
  r.f('debrief');
  const display = project(r.state, 'display');
  assert.equal(display.phase, 'debrief');
  assert.equal(display.surface, null);
  assert.equal(display.decision, null);
  assert.equal(display.responseResult, null);
  assert.equal(display.lastResult, null);
  assert.equal(display.feedbackCode, '7K3QX9');
  assert.ok(Array.isArray(display.debrief.results) && display.debrief.page === 0);
  // Only already-public text: no private notes, cues or rationales, no unrevealed surface titles.
  const revealed = new Set(r.state.revealed.map(e => e.surfaceId)), text = JSON.stringify(display);
  for (const surface of doc.surfaces) if (!revealed.has(surface.id)) assert.equal(text.includes(surface.title), false, surface.title);
  for (const beat of doc.beats) if (beat.cue) assert.equal(text.includes(beat.cue), false);
  for (const path of doc.decisions.flatMap(d => d.paths)) assert.equal(text.includes(path.rationale), false);
  r.f('replay', { entryIndex: 0 });
  assert.equal(project(r.state, 'display').surface.surfaceId, r.state.revealed[0].surfaceId);
  const phone = project(r.state, 'participant', a);
  assert.equal(phone.phase, 'debrief');
  assert.equal(phone.recap.feedbackCode, '7K3QX9');
  assert.equal(phone.recap.expiresAt, null, 'not ended: no expiry yet');
  assert.ok(phone.recap.rounds.length >= 1);
  const facilitator = project(r.state, 'facilitator');
  assert.equal(facilitator.debrief.resumePhase, 'consequence_revealed');
  // The review's questions are the console's alone: where each was asked, the route chosen and the routes not taken.
  const [q] = facilitator.debrief.questions, decision = doc.decisions.find(d => d.id === r.state.rounds[0].decisionId);
  assert.equal(facilitator.debrief.questions.length, 1);
  assert.equal(q.prompt, decision.prompt);
  assert.equal(q.total, 1);
  assert.equal(r.state.revealed[q.entryIndex].beatId, doc.beats.find(b => b.decision_id === decision.id).id);
  assert.equal(q.chosen.label, decision.paths.find(p => p.id === r.state.rounds[0].selectedPathId).label);
  assert.equal(q.notTaken.length, decision.paths.length - 1);
  // Its result is on the debrief's own pages (the room saw it at Lock): the page after the summary.
  assert.equal(facilitator.debrief.public.results[0].roundNo, q.roundNo);
  assert.ok(Number.isSafeInteger(q.resultPage) && q.resultPage >= 1);
  assert.equal(JSON.stringify(display).includes(q.notTaken[0].label), false);
});

test('End from Debrief ends the room and clears Debrief; the wire accepts the three commands and validates the page', () => {
  const { r } = afterFirstReveal();
  r.f('debrief'); r.f('replay', { entryIndex: 0 }); r.f('end');
  assert.equal(r.state.phase, 'ended');
  assert.equal(r.state.display.cursor, null, 'a Debrief replay ends with the room');
  assert.equal(r.state.debrief, null);
  for (const [type, extra] of [['debrief', {}], ['back_to_case', {}], ['debrief_page', { page: 2 }]])
    assert.equal(parseCommandEnvelope({ v: 1, type, epoch: 0, clientEventId: uuidv7(), ...extra }, 'facilitator').ok, true, type);
  assert.equal(parseCommandEnvelope({ v: 1, type: 'debrief_page', epoch: 0, clientEventId: uuidv7(), page: -1 }, 'facilitator').ok, false);
  assert.equal(parseCommandEnvelope({ v: 1, type: 'debrief', epoch: 0, clientEventId: uuidv7() }, 'participant').ok, false);
});

test('[AS-194] the console dock: Debrief on a complete case (press again), then Next by question with its result, Back and Forward by slide', async () => {
  const { dockControl, debriefNext, debriefSteps } = await import('../src/client/console-actions.mjs');
  const { r } = afterFirstReveal();
  // Not complete: the case still has a next beat, so the dock keeps its own primary.
  assert.notEqual(dockControl(project(r.state, 'facilitator'))?.local, 'debrief');
  const complete = { ...project(r.state, 'facilitator'), nextBeat: null, actions: ['debrief', 'end'], phase: 'consequence_revealed' };
  assert.deepEqual(dockControl(complete), { local: 'debrief', label: 'Debrief' });
  assert.deepEqual(dockControl(complete, { debriefArmed: true }), { local: 'debrief', label: 'Press again: Debrief', armed: true });
  r.f('debrief');
  const view = () => project(r.state, 'facilitator'), slides = r.state.revealed.length, q = view().debrief.questions[0];
  // CASE-327: from the summary, Next is the first question with its result on the projector (no slide-by-slide walk).
  assert.deepEqual(dockControl(view()), { command: 'debrief_page', payload: { page: q.resultPage }, label: 'Next: Question 1', debrief: true, note: 'The projector follows' });
  assert.deepEqual(debriefSteps(view()), { at: null, back: null, forward: { command: 'replay', payload: { entryIndex: 0 } } });
  // The last question's result goes back to the summary.
  r.f('debrief_page', { page: q.resultPage });
  assert.deepEqual(debriefNext(view()), { command: 'debrief_page', payload: { page: 0 }, label: 'Back to the summary' });
  // Its slide replayed from the strip goes on to its own result.
  r.f('replay', { entryIndex: q.entryIndex });
  assert.deepEqual(debriefNext(view()), { command: 'debrief_page', payload: { page: q.resultPage }, label: 'Next: Question 1 results' });
  // A slide after every question: back to the summary. Back from the first slide is the summary; Forward stops at the last.
  r.f('replay', { entryIndex: slides - 1 });
  if (slides - 1 > q.entryIndex) assert.deepEqual(debriefNext(view()), { command: 'debrief_page', payload: { page: 0 }, label: 'Back to the summary' });
  assert.equal(debriefSteps(view()).forward, null);
  r.f('replay', { entryIndex: 0 });
  assert.deepEqual(debriefSteps(view()).back, { command: 'debrief_page', payload: { page: 0 } });
});

test('[AS-194] Debrief pages a result the room was not shown live (CASE-327)', () => {
  const { r } = afterFirstReveal();
  r.f('debrief');
  // The same room had it never drawn the result live: Debrief still gives the question its result page.
  const unseen = { ...r.state, rounds: r.state.rounds.map(({ shown, ...round }) => round) };
  const q = project(unseen, 'facilitator').debrief.questions[0];
  assert.ok(Number.isSafeInteger(q.resultPage), 'the question has a result page');
  const pageUp = { ...unseen, debrief: { ...unseen.debrief, page: q.resultPage } }, shown = project(pageUp, 'display').debrief;
  assert.equal(shown.page, q.resultPage);
  assert.ok(shown.results.some(x => x.roundNo === q.roundNo && x.total === 1));
});
