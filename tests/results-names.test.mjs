import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, facilitatorActions } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
function room(type = 'single_choice') {
  const fixture = miniCase(), decision = fixture.doc.decisions[0], pid = uuidv7(), fid = uuidv7(), ledger = new Map();
  decision.interaction.type = type;
  if (type === 'ranking') decision.interaction.rank_count = 3;
  if (type === 'free_text') decision.interaction = { type, max_length: 280 };
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: fixture.doc });
  const send = (type, payload = {}, actor = { role: 'facilitator', id: fid }) => {
    const result = dispatch(state, { type, ...payload, actor, epoch: state.epoch, ...(['start','advance','lock','select_path','reveal'].includes(type) ? { expectRevision: state.revision } : {}),
      at: '2026-10-03T10:00:00Z', clientEventId: uuidv7(), ...(['advance','start'].includes(type) ? { roundId: uuidv7() } : {}) }, ledger);
    state = result.state; return result.effects.find(row => row.type === 'receipt');
  };
  const ok = (type, payload, actor) => assert.equal(send(type, payload, actor).receipt, 'accepted', type);
  ok('join', { displayName: 'Sam' }, { role: 'participant', id: pid }); ok('start'); ok('advance'); ok('advance');
  const ids = decision.interaction.options?.map(row => row.id);
  const response = type === 'ranking' ? { order: ids } : type === 'multi_select' ? { option_ids: [ids[0]] } : type === 'free_text' ? { text: 'Simulation answer' } : { option_id: ids[0] };
  ok('vote', { roundId: state.round.id, responseId: uuidv7(), response }, { role: 'participant', id: pid });
  return { fixture, pid, send, ok, get state() { return state; } };
}
test('Card24 closing every aggregate clears play names before exposing anonymous answer counts', () => {
  for (const type of ['single_choice','multi_select','ranking','free_text']) {
    const r = room(type); r.ok('show_names', { on: true });
    assert.equal(project(r.state, 'display').names[0].name, 'Sam');
    r.ok('lock'); const v = project(r.state, 'display');
    assert.equal(r.state.namesShown, false, type); assert.equal(v.names, null, type); assert.equal(v.avatars, null, type);
    assert.equal(v.responseResult.total, 1, type); assert.equal(r.state.resultsShown, true);
  }
});
test('Card24 explicitly showing responses clears names while preserving stored page and clinical state', () => {
  const r = room('ranking'); r.ok('lock'); r.ok('results_page', { page: 1 }); r.ok('show_results', { on: false }); r.ok('show_names', { on: true });
  const before = { round: structuredClone(r.state.round), history: structuredClone(r.state.revealed), flags: [...r.state.flags] };
  r.ok('show_results', { on: true }); const v = project(r.state, 'display');
  assert.equal(r.state.namesShown, false); assert.equal(v.names, null); assert.equal(v.responseResult.total, 1); assert.equal(v.resultsPage, 1);
  assert.deepEqual({ round: r.state.round, history: r.state.revealed, flags: r.state.flags }, before);
  r.ok('show_results', { on: false }); r.ok('show_names', { on: true }); r.ok('show_results', { on: false });
  assert.equal(r.state.namesShown, true, 'hiding responses does not hide names');
});
test('Card24 a visible chart refuses Show names until explicit Hide with replay and legacy Hide names allowed', () => {
  const r = room(); r.ok('lock'); const before = r.state;
  assert.equal(r.send('show_names', { on: true }).reason, 'hide_responses_first'); assert.equal(r.state, before);
  assert.ok(!facilitatorActions(r.state).includes('show_names'));
  const legacy = { ...r.state, namesShown: true }; assert.ok(facilitatorActions(legacy).includes('show_names'), 'legacy Hide names remains available');
  r.ok('show_results', { on: false }); r.ok('show_names', { on: true }); assert.equal(project(r.state, 'display').names[0].name, 'Sam');
  r.ok('show_names', { on: false }); r.ok('show_results', { on: true }); r.ok('replay', { entryIndex: 0 });
  r.ok('show_names', { on: true }); assert.equal(project(r.state, 'display').responseResult, null); assert.equal(project(r.state, 'display').names[0].name, 'Sam');
  const page = r.state.resultsPage; r.ok('replay', { entryIndex: null });
  assert.equal(r.state.namesShown, true); assert.equal(r.state.resultsShown, true); assert.equal(r.state.resultsPage, page);
  assert.equal(project(r.state, 'display').names, null); assert.equal(project(r.state, 'display').avatars, null); assert.equal(project(r.state, 'display').responseResult.total, 1);
});
test('Card24 restored legacy named states never pair a roster with current or after-consequence answer counts', () => {
  const r = room(); r.ok('lock');
  let restored = { ...JSON.parse(JSON.stringify(r.state)), namesShown: true };
  let view = project(restored, 'display'); assert.equal(view.names, null); assert.equal(view.avatars, null); assert.equal(view.responseResult.total, 1);
  r.ok('select_path', { pathId: r.fixture.p.decompress }); r.ok('show_results', { on: false }); r.ok('reveal'); r.ok('show_results', { on: true });
  restored = { ...JSON.parse(JSON.stringify(r.state)), namesShown: true };
  view = project(restored, 'display'); assert.equal(view.names, null); assert.equal(view.avatars, null); assert.equal(view.lastResult.total, 1);
  assert.equal(project(restored, 'participant', r.pid).lastResult.yourAnswer, 'Decompress the right chest');
  const ranked = room('ranking'); ranked.ok('lock'); ranked.ok('select_path', { pathId: ranked.fixture.p.decompress }); ranked.ok('show_results', { on: false }); ranked.ok('reveal'); ranked.ok('show_results', { on: true });
  restored = { ...JSON.parse(JSON.stringify(ranked.state)), namesShown: true };
  delete restored.rounds.at(-1).aggregate.positionCounts; delete restored.rounds.at(-1).aggregate.rankCount;
  restored.rounds.at(-1).answers = {}; delete restored.rounds.at(-1).responses;
  view = project(restored, 'display'); assert.equal(view.responseResult, null); assert.equal(view.lastResult.total, 1);
  assert.equal(view.names, null); assert.equal(view.avatars, null);
});
