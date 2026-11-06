import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateBuilderProvenancePaths } from '../src/shared/builder-provenance.mjs';
import { PRESENTATION_GROUPS, populatedPresentationGroups } from '../src/shared/presentation-order.mjs';
import { formattedTextPlainText } from '../src/shared/builder-format.mjs';
import { legacySlide, convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { paragraphsText, validateSlideParts } from '../src/shared/slide-document.mjs';
import { isUuidV7, uuidv7 } from '../src/shared/ids.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

const pair = ({ variants = false } = {}) => {
  const converted = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 });
  assert.equal(converted.ok, true);
  const document = converted.candidate;
  // Flag variants have no reviewed slide mapping yet; the lossless fixture removes them, the refusal case keeps them.
  if (!variants) for (const item of document.surfaces) delete item.variants;
  const surface = document.surfaces.find(item => item.points?.length >= 2 && item.observations?.length);
  const metadata = { metadata_version: 1, sources: [{ id: uuidv7(), title: 'Source', text: 'Line one\nLine two', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', rights_status: 'unknown' }] };
  const source = metadata.sources[0].id;
  metadata.provenance = [
    { entity_id: surface.id, field: 'points[1]', source_id: source, start_line: 1, end_line: 1, transformation: 'adapted', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'observations[0].value', source_id: source, start_line: 1, end_line: 1, transformation: 'adapted', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'observations[0]', source_id: source, start_line: 1, end_line: 1, transformation: 'adapted', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'scene', source_id: source, start_line: 1, end_line: 1, transformation: 'adapted', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'title', source_id: source, start_line: 1, end_line: 1, transformation: 'adapted', visibility: 'public', review_status: 'confirmed' },
  ];
  return { document, metadata, surface };
};
const learnerStrings = surface => [
  ...(typeof surface.scene === 'string' ? [surface.scene] : surface.scene ? [formattedTextPlainText(surface.scene)] : []),
  ...(surface.points ?? []), ...(surface.investigations ?? []),
  ...(surface.observations ?? []).flatMap(item => [item.label, String(item.value ?? ''), item.unit ?? '']),
];
const blockStrings = block => block.type === 'text' ? [paragraphsText(block.paragraphs)] : block.type === 'list' ? block.items.map(item => paragraphsText([item]))
  : block.type === 'values' ? block.rows.flatMap(row => [row.label, row.value, row.unit]) : [];

test('[AS-134] schema 3 stays refused unless a caller opts in; schema 1 and 2 validation is unchanged by the hook', () => {
  const { document, metadata } = pair();
  const before = validateBuilderDocument(document, metadata, { mode: 'ready' });
  assert.deepEqual(validateBuilderDocument(document, metadata, { mode: 'ready', validateSlides: validateSlideParts }), before);
  const converted = convertToSlideDocument(document, metadata, { createId: uuidv7 });
  assert.equal(converted.ok, true, JSON.stringify(converted.errors?.slice(0, 3)));
  const refused = validateBuilderDocument(converted.candidate.document, converted.candidate.authoringMetadata);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.errors.map(item => item.code), ['schema_version']);
  // A schema-2 draft may not declare the slide capability; only schema 3 carries it.
  const declared = structuredClone(document); declared.required_capabilities = [...declared.required_capabilities, 'slide_composition'];
  assert.ok(validateBuilderDocument(declared, metadata, { validateSlides: validateSlideParts }).errors.some(item => item.code === 'unknown_capability'));
});

test('[AS-134] the in-memory legacy slide reproduces today\'s fixed reveal order and never mutates or mints identities', () => {
  const { document } = pair(), before = structuredClone(document);
  const owners = [...document.beats.map(beat => ({ kind: 'beat', id: beat.id, surfaceId: beat.surface_id, decision: beat.kind === 'decision' })),
    ...document.decisions.flatMap(decision => decision.paths.map(path => ({ kind: 'path', id: path.id, surfaceId: path.reveal_surface_id })))];
  for (const owner of owners) {
    const slide = legacySlide(document, owner), surface = document.surfaces.find(item => item.id === owner.surfaceId);
    const groups = populatedPresentationGroups(surface);
    assert.equal(slide.composition.steps.length, groups.length + (owner.decision ? 1 : 0), owner.id);
    assert.deepEqual(groups, PRESENTATION_GROUPS.filter(group => groups.includes(group)));
    if (owner.decision) assert.equal(slide.blocks.find(block => block.id === slide.composition.steps.at(-1).block_ids[0]).type, 'question');
    for (const id of [slide.composition.id, ...slide.blocks.map(block => block.id)]) assert.ok(id.startsWith('legacy:') && !isUuidV7(id));
  }
  assert.equal(legacySlide(document, { kind: 'beat', id: uuidv7() }), null);
  assert.deepEqual(document, before);
});

test('[AS-135] explicit upgrade moves every learner string exactly once, keeps the graph, and re-points provenance as stale', () => {
  const { document, metadata, surface } = pair(), before = structuredClone({ document, metadata });
  const result = convertToSlideDocument(document, metadata, { createId: uuidv7 });
  assert.equal(result.ok, true);
  assert.deepEqual({ document, metadata }, before, 'the source pair is never mutated');
  const next = result.candidate.document, nextMetadata = result.candidate.authoringMetadata;
  // Lossless: the multiset of learner strings is identical; no surface keeps a second copy. The one deliberate copy is
  // each shown surface's heading (CASE-222): the surface keeps it and it also opens the slide as an H1, On entry, in rows 1–2.
  const used = new Set([...next.beats.map(beat => beat.surface_id), ...next.decisions.flatMap(decision => decision.paths.map(path => path.reveal_surface_id))]);
  const shown = document.surfaces.filter(item => used.has(item.id));
  const sourceStrings = [...shown.flatMap(learnerStrings), ...shown.map(item => item.title)].filter(Boolean).sort();
  assert.deepEqual(next.blocks.flatMap(blockStrings).filter(Boolean).sort(), sourceStrings);
  for (const item of next.surfaces.filter(entry => used.has(entry.id))) assert.equal(item.title, document.surfaces.find(entry => entry.id === item.id).title);
  for (const composition of next.compositions) {
    const surfaceId = next.beats.find(beat => beat.id === composition.owner.id)?.surface_id ?? next.decisions.flatMap(item => item.paths).find(path => path.id === composition.owner.id)?.reveal_surface_id;
    const lead = next.blocks.find(block => block.id === composition.reading_order[0]);
    assert.deepEqual(lead.paragraphs, [{ style: 'h1', runs: [{ text: document.surfaces.find(entry => entry.id === surfaceId).title }] }]);
    assert.equal(composition.steps[0].block_ids[0], lead.id);
    assert.deepEqual(composition.placements.find(item => item.block_id === lead.id), { block_id: lead.id, col: 1, row: 1, w: 12, h: composition.placements.find(item => item.block_id === lead.id).h });
    assert.ok(composition.placements.filter(item => item.block_id !== lead.id).every(item => item.row > composition.placements.find(entry => entry.block_id === lead.id).h), 'the body sits beneath the title rows');
  }
  for (const item of next.surfaces.filter(entry => used.has(entry.id))) for (const key of ['scene', 'points', 'investigations', 'observations']) assert.equal(item[key], undefined);
  // The graph, decisions and flags are byte-identical; only slide content moved.
  for (const key of ['beats', 'decisions', 'flags', 'start_beat_id', 'clarifications', 'title']) assert.deepEqual(next[key], document[key], key);
  // Every new identity is a fresh UUIDv7, unique across the document.
  const ids = [...next.blocks.map(block => block.id), ...next.compositions.flatMap(item => [item.id, ...item.steps.map(step => step.id)]),
    ...next.blocks.flatMap(block => block.rows?.map(row => row.id) ?? [])];
  assert.ok(ids.every(isUuidV7)); assert.equal(new Set(ids).size, ids.length);
  // One composition per occurrence, and the decision stage ends with its own bound question.
  assert.equal(next.compositions.length, next.beats.length + next.decisions.reduce((sum, item) => sum + item.paths.length, 0));
  // Provenance: moved traces resolve in the new document and lose their review; untouched traces keep it.
  assert.deepEqual(validateBuilderProvenancePaths(next, nextMetadata), []);
  assert.equal(result.staled, 4);
  assert.deepEqual(nextMetadata.provenance.map(entry => entry.review_status), ['stale', 'stale', 'stale', 'stale', 'confirmed']);
  const points = next.blocks.find(block => block.id === nextMetadata.provenance[0].entity_id);
  assert.equal(points.type, 'list'); assert.equal(nextMetadata.provenance[0].field, 'items[1].runs');
  assert.equal(paragraphsText([points.items[1]]), surface.points[1]);
  assert.equal(nextMetadata.provenance[1].field, 'value');
  assert.equal(nextMetadata.provenance[2].field, 'rows[0]');
  assert.equal(nextMetadata.provenance[4].entity_id, surface.id);
  // The upgraded pair is preservable, and strictly ready when the source was.
  assert.equal(validateBuilderDocument(next, nextMetadata, { validateSlides: validateSlideParts }).ok, true);
  assert.equal(validateBuilderDocument(next, nextMetadata, { mode: 'ready', validateSlides: validateSlideParts }).ok, validateBuilderDocument(document, metadata, { mode: 'ready' }).ok);
});

test('[AS-135] upgrade refuses unchanged when content cannot be carried losslessly', () => {
  const { document, metadata } = pair();
  const variant = pair({ variants: true }).document;
  assert.ok(variant.surfaces.some(item => item.variants?.length));
  const before = structuredClone(variant);
  assert.equal(convertToSlideDocument(variant, metadata, { createId: uuidv7 }).code, 'variants_need_review');
  assert.deepEqual(variant, before);
  assert.equal(convertToSlideDocument({ ...document, schema_version: 1 }, metadata, { createId: uuidv7 }).code, 'schema_version');
});

function slideDoc() {
  const { document, metadata } = pair();
  const result = convertToSlideDocument(document, metadata, { createId: uuidv7 });
  return { document: result.candidate.document, metadata: result.candidate.authoringMetadata };
}
const codes = (document, metadata, mode = 'preserve') => validateBuilderDocument(document, metadata, { mode, validateSlides: validateSlideParts }).errors.map(item => item.code);
const firstText = document => document.blocks.find(block => block.type === 'text');
const compositionOf = (document, blockId) => document.compositions.find(item => item.reading_order.includes(blockId));

test('[AS-136] slide structure refuses bad identities, memberships, placements, shapes and bindings without repair', () => {
  const cases = {
    duplicate_id: d => { d.blocks[1].id = d.blocks[0].id; },
    bad_id: d => { d.compositions[0].steps[0].id = 'step-one'; },
    duplicate_membership: d => { const c = d.compositions.find(item => item.steps[0].block_ids.length); c.steps.push({ id: uuidv7(), block_ids: [c.steps[0].block_ids[0]] }); },
    ref: d => { d.compositions[0].steps[0].block_ids.push(uuidv7()); },
    reading_order: d => { const c = d.compositions.find(item => item.reading_order.length > 1); c.reading_order.pop(); },
    placement_overlap: d => { const c = d.compositions.find(item => item.placements.length > 1); c.placements[1].row = c.placements[0].row; },
    placement_bounds: d => { const c = d.compositions.find(item => item.placements.length); c.placements[0].w = 13; },
    duplicate_owner: d => { d.compositions.push({ ...structuredClone(d.compositions[0]), id: uuidv7(), steps: [{ id: uuidv7(), block_ids: [] }], reading_order: [], placements: [] }); },
    enum: d => { firstText(d).paragraphs[0].style = 'h7'; },
    unknown_key: d => { firstText(d).html = '<b>x</b>'; },
    question_binding: d => { const question = d.blocks.find(block => block.type === 'question'); question.decision_id = d.decisions.at(-1).id === question.decision_id ? uuidv7() : d.decisions.at(-1).id; },
    too_long: d => { firstText(d).paragraphs[0].runs = [{ text: 'x'.repeat(501) }]; },
  };
  for (const [code, sabotage] of Object.entries(cases)) {
    const { document, metadata } = slideDoc(); sabotage(document);
    assert.ok(codes(document, metadata).includes(code), `${code}: ${codes(document, metadata).join(',')}`);
  }
});

test('[AS-136] tables keep exact rectangular cells by identity, never hidden header text, within bounds', () => {
  const { document, metadata } = slideDoc();
  const column = label => ({ id: uuidv7(), label, width: 2, align: 'start' });
  const table = { id: uuidv7(), type: 'table', caption: 'Observations', header_row: true, first_column_header: true,
    columns: [column('Time'), column('HR'), { ...column('SpO₂'), align: 'end', unit: '%' }],
    rows: [{ id: uuidv7(), cells: ['00:00', '', '<92'] }, { id: uuidv7(), cells: ['00:05', '0110', '≥ 94\nrecheck'] }] };
  document.blocks.push(table);
  const host = document.compositions[0];
  host.steps.push({ id: uuidv7(), block_ids: [table.id] }); host.reading_order.push(table.id);
  assert.equal(validateBuilderDocument(document, metadata, { validateSlides: validateSlideParts }).ok, true);
  const ragged = structuredClone(document); ragged.blocks.at(-1).rows[0].cells.pop();
  assert.ok(codes(ragged, metadata).includes('table_shape'));
  const hidden = structuredClone(document); hidden.blocks.at(-1).header_row = false;
  assert.ok(codes(hidden, metadata).includes('hidden_header_text'));
  const wide = structuredClone(document); wide.blocks.at(-1).columns.forEach(item => { item.width = 7; });
  assert.ok(codes(wide, metadata).includes('range'));
  const tall = structuredClone(document); const last = tall.blocks.at(-1);
  for (let index = 0; index < 33; index++) last.rows.push({ id: uuidv7(), cells: ['', '', ''] });
  assert.ok(codes(tall, metadata).includes('too_many'));
  // CASE-225: any block may have a fill (tone) and a text colour (ink) from the palette; nothing else is accepted.
  const toned = structuredClone(document); toned.compositions[0].styles = [{ block_id: table.id, tone: 'coral', ink: 'blue' }];
  assert.ok(!codes(toned, metadata).includes('enum'));
  for (const style of [{ tone: 'neon' }, { ink: 'soft' }, { ink: 'plain' }]) {
    const bad = structuredClone(document); bad.compositions[0].styles = [{ block_id: table.id, ...style }];
    assert.ok(codes(bad, metadata).includes('enum'), JSON.stringify(style));
  }
});

test('[AS-136] every reveal prefix keeps a heading outline: a late H1 cannot rescue an early H3', () => {
  const { document, metadata } = slideDoc();
  const host = document.compositions.find(item => item.owner.kind === 'beat');
  const heading = (...lines) => ({ id: uuidv7(), type: 'text', paragraphs: lines.map(([style, text]) => ({ style, runs: [{ text }] })) });
  // The whole slide reads H1, H2, H3; only revealing the H3 block before the title block breaks the outline.
  const early = heading(['h3', 'Findings']), late = heading(['h1', 'Title'], ['h2', 'Assessment']);
  document.blocks.push(early, late);
  host.steps[0].block_ids.push(early.id); host.steps.push({ id: uuidv7(), block_ids: [late.id] });
  host.reading_order.unshift(late.id); host.reading_order.splice(1, 0, early.id);
  const ready = validateBuilderDocument(document, metadata, { mode: 'ready', validateSlides: validateSlideParts });
  const issue = ready.errors.find(item => item.code === 'heading_order');
  assert.equal(issue?.at, `/compositions/${document.compositions.indexOf(host)}/steps/0`);
  // The same outline is valid once the title is On entry; levels are never renumbered to pass.
  host.steps[0].block_ids.push(late.id); host.steps.pop();
  assert.equal(validateBuilderDocument(document, metadata, { mode: 'ready', validateSlides: validateSlideParts }).errors.some(item => item.code === 'heading_order'), false);
  assert.equal(early.paragraphs[0].style, 'h3');
});

test('[AS-134] the legacy slide maps each step to exactly the room\'s populated group, including a blank formatted scene', () => {
  const { document } = pair();
  for (const beat of document.beats) {
    const surface = document.surfaces.find(item => item.id === beat.surface_id), slide = legacySlide(document, { kind: 'beat', id: beat.id });
    assert.deepEqual(slide.groups.filter(group => group !== 'question'), populatedPresentationGroups(surface));
  }
  const blank = structuredClone(document), surface = blank.surfaces.find(item => item.points?.length);
  surface.scene = { blocks: [{ type: 'paragraph', runs: [{ text: '' }] }] };
  const owner = blank.beats.find(beat => beat.surface_id === surface.id);
  assert.equal(legacySlide(blank, { kind: 'beat', id: owner.id }).groups[0], populatedPresentationGroups(surface)[0]);
});

test('[AS-135] formatted scenes, every accepted provenance form and large legacy lists convert losslessly or refuse', () => {
  const { document, metadata, surface } = pair();
  surface.scene = { blocks: [{ type: 'paragraph', runs: [{ text: 'Alpha' }] }, { type: 'list', ordered: false, items: [{ runs: [{ text: 'Beta' }] }] }, { type: 'paragraph', runs: [{ text: 'Gamma' }] }] };
  document.required_capabilities = [...new Set([...document.required_capabilities, 'formatted_text'])];
  const trace = field => ({ ...metadata.provenance[0], field });
  metadata.provenance = [trace('scene'), trace(`surfaces[${surface.id}].scene`), trace('scene.blocks[1].items[0].runs[0].text'), trace('surfaces.points[0]'), trace('observations'), trace('title')];
  const result = convertToSlideDocument(document, metadata, { createId: uuidv7 });
  assert.equal(result.ok, true, JSON.stringify(result.errors?.slice(0, 3)));
  const next = result.candidate.document, provenance = result.candidate.authoringMetadata.provenance;
  assert.deepEqual(validateBuilderProvenancePaths(next, result.candidate.authoringMetadata), []);
  // A whole-scene trace now covers every block the scene became (text, list, text), each stale.
  const sceneTypes = provenance.slice(0, 3).map(entry => next.blocks.find(block => block.id === entry.entity_id).type);
  assert.deepEqual(sceneTypes, ['text', 'list', 'text']);
  assert.equal(provenance.filter(entry => entry.review_status === 'stale').length, provenance.length - 1);
  assert.equal(provenance.find(entry => entry.field === 'items' && next.blocks.find(block => block.id === entry.entity_id).items[0].runs[0].text === 'Beta')?.review_status, 'stale');
  // A trace on the whole formatted-scene array follows every block the scene became.
  const whole = convertToSlideDocument(document, { ...metadata, provenance: [trace('scene.blocks')] }, { createId: uuidv7 });
  assert.equal(whole.ok, true); assert.equal(whole.candidate.authoringMetadata.provenance.length, 3);
  // An unmappable trace inside moved content refuses the upgrade, unchanged.
  const unmapped = { ...metadata, provenance: [trace('scene.blocks[9].runs[0].text')] };
  assert.equal(convertToSlideDocument(document, unmapped, { createId: uuidv7 }).code, 'invalid_provenance');
  // A trace that resolves today but whose content has no slide location (a scene with no text) refuses, unchanged.
  const empty = structuredClone(document), emptySurface = empty.surfaces.find(item => item.id === surface.id);
  emptySurface.scene = { blocks: [{ type: 'paragraph', runs: [{ text: '' }] }] };
  const before = structuredClone(empty);
  assert.equal(convertToSlideDocument(empty, { ...metadata, provenance: [trace('scene.blocks[0].runs[0].text')] }, { createId: uuidv7 }).code, 'provenance_unmapped');
  assert.deepEqual(empty, before);
  // Eight 100-character debrief findings, and more blocks than one grid column, still convert and stay placed.
  const big = structuredClone(document), debrief = big.surfaces.find(item => item.kind === 'debrief') ?? big.surfaces[0];
  debrief.points = Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(100, 'x'));
  const many = big.surfaces.find(item => item.id === surface.id);
  many.scene = { blocks: Array.from({ length: 14 }, (_, index) => index % 2 ? { type: 'list', ordered: false, items: [{ runs: [{ text: `I${index}` }] }] } : { type: 'paragraph', runs: [{ text: `P${index}` }] }) };
  const upgraded = convertToSlideDocument(big, { metadata_version: 1 }, { createId: uuidv7 });
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.errors?.slice(0, 3)));
  const issues = validateBuilderDocument(upgraded.candidate.document, upgraded.candidate.authoringMetadata, { validateSlides: validateSlideParts }).warnings.map(item => item.code);
  assert.equal(issues.includes('unplaced_block'), false);
  assert.equal(issues.includes('too_long'), false);
});

test('[AS-135] clarification occurrences get their own composition over shared blocks', () => {
  const { document, metadata } = pair();
  const decisionBeat = document.beats.find(beat => beat.decision_id);
  document.clarifications = [{ id: uuidv7(), label: 'Clarify', surface_id: decisionBeat.surface_id, beat_ids: [decisionBeat.id] }];
  document.required_capabilities = [...new Set([...document.required_capabilities, 'early_clarification'])];
  const result = convertToSlideDocument(document, metadata, { createId: uuidv7 });
  assert.equal(result.ok, true, JSON.stringify(result.errors?.slice(0, 3)));
  const next = result.candidate.document, clarification = next.compositions.find(item => item.owner.kind === 'clarification');
  const stage = next.compositions.find(item => item.owner.id === decisionBeat.id);
  assert.ok(clarification && stage);
  assert.ok(clarification.reading_order.every(id => stage.reading_order.includes(id)), 'the clarification reuses the stage\'s shared content blocks');
  assert.notEqual(clarification.steps[0].id, stage.steps[0].id);
});

test('[AS-136] hostile shapes return issues instead of throwing; readiness needs content, questions and UUIDv7 ids', () => {
  const { document, metadata } = slideDoc();
  for (const value of [{}, 5, true, null]) {
    const hostile = structuredClone(document); firstText(hostile).paragraphs = value;
    assert.doesNotThrow(() => validateBuilderDocument(hostile, metadata, { validateSlides: validateSlideParts }));
    assert.equal(validateBuilderDocument(hostile, metadata, { validateSlides: validateSlideParts }).ok, false);
  }
  const noQuestion = structuredClone(document), question = noQuestion.blocks.find(block => block.type === 'question');
  const host = noQuestion.compositions.find(item => item.reading_order.includes(question.id));
  host.steps.forEach(step => { step.block_ids = step.block_ids.filter(id => id !== question.id); });
  host.reading_order = host.reading_order.filter(id => id !== question.id); host.placements = host.placements.filter(item => item.block_id !== question.id);
  noQuestion.blocks = noQuestion.blocks.filter(block => block.id !== question.id);
  assert.ok(codes(noQuestion, metadata, 'ready').includes('question_missing'));
  const blank = structuredClone(document), values = blank.blocks.find(block => block.type === 'values');
  values.rows[0].label = '';
  assert.ok(codes(blank, metadata, 'ready').includes('required'));
  const v4 = structuredClone(document); v4.compositions[0].id = '3f0c1d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  assert.ok(codes(v4, metadata).includes('bad_id'));
});

test('[AS-136] a slide that would release more than 32 KiB of public content is not ready (CASE-212)', () => {
  const { document, metadata } = slideDoc();
  const host = document.compositions.find(item => item.owner.kind === 'beat');
  const column = () => ({ id: uuidv7(), label: 'Column', width: 1, align: 'start' });
  const columns = Array.from({ length: 12 }, column);
  const table = { id: uuidv7(), type: 'table', header_row: true, first_column_header: false, columns, rows: Array.from({ length: 6 }, () => ({ id: uuidv7(), cells: columns.map(() => 'x'.repeat(480)) })) };
  document.blocks.push(table); host.steps.push({ id: uuidv7(), block_ids: [table.id] }); host.reading_order.push(table.id);
  assert.ok(codes(document, metadata, 'ready').includes('slide_payload_too_large'));
  assert.equal(codes(document, metadata).includes('slide_payload_too_large'), false, 'preserve mode keeps it as a warning');
  table.rows = table.rows.slice(0, 4);
  assert.equal(codes(document, metadata, 'ready').includes('slide_payload_too_large'), false);
});

test('[AS-159] a text run may be subscript or superscript, nothing else', () => {
  const { document, metadata } = slideDoc();
  const text = document.blocks.find(block => block.type === 'text');
  const withRuns = runs => { const next = structuredClone(document); next.blocks.find(block => block.id === text.id).paragraphs[0].runs = runs; return next; };
  assert.deepEqual(codes(withRuns([{ text: 'SpO' }, { text: '2', script: 'sub' }, { text: 'x', script: 'sup', bold: true }]), metadata), []);
  assert.ok(codes(withRuns([{ text: '2', script: 'middle' }]), metadata).includes('enum'));
  assert.ok(codes(withRuns([{ text: '2', italic: true }]), metadata).length > 0, 'other run formatting is refused');
});

test('D15 (CASE-258): a clarification slide may place the question of the one decision its stages ask, and may drop it', async () => {
  const { removeBlock } = await import('../src/shared/slide-edit.mjs');
  const { withEmptySlide } = await import('../src/shared/builder-graph.mjs');
  const { document, metadata } = slideDoc(), stage = document.beats.find(beat => beat.kind === 'decision'), id = uuidv7();
  document.clarifications = [{ id, label: 'Imaging alongside surgery', surface_id: stage.surface_id, beat_ids: [stage.id] }];
  document.required_capabilities = [...new Set([...(document.required_capabilities ?? []), 'early_clarification'])];
  const placed = withEmptySlide(document, { kind: 'clarification', id }, uuidv7, { decisionId: stage.decision_id });
  assert.ok(!codes(placed, metadata).includes('question_binding'), codes(placed, metadata).join(','));
  const composition = placed.compositions.find(item => item.owner.kind === 'clarification');
  const question = placed.blocks.find(block => block.type === 'question' && composition.reading_order.includes(block.id));
  // Shown during a stage that asks another question (or none), the binding is refused.
  const other = structuredClone(placed), elsewhere = other.beats.find(beat => beat.id !== stage.id && beat.decision_id !== stage.decision_id);
  other.clarifications[0].beat_ids.push(elsewhere.id);
  assert.ok(codes(other, metadata).includes('question_binding'));
  const unbound = structuredClone(placed); unbound.clarifications[0].beat_ids = [];
  assert.ok(codes(unbound, metadata).includes('question_binding'));
  // Optional there: removing it is allowed, and no "question missing" is raised; a stage's own question stays.
  const dropped = removeBlock(placed, composition.id, question.id);
  assert.equal(dropped.ok, true);
  assert.ok(!codes(dropped.document, metadata).some(code => /question/.test(code)));
  const stageSlide = placed.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === stage.id);
  const own = placed.blocks.find(block => block.type === 'question' && stageSlide.reading_order.includes(block.id));
  assert.equal(removeBlock(placed, stageSlide.id, own.id).ok, false);
});

test('r25 P3: empty rows left at the end of a table are advice (never a stop); a blank row inside it is data', () => {
  const { document, metadata } = slideDoc(), column = label => ({ id: uuidv7(), label, width: 2, align: 'start' });
  const table = { id: uuidv7(), type: 'table', header_row: true, first_column_header: false, columns: [column('Time'), column('HR')],
    rows: [{ id: uuidv7(), cells: ['00:00', '110'] }, { id: uuidv7(), cells: ['', ''] }, { id: uuidv7(), cells: ['00:10', '96'] }, { id: uuidv7(), cells: ['', ' '] }, { id: uuidv7(), cells: ['', ''] }] };
  document.blocks.push(table);
  const host = document.compositions[0]; host.steps.push({ id: uuidv7(), block_ids: [table.id] }); host.reading_order.push(table.id);
  const at = `/blocks/${document.blocks.length - 1}`;
  for (const mode of ['preserve', 'ready']) {
    const result = validateBuilderDocument(document, metadata, { mode, validateSlides: validateSlideParts });
    assert.ok(!result.errors.some(issue => issue.code === 'empty_table_row'), mode);
    assert.deepEqual(result.warnings.filter(issue => issue.code === 'empty_table_row').map(issue => [issue.at, issue.message]), [[`${at}/rows/3`, 'remove the empty rows at the end']], mode);
  }
  table.rows.splice(3, 2);
  assert.ok(!validateBuilderDocument(document, metadata, { validateSlides: validateSlideParts }).warnings.some(issue => issue.code === 'empty_table_row'));
});
