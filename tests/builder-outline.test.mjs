import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBuilderOutline, builderOutlineSignature } from '../src/client/builder-outline.mjs';

const beat = (id, extra = {}) => ({ id, kind: 'surface', title: id, surface_id: `${id}-s`, ...extra });
const path = (id, extra = {}) => ({ id, label: id, reveal_surface_id: `${id}-s`, ...extra });
const doc = () => ({
  start_beat_id: 'open',
  surfaces: [],
  beats: [beat('open', { next_beat_id: 'ask' }), beat('ask', { kind: 'decision', decision_id: 'q' }), beat('side', { next_beat_id: 'join' }),
    beat('main', { next_beat_id: 'join' }), beat('join', { next_beat_id: 'end' }), beat('end', { kind: 'debrief' })],
  // The authored recommendation is deliberately second in the array.
  decisions: [{ id: 'q', paths: [path('alt', { next_beat_id: 'side' }), path('rec', { next_beat_id: 'main', recommended: true }), path('stop', { terminal: { checkpoint_beat_id: 'open' }, recovery: { prompt: 'Recover' } })] }],
});
const kinds = rows => rows.map(row => `${row.kind}:${row.kind === 'consequence' ? row.pathId : row.kind === 'reference' ? row.reference : row.beatId ?? row.label}${row.kind === 'stage' ? `@${row.depth}` : ''}`);
const stages = rows => rows.filter(row => row.kind === 'stage');

test('[AS-129] Outline spine follows the authored recommendation, not array position, and alternatives stay local', () => {
  const input = doc(), before = structuredClone(input), outline = deriveBuilderOutline(input);
  assert.equal(outline.ok, true);
  assert.deepEqual(stages(outline.rows).filter(row => row.depth === 0).map(row => [row.beatId, row.number]), [['open', 1], ['ask', 2], ['main', 3], ['join', 4], ['end', 5]]);
  const ask = outline.rows.find(row => row.beatId === 'ask' && row.kind === 'stage');
  assert.deepEqual(ask.consequences.map(item => [item.pathId, item.recommended]), [['alt', false], ['rec', true], ['stop', false]]);
  // The alternative's local stage sits under its consequence, and its return to the spine is a named reference.
  assert.deepEqual(kinds(outline.rows).slice(2, 7), ['consequence:alt', 'stage:side@2', 'reference:joins', 'consequence:rec', 'consequence:stop']);
  assert.equal(outline.rows.find(row => row.reference === 'joins').label, 'Joins join');
  assert.deepEqual(outline.rows.find(row => row.pathId === 'stop').owners, ['ask']);
  assert.equal(outline.rows.find(row => row.pathId === 'alt').key, 'path:ask:alt');
  assert.match(outline.rows.find(row => row.pathId === 'stop').destination, /^Ends · checkpoint open$/);
  assert.equal(outline.rows.find(row => row.pathId === 'stop').recovery, true);
  assert.deepEqual(outline.rows.find(row => row.beatId === 'side').owners, ['ask', 'path:ask:alt']);
  assert.deepEqual(input, before);
});

test('[AS-130] Outline stays finite and non-mutating for cycles, missing references, shared decisions and unconnected stages', () => {
  const input = doc();
  input.beats.find(row => row.id === 'end').next_beat_id = 'open'; input.beats.find(row => row.id === 'end').kind = 'surface';
  input.beats.push(beat('loose', { next_beat_id: 'gone' }), beat('again', { kind: 'decision', decision_id: 'q' }), beat('orphan', { kind: 'decision', decision_id: 'missing' }));
  const before = structuredClone(input), outline = deriveBuilderOutline(input);
  assert.deepEqual(input, before);
  assert.equal(outline.rows.filter(row => row.reference === 'returns').map(row => row.label)[0], 'Returns to open');
  const heading = outline.rows.findIndex(row => row.kind === 'heading');
  assert.ok(heading > 0);
  assert.deepEqual(outline.rows.slice(heading).filter(row => row.kind === 'stage' && row.depth === 0).map(row => row.beatId), ['loose', 'again', 'orphan']);
  assert.ok(outline.rows.some(row => row.reference === 'missing' && row.label === 'Destination needs repair'));
  assert.deepEqual(outline.rows.filter(row => row.kind === 'stage' && row.shared).map(row => row.beatId), ['ask', 'again']);
  assert.equal(outline.rows.find(row => row.beatId === 'orphan').issue, 'Decision details need repair');
  // Every admitted stage remains findable exactly once as a stage row.
  assert.deepEqual(stages(outline.rows).map(row => row.beatId).sort(), input.beats.map(row => row.id).sort());
  // A shared decision's consequences are distinct rows per owning stage: every row key is unique.
  assert.equal(new Set(outline.rows.map(row => row.key)).size, outline.rows.length);
  assert.deepEqual(outline.rows.filter(row => row.pathId === 'alt').map(row => row.key), ['path:ask:alt', 'path:again:alt']);
});

test('[AS-130] an unconnected chain listed in reverse array order stays one group from its root', () => {
  const input = doc();
  input.beats.push(beat('c3'), beat('c2', { next_beat_id: 'c3' }), beat('c1', { next_beat_id: 'c2' }));
  const outline = deriveBuilderOutline(input), heading = outline.rows.findIndex(row => row.kind === 'heading');
  assert.deepEqual(outline.rows.slice(heading + 1).map(row => row.beatId ?? row.reference), ['c1', 'c2', 'c3']);
});

test('[AS-130] Outline never infers a continuation when no or several recommendations are authored', () => {
  for (const flags of [[false, false, false], [true, true, false]]) {
    const input = doc();
    input.decisions[0].paths.forEach((item, at) => { item.recommended = flags[at]; });
    const outline = deriveBuilderOutline(input), ask = outline.rows.find(row => row.beatId === 'ask');
    assert.equal(ask.issue, 'Choose exactly one recommended consequence');
    assert.equal(ask.consequences.some(item => item.recommended), false);
    // Every consequence becomes a local alternative: the spine stops at the decision and nothing is unconnected.
    assert.deepEqual(stages(outline.rows).filter(row => row.depth === 0).map(row => row.beatId), ['open', 'ask']);
    assert.deepEqual(outline.rows.find(row => row.beatId === 'main').owners, ['ask', 'path:ask:rec']);
    assert.deepEqual(stages(outline.rows).map(row => row.beatId).sort(), input.beats.map(row => row.id).sort());
  }
});

test('[AS-130] Outline handles nested alternatives and multiple rejoins without duplicating downstream stages', () => {
  const input = doc();
  input.beats.find(row => row.id === 'side').kind = 'decision'; input.beats.find(row => row.id === 'side').decision_id = 'q2';
  delete input.beats.find(row => row.id === 'side').next_beat_id;
  input.beats.push(beat('deep', { next_beat_id: 'main' }));
  input.decisions.push({ id: 'q2', paths: [path('d1', { next_beat_id: 'join', recommended: true }), path('d2', { next_beat_id: 'deep' })] });
  const outline = deriveBuilderOutline(input);
  assert.deepEqual(outline.rows.find(row => row.beatId === 'deep').owners, ['ask', 'path:ask:alt', 'side', 'path:side:d2']);
  assert.deepEqual(outline.rows.filter(row => row.kind === 'reference').map(row => row.label), ['Joins main', 'Joins join']);
  assert.equal(new Set(stages(outline.rows).map(row => row.beatId)).size, stages(outline.rows).length);
});

test('[AS-130] a 5000-stage linear draft projects iteratively without recursion or mutation', () => {
  const beats = Array.from({ length: 5000 }, (_, at) => beat(`b${at}`, at < 4999 ? { next_beat_id: `b${at + 1}` } : {}));
  const input = { start_beat_id: 'b0', beats, decisions: [], surfaces: [] }, before = structuredClone(input);
  const outline = deriveBuilderOutline(input);
  assert.equal(outline.stages, 5000);
  assert.equal(outline.rows.at(-1).beatId, 'b4999');
  assert.deepEqual(input, before);
});

test('[AS-130] rejected identities return bounded diagnostics and refuse ambiguous navigation', () => {
  const duplicate = doc(); duplicate.beats.push(beat('open'));
  const missing = doc(); missing.decisions[0].paths.push({ label: 'No identity' });
  const flood = doc(); for (let at = 0; at < 500; at++) flood.beats.push({ title: 'x' });
  for (const input of [duplicate, missing, flood]) {
    const outline = deriveBuilderOutline(input);
    assert.equal(outline.ok, false); assert.deepEqual(outline.rows, []);
    assert.ok(outline.diagnostics.length >= 1 && outline.diagnostics.length <= 20);
  }
});

test('Outline signature ignores learner text so typing patches thumbnails instead of rebuilding navigation', () => {
  const input = doc(), signature = builderOutlineSignature(input);
  input.surfaces.push({ id: 'open-s', title: 'Opening', scene: 'Typed text' });
  assert.equal(builderOutlineSignature(input), signature);
  // A rename refills rows in place: it changes only the name signature, never the structural one.
  const named = builderOutlineSignature(input, true);
  input.beats[0].title = 'Renamed'; input.decisions[0].paths[0].label = 'Renamed path';
  assert.equal(builderOutlineSignature(input), signature);
  assert.notEqual(builderOutlineSignature(input, true), named);
  input.decisions[0].paths[0].recommended = true;
  assert.notEqual(builderOutlineSignature(input), signature);
});

test('D15: a schema-3 clarification is listed under its first stage, before that stage\'s consequences, and only there', () => {
  const input = { ...doc(), schema_version: 3, clarifications: [{ id: 'clar', label: 'Imaging alongside surgery', surface_id: 'ask-s', beat_ids: ['ask', 'open'] }, { id: 'nowhere', label: 'Unbound', surface_id: 'ask-s', beat_ids: [] }] };
  const outline = deriveBuilderOutline(input), row = outline.rows.find(item => item.kind === 'clarification');
  assert.deepEqual(kinds(outline.rows).slice(1, 4), ['stage:ask@0', 'clarification:ask', 'consequence:alt']);
  assert.deepEqual({ key: row.key, beatId: row.beatId, clarificationId: row.clarificationId, label: row.label, depth: row.depth, owners: row.owners }, { key: 'clarification:clar', beatId: 'ask', clarificationId: 'clar', label: 'Imaging alongside surgery', depth: 1, owners: [] });
  assert.equal(outline.rows.filter(item => item.kind === 'clarification').length, 1, 'a clarification shown during no stage has no slide to list');
  // Its name refills in place; binding it to another stage is structural.
  const renamed = structuredClone(input); renamed.clarifications[0].label = 'Renamed';
  assert.equal(builderOutlineSignature(renamed), builderOutlineSignature(input));
  assert.notEqual(builderOutlineSignature(renamed, true), builderOutlineSignature(input, true));
  const moved = structuredClone(input); moved.clarifications[0].beat_ids = ['open'];
  assert.notEqual(builderOutlineSignature(moved), builderOutlineSignature(input));
  // A fixed-layout draft has no clarification slides to open.
  assert.equal(deriveBuilderOutline({ ...input, schema_version: 2 }).rows.some(item => item.kind === 'clarification'), false);
});
