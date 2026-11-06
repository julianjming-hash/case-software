// CASE-344 B3, [AS-220]: every optional field of a schema-3 draft can be edited or cleared through the Builder. The fixture
// (tests/helpers/builder-everything-fixture.mjs) carries one of each; for each field this spec drives the control a person
// would use, saves, and asserts the saved draft changed at that field. The last test fails if a field of the fixture has no
// entry here, so a new optional field cannot ship without a control. Local workerd and fakes only (hard rule 12).
import { test, expect } from '@playwright/test';
import { startServers, openEditor, inspectorOf, slideOf } from '../tests/helpers/builder-simplify-fixture.mjs';
import { everythingPair, fieldPatterns, REACH_FIELDS } from '../tests/helpers/builder-everything-fixture.mjs';

test.use({ ignoreHTTPSErrors: true });
// One worker runs the file in order, so the last test can see which fields the others reached.
test.describe.configure({ mode: 'serial' });
let servers;
test.beforeAll(async () => { servers = await startServers(); });
test.afterAll(async () => { await servers?.stop(); });

const fx = everythingPair();
const reached = new Set();
const blockOf = (document, id) => document.blocks.find(block => block.id === id);
const styleOf = (slide, id, key) => document => document.compositions.find(item => item.id === slide.id).styles?.find(item => item.block_id === id)?.[key];
const compositionOf = (slide, key) => document => document.compositions.find(item => item.id === slide.id)[key];

/** Edit through the UI, save, and assert the saved draft changed at the field; `clear` then undoes it the way a person would. */
async function reach(page, state, pattern, read, edit, clear = null) {
  const saved = () => JSON.stringify(read(state.pair.document, state.pair.authoringMetadata) ?? null);
  const before = saved();
  let puts = state.puts.length;
  await edit();
  await save(page, state, puts);
  const after = saved();
  expect(after, `${pattern}: the saved draft changed`).not.toBe(before);
  if (clear) {
    puts = state.puts.length;
    await clear();
    await save(page, state, puts);
    expect(saved(), `${pattern}: clearing changed it again`).not.toBe(after);
  }
  reached.add(pattern);
}
async function save(page, state, puts) {
  // Autosave can win while a slow runner is between edit and save. Use the supported
  // keyboard command and measure receipts from before the edit, never after autosave.
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => state.puts.length).toBeGreaterThan(puts);
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
}
/** Type into a field and leave it, so both input- and change-driven controls commit. */
async function type(locator, value) { await locator.fill(value); await locator.blur(); }

/** Open the exact known fixture owner through the Outline, opening its group when needed. */
const beatForDecision = decision => fx.document.beats.find(beat=>beat.decision_id===decision.id);
async function go(page, target) {
  const owner=target.owner??{kind:'beat',id:target.id};
  const beat=owner.kind==='path'?fx.document.beats.find(beat=>fx.document.decisions.find(d=>d.id===beat.decision_id)?.paths.some(path=>path.id===owner.id)):null;
  const key=owner.kind==='path'?`path:${beat.id}:${owner.id}`:`beat:${owner.id}`;
  const tile=page.locator(`.builder-outline-list button.builder-outline-target[data-outline-key="${key}"]`);
  if (!(await tile.isVisible())) for (const group of await page.getByRole('button', { name: /^\d+ consequences? of / }).all()) { await group.click(); if (await tile.isVisible()) break; }
  await tile.click();
  await expect(slideOf(page).locator('.slide-canvas')).toBeVisible();
}

const control = (page, id, suffix) => page.locator(`[data-control-key="slide:${id}:${suffix}"]`);
const pick = async (page, id) => {
  await slideOf(page).locator(`.slide-block[data-block-id="${id}"]`).first().click();
  await expect(inspectorOf(page).locator('.builder-back-to-slide')).toBeVisible();
};
const back = page => inspectorOf(page).locator('.builder-back-to-slide').click();
/** The inspector's folded sections stay open once opened; open one by its summary. */
async function unfold(page, name) {
  const summary = inspectorOf(page).locator('summary', { hasText: name });
  if ((await summary.locator('xpath=..').getAttribute('open')) === null) await summary.click();
}
/** The Builder's dropdowns keep a native select (hidden) as their value contract; tests drive that. */
const choose = (page, id, suffix, value) => setNative(page.locator(`select[data-control-key="slide:${id}:${suffix}"]`), value);
// Set the native select and fire its change, as a person's choice does; Playwright's own selectOption races the dropdown's redraw.
const setNative = (select, value) => select.evaluate((node, next) => { node.value = next; node.dispatchEvent(new Event('change', { bubbles: true })); }, value);
const press = (page, id, suffix) => control(page, id, suffix).click();

test('[AS-220] the fixture carries every optional field, and each kind of block can be edited and cleared (callout, values, timeline, list)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const { first } = fx.slides, { callout, values, timeline, list } = fx.ids;
  await go(page, fx.slides.first);

  await pick(page, callout);
  await reach(page, state, '.blocks[]<callout>.icon', document => blockOf(document, callout).icon, () => press(page, callout, 'icon:pulse'), () => press(page, callout, 'icon:none'));
  await reach(page, state, '.compositions[].styles[].tone', styleOf(first, callout, 'tone'), () => press(page, callout, 'tone:blue'), () => press(page, callout, 'tone:plain'));

  await pick(page, values);
  const row = blockOf(fx.document, values).rows[0];
  await reach(page, state, '.blocks[]<values>.rows[].label', document => blockOf(document, values).rows[0].label, () => type(control(page, values, `${row.id}:label`), 'Saturation'));
  await reach(page, state, '.blocks[]<values>.rows[].value', document => blockOf(document, values).rows[0].value, () => type(control(page, values, `${row.id}:value`), '88'));
  await control(page, values, `${row.id}:unit`).click();
  await reach(page, state, '.blocks[]<values>.rows[].unit', document => blockOf(document, values).rows[0].unit, () => type(control(page, values, `unit-tools:${row.id}`), 'percent'));

  await pick(page, timeline);
  const entry = blockOf(fx.document, timeline).entries[0];
  await reach(page, state, '.blocks[]<timeline>.entries[].label', document => blockOf(document, timeline).entries[0].label, () => type(control(page, timeline, `${entry.id}:label`), '1 min'));
  await reach(page, state, '.blocks[]<timeline>.entries[].text', document => blockOf(document, timeline).entries[0].text, () => type(control(page, timeline, `${entry.id}:text`), 'Door'));

  await pick(page, list);
  await reach(page, state, '.blocks[]<list>.ordered', document => blockOf(document, list).ordered, () => press(page, list, 'style:bulleted'), () => press(page, list, 'style:numbered'));
});

test('[AS-220] field verification accepts an acknowledged autosave before the explicit save command', async ({ page }) => {
  const state = await openEditor(page, servers, fx);
  await go(page, fx.slides.first);
  await unfold(page, 'Layout and fill');
  const puts = state.puts.length;
  await reach(page, state, '.theme', document => document.theme, async () => {
    await page.locator('[data-control-key="slide-theme:night"]').click();
    await expect.poll(() => state.puts.length).toBeGreaterThan(puts);
    await expect(page.locator('.builder-save-state')).toHaveText('Saved');
    await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  });
  expect(state.pair.document.theme).toBe('night');
});

test('[AS-220] text formatting, block styles and the slide\'s own layout, fill, hero, theme and reading order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const { first } = fx.slides, { callout, values, timeline, list } = fx.ids;
  const more = () => unfold(page, 'More formatting');

  // Bold is a run mark: select the callout's words and toggle it on, then off again.
  await go(page, fx.slides.first);
  await slideOf(page).locator(`.slide-block[data-block-id="${callout}"]`).first().click();
  await slideOf(page).locator(`.slide-block[data-block-id="${callout}"] [contenteditable]`).first().click();
  await page.keyboard.press('ControlOrMeta+a');
  const bold = () => page.getByRole('button', { name: 'Bold selection', exact: true }).click();
  await reach(page, state, '.blocks[]<callout>.paragraphs[].runs[].bold', document => blockOf(document, callout).paragraphs.map(item => item.runs.map(run => run.bold ?? false)), bold, async () => { await page.keyboard.press('ControlOrMeta+a'); await bold(); });

  const selectCallout = async () => {
    await slideOf(page).locator(`.slide-block[data-block-id="${callout}"] [contenteditable]`).first().click();
    await page.keyboard.press('ControlOrMeta+a');
  };
  await reach(page, state, '.blocks[]<callout>.paragraphs[].runs[].script', document => blockOf(document, callout).paragraphs.map(item => item.runs.map(run => run.script ?? null)),
    async () => { await selectCallout(); await page.getByRole('button', { name: 'Superscript selection', exact: true }).click(); },
    async () => { await selectCallout(); await page.getByRole('button', { name: 'Superscript selection', exact: true }).click(); });

  // A slide fill hides block text colours (text stays plain on a fill), so the fill comes off before the colour is tried.
  await slideOf(page).locator('.slide-canvas').click({ position: { x: 3, y: 3 } });
  await unfold(page, 'Layout and fill');
  await reach(page, state, '.compositions[].fill', compositionOf(first, 'fill'), () => page.locator('[data-control-key="slide-fill:blue"]').click(), () => page.locator('[data-control-key="slide-fill:plain"]').click());
  await reach(page, state, '.theme', document => document.theme, () => page.locator('[data-control-key="slide-theme:night"]').click(), () => page.locator('[data-control-key="slide-theme:case"]').click());

  // Block styles, each from the Inspector's More formatting.
  await pick(page, values); await more();
  await reach(page, state, '.compositions[].styles[].ink', styleOf(first, values, 'ink'), () => press(page, values, 'ink:teal'), () => press(page, values, 'ink:plain'));
  await reach(page, state, '.compositions[].styles[].align', styleOf(first, values, 'align'), () => press(page, values, 'align:end'), () => press(page, values, 'align:start'));
  await reach(page, state, '.compositions[].styles[].padding', styleOf(first, values, 'padding'), () => press(page, values, 'padding:normal'), () => press(page, values, 'padding:none'));
  await pick(page, list); await more();
  await reach(page, state, '.compositions[].styles[].background', styleOf(first, list, 'background'), () => press(page, list, 'border:outline'), () => press(page, list, 'border:plain'));

  // Reading order is the slide panel's folded list; the layout comes last because it re-lays the blocks.
  await back(page);
  await unfold(page, 'How steps work');
  await unfold(page, 'Reading order');
  const opening = fx.document.compositions.find(item => item.owner.id === fx.document.start_beat_id);
  await reach(page, state, '.compositions[].reading_order[]', compositionOf(first, 'reading_order'), () => inspectorOf(page).getByRole('button', { name: /^Read Callout .* later$/ }).click());
  await reach(page, state, '.compositions[].template', compositionOf(first, 'template'), () => page.locator('[data-control-key="slide-template:story"]').click());

  await go(page, fx.document.beats.find(beat=>beat.id===fx.document.start_beat_id));
  await unfold(page, 'Layout and fill');
  await reach(page, state, '.compositions[].hero', compositionOf(opening, 'hero'), () => page.locator('[data-control-key="slide-hero:top"]').click(), () => page.locator('[data-control-key="slide-hero:centred"]').click());
  // A text block's style is the whole-block style in More formatting (single lines are restyled from the canvas toolbar).
  const title = opening.reading_order[0];
  await pick(page, title); await more();
  await reach(page, state, '.blocks[]<text>.paragraphs[].style', document => blockOf(document, title).paragraphs.map(item => item.style), () => choose(page, title, 'block-style', 'h3'), () => choose(page, title, 'block-style', 'h1'));
});

test('[AS-220] a table: caption, header and row labels, cells, column unit, alignment and width, and its presentation settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const { second } = fx.slides, { table } = fx.ids;
  const grid = blockOf(fx.document, table), column = grid.columns[2], row = grid.rows[0];
  await go(page, fx.slides.second);
  await pick(page, table);
  await reach(page, state, '.blocks[]<table>.caption', document => blockOf(document, table).caption, () => type(control(page, table, 'caption-tools'), 'Door observations'), () => type(control(page, table, 'caption-tools'), ''));
  await reach(page, state, '.blocks[]<table>.first_column_header', document => blockOf(document, table).first_column_header, () => control(page, table, 'first-column').uncheck(), () => control(page, table, 'first-column').check());
  await reach(page, state, '.blocks[]<table>.rows[].cells[]', document => blockOf(document, table).rows[0].cells, () => type(control(page, table, `${row.id}:${column.id}`), '86'));
  // Column settings open for the column of the selected cell.
  await control(page, table, `${row.id}:${column.id}`).click();
  await reach(page, state, '.blocks[]<table>.columns[].label', document => blockOf(document, table).columns[2].label, () => type(control(page, table, `column-label:${column.id}`), 'Reading'));
  await reach(page, state, '.blocks[]<table>.columns[].unit', document => blockOf(document, table).columns[2].unit, () => type(control(page, table, `unit:${column.id}`), '%'), () => type(control(page, table, `unit:${column.id}`), ''));
  await reach(page, state, '.blocks[]<table>.columns[].align', document => blockOf(document, table).columns[2].align, () => choose(page, table, `align:${column.id}`, 'start'), () => choose(page, table, `align:${column.id}`, 'end'));
  await reach(page, state, '.blocks[]<table>.columns[].width', document => blockOf(document, table).columns[2].width, () => type(control(page, table, `width:${column.id}`), '4'));
  await unfold(page, 'More formatting');
  await reach(page, state, '.compositions[].styles[].banded', styleOf(second, table, 'banded'), () => press(page, table, 'banded:false'), () => press(page, table, 'banded:true'));
  await reach(page, state, '.compositions[].styles[].density', styleOf(second, table, 'density'), () => press(page, table, 'density:roomy'), () => press(page, table, 'density:normal'));
  await reach(page, state, '.compositions[].styles[].text_size', styleOf(second, table, 'text_size'), () => press(page, table, 'text_size:normal'), () => press(page, table, 'text_size:large'));
  // The header row last: turning it off moves the labels into a visible row; turning it on again asks first.
  await reach(page, state, '.blocks[]<table>.header_row', document => blockOf(document, table).header_row, () => control(page, table, 'header-row').uncheck(), async () => {
    await control(page, table, 'header-row').click();
    await inspectorOf(page).getByRole('button', { name: 'Confirm', exact: true }).click();
  });
  await reach(page, state, '.blocks[].type', document => blockOf(document, table).type, async () => {
    await unfold(page, 'More formatting');
    await choose(page, table, 'turn-into', 'text');
    const confirm = inspectorOf(page).getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm.or(page.getByRole('button', { name: 'Save draft', exact: true }).and(page.locator(':enabled')))).toBeVisible();
    if (await confirm.isVisible()) await confirm.click();
  });
});

test('[AS-220] a chart: caption, axes, units, bounds, spacing, drawing style, shown values, points and readings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const { trend } = fx.ids, chart = blockOf(fx.document, trend), point = chart.points[0], series = chart.series[0];
  await go(page, fx.slides.third);
  await pick(page, trend);
  for (const [key, value] of [['caption', 'SpO2 at the door'], ['y_label', 'Saturation'], ['y_unit', 'per cent'], ['y_min', '60'], ['y_max', '99'], ['x_label', 'Minutes'], ['x_unit', 'mins']])
    await reach(page, state, `.blocks[]<trend>.${key}`, document => blockOf(document, trend)[key], () => type(control(page, trend, `trend:${key}`), value), key === 'caption' || key.endsWith('unit') ? () => type(control(page, trend, `trend:${key}`), '') : null);
  await reach(page, state, '.blocks[]<trend>.scale', document => blockOf(document, trend).scale, () => press(page, trend, 'trend:scale:category'), () => press(page, trend, 'trend:scale:time'));
  await reach(page, state, '.blocks[]<trend>.style', document => blockOf(document, trend).style, () => press(page, trend, 'trend:style:line'), () => press(page, trend, 'trend:style:points'));
  await reach(page, state, '.blocks[]<trend>.values_shown', document => blockOf(document, trend).values_shown, () => press(page, trend, 'trend:values_shown:true'), () => press(page, trend, 'trend:values_shown:false'));
  await reach(page, state, '.blocks[]<trend>.points[].label', document => blockOf(document, trend).points[0].label, () => type(control(page, trend, `point:${point.id}:label`), 'Arrival'));
  await reach(page, state, '.blocks[]<trend>.points[].at', document => blockOf(document, trend).points[0].at, () => type(control(page, trend, `point:${point.id}:at`), '1'));
  await reach(page, state, '.blocks[]<trend>.series[].label', document => blockOf(document, trend).series[0].label, () => type(control(page, trend, `series:${series.id}`), 'Pulse oximetry'));
  await reach(page, state, '.blocks[]<trend>.series[].values[]', document => blockOf(document, trend).series[0].values, () => type(control(page, trend, `value:${series.id}:${point.id}`), '85'));
});

test('[AS-220] a blood gas: sample, caption, groups, rows, ranges, readings and compare columns', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const { gas } = fx.ids, report = blockOf(fx.document, gas), group = report.groups[0], row = group.rows[0], sample = report.compare.earlier[0];
  await go(page, fx.slides.fourth);
  await pick(page, gas);
  const key = part => `gas:${part}`;
  await reach(page, state, '.blocks[]<gas>.sample', document => blockOf(document, gas).sample, () => press(page, gas, key('sample:arterial')), () => press(page, gas, key('sample:venous')));
  await reach(page, state, '.blocks[]<gas>.caption', document => blockOf(document, gas).caption, () => type(control(page, gas, key('caption')), 'Gas at the door'), () => type(control(page, gas, key('caption')), ''));
  await reach(page, state, '.blocks[]<gas>.compare.label', document => blockOf(document, gas).compare.label, () => type(control(page, gas, key('label:now')), 'Door'));
  await reach(page, state, '.blocks[]<gas>.compare.earlier[].label', document => blockOf(document, gas).compare.earlier[0].label, () => type(control(page, gas, key(`label:${sample.id}`)), 'Ambulance'));
  await reach(page, state, '.blocks[]<gas>.groups[].rows[].value', document => blockOf(document, gas).groups[0].rows[0].value, () => type(control(page, gas, key(`cell:${row.id}:now`)), '7.28'));
  await reach(page, state, '.blocks[]<gas>.groups[].rows[].earlier[]', document => blockOf(document, gas).groups[0].rows[0].earlier, () => type(control(page, gas, key(`cell:${row.id}:${sample.id}`)), '7.2'));
  await press(page, gas, key('mode:rows'));
  await reach(page, state, '.blocks[]<gas>.groups[].label', document => blockOf(document, gas).groups[0].label, () => type(control(page, gas, `group:${group.id}`), 'Blood gas results'));
  for (const part of ['label', 'unit', 'low', 'high'])
    await reach(page, state, `.blocks[]<gas>.groups[].rows[].${part}`, document => blockOf(document, gas).groups[0].rows[0][part], () => type(control(page, gas, `row:${row.id}:${part}`), part === 'low' ? '7.3' : part === 'high' ? '7.5' : part === 'unit' ? 'pH units' : 'pH (venous)'));
});

test('[AS-220] an image and an ECG: text alternative, caption, fit and calibration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const { ecg, photo } = fx.ids;
  await go(page, fx.slides.fifth);
  await pick(page, photo);
  await reach(page, state, '.blocks[]<image>.alt', document => blockOf(document, photo).alt, () => type(control(page, photo, 'image:alt'), 'A chest film with the right lung collapsed'));
  await reach(page, state, '.blocks[]<image>.caption', document => blockOf(document, photo).caption, () => type(control(page, photo, 'image:caption'), 'Film at the door'), () => type(control(page, photo, 'image:caption'), ''));
  await reach(page, state, '.blocks[]<image>.fit', document => blockOf(document, photo).fit, () => press(page, photo, 'image:fit:contain'), () => press(page, photo, 'image:fit:cover'));
  await pick(page, ecg);
  await reach(page, state, '.blocks[]<image>.ecg.speed', document => blockOf(document, ecg).ecg.speed, () => press(page, ecg, 'image:speed:50'), () => press(page, ecg, 'image:speed:'));
  await reach(page, state, '.blocks[]<image>.ecg.gain', document => blockOf(document, ecg).ecg.gain, () => press(page, ecg, 'image:gain:20'), () => press(page, ecg, 'image:gain:'));
  await reach(page, state, '.blocks[]<image>.ecg.layout', document => blockOf(document, ecg).ecg.layout, () => press(page, ecg, 'image:layout:rhythm-strip'), () => press(page, ecg, 'image:layout:other'));
});

const caseDetails = async page => { await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('button', { name: 'Case details', exact: true }).click(); };

test('[AS-220] the case itself: title, summary, audience, setting, length, objectives, flags and preparation notes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  await caseDetails(page);
  const labelled = name => page.getByLabel(name, { exact: true });
  for (const [pattern, label, field, value] of [['.title', 'Case title', 'title', 'A tension pneumothorax'], ['.summary', 'Case summary', 'summary', 'A short new summary.'], ['.audience', 'Audience', 'audience', 'Interns'], ['.setting', 'Setting', 'setting', 'City ED'], ['.duration_min', 'Teaching estimate in minutes', 'duration_min', '30']])
    await reach(page, state, pattern, document => document[field], () => type(labelled(label), value));
  await reach(page, state, '.learning_objectives[]', document => document.learning_objectives, () => type(labelled('Learning objective 1'), 'Decompress first.'));
  await page.locator('.builder-case-advanced > summary').click();
  await reach(page, state, '.clarifications[].label', document => document.clarifications[0].label, () => type(page.getByLabel('Clarification label', { exact: true }), 'Arrival clarification'));
  const flag = fx.document.flags[1];
  await reach(page, state, '.flags[].label', document => document.flags[1].label, () => type(page.locator(`[data-control-key="${flag.id}:label"]`), 'Finger thoracostomy done'));
  await reach(page, state, '.flags[].key', document => document.flags[1].key, () => type(page.locator(`[data-control-key="${flag.id}:key"]`), 'finger_done'));
  await reach(page, state, '#.preparation_requirements', (document, metadata) => metadata.preparation_requirements, () => type(labelled('Private preparation requirements'), 'Bring two drains.'), () => type(labelled('Private preparation requirements'), ''));
});

const stageFold = (page, name) => page.locator('summary', { hasText: name });
async function fold(page, name) { const summary = stageFold(page, name).first(); if ((await summary.locator('xpath=..').getAttribute('open')) === null) await summary.click(); }

test('[AS-220] a stage: its name, private cue, notes, flags it requires and what the slide is for', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const beat = fx.document.beats[2], surface = fx.document.surfaces.find(item => item.id === beat.surface_id);
  await go(page, fx.document.beats[2]);
  await reach(page, state, '.beats[].title', document => document.beats[2].title, () => type(page.getByLabel('Slide title', { exact: true }), 'S00167 worksho now'));
  await fold(page, 'Facilitator notes');
  await reach(page, state, '.beats[].cue', document => document.beats[2].cue, () => type(page.getByLabel('Private stage cue', { exact: true }), 'Ask what changed.'), () => type(page.getByLabel('Private stage cue', { exact: true }), ''));
  await reach(page, state, '.surfaces[].notes', document => document.surfaces.find(item => item.id === surface.id).notes, () => type(page.getByLabel('Private facilitator notes', { exact: true }), 'The room has steadied.'), () => type(page.getByLabel('Private facilitator notes', { exact: true }), ''));
  await caseDetails(page);
  await page.locator('.builder-case-advanced > summary').click();
  await reach(page, state, '.beats[].requires_flags[]', document => document.beats[2].requires_flags, () => page.getByLabel('S00010 workshop label. Record a sen').and(page.locator('[data-control-key^="check:Required flags"]')).check(), () => page.getByLabel('S00010 workshop label. Record a sen').and(page.locator('[data-control-key^="check:Required flags"]')).uncheck());
  await reach(page, state, '.surfaces[].kind', document => document.surfaces.find(item => item.id === surface.id).kind, () => pickSelect(page, 'Presentation purpose', 'update'));
  // A consequence's slide is titled by the heading of the content it reveals.
  const reveal = fx.document.decisions[0].paths[0].reveal_surface_id;
  await page.getByRole('button', { name: '← Back to the slide', exact: true }).click();
  await go(page, fx.slides.first);
  await reach(page, state, '.surfaces[].title', document => document.surfaces.find(item => item.id === reveal).title, () => type(page.getByLabel('Slide title', { exact: true }), 'Needle decompression'));
});

const pickSelect = (page, label, value) => setNative(page.locator(`select[data-control-key="select:${label}"]`), value);
const keyed = (page, key) => page.locator(`[data-control-key="${key}"]`);
const checkbox = (page, group, flag) => page.locator(`[data-control-key="check:${group}:${flag}"]`);
const openResponse = async page => fold(page, 'Response and consequences');
/** From the stage's slide, open one of its consequences in Response and consequences. */
async function openConsequence(page, stage, name) {
  if (await page.locator('.builder-crumb').count()) await page.locator('.builder-crumb').click();
  await go(page, stage);
  await openResponse(page);
  await page.locator('button.builder-issue-link', { hasText: name }).first().click();
}

test('[AS-220] a question and its consequences: prompt, timer, responses, interpretation, classification, recommendation, flags, cues and recovery', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const decision = fx.document.decisions[0], [needle, finger, xray, rsi] = decision.paths;
  await go(page, beatForDecision(fx.document.decisions[0]));
  const question = fx.document.blocks.find(item => item.type === 'question' && item.decision_id === decision.id);
  await pick(page, question.id);
  await reach(page, state, '.decisions[].prompt', document => document.decisions[0].prompt, () => type(page.getByLabel('Question text', { exact: true }), 'What is the single next intervention?'));
  await back(page);
  await openResponse(page);
  await reach(page, state, '.decisions[].timer_s', document => document.decisions[0].timer_s, () => type(keyed(page, `${decision.id}:timer_s`), '120'), () => type(keyed(page, `${decision.id}:timer_s`), ''));
  await reach(page, state, '.decisions[].interaction.options[].label', document => document.decisions[0].interaction.options[0].label, () => type(keyed(page, `${decision.interaction.options[0].id}:label`), 'Film first'));
  await reach(page, state, '.decisions[].interpretation', document => document.decisions[0].interpretation, () => pickSelect(page, 'Interpretation', 'facilitator'), () => pickSelect(page, 'Interpretation', 'rules'));

  await openConsequence(page, beatForDecision(fx.document.decisions[0]), finger.label);
  await reach(page, state, '.decisions[].paths[].label', document => document.decisions[0].paths[1].label, () => type(keyed(page, `${finger.id}:label`), 'Finger thoracostomy'));
  await reach(page, state, '.decisions[].paths[].classification', document => document.decisions[0].paths[1].classification, () => pickSelect(page, 'Teaching classification', 'context-dependent'));
  await reach(page, state, '.decisions[].paths[].recommended', document => document.decisions[0].paths[1].recommended, () => pickSelect(page, 'Recommended main path', finger.id));
  await reach(page, state, '.decisions[].paths[].set_flags[]', document => document.decisions[0].paths[1].set_flags, () => checkbox(page, 'Flags set by this consequence', 'workshop_flag_02').uncheck(), () => checkbox(page, 'Flags set by this consequence', 'workshop_flag_02').check());
  await reach(page, state, '.decisions[].paths[].clear_flags[]', document => document.decisions[0].paths[1].clear_flags, () => checkbox(page, 'Flags cleared by this consequence', 'workshop_flag_01').check(), () => checkbox(page, 'Flags cleared by this consequence', 'workshop_flag_01').uncheck());
  await fold(page, 'Facilitator notes');
  await reach(page, state, '.decisions[].paths[].rationale', document => document.decisions[0].paths[1].rationale, () => type(page.getByLabel('Consequence rationale', { exact: true }), 'A rationale for the finger.'));
  await reach(page, state, '.decisions[].paths[].cue', document => document.decisions[0].paths[1].cue, () => type(page.getByLabel('Private facilitator cue', { exact: true }), 'Ask who is credentialed.'));

  await openConsequence(page, beatForDecision(fx.document.decisions[0]), xray.label);
  await reach(page, state, '.decisions[].paths[].recovery.prompt', document => document.decisions[0].paths[2].recovery?.prompt, () => type(page.getByLabel('Required recovery action', { exact: true }), 'Recover the airway.'));
  await openConsequence(page, beatForDecision(fx.document.decisions[0]), rsi.label);
  await reach(page, state, '.decisions[].paths[].terminal.debrief_prompt', document => document.decisions[0].paths[3].terminal.debrief_prompt, () => type(page.getByLabel('Terminal debrief prompt', { exact: true }), 'Why did the pressure matter?'));
});

test('[AS-220] response rules and settings for multiple choice, ranking and free text, and a route that simply continues', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openEditor(page, servers, fx);
  const [, multi, ranking, free] = fx.document.decisions;
  const rule = (decision, field) => keyed(page, `${decision.id}:rule:0:${field}`);

  await go(page, fx.document.beats[2]);
  await openResponse(page);
  await reach(page, state, '.decisions[].rules[].reason', document => document.decisions[1].rules[0].reason, () => type(rule(multi, 'reason'), 'All three of these'));
  await reach(page, state, '.decisions[].rules[].when.includes_all[]', document => document.decisions[1].rules[0].when.includes_all, () => page.locator('.builder-rule-row').first().getByLabel(multi.interaction.options[2].label, { exact: true }).check(), () => page.locator('.builder-rule-row').first().getByLabel(multi.interaction.options[2].label, { exact: true }).uncheck());

  for (const [index, key] of [[1, 'includes_any'], [2, 'excludes']]) {
    const row = page.locator('.builder-rule-row').nth(index);
    await reach(page, state, `.decisions[].rules[].when.${key}[]`, document => document.decisions[1].rules[index].when[key],
      () => row.getByLabel(multi.interaction.options[2].label, { exact: true }).check(),
      () => row.getByLabel(multi.interaction.options[2].label, { exact: true }).uncheck());
    expect(state.pair.document.decisions[1].rules[index].when[key]).toEqual([multi.interaction.options[0].id]);
  }

  await go(page, beatForDecision(ranking));
  await openResponse(page);
  await reach(page, state, '.decisions[].interaction.order_meaning', document => document.decisions[2].interaction.order_meaning, () => pickSelect(page, 'Ranking means', 'priority'), () => pickSelect(page, 'Ranking means', 'action'));
  await reach(page, state, '.decisions[].interaction.rank_count', document => document.decisions[2].interaction.rank_count, () => type(keyed(page, `${ranking.id}:rank_count`), '3'), () => type(keyed(page, `${ranking.id}:rank_count`), ''));
  await reach(page, state, '.decisions[].rules[].when.top[]', document => document.decisions[2].rules[0].when.top, () => page.locator('.builder-rule-row').first().getByLabel(ranking.interaction.options[2].label, { exact: true }).check());

  const beforeRow = page.locator('.builder-rule-row').nth(1);
  await reach(page, state, '.decisions[].rules[].when.before[]', document => document.decisions[2].rules[1]?.when.before,
    () => setNative(beforeRow.locator('select[data-control-key="select:Ranked above"]'), ranking.interaction.options[2].id),
    async () => {
      expect(state.pair.document.decisions[2].rules[1].when.before).toEqual([ranking.interaction.options[2].id, ranking.interaction.options[1].id]);
      await beforeRow.getByRole('button', { name: 'Remove rule 2', exact: true }).click();
    });
  expect(state.pair.document.decisions[2].rules).toHaveLength(1);

  await go(page, beatForDecision(free));
  await openResponse(page);
  await reach(page, state, '.decisions[].interaction.max_length', document => document.decisions[3].interaction.max_length, () => type(keyed(page, `${free.id}:max_length`), '300'));
  await reach(page, state, '.decisions[].paths[].continue_to_next', document => document.decisions[3].paths[0].continue_to_next, () => page.getByRole('button', { name: 'Add branches', exact: true }).click());
  await page.locator('.builder-crumb').click();
  await openResponse(page);
  await reach(page, state, '.decisions[].rules[].when.keywords[]', document => document.decisions[3].rules[0].when.keywords, () => type(rule(free, 'keywords'), 'airway, plan, intubate'));

  // The response type last: it removes what the new type cannot hold, after a review.
  await go(page, fx.document.beats[2]);
  await openResponse(page);
  await reach(page, state, '.decisions[].interaction.type', document => document.decisions[1].interaction.type, async () => {
    await pickSelect(page, 'Response type', 'ranking');
    await page.getByRole('button', { name: 'Apply response type change', exact: true }).click();
  });
});

test('[AS-220] every field the fixture carries was edited through the Builder, and the fixture carries every field a draft can have', async () => {
  const carried = fieldPatterns(fx.document, fx.authoringMetadata);
  expect(carried.filter(name => !REACH_FIELDS.includes(name)), 'fields the fixture has but the registry lacks').toEqual([]);
  expect(REACH_FIELDS.filter(name => !carried.includes(name)), 'registered fields the fixture lacks').toEqual([]);
  expect(REACH_FIELDS.filter(name => !reached.has(name)), 'fields no test edited through the Builder').toEqual([]);
  expect([...reached].filter(name => !REACH_FIELDS.includes(name)), 'edited fields that are not registered').toEqual([]);
});
