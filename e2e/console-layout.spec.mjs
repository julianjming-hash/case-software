// Console layout v2 (Julian, 2026-10-18; prototypes/console-layout-v2.html): one screen with a fixed side rail and a
// Room setup sheet, no Run/Room tabs. At a laptop page (1440 × 800, a 1440 × 900 screen inside a browser) and a monitor
// page (1920 × 980), in light and dark, the page never scrolls and every control needed mid-session is on screen: the
// bottom bar's primary, Undo and Room sound, and the rail's Projector, People (join code, Stop new joins) and End case.
// Built console against a local Worker, as e2e/console-parity.spec.mjs.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { settled } from '../tests/helpers/settled.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE } from '../tests/helpers/local-worker.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';

const SHOTS = process.env.CONSOLE_LAYOUT_SHOTS || null; // a directory: captures for review, never asserted
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SIZES = [[1440, 800], [1920, 980]];

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

async function signedIn(page) {
  await page.goto(casesUrl(shell.origin));
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
}

/** Every named control is wholly inside the viewport, and neither the page nor the console scrolls. */
async function onScreen(page, label, controls) {
  const report = await page.evaluate(() => ({
    pageScroll: document.scrollingElement.scrollHeight - innerHeight,
    pageScrollX: document.scrollingElement.scrollWidth - innerWidth,
    room: (() => { const r = document.querySelector('.console-room'); return r ? r.scrollHeight - r.clientHeight : null; })(),
    rail: (() => { const r = document.querySelector('.console-rail'); return r ? r.scrollHeight - r.clientHeight : null; })(),
  }));
  expect.soft(report.pageScroll, `${label}: the page does not scroll`).toBeLessThanOrEqual(0);
  expect.soft(report.pageScrollX, `${label}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect.soft(report.room, `${label}: the console does not scroll`).toBeLessThanOrEqual(0);
  expect.soft(report.rail, `${label}: the rail does not scroll`).toBeLessThanOrEqual(0);
  const view = page.viewportSize();
  for (const [name, locator] of controls) {
    const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
    expect.soft(box, `${label}: ${name} is rendered`).not.toBeNull();
    if (!box) continue;
    expect.soft(box.y >= 0 && box.x >= 0 && box.y + box.height <= view.height + 0.5 && box.x + box.width <= view.width + 0.5,
      `${label}: ${name} is wholly on screen (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)})`).toBe(true);
  }
}

async function everySize(page, state, controls) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await settled(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-${state}-${width}-${scheme}.png`, animations: 'disabled' });
      await onScreen(page, `${state} ${width}×${height} ${scheme}`, controls(page));
      const violations = (await new AxeBuilder({ page }).analyze()).violations;
      expect.soft(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), `${state} ${scheme} ${width} axe`).toEqual([]);
    }
  }
}

const rail = page => page.getByRole('complementary', { name: 'Session' });
/** Reveal the arrival's groups until the first decision opens. */
async function openFirstDecision(page) {
  for (let i = 0; i < 8; i++) {
    if (await page.locator('.console-phase').getAttribute('data-phase') === 'responses_open') return;
    const before = await page.locator('.console-primary').textContent();
    await page.locator('.console-primary').click();
    await expect.poll(async () => (await page.locator('.console-primary').textContent()) !== before || await page.locator('.console-phase').getAttribute('data-phase') === 'responses_open').toBe(true);
  }
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
}
const always = page => [
  ['primary action', page.locator('.console-action-dock .console-primary')],
  ['Undo', page.locator('.console-action-dock .console-undo')],
  ['Session sound', page.getByRole('button', { name: /Session sound/ })],
  ['Projector card', rail(page).locator('.console-projector')],
  ['join code', rail(page).locator('.console-people .console-code')],
  ['Stop new joins', rail(page).getByRole('button', { name: 'Stop new joins' })],
  ['End case', rail(page).getByRole('button', { name: 'End case' })],
];

test('[AS-174] [console layout v2] lobby, live slide and open decision fit one screen at 1440 × 800 and 1920 × 980, light and dark', async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 800 } });
  const page = await context.newPage();
  try {
    await signedIn(page);
    await (await openCase(page)).click();
    // No tabs: the lobby is the Room setup sheet beside the rail.
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Session setup' })).toBeVisible();
    await expect(page.locator('.console-primary')).toHaveText(/Start case/);
    await everySize(page, 'lobby', page => [...always(page), ['Session setup sheet', page.locator('#console-setup')]]);
    await page.getByRole('button', { name: 'Start case' }).click();
    await expect(page.locator('.console-room-sees')).toBeVisible();
    // The sheet folded away and comes back from the rail; Escape folds it again.
    await expect(page.locator('#console-setup')).toHaveCount(0);
    await page.getByRole('button', { name: 'Session setup', exact: true }).click();
    await expect(page.locator('#console-setup')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#console-setup')).toHaveCount(0);
    await everySize(page, 'live', page => [...always(page), ['Projector', page.locator('.console-room-sees')],
      ['Only you', page.locator('.console-only-you')], ['decision panel', page.locator('.console-decision')]]);
    await openFirstDecision(page);
    await everySize(page, 'decision-open', page => [...always(page), ['Void round', page.getByRole('button', { name: 'Void round' })],
      ['decision panel', page.locator('.console-decision')]]);
  } finally { await context.close(); }
});

test('[AS-174] [console layout v2] End case and Void round confirm in place: a double-click does not fire them; Escape disarms', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 800 } });
  const page = await context.newPage();
  try {
    await signedIn(page);
    await (await openCase(page)).click();
    await page.getByRole('button', { name: 'Start case' }).click();
    await openFirstDecision(page);
    page.on('dialog', dialog => { throw new Error(`no pop-up dialogs: ${dialog.message()}`); });
    const end = rail(page).locator('[data-focus-key="arm-end"]');
    await end.dblclick();
    await expect(end).toHaveText('Press again: End case');
    await expect(page.locator('#console-dock-status')).toHaveText('Ends the session for everyone. Phones keep their recap for 24 hours.');
    await expect(page.locator('.console-room-sees')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(end).toHaveText('End case');
    const voidRound = page.locator('[data-focus-key="arm-void-round"]');
    await voidRound.click();
    await expect(voidRound).toHaveText('Press again: discard answers');
    await page.waitForTimeout(700);
    await voidRound.click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    // Armed controls disarm by themselves after three seconds.
    await end.click();
    await expect(end).toHaveText('Press again: End case');
    await expect(end).toHaveText('End case', { timeout: 5000 });
  } finally { await context.close(); }
});

test('[AS-174] [console layout v2] panels: Room sees folds, the decision panel hides and returns, dividers resize by keyboard and persist', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 800 } });
  const page = await context.newPage();
  try {
    await signedIn(page);
    await (await openCase(page)).click();
    await page.getByRole('button', { name: 'Start case' }).click();
    const sees = page.locator('.console-room-sees'), only = page.locator('.console-only-you');
    const before = await only.boundingBox();
    await page.getByRole('button', { name: 'Hide projector preview' }).click();
    await expect(sees).toHaveClass(/is-folded/);
    expect((await only.boundingBox()).height, 'notes take the space').toBeGreaterThan(before.height + 100);
    await page.getByRole('button', { name: 'Show projector preview' }).click();
    await page.getByRole('button', { name: 'Hide decision panel' }).click();
    await expect(page.locator('.console-decision')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show decision' }).click();
    await expect(page.locator('.console-decision')).toBeVisible();
    const col = page.getByRole('separator', { name: 'Resize the left and right panels' });
    const width = (await page.locator('.console-stage-left').boundingBox()).width;
    await col.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.round((await page.locator('.console-stage-left').boundingBox()).width)).toBe(Math.round(width - 48));
    expect(await page.evaluate(() => localStorage.getItem('case:preferences:console-split'))).toMatch(/^\d+,(\d+|-)$/);
    await onScreen(page, 'after resize', always(page));
  } finally { await context.close(); }
});
