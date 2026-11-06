import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { consoleRankingRows } from '../src/client/console-ranking.mjs';

test('Card24 console ranking formats every actual position and preserves its private first-choice suggestion', () => {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: fixture.doc });
  const ledger = new Map(); let tick = Date.parse('2026-10-03T09:00:00Z');
  const send = (type, payload = {}, actor = { role: 'facilitator', id: 'fac' }) => {
    const result = dispatch(state, { type, actor, epoch: state.epoch, clientEventId: uuidv7(),
      at: new Date(tick += 1000).toISOString(), ...(['start','advance'].includes(type) ? { roundId: uuidv7() } : {}), ...payload }, ledger);
    assert.equal(result.effects.find(row => row.type === 'receipt').receipt, 'accepted'); state = result.state;
  };
  const people = [uuidv7(), uuidv7()];
  for (const id of people) send('join', { displayName: 'Same' }, { role: 'participant', id });
  send('start');
  for (let step = 0; step < 20 && state.phase !== 'responses_open'; step++) send('advance');
  assert.equal(state.phase, 'responses_open');
  for (const [index, id] of people.entries()) send('vote', { roundId: state.round.id, responseId: uuidv7(), response: { order: index ? [fixture.o.decompress,fixture.o.intubate,fixture.o.image] : [fixture.o.decompress,fixture.o.image,fixture.o.intubate] } }, { role: 'participant', id });
  send('lock');
  const view = project(state, 'facilitator'), suggestion = structuredClone(view.round.suggestion);
  assert.deepEqual(consoleRankingRows(view.decision, view.round.aggregate), [
    'Decompress the right chest · Rank 1: 2 · Rank 2: 0 · Rank 3: 0',
    'Chest X-ray first · Rank 1: 0 · Rank 2: 1 · Rank 3: 1',
    'RSI and intubate · Rank 1: 0 · Rank 2: 1 · Rank 3: 1',
  ]);
  assert.deepEqual(view.round.suggestion, suggestion); assert.equal(suggestion.pathId, fixture.p.decompress);
  assert.equal(consoleRankingRows({ interaction: { type: 'single_choice' } }, view.round.aggregate), null);
  assert.equal(consoleRankingRows(view.decision, { total: 2, counts: view.round.aggregate.counts }), null, 'missing historical positions cannot be invented');
});
