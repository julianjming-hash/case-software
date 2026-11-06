// Card 36b (console half): the lobby header (cover, title, menu, connection on one line) and the live
// view's two unbordered columns, Room sees and Only you, against the built console and a local Worker.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { mkdirSync } from 'node:fs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE } from '../tests/helpers/local-worker.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { consoleReady, openRoomSetup, confirmInPlace } from '../tests/helpers/console-v2.mjs';

const SHOTS = process.env.C36_SHOTS || null; // a directory: before/after captures for the card, never asserted
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin, art: withSolution(describeCase(FIXTURE), { attempt: 0, summarised: false }) });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin,
      SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
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
async function axe(page, label, soft = false) {
  await settled(page);
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  (soft ? expect.soft : expect)(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), label).toEqual([]);
}
/** Light and dark at each width: axe, then (with C36_SHOTS) a capture. */
async function everyScheme(page, state, widths, check = async () => {}) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 768 });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-${state}-${width}-${scheme}.png`, animations: 'disabled' });
      await check(width, scheme);
      await axe(page, `${state} ${scheme} ${width}`, true);
    }
  }
}
const centreY = box => box.y + box.height / 2;
const box = loc => loc.boundingBox({ timeout: 3000 }).catch(() => ({ x: NaN, y: NaN, width: NaN, height: NaN }));

test('36b console lobby header: cover, title, menu and connection on one line; the menu sends the existing mute request', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  try {
    await signedIn(page);
    const created = shell.waitForCreatedRoom();
    await (await openCase(page)).click();
    const room = await created;
    await consoleReady(page);
    await everyScheme(page, 'lobby', [1366, 1920], async width => {
      if (width !== 1366) return;
      const header = page.locator('.console-orientation');
      const cover = header.locator('canvas.console-cover');
      await expect.soft(cover).toBeVisible();
      await expect.soft(cover).toHaveAttribute('role', 'img');
      const coverBox = await box(cover);
      expect.soft([coverBox.width, coverBox.height], 'cover is 32 px').toEqual([32, 32]);
      expect.soft(await cover.evaluate(c => c.width > 1, null, { timeout: 3000 }).catch(() => false), 'cover painted').toBe(true);
      const currentCase=header.getByRole('navigation',{name:'Breadcrumb'}).locator('[aria-current="page"]');
      await expect.soft(currentCase).toHaveText(FIXTURE.title);
      await expect.soft(header.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Present',exact:true})).toBeVisible();
      const menu = header.getByRole('button', { name: 'Open menu', exact: true });
      await expect.soft(menu).toHaveClass(/console-menu-button/);
      const parts = [cover, currentCase, menu, header.locator('.console-connection')];
      const boxes = await Promise.all(parts.map(box));
      for (const [i, box] of boxes.entries()) expect.soft(Math.abs(centreY(box) - centreY(boxes[0])), `part ${i} on the cover's line`).toBeLessThanOrEqual(8);
    });
    await page.evaluate(() => { window.muteFrames = []; const c = new BroadcastChannel('case-room-local'); c.onmessage = ({ data }) => { if (data?.t === 'mute_projector') window.muteFrames.push(data); }; window.muteChannel = c; });
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Mute same-PC projector', exact: true }).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.muteFrames.length)).toBe(1);
    expect(await page.evaluate(() => window.muteFrames[0].sessionId)).toBe(room.sessionId);
    // Start room opened the same-PC projector in its click (console layout v2), so the projector acknowledges.
    await expect(page.locator('.console-sound-status')).toHaveText('Projector sound muted.', { timeout: 6000 });
  } finally { await context.close(); }
});

test('console layout v2: Room sees over Only you on the left, the decision panel on the right at 1366; stacked at 1024', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  try {
    await signedIn(page);
    await (await openCase(page)).click();
    await page.getByRole('button', { name: 'Start case' }).click();
    await expect(page.locator('.console-phase')).toBeVisible();
    const sees = page.locator('.console-room-sees'), only = page.locator('.console-only-you'), decision = page.locator('.console-decision');
    await everyScheme(page, 'live', [1366, 1920], async width => {
      if (width !== 1366) return;
      await expect.soft(sees.getByRole('heading', { name: 'Projector preview' })).toBeVisible();
      await expect.soft(only.getByRole('heading', { name: 'Only you' })).toBeVisible();
      await expect.soft(only.locator('.console-private')).toContainText(FIXTURE.beats[0].cue);
      const [a, b, c] = [await box(sees), await box(only), await box(decision)];
      expect.soft(b.y, 'Only you sits under Projector').toBeGreaterThanOrEqual(a.y + a.height - 1);
      expect.soft(c.x, 'the decision panel sits right of both').toBeGreaterThanOrEqual(Math.max(a.x + a.width, b.x + b.width) - 1);
      expect.soft(Math.abs(a.y - c.y), 'Projector and the decision panel share a top').toBeLessThanOrEqual(2);
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    const [a, b] = [await sees.boundingBox(), await only.boundingBox()];
    expect(b.y, 'Only you stacks under Projector at 1024').toBeGreaterThanOrEqual(a.y + a.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll at 1024').toBe(true);
    // The bottom bar keeps the next action; no panel holds a primary.
    await expect(page.locator('.console-col .btn.primary')).toHaveCount(0);
    await expect(page.locator('.console-action-dock .btn.primary')).toBeVisible();
  } finally { await context.close(); }
});

test('console layout v2: Room setup renders from its lazy chunk with its cards in order; the rail is the console\'s own', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 800 } });
  const page = await context.newPage();
  try {
    const chunks = [];
    page.on('request', request => { if (/\/assets\/console-room-tab\.[0-9a-f]+\.mjs$/.test(new URL(request.url()).pathname)) chunks.push(request.url()); });
    await signedIn(page);
    await (await openCase(page)).click();
    await consoleReady(page);
    await expect.poll(() => chunks.length, { message: 'the Session setup chunk is preloaded at mount' }).toBe(1);
    const sheet = await openRoomSetup(page);
    await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(['Session setup', /^People · 0$/, 'Facilitator briefing', 'Consoles', 'Use a shared computer', 'Manual session']);
    const rail = page.getByRole('complementary', { name: 'Session' });
    await expect(rail.getByRole('heading', { name: 'Projector' })).toBeVisible();
    // Start room opened the projector window in its own click, so the card says it is connected.
    await expect(rail.locator('.console-projector .tag')).toHaveText(/^(Connected|One screen)$/);
    await expect(rail.getByRole('button', { name: 'End case' })).toBeVisible();
    await rail.getByRole('button', { name: 'Use another screen' }).click();
    await expect(sheet.getByLabel('Display pairing code')).toBeVisible();
    await expect(page.getByText('Loading session controls…')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
  } finally { await context.close(); }
});

test('console layout v2: with the Room setup chunk unreachable, Manual room and End case still render and work', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 800 } });
  let blocked = 0;
  await context.route(/\/assets\/console-room-tab\.[0-9a-f]+\.mjs$/, route => { blocked++; return route.abort('failed'); });
  const page = await context.newPage();
  try {
    await signedIn(page);
    await (await openCase(page)).click();
    const sheet = await openRoomSetup(page);
    await expect(sheet.getByText('Loading session controls…')).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(['Session setup', 'Manual session']);
    await expect(page.getByRole('complementary', { name: 'Session' }).getByRole('button', { name: 'End case' })).toBeVisible();
    expect(blocked).toBeGreaterThanOrEqual(1);
    page.once('dialog', dialog => { throw new Error(`no pop-up: ${dialog.message()}`); });
    await confirmInPlace(page, sheet.locator('[data-focus-key="arm-manual"]'), 'Press again: manual session');
    await expect(page.locator('.console-manual-tray')).toContainText('This computer runs the session. Keep this tab open.');
  } finally { await context.close(); }
});
