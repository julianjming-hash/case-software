import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, project, normalizePresentationState } from '../src/shared/room-machine.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { clientSchemaTooOld } from '../src/shared/wire.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';
import { publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

// A real schema-3 case: card 56's own lossless upgrade of the local fixture (variants removed: not yet mappable).
function slideCase({ clarify = false } = {}) {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  if (clarify) {
    // A clarification reusing a stage's surface: its own occurrence, own composition, own progress.
    const decisionBeat = source.beats.find(beat => beat.decision_id), reused = source.beats.find(beat => !beat.decision_id);
    source.clarifications = [{ id: uuidv7(), label: 'Clarify the history', surface_id: reused.surface_id, beat_ids: [decisionBeat.id] }];
    source.required_capabilities = [...new Set([...source.required_capabilities, 'early_clarification'])];
  }
  const result = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 });
  assert.equal(result.ok, true, JSON.stringify(result.errors?.slice(0, 2)));
  return result.candidate.document;
}
const facilitator = { role: 'facilitator', id: 'fac' };
let clock = Date.parse('2026-10-11T00:00:00.000Z');
function send(state, type, extra = {}) {
  clock += 1000;
  // Every command carries a fresh round identity, as the console does; only a round-opening advance uses it.
  return reduce(state, { type, roundId: uuidv7(), clientEventId: uuidv7(), epoch: state.epoch, at: new Date(clock).toISOString(), actor: facilitator, ...extra });
}
const ok = result => { assert.equal(result.effects.find(effect => effect.type === 'receipt')?.receipt ?? 'accepted', 'accepted', JSON.stringify(result.effects.at(-1))); return result.state; };
const reason = result => result.effects.find(effect => effect.type === 'receipt')?.reason;
const compositionOf = (doc, entry) => doc.compositions.find(item => item.owner.kind === (entry.pathId ? 'path' : 'beat') && item.owner.id === (entry.pathId ?? entry.beatId));

test('[AS-142] a slide room starts at version 2 and releases only On entry blocks to public roles', () => {
  const caseDoc = slideCase();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc });
  assert.equal(state.presentationVersion, 2);
  state = ok(send(state, 'start'));
  const entry = state.revealed.at(-1), composition = compositionOf(caseDoc, entry);
  assert.equal(entry.groupsShown, 1);
  const released = new Set(composition.steps.filter(step => step.block_ids.length)[0].block_ids);
  const future = caseDoc.blocks.filter(block => composition.reading_order.includes(block.id) && !released.has(block.id));
  for (const role of ['display', 'participant']) {
    const view = project(state, role), json = JSON.stringify(view);
    const slide = role === 'display' ? view.surface.slide : view.liveSurface.slide;
    assert.deepEqual(new Set(slide.blocks.map(block => block.id)), released);
    // Network-level sentinels: no future block id, future text, step identity, step count or composition identity.
    for (const block of future) { assert.ok(!json.includes(block.id), `${role} leaked a future block id`); }
    // Every string leaf of every future block (text, list, values, table, timeline, callout) stays off the wire.
    const leaves = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(leaves) : value && typeof value === 'object' ? Object.entries(value).filter(([key]) => key !== 'type' && key !== 'style').flatMap(([, item]) => leaves(item)) : [];
    for (const block of future) for (const leaf of leaves(block).filter(item => item.length >= 6)) assert.ok(!json.includes(leaf), `${role} leaked future content`);
    for (const step of composition.steps) assert.ok(!json.includes(step.id), `${role} leaked a step id`);
    assert.ok(!json.includes(composition.id)); assert.equal(slide.total, undefined); assert.equal(slide.steps, undefined);
    assert.deepEqual(slide.placements.map(item => item.block_id).sort(), [...released].sort());
  }
  // The facilitator keeps the whole composition in memory (private device).
  assert.equal(project(state, 'facilitator').liveSurface.slide.composition.id, composition.id);
});

test('[AS-143] each slide step needs the displayed revision; two distinct inputs on one revision cannot consume two steps', () => {
  const caseDoc = slideCase();
  let state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  const total = compositionOf(caseDoc, state.revealed.at(-1)).steps.filter(step => step.block_ids.length).length;
  assert.ok(total >= 2, 'fixture opening slide has more than one step');
  assert.equal(reason(send(state, 'advance')), 'missing_expect_revision');
  const revision = state.revision;
  const first = send(state, 'advance', { expectRevision: revision });
  const after = ok(first);
  assert.equal(after.revealed.at(-1).groupsShown, 2);
  // A second, distinct input aimed at the revision the facilitator saw is refused; nothing advances twice.
  const second = send(after, 'advance', { expectRevision: revision });
  assert.equal(reason(second), 'stale_revision');
  assert.equal(second.state.revealed.at(-1).groupsShown, 2);
});

test('[AS-143] responses open only after the last context step, including the question, and never early', () => {
  const caseDoc = slideCase();
  let state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  for (let guard = 0; guard < 40 && !state.decisionId; guard++) state = ok(send(state, 'advance', { expectRevision: state.revision }));
  assert.ok(state.decisionId, 'reached the decision stage');
  const entry = state.revealed.at(-1), steps = compositionOf(caseDoc, entry).steps.filter(step => step.block_ids.length);
  assert.equal(caseDoc.blocks.find(block => block.id === steps.at(-1).block_ids[0]).type, 'question', 'the question is the last step');
  while (state.revealed.at(-1).groupsShown < steps.length) {
    assert.notEqual(state.phase, 'responses_open');
    state = ok(send(state, 'advance', { expectRevision: state.revision }));
  }
  assert.equal(state.phase, 'surface_live');
  state = ok(send(state, 'advance', { expectRevision: state.revision }));
  assert.equal(state.phase, 'responses_open');
});

test('[AS-143] an empty step consumes no reveal press', () => {
  const caseDoc = slideCase();
  const start = caseDoc.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === caseDoc.start_beat_id);
  start.steps.splice(1, 0, { id: uuidv7(), block_ids: [] });
  let state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  state = ok(send(state, 'advance', { expectRevision: state.revision }));
  const shown = new Set(project(state, 'display').surface.slide.blocks.map(block => block.id));
  for (const id of start.steps[2].block_ids) assert.ok(shown.has(id), 'the next non-empty step was revealed by one press');
});

test('[AS-144] slide progress fails closed: mismatched versions and missing progress are refused, never invented', () => {
  const caseDoc = slideCase();
  const state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  assert.equal(normalizePresentationState(state), state);
  const missing = structuredClone({ ...state, caseDoc: undefined }); missing.caseDoc = caseDoc; delete missing.revealed[0].groupsShown;
  assert.throws(() => normalizePresentationState(missing), /invalid_presentation_progress/);
  for (const presentationVersion of [1, undefined, 3]) assert.throws(() => normalizePresentationState({ ...state, presentationVersion }), /invalid_presentation_version/);
});

test('[AS-144] each occurrence keeps its own step progress: a clarification starts fresh and the decision resumes exactly', () => {
  const caseDoc = slideCase({ clarify: true });
  let state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  for (let guard = 0; guard < 60 && state.phase !== 'responses_open'; guard++) state = ok(send(state, 'advance', { expectRevision: state.revision }));
  assert.equal(state.phase, 'responses_open');
  const decisionProgress = state.revealed.at(-1).groupsShown, clarification = caseDoc.clarifications[0];
  state = ok(send(state, 'show_clarification', { clarificationId: clarification.id, expectRevision: state.revision }));
  const shown = state.revealed.at(-1), own = caseDoc.compositions.find(item => item.owner.kind === 'clarification');
  assert.equal(shown.clarificationId, clarification.id);
  assert.equal(shown.groupsShown, 1, 'the clarification starts at its own On entry, not the reused stage\'s progress');
  assert.deepEqual(new Set(project(state, 'display').surface.slide.blocks.map(block => block.id)), new Set(own.steps.filter(step => step.block_ids.length)[0].block_ids));
  // The return names the clarification occurrence it closes, as the console does.
  state = ok(send(state, 'return_clarification', { occurrenceId: state.clarification.occurrenceId, expectRevision: state.revision }));
  assert.equal(state.revealed.at(-1).groupsShown, decisionProgress, 'the decision occurrence resumes with exactly its earlier progress');
});

test('[AS-144] rooms refuse clients older than their case schema before sending content', () => {
  assert.equal(clientSchemaTooOld(1, 1), false);
  assert.equal(clientSchemaTooOld(2, 1), true); assert.equal(clientSchemaTooOld(2, 2), false); assert.equal(clientSchemaTooOld(2, 3), false);
  assert.equal(clientSchemaTooOld(3, 2), true); assert.equal(clientSchemaTooOld(3, undefined), true); assert.equal(clientSchemaTooOld(3, 3), false);
});

test('[AS-144] a stray compositions key on a schema-1 or schema-2 case never switches a room to slides', () => {
  const legacy = structuredClone(fixture);
  legacy.compositions = [{ owner: { kind: 'beat', id: legacy.start_beat_id } }];
  assert.equal(validateRuntimeDocument(legacy).ok, true, 'today\'s runtime admission accepts the unknown root key');
  let state = initialState({ sessionId: uuidv7(), caseDoc: legacy });
  assert.equal(state.presentationVersion, 1);
  state = ok(send(state, 'start'));
  assert.equal(project(state, 'display').surface.slide, undefined);
  assert.equal(normalizePresentationState({ ...state, presentationVersion: 1 }).presentationVersion, 1, 'a stored legacy room still loads');
});

test('[AS-143] offline manual mode steps through a slide without a revision fence', () => {
  const caseDoc = slideCase();
  let state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  state = ok(send(state, 'enter_manual', { expectRevision: state.revision, segmentId: uuidv7() }));
  assert.ok(state.manual);
  const before = state.revealed.at(-1).groupsShown;
  state = ok(send(state, 'advance'));
  assert.equal(state.revealed.at(-1).groupsShown, before + 1);
});

test('[AS-142] public projection forwards only known block fields and passes an already-public slide row through', () => {
  const caseDoc = slideCase();
  const block = caseDoc.blocks.find(item => item.type === 'text');
  block.secret = 'PRIVATE_SENTINEL';
  let state = ok(send(initialState({ sessionId: uuidv7(), caseDoc }), 'start'));
  const display = project(state, 'display').surface;
  assert.ok(!JSON.stringify(display).includes('PRIVATE_SENTINEL'));
  assert.deepEqual(publicPresentationSurface(display, 99), display);
});

test('[AS-136] a schema-3 surface cannot be both a slide and a legacy surface', () => {
  const caseDoc = slideCase(), metadata = { metadata_version: 1 };
  const path = caseDoc.decisions[0].paths[0];
  caseDoc.compositions = caseDoc.compositions.filter(item => !(item.owner.kind === 'path' && item.owner.id === path.id));
  const shared = caseDoc.compositions.find(item => item.owner.kind === 'beat' && caseDoc.beats.find(beat => beat.id === item.owner.id)?.surface_id === path.reveal_surface_id);
  if (!shared) caseDoc.beats.find(beat => !beat.decision_id).surface_id = path.reveal_surface_id;
  const result = validateBuilderDocument(caseDoc, metadata, { mode: 'ready', validateSlides: validateSlideParts });
  assert.ok(result.errors.some(item => item.code === 'mixed_surface_use'), JSON.stringify(result.errors.slice(0, 3)));
});
