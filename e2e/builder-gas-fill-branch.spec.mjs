// CASE-311 blood gas, CASE-312 slide fill, CASE-313 branch badge: an author builds a gas and fills a slide with real input in the
// Builder, and the Run preview's real projector and phone draw the gas, the fill and the badge. Local workerd and fakes only.
import { test, expect } from '@playwright/test';
import { start, stop, mvcSchema2, openBuilder, slide, shot } from '../tests/design-critique/harness.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { decisionBranches } from '../src/shared/decision-branches.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start);
test.afterAll(stop);

function slidesPair() {
  const { document, authoringMetadata } = mvcSchema2();
  document.title = 'Gas, fill and branch fixture';
  const converted = convertToSlideDocument(document, authoringMetadata, { createId: uuidv7 }).candidate;
  return { document: converted.document, authoringMetadata: converted.authoringMetadata };
}
const ok = result => { if (!result.ok) throw new Error(result.reason); return result.document; };
const startComposition = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const ground = locator => locator.evaluate(node => {
  // The fill's token as this element resolves it (theme and appearance included), against the painted background.
  const probe = node.ownerDocument.createElement('i'); probe.style.background = `var(--slide-fill-${[...node.classList].find(c => c.startsWith('slide-fill-')).slice(11)})`;
  node.append(probe); const want = getComputedStyle(probe).backgroundColor; probe.remove();
  return { painted: getComputedStyle(node).backgroundColor, want };
});

test('[AS-182] [AS-183] an author types a blood gas and fills the slide; the canvas draws only typed rows, flagged, on the fill in light and dark', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The opening keeps only its title, so the palette finds room and places the gas on the slide.
  const pair = slidesPair(), opening = startComposition(pair.document);
  for (const blockId of opening.reading_order.slice(1)) pair.document = ok(edit.removeBlock(pair.document, opening.id, blockId));
  const state = await openBuilder(page, pair);
  await expect(slide(page)).toBeVisible();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Blood gas', exact: true }).click();
  const gas = slide(page).locator('.slide-canvas .slide-block.slide-gas');
  await expect(gas).toHaveCount(1);
  await expect(slide(page).getByText(/unplaced block/)).toHaveCount(0);
  // A new report shows its heading and no rows: every row waits for a value.
  await expect(gas.locator('.slide-gas-title')).toHaveText('Arterial blood gas');
  await expect(gas.locator('.slide-gas-table')).toHaveCount(0);
  await tools.getByLabel('Caption', { exact: true }).fill('10:40 · FiO2 0.6');
  await tools.getByLabel('pH value', { exact: true }).pressSequentially('7.21');
  await tools.getByLabel('pCO2 value', { exact: true }).pressSequentially('60');
  await tools.getByLabel('cLac value', { exact: true }).pressSequentially('1.8');
  await expect(gas.locator('.slide-gas-table tbody tr')).toHaveCount(3);
  await expect(gas.locator('.slide-gas-table caption')).toHaveText(['Blood gas values', 'Metabolites']);
  await expect(gas.locator('tr.slide-gas-high th')).toHaveText('pCO2');
  await expect(gas.locator('tr.slide-gas-low th')).toHaveText('pH');
  await expect(gas.locator('tr.slide-gas-high .slide-gas-flag')).toHaveText('↑High:');
  await expect(gas.locator('.slide-gas-title')).toHaveText('Arterial blood gas · 10:40 · FiO2 0.6');
  // Slide fill, from Layout: the canvas paints the fill's token.
  await tools.getByRole('button', { name: '← This slide', exact: true }).click();
  await tools.getByText('Layout and fill', { exact: false }).click();
  await tools.getByRole('group', { name: 'Slide fill', exact: true }).getByRole('button', { name: 'Teal', exact: true }).click();
  const canvas = slide(page).locator('.slide-canvas').first();
  await expect(canvas).toHaveClass(/\bslide-fill-teal\b/);
  // Once the fit check has run, every report cell sits inside the block's box.
  await expect(page.getByText('Checking fit…')).toHaveCount(0);
  const spill = await gas.evaluate(block => { const box = block.getBoundingClientRect(); return [...block.querySelectorAll('td, th, caption, .slide-gas-title')].map(cell => cell.getBoundingClientRect()).filter(r => r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5).length; });
  expect(spill).toBe(0);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const { painted, want } = await ground(canvas);
    expect(painted).toBe(want);
    await shot(page, `case-310-builder-gas-fill-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // What the author built is what is saved.
  await expect.poll(() => state.puts).toBeGreaterThan(0);
  await expect.poll(() => startComposition(state.pair.document).fill).toBe('teal');
  const saved = state.pair.document.blocks.find(block => block.type === 'gas');
  expect(saved.groups.flatMap(group => group.rows).filter(row => row.value).map(row => `${row.label}=${row.value}`)).toEqual(['pH=7.21', 'pCO2=60', 'cLac=1.8']);
});

test('[AS-184] [AS-183] the Run preview\'s projector and phone draw the gas on its fill, and the branch badge on a branching question', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const pair = slidesPair();
  let document = pair.document;
  const opening = startComposition(document);
  // The opening keeps its title and gives the rest of the slide to the gas (the fixture's slides are full).
  for (const blockId of opening.reading_order.slice(1)) document = ok(edit.removeBlock(document, opening.id, blockId));
  document = ok(edit.addBlock(document, opening.id, 'gas', uuidv7));
  const gas = document.blocks.find(block => block.type === 'gas');
  for (const [label, value] of [['pH', '7.21'], ['pCO2', '60'], ['cHCO3−', '23']]) document = ok(edit.setGasRow(document, gas.id, gas.groups.flatMap(group => group.rows).find(row => row.label === label).id, 'value', value));
  document = ok(edit.setFill(document, opening.id, 'amber'));
  const decision = document.decisions[0];
  expect(decisionBranches(decision)).toBe(true);
  const checked = validateBuilderDocument(document, pair.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
  expect(checked.ok, JSON.stringify(checked.errors?.slice(0, 3))).toBe(true);
  await openBuilder(page, { document, authoringMetadata: pair.authoringMetadata });
  await page.goto(page.url().replace(/\/edit(?:\/[a-z]+)?(\?.*)?$/, '/edit/preview$1'));
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.getByRole('heading', { name: `Preview · shown here · ${document.title}`, exact: true })).toBeVisible();
  const projector = preview.frameLocator('iframe[title="Projector"]'), phone = preview.frameLocator('iframe[title="Phone"]');
  await preview.getByRole('button', { name: 'Restart preview', exact: true }).click();
  const primary = preview.locator('.run-preview-rail .console-primary');
  await primary.click();
  // The opening slide: the gas (its own reveal step) on its amber fill, only the typed rows.
  for (let i = 0; i < 6 && !(await projector.locator('.slide-gas-table').count()); i++) await primary.click();
  await expect(projector.locator('.slide-gas-table tbody tr')).toHaveCount(3);
  await expect(projector.locator('.slide-canvas.slide-fill-amber')).toHaveCount(1);
  await expect(phone.locator('.slide-gas-table tbody tr')).toHaveCount(3);
  await expect(phone.locator('.slide-canvas.slide-fill-amber')).toHaveCount(1);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const { painted, want } = await ground(projector.locator('.slide-canvas.slide-fill-amber'));
    expect(painted).toBe(want);
    await shot(page, `case-309-preview-gas-fill-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // Step on to the question; the badge is there on both screens while it is open, with its spoken name.
  for (let i = 0; i < 12 && !(await projector.locator('.decision').count()); i++) await primary.click();
  await expect(projector.locator('.decision .branch-badge')).toBeVisible();
  await expect(projector.locator('.decision .branch-badge')).toHaveAttribute('title', 'Branching question');
  // Top right of the question card, inside it, clear of the prompt line.
  const corner = box => box.evaluate(card => {
    const badge = card.querySelector('.branch-badge').getBoundingClientRect(), outer = card.getBoundingClientRect();
    return { right: outer.right - badge.right, top: badge.top - outer.top, width: badge.width, card: outer.width };
  });
  for (const at of [await corner(projector.locator('.decision'))]) {
    expect(at.card).toBeGreaterThan(100); expect(at.width).toBeGreaterThan(8);
    expect(at.right).toBeGreaterThanOrEqual(0); expect(at.right).toBeLessThan(40);
    expect(at.top).toBeGreaterThanOrEqual(0); expect(at.top).toBeLessThan(40);
  }
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(page, `case-311-preview-branch-projector-${scheme}`); }
  // At this width the Run preview shows a phone on demand: a learner's chip opens theirs.
  await preview.getByRole('group', { name: 'Phone of', exact: true }).getByRole('button').first().click();
  await expect(phone.locator('.decision .branch-badge')).toBeVisible();
  const onPhone = await corner(phone.locator('.decision'));
  expect(onPhone.card).toBeGreaterThan(100); expect(onPhone.width).toBeGreaterThan(8);
  expect(onPhone.right).toBeGreaterThanOrEqual(0); expect(onPhone.right).toBeLessThan(40); expect(onPhone.top).toBeLessThan(40);
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await shot(page, `case-311-preview-branch-phone-${scheme}`); }
});
