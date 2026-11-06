// Card 59 M1 (CASE-263): an author adds a trend chart from the palette, types its axis and readings in the Block tab,
// and the slide draws exactly those numbers. A reading outside the axis is named by Readiness and never clipped; Undo
// takes the last reading back. Local workerd and fakes only (hard rule 12).
import { test, expect } from '@playwright/test';
import { start, stop, divingSlides, openBuilder, slide } from '../tests/design-critique/harness.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start);
test.afterAll(stop);

test('[AS-164] an author builds a trend chart in the Block tab and the slide draws exactly the typed values', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  await openBuilder(page, pair);
  await expect(slide(page)).toBeVisible();
  // The palette is the Tools panel's Block tab with nothing selected (CASE-225).
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = slide(page).locator('.slide-block.slide-trend');
  await expect(chart).toHaveCount(1);
  const id = await chart.getAttribute('data-block-id');
  const field = key => page.locator(`[data-control-key="slide:${id}:${key}"]`);
  // The new chart opens with its vertical axis label ready to type; nothing is pre-filled with a value.
  await expect(field('trend:y_label')).toBeFocused();
  await expect(field('trend:y_min')).toHaveValue('');
  await page.keyboard.type('Lactate');
  for (const [key, value] of [['trend:y_unit', 'mmol/L'], ['trend:y_min', '0'], ['trend:y_max', '6.0'], ['trend:caption', 'Lactate after resuscitation']]) await field(key).fill(value);
  const rows = page.locator('.builder-trend-grid tbody tr');
  await expect(rows).toHaveCount(2);
  const cells = row => rows.nth(row).locator('input');
  await cells(0).nth(0).fill('Arrival'); await cells(0).nth(1).fill('0'); await cells(0).nth(2).fill('4.80');
  await cells(1).nth(0).fill('8 h'); await cells(1).nth(1).fill('8'); await cells(1).nth(2).fill('2.0');
  await page.locator('.builder-trend-grid thead input').first().fill('Lactate');
  // The canvas draws the authored strings exactly, 4.80 with its trailing zero, and no other number.
  const drawn = chart.locator('svg text');
  await expect(drawn.filter({ hasText: /^4\.80$/ })).toHaveCount(1);
  await expect(drawn.filter({ hasText: /^2\.0$/ })).toHaveCount(1);
  await expect(drawn.filter({ hasText: /^6\.0$/ })).toHaveCount(1);
  await expect(chart.locator('svg polyline')).toHaveCount(1);
  await expect(chart.locator('table.slide-trend-data caption')).toHaveText('Lactate after resuscitation');
  // A reading above the axis top is not drawn and Readiness names it; Undo takes it back. Typing in one chart within a
  // second is one history entry (the Builder's typing rule), so the wrong reading comes after a pause, as a person's would.
  await page.waitForTimeout(1200);
  await cells(1).nth(2).fill('9');
  await expect(chart.locator('svg circle')).toHaveCount(1);
  await expect(page.getByText('is outside the axis; widen the axis or correct the value').first()).toBeAttached();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(chart.locator('svg circle')).toHaveCount(2);
  // A second series is told apart by marker shape as well as colour, and gets a legend.
  await page.getByRole('button', { name: 'Add series' }).click();
  await expect(page.locator('.builder-trend-grid thead input')).toHaveCount(2);
  await expect(chart.locator('.slide-trend-legend li')).toHaveCount(2);
});

// D27: two charts side by side in 6 × 9 cells each (the diving case's Sodium and creatinine slide). The plot fills its
// block (its drawing has the block's shape, so nothing is letterboxed), and its type is the room's: at least 18 px of a
// 1280 px slide, whatever the block's width. Measured on the Builder canvas, which draws the room's renderer smaller.
test('[AS-164] D27: a trend chart fills its block and its labels are room-sized at any block width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), start = pair.document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === pair.document.start_beat_id);
  let document = pair.document;
  for (const id of start.reading_order) if (!document.blocks.find(block => block.id === id && block.type === 'question')) document = edit.removeBlock(document, start.id, id).document ?? document;
  for (let n = 0; n < 2; n++) document = edit.addBlock(document, start.id, 'trend', uuidv7).document;
  const target = document.compositions.find(item => item.id === start.id), trends = document.blocks.filter(block => block.type === 'trend').slice(-2);
  target.placements = target.placements.filter(item => !trends.some(trend => trend.id === item.block_id));
  trends.forEach((trend, n) => {
    Object.assign(trend, { y_label: 'Sodium', y_unit: 'mmol/L', y_min: '110', y_max: '140' });
    trend.points[0].label = 'Day 6'; trend.points[1].label = 'Day 8'; trend.series[0].label = 'Sodium'; trend.series[0].values = ['133', '118'];
    // Beside the slide's Question block (columns 9–12), which an overlapping chart would make an invalid draft.
    target.placements.push({ block_id: trend.id, col: 1 + 4 * n, row: 3, w: 4, h: 9 });
  });
  await openBuilder(page, { ...pair, document });
  // The charts draw once the slide code has loaded, after the studio mounts: wait for both before measuring (a hosted
  // runner measured before they were drawn and found none).
  const charts = slide(page).locator('.slide-canvas > .slide-block.slide-trend svg');
  await expect(charts).toHaveCount(2);
  const shapes = await charts.evaluateAll(list => list.map(svg => {
    const box = svg.getBoundingClientRect(), [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number), canvas = svg.closest('.slide-canvas').getBoundingClientRect().width;
    const scale = Math.min(box.width / w, box.height / h), tick = parseFloat(getComputedStyle(svg.querySelector('.slide-trend-tick')).fontSize) * scale;
    return { box: box.width / box.height, drawing: w / h, tick: tick * 1280 / canvas };
  }));
  expect(shapes).toHaveLength(2);
  for (const shape of shapes) {
    expect(Math.abs(shape.drawing - shape.box) / shape.box, 'the plot fills its block').toBeLessThan(.12);
    expect(shape.tick, 'labels are at least 18 px of a 1280 px slide').toBeGreaterThanOrEqual(18);
  }
});
