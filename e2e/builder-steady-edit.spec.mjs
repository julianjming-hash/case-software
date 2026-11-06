// CASE-249 (Julian, 2026-10-14): selecting a block to edit it must not move or rescale anything. The edit surface is
// the rendered block (same font size, line height, inset and fit); editing chrome sits outside the block or over it.
// Each block's box and its first line's text box are measured before selection, after selection and after typing, at
// 1440 × 900 and 1280 × 720, light and dark. A block shared by two slides is selected straight after arriving on its
// smaller slide, before the slide's own fit pass, which is how the fit of the other slide used to leak in.
import { test, expect } from '@playwright/test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { start, stop, divingSlides, openBuilder, slide } from '../tests/design-critique/harness.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start);
test.afterAll(stop);

const para = (text, style = 'p') => ({ style, runs: [{ text }] });
const block = id => `.builder-slide .slide-canvas > .slide-block[data-block-id="${id}"]`;

/** The diving slides with Julian's three cases: a Day/Event table, a filled Symptoms text block shared by two slides,
 *  a captioned table and the decision's question block. */
async function steadyDraft() {
  const pair = await divingSlides(), document = pair.document, kind = id => document.blocks.find(item => item.id === id)?.type;
  // Stage slides (the Outline lists them): A has the decision's question; B and C are a heading over one text body.
  const stages = document.compositions.filter(item => item.owner.kind === 'beat'), a = stages[0];
  const [b, c, d] = stages.filter(item => item.placements.length === 2 && kind(item.placements[1].block_id) === 'text');
  const meta = pair.authoringMetadata, retire = id => { meta.provenance = meta.provenance.filter(item => item.entity_id !== id); };
  const columns = () => [{ id: uuidv7(), label: 'Day', width: 1, align: 'start' }, { id: uuidv7(), label: 'Event', width: 3, align: 'start' }];
  const rows = () => [['Days 0–3', 'Six air dives over four days, to about 18 m'], ['Day 5', 'Flies home. Symptoms worsen.'], ['Day 6', 'Referred to your ED']].map(cells => ({ id: uuidv7(), cells }));
  // Slide A: the 8 × 8 text block becomes the table without a caption, beside the decision's question block.
  const table = document.blocks.find(item => item.id === a.placements[1].block_id); retire(table.id);
  for (const key of Object.keys(table)) if (key !== 'id') delete table[key];
  Object.assign(table, { type: 'table', header_row: true, first_column_header: false, columns: columns(), rows: rows() });
  // Slide B: its body becomes the filled Symptoms block on the right, with a captioned table on the left.
  const symptoms = document.blocks.find(item => item.id === b.placements[1].block_id); retire(symptoms.id);
  symptoms.paragraphs = [para('Symptoms', 'h3'), ...['Neck and shoulder pain', 'Right calf pain', 'Red eyes', 'Dizzy on standing since the flight', 'Tingling in both hands'].map(text => para(text))];
  Object.assign(b.placements[1], { col: 9, row: 3, w: 4, h: 5 });
  b.styles = [...(b.styles ?? []).filter(item => item.block_id !== symptoms.id), { block_id: symptoms.id, tone: 'blue' }];
  const captioned = { id: uuidv7(), type: 'table', caption: 'Dive log', header_row: true, first_column_header: false, columns: columns(), rows: rows() };
  document.blocks.push(captioned); b.reading_order.push(captioned.id); b.steps[0].block_ids.push(captioned.id);
  b.placements.push({ block_id: captioned.id, col: 1, row: 3, w: 8, h: 8 });
  // Slide C shares the Symptoms block in a much wider area, so its fit there differs from slide B's.
  const replaced = c.placements[1].block_id;
  for (const list of [c.reading_order, ...c.steps.map(step => step.block_ids)]) { const at = list.indexOf(replaced); if (at >= 0) list[at] = symptoms.id; }
  c.placements[1].block_id = symptoms.id; c.styles = (c.styles ?? []).filter(item => item.block_id !== replaced);
  document.blocks = document.blocks.filter(item => item.id !== replaced); retire(replaced);
  // Slide D (CASE-251, the eighth critique): a quote, a callout, values and a timeline, each drawn in its own wrapper.
  const quote = document.blocks.find(item => item.id === d.placements[1].block_id); retire(quote.id);
  for (const key of Object.keys(quote)) if (key !== 'id') delete quote[key];
  const plain = text => ({ runs: [{ text }] }), top = d.placements[0].row + d.placements[0].h, half = Math.floor((13 - top) / 2);
  Object.assign(quote, { type: 'quote', paragraphs: [plain('Felt fine on the boat, then the shoulders ached on the drive home.')] });
  Object.assign(d.placements[1], { col: 1, row: top, w: 6, h: half });
  const extra = [
    [{ id: uuidv7(), type: 'callout', paragraphs: [plain('Ask about the dive profile and the flight home.')] }, { col: 7, row: top, w: 6, h: half }],
    [{ id: uuidv7(), type: 'values', rows: [['Heart rate', '104', 'bpm'], ['SpO₂', '95', '%'], ['Temperature', '37.4', '°C']].map(([label, value, unit]) => ({ id: uuidv7(), label, value, unit })) }, { col: 1, row: top + half, w: 6, h: 13 - top - half }],
    [{ id: uuidv7(), type: 'timeline', entries: [['Day 0', 'Six air dives to 18 m'], ['Day 5', 'Flies home'], ['Day 6', 'Referred to your ED']].map(([label, text]) => ({ id: uuidv7(), label, text })) }, { col: 7, row: top + half, w: 6, h: 13 - top - half }],
  ];
  for (const [item, place] of extra) { document.blocks.push(item); d.reading_order.push(item.id); d.steps[0].block_ids.push(item.id); d.placements.push({ block_id: item.id, ...place }); }
  // Each stage gets a name no other stage contains, so the Outline finds it.
  // Slide B's long name fills the canvas head, where the text tools used to wrap to a second row.
  for (const [composition, title] of [[a, 'Steady A'], [b, 'Steady B · results after commitment and a parallel assessment'], [c, 'Steady C'], [d, 'Steady D']]) {
    const heading = document.blocks.find(item => item.id === composition.placements[0].block_id); retire(heading.id);
    heading.paragraphs = [para(title, 'h1')]; document.beats.find(item => item.id === composition.owner.id).title = title;
  }
  const checked = validateBuilderDocument(document, meta, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors.slice(0, 3)));
  return { pair, ids: { quote: quote.id, callout: extra[0][0].id, values: extra[1][0].id, timeline: extra[2][0].id, table: table.id, symptoms: symptoms.id, captioned: captioned.id, question: a.placements.find(item => document.blocks.find(x => x.id === item.block_id).type === 'question').block_id } };
}

/** A block's border box, and the content box, font size and line height of the first thing it reads (a text node's
 *  block-level parent, or the field that edits it). Editing chrome is not content. */
const measure = (page, id) => page.evaluate(selector => {
  const node = document.querySelector(selector);
  if (!node) return null;
  const chrome = '.builder-reveal-badge, .builder-shared-note, .builder-block-handle, .builder-block-resize, .builder-slide-edit, .builder-slide-kicker, .builder-limit-meter, .builder-col-ruler';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: item => {
    if ((item.nodeType === 1 ? item : item.parentElement).closest(chrome)) return NodeFilter.FILTER_REJECT;
    if (item.nodeType === 1) return item.matches('textarea, input') && item.value.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    return item.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
  } });
  const first = walker.nextNode();
  let holder = first?.nodeType === 1 ? first : first?.parentElement;
  while (holder && holder !== node && getComputedStyle(holder).display.startsWith('inline') && !holder.matches('textarea, input')) holder = holder.parentElement;
  const head = document.querySelector('.builder-canvas-head').getBoundingClientRect().height;
  const box = node.getBoundingClientRect(), at = holder?.getBoundingClientRect(), style = holder && getComputedStyle(holder);
  const px = value => parseFloat(value) || 0;
  return {
    box: { x: box.x, y: box.y, w: box.width, h: box.height }, head,
    line: holder && { x: at.x + px(style.borderLeftWidth) + px(style.paddingLeft), y: at.y + px(style.borderTopWidth) + px(style.paddingTop) - (holder.scrollTop || 0),
      text: (first.nodeType === 1 ? first.value : first.data).trim().slice(0, 24), size: (first.nodeType === 1 ? style : getComputedStyle(first.parentElement)).fontSize, height: style.lineHeight },
  };
}, block(id));

function same(label, before, after) {
  const off = (a, b) => Math.abs(a - b);
  expect(after?.line, `${label}: block still drawn`).toBeTruthy();
  // Soft, so one run lists every drift of every block.
  for (const key of ['x', 'y', 'w', 'h']) expect.soft(off(before.box[key], after.box[key]), `${label}: block ${key} ${before.box[key]} → ${after.box[key]}`).toBeLessThanOrEqual(1);
  expect.soft(off(before.head, after.head), `${label}: canvas head height ${before.head} → ${after.head}`).toBeLessThanOrEqual(1);
  expect.soft(after.line?.text, `${label}: same first line`).toBe(before.line.text);
  for (const key of ['x', 'y']) expect.soft(off(before.line[key], after.line[key]), `${label}: first line ${key} ${before.line[key]} → ${after.line[key]}`).toBeLessThanOrEqual(1);
  expect.soft(after.line.size, `${label}: font size`).toBe(before.line.size);
  expect.soft(after.line.height, `${label}: line height`).toBe(before.line.height);
}

/** Open a stage's slide from the Outline by the stage's name, as an author does. */
async function showSlide(page, stage, { settle = true } = {}) {
  await page.locator('.builder-outline-target:visible').filter({ hasText: stage }).first().click();
  await expect(slide(page)).toBeVisible();
  if (settle) await page.waitForTimeout(900);
}

/** Select by a click on the block's first line, as an author does, then type one space at the end of that field. */
async function selectAndType(page, id, label, settled = null, { converts = false } = {}) {
  const before = settled ?? await measure(page, id);
  expect(before?.line, `${label}: drawn`).toBeTruthy();
  await page.mouse.click(before.line.x + 2, before.line.y + 4);
  await expect(page.locator(`${block(id)}[data-selected]`)).toBeVisible();
  await page.waitForTimeout(500); // past the 400 ms fit pass, so a late re-measure counts
  same(`${label} selected`, before, await measure(page, id));
  await page.keyboard.type(' '); // at the click point (End scrolls the page on macOS)
  await page.waitForTimeout(500);
  if (converts) {
    // CASE-344: a quote becomes a Plain callout with the quote icon on its author's first edit, so it is drawn anew
    // once, on that key; from then on it must stay as steady as any other block.
    const converted = await measure(page, id);
    await page.keyboard.type(' '); await page.waitForTimeout(500);
    same(`${label} typed again`, converted, await measure(page, id));
    await page.keyboard.press('Backspace');
  } else same(`${label} typed`, before, await measure(page, id));
  // Let go with a click on empty slide space.
  await page.keyboard.press('Backspace');
  const canvas = await slide(page).locator('.slide-canvas').boundingBox(); await page.mouse.click(canvas.x + 4, canvas.y + 4);
  await expect.soft(page.locator(`${block(id)}[data-selected]`)).toHaveCount(0);
  await page.waitForTimeout(500);
}

for (const [width, height] of [[1440, 900], [1280, 720]]) {
  test(`[AS-153] selecting and typing never moves or rescales a block, ${width} × ${height}, light and dark`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    const { pair, ids } = await steadyDraft();
    await openBuilder(page, pair); await page.waitForTimeout(1200);
    for (const scheme of ['light', 'dark']) await test.step(scheme, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      await showSlide(page, 'Steady A');
      await selectAndType(page, ids.table, `${scheme}: table without caption`);
      await selectAndType(page, ids.question, `${scheme}: question`);
      // The shared block as slide B settles it; then back from slide C, where it is wider, and selected at once, before
      // slide B's own fit pass: it must come back at slide B's size, not slide C's.
      await showSlide(page, 'Steady B');
      const settled = await measure(page, ids.symptoms);
      await showSlide(page, 'Steady C');
      expect((await measure(page, ids.symptoms)).line.size, 'the shared block fits slide C at another size').not.toBe(settled.line.size);
      await showSlide(page, 'Steady B', { settle: false });
      same(`${scheme}: shared filled text on return`, settled, await measure(page, ids.symptoms));
      await selectAndType(page, ids.symptoms, `${scheme}: shared filled text`, settled);
      await selectAndType(page, ids.captioned, `${scheme}: table with caption`);
      // Select the actual consequence owner, not a matching thumbnail or the long Steady B stage title.
      const pathId='01a11de6-71d8-7116-9441-2795b2c701c6';
      const decision=pair.document.decisions.find(row=>row.paths.some(path=>path.id===pathId));
      const path=decision.paths.find(row=>row.id===pathId),owner=pair.document.beats.find(row=>row.decision_id===decision.id);
      const consequence=page.locator(`.builder-outline-target[data-outline-key="path:${owner.id}:${pathId}"]`);
      if(!(await consequence.isVisible()))await page.locator(`button[data-outline-key="chip:${owner.id}"]`).click();
      await consequence.click();await page.waitForTimeout(900);
      await expect(page.locator('.builder-canvas-head')).toContainText(owner.title);
      await expect(page.locator('.builder-canvas-head')).toContainText(path.label);
      const body = await slide(page).locator('.slide-canvas > .slide-block').nth(1).getAttribute('data-block-id');
      await selectAndType(page, body, `${scheme}: consequence text`);
      // CASE-251: a quote and a callout keep their drawn indent, padding and fill; values and timeline are edited as drawn.
      await showSlide(page, 'Steady D');
      for (const name of ['quote', 'callout', 'values', 'timeline']) await selectAndType(page, ids[name], `${scheme}: ${name}`, null, { converts: name === 'quote' && scheme === 'light' });
    });
  });
}

test('[AS-153] values and timeline are written where the slide draws them; add, move and unit are in the Block tab (CASE-251)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { pair, ids } = await steadyDraft();
  const state = await openBuilder(page, pair); await page.waitForTimeout(800);
  await showSlide(page, 'Steady D');
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true }), field = name => slide(page).getByRole('textbox', { name, exact: true });
  // A click on a drawn value leaves the caret in that value; Enter adds no line.
  await page.locator(block(ids.values)).locator('dd').first().click({ position: { x: 6, y: 8 } });
  await expect(field('Value, row 1')).toBeFocused();
  await page.keyboard.type('5'); await page.keyboard.press('Enter');
  await expect(field('Value, row 1')).toHaveText(/^\d{4}$/);
  await expect(tools).toContainText('Row 1');
  await tools.getByLabel('Unit', { exact: true }).fill('beats/min'); await tools.getByLabel('Unit', { exact: true }).press('Tab');
  await expect(field('Unit, row 1')).toHaveText('beats/min');
  await tools.getByRole('button', { name: 'Add row below', exact: true }).click();
  await expect(field('Label, row 2')).toHaveText('');
  await field('Label, row 2').click(); await page.keyboard.type('Resp rate');
  await expect(tools).toContainText('Row 2');
  await tools.getByRole('button', { name: 'Move row down', exact: true }).click();
  await expect(field('Label, row 3')).toHaveText('Resp rate');
  // The timeline's rows, the same way: a click on an event, then Move row up.
  await page.locator(block(ids.timeline)).getByText('Flies home', { exact: true }).click();
  await expect(field('Event, row 2')).toBeFocused();
  await expect(tools).toContainText('Row 2');
  await tools.getByRole('button', { name: 'Move row up', exact: true }).click();
  await expect(field('Event, row 1')).toHaveText('Flies home');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect.poll(() => state.puts).toBe(1);
  const saved = id => state.pair.document.blocks.find(item => item.id === id);
  expect(saved(ids.values).rows.map(row => [row.label, row.unit])).toEqual([['Heart rate', 'beats/min'], ['SpO₂', '%'], ['Resp rate', ''], ['Temperature', '°C']]);
  expect(saved(ids.values).rows[0].value).toMatch(/^\d{4}$/);
  expect(saved(ids.timeline).entries.map(entry => entry.text)).toEqual(['Flies home', 'Six air dives to 18 m', 'Referred to your ED']);
});

for (const [width, height] of [[1440, 900], [1280, 720]]) test(`[AS-153] the Stage name's focus ring is drawn whole in the canvas head, ${width} × ${height} (CASE-251)`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await openBuilder(page, await divingSlides()); await page.waitForTimeout(800);
  const name = page.getByLabel('Slide title', { exact: true });
  await name.focus();
  // The ring (outline width plus offset around the field) must lie inside every ancestor that clips.
  const clipped = await name.evaluate(input => {
    const style = getComputedStyle(input), grow = (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0), box = input.getBoundingClientRect();
    const ring = { left: box.left - grow, right: box.right + grow, top: box.top - grow, bottom: box.bottom + grow }, cut = [];
    for (let node = input.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const clip = node.getBoundingClientRect();
      if (ring.left < clip.left - .5 || ring.right > clip.right + .5 || ring.top < clip.top - .5 || ring.bottom > clip.bottom + .5) cut.push(node.className);
    }
    return { cut, outline: style.outlineStyle };
  });
  expect(clipped.outline).not.toBe('none');
  expect(clipped.cut, 'no ancestor clips the ring').toEqual([]);
});

test('[AS-153] the Outline tile draws a quote with its words on lines and a callout with its fill (CASE-251)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, (await steadyDraft()).pair); await page.waitForTimeout(800);
  const tile = page.locator('.builder-outline-target:visible').filter({ hasText: 'Steady D' }).first().locator('.builder-thumb');
  const drawn = await tile.evaluate(thumb => {
    const q = thumb.querySelector('.slide-quote'), quoteBox = q.getBoundingClientRect(), text = q.querySelector('blockquote').getBoundingClientRect();
    return { share: text.width / quoteBox.width, fill: getComputedStyle(thumb.querySelector('.slide-callout aside')).backgroundColor };
  });
  expect(drawn.share, 'the quote keeps most of its block for words').toBeGreaterThan(.6);
  expect(drawn.fill).not.toBe('rgba(0, 0, 0, 0)');
});

test('[AS-153] on a one-row block the Move and Resize grips never overlap, on hover or selected (CASE-251)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { pair, ids } = await steadyDraft();
  const d = pair.document.compositions.find(item => item.placements.some(placement => placement.block_id === ids.callout));
  Object.assign(d.placements.find(placement => placement.block_id === ids.callout), { h: 1 });
  await openBuilder(page, pair); await page.waitForTimeout(800);
  await showSlide(page, 'Steady D');
  const node = page.locator(block(ids.callout));
  const apart = async state => {
    const [move, size] = await Promise.all([node.locator('.builder-block-handle').boundingBox(), node.locator('.builder-block-resize').boundingBox()]);
    const overlap = Math.max(0, Math.min(move.x + move.width, size.x + size.width) - Math.max(move.x, size.x)) * Math.max(0, Math.min(move.y + move.height, size.y + size.height) - Math.max(move.y, size.y));
    expect(overlap, `${state}: grips overlap by ${overlap} px²`).toBe(0);
  };
  await node.hover(); await apart('hover');
  await node.click(); await expect(page.locator(`${block(ids.callout)}[data-selected]`)).toBeVisible(); await apart('selected');
});
