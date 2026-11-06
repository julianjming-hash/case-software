// Card14 exercises only the built projector, display pairing and local test Worker.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLocalWorker, createRoom, facilitatorCommand, serverMirror, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { sessionUrl, displayPairUrl } from '../src/shared/urls.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { docShotsDir } from '../tests/helpers/doc-shots.mjs';
let worker;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
const api = async (path, token, body) => {
  const response = await fetch(`${worker.origin}/api/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect(response.ok, path).toBe(true); return response.json();
};
async function pair(page, room) {
  await page.goto(displayPairUrl('00000000', worker.origin));
  await expect(page.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  const code = (await page.locator('.pair-code').textContent()).replace(/\s/g, '');
  await api(`sessions/${room.sessionId}/display-pairs/approve`, room.facilitatorToken, { code });
  await expect(page).toHaveURL(new RegExp(`/sessions/${room.sessionId}/display`), { timeout: 15_000 });
  await expect(page.locator('.joinpanel')).toBeVisible();
}
async function send(page, frame) {
  await page.evaluate(frame => { const c = new BroadcastChannel('case-room-local'); c.postMessage(frame); c.close(); }, frame);
}
function fixtureView(room, surface, phase = 'live', variant = -1) {
  const state = initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: FIXTURE });
  state.epoch = 100; state.revision = 1;
  if (surface) { state.liveSurfaceId = surface.id; state.revealed = [{ surfaceId: surface.id, variant, kind: phase === 'teaching' ? 'terminal' : 'live', manual: false, at: '2026-10-02T00:00:00Z' }]; }
  state.phase = phase === 'waiting' ? 'lobby' : 'surface_live';
  const view = project(state, 'display'); view.phase = phase; if (phase === 'decision_open') view.counts.responded = 0;
  return view;
}
function manualView(room) {
  let state = initialState({ sessionId: room.sessionId, joinCode: room.joinCode, caseDoc: FIXTURE });
  state.epoch = 99; // enter_manual bumps it to the same epoch as the other local fixtures.
  const ledger = new Map();
  // Manual projector reaches the authored decision only after Arrival findings and
  // the decision's scene, observations and findings have been deliberately shown.
  for (const type of ['start', 'enter_manual', 'advance', 'advance', 'advance', 'advance']) {
    const result = dispatch(state, { type, actor: { role: 'facilitator', id: 'fac' }, at: '2026-10-02T00:00:00Z', epoch: state.epoch, clientEventId: uuidv7(), ...(['start', 'advance'].includes(type) ? { roundId: uuidv7() } : { segmentId: uuidv7() }) }, ledger);
    expect(result.effects.find(e => e.type === 'receipt')?.receipt, type).toBe('accepted');
    state = result.state;
  }
  return project(state, 'display');
}
const frameFor = view => ({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision });
async function steer(room, type, extra = {}) { const receipt = await facilitatorCommand(worker.origin, room, type, extra); expect(receipt?.receipt, `${type}: ${JSON.stringify(receipt)}`).toBe('accepted'); }

test('[AS-025] [AS-037] [AS-038] [AS-050] [AS-053] [AS-054] served display pairs and follows a private-safe full real room', async ({ page }) => {
  test.setTimeout(120_000); const room = await createRoom(worker.origin);
  // Accelerate only the initial healthy display upgrade, preserving real connection budgets.
  await page.addInitScript(() => {
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 120_000 ? 6000 : delay, ...args);
  });
  const payloads = []; const errors = []; const urls = []; let socketSnapshots = 0;
  page.on('request', request => urls.push(request.url()));
  page.on('response', async response => {
    if (!response.url().includes(`/sessions/${room.sessionId}/`) || !/snapshot|updates/.test(response.url())) return;
    try { const body = await response.json(); if (body.t === 'snapshot') payloads.push(body); } catch (error) { errors.push(error.message); }
  });
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => { try { const f = JSON.parse(String(payload)); if (f.t === 'snapshot') { payloads.push(f); socketSnapshots++; } } catch { /* fixed wire ping/pong may be non-JSON */ } }));
  await pair(page, room);
  await page.evaluate(() => sessionStorage.removeItem('case:display:main:token'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pair this display' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  await pair(page, room);
  await page.goto(sessionUrl(room.sessionId, 'display', worker.origin));
  await expect(page.locator('.joinpanel')).toBeVisible();
  const participants = [];
  for (let i = 0; i < 14; i++) participants.push(await api('join', null, { v: 1, code: room.joinCode, displayName: `Team${i}`, avatarId: 'shadows-01' }));
  await expect(page.locator('.names .chip.more')).toContainText('more');
  await expect(page.locator('.names .nm')).toHaveCount(8);
  expect(await page.locator('.names .nm').allTextContents()).toEqual(Array.from({ length: 8 }, (_, i) => `Team${i}`));
  expect(await page.locator('.names .chip:not(.more)').count()).toBeLessThanOrEqual(12);
  await expect.poll(() => payloads.at(-1)?.view.names?.length).toBe(14);
  expect(payloads.at(-1).view.names.map(person => person.name)).toEqual(Array.from({ length: 14 }, (_, i) => `Team${i}`));
  expect(urls.some(url => url.includes('/updates'))).toBe(true);
  await steer(room, 'close_joining', { closed: true });
  await expect(page.getByRole('heading', { name: 'Joining is closed' })).toBeVisible();
  await steer(room, 'close_joining', { closed: false });
  await steer(room, 'start');
  await expect(page.locator('.scene h1')).toHaveText(FIXTURE.surfaces[0].title);
  await expect.poll(() => payloads.at(-1)?.view.names).toBeNull();
  expect(JSON.stringify(payloads.at(-1).view)).not.toMatch(/Team[0-9]+/);
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await steer(room, 'advance'); // arrival findings
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await steer(room, 'advance'); // decision scene
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await steer(room, 'advance'); // decision observations
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await steer(room, 'advance'); // decision findings
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await steer(room, 'advance'); // explicitly Open responses
  await expect(page.locator('.decision')).toBeVisible();
  const mirror = await serverMirror(worker.origin, room);
  const decision = FIXTURE.decisions.find(d => d.id === mirror.decisionId);
  await expect(page.locator('.tiles .lbl')).toHaveText(decision.interaction.options.map(o => o.label));
  await expect(page.locator('.count')).toContainText('0 of');
  const vote = await api(`sessions/${room.sessionId}/commands`, participants[0].token, { v: 1, type: 'vote', epoch: mirror.epoch, clientEventId: uuidv7(), roundId: mirror.round.id, response: { option_id: decision.interaction.options[0].id } });
  expect(vote.receipt.receipt).toBe('accepted');
  await expect.poll(() => payloads.at(-1)?.view.counts.responded).toBe(1);
  await expect(page.locator('.count')).toContainText(`1 of ${payloads.at(-1).view.counts.present} answered`);
  await expect(page.locator('.result')).toHaveCount(0);
  await steer(room, 'show_names', { on: true });
  await expect(page.locator('.count')).toHaveCount(0);
  await expect(page.locator('.names .nm').first()).toHaveText(/Team[0-9]+/);
  expect(await page.locator('.names .chip:not(.more)').count()).toBeLessThanOrEqual(12);
  await steer(room, 'replay', { surfaceId: FIXTURE.surfaces[0].id });
  await expect(page.locator('#banners')).toContainText('Presentation replay');
  await steer(room, 'lock');
  await expect(page.locator('#banners')).toContainText('Presentation replay');
  await expect(page.locator('.decision')).toContainText('Responses locked');
  const before = await page.locator('.screen').innerText();
  await steer(room, 'select_path', { pathId: decision.paths[0].id });
  await expect.poll(() => page.locator('.screen').innerText()).toBe(before);
  await steer(room, 'reveal');
  await expect(page.locator('#banners')).toContainText('Presentation replay');
  await expect(page.locator('.scene h1')).toHaveText(FIXTURE.surfaces[0].title);
  await expect(page.locator('.result')).toHaveCount(0);
  await steer(room, 'replay', { surfaceId: null });
  await expect(page.locator('#banners')).not.toContainText('Presentation replay');
  await expect(page.locator('.scene h1')).toHaveText(FIXTURE.surfaces.find(s => s.id === decision.paths[0].reveal_surface_id).title);
  await expect(page.getByRole('region', { name: 'Responses closed', exact: true })).toBeVisible();
  await expect(page.locator('.result')).toContainText('1 answered');
  await expect(page.locator('.result .n').first()).toHaveText('1');
  await expect.poll(() => socketSnapshots, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.goto(sessionUrl(room.sessionId, 'facilitate', worker.origin));
  await expect(page.locator('body')).toHaveClass(/projector/);
  await expect(page.locator('#surfaceTitle')).toHaveCount(0);
  await steer(room, 'end');
  await expect(page.locator('#banners')).toContainText('Session ended');
  expect(payloads.length).toBeGreaterThan(6); expect(errors).toEqual([]);
  for (const snapshot of payloads) {
    expect(acceptDisplayView(snapshot.view)).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/"(?:cue|notes|rationale|classification|mirror|casePack|response|answers)"\s*:/);
    const publicId = snapshot.view.surface?.surfaceId;
    // Only the currently projected surface ID may occur; no hidden surface collection crosses the wire.
    for (const surface of FIXTURE.surfaces.filter(s => s.id !== publicId)) expect(JSON.stringify(snapshot.view)).not.toContain(surface.id);
  }
  for (const url of urls) expect(url).not.toMatch(/[?&](?:token|name|answer)=/);
  await api(`sessions/${room.sessionId}/display-pairs/revoke`, room.facilitatorToken, {});
  await expect(page.getByRole('heading', { name: 'Pair this display' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Session sound' })).toHaveCount(0);
});

async function localPage(browser, room) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    const activeIntervals = new Set(); let globalListeners = 0;
    const interval = window.setInterval.bind(window); const clear = window.clearInterval.bind(window);
    window.setInterval = (...args) => { const id = interval(...args); activeIntervals.add(id); return id; };
    window.clearInterval = id => { activeIntervals.delete(id); return clear(id); };
    const add = EventTarget.prototype.addEventListener; const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function(...args) { if (this === window || this === document) globalListeners++; return add.apply(this, args); };
    EventTarget.prototype.removeEventListener = function(...args) { if (this === window || this === document) globalListeners--; return remove.apply(this, args); };
    window.projectorResources = () => ({ intervals: activeIntervals.size, globalListeners });
  });
  const page = await context.newPage();
  await page.goto(`${worker.origin}/check`);
  await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?topology=same-pc&scale=0.005`);
  await expect(page.locator('body')).toHaveClass(/projector/);
  return { context, page };
}

test('served same-PC projector rejects private mirrors and renders every MVC surface and public phase legibly in both themes', async ({ browser }) => {
  test.setTimeout(180_000); const room = await createRoom(worker.origin);
  const { context, page } = await localPage(browser, room);
  const screenshots = docShotsDir('14-screenshots');
  let revision = 0;
  const deliver = async view => { view.revision = ++revision; await send(page, frameFor(view)); await expect(page.locator('.scene h1')).toHaveText(view.surface.title); };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const surface of FIXTURE.surfaces) for (const variant of [-1, ...(surface.variants ?? []).map((_, i) => i)]) {
      const view = fixtureView(room, surface, 'live', variant); await deliver(view);
      const evidence = await page.evaluate(() => ({
        overflow: document.querySelector('#main').dataset.overflow,
        pageOverflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
        small: [...document.querySelectorAll('.prose,.find li,.vital .value,.tiles .lbl,.scene h1')].filter(n => n.getClientRects().length).filter(n => parseFloat(getComputedStyle(n).fontSize) < 24).map(n => n.className),
        hidden: [...document.querySelectorAll('.find li')].filter(n => n.hidden).length,
      }));
      expect(evidence, `${theme}: ${surface.title} variant${variant}`).toEqual({ overflow: 'false', pageOverflow: false, small: [], hidden: 0 });
      if (view.surface.points.length) await expect(page.locator('.findings li')).toHaveText(view.surface.points);
      if (view.surface.investigations.length) await expect(page.locator('.investigations li')).toHaveText(view.surface.investigations);
    }
    for (const phase of ['waiting', 'live', 'decision_open', 'reviewing', 'paused', 'teaching', 'ended']) {
      const view = fixtureView(room, phase === 'waiting' ? null : FIXTURE.surfaces[1], phase);
      if (['decision_open', 'reviewing', 'paused'].includes(phase)) {
        const d = FIXTURE.decisions[0]; view.decision = { decisionId: d.id, prompt: d.prompt, status: { decision_open: 'open', reviewing: 'locked', paused: 'paused' }[phase], interaction: { type: d.interaction.type, rankCount: d.interaction.rankCount ?? null, options: d.interaction.options.map(o => ({ id: o.id, label: o.label, disabled: false, explored: false })) } };
      }
      expect(acceptDisplayView(view), `${theme} ${phase} fixture`).toBeTruthy();
      view.revision = ++revision; await send(page, frameFor(view));
      if (phase === 'waiting') {
        await expect(page.locator('#banners .pill')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
        await expect(page.locator('.names .arrival-note')).toHaveText(`${view.counts.participants} joined`);
        await expect(page.getByRole('heading', { name: 'Joining is closed', exact: true })).toHaveCount(0);
      } else {
        await expect(page.locator('#banners .pill')).toBeVisible();
        await expect(page.locator('#banners .pill')).toHaveText({ live: 'Revealed', decision_open: 'Decision open', reviewing: 'Responses locked', paused: 'Discussion pause', teaching: 'Teaching point', ended: 'Session ended' }[phase]);
      }
      await expect(page.locator('#main')).toHaveAttribute('data-overflow', 'false');
      if (phase === 'waiting') {
        expect(await page.locator('.joinpanel .code').evaluate(n => parseFloat(getComputedStyle(n).fontSize))).toBeGreaterThanOrEqual(96);
        expect((await page.locator('.qrcard svg').boundingBox()).height).toBeGreaterThanOrEqual(270);
        expect(await page.locator('.qrcard rect').getAttribute('fill')).toBe('#ffffff');
      }
      const violations = (await new AxeBuilder({ page }).analyze()).violations;
      expect(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), `${theme} ${phase}`).toEqual([]);
      await page.screenshot({ path: `${screenshots}/${theme}-${phase.replaceAll('_', '-')}.png` });
    }
    const manual = manualView(room);
    const decision = FIXTURE.decisions.find(d => d.id === manual.decision.decisionId);
    await deliver(manual);
    await expect(page.locator('#banners')).toContainText('Manual session mode');
    await expect(page.locator('.tiles .lbl')).toHaveText(decision.interaction.options.map(o => o.label));
    await expect(page.locator('.count')).toHaveCount(0);
  }
  const accepted = fixtureView(room, FIXTURE.surfaces[0]); accepted.revision = ++revision; await send(page, frameFor(accepted));
  await expect(page.locator('.scene h1')).toHaveText(accepted.surface.title);
  const privateView = { ...accepted, caseDoc: FIXTURE, surface: { ...accepted.surface, title: 'PRIVATE MIRROR LEAK' }, revision: ++revision };
  await send(page, frameFor(privateView));
  await expect(page.locator('.scene h1')).toHaveText(accepted.surface.title);
  await expect(page.getByText('PRIVATE MIRROR LEAK')).toHaveCount(0);
  const wrongRoom = { ...accepted, sessionId: uuidv7(), revision: ++revision, surface: { ...accepted.surface, title: 'WRONG ROOM' } };
  await send(page, frameFor(wrongRoom)); await expect(page.getByText('WRONG ROOM')).toHaveCount(0);
  const people = { ...accepted, revision: ++revision, names: Array.from({ length: 20 }, (_, i) => ({ name: `Team ${i}`, avatarId: 'shadows-01' })), avatars: null };
  await send(page, frameFor(people)); await expect(page.locator('.chip.more')).toContainText('more');
  expect(await page.locator('.chip:not(.more)').count()).toBeLessThanOrEqual(12);
  await expect(page.locator('.avatar').first()).toBeVisible();
  expect(await page.locator('.avatar').first().evaluate(n => n.complete && n.naturalWidth > 0)).toBe(true);
  await context.close();
});

test('served separate projector remains fresh on unchanged polling and reports a real network cut within fifteen seconds', async ({ page, context }) => {
  const room = await createRoom(worker.origin);
  await page.routeWebSocket('**/ws', socket => socket.close()); // deterministic local long-poll-only network
  let networkCut = false, armPendingRead = false, activeCutRead = null;
  const cancelledReads = new WeakSet();
  let markPendingRead;
  const pendingReadReady = new Promise(resolve => { markPendingRead = resolve; });
  await page.route(url => url.pathname === `/api/v1/sessions/${room.sessionId}/snapshot` || url.pathname === `/api/v1/sessions/${room.sessionId}/updates`, async route => {
    if (networkCut) { await route.abort('internetdisconnected'); return; } // never bypass offline via route.fetch
    const pending = route.fetch(); // the unchanged/snapshot body still comes from the real local Worker
    const held = armPendingRead && new URL(route.request().url()).pathname.endsWith('/updates');
    if (held) { armPendingRead = false; activeCutRead = route; markPendingRead(); }
    try {
      const response = await pending;
      if (!cancelledReads.has(route)) await route.fulfill({ response });
    } catch (error) { if (!cancelledReads.has(route) && !networkCut && !page.isClosed()) throw error; }
  });
  let unchanged = 0;
  page.on('response', async response => { if (response.url().includes('/updates')) { try { if ((await response.json()).t === 'unchanged') unchanged++; } catch { /* offline cut aborts the in-flight poll */ } } });
  await pair(page, room);
  await page.goto(`${sessionUrl(room.sessionId, 'display', worker.origin)}?scale=0.1`);
  await expect(page.locator('.joinpanel')).toBeVisible();
  await page.evaluate(() => {
    window.falseLostSeen = false;
    const banners = document.querySelector('#banners');
    new MutationObserver(() => { if (banners.textContent.includes('Connection lost')) window.falseLostSeen = true; }).observe(banners, { childList: true, subtree: true, characterData: true });
  });
  await page.waitForTimeout(4000); // forty scaled seconds, spanning multiple no-change HTTP replies
  expect(unchanged).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.falseLostSeen)).toBe(false);
  await expect(page.locator('#banners')).not.toContainText('Connection lost');
  armPendingRead = true;
  let readinessTimer;
  const readinessDeadline = new Promise((_, reject) => { readinessTimer = setTimeout(() => reject(new Error('Pending display read did not start')), 2000); });
  try { await Promise.race([pendingReadReady, readinessDeadline]); } finally { clearTimeout(readinessTimer); }
  networkCut = true;
  await context.setOffline(true);
  cancelledReads.add(activeCutRead);
  await activeCutRead.abort('internetdisconnected'); // context offline alone does not cancel an in-flight long-poll
  await expect(page.locator('#banners')).toContainText('Connection lost · follow the facilitator', { timeout: 2100 });
  networkCut = false;
  await context.setOffline(false);
  await expect(page.locator('#banners')).not.toContainText('Connection lost', { timeout: 10_000 });
});

test('served projector is silent until click, uses neutral cues and keeps a two-hour scaled tab bounded', async ({ browser }) => {
  test.setTimeout(120_000); const room = await createRoom(worker.origin);
  const { context, page } = await localPage(browser, room);
  await page.evaluate(() => {
    window.cueEvidence = { created: 0, started: 0, disconnected: 0, tones: 0, wavFetches: 0 };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, ...rest) => { if (String(input?.url ?? input).endsWith('.wav')) window.cueEvidence.wavFetches++; return nativeFetch(input, ...rest); };
    const Native = window.AudioContext;
    window.AudioContext = class extends Native { constructor(...args) { super(...args); window.cueEvidence.created++; }
      createOscillator() { const oscillator = super.createOscillator(); const start = oscillator.start.bind(oscillator);
        oscillator.start = (...args) => { window.cueEvidence.tones++; return start(...args); }; return oscillator; }
      createBufferSource() { const source = super.createBufferSource(); const start = source.start.bind(source); const disconnect = source.disconnect.bind(source);
        source.start = (...args) => { window.cueEvidence.started++; return start(...args); };
        source.disconnect = (...args) => { window.cueEvidence.disconnected++; return disconnect(...args); }; return source; }
    };
  });
  let revision = 1;
  const view = fixtureView(room, FIXTURE.surfaces[0]); view.revision = revision;
  await send(page, frameFor(view)); await expect(page.locator('.scene h1')).toHaveText(view.surface.title);
  const opened = { ...view, phase: 'decision_open', revision: ++revision }; await send(page, frameFor(opened));
  expect(await page.evaluate(() => window.cueEvidence)).toMatchObject({ created: 0, started: 0, wavFetches: 0 });
  await page.getByRole('button', { name: 'Session sound' }).click();
  await expect(page.getByRole('button', { name: 'Session sound' })).toHaveAttribute('aria-pressed', 'true');
  const live = { ...view, revision: ++revision, surface: { ...view.surface, surfaceId: FIXTURE.surfaces[1].id } }; await send(page, frameFor(live));
  await expect.poll(() => page.evaluate(() => window.cueEvidence.started)).toBe(1);
  const deterioration = { ...live, revision: ++revision, surface: { ...live.surface, surfaceId: FIXTURE.surfaces[2].id, timelineKind: 'consequence' } }; await send(page, frameFor(deterioration));
  await page.waitForTimeout(250); expect(await page.evaluate(() => window.cueEvidence.started)).toBe(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await send(page, frameFor({ ...opened, revision: ++revision }));
  await page.waitForTimeout(250); expect(await page.evaluate(() => window.cueEvidence.started)).toBe(1);
  const before = await page.locator('*').count();
  const resourcesBefore = await page.evaluate(() => window.projectorResources());
  // Two simulated hours at scale .005, with hundreds of monotonic manual frames (36 seconds).
  await page.evaluate(async ({ view, revision }) => {
    const c = new BroadcastChannel('case-room-local'); const started = performance.now();
    while (performance.now() - started < 2 * 60 * 60 * 1000 * .005) {
      view.revision = ++revision; c.postMessage({ t: 'local_snapshot', view, epoch: view.epoch, revision: view.revision, displayRevision: view.displayRevision });
      await new Promise(resolve => setTimeout(resolve, 50));
    } c.close();
  }, { view: opened, revision });
  expect(await page.locator('*').count()).toBeLessThanOrEqual(before + 10);
  expect(await page.evaluate(() => window.projectorResources())).toEqual(resourcesBefore);
  const evidence = await page.evaluate(() => window.cueEvidence); expect(evidence.created).toBe(1); expect(evidence.started).toBe(evidence.disconnected);
  expect(evidence.wavFetches).toBe(1); // on demand: only the cue that played
  expect(evidence.tones).toBe(0); // the library samples played; the neutral fallback tone did not
  await context.close();
});

test('the projector keeps only its sound button; a level saved on this device stays saved and enables nothing (CASE-335)', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const { context, page } = await localPage(browser, room);
  await expect(page.getByRole('button', { name: 'Session sound' })).toBeVisible();
  await expect(page.getByRole('slider')).toHaveCount(0); // the room's music and Effects levels live on the console's player
  await page.evaluate(() => localStorage.setItem('case:audio:effects-volume', '0.4'));
  await page.reload();
  await expect(page.locator('body')).toHaveClass(/projector/);
  expect(await page.evaluate(() => localStorage.getItem('case:audio:effects-volume'))).toBe('0.4');
  await expect(page.getByRole('button', { name: 'Session sound' })).toHaveAttribute('aria-pressed', 'false');
  await context.close();
});
