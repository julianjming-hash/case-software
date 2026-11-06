// CASE-317 blood gas compare mode (AS-186). Expected values are hand-computed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import * as compare from '../src/shared/slide-gas-edit.mjs';
import { gasStarter, gasLines, gasVisible, gasColumns, gasCells, GAS_LIMITS } from '../src/shared/slide-gas.mjs';
import { parseGasPrintout, matchGasPrintout, gasNameKey } from '../src/shared/slide-gas-paste.mjs';
import { publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { duplicateStage } from '../src/shared/builder-graph.mjs';
import { createBuilderTransferExport, inspectBuilderTransfer, createBuilderCopyCandidate } from '../src/shared/builder-transfer.mjs';
import { slidePlan } from '../src/client/slide-render.mjs';
import { briefingRows } from '../src/client/briefing.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

const id = name => `00000000-0000-7000-8000-${name.padStart(12, '0')}`;
let next = 0;
const counter = () => id(String(++next));
const rowNamed = (gas, label) => gas.groups.flatMap(group => group.rows).find(item => item.label === label);
const all = (node, cls) => (node.cls?.split(' ').includes(cls) ? [node] : []).concat((node.children ?? []).flatMap(child => all(child, cls)));
const tagged = (node, tag) => (node.tag === tag ? [node] : []).concat((node.children ?? []).flatMap(child => tagged(child, tag)));
const texts = node => Object.hasOwn(node, 'text') ? [node.text] : (node.children ?? []).flatMap(texts);
const plan = block => slidePlan({ blocks: [block], composition: { reading_order: [block.id], placements: [{ block_id: block.id, col: 1, row: 1, w: 12, h: 12 }], styles: [] } }).root;

function slideDoc() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const check = (document, mode) => validateBuilderDocument(document, { metadata_version: 1 }, { validateSlides: validateSlideParts, mode });
const applied = result => { assert.equal(result.ok, true, result.reason); const v = check(result.document); assert.equal(v.ok, true, JSON.stringify(v.errors.slice(0, 3))); return result.document; };
const start = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const gases = document => document.blocks.filter(block => block.type === 'gas');

/** The approved mockup's report: three samples, oldest first, with one empty row and one reading missing at 19:00. */
function compared() {
  const gas = { id: id('100'), type: 'gas', ...gasStarter('arterial', counter) };
  gas.caption = 'Oxygen-driven nebuliser';
  gas.compare = { label: '19:25', earlier: [{ id: id('101'), label: '18:45' }, { id: id('102'), label: '19:00' }] };
  for (const group of gas.groups) for (const row of group.rows) row.earlier = ['', ''];
  const set = (label, earlier, value) => { const row = rowNamed(gas, label); row.earlier = earlier; row.value = value; };
  set('pH', ['7.47', '7.37'], '7.23'); set('pCO2', ['30', '40'], '60'); set('cK+', ['3.9', ''], '3.4'); set('cLac', ['1.8', '3.1'], '');
  return gas;
}

test('[AS-186] the compare contract: 1–3 labelled earlier samples, one reading per sample on every row, text limits', () => {
  let document = slideDoc(); const compositionId = start(document).id;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7));
  const gasId = gases(document)[0].id;
  document = applied(compare.addGasSample(document, gasId, { label: '18:45', current: '19:25' }, uuidv7));
  const good = gases(document)[0];
  assert.deepEqual(gasColumns(good), ['18:45', '19:25']);
  assert.ok(good.groups.every(group => group.rows.every(row => row.earlier.length === 1 && row.earlier[0] === '')));
  assert.equal(check(document, 'ready').errors.filter(item => item.at.includes('compare')).length, 0);
  // Only what a mutation adds is counted: the fresh report's own not-ready advice (no values yet) is the baseline.
  const listed = doc => check(doc, 'ready').errors.map(item => `${item.code}@${item.at.split('/').slice(-2).join('/')}`), baseline = new Set(listed(document));
  const codes = mutate => { const broken = structuredClone(document); mutate(gases(broken)[0]); return listed(broken).filter(code => !baseline.has(code)); };
  // A row whose readings do not match the samples (a reading with no sample, or a missing one) is refused.
  assert.ok(codes(gas => { gas.groups[0].rows[0].earlier.push('7.30'); }).includes('gas_shape@0/earlier'));
  assert.ok(codes(gas => { delete gas.groups[0].rows[1].earlier; }).includes('gas_shape@1/earlier'));
  // A reading outside compare mode, or an unknown field on a sample or on compare itself, is an unknown field.
  assert.ok(codes(gas => { delete gas.compare; }).some(code => code.startsWith('unknown_key@')));
  assert.ok(codes(gas => { gas.compare.earlier[0].values = {}; }).includes('unknown_key@0/values'));
  assert.ok(codes(gas => { gas.compare.colour = 'red'; }).includes('unknown_key@compare/colour'));
  // At most three earlier samples, and at least one.
  assert.ok(codes(gas => { for (let n = 0; n < 3; n++) { gas.compare.earlier.push({ id: uuidv7(), label: `t${n}` }); for (const row of gas.groups.flatMap(group => group.rows)) row.earlier.push(''); } }).includes('too_many@compare/earlier'));
  assert.ok(codes(gas => { gas.compare.earlier = []; for (const row of gas.groups.flatMap(group => group.rows)) row.earlier = []; }).includes('type@compare/earlier'));
  // Labels: 1–24 characters; a reading keeps the value's 24-character limit; a sample id is a fresh UUIDv7.
  assert.ok(codes(gas => { gas.compare.label = ''; }).includes('required@compare/label'));
  assert.ok(codes(gas => { gas.compare.earlier[0].label = 'x'.repeat(GAS_LIMITS.sampleLabel + 1); }).includes('too_long@0/label'));
  assert.ok(codes(gas => { gas.groups[0].rows[0].earlier[0] = '7'.repeat(GAS_LIMITS.value + 1); }).includes('too_long@earlier/0'));
  assert.ok(codes(gas => { gas.groups[0].rows[0].earlier[0] = 7.3; }).includes('type@earlier/0'));
  assert.ok(codes(gas => { gas.compare.earlier[0].id = gas.groups[0].id; }).includes('duplicate_id@0/id'));
  // Like a value, a reading is text: "<0.5" is kept and never flagged; a bound must still be a number.
  assert.equal(codes(gas => { gas.groups[0].rows[0].earlier[0] = '<0.5'; }).length, 0);
  assert.ok(codes(gas => { gas.groups[0].rows[0].low = 'seven'; }).includes('number@0/low'));
  // A report whose only readings are earlier ones is ready: the room sees those rows.
  const earlierOnly = structuredClone(document); gases(earlierOnly)[0].groups[0].rows[0].earlier[0] = '7.30';
  assert.ok(!check(earlierOnly, 'ready').errors.some(item => item.code === 'empty_gas'));
});

test('[AS-186] compare renders ONE table: aligned sample columns oldest first, the newest tinted, a flag per cell, "–" when empty', () => {
  const gas = compared(), root = plan(gas);
  assert.equal(all(root, 'slide-gas-table').length, 0, 'no per-group tables in compare mode');
  const tables = tagged(root, 'table');
  assert.equal(tables.length, 1);
  const [head, ...bodies] = tables[0].children;
  assert.equal(head.tag, 'thead');
  assert.deepEqual(texts(head), ['Unit', '18:45', '19:00', '19:25', 'Range']);
  assert.deepEqual(head.children[0].children.map(cell => cell.cls), [null, 'slide-unit', 'slide-gas-cell', 'slide-gas-cell', 'slide-gas-cell slide-gas-now', 'slide-gas-range']);
  // One body per shown group; its first row is the group name spanning every column. Rows with any reading show.
  assert.deepEqual(bodies.map(body => texts(body.children[0])), [['Blood gas values'], ['Electrolytes'], ['Metabolites']]);
  assert.ok(bodies.every(body => body.children[0].children[0].attrs.colspan === '6'));
  const rows = bodies.flatMap(body => body.children.slice(1));
  // Every row has the same cells in the same order, so each sample's column lines up down the whole printout.
  assert.ok(rows.every(row => row.children.length === 6));
  const cells = row => row.children.slice(2, 5);
  assert.deepEqual(rows.map(row => [texts(row.children[0])[0], ...cells(row).map(cell => texts(cell).join(''))]), [
    ['pH', '↑High: 7.47', '7.37', '↓Low: 7.23'], ['pCO2', '↓Low: 30', '40', '↑High: 60'],
    ['cK+', '3.9', '–', '↓Low: 3.4'], ['cLac', '1.8', '↑High: 3.1', '–']]);
  // Each flagged cell is bold through its own class; the newest column is tinted; ranges print once per row.
  assert.deepEqual(cells(rows[1]).map(cell => cell.cls), ['slide-gas-cell slide-gas-low', 'slide-gas-cell', 'slide-gas-cell slide-gas-now slide-gas-high']);
  assert.deepEqual(rows.map(row => texts(row.children[5])[0]), ['7.35–7.45', '35–45', '3.5–5.2', '0.5–2.0']);
  assert.ok(!texts(root).includes('pO2'), 'a row with no reading in any sample stays off the slide');
  // The sr-only words stay with each flag mark.
  assert.deepEqual(all(rows[0], 'sr-only').map(node => texts(node)[0]), ['High: ', 'Low: ']);
});

test('[AS-186] without compare the two-column report is unchanged, and the text lines read oldest to newest', () => {
  const plain = { id: id('200'), type: 'gas', ...gasStarter('arterial', counter) };
  rowNamed(plain, 'pCO2').value = '60';
  const before = JSON.stringify(plan(plain));
  // The same block with compare mode on and off again (the Builder's add then remove) draws byte-for-byte the same plan.
  let document = slideDoc(); const compositionId = start(document).id;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7));
  const gasId = gases(document)[0].id;
  document = applied(edit.setGasRow(document, gasId, rowNamed(gases(document)[0], 'pCO2').id, 'value', '60'));
  const original = JSON.stringify(plan(gases(document)[0]));
  document = applied(compare.addGasSample(document, gasId, { label: '18:45', current: 'now' }, uuidv7));
  document = applied(compare.removeGasSample(document, gasId, gases(document)[0].compare.earlier[0].id));
  assert.equal(JSON.stringify(plan(gases(document)[0])), original);
  assert.equal('compare' in gases(document)[0], false);
  assert.ok(gases(document)[0].groups.every(group => group.rows.every(row => !('earlier' in row))));
  assert.equal(all(JSON.parse(before), 'slide-gas-table').length, 1);
  assert.deepEqual(gasLines(plain), ['Arterial blood gas', 'Blood gas values', '↑ pCO2 60 mmHg (35–45)']);
  // Compare lines: the samples after the heading, then each row oldest to newest, flagged by its newest reading.
  assert.deepEqual(gasLines(compared()), ['Arterial blood gas · Oxygen-driven nebuliser', '18:45 → 19:00 → 19:25',
    'Blood gas values', '↓ pH 7.47 → 7.37 → 7.23 (7.35–7.45)', '↑ pCO2 30 → 40 → 60 mmHg (35–45)',
    'Electrolytes', '↓ cK+ 3.9 → – → 3.4 mmol/L (3.5–5.2)', 'Metabolites', 'cLac 1.8 → 3.1 → – mmol/L (0.5–2.0)']);
  // The briefing prints the same: the samples under the heading, each row's readings oldest to newest.
  document = applied(compare.addGasSample(document, gasId, { label: '18:45', current: '19:25' }, uuidv7));
  document = applied(compare.setGasReading(document, gasId, rowNamed(gases(document)[0], 'pCO2').id, 0, '30'));
  const rows = JSON.stringify(briefingRows(document));
  for (const piece of ['"18:45 → 19:25"', '["↑ pCO2","30 → 60 mmHg","35–45"]']) assert.ok(rows.includes(piece), piece);
});

test('[AS-186] the public slide carries compare and the readings of shown rows only (hard rule 1)', () => {
  const gas = compared();
  rowNamed(gas, 'cNa+').label = 'Na – author note';
  const composition = { id: id('302'), owner: { kind: 'beat', id: id('303') }, template: 'bento', placements: [{ block_id: gas.id, col: 1, row: 1, w: 12, h: 12 }],
    reading_order: [gas.id], steps: [{ id: id('304'), block_ids: [gas.id] }], styles: [] };
  const surface = { id: id('305'), kind: 'slide', title: 'Gas', slide: { blocks: [gas], composition } };
  const shown = publicPresentationSurface(surface, 1).slide.blocks[0];
  assert.deepEqual(Object.keys(shown).sort(), ['caption', 'compare', 'groups', 'id', 'sample', 'type']);
  assert.deepEqual(shown.compare, gas.compare);
  assert.deepEqual(shown.groups.flatMap(group => group.rows.map(row => [row.label, ...row.earlier, row.value])),
    [['pH', '7.47', '7.37', '7.23'], ['pCO2', '30', '40', '60'], ['cK+', '3.9', '', '3.4'], ['cLac', '1.8', '3.1', '']]);
  assert.ok(!JSON.stringify(shown).includes('author note'));
  assert.deepEqual(publicPresentationSurface(surface, 0).slide.blocks, []);
  assert.deepEqual(gasVisible(shown).length, 3);
});

test('[AS-186] editing samples: copy once by row name, rename, move, fill one column in one change, remove with confirm', () => {
  let document = slideDoc(); const compositionId = start(document).id;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7));
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7));
  const [earlierGas, gas] = gases(document);
  for (const [label, value] of [['pH', '7.37'], ['PCO2 ', '40'], ['cLac', '3.1']]) {
    const row = earlierGas.groups.flatMap(group => group.rows).find(item => item.label.toLowerCase() === label.trim().toLowerCase());
    document = applied(edit.setGasRow(document, earlierGas.id, row.id, 'value', value));
  }
  document = applied(compare.addGasSample(document, gas.id, { label: '19:00', current: '19:25', from: earlierGas.id }, uuidv7));
  let current = gases(document)[1];
  assert.deepEqual(['pH', 'pCO2', 'cLac', 'cK+'].map(label => rowNamed(current, label).earlier), [['7.37'], ['40'], ['3.1'], ['']]);
  // Copied once: a later change to the source never reaches the copy.
  document = applied(edit.setGasRow(document, earlierGas.id, rowNamed(gases(document)[0], 'pH').id, 'value', '7.10'));
  assert.deepEqual(rowNamed(gases(document)[1], 'pH').earlier, ['7.37']);
  // The second sample goes just before the current one; moving it makes it the oldest.
  document = applied(compare.addGasSample(document, gas.id, { label: '18:45' }, uuidv7));
  current = gases(document)[1];
  assert.deepEqual(gasColumns(current), ['19:00', '18:45', '19:25']);
  document = applied(compare.moveGasSample(document, gas.id, current.compare.earlier[1].id, -1));
  current = gases(document)[1];
  assert.deepEqual(gasColumns(current), ['18:45', '19:00', '19:25']);
  assert.deepEqual(rowNamed(current, 'pH').earlier, ['', '7.37']);
  assert.equal(compare.moveGasSample(document, gas.id, current.compare.earlier[0].id, -1).ok, false);
  document = applied(compare.setGasColumnLabel(document, gas.id, 2, '19:30'));
  document = applied(compare.setGasColumnLabel(document, gas.id, 0, '18:40'));
  document = applied(compare.setGasReading(document, gas.id, rowNamed(current, 'pH').id, 0, '7.47'));
  current = gases(document)[1];
  assert.deepEqual([gasColumns(current), gasCells(current, rowNamed(current, 'pH'))], [['18:40', '19:00', '19:30'], ['7.47', '7.37', '']]);
  // A new row or group carries one empty reading per sample.
  document = applied(edit.addGasRow(document, gas.id, current.groups[0].id, uuidv7));
  document = applied(edit.addGasGroup(document, gas.id, uuidv7));
  assert.ok(gases(document)[1].groups.flatMap(group => group.rows).every(row => row.earlier.length === 2));
  // A fourth sample is refused.
  document = applied(compare.addGasSample(document, gas.id, { label: '18:00' }, uuidv7));
  assert.equal(compare.addGasSample(document, gas.id, { label: '17:00' }, uuidv7).ok, false);
  // Fill a column: replacing a different typed reading asks first; confirmed, it is one change.
  current = gases(document)[1];
  const readings = [{ rowId: rowNamed(current, 'pH').id, value: '7.23' }, { rowId: rowNamed(current, 'pCO2').id, value: '60' }];
  document = applied(compare.fillGasColumn(document, gas.id, 3, readings));
  const asked = compare.fillGasColumn(document, gas.id, 1, readings);
  assert.equal(asked.review, true); assert.match(asked.reason, /^2 typed values will be replaced/);
  document = applied(compare.fillGasColumn(document, gas.id, 1, readings, { confirmed: true }));
  current = gases(document)[1];
  assert.deepEqual(gasCells(current, rowNamed(current, 'pCO2')), ['', '60', '', '60']);
  // A row whose only reading is an earlier one still asks before it is deleted.
  assert.equal(edit.removeGasRow(document, gas.id, rowNamed(current, 'cLac').id).review, true);
  // Removing a column with readings asks first; removing the last earlier one ends compare mode.
  const [first, second, third] = current.compare.earlier;
  assert.equal(compare.removeGasSample(document, gas.id, second.id).review, true);
  for (const sample of [first, second, third]) document = applied(compare.removeGasSample(document, gas.id, sample.id, { confirmed: true }));
  assert.equal('compare' in gases(document)[1], false);
  assert.equal(compare.addGasSample(document, gas.id, { from: gas.id }, uuidv7).ok, false, 'a report is not copied into itself');
});

test('[AS-186] reset ranges restores the adult defaults by row name for the block\'s sample', () => {
  let document = slideDoc(); const compositionId = start(document).id;
  document = applied(edit.addBlock(document, compositionId, 'gas', uuidv7, { sample: 'venous' }));
  const gas = gases(document)[0];
  document = applied(edit.setGasRow(document, gas.id, rowNamed(gas, 'pCO2').id, 'low', '30'));
  document = applied(edit.setGasRow(document, gas.id, rowNamed(gas, 'cK+').id, 'label', 'Potassium'));
  document = applied(compare.resetGasRanges(document, gas.id));
  const reset = gases(document)[0];
  assert.deepEqual([rowNamed(reset, 'pCO2').low, rowNamed(reset, 'pCO2').high], ['41', '51'], 'the venous default');
  assert.equal(compare.resetGasRanges(document, gas.id).ok, false, 'nothing left to reset');
});

test('[AS-186] identities: a duplicated block or stage renews its samples, and a transfer copy round-trips compare mode', async () => {
  let document = slideDoc(); const composition = start(document);
  document = applied(edit.addBlock(document, composition.id, 'gas', uuidv7));
  const gasId = gases(document)[0].id;
  document = applied(compare.addGasSample(document, gasId, { label: '18:45', current: '19:25' }, uuidv7));
  document = applied(compare.setGasReading(document, gasId, rowNamed(gases(document)[0], 'pH').id, 0, '7.47'));
  document = applied(edit.duplicateBlock(document, composition.id, gasId, uuidv7));
  const [one, two] = gases(document);
  assert.notEqual(one.compare.earlier[0].id, two.compare.earlier[0].id);
  assert.deepEqual(rowNamed(two, 'pH').earlier, ['7.47']);
  const copied = duplicateStage(document, { metadata_version: 1 }, composition.owner.id, uuidv7);
  assert.equal(copied.ok, true, copied.reason);
  assert.equal(check(copied.document).ok, true, JSON.stringify(check(copied.document).errors.slice(0, 3)));
  assert.equal(new Set(gases(copied.document).map(gas => gas.compare.earlier[0].id)).size, 4);
  // Export, inspect and copy: every identity is remapped and compare mode arrives intact.
  const exported = await createBuilderTransferExport({ document });
  assert.equal(exported.ok, true, JSON.stringify(exported.errors));
  const inspected = await inspectBuilderTransfer(exported.envelope, { acknowledgeRedactions: true });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.errors));
  assert.deepEqual(gases(inspected.candidate.document)[0].compare, one.compare);
  const copy = await createBuilderCopyCandidate(inspected.candidate);
  assert.equal(copy.ok, true, JSON.stringify(copy.errors));
  const moved = gases(copy.candidate.document)[0];
  assert.deepEqual([moved.compare.label, moved.compare.earlier[0].label, rowNamed(moved, 'pH').earlier], ['19:25', '18:45', ['7.47']]);
  assert.notEqual(moved.compare.earlier[0].id, one.compare.earlier[0].id);
});

test('[AS-186] pasting a printout: names match loosely through the alias table, the first reading of each line is taken', () => {
  assert.deepEqual(parseGasPrintout('pH        7.23\n\npCO2      60   mmHg\nBase excess: -3.6\nK+ 3.4H\nFiO2\n'), [
    { line: 'pH        7.23', name: 'pH', value: '7.23' }, { line: 'pCO2      60   mmHg', name: 'pCO2', value: '60' },
    { line: 'Base excess: -3.6', name: 'Base excess', value: '-3.6' }, { line: 'K+ 3.4H', name: 'K+', value: '3.4' }, { line: 'FiO2', name: 'FiO2', value: '' }]);
  // Each pair names the same row: the analyser's c prefix, charge signs, brackets and case are ignored, and aliases join.
  for (const [a, b] of [['HCO3-', 'cHCO3−'], ['HCO3', 'cHCO3−'], ['BE', 'cBase(B)'], ['K', 'cK+'], ['K+', 'cK+'], ['Lactate', 'cLac'], ['Lac', 'cLac'],
    ['Cl', 'cCl−'], ['Hb', 'ctHb'], ['Glucose', 'cGlu'], ['iCa', 'cCa2+'], ['Na', 'cNa+'], ['SaO2', 'sO2'], ['PaCO2', 'pCO2'], ['COHb', 'FCOHb']])
    assert.equal(gasNameKey(a), gasNameKey(b), `${a} ~ ${b}`);
  assert.notEqual(gasNameKey('Cl'), gasNameKey('cLac'));
  assert.notEqual(gasNameKey('pO2'), gasNameKey('pCO2'));
  const gas = gasStarter('arterial', counter);
  const matched = matchGasPrintout('pH 7.23\npCO2 60 mmHg\npO2 74\nHCO3- 24.1\nBE -3.6\nK+ 3.4\nLac 3.8\nFiO2 0.4\npH 7.30\nAnion gap\n', gas);
  assert.deepEqual(matched.readings.map(item => [item.label, item.value]), [['pH', '7.23'], ['pCO2', '60'], ['pO2', '74'], ['cHCO3−', '24.1'], ['cBase(B)', '-3.6'], ['cK+', '3.4'], ['cLac', '3.8']]);
  assert.deepEqual(matched.unmatched, ['FiO2 0.4', 'pH 7.30', 'Anion gap']);
  assert.equal(matched.lines, 10);
});
