// Card 54 graph tools (D01 scope): pure planners refuse what they cannot do safely and name every link they change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument, layoutCandidates, addSlideTitles } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { moveStage, moveStageTo, stageMoveTargets, connectStage, duplicateStage, incomingLinks, withEmptySlide, withoutComposedShadows } from '../src/shared/builder-graph.mjs';
import { addBlock } from '../src/shared/slide-edit.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

const schema2 = () => { const doc = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate; for (const surface of doc.surfaces) delete surface.variants; return doc; };
const valid = (document, metadata = { metadata_version: 1 }) => {
  const result = validateBuilderDocument(document, metadata, { mode: 'preserve', validateSlides: validateSlideParts });
  assert.equal(result.ok, true, JSON.stringify(result.errors?.slice(0, 2)));
};
/** A linear run of three teaching stages after the start, built on the fixture so every other link stays real. */
function linearCase() {
  const doc = schema2(), start = doc.beats.find(beat => beat.id === doc.start_beat_id);
  const [a, b, c] = [0, 1, 2].map(n => ({ id: uuidv7(), kind: 'surface', title: `Stage ${'ABC'[n]}`, surface_id: uuidv7() }));
  for (const beat of [a, b, c]) doc.surfaces.push({ id: beat.surface_id, kind: 'text', title: '', scene: beat.title, points: [] });
  a.next_beat_id = b.id; b.next_beat_id = c.id; c.next_beat_id = start.next_beat_id ?? undefined; if (!c.next_beat_id) delete c.next_beat_id;
  start.next_beat_id = a.id; doc.beats.push(a, b, c);
  return { doc, a, b, c, start };
}

test('[AS-154] Move later swaps two linear stages and names every changed link; Move earlier is its mirror', () => {
  const { doc, a, b, c } = linearCase();
  const result = moveStage(doc, a.id, 1);
  assert.equal(result.ok, true, result.reason);
  const byId = id => result.document.beats.find(beat => beat.id === id);
  assert.equal(result.document.beats.find(beat => beat.next_beat_id === b.id && beat.id !== a.id) !== undefined, true);
  assert.equal(byId(b.id).next_beat_id, a.id); assert.equal(byId(a.id).next_beat_id, c.id);
  assert.equal(result.changes.length, 3);
  valid(result.document);
  const back = moveStage(result.document, a.id, -1);
  assert.equal(back.ok, true, back.reason);
  assert.deepEqual(back.document.beats.map(beat => beat.next_beat_id), doc.beats.map(beat => beat.next_beat_id));
});

test('[AS-154] Move refuses decisions, rejoins and checkpoints rather than rewiring them', () => {
  const { doc, a, b } = linearCase();
  const decision = doc.beats.find(beat => beat.kind === 'decision');
  assert.match(moveStage(doc, decision.id, 1).reason, /Only teaching stages move/);
  // r24 P3: a teaching stage beside a decision is refused for its neighbour, and the reason names that neighbour.
  const beside = structuredClone(doc), stage = beside.beats.find(beat => beat.id === a.id);
  const besideDecision = beside.beats.find(beat => beat.kind === 'decision'); stage.next_beat_id = besideDecision.id;
  assert.equal(moveStage(beside, a.id, 1).reason, `“${besideDecision.title}” is a decision or debrief, which stays where its routes put it. Use Connect to change a route.`);
  // A second link into B makes it a rejoin.
  const extra = structuredClone(doc); extra.decisions[0].paths[0].next_beat_id = b.id;
  assert.match(moveStage(extra, a.id, 1).reason, /reached from 2 places/);
  // A checkpoint keeps its place.
  const checkpoint = structuredClone(doc); const path = checkpoint.decisions[0].paths[0]; delete path.next_beat_id; path.terminal = { checkpoint_beat_id: b.id, debrief_prompt: 'Debrief' };
  assert.match(moveStage(checkpoint, a.id, 1).reason, /checkpoint/);
});

test('[AS-154] Connect changes one named link and says what becomes unconnected or a rejoin', () => {
  const { doc, a, b, c } = linearCase();
  const result = connectStage(doc, a.id, c.id);
  assert.equal(result.ok, true);
  assert.equal(result.document.beats.find(beat => beat.id === a.id).next_beat_id, c.id);
  assert.ok(result.changes.some(line => line.includes('“Stage B” is no longer reached')));
  assert.ok(result.changes.some(line => line.includes('becomes a rejoin')));
  assert.equal(incomingLinks(result.document, b.id).length, 0);
  assert.match(connectStage(doc, a.id, a.id).reason, /cannot lead to itself/);
  assert.match(connectStage(doc, doc.beats.find(beat => beat.kind === 'decision').id, a.id).reason, /consequences/);
  valid(result.document);
});

test('[AS-154] Duplicate stage copies one teaching stage with fresh identities, its own slide and blocks, traces needing review', () => {
  const source = schema2();
  const slides = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate;
  const doc = slides.document, stage = doc.beats.find(beat => beat.id === doc.start_beat_id && beat.kind !== 'decision') ?? doc.beats.find(beat => beat.kind !== 'decision');
  const composition = doc.compositions.find(item => item.owner.id === stage.id), block = composition.reading_order[0];
  const metadata = { metadata_version: 1, sources: [], provenance: [] };
  const result = duplicateStage(doc, metadata, stage.id, uuidv7, { insert: true });
  assert.equal(result.ok, true, result.reason);
  const copy = result.document.beats.find(beat => beat.id === result.beatId);
  assert.equal(copy.title, `${stage.title} (copy)`);
  assert.notEqual(copy.surface_id, stage.surface_id);
  const copied = result.document.compositions.find(item => item.owner.id === copy.id);
  assert.ok(copied && copied.id !== composition.id);
  assert.ok(copied.reading_order.every(id => !composition.reading_order.includes(id)), 'blocks are independent copies');
  assert.equal(result.document.beats.find(beat => beat.id === stage.id).next_beat_id, copy.id);
  assert.equal(copy.next_beat_id, stage.next_beat_id);
  valid(result.document, result.metadata);
  // Independent: editing the copy's first block leaves the original's alone.
  assert.notEqual(copied.reading_order[0], block);
  const decision = doc.beats.find(beat => beat.kind === 'decision');
  assert.match(duplicateStage(doc, metadata, decision.id, uuidv7).reason, /decision stage is not copied/);
});

test('[AS-157] a new slide stage opens as Title and text: an empty H1 in rows 1–2 and an empty body, both On entry', () => {
  const pair = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate;
  const beatId = uuidv7(), next = withEmptySlide(pair.document, beatId, uuidv7);
  const composition = next.compositions.find(item => item.owner.id === beatId), [title, body] = composition.reading_order.map(id => next.blocks.find(block => block.id === id));
  assert.equal(composition.template, 'title_text');
  assert.deepEqual(title.paragraphs, [{ style: 'h1', runs: [{ text: '' }] }]);
  assert.deepEqual(body.paragraphs, [{ style: 'p', runs: [{ text: '' }] }]);
  assert.deepEqual(composition.placements.map(({ row, h }) => [row, h]), [[1, 2], [3, 10]]);
  assert.deepEqual(composition.steps.map(step => step.block_ids), [[title.id, body.id]]);
});

test('[AS-157] D4: a new stage\'s slide takes added blocks at once; its first step is not the reading order itself', () => {
  const pair = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate;
  const beatId = uuidv7(), next = withEmptySlide(pair.document, beatId, uuidv7);
  const composition = next.compositions.find(item => item.owner.id === beatId);
  assert.notEqual(composition.steps[0].block_ids, composition.reading_order);
  const added = addBlock(next, composition.id, 'text', uuidv7);
  assert.equal(added.ok, true, added.reason);
  const after = added.document.compositions.find(item => item.id === composition.id);
  assert.equal(after.steps[0].block_ids.length, 2);
  assert.deepEqual(after.steps.flatMap(step => step.block_ids).sort(), [...after.reading_order].sort(), 'each block in exactly one step');
});

test('[AS-157] D5: a new stage or decision on slides keeps no empty scene or points, so rehearsal can run it', () => {
  const pair = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate;
  const shadowErrors = document => validateCaseDocument(document, { profile: 'schema3' }).errors.filter(error => error.code === 'composed_surface_content');
  const surfaceId = uuidv7(), beatId = uuidv7(), doc = structuredClone(pair.document);
  doc.surfaces.push({ id: surfaceId, kind: 'text', title: '', scene: '', points: [] });
  doc.beats.push({ id: beatId, kind: 'surface', title: '', surface_id: surfaceId });
  const stage = withEmptySlide(doc, beatId, uuidv7);
  assert.deepEqual(Object.keys(stage.surfaces.find(item => item.id === surfaceId)).sort(), ['id', 'kind', 'title']);
  assert.deepEqual(shadowErrors(stage), []);
  // A decision's question surface is also each consequence's reveal: it is cleared once all three have slides.
  const decided = structuredClone(stage), qId = uuidv7(), qBeat = uuidv7(), decisionId = uuidv7(), pathIds = [uuidv7(), uuidv7()];
  decided.surfaces.push({ id: qId, kind: 'text', title: '', scene: '', points: [] });
  decided.beats.push({ id: qBeat, kind: 'decision', title: '', surface_id: qId, decision_id: decisionId });
  decided.decisions.push({ id: decisionId, prompt: '', paths: pathIds.map(id => ({ id, reveal_surface_id: qId })) });
  let next = withEmptySlide(decided, qBeat, uuidv7, { decisionId });
  assert.equal(next.surfaces.find(item => item.id === qId).scene, '', 'a consequence still shows the surface without a slide');
  for (const id of pathIds) next = withEmptySlide(next, { kind: 'path', id }, uuidv7);
  assert.equal(Object.hasOwn(next.surfaces.find(item => item.id === qId), 'scene'), false);
  // An older draft that kept them is cleared by the next edit; filled text is never dropped.
  const older = structuredClone(stage); Object.assign(older.surfaces.find(item => item.id === surfaceId), { scene: '', points: [] });
  assert.deepEqual(Object.keys(withoutComposedShadows(older).surfaces.find(item => item.id === surfaceId)).sort(), ['id', 'kind', 'title']);
  Object.assign(older.surfaces.find(item => item.id === surfaceId), { scene: 'Kept', points: [] });
  assert.equal(withoutComposedShadows(older).surfaces.find(item => item.id === surfaceId).scene, 'Kept');
});

test('[AS-157] critique r23 P1: naming a new slide stage names its learner heading, so rehearsal runs; a heading set apart stays', () => {
  const pair = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate;
  const surfaceId = uuidv7(), beatId = uuidv7(), doc = structuredClone(pair.document);
  doc.surfaces.push({ id: surfaceId, kind: 'text', title: '', scene: '', points: [] });
  doc.beats.push({ id: beatId, kind: 'surface', title: '', surface_id: surfaceId });
  const created = withEmptySlide(doc, beatId, uuidv7);
  const titles = validateCaseDocument(created, { profile: 'schema3' }).errors.filter(error => error.code === 'length').map(error => error.message);
  assert.deepEqual(titles.sort(), ['give its learner content a heading (Stage settings)', 'name this slide']);
  const rename = (from, title) => { const next = structuredClone(from); next.beats.find(beat => beat.id === beatId).title = title; return withoutComposedShadows(next, from); };
  const named = rename(rename(created, 'H'), 'Hyperbaric review');
  assert.equal(named.surfaces.find(item => item.id === surfaceId).title, 'Hyperbaric review');
  assert.deepEqual(validateCaseDocument(named, { profile: 'schema3' }).errors.filter(error => error.code === 'length'), []);
  const apart = structuredClone(named); apart.surfaces.find(item => item.id === surfaceId).title = 'Chamber';
  assert.equal(rename(apart, 'Hyperbaric review, day 3').surfaces.find(item => item.id === surfaceId).title, 'Chamber');
});

test('[AS-157] D25: a consequence\'s or clarification\'s own content follows its renamed label; shared or set-apart content does not', () => {
  const pair = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate, doc = structuredClone(pair.document);
  const decision = doc.decisions[0], [first, second] = decision.paths, own = uuidv7(), stageSurface = doc.beats.find(beat => beat.decision_id === decision.id).surface_id;
  doc.surfaces.push({ id: own, kind: 'text', title: '' });
  first.label = ''; first.reveal_surface_id = own; second.reveal_surface_id = stageSurface;
  const relabel = (from, id, label) => { const next = structuredClone(from); next.decisions[0].paths.find(path => path.id === id).label = label; return withoutComposedShadows(next, from); };
  const title = (document, id) => document.surfaces.find(item => item.id === id).title;
  const named = relabel(relabel(doc, first.id, 'Day 6'), first.id, 'Day 6 · The referral');
  assert.equal(title(named, own), 'Day 6 · The referral');
  // The stage's content, shown by the stage and by the second consequence, keeps its own heading.
  assert.equal(title(relabel(named, second.id, 'Referral pathway'), stageSurface), title(doc, stageSurface));
  const apart = structuredClone(named); apart.surfaces.find(item => item.id === own).title = 'Referral';
  assert.equal(title(relabel(apart, first.id, 'Day 6 · Referral'), own), 'Referral');
});

test('[AS-157] a leading heading takes the title rows and every candidate lays the rest beneath it; too many blocks fall back', () => {
  const text = (id, style, words) => ({ id, type: 'text', paragraphs: [{ style, runs: [{ text: words }] }] });
  const title = text('t', 'h1', 'Referred diagnosis'), body = [1, 2, 3].map(i => text('b' + i, 'p', 'word '.repeat(30)));
  const candidates = layoutCandidates([title, ...body]);
  assert.ok(candidates.length > 1);
  for (const { placements } of candidates) {
    assert.deepEqual(placements[0], { block_id: 't', col: 1, row: 1, w: 12, h: 2 });
    assert.ok(placements.slice(1).every(item => item.row >= 3 && item.row + item.h - 1 <= 12 && item.h >= 1));
  }
  assert.deepEqual(layoutCandidates([title]), [{ template: 'title_text', placements: [{ block_id: 't', col: 1, row: 1, w: 12, h: 2 }] }]);
  // A long heading gets more rows; eleven body blocks no longer fit under it, so every block keeps at least one row.
  const many = layoutCandidates([text('t', 'h1', 'word '.repeat(60)), ...Array.from({ length: 11 }, (_, i) => text('m' + i, 'p', 'x'))])[0];
  assert.ok(many.placements.every(item => item.h >= 1 && item.row >= 1 && item.row + item.h - 1 <= 12));
});

test('[AS-157] the one-off titles slides still in a converted layout, shares one block per surface, and never moves an arranged slide', () => {
  // A draft converted before CASE-222: no title blocks, every slide in the conversion's own first layout.
  const converted = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const titles = new Set(converted.compositions.map(item => item.reading_order[0]));
  const old = structuredClone(converted);
  old.blocks = old.blocks.filter(block => !titles.has(block.id));
  for (const composition of old.compositions) {
    composition.reading_order = composition.reading_order.filter(id => !titles.has(id));
    composition.steps = composition.steps.map(step => ({ ...step, block_ids: step.block_ids.filter(id => !titles.has(id)) }));
    const beat = old.beats.find(item => item.id === composition.owner.id), decision = beat?.kind === 'decision' ? old.decisions.find(item => item.id === beat.decision_id) : null;
    Object.assign(composition, layoutCandidates(composition.reading_order.map(id => old.blocks.find(block => block.id === id)), decision)[0]);
  }
  valid(old);
  // An author nudged one slide: it is reported and left exactly as it is.
  const arranged = old.compositions.find(item => item.placements.length > 1);
  arranged.placements[0] = { ...arranged.placements[0], w: arranged.placements[0].w - 1 };
  const before = structuredClone(old), result = addSlideTitles(old, { createId: uuidv7 });
  assert.deepEqual(old, before, 'the source is never mutated');
  assert.equal(result.ok, true);
  valid(result.document);
  assert.deepEqual(result.skipped, [{ owner: `${arranged.owner.kind}:${arranged.owner.id}`, reason: 'arranged by an author; add the title by hand' }]);
  assert.deepEqual(result.document.compositions.find(item => item.id === arranged.id), arranged);
  assert.equal(result.added.length, old.compositions.length - 1);
  for (const { compositionId } of result.added) {
    const composition = result.document.compositions.find(item => item.id === compositionId), lead = result.document.blocks.find(block => block.id === composition.reading_order[0]);
    const surfaceId = result.document.beats.find(beat => beat.id === composition.owner.id)?.surface_id ?? result.document.decisions.flatMap(item => item.paths).find(path => path.id === composition.owner.id)?.reveal_surface_id;
    assert.deepEqual(lead.paragraphs, [{ style: 'h1', runs: [{ text: result.document.surfaces.find(item => item.id === surfaceId).title }] }]);
    assert.equal(composition.steps[0].block_ids[0], lead.id);
    assert.deepEqual(composition.placements[0], { block_id: lead.id, col: 1, row: 1, w: 12, h: composition.placements[0].h });
  }
  // Every other block keeps its words; a second run finds nothing more to add.
  assert.equal(result.document.blocks.length, old.blocks.length + new Set(result.added.map(({ compositionId }) => result.document.compositions.find(item => item.id === compositionId).reading_order[0])).size);
  assert.deepEqual(addSlideTitles(result.document, { createId: uuidv7 }).added, []);
});

test('[AS-157] the one-off ignores stored placement order and accepts a slide exactly as the conversion saved it', () => {
  const document = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  // A converted draft without titles, as the conversion's own layouts; the database hands placements back in any order.
  const titles = new Set(document.compositions.map(item => item.reading_order[0])), old = structuredClone(document);
  old.blocks = old.blocks.filter(block => !titles.has(block.id));
  for (const composition of old.compositions) {
    composition.reading_order = composition.reading_order.filter(id => !titles.has(id));
    composition.steps = composition.steps.map(step => ({ ...step, block_ids: step.block_ids.filter(id => !titles.has(id)) }));
    const beat = old.beats.find(item => item.id === composition.owner.id), decision = beat?.kind === 'decision' ? old.decisions.find(item => item.id === beat.decision_id) : null;
    Object.assign(composition, layoutCandidates(composition.reading_order.map(id => old.blocks.find(block => block.id === id)), decision)[0]);
  }
  const reordered = structuredClone(old);
  for (const composition of reordered.compositions) composition.placements.reverse();
  assert.equal(addSlideTitles(reordered, { createId: uuidv7 }).skipped.length, 0, 'placement order alone never makes a slide "arranged"');
  // A layout today's heuristics would not offer, but exactly as the conversion saved it, is still the conversion's own.
  const drifted = structuredClone(old), slide = drifted.compositions.find(item => item.placements.length > 1);
  slide.placements[0] = { ...slide.placements[0], w: slide.placements[0].w - 1 };
  assert.equal(addSlideTitles(drifted, { createId: uuidv7 }).skipped.length, 1);
  const since = addSlideTitles(drifted, { createId: uuidv7, converted: structuredClone(drifted) });
  assert.deepEqual(since.skipped, []);
  valid(since.document);
  // Once an author changes that slide after the conversion, it is left alone again.
  const edited = structuredClone(drifted); edited.compositions.find(item => item.id === slide.id).placements[0].h -= 1;
  assert.equal(addSlideTitles(edited, { createId: uuidv7, converted: drifted }).skipped.length, 1);
});

test('[AS-163] a stage moves several places along its path; the review lists only the net link changes', () => {
  const { doc, a, b, c, start } = linearCase();
  const targets = stageMoveTargets(doc, a.id);
  assert.deepEqual(targets.filter(([delta]) => delta > 0).map(([, label]) => label).slice(0, 2), ['After “Stage B”', 'After “Stage C”']);
  // Each place names the stage it sits beside, so an Outline drop onto that stage finds its offset (re-audit #15).
  assert.equal(targets.find(([, , passed]) => passed === c.id)?.[0], 2);
  const result = moveStageTo(doc, a.id, 2);
  assert.equal(result.ok, true, result.reason);
  const byId = id => result.document.beats.find(beat => beat.id === id);
  assert.equal(byId(start.id).next_beat_id, b.id);
  assert.equal(byId(b.id).next_beat_id, c.id);
  assert.equal(byId(c.id).next_beat_id, a.id);
  assert.ok(result.changes.some(line => line.includes('“Stage C” now leads to “Stage A”')));
  assert.equal(new Set(result.changes).size, result.changes.length, 'each change once');
  valid(result.document);
  assert.equal(moveStageTo(doc, a.id, 0).ok, false);
});

test('[AS-182] Duplicate stage renews the nested identities of a blood gas and a trend chart, so the copy stays valid', () => {
  const slides = convertToSlideDocument(schema2(), { metadata_version: 1 }, { createId: uuidv7 }).candidate;
  let doc = slides.document;
  const stage = doc.beats.find(beat => beat.kind !== 'decision'), compositionId = doc.compositions.find(item => item.owner.id === stage.id).id;
  for (const kind of ['gas', 'trend']) { const added = addBlock(doc, compositionId, kind, uuidv7); assert.equal(added.ok, true, added.reason); doc = added.document; }
  const result = duplicateStage(doc, { metadata_version: 1, sources: [], provenance: [] }, stage.id, uuidv7, { insert: true });
  assert.equal(result.ok, true, result.reason);
  valid(result.document, result.metadata);
  const nested = block => [...(block.groups ?? []).flatMap(group => [group.id, ...group.rows.map(row => row.id)]), ...(block.points ?? []).map(point => point.id), ...(block.series ?? []).map(series => series.id)];
  for (const type of ['gas', 'trend']) {
    const [one, two] = result.document.blocks.filter(block => block.type === type);
    assert.ok(nested(one).length > 0, type);
    assert.ok(nested(two).every(id => !nested(one).includes(id)), `${type} copy has fresh nested ids`);
  }
});
