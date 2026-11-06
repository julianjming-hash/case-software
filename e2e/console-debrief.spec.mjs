// Console Debrief (Julian, 2026-10-18; prototypes/console-layout-v2.html, Debrief and After End case): a reversible room
// phase before End. Debrief now confirms in place and is greyed inside a round; in Debrief the bottom bar steps the review
// (Next, with End case beside it and Back to the case in the Undo slot), the projector follows, and the page fits one
// screen at 1440 × 800 and 1920 × 980 in light and dark. Back to the case restores the slide and joining; End case from
// Debrief closes this computer's projector and returns to Cases. Built console against a local Worker.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { settled } from '../tests/helpers/settled.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl, joinUrl } from '../src/shared/urls.mjs';
import { confirmInPlace, projectorPage } from '../tests/helpers/console-v2.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE } from '../tests/helpers/local-worker.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';

const SIZES = [[1440, 800], [1920, 980]];
const SHOTS = process.env.CONSOLE_LAYOUT_SHOTS || null; // a directory: captures for review, never asserted
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin, art: withSolution(describeCase(FIXTURE), { attempt: 0, summarised: false }) });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

async function startedRoom(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 800 } });
  const page = await context.newPage();
  await page.goto(casesUrl(shell.origin));
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await (await openCase(page)).click();
  await page.getByRole('button', { name: 'Start case' }).click();
  await expect(page.locator('.console-room-sees')).toBeVisible();
  return { context, page, projector: await projectorPage(page) };
}
const rail = page => page.getByRole('complementary', { name: 'Session' });
const dock = page => page.locator('.console-action-dock');
const phase = page => page.locator('.console-phase');

/** Every named control is wholly on screen, and neither the page nor the console nor the rail scrolls. */
async function fits(page, label, controls) {
  const report = await page.evaluate(() => ({
    page: document.scrollingElement.scrollHeight - innerHeight, sideways: document.scrollingElement.scrollWidth - innerWidth,
    rail: (() => { const r = document.querySelector('.console-rail'); return r ? r.scrollHeight - r.clientHeight : null; })(),
  }));
  expect.soft(report, `${label}: nothing scrolls`).toEqual({ page: 0, sideways: 0, rail: 0 });
  const view = page.viewportSize();
  for (const [name, locator] of controls) {
    const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
    expect.soft(box && box.y >= 0 && box.x >= 0 && box.y + box.height <= view.height + 0.5 && box.x + box.width <= view.width + 0.5,
      `${label}: ${name} is wholly on screen`).toBe(true);
  }
}

test('[AS-179] [console Debrief] Debrief now confirms in place; Debrief fits one screen at both sizes; Next steps the projector; Back to the case restores', async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page, projector } = await startedRoom(browser);
  try {
    page.on('dialog', dialog => { throw new Error(`no pop-up dialogs: ${dialog.message()}`); });
    // A phone in the room: Debrief gives it the recap, Back to the case takes it back to the live slide.
    const code = (await rail(page).locator('.console-people .console-code').textContent()).replace(/\s/g, '');
    const phone = await context.newPage();
    await phone.goto(joinUrl(code, shell.origin));
    await phone.getByLabel('Your name', { exact: true }).fill('Ana');
    await phone.getByRole('button', { name: 'Join case', exact: true }).click();
    await expect(rail(page).locator('.console-people-count strong')).toHaveText('1');
    const now = rail(page).locator('[data-focus-key="arm-debrief"]');
    await now.dblclick();
    await expect(now).toHaveText('Press again: Debrief');
    await expect(page.locator('#console-dock-status')).toHaveText('Phones get their recap and feedback opens. Back to the case undoes it.');
    await expect(phase(page)).toHaveAttribute('data-phase', 'surface_live');
    await page.waitForTimeout(650);
    await now.click();
    await expect(phase(page)).toHaveAttribute('data-phase', 'debrief');
    await expect(page.locator('.console-orientation h1')).toHaveText('Summary');
    // The projector shows the debrief summary; joining stopped (the People card no longer offers it).
    await expect(projector.getByRole('heading', { name: 'Debrief', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /new joins/ })).toHaveCount(0);
    await expect(rail(page).getByRole('region', { name: 'Debrief record' })).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
    await expect(dock(page).locator('.console-undo')).toHaveText('Back to the case');
    const next = dock(page).locator('.console-primary');
    await expect(next).toHaveText(/^Next: /);
    const controls = [['Next', next], ['Back to the case', dock(page).locator('.console-undo')], ['End case', dock(page).locator('[data-focus-key="arm-end"]')],
      ['Session sound', page.getByRole('button', { name: /Session sound/ })], ['Projector card', rail(page).locator('.console-projector')],
      ['Debrief record', rail(page).getByRole('region', { name: 'Debrief record' })], ['Questions', page.getByRole('group', { name: 'Questions' })],
      ['review strip', page.getByRole('navigation', { name: 'Review the case' })]];
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        await settled(page);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-debrief-${width}-${scheme}.png`, animations: 'disabled' });
        await fits(page, `debrief ${width} ${scheme}`, controls);
        const violations = (await new AxeBuilder({ page }).analyze()).violations;
        expect.soft(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), `debrief ${scheme} ${width} axe`).toEqual([]);
      }
    }
    await page.setViewportSize({ width: 1440, height: 800 });
    // Next replays the first slide; the projector follows and the header names it.
    const title = (await next.textContent()).replace(/^Next: /, '');
    await next.click();
    await expect(page.locator('.console-orientation h1')).toHaveText(title);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-debrief-slide-1440.png`, animations: 'disabled' });
    await expect(projector.getByText(title, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Review the case' }).locator('[aria-current="step"]')).toContainText(title);
    // Summary returns the projector to the debrief summary.
    await page.getByRole('group', { name: 'Questions' }).getByRole('button', { name: 'Summary' }).click();
    await expect(page.locator('.console-orientation h1')).toHaveText('Summary');
    await expect(projector.getByRole('heading', { name: 'Debrief', exact: true })).toBeVisible();
    // Back to the case: the slide comes back and so does joining.
    await dock(page).locator('.console-undo').click();
    await expect(phase(page)).toHaveAttribute('data-phase', 'surface_live');
    await expect(rail(page).getByRole('button', { name: 'Stop new joins' })).toBeVisible();
    await expect(projector.getByRole('heading', { name: 'Debrief', exact: true })).toHaveCount(0);
    await expect(phone.getByRole('heading', { name: 'Your private recap', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test('[AS-180] [console Debrief] Debrief now is greyed inside a round; End case from Debrief closes this computer\'s projector and returns to Cases', async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, projector } = await startedRoom(browser);
  try {
    for (let i = 0; i < 8 && await phase(page).getAttribute('data-phase') !== 'responses_open'; i++) {
      const before = await page.locator('.console-primary').textContent();
      await page.locator('.console-primary').click();
      await expect.poll(async () => (await page.locator('.console-primary').textContent()) !== before || await phase(page).getAttribute('data-phase') === 'responses_open').toBe(true);
    }
    await expect(phase(page)).toHaveAttribute('data-phase', 'responses_open');
    const greyed = rail(page).getByRole('button', { name: 'Debrief now' });
    await expect(greyed).toHaveAttribute('aria-disabled', 'true');
    await expect(rail(page).getByText('Debrief now: lock or void the round first.')).toBeVisible();
    await greyed.click({ force: true }); // aria-disabled: Playwright would otherwise wait for it to enable
    await expect(phase(page)).toHaveAttribute('data-phase', 'responses_open');
    await confirmInPlace(page, page.locator('[data-focus-key="arm-void-round"]'), 'Press again: discard answers');
    await expect(phase(page)).toHaveAttribute('data-phase', 'surface_live');
    await confirmInPlace(page, rail(page).locator('[data-focus-key="arm-debrief"]'), 'Press again: Debrief');
    await expect(phase(page)).toHaveAttribute('data-phase', 'debrief');
    // End case sits beside Next, not where Debrief was pressed; its hint says what it does.
    const end = dock(page).locator('[data-focus-key="arm-end"]');
    await end.click();
    await expect(page.locator('#console-dock-status')).toHaveText('Ends the session for everyone and closes the projector. Phones keep their recap for 24 hours.');
    await page.waitForTimeout(650);
    const closedProjector = projector.waitForEvent('close');
    await end.click();
    await closedProjector;
    await expect(page.getByText('session ended. Its debrief and feedback are in Sessions.', { exact: false })).toBeVisible();
    await expect(page.locator('.console-room')).toHaveCount(0);
    await expect(page.locator('.ended-summary')).toHaveCount(0);
  } finally { await context.close(); }
});
