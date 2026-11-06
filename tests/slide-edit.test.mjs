import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts, paragraphsText } from '../src/shared/slide-document.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateBuilderProvenancePaths } from '../src/shared/builder-provenance.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

function slideDoc({ shared = false } = {}) {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  if (shared) {
    // A clarification reusing a stage's surface makes that surface's blocks shared by two slides.
    const decisionBeat = source.beats.find(beat => beat.decision_id), reused = source.beats.find(beat => !beat.decision_id);
    source.clarifications = [{ id: uuidv7(), label: 'Clarify', surface_id: reused.surface_id, beat_ids: [decisionBeat.id] }];
    source.required_capabilities = [...new Set([...source.required_capabilities, 'early_clarification'])];
  }
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const valid = document => {
  const result = validateBuilderDocument(document, { metadata_version: 1 }, { validateSlides: validateSlideParts });
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 3)));
  return document;
};
const applied = result => { assert.equal(result.ok, true, result.reason); return valid(result.document); };
const start = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const placementsOf = composition => Object.fromEntries(composition.placements.map(item => [item.block_id, `${item.col},${item.row},${item.w},${item.h}`]));

test('[AS-145] templates move placements only: four blocks into two slots keep two visibly unplaced, nothing is lost', () => {
  let document = slideDoc(); const id = start(document).id;
  for (const kind of ['heading', 'text', 'callout']) document = applied(edit.addBlock(document, id, kind, uuidv7));
  const before = start(document);
  assert.ok(before.reading_order.length >= 4);
  document = applied(edit.applyTemplate(document, id, 'title_text'));
  const after = start(document);
  assert.equal(after.placements.length, 2);
  assert.deepEqual(after.reading_order, before.reading_order);
  assert.deepEqual(after.steps, before.steps);
  assert.equal(document.blocks.length, slideDoc().blocks.length + 3, 'no block content is deleted by a template');
  const issues = validateBuilderDocument(document, { metadata_version: 1 }, { validateSlides: validateSlideParts }).warnings.filter(item => item.code === 'unplaced_block');
  assert.ok(issues.length >= 1, 'unplaced content is reported, not hidden');
  // The first heading in reading order takes the title slot; re-applying a roomier template places everything again.
  const heading = before.reading_order.map(item => document.blocks.find(block => block.id === item)).find(block => block?.type === 'text' && block.paragraphs.some(item => item.style !== 'p'));
  assert.equal(after.placements.find(item => item.block_id === heading.id)?.row, 1);
  document = applied(edit.applyTemplate(document, id, 'bento'));
  assert.ok(start(document).placements.length >= 3);
  assert.equal(edit.applyTemplate(document, id, 'freeform').ok, false);
});

test('[AS-145] placement, reveal steps and reading order change independently', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.addBlock(document, id, 'text', uuidv7));
  const composition = start(document), [first, second] = composition.reading_order, placements = placementsOf(composition);
  document = applied(edit.moveBlockToStep(document, id, first, 'new', uuidv7));
  assert.deepEqual(placementsOf(start(document)), placements, 'Block order never moves a block on the canvas');
  assert.deepEqual(start(document).reading_order, composition.reading_order);
  document = applied(edit.moveInReadingOrder(document, id, second, -1));
  assert.deepEqual(start(document).reading_order.slice(0, 2), [second, first]);
  assert.deepEqual(placementsOf(start(document)), placements);
  const last = start(document).steps.at(-1).id;
  document = applied(edit.moveStep(document, id, last, -1));
  assert.equal(start(document).steps.at(-2).id, last);
  assert.equal(edit.moveStep(document, id, start(document).steps[0].id, -1).ok, false);
});

test('[AS-146] tables keep exact text, units and blanks; rows and columns move by identity', () => {
  let document = slideDoc(); const id = start(document).id;
  const added = edit.addBlock(document, id, 'table', uuidv7, { recipe: 'observations' }); document = applied(added);
  const tableId = added.blockId, table = () => document.blocks.find(block => block.id === tableId);
  assert.deepEqual(table().columns.map(column => column.label), ['Time', 'Observation', 'Value', 'Unit']);
  assert.ok(table().rows[0].cells.every(cell => cell === ''), 'recipes never invent values');
  const [time, , value] = table().columns.map(column => column.id), rowId = table().rows[0].id;
  for (const text of ['0128', '<5', '-2.50', '≥ 94\nrecheck', '']) {
    document = applied(edit.setCell(document, tableId, rowId, value, text));
    assert.equal(table().rows[0].cells[2], text);
  }
  document = applied(edit.setCell(document, tableId, rowId, value, '0128'));
  document = applied(edit.setColumn(document, tableId, value, { unit: 'mmol/L', align: 'end', width: 2 }));
  document = applied(edit.addRow(document, tableId, null, uuidv7));
  document = applied(edit.addColumn(document, tableId, time, uuidv7));
  assert.equal(table().columns.length, 5); assert.equal(table().rows[0].cells.length, 5);
  assert.equal(table().rows[0].cells[3], '0128', 'existing cells follow their column, not an index');
  document = applied(edit.moveColumn(document, tableId, value, -2));
  assert.equal(table().rows[0].cells[table().columns.findIndex(column => column.id === value)], '0128');
  // A populated row or column needs a reviewed confirmation; the last row is never removed.
  assert.equal(edit.removeRow(document, tableId, rowId).review, true);
  document = applied(edit.removeRow(document, tableId, table().rows[1].id));
  assert.equal(edit.removeRow(document, tableId, rowId, { confirmed: true }).ok, false);
  assert.equal(edit.removeColumn(document, tableId, value).review, true);
  document = applied(edit.removeColumn(document, tableId, value, { confirmed: true }));
  assert.ok(!table().rows[0].cells.includes('0128'));
});

test('[AS-146] header semantics off keeps the labels visible as the first row; on promotes them back', () => {
  let document = slideDoc(); const id = start(document).id;
  const added = edit.addBlock(document, id, 'table', uuidv7, { recipe: 'investigations' }); document = applied(added);
  const table = () => document.blocks.find(block => block.id === added.blockId);
  document = applied(edit.setHeaderRow(document, added.blockId, false, uuidv7));
  assert.deepEqual(table().rows[0].cells, ['Test', 'Result', 'Unit', 'Reference']);
  assert.ok(table().columns.every(column => column.label === ''), 'no header text is hidden');
  assert.equal(edit.setColumn(document, added.blockId, table().columns[0].id, { label: 'Hidden' }).ok, false);
  assert.equal(edit.setHeaderRow(document, added.blockId, true, uuidv7).review, true, 'promoting a body row to labels is reviewed');
  document = applied(edit.setHeaderRow(document, added.blockId, true, uuidv7, { confirmed: true }));
  assert.deepEqual(table().columns.map(column => column.label), ['Test', 'Result', 'Unit', 'Reference']);
  assert.equal(table().rows.length, 1);
});

test('[AS-146] range paste is rectangular, atomic and reviewed before overwriting content', () => {
  let document = slideDoc(); const id = start(document).id;
  const added = edit.addBlock(document, id, 'table', uuidv7, { recipe: 'observations' }); document = applied(added);
  const table = () => document.blocks.find(block => block.id === added.blockId), first = table().columns[0].id;
  const before = structuredClone(document);
  for (const bad of ['a\tb\nc', '"a"\tb', 'a\tb\tc\td\te']) { assert.equal(edit.pasteRange(document, added.blockId, table().rows[0].id, first, bad, uuidv7).ok, false); assert.deepEqual(document, before); }
  document = applied(edit.pasteRange(document, added.blockId, table().rows[0].id, first, '00:00\tHR\t\tbpm\n00:05\tHR\t0110\tbpm\n', uuidv7));
  assert.deepEqual(table().rows.map(item => item.cells), [['00:00', 'HR', '', 'bpm'], ['00:05', 'HR', '0110', 'bpm']]);
  assert.equal(edit.pasteRange(document, added.blockId, table().rows[0].id, first, 'X', uuidv7).review, true);
  document = applied(edit.pasteRange(document, added.blockId, table().rows[0].id, first, 'X', uuidv7, { confirmed: true }));
  assert.equal(table().rows[0].cells[0], 'X');
});

test('[AS-147] Turn into keeps identity, placement, step and every word; losses and shared changes are reviewed first', () => {
  let document = slideDoc(); const id = start(document).id;
  const heading = edit.addBlock(document, id, 'heading', uuidv7); document = applied(heading);
  document = applied(edit.setParagraphs(document, heading.blockId, [{ style: 'h2', runs: [{ text: 'Assessment' }] }, { style: 'p', runs: [{ text: 'Body' }] }]));
  const placement = placementsOf(start(document))[heading.blockId], step = start(document).steps.find(item => item.block_ids.includes(heading.blockId)).id;
  assert.equal(edit.turnInto(document, heading.blockId, 'quote').review, true, 'dropping a heading style is reviewed');
  document = applied(edit.turnInto(document, heading.blockId, 'list', { confirmed: true }));
  const block = document.blocks.find(item => item.id === heading.blockId);
  assert.equal(block.type, 'list'); assert.deepEqual(block.items.map(item => paragraphsText([item])), ['Assessment', 'Body']);
  assert.equal(placementsOf(start(document))[heading.blockId], placement);
  assert.ok(start(document).steps.find(item => item.id === step).block_ids.includes(heading.blockId));
  document = applied(edit.turnInto(document, heading.blockId, 'callout'));
  document = applied(edit.setCalloutTone(document, id, heading.blockId, 'coral'));
  // CASE-225: every block keeps its fill, so turning a coloured callout into text loses nothing and needs no review.
  document = applied(edit.turnInto(document, heading.blockId, 'text'));
  assert.equal(start(document).styles.find(style => style.block_id === heading.blockId)?.tone, 'coral', 'the fill survives the conversion');
  const question = document.blocks.find(item => item.type === 'question');
  assert.equal(edit.turnInto(document, question.id, 'text').ok, false);
  const host = document.compositions.find(item => item.reading_order.includes(question.id));
  assert.equal(edit.removeBlock(document, host.id, question.id).ok, false);
});

test('[AS-147] removing a shared block from one slide keeps it for the slides that still show it', () => {
  const document = slideDoc({ shared: true });
  const shared = document.blocks.find(block => document.compositions.filter(item => item.reading_order.includes(block.id)).length > 1 && block.type !== 'question');
  assert.ok(shared, 'the clarification shares the stage surface\'s blocks');
  const [host, other] = document.compositions.filter(item => item.reading_order.includes(shared.id));
  const next = applied(edit.removeBlock(document, host.id, shared.id));
  assert.ok(next.blocks.some(block => block.id === shared.id));
  assert.ok(next.compositions.find(item => item.id === other.id).reading_order.includes(shared.id));
  // A shared change through Turn into names the other slide before it applies.
  assert.match(edit.turnInto(document, shared.id, shared.type === 'list' ? 'text' : 'list').reason ?? '', /2 slides/);
});

test('[AS-145] move, resize, unplace and place keep content, reveal step and reading order; bad cells refuse', () => {
  let document = slideDoc(); const id = start(document).id;
  const added = edit.addBlock(document, id, 'callout', uuidv7); document = applied(added);
  // Blank leaves every block unplaced (and reported), so placement starts from an empty grid.
  document = applied(edit.applyTemplate(document, id, 'blank'));
  const before = start(document), [firstId] = before.reading_order;
  assert.equal(before.placements.length, 0);
  assert.equal(edit.unplaceBlock(document, id, added.blockId).ok, false);
  document = applied(edit.placeBlock(document, id, firstId));
  document = applied(edit.placeBlock(document, id, added.blockId));
  const other = start(document).placements.find(item => item.block_id === firstId), placed = start(document).placements.find(item => item.block_id === added.blockId);
  assert.equal(edit.setPlacement(document, id, added.blockId, { col: other.col, row: other.row, w: 1, h: 1 }).reason, 'That position overlaps another block.');
  for (const cell of [{ col: 0, row: 1, w: 1, h: 1 }, { col: 12, row: 1, w: 2, h: 1 }, { col: 1, row: 1.5, w: 1, h: 1 }]) assert.equal(edit.setPlacement(document, id, added.blockId, cell).ok, false);
  document = applied(edit.setPlacement(document, id, added.blockId, { ...placed, w: 6 }));
  assert.equal(start(document).placements.find(item => item.block_id === added.blockId).w, 6);
  document = applied(edit.unplaceBlock(document, id, added.blockId));
  assert.ok(!start(document).placements.some(item => item.block_id === added.blockId));
  assert.deepEqual(start(document).reading_order, before.reading_order); assert.deepEqual(start(document).steps, before.steps);
  assert.ok(document.blocks.some(block => block.id === added.blockId), 'unplacing never deletes content');
});

test('[AS-146] values and timeline rows keep exact text and refuse populated deletion without review', () => {
  let document = slideDoc(); const id = start(document).id;
  const values = edit.addBlock(document, id, 'values', uuidv7); document = applied(values);
  const rows = () => document.blocks.find(block => block.id === values.blockId).rows, first = rows()[0].id;
  document = applied(edit.setEntry(document, values.blockId, first, 'value', '<5'));
  document = applied(edit.setEntry(document, values.blockId, first, 'unit', 'mmol/L'));
  assert.equal(edit.setEntry(document, values.blockId, first, 'text', 'x').ok, false, 'a values row has no text field');
  assert.equal(edit.addEntry(document, values.blockId, uuidv7(), uuidv7).ok, false);
  document = applied(edit.addEntry(document, values.blockId, null, uuidv7));
  assert.deepEqual(rows().map(row => [row.value, row.unit]), [['<5', 'mmol/L'], ['', '']]);
  assert.equal(edit.removeEntry(document, values.blockId, first).review, true);
  document = applied(edit.removeEntry(document, values.blockId, rows()[1].id));
  assert.equal(edit.removeEntry(document, values.blockId, first, { confirmed: true }).ok, false, 'the last row stays');
  const timeline = edit.addBlock(document, id, 'timeline', uuidv7); document = applied(timeline);
  const entry = document.blocks.find(block => block.id === timeline.blockId).entries[0].id;
  document = applied(edit.setEntry(document, timeline.blockId, entry, 'text', 'Ascent\nthen flight'));
  assert.equal(document.blocks.find(block => block.id === timeline.blockId).entries[0].text, 'Ascent\nthen flight');
});

test('[AS-145] a callout colour change keeps the block\'s alignment and padding; plain removes only the tone', () => {
  let document = slideDoc(); const id = start(document).id;
  const callout = edit.addBlock(document, id, 'callout', uuidv7); document = applied(callout);
  start(document).styles.push({ block_id: callout.blockId, tone: 'blue', align: 'center', padding: 'roomy' });
  document = applied(edit.setCalloutTone(document, id, callout.blockId, 'coral'));
  assert.deepEqual(start(document).styles.find(item => item.block_id === callout.blockId), { block_id: callout.blockId, tone: 'coral', align: 'center', padding: 'roomy' });
  document = applied(edit.setCalloutTone(document, id, callout.blockId, 'plain'));
  assert.deepEqual(start(document).styles.find(item => item.block_id === callout.blockId), { block_id: callout.blockId, align: 'center', padding: 'roomy' });
});

test('[AS-147] numbered lists lose numbering only after review', () => {
  let document = slideDoc(); const id = start(document).id;
  const list = edit.addBlock(document, id, 'list', uuidv7); document = applied(list);
  document = applied(edit.setListOrdered(document, list.blockId, true));
  assert.match(edit.turnInto(document, list.blockId, 'quote').reason, /list numbering/);
});

test('[AS-147] source traces follow moved text, go stale on edits, and removals are counted for review', () => {
  let document = slideDoc(); const id = start(document).id;
  const added = edit.addBlock(document, id, 'text', uuidv7); document = applied(added);
  document = applied(edit.setParagraphs(document, added.blockId, ['One', 'Two', 'Three'].map(text => ({ style: 'p', runs: [{ text }] }))));
  const trace = (field, extra = {}) => ({ entity_id: added.blockId, field, review_status: 'approved', ...extra });
  const metadata = { metadata_version: 1, provenance: [trace('paragraphs[2]'), trace('paragraphs[0]'), trace('paragraphs')] };
  // Removing paragraph 2 ("Two") moves "Three" to index 1: its trace follows, "One" stays, the whole-field trace goes stale.
  let next = applied(edit.setParagraphs(document, added.blockId, ['One', 'Three'].map(text => ({ style: 'p', runs: [{ text }] }))));
  let carried = edit.carryProvenance(document, next, metadata);
  assert.equal(carried.removed, 0);
  assert.deepEqual(carried.metadata.provenance.map(entry => [entry.field, entry.review_status]), [['paragraphs[1]', 'approved'], ['paragraphs[0]', 'approved'], ['paragraphs', 'stale']]);
  // Removing the traced paragraph itself is counted; editing its text in place keeps it, stale.
  next = applied(edit.setParagraphs(document, added.blockId, ['One', 'Two'].map(text => ({ style: 'p', runs: [{ text }] }))));
  assert.equal(edit.carryProvenance(document, next, metadata).removed, 1);
  next = applied(edit.setParagraphs(document, added.blockId, ['One', 'Two', 'Three!'].map(text => ({ style: 'p', runs: [{ text }] }))));
  assert.deepEqual(edit.carryProvenance(document, next, metadata).metadata.provenance[0], trace('paragraphs[2]', { review_status: 'stale' }));
  // Turn into a list re-points paragraphs to items without staling unchanged text; removing the block counts every trace.
  next = applied(edit.turnInto(document, added.blockId, 'list'));
  carried = edit.carryProvenance(document, next, metadata);
  assert.deepEqual(carried.metadata.provenance.map(entry => [entry.field, entry.review_status]), [['items[2]', 'approved'], ['items[0]', 'approved'], ['items', 'approved']]);
  assert.equal(validateBuilderProvenancePaths(next, carried.metadata).length, 0);
  next = applied(edit.removeBlock(document, id, added.blockId));
  assert.equal(edit.carryProvenance(document, next, metadata).removed, 3);
  // Unrelated operations return the same metadata object.
  assert.equal(edit.carryProvenance(document, applied(edit.addBlock(document, id, 'text', uuidv7)), metadata).metadata, metadata);
});

test('[AS-147] a removed stage takes its slide and only-its blocks; traces into them refuse the removal', async () => {
  const { reconcile } = await import('../src/client/builder-slide-check.mjs');
  let document = slideDoc({ shared: true });
  const own = edit.addBlock(document, document.compositions.find(item => item.owner.kind === 'clarification').id, 'callout', uuidv7); document = applied(own);
  const clarification = document.clarifications[0], slide = document.compositions.find(item => item.owner.kind === 'clarification');
  const next = structuredClone(document); next.clarifications = []; next.required_capabilities = next.required_capabilities.filter(item => item !== 'early_clarification');
  const result = reconcile(next, { metadata_version: 1 });
  assert.equal(result.traces, 0);
  assert.ok(!result.document.compositions.some(item => item.owner.id === clarification.id));
  // The clarification reused a stage's surface: its blocks are still shown by that stage and are kept.
  for (const id of slide.reading_order) if (document.compositions.some(item => item !== slide && item.reading_order.includes(id))) assert.ok(result.document.blocks.some(block => block.id === id));
  valid(result.document);
  assert.ok(!result.document.blocks.some(block => block.id === own.blockId), 'a block only that slide showed goes with it');
  assert.equal(reconcile(next, { metadata_version: 1, provenance: [{ entity_id: own.blockId, field: 'paragraphs' }] }).traces, 1);
  assert.equal(reconcile(document, { metadata_version: 1 }).document, document, 'nothing removed: same document');
});

test('[AS-153] block alignment and spacing are slide-local styles; the default value removes the key and keeps the tone', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.addBlock(document, id, 'callout', uuidv7));
  const callout = start(document).reading_order.at(-1);
  document = applied(edit.setCalloutTone(document, id, callout, 'coral'));
  document = applied(edit.setBlockStyle(document, id, callout, 'align', 'center'));
  document = applied(edit.setBlockStyle(document, id, callout, 'padding', 'roomy'));
  assert.deepEqual(start(document).styles.find(item => item.block_id === callout), { block_id: callout, tone: 'coral', align: 'center', padding: 'roomy' });
  document = applied(edit.setBlockStyle(document, id, callout, 'align', 'start'));
  document = applied(edit.setBlockStyle(document, id, callout, 'padding', 'none'));
  assert.deepEqual(start(document).styles.find(item => item.block_id === callout), { block_id: callout, tone: 'coral' });
  assert.equal(edit.setBlockStyle(document, id, callout, 'align', 'justify').ok, false);
  assert.equal(edit.setBlockStyle(document, id, uuidv7(), 'align', 'center').ok, false);
});

test('[AS-153] duplicating a block makes an independent copy with fresh identities, its own last step, free space or unplaced', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.applyTemplate(document, id, 'blank'));
  document = applied(edit.addBlock(document, id, 'table', uuidv7, { recipe: 'observations', at: { col: 1, row: 1, w: 6, h: 4 } }));
  const table = start(document).reading_order.at(-1);
  const result = edit.duplicateBlock(document, id, table, uuidv7);
  document = applied(result);
  const source = document.blocks.find(block => block.id === table), copy = document.blocks.find(block => block.id === result.blockId);
  assert.notEqual(copy.id, source.id);
  assert.deepEqual(copy.columns.map(column => column.label), source.columns.map(column => column.label));
  assert.ok(copy.columns.every((column, at) => column.id !== source.columns[at].id));
  assert.ok(copy.rows.every((row, at) => row.id !== source.rows[at].id));
  const slide = start(document);
  assert.deepEqual(slide.steps.at(-1).block_ids, [copy.id]);
  assert.deepEqual(slide.placements.find(item => item.block_id === copy.id), { block_id: copy.id, col: 7, row: 1, w: 6, h: 4 });
  // The copy is independent: editing it leaves the source untouched.
  document = applied(edit.setCaption(document, copy.id, 'Copy only'));
  assert.notEqual(document.blocks.find(block => block.id === table).caption, 'Copy only');
  // A question binds its decision and is never copied.
  const decisionSlide = document.compositions.find(item => item.reading_order.some(blockId => document.blocks.find(block => block.id === blockId)?.type === 'question'));
  const question = decisionSlide.reading_order.find(blockId => document.blocks.find(block => block.id === blockId)?.type === 'question');
  assert.equal(edit.duplicateBlock(document, decisionSlide.id, question, uuidv7).ok, false);
});

test('[AS-153] moving the last block out of a later step removes that step; Own step splits right after; On entry remains', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.addBlock(document, id, 'text', uuidv7));
  document = applied(edit.addBlock(document, id, 'callout', uuidv7));
  const [entry] = start(document).steps, before = start(document).steps.length;
  const callout = start(document).reading_order.at(-1);
  document = applied(edit.moveBlockToStep(document, id, callout, entry.id, uuidv7));
  assert.equal(start(document).steps.length, before - 1, 'the emptied last step is gone');
  assert.equal(edit.moveBlockToStep(document, id, start(document).steps.at(-1).block_ids[0], 'own', uuidv7).ok, false, 'a block alone in its step already has its own');
  document = applied(edit.moveBlockToStep(document, id, callout, 'own', uuidv7));
  assert.deepEqual(start(document).steps[1].block_ids, [callout], 'own step sits right after On entry');
  const lone = start(document).steps[0].block_ids;
  for (const blockId of lone) document = applied(edit.moveBlockToStep(document, id, blockId, start(document).steps[1].id, uuidv7));
  assert.deepEqual(start(document).steps[0].block_ids, [], 'On entry remains even when empty');
});

test('[AS-153] teaching presets assemble existing primitives in one step, with labels only and no clinical values', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.applyTemplate(document, id, 'blank'));
  for (const preset of Object.keys(edit.PRESETS)) {
    const before = start(document).steps.length;
    const result = edit.addPreset(document, id, preset, uuidv7);
    document = applied(result);
    const step = start(document).steps.at(-1);
    assert.equal(start(document).steps.length, before + 1, `${preset} is one new step`);
    assert.equal(step.block_ids.length, edit.PRESETS[preset].parts.length);
    const blocks = step.block_ids.map(blockId => document.blocks.find(block => block.id === blockId));
    for (const block of blocks.filter(item => item.type === 'table')) assert.ok(block.rows.every(row => row.cells.every(cell => cell === '')), 'no invented values');
    for (const block of blocks.filter(item => item.type === 'values')) assert.ok(block.rows.every(row => !row.value), 'no invented values');
  }
  assert.equal(edit.addPreset(document, id, 'triage', uuidv7).ok, false);
});

test('[AS-153] Turn into table and back keeps every word, previews first, and names what cells cannot hold', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.addBlock(document, id, 'list', uuidv7));
  const list = start(document).reading_order.at(-1);
  document = applied(edit.setListItems(document, list, [{ runs: [{ text: 'Needle decompression', bold: true }] }, { runs: [{ text: 'Chest drain' }] }]));
  const preview = edit.turnInto(document, list, 'table', { createId: uuidv7 });
  assert.equal(preview.ok, false); assert.equal(preview.review, true);
  assert.equal(preview.preview, '| Needle decompression |\n| Chest drain |');
  assert.match(preview.reason, /not bold/);
  assert.equal(edit.turnInto(document, list, 'table').ok, false, 'needs injected identities');
  document = applied(edit.turnInto(document, list, 'table', { confirmed: true, createId: uuidv7 }));
  const table = document.blocks.find(block => block.id === list);
  assert.deepEqual(table.rows.map(row => row.cells), [['Needle decompression'], ['Chest drain']]);
  // Back to text: one paragraph per row, values kept with their column label and unit.
  // Turning the header row on promotes the first row to the column label.
  document = applied(edit.setHeaderRow(document, list, true, uuidv7, { confirmed: true }));
  assert.equal(document.blocks.find(block => block.id === list).columns[0].label, 'Needle decompression');
  const back = edit.turnInto(document, list, 'text', { createId: uuidv7 });
  assert.equal(back.review, true);
  document = applied(edit.turnInto(document, list, 'text', { confirmed: true, createId: uuidv7 }));
  const text = document.blocks.find(block => block.id === list);
  assert.equal(text.type, 'text');
  assert.deepEqual(text.paragraphs.map(paragraph => paragraph.runs[0].text), ['Needle decompression: Chest drain']);
});

test('[AS-155] CASE-220 styles: block background on any block, banded/density/text size on tables only, rendered as classes', async () => {
  const { slidePlan } = await import('../src/client/slide-render.mjs');
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.applyTemplate(document, id, 'blank'));
  document = applied(edit.addBlock(document, id, 'table', uuidv7, { recipe: 'observations', at: { col: 1, row: 1, w: 12, h: 4 } }));
  const table = start(document).reading_order.at(-1);
  for (const [key, value] of [['background', 'soft'], ['banded', true], ['density', 'compact'], ['text_size', 'large']]) document = applied(edit.setBlockStyle(document, id, table, key, value));
  assert.deepEqual(start(document).styles.find(item => item.block_id === table), { block_id: table, background: 'soft', banded: true, density: 'compact', text_size: 'large' });
  const plan = slidePlan({ blocks: start(document).reading_order.map(blockId => document.blocks.find(block => block.id === blockId)), composition: start(document) });
  const node = plan.root.children.at(-1);
  for (const cls of ['slide-bg-soft', 'slide-banded', 'slide-density-compact', 'slide-text-large']) assert.ok(node.cls.split(' ').includes(cls), cls);
  // Defaults remove the key; table keys refuse on other blocks; the validator refuses them too.
  document = applied(edit.setBlockStyle(document, id, table, 'banded', false));
  assert.equal(start(document).styles.find(item => item.block_id === table).banded, undefined);
  const text = start(document).reading_order.find(blockId => document.blocks.find(block => block.id === blockId).type !== 'table');
  if (text) assert.match(edit.setBlockStyle(document, id, text, 'density', 'roomy').reason, /tables only/);
  const forged = structuredClone(document); forged.compositions.find(item => item.id === id).styles.push({ block_id: start(document).reading_order[0] === table ? start(document).reading_order[1] ?? table : start(document).reading_order[0], density: 'roomy' });
  const checked = validateBuilderDocument(forged, { metadata_version: 1 }, { validateSlides: validateSlideParts });
  assert.equal(checked.ok, false);
});

test('[AS-153] a table starter swaps the columns of an empty table only', () => {
  let document = slideDoc(); const id = start(document).id;
  document = applied(edit.addBlock(document, id, 'table', uuidv7, { recipe: 'observations' }));
  const table = start(document).reading_order.at(-1);
  document = applied(edit.applyTableRecipe(document, table, 'investigations', uuidv7));
  assert.deepEqual(document.blocks.find(block => block.id === table).columns.map(column => column.label), ['Test', 'Result', 'Unit', 'Reference']);
  const row = document.blocks.find(block => block.id === table).rows[0], column = document.blocks.find(block => block.id === table).columns[1];
  document = applied(edit.setCell(document, table, row.id, column.id, '7.2'));
  assert.match(edit.applyTableRecipe(document, table, 'timeline', uuidv7).reason, /empty/);
});

test('[AS-163] Values and Timeline turn into a table and back with every value and row identity kept; mismatched tables refuse', () => {
  const document = slideDoc(), values = document.blocks.find(block => block.type === 'values');
  assert.ok(values, 'the converted fixture has a values block');
  const preview = edit.turnInto(document, values.id, 'table', { createId: uuidv7 });
  assert.equal(preview.review, true); assert.match(preview.preview, /\| Label \| Value/);
  const table = edit.turnInto(document, values.id, 'table', { confirmed: true, createId: uuidv7 });
  assert.equal(table.ok, true);
  const converted = table.document.blocks.find(block => block.id === values.id);
  assert.equal(converted.type, 'table'); assert.equal(converted.header_row, true);
  assert.deepEqual(converted.rows.map(row => row.id), values.rows.map(row => row.id));
  assert.deepEqual(converted.rows.map(row => row.cells[1]), values.rows.map(row => row.value));
  assert.deepEqual(validateSlideParts(table.document).errors, []);
  const back = edit.turnInto(table.document, values.id, 'values', { confirmed: true });
  assert.equal(back.ok, true);
  const again = back.document.blocks.find(block => block.id === values.id);
  assert.deepEqual(again.rows.map(({ label, value, unit }) => [label, value, unit ?? '']), values.rows.map(({ label, value, unit }) => [label, value, unit ?? '']));
  assert.deepEqual(validateSlideParts(back.document).errors, []);
  // Timeline: two fixed columns, Time and Event.
  const timeline = { id: uuidv7(), type: 'timeline', entries: [{ id: uuidv7(), label: '08:00', text: 'Arrives' }, { id: uuidv7(), label: '08:10', text: 'Decompressed' }] };
  const withTimeline = structuredClone(document); withTimeline.blocks.push(timeline); withTimeline.compositions[0].reading_order.push(timeline.id); withTimeline.compositions[0].steps[0].block_ids.push(timeline.id);
  const asTable = edit.turnInto(withTimeline, timeline.id, 'table', { confirmed: true, createId: uuidv7 });
  assert.deepEqual(asTable.document.blocks.find(block => block.id === timeline.id).rows.map(row => row.cells), [['08:00', 'Arrives'], ['08:10', 'Decompressed']]);
  assert.equal(edit.turnInto(asTable.document, timeline.id, 'timeline', { confirmed: true }).document.blocks.find(block => block.id === timeline.id).entries[1].text, 'Decompressed');
  // A four-column table is not a timeline or values.
  const wide = structuredClone(asTable.document), wideTable = wide.blocks.find(block => block.id === timeline.id);
  wideTable.columns.push({ id: uuidv7(), label: 'A', width: 1, align: 'start' }, { id: uuidv7(), label: 'B', width: 1, align: 'start' }); for (const row of wideTable.rows) row.cells.push('x', 'y');
  assert.match(edit.turnInto(wide, timeline.id, 'timeline', { confirmed: true }).reason, /two columns/);
  assert.match(edit.turnInto(wide, timeline.id, 'values', { confirmed: true }).reason, /two or three columns/);
});

test('[AS-163] Values and Timeline rows move up and down, and refuse past the ends', () => {
  const document = slideDoc(), values = document.blocks.find(block => block.type === 'values');
  const [first, second] = values.rows;
  const moved = edit.moveEntry(document, values.id, second.id, -1);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.document.blocks.find(block => block.id === values.id).rows.slice(0, 2).map(row => row.id), [second.id, first.id]);
  assert.match(edit.moveEntry(document, values.id, first.id, -1).reason, /already first/);
});

test('[AS-163] a styled table turned into a timeline or text sheds its table-only styles and stays valid', () => {
  const document = slideDoc(), composition = document.compositions[0];
  const table = { id: uuidv7(), type: 'table', header_row: true, first_column_header: false, columns: [{ id: uuidv7(), label: 'Time', width: 1, align: 'start' }, { id: uuidv7(), label: 'Event', width: 3, align: 'start' }], rows: [{ id: uuidv7(), cells: ['08:00', 'Arrives'] }] };
  document.blocks.push(table); composition.reading_order.push(table.id); composition.steps[0].block_ids.push(table.id);
  composition.styles = [...(composition.styles ?? []), { block_id: table.id, tone: 'blue', banded: true, density: 'roomy', text_size: 'large' }];
  for (const type of ['timeline', 'text']) {
    const result = edit.turnInto(document, table.id, type, { confirmed: true });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(validateSlideParts(result.document).errors, [], type);
    assert.deepEqual(result.document.compositions[0].styles.find(style => style.block_id === table.id), { block_id: table.id, tone: 'blue' });
  }
});

test('[AS-153] a decision slide that lost its question takes it back from the palette, once; other slides refuse it', () => {
  const document = slideDoc(), beat = document.beats.find(item => item.decision_id);
  const host = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === beat.id);
  const question = host.reading_order.map(id => document.blocks.find(block => block.id === id)).find(block => block?.type === 'question');
  assert.equal(edit.addBlock(document, host.id, 'question', uuidv7, { decisionId: beat.decision_id }).ok, false, 'already on this slide');
  // Strip it as an import or older draft could, then add it back.
  const stripped = structuredClone(document), slide = stripped.compositions.find(item => item.id === host.id);
  slide.reading_order = slide.reading_order.filter(id => id !== question.id); slide.placements = slide.placements.filter(item => item.block_id !== question.id);
  for (const step of slide.steps) step.block_ids = step.block_ids.filter(id => id !== question.id);
  slide.steps = slide.steps.filter(step => step.block_ids.length); stripped.blocks = stripped.blocks.filter(block => block.id !== question.id);
  const result = applied(edit.addBlock(stripped, host.id, 'question', uuidv7, { decisionId: beat.decision_id }));
  const added = result.blocks.find(block => block.id === result.compositions.find(item => item.id === host.id).reading_order.at(-1));
  assert.deepEqual([added.type, added.decision_id], ['question', beat.decision_id]);
  assert.equal(edit.addBlock(document, start(document).id, 'question', uuidv7, { decisionId: null }).ok, false);
});

test('[CASE-239] a block added to a full slide shares the largest block\'s area: placed, no overlap, still valid', () => {
  let document = slideDoc(); const id = start(document).id;
  // Fill the slide: one block over the whole grid.
  const full = structuredClone(document), slide = full.compositions.find(item => item.id === id);
  slide.placements = slide.placements.slice(0, 1).map(item => ({ ...item, col: 1, row: 1, w: 12, h: 12 }));
  const result = applied(edit.addBlock(full, id, 'text', uuidv7));
  const after = result.compositions.find(item => item.id === id), added = after.placements.find(item => item.block_id === result.blocks.at(-1).id);
  assert.ok(added, 'the new block is on the slide, not in the unplaced tray');
  const cells = new Set();
  for (const item of after.placements) for (let r = item.row; r < item.row + item.h; r++) for (let c = item.col; c < item.col + item.w; c++) {
    assert.equal(cells.has(`${r},${c}`), false, 'no two blocks share a cell'); cells.add(`${r},${c}`);
  }
});

test('[AS-153] a block added to a full slide takes free space first, else the roomiest block\'s half, never squeezing dense text (round 19)', () => {
  const document = slideDoc(), id = start(document).id;
  const full = structuredClone(document), slide = full.compositions.find(item => item.id === id);
  const [dense] = slide.placements, denseBlock = full.blocks.find(item => item.id === dense.block_id);
  denseBlock.paragraphs = Array.from({ length: 6 }, () => ({ style: 'p', runs: [{ text: 'A long paragraph of findings that fills its block on the projector.' }] }));
  // Two blocks fill the grid: dense text on the left (8 columns) and a near-empty one on the right (4 columns).
  const roomy = { id: uuidv7(), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'Short.' }] }] };
  full.blocks.push(roomy); slide.reading_order.push(roomy.id); slide.steps[0].block_ids.push(roomy.id);
  slide.placements = [{ ...dense, col: 1, row: 1, w: 8, h: 12 }, { block_id: roomy.id, col: 9, row: 1, w: 4, h: 12 }];
  const result = applied(edit.addBlock(full, id, 'text', uuidv7));
  const after = result.compositions.find(item => item.id === id), placed = new Map(after.placements.map(item => [item.block_id, item]));
  assert.deepEqual({ w: placed.get(dense.block_id).w, h: placed.get(dense.block_id).h }, { w: 8, h: 12 }, 'the dense text keeps its whole area');
  assert.ok(placed.get(result.blocks.at(-1).id), 'the new block is placed');
  assert.equal(placed.get(roomy.id).col, 9, 'the near-empty block gave up part of its area');
  // With free space left, nothing is split at all.
  slide.placements = [{ ...dense, col: 1, row: 1, w: 8, h: 12 }];
  const roomyAgain = applied(edit.addBlock(full, id, 'text', uuidv7)).compositions.find(item => item.id === id);
  assert.deepEqual(roomyAgain.placements.find(item => item.block_id === dense.block_id), { ...dense, col: 1, row: 1, w: 8, h: 12 });
});


test('[AS-153] a full slide never splits a question or dense text: the new block waits unplaced instead (round 20)', () => {
  const document = slideDoc(), id = start(document).id;
  const full = structuredClone(document), slide = full.compositions.find(item => item.id === id);
  const [dense] = slide.placements, denseBlock = full.blocks.find(item => item.id === dense.block_id);
  denseBlock.paragraphs = Array.from({ length: 8 }, () => ({ style: 'p', runs: [{ text: 'A long paragraph of findings that fills its block on the projector, line after line.' }] }));
  slide.placements = [{ ...dense, col: 1, row: 1, w: 12, h: 12 }];
  const result = edit.addBlock(full, id, 'table', uuidv7);
  assert.equal(result.ok, true);
  assert.equal(result.unplaced, true, 'the new block waits unplaced');
  const after = result.document.compositions.find(item => item.id === id);
  assert.deepEqual(after.placements.find(item => item.block_id === dense.block_id), { ...dense, col: 1, row: 1, w: 12, h: 12 }, 'the dense text keeps its whole area');
  assert.ok(after.reading_order.includes(result.blockId), 'the block is on the slide, waiting to be placed');
});

test('[AS-153] adding and placing share one room finder: a short free area is used, Place makes room, a truly full slide says why (round 21)', () => {
  const document = slideDoc(), id = start(document).id;
  const full = structuredClone(document), slide = full.compositions.find(item => item.id === id);
  const [dense] = slide.placements, denseBlock = full.blocks.find(item => item.id === dense.block_id);
  denseBlock.paragraphs = Array.from({ length: 8 }, () => ({ style: 'p', runs: [{ text: 'A long paragraph of findings that fills its block on the projector, line after line.' }] }));
  // The dense text fills ten rows; an 8 × 2 area is free below it beside a narrow block.
  const side = { id: uuidv7(), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'Side note with a few more words than a heading.' }] }] };
  full.blocks.push(side); slide.reading_order.push(side.id); slide.steps[0].block_ids.push(side.id);
  slide.placements = [{ ...dense, col: 1, row: 1, w: 12, h: 10 }, { block_id: side.id, col: 9, row: 11, w: 4, h: 2 }];
  const added = edit.addBlock(full, id, 'text', uuidv7);
  assert.equal(added.unplaced, false, 'the free 8 × 2 area takes the new block');
  assert.deepEqual(added.document.compositions.find(item => item.id === id).placements.find(item => item.block_id === added.blockId), { block_id: added.blockId, col: 1, row: 11, w: 8, h: 2 });
  // With the grid truly full of dense text, the block waits; Place then says what to do, never "no free row".
  slide.placements = [{ ...dense, col: 1, row: 1, w: 12, h: 12 }];
  slide.reading_order = slide.reading_order.filter(item => item !== side.id); slide.steps[0].block_ids = slide.steps[0].block_ids.filter(item => item !== side.id);
  const waiting = edit.addBlock(full, id, 'text', uuidv7);
  assert.equal(waiting.unplaced, true);
  const refused = edit.placeBlock(waiting.document, id, waiting.blockId);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /No room on the slide/);
  // Once a block has room to spare, Place makes room from it.
  const roomy = structuredClone(waiting.document);
  roomy.blocks.find(item => item.id === dense.block_id).paragraphs = [{ style: 'p', runs: [{ text: 'Short.' }] }];
  const placed = applied(edit.placeBlock(roomy, id, waiting.blockId));
  assert.ok(placed.compositions.find(item => item.id === id).placements.some(item => item.block_id === waiting.blockId));
});

test('[AS-153] a block is placed only where it can read: a 4-column table needs 8 × 3, never a 4 × 2 gap (round 22)', () => {
  assert.deepEqual(edit.blockNeeds({ type: 'table', columns: [1, 2, 3, 4] }), { height: 4, minW: 8, minH: 3 });
  assert.deepEqual(edit.blockNeeds({ type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'x' }] }] }), { height: 3, minW: 3, minH: 2 });
  const document = slideDoc(), id = start(document).id;
  const full = structuredClone(document), slide = full.compositions.find(item => item.id === id);
  const [dense] = slide.placements, denseBlock = full.blocks.find(item => item.id === dense.block_id);
  const paragraphs = Array.from({ length: 5 }, () => ({ style: 'p', runs: [{ text: 'A long paragraph of findings that fills its block on the projector, line by line.' }] }));
  denseBlock.paragraphs = paragraphs;
  slide.placements = [{ ...dense, col: 1, row: 1, w: 12, h: 12 }];
  const waiting = edit.addBlock(full, id, 'table', uuidv7, { recipe: 'observations' });
  assert.equal(waiting.unplaced, true);
  // Leave exactly a 4 × 2 hole: dense text fills rows 1–10, and a second dense block fills columns 5–12 of rows 11–12.
  const gap = structuredClone(waiting.document), gapSlide = gap.compositions.find(item => item.id === id);
  const second = { id: uuidv7(), type: 'text', paragraphs };
  gap.blocks.push(second); gapSlide.reading_order.push(second.id); gapSlide.steps[0].block_ids.push(second.id);
  gapSlide.placements = [{ ...dense, col: 1, row: 1, w: 12, h: 10 }, { block_id: second.id, col: 5, row: 11, w: 8, h: 2 }];
  const refused = edit.placeBlock(gap, id, waiting.blockId);
  assert.equal(refused.ok, false, 'too small for the table, so Place refuses instead of drawing it at a few pixels');
  assert.equal(refused.reason, 'No room on the slide. Make a block smaller first. A 4-column table needs a free area 8 grid cells wide and 3 tall.');
  // With an 8 × 3 area free it is placed there.
  gapSlide.placements = [{ ...dense, col: 1, row: 1, w: 12, h: 9 }, { block_id: second.id, col: 9, row: 10, w: 4, h: 3 }];
  const placed = applied(edit.placeBlock(gap, id, waiting.blockId)).compositions.find(item => item.id === id).placements.find(item => item.block_id === waiting.blockId);
  assert.ok(placed.w >= 8 && placed.h >= 3, JSON.stringify(placed));
});

// r24 P2-3 (CASE-248): one learner heading. Naming a stage writes its slide's empty lead heading; rewriting that
// heading carries the learner content title while the two matched.
function headedStage() {
  const document = slideDoc(), composition = start(document), beat = document.beats.find(item => item.id === document.start_beat_id);
  const heading = { id: uuidv7(), type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: '' }] }] };
  document.blocks.push(heading); composition.reading_order.unshift(heading.id);
  beat.title = ''; document.surfaces.find(item => item.id === beat.surface_id).title = '';
  return { document, beat, heading };
}
test('[AS-155] followHeadings: a stage name fills its empty slide heading, and a rewritten heading carries the learner title', () => {
  const { document, beat, heading } = headedStage();
  const named = structuredClone(document); named.beats.find(item => item.id === beat.id).title = 'Hyperbaric review';
  named.surfaces.find(item => item.id === beat.surface_id).title = 'Hyperbaric review';
  const after = edit.followHeadings(named, document);
  assert.equal(after.blocks.find(item => item.id === heading.id).paragraphs[0].runs[0].text, 'Hyperbaric review');
  const rewritten = structuredClone(after); rewritten.blocks.find(item => item.id === heading.id).paragraphs[0].runs = [{ text: 'Day 3 · hyperbaric review' }];
  const retitled = edit.followHeadings(rewritten, after);
  assert.equal(retitled.surfaces.find(item => item.id === beat.surface_id).title, 'Day 3 · hyperbaric review');
  assert.equal(retitled.beats.find(item => item.id === beat.id).title, 'Day 3 · hyperbaric review');
  // Editing the public heading deliberately replaces a formerly separate label (CASE-280).
  const apart = structuredClone(after); apart.surfaces.find(item => item.id === beat.surface_id).title = 'Set apart';
  const moved = structuredClone(apart); moved.blocks.find(item => item.id === heading.id).paragraphs[0].runs = [{ text: 'Other' }];
  assert.equal(edit.followHeadings(moved, apart).surfaces.find(item => item.id === beat.surface_id).title, 'Other');
  assert.equal(edit.followHeadings(moved, apart).beats.find(item => item.id === beat.id).title, 'Other');
});
test('[AS-153] followHeadings runs on every keystroke, so its work stays linear in stages, slides and blocks (BWR13, r24 CI)', () => {
  const base = slideDoc(), extra = 120;
  // Many stages, each with its own slide: a per-stage scan of every slide would read the slides array stages × slides times.
  for (let n = 0; n < extra; n++) {
    const beat = { id: uuidv7(), kind: 'surface', title: `Stage ${n}`, surface_id: uuidv7() }, block = { id: uuidv7(), type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: `Stage ${n}` }] }] };
    base.beats.push(beat); base.surfaces.push({ id: beat.surface_id, kind: 'text', title: beat.title }); base.blocks.push(block);
    base.compositions.push({ id: uuidv7(), owner: { kind: 'beat', id: beat.id }, template: 'blank', placements: [], reading_order: [block.id], steps: [{ id: uuidv7(), block_ids: [block.id] }], styles: [] });
  }
  let reads = 0;
  const watch = items => new Proxy(items, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const counted = document => ({ ...document, compositions: watch(document.compositions), blocks: watch(document.blocks) });
  // The last stage is renamed while its heading still matched, so the pass has real work to do.
  const next = structuredClone(base); next.beats.at(-1).title = 'Renamed'; next.surfaces.at(-1).title = 'Renamed';
  const result = edit.followHeadings(counted(next), counted(base));
  assert.equal(result.blocks.at(-1).paragraphs[0].runs[0].text, 'Renamed');
  const items = base.compositions.length + base.blocks.length, stages = base.beats.length;
  assert.ok(reads <= 4 * items, `${reads} reads of ${items} slides and blocks for ${stages} stages (a per-stage scan would read about ${stages * items})`);
});

// Round 28 (CASE-267): typing in a block copies that block only; the draft it starts from is never changed, and every
// other block is the same object, so the history's diff and the trace carry stop at identity.
test('[AS-153] typing in a writing block or a list copies that block only and never changes the draft it starts from', () => {
  const document = slideDoc(), text = document.blocks.find(block => block.type === 'text'), deep = structuredClone(document);
  const typed = applied(edit.setParagraphs(document, text.id, [{ style: 'p', runs: [{ text: 'Typed' }] }]));
  assert.deepEqual(document, deep, 'the starting draft is unchanged');
  assert.equal(paragraphsText(typed.blocks.find(block => block.id === text.id).paragraphs), 'Typed');
  for (const [index, block] of typed.blocks.entries()) if (block.id !== text.id) assert.equal(block, document.blocks[index]);
  assert.equal(typed.compositions, document.compositions);
  const metadata = { metadata_version: 1, provenance: [{ entity_id: document.blocks.find(block => block.id !== text.id).id, field: 'paragraphs[0]', source_id: 's', review_status: 'confirmed' }] };
  assert.equal(edit.carryProvenance(document, typed, metadata).metadata, metadata, 'a trace on an untouched block is carried as it is');
});
