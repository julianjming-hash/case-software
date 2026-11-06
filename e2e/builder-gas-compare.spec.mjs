// CASE-317 blood gas compare mode (AS-186): an author types results in the redesigned gas editor, adds an earlier sample
// copied from another gas, pastes a printout into a column, and the room's projector draws ONE table whose sample columns
// line up down the whole printout and fit their placement at 720p and 1080p. Local workerd and fakes only (hard rule 12).
import { test, expect } from '@playwright/test';
import { start, stop, mvcSchema2, openBuilder, slide, shot } from '../tests/design-critique/harness.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { facilitatorCommand } from '../tests/helpers/local-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import * as compare from '../src/shared/slide-gas-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { displayPairUrl } from '../src/shared/urls.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start);
test.afterAll(stop);

const ok = result => { if (!result.ok) throw new Error(result.reason); return result.document; };
const rowOf = (gas, label) => gas.groups.flatMap(group => group.rows).find(row => row.label === label);
const startComposition = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
/** The fixture as slides: the opening keeps its title and gains the 19:25 gas; the next slide keeps its title and the 18:45 gas. */
function gasCase() {
  const { document: source, authoringMetadata } = mvcSchema2();
  source.title = 'Gas compare fixture';
  let document = convertToSlideDocument(source, authoringMetadata, { createId: uuidv7 }).candidate.document;
  const opening = startComposition(document), plain = document.beats.find(beat => !beat.decision_id && beat.id !== document.start_beat_id);
  const next = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === plain.id);
  for (const composition of [opening, next]) for (const blockId of composition.reading_order.slice(1)) document = ok(edit.removeBlock(document, composition.id, blockId));
  document = ok(edit.addBlock(document, next.id, 'gas', uuidv7));
  const earlier = document.blocks.findLast(block => block.type === 'gas');
  document = ok(edit.setGasField(document, earlier.id, 'caption', '18:45 · room air'));
  for (const [label, value] of [['pH', '7.47'], ['pCO2', '30'], ['cLac', '1.8']]) document = ok(edit.setGasRow(document, earlier.id, rowOf(earlier, label).id, 'value', value));
  document = ok(edit.addBlock(document, opening.id, 'gas', uuidv7));
  const current = document.blocks.findLast(block => block.type === 'gas');
  document = ok(edit.setGasField(document, current.id, 'caption', '19:25 · nebuliser'));
  return { document, authoringMetadata, earlier: earlier.id, current: current.id };
}
const noSideScroll = locator => locator.evaluate(node => node.scrollWidth <= node.clientWidth + 1);

test('[AS-186] an author types gas results by column, adds an earlier sample copied by row name and pastes a printout into one column', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = gasCase();
  const state = await openBuilder(page, { document: fixture.document, authoringMetadata: fixture.authoringMetadata });
  await expect(slide(page)).toBeVisible();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  const gas = slide(page).locator(`.slide-canvas .slide-block[data-block-id="${fixture.current}"]`);
  await gas.click({ position: { x: 6, y: 6 } });
  // Values mode is the default: names are text, one value input per row, and Enter moves down the column.
  await expect(tools.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Values', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tools.getByRole('rowheader', { name: 'pCO2', exact: true })).toBeVisible();
  const ph = tools.getByLabel('pH value', { exact: true });
  await ph.click(); await ph.pressSequentially('7.23'); await ph.press('Enter');
  await expect(tools.getByLabel('pCO2 value', { exact: true })).toBeFocused();
  await page.keyboard.type('60');
  await expect(tools.getByLabel('pCO2 value', { exact: true })).toHaveClass(/builder-gas-flagged/);
  await expect(tools.getByLabel('pCO2 value', { exact: true })).toHaveAttribute('title', 'Range 35–45 · above its range');
  // Add an earlier sample copied from the 18:45 gas: its label comes from that gas's caption.
  await tools.getByRole('button', { name: 'Add earlier sample…', exact: true }).click();
  const add = tools.getByRole('region', { name: 'Add earlier sample', exact: true });
  await expect(add.getByRole('group', { name: 'Copy values from', exact: true }).getByRole('button', { pressed: true })).toHaveText(/^Arterial blood gas · 18:45 · room air · /);
  await expect(add.getByLabel('Column label', { exact: true })).toHaveValue('18:45');
  await add.getByLabel('This sample’s label', { exact: true }).fill('19:25');
  await add.getByRole('button', { name: 'Add column', exact: true }).click();
  await expect(tools.getByLabel('Sample 1 label', { exact: true })).toHaveValue('18:45');
  await expect(tools.getByLabel('Current sample label', { exact: true })).toHaveValue('19:25');
  await expect(tools.getByLabel('pH at 18:45', { exact: true })).toHaveValue('7.47');
  await expect(tools.getByLabel('pCO2 at 19:25', { exact: true })).toHaveValue('60');
  // A second, empty column sits just before the current one; paste fills the column the caret was in, with one Undo.
  await tools.getByRole('button', { name: 'Add earlier sample…', exact: true }).click();
  await add.getByRole('button', { name: 'Empty column', exact: true }).click();
  await add.getByLabel('Column label', { exact: true }).fill('19:00');
  await add.getByRole('button', { name: 'Add column', exact: true }).click();
  await tools.getByLabel('pH at 19:00', { exact: true }).focus();
  await tools.getByRole('button', { name: 'Paste a printout…', exact: true }).click();
  const paste = tools.getByRole('region', { name: 'Paste a printout', exact: true });
  await paste.getByLabel('Printout text', { exact: true }).fill('pH 7.37\npCO2   40  mmHg\nLactate 3.1\nFiO2 0.4');
  await expect(paste.getByRole('status')).toHaveText('3 of 4 lines matched: pH, pCO2, cLac. Fills column 19:00.');
  await expect(paste.getByRole('list', { name: 'Lines not matched' }).getByRole('listitem')).toHaveText(['FiO2 0.4']);
  await paste.scrollIntoViewIfNeeded();
  await shot(page, 'case-317-builder-gas-paste-light');
  await paste.getByRole('button', { name: 'Fill values', exact: true }).click();
  await expect(tools.getByLabel('pCO2 at 19:00', { exact: true })).toHaveValue('40');
  await expect(tools.getByLabel('cLac at 19:00', { exact: true })).toHaveValue('3.1');
  // The canvas draws the room's one table: the three samples oldest first, the newest tinted.
  await expect(gas.locator('.slide-gas-compare thead th')).toHaveText(['Unit', '18:45', '19:00', '19:25', 'Range']);
  await expect(gas.locator('.slide-gas-compare thead th.slide-gas-now')).toHaveText('19:25');
  // Everything fits the 340 px inspector at 720p, in both modes and both themes, with no sideways scroll.
  const body = tools.locator('.builder-inspector-body');
  await tools.getByRole('group', { name: 'Editor mode', exact: true }).scrollIntoViewIfNeeded();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await noSideScroll(body), `values mode, ${scheme}`).toBe(true);
    await shot(page, `case-317-builder-gas-values-${scheme}`);
  }
  await tools.getByRole('group', { name: 'Editor mode', exact: true }).getByRole('button', { name: 'Rows and ranges', exact: true }).click();
  await expect(tools.getByLabel('pCO2 low', { exact: true })).toHaveValue('35');
  await expect(tools.getByRole('button', { name: 'Delete group' }).first()).toHaveClass(/builder-quiet-link/);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await noSideScroll(body), `rows mode, ${scheme}`).toBe(true);
    await shot(page, `case-317-builder-gas-rows-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // What the author built is what is saved: compare mode with each row's earlier readings, oldest first.
  await expect.poll(() => state.puts).toBeGreaterThan(0);
  await expect.poll(() => state.pair.document.blocks.find(block => block.id === fixture.current)?.compare?.earlier?.map(sample => sample.label) ?? null).toEqual(['18:45', '19:00']);
  const saved = state.pair.document.blocks.find(block => block.id === fixture.current);
  expect(saved.compare.label).toBe('19:25');
  expect(['pH', 'pCO2', 'cLac'].map(label => [...rowOf(saved, label).earlier, rowOf(saved, label).value])).toEqual([['7.47', '7.37', '7.23'], ['30', '40', '60'], ['1.8', '3.1', '']]);
});

const VIEWPORTS = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }];
/** Publish `document`, open a real room's projector at each viewport, release the gas step and hand the display to `check`. */
async function onProjector(browser, document, check) {
  const worker = await startPublishedWorker({ caseDocument: document }), shell = await startServedAuthShell({ apiOrigin: worker.origin });
  try {
    for (const viewport of VIEWPORTS) {
      const started = await fetch(`${worker.origin}/api/v1/sessions`, { method: 'POST', headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
      expect(started.status).toBe(201);
      const room = await started.json();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport }), display = await context.newPage();
      await display.goto(displayPairUrl('00000000', shell.origin));
      await expect(display.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
      const code = (await display.locator('.pair-code').textContent()).replace(/\s/g, '');
      expect((await fetch(`${worker.origin}/api/v1/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST',
        headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).ok).toBe(true);
      await expect(display).toHaveURL(new RegExp(`/sessions/${room.sessionId}/display`), { timeout: 15_000 });
      expect((await facilitatorCommand(worker.origin, room, 'start')).receipt).toBe('accepted');
      // The gas is the opening slide's own reveal step.
      const table = display.locator('main.slide-band .slide-gas-compare table');
      for (let i = 0; i < 4 && !(await table.count()); i++) {
        expect((await facilitatorCommand(worker.origin, room, 'advance')).receipt).toBe('accepted');
        await display.waitForTimeout(400);
      }
      await expect(table).toHaveCount(1);
      await check(display, viewport);
      await context.close();
    }
  } finally { await shell.stop(); await worker.stop(); }
}
/** After the fit pass settles: each sample column's shared edges, cells outside the block, the overflow mark and the block's fit. */
const measure = display => display.evaluate(() => {
  const block = document.querySelector('main.slide-band .slide-block.slide-gas'), box = block.getBoundingClientRect();
  const rows = [...block.querySelectorAll('table tr')].filter(row => row.querySelectorAll('.slide-gas-cell').length), width = rows[0].querySelectorAll('.slide-gas-cell').length;
  const columns = Array.from({ length: width }, (_, at) => rows.map(row => row.querySelectorAll('.slide-gas-cell')[at].getBoundingClientRect()));
  const spread = columns.map(cells => Math.max(...cells.map(r => r.left)) - Math.min(...cells.map(r => r.left)) + Math.max(...cells.map(r => r.right)) - Math.min(...cells.map(r => r.right)));
  const outside = [...block.querySelectorAll('th, td, .slide-gas-title')].map(cell => cell.getBoundingClientRect())
    .filter(r => r.left < box.left - .5 || r.right > box.right + .5 || r.top < box.top - .5 || r.bottom > box.bottom + .5).length;
  return { rows: rows.length, spread: spread.map(value => Math.round(value * 10) / 10), outside, overflow: document.querySelector('main').dataset.overflow,
    fit: parseFloat(block.style.getPropertyValue('--fit') || '1') };
});

test('[AS-186] the room projector draws one compare table whose sample columns line up and fit their placement at 720p and 1080p', async ({ browser }) => {
  test.setTimeout(150_000);
  const fixture = gasCase();
  let document = fixture.document;
  document = ok(compare.addGasSample(document, fixture.current, { label: '18:45', current: '19:25', from: fixture.earlier }, uuidv7));
  document = ok(compare.addGasSample(document, fixture.current, { label: '19:00' }, uuidv7));
  const gas = () => document.blocks.find(block => block.id === fixture.current);
  for (const [label, readings] of [['pH', ['7.47', '7.37', '7.23']], ['pCO2', ['30', '40', '60']], ['pO2', ['68', '82', '74']], ['cHCO3−', ['21.1', '22.3', '24.1']],
    ['cBase(B)', ['−1.4', '−2.6', '−3.6']], ['cK+', ['3.9', '', '3.4']], ['cLac', ['1.8', '3.1', '3.8']]])
    readings.forEach((value, column) => { document = ok(compare.setGasReading(document, fixture.current, rowOf(gas(), label).id, column, value)); });
  await onProjector(browser, document, async (display, viewport) => {
    const table = display.locator('main.slide-band .slide-gas-compare table');
    await expect(display.locator('main.slide-band .slide-gas-table')).toHaveCount(0);
    await expect(table.locator('thead th')).toHaveText(['Unit', '18:45', '19:00', '19:25', 'Range']);
    // Each sample's cells share one left and right edge down the whole printout, across every group, inside the block.
    await expect.poll(async () => { const { fit, ...rest } = await measure(display); return rest; }, { timeout: 10_000 })
      .toEqual({ rows: 8, spread: [0, 0, 0], outside: 0, overflow: 'false' });
    await expect(display.locator('main.slide-band .slide-gas-cell.slide-gas-now.slide-gas-high')).toHaveText(['↑High: 60', '↑High: 3.8']);
    await display.screenshot({ path: `test-results/case-317-gas-compare-${viewport.height}p.png` });
  });
});

test('[AS-186] a full printout in compare mode fits a full-width placement under a title, as it does a narrower one', async ({ browser }) => {
  test.setTimeout(150_000);
  // Review finding on #351: 17 typed rows in five groups, one earlier sample, alone at col 1, row 3, w12, h9 under an h1 at
  // 1/1/12/2, shrank to the fit floor and was marked, while the same block at w8, h10 fitted. The table is height-bound (24
  // lines at any width): h9 needed fit 0.38 and h10 0.43 at every width, so the compare rows were tightened (CASE-317).
  const fixture = gasCase();
  let document = fixture.document;
  const opening = startComposition(document), title = opening.reading_order[0];
  document = ok(compare.addGasSample(document, fixture.current, { label: '19:55', current: '20:05' }, uuidv7));
  const gas = () => document.blocks.find(block => block.id === fixture.current);
  const readings = { pH: ['7.31', '7.24'], pCO2: ['52', '61'], pO2: ['71', '64'], 'cHCO3−': ['25.6', '25.9'], 'cBase(B)': ['−1.2', '−1.8'], 'cK+': ['3.6', '3.4'],
    'cNa+': ['139', '139'], 'cCa2+': ['1.18', '1.17'], 'cCl−': ['104', '104'], cGlu: ['9.8', '11.2'], cLac: ['2.9', '3.6'], ctHb: ['142', '141'],
    sO2: ['93', '91'], FO2Hb: ['92', '90'], FCOHb: ['0.9', '0.9'], FMetHb: ['0.6', '0.6'], Hct: ['42', '42'] };
  for (const [label, values] of Object.entries(readings)) values.forEach((value, column) => { document = ok(compare.setGasReading(document, fixture.current, rowOf(gas(), label).id, column, value)); });
  document = ok(edit.setPlacement(document, opening.id, title, { col: 1, row: 1, w: 12, h: 2 }));
  document = ok(edit.setPlacement(document, opening.id, fixture.current, { col: 1, row: 3, w: 12, h: 9 }));
  // As on the asthma slide: the author turned the hero off, so the block keeps its own nine rows.
  document = ok(edit.setHero(document, opening.id, 'off'));
  await onProjector(browser, document, async (display, viewport) => {
    await expect.poll(async () => { const { fit, ...rest } = await measure(display); return rest; }, { timeout: 10_000 })
      .toEqual({ rows: 18, spread: [0, 0], outside: 0, overflow: 'false' });
    // A one-table printout is height-bound whatever its width: it fits above the fit floor (0.415) and is never marked.
    expect((await measure(display)).fit, `${viewport.height}p`).toBeGreaterThan(.415);
    await expect(display.locator('main.slide-band .slide-gas .slide-more')).toHaveCount(0);
    await display.screenshot({ path: `test-results/case-317-gas-compare-full-${viewport.height}p.png` });
  });
});
