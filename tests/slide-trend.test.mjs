// Trend chart blocks (card 59 M1, CASE-263): authored numbers only, exact text kept, never interpolated or clipped,
// withheld until their reveal step, and one renderer for every surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, project } from '../src/shared/room-machine.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { slidePlan, buildSlide } from '../src/client/slide-render.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

function slideDoc() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}
const start = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const lactate = () => ({ id: uuidv7(), type: 'trend', caption: 'Lactate after resuscitation', x_label: 'Time since arrival', x_unit: 'h', y_label: 'Lactate', y_unit: 'mmol/L',
  y_min: '0', y_max: '6.0', scale: 'time', style: 'line', values_shown: true,
  points: [['Arrival', '0'], ['2 h', '2'], ['4 h', '4'], ['8 h', '8']].map(([label, at]) => ({ id: uuidv7(), label, at })),
  series: [{ id: uuidv7(), label: 'Lactate', values: ['4.80', '3.9', '', '2.0'] }] });
const issues = (block, mode = 'ready') => { const result = validateSlideParts({ blocks: [block], compositions: [] }, { mode }); return result.errors.filter(item => item.code !== 'orphan_block').concat(result.warnings.filter(item => item.code !== 'orphan_block')); };
const codes = (block, mode) => issues(block, mode).map(item => item.code);
const texts = node => Object.hasOwn(node, 'text') ? [node.text] : (node.children ?? []).flatMap(texts);
const find = (node, predicate) => predicate(node) ? [node] : (node.children ?? []).flatMap(child => find(child, predicate));
const planOf = (block, layout = 'grid') => slidePlan({ blocks: [block], composition: { placements: [{ block_id: block.id, col: 1, row: 1, w: 12, h: 12 }], reading_order: [block.id], styles: [] } }, { layout }).root;

test('[AS-164] a trend chart validates authored numbers, axis bounds, order and shape without repairing anything', () => {
  assert.deepEqual(codes(lactate()), []);
  // Exact decimal text: 1e3, a comma or a unit inside the number is refused, never parsed loosely.
  for (const bad of ['1e3', '4,8', '4.8 mmol', '.5', '12345678']) { const block = lactate(); block.series[0].values[1] = bad; assert.deepEqual(codes(block), ['number'], bad); }
  // Out of axis: advice while drafting, a stop for readiness; the value is kept as typed.
  const high = lactate(); high.series[0].values[0] = '7.1';
  assert.deepEqual(codes(high, 'ready'), ['out_of_axis']); assert.equal(validateSlideParts({ blocks: [high], compositions: [] }, { mode: 'preserve' }).errors.filter(item => item.code === 'out_of_axis').length, 0);
  const inverted = lactate(); inverted.y_min = '6'; inverted.y_max = '6';
  assert.ok(codes(inverted).includes('axis_range'));
  const backwards = lactate(); backwards.points[2].at = '1';
  assert.deepEqual(codes(backwards), ['time_order']);
  // A category scale keeps typed times unused; switching back loses nothing.
  const evenly = lactate(); evenly.scale = 'category'; assert.deepEqual(codes(evenly), []);
  const ragged = lactate(); ragged.series[0].values.pop(); assert.deepEqual(codes(ragged), ['trend_shape']);
  const extra = lactate(); extra.series[0].normal_range = '0.5-2'; assert.deepEqual(codes(extra), ['unknown_key']);
  const blank = lactate(); blank.series[0].values = ['', '', '', '']; assert.deepEqual(codes(blank), ['empty_series']);
  const unlabelled = lactate(); unlabelled.y_label = ''; assert.deepEqual(codes(unlabelled), ['required']);
});

test('[AS-164] the chart draws only authored values: exact text, gaps unbridged, out-of-axis undrawn, axis ends labelled by the author', () => {
  const block = lactate(), root = planOf(block);
  const words = texts(root);
  // The authored strings appear exactly; no computed tick, mean or range is invented.
  for (const value of ['4.80', '3.9', '2.0', '0', '6.0', 'Lactate (mmol/L)', 'Time since arrival (h)', 'Arrival', '8 h']) assert.ok(words.includes(value), value);
  assert.ok(!words.some(word => /^(?:1\.5|3|4\.5)$/.test(word)), 'no computed graduations');
  // A blank reading breaks the line: two runs, never one bridged line.
  const lines = find(root, node => node.tag === 'polyline');
  assert.deepEqual(lines.map(node => node.svg.points.split(' ').length), [2]);
  assert.equal(find(root, node => node.tag === 'circle').length, 3);
  // Time spacing is proportional to the authored times (0, 2, 8 → 0, 1/4, 1 of the drawing width).
  const xs = find(root, node => node.tag === 'circle').map(node => node.svg.cx);
  assert.ok(Math.abs((xs[1] - xs[0]) / (xs[2] - xs[0]) - 0.25) < 1e-9);
  const high = lactate(); high.series[0].values[3] = '9';
  assert.equal(find(planOf(high), node => node.tag === 'circle').length, 2, 'an out-of-axis value is not drawn or clipped');
  // Points only: no line at all.
  const dots = lactate(); dots.style = 'points'; assert.equal(find(planOf(dots), node => node.tag === 'polyline').length, 0);
  // The same values as a table: hidden visually on a fixed slide, shown on a phone.
  const table = root => find(root, node => node.tag === 'table')[0];
  assert.equal(table(root).cls, 'slide-trend-data sr-only');
  assert.equal(table(planOf(block, 'reflow')).cls, 'slide-trend-data');
  assert.deepEqual(texts(find(table(root), node => node.tag === 'tbody')[0]), ['Arrival', '4.80', '2 h', '3.9', '4 h', '', '8 h', '2.0']);
});

test('[AS-164] the SVG is built with allowlisted elements and attributes; labels are text nodes', () => {
  const made = [];
  const element = (ns, tag) => { const node = { ns, tag, attrs: {}, children: [], style: {}, setAttribute(name, value) { this.attrs[name] = value; }, append(child) { this.children.push(child); } }; made.push(node); return node; };
  const doc = { createElement: tag => element(null, tag), createElementNS: (ns, tag) => element(ns, tag), createTextNode: data => ({ data }) };
  const block = lactate(); block.series[0].label = '<img src=x onerror=alert(1)>';
  block.series.push({ id: uuidv7(), label: 'MAP', values: ['55', '60', '64', '66'] }); block.y_max = '70';
  buildSlide(doc, { root: planOf(block) });
  const svg = made.filter(node => node.ns === 'http://www.w3.org/2000/svg');
  assert.ok(svg.length > 10);
  assert.deepEqual([...new Set(svg.map(node => node.tag))].sort(), ['circle', 'line', 'polygon', 'polyline', 'svg', 'text']);
  for (const node of svg) for (const name of Object.keys(node.attrs)) assert.match(name, /^(?:class|viewBox|aria-hidden|focusable|x|y|x1|y1|x2|y2|points|cx|cy|r|text-anchor)$/);
  // The hostile label stays inert text in the legend and the table.
  assert.ok(made.some(node => node.children.some(child => child.data === '<img src=x onerror=alert(1)>')));
  assert.ok(!made.some(node => node.tag === 'img'));
  // A planted node outside the allowlists is refused.
  assert.throws(() => buildSlide(doc, { root: { tag: 'svg', svg: {}, children: [{ tag: 'foreignObject', svg: {} }] } }), /slide_tag/);
  assert.throws(() => buildSlide(doc, { root: { tag: 'svg', svg: { onload: 'x' } } }), /slide_attribute/);
});

test('[AS-164] editing keeps every reading with its point; nothing is invented', () => {
  let document = slideDoc();
  const composition = start(document);
  const added = edit.addBlock(document, composition.id, 'trend', uuidv7);
  assert.equal(added.ok, true, added.reason);
  document = added.document;
  let block = document.blocks.find(item => item.id === added.blockId);
  // The starter has labels to fill but no value, axis bound or series name.
  assert.deepEqual([block.y_min, block.y_max, block.series[0].label, ...block.series[0].values], ['', '', '', '', '']);
  const step = (result, message) => { assert.equal(result.ok, true, result.reason ?? message); document = result.document; block = document.blocks.find(item => item.id === added.blockId); };
  const [p1, p2] = block.points, s1 = block.series[0];
  step(edit.setTrendValue(document, block.id, s1.id, p1.id, '4.80'));
  step(edit.setTrendValue(document, block.id, s1.id, p2.id, '3.9'));
  step(edit.addTrendPoint(document, block.id, p1.id, uuidv7));
  assert.deepEqual(block.series[0].values, ['4.80', '', '3.9']);
  step(edit.addTrendSeries(document, block.id, uuidv7));
  assert.deepEqual(block.series[1].values, ['', '', '']);
  step(edit.moveTrendPoint(document, block.id, p2.id, -1));
  assert.deepEqual(block.points.map(point => point.id).filter(id => id !== block.points[2].id), [p1.id, p2.id]);
  assert.deepEqual(block.series[0].values, ['4.80', '3.9', '']);
  // Removing a point with readings asks first; a refusal changes nothing.
  const asked = edit.removeTrendPoint(document, block.id, p1.id);
  assert.equal(asked.review, true);
  step(edit.removeTrendPoint(document, block.id, p1.id, { confirmed: true }));
  assert.deepEqual(block.series[0].values, ['3.9', '']);
  assert.equal(edit.removeTrendPoint(document, block.id, p2.id, { confirmed: true }).ok, false, 'two points stay');
  assert.equal(edit.setTrendField(document, block.id, 'scale', 'log').ok, false);
  assert.equal(edit.setTrendField(document, block.id, 'normal_range', '0.5').ok, false);
  // A duplicate gets fresh identities for every point and series.
  const copy = edit.duplicateBlock(document, composition.id, block.id, uuidv7);
  const twin = copy.document.blocks.find(item => item.id === copy.blockId);
  const ids = item => [...item.points, ...item.series].map(part => part.id);
  assert.equal(ids(twin).filter(id => ids(block).includes(id)).length, 0);
  // Source traces can point at a chart, its points and its series.
  const targets = edit.traceTargets(document).filter(target => target.label.includes('Trend chart'));
  assert.equal(targets.length, 1 + block.points.length + block.series.length);
  const result = validateBuilderDocument(document, { metadata_version: 1 }, { validateSlides: validateSlideParts });
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 3)));
});

test('[AS-164] a trend on a later step reaches no public role before its reveal, then arrives whole', () => {
  const caseDoc = slideDoc(), composition = start(caseDoc), chart = lactate();
  caseDoc.blocks.push(chart);
  composition.steps.push({ id: uuidv7(), block_ids: [chart.id] });
  composition.reading_order.push(chart.id);
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc });
  let clock = Date.parse('2026-10-15T00:00:00.000Z');
  const send = (type, extra = {}) => { clock += 1000; const result = reduce(state, { type, roundId: uuidv7(), clientEventId: uuidv7(), epoch: state.epoch, at: new Date(clock).toISOString(), actor: { role: 'facilitator', id: 'fac' }, ...extra }); state = result.state; };
  send('start');
  const steps = composition.steps.filter(item => item.block_ids.length).length;
  const sentinels = [chart.id, 'Lactate after resuscitation', '4.80', 'Time since arrival', ...chart.points.map(point => point.id), chart.series[0].id];
  for (let shown = 1; shown < steps; shown++) {
    for (const role of ['display', 'participant']) { const json = JSON.stringify(project(state, role)); for (const sentinel of sentinels) assert.ok(!json.includes(sentinel), `${role} step ${shown} leaked ${sentinel}`); }
    send('advance', { expectRevision: state.revision });
  }
  for (const role of ['display', 'participant']) {
    const view = project(state, role), slide = role === 'display' ? view.surface.slide : view.liveSurface.slide;
    const released = slide.blocks.find(block => block.id === chart.id);
    assert.deepEqual(released, chart, `${role} receives the whole chart, exactly as authored`);
  }
});

test('[AS-164] point labels stay inside the chart and never overprint; every label stays in the table (Builder round 31 P1-1)', async () => {
  const { trendChart } = await import('../src/client/slide-trend-render.mjs');
  const labels = ['Cefazolin given', 'Adrenaline IM', 'Second adrenaline', 'Fluids running', 'Hydrocortisone', 'Salbutamol neb', 'Glucagon given', 'Transfer to ICU'];
  const block = labels => ({ ...lactate(), scale: 'category', points: labels.map(label => ({ id: uuidv7(), label, at: '' })), series: [{ id: uuidv7(), label: 'HR', values: labels.map(() => '2.0') }] });
  // Half a slide's width, eight rows tall: W = 101.5 × 6 − 39, B = 55 × 8 − 50 − 60 (D27's slide-pixel drawing).
  const W = 101.5 * 6 - 39, B = 55 * 8 - 110;
  const drawn = chart => chart[0].children.filter(item => item.tag === 'text' && item.svg.y === B + 26).map(item => ({ text: item.children[0].text, x: item.svg.x }));
  const crowded = trendChart(block(labels), 'grid', '3 / 1 / span 8 / span 6'), shown = drawn(crowded);
  // About 11 units a character at 20: each drawn label's span is inside the chart and clear of the next.
  const spans = shown.map(({ text, x }) => [x - text.length * 5.5, x + text.length * 5.5]);
  assert.ok(spans.every(([left, right]) => left >= 0 && right <= W), JSON.stringify(spans));
  assert.ok(spans.every(([left], index) => !index || left >= spans[index - 1][1]), JSON.stringify(spans));
  assert.ok(shown.length >= 2 && shown.length < labels.length, `${shown.length} of ${labels.length} drawn`);
  // Nothing is lost: the table beneath names every point.
  const table = crowded.find(item => item.tag === 'table'), rows = table.children.find(item => item.tag === 'tbody').children;
  assert.deepEqual(rows.map(row => row.children[0].children[0].text), labels);
  // Short labels are all drawn, each over its own point.
  assert.equal(drawn(trendChart(block(['0', '1', '2', '3']), 'grid', '3 / 1 / span 8 / span 6')).length, 4);
});
