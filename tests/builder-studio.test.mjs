import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurePathTerminal, builderDependencyReport, leftoverMappings, withoutMappings, unusedContent, orphanedSurfaces, invalidateChangedProvenance, provenanceFields, rankingBeforePair } from '../src/client/builder-studio.mjs';
import { deriveBuilderTopology, topologyEdgeText } from '../src/client/builder-overview.mjs';

const doc = () => ({
  schema_version: 2,
  start_beat_id: 'start',
  surfaces: [
    { id: 'end-surface', title: 'End content' },
    { id: 'slow-surface', title: 'Delay consequence' },
    { id: 'question-surface', title: 'Question context' },
    { id: 'start-surface', title: 'Opening scene' },
    { id: 'fast-surface', title: 'Fast consequence' },
    { id: 'join-surface', title: 'Reassess' },
  ],
  beats: [
    { id: 'end', kind: 'debrief', title: 'End', surface_id: 'end-surface' },
    { id: 'slow', kind: 'surface', title: 'Delay', surface_id: 'slow-surface', next_beat_id: 'join' },
    { id: 'decision', kind: 'decision', title: 'Choose', surface_id: 'question-surface', decision_id: 'question' },
    { id: 'start', kind: 'surface', title: 'Opening', surface_id: 'start-surface', next_beat_id: 'decision' },
    { id: 'fast', kind: 'surface', title: 'Fast', surface_id: 'fast-surface', next_beat_id: 'join' },
    { id: 'join', kind: 'surface', title: 'Reassess', surface_id: 'join-surface', next_beat_id: 'end' },
  ],
  decisions: [{ id: 'question', paths: [
    { id: 'fast-path', label: 'Fast path', reveal_surface_id: 'fast-surface', next_beat_id: 'fast' },
    { id: 'slow-path', label: 'Slow path', reveal_surface_id: 'slow-surface', next_beat_id: 'slow' },
  ] }],
});

test('topology exposes authored branch, join and unresolved edges without repairing the graph', () => {
  const input = doc();
  input.decisions[0].paths[1].next_beat_id = 'missing-beat';
  const before = structuredClone(input);
  const topology = deriveBuilderTopology(input);
  assert.ok(topology.edges.some(edge => edge.kind === 'path-destination' && edge.pathId === 'fast-path' && edge.to === 'fast'));
  assert.ok(topology.edges.some(edge => edge.kind === 'path-destination' && edge.pathId === 'slow-path' && edge.to === 'missing-beat' && edge.missing));
  assert.ok(topology.nodes.some(node => node.beatId === 'join'));
  assert.equal(topology.nodes.find(node => node.kind === 'missing')?.label, 'Unresolved stage destination');
  assert.equal(topologyEdgeText(topology.edges.find(edge => edge.kind === 'decision-path'), input), 'Consequence: Fast path');
  assert.equal(topologyEdgeText(topology.edges.find(edge => edge.kind === 'path-destination' && edge.pathId === 'fast-path'), input), 'Continues to: Fast');
  assert.equal(topologyEdgeText(topology.edges.find(edge => edge.kind === 'path-destination' && edge.pathId === 'slow-path'), input), 'Stage destination needs repair');
  assert.ok(!topology.nodes.some(node => node.label.includes('missing-beat')));
  assert.deepEqual(input, before);
});

test('dependency report names the route edges that a beat deletion would affect', () => {
  const input = doc();
  const report = builderDependencyReport(input, { kind: 'beat', id: 'join' });
  assert.ok(report.references.some(ref => ref.kind === 'beat-successor' && ref.ownerId === 'fast'));
  assert.ok(report.references.some(ref => ref.kind === 'beat-successor' && ref.ownerId === 'slow'));
  assert.equal(report.safeToRemove, false);
  const routeReport = builderDependencyReport(input, { kind: 'beat', id: 'fast' });
  assert.ok(routeReport.references.some(ref => ref.kind === 'path-destination' && ref.ownerId === 'fast-path'));
});

test('confirmed provenance goes stale on exact bound-content, source, range, transformation, entity or field change', () => {
  const authored = { surfaces: [{ id: 'surface', points: ['alpha', 'beta'], variants: [{ scene: 'first version', when_flags: ['flag'] }] }] };
  const metadata = { sources: [{ id: 'source', title: 'Reference', text: 'line one', rights_status: 'permitted' }], provenance: [
    { entity_id: 'surface', field: 'points[1]', source_id: 'source', start_line: 1, end_line: 1, transformation: 'adapted', visibility: 'private', review_status: 'confirmed' },
  ] };
  const changedText = structuredClone(authored); changedText.surfaces[0].points[1] = 'edited';
  assert.equal(invalidateChangedProvenance(authored, metadata, changedText, metadata).provenance[0].review_status, 'stale');
  const reordered = structuredClone(authored); reordered.surfaces.reverse();
  assert.equal(invalidateChangedProvenance(authored, metadata, reordered, metadata).provenance[0].review_status, 'confirmed', 'surface array order does not change an ID-bound field');
  const changedSource = structuredClone(metadata); changedSource.sources[0].text = 'line one changed';
  assert.equal(invalidateChangedProvenance(authored, metadata, authored, changedSource).provenance[0].review_status, 'stale');
  for (const key of ['start_line', 'transformation', 'entity_id', 'field']) {
    const changedBinding = structuredClone(metadata); changedBinding.provenance[0][key] = key === 'transformation' ? 'verbatim' : key === 'start_line' ? 2 : key === 'entity_id' ? 'other' : 'points[0]';
    assert.equal(invalidateChangedProvenance(authored, metadata, authored, changedBinding).provenance[0].review_status, 'stale', key);
  }
  const updatedReview = structuredClone(metadata); updatedReview.provenance[0].review_status = 'confirmed';
  assert.equal(invalidateChangedProvenance(authored, metadata, authored, updatedReview).provenance[0].review_status, 'confirmed');
});

test('provenance field choices include indexed values and every existing variant', () => {
  const document = { surfaces: [{ id: 's', points: ['one', 'two'], investigations: ['result'], observations: [{ label: 'HR', value: '90', unit: 'bpm' }], variants: [{ scene: 'flagged scene', points: ['variant point'], investigations: ['variant result'] }] }] };
  const fields = provenanceFields('surface', { id: 's' }, document);
  assert.ok(fields.includes('points[1]'));
  assert.ok(fields.includes('investigations[0]'));
  assert.ok(fields.includes('observations[0].value'));
  assert.ok(fields.includes('variants[0].scene'));
  assert.ok(fields.includes('variants[0].points[0]'));
  assert.ok(fields.includes('variants[0].investigations[0]'));
});

test('ranking-before and terminal controls preserve authored order and checkpoint targets', () => {
  assert.deepEqual(rankingBeforePair('higher', 'lower'), ['higher', 'lower']);
  assert.equal(rankingBeforePair('same', 'same'), null);
  const continuing = { id: 'path', next_beat_id: 'checkpoint', label: 'Continue', classification: 'unsafe' };
  // Card 60 PREVIEW-02: a terminal made in the Builder is one the validator accepts: terminal-unsafe, reset by snapshot.
  const terminal = configurePathTerminal(continuing, 'checkpoint');
  assert.deepEqual(terminal.terminal, { checkpoint_beat_id: 'checkpoint', debrief_prompt: '', restore_policy: 'snapshot' });
  assert.equal(terminal.classification, 'terminal-unsafe');
  assert.equal('next_beat_id' in terminal, false);
  const restored = configurePathTerminal(terminal);
  assert.equal(restored.next_beat_id, 'checkpoint');
  assert.equal(restored.classification, 'unsafe');
  assert.equal('terminal' in restored, false);
  assert.equal(configurePathTerminal(continuing), null);
  // Reset to the question itself: continuing from it would loop back to the question, so the author picks the next stage.
  const atQuestion = configurePathTerminal(configurePathTerminal(continuing, 'question-beat'), null, { decisionBeatId: 'question-beat' });
  assert.equal('next_beat_id' in atQuestion, false);
  assert.equal('terminal' in atQuestion, false);
  // A classification other than terminal-unsafe is the author's and survives the round trip.
  assert.equal(configurePathTerminal({ ...terminal, classification: 'terminal-unsafe' }).classification, 'unsafe');
  assert.equal(configurePathTerminal({ ...continuing, classification: 'sound' }, 'checkpoint').classification, 'terminal-unsafe');
});

/** The fixture's question as a ranking or select-all question still carrying single-choice mappings (D17, D20). */
function leftoverMappings0(type) {
  const document = doc();
  const decision = document.decisions[0];
  decision.interaction = { type, options: [{ id: 'option-a', label: 'A' }, { id: 'option-b', label: 'B' }] };
  decision.paths[0].option_ids = ['option-a', 'option-b'];
  decision.paths[1].option_ids = [];
  return document;
}

test('D17: a ranking or select-all question\'s leftover mappings never stop a consequence or response being removed; single choice still does', () => {
  for (const type of ['ranking', 'multi_select']) {
    const document = leftoverMappings0(type);
    assert.deepEqual(builderDependencyReport(document, { kind: 'path', id: 'fast-path' }).references.map(item => item.kind), [], type);
    assert.deepEqual(builderDependencyReport(document, { kind: 'option', id: 'option-a' }).references.map(item => item.kind), [], type);
  }
  const single = leftoverMappings0('single_choice');
  assert.deepEqual(builderDependencyReport(single, { kind: 'path', id: 'fast-path' }).references.map(item => item.kind), ['option-mapping', 'option-mapping']);
  assert.deepEqual(builderDependencyReport(single, { kind: 'option', id: 'option-a' }).references.map(item => item.kind), ['option-path']);
});

test('D20/D22 [AS-220]: leftover mappings ([] and [ids]) and unused content are found for their own controls, traced content is kept, single choice is never touched', () => {
  const document = leftoverMappings0('ranking');
  document.surfaces.push({ id: 'orphan', kind: 'text', title: 'Coordinated imaging/surgical review' }, { id: 'traced-orphan', kind: 'text', title: 'Traced' });
  const metadata = { metadata_version: 1, provenance: [{ entity_id: 'traced-orphan', field: 'title' }] };
  const before = structuredClone(document);
  const mappings = leftoverMappings(document);
  assert.deepEqual(document, before, 'the draft passed in is never changed in place');
  assert.deepEqual(mappings.map(item => item.pathId), ['fast-path', 'slow-path']);
  // One consequence's mappings clear alone; the other keeps them.
  const one = withoutMappings(document, ['fast-path']);
  assert.equal(Object.hasOwn(one.decisions[0].paths[0], 'option_ids'), false);
  assert.equal(Object.hasOwn(one.decisions[0].paths[1], 'option_ids'), true);
  assert.deepEqual(leftoverMappings(withoutMappings(document, mappings.map(item => item.pathId))), []);
  const { surfaces, traced } = unusedContent(document, metadata);
  assert.deepEqual(surfaces.map(item => [item.id, item.title]), [['orphan', 'Coordinated imaging/surgical review']]);
  assert.deepEqual(traced.map(item => [item.id, item.traces]), [['traced-orphan', [0]]]);
  // A branching single-choice mapping is never found or changed.
  const single = leftoverMappings0('single_choice');
  assert.deepEqual(leftoverMappings(single), []);
  assert.deepEqual(withoutMappings(single, ['fast-path', 'slow-path']), single);
});

test('D22: the content a removal leaves unshown is found; content already unused, or still shown elsewhere, is not', () => {
  const before = doc();
  before.surfaces.push({ id: 'old-orphan', title: 'Old' });
  const next = structuredClone(before);
  next.decisions[0].paths = next.decisions[0].paths.filter(path => path.id !== 'fast-path');
  assert.deepEqual(orphanedSurfaces(before, next).map(item => item.id), []); // the fast stage still shows it
  next.beats = next.beats.filter(beat => beat.id !== 'fast');
  assert.deepEqual(orphanedSurfaces(before, next).map(item => item.id), ['fast-surface']);
});
