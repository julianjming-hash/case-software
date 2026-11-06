// Splash composition guard (Julian, 2026-10-10): "the braid must never be mainly behind a card". On every splash
// surface, at phone and desktop/projector sizes, at least 60% of the art's route and path tiles (every tile but the
// ground) sit outside the opaque cards and bars. Built shell and a local Worker only; static under reduced motion so
// the measure is the composition, not a moment of motion.
import { test, expect } from '@playwright/test';
import { startLocalWorker, createRoom, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { initialState, project } from '../src/shared/room-machine.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { homeUrl, joinUrl, joinEntryUrl, sessionUrl, casesUrl } from '../src/shared/urls.mjs';

const PHONES = [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 375, height: 812 }, { width: 390, height: 844 }];
// Landscape phones: the card fills the stage, so there is no region thick enough; the art draws unfocused behind it,
// and the guard there is only that it never explodes into thousands of micro tiles.
const LANDSCAPE = [{ width: 568, height: 320 }, { width: 740, height: 360 }];
const MAX_TILES = 6000;
const DESKTOPS = [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }];
const ART = withSolution(describeCase(FIXTURE), { attempt: 0, summarised: false });
const TEN_STOP = { v: 1, stops: 10, decisions: [{ stop: 1, strands: [{ rejoin: 3 }, { rejoin: 2 }], resets: 0, ends: 1 }, { stop: 3, strands: [{ rejoin: 5 }], resets: 1, ends: 0 },
  { stop: 5, strands: [{ rejoin: 7 }, { rejoin: 6 }], resets: 0, ends: 0 }, { stop: 7, strands: [{ rejoin: 9 }], resets: 1, ends: 1 }], attempt: 11, summarised: false, renderer: 1 };
const MIN_UNCOVERED = 0.6;

let worker;
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });

/** The share of visible non-ground tiles in `host`'s splash whose centre no cover overlaps (after any re-solve settles). */
async function uncovered(page, host, covers) {
  await expect(page.locator(`${host} svg polygon`).first()).toBeAttached();
  await page.waitForTimeout(500); // the resize re-solve is debounced 200 ms
  return page.evaluate(([host, covers]) => {
    const art = [...document.querySelectorAll(host)].find(el => el.getClientRects().length && el.querySelector('polygon'));
    const stage = art.getBoundingClientRect();
    const boxes = covers.flatMap(sel => [...document.querySelectorAll(sel)]).filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect());
    const tiles = [...art.querySelectorAll('svg polygon:not([data-l="g"])')].map(p => p.getBoundingClientRect())
      .map(r => [r.left + r.width / 2, r.top + r.height / 2])
      .filter(([x, y]) => x >= stage.left && x <= stage.right && y >= stage.top && y <= stage.bottom && x >= 0 && x <= innerWidth);
    const free = tiles.filter(([x, y]) => !boxes.some(b => x > b.left && x < b.right && y > b.top && y < b.bottom));
    return { share: tiles.length ? free.length / tiles.length : 0, tiles: tiles.length, all: art.querySelectorAll('polygon').length, how: art.dataset.how };
  }, [host, covers]);
}
const context = (browser, size) => browser.newContext({ viewport: size, reducedMotion: 'reduce' });
const check = (result, label, { share = true } = {}) => {
  expect.soft(result.tiles, `${label}: path tiles drawn`).toBeGreaterThan(20);
  expect.soft(result.all, `${label}: ${result.all} tiles in the art (${result.how})`).toBeLessThan(MAX_TILES);
  if (!share) return;
  expect.soft(result.share, `${label}: ${Math.round(result.share * 100)}% of the route uncovered (${result.how})`).toBeGreaterThanOrEqual(MIN_UNCOVERED);
};

test('[splash] the braid is never mainly behind a card: room-code entry, facilitator sign-in, phone join and waiting at phone and desktop sizes', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const size of [...PHONES, ...DESKTOPS]) {
    const label = `${size.width}x${size.height}`;
    const room = await createRoom(worker.origin);
    const ctx = await context(browser, size); const page = await ctx.newPage();
    try {
      await page.goto(homeUrl(worker.origin));
      check(await uncovered(page, '.home-art', ['.home-panel', '.site-header']), `home ${label}`);
      await page.goto(casesUrl(worker.origin));
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      check(await uncovered(page, '.auth-art', ['.auth-panel', '.site-header']), `sign-in ${label}`);
      await page.goto(joinEntryUrl(worker.origin));
      check(await uncovered(page, '.phone-splash .splash-art', ['.splash-panel']), `join entry ${label}`);
      await page.goto(joinUrl(room.joinCode, worker.origin));
      check(await uncovered(page, '.phone-splash .splash-art', ['.splash-panel']), `join ${label}`);
      await page.getByLabel('Your name', { exact: true }).fill('Robin');
      await page.getByRole('button', { name: 'Join case', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
      check(await uncovered(page, '.phone-splash .splash-art', ['.splash-panel']), `waiting ${label}`);
    } finally { await ctx.close(); }
  }
});

test('[splash] landscape phones never build a giant scene when the card fills the stage', async ({ browser }) => {
  test.setTimeout(120_000);
  for (const size of LANDSCAPE) {
    const label = `${size.width}x${size.height}`;
    const room = await createRoom(worker.origin);
    const ctx = await context(browser, size); const page = await ctx.newPage();
    try {
      await page.goto(homeUrl(worker.origin));
      check(await uncovered(page, '.home-art', ['.home-panel']), `home ${label}`, { share: false });
      await page.goto(casesUrl(worker.origin));
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      check(await uncovered(page, '.auth-art', ['.auth-panel']), `sign-in ${label}`, { share: false });
      await page.goto(joinUrl(room.joinCode, worker.origin));
      check(await uncovered(page, '.phone-splash .splash-art', ['.splash-panel']), `join ${label}`, { share: false });
    } finally { await ctx.close(); }
  }
});

function view(room, { phase = 'waiting', art = ART, people = 0 } = {}) {
  const state = initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: FIXTURE, art });
  state.epoch = 100; state.revision = 1; state.phase = 'lobby';
  const v = project(state, 'display'); v.phase = phase;
  if (people) { v.names = Array.from({ length: people }, (_, i) => ({ name: `Person ${i + 1}`, avatarId: 'shadows-01' })); v.counts = { ...v.counts, participants: people, present: people }; v.arrivalCount = people; }
  if (phase === 'ended') { v.endedAt = '2026-10-02T01:00:00Z'; v.recapExpiresAt = '2026-10-03T01:00:00Z'; }
  return v;
}
let revision = 0;
const deliver = (page, v) => { v.revision = ++revision; return page.evaluate(frame => { const c = new BroadcastChannel('case-room-local'); c.postMessage(frame); c.close(); },
  { t: 'local_snapshot', view: v, epoch: v.epoch, revision: v.revision, displayRevision: v.displayRevision }); };

test('[splash] the braid is never mainly behind a card: projector lobby and ended at projector sizes', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const size of DESKTOPS) {
    const label = `${size.width}x${size.height}`;
    const room = await createRoom(worker.origin);
    const ctx = await context(browser, size); const page = await ctx.newPage();
    try {
      await page.goto(`${worker.origin}/check`);
      await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?topology=same-pc&scale=0.005`);
      await expect(page.locator('body')).toHaveClass(/projector/);
      const bars = ['.screen > .top', '.screen > footer'];
      for (const [name, art] of [['case', ART], ['brand', null], ['ten-stop', TEN_STOP]]) {
        await deliver(page, view(room, { art, people: 6 }));
        await expect(page.locator('.joinpanel')).toBeVisible();
        await expect(page.locator('.projector-splash')).toHaveAttribute('data-art', art ? 'case' : 'brand');
        check(await uncovered(page, '.projector-splash', [...bars, '.joinpanel']), `lobby ${name} ${label}`);
      }
      await deliver(page, view(room, { phase: 'ended' }));
      await expect(page.locator('.endcard')).toBeVisible();
      check(await uncovered(page, '.projector-splash', [...bars, '.endcard']), `ended ${label}`);
      // The slim card: about a third wide on the left, and everything in it centred.
      await deliver(page, view(room));
      const card = await page.locator('.joinpanel').boundingBox();
      expect.soft(card.width / size.width, 'lobby card about 33% wide').toBeCloseTo(0.33, 1);
      expect.soft(card.x + card.width, 'lobby card on the left').toBeLessThan(size.width * 0.4);
      expect.soft(await page.locator('.joinpanel').evaluate(n => getComputedStyle(n).textAlign)).toBe('center');
      for (const sel of ['.joinpanel h1', '.joinpanel .qrcard', '.joinpanel .code']) {
        const b = await page.locator(sel).boundingBox();
        expect.soft(Math.abs(b.x + b.width / 2 - (card.x + card.width / 2)), `${sel} centred`).toBeLessThan(3);
      }
      await expect(page.locator('.joinpanel .status-line, .joinpanel .code-label')).toHaveCount(0);
    } finally { await ctx.close(); }
  }
});

test('[splash] Motion off in Appearance stops splash motion at once and before first paint (WCAG 2.2.2)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' }); const page = await ctx.newPage();
  try {
    await page.goto(homeUrl(worker.origin));
    const moving = () => page.evaluate(() => document.querySelector('.home-art svg')?.getAnimations({ subtree: true }).length ?? 0);
    await expect.poll(moving).toBeGreaterThan(0);
    await page.getByRole('button', { name: /menu/i }).first().click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const motion = page.getByRole('group', { name: 'Appearance' }).getByRole('switch', { name: 'Reduce motion', exact: true });
    await expect(motion).not.toBeChecked();
    await motion.check();
    await expect.poll(moving).toBe(0);
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Session code', exact: true }).fill('ABC');
    await page.waitForTimeout(800);
    expect(await moving(), 'typing lays nothing with Motion off').toBe(0);
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.dataset.motion), 'applied before first paint').toBe('false');
    await expect(page.locator('.home-art svg polygon').first()).toBeAttached();
    await page.waitForTimeout(1200);
    expect(await moving(), 'no arrival and no ambient life after a reload').toBe(0);
  } finally { await ctx.close(); }
});

test('[splash] typing a room code lays the route one sixth per character, and deleting takes it back', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'no-preference' }); const page = await ctx.newPage();
  try {
    await page.goto(homeUrl(worker.origin));
    await expect(page.locator('.home-art svg polygon').first()).toBeAttached();
    await page.waitForTimeout(2600); // past the laid arrival
    const laid = () => page.evaluate(() => document.querySelector('.home-art svg').getAnimations({ subtree: true })
      .filter(a => a.effect.getTiming().fill === 'forwards' && a.effect.target.dataset.l === 'm').length);
    const code = page.getByRole('textbox', { name: 'Session code', exact: true });
    await code.pressSequentially('AB');
    const two = await laid();
    expect(two, 'two characters lay route tiles').toBeGreaterThan(0);
    await code.pressSequentially('CDEF');
    const six = await laid();
    expect(six, 'six characters lay more of the route').toBeGreaterThan(two);
    await code.fill('');
    await expect.poll(laid, { timeout: 5000 }).toBe(0);
  } finally { await ctx.close(); }
});
