// Card 36a (surface parity, phone and Help): join, waiting, material and recap on the served phone against
// the real local Worker, plus the Help page. Geometry and axe in light and dark at 320 and 390 px.
// CASE_SHOTS_DIR, when set, saves a screenshot per state (outside the repo).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { mkdirSync } from 'node:fs';
import { startLocalWorker, createRoom, facilitatorCommand, serverMirror, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { joinUrl, joinEntryUrl, sessionUrl } from '../src/shared/urls.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { solveArt } from '../src/shared/mosaic-geometry.mjs';

const SHOTS = process.env.CASE_SHOTS_DIR || null;
const shot = async (page, state, v) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${state}-${v.t}-${v.w}.png`, fullPage: true });
};
const VARIANTS = [[320, 568], [390, 844]].flatMap(([w, h]) => ['light', 'dark'].map(t => ({ w, h, t })));
const DESC = describeCase(FIXTURE);
const CASE_ART = withSolution(DESC, solveArt(DESC));

let worker;
test.describe.configure({ mode: 'default' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });

async function open(browser, v, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, colorScheme: v.t, ...extra });
  return { ctx, page: await ctx.newPage() };
}
const axe = async (page, label) => {
  await settled(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(x => `${label}: ${x.id} ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
};
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function joinThroughUi(page, room, name = 'Robin') {
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
}
/** Serve a chosen descriptor in every participant snapshot, over HTTP only (the socket is off). */
async function serveArt(page, art) {
  await page.addInitScript(() => { window.WebSocket = function BlockedSocket() { throw new Error('blocked'); }; }); // the transport falls back to HTTP long-poll
  await page.route('**/api/v1/**', async route => {
    try {
      const res = await route.fetch();
      if (!(res.headers()['content-type'] ?? '').includes('json')) { await route.fulfill({ response: res }); return; }
      const body = await res.json().catch(() => null);
      const patch = n => { if (n && typeof n === 'object') { if (n.t === 'snapshot' && n.view) n.view.art = art; for (const x of Object.values(n)) patch(x); } };
      patch(body);
      await route.fulfill({ response: res, json: body });
    } catch { /* the page closed while a long-poll was held */ }
  });
}

test('[36a] join: the prefilled code is one line, the avatar is preassigned and folded, and Join case is in the first screen, light and dark at 320 and 390', async ({ browser }) => {
  for (const v of VARIANTS) {
    const room = await createRoom(worker.origin);
    const { ctx, page } = await open(browser, v);
    try {
      await page.goto(joinUrl(room.joinCode, worker.origin));
      await expect(page.getByRole('heading', { name: 'Join the case' })).toBeVisible();
      await shot(page, 'join', v);
      // The code is confirmed in one line with Change; the input is not in the way.
      await expect(page.locator('#jcode')).toBeHidden();
      await expect(page.locator('#jcode')).toHaveValue(room.joinCode);
      await expect(page.locator('.room-line')).toContainText(`Room ${room.joinCode.slice(0, 3)} ${room.joinCode.slice(3)}`);
      const change = page.getByRole('button', { name: 'Change code' });
      await expect(change).toBeVisible();
      // The avatar is preassigned: one 56 px row, the grid folded away until Change avatar opens.
      const avatar = page.locator('.avatar-row img, .avatar-row svg').first();
      await expect(avatar).toBeVisible();
      expect((await avatar.boundingBox()).width).toBe(56);
      await expect(page.getByText('Your avatar', { exact: true })).toBeVisible();
      await expect(page.getByText('Picked at random. You can change it now or later.', { exact: true })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Choose an avatar' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Randomise avatar', exact: true })).toBeHidden();
      // Join case sits inside the first screen.
      const box = await page.getByRole('button', { name: 'Join case', exact: true }).boundingBox();
      expect(box.y + box.height, `Join case bottom ${box.y + box.height} within ${v.h}`).toBeLessThanOrEqual(v.h);
      expect(await noOverflow(page)).toBe(true);
      // Kept exactly.
      await expect(page.getByText('Do not enter patient details.', { exact: true })).toBeVisible();
      await expect(page.getByText('0 of 20', { exact: true })).toBeVisible();
      await expect(page.getByText('Your name and avatar appear on the projector in the lobby.', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
      // The join page draws the brand splash, never the room's.
      await expect(page.locator('[data-splash-art]')).toHaveAttribute('data-art', 'brand');
      await expect.poll(() => page.locator('[data-splash-art] svg polygon').count()).toBeGreaterThan(20);
      await axe(page, `join ${v.t} ${v.w}`);
      // Change avatar opens the existing grid and Randomise.
      await page.getByText('Change avatar', { exact: true }).click();
      await expect(page.getByRole('group', { name: 'Choose an avatar' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Randomise avatar', exact: true })).toBeVisible();
      // Change expands the existing input in place and focuses it.
      await change.click();
      await expect(page.locator('#jcode')).toBeVisible();
      await expect(page.locator('#jcode')).toBeFocused();
      await expect(page.locator('.room-line')).toBeHidden();
      await axe(page, `join expanded ${v.t} ${v.w}`);
    } finally { await ctx.close(); }
  }
});

test('[36a] join: no code, a malformed code and a refusal all show the input; the refusal keeps the typed value under the field', async ({ browser }) => {
  const v = { w: 390, h: 844, t: 'light' };
  const draftedPage = async draft => {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h } });
    await ctx.addInitScript(value => { if (value) sessionStorage.setItem('case:phone:join-code-draft', value); }, draft);
    const page = await ctx.newPage();
    await page.goto(joinEntryUrl(worker.origin));
    return { ctx, page };
  };
  // No code: the input is shown, no confirmation line.
  let { ctx, page } = await draftedPage('');
  try {
    await expect(page.locator('#jcode')).toBeVisible();
    await expect(page.locator('.room-line')).toBeHidden();
    await shot(page, 'join-nocode', v);
  } finally { await ctx.close(); }
  // A malformed code (the wrong length): the input at once.
  ({ ctx, page } = await draftedPage('AB'));
  try {
    await expect(page.locator('#jcode')).toBeVisible();
    await expect(page.locator('.room-line')).toBeHidden();
  } finally { await ctx.close(); }
  // A well-formed code is confirmed in one line; a refusal re-expands the input with the error under it, value kept.
  ({ ctx, page } = await draftedPage('ZZZZZZ'));
  try {
    await expect(page.locator('#jcode')).toBeHidden();
    await expect(page.locator('.room-line')).toContainText('Room ZZZ ZZZ');
    await page.getByLabel('Your name', { exact: true }).fill('Robin');
    await page.getByRole('button', { name: 'Join case', exact: true }).click();
    const err = page.locator('#jcode-err');
    await expect(err).toBeVisible();
    await expect(err).toContainText("That code isn't right · check it against the projector");
    await expect(page.locator('#jcode')).toBeVisible();
    await expect(page.locator('#jcode')).toHaveValue('ZZZZZZ');
    await expect(page.locator('#jcode')).toBeFocused();
    await expect(page.locator('.room-line')).toBeHidden();
    await shot(page, 'join-refused', v);
    await axe(page, 'join refused');
  } finally { await ctx.close(); }
});

test('[36a] waiting: case art around an opaque status panel, brand art when the descriptor is missing or invalid, nothing new on the phone, light and dark at 320 and 390', async ({ browser }) => {
  for (const v of VARIANTS) {
    const room = await createRoom(worker.origin);
    const { ctx, page } = await open(browser, v);
    try {
      await joinThroughUi(page, room);
      await expect(page.locator('[data-splash-art]')).toHaveAttribute('data-art', 'brand'); // the dev room carries no art
      await expect.poll(() => page.locator('[data-splash-art] svg polygon').count()).toBeGreaterThan(20);
      await shot(page, 'waiting', v);
      const panel = page.locator('.splash-panel');
      await expect(panel).toBeVisible();
      expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor.match(/rgba\(.*,\s*0\)|transparent/) === null)).toBe(true);
      await expect(page.getByText('The case starts when the facilitator is ready. Keep this page open.', { exact: true })).toBeVisible();
      await expect(page.getByText('Change name or avatar', { exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(FIXTURE.title); // no case title on the phone lobby
      expect(await noOverflow(page)).toBe(true);
      await axe(page, `waiting ${v.t} ${v.w}`);
    } finally { await ctx.close(); }
  }
});

test('[36a] waiting: a valid descriptor in the participant view draws the case art; an invalid one falls back to the brand art', async ({ browser }) => {
  const v = { w: 390, h: 844, t: 'light' };
  for (const [art, want] of [[CASE_ART, 'case'], [{ v: 1, junk: true }, 'brand']]) {
    const room = await createRoom(worker.origin);
    const { ctx, page } = await open(browser, v);
    try {
      await serveArt(page, art);
      await joinThroughUi(page, room);
      await expect(page.locator('[data-splash-art]')).toHaveAttribute('data-art', want);
      await expect.poll(() => page.locator('[data-splash-art] svg polygon').count()).toBeGreaterThan(20);
      if (want === 'case') await shot(page, 'waiting-case-art', v);
    } finally { await ctx.close(); }
  }
});

test('[36a] waiting: no animation runs under prefers-reduced-motion', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const { ctx, page } = await open(browser, { w: 390, h: 844, t: 'light' }, { reducedMotion: 'reduce' });
  try {
    await joinThroughUi(page, room);
    await expect(page.locator('[data-splash-art]')).toHaveAttribute('data-art', /./);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.querySelector('[data-splash-art] svg').getAnimations({ subtree: true }).length)).toBe(0);
  } finally { await ctx.close(); }
});

async function advanceUntil(room, page, selector, limit = 8) {
  for (let i = 0; i < limit; i++) {
    if (await page.locator(selector).count()) return;
    expect((await facilitatorCommand(worker.origin, room, 'advance')).receipt).toBe('accepted');
    await page.waitForTimeout(400);
  }
  await expect(page.locator(selector).first()).toBeVisible();
}

test('[36a] material: vitals are one ruled strip with labels above mono numerals that wraps without horizontal scroll, light and dark at 320 and 390', async ({ browser }) => {
  for (const v of VARIANTS) {
    const room = await createRoom(worker.origin);
    const { ctx, page } = await open(browser, v);
    try {
      await joinThroughUi(page, room);
      expect((await facilitatorCommand(worker.origin, room, 'start')).receipt).toBe('accepted');
      await advanceUntil(room, page, 'ul.vitals');
      const vitals = page.locator('ul.vitals').first();
      await vitals.scrollIntoViewIfNeeded();
      await shot(page, 'material', v);
      const style = await vitals.evaluate(el => { const c = getComputedStyle(el); return { l: c.borderLeftWidth, r: c.borderRightWidth, t: c.borderTopWidth, b: c.borderBottomWidth, radius: c.borderTopLeftRadius }; });
      expect(style, 'ruled strip: rules above and below, no box').toEqual({ l: '0px', r: '0px', t: '1px', b: '1px', radius: '0px' });
      const first = vitals.locator('li').first();
      const label = await first.locator('.vl').boundingBox(), value = await first.locator('.vv').boundingBox();
      expect(label.y + label.height, 'label above numeral').toBeLessThanOrEqual(value.y + 1);
      expect(await first.locator('.vv').evaluate(el => getComputedStyle(el).fontFamily)).toContain('JetBrains Mono');
      const tops = await vitals.locator('li').evaluateAll(items => [...new Set(items.map(i => Math.round(i.getBoundingClientRect().top)))]);
      if (v.w === 320) expect(tops.length, 'wraps onto rows at 320').toBeGreaterThan(1);
      expect(await vitals.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      await axe(page, `material ${v.t} ${v.w}`);
    } finally { await ctx.close(); }
  }
});

test('[36a] recap: the exact expiry sentences, a cover beside the heading at 390 and dropped at 320, white A4-style print in either theme', async ({ browser }) => {
  for (const v of VARIANTS) {
    const room = await createRoom(worker.origin);
    const { ctx, page } = await open(browser, v);
    try {
      await joinThroughUi(page, room);
      expect((await facilitatorCommand(worker.origin, room, 'end')).receipt).toBe('accepted');
      await expect(page.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
      await shot(page, 'recap', v);
      // Card 40b: one expiry line, no session facts; no Give feedback link (room PDFs v2: the Finish block leads); Objectives first.
      await expect(page.getByText(/^On this phone until .+$/)).toBeVisible();
      for (const gone of ['Only this phone can see this', 'A downloaded PDF is your own copy', 'Online until', 'Yours to keep', 'What this case teaches', 'What the room was shown'])
        await expect(page.locator('body')).not.toContainText(gone);
      await expect(page.getByRole('link', { name: 'Give feedback', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Objectives', exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Kept for 24 hours');
      await expect(page.locator('body')).not.toContainText('Expires ');
      const cover = page.locator('canvas.recap-cover');
      const heading = page.getByRole('heading', { name: 'Your private recap', exact: true });
      if (v.w >= 360) {
        await expect(cover).toBeVisible();
        const b = await cover.boundingBox();
        expect([b.width, b.height]).toEqual([72, 72]);
        const hb = await heading.boundingBox(), lh = await heading.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
        expect(hb.height, 'heading stays on one line beside the cover').toBeLessThan(lh * 1.5);
        await expect(cover).toHaveAttribute('aria-label', 'Abstract branching mosaic artwork');
      } else await expect(cover).toBeHidden();
      expect(await noOverflow(page)).toBe(true);
      await axe(page, `recap ${v.t} ${v.w}`);
      await expect(page.getByRole('button', { name: 'Download recap (PDF)', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Print recap', exact: true })).toBeVisible();
      // Print: buttons gone, white paper in either theme, the page header with CASE and the case title.
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByRole('button', { name: 'Print recap', exact: true })).toBeHidden();
      await expect(page.locator('.print-head')).toBeVisible();
      await expect(page.locator('.print-head')).toContainText('CASE');
      await expect(page.locator('.print-head')).toContainText('Your private recap');
      await expect(page.locator('.print-head')).toContainText(FIXTURE.title);
      // Under emulated print the paper theme is applied by phone.mjs's matchMedia('print') change listener, which
      // fires asynchronously after emulateMedia (a real print fires beforeprint first), so wait for it (36b CI, run 37555739852).
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.recap-round, #recH')).color)).not.toBe('rgb(255, 255, 255)');
      await page.emulateMedia({ media: 'screen' });
      await expect(page.locator('.print-head')).toBeHidden();
    } finally { await ctx.close(); }
  }
});

test('[36a] help: /help serves a text-only page with a real tablist, the menu links to it, and no disclaimer appears', async ({ browser }) => {
  for (const v of [{ w: 390, h: 844, t: 'light' }, { w: 390, h: 844, t: 'dark' }, { w: 1280, h: 800, t: 'light' }, { w: 1280, h: 800, t: 'dark' }]) {
    const { ctx, page: entryPage } = await open(browser, v);
    let page = entryPage;
    const violations = [];
    const observeErrors = target => {
      target.on('console', m => { if (/Content Security Policy|Trusted Type/i.test(m.text())) violations.push(m.text()); });
      target.on('pageerror', e => violations.push(String(e)));
    };
    observeErrors(entryPage);
    ctx.on('page', observeErrors);
    try {
      // The menu's Help entry is a link to the page, not a folded section.
      await page.goto(`${worker.origin}/`);
      await page.getByRole('button', { name: 'Open menu' }).click();
      const link = page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: 'Help', exact: true });
      await expect(link).toHaveAttribute('href', `${worker.origin}/help`);
      await expect(link).not.toHaveAttribute('target', '_blank');
      await link.click();
      expect(page).toBe(entryPage);
      await expect(page).toHaveURL(`${worker.origin}/help`);
      await expect(page.getByRole('heading', { level: 1, name: 'Help', exact: true })).toBeVisible();
      await expect(page.getByText('Short answers, by what you are doing.', { exact: true })).toBeVisible();
      await shot(page, 'help', v);
      const tabs = page.getByRole('tablist').getByRole('tab');
      await expect(tabs).toHaveText(['Joining', 'Connection', 'Facilitating', 'Projector', 'Shared computer']);
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel', { name: 'Joining' })).toBeVisible();
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(page.getByRole('tabpanel', { name: 'Connection' })).toBeVisible();
      await expect(page.getByRole('tabpanel', { name: 'Joining' })).toBeHidden();
      await page.keyboard.press('End');
      await expect(tabs.nth(4)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel', { name: 'Shared computer' })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(tabs.nth(4)).toBeFocused();
      await page.keyboard.press('Home');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      // Every tab names its panel; the network check moved into Connection.
      for (let i = 0; i < 5; i++) {
        await tabs.nth(i).click();
        const panel = page.getByRole('tabpanel');
        await expect(panel).toHaveAccessibleName(await tabs.nth(i).innerText());
        await expect(panel.getByRole('heading', { level: 2 }).first()).toBeVisible();
      }
      await tabs.nth(1).click();
      await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Check this network' })).toHaveAttribute('href', `${worker.origin}/check`);
      // Text only; no disclaimer (CASE-168); the footer line is the privacy instruction and link.
      expect(await page.locator('main').evaluate(m => m.querySelectorAll('img, svg, canvas, iframe, video, input, form').length)).toBe(0);
      expect(await page.locator('body').innerText()).not.toMatch(/simulation|clinical advice/i);
      await expect(page.getByText('Do not enter patient details.', { exact: false })).toBeVisible();
      await expect(page.getByRole('main').getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      await axe(page, `help ${v.t} ${v.w}`);
      expect(violations).toEqual([]);
    } finally { await ctx.close(); }
  }
});

test('[36a] root and /join: "Join the Case", no hint, the code as two groups of three boxes over ONE input; paste, aliases and Backspace across groups, never auto-submit', async ({ browser }) => {
  for (const v of [{ w: 320, h: 568, t: 'light' }, { w: 320, h: 568, t: 'dark' }, { w: 390, h: 844, t: 'light' }, { w: 1280, h: 800, t: 'light' }]) {
    const { ctx, page } = await open(browser, v);
    try {
      await page.goto(`${worker.origin}/`);
      await expect(page.getByRole('heading', { level: 1, name: 'Join the Case', exact: true })).toBeVisible();
      await expect(page.getByText('Six characters. Spaces and hyphens are fine.')).toHaveCount(0);
      await shot(page, 'root-join', v);
      const input = page.getByRole('textbox', { name: 'Session code' });
      await expect(page.getByRole('textbox')).toHaveCount(1); // one native input, boxes are a rendering of it
      const boxes = page.locator('.code-box');
      await expect(boxes).toHaveCount(6);
      const rects = await boxes.evaluateAll(list => list.map(b => { const r = b.getBoundingClientRect(); return { x: r.x, w: r.width, h: r.height }; }));
      const gap = i => rects[i + 1].x - (rects[i].x + rects[i].w);
      expect(gap(2), 'a wider gap between the two groups').toBeGreaterThan(gap(0) + 4);
      expect(Math.abs(gap(0) - gap(1)) + Math.abs(gap(3) - gap(4))).toBeLessThan(1);
      expect(rects[5].x + rects[5].w).toBeLessThanOrEqual(v.w);
      expect(await page.locator('.code-boxes').evaluate(el => el.closest('form').querySelectorAll('.code-box [role], .code-box input').length)).toBe(0);
      expect(await boxes.first().getAttribute('aria-hidden')).toBe('true');
      const text = async () => (await boxes.allInnerTexts()).join('');
      // Paste with a space or a hyphen: normalised, mirrored into the boxes, not submitted.
      for (const pasted of ['6BJ NMB', '6bj-nmb']) {
        await input.fill('');
        await input.focus();
        await input.evaluate((el, value) => { const dt = new DataTransfer(); dt.setData('text/plain', value); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, pasted);
        await expect(input).toHaveValue('6BJNMB');
        expect(await text()).toBe('6BJNMB');
      }
      await page.waitForTimeout(300);
      expect(new URL(page.url()).pathname).toBe('/');
      // Aliases: O reads as 0; I and L as 1.
      await input.fill('');
      await input.pressSequentially('olkil0');
      await expect(input).toHaveValue('01K110');
      expect(await text()).toBe('01K110');
      // Caret editing and Backspace across the group boundary.
      await input.fill('A7K2M9');
      await input.press('Home');
      for (let i = 0; i < 3; i++) await input.press('ArrowRight');
      await expect(page.locator('.code-box[data-active]')).toHaveCount(1);
      expect(await boxes.evaluateAll(list => list.findIndex(b => b.hasAttribute('data-active')))).toBe(3);
      await input.press('Backspace');
      await expect(input).toHaveValue('A72M9');
      expect(await text()).toBe('A72M9');
      expect(await boxes.evaluateAll(list => list.findIndex(b => b.hasAttribute('data-active')))).toBe(2);
      await input.press('Backspace'); await input.press('Backspace');
      await expect(input).toHaveValue('2M9');
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await noOverflow(page)).toBe(true);
      await axe(page, `root ${v.t} ${v.w}`);
    } finally { await ctx.close(); }
  }
  // /join with no code draws the same boxes over its one input.
  const { ctx, page } = await open(browser, { w: 390, h: 844, t: 'light' });
  try {
    await page.goto(joinEntryUrl(worker.origin));
    await expect(page.locator('.code-box')).toHaveCount(6);
    await expect(page.getByLabel('Session code', { exact: true })).toHaveCount(1);
    await page.getByLabel('Session code', { exact: true }).pressSequentially('7K3QX9');
    expect((await page.locator('.code-box').allInnerTexts()).join('')).toBe('7K3QX9');
  } finally { await ctx.close(); }
});

test('[36a] QR landing: /J/<code> renders the v2 join page with the mosaic splash', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const { ctx, page } = await open(browser, { w: 390, h: 844, t: 'light' });
  try {
    await page.goto(joinUrl(room.joinCode, worker.origin));
    await expect(page.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
    await expect(page.locator('.phone-splash [data-splash-art]')).toHaveAttribute('data-art', 'brand');
    await expect.poll(() => page.locator('[data-splash-art] svg polygon').count()).toBeGreaterThan(20);
    await expect(page.locator('.splash-panel')).toBeVisible();
  } finally { await ctx.close(); }
});
