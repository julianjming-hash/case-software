// Card 36b (projector half): lobby, crowded lobby, decision marks and ended splash at both projector sizes,
// in light and dark, against the built projector and a local test Worker. Geometry, not pixels.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { startLocalWorker, createRoom, facilitatorCommand, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { initialState, project } from '../src/shared/room-machine.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { sessionUrl, displayPairUrl } from '../src/shared/urls.mjs';

let worker;
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });

const SHOTS = process.env.C36_SHOTS || null; // a directory: before/after captures for the card, never asserted
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// Captures wait out the splash's assemble (about 1.4 s) so they show the settled art.
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(1600); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

const ART = withSolution(describeCase(FIXTURE), { attempt: 0, summarised: false });
const LONG_TITLE = 'Deteriorating post-operative patient on the surgical ward overnight with escalating oxygen requirement';
const SIZES = [{ width: 1280, height: 720, qr: 223 }, { width: 1920, height: 1080, qr: 335 }];

function view(room, { phase = 'waiting', surface = null, art = ART, title = FIXTURE.title, people = 0 } = {}) {
  const state = initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: { ...FIXTURE, title }, art });
  state.epoch = 100; state.revision = 1;
  if (surface) { state.liveSurfaceId = surface.id; state.revealed = [{ surfaceId: surface.id, variant: -1, kind: 'live', manual: false, at: '2026-10-02T00:00:00Z' }]; }
  state.phase = phase === 'waiting' ? 'lobby' : 'surface_live';
  const v = project(state, 'display'); v.phase = phase;
  if (people) { v.names = Array.from({ length: people }, (_, i) => ({ name: `Person ${i + 1}`, avatarId: 'shadows-01' })); v.counts = { ...v.counts, participants: people, present: people }; v.arrivalCount = people; }
  if (phase === 'decision_open') {
    const d = FIXTURE.decisions[0];
    v.counts.responded = 0;
    v.decision = { decisionId: d.id, prompt: d.prompt, status: 'open', interaction: { type: d.interaction.type, options: d.interaction.options.map(o => ({ id: o.id, label: o.label, disabled: false, explored: false })), rankCount: null } };
  }
  if (phase === 'ended') { v.endedAt = '2026-10-02T01:00:00Z'; v.recapExpiresAt = '2026-10-03T01:00:00Z'; }
  return v;
}
let revision = 0;
async function deliver(page, v) {
  v.revision = ++revision;
  await page.evaluate(frame => { const c = new BroadcastChannel('case-room-local'); c.postMessage(frame); c.close(); },
    { t: 'local_snapshot', view: v, epoch: v.epoch, revision: v.revision, displayRevision: v.displayRevision });
}
async function projector(browser, room, { width, height }, colorScheme, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion });
  const page = await context.newPage();
  await page.goto(`${worker.origin}/check`);
  await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?topology=same-pc&scale=0.005`);
  await expect(page.locator('body')).toHaveClass(/projector/);
  return { context, page };
}
/** A token's resolved px on this page: a probe element measures it, so the assertion follows the token, not a copy. */
const resolved = (page, prop, token) => page.evaluate(([prop, token]) => {
  const probe = document.createElement('div'); probe.style.position = 'absolute'; probe.style.visibility = 'hidden';
  probe.style.setProperty(prop, `var(${token})`); document.body.append(probe);
  const px = prop === 'width' ? probe.getBoundingClientRect().width : parseFloat(getComputedStyle(probe).fontSize);
  probe.remove(); return px;
}, [prop, token]);
const noOverflow = page => page.evaluate(() => ({
  page: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
  panel: [...document.querySelectorAll('.joinpanel, .endcard')].every(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }),
}));
const fontPx = loc => loc.evaluate(n => parseFloat(getComputedStyle(n).fontSize), null, { timeout: 3000 }).catch(() => NaN);
const box = loc => loc.boundingBox({ timeout: 3000 }).catch(() => ({ x: NaN, y: NaN, width: NaN, height: NaN }));
async function axe(page, label) {
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  expect.soft(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), label).toEqual([]);
}
const splashTiles = page => page.locator('.projector-splash svg polygon').count();

for (const size of SIZES) for (const scheme of ['light', 'dark']) {
  const tag = `${size.width}x${size.height}-${scheme}`;
  test(`36b projector lobby, crowded lobby, decision and ended at ${tag}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const room = await createRoom(worker.origin);
    const { context, page } = await projector(browser, room, size, scheme);
    try {
      // proj-lobby: code at --projector-code on one line, QR at --projector-qr, splash art from the room's descriptor.
      await deliver(page, view(room));
      await expect(page.locator('.joinpanel')).toBeVisible(); // a hard wait; every geometry check below is soft so one run reports them all
      await page.waitForTimeout(150);
      await shot(page, `projector-lobby-${tag}`);
      const code = page.locator('.joinpanel .code');
      const codePx = await fontPx(code);
      expect.soft(codePx, 'code font-size equals --projector-code').toBeCloseTo(await resolved(page, 'font-size', '--projector-code'), 1);
      const codeBox = await box(code);
      expect.soft(codeBox.height, 'code is one line').toBeLessThan(codePx * 1.5);
      expect.soft(await code.evaluate(n => getComputedStyle(n).fontFamily, null, { timeout: 3000 }).catch(() => '')).toMatch(/mono/i);
      const qr = await box(page.locator('.qrcard svg'));
      expect.soft(qr.width, 'QR equals --projector-qr').toBeCloseTo(await resolved(page, 'width', '--projector-qr'), 0);
      expect.soft(Math.abs(qr.width - size.qr), `QR ${qr.width} vs ${size.qr}`).toBeLessThanOrEqual(1);
      expect.soft(await page.locator('.qrcard rect').first().getAttribute('fill')).toBe('#ffffff');
      expect.soft(await noOverflow(page)).toEqual({ page: true, panel: true });
      expect.soft(await splashTiles(page), 'case splash tiles').toBeGreaterThan(20);
      await expect.soft(page.locator('.projector-splash')).toHaveAttribute('data-art', 'case');
      const lobbyTitle = await fontPx(page.locator('.joinpanel h1'));
      await axe(page, `lobby ${tag}`);

      // Missing art falls back to the brand splash, never an error.
      await deliver(page, view(room, { art: null }));
      await expect.soft(page.locator('.projector-splash')).toHaveAttribute('data-art', 'brand');
      expect.soft(await splashTiles(page), 'brand splash tiles').toBeGreaterThan(20);

      // proj-lobby-crowded: a long title steps down (--projector-title, then --projector-body in the slim card); the code never shrinks; + N more.
      await deliver(page, view(room, { title: LONG_TITLE, people: 48 }));
      await expect.soft(page.locator('.joinpanel h1')).toHaveText(LONG_TITLE);
      await expect.soft(page.locator('.names .chip.more')).toContainText('more');
      await page.waitForTimeout(150);
      await shot(page, `projector-lobby-crowded-${tag}`);
      const longPx = await fontPx(page.locator('.joinpanel h1'));
      expect.soft(longPx, 'a long title steps down to --projector-title or below').toBeLessThanOrEqual(await resolved(page, 'font-size', '--projector-title') + 0.1);
      expect.soft(longPx, 'never below --projector-body').toBeGreaterThanOrEqual(await resolved(page, 'font-size', '--projector-body') - 0.1);
      expect.soft(lobbyTitle, 'a short title keeps the lobby size').toBeGreaterThanOrEqual(longPx);
      expect.soft(await fontPx(code), 'code unchanged').toBeCloseTo(codePx, 1);
      expect.soft((await box(code)).height, 'code still one line').toBeLessThan(codePx * 1.5);
      expect.soft(await noOverflow(page)).toEqual({ page: true, panel: true });
      await axe(page, `crowded ${tag}`);

      // proj-decision: marks at 72 px.
      await deliver(page, view(room, { phase: 'decision_open', surface: FIXTURE.surfaces[1] }));
      await expect.soft(page.locator('.tiles svg.mark')).toHaveCount(FIXTURE.decisions[0].interaction.options.length);
      await shot(page, `projector-decision-${tag}`);
      for (const box of await page.locator('.tiles svg.mark').evaluateAll(ns => ns.map(n => n.getBoundingClientRect()).map(r => ({ w: r.width, h: r.height }))))
        expect.soft(box, 'mark box').toEqual({ w: 72, h: 72 });
      await expect.soft(page.locator('#main')).toHaveAttribute('data-overflow', 'false');
      expect.soft(await splashTiles(page), 'no splash during a decision').toBe(0);
      await axe(page, `decision ${tag}`);

      // proj-ended: the lobby's splash behind the shipped copy.
      await deliver(page, view(room, { phase: 'ended', surface: FIXTURE.surfaces[1] }));
      await expect.soft(page.locator('.endcard h2')).toHaveText('Session ended');
      await page.waitForTimeout(150);
      await shot(page, `projector-ended-${tag}`);
      await expect.soft(page.locator('.endcard p')).toHaveText('Thank you · your private recap is on your phone for 24 hours');
      expect.soft(await splashTiles(page), 'ended splash').toBeGreaterThan(20);
      expect.soft(await noOverflow(page)).toEqual({ page: true, panel: true });
      await axe(page, `ended ${tag}`);
    } finally { await context.close(); }
  });
}

test('36b projector splash runs no animation under reduced motion and assembles otherwise', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  for (const reducedMotion of ['reduce', 'no-preference']) {
    const { context, page } = await projector(browser, room, SIZES[0], 'light', reducedMotion);
    try {
      await deliver(page, view(room));
      await expect(page.locator('.projector-splash svg polygon').first()).toBeAttached();
      const running = await page.evaluate(() => document.querySelector('.projector-splash').getAnimations({ subtree: true }).length);
      if (reducedMotion === 'reduce') expect(running, 'no splash animation under reduced motion').toBe(0);
      else expect(running, 'assemble runs when motion is allowed').toBeGreaterThan(0);
    } finally { await context.close(); }
  }
});

test('36b an ended room\'s projector stays on the ended state across a reconnect', async ({ browser }) => {
  test.setTimeout(240_000);
  const room = await createRoom(worker.origin);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto(displayPairUrl('00000000', worker.origin));
    await expect(page.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
    const pairCode = (await page.locator('.pair-code').textContent()).replace(/\s/g, '');
    const approved = await fetch(`${worker.origin}/api/v1/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST',
      headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: pairCode }) });
    expect(approved.ok).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/sessions/${room.sessionId}/display`), { timeout: 15_000 });
    await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?scale=0.1`);
    await expect(page.locator('.joinpanel')).toBeVisible();
    for (const type of ['start', 'end']) expect((await facilitatorCommand(worker.origin, room, type))?.receipt, type).toBe('accepted');
    await expect(page.locator('.endcard h2')).toHaveText('Session ended');
    await context.setOffline(true);
    await expect(page.locator('#banners')).toContainText('Connection lost', { timeout: 5000 });
    await context.setOffline(false);
    await expect(page.locator('#banners')).not.toContainText('Connection lost', { timeout: 15_000 });
    await expect(page.locator('.endcard h2')).toHaveText('Session ended');
    await expect(page.getByText('Waiting for the session…')).toHaveCount(0);
    await expect(page.locator('.conn')).toHaveCount(0);
  } finally { await context.close(); }
});

// Julian's screenshot (red-team 36b): decision 2 with its responses shown. The results column takes the decision
// layout (context .8fr, results 1.2fr) and every option label reads on one line at both projector sizes.
test('36b results-shown decision 2 keeps each option label on one line at both projector sizes', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const d = FIXTURE.decisions[1];
  for (const size of SIZES) {
    const { context, page } = await projector(browser, room, size, 'light');
    try {
      const v = view(room, { phase: 'reviewing', surface: FIXTURE.surfaces[1] });
      const options = d.interaction.options.map(o => ({ id: o.id, label: o.label, disabled: false, explored: false }));
      v.decision = { decisionId: d.id, prompt: d.prompt, status: 'locked', interaction: { type: d.interaction.type, options, rankCount: null } };
      v.resultsShown = true; v.avatars = null; // results and avatar chips never share a frame (projector-view)
      const counts = options.map((o, i) => ({ optionId: o.id, label: o.label, count: [3, 1, 1][i] ?? 0, positionCounts: null }));
      v.responseResult = { decisionId: d.id, prompt: d.prompt, roundNo: 1, type: 'single_choice', total: counts.reduce((n, c) => n + c.count, 0), rankCount: null, counts };
      await deliver(page, v);
      await expect(page.locator('.result li')).toHaveCount(options.length);
      await shot(page, `projector-results-${size.width}x${size.height}`);
      const geometry = await page.evaluate(() => {
        const [left, right] = [...document.querySelectorAll('#main > .col')].map(c => c.getBoundingClientRect().width);
        const labels = [...document.querySelectorAll('.result li > span:not(.bar):not(.n)')].map(s => {
          const style = getComputedStyle(s); const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
          return { text: s.textContent, lines: Math.round(s.getBoundingClientRect().height / line) };
        });
        return { ratio: right / left, labels };
      });
      expect.soft(geometry.ratio, `results column is 1.2fr against .8fr at ${size.width}`).toBeCloseTo(1.5, 1);
      for (const label of geometry.labels) expect.soft(label.lines, `${label.text} at ${size.width}`).toBe(1);
      await axe(page, `results ${size.width}`);
    } finally { await context.close(); }
  }
});

// D19 (Diving Deeper, 2026-10-15): a select-all question's count reads "selected by 5", whole, on one line; the count
// column was a fixed 2.4em, which cut it to "select / by 5".
test('D19 a select-all result keeps each "selected by" count whole on one line at both projector sizes', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const d = FIXTURE.decisions[1];
  for (const size of SIZES) {
    const { context, page } = await projector(browser, room, size, 'light');
    try {
      const v = view(room, { phase: 'reviewing', surface: FIXTURE.surfaces[1] });
      const options = ['Surgical team', 'Hyperbaric unit', 'Dive club', 'Public health unit', 'GP'].map((label, i) => ({ id: d.interaction.options[i]?.id ?? `00000000-0000-7000-8000-00000000000${i}`, label, disabled: false, explored: false }));
      v.decision = { decisionId: d.id, prompt: 'Who else needs to know?', status: 'locked', interaction: { type: 'multi_select', options, rankCount: null } };
      v.resultsShown = true; v.avatars = null;
      const counts = options.map((o, i) => ({ optionId: o.id, label: o.label, count: [5, 4, 2, 5, 1][i], positionCounts: null }));
      v.responseResult = { decisionId: d.id, prompt: 'Who else needs to know?', roundNo: 1, type: 'multi_select', total: 5, rankCount: null, counts };
      await deliver(page, v);
      await expect(page.locator('.result li')).toHaveCount(options.length);
      const counted = await page.evaluate(() => [...document.querySelectorAll('.result li > .n')].map(n => {
        const style = getComputedStyle(n), line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
        return { text: n.textContent, lines: Math.round(n.getBoundingClientRect().height / line), clipped: n.scrollWidth > n.clientWidth + 1 };
      }));
      expect(counted.map(item => item.text)).toEqual(['selected by 5', 'selected by 4', 'selected by 2', 'selected by 5', 'selected by 1']);
      for (const item of counted) { expect.soft(item.lines, `${item.text} at ${size.width}`).toBe(1); expect.soft(item.clipped, `${item.text} at ${size.width}`).toBe(false); }
    } finally { await context.close(); }
  }
});

test('36b the ended panel shows its shipped copy even when the splash chunk cannot load', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route(/\/assets\/splash\.[0-9a-f]+\.mjs$/, route => route.abort('failed'));
  const page = await context.newPage();
  try {
    await page.goto(`${worker.origin}/check`);
    await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?topology=same-pc&scale=0.005`);
    await expect(page.locator('body')).toHaveClass(/projector/);
    await deliver(page, view(room, { phase: 'ended', surface: FIXTURE.surfaces[1] }));
    await expect(page.locator('.endcard h2')).toHaveText('Session ended');
    await expect(page.locator('.endcard p')).toHaveText('Thank you · your private recap is on your phone for 24 hours');
    await expect(page.locator('.projector-splash svg')).toHaveCount(0);
  } finally { await context.close(); }
});
