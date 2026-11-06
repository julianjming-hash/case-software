import { test, expect } from '@playwright/test';
import { startLocalWorker, createRoom, facilitatorCommand } from '../tests/helpers/local-worker.mjs';
import { displayPairUrl, samePcProjectorUrl, apiUrl } from '../src/shared/urls.mjs';
import { initialState, reduce, project } from '../src/shared/room-machine.mjs';
import { walkRoom, WALK_AT } from '../tests/helpers/room-walk.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
let worker;
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
const cueCount = page => page.evaluate(() => window.__cueCount);
async function instrument(page) {
  await page.addInitScript(() => {
    window.__cueCount = 0;
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      createBufferSource() { const source = super.createBufferSource(), start = source.start.bind(source); source.start = (...a) => { window.__cueCount++; return start(...a); }; return source; }
      createOscillator() { const source = super.createOscillator(), start = source.start.bind(source); source.start = (...a) => { window.__cueCount++; return start(...a); }; return source; }
    };
  });
}
async function steer(room, type, extra = {}) {
  expect((await facilitatorCommand(worker.origin, room, type, extra)).receipt).toBe('accepted');
}
async function quietReturn(page, expected) {
  await expect(page.locator('.joinpanel')).toHaveCount(0);
  // The fetched cue sample can resolve asynchronously; wait beyond its normal local completion.
  await page.waitForTimeout(300);
  expect(await cueCount(page)).toBe(expected);
}

test('separate projector starts audibly and returns silently after private round changes', async ({ page }) => {
  const room = await createRoom(worker.origin); await instrument(page);
  await page.goto(displayPairUrl('00000000', worker.origin));
  await expect(page.locator('.pair-code')).toHaveText(/[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}/);
  const code = (await page.locator('.pair-code').textContent()).replace(/\s/g, '');
  const approval = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'display-pairs', 'approve'), {
    method: 'POST', headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  expect(approval.ok).toBe(true);
  await expect(page.locator('.joinpanel')).toBeVisible();
  await expect(page.locator('.joinpanel')).toContainText('Join the case');
  await expect(page.locator('body')).not.toContainText('Waiting to start');
  await steer(room, 'close_joining', { closed: true });
  await expect(page.locator('.joinpanel h2')).toHaveText('Joining is closed');
  await expect(page.locator('#announce')).toContainText('Joining is closed');
  await steer(room, 'close_joining', { closed: false });
  await expect(page.locator('#announce')).toContainText('Join the case');
  await steer(room, 'set_music', { playing: false }); // CASE-335: room music plays by default; these tests count event cues only
  await page.getByRole('button', { name: 'Session sound', exact: true }).click();
  await steer(room, 'start'); await expect.poll(() => cueCount(page)).toBe(1);
  await steer(room, 'show_lobby', { on: true }); await expect(page.locator('.joinpanel')).toBeVisible();
  await steer(room, 'show_lobby', { on: false }); await quietReturn(page, 1);
  for (let i = 0; i < 2; i++) await steer(room, 'advance');
  await expect.poll(() => cueCount(page)).toBe(2);
  for (let i = 0; i < 3; i++) await steer(room, 'advance');
  await expect(page.locator('.decision')).toBeVisible(); await expect.poll(() => cueCount(page)).toBe(3);
  await steer(room, 'show_lobby', { on: true }); await expect(page.locator('.joinpanel')).toBeVisible();
  await steer(room, 'lock'); await steer(room, 'reopen');
  await steer(room, 'show_lobby', { on: false }); await quietReturn(page, 3);
  await page.reload(); await expect(page.locator('.decision')).toBeVisible(); expect(await cueCount(page)).toBe(0);
});

test('same-PC projector keeps restoration quiet across repeated and stale local frames', async ({ page }) => {
  const room = await createRoom(worker.origin); await instrument(page);
  await page.goto(samePcProjectorUrl(room.sessionId, worker.origin));
  await page.evaluate(() => { window.__channel = new BroadcastChannel('case-room-local'); });
  const { doc, states } = walkRoom(); let revision = 0;
  async function send(state, { stale = false } = {}) {
    // CASE-335: room music plays by default; these tests count event cues only, so the room's music is paused.
    const view = project({ ...state, music: { ...state.music, playing: false }, sessionId: room.sessionId, joinCode: room.joinCode, epoch: 100, revision: stale ? 1 : ++revision }, 'display');
    await page.evaluate(view => window.__channel.postMessage({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }), view);
    return view;
  }
  await send(initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: doc }));
  await expect(page.locator('.joinpanel')).toBeVisible();
  await page.getByRole('button', { name: 'Session sound', exact: true }).click();
  const live = states.find(s => s.phase === 'surface_live' && !s.manual);
  const shown = await send(live); await expect(page.locator('.scene h1')).toHaveText(shown.surface.title);
  await expect.poll(() => cueCount(page)).toBe(1);
  const change = (state, type, extra = {}) => {
    const result = reduce(state, { type, ...extra, epoch: state.epoch, actor: { role: 'facilitator', id: 'fac' }, at: WALK_AT, clientEventId: uuidv7() });
    expect(result.effects.find(e => e.type === 'receipt').receipt).toBe('accepted'); return result.state;
  };
  let overlay = change(live, 'show_lobby', { on: true });
  await send(overlay); await expect(page.locator('.joinpanel')).toBeVisible();
  await send(overlay); await send(live, { stale: true }); await expect(page.locator('.joinpanel')).toBeVisible();
  await send(change(overlay, 'show_lobby', { on: false })); await quietReturn(page, 1);
  const decision = states.find(s => s.phase === 'responses_open' && !s.manual);
  await send(decision); await expect(page.locator('.decision')).toBeVisible(); await expect.poll(() => cueCount(page)).toBe(2);
  overlay = change(decision, 'show_lobby', { on: true }); await send(overlay); await expect(page.locator('.joinpanel')).toBeVisible();
  overlay = change(change(overlay, 'lock'), 'reopen', { roundId: uuidv7() });
  await send(overlay); await send(change(overlay, 'show_lobby', { on: false })); await quietReturn(page, 2);
  await page.evaluate(() => window.__channel.close());
});

test('projector cancels delayed publication sound across the join screen and reuses its decoded sample', async ({ page }) => {
  const room = await createRoom(worker.origin); await instrument(page);
  await page.addInitScript(() => {
    window.__decoding = false;
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      async decodeAudioData(bytes) {
        const buffer = await super.decodeAudioData(bytes);
        window.__decoding = true;
        return new Promise(resolve => { window.__releaseDecode = () => resolve(buffer); });
      }
    };
  });
  await page.goto(samePcProjectorUrl(room.sessionId, worker.origin));
  await page.evaluate(() => { window.__channel = new BroadcastChannel('case-room-local'); });
  const { doc, states } = walkRoom(); let revision = 0;
  async function send(state) {
    const view = project({ ...state, music: { ...state.music, playing: false }, sessionId: room.sessionId, joinCode: room.joinCode, epoch: 100, revision: ++revision }, 'display');
    await page.evaluate(view => window.__channel.postMessage({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }), view);
    return view;
  }
  await send(initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: doc }));
  await expect(page.locator('.joinpanel')).toBeVisible();
  await page.getByRole('button', { name: 'Session sound', exact: true }).click();
  const live = states.find(s => s.phase === 'surface_live' && !s.manual);
  await send(live); await expect.poll(() => page.evaluate(() => window.__decoding)).toBe(true);
  const overlay = structuredClone(live); overlay.display.lobby = true; overlay.display.revision++;
  await send(overlay); await expect(page.locator('.joinpanel')).toBeVisible();
  await send(live); await expect(page.locator('.scene')).toBeVisible();
  await page.evaluate(() => window.__releaseDecode());
  await quietReturn(page, 0);
  // The following genuine publication uses the completed buffer without another held decode.
  const next = states.find(s => s.phase === 'surface_live' && !s.manual && s.revealed.at(-1)?.surfaceId !== live.revealed.at(-1)?.surfaceId);
  expect(next).toBeTruthy();
  await send(next); await expect.poll(() => cueCount(page)).toBe(1);
  // Standard and soft events share one decoded sample. A separate device context
  // gives the pending-decision check a genuine first decode without evicting that cache.
  const decision = states.find(s => project(s, 'display').phase === 'decision_open' && !s.manual);
  expect(decision).toBeTruthy();
  const pendingContext = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const pendingPage = await pendingContext.newPage(); await instrument(pendingPage);
    await pendingPage.addInitScript(() => {
      window.__decoding = false;
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        async decodeAudioData(bytes) {
          const buffer = await super.decodeAudioData(bytes);
          window.__decoding = true;
          return new Promise(resolve => { window.__releaseDecode = () => resolve(buffer); });
        }
      };
    });
    await pendingPage.goto(samePcProjectorUrl(room.sessionId, worker.origin));
    await expect(pendingPage.locator('body')).toHaveClass(/projector/);
    await pendingPage.evaluate(() => { window.__channel = new BroadcastChannel('case-room-local'); });
    const pendingSend = async state => {
      const view = project({ ...state, music: { ...state.music, playing: false }, sessionId: room.sessionId, joinCode: room.joinCode, epoch: 100, revision: ++revision }, 'display');
      await pendingPage.evaluate(view => window.__channel.postMessage({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }), view);
      return view;
    };
    await pendingSend(initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: doc }));
    await expect(pendingPage.locator('.joinpanel')).toBeVisible();
    await pendingPage.getByRole('button', { name: 'Session sound', exact: true }).click();
    const pendingDecisionView = await pendingSend(decision);
    await expect.poll(() => pendingPage.evaluate(() => window.__decoding)).toBe(true);
    expect(await cueCount(pendingPage)).toBe(0);
    pendingDecisionView.timer = { paused: true, remainingS: 45 };
    pendingDecisionView.revision = ++revision;
    await pendingPage.evaluate(view => window.__channel.postMessage({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }), pendingDecisionView);
    await expect(pendingPage.locator('#timerLine')).toHaveText('0:45'); // CASE-335: digits only
    expect(await cueCount(pendingPage)).toBe(0);
    await pendingPage.evaluate(() => window.__releaseDecode());
    await expect.poll(() => cueCount(pendingPage)).toBe(1);
    await pendingPage.evaluate(() => window.__channel.close());
  } finally { await pendingContext.close(); }
  // The original device still reuses its sample for the standard decision event.
  const decisionView = await send(decision);
  decisionView.timer = { paused: true, remainingS: 45 };
  decisionView.revision = ++revision;
  await page.evaluate(view => window.__channel.postMessage({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision }), decisionView);
  await expect(page.locator('#timerLine')).toHaveText('0:45'); // CASE-335: digits only
  await expect.poll(() => cueCount(page)).toBe(2);
  await page.evaluate(() => window.__channel.close());
});
