import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, facilitatorActions } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { legacyPausedState } from './helpers/legacy-pause.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { parseCommandEnvelope } from '../src/shared/wire.mjs';
import fc from 'fast-check';

function room(fixture = miniCase()) {
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: fixture.doc });
  const facilitatorId = uuidv7();
  const ledger = new Map(); let at = Date.parse('2026-10-03T09:00:00Z');
  const send = (type, payload = {}, actor = { role: 'facilitator', id: facilitatorId }) => {
    const result = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(at += 1000).toISOString(),
      clientEventId: uuidv7(), ...(['start', 'advance', 'reopen', 'reset_checkpoint'].includes(type) ? { roundId: uuidv7() } : {}), ...payload }, ledger);
    state = result.state;
    return result.effects.find(effect => effect.type === 'receipt')?.receipt;
  };
  const join = name => { const id = uuidv7(); assert.equal(send('join', { displayName: name }, { role: 'participant', id }), 'accepted'); return id; };
  const vote = (id, response) => send('vote', { roundId: state.round.id, responseId: uuidv7(), response }, { role: 'participant', id });
  // A room persisted while paused before CASE-255 retired Pause for discussion.
  const legacyPause = () => { state = legacyPausedState(state, new Date(at += 1000).toISOString()); return 'accepted'; };
  return { fixture, send, join, vote, legacyPause, get state() { return state; }, display: () => project(state, 'display') };
}

test('[AS-088] Card24 lobby exposes cleaned names without identities and counts only fresh arrivals', () => {
  const r = room(); const a = r.join('  Same  '); const b = r.join('Same');
  assert.ok(!facilitatorActions(r.state).includes('show_names'), 'automatic lobby names have no toggle');
  assert.equal(r.display().arrivalCount, 2);
  assert.deepEqual(r.display().names.map(row => row.name), ['Same', 'Same']);
  assert.equal(r.display().avatars, null);
  assert.ok(!JSON.stringify(r.display()).includes(a));
  r.send('rename', { displayName: 'Changed' }, { role: 'participant', id: a });
  r.send('join', { displayName: 'Changed' }, { role: 'participant', id: a });
  r.send('remove_participant', { participantId: b });
  assert.equal(r.display().arrivalCount, 2);
  assert.equal(r.display().counts.participants, 1);
  r.send('start'); assert.equal(r.display().names, null, 'play remains names opt-in');
});

test('[AS-089] Card24 closed anonymous result appears before path choice and Hide persists until next round', () => {
  const r = room(); const a = r.join('Private participant'); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  r.vote(a, { option_id: r.fixture.o.decompress });
  assert.equal(r.display().responseResult, null);
  assert.equal(r.send('show_results', { on: false }), 'rejected');
  r.send('lock'); const closed = r.display().responseResult;
  assert.equal(closed.total, 1); assert.deepEqual(closed.counts.map(row => row.count), [1, 0, 0]);
  assert.equal(project(r.state, 'participant', a).lastResult, null);
  assert.ok(facilitatorActions(r.state).includes('show_results'));
  assert.equal(project(r.state, 'facilitator').resultsShown, true);
  for (const key of ['suggestion', 'classification', 'pathId', 'howChosen', 'whatHappened']) assert.ok(!Object.hasOwn(closed, key));
  r.send('select_path', { pathId: r.fixture.p.decompress }); assert.deepEqual(r.display().responseResult, closed);
  assert.equal(r.send('show_results', { on: false }), 'accepted');
  assert.equal(project(r.state, 'facilitator').resultsShown, false);
  r.send('reveal'); assert.equal(r.display().responseResult, null); assert.equal(r.display().lastResult, null);
  assert.ok(project(r.state, 'participant', a).lastResult, 'phone result keeps consequence timing');
  r.send('show_results', { on: true }); assert.ok(r.display().responseResult);
  r.send('replay', { surfaceId: r.fixture.s.open }); assert.equal(r.display().responseResult, null);
  r.send('advance'); assert.equal(r.state.resultsShown, true); assert.equal(r.display().responseResult, null);
});

test('[AS-089] Card24 ranking preserves all positions, legal shorter rankings and zero cells', () => {
  const fixture = miniCase(); const d = fixture.doc.decisions[0];
  d.interaction.type = 'ranking'; d.interaction.rank_count = 2;
  d.paths.forEach(path => { delete path.option_ids; });
  d.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const r = room(fixture); const [a, b] = [r.join('A'), r.join('B')]; r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  assert.equal(r.vote(a, { order: [fixture.o.decompress, fixture.o.image] }), 'accepted');
  assert.equal(r.vote(b, { order: [fixture.o.decompress, fixture.o.intubate] }), 'accepted');
  r.send('lock'); const result = r.display().responseResult;
  assert.equal(result.rankCount, 2);
  assert.deepEqual(result.counts.map(row => row.positionCounts), [[2, 0], [0, 1], [0, 1]]);
  assert.deepEqual(result.counts.map(row => row.count), [2, 0, 0]);
  assert.equal(r.state.round.suggestion.pathId, fixture.p.decompress);
  r.send('select_path', { pathId: fixture.p.decompress }); assert.equal(r.send('show_results', { on: false }), 'accepted'); assert.equal(r.send('reveal'), 'accepted'); assert.equal(r.send('show_results', { on: true }), 'accepted');
  assert.deepEqual(project(r.state, 'participant', a).lastResult.counts.map(row => row.positionCounts), [[2, 0], [0, 1], [0, 1]]);
});

test('Card24 result command is strictly boolean and facilitator-only on the wire', () => {
  const command = { v: 1, type: 'show_results', epoch: 0, clientEventId: uuidv7(), on: false };
  assert.equal(parseCommandEnvelope(command, 'facilitator').ok, true);
  for (const role of ['participant', 'display']) assert.equal(parseCommandEnvelope(command, role).ok, false);
  for (const on of [null, 0, 'false', {}, undefined]) assert.equal(parseCommandEnvelope({ ...command, on }, 'facilitator').ok, false);
  assert.equal(parseCommandEnvelope({ ...command, pathId: uuidv7() }, 'facilitator').ok, false);
});

test('Card24 display validator rejects corrupt ranking dimensions, totals and private result fields', () => {
  const fixture = miniCase(); const d = fixture.doc.decisions[0];
  d.interaction.type = 'ranking'; d.interaction.rank_count = 2; d.paths.forEach(path => { delete path.option_ids; });
  d.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const r = room(fixture); const a = r.join('A'); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  r.vote(a, { order: [fixture.o.decompress, fixture.o.image] }); r.send('lock');
  const clean = r.display(); assert.equal(acceptDisplayView(clean), clean);
  const mutate = change => { const next = structuredClone(clean); change(next); assert.equal(acceptDisplayView(next), null); };
  mutate(v => { v.arrivalCount = 301; });
  mutate(v => { v.arrivalCount = 0; });
  mutate(v => { v.responseResult.rankCount = 3; });
  mutate(v => { v.responseResult.rankCount = 3; v.responseResult.counts.forEach(row => row.positionCounts.push(0));
    v.responseResult.counts[2].positionCounts[2] = 1; });
  mutate(v => { v.responseResult.counts[0].positionCounts = [1]; });
  mutate(v => { v.responseResult.counts[0].positionCounts[0] = 2; });
  mutate(v => { v.responseResult.counts[0].count = 0; });
  mutate(v => { v.responseResult.counts[1].optionId = v.responseResult.counts[0].optionId; });
  mutate(v => { v.responseResult.counts[0].optionId = uuidv7(); });
  for (const key of ['pathId', 'suggestion', 'classification', 'text', 'participantId']) mutate(v => { v.responseResult[key] = 'private'; });
  mutate(v => { v.replay = true; }); mutate(v => { v.resultsShown = false; });
});

test('Card24 older ranking snapshots recover positions only from retained actual answers', () => {
  const fixture = miniCase(); const d = fixture.doc.decisions[0];
  d.interaction.type = 'ranking'; d.interaction.rank_count = 2; d.paths.forEach(path => { delete path.option_ids; });
  d.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const r = room(fixture); const a = r.join('A'); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  r.vote(a, { order: [fixture.o.image, fixture.o.intubate] }); r.send('lock');
  delete r.state.round.aggregate.positionCounts; delete r.state.round.aggregate.rankCount;
  assert.deepEqual(r.display().responseResult.counts.map(row => row.positionCounts), [[0, 0], [1, 0], [0, 1]]);
  r.send('select_path', { pathId: fixture.p.decompress }); assert.equal(r.send('show_results', { on: false }), 'accepted'); assert.equal(r.send('reveal'), 'accepted'); assert.equal(r.send('show_results', { on: true }), 'accepted');
  assert.deepEqual(project(r.state, 'participant', a).lastResult.counts.map(row => row.positionCounts), [[0, 0], [1, 0], [0, 1]]);
  r.state.rounds.at(-1).answers = {};
  assert.equal(r.display().responseResult, null, 'missing history never becomes an invented zero distribution');
});

test('Card24 held, void and manual rounds never invent charts; free text appears only on closed anonymous pages', () => {
  const fixture = miniCase(); const decision = fixture.doc.decisions[0];
  decision.interaction = { type: 'free_text', max_length: 280 }; decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [];
  const r = room(fixture); const a = r.join('A'); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  assert.equal(r.vote(a, { text: 'Discussion answer for the projector' }), 'accepted');
  r.legacyPause(); assert.equal(r.display().responseResult, null);
  assert.equal(r.send('resume'), 'accepted'); r.send('lock');
  assert.equal(r.display().responseResult.total, 1); assert.deepEqual(r.display().responseResult.counts, []);
  assert.deepEqual(r.display().responseResult.textPage.answers, ['Discussion answer for the projector']);
  assert.equal(r.display().names, null);
  r.legacyPause(); assert.equal(r.display().responseResult.total, 1);
  r.send('show_results', { on: false }); assert.equal(r.send('resume'), 'accepted'); assert.equal(r.display().responseResult, null);
  r.send('show_results', { on: true }); r.send('void_round'); assert.equal(r.display().responseResult, null);
  r.send('advance'); r.send('lock'); r.send('enter_manual', { segmentId: uuidv7() });
  assert.equal(r.display().responseResult, null, 'manual entry voided this round, not a closed count');
});

test('Card24 ranking replacements and duplicate events cannot inflate position counts', () => {
  const fixture = miniCase(); const d = fixture.doc.decisions[0];
  d.interaction.type = 'ranking'; d.interaction.rank_count = 3; d.paths.forEach(path => { delete path.option_ids; });
  d.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const r = room(fixture); const [a, b] = [r.join('A'), r.join('B')]; r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  const options = d.interaction.options.map(option => option.id);
  r.vote(a, { order: [options[1], options[0], options[2]] });
  const latest = { roundId: r.state.round.id, responseId: uuidv7(), response: { order: options }, clientEventId: uuidv7() };
  assert.equal(r.send('vote', latest, { role: 'participant', id: a }), 'accepted');
  assert.equal(r.send('vote', latest, { role: 'participant', id: a }), 'already_accepted');
  r.vote(b, { order: [options[0], options[2], options[1]] }); r.send('lock');
  assert.equal(r.display().responseResult.total, 2);
  assert.deepEqual(r.display().responseResult.counts.map(row => row.positionCounts), [[2, 0, 0], [0, 1, 1], [0, 1, 1]]);
});

test('Card24 final display ranking rejects inconsistent positions and invented options', () => {
  const fixture = miniCase(); const d = fixture.doc.decisions[0];
  d.interaction.type = 'ranking'; d.interaction.rank_count = 2; d.paths.forEach(path => { delete path.option_ids; });
  d.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const r = room(fixture); const a = r.join('A'); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  r.vote(a, { order: [fixture.o.decompress, fixture.o.image] }); r.send('lock');
  r.send('select_path', { pathId: fixture.p.decompress }); assert.equal(r.send('show_results', { on: false }), 'accepted'); assert.equal(r.send('reveal'), 'accepted'); assert.equal(r.send('show_results', { on: true }), 'accepted');
  const clean = r.display(); assert.equal(acceptDisplayView(clean), clean);
  for (const change of [v => { v.lastResult.counts[0].positionCounts = [1]; },
    v => { v.lastResult.rankCount = 3; }, v => { v.lastResult.counts[0].positionCounts[0] = 2; },
    v => { v.lastResult.counts[0].optionId = uuidv7(); }]) {
    const next = structuredClone(clean); change(next); assert.equal(acceptDisplayView(next), null);
  }
});

test('Card24 ranking property counts every latest accepted position and no duplicate receipt', () => {
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  fc.assert(fc.property(fc.integer({ min: 2, max: 3 }), fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 20 }),
    (length, choices) => {
      const fixture = miniCase(), decision = fixture.doc.decisions[0];
      decision.interaction.type = 'ranking'; decision.interaction.rank_count = length;
      decision.paths.forEach(path => { delete path.option_ids; });
      decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
      const r = room(fixture), people = choices.map(() => r.join('Same'));
      r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
      const ids = decision.interaction.options.map(option => option.id);
      const expected = ids.map(() => Array(length).fill(0));
      choices.forEach((choice, i) => {
        r.vote(people[i], { order: orders[(choice + 1) % orders.length].slice(0, length).map(index => ids[index]) });
        const order = orders[choice].slice(0, length);
        const latest = { roundId: r.state.round.id, responseId: uuidv7(), clientEventId: uuidv7(), response: { order: order.map(index => ids[index]) } };
        assert.equal(r.send('vote', latest, { role: 'participant', id: people[i] }), 'accepted');
        assert.equal(r.send('vote', latest, { role: 'participant', id: people[i] }), 'already_accepted');
        order.forEach((index, position) => { expected[index][position]++; });
      });
      r.send('lock'); const result = r.display().responseResult;
      assert.equal(result.total, choices.length);
      assert.deepEqual(result.counts.map(row => row.positionCounts), expected);
      const view = r.display(); assert.equal(acceptDisplayView(view), view);
    }), { numRuns: 50, seed: 2403 });
});

function pagedRankingRoom() {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 8;
  while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: `Option ${decision.interaction.options.length + 1}` });
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  return room(fixture);
}

test('Card24 ranking page changes only closed visible presentation and resets with a new round', () => {
  const r = pagedRankingRoom(), participant = r.join('Private participant');
  assert.equal(r.state.resultsPage, 0);
  assert.equal(r.send('results_page', { page: 1 }), 'rejected');
  r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  assert.equal(r.send('results_page', { page: 1 }), 'rejected');
  r.vote(participant, { order: r.fixture.doc.decisions[0].interaction.options.map(option => option.id) }); r.send('lock');
  const invariant = () => structuredClone({ round: r.state.round, rounds: r.state.rounds, revealed: r.state.revealed,
    selectedPathId: r.state.selectedPathId, flags: r.state.flags, phase: r.state.phase });
  const before = invariant(), counts = r.display().responseResult;
  assert.ok(facilitatorActions(r.state).includes('results_page'));
  const command = { page: 3, clientEventId: uuidv7() };
  assert.equal(r.send('results_page', command), 'accepted');
  assert.equal(r.send('results_page', command), 'already_accepted');
  assert.deepEqual(invariant(), before); assert.deepEqual(r.display().responseResult, counts);
  assert.equal(r.display().resultsPage, 3); assert.equal(project(r.state, 'facilitator').resultsPage, 3);
  assert.equal(project(r.state, 'facilitator').resultsPageCount, 4);
  assert.ok(!JSON.stringify(r.display()).includes(participant));
  for (const page of [-1, 4, 1.5, '1', null]) assert.equal(r.send('results_page', { page }), 'rejected');
  assert.equal(r.send('results_page', { page: 0 }, { role: 'participant', id: participant }), 'rejected');
  r.send('show_results', { on: false }); assert.equal(r.state.resultsPage, 3);
  assert.equal(r.send('results_page', { page: 0 }), 'rejected');
  r.send('show_results', { on: true }); assert.equal(r.display().resultsPage, 3);
  r.send('replay', { surfaceId: r.fixture.s.open });
  assert.equal(r.send('results_page', { page: 0 }), 'rejected'); assert.equal(r.state.resultsPage, 3);
  r.send('replay', { surfaceId: null }); r.legacyPause();
  assert.equal(r.send('results_page', { page: 0 }), 'accepted'); assert.equal(r.send('resume'), 'accepted');
  r.send('results_page', { page: 1 }); r.send('reopen'); assert.equal(r.state.resultsPage, 0);
  const ordinary = room(); ordinary.send('start'); ordinary.send('advance'); assert.equal(ordinary.state.round, null, 'context is prepared before Open'); assert.equal(ordinary.send('advance'), 'accepted', 'explicit Open after complete context'); ordinary.send('lock');
  assert.equal(ordinary.send('results_page', { page: 0 }), 'rejected');
});

test('Card24 ranking page wire allows only bounded facilitator indices', () => {
  const command = { v: 1, type: 'results_page', epoch: 0, clientEventId: uuidv7(), page: 1 };
  for (const page of [0, 1, 2, 3]) assert.equal(parseCommandEnvelope({ ...command, page }, 'facilitator').ok, true);
  for (const page of [-1, 4, 1.5, '1', null, undefined]) assert.equal(parseCommandEnvelope({ ...command, page }, 'facilitator').ok, false);
  for (const role of ['participant', 'display']) assert.equal(parseCommandEnvelope(command, role).ok, false);
  assert.equal(parseCommandEnvelope({ ...command, pathId: uuidv7() }, 'facilitator').ok, false);
});

test('Card24 display validates bounded ranking page without discarding complete anonymous counts', () => {
  const r = pagedRankingRoom(); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context'); r.send('lock');
  const clean = r.display(); assert.equal(clean.resultsPage, 0); assert.equal(acceptDisplayView(clean), clean);
  assert.equal(clean.responseResult.counts.length, 8);
  for (const resultsPage of [1, 2, 3]) { const next = { ...clean, resultsPage }; assert.equal(acceptDisplayView(next), next); }
  const forged = structuredClone(clean), extra = { optionId: uuidv7(), label: 'Forged ninth option', count: 0, positionCounts: Array(8).fill(0) };
  forged.responseResult.counts.push(extra);
  forged.decision.interaction.options.push({ id: extra.optionId, label: extra.label, disabled: false, explored: false });
  assert.equal(acceptDisplayView(forged), null);
  for (const resultsPage of [-1, 4, 1.5, null, '1']) assert.equal(acceptDisplayView({ ...clean, resultsPage }), null);
  const ordinary = room(); ordinary.send('start'); ordinary.send('advance'); assert.equal(ordinary.state.round, null, 'context is prepared before Open'); assert.equal(ordinary.send('advance'), 'accepted', 'explicit Open after complete context'); ordinary.send('lock');
  assert.equal(acceptDisplayView({ ...ordinary.display(), resultsPage: 1 }), null);
});

test('Card24 open ranking projection refuses authored option and rank limits before any result', () => {
  const r = pagedRankingRoom(); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context');
  const clean = r.display(); assert.equal(acceptDisplayView(clean), clean);
  const tooMany = structuredClone(clean);
  tooMany.decision.interaction.options.push({ id: uuidv7(), label: 'Ninth option', disabled: false, explored: false });
  assert.equal(acceptDisplayView(tooMany), null);
  const tooManyRanks = structuredClone(clean); tooManyRanks.decision.interaction.rankCount = 9;
  assert.equal(acceptDisplayView(tooManyRanks), null);
});

test('Card24 legacy ranking result cannot introduce a ninth option without a current chart', () => {
  const r = pagedRankingRoom(); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context'); r.send('lock');
  r.send('select_path', { pathId: r.fixture.p.decompress }); assert.equal(r.send('show_results', { on: false }), 'accepted'); assert.equal(r.send('reveal'), 'accepted'); assert.equal(r.send('show_results', { on: true }), 'accepted');
  const clean = structuredClone({ ...r.display(), responseResult: null });
  delete clean.lastResult.rankCount; clean.lastResult.counts.forEach(row => { delete row.positionCounts; });
  assert.equal(acceptDisplayView(clean), clean);
  const forged = structuredClone(clean);
  forged.lastResult.counts.push({ optionId: uuidv7(), label: 'Ninth option', count: 0 });
  assert.equal(acceptDisplayView(forged), null);
  const invalidFirstCounts = structuredClone(clean);
  invalidFirstCounts.lastResult.total = 301; invalidFirstCounts.lastResult.counts[0].count = 302;
  assert.equal(acceptDisplayView(invalidFirstCounts), null);
});


test('Card24 three-option rankings retain their third option on a bounded second page', () => {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
  decision.paths.forEach(path => { delete path.option_ids; });
  const r = room(fixture); r.send('start'); r.send('advance'); assert.equal(r.state.round, null, 'context is prepared before Open'); assert.equal(r.send('advance'), 'accepted', 'explicit Open after complete context'); r.send('lock');
  assert.equal(r.display().responseResult.counts.length, 3);
  assert.ok(facilitatorActions(r.state).includes('results_page'));
  assert.equal(project(r.state, 'facilitator').resultsPageCount, 2);
  assert.equal(r.send('results_page', { page: 1 }), 'accepted');
  assert.equal(r.display().resultsPage, 1);
  const view = r.display(); assert.equal(acceptDisplayView(view), view);
  assert.equal(r.send('results_page', { page: 2 }), 'rejected');
});


function eligibleRankingRoom({ disabledCount = 1, rankCount } = {}) {
  const fixture = miniCase(); const d = fixture.doc.decisions[0];
  d.interaction.type = 'ranking';
  if (rankCount === undefined) delete d.interaction.rank_count;
  else d.interaction.rank_count = rankCount;
  d.paths.forEach(path => { delete path.option_ids; });
  const r = room(fixture); const participant = r.join('Rank learner');
  r.state.disabledOptions[d.id] = d.interaction.options.slice(-disabledCount).map(option => option.id);
  const eligible = d.interaction.options.slice(0, d.interaction.options.length - disabledCount).map(option => option.id);
  assert.equal(r.send('start'), 'accepted');
  for (let i = 0; i < 20 && r.state.phase !== 'responses_open'; i++) assert.equal(r.send('advance'), 'accepted');
  assert.equal(r.state.phase, 'responses_open');
  return { r, participant, eligible, d };
}

test('Card24 default ranking closes with actual eligible length and survives resolved public projection', () => {
  const { r, participant, eligible } = eligibleRankingRoom();
  assert.equal(r.vote(participant, { order: eligible }), 'accepted');
  assert.equal(r.send('lock'), 'accepted');
  assert.equal(r.state.round.aggregate.rankCount, 2);
  assert.deepEqual(r.state.round.aggregate.eligibleOptionIds, eligible);
  const locked = r.display();
  assert.equal(locked.decision.interaction.rankCount, 2);
  assert.equal(locked.responseResult.rankCount, 2);
  assert.equal(acceptDisplayView(locked), locked);
  assert.equal(r.send('select_path', { pathId: r.fixture.p.decompress }), 'accepted');
  assert.equal(r.send('show_results', { on: false }), 'accepted');
  assert.equal(r.send('reveal'), 'accepted');
  assert.equal(r.send('show_results', { on: true }), 'accepted');
  const resolved = r.display();
  assert.equal(resolved.lastResult.rankCount, 2);
  assert.equal(project(r.state, 'participant', participant).lastResult.rankCount, 2);
  assert.equal(acceptDisplayView(resolved), resolved);
});

test('Card24 explicit authored ranking length is never shrunk to fit disabled options', () => {
  const { r, participant, eligible } = eligibleRankingRoom({ rankCount: 3 });
  assert.equal(r.vote(participant, { order: eligible }), 'rejected');
  assert.equal(Object.keys(r.state.round.responses).length, 0);
  assert.equal(r.send('lock'), 'accepted');
  assert.equal(r.state.round.aggregate.rankCount, 3);
  const frame = r.display(); assert.equal(acceptDisplayView(frame), frame);
});

test('Card24 one-eligible legacy ranking reconstructs only actual complete response positions', () => {
  const { r, participant, eligible } = eligibleRankingRoom({ disabledCount: 2 });
  assert.equal(r.vote(participant, { order: eligible }), 'accepted');
  assert.equal(r.send('lock'), 'accepted');
  delete r.state.round.aggregate.positionCounts;
  delete r.state.round.aggregate.rankCount;
  delete r.state.round.aggregate.eligibleOptionIds;
  const legacy = r.display();
  assert.equal(legacy.responseResult.rankCount, 1);
  assert.deepEqual(legacy.responseResult.counts.map(row => row.positionCounts), [[1], [0], [0]]);
  assert.equal(acceptDisplayView(legacy), legacy);
  r.state.round.responses = {};
  assert.equal(r.display().responseResult, null, 'first-choice history alone cannot invent positions');
});

test('Card24 restored zero-eligible ranking rejects blank responses and exposes no invented open rank', () => {
  const { r, participant } = eligibleRankingRoom({ disabledCount: 3 });
  const open = r.display();
  assert.equal(open.decision.interaction.rankCount, null);
  assert.equal(acceptDisplayView(open), open);
  const eligible = structuredClone(open); eligible.decision.interaction.options[0].disabled = false;
  assert.equal(acceptDisplayView(eligible), null);
  const noOptions = structuredClone(open); noOptions.decision.interaction.options = [];
  assert.equal(acceptDisplayView(noOptions), null);
  assert.equal(r.vote(participant, { order: [] }), 'rejected');
  assert.equal(Object.keys(r.state.round.responses).length, 0);
});

test('Card24 zero-eligible closed ranking permits only proven zero-answer count-only frames', () => {
  const { r } = eligibleRankingRoom({ disabledCount: 3 });
  assert.equal(r.send('lock'), 'accepted');
  const closed = r.display();
  assert.equal(closed.responseResult.total, 0);
  assert.equal(closed.responseResult.rankCount, null);
  assert.deepEqual(closed.responseResult.counts, []);
  assert.equal(acceptDisplayView(closed), closed);
  for (const perturb of [
    frame => { frame.responseResult.total = 1; },
    frame => { frame.responseResult.counts = [{ optionId: r.fixture.o.decompress, label: 'forged', count: 1, positionCounts: null }]; },
    frame => { frame.decision.interaction.options[0].disabled = false; },
    frame => { frame.decision = null; },
  ]) {
    const forged = structuredClone(closed); perturb(forged); assert.equal(acceptDisplayView(forged), null);
  }
  // A legacy accepted blank was never an answer and cannot become a truthful empty result.
  r.state.round.aggregate.total = 1;
  assert.equal(r.display().responseResult, null);
});

test('Card24 zero-eligible consequence and phone results contain no invented ranking rows', () => {
  const { r, participant } = eligibleRankingRoom({ disabledCount: 3 });
  assert.equal(r.send('lock'), 'accepted');
  assert.equal(r.send('select_path', { pathId: r.fixture.p.decompress }), 'accepted');
  assert.equal(r.send('show_results', { on: false }), 'accepted');
  assert.equal(r.send('reveal'), 'accepted');
  assert.equal(r.send('show_results', { on: true }), 'accepted');
  const resolved = r.display(), phone = project(r.state, 'participant', participant);
  assert.equal(resolved.responseResult, null, 'no current eligibility evidence after consequence');
  assert.equal(resolved.lastResult.total, 0); assert.deepEqual(resolved.lastResult.counts, []);
  assert.equal(resolved.lastResult.rankCount, undefined);
  assert.deepEqual(phone.lastResult.counts, []); assert.equal(phone.lastResult.rankCount, undefined);
  assert.equal(acceptDisplayView(resolved), resolved);
  r.state.rounds.at(-1).aggregate.total = 1;
  assert.equal(r.display().lastResult, null, 'old accepted empty order is not a zero-answer result');
  assert.equal(project(r.state, 'participant', participant).lastResult, null);
});
