// CASE-344 pure slide operations (B1): "+" areas, settle-to-kind sizing, replacing a block in place, and synced blocks.
// Each runs on a real converted case and the result passes the schema-3 validator; the Builder UI that uses them is B2's.
// Titles name their acceptance scenario as (AS-NNN unit part) until the Builder rows land in docs/ACCEPTANCE-SCENARIOS.md,
// whose ids must stay contiguous after the Access PR's AS-203–214; then each becomes the [AS-NNN] tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts, SLIDE_GRID } from '../src/shared/slide-document.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateBuilderProvenancePaths } from '../src/shared/builder-provenance.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

function slideDoc() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const valid = document => {
  const result = validateBuilderDocument(document, { metadata_version: 1 }, { validateSlides: validateSlideParts });
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 3)));
  return document;
};
const applied = result => { assert.equal(result.ok, true, result.reason); return valid(result.document); };
const start = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
// A slide with room for a "+" (the converted case's slides are laid out on templates, most of them full).
const roomy = document => document.compositions.find(item => edit.freeAreas(item.placements).length);
const byId = (document, id) => document.compositions.find(item => item.id === id);
const placementOf = (composition, blockId) => composition.placements.find(item => item.block_id === blockId);
const others = (composition, blockId) => composition.placements.filter(item => item.block_id !== blockId).map(item => ({ ...item }));
const overlaps = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
const inside = (cell, area) => cell.col >= area.col && cell.row >= area.row && cell.col + cell.w <= area.col + area.w && cell.row + cell.h <= area.row + area.h;
const stepOf = (composition, blockId) => composition.steps.findIndex(step => step.block_ids.includes(blockId));
const text = words => [{ style: 'p', runs: [{ text: words }] }];
const trace = (entity_id, field) => ({ entity_id, field, transformation: 'editorial', visibility: 'private', review_status: 'confirmed' });

test('[AS-216] free areas: the largest empty rectangles first, never over a block or each other, none under 2 rows × 3 columns', () => {
  assert.deepEqual(edit.freeAreas([]), [{ col: 1, row: 1, w: 12, h: 12 }]);
  // A title band across the top and a block on the left leave one area beside it and one strip too short for a "+".
  const placements = [{ block_id: 'a', col: 1, row: 1, w: 12, h: 2 }, { block_id: 'b', col: 1, row: 3, w: 7, h: 9 }];
  const areas = edit.freeAreas(placements);
  assert.deepEqual(areas[0], { col: 8, row: 3, w: 5, h: 10 });
  assert.deepEqual(areas, [{ col: 8, row: 3, w: 5, h: 10 }], 'the one-row strip under the left block offers no "+"');
  const busy = [{ col: 1, row: 1, w: 4, h: 4 }, { col: 9, row: 9, w: 4, h: 4 }, { col: 5, row: 6, w: 2, h: 2 }];
  const found = edit.freeAreas(busy);
  assert.ok(found.length > 1);
  for (const [i, area] of found.entries()) {
    assert.ok(area.w >= 3 && area.h >= 2, 'big enough for a "+"');
    assert.ok(area.col + area.w - 1 <= SLIDE_GRID && area.row + area.h - 1 <= SLIDE_GRID);
    assert.ok(!busy.some(item => overlaps(item, area)), 'never over a block');
    assert.ok(!found.slice(0, i).some(other => overlaps(other, area)), 'never over another area');
    if (i) assert.ok(area.w * area.h <= found[i - 1].w * found[i - 1].h, 'largest first');
  }
  assert.deepEqual(edit.freeAreas([{ col: 3, row: 1, w: 1, h: 12 }, { col: 4, row: 3, w: 9, h: 10 }]),
    [{ col: 4, row: 1, w: 9, h: 2 }], 'a larger narrow strip cannot hide a usable area');
  assert.deepEqual(edit.freeAreas([{ col: 1, row: 2, w: 12, h: 1 }, { col: 4, row: 3, w: 9, h: 10 }, { col: 1, row: 6, w: 3, h: 7 }]),
    [{ col: 1, row: 3, w: 3, h: 3 }], 'a larger short strip cannot hide a usable area');
  const full = [{ col: 1, row: 1, w: 12, h: 12 }];
  assert.deepEqual(edit.freeAreas(full), [], 'a full slide has no "+"');
});

test('[AS-216] settle: each kind takes the area’s width from its top-left corner and its own height, never more than the area', () => {
  const area = { col: 3, row: 4, w: 10, h: 9 };
  assert.deepEqual(edit.settle('text', area), { col: 3, row: 4, w: 10, h: 2 }, 'an empty text block: one line plus one');
  assert.equal(edit.settle('text', area, { paragraphs: text('x'.repeat(120)) }).h, 4, '120 characters over 10 columns are three lines');
  assert.equal(edit.settle('text', { ...area, h: 1 }).h, 1, 'at least one row');
  assert.equal(edit.settle('callout', area).h, 3);
  assert.equal(edit.settle('callout', { ...area, h: 2 }).h, 2, 'never taller than its area');
  assert.equal(edit.settle('values', area).h, 5);
  assert.equal(edit.settle('values', area, { rows: Array.from({ length: 7 }, () => ({})) }).h, 8, 'values take their rows');
  assert.equal(edit.settle('table', area, { header_row: true, rows: [{}] }).h, 5);
  assert.equal(edit.settle('gas', area).h, 9);
  assert.equal(edit.settle('gas', { ...area, h: 12, row: 1 }).h, 9, 'a blood gas stops at nine rows');
  for (const kind of ['trend', 'image', 'question']) assert.deepEqual(edit.settle(kind, area), area, `${kind} keeps the whole area`);
  for (const kind of ['text', 'callout', 'values', 'table', 'gas', 'trend']) {
    const cell = edit.settle(kind, area);
    assert.ok(inside(cell, area) && cell.w === area.w && cell.col === area.col && cell.row === area.row, kind);
  }
});

test('[AS-216] a block born in a "+" area settles to its kind and moves no other block; converting it keeps its place', () => {
  let document = slideDoc();
  const slideBefore = roomy(document), id = slideBefore.id, before = others(slideBefore, null);
  const area = edit.freeAreas(slideBefore.placements)[0];
  const added = edit.addBlock(document, id, 'text', uuidv7, { at: edit.settle('text', area) });
  document = applied(added);
  const slide = byId(document, id), cell = placementOf(slide, added.blockId);
  assert.ok(inside(cell, area));
  assert.deepEqual(cell, { block_id: added.blockId, ...edit.settle('text', area) });
  assert.deepEqual(others(slide, added.blockId), before, 'no other block moved or resized');
  const step = stepOf(slide, added.blockId), position = slide.reading_order.indexOf(added.blockId);
  // "/ab" then Enter: the same block becomes a blood gas in the same place, then settles in the area it was born in.
  const replaced = edit.replaceBlock(document, id, added.blockId, 'gas', uuidv7);
  assert.equal(replaced.blockId, added.blockId);
  let next = applied(replaced);
  const converted = byId(next, id);
  assert.equal(next.blocks.find(block => block.id === added.blockId).type, 'gas');
  assert.deepEqual(placementOf(converted, added.blockId), cell, 'replacing keeps the placement');
  assert.equal(stepOf(converted, added.blockId), step, 'and the reveal step');
  assert.equal(converted.reading_order.indexOf(added.blockId), position, 'and the reading position');
  next = applied(edit.setPlacement(next, id, added.blockId, edit.settle('gas', area)));
  assert.deepEqual(others(byId(next, id), added.blockId), before, 'settling again moves no other block');
  assert.ok(inside(placementOf(byId(next, id), added.blockId), area));
});

test('[AS-216] replaceBlock keeps the words between writing kinds and every source trace whose field still exists', () => {
  let document = slideDoc();
  const id = start(document).id, added = edit.addBlock(document, id, 'text', uuidv7);
  document = applied(edit.setParagraphs(applied(added), added.blockId, text('Salbutamol used all night')));
  const metadata = { metadata_version: 1, provenance: [trace(added.blockId, 'paragraphs[0]')] };
  const callout = applied(edit.replaceBlock(document, id, added.blockId, 'callout', uuidv7));
  assert.deepEqual(callout.blocks.find(block => block.id === added.blockId).paragraphs, [{ runs: [{ text: 'Salbutamol used all night' }] }]);
  const carried = edit.carryProvenance(document, callout, metadata);
  assert.equal(carried.removed, 0);
  assert.deepEqual(carried.metadata.provenance, metadata.provenance, 'the trace still points at the same words');
  assert.equal(validateBuilderProvenancePaths(callout, carried.metadata).length, 0);
  // A table has no paragraphs: that trace is counted for review, never silently kept pointing at nothing.
  const table = applied(edit.replaceBlock(document, id, added.blockId, 'table', uuidv7, { recipe: 'blank' }));
  assert.equal(edit.carryProvenance(document, table, metadata).removed, 1);
  assert.equal(edit.replaceBlock(document, id, added.blockId, 'text', uuidv7).ok, false, 'already that kind');
  const question = document.blocks.find(block => block.type === 'question');
  if (question) {
    const owner = document.compositions.find(item => item.reading_order.includes(question.id));
    assert.match(edit.replaceBlock(document, owner.id, question.id, 'text', uuidv7).reason, /bound to its decision/);
  }
});

test('[AS-217] Show on other slides: one shared block, each slide with its own settled placement and its own reveal step', () => {
  let document = slideDoc();
  const home = start(document), added = edit.addBlock(document, home.id, 'values', uuidv7);
  document = applied(added);
  // One slide with room for it and one full slide, where it waits unplaced rather than moving anything.
  const free = document.compositions.find(item => item.id !== home.id && edit.freeAreas(item.placements).some(area => area.w >= 4 && area.h >= 2));
  const full = document.compositions.find(item => item.id !== home.id && !edit.freeAreas(item.placements).length);
  const targets = [free, full], blocks = document.blocks.length;
  assert.ok(free && full);
  const shared = edit.shareBlock(document, added.blockId, targets.map(item => item.id), uuidv7);
  const next = applied(shared);
  assert.deepEqual(shared.added, targets.map(item => item.id));
  assert.equal(next.blocks.length, blocks, 'one block, not copies');
  for (const target of targets) {
    const before = target, after = byId(next, target.id), cell = placementOf(after, added.blockId);
    assert.equal(after.steps.length, before.steps.length + 1, 'its own new reveal step');
    assert.deepEqual(after.steps.at(-1).block_ids, [added.blockId]);
    assert.equal(after.reading_order.at(-1), added.blockId);
    assert.deepEqual(others(after, added.blockId), before.placements.map(item => ({ ...item })), 'nothing else on that slide moved');
    if (target === full) assert.equal(cell, undefined, 'a full slide leaves it unplaced');
    else {
      const area = edit.freeAreas(before.placements).find(item => inside(cell, item));
      assert.ok(area, 'placed inside one of that slide’s free areas');
      assert.deepEqual(cell, { block_id: added.blockId, ...edit.settle('values', area, next.blocks.find(block => block.id === added.blockId)) });
    }
  }
  // Editing it on one slide is an edit to every slide that shows it.
  const row = next.blocks.find(block => block.id === added.blockId).rows[0].id;
  const edited = applied(edit.setEntry(next, added.blockId, row, 'value', '118'));
  for (const composition of [home, ...targets]) assert.ok(byId(edited, composition.id).reading_order.includes(added.blockId));
  assert.equal(edited.blocks.find(block => block.id === added.blockId).rows[0].value, '118');
  // A slide already showing it is left as it is; a question is never shared.
  assert.deepEqual(edit.shareBlock(next, added.blockId, [targets[0].id], uuidv7).document.compositions, next.compositions);
  const question = next.blocks.find(block => block.type === 'question');
  if (question) assert.equal(edit.shareBlock(next, question.id, [home.id], uuidv7).ok, false);
});

test('[AS-217] Unsync this slide: fresh identities here only, same place, step and position, source traces carried', () => {
  let document = slideDoc();
  const home = start(document), added = edit.addBlock(document, home.id, 'values', uuidv7);
  document = applied(added);
  const target = document.compositions.find(item => item.id !== home.id);
  document = applied(edit.shareBlock(document, added.blockId, [target.id], uuidv7));
  const original = document.blocks.find(block => block.id === added.blockId), rowId = original.rows[0].id;
  const metadata = { metadata_version: 1, provenance: [trace(added.blockId, 'rows'), trace(rowId, 'label')] };
  const slide = byId(document, target.id), cell = placementOf(slide, added.blockId), step = stepOf(slide, added.blockId), position = slide.reading_order.indexOf(added.blockId);
  const result = edit.unshareBlock(document, target.id, added.blockId, uuidv7, { metadata });
  const next = applied(result);
  const copy = next.blocks.find(block => block.id === result.blockId);
  assert.notEqual(result.blockId, added.blockId);
  assert.notEqual(copy.rows[0].id, rowId, 'its rows get fresh identities too');
  assert.deepEqual(copy.rows.map(({ id, ...rest }) => rest), original.rows.map(({ id, ...rest }) => rest), 'the same content');
  const after = byId(next, target.id);
  assert.deepEqual(placementOf(after, result.blockId), { ...cell, block_id: result.blockId });
  assert.equal(stepOf(after, result.blockId), step);
  assert.equal(after.reading_order.indexOf(result.blockId), position);
  assert.ok(!after.reading_order.includes(added.blockId), 'this slide no longer shows the shared block');
  assert.ok(byId(next, home.id).reading_order.includes(added.blockId), 'the other slide keeps it');
  assert.deepEqual(byId(next, home.id), byId(document, home.id), 'and is otherwise untouched');
  assert.deepEqual(result.metadata.provenance.slice(2), [trace(result.blockId, 'rows'), trace(copy.rows[0].id, 'label')]);
  assert.deepEqual(result.metadata.provenance.slice(0, 2), metadata.provenance, 'the shared block keeps its own traces');
  assert.equal(validateBuilderProvenancePaths(next, result.metadata).length, 0);
  assert.match(edit.unshareBlock(next, target.id, result.blockId, uuidv7).reason, /only on this slide/);
});
