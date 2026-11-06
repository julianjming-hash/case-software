// Card 40 + feedback integration slice 5b: the ended projector. The feedback QR card sits above Session ended on the
// left (the lobby join panel's pattern), and the debrief panel on the right shows page 0 (title, route, objectives) or
// one shown result per page while the console pages it. Geometry and text, not pixels, at both projector sizes.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startLocalWorker, createRoom, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { initialState, project } from '../src/shared/room-machine.mjs';
import { sessionUrl } from '../src/shared/urls.mjs';

const SHOTS = process.env.C40_SHOTS || null; // a directory: captures for review, never asserted
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(1600); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };
let worker;
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });

const SIZES = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }];
const RESULT = { prompt: FIXTURE.decisions[0].prompt, type: 'single_choice', roundNo: 1, total: 12,
  counts: FIXTURE.decisions[0].interaction.options.map((o, i) => ({ label: o.label, count: [7, 4, 1, 0][i] ?? 0 })) };

function endedView(room, { feedbackCode = '7K3QX9', page, results = [RESULT, { ...RESULT, roundNo: 2, total: 9 }] } = {}) {
  const state = initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: FIXTURE });
  state.epoch = 100; state.revision = 1; state.phase = 'surface_live';
  const v = project(state, 'display');
  v.phase = 'ended'; v.endedAt = '2026-10-02T01:00:00Z'; v.recapExpiresAt = '2026-10-03T01:00:00Z';
  v.debrief = { route: FIXTURE.surfaces.slice(1, 3).map(s => s.title), objectives: [...FIXTURE.learning_objectives], results: page === undefined ? [] : results };
  if (page !== undefined) v.debrief.page = page;
  if (feedbackCode) v.feedbackCode = feedbackCode;
  return v;
}
let revision = 0;
async function deliver(page, v) {
  v.revision = ++revision;
  await page.evaluate(frame => { const c = new BroadcastChannel('case-room-local'); c.postMessage(frame); c.close(); },
    { t: 'local_snapshot', view: v, epoch: v.epoch, revision: v.revision, displayRevision: v.displayRevision });
}
const inside = page => page.evaluate(() => ({
  page: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
  panels: [...document.querySelectorAll('.endcard, .fbcard, .debrief-panel')].every(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }),
}));

for (const size of SIZES) for (const colorScheme of ['light', 'dark']) {
  test(`[card 40 projector] ended: feedback QR above Session ended, debrief pages at ${size.width}x${size.height} ${colorScheme}`, async ({ browser }) => {
    const room = await createRoom(worker.origin);
    const context = await browser.newContext({ viewport: size, colorScheme });
    const page = await context.newPage();
    try {
      await page.goto(`${worker.origin}/check`);
      await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?topology=same-pc&scale=0.005`);
      await expect(page.locator('body')).toHaveClass(/projector/);

      // Page 0, before any grant: the summary page and the feedback card; no results, no position.
      await deliver(page, endedView(room));
      await expect(page.locator('.endcard h2')).toHaveText('Session ended');
      const fb = page.locator('.fbcard');
      await expect(fb.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible();
      await expect(fb.locator('svg')).toHaveAttribute('aria-label', /QR code for .*\/F\/7K3QX9/);
      // One read of the live DOM: the projector re-renders on fonts, art and resize, so separate boundingBox() calls can
      // land between renders and see a detached node (null). Read every box in the same frame instead.
      const boxes = await page.evaluate(() => Object.fromEntries(['.fbcard', '.endcard', '.debrief-panel'].map(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return [s, r && { x: r.x, y: r.y, width: r.width, height: r.height }]; })));
      const [fbBox, endBox] = [boxes['.fbcard'], boxes['.endcard']];
      expect(fbBox.y + fbBox.height, 'the feedback card sits above Session ended').toBeLessThanOrEqual(endBox.y + 1);
      expect(Math.abs(fbBox.x - endBox.x), 'one left column').toBeLessThan(2);
      const panel = page.locator('.debrief-panel');
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText(FIXTURE.title);
      await expect(panel.locator('ol.route li')).toHaveCount(2);
      await expect(panel.locator('ol.objectives li')).toHaveCount(FIXTURE.learning_objectives.length);
      await expect(panel.locator('.pos')).toHaveCount(0);
      expect(boxes['.debrief-panel'].x, 'the debrief panel is right of the column').toBeGreaterThan(endBox.x + endBox.width);
      expect(await inside(page)).toEqual({ page: true, panels: true });
      await shot(page, `ended-summary-${size.width}-${colorScheme}`);
      const axe0 = (await new AxeBuilder({ page }).analyze()).violations;
      expect(axe0.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);

      // The fixture's route and four long objectives run past eight lines, so the summary pages (Julian, 2026-10-17):
      // the route, then the objectives, then one result per page.
      const minFont = () => panel.evaluate(n => Math.min(...[...n.querySelectorAll('li, p, h2, span')].filter(e => e.textContent.trim()).map(e => parseFloat(getComputedStyle(e).fontSize))));
      const clipped = () => panel.evaluate(n => n.scrollHeight - n.clientHeight);
      await deliver(page, endedView(room, { page: 0 }));
      await expect(panel.locator('ol.route li')).toHaveCount(2);
      await expect(panel.locator('ol.objectives')).toHaveCount(0);
      await expect(panel.locator('.pos')).toHaveText('1 of 4');
      await deliver(page, endedView(room, { page: 1 }));
      await expect(panel.locator('ol.objectives li')).toHaveCount(FIXTURE.learning_objectives.length);
      await expect(panel.locator('ol.route')).toHaveCount(0);
      await expect(panel.locator('.pos')).toHaveText('2 of 4');
      expect(await clipped(), 'objectives page: nothing clipped').toBeLessThanOrEqual(1);

      // The first result: its prompt, a mark and a count per option, and the position.
      await deliver(page, endedView(room, { page: 2 }));
      await expect(panel.locator('.q')).toHaveText(RESULT.prompt);
      await expect(panel.locator('.pres li')).toHaveCount(RESULT.counts.length);
      await expect(panel.locator('.pres li svg.mark')).toHaveCount(RESULT.counts.length);
      await expect(panel.locator('.pres li .n').first()).toHaveText('7');
      await expect(panel.locator('.pos')).toHaveText('3 of 4');
      await expect(panel).toContainText('12 responses');
      expect(await inside(page)).toEqual({ page: true, panels: true });
      await shot(page, `ended-result-${size.width}-${colorScheme}`);
      const axe1 = (await new AxeBuilder({ page }).analyze()).violations;
      expect(axe1.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);

      // A long route (twice Diving Deeper's three forks) pages too, and each page fits with no text under 18 px.
      for (const p of [0, 1]) {
        const long = endedView(room, { page: p });
        long.debrief.route = Array.from({ length: 6 }, (_, i) => `Day ${i + 1} · ${FIXTURE.surfaces[1].title}`);
        await deliver(page, long);
        await expect(panel.locator('.pos')).toHaveText(`${p + 1} of 4`);
        await shot(page, `ended-long-${p}-${size.width}-${colorScheme}`);
        expect(await clipped(), `long summary page ${p}: nothing clipped`).toBeLessThanOrEqual(1);
        expect(await minFont(), `long summary page ${p}: text stays at or above 18 px`).toBeGreaterThanOrEqual(18);
      }
    } finally { await context.close(); }
  });
}

test('[card 40 projector] a room created before the feedback migration shows no feedback card, and the old view still renders', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const context = await browser.newContext({ viewport: SIZES[0] });
  const page = await context.newPage();
  try {
    await page.goto(`${worker.origin}/check`);
    await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?topology=same-pc&scale=0.005`);
    await expect(page.locator('body')).toHaveClass(/projector/);
    await deliver(page, endedView(room, { feedbackCode: null }));
    await expect(page.locator('.endcard h2')).toHaveText('Session ended');
    await expect(page.locator('.fbcard')).toHaveCount(0);
    // A view with no debrief at all (a cached older Worker) keeps today's ended card alone.
    const old = endedView(room, { feedbackCode: null }); delete old.debrief;
    await deliver(page, old);
    await expect(page.locator('.debrief-panel')).toHaveCount(0);
    await expect(page.locator('.endcard p')).toHaveText('Thank you · your private recap is on your phone for 24 hours');
  } finally { await context.close(); }
});
