import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, PHASES, facilitatorActions } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { canLegacyPause, legacyPausedState } from './helpers/legacy-pause.mjs';

const FAC = { role: 'facilitator', id: 'facilitator' };
const AT0 = Date.UTC(2026, 9, 1, 9, 0, 0);
function room() {
  const { doc } = miniCase(), ledger = new Map();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), time = AT0;
  return {
    get state() { return state; },
    apply(type, payload = {}, actor = FAC) {
      const result = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(time += 1000).toISOString(),
        clientEventId: uuidv7(), ...(type === 'pause' ? {} : { roundId: uuidv7() }), ...payload }, ledger);
      state = result.state; return result;
    },
    resumePersisted(paused, at) {
      return dispatch(paused, { type: 'resume', epoch: paused.epoch, actor: FAC, at,
        clientEventId: uuidv7() }, ledger);
    },
  };
}

test('the legacy pause fixture admits exactly the historical six live phases, never a later or unknown phase', () => {
  const historical = ['surface_live', 'responses_open', 'responses_locked', 'path_selected', 'consequence_revealed', 'terminal_teaching'];
  assert.deepEqual(PHASES.filter(phase => canLegacyPause({ phase })), historical);
  for (const phase of ['lobby', 'discussion_paused', 'ended', 'debrief', 'future_phase']) {
    assert.equal(canLegacyPause({ phase }), false, phase);
    assert.throws(() => legacyPausedState({ phase }, new Date(AT0).toISOString()), /could not be paused/, phase);
  }
});

test('a genuine historical paused round retains its document/timer and resumes through the real reducer', () => {
  const r = room();
  r.apply('start');
  for (let step = 0; step < 15 && r.state.phase !== 'responses_open'; step++) r.apply('advance');
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.apply('set_timer', { seconds: 60 }).effects[0].receipt, 'accepted');
  const before = r.state, unchanged = structuredClone(before);
  const pauseAt = new Date(Date.parse(before.timer.startedAt) + 10_000).toISOString();
  const paused = legacyPausedState(before, pauseAt);
  assert.equal(paused.phase, 'discussion_paused');
  assert.equal(paused.resumePhase, 'responses_open');
  assert.equal(paused.revision, before.revision + 1);
  assert.equal(paused.caseDoc, before.caseDoc);
  assert.equal(paused.timer.remainingS, 50);
  assert.deepEqual(before, unchanged, 'the persisted fixture never mutates the original state');
  const resumeAt = new Date(Date.parse(pauseAt) + 1000).toISOString();
  const resumed = r.resumePersisted(paused, resumeAt);
  assert.equal(resumed.effects[0].receipt, 'accepted');
  assert.equal(resumed.state.phase, 'responses_open');
  assert.equal(resumed.state.resumePhase, null);
  assert.deepEqual(resumed.state.timer, { durationS: 50, startedAt: resumeAt, remainingS: null, totalS: 60 }, 'CASE-320: the set length survives the resume');
});

test('CI seed -848153935: start → debrief → pause → start leaves Debrief unchanged and cannot synthesize a legacy pause', () => {
  // Exact reduced command sequence from run39111944606, with the model's three setup joins.
  const r = room();
  for (let i = 0; i < 3; i++) r.apply('join', { displayName: 'P' }, { role: 'participant', id: uuidv7() });
  for (const [type, expectedPhase, expectedReason] of [
    ['start', 'surface_live', null], ['debrief', 'debrief', null],
    ['pause', 'debrief', 'in_debrief'], ['start', 'debrief', 'in_debrief'],
  ]) {
    const before = r.state, result = r.apply(type), receipt = result.effects[0];
    assert.equal(receipt.receipt, expectedReason ? 'rejected' : 'accepted', type);
    assert.equal(receipt.reason ?? null, expectedReason, type);
    assert.equal(r.state.phase, expectedPhase, type);
    assert.equal(r.state.resumePhase, null, 'the real sequence never enters a paused state');
    if (expectedReason) {
      assert.equal(r.state, before, `${type}: refused commands preserve the exact state object`);
      assert.deepEqual(result.effects.map(effect => effect.type), ['receipt']);
    }
    if (r.state.phase === 'debrief') {
      assert.equal(canLegacyPause(r.state), false);
      assert.throws(() => legacyPausedState(r.state, new Date(AT0 + 60_000).toISOString()), /could not be paused from debrief/);
      assert.equal(r.state, result.state);
      assert.equal(facilitatorActions(r.state).includes('pause'), false);
    }
  }
  assert.equal(r.state.debrief.resumePhase, 'surface_live', 'the reversible Debrief return state is preserved');
});
