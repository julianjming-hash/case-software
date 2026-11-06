import { chooseOption } from '../tests/helpers/choose-option.mjs';
// Card 37: console live fixes, through the built console, a same-PC projector and phones against the real local
// Worker. The dock never goes blank, background updates never move the console, options look as the room sees them
// with private callouts kept to the console, and the lobby screen (CASE-176) comes and goes mid-case.
import { openCase } from '../tests/helpers/library-flow.mjs';
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE, serverMirror } from '../tests/helpers/local-worker.mjs';
import { apiUrl, casesUrl, joinUrl, samePcProjectorUrl } from '../src/shared/urls.mjs';
import { formatCode, uuidv7 } from '../src/shared/ids.mjs';
import { markFor } from '../src/client/projector-marks.mjs';
import { miniCase } from '../tests/helpers/mini-case.mjs';
import { consoleReady, openRoomSetup, closeRoomSetup, projectorPage, dismissDisplayReminder, endCase, confirmInPlace, openPairing, enterManualRoom } from '../tests/helpers/console-v2.mjs';

const SHOTS = fileURLToPath(new URL('../test-results/card-37-screenshots/', import.meta.url));
const decision = FIXTURE.decisions[0];
let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

/** Signed in, a room started with a same-PC projector open and confirmed, and the first decision open. */
async function openDecision(context, { served = shell, steps = ['Reveal findings', 'Show decision context', 'Reveal observations', 'Reveal findings', 'Open responses'] } = {}) {
  const page = await context.newPage();
  await page.goto(casesUrl(served.origin));
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const created = served.waitForCreatedRoom();
  await (await openCase(page)).click();
  const room = await created;
  // Start room opened the same-PC projector in its own click (console layout v2).
  const projector = await projectorPage(page);
  await expect(projector).toHaveURL(samePcProjectorUrl(room.sessionId, served.origin));
  await expect(projector.locator('.joinpanel')).toBeVisible();
  await dismissDisplayReminder(page);
  await page.getByRole('button', { name: 'Start case' }).click();
  for (const name of steps) await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
  return { page, projector, room };
}
/** CASE-335: set the player's timer length with its −/+ stepper (the CASE-320 stops). */
async function pickTimer(page, wanted) {
  const value = page.locator('.player-pick-value'), stops = ['0:10','0:15','0:20','0:25','0:30','0:35','0:40','0:45','0:50','0:55','1:00','1:15','1:30','1:45','2:00','2:30','3:00','3:30','4:00','4:30','5:00'];
  for (let n = 0; n < 25 && (await value.textContent()) !== wanted; n++) {
    const now = stops.indexOf(await value.textContent());
    await page.getByRole('button', { name: now < stops.indexOf(wanted) ? 'Longer timer' : 'Shorter timer', exact: true }).click();
  }
  await expect(value).toHaveText(wanted);
}
async function apiParticipant(room, name, origin = worker.origin) {
  const joined = await fetch(apiUrl(origin, 'join'), { method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.137' },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName: name, avatarId: 'shadows-01' }) });
  expect(joined.status).toBe(201);
  return joined.json();
}
async function apiVote(room, participant, option, origin = worker.origin, response = { option_id: option?.id }) {
  const mirror = await serverMirror(origin, room);
  const voted = await fetch(apiUrl(origin, 'sessions', room.sessionId, 'commands'), { method: 'POST',
    headers: { authorization: `Bearer ${participant.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'vote', epoch: mirror.epoch, clientEventId: uuidv7(), roundId: mirror.round.id, response }) });
  expect((await voted.json()).receipt.receipt).toBe('accepted');
}
const dockButton = page => page.locator('.console-primary');
/** Every focus key on the console is unique, so a restore can never land on another person's or route's control. */
async function uniqueFocusKeys(page, where) {
  const keys = await page.evaluate(() => [...document.querySelectorAll('.console-room [data-focus-key]')].map(n => n.dataset.focusKey));
  expect(keys.filter((key, i) => keys.indexOf(key) !== i), `${where}: duplicate focus keys`).toEqual([]);
}

test('[card 37] the dock is never empty: one atomic Reveal dismisses the chart; options carry room marks and private callouts stay on the console', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  try {
    const { page, projector, room } = await openDecision(context);
    await apiVote(room, await apiParticipant(room, 'Voter'), decision.interaction.options[2]);
    // Item 3: the Room sees column shows the options as phones do, in the authored order, with Only you callouts.
    const tiles = page.locator('.console-room-sees .console-options .opt-tile');
    await expect(tiles).toHaveCount(decision.interaction.options.length);
    for (const [index, option] of decision.interaction.options.entries()) {
      const tile = tiles.nth(index);
      await expect(tile.locator('.lbl')).toHaveText(option.label);
      await expect(tile.locator('svg.mark')).toHaveClass(new RegExp(`\\bmark-${markFor(index).colour}\\b`));
      await expect(tile.locator('.sr-only')).toHaveText(`${markFor(index).name}:`);
      expect(await tile.evaluate(node => node.style.getPropertyValue('--mk'))).toBe(markFor(index).fill);
    }
    const sound = decision.paths.find(path => path.classification === 'sound');
    const callouts = page.locator('.console-options .console-callout');
    await expect(callouts.filter({ hasText: sound.rationale })).toHaveCount(1);
    await expect(callouts.first()).toContainText('Only you');
    await uniqueFocusKeys(page, 'responses_open');
    await page.locator('.console-options').screenshot({ path: `${SHOTS}console-options-1366.png`, animations: 'disabled' });
    for (const path of decision.paths) {
      await expect(projector.locator('body')).not.toContainText(path.rationale.slice(0, 40));
      await expect(projector.locator('body')).not.toContainText(path.cue.slice(0, 20));
    }
    expect(await projector.content()).not.toMatch(/console-callout|Only you/);
    // Lock retains the chart; local authored choice does not command authority. One Reveal publishes and dismisses.
    await dockButton(page).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    await uniqueFocusKeys(page, 'responses_locked');
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toBeVisible();
    const beforeChoice = await serverMirror(worker.origin, room), commands = [];
    page.on('request', request => { if(request.method()==='POST'&&request.url().endsWith('/commands')) commands.push(request.postDataJSON()); });
    const authored = page.getByRole('radio', { name: `Choose ${sound.label}`, exact: true });
    await authored.click();await expect(authored).toHaveAttribute('aria-checked','true');
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    expect((await serverMirror(worker.origin, room)).revision).toBe(beforeChoice.revision);
    expect((await serverMirror(worker.origin, room)).selectedPathId).toBeNull();expect(commands).toEqual([]);
    await expect(dockButton(page)).toHaveText(/^Reveal: /);
    await expect(page.getByRole('button', { name: 'Hide responses on projector', exact: true })).toHaveCount(1);
    await uniqueFocusKeys(page, 'local_route_preview');
    await expect(page.getByRole('button', { name: /^Reveal:/ })).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}console-dock-local-route-1366.png`, animations: 'disabled' });
    await dockButton(page).click();
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({type:'reveal_path',pathId:sound.id,expectRevision:beforeChoice.revision});
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed');
    await expect(dockButton(page)).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-196] Room sees is the projector screen itself, drawn by the projector renderer and updated with the room', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  try {
    const { page, projector, room } = await openDecision(context);
    const frame = page.locator('.console-room-sees .console-mirror iframe');
    await expect(frame).toHaveCount(1);
    const copy = page.frameLocator('.console-room-sees .console-mirror iframe');
    // The same options the projector draws, as tiles, in the copy (CASE-327: not a list of block types).
    for (const option of decision.interaction.options) {
      await expect(copy.locator('.opt-tile', { hasText: option.label })).toHaveCount(1);
      await expect(projector.locator('.opt-tile', { hasText: option.label })).toHaveCount(1);
    }
    expect(await copy.locator('body').getAttribute('class')).toContain('projector');
    // The projector window's own shape, scaled to the panel (its hello reports its size), hidden from assistive tech (the
    // panel keeps its words for screen readers).
    const shape = await projector.evaluate(() => innerWidth / innerHeight);
    await expect.poll(async () => { const box = await page.locator('.console-room-sees .console-mirror').boundingBox(); return Math.abs(box.width / box.height - shape) < 0.02; }).toBe(true);
    await expect(frame).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.console-room-sees .sr-only .console-options .opt-tile')).toHaveCount(decision.interaction.options.length);
    // It follows the room: after a vote, the copy's slide reads as the projector's does.
    await apiVote(room, await apiParticipant(room, 'Voter'), decision.interaction.options[0]);
    const words = locator => locator.locator('main').evaluate(node => node.innerText.replace(/\s+/g, ' ').trim());
    await expect.poll(async () => (await words(copy)) === (await words(projector))).toBe(true);
  } finally { await context.close(); }
});

test('[card 37] projector hellos and votes keep the console scroll position and its nodes; controls stay still while the timer ticks', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 560 } });
  try {
    const { page, room } = await openDecision(context);
    const transitions = await page.locator('.console-room .btn').evaluateAll(buttons => buttons.filter(button => getComputedStyle(button).transitionDuration.split(',').some(value => parseFloat(value) > 0)).map(button => ({label:button.getAttribute('aria-label') ?? button.textContent, duration:getComputedStyle(button).transitionDuration})));
    expect(transitions, 'live console controls do not inherit catalogue transitions').toEqual([]);
    const voters = await Promise.all(['A', 'B', 'C'].map(name => apiParticipant(room, `Voter ${name}`)));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await closeRoomSetup(page);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 2000);
    // The wheel scroll may animate: wait until it has settled before taking the reference position.
    await expect.poll(() => page.evaluate(() => new Promise(done => { const a = scrollY; setTimeout(() => done(a > 100 && scrollY === a), 300); }))).toBe(true);
    // Below the one-screen size the console stacks and scrolls; votes add response rows above the facilitator's view, so
    // what must hold still is what is on screen (the browser anchors it), measured by the rail's place in the viewport.
    const onScreen = () => page.evaluate(() => Math.round(document.querySelector('.console-rail').getBoundingClientRect().top));
    const before = await page.evaluate(() => { window.__scene = document.querySelector('.console-scene'); window.__header = document.querySelector('.console-orientation'); return 0; }) + await onScreen();
    for (const [index, voter] of voters.entries()) {
      await apiVote(room, voter, decision.interaction.options[index]);
      await expect(page.locator('.console-phase')).toContainText(`${index + 1} of`);
    }
    await page.waitForTimeout(9_000); // two or more same-PC projector hellos (every 4 s)
    expect(Math.abs(await onScreen() - before), 'what is on screen does not move').toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.querySelector('.console-scene') === window.__scene), 'the scene node survives votes and hellos').toBe(true);
    expect(await page.evaluate(() => document.querySelector('.console-orientation') === window.__header), 'the header survives votes and hellos').toBe(true);
    // CASE-335 / canonical HTML: only the player's countdown stroke moves; background console controls stay still.
    // Sample an actual tick rather than randomly counting the permitted 250ms timer transition as a failure.
    const ticking = await page.waitForFunction(() => {
      const active = document.getAnimations().filter(a => a.effect?.target?.closest?.('.console-room'));
      const clock = active.find(a => a.constructor.name === 'CSSTransition' && a.transitionProperty === 'stroke-dasharray' && a.effect.target.matches('.console-player .player-ring .ring-fill'));
      return clock ? { clock: clock.transitionProperty, unexpected: active.filter(a => a !== clock).map(a => ({ target: a.effect.target.getAttribute('class'), property: a.transitionProperty ?? a.animationName })) } : null;
    });
    const motion = await ticking.jsonValue();expect(motion.clock, 'the real countdown is ticking').toBe('stroke-dasharray');
    expect(motion.unexpected, 'no console control or panel animation during a timer tick').toEqual([]);
    expect(Math.abs(await onScreen() - before), 'the timer tick does not move the view').toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.querySelector('.console-scene') === window.__scene && document.querySelector('.console-orientation') === window.__header), 'votes, hellos and the timer preserve the console nodes').toBe(true);
  } finally { await context.close(); }
});

test('[AS-107] [AS-108] the lobby screen mid-decision: a late phone joins and votes, the projector shows no case material, and returning is exact', async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  try {
    const { page, projector, room } = await openDecision(context);
    await apiVote(room, await apiParticipant(room, 'Early'), decision.interaction.options[0]);
    await expect(projector.locator('#main')).toContainText(decision.prompt);
    const before = await serverMirror(worker.origin, room);
    // What the projector was given before the lobby: compared field by field after the return (its fitted text
    // layout depends on font and viewport timing, so the frame, not innerText, is the exact record).
    const SHOWN = ['phase', 'replay', 'manual', 'surface', 'decision', 'resultsShown', 'resultsPage', 'responseResult', 'lastResult'];
    await page.evaluate(() => { window.__frames = []; const c = new BroadcastChannel('case-room-local'); c.onmessage = ({ data }) => { if (data?.t === 'local_snapshot') window.__frames.push(data.view); }; window.__frameChannel = c; });
    await expect.poll(() => page.evaluate(() => window.__frames.length), { message: 'a pre-lobby frame (hellos re-publish every 4 s)', timeout: 15_000 }).toBeGreaterThan(0);
    // Show the lobby: the rail's toggle (console layout v2); Room sees says so; the bottom bar is Return to case.
    const railRoom = page.getByRole('complementary', { name: 'Session' });
    await railRoom.getByRole('button', { name: 'Show join screen', exact: true }).click();
    await expect(railRoom.getByRole('button', { name: 'Hide join screen', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Return to case', exact: true })).toHaveCount(1);
    await expect(page.locator('.console-room-sees .console-join-screen')).toContainText('Projector: join screen');
    await expect(dockButton(page)).toHaveText('Return to case');
    await expect(projector.locator('.joinpanel')).toBeVisible();
    await expect(projector.locator('.joinpanel')).toContainText(FIXTURE.title);
    await expect(projector.locator('.joinpanel .code')).toHaveText(formatCode(room.joinCode));
    // AS-108: nothing of the case reaches the lobby screen.
    const lobbyText = await projector.locator('body').innerText();
    const material = [decision.prompt, ...decision.interaction.options.map(o => o.label), ...FIXTURE.surfaces.map(s => s.title).filter(t => t !== FIXTURE.title),
      ...decision.paths.map(p => p.rationale.slice(0, 40))];
    for (const text of material) expect(lobbyText, `lobby screen shows "${text}"`).not.toContain(text);
    await expect(projector.locator('.scene, .decision, .tiles, .vitals, [aria-label="Responses closed"]')).toHaveCount(0);
    // The same-PC frame itself, not only what the projector chooses to draw, carries no case material.
    const frame = await page.evaluate(() => window.__frames.findLast(view => view.phase === 'waiting'));
    const shownBefore = await page.evaluate(keys => { const v = window.__frames.findLast(view => view.phase !== 'waiting'); return v && Object.fromEntries(keys.map(k => [k, v[k]])); }, SHOWN);
    expect(shownBefore?.phase, 'a frame from before the lobby was captured').toBe('decision_open');
    expect(frame, 'a lobby frame reached the same-PC projector').toBeTruthy();
    for (const key of ['surface', 'decision', 'responseResult', 'lastResult', 'timer']) expect(frame[key], key).toBeNull();
    for (const text of material) expect(JSON.stringify(frame)).not.toContain(text);
    await page.screenshot({ path: `${SHOTS}console-lobby-view-1366.png`, animations: 'disabled' });
    await expect(projector.locator('#projectorCheck')).toBeHidden({ timeout: 15_000 }); // the display-check word, shown for 6 s
    await projector.setViewportSize({ width: 1920, height: 1080 });
    await projector.screenshot({ path: `${SHOTS}projector-lobby-mid-case-1920.png`, animations: 'disabled' });
    // A late phone joins as today and lands on the open decision, and its vote counts.
    const phone = await phoneContext.newPage();
    await phone.goto(joinUrl(room.joinCode, shell.origin));
    await phone.getByLabel('Your name', { exact: true }).fill('Late');
    await phone.getByRole('button', { name: 'Join case', exact: true }).click();
    await phone.getByRole('radio', { name: `${markFor(2).name}: ${decision.interaction.options[2].label}`, exact: true }).check();
    await expect(phone.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
    await expect(phone.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
    // Names stay hidden mid-case (CASE-133): the latecomer arrives as an avatar chip, never a name.
    await expect(projector.locator('.names li.chip.anonymous')).toHaveCount(2);
    await expect(projector.locator('.names .nm')).toHaveCount(0);
    const during = await serverMirror(worker.origin, room);
    expect(during.phase).toBe('responses_open'); expect(Object.keys(during.round.responses)).toHaveLength(2);
    expect(during.revealed).toEqual(before.revealed); expect(during.display.cursor).toBe(before.display.cursor);
    // The private round steps stay available from the Run view; projector commands are not offered.
    await closeRoomSetup(page);
    await expect(page.getByRole('button', { name: 'Lock responses & review', exact: true })).toHaveCount(1);
    await expect(dockButton(page)).toHaveText('Return to case');
    // Return: the projector shows exactly what it showed before, with the late answer counted.
    await dockButton(page).click();
    await expect(railRoom.getByRole('button', { name: 'Show join screen', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.console-join-screen')).toHaveCount(0);
    await projector.setViewportSize({ width: 1366, height: 768 });
    await expect(projector.locator('.joinpanel')).toHaveCount(0);
    await expect(projector.locator('#main')).toContainText(decision.prompt);
    await expect.poll(() => page.evaluate(keys => { const v = window.__frames.at(-1); return v.phase === 'waiting' ? null : Object.fromEntries(keys.map(k => [k, v[k]])); }, SHOWN),
      { message: 'the projector is given exactly the display it had' }).toEqual(shownBefore);
    // Lock, choose the authored local override and atomically Reveal in one press.
    await dockButton(page).click();
    await page.getByRole('radio', { name: `Choose ${decision.paths.find(path => path.classification === 'sound').label}`, exact: true }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase','responses_locked');
    await expect(dockButton(page)).toHaveText(/^Reveal: /);
    await dockButton(page).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed');
    const consequence = FIXTURE.surfaces.find(s => s.id === decision.paths.find(p => p.classification === 'sound').reveal_surface_id);
    await expect(projector.locator('#main')).toContainText(consequence.title);
    await expect(phone.getByText(consequence.title).first()).toBeVisible();
  } finally { await phoneContext.close(); await context.close(); }
});

test('[card 37] a re-rendered control runs the fresh render\'s handler, never one that captured an older page (Chromium, the results-page shape)', async ({ page }) => {
  // The console's own patcher, in a real DOM: a Next button whose label and state are unchanged across a page
  // change must still send the NEW next page (red-team H1: it sent page 1 twice).
  const source = readFileSync(new URL('../src/client/console-focus.mjs', import.meta.url), 'utf8').replace(/export /g, '');
  await page.setContent('<div id="root"></div>');
  const sent = await page.evaluate(`${source};
    const root = document.getElementById('root'), sent = [];
    const button = (label, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.onclick = fn; return b; }; // the console's button(): a property handler
    const render = (page, pages) => { const fresh = document.createElement('section'), box = document.createElement('div');
      const previous = button('Previous results page', () => sent.push(page - 1)); previous.disabled = page === 0;
      const next = button('Next results page', () => sent.push(page + 1)); next.disabled = page === pages - 1;
      box.append(previous, next); fresh.append(box); patchChildren(root, fresh); };
    render(0, 3); root.querySelectorAll('button')[1].click(); render(sent.at(-1), 3); root.querySelectorAll('button')[1].click(); sent`);
  expect(sent).toEqual([1, 2]);
});

test('[card 37] ranked paging works after a foreign revision bump online and page after page in manual room mode', async ({ browser }) => {
  test.setTimeout(180_000);
  const fixture = miniCase(), ranked = fixture.doc.decisions[0];
  ranked.interaction.type = 'ranking'; ranked.interaction.rank_count = 8;
  while (ranked.interaction.options.length < 8) ranked.interaction.options.push({ id: uuidv7(), label: `Additional option ${ranked.interaction.options.length + 1}` });
  ranked.paths.forEach(path => { delete path.option_ids; });
  ranked.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const localAuth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  let localWorker, localShell, context;
  try {
    localWorker = await startPublishedWorker({ authOrigin: localAuth.origin, caseDocument: fixture.doc }); localAuth.setJwt(localWorker.jwt);
    localShell = await startServedAuthShell({ apiOrigin: localWorker.origin, buildAuthBindings: { SUPABASE_URL: localAuth.origin,
      SUPABASE_JWT_ISSUER: `${localAuth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${localAuth.origin}/auth/v1/.well-known/jwks.json` } });
    localAuth.setAppOrigin(localShell.origin);
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
    const { page, room } = await openDecision(context, { served: localShell, steps: ['Show decision context', 'Open responses'] });
    const ids = ranked.interaction.options.map(option => option.id);
    const orders = [ids, [ids[1], ids[0], ...ids.slice(2)], [ids[2], ids[0], ids[1], ...ids.slice(3)], [ids[3], ids[0], ids[1], ids[2], ...ids.slice(4)]];
    for (const [index, order] of orders.entries())
      await apiVote(room, await apiParticipant(room, `Ranker ${index}`, localWorker.origin), null, localWorker.origin, { order });
    await dockButton(page).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    await page.setViewportSize({ width: 320, height: 900 });
    const tiles = await page.locator('.console-aggregate .opt-tile.console-option').evaluateAll(nodes => nodes.map(tile => {
      const count = tile.querySelector('.console-option-count'), outer = tile.getBoundingClientRect(), inner = count.getBoundingClientRect();
      return { left: inner.left - outer.left, right: inner.right - outer.right, overflow: count.scrollWidth - count.clientWidth };
    }));
    expect(tiles).toHaveLength(ranked.interaction.options.length);
    for (const tile of tiles) { expect(tile.left).toBeGreaterThanOrEqual(-1); expect(tile.right).toBeLessThanOrEqual(1); expect(tile.overflow).toBeLessThanOrEqual(1); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1366, height: 768 });
    const status = page.locator('.ranked-controls [role="status"]');
    await expect(status).toHaveText(/^Response orders 1–2 of 4 · Positions 1–5 of 8$/);
    // A foreign revision bump (a late join) re-renders the console; the next press must carry the new revision.
    await apiParticipant(room, 'Late joiner', localWorker.origin);
    await expect(page.locator('.console-people-count strong')).toHaveText('5');
    await page.getByRole('button', { name: 'Next positions', exact: true }).click();
    await expect(status).toHaveText(/Positions 6–8 of 8$/);
    await expect(page.locator('.console-action-dock [role="status"]')).not.toContainText('The room changed');
    await page.getByRole('button', { name: 'Next response orders', exact: true }).click();
    await expect(status).toHaveText(/^Response orders 3–4 of 4 · Positions 1–5 of 8$/);
    // Reveal atomically dismisses the chart; show it again, then page locally, press after press.
    await page.getByRole('radio', { name: 'Choose Decompress', exact: true }).click();
    await expect(dockButton(page)).toHaveText(/^Reveal: /); await dockButton(page).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed');
    await page.getByRole('button', { name: 'Show responses on projector', exact: true }).click();
    // The reveal keeps the round's ranked selection (orders 3–4).
    await expect(status).toHaveText(/^Response orders 3–4 of 4 · Positions 1–5 of 8$/);
    await enterManualRoom(page);
    await expect(page.locator('.console-manual-tray')).toContainText('This computer runs the session. Keep this tab open.');
    await closeRoomSetup(page);
    for (const positions of ['6–8']) { // CASE-327: five positions a page
      await page.getByRole('button', { name: 'Next positions', exact: true }).click();
      await expect(status).toHaveText(new RegExp(`Positions ${positions} of 8$`));
    }
    await page.getByRole('button', { name: 'Previous response orders', exact: true }).click();
    await expect(status).toHaveText(/^Response orders 1–2 of 4 · Positions 1–5 of 8$/);
    await page.getByRole('button', { name: 'Next positions', exact: true }).click();
    await expect(status).toHaveText(/^Response orders 1–2 of 4 · Positions 6–8 of 8$/);
    await expect(page.locator('.console-action-dock [role="status"]')).not.toContainText('could not apply');
  } finally { await context?.close(); await localShell?.stop(); await localWorker?.stop(); await localAuth.stop(); }
});

test('[card 37] typed and picked values survive background renders; same-name people keep distinct controls by keyboard', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  try {
    const { page, room } = await openDecision(context);
    const approvals = [];
    await page.route('**/display-pairs/approve', route => { approvals.push(route.request().postDataJSON()); return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unknown_code"}' }); });
    // Keyboard path: type the code, Tab to Approve (a render on blur), a join arrives (another render), Enter.
    await openPairing(page);
    await page.getByLabel('Display pairing code').fill('ABCD 2345');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Connect projector', exact: true })).toBeFocused();
    const alexes = [await apiParticipant(room, 'Alex'), await apiParticipant(room, 'Alex')];
    await expect(page.locator('.console-people-count strong')).toHaveText('2');
    await page.keyboard.press('Enter');
    await expect.poll(() => approvals.length).toBe(1);
    expect(String(approvals[0].code).replace(/\W/g, '')).toBe('ABCD2345');
    // The round timer sits in the decision panel (console layout v2): fold Room setup away first.
    await closeRoomSetup(page);
    // The round timer (CASE-335 player stepper over the CASE-320 stops): pick 2:00, a render arrives, then Restart sends the pick.
    await pickTimer(page, '2:00');
    await apiParticipant(room, 'Sam');
    await expect(page.locator('.console-people-count strong')).toHaveText('3');
    await expect(page.locator('.player-pick-value')).toHaveText('2:00');
    await expect(page.getByRole('group', { name: 'Timer length 2 minutes', exact: true })).toBeVisible();
    // The fixture's decision opens with its own 1:15 timer, so the button restarts it (CASE-334).
    await page.getByRole('button', { name: 'Restart 2:00', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).timer?.durationS).toBe(120);
    // Two people named Alex: keyboard focus on the second Remove survives a render and removes that person.
    await openRoomSetup(page);
    await uniqueFocusKeys(page, 'Session setup with two people named Alex');
    await page.getByRole('button', { name: 'Remove Alex from session', exact: true }).nth(1).focus();
    await apiParticipant(room, 'Kim');
    await expect(page.locator('.console-people-count strong')).toHaveText('4');
    // Remove confirms in place (console layout v2): Enter arms it, and Enter again after the label changed removes.
    await page.keyboard.press('Enter');
    await expect(page.locator('#console-dock-status')).toHaveText(/^Removes Alex \(joined .+\) from the session\.$/);
    await page.waitForTimeout(650);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await serverMirror(worker.origin, room)).participants[alexes[1].participantId]?.removedAt ?? null).not.toBeNull();
    expect((await serverMirror(worker.origin, room)).participants[alexes[0].participantId].removedAt).toBeNull();
  } finally { await context.close(); }
});

test('[AS-201] [AS-202] the console player drives the room: covers, play, volume, Effects, Build and the timer; the projector counts down to Time up', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  try {
    const { page, projector, room } = await openDecision(context);
    const player = page.locator('.console-player');
    await expect(player.locator('select, input[type="checkbox"]')).toHaveCount(0); // no native dropdowns or checkboxes
    await expect(projector.getByRole('slider')).toHaveCount(0); // the projector keeps only its sound button
    // An album cover picks the question music; the others are not pressed.
    await page.getByRole('button', { name: 'Night Platform', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).music?.choice).toBe('night-platform-developed');
    await expect(page.getByRole('button', { name: 'Night Platform', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Auto · shuffle', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(player.locator('.player-title')).toHaveText('Night Platform');
    await expect(player.locator('.player-now .cover-night-platform-developed')).toBeVisible();
    // Pause and Play, volume and Effects reach the room for every projector.
    await page.getByRole('button', { name: 'Pause session music', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).music?.playing).toBe(false);
    await page.getByRole('button', { name: 'Play session music', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).music?.playing).toBe(true);
    await page.getByRole('slider', { name: 'Session music volume', exact: true }).fill('35');
    await expect.poll(async () => (await serverMirror(worker.origin, room)).music?.volume).toBe(35);
    await page.getByRole('button', { name: 'Session effects on', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).music?.effects).toBe(false);
    const build = page.getByRole('slider', { name: 'Build', exact: true });
    await expect(build).toHaveAttribute('aria-valuetext', '70 percent: Builds to most of the full peak at time-up.');
    await build.fill('150');
    await expect(player.locator('.player-build-value')).toHaveText('150%');
    await expect.poll(async () => (await serverMirror(worker.origin, room)).music?.intensity).toBe(150);
    // The timer: the fixture's question opens with its own 1:15, so No timer first; then 0:20 by the stepper and Start.
    await page.getByRole('button', { name: 'No timer', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).timer).toBeNull();
    await pickTimer(page, '0:20');
    await page.getByRole('button', { name: 'Start 0:20', exact: true }).click();
    await expect.poll(async () => (await serverMirror(worker.origin, room)).timer?.durationS).toBe(20);
    await expect(page.getByRole('button', { name: 'Restart 0:20', exact: true })).toBeVisible();
    await expect(player.locator('.player-sub')).toHaveText('of 0:20');
    const first = await player.locator('.player-digits').textContent();
    await expect.poll(() => player.locator('.player-digits').textContent(), { timeout: 4000 }).not.toBe(first);
    // The projector: digits only, top right; the final ten; then the Time up chip while answers stay open.
    const countdown = projector.locator('.meta .timer');
    await expect(countdown).toHaveAttribute('data-state', 'run');
    await expect(projector.locator('#timerLine')).toHaveText(/^0:\d\d$/);
    if (process.env.CASE_UI_EVIDENCE) { await player.screenshot({ path: `${process.env.CASE_UI_EVIDENCE}/console-player.png` }); await projector.screenshot({ path: `${process.env.CASE_UI_EVIDENCE}/projector-run.png` }); }
    await expect(countdown).toHaveAttribute('data-state', 'final', { timeout: 15_000 });
    await expect(countdown).toHaveAttribute('data-tick', /^[ab]$/, { timeout: 3000 });
    if (process.env.CASE_UI_EVIDENCE) await projector.locator('header, .top').first().screenshot({ path: `${process.env.CASE_UI_EVIDENCE}/projector-final.png` });
    await expect(countdown).toHaveAttribute('data-state', 'up', { timeout: 15_000 });
    await expect(projector.locator('#timerLine')).toHaveText('Time up');
    await expect(countdown.locator('.timer-ring')).toBeHidden();
    await expect(player.locator('.player-digits')).toHaveText('Time up');
    await expect(page.frameLocator('.console-mirror iframe').locator('#timerLine')).toHaveText('Time up'); // Projector agrees
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
    if (process.env.CASE_UI_EVIDENCE) { await projector.locator('header, .top').first().screenshot({ path: `${process.env.CASE_UI_EVIDENCE}/projector-up.png` }); await player.screenshot({ path: `${process.env.CASE_UI_EVIDENCE}/console-up.png` }); }
  } finally { await context.close(); }
});

test('[audit] primary action stays in place while a command is sent and acknowledged', async ({ browser }) => {
  test.setTimeout(150_000);
  for (const width of [1366, 390, 320]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 } });
    try {
      const { page } = await openDecision(context);
      await page.evaluate(() => {
        const primary = () => document.querySelector('.console-primary');
        const rect = () => { const r = primary().getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, busy: primary().getAttribute('aria-busy') === 'true' }; };
        window.__dockPositions = [rect()];
        window.__dockObserver = new MutationObserver(() => { if (primary()) window.__dockPositions.push(rect()); });
        window.__dockObserver.observe(document.querySelector('.console-action-dock'), { subtree: true, childList: true, attributes: true });
      });
      await dockButton(page).click();
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
      await expect(dockButton(page)).not.toHaveAttribute('aria-busy', 'true');
      const positions = await page.evaluate(() => { window.__dockObserver.disconnect(); return window.__dockPositions; });
      expect(positions.length, 'round trip produces measured updates').toBeGreaterThan(1);
      expect(positions.some(position => position.busy), 'sending state is measured').toBe(true);
      for (const position of positions) for (const key of ['x', 'y', 'width', 'height'])
        expect(Math.abs(position[key] - positions[0][key]), `${width}px: primary ${key} changed`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${SHOTS}stable-dock-${width}.png`, animations: 'disabled' });
    } finally { await context.close(); }
  }
});



test('[audit] long actual console feedback keeps the primary anchored and keyboard controls clear at 320px', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 844 } });
  try {
    const { page } = await openDecision(context);
    const roomSource = readFileSync(new URL('../src/client/console-room.mjs', import.meta.url), 'utf8');
    const notices = [...new Set([...roomSource.matchAll(/statusText = '([^']+)'/g)].map(match => match[1]))];
    expect(notices.length).toBeGreaterThan(10);
    const primary = page.locator('.console-primary');
    const original = await primary.boundingBox();
    for (const notice of notices) {
      await page.locator('.console-action-dock > span').evaluate((element, text) => { element.textContent = text; }, notice);
      const bounds = await primary.boundingBox();
      expect(Math.abs(bounds.y - original.y), `primary moved for: ${notice}`).toBeLessThanOrEqual(1);
      const feedback = await page.locator('.console-action-dock > span').boundingBox();
      expect(feedback.x).toBeGreaterThanOrEqual(0); expect(feedback.x + feedback.width).toBeLessThanOrEqual(320);
      expect(feedback.y).toBeGreaterThanOrEqual(0);
      expect(await page.locator('.console-action-dock > span').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
      const contentControl = page.locator('.console-main button').last();
      await contentControl.focus(); await contentControl.evaluate(element => element.scrollIntoView({ block: 'end' }));
      await expect(contentControl).toBeFocused();
      const control = await contentControl.boundingBox(), dock = await page.locator('.console-action-dock').boundingBox();
      expect(control.y + control.height, `focused content obscured for: ${notice}`).toBeLessThanOrEqual(dock.y);
    }
    // The test's own output folder, never a shared /tmp path another user can read or own (CI runners).
    await page.screenshot({ path: testInfo.outputPath('long-feedback-320.png'), fullPage: true });
  } finally { await context.close(); }
});

test('[AS-121] private live map keeps inspection through room updates; teaching and canonical route stay exact', async ({browser})=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1024,height:768}});
 try{
  const {page,room,projector}=await openDecision(context);await dockButton(page).click();const sound=decision.paths.find(p=>p.recommended);await page.getByRole('radio', { name: `Choose ${sound.label}`, exact: true }).click();const revealLabel=await dockButton(page).innerText();
  await page.getByRole('button',{name:'Case map',exact:true}).click();const map=page.locator('.console-room .case-map');await expect(map).toBeVisible();const header=map.locator('.decision-header').first();await header.click();await expect(header).toHaveAttribute('aria-expanded','true');await expect(map.locator('.overview-strands polygon')).not.toHaveCount(0);
  const revision=(await serverMirror(worker.origin,room)).revision;await apiParticipant(room,'Map update');await expect.poll(async()=>(await serverMirror(worker.origin,room)).revision).toBeGreaterThan(revision);await expect(header).toHaveAttribute('aria-expanded','true');await expect(dockButton(page)).toHaveText(revealLabel);
  const before=(await serverMirror(worker.origin,room)).revealed.length;await map.locator('.branch-choice').last().click();expect((await serverMirror(worker.origin,room)).revealed.length).toBe(before);await dockButton(page).click();await expect(projector.locator('#main')).toContainText(FIXTURE.surfaces.find(s=>s.id===sound.reveal_surface_id).title);
  await page.getByRole('button',{name:'Return to the case',exact:true}).click();await expect(page.locator('.console-undo')).toBeEnabled();await page.locator('.console-undo').click();await page.getByRole('button',{name:'Actual path',exact:true}).click();await expect(page.locator('.case-route')).toContainText('Displaced visits');await expect(page.locator('.case-route')).not.toContainText('Route evidence unavailable');const excursion=page.locator('.route-excursion');await excursion.locator('summary').click();await apiParticipant(room,'Route update');await expect(excursion).toHaveAttribute('open','');
  await page.getByRole('button',{name:'Return to the case',exact:true}).click();await page.getByRole('radio', { name: `Choose ${sound.label}`, exact: true }).click();await dockButton(page).click();await page.getByRole('button',{name:'Case map',exact:true}).click();
  const startBeat=(await serverMirror(worker.origin,room)).beatId;for(let i=0;i<8&&(await serverMirror(worker.origin,room)).beatId===startBeat;i++)await dockButton(page).click();
  const beat=(await serverMirror(worker.origin,room)).beatId;expect(beat).not.toBe(startBeat);await expect(map.locator(`[data-focus="overview-${beat}"]`)).toHaveAttribute('aria-current','step');await expect(map.locator('.overview-strands polygon')).not.toHaveCount(0);
 }finally{await context.close();}
});
