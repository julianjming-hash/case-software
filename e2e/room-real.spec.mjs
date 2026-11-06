// e2e/room-real.spec.mjs: the Phase 1 exit gate. The stage C windows run with `?api=` against the
// REAL Worker, RoomDO and DirectoryDO in local workerd (`wrangler dev`, no network, no Cloudflare
// account), for one full room: joins, a vote, lock, select, reveal, a pause with a held answer, a
// display paired for real, the facilitator's network cut with manual mode and rejoin, end and recap.
//
// Every window is its own browser context (its own network, cookies and storage), driven through its
// own UI. The server is read only to assert, through the facilitator snapshot's mirror.
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startLocalWorker, createRoom, serverMirror, freePort, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { startServer } from '../scripts/serve-prototypes.mjs';
import { axeViolations } from '../tests/playwright-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCALE = 0.2; // transport timings ×0.2: heartbeat 2 s, dead after 5 s
const OPT = {
  cxr: 'S00173 workshop label. Record az',
  needle: 'S00175 workshop label. Record a s',
  icc: 'S00189 workshop label. Record a s',
};
const ROUTE = {needle:FIXTURE.decisions[0].paths[0].label,icc:FIXTURE.decisions[1].paths[0].label};
const VIEWPORT = { width: 1400, height: 1700 };

let worker;
let server;
let origin;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  worker = await startLocalWorker();
  const port = await freePort();
  server = await startServer({ root: ROOT, port, apiProxy: worker.origin });
  origin = `http://127.0.0.1:${port}`; // the windows and /api share this origin (the Worker has no CORS)
});
test.afterAll(async () => {
  server?.dropAll(); // a failed test can leave sockets open, and close() would wait for them
  await new Promise((r) => (server ? server.close(r) : r()));
  await worker?.stop();
});

const page = (name, q = {}) => `${origin}/prototypes/room/${name}?${new URLSearchParams({ api: origin, scale: String(SCALE), ...q })}`;

test('[AS-066] the privacy return keeps a real room and a non-A phone slot', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const phone = await context.newPage();
  await phone.goto(page('phone.html', { slot: 'B' }));
  await phone.getByLabel('Room code').fill(room.joinCode);
  await phone.getByRole('link', { name: 'Privacy' }).click();
  await expect(phone.getByRole('heading', { name: 'Privacy and data notice' })).toBeVisible();
  await phone.getByRole('link', { name: 'Back to join' }).click();
  await expect(phone.getByLabel('Room code')).toHaveValue(room.joinCode);
  expect(new URL(phone.url()).searchParams.get('api')).toBe(origin);
  expect(new URL(phone.url()).searchParams.get('slot')).toBe('B');
  await phone.getByLabel('Your name').fill('Alex');
  await phone.getByRole('radio', { name: 'Wine, curls', exact: true }).check();
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  expect(await phone.evaluate(() => window.casePhone.link.mode)).toBe('ws');
  await context.close();
});

test('[AS-001] [AS-006] [AS-007] [AS-017] [AS-025] [AS-033] [AS-034] [AS-035] one full room against the real Worker: join, vote, lock, reveal, held answer, paired display, offline facilitator, manual mode, rejoin, end', async ({ browser }) => {
  test.setTimeout(180_000);
  const room = await createRoom(worker.origin); // a signed-in facilitator created it (Supabase JWT, test secret)
  const state = () => serverMirror(worker.origin, room);
  const until = async (predicate, message) => {
    await expect.poll(async () => predicate(await state()), { message, timeout: 20_000 }).toBe(true);
    return state();
  };
  const urls = [];
  const watch = (context) => {
    context.on('request', (r) => urls.push(r.url()));
    context.on('page', (p) => p.on('websocket', (ws) => urls.push(ws.url())));
    return context;
  };

  // ── facilitator console. DEV-ONLY token hand-off: sessionStorage before the page loads (link.mjs). ──
  const facCtx = watch(await browser.newContext({ viewport: VIEWPORT }));
  await facCtx.addInitScript(({ key, value }) => { sessionStorage.setItem(key, value); }, { key: 'case:facilitator:main:token', value: JSON.stringify({ sessionId: room.sessionId, token: room.facilitatorToken }) });
  const fac = await facCtx.newPage();
  await fac.goto(page('facilitator.html', { session: room.sessionId }));
  await expect(fac.getByRole('heading', { level: 1, name: 'Lobby' })).toBeVisible();
  const press = async (name) => { const b = fac.getByRole('button', { name, exact: true }); await expect(b).toBeEnabled(); await b.click(); };
  // The Room tab holds people, displays, manual mode and the end (CASE-118); Run holds the case.
  const drawer = fac.locator('#panel-room');
  const openDrawer = async () => { await fac.getByRole('tab', { name: 'Room' }).click(); await expect(drawer).toBeVisible(); };
  const closeDrawer = async () => { await fac.getByRole('tab', { name: 'Run' }).click(); };

  // ── AS-025: a separate display pairs for real (number matching on the console). ──
  const dispCtx = watch(await browser.newContext({ viewport: VIEWPORT }));
  const display = await dispCtx.newPage();
  await display.goto(page('display.html')); // not paired yet: link.mjs sends it to pair-display.html
  await expect(display.getByRole('heading', { level: 1, name: 'Pair this display' })).toBeVisible();
  await expect(display.locator('#code')).toHaveText(/^[0-9A-Z]{4} [0-9A-Z]{4}$/);
  expect(await axeViolations(display.mainFrame()), 'pair-display.html').toEqual([]);
  const pairCode = (await display.locator('#code').textContent()).replace(/\s/g, '');
  await openDrawer();
  await drawer.getByLabel('Display code').fill(pairCode.toLowerCase());
  await drawer.getByRole('button', { name: 'Pair a display', exact: true }).click();
  await expect(drawer.getByText('Display paired')).toBeVisible();
  await closeDrawer();
  await expect(display).toHaveURL(/\/display\.html\?/);
  await expect(display.getByRole('heading', { level: 2, name: 'Join on your phone' })).toBeVisible();
  await expect(display.getByText(room.joinCode.replace(/^(...)(...)$/, '$1 $2'))).toBeVisible();

  // ── AS-001: three phones join through their own UI. ──
  const phones = {};
  for (const [slot, name] of [['A', 'Sam'], ['B', 'Alex'], ['C', 'Guest C']]) {
    const ctx = watch(await browser.newContext({ viewport: { width: 420, height: 1400 } }));
    const p = await ctx.newPage();
    await p.goto(page('phone.html', { slot }));
    await p.getByLabel('Room code').fill(room.joinCode);
    await p.getByLabel('Your name').fill(name);
    await p.getByRole('radio', { name: 'Wine, curls', exact: true }).check();
    await p.getByRole('button', { name: 'Join case', exact: true }).click();
    await expect(p.getByRole('heading', { level: 1, name: 'Waiting to start' })).toBeVisible();
    phones[slot] = { page: p, ctx };
  }
  await expect(display.getByText('3 in the room · Waiting to start')).toBeVisible();
  expect(Object.keys((await state()).participants)).toHaveLength(3);
  // The windows run the real transport (src/client/transport.mjs) on a WebSocket, not the lab bus.
  for (const slot of ['A', 'B', 'C']) expect(await phones[slot].page.evaluate(() => window.casePhone.link.mode)).toBe('ws');

  const vote = async (slot, label) => {
    const p = phones[slot].page;
    await p.getByRole('radio', { name: label }).check();
    await p.getByRole('button', { name: /^(Send|Change) answer$/ }).click();
    await expect(p.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
  };

  // ── start, open decision, vote, lock (AS-006), select and reveal (AS-007) ──
  await press('Start case'); // the paired display counts as the display check
  await until((s) => s.phase === 'surface_live', 'case started');
  await expect(display.getByRole('heading', { level: 1, name: 'S00011 workshop title.z' })).toBeVisible();
  await until((s) => s.revealed.at(-1)?.groupsShown === 1 && !s.round, 'arrival scene before findings');
  await press('Reveal findings');
  await until((s) => s.revealed.at(-1)?.groupsShown === 2 && !s.round, 'arrival findings before decision');
  await press('Show decision context');
  await until((s) => s.decisionId && s.revealed.at(-1)?.groupsShown === 1 && !s.round, 'decision scene before voting');
  await press('Reveal observations');
  await until((s) => s.revealed.at(-1)?.groupsShown === 2 && !s.round, 'decision observations before voting');
  await press('Reveal findings');
  await until((s) => s.revealed.at(-1)?.groupsShown === 3 && !s.round, 'decision findings before voting');
  await press('Open responses');
  await until((s) => s.phase === 'responses_open', 'decision 1 open');
  await vote('A', OPT.needle);
  await vote('B', OPT.cxr);
  await vote('C', OPT.needle);
  await expect(display.getByText('3 of 3 answered')).toBeVisible();
  await press('Lock responses & review');
  await until((s) => s.phase === 'responses_locked', 'locked');
  await expect(phones.A.page.getByText(`Your answer (locked): ${OPT.needle}`)).toBeVisible();
  await fac.getByRole('radio', { name: ROUTE.needle }).check();
  await press('Select this route');
  await expect(fac.getByRole('heading', { level: 1, name: 'Route chosen · not yet shown to the room' })).toBeVisible();
  await press('Hide responses on projector');
  const primary = fac.locator('[data-k="primary"]');
  await expect(primary).toHaveText(/^Reveal: /);
  await primary.click();
  await expect(primary).toHaveText('Show to room?');
  await primary.click();
  const revealed = await until((s) => s.phase === 'consequence_revealed', 'revealed');
  expect(revealed.rounds[0]).toMatchObject({ status: 'resolved', resolutionKind: 'majority' });
  await expect(display.getByRole('heading', { level: 1, name: 'S00031 workshop title. Recordz' })).toBeVisible();
  await expect(phones.A.page.getByRole('heading', { name: 'S00031 workshop title. Recordz' })).toBeVisible();

  // ── An answer in flight (CASE-255 retired the pause this step once took). Phone A's vote POST is held in
  // the network; the open round offers no pause, and the answer lands once the network lets it through. ──
  await press('Reveal observations');
  await press('Reveal findings');
  await press('Show decision context');
  await until((s) => s.decisionId && s.revealed.at(-1)?.groupsShown === 1 && !s.round, 'next decision scene before voting');
  await press('Reveal observations');
  await press('Reveal findings');
  await press('Reveal investigations');
  await until((s) => s.revealed.at(-1)?.groupsShown === 4 && !s.round, 'next decision context before voting');
  await press('Open responses');
  await until((s) => s.phase === 'responses_open' && s.rounds.length === 1, 'decision 2 open');
  let holding = true;
  const held = [];
  await phones.A.page.route('**/api/v1/sessions/*/commands', (route) => {
    if (holding && route.request().postDataJSON()?.type === 'vote') held.push(route); else route.continue();
  });
  await phones.A.page.getByRole('radio', { name: OPT.icc }).check();
  await phones.A.page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(fac.getByRole('button', { name: 'Pause for discussion' })).toHaveCount(0);
  expect(Object.keys((await state()).round.responses)).toHaveLength(0);
  holding = false;
  for (const r of held) r.continue().catch(() => { /* the transport timed this attempt out and retried */ });
  await expect(phones.A.page.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
  await until((s) => s.phase === 'responses_open' && Object.keys(s.round.responses).length === 1, 'answer in flight recorded once released');

  // ── AS-033: the facilitator's network is cut; the phones keep voting into the open round. ──
  await facCtx.setOffline(true);
  await expect(fac.getByRole('button', { name: 'Switch to manual room', exact: true })).toBeVisible();
  await vote('B', OPT.icc);
  const before = await until((s) => Object.keys(s.round.responses).length === 2, 'phones kept voting');

  // AS-031: manual room mode, entered locally with no server.
  await fac.getByRole('button', { name: 'Switch to manual room', exact: true }).click();
  await expect(fac.locator('#dlg')).toContainText('This cancels the open round. Its answers are discarded.');
  await fac.locator('#dlg').getByRole('button', { name: 'Enter manual room mode', exact: true }).click();
  await expect(fac.getByText('Manual room mode · phone votes and recap capture are unavailable until connectivity returns')).toBeVisible();
  await fac.getByRole('radio', { name: ROUTE.icc }).check();
  await press('Select this route');
  await primary.click();
  await expect(primary).toHaveText('Show to room?');
  await primary.click();
  expect(await state()).toMatchObject({ phase: 'responses_open', epoch: before.epoch, manual: null }); // the server heard nothing

  // AS-035 / AS-034: back online, rejoin; the segment replays; the open round is abandoned; new epoch.
  await facCtx.setOffline(false);
  await expect(fac.getByText('Live', { exact: true })).toBeVisible();
  await openDrawer();
  await drawer.getByRole('button', { name: 'Rejoin online at the next decision', exact: true }).click();
  const after = await until((s) => s.manualSegments.length === 1, 'manual segment applied');
  expect(after.epoch).toBeGreaterThan(before.epoch);
  expect(after.manual).toBeNull();
  expect(after.rounds).toHaveLength(2);
  expect(after.rounds[1]).toMatchObject({ status: 'abandoned', aggregate: null, answers: {} });
  await expect(fac.getByText('Round closed as abandoned · Manual choices recorded · New epoch', { exact: false })).toBeVisible();
  await expect(fac.getByRole('heading', { level: 1, name: 'This room is now controlled from another device' })).toHaveCount(0);
  for (const slot of ['A', 'B']) await expect(phones[slot].page.getByRole('main').getByText('Round cancelled · the facilitator will open a new round')).toBeVisible();

  // ── AS-017: end; every phone gets its private recap. ──
  await openDrawer();
  await drawer.getByRole('button', { name: 'End room', exact: true }).click();
  await fac.locator('#dlg').getByRole('button', { name: 'End room', exact: true }).click();
  await until((s) => s.phase === 'ended', 'ended');
  await expect(fac.getByRole('heading', { level: 1, name: 'Room ended' })).toBeVisible();
  await expect(display.getByRole('main').getByText('Session ended')).toBeVisible();
  for (const slot of ['A', 'B', 'C']) await expect(phones[slot].page.getByRole('heading', { name: 'Your private recap' })).toBeVisible();
  await expect(phones.B.page.locator('article.recap-round').first()).toContainText(`Your answer: ${OPT.cxr}`);

  // Tokens never travelled in a URL: not the console's, not any phone's or the display's.
  expect(urls.length).toBeGreaterThan(20);
  for (const u of urls) {
    expect(u).not.toContain(room.facilitatorToken);
    expect(new URL(u).search).not.toMatch(/token|secret|bearer/i);
  }
  // The display and the phones never stored the case pack or the mirror.
  for (const p of [display, phones.A.page]) expect(await p.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain('"participants"');
  for (const ctx of [facCtx, dispCtx, ...Object.values(phones).map((p) => p.ctx)]) await ctx.close();
});

test('[AS-061] reload during a total outage: the shell loads from the offline cache, the console says what it cannot do and keeps the manual segment; back online it continues', async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom(worker.origin);
  // This test's own origin, so the outage (its server going away) touches nothing else.
  const port = await freePort();
  let own = await startServer({ root: ROOT, port, apiProxy: worker.origin });
  const at = `http://127.0.0.1:${port}`;
  const url = (name, q = {}) => `${at}/prototypes/room/${name}?${new URLSearchParams({ api: at, scale: String(SCALE), ...q })}`;
  const outage = async () => { own.dropAll(); await new Promise((r) => own.close(r)); };

  const facCtx = await browser.newContext({ viewport: VIEWPORT });
  await facCtx.addInitScript(({ key, value }) => { sessionStorage.setItem(key, value); }, { key: 'case:facilitator:main:token', value: JSON.stringify({ sessionId: room.sessionId, token: room.facilitatorToken }) });
  const fac = await facCtx.newPage();
  await fac.goto(url('facilitator.html', { session: room.sessionId }));
  await expect(fac.getByRole('heading', { level: 1, name: 'Lobby' })).toBeVisible();
  const phoneCtx = await browser.newContext({ viewport: { width: 420, height: 1400 } });
  const phone = await phoneCtx.newPage();
  await phone.goto(url('phone.html', { slot: 'A' }));
  await phone.getByLabel('Room code').fill(room.joinCode);
  await phone.getByLabel('Your name').fill('Sam');
  await phone.getByRole('radio', { name: 'Wine, curls', exact: true }).check();
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { level: 1, name: 'Waiting to start' })).toBeVisible();
  // The shell is installed: shell files only, nothing from /api/ and no case data.
  const cachedUrls = (p) => p.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url); return out; });
  for (const p of [fac, phone]) {
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await expect.poll(async () => (await cachedUrls(p)).length, { timeout: 15_000 }).toBeGreaterThan(10);
    const cached = await cachedUrls(p);
    expect(cached.filter((u) => u.includes('/api/') || u.includes('fixtures') || u.endsWith('/index.html'))).toEqual([]);
  }
  await fac.getByRole('button', { name: 'Projector is on a separate paired device', exact: true }).click();
  await fac.getByRole('button', { name: 'Start case', exact: true }).click();
  await expect(fac.getByRole('heading', { level: 1, name: 'Live surface' })).toBeVisible();

  // Total outage: Case cannot be reached at all. The console goes to manual room mode and adds a marker.
  await outage();
  await fac.getByRole('button', { name: 'Switch to manual room', exact: true }).click({ timeout: 20_000 });
  await fac.locator('#dlg').getByRole('button', { name: 'Enter manual room mode', exact: true }).click();
  await fac.getByLabel('Add marker').fill('Hands up: most would decompress');
  await fac.getByRole('button', { name: 'Add marker', exact: true }).click();
  await expect(fac.getByText('Marker added on this device')).toBeVisible();

  // Reload during the outage: the shell comes from the cache; the case pack (memory only) does not.
  await fac.reload();
  await expect(fac.getByRole('heading', { level: 1, name: 'Offline after a reload' })).toBeVisible({ timeout: 15_000 });
  await expect(fac.getByText('This console keeps the case only in memory', { exact: false })).toBeVisible();
  await expect(fac.getByText('Your manual room segment is kept on this device', { exact: false })).toBeVisible();
  const [download] = await Promise.all([fac.waitForEvent('download'), fac.getByRole('button', { name: 'Download your notes', exact: true }).click()]);
  const notes = await (await download.createReadStream()).toArray();
  expect(Buffer.concat(notes).toString('utf8')).toContain('Marker: Hands up: most would decompress');
  await phone.reload();
  await expect(phone.getByRole('heading', { level: 1, name: 'Checking the room…' })).toBeVisible({ timeout: 15_000 }); // its place is kept (localStorage)

  // Case is back: the console loads the case again and continues the manual segment.
  own = await startServer({ root: ROOT, port, apiProxy: worker.origin });
  await expect(fac.getByText('Manual room mode · phone votes and recap capture are unavailable until connectivity returns')).toBeVisible({ timeout: 30_000 });
  await expect(phone.getByRole('heading', { level: 2, name: 'S00011 workshop title.z' })).toBeVisible({ timeout: 30_000 });
  await facCtx.close(); await phoneCtx.close();
  own.dropAll(); await new Promise((r) => own.close(r));
});

test('[RT2] hospital PC: wake lock taken, a blocked projector window shows the link to open by hand, and a one-screen PC is offered the phone as console', async ({ browser }) => {
  const room = await createRoom(worker.origin);
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ctx.addInitScript(({ key, value }) => {
    sessionStorage.setItem(key, value);
    // A hospital PC: one screen (Windows "Duplicate" mode), a pop-up blocker, and the Wake Lock API.
    Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => false });
    window.open = () => null;
    window.__wake = 0;
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake += 1; return new EventTarget(); } } });
  }, { key: 'case:facilitator:main:token', value: JSON.stringify({ sessionId: room.sessionId, token: room.facilitatorToken }) });
  const fac = await ctx.newPage();
  await fac.goto(page('facilitator.html', { session: room.sessionId }));
  await expect(fac.getByRole('heading', { level: 1, name: 'Lobby' })).toBeVisible();
  expect(await fac.evaluate(() => window.__wake)).toBeGreaterThan(0);
  await expect(fac.getByText('This computer is showing one screen')).toBeVisible();
  await expect(fac.getByText('run the console on your phone', { exact: false })).toBeVisible();
  await expect(fac.getByRole('button', { name: 'Start case', exact: true })).toBeVisible(); // a hint, never a block
  await fac.getByRole('button', { name: 'Open projector window', exact: true }).click();
  await expect(fac.getByText('The projector window did not open', { exact: true })).toBeVisible({ timeout: 6_000 });
  const href = await fac.locator('[data-k="projLink"]').getAttribute('href');
  expect(href).toContain('/prototypes/room/display.html?');
  expect(href).not.toContain(room.facilitatorToken);
  expect(new URL(href).search).not.toMatch(/token|secret|bearer/i);
  expect(await fac.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain(room.facilitatorToken); // memory only
  expect(await axeViolations(fac.mainFrame()), 'console with the hospital-PC hints').toEqual([]);
  await ctx.close();
});

test('[RT2] network check: a held socket, a held request and the round trip, in plain words', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const p = await ctx.newPage();
  await p.goto(`${origin}/prototypes/room/check.html?${new URLSearchParams({ api: origin, hold: '5000', wait: '2' })}`);
  await expect(p.getByRole('heading', { level: 1, name: 'Network check' })).toBeVisible();
  await p.getByRole('button', { name: 'Run the check', exact: true }).click();
  await expect(p.locator('#summary')).toHaveText('Ready: this network supports live updates.', { timeout: 30_000 });
  await expect(p.locator('#checks li[data-state="pass"]')).toHaveCount(3);
  await expect(p.getByText(/^Live updates work and stayed connected for \d+ seconds\.$/)).toBeVisible();
  expect(await axeViolations(p.mainFrame()), 'check.html').toEqual([]);
  await ctx.close();
});
