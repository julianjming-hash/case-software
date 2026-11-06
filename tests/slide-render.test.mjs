import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slidePlan, buildSlide } from '../src/client/slide-render.mjs';
import { CALLOUT_TONES } from '../src/shared/slide-document.mjs';

const id = name => `00000000-0000-7000-8000-${name.padStart(12, '0')}`;
const heading = { id: id('1'), type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: 'Staged evidence' }] }, { style: 'h4', runs: [{ text: 'Detail' }] }, { style: 'p', runs: [{ text: 'Body ', bold: true }, { text: '<img src=x onerror=alert(1)>' }] }] };
const values = { id: id('2'), type: 'values', rows: [{ id: id('21'), label: 'Na', value: '0128', unit: 'mmol/L' }, { id: id('22'), label: 'Note', value: '<5', unit: '' }] };
const table = { id: id('3'), type: 'table', caption: 'Observations', header_row: true, first_column_header: true,
  columns: [{ id: id('31'), label: 'Time', width: 1, align: 'start' }, { id: id('32'), label: 'HR', width: 1, align: 'end' }, { id: id('33'), label: 'SpO₂', width: 1, align: 'end', unit: '%' }],
  rows: [{ id: id('34'), cells: ['00:00', '', '91'] }, { id: id('35'), cells: ['00:05', '+12', ''] }] };
const composition = { id: id('9'), owner: { kind: 'beat', id: id('8') }, template: 'bento',
  // Placement puts the table first visually; reading order still starts with the heading.
  placements: [{ block_id: table.id, col: 1, row: 1, w: 8, h: 12 }, { block_id: heading.id, col: 9, row: 1, w: 4, h: 4 }, { block_id: values.id, col: 9, row: 5, w: 4, h: 8 }],
  reading_order: [heading.id, values.id, table.id], steps: [{ id: id('91'), block_ids: [heading.id, values.id, table.id] }], styles: [] };
const texts = node => Object.hasOwn(node, 'text') ? [node.text] : (node.children ?? []).flatMap(texts);
const find = (node, predicate) => predicate(node) ? [node] : (node.children ?? []).flatMap(child => find(child, predicate));

test('[AS-137] slide DOM order is the authored reading order; grid areas only position blocks', () => {
  const { root, unplaced } = slidePlan({ blocks: [table, heading, values], composition });
  assert.deepEqual(root.children.map(child => child.cls.split(' ')[1]), ['slide-text', 'slide-values', 'slide-table']);
  assert.deepEqual(root.children.map(child => child.area), ['1 / 9 / span 4 / span 4', '5 / 9 / span 8 / span 4', '1 / 1 / span 12 / span 8']);
  assert.deepEqual(unplaced, []);
  assert.equal(root.attrs['aria-label'], 'Staged evidence');
});

test('[AS-137] only released blocks render: no node, placement or accessible name for a withheld block', () => {
  const { root } = slidePlan({ blocks: [values], composition });
  assert.equal(root.children.length, 1);
  assert.equal(root.attrs['aria-label'], 'Slide');
  assert.ok(!texts(root).some(value => /Staged evidence|Observations|Time/.test(value)));
});

test('[AS-137] headings keep their level relative to the host and text stays text, never markup', () => {
  const { root } = slidePlan({ blocks: [heading], composition: { ...composition, reading_order: [heading.id] } }, { headingBase: 2 });
  assert.deepEqual(find(root, item => /^h\d$/.test(item.tag ?? '')).map(item => item.tag), ['h2', 'h5']);
  assert.ok(texts(root).includes('<img src=x onerror=alert(1)>'));
  assert.equal(find(root, item => item.tag === 'strong')[0].children[0].text, 'Body ');
});

test('[AS-138] tables keep caption, scoped headers, exact cells and units; narrow reflow keeps every cell as a labelled card', () => {
  const grid = slidePlan({ blocks: [table], composition: { ...composition, reading_order: [table.id] } }).root;
  assert.deepEqual(find(grid, item => item.tag === 'th').map(item => item.attrs?.scope), ['col', 'col', 'col', 'row', 'row']);
  assert.deepEqual(find(grid, item => item.tag === 'caption').flatMap(texts), ['Observations']);
  assert.deepEqual(find(grid, item => item.tag === 'tbody').flatMap(texts), ['00:00', '', '91', '%', '00:05', '+12', '']);
  const reflow = slidePlan({ blocks: [table], composition: { ...composition, reading_order: [table.id] } }, { layout: 'reflow' }).root;
  const cards = find(reflow, item => item.cls === 'slide-table-card');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(texts), [['00:00', 'HR', '', 'SpO₂', '91', '%'], ['00:05', 'HR', '+12', 'SpO₂', '']]);
  assert.equal(reflow.children[0].area, null);
  // Header semantics off: safe generic labels, and no hidden header text is ever rendered.
  const plain = { ...table, header_row: false, first_column_header: false, columns: table.columns.map(column => ({ ...column, label: '' })) };
  const plainCards = find(slidePlan({ blocks: [plain], composition: { ...composition, reading_order: [plain.id] } }, { layout: 'reflow' }).root, item => item.cls === 'slide-table-card');
  assert.deepEqual(plainCards[0].children.flatMap(texts), ['Column 1', '00:00', 'Column 2', '', 'Column 3', '91', '%']);
  assert.equal(find(slidePlan({ blocks: [plain], composition: { ...composition, reading_order: [plain.id] } }).root, item => item.tag === 'thead').length, 0);
});

test('[AS-138] values keep exact text: leading zeros, inequalities and empty units are not parsed or invented', () => {
  const { root } = slidePlan({ blocks: [values], composition: { ...composition, reading_order: [values.id] } });
  assert.deepEqual(texts(root), ['Na', '0128', 'mmol/L', 'Note', '<5']);
});

test('[AS-138] the DOM builder refuses anything outside its allowlist and every tone maps to an existing token', () => {
  const made = [];
  const fake = { createTextNode: value => ({ text: value }), createElement: tag => { const element = { tag, style: {}, children: [], attrs: {}, append(child) { this.children.push(child); }, setAttribute(name, value) { this.attrs[name] = value; } }; made.push(element); return element; } };
  const plan = slidePlan({ blocks: [heading, values, table], composition });
  const { root } = buildSlide(fake, plan);
  assert.equal(root.attrs['aria-label'], 'Staged evidence');
  assert.ok(made.every(element => !('innerHTML' in element)));
  assert.throws(() => buildSlide(fake, { root: { tag: 'script', children: [] } }), /slide_tag/);
  assert.throws(() => buildSlide(fake, { root: { tag: 'div', attrs: { onclick: 'x' }, children: [] } }), /slide_attribute/);
  assert.throws(() => buildSlide(fake, { root: { tag: 'div', cls: 'x" onload="y', children: [] } }), /slide_class/);
  // Tone names resolve only to existing canonical tokens (BWR20); never stored.
  for (const [tone, token] of Object.entries(CALLOUT_TONES)) assert.ok(token === null || /^--(mark-[a-z]+|quiet)$/.test(token), tone);
});

test('[AS-137] the slide never claims the page h1, whatever heading base a caller passes', () => {
  for (const headingBase of [1, 0, -3, 2.5]) {
    const { root } = slidePlan({ blocks: [heading], composition: { ...composition, reading_order: [heading.id] } }, { headingBase });
    assert.equal(find(root, item => /^h\d$/.test(item.tag ?? ''))[0].tag, 'h2', String(headingBase));
  }
});

test('[AS-157] a phone card that already shows the title drops only a leading block that repeats it, and keeps the region name', () => {
  const title = { id: 't', type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: 'Referred diagnosis' }] }] };
  const body = { id: 'b', type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'Referred diagnosis' }] }] };
  const slide = { blocks: [title, body], composition: { reading_order: ['t', 'b'], placements: [], styles: [] } };
  const dropped = slidePlan(slide, { layout: 'reflow', repeats: ' Referred diagnosis ' });
  assert.equal(dropped.root.children.length, 1);
  assert.equal(dropped.root.attrs['aria-label'], 'Referred diagnosis');
  // A different heading, a body paragraph with the same words, or no host title: nothing is dropped.
  assert.equal(slidePlan(slide, { layout: 'reflow', repeats: 'Another title' }).root.children.length, 2);
  assert.equal(slidePlan({ ...slide, composition: { ...slide.composition, reading_order: ['b', 't'] } }, { layout: 'reflow', repeats: 'Referred diagnosis' }).root.children.length, 2);
  assert.equal(slidePlan(slide, { layout: 'reflow' }).root.children.length, 2);
  // The projector passes no host title and always shows the block.
  assert.equal(slidePlan(slide, { layout: 'reflow', repeats: '' }).root.children.length, 2);
});

test('[AS-159] subscript and superscript render as sub and sup (inside bold), and a text colour is a palette class on a plain ground', () => {
  const block = { id: 'f', type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'PaO' }, { text: '2', script: 'sub' }, { text: ' 10' }, { text: '-3', script: 'sup', bold: true }] }] };
  const plan = slidePlan({ blocks: [block], composition: { reading_order: ['f'], placements: [{ block_id: 'f', col: 1, row: 1, w: 12, h: 12 }], styles: [{ block_id: 'f', ink: 'teal', tone: 'amber' }] } });
  const node = plan.root.children[0];
  assert.match(node.cls, /\bslide-tone-amber\b/);
  // CASE-244: a text colour shows only on a plain ground; on a fill, banded rows or a callout the text stays plain.
  assert.doesNotMatch(node.cls, /\bslide-ink-/);
  const inkOn = (style, type = 'text') => slidePlan({ blocks: [{ ...block, type }], composition: { reading_order: ['f'], placements: [{ block_id: 'f', col: 1, row: 1, w: 12, h: 12 }], styles: [{ block_id: 'f', ink: 'teal', ...style }] } }).root.children[0].cls;
  assert.match(inkOn({}), /\bslide-ink-teal\b/); assert.match(inkOn({ tone: 'plain' }), /\bslide-ink-teal\b/); assert.match(inkOn({ background: 'outline' }), /\bslide-ink-teal\b/);
  for (const style of [{ tone: 'soft' }, { background: 'soft' }, { banded: true }]) assert.doesNotMatch(inkOn(style), /\bslide-ink-/, JSON.stringify(style));
  assert.doesNotMatch(inkOn({}, 'callout'), /\bslide-ink-/);
  const runs = node.children[0].children;
  assert.deepEqual(runs.map(run => run.tag ?? 'text'), ['text', 'sub', 'text', 'strong']);
  assert.equal(runs[3].children[0].tag, 'sup');
  // The allowlisted DOM builder accepts them; text stays text.
  assert.doesNotThrow(() => buildSlide({ createElement: tag => ({ tag, children: [], append(...items) { this.children.push(...items); }, setAttribute() {}, set className(value) { this.cls = value; }, style: {} }),
    createTextNode: text => ({ text }) }, plan));
});

test('[AS-137] D6/D11: a timeline entry reads its label and text as two words, not "Day 5Flies home."', () => {
  const timeline = { id: id('4'), type: 'timeline', entries: [{ id: id('41'), label: 'Day 5', text: 'Flies home.' }] };
  const only = { ...composition, placements: [{ block_id: timeline.id, col: 1, row: 1, w: 12, h: 12 }], reading_order: [timeline.id], steps: [{ id: id('91'), block_ids: [timeline.id] }] };
  const [entry] = find(slidePlan({ blocks: [timeline], composition: only }).root, node => node.tag === 'li');
  assert.equal(texts(entry).join(''), 'Day 5 Flies home.');
});
