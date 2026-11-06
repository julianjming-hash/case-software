import test from 'node:test';
import assert from 'node:assert/strict';
import { miniCase } from './helpers/mini-case.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { undoDescriptor } from '../src/shared/room-corrections.mjs';
import { withOrdinaryMappings } from '../src/shared/ordinary-question.mjs';
import { primaryAction, armedRoute } from '../src/client/console-actions.mjs';
import { createRouteSelection } from '../src/client/console-route-selection.mjs';

function ordinaryQuestion() {
  const doc = convertSchema1ToBuilderDocument(miniCase().doc, { metadata_version: 1 }).candidate;
  const decision = doc.decisions[0], path = decision.paths[0];
  decision.paths = [{ ...path, continue_to_next: true, classification: 'discussion-prompt', option_ids: decision.interaction.options.map(item => item.id) }];
  delete decision.paths[0].set_flags; delete decision.paths[0].clear_flags;
  for (const beat of doc.beats) delete beat.requires_flags;
  doc.required_capabilities.push('direct_continuation');
  return doc;
}
test('ordinary Continue publishes the next story once, without an outcome screen, and Undo restores its locked discussion', () => {
  const doc = ordinaryQuestion(), decision = doc.decisions[0], path = decision.paths[0];
  assert.equal(validateBuilderDocument(doc, { metadata_version: 1 }, { mode: 'ready' }).ok, true);
  let state = initialState({ sessionId: uuidv7(), caseDoc: doc }); const ledger = new Map(); let n = 0;
  function send(type, payload = {}) {
    const result = dispatch(state, { type, epoch: state.epoch, expectRevision: state.revision, actor: { role: 'facilitator', id: 'fac' }, at: new Date(1800000000000 + n++ * 1000).toISOString(), clientEventId: uuidv7(), ...payload }, ledger);
    const receipt = result.effects.find(item => item.type === 'receipt');
    assert.equal(receipt?.receipt, 'accepted', receipt?.reason); state = result.state; return result;
  }
  send('start', { roundId: uuidv7() });
  for (let i = 0; i < 10 && state.phase !== 'responses_open'; i++) send('advance', { roundId: uuidv7() });
  assert.equal(state.phase, 'responses_open'); send('lock');
  const oldRound = structuredClone(state.round), context = state.revealed.at(-1), count = state.revealed.length;
  send('reveal_path', { pathId: path.id });
  assert.equal(state.phase, 'surface_live'); assert.equal(state.beatId, path.next_beat_id);
  assert.equal(state.revealed.length, count + 1); assert.equal(state.revealed.at(-1).kind, 'live');
  assert.notEqual(state.liveSurfaceId, path.reveal_surface_id);
  assert.equal(undoDescriptor(state).available, true);
  for (const role of ['display', 'participant']) assert.equal(JSON.stringify(project(state, role)).includes(path.rationale), false);
  send('undo', { targetEventId: undoDescriptor(state).targetEventId, sourceRound: oldRound, roundId: uuidv7() });
  assert.equal(state.phase, 'responses_locked'); assert.equal(state.decisionId, decision.id);
  assert.equal(state.liveSurfaceId, context.surfaceId); assert.equal(state.round.seedSourceRoundId, oldRound.id);
});
test('continuation cannot silently skip a branch, clinical effect, or an undeclared reader capability', () => {
  for (const mutate of [doc => doc.decisions[0].paths.push({ ...doc.decisions[0].paths[0], id: uuidv7() }),
    doc => doc.decisions[0].paths[0].set_flags = ['workshop_flag_01'],
    doc => doc.required_capabilities = doc.required_capabilities.filter(item => item !== 'direct_continuation')]) {
    const doc = ordinaryQuestion(); mutate(doc);
    assert.equal(validateBuilderDocument(doc, { metadata_version: 1 }, { mode: 'ready' }).ok, false);
  }
});

test('ordinary answer edits maintain one Continue mapping while explicit branch mappings stay authored', () => {
  const doc = ordinaryQuestion(), option = { id: uuidv7(), label: 'Another response' }; doc.decisions[0].interaction.options.push(option);
  const after = withOrdinaryMappings(doc);
  assert.ok(after.decisions[0].paths[0].option_ids.includes(option.id));
  assert.equal(doc.decisions[0].paths[0].option_ids.includes(option.id), false, 'the original snapshot stays unchanged');
  after.decisions[0].interaction = { type: 'free_text', max_length: 300 };
  assert.equal(Object.hasOwn(withOrdinaryMappings(after).decisions[0].paths[0], 'option_ids'), false);
  const branched = miniCase().doc;
  assert.deepEqual(withOrdinaryMappings(branched), branched, 'clinical branch mappings are never inferred');
});

// Unrelated notes must not invalidate the cached question and Outline indices on every key.
test('ordinary question normalization preserves unrelated edit references and still updates changed questions', () => {
  const before = withOrdinaryMappings(ordinaryQuestion());
  const noteEdit = { ...before, surfaces: before.surfaces.map((surface, index) => index ? surface : { ...surface, facilitator_notes: 'Edited private notes' }) };
  assert.equal(withOrdinaryMappings(noteEdit, before), noteEdit);
  assert.equal(noteEdit.decisions, before.decisions);
  const questionEdit = { ...noteEdit, decisions: noteEdit.decisions.map((decision, index) => index ? decision : { ...decision, prompt: 'Updated public question' }) };
  const updated = withOrdinaryMappings(questionEdit, noteEdit);
  assert.equal(updated.beats.find(beat => beat.decision_id === updated.decisions[0].id).title, 'Updated public question');
  assert.equal(before.decisions[0].prompt === 'Updated public question', false);
});

test('turning the sole content block into a question still derives its public slide title', () => {
  const original = ordinaryQuestion(), decision = original.decisions[0];
  decision.paths[0].continue_to_next = false;
  const beat = original.beats.find(item => item.decision_id === decision.id), blockId = uuidv7();
  beat.title = 'Original story title';
  original.blocks = [{ id: blockId, type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: beat.title }] }] }];
  original.compositions = [{ owner: { kind: 'beat', id: beat.id }, reading_order: [blockId] }];
  const before = withOrdinaryMappings(original);
  const converted = { ...before, blocks: [{ id: blockId, type: 'question', decision_id: decision.id }] };
  assert.equal(withOrdinaryMappings(converted, before).beats.find(item => item.id === beat.id).title, decision.prompt);
});

// Card 61 (RUNTIME-01): an ordinary question goes Lock → Continue. The console reads the view's directContinue flag;
// a branching question keeps its authored routes, and a console that ignores the flag keeps today's route card.
function lockedView(doc) {
  let state = initialState({ sessionId: uuidv7(), caseDoc: doc }); const ledger = new Map(); let n = 0;
  const send = (type, payload = {}) => { state = dispatch(state, { type, epoch: state.epoch, expectRevision: state.revision, actor: { role: 'facilitator', id: 'fac' }, at: new Date(1800000000000 + n++ * 1000).toISOString(), clientEventId: uuidv7(), ...payload }, ledger).state; };
  send('start', { roundId: uuidv7() });
  for (let i = 0; i < 10 && state.phase !== 'responses_open'; i++) send('advance', { roundId: uuidv7() });
  send('lock');
  assert.equal(state.phase, 'responses_locked');
  return project(state, 'facilitator');
}
test('[AS-160] an ordinary question offers one Continue to its next slide, with no route choice to undo or arm', () => {
  const doc = ordinaryQuestion(), path = doc.decisions[0].paths[0], next = doc.beats.find(beat => beat.id === path.next_beat_id);
  const view = lockedView(doc);
  assert.equal(view.decision.directContinue, true);
  for (const role of ['display', 'participant']) assert.equal(Object.hasOwn(project(initialState({ sessionId: uuidv7(), caseDoc: doc }), role).decision ?? {}, 'directContinue'), false);
  const control = primaryAction(view);
  assert.deepEqual(control, { command: 'reveal_path', payload: { pathId: path.id, expectRevision: view.revision }, label: `Continue to ${next.title}`, pathId: path.id, direct: true });
  assert.equal(armedRoute(control, Date.now() + 3000), control, 'Continue is one press from the keyboard too, like Next');
  const routes = createRouteSelection();
  assert.equal(routes.sync(view), path.id);
  assert.equal(routes.canUndo(view), false, 'no local route choice exists, so Undo stays the room\'s');
  // An older console that ignores the flag still sees the one authored route and its Reveal.
  const { directContinue, ...older } = view.decision;
  assert.equal(primaryAction({ ...view, decision: older }, { pickedPathId: path.id }).label, `Reveal: ${next.title}`);
});
test('[AS-160] a branching question keeps its authored routes', () => {
  const view = lockedView(convertSchema1ToBuilderDocument(miniCase().doc, { metadata_version: 1 }).candidate);
  assert.equal(view.decision.directContinue, false);
  assert.deepEqual(primaryAction(view), { local: 'focus_resolution', label: 'Choose a path' });
  assert.match(primaryAction(view, { pickedPathId: view.decision.paths[0].id }).label, /^Reveal: /);
});
