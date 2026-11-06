import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE, serverMirror } from '../tests/helpers/local-worker.mjs';
import { joinUrl } from '../src/shared/urls.mjs';
import { openRoomSetup, closeRoomSetup, projectorPage, dismissDisplayReminder } from '../tests/helpers/console-v2.mjs';
import { docShotsDir } from '../tests/helpers/doc-shots.mjs';

let auth, worker, shell, otp;
const CAPTURES = docShotsDir('23-screenshots');
test.beforeAll(async () => {
  otp = String(randomInt(100000, 1000000));
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null, otp });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin,
      SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

test('Card 23 served console key shares one group with phone and projector, then a clicked public row replays only there, with axe on every window', async ({ browser }) => {
  test.setTimeout(120_000);
  const facContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const fac = await facContext.newPage();
  const phone = await phoneContext.newPage();
  const publicFrames = [];
  let projector;
  const capture = async (state) => {
    await expect(projector.locator('#projectorCheck')).toBeHidden();
    expect(await projector.locator('#projectorCheck').isVisible(), `${state} display check cleared before capture`).toBe(false);
    await expect(projector.getByRole('heading', { name: 'S00011 workshop title.z' })).toBeVisible();
    await expect(projector.getByText(FIXTURE.surfaces[0].scene)).toBeVisible();
    if (state !== 'arrival-first-group')
      await expect(projector.getByText(FIXTURE.surfaces[0].points[0], { exact: true })).toBeVisible();
    mkdirSync(CAPTURES, { recursive: true });
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        for (const [role, page] of [['console', fac], ['projector', projector]]) {
          await page.setViewportSize({ width, height });
          await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
          await page.evaluate((selected) => { document.documentElement.dataset.theme = selected; }, theme);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          expect(await page.evaluate(() => [innerWidth, innerHeight]), `${state} ${role} browser size`).toEqual([width, height]);
          await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
          expect(await page.evaluate(() => scrollY), `${state} ${role} ${theme} ${width} starts at top`).toBe(0);
          await settled(page);
          expect((await new AxeBuilder({ page }).analyze()).violations,
            `${state} ${role} ${theme} ${width} accessibility`).toEqual([]);
          const png = await page.screenshot({ path: `${CAPTURES}/${state}-${role}-${theme}-${width}.png`, animations: 'disabled' });
          expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${state} ${role} PNG size`).toEqual([width, height]);
        }
      }
    }
  };
  for (const page of [phone]) page.on('websocket', socket => socket.on('framereceived', frame => publicFrames.push(String(frame.payload))));
  try {
    await fac.addInitScript(() => {
      const added = window.addEventListener.bind(window);
      const removed = window.removeEventListener.bind(window);
      const roomKeys = new Set();
      window.__caseTrackRoomKeys = () => { window.__caseTrackKeys = true; };
      window.__caseRoomKeyCount = () => roomKeys.size;
      window.addEventListener = (type, listener, options) => {
        if (window.__caseTrackKeys && type === 'keydown') roomKeys.add(listener);
        return added(type, listener, options);
      };
      window.removeEventListener = (type, listener, options) => {
        if (type === 'keydown') roomKeys.delete(listener);
        return removed(type, listener, options);
      };
    });
    await fac.goto(casesUrl(shell.origin));
    await fac.getByLabel('Email').fill('owner@example.invalid');
    await fac.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await fac.getByLabel('One-time code').fill(otp);
    await fac.getByRole('button', { name: 'Sign in' }).click();
    await expect(fac.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    const created = shell.waitForCreatedRoom();
    await fac.evaluate(() => window.__caseTrackRoomKeys());
    await (await openCase(fac)).click();
    const room = await created;
    // Start room opened the same-PC projector in its own click (console layout v2).
    projector = await projectorPage(fac);
    projector.on('websocket', socket => socket.on('framereceived', frame => publicFrames.push(String(frame.payload))));
    await expect(projector.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
    await expect(projector.locator('.names .arrival-note')).toHaveText('0 joined');
    await expect(projector.getByRole('heading', { name: 'Joining is closed', exact: true })).toHaveCount(0);
    await dismissDisplayReminder(fac);
    await phone.goto(joinUrl(room.joinCode, shell.origin));
    await phone.getByLabel('Your name').fill('Learner');
    await phone.getByRole('button', { name: 'Join case' }).click();
    await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
    await fac.getByRole('button', { name: 'Start case' }).click();
    await expect(fac.getByRole('button', { name: 'Reveal findings' })).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'S00011 workshop title.z' })).toBeVisible();
    await expect(projector.getByRole('heading', { name: 'S00011 workshop title.z' })).toBeVisible();
    await capture('arrival-first-group');
    const withheld = FIXTURE.surfaces[0].points[0];
    const privateNote = FIXTURE.surfaces[0].notes.slice(0, 48);
    await expect(fac.locator('.console-private')).toContainText(privateNote);
    await expect(fac.locator('.console-scene')).not.toContainText(privateNote);
    expect(publicFrames.join('\n')).not.toContain(privateNote);
    await expect(phone.getByText(withheld, { exact: true })).toHaveCount(0);
    await expect(projector.getByText(withheld, { exact: true })).toHaveCount(0);
    expect(publicFrames.join('\n')).not.toContain(withheld);
    await fac.locator('body').press('ArrowRight');
    await expect(phone.getByText(withheld, { exact: true })).toBeVisible();
    await expect(projector.getByText(withheld, { exact: true })).toBeVisible();
    await expect(phone.locator('.tile[aria-label="Findings"]')).toHaveClass(/presentation-new-group/);
    await expect(projector.locator('.findings')).toHaveClass(/presentation-new-group/);
    await capture('arrival-findings');
    await fac.getByRole('button', { name: 'Show decision context' }).click();
    await expect(phone.getByRole('heading', { name: 'S00021 worksho' })).toBeVisible();
    await openPresentation(fac);
    await fac.getByRole('navigation', { name: 'Presentation' }).getByRole('button', { name: /S00011 workshop title.z/ }).click();
    await expect(projector.getByText('Presentation replay · phones remain on live surface')).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'S00021 worksho' })).toBeVisible();
    await fac.getByRole('button', { name: 'Live surface' }).click();
    await expect(projector.getByText('Presentation replay · phones remain on live surface')).toHaveCount(0);
    await fac.getByRole('button', { name: 'Reveal observations' }).click();
    await fac.getByRole('button', { name: 'Reveal findings' }).click();
    await fac.getByRole('button', { name: 'Open responses' }).click();
    await fac.getByRole('button', { name: 'Lock responses & review' }).click();
    await chooseLocalRoute(fac, room, fac.getByRole('radio', { name: 'Choose S00174 workshop label. Record a senso', exact: true }));
    await revealAtomic(fac, room);
    await expect(fac.locator('.console-phase')).toHaveAttribute('data-phase', 'terminal_teaching');
    await openPresentation(fac);
    await fac.getByRole('navigation', { name: 'Presentation' }).getByRole('button', { name: /S00011 workshop title.z/ }).click();
    await expect(projector.getByText('Presentation replay · phones remain on live surface')).toBeVisible();
    await expect(fac.locator('.console-scene').getByText('Projector replay · S00011 workshop title.z', { exact: true })).toBeVisible();
    await capture('terminal-replay');
    expect(await fac.evaluate(() => window.__caseRoomKeyCount())).toBeGreaterThan(0);
    await fac.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(await fac.evaluate(() => window.__caseRoomKeyCount())).toBe(0);
  } finally { await facContext.close(); await phoneContext.close(); }
});

// Route cards are page-local until one explicit atomic Reveal. Observe real requests and authority.
async function chooseLocalRoute(page, room, route = page.locator('.console-routes').getByRole('radio', { disabled: false }).first()) {
  const before = await serverMirror(worker.origin, room), commands = [];
  const record = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/sessions/${room.sessionId}/commands`) commands.push(request); };
  page.on('request', record);
  try {
    await route.click(); await expect(route).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    const after = await serverMirror(worker.origin, room);
    expect(after.revision).toBe(before.revision); expect(after.phase).toBe('responses_locked');
    expect(after.selectedPathId).toBeNull(); expect(after.revealed).toEqual(before.revealed);
    expect(commands).toHaveLength(0);
  } finally { page.off('request', record); }
}

// A single native press must send exactly one fenced reveal and clear presentation overlays atomically.
async function revealAtomic(page, room) {
  const pathId = await page.locator('.console-route').filter({ has: page.getByRole('radio', { checked: true }) }).getAttribute('data-path');
  expect(pathId).toBeTruthy();
  const before = await serverMirror(worker.origin, room), commands = [];
  const record = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/sessions/${room.sessionId}/commands`) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.getByRole('button', { name: /^Reveal:/ }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', /^(consequence_revealed|terminal_teaching)$/);
    expect(commands).toHaveLength(1); expect(commands[0].type).toBe('reveal_path');
    expect(commands[0].expectRevision).toBe(before.revision); expect(commands[0].pathId).toBe(pathId);
    const after = await serverMirror(worker.origin, room);
    expect(after.resultsShown).toBe(false); expect(after.display.cursor).toBeNull(); expect(after.display.lobby).toBe(false);
    await expect(page.getByRole('button', { name: 'Show to participants?' })).toHaveCount(0);
  } finally { page.off('request', record); }
}

// Console layout v2: the presentation is one always-open strip at the foot of the main area.
async function openPresentation(page) {
  await expect(page.getByRole('navigation', { name: 'Presentation' })).toBeVisible();
}

