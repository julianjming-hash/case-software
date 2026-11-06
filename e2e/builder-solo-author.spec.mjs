// AS-166: a clinician-author editing a case alone never meets a dead end (Builder round 28, CASE-267). Each check is a
// finding of the round 28 critique (docs/plans/2026-10-16-builder-critique-round-28.md), as the author sees it: the
// first sentence on a new stage can be read as it is typed; every Readiness item opens the field it names; a fixed field
// stops saying it is wrong; Delete after Escape removes the block; a fixed-layout draft says where slides are. (A chosen
// route revealed by Space alone is in keymap.spec.mjs and tests/keymap.test.mjs.) Every check fails on main eeb5a66.
import { test, expect } from '@playwright/test';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { start, stop, divingSlides, mvcSchema2, openBuilder, slide } from '../tests/design-critique/harness.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start); test.afterAll(stop);
const must = result => { if (!result.ok) throw new Error(result.reason); return result.document; };
const opening = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const readiness = async page => {
  const zone = page.locator('.builder-zone-readiness');
  if (!(await zone.evaluate(node => node.open))) await zone.locator(':scope > summary').click();
  return zone;
};

test('[AS-166] the first sentence on a new stage is written across the slide, never in a sliver, and selecting the empty block moves nothing (P1-1)', async ({ page }) => {
  // A teaching stage's slide (a decision's slide keeps its question): its title, then one empty text block.
  const pair = await divingSlides(), teaching = pair.document.beats.find(beat => !beat.decision_id && beat.id !== pair.document.start_beat_id);
  const record = pair.document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === teaching.id), heading = record.reading_order[0];
  let document = pair.document;
  for (const id of record.reading_order.slice(1)) document = must(edit.removeBlock(document, record.id, id));
  const blank = { id: uuidv7(), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: '' }] }] }, target = document.compositions.find(item => item.id === record.id);
  document.blocks.push(blank); target.reading_order.push(blank.id); target.steps[0].block_ids.push(blank.id);
  target.placements = [{ ...target.placements.find(item => item.block_id === heading), col: 1, row: 1, w: 12, h: 2 }, { block_id: blank.id, col: 1, row: 3, w: 6, h: 3 }];
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, { ...pair, document });
  await page.locator('.builder-outline-target', { hasText: teaching.title }).first().click();
  const block = slide(page).locator(`.slide-canvas > .slide-block[data-block-id="${blank.id}"]`);
  await expect(block).toHaveAttribute('data-hero-wide', '');
  const box = () => block.evaluate(node => { const b = node.getBoundingClientRect(), c = node.parentElement.getBoundingClientRect(); return { x: b.x - c.x, w: b.width, canvas: c.width }; });
  const before = await box();
  expect(before.w, 'the empty hero spans the slide').toBeGreaterThan(before.canvas * .5);
  await block.click();
  const selected = await box();
  expect(Math.abs(selected.x - before.x), 'selecting moves nothing').toBeLessThanOrEqual(1);
  expect(Math.abs(selected.w - before.w), 'selecting resizes nothing').toBeLessThanOrEqual(1);
  await page.keyboard.type('A woman in her late thirties is referred after six dives and a flight home, with tingling in both hands.', { delay: 5 });
  const editor = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  const shown = () => editor.evaluate(node => ({ w: node.getBoundingClientRect().width, scroll: node.scrollHeight, client: node.clientHeight,
    line: parseFloat(getComputedStyle(node).lineHeight) || parseFloat(getComputedStyle(node).fontSize) * 1.4, canvas: node.closest('.slide-canvas').getBoundingClientRect().width }));
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(700); // past the typing catch-up and the fit pass
    const text = await shown();
    expect(text.w, `${width}: the editor is at least half the slide`).toBeGreaterThanOrEqual(text.canvas * .5);
    expect(text.scroll, `${width}: the sentence is on screen as it is typed`).toBeLessThanOrEqual(text.client + text.line);
  }
});

test('[AS-166] Readiness items name their field and open it; Case details follows the draft; a trend names its field; Delete after Escape removes the block (P1-2, P2-1, P2-5, P2-3)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  Object.assign(pair.document, { summary: '', audience: '', setting: '', learning_objectives: [] });
  pair.document = must(edit.addBlock(pair.document, opening(pair.document).id, 'trend', uuidv7));
  const trend = pair.document.blocks.at(-1);
  await openBuilder(page, pair);
  const zone = await readiness(page);
  for (const [item, field] of [['Write the case summary', 'Case summary'], ['Name the audience', 'Audience'], ['Name the setting', 'Setting']]) {
    await zone.getByRole('button', { name: new RegExp(`^Case: ${item}`) }).click();
    await expect(page.getByRole('textbox', { name: field, exact: true })).toBeFocused();
  }
  // P2-1: an empty required field says Required in plain words; once filled it stops saying it is wrong.
  const summary = page.getByRole('textbox', { name: 'Case summary', exact: true });
  await expect(summary).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.builder-studio').getByText('Required.', { exact: true }).first()).toBeVisible();
  await summary.click(); await page.keyboard.type('A diver with a fever.');
  await expect(summary).not.toHaveAttribute('aria-invalid', 'true');
  await expect(zone.getByRole('button', { name: /^Case: Write the case summary/ })).toHaveCount(0);
  // "Add a learning objective" opens the button that adds one; the new field appears at once and takes focus.
  await zone.getByRole('button', { name: /^Case: Add a learning objective/ }).click();
  await expect(page.getByRole('button', { name: 'Add learning objective', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const objective = page.getByRole('textbox', { name: 'Learning objective 1', exact: true });
  await expect(objective).toBeFocused();
  await page.keyboard.type('Recognise anchoring on a referral label.');
  await expect(objective).toHaveValue('Recognise anchoring on a referral label.');
  expect(await page.getByRole('textbox', { name: /^Learning objective/ }).count(), 'one press, one objective').toBe(1);
  // P2-5: a trend chart's items say which field, and focus it in the Block tab.
  await zone.getByRole('button', { name: /Name the vertical axis/ }).first().click();
  await expect(page.locator(`[data-control-key="slide:${trend.id}:trend:y_label"]`)).toBeFocused();
  await zone.getByRole('button', { name: /Set the axis bottom/ }).first().click();
  await expect(page.locator(`[data-control-key="slide:${trend.id}:trend:y_min"]`)).toBeFocused();
  // P2-3: Escape leaves focus on the block's Edit button, and Delete there starts that block's reviewed removal.
  const block = slide(page).locator('.slide-canvas > .slide-block:not(.slide-question)').nth(1);
  await block.click(); await page.keyboard.press('Escape');
  await expect(page.locator(':focus')).toHaveClass(/builder-slide-edit/);
  await page.keyboard.press('Delete');
  await expect(page.getByText(/^Remove .* from this slide\?/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  // With nothing selected, Delete on the slide says how to select a block rather than doing nothing.
  await page.keyboard.press('Escape');
  await slide(page).locator('.slide-canvas').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Delete');
  await expect(page.locator('.builder-studio [role="status"]').filter({ hasText: 'No block is selected. Select a block, then press Delete.' }).first()).toBeVisible();
});

test('[AS-166] a fixed-layout draft says where slides are, on the canvas (P2-2)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, mvcSchema2());
  await page.getByRole('button', { name: 'Turn into slides…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review turning this draft into slides', exact: true })).toBeFocused();
});

// Round 29's P1s (docs/plans/2026-10-16-builder-critique-round-29.md on the round 29 branch), shipped alone so Julian
// has them while he edits Diving Deeper: every point of a menu item takes its own clicks (the sticky canvas head painted
// over More's first item), and a Run preview that cannot run names the field as Readiness does, with nothing live
// that cannot act.
test('[AS-166] menus open above the canvas head, and a Run preview that cannot run names its field with its controls at rest', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(); pair.document.summary = '';
  await openBuilder(page, pair);
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const missed = await page.locator('.builder-menu-list:not([hidden]) .builder-menu-item:visible').first().evaluate(item => {
      const box = item.getBoundingClientRect(), out = [];
      for (let x = Math.ceil(box.left + 1); x < box.right - 1; x += 4) for (const y of [box.top + 3, box.top + box.height / 2, box.bottom - 3]) if (!item.contains(document.elementFromPoint(x, y))) out.push(`${Math.round(x)},${Math.round(y)}`);
      return out;
    });
    expect(missed, `${width}: every point of the menu item takes its own clicks`).toEqual([]);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const [child] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  const blocked = child.locator('.run-preview-blocked');
  await expect(blocked).toContainText('Write the case summary (in Case details)');
  await expect(blocked).not.toContainText('Length must be');
  for (const name of ['Restart preview', 'Fewer learners', 'More learners', 'Online', 'Manual', '720p', '1080p']) await expect(child.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(child.locator('.run-preview-notes')).toBeHidden();
});
