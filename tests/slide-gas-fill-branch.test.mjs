// CASE-311 blood gas block, CASE-312 whole-slide fills, CASE-313 branch badge. Expected values are hand-computed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts, SLIDE_FILLS } from '../src/shared/slide-document.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { gasStarter, gasFlag, gasRange, gasVisible, gasLines, gasTitle } from '../src/shared/slide-gas.mjs';
import { decisionBranches } from '../src/shared/decision-branches.mjs';
import { publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { slidePlan } from '../src/client/slide-render.mjs';
import { reconcile } from '../src/client/builder-slide-check.mjs';
import { briefingRows } from '../src/client/briefing.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { initialState, reduce, project } from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

const id = name => `00000000-0000-7000-8000-${name.padStart(12, '0')}`;
let next = 0;
const counter = () => id(String(++next));
const row = (label, value, unit, low, high) => ({ id: counter(), label, value, unit, low, high });

function slideDoc() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const check = (document, mode) => validateBuilderDocument(document, { metadata_version: 1 }, { validateSlides: validateSlideParts, mode });
const applied = result => { assert.equal(result.ok, true, result.reason); const v = check(result.document); assert.equal(v.ok, true, JSON.stringify(v.errors.slice(0, 3))); return result.document; };
const start = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const gasOf = document => document.blocks.find(block => block.type === 'gas');
const rowNamed = (gas, label) => gas.groups.flatMap(group => group.rows).find(item => item.label === label);

test('[AS-182] a new arterial gas carries every standard row with adult ranges and no values; a venous gas has no oxygenation ranges', () => {
  const arterial = gasStarter('arterial', counter), venous = gasStarter('venous', counter);
  assert.deepEqual(arterial.groups.map(group => group.label), ['Blood gas values', 'Acid–base status', 'Electrolytes', 'Metabolites', 'Oxygen status']);
  assert.equal(arterial.groups.flatMap(group => group.rows).length, 3 + 2 + 4 + 2 + 6);
  assert.ok(arterial.groups.flatMap(group => group.rows).every(item => item.value === ''));
  assert.deepEqual([rowNamed(arterial, 'pCO2').low, rowNamed(arterial, 'pCO2').high], ['35', '45']);
  assert.deepEqual([rowNamed(venous, 'pCO2').low, rowNamed(venous, 'pCO2').high], ['41', '51']);
  assert.deepEqual([rowNamed(venous, 'pH').low, rowNamed(venous, 'pH').high], ['7.31', '7.41']);
  for (const label of ['pO2', 'sO2', 'FO2Hb']) assert.deepEqual([rowNamed(venous, label).low, rowNamed(venous, label).high], ['', ''], label);
  // Rows without a venous range keep the arterial one.
  assert.deepEqual([rowNamed(venous, 'cK+').low, rowNamed(venous, 'cK+').high], ['3.5', '5.2']);
  assert.equal(gasTitle(venous), 'Venous blood gas');
});

test('[AS-182] flags come from the row\'s own bounds: outside is flagged, a bound itself is not, and non-numbers never are', () => {
  assert.equal(gasFlag(row('pH', '7.21', '', '7.35', '7.45')), 'low');
  assert.equal(gasFlag(row('pCO2', '60', 'mmHg', '35', '45')), 'high');
  assert.equal(gasFlag(row('pCO2', '45', 'mmHg', '35', '45')), null);
  assert.equal(gasFlag(row('pCO2', '35', 'mmHg', '35', '45')), null);
  assert.equal(gasFlag(row('cBase(B)', '−12.0', 'mmol/L', '-3.0', '3.0')), 'low');
  assert.equal(gasFlag(row('cBase(B)', '-12.0', 'mmol/L', '−3.0', '3.0')), 'low');
  assert.equal(gasFlag(row('cLac', '<0.5', 'mmol/L', '0.5', '2.0')), null);
  assert.equal(gasFlag(row('pO2', '48', 'mmHg', '', '')), null);
  assert.equal(gasFlag(row('FCOHb', '4', '%', '', '1.5')), 'high');
  assert.deepEqual([row('a', '1', '', '7.35', '7.45'), row('a', '1', '', '0.5', ''), row('a', '1', '', '', '1.5'), row('a', '1', '', '', '')].map(gasRange),
    ['7.35–7.45', '≥ 0.5', '≤ 1.5', '']);
});

test('[AS-182] only typed rows reach the room: empty rows and groups drop, and the text exports read the same rows', () => {
  const gas = gasStarter('arterial', counter);
  gas.caption = '10:40 · FiO2 0.6';
  rowNamed(gas, 'pH').value = '7.21';
  rowNamed(gas, 'pCO2').value = ' 60 ';
  rowNamed(gas, 'cLac').value = '1.8';
  const shown = gasVisible(gas);
  assert.deepEqual(shown.map(group => [group.label, group.rows.map(item => item.label)]), [['Blood gas values', ['pH', 'pCO2']], ['Metabolites', ['cLac']]]);
  assert.deepEqual(gasLines(gas), ['Arterial blood gas · 10:40 · FiO2 0.6', 'Blood gas values', '↓ pH 7.21 (7.35–7.45)', '↑ pCO2 60 mmHg (35–45)', 'Metabolites', 'cLac 1.8 mmol/L (0.5–2.0)']);
  // The renderer draws the same rows, marks the flag for sight and names it for a screen reader.
  const block = { id: id('700'), type: 'gas', ...gas };
  const composition = { reading_order: [block.id], placements: [{ block_id: block.id, col: 1, row: 1, w: 12, h: 12 }], styles: [] };
  const { root } = slidePlan({ blocks: [block], composition });
  const all = (node, cls) => (node.cls?.split(' ').includes(cls) ? [node] : []).concat((node.children ?? []).flatMap(child => all(child, cls)));
  const texts = node => Object.hasOwn(node, 'text') ? [node.text] : (node.children ?? []).flatMap(texts);
  assert.equal(all(root, 'slide-gas-table').length, 2);
  assert.deepEqual(all(root, 'slide-gas-high').map(node => texts(node).join('|')), ['↑|High: |pCO2|60|mmHg|35–45']);
  assert.deepEqual(all(root, 'slide-gas-low').map(node => texts(node).join('|')), ['↓|Low: |pH|7.21|7.35–7.45']);
  assert.ok(!texts(root).includes('cK+'), 'an empty row stays off the slide');
});

test('[AS-182] the gas contract: sample enum, numeric bounds in order, row caps, and a report with no values is not ready', () => {
  let document = slideDoc(); const compositionId = start(document).id;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7, { sample: 'venous' }));
  const gas = gasOf(document);
  assert.equal(gas.sample, 'venous');
  // A fresh report is a valid draft, but not ready until a value is typed.
  assert.ok(check(document).warnings.some(item => item.code === 'empty_gas'));
  assert.ok(check(document, 'ready').errors.some(item => item.code === 'empty_gas'));
  const ph = rowNamed(gas, 'pH');
  document = applied(edit.setGasRow(document, gas.id, ph.id, 'value', '7.29'));
  assert.ok(!check(document, 'ready').errors.some(item => item.code === 'empty_gas'));
  const broken = structuredClone(document), target = gasOf(broken);
  target.sample = 'capillary';
  rowNamed(target, 'pH').low = 'seven';
  rowNamed(target, 'pCO2').low = '51'; rowNamed(target, 'pCO2').high = '41';
  rowNamed(target, 'cK+').extra = true;
  const codes = check(broken, 'ready').errors.map(item => `${item.code}@${item.at.split('/').slice(-1)[0]}`);
  for (const code of ['enum@sample', 'number@low', 'range_order@high', 'unknown_key@extra']) assert.ok(codes.some(item => item === code || item.startsWith(code.split('@')[0])), `${code} in ${codes}`);
  assert.equal(edit.setGasField(document, gas.id, 'sample', 'capillary').ok, false);
  assert.equal(edit.setGasRow(document, gas.id, ph.id, 'flag', 'high').ok, false, 'a flag is never typed');
});

test('[AS-182] editing a gas: rows move within their group, a row with a value needs confirming, the last row and group stay', () => {
  let document = slideDoc(); const compositionId = start(document).id;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7));
  let gas = gasOf(document);
  const values = gas.groups[0], pco2 = rowNamed(gas, 'pCO2');
  document = applied(edit.setGasRow(document, gas.id, pco2.id, 'value', '60'));
  document = applied(edit.moveGasRow(document, gas.id, pco2.id, -1));
  assert.deepEqual(gasOf(document).groups[0].rows.map(item => item.label), ['pCO2', 'pH', 'pO2']);
  assert.equal(edit.moveGasRow(document, gas.id, pco2.id, -1).ok, false);
  const asked = edit.removeGasRow(document, gas.id, pco2.id);
  assert.equal(asked.ok, false); assert.equal(asked.review, true);
  document = applied(edit.removeGasRow(document, gas.id, pco2.id, { confirmed: true }));
  for (const item of gasOf(document).groups[0].rows.slice(1)) document = applied(edit.removeGasRow(document, gas.id, item.id));
  assert.equal(edit.removeGasRow(document, gas.id, gasOf(document).groups[0].rows[0].id).ok, false, 'a group keeps one row');
  document = applied(edit.addGasRow(document, gas.id, values.id, uuidv7));
  document = applied(edit.addGasGroup(document, gas.id, uuidv7));
  gas = gasOf(document);
  assert.deepEqual(gas.groups.at(-1).label, 'Other');
  for (const group of gas.groups.slice(1)) document = applied(edit.removeGasGroup(document, gas.id, group.id));
  assert.equal(edit.removeGasGroup(document, gas.id, gasOf(document).groups[0].id).ok, false, 'a report keeps one group');
  // A duplicate renews every group and row identity, so the document stays valid.
  document = applied(edit.duplicateBlock(document, compositionId, gas.id, uuidv7));
  const [one, two] = document.blocks.filter(block => block.type === 'gas');
  const ids = block => block.groups.flatMap(group => [group.id, ...group.rows.map(item => item.id)]);
  assert.equal(new Set([...ids(one), ...ids(two)]).size, ids(one).length * 2);
});

test('[AS-183] a slide fill is one of the block palette tones, set and cleared by the Builder, and reaches the room only when set', () => {
  assert.deepEqual(SLIDE_FILLS, ['soft', 'blue', 'teal', 'green', 'purple', 'coral', 'orange', 'amber', 'grey']);
  let document = slideDoc(); const compositionId = start(document).id;
  assert.equal(edit.setFill(document, compositionId, 'plain').ok, false);
  assert.equal(edit.setFill(document, compositionId, 'red').ok, false);
  document = applied(edit.setFill(document, compositionId, 'teal'));
  assert.equal(start(document).fill, 'teal');
  const invalid = structuredClone(document); start(invalid).fill = 'red';
  assert.ok(check(invalid).errors.some(item => item.code === 'enum' && item.at.endsWith('/fill')));
  document = applied(edit.setFill(document, compositionId, null));
  assert.equal('fill' in start(document), false);
});

test('[AS-183] the projector accepts a known fill on a slide and refuses any other', () => {
  const { state } = room();
  const view = project(state, 'display');
  // A slide surface built by hand: the strict shape is what an unknown fill must fail.
  const slide = { template: 'bento', blocks: [], placements: [], reading_order: [], styles: [] };
  const surface = { surfaceId: uuidv7(), kind: 'slide', title: 'Slide', assetIds: [], slide, timelineKind: 'live', manual: false, at: '2026-10-30T00:00:00.000Z' };
  assert.ok(acceptDisplayView({ ...view, surface }));
  assert.ok(acceptDisplayView({ ...view, surface: { ...surface, slide: { ...slide, fill: 'amber' } } }));
  assert.equal(acceptDisplayView({ ...view, surface: { ...surface, slide: { ...slide, fill: 'red' } } }), null);
});

function room({ sameNext = false } = {}) {
  const { doc } = miniCase();
  const caseDoc = structuredClone(doc);
  if (sameNext) {
    // The opening question without its terminal route: the two that remain rejoin at the same next slide.
    const decision = caseDoc.decisions[0], ending = decision.paths.find(path => !path.next_beat_id);
    decision.paths = decision.paths.filter(path => path !== ending);
    decision.interaction.options = decision.interaction.options.filter(option => !ending.option_ids.includes(option.id));
    assert.equal(validateCaseDocument(caseDoc).ok, true, 'the rejoining fixture is a valid case');
  }
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc });
  const send = type => { state = reduce(state, { type, actor: { role: 'facilitator', id: 'facilitator' }, epoch: state.epoch, at: '2026-10-30T00:00:00.000Z', clientEventId: uuidv7(), roundId: uuidv7() }).state; };
  send('start'); send('advance'); send('advance');
  return { state, caseDoc };
}

test('[AS-184] the branch badge: only when routes lead to different next slides, never which route, on the phone and the projector', () => {
  assert.equal(decisionBranches({ paths: [{ next_beat_id: 'a' }, { next_beat_id: 'b' }] }), true);
  assert.equal(decisionBranches({ paths: [{ next_beat_id: 'a' }, { next_beat_id: 'a' }] }), false);
  assert.equal(decisionBranches({ paths: [{ next_beat_id: null }, { next_beat_id: 'a' }] }), true);
  assert.equal(decisionBranches({ paths: [{ next_beat_id: 'a' }] }), false);
  assert.equal(decisionBranches({}), false);
  // In a single choice, a route no option maps to is the facilitator's alone and does not count.
  const single = paths => ({ interaction: { type: 'single_choice' }, paths });
  assert.equal(decisionBranches(single([{ option_ids: ['x'], next_beat_id: 'a' }, { option_ids: ['y'], next_beat_id: 'a' }, { option_ids: [], next_beat_id: 'b' }])), false);
  assert.equal(decisionBranches(single([{ option_ids: ['x'], next_beat_id: 'a' }, { option_ids: ['y'], next_beat_id: 'b' }])), true);

  const branching = room();
  assert.equal(branching.state.phase, 'responses_open');
  assert.ok(decisionBranches(branching.caseDoc.decisions[0]), 'the mini case branches');
  const pid = uuidv7();
  branching.state.participants[pid] = { name: 'P', joinedAt: '2026-10-30T00:00:00.000Z', removedAt: null };
  branching.state.arrivalCount = 1;
  const display = project(branching.state, 'display'), phone = project(branching.state, 'participant', pid);
  assert.equal(display.decisionBranches, true);
  assert.equal('branches' in display.decision, false, 'the projector carries the badge at its root (CASE-172)');
  assert.equal(phone.decision.branches, true);
  assert.deepEqual(acceptDisplayView(display).decisionBranches, true);
  for (const bad of [false, 'yes', 1]) assert.equal(acceptDisplayView({ ...display, decisionBranches: bad }), null);
  assert.equal(acceptDisplayView({ ...display, decision: null }), null, 'no badge without a question');
  // Hard rule 1: the badge says a route exists, never which one, so no path, beat or next-slide identity is projected.
  const ids = [...branching.caseDoc.decisions.flatMap(decision => decision.paths.flatMap(path => [path.id, path.next_beat_id])), ...branching.caseDoc.beats.map(beat => beat.id)].filter(Boolean);
  assert.ok(ids.length > 4);
  for (const view of [display, phone]) for (const secret of ids) assert.ok(!JSON.stringify(view).includes(secret), 'no route identity in a public view');

  const joined = room({ sameNext: true });
  joined.state.participants[pid] = { name: 'P', joinedAt: '2026-10-30T00:00:00.000Z', removedAt: null };
  assert.equal(joined.state.phase, 'responses_open');
  assert.equal('decisionBranches' in project(joined.state, 'display'), false);
  assert.equal('branches' in project(joined.state, 'participant', pid).decision, false);
});

test('[AS-183] [AS-182] a public slide carries its fill only when set, and a gas block only its typed rows', () => {
  const gas = { id: id('801'), type: 'gas', ...gasStarter('arterial', counter) };
  rowNamed(gas, 'pH').value = '7.21'; rowNamed(gas, 'cLac').value = '1.8';
  rowNamed(gas, 'cK+').label = 'AG 28 – author note';
  const composition = { id: id('802'), owner: { kind: 'beat', id: id('803') }, template: 'bento', placements: [{ block_id: gas.id, col: 1, row: 1, w: 12, h: 12 }],
    reading_order: [gas.id], steps: [{ id: id('804'), block_ids: [gas.id] }], styles: [] };
  const surface = fill => ({ id: id('805'), kind: 'slide', title: 'Gas', slide: { blocks: [gas], composition: { ...composition, ...(fill ? { fill } : {}) } } });
  const plain = publicPresentationSurface(surface(null), 1), filled = publicPresentationSurface(surface('amber'), 1);
  assert.equal('fill' in plain.slide, false);
  assert.equal(filled.slide.fill, 'amber');
  assert.deepEqual(Object.keys(plain.slide.blocks[0]).sort(), ['caption', 'groups', 'id', 'sample', 'type']);
  assert.deepEqual(plain.slide.blocks[0].groups.map(group => [group.label, group.rows.map(item => item.label)]), [['Blood gas values', ['pH']], ['Metabolites', ['cLac']]]);
  assert.ok(!JSON.stringify(plain).includes('author note'), 'an empty row stays with the author (hard rule 1)');
  // Before its step is released the fill still shows (it foretells nothing) and the report does not.
  const unreleased = publicPresentationSurface(surface('amber'), 0);
  assert.deepEqual(unreleased.slide.blocks, []); assert.equal(unreleased.slide.fill, 'amber');
});

test('[AS-182] an older or newer block type draws nothing instead of stopping the slide; a leading-dot reading is a number', () => {
  const composition = { reading_order: [id('901')], placements: [{ block_id: id('901'), col: 1, row: 1, w: 12, h: 12 }], styles: [] };
  for (const layout of [undefined, 'reflow']) {
    const { root } = slidePlan({ blocks: [{ id: id('901'), type: 'future_block', rows: undefined }], composition, ...(layout ? { layout } : {}) });
    assert.equal(root.children.length, 1);
  }
  assert.equal(gasFlag(row('cLac', '.4', 'mmol/L', '0.5', '2.0')), 'low');
  assert.equal(gasFlag(row('cLac', '0.4', 'mmol/L', '.5', '2.0')), 'low');
});

test('[AS-182] removing a stage counts traces on a blood gas\'s groups and rows, and on a trend\'s points and series', () => {
  let document = slideDoc(); const stage = document.beats.find(beat => beat.kind !== 'decision' && beat.id !== document.start_beat_id) ?? document.beats.find(beat => beat.kind !== 'decision');
  const compositionId = document.compositions.find(item => item.owner.id === stage.id).id;
  for (const blockId of document.compositions.find(item => item.id === compositionId).reading_order.slice(1)) document = edit.removeBlock(document, compositionId, blockId).document;
  for (const kind of ['gas', 'trend']) document = applied(edit.addBlock(document, compositionId, kind, uuidv7));
  const gas = gasOf(document), trend = document.blocks.find(block => block.type === 'trend');
  const removed = { ...document, beats: document.beats.filter(beat => beat.id !== stage.id) };
  for (const entity of [gas.groups[0].id, gas.groups[0].rows[0].id, trend.points[0].id, trend.series[0].id]) {
    const metadata = { metadata_version: 1, provenance: [{ entity_id: entity }] };
    assert.equal(reconcile(removed, metadata).traces, 1, entity);
  }
});

test('[AS-182] the briefing prints a gas as its heading, then each group over its typed rows, flagged, with ranges', () => {
  let document = slideDoc(); const compositionId = start(document).id;
  for (const blockId of start(document).reading_order.slice(1)) document = edit.removeBlock(document, compositionId, blockId).document;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7));
  const empty = JSON.stringify(briefingRows(document));
  assert.ok(empty.includes('Arterial blood gas') && !empty.includes('Blood gas values'), 'a report with no values prints its heading only');
  for (const [label, value] of [['pCO2', '60'], ['cLac', '1.8']]) document = applied(edit.setGasRow(document, gasOf(document).id, rowNamed(gasOf(document), label).id, 'value', value));
  const rows = JSON.stringify(briefingRows(document));
  for (const piece of ['Blood gas values', '["↑ pCO2","60 mmHg","35–45"]', 'Metabolites', '["cLac","1.8 mmol/L","0.5–2.0"]']) assert.ok(rows.includes(piece), piece);
});
