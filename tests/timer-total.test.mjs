// CASE-320: the console's timer slider stops, and the timer's full length (timerTotalS) on every public screen, kept
// through Undo so a screen always knows how far through the timer it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { TIMER_STOPS, nearestTimerStop, timerSpoken } from '../src/shared/timer.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { miniCase } from './helpers/mini-case.mjs';

test('[AS-190] the slider has 21 stops: 5 s to a minute, 15 s to two, 30 s to five', () => {
  assert.equal(TIMER_STOPS.length, 21);
  assert.deepEqual(TIMER_STOPS.slice(0, 3), [10, 15, 20]);
  assert.deepEqual(TIMER_STOPS.slice(10, 15), [60, 75, 90, 105, 120]);
  assert.deepEqual(TIMER_STOPS.slice(-3), [240, 270, 300]);
  assert.equal(nearestTimerStop('95'), 90);
  assert.equal(nearestTimerStop(9000), 300);
  assert.equal(nearestTimerStop('garbage'), 90, 'a corrupt stored pick lands on 1:30');
  assert.equal(timerSpoken(90), '1 minute 30 seconds');
  assert.equal(timerSpoken(120), '2 minutes');
  assert.equal(timerSpoken(15), '15 seconds');
});

test('[AS-190] every public screen gets the timer length, and Undo of a lock keeps it', () => {
  const { doc, o } = miniCase();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), t = Date.parse('2026-10-30T09:00:00Z');
  const ledger = new Map(), fac = { role: 'facilitator', id: 'fac' }, pid = uuidv7();
  const send = (type, payload = {}, actor = fac) => { t += 1000; const r = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(t).toISOString(), clientEventId: uuidv7(), ...payload }, ledger); state = r.state; return r.effects.find(e => e.type === 'receipt'); };
  send('join', { displayName: 'Learner' }, { role: 'participant', id: pid });
  send('start', { roundId: uuidv7() });
  for (let n = 0; n < 15 && state.phase !== 'responses_open'; n++) send('advance', { roundId: uuidv7(), expectRevision: state.revision });
  assert.equal(send('set_timer', { seconds: 10 }).receipt, 'accepted', 'the slider minimum is accepted');
  assert.equal(send('set_timer', { seconds: 300 }).receipt, 'accepted', 'and its maximum');
  const display = project(state, 'display');
  assert.equal(display.timerTotalS, 300);
  assert.ok(acceptDisplayView(display));
  assert.equal(project(state, 'participant', pid).timerTotalS, 300);
  send('vote', { roundId: state.round.id, response: { option_id: o.image }, responseId: uuidv7() }, { role: 'participant', id: pid });
  t += 100_000; // 100 s in, so 200 s are left when the lock lands
  const lockCid = uuidv7();
  t += 1000; state = dispatch(state, { type: 'lock', epoch: state.epoch, actor: fac, at: new Date(t).toISOString(), clientEventId: lockCid }, ledger).state;
  assert.equal('timerTotalS' in project(state, 'display'), false, 'no timer, no key');
  const sourceRound = structuredClone(state.round);
  t += 1000;
  const undone = dispatch(state, { type: 'undo', epoch: state.epoch, actor: fac, at: new Date(t).toISOString(), clientEventId: uuidv7(), expectRevision: state.revision,
    targetEventId: lockCid, roundId: uuidv7(), sourceRound, seedResponseIds: { [pid]: uuidv7() } }, ledger);
  state = undone.state;
  assert.equal(state.phase, 'responses_open');
  assert.ok(state.timer.durationS <= 200 && state.timer.durationS >= 198, 'the reopened timer runs from what was left');
  assert.equal(project(state, 'display').timerTotalS, 300, 'the length is still the one the facilitator set');
});
