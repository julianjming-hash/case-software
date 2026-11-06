// CASE-344 (Builder PR, step B2): the simplified Builder. One contextual inspector; a "+" in every free area that starts a
// text block, with "/" as its first character opening the kind menu; settling to the kind; synced blocks; Check; the ⋯ menu.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { iconNodes } from '../src/shared/icons.mjs';
import { paragraphsText } from '../src/shared/slide-document.mjs';
import * as ops from '../src/shared/slide-edit.mjs';
import { startServers, openEditor, inspectorOf, slideOf, roomyPair, startSlide } from '../tests/helpers/builder-simplify-fixture.mjs';

test.use({ ignoreHTTPSErrors: true });
let servers;
test.beforeAll(async () => { servers = await startServers(); });
test.afterAll(async () => { await servers?.stop(); });

const pluses = page => slideOf(page).getByRole('button', { name: 'Add a block here', exact: true });
const saveButton = page => page.getByRole('button', { name: 'Save draft', exact: true });
const undoButton = page => page.getByRole('button', { name: 'Undo', exact: true });

test('[AS-215] "+" then /ab then Enter makes a blood gas with the caret in pH; the slash query never reaches the draft or the undo stack', async ({ page }) => {
  const state = await openEditor(page, servers);
  await expect(saveButton(page)).toBeDisabled();
  await expect(undoButton(page)).toBeDisabled();
  await expect(pluses(page).first()).toBeVisible();
  await pluses(page).first().click();
  const fresh = slideOf(page).getByRole('combobox', { name: 'New block text', exact: true });
  await expect(fresh).toBeFocused();
  await page.keyboard.type('/ab');
  const menu = slideOf(page).getByRole('listbox', { name: 'Blocks', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option').first()).toHaveText(/Arterial blood gas/);
  await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await inBothThemes(page, 'slash-menu', '.builder-slide');
  // The query is the editor's own: the draft is untouched, nothing is saved, and Undo has nothing to undo.
  await expect(saveButton(page)).toBeDisabled();
  await expect(undoButton(page)).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(slideOf(page).locator('.slide-gas-title')).toHaveText('Arterial blood gas');
  const pH = inspectorOf(page).getByLabel('pH value', { exact: true });
  await expect(pH).toBeFocused();
  await page.keyboard.type('7.47');
  await expect(pH).toHaveValue('7.47');
  // Create and convert are one history step (the typed value is a second, coalesced one): two Undos clear them both,
  // and nothing the slash query held is left behind.
  await undoButton(page).click();
  await undoButton(page).click();
  await expect(undoButton(page)).toBeDisabled();
  await expect(slideOf(page).locator('.slide-gas-title')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  const saved = state.pair.document, gas = saved.blocks.filter(item => item.type === 'gas');
  expect(gas).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toContain('/ab');
  const opening = startSlide(saved), placed = opening.placements.find(item => item.block_id === gas[0].id);
  expect(placed).toMatchObject({ w: expect.any(Number) });
  expect(JSON.stringify(gas[0])).toContain('7.47');
});

test('[AS-215] Esc keeps the text, Backspace on an empty new block removes it, and plain words make a text block in that area', async ({ page }) => {
  const state = await openEditor(page, servers);
  // Backspace on an empty new block removes it: no block, no draft change.
  await pluses(page).first().click();
  await expect(slideOf(page).getByRole('combobox', { name: 'New block text', exact: true })).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(slideOf(page).getByRole('combobox', { name: 'New block text', exact: true })).toHaveCount(0);
  await expect(saveButton(page)).toBeDisabled();
  // Esc keeps the typed "/" text as a text block.
  await pluses(page).first().click();
  await page.keyboard.type('/zz');
  await expect(slideOf(page).getByRole('listbox', { name: 'Blocks', exact: true })).toContainText('No block by that name');
  await page.keyboard.press('Escape');
  await expect(slideOf(page).getByRole('combobox', { name: 'New block text', exact: true })).toHaveCount(0);
  await expect(slideOf(page).getByLabel('Slide text').filter({ hasText: '/zz' })).toBeVisible();
  // Plain words become a text block in the area, with the caret after them.
  await page.locator('.builder-slide .slide-canvas').click({ position: { x: 3, y: 3 } });
  await pluses(page).first().click();
  await page.keyboard.type('Hello');
  await expect(slideOf(page).getByLabel('Slide text').filter({ hasText: 'Hello' })).toBeFocused();
  await page.keyboard.type(' there');
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  const texts = state.pair.document.blocks.filter(item => item.paragraphs).map(item => paragraphsText(item.paragraphs));
  expect(texts).toContain('/zz');
  expect(texts).toContain('Hello there');
});

const usesOnly = (document, id) => document.compositions.filter(item => item.reading_order.includes(id)).length === 1;
// SHOTS names a directory to leave a light and a dark screenshot of each new surface in (the orchestrator's review).
const SHOTS = process.env.SHOTS;
/** Light and dark, with axe over the named region; a screenshot per theme for the orchestrator when SHOTS is set. */
async function inBothThemes(page, name, scope, { shot = true } = {}) {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    // Colours ease between themes (.12 s); axe reads the settled ones.
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).include(scope).analyze();
    expect(results.violations.map(item => `${item.id}: ${item.nodes.map(node => node.target.join(' ')).slice(0, 2).join(', ')}`), `${name} (${theme})`).toEqual([]);
    if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/builder-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('[AS-216] a new block settles to its kind inside the area it was born in and moves no other block', async ({ page }) => {
  const pair = roomyPair(), before = startSlide(pair.document).placements, areas = ops.freeAreas(before);
  const state = await openEditor(page, servers, pair);
  await expect(pluses(page)).toHaveCount(areas.length);
  // The first "+" is the largest free area: a warning callout settles to three rows of it.
  await pluses(page).first().click();
  await page.keyboard.type('/warn');
  await page.keyboard.press('Enter');
  await expect(slideOf(page).locator('.slide-callout')).toBeVisible();
  await page.locator('.builder-slide .slide-canvas').click({ position: { x: 3, y: 3 } });
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  let saved = state.pair.document, opening = startSlide(saved);
  const callout = saved.blocks.find(item => item.type === 'callout');
  expect(opening.placements.find(item => item.block_id === callout.id)).toEqual({ block_id: callout.id, ...ops.settle('callout', areas[0], callout) });
  for (const item of before) expect(opening.placements.find(entry => entry.block_id === item.block_id)).toEqual(item);
  expect(callout.icon).toBe('alert');
  expect(opening.styles.find(item => item.block_id === callout.id).tone).toBe('amber');
  // Another area, another kind: a table takes its rows (at least five), and again nothing else moves.
  const later = ops.freeAreas(opening.placements);
  await expect(pluses(page)).toHaveCount(later.length);
  await pluses(page).first().click();
  await page.keyboard.type('/obs');
  await page.keyboard.press('Enter');
  await expect(slideOf(page).locator('.slide-table')).toBeVisible();
  await page.locator('.builder-slide .slide-canvas').click({ position: { x: 3, y: 3 } });
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  saved = state.pair.document; opening = startSlide(saved);
  const table = saved.blocks.find(item => item.type === 'table');
  expect(opening.placements.find(item => item.block_id === table.id)).toEqual({ block_id: table.id, ...ops.settle('table', later[0], table) });
  for (const item of [...before, { block_id: callout.id, ...ops.settle('callout', areas[0], callout) }]) expect(opening.placements.find(entry => entry.block_id === item.block_id)).toEqual(item);
  expect(table.columns.map(column => column.label)).toEqual(['Time', 'Observation', 'Value', 'Unit']);
});

test('[AS-217] Show on other slides, Also on and Unsync this slide, each slide keeping its own reveal step', async ({ page }) => {
  const state = await openEditor(page, servers);
  await pluses(page).first().click();
  await page.keyboard.type('Vitals');
  const text = slideOf(page).getByLabel('Slide text').filter({ hasText: 'Vitals' });
  await expect(text).toBeFocused();
  const panel = inspectorOf(page);
  await expect(panel.getByRole('heading', { name: 'Text', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Show on other slides…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show on other slides' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox').first()).toBeDisabled();
  await expect(dialog.getByRole('checkbox').first()).toBeChecked();
  await inBothThemes(page, 'sync-picker', '.builder-sync-dialog');
  const boxes = dialog.getByRole('checkbox'), total = await boxes.count();
  expect(total).toBeGreaterThan(2);
  await boxes.nth(1).check(); await boxes.nth(2).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Outlined on hover and selection, and it says how many slides show it.
  const shown = slideOf(page).locator('[data-synced]');
  await expect(shown).toHaveCount(1);
  await expect(shown.locator('.builder-shared-note')).toHaveText('On 3 slides');
  await expect(panel.getByText('Synced · on 3 slides')).toBeVisible();
  const also = panel.getByRole('group', { name: 'Also on', exact: true }).getByRole('button');
  await expect(also).toHaveCount(2);
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  let saved = state.pair.document;
  const synced = saved.blocks.find(item => item.paragraphs && paragraphsText(item.paragraphs) === 'Vitals');
  const uses = saved.compositions.filter(item => item.reading_order.includes(synced.id));
  expect(uses).toHaveLength(3);
  // Each slide has its own reveal step and its own placement for the one shared block.
  const steps = uses.map(item => item.steps.find(step => step.block_ids.includes(synced.id)).id);
  expect(new Set(steps).size).toBe(3);
  // Its own slide places it; a slide with no room for it keeps it unplaced (listed under the slide), never over another block.
  expect(startSlide(saved).placements.some(entry => entry.block_id === synced.id)).toBe(true);
  // “Also on” opens that slide with the block selected; Unsync there gives it its own copy and leaves the others sharing.
  await also.first().click();
  await expect(slideOf(page).locator('[data-synced]')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Unsync this slide', exact: true })).toBeVisible();
  await inBothThemes(page, 'inspector-synced-block', '.builder-inspector', { shot: true });
  await panel.getByRole('button', { name: 'Unsync this slide', exact: true }).click();
  await expect(slideOf(page).locator('[data-synced]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Show on other slides…', exact: true })).toBeVisible();
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  saved = state.pair.document;
  expect(saved.compositions.filter(item => item.reading_order.includes(synced.id))).toHaveLength(2);
  expect(saved.blocks.filter(item => item.paragraphs && paragraphsText(item.paragraphs) === 'Vitals')).toHaveLength(2);
  // Each slide keeps its own reveal step: moving this slide's copy to On entry touches no other slide.
  const mine = saved.compositions.find(item => item.reading_order.some(id => saved.blocks.find(block => block.id === id)?.paragraphs && paragraphsText(saved.blocks.find(block => block.id === id).paragraphs) === 'Vitals' && usesOnly(saved, id)));
  const shared = saved.compositions.filter(item => item.reading_order.includes(synced.id)), sharedBefore = JSON.stringify(shared.map(item => item.steps));
  await panel.locator('select[aria-label="Reveal"]').selectOption({ index: 0 }, { force: true });
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  const now = state.pair.document;
  expect(JSON.stringify(now.compositions.filter(item => item.reading_order.includes(synced.id)).map(item => item.steps))).toBe(sharedBefore);
  const after = now.compositions.find(item => item.id === mine.id), copy = after.reading_order.find(id => now.blocks.find(block => block.id === id)?.paragraphs && paragraphsText(now.blocks.find(block => block.id === id).paragraphs) === 'Vitals');
  expect(after.steps[0].block_ids).toContain(copy);
});

const must = result => { if (!result.ok) throw new Error(result.reason); return result.document; };

test('[AS-218] a callout takes a tone and an icon, drawn the same on the projector, the phone and the PDF; a quote converts only when it is edited', async ({ page }) => {
  const state = await openEditor(page, servers);
  const panel = inspectorOf(page);
  await panel.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Callout', exact: true }).click();
  await slideOf(page).getByLabel('Callout text', { exact: true }).fill('Salbutamol used all night');
  await expect(slideOf(page).locator('.slide-callout.slide-centred')).toHaveCount(1);
  await expect(panel.locator('.builder-inspector-title')).toHaveText('Callout');
  await panel.getByRole('group', { name: 'Tone', exact: true }).getByRole('button', { name: 'Warning', exact: true }).click();
  await panel.getByRole('group', { name: 'Icon', exact: true }).getByRole('button', { name: 'Alert', exact: true }).click();
  const drawn = slideOf(page).locator('.slide-callout.slide-centred svg');
  await expect(drawn).toHaveCount(1);
  await expect(drawn.locator('path').first()).toBeVisible();
  await panel.locator('select[aria-label="Reveal"]').selectOption({ index: 0 }, { force: true });
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  const saved = state.pair.document, callout = saved.blocks.find(item => item.type === 'callout');
  expect(callout.icon).toBe('alert');
  expect(saved.required_capabilities).toContain('callout_icon');
  expect(startSlide(saved).styles.find(item => item.block_id === callout.id).tone).toBe('amber');
  // The projector (grid), the phone (reflow) and the PDF draw the one icon the Builder saved, centred.
  const { slidePlan } = await import('../src/client/slide-render.mjs'), { briefingRows } = await import('../src/client/briefing.mjs'), { entryLines } = await import('../src/client/recap-journey.mjs');
  const alone = { blocks: [callout], composition: { id: 'c', owner: { kind: 'beat', id: 'b' }, template: 'blank', placements: [{ block_id: callout.id, col: 1, row: 1, w: 12, h: 4 }], reading_order: [callout.id], steps: [{ id: 's', block_ids: [callout.id] }], styles: [] } };
  const find = (node, test) => test(node) ? [node] : (node.children ?? []).flatMap(child => find(child, test));
  const icons = ['grid', 'reflow'].map(layout => { const [plan] = slidePlan(alone, { layout }).root.children; expect(plan.cls).toMatch(/slide-centred/); return find(plan, item => item.tag === 'svg').map(item => item.icon); });
  expect(icons).toEqual([['alert'], ['alert']]);
  expect(JSON.stringify(briefingRows(saved))).toContain('"icon":"alert"');
  expect(entryLines({ title: 'Start', slide: { blocks: [callout] } }).map(line => line.i)).toEqual(['alert']);
  await inBothThemes(page, 'inspector-callout', '.builder-inspector');
  const [preview] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  try {
    await expect(preview.locator('.run-preview-status')).toContainText('Following your edits');
    for (const theme of ['light', 'dark']) {
      await preview.emulateMedia({ colorScheme: theme });
      for (const title of ['Projector', 'Phone']) {
        const rendered = preview.frameLocator(`iframe[title="${title}"]`).locator('.slide-callout.slide-centred > aside');
        await expect(rendered).toContainText('Salbutamol used all night');
        await expect(rendered.locator('svg path').first()).toBeVisible();
        const actual = await rendered.evaluate(aside => {
          const svg = aside.querySelector('svg'), text = aside.querySelector('.slide-callout-text'), style = getComputedStyle(aside);
          const box = aside.getBoundingClientRect(), icon = svg.getBoundingClientRect(), words = text.getBoundingClientRect();
          return { nodes: [...svg.children].map(child => [child.tagName, Object.fromEntries([...child.attributes].map(a => [a.name, a.value]))]),
            display: style.display, align: style.alignItems, offset: Math.abs(icon.top + icon.height / 2 - words.top - words.height / 2),
            contained: [icon, words].every(b => b.left >= box.left - 1 && b.right <= box.right + 1 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1),
            overflows: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1 };
        });
        expect(actual.nodes).toEqual(iconNodes('alert'));
        expect(actual).toMatchObject({ display: 'flex', align: 'center', contained: true, overflows: false });
        expect(actual.offset).toBeLessThanOrEqual(2);
        if (process.env.SHOTS) await rendered.screenshot({ path: `${process.env.SHOTS}/builder-callout-${title.toLowerCase()}-${theme}.png` });
      }
    }
  } finally { await preview.close(); }

});

test('[AS-218] an old quote renders as it was and converts to a Plain callout with the quote icon only when its author edits it', async ({ page }) => {
  const pair = roomyPair(), opening = startSlide(pair.document);
  const added = ops.addBlock(pair.document, opening.id, 'quote', (await import('../src/shared/ids.mjs')).uuidv7);
  pair.document = must(ops.setParagraphs(must(added), added.blockId, [{ runs: [{ text: 'First, do no harm' }] }]));
  const state = await openEditor(page, servers, pair);
  await expect(slideOf(page).locator('blockquote')).toContainText('First, do no harm');
  await expect(saveButton(page)).toBeDisabled();
  expect(state.puts).toEqual([]);
  // Selecting it, and looking, changes nothing.
  await slideOf(page).locator('blockquote').click();
  await slideOf(page).getByLabel('Quote text', { exact: true }).click();
  await expect(saveButton(page)).toBeDisabled();
  await page.keyboard.press('End'); await page.keyboard.type('.');
  await expect(slideOf(page).getByLabel('Callout text', { exact: true })).toContainText('First, do no harm.');
  await saveButton(page).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  const saved = state.pair.document, block = saved.blocks.find(item => item.id === added.blockId);
  expect(block).toMatchObject({ type: 'callout', icon: 'quote' });
  expect(paragraphsText(block.paragraphs)).toBe('First, do no harm.');
  expect(saved.required_capabilities).toContain('callout_icon');
  // The edit and the conversion are one history step.
  await undoButton(page).click();
  await expect(undoButton(page)).toBeDisabled();
  await expect(slideOf(page).locator('blockquote')).toContainText('First, do no harm');
  // An older build refuses the capability by its name.
  const { validateBuilderDocument } = await import('../src/shared/builder-document.mjs'), { validateSlideParts } = await import('../src/shared/slide-document.mjs');
  const refused = validateBuilderDocument({ ...saved, required_capabilities: [...saved.required_capabilities, 'callout_icon_v9'] }, { metadata_version: 1 }, { mode: 'preserve', validateSlides: validateSlideParts });
  expect(refused.ok).toBe(false);
  expect(JSON.stringify(refused.errors)).toContain('callout_icon_v9');
});

test('[AS-219] one contextual inspector: no tabs and no Tools panel; the slide\'s with nothing selected, the block\'s when one is', async ({ page }) => {
  await openEditor(page, servers);
  const panel = inspectorOf(page);
  await expect(page.getByRole('heading', { name: 'Inspector', exact: true })).toBeVisible();
  for (const name of ['Layout', 'Block', 'Block order', 'Tools']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toHaveCount(0);
  // Nothing selected: Add a block (seven), the reveal order as one list, layout and fill folded.
  const add = panel.getByRole('group', { name: 'Add block', exact: true });
  await expect(add.getByRole('button')).toHaveText([/^Text/, /^Callout/, /^Table/, /^Values/, /^Chart/, /^Blood gas/, /^Image/]);
  await expect(panel.getByText('Presets')).toHaveCount(0);
  await expect(panel.getByText('Reveal order', { exact: false }).first()).toBeVisible();
  await expect(panel.locator('details.builder-layout-fold')).not.toHaveAttribute('open', '');
  await panel.getByText('Layout and fill', { exact: false }).click();
  await expect(panel.getByRole('button', { name: 'Blank', exact: true })).toBeVisible();
  await panel.getByText('Layout and fill', { exact: false }).click();
  await inBothThemes(page, 'inspector-nothing-selected', '.builder-inspector');
  // A block selected: that block, with a way back to the slide.
  await add.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(panel.locator('.builder-inspector-title')).toHaveText('Table');
  await expect(panel.getByRole('button', { name: '← This slide', exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Add block', exact: true })).toHaveCount(0);
  await inBothThemes(page, 'inspector-block-selected', '.builder-inspector');
  await panel.getByRole('button', { name: '← This slide', exact: true }).click();
  await expect(panel.getByRole('group', { name: 'Add block', exact: true })).toBeVisible();
});

test('[AS-219] Check gathers every blocker in one list with Fix to the field, drops image approval, and the ⋯ menu holds Import and export, Checkpoints, Case details and Archive', async ({ page }) => {
  await openEditor(page, servers);
  // An empty callout is a blocker; the service's image-approval item (the mock returns one) is not.
  await inspectorOf(page).getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Callout', exact: true }).click();
  await page.locator('.builder-slide .slide-canvas').click({ position: { x: 3, y: 3 } });
  const check = page.getByRole('button', { name: /^Check/ });
  await expect(check).toBeVisible();
  const menu = page.getByRole('button', { name: 'More', exact: true });
  await menu.click();
  const items = page.getByRole('group', { name: 'More', exact: true }).getByRole('button');
  await expect(items).toHaveText(['Back to Create', 'Import and export', 'Manage checkpoints', 'Case details', 'Archive draft…']);
  await inBothThemes(page, 'more-menu', '.builder-menu');
  await page.keyboard.press('Escape');
  await check.click();
  const dialog = page.getByRole('dialog', { name: 'Check' });
  await expect(dialog).toBeVisible();
  // Blockers are one list, each with Fix; the service's image-approval item is not among them.
  await expect(dialog).not.toContainText(/approval|awaiting/i);
  const fixes = dialog.getByRole('button', { name: /^Fix/ });
  expect(await fixes.count()).toBeGreaterThan(0);
  await inBothThemes(page, 'check', '.builder-check-dialog');
  const first = await fixes.first().getAttribute('aria-label');
  await fixes.first().click();
  await expect(dialog).toHaveCount(0);
  expect(first).toMatch(/^Fix: /);
  // Fix lands on the field: focus is in the studio on an editable control.
  await expect.poll(() => page.evaluate(() => { const at = document.activeElement; return Boolean(at && at !== document.body && /INPUT|TEXTAREA|SELECT|BUTTON/.test(at.tagName) || at?.isContentEditable); })).toBe(true);
});

test('[AS-219] Import and export opens from the ⋯ menu in its own dialog; a file that replaces the draft there leaves no Reconcile save behind', async ({ page }) => {
  await openEditor(page, servers);
  const reconcile = page.getByRole('button', { name: 'Reconcile save', exact: true });
  await expect(reconcile).toBeHidden();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Import and export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import and export' });
  const transfer = dialog.getByRole('region', { name: 'Transfer Builder draft', exact: true });
  await expect(transfer).toBeVisible();
  await inBothThemes(page, 'import-export', '.builder-transfer-dialog');
  // Download the saved draft once, choose that file again and replace the draft with it.
  const download = page.waitForEvent('download');
  await transfer.getByRole('button', { name: 'Download this case', exact: true }).click();
  const file = await (await download).path();
  await transfer.getByLabel('Choose a transfer JSON file', { exact: true }).setInputFiles(file);
  await expect(transfer.getByRole('button', { name: 'Replace this draft', exact: true })).toBeEnabled();
  await transfer.getByRole('button', { name: 'Replace this draft', exact: true }).click();
  await expect(transfer.getByRole('status')).toContainText('replaced by the file');
  await expect(reconcile).toBeHidden();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused();
});

test('[AS-219] a save the service took but never answered is uncertain; Reconcile save reads its receipt and clears, and replacing the draft from a file leaves it settled', async ({ page }) => {
  let lose = false;
  const state = await openEditor(page, servers, roomyPair(), { failSave: () => lose });
  const reconcile = page.getByRole('button', { name: 'Reconcile save', exact: true });
  await expect(reconcile).toBeHidden();
  await pluses(page).first().click();
  await page.keyboard.type('Uncertain');
  lose = 'after';
  await saveButton(page).click();
  await expect(reconcile).toBeVisible();
  expect(state.puts).toEqual([2]);
  await reconcile.click();
  await expect(reconcile).toBeHidden();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  // With nothing uncertain, replacing the draft from a file leaves the button hidden too.
  lose = false;
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Import and export', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: 'Import and export' }).getByRole('region', { name: 'Transfer Builder draft', exact: true });
  const download = page.waitForEvent('download');
  await transfer.getByRole('button', { name: 'Download this case', exact: true }).click();
  await transfer.getByLabel('Choose a transfer JSON file', { exact: true }).setInputFiles(await (await download).path());
  await transfer.getByRole('button', { name: 'Replace this draft', exact: true }).click();
  await expect(transfer.getByRole('status')).toContainText('replaced by the file');
  await expect(reconcile).toBeHidden();
});

test('[AS-215] an image entry opens the image chooser first; cancelling it leaves the new block and its text where they were, and the draft untouched', async ({ page }) => {
  await page.route(url => /\/api\/v1\/builder\/workspaces\/[^/]+\/assets$/.test(url.pathname), route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assets: [] }) }));
  await openEditor(page, servers);
  await pluses(page).first().click();
  await page.keyboard.type('/image');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Image or ECG' });
  await expect(dialog).toBeVisible();
  // The chooser took the focus, and the words typed so far were not turned into a text block.
  await expect(saveButton(page)).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const fresh = slideOf(page).getByRole('combobox', { name: 'New block text', exact: true });
  await expect(fresh).toBeFocused();
  await expect(fresh).toHaveText('/image');
  await expect(saveButton(page)).toBeDisabled();
  await expect(undoButton(page)).toBeDisabled();
});
