// CASE-249 E and G (Julian, 2026-10-14). One keymap: the same key does the same thing in the Builder, the Run preview
// and the live console, and nothing where a surface has no such action. And the dock's main action keeps its place
// through a whole round, as its label, the counts, the phase and Undo change.
import { test, expect } from '@playwright/test';
import { controlsCase, startControlsHarness, captureLocalPublicFrames, openControlsDecision, primary, undo, route, mirror,
  joinApi, voteApi } from '../tests/helpers/live-console-controls.mjs';
import { start, stop, divingSlides, openBuilder, slide } from '../tests/design-critique/harness.mjs';
import { closeRoomSetup } from '../tests/helpers/console-v2.mjs';

test.use({ ignoreHTTPSErrors: true });
const blur = page => page.evaluate(() => { document.activeElement?.blur(); });
const sheet = page => page.locator('dialog.case-keys');
const confirm = page => page.locator('dialog.case-confirm');
const box = async locator => { const b = await locator.boundingBox(); return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };

/** The shared keys a room surface answers the same way: ? sheet (and nothing under it), and Escape's confirmation.
 *  CASE-251 (Julian, 2026-10-14): it opens on Cancel, so a stray Enter or Space only cancels (`unchanged` proves nothing
 *  ended); Tab reaches the red button `ask`, and Enter confirms it (`confirmed` proves it acted). */
async function sharedRoomKeys(page, { ask, unchanged, confirmed }) {
  await blur(page); await page.keyboard.press('Shift+?');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('Press the main action');
  await page.keyboard.press('Escape'); await expect(sheet(page)).toHaveCount(0);
  for (const stray of ['Enter', 'Space']) {
    await blur(page); await page.keyboard.press('Escape');
    await expect(confirm(page)).toBeVisible();
    await expect(confirm(page).getByRole('button', { name: 'Cancel', exact: true }), 'the confirmation opens on Cancel').toBeFocused();
    await page.keyboard.press(stray);
    await expect(confirm(page), `a stray ${stray} cancels`).toHaveCount(0);
    await unchanged();
  }
  await blur(page); await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(confirm(page).getByRole('button', { name: ask, exact: true }), 'Tab reaches the red button').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm(page)).toHaveCount(0);
  await confirmed();
}

test.describe('live console', () => {
  test.describe.configure({ mode: 'serial' });
  let harness, fixture;
  test.beforeAll(async () => { fixture = controlsCase(); harness = await startControlsHarness(fixture); });
  test.afterAll(async () => { await harness?.stop(); });

  test('[AS-160] Space presses the main action and asks twice for a route reveal; ⌘Z presses Undo; ← replays; ? and Escape', async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
    await captureLocalPublicFrames(context);
    try {
      const { page, room, commands } = await openControlsDecision(context, harness);
      await voteApi(harness, room, await joinApi(harness, room, 'Key Voter'), fixture.o.image);
      await expect(primary(page)).toHaveAttribute('aria-keyshortcuts', 'Space');
      // Enter is → (CASE-251): with no next step it does nothing, and never presses the main action (Lock here).
      const opened = commands.length;
      await blur(page); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
      expect(commands.length, 'Enter never presses the main action').toBe(opened);
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
      await blur(page); await page.keyboard.press('Space');
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
      // ⌘Z presses the Undo that is shown: here it takes back a route picked on this console (no room command).
      await route(page, 'Decompress').click(); await expect(undo(page)).toHaveText('Undo route choice');
      const local = commands.length;
      await blur(page); await page.keyboard.press('ControlOrMeta+z');
      await expect(route(page, 'Image first')).toHaveAttribute('aria-checked', 'true');
      expect(commands.length).toBe(local);
      // The route already chosen by the responses: the first Space arms, the second reveals it.
      await expect(route(page, 'Image first')).toHaveAttribute('aria-checked', 'true');
      const sent = commands.length;
      await blur(page); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
      await expect(primary(page), 'Enter never arms or reveals a route').toHaveText(/^Reveal:/);
      expect(commands.length).toBe(sent);
      await blur(page); await page.keyboard.press('Space');
      await expect(primary(page)).toHaveText('Show to participants?');
      expect(commands.length).toBe(sent);
      await page.keyboard.press('Space');
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed');
      expect(commands.at(-1)).toMatchObject({ type: 'reveal_path', pathId: fixture.p.image });
      // Enter reveals the next step, as → does.
      const groups = async () => (await mirror(harness, room)).revealed.at(-1).groupsShown, shown = await groups();
      await blur(page); await page.keyboard.press('Enter');
      await expect.poll(() => commands.at(-1)?.type).toBe('advance');
      await expect.poll(groups).toBe(shown + 1);
      await expect(primary(page), 'the step has landed').not.toHaveAttribute('aria-busy', 'true');
      // ← replays the presentation back, as the Back control does.
      await blur(page); await page.keyboard.press('ArrowLeft');
      await expect.poll(() => commands.at(-1)?.type).toBe('replay');
      // A control's own arrows stay its own: → on a panel divider resizes the panels and sends nothing (console layout v2).
      const before = commands.length, phase = (await mirror(harness, room)).phase;
      await page.setViewportSize({ width: 1440, height: 800 });
      const divider = page.getByRole('separator', { name: 'Resize the left and right panels' });
      const width = (await page.locator('.console-stage-left').boundingBox()).width;
      await divider.focus(); await page.keyboard.press('ArrowRight');
      await expect.poll(async () => Math.round((await page.locator('.console-stage-left').boundingBox()).width)).toBe(Math.round(width + 24));
      expect(commands.length).toBe(before); expect((await mirror(harness, room)).phase).toBe(phase);
      // CASE-251: a plain button has no arrow action, so → still steps while a clicked button keeps focus.
      await primary(page).focus(); await page.keyboard.press('ArrowRight');
      await expect.poll(() => commands.length, '→ on the focused main action replays forward').toBe(before + 1);
      expect(commands.at(-1).type).toBe('replay');
      await expect(undo(page)).toHaveAttribute('aria-keyshortcuts', 'Meta+Z Control+Z');
      // Console layout v2 (Julian, 2026-10-18): Escape ends nothing. It cancels an armed press-again confirm instead.
      await blur(page); await page.keyboard.press('Shift+?');
      await expect(sheet(page)).toBeVisible(); await expect(sheet(page)).toContainText('cancel a press-again confirm');
      await page.keyboard.press('Escape'); await expect(sheet(page)).toHaveCount(0);
      const end = page.locator('.console-rail [data-focus-key="arm-end"]');
      await end.click(); await expect(end).toHaveText('Press again: End case');
      await blur(page); await page.keyboard.press('Escape');
      await expect(end).toHaveText('End case');
      await blur(page); await page.keyboard.press('Escape');
      expect(commands.some(c => c.type === 'end'), 'nothing ended').toBe(false);
    } finally { await context.close(); }
  });

  for (const [width, height] of [[1200, 720], [1280, 720], [1440, 900]]) test(`[AS-160] the main action keeps its place through a round at ${width} × ${height}`, async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height }, reducedMotion: 'reduce' });
    await captureLocalPublicFrames(context);
    try {
      const { page, room } = await openControlsDecision(context, harness);
      const at = await box(primary(page)), seen = [];
      const check = async step => { const now = await box(primary(page)); seen.push(step);
        for (const key of ['x', 'y', 'w', 'h']) expect(Math.abs(now[key] - at[key]), `${step}: ${key} ${at[key]} → ${now[key]}`).toBeLessThanOrEqual(1); };
      await voteApi(harness, room, await joinApi(harness, room, 'Steady Voter'), fixture.o.image); await check('a response arrives');
      await primary(page).click(); await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked'); await check('locked, Undo shown');
      await route(page, 'Decompress').click(); await check('a route picked locally');
      await undo(page).click(); await check('the pick undone');
      await primary(page).click(); await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed'); await check('revealed');
      for (let i = 0; i < 4 && (await primary(page).getAttribute('aria-disabled')) !== 'true'; i++) { await primary(page).click(); await page.waitForTimeout(300); await check(`step ${i + 1}`); }
    } finally { await context.close(); }
  });
});

test.describe('Builder and Run preview', () => {
  test.beforeAll(start); test.afterAll(stop);

  test('[AS-153] on the selected slide tile → Space Enter step the reveal and ← steps back; ? opens the sheet; ⌘S saves', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await openBuilder(page, await divingSlides()); await page.waitForTimeout(800);
    const tile = page.locator('.builder-outline-target[aria-current="true"]').first();
    await tile.focus();
    const where = page.locator('.builder-reveal-where');
    await page.keyboard.press('ArrowRight'); await expect(where).toContainText('On entry');
    await page.keyboard.press('Space'); await expect(where).toHaveText(/^Step 1 of/);
    await page.keyboard.press('Enter'); await expect(where).toHaveText(/^Step 2 of/);
    await page.keyboard.press('ArrowLeft'); await expect(where).toHaveText(/^Step 1 of/);
    await expect(tile).toBeFocused();
    // CASE-251: Escape closes the reveal preview, from the tile (focus stays there) and from the stepper.
    await page.keyboard.press('Escape'); await expect(page.locator('.builder-reveal-stepper')).toHaveCount(0); await expect(tile).toBeFocused();
    await page.keyboard.press('ArrowRight'); await page.locator('.builder-reveal-stepper').getByRole('button', { name: 'All visible', exact: true }).focus();
    await page.keyboard.press('Escape'); await expect(page.locator('.builder-reveal-stepper')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Preview reveals', exact: true })).toBeFocused();
    // Never while a block is being edited: the same keys type there.
    await slide(page).locator('.slide-canvas > .slide-block').nth(1).click();
    await page.keyboard.press('ArrowRight'); await expect(page.locator('.builder-reveal-stepper')).toHaveCount(0);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await blur(page); await page.keyboard.press('Shift+?');
    await expect(sheet(page)).toContainText('On the selected slide tile');
    await page.keyboard.press('Escape');
    await page.getByLabel('Slide title', { exact: true }).fill('Keymap stage');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => state.puts).toBe(1);
  });

  test('[AS-160] the Run preview answers the live console\'s keys, and its main action keeps its place through a round', async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuilder(page, await divingSlides()); await page.waitForTimeout(800);
    const [child] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
    await child.getByRole('heading', { name: /^Preview · / }).waitFor();
    const main = child.locator('.run-preview-rail .console-primary'), phase = child.locator('.run-preview-phase h2');
    await child.getByRole('button', { name: 'Restart preview', exact: true }).click();
    await expect(main).toHaveText('Start case');
    for (const [width, height] of [[1200, 720], [1280, 720], [1440, 900]]) {
      await child.setViewportSize({ width, height }); await child.waitForTimeout(400);
      const at = await box(main);
      const check = async step => { const now = await box(main),layout=await child.locator('.run-preview').evaluate(root=>({layout:root.dataset.layout,stage:root.style.getPropertyValue('--run-stage'),headerHeight:root.querySelector('.run-preview-head').getBoundingClientRect().height})); for (const key of ['x', 'y', 'w', 'h']) expect(Math.abs(now[key] - at[key]), `${width}: ${step}: ${key}: ${JSON.stringify({at,now,...layout})}`).toBeLessThanOrEqual(1); };
      // Space walks the stage, as on the console, until the decision opens; the position never moves.
      for (let i = 0; i < 10 && !(await child.getByRole('button', { name: /Simulate answers/ }).count()); i++) { await blur(child); await child.keyboard.press('Space'); await child.waitForTimeout(150); await check(`step ${i}`); }
      await expect(phase).toHaveText('Team decision open');
      await child.getByRole('button', { name: /Simulate answers/ }).click(); await check('answers simulated');
      await blur(child); await child.keyboard.press('Space'); await expect(phase).toHaveText('Responses locked'); await check('locked');
      await expect(child.locator('.run-preview-rail .console-undo')).toHaveText(/^Undo/); await check('Undo shown');
      await blur(child); await child.keyboard.press('ControlOrMeta+z'); await expect(phase).toHaveText('Team decision open'); await check('Undo pressed by ⌘Z');
      await blur(child); await child.keyboard.press('Space'); await expect(phase).toHaveText('Responses locked');
      await child.locator('.run-preview-rail .console-routes button').first().click(); await check('route chosen');
      // Focus stays on the chosen route: Space there arms its reveal, so a keyboard rehearsal is never stuck (CASE-267).
      await child.keyboard.press('Space'); await expect(main).toHaveText('Show to participants?'); await check('armed');
      await child.keyboard.press('Space'); await expect(phase).not.toHaveText('Responses locked'); await check('revealed');
      await blur(child); await child.keyboard.press('ArrowLeft');
      await expect(child.getByRole('group', { name: 'Presentation', exact: true }).getByRole('button', { name: 'Live surface', exact: true })).toBeEnabled();
      await child.getByRole('button', { name: 'Restart preview', exact: true }).click(); await expect(main).toHaveText('Start case');
    }
    // CASE-251. From one blur, the keys walk the stage into the decision: the phone frame never takes focus (P1-1).
    // Enter is → (the next step, never the main action or a route); after a click on a dock button → still steps;
    // a click on Reveal is one press.
    const projector = () => child.frameLocator('iframe[title="Projector"]').locator('body').innerText();
    const simulate = child.getByRole('button', { name: /Simulate answers/ }), nextStep = /^Reveal (?!next surface)[a-z]/;
    await blur(child);
    for (let i = 0; i < 10 && !nextStep.test(await main.innerText()); i++) { await child.keyboard.press('Space'); await child.waitForTimeout(150); }
    await expect(main).toHaveText(nextStep);
    const shown = await projector();
    await child.keyboard.press('Enter');
    await expect.poll(projector, 'Enter reveals the next step').not.toBe(shown);
    for (let i = 0; i < 12 && !(await simulate.count()); i++) { await child.keyboard.press('Space'); await child.waitForTimeout(150); }
    await expect(phase).toHaveText('Team decision open');
    expect(await child.evaluate(() => document.activeElement?.tagName), 'focus stayed on the page, not in the phone').toBe('BODY');
    await simulate.click(); await blur(child);
    await child.keyboard.press('Enter'); await child.waitForTimeout(200);
    await expect(phase, 'Enter never presses Lock responses').toHaveText('Team decision open');
    await child.keyboard.press('Space'); await expect(phase).toHaveText('Responses locked');
    await child.keyboard.press('Space'); await expect(main, 'Space with no route chosen moves to the routes').toHaveCount(1);
    await child.locator('.run-preview-rail .console-routes button').first().click(); await blur(child);
    await child.keyboard.press('Enter'); await child.waitForTimeout(200);
    await expect(main, 'Enter never arms or reveals a route').toHaveText(/^Reveal:/);
    await main.click();
    await expect(phase, 'one click reveals the route').not.toHaveText('Responses locked');
    await expect(main).toBeFocused(); await child.keyboard.press('ArrowLeft');
    await expect(child.getByRole('group', { name: 'Presentation', exact: true }).getByRole('button', { name: 'Live surface', exact: true }),
      '← replays back while the clicked main action keeps focus').toBeEnabled();
    // Escape asks to Restart; a stray key cancels, Tab and Enter confirm.
    await sharedRoomKeys(child, { ask: 'Restart preview',
      unchanged: () => expect(main).not.toHaveText('Start case'),
      confirmed: () => expect(main).toHaveText('Start case') });
  });
});
