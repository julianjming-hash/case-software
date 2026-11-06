import { roomNetwork } from '../tests/helpers/room-network.mjs';
// Card 12: built console, real local Worker/room and throwaway HTTPS Auth only.
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { mkdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE, serverMirror } from '../tests/helpers/local-worker.mjs';
import { apiUrl, displayPairUrl, joinUrl, sessionUrl, samePcProjectorUrl } from '../src/shared/urls.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { STORAGE_FENCE_KEY } from '../src/client/storage-generation.mjs';
import { ordinaryQuestions } from '../tests/helpers/ordinary-questions.mjs';
import { closeRoomSetup, confirmInPlace, consoleReady, dismissDisplayReminder, endCase, enterManualRoom, openPairing, openRoomSetup, projectorPage } from '../tests/helpers/console-v2.mjs';
import { docShotsDir } from '../tests/helpers/doc-shots.mjs';

let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
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

test('[AS-095] Card20 served picker labels the exact pinned version and warns before another published start', async ({ browser }) => {
  const otp = String(randomInt(100000, 1000000));
  const localAuth = await startLocalAuthStub({ appOrigin: null, jwt: null, otp });
  let localWorker, localShell, context;
  try {
    localWorker = await startPublishedWorker({ authOrigin: localAuth.origin, pilotPin: true, secondVersion: true });
    localAuth.setJwt(localWorker.jwt);
    localShell = await startServedAuthShell({ apiOrigin: localWorker.origin,
      buildAuthBindings: { SUPABASE_URL: localAuth.origin,
        SUPABASE_JWT_ISSUER: `${localAuth.origin}/auth/v1`,
        SUPABASE_JWKS_URL: `${localAuth.origin}/auth/v1/.well-known/jwks.json` } });
    localAuth.setAppOrigin(localShell.origin);
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(casesUrl(localShell.origin));
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill(otp);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const pinned = page.locator('article.case-card').filter({ has: page.getByRole('heading', { name: 'Published case', exact: true }) });
    const other = page.locator('article.case-card').filter({ has: page.getByRole('heading', { name: 'Other published case' }) });
    await expect(pinned.getByText('Pinned pilot version', { exact: true })).toBeVisible();
    await expect(other.getByText('Different from the approved pilot version', { exact: true })).toBeVisible();
    const text = await page.locator('main.facilitator-console').innerText();
    // Card 29: Start room is on case detail, still enabled and described by the card's pilot label.
    for (const [title, label] of [['Published case', 'Pinned pilot version'], ['Other published case', 'Different from the approved pilot version']]) {
      const start = await openCase(page, title, {confirm:false});
      await expect(start).toBeEnabled();
      await expect(start).toHaveAccessibleDescription(label);
      await start.click();const confirmation=page.getByRole('dialog',{name:'Present case',exact:true});await expect(confirmation.getByRole('button',{name:'Present',exact:true})).toHaveAccessibleDescription(label);await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
      expect(await page.locator('main.facilitator-console').innerText()).not.toContain(localWorker.contentSha256);
      await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link', { name: 'Present',exact:true }).click();
    }
    expect(text).not.toContain(localWorker.versionId);
    expect(text).not.toContain(localWorker.contentSha256);
  } finally { await context?.close(); await localShell?.stop(); await localWorker?.stop(); await localAuth.stop(); }
});

test('[AS-095] served picker omits an unconfigured pilot label without claiming approval', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await signedIn(page);
    const card = page.locator('article.case-card').first();
    await expect(card.locator('.pilot-tag')).toHaveCount(0);
    await expect(card.getByRole('link')).toBeEnabled();
    await expect(card.getByText('Pinned pilot version', { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function afterBrowserResponse(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function caseStorageFootprint(page) {
  return page.evaluate(async () => {
    const keys = [...Object.keys(sessionStorage), ...Object.keys(localStorage)];
    const privateKeys = keys.filter(key => key.startsWith('case-lab:segment:') ||
      /case:(?:room|pack|mirror|capability)/.test(key));
    const privateValues = keys.some(key => {
      const value = sessionStorage.getItem(key) ?? localStorage.getItem(key) ?? '';
      return /"(?:casePack|mirror|facilitatorToken|document_text)"/.test(value);
    });
    const cachedApi = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (path.startsWith('/api/') || path.startsWith('/sessions/')) cachedApi.push(path);
      }
    }
    const privateDatabases = (await indexedDB.databases()).map(item => item.name)
      .filter(name => name?.startsWith('case:'));
    return { privateKeys, privateValues, cachedApi, privateDatabases };
  });
}

async function startedRoom(page) {
  await signedIn(page);
  await (await openCase(page)).click();
  await consoleReady(page);
}

// Card 38: /me/rooms lists the room this test started (the fake RPC), so the console can rejoin it.
function listRooms(...rooms) {
  worker.fake.replies.set('list_owned_active_sessions', rooms.map(room => ({ session_id: room.sessionId,
    join_code: room.joinCode, expires_at: room.expiresAt })));
}
const unlistRooms = () => worker.fake.replies.delete('list_owned_active_sessions');
async function liveRoom(page, { signIn = true } = {}) {
  if (signIn) await signedIn(page);
  const created = shell.waitForCreatedRoom();
  await (await openCase(page)).click();
  const room = await created;
  listRooms(room);
  await consoleReady(page);
  return room;
}

async function openFirstDecisionWithContext(page) {
  await expect(page.getByRole('button', { name: 'Open responses' })).toHaveCount(0);
  for (const name of ['Reveal findings', 'Show decision context', 'Reveal observations',
    'Reveal findings', 'Open responses']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
}

async function lockedRoomWithOneVote(page) {
  await signedIn(page);
  const created = shell.waitForCreatedRoom();
  await (await openCase(page)).click();
  const room = await created;
  const joined = await fetch(apiUrl(worker.origin, 'join'), { method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.116' },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName: 'Learner', avatarId: 'shadows-01' }) });
  expect(joined.status).toBe(201);
  const participant = await joined.json();
  await openProjectorOptions(page);
  await dismissProjectorReminder(page);
  await page.getByRole('button', { name: 'Start case' }).click();
  await openFirstDecisionWithContext(page);
  const mirror = await serverMirror(worker.origin, room);
  const option = FIXTURE.decisions[0].interaction.options[2];
  const voted = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'commands'), {
    method: 'POST', headers: { authorization: `Bearer ${participant.token}`,
      'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'vote', epoch: mirror.epoch, clientEventId: uuidv7(),
      roundId: mirror.round.id, response: { option_id: option.id } }),
  });
  expect(voted.status).toBe(200);
  expect((await voted.json()).receipt.receipt).toBe('accepted');
  await page.getByRole('button', { name: 'Lock responses & review' }).click();
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
  return { room, option };
}

function roomSocketState(page) {
  const state = { connected: false, closed: false };
  page.on('websocket', socket => {
    if (!/^\/api\/v1\/sessions\/[0-9a-f-]{36}\/ws$/.test(new URL(socket.url()).pathname)) return;
    state.connected = true;
    socket.on('close', () => { state.closed = true; });
  });
  return state;
}

test('[AS-036] sign-out ends the served console lifetime and leaves no private room storage', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const socket = roomSocketState(page);
  try {
    await startedRoom(page);
    await expect.poll(() => socket.connected).toBe(true);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
    await signOutFromVisibleUi(page);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect.poll(() => socket.closed).toBe(true);
    await expect(page.locator('.console-room')).toHaveCount(0);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
  } finally { await context.close(); }
});

test('[AS-036] actual room end clears the served facilitator capability and private storage, and keeps the account (card 38)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const socket = roomSocketState(page);
  try {
    await startedRoom(page);
    await expect.poll(() => socket.connected).toBe(true);
    await endCase(page);
    // Card 40 slice 6 (AS-036 amended): End shows the ended summary; only its derived model remains, in memory.
    await expect(page.locator('.ended-summary')).toBeVisible();
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
    await page.getByRole('button', { name: 'Back to Present' }).click();
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBeNull();
    await expect.poll(() => socket.closed).toBe(true);
    await expect(page.locator('.console-room')).toHaveCount(0);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
  } finally { await context.close(); }
});

test('[card 40 ended summary] End offers the counts-only debrief, pages the projector and clears on Back to Present', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  await context.addInitScript(() => {
    // A spy on every local broadcast: the facilitator's model never travels, only public display frames do.
    window.__broadcasts = [];
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message) { try { window.__broadcasts.push(JSON.stringify(message)); } catch {} return post.call(this, message); };
  });
  const page = await context.newPage();
  try {
    const { room } = await lockedRoomWithOneVote(page);
    await endCase(page);
    const summary = page.locator('.ended-summary');
    await expect(summary.getByRole('heading', { level: 1 })).toHaveText(FIXTURE.title);
    await expect(summary.locator('.ended-meta').first()).toContainText('1 joined');
    // The pager holds a live grant: page 0 of the summary page plus each shown result.
    const pager = summary.getByRole('group', { name: 'Projector' });
    await expect(pager.locator('.ended-pos')).toHaveText(/^1 of \d+$/);
    // Download: a real PDF of the debrief.
    const [download] = await Promise.all([page.waitForEvent('download'), summary.getByRole('button', { name: 'Download debrief (PDF)' }).click()]);
    const bytes = await (await download.createReadStream()).toArray().then(chunks => Buffer.concat(chunks));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(download.suggestedFilename()).toMatch(/^.+ – Facilitator debrief – \d{4}-\d{2}-\d{2} \d{4}\.pdf$/); // room PDFs v2 file names
    // Print: the print copy exists only while printing.
    await page.evaluate(() => { window.__printed = null; window.print = () => { window.__printed = document.querySelector('.private-session-print')?.textContent ?? null; }; });
    await summary.getByRole('button', { name: 'Print debrief' }).click();
    await expect.poll(() => page.evaluate(() => window.__printed)).toContain(FIXTURE.decisions[0].prompt);
    await expect(page.locator('.private-session-print')).toHaveCount(0);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false, cachedApi: [], privateDatabases: [] });
    const broadcasts = await page.evaluate(() => window.__broadcasts.join('\n'));
    expect(broadcasts).not.toMatch(/routeChoices|"questions"|classification|"mirror"|facilitatorToken/);
    // Back to Present revokes the grant: the projector leaves paging.
    const revoked = page.waitForRequest(request => request.url().endsWith(`/sessions/${room.sessionId}/debrief/revoke`) && request.method() === 'POST');
    await summary.getByRole('button', { name: 'Back to Present' }).click();
    await revoked;
    await expect(page.locator('.ended-summary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-036] room end returns to the library still signed in, with Sign out visible (card 38)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    await endCase(page);
    await expect(page.locator('.ended-summary')).toBeVisible();
    await page.getByRole('button', { name: 'Back to Present' }).click();
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeHidden();
    await expect(page.locator('form.auth-form')).toBeHidden();await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('button',{name:'Sign out',exact:true})).toBeVisible();await page.keyboard.press('Escape');
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).not.toBeNull();
  } finally { await context.close(); }
});

test('[AS-036] a reload reopens the same room in the same tab and a new tab offers Rejoin room; no private cache survives (card 38)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') void dialog.accept(); });
  try {
    const room = await liveRoom(page);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
    await page.reload();
    await consoleReady(page);
    expect(await page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBe(room.sessionId);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
    await page.close({ runBeforeUnload: false });
    const reopened = await context.newPage();
    await reopened.goto(casesUrl(shell.origin));
    const rejoin = reopened.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) });
    await expect(rejoin).toBeVisible();
    await expect(reopened.locator('.console-room .console-primary')).toHaveCount(0);
    expect(await caseStorageFootprint(reopened)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
    await rejoin.click();
    await consoleReady(reopened);
  } finally { unlistRooms(); await context.close(); }
});

test('[AS-036] served console axe on every window phase in light and dark with legible 1920 and 1366 captures', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const screenshots = docShotsDir('12-screenshots');
  mkdirSync(screenshots, { recursive: true });
  const inspect = async phase => {
    if (phase !== 'lobby') await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', phase);
    expect(await caseStorageFootprint(page), `${phase} private storage`).toEqual({ privateKeys: [],
      privateValues: false, cachedApi: [], privateDatabases: [] });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1920, 1366]) {
        await page.setViewportSize({ width, height: width === 1920 ? 1080 : 768 });
        const rail = page.getByRole('navigation', { name: 'Presentation', exact: true });
        // This matrix's initial lobby has no publication; every later phase has real public history.
        if (phase === 'lobby') {
          await expect(rail).toHaveCount(0);
          await expect(page.locator('.console-presentation-controls')).toHaveCount(0);
        } else {
          await expect(rail).toBeVisible();
          await expect(page.locator('.console-presentation-controls')).toHaveCount(1);
        }
        await settled(page);
        const violations = (await new AxeBuilder({ page }).analyze()).violations;
        expect(violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })),
          `${phase} ${scheme} ${width}`).toEqual([]);
        const disabled = await page.locator('.console-room button:disabled').evaluateAll(buttons => buttons
          .filter(button => !button.closest('.console-presentation-controls')).map(button => button.textContent));
        expect(disabled.every(label => label === 'Start case'), `${phase} blocked controls`).toBe(true);
        const presentation = page.locator('.console-presentation-controls');
        if (phase !== 'lobby') {
          const tiles = page.locator('.console-presentation-tile'), last = await tiles.count() - 1;
          const selectedTile = page.locator('.console-presentation-tile[aria-current="step"]');
          await expect(selectedTile).toHaveCount(1);
          const target = await selectedTile.getAttribute('data-target');
          const at = target === 'null' ? last : Number(target);
          expect(Number.isSafeInteger(at) && at >= 0 && at <= last).toBe(true);
          for (const [name, unavailable] of [['Back', at === 0], ['Forward', at === last], ['Live surface', at === last]]) {
            const navigation = presentation.getByRole('button', { name, exact: true });
            if (unavailable) await expect(navigation).toBeDisabled(); else await expect(navigation).toBeEnabled();
          }
        }
        const dock = page.locator('.console-action-dock');
        if (await dock.count()) {
          const primary = dock.locator('button.console-primary');
          if (await primary.count()) { await expect(primary).toHaveCount(1); await expect(primary).toBeInViewport(); }
          const undo = dock.getByRole('button', { name: /^Undo / });
          if (await undo.count()) await expect(undo).toBeInViewport();
        }
        if (width === 1366) {
          const lastContentControl = page.locator('.console-main button').last();
          if (await lastContentControl.count()) {
            await lastContentControl.focus();
            const unobscured = await lastContentControl.evaluate(element => {
              const button = element.getBoundingClientRect();
              const dock = document.querySelector('.console-action-dock')?.getBoundingClientRect();
              return button.top >= 0 && button.bottom <= (dock?.top ?? innerHeight) - 8;
            });
            expect(unobscured, `${phase} keyboard focus above action dock`).toBe(true);
          }
        }
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        expect(await page.evaluate(() => scrollY), `${phase} screenshot starts at top`).toBe(0);
        await expect(page.locator('.console-orientation')).toBeInViewport();
        await page.screenshot({ path: `${screenshots}/${phase.replaceAll('_', '-')}-${scheme}-${width}.png`, animations: 'disabled' });
      }
    }
  };
  const chooseAndReveal = async room => {
    await page.getByRole('button', { name: /^Lock responses & review$/ }).click();
    await inspect('responses_locked');
    await chooseLocalRoute(page, room);
    await inspect('responses_locked');
    await revealAtomic(page, room);
    await inspect('consequence_revealed');
  };
  let projector = null;
  try {
    const created = shell.waitForCreatedRoom();
    await startedRoom(page);
    const room = await created;
    await page.evaluate(sessionId => {
      const channel = new BroadcastChannel('case-room-local');
      window.__matrixProjectorHello = { channel, seen: false };
      channel.onmessage = ({ data }) => {
        if (data && [2, 4].includes(Object.keys(data).length) && data.t === 'projector_hello' && data.sessionId === sessionId)
          window.__matrixProjectorHello.seen = true;
      };
    }, room.sessionId);
    // Start room opened the same-PC projector in its own click (console layout v2).
    projector = await projectorPage(page);
    await expect(projector).toHaveURL(samePcProjectorUrl(room.sessionId, shell.origin));
    await expect(projector.getByRole('main', { name: 'Projector' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__matrixProjectorHello.seen),
      { message: 'actual room-bound projector handshake before display confirmation' }).toBe(true);
    await projectorRun(page);
    await inspect('lobby');
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case' }).click();
    await inspect('surface_live');
    await expect(page.getByRole('button', { name: 'Open responses' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: 'Show decision context' }).click();
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    await page.getByRole('button', { name: 'Open responses' }).click();
    await inspect('responses_open');
    await page.getByRole('button', { name: 'Lock responses & review' }).click();
    await inspect('responses_locked');
    await chooseLocalRoute(page, room, page.getByRole('radio', { name: 'Choose S00174 workshop label. Record a senso', exact: true }));
    await inspect('responses_locked');
    await revealAtomic(page, room);
    await inspect('terminal_teaching');
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: /^Reset to / }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: 'Open responses' }).click();
    await inspect('responses_open');
    await chooseAndReveal(room);
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: 'Show decision context' }).click();
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: 'Reveal investigations' }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    await page.getByRole('button', { name: 'Open responses' }).click();
    await inspect('responses_open');
    // CASE-255: Pause for discussion is retired; an open round offers no pause.
    await expect(page.getByRole('button', { name: 'Pause for discussion' })).toHaveCount(0);
    await chooseAndReveal(room);
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: 'Show decision context' }).click();
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    await page.getByRole('button', { name: 'Open responses' }).click();
    await inspect('responses_open');
    await chooseAndReveal(room);
    await page.getByRole('button', { name: 'Reveal observations' }).click();
    await page.getByRole('button', { name: 'Reveal findings' }).click();
    await page.getByRole('button', { name: 'Reveal investigations' }).click();
    await page.getByRole('button', { name: 'Reveal next surface' }).click();
    await inspect('surface_live');
    await endCase(page);
    await page.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click(); // card 40 slice 6: the summary comes first
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible(); // card 38: still signed in, back on the case
    await expect(page.locator('.console-room')).toHaveCount(0);
    expect(await caseStorageFootprint(page), 'ended private storage').toEqual({ privateKeys: [],
      privateValues: false, cachedApi: [], privateDatabases: [] });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1920, 1366]) {
        await page.setViewportSize({ width, height: width === 1920 ? 1080 : 768 });
        await settled(page);
        expect((await new AxeBuilder({ page }).analyze()).violations.map(item => item.id),
          `ended ${scheme} ${width}`).toEqual([]);
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        expect(await page.evaluate(() => scrollY), `ended ${scheme} ${width} screenshot starts at top`).toBe(0);
        await expect(page.locator('form.auth-form')).toBeHidden();await expect(page.getByRole('button',{name:'Open menu',exact:true})).toBeInViewport();
        await page.screenshot({ path: `${screenshots}/ended-${scheme}-${width}.png`, animations: 'disabled' });
      }
    }
  } finally {
    if (!page.isClosed()) await page.evaluate(() => { window.__matrixProjectorHello?.channel.close(); delete window.__matrixProjectorHello; });
    await projector?.close();
    await context.close();
  }
});

test('[AS-036] signed-in active room hides credential-entry buttons while keeping Sign out available', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    const form = page.locator('form.auth-form');
    for (const label of ['Email me a sign-in code', 'Or email me a link instead', 'Sign in'])
      await expect(form.getByRole('button', { name: label, includeHidden: true })).toBeHidden();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-036] active room replaces catalog chrome with its beat heading and accessible menu Sign out', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    const main = page.locator('main.facilitator-console');
    await expect(main.getByRole('heading', { name: 'Your cases', includeHidden: true })).toBeHidden();
    await expect(main.getByText('Room ready', { exact: true, includeHidden: true })).toBeHidden();
    await expect(main.locator('.console-orientation h1')).toHaveText('Lobby');
    await expect(main.getByRole('button', { name: 'Open menu', exact: true })).toBeInViewport();
    await main.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-036] the next console action stays visible but disabled while a command awaits its receipt', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case' }).click();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let heldCount = 0;
    await page.route(/\/commands$/, async route => { heldCount++; await held; await route.continue(); });
    await page.getByRole('button', { name: 'Reveal findings', exact: true }).click();
    const pending = page.locator('.console-action-dock .console-primary');
    await expect(pending).toBeVisible();
    await expect(pending).toHaveAttribute('aria-disabled', 'true');
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.console-action-dock')).toContainText('Sending to the room…');
    expect(heldCount).toBe(1);
    release();
    await expect(page.getByRole('button', { name: 'Show decision context', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.console-action-dock')).not.toContainText('Sending to the room…');
    await page.unroute(/\/commands$/);
  } finally { await context.close(); }
});

test('[AS-036] projector setup exposes alternatives only on request and never blocks Start case', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    await expect(page.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Open projector', exact: true })).toHaveCount(0);
    await expect(page.locator('.console-display-check')).toHaveCount(0);
    await projectorRoom(page);
    // Start room opened the projector in its own click (console layout v2), so the card reports it.
    await expect(page.locator('.console-rail .console-projector .tag')).toHaveText(/^(Connected|One screen)$/);
    await expect(page.getByLabel('Display pairing code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dismiss display reminder' })).toHaveCount(0);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 844 });
        // The test's own output folder, never a shared /tmp path another user can read or own (CI runners).
        await page.screenshot({ path: testInfo.outputPath(`default-projector-${scheme}-${width}.png`), animations: 'disabled' });
      }
    }
    await openProjectorOptions(page);
    await expect(page.getByLabel('Display pairing code')).toBeVisible();
    await projectorRun(page);
    await expect(page.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
    await openProjectorOptions(page);
    const screenshots = docShotsDir('12-screenshots');
    mkdirSync(screenshots, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1920, 1366, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1920 ? 1080 : 844 });
        await settled(page);
        expect((await new AxeBuilder({ page }).analyze()).violations.map(item => item.id),
          `projector setup ${scheme} ${width}`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `${screenshots}/display-check-${scheme}-${width}.png`, animations: 'disabled' });
      }
    }
    await page.locator('#console-setup [data-focus-key="pairing-cancel"]').click();
    await expect(page.getByLabel('Display pairing code')).toHaveCount(0);
    await projectorRun(page);
    await page.getByRole('button', { name: 'Start case', exact: true }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
  } finally { await context.close(); }
});

test('[AS-036] signing out while a workspace version response is held cannot rebuild the cleared catalog', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const requested = deferred(), release = deferred();
  const secondWorkspaceId = uuidv7();
  await page.route('**/api/v1/me?*', route => route.fulfill({ json: {
    account: { email: 'owner@example.invalid', administration: false },
    profile: { displayName: 'Facilitator' },
    memberships: [
      { workspace_id: worker.workspaceId, role: 'owner', name: 'First workspace' },
      { workspace_id: secondWorkspaceId, role: 'facilitator', name: 'Late workspace' },
    ], nextAfter: null,
  } }));
  await page.route(url => url.pathname === `/api/v1/workspaces/${worker.workspaceId}/catalogue`, async route => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ json: { cases: [], total: 0, offset: 0, limit: 24, pilotPin: null } });
  });
  try {
    await page.goto(casesUrl(shell.origin));
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill('123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await requested.promise;
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
    await expect(page.locator('.library')).toHaveCount(0);
    const response = page.waitForResponse(value =>
      new URL(value.url()).pathname === `/api/v1/workspaces/${worker.workspaceId}/catalogue`);
    release.resolve();
    await response;
    await afterBrowserResponse(page);
    await expect(page.locator('.library')).toHaveCount(0);
    await expect(page.locator('.case-card')).toHaveCount(0);
    await expect(page.getByText('Late workspace')).toHaveCount(0);
  } finally { release.resolve(); await context.close(); }
});

test('[AS-036] a held next workspace page cannot append catalog cards after room entry', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const requested = deferred(), release = deferred();
  const firstIds = Array.from({ length: 19 }, () => uuidv7());
  const cursor = firstIds.at(-1), lateId = uuidv7();
  await page.route('**/api/v1/me?*', async route => {
    const after = new URL(route.request().url()).searchParams.get('after');
    if (!after) return route.fulfill({ json: { profile: { displayName: 'Facilitator' },
      memberships: [{ workspace_id: worker.workspaceId, role: 'owner', name: 'First workspace' },
        ...firstIds.map(id => ({ workspace_id: id, role: 'facilitator', name: 'Other workspace' }))],
      nextAfter: cursor } });
    requested.resolve();
    await release.promise;
    await route.fulfill({ json: { profile: { displayName: 'Facilitator' },
      memberships: [{ workspace_id: lateId, role: 'facilitator', name: 'Late workspace' }],
      nextAfter: null } });
  });
  try {
    await signedIn(page);
    await page.getByRole('button', { name: 'More workspaces' }).click();
    await requested.promise;
    await (await openCase(page)).click();
    await consoleReady(page);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/me' &&
      new URL(value.url()).searchParams.has('after'));
    release.resolve();
    await response;
    await afterBrowserResponse(page);
    await consoleReady(page);
    await expect(page.getByText('Late workspace')).toHaveCount(0);
    await expect(page.locator('.case-workspace')).toHaveCount(0);
  } finally { release.resolve(); await context.close(); }
});

test('[AS-036] failed local room mount keeps the safe start error and a usable catalog', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.BroadcastChannel = class { constructor() { throw new Error('local channel unavailable'); } };
  });
  try {
    await signedIn(page);
    const beforeUpgrades = shell.upgradedCount;
    await (await openCase(page)).click();
    // CASE-356: a successful create followed by local mount failure must not create another Lobby.
    await expect(page.locator('.surface-toast')).toContainText('The session was created, but this console could not open. Check active sessions to reopen its Lobby.');
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeDisabled();
    await expect(page.getByRole('link',{name:'Sessions',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'Check active sessions',exact:true})).toHaveAttribute('href',casesUrl(shell.origin));
    await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link', { name: 'Present',exact:true }).click();
    await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    await expect(page.locator('.console-room')).toHaveCount(0);
    await afterBrowserResponse(page);
    // Give an accidentally started socket time to reach the local Worker.
    await page.waitForTimeout(250);
    expect(shell.upgradedCount).toBe(beforeUpgrades);
  } finally { await context.close(); }
});

test('[AS-036] room roster shows the approved avatar and join time, and facilitator rename uses cleaned text', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    // The started-room helper already sent the create request; read the active join code from the Room tab.
    await openRoomSetup(page);
    const displayed = await page.locator('.console-rail .console-people .console-code').first().textContent();
    const joined = await fetch(apiUrl(worker.origin, 'join'), { method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.85' },
      body: JSON.stringify({ v: 1, code: displayed.replace(/\s/g, ''),
        displayName: 'Learner', avatarId: 'shadows-01' }) });
    expect(joined.status).toBe(201);
    const row = page.locator('.console-person').filter({ hasText: 'Learner' });
    await expect(row).toBeVisible();
    await expect(row.locator('img.avatar')).toHaveCount(1);
    await expect(row).toContainText('Joined');
    await expect(row).not.toContainText('unavailable');
    page.once('dialog', dialog => dialog.accept('  Renamed   Learner  '));
    await page.getByRole('button', { name: 'Rename Learner' }).click();
    await expect(page.locator('.console-person').filter({ hasText: 'Renamed Learner' })).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-036] visible manual Room controls change local authority and End clears the console', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    await openRoomSetup(page);
    await expect(page.getByRole('button', { name: /^(Show|Hide) names on projector$/ })).toHaveCount(0);
    await closeRoomSetup(page);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case', exact: true }).click();
    await openRoomSetup(page);
    await enterManualRoom(page);
    await expect(page.getByText('This computer runs the session. Keep this tab open.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take over this session' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show names on projector' }).click();
    await expect(page.getByRole('button', { name: 'Hide names on projector' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop new joins' }).click();
    await expect(page.getByRole('button', { name: 'Allow new joins' })).toBeVisible();
    await endCase(page);
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible(); // card 38: still signed in, back on the case
    await expect(page.locator('.console-room')).toHaveCount(0);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
  } finally { await context.close(); }
});

test('[AS-036] display check can be repeated during an active phase without hiding clinical controls', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await startedRoom(page);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case' }).click();
    await openRoomSetup(page);
    await openProjectorOptions(page);
    await expect(page.getByRole('button', { name: 'Check display' })).toBeVisible();
    await openProjectorOptions(page);
    await page.getByRole('button', { name: 'Check display' }).click();
    await openProjectorOptions(page);
    await expect(page.getByRole('button', { name: 'Dismiss display reminder' })).toBeVisible();
    await projectorRun(page);
    await expect(page.getByRole('button', { name: 'Reveal findings' })).toBeVisible();
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await expect(page.getByRole('button', { name: 'Reveal findings' })).toBeVisible();
  } finally { await context.close(); }
});

test('console UI tones stay silent until the console sound toggle is pressed, then play on its controls only', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    window.toneEvidence = { created: 0, started: 0 };
    const Native = window.AudioContext;
    window.AudioContext = class extends Native { constructor(...args) { super(...args); window.toneEvidence.created++; }
      createBufferSource() { const source = super.createBufferSource(); const start = source.start.bind(source);
        source.start = (...args) => { window.toneEvidence.started++; return start(...args); }; return source; } };
  });
  const fac = await context.newPage();
  try {
    await signedIn(fac);
    const created = shell.waitForCreatedRoom();
    await (await openCase(fac)).click();
    await created;
    await consoleReady(fac);
    const evidence = () => fac.evaluate(() => window.toneEvidence);
    const menu = fac.getByRole('dialog', { name: 'Menu', exact: true });
    const openSoundMenu = async () => {
      await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
      await expect(menu).toBeVisible();
    };
    await openSoundMenu();
    await expect(menu.getByRole('button', { name: 'Enable console sounds', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Disable console sounds', exact: true })).toHaveCount(0);
    await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
    const otherScreen = fac.locator('.console-rail [data-focus-key="use-another-screen"]'), cancel = fac.locator('#console-setup [data-focus-key="pairing-cancel"]');
    await otherScreen.click(); await cancel.click();
    await fac.waitForTimeout(300);
    expect(await evidence()).toEqual({ created: 0, started: 0 });
    await openSoundMenu();
    await menu.getByRole('button', { name: 'Enable console sounds', exact: true }).click();
    await expect(menu).toBeHidden();
    await openSoundMenu();
    await expect(menu.getByRole('button', { name: 'Disable console sounds', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Enable console sounds', exact: true })).toHaveCount(0);
    await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
    expect((await evidence()).created).toBe(1);
    const before = (await evidence()).started;
    await otherScreen.click();
    await expect.poll(async () => (await evidence()).started).toBeGreaterThan(before);
    // Opening the console menu is itself an eligible console control while sound is on.
    await openSoundMenu();
    const afterOpen = (await evidence()).started;
    await menu.getByRole('button', { name: 'Disable console sounds', exact: true }).click();
    await expect(menu).toBeHidden();
    await openSoundMenu();
    await expect(menu.getByRole('button', { name: 'Enable console sounds', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Disable console sounds', exact: true })).toHaveCount(0);
    await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
    await cancel.click();
    await fac.waitForTimeout(300);
    expect((await evidence()).started).toBe(afterOpen);
  } finally { await context.close(); }
});

test('[AS-036] same-PC console mute only turns projector sound off after a room-scoped acknowledgement', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const fac = await context.newPage();
  try {
    await signedIn(fac);
    const created = shell.waitForCreatedRoom();
    await (await openCase(fac)).click();
    const room = await created;
    const projector = await projectorPage(fac); // Present opened it in its own click (console layout v2)
    const sound = projector.getByRole('button', { name: 'Session sound' });
    await expect(sound).toBeVisible();
    await sound.click();
    await expect(sound).toHaveAttribute('aria-pressed', 'true');
    const menu = fac.getByRole('dialog', { name: 'Menu', exact: true });
    await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
    const mute = menu.getByRole('button', { name: 'Mute same-PC projector', exact: true });
    await expect(mute).toBeVisible();
    await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
    await closeRoomSetup(fac);
    await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(mute).toBeVisible();
    await expect(projector.locator('#projectorCheck')).toBeHidden();
    await fac.evaluate(({ sessionId, wrongId }) => {
      const channel = new BroadcastChannel('case-room-local');
      channel.postMessage({ t: 'mute_projector', sessionId: wrongId, requestId: wrongId });
      channel.postMessage({ t: 'mute_projector', sessionId, requestId: 'malformed', extra: true });
      channel.postMessage({ t: 'show_projector', sessionId });
      channel.close();
    }, { sessionId: room.sessionId, wrongId: uuidv7() });
    await expect(projector.locator('#projectorCheck')).toBeVisible();
    await expect(sound).toHaveAttribute('aria-pressed', 'true');
    await mute.click();
    await expect(menu).toBeHidden();
    await expect(sound).toHaveAttribute('aria-pressed', 'false');
    await expect(fac.getByRole('status').filter({ hasText: 'Projector sound muted' })).toBeVisible();
    await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
    await mute.click();
    await expect(menu).toBeHidden();
    await expect(sound).toHaveAttribute('aria-pressed', 'false');
    await expect(fac.getByText('On a separate display, use its Session sound chip to mute it.')).toHaveCount(0);
    await openProjectorOptions(fac);
    await expect(fac.getByText('On a separate display, use its Session sound chip to mute it.')).toBeVisible();
  } finally { await context.close(); }
});

test('[CASE-255] the dock Room sound switch mutes the same-PC projector and console sounds through the Menu\'s own actions, and keeps the main action in place', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const fac = await context.newPage();
  try {
    await signedIn(fac);
    const created = shell.waitForCreatedRoom();
    await (await openCase(fac)).click();
    await created;
    const projector = await projectorPage(fac); // Present opened it in its own click (console layout v2)
    const projectorSound = projector.getByRole('button', { name: 'Session sound' });
    await projectorSound.click();
    await expect(projectorSound).toHaveAttribute('aria-pressed', 'true');
    await closeRoomSetup(fac);
    const menu = fac.getByRole('dialog', { name: 'Menu', exact: true });
    await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
    await menu.getByRole('button', { name: 'Enable console sounds', exact: true }).click();
    await expect(menu).toBeHidden();
    const dock = fac.locator('.console-action-dock');
    const quiet = dock.getByRole('button', { name: 'Session sound', exact: true });
    await expect(quiet).toHaveAttribute('aria-pressed', 'true');
    await expect(dock.getByRole('button', { name: 'Pause for discussion' })).toHaveCount(0);
    const primary = fac.locator('.console-primary'), before = await primary.boundingBox();
    // Its own slot, opposite Undo: it never overlaps the main action.
    const slot = await quiet.boundingBox();
    expect(slot.x).toBeGreaterThanOrEqual(before.x + before.width);
    await quiet.click();
    await expect(quiet).toHaveAttribute('aria-pressed', 'false');
    await expect(projectorSound).toHaveAttribute('aria-pressed', 'false');
    await expect(fac.getByRole('status').filter({ hasText: 'Projector sound muted' })).toBeVisible();
    await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(menu.getByRole('button', { name: 'Enable console sounds', exact: true })).toBeVisible();
    await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
    expect(await primary.boundingBox()).toEqual(before);
    await quiet.click();
    await expect(quiet).toHaveAttribute('aria-pressed', 'true');
    await expect(fac.getByRole('status').filter({ hasText: 'Session sound on. Press Session sound on the projector to bring its music back.' })).toBeVisible();
    await expect(projectorSound).toHaveAttribute('aria-pressed', 'false');
    await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(menu.getByRole('button', { name: 'Disable console sounds', exact: true })).toBeVisible();
    await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
    expect(await primary.boundingBox()).toEqual(before);
  } finally { await context.close(); }
});

test('[AS-036] manual entry says it voids an open round before the second press, and not pressing again preserves it', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('dialog', dialog => { throw new Error(`no pop-up: ${dialog.message()}`); });
  try {
    await startedRoom(page);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case' }).click();
    await openFirstDecisionWithContext(page);
    const sheet = await openRoomSetup(page);
    const manual = sheet.locator('[data-focus-key="arm-manual"]');
    await manual.click();
    await expect(manual).toHaveText('Press again: manual session');
    await expect(page.locator('#console-dock-status')).toHaveText(/^Discards the open round\./);
    // Not pressing again within 3 s leaves everything as it was.
    await expect(manual).toHaveText('Enter manual session mode', { timeout: 5000 });
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key =>
      key.startsWith('case-lab:segment:')))).toEqual([]);
    await closeRoomSetup(page);
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
    await enterManualRoom(page);
    await expect(page.getByText('This computer runs the session. Keep this tab open.')).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-036] locked facilitator responses show every mapped option count and share once in authored route cards plus a nonbinding suggestion', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    const { room, option } = await lockedRoomWithOneVote(page);
    const aggregate = page.locator('.console-aggregate');
    await expect(aggregate).toContainText('Responses · 1 answer');
    const frozen = (await serverMirror(worker.origin, room)).round.aggregate;
    expect(frozen.total).toBe(1); expect(frozen.counts[option.id]).toBe(1);
    const decision = FIXTURE.decisions[0];
    for (const authored of decision.interaction.options) {
      const count = frozen.counts[authored.id] ?? 0;
      expect(count).toBe(authored.id === option.id ? 1 : 0);
      const path = decision.paths.find(row => row.option_ids?.includes(authored.id));
      expect(path, `${authored.label} maps to its authored route`).toBeTruthy();
      const row = page.locator('.console-route').filter({ has: page.getByRole('radio', { name: `Choose ${path.label}`, exact: true }) });
      await expect(row.locator('.console-option-count')).toHaveText(`${count} ${count === 1 ? 'response' : 'responses'} · ${Math.round(count / frozen.total * 100)}%`);
    }
    await expect(page.locator('.console-option-count')).toHaveCount(decision.interaction.options.length);
    // CASE-251: the choice glyph ends every row, so it sits in one column whatever each row's count says.
    const glyphs = await page.locator('.console-route-glyph').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().right)));
    expect(glyphs.length).toBeGreaterThan(1); expect(new Set(glyphs).size, `glyph right edges ${glyphs}`).toBe(1);
    await expect(aggregate.locator('.console-option-count, .console-option-list')).toHaveCount(0);
    await expect(aggregate).toContainText('Suggested by responses:');
    await expect(aggregate).toContainText('You choose the path.');
    expect((await aggregate.innerText()).match(/choose/gi), '"choose" is said once').toHaveLength(1);
  } finally { await context.close(); }
});

// Card 61 (RUNTIME-01): an ordinary question (CASE-280) has no authored route to choose. The live console goes
// Lock → Continue with no route card; Space continues on one press, like Next; Undo returns to the locked discussion.
test('[AS-006] an ordinary select-all, ranking or free-text question goes Lock → Continue on the live console, with no route card (card 61)', async ({ browser }) => {
  const otp = String(randomInt(100000, 1000000)), document = ordinaryQuestions(FIXTURE, ['multi_select', 'ranking', 'free_text']);
  const localAuth = await startLocalAuthStub({ appOrigin: null, jwt: null, otp });
  let localWorker, localShell, context;
  try {
    localWorker = await startPublishedWorker({ authOrigin: localAuth.origin, caseDocument: document });
    localAuth.setJwt(localWorker.jwt);
    localShell = await startServedAuthShell({ apiOrigin: localWorker.origin,
      buildAuthBindings: { SUPABASE_URL: localAuth.origin,
        SUPABASE_JWT_ISSUER: `${localAuth.origin}/auth/v1`,
        SUPABASE_JWKS_URL: `${localAuth.origin}/auth/v1/.well-known/jwks.json` } });
    localAuth.setAppOrigin(localShell.origin);
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(casesUrl(localShell.origin));
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill(otp);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const created = localShell.waitForCreatedRoom();
    await (await openCase(page)).click();
    const room = await created;
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    const phase = page.locator('.console-phase'), main = page.locator('.console-primary'), commands = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/sessions/${room.sessionId}/commands`) commands.push(request.postDataJSON()); });
    await page.getByRole('button', { name: 'Start case' }).click();
    for (const [index, decision] of document.decisions.entries()) {
      for (let i = 0; i < 8 && await phase.getAttribute('data-phase') !== 'responses_open'; i++) { await main.click(); await expect(main).not.toHaveAttribute('aria-busy', 'true'); }
      await expect(phase).toHaveAttribute('data-phase', 'responses_open');
      await main.click();
      await expect(phase).toHaveAttribute('data-phase', 'responses_locked');
      const next = document.beats.find(beat => beat.id === decision.paths[0].next_beat_id);
      await expect(main).toHaveText(`Continue to ${next.title}`);
      await expect(page.locator('.console-routes')).toHaveCount(0);
      await expect(page.locator('.console-card').filter({ hasText: /authored route|route cards|Suggested by responses/ })).toHaveCount(0);
      if (index === 0) {
        commands.length = 0;
        await main.click();
        await expect(phase).toHaveAttribute('data-phase', 'surface_live');
        expect(commands.map(command => [command.type, command.pathId])).toEqual([['reveal_path', decision.paths[0].id]]);
        expect((await serverMirror(localWorker.origin, room)).beatId).toBe(next.id);
        await page.locator('.console-undo').click();
        await expect(phase).toHaveAttribute('data-phase', 'responses_locked');
        await expect(main).toHaveText(`Continue to ${next.title}`);
        await main.click();
      } else if (index === 1) {
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Space');
        await expect(page.getByRole('button', { name: 'Show to participants?' })).toHaveCount(0);
      } else await main.click();
      await expect(phase).toHaveAttribute('data-phase', 'surface_live');
      expect((await serverMirror(localWorker.origin, room)).beatId).toBe(next.id);
    }
  } finally { await context?.close(); await localShell?.stop(); await localWorker?.stop(); await localAuth.stop(); }
});

test('[AS-036] facilitator resolution rows expose private classification, rationale and cue before choice', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await lockedRoomWithOneVote(page);
    const sound = page.locator('.console-route').filter({ hasText: 'S00177 workshop label. Record a sensor signal and inspect the selec' });
    await expect(sound).toContainText('Sound');
    const path = FIXTURE.decisions[0].paths.find(row => row.label.startsWith('S00177 workshop label. Record a sensor signal and inspect the selec'));
    await expect(sound.getByText('Private notes', { exact: true })).toBeVisible();
    await expect(sound.getByRole('radio', { name: `Choose ${path.label}`, exact: true })).toBeVisible();
    await sound.locator('summary').click();
    await expect(sound).toContainText(path.rationale); await expect(sound).toContainText(path.cue);
    await expect(sound).toContainText('Ask:');
    await expect(page.getByRole('button', { name: /^Reveal:/ })).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-061] served console, phone and same-PC projector share only revealed room state through manual recovery', async ({ browser }) => {
  test.setTimeout(120_000);
  const facContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 } });
  const outage = await roomNetwork(facContext);
  const fac = await facContext.newPage();
  const phone = await phoneContext.newPage();
  const publicUrls = [], publicFrames = [], publicBodies = [];
  const watchPublic = page => {
    page.on('request', request => publicUrls.push(request.url()));
    page.on('websocket', socket => {
      publicUrls.push(socket.url());
      socket.on('framereceived', frame => publicFrames.push(String(frame.payload)));
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path === '/api/v1/join' || /\/snapshot$/.test(path))
        publicBodies.push(response.text().catch(() => 'unreadable'));
    });
  };
  watchPublic(phone);
  let projector, releaseUpload = () => {};
  let uploadHeld = false, uploadCount = 0, cleaningUploads = false;
  const uploadHandlers = [];
  const uploadRoute = '**/api/v1/sessions/*/manual-segment';
  try {
    await signedIn(fac);
    const created = shell.waitForCreatedRoom();
    await (await openCase(fac)).click();
    const room = await created;
    projector = await projectorPage(fac); // Present opened it in its own click (console layout v2)
    watchPublic(projector);
    await expect(projector.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
    await expect(projector.locator('.names .arrival-note')).toHaveText('0 joined');
    await expect(projector.getByRole('heading', { name: 'Joining is closed', exact: true })).toHaveCount(0);
    await closeRoomSetup(fac);
    await openProjectorOptions(fac);
    await dismissProjectorReminder(fac);

    await phone.goto(joinUrl(room.joinCode, shell.origin));
    await phone.getByLabel('Your name').fill('Learner');
    await phone.getByRole('button', { name: 'Join case' }).click();
    await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
    await expect.poll(() => new URL(phone.url()).pathname).toBe(
      new URL(sessionUrl(room.sessionId, 'play', shell.origin)).pathname);
    await expect(fac.locator('.console-people-count strong')).toHaveText('1');

    await fac.getByRole('button', { name: 'Start case' }).click();
    await openFirstDecisionWithContext(fac);
    await phone.getByRole('radio', { name: /S00175 workshop label. Record a s/ }).check();
    await expect(phone.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
    await expect(phone.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
    // Keep Lock asynchronous so the route-local baseline cannot race its preceding command.
    await fac.route('**/api/v1/sessions/*/commands', async route => {
      if (route.request().postDataJSON()?.type === 'lock') await new Promise(resolve => setTimeout(resolve, 250));
      await route.continue();
    });
    await fac.getByRole('button', { name: 'Lock responses & review' }).click();
    await chooseLocalRoute(fac, room);
    await revealAtomic(fac, room);
    await expect(projector.getByRole('heading', { name: 'S00031 workshop title. Recordz' })).toBeVisible();

    await openRoomSetup(fac);
    await outage.offline(fac);
    await enterManualRoom(fac);
    fac.once('dialog', dialog => dialog.accept('Local discussion marker'));
    await fac.getByRole('button', { name: 'Add spoken marker' }).click();
    await expect(projector.getByText('Manual session mode · facilitator-led discussion')).toBeVisible();
    await expect(phone.getByText('Facilitator-led discussion · phone answers are off for now')).toHaveCount(0);
    const rejoin = fac.getByRole('button', { name: 'Rejoin online at the next decision' });
    await expect(rejoin).toBeDisabled();
    await rejoin.hover();
    try { await fac.mouse.down(); }
    finally { await fac.mouse.up(); }
    await outage.online();
    await expect(rejoin).toBeEnabled();
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    await fac.route(uploadRoute, route => {
      uploadCount++; uploadHeld = true;
      const handled = (async () => {
        await uploadGate;
        try { await route.continue(); } catch (error) { if (!cleaningUploads && !fac.isClosed()) throw error; }
      })();
      uploadHandlers.push(handled);
      return handled;
    });
    await rejoin.click();
    await expect.poll(() => uploadHeld).toBe(true);
    expect(await fac.getByRole('button', { name: 'Add spoken marker', exact: true }).count()).toBe(0);
    expect(await fac.getByRole('button', { name: /^(Rejoin online at the next decision|Retry manual upload)$/ }).isDisabled()).toBe(true);
    expect(uploadCount).toBe(1);
    releaseUpload();
    await expect(fac.getByRole('status').filter({ hasText: 'Manual changes rejoined the room.' })).toBeVisible();

    const disclosed = [publicFrames.join('\n'), ...(await Promise.all(publicBodies)),
      await phone.locator('body').innerText(), await projector.locator('body').innerText()].join('\n');
    for (const privatePart of ['"rationale"', '"caseDoc"', '"document_text"',
      FIXTURE.surfaces[0].notes.slice(0, 60), FIXTURE.decisions[0].paths[0].rationale.slice(0, 60),
      'Local discussion marker', room.facilitatorToken, worker.jwt])
      expect(disclosed).not.toContain(privatePart);
    expect(publicUrls.every(url => !url.includes(room.facilitatorToken) && !url.includes(worker.jwt) &&
      !url.includes('Learner') && !url.includes('Local discussion marker'))).toBe(true);
    await endCase(fac);
    await fac.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click(); // card 40 slice 6: the ended summary comes first
    await expect(fac.getByRole('button', { name: 'Present', exact: true })).toBeVisible(); // card 38: still signed in, back on the case
    expect(await caseStorageFootprint(fac)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
  } finally { cleaningUploads = true; releaseUpload(); await Promise.all(uploadHandlers); await fac.unroute(uploadRoute); await facContext.close(); await phoneContext.close(); }
});

test('[AS-112] a facilitator starts a published case without confirming the advisory display check', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signedIn(page);
  await (await openCase(page)).click();
  await consoleReady(page);
  await expect.poll(() => shell.upgradedCount ?? 0).toBeGreaterThan(0);
  await consoleReady(page);
  await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
  await expect(page.getByText('Confirm the display check first')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start case' }).click();
  await expect(page.getByRole('heading', { name: 'Live surface' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reveal findings' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open responses' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'The session could not apply that action.' })).toHaveCount(0);
  await context.close();
});

test('Card 12 console never locks after more than ten quiet minutes before and during a room', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.clock.install();
  await signedIn(page);
  await page.clock.fastForward(10 * 60_000 + 1000);
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
  await (await openCase(page)).click();
  await expect(page.getByRole('button', { name: 'Start case' })).toBeVisible();
  await page.clock.fastForward(10 * 60_000 + 1000);
  await expect(page.getByRole('button', { name: 'Start case' })).toBeVisible();
  await expect(page.getByText(/locked due to inactivity/i)).toHaveCount(0);
  await context.close();
});

test('[AS-036] served projector handshake and actual ScreenDetails change renew the advisory display reminder without blocking start', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const details = new EventTarget();
    details.screens = [{}, {}];
    Object.defineProperty(navigator, 'permissions', { configurable: true,
      value: { query: async () => ({ state: 'granted' }) } });
    window.getScreenDetails = async () => details;
    window.__caseScreenCount = count => {
      details.screens = Array.from({ length: count }, () => ({}));
      details.dispatchEvent(new Event('screenschange'));
    };
  });
  try {
    await signedIn(page);
    const created = shell.waitForCreatedRoom();
    await (await openCase(page)).click();
    const room = await created;
    await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
    await page.evaluate(sessionId => {
      const channel = new BroadcastChannel('case-room-local');
      channel.postMessage({ t: 'projector_hello', sessionId });
      channel.close();
    }, room.sessionId);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
    await page.evaluate(() => window.__caseScreenCount(1));
    await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
    await expect(page.getByText('The projector connection changed. Check the room screen if needed.')).toBeVisible();
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
    await page.evaluate(() => window.__caseScreenCount(2));
    await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
  } finally { await context.close(); }
});

test('[AS-002] a different projector at the same screen count clears the display check (CASE-167)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const laptop = { label: 'Built-in', left: 0, top: 0, width: 1440, height: 900, isPrimary: true, isExtended: true };
    const details = new EventTarget();
    details.screens = [laptop, { label: 'EPSON PJ', left: 1440, top: 0, width: 1920, height: 1080, isPrimary: false, isExtended: true }];
    details.currentScreen = laptop;
    Object.defineProperty(navigator, 'permissions', { configurable: true,
      value: { query: async () => ({ state: 'granted' }) } });
    window.getScreenDetails = async () => details;
    window.__caseSwapProjector = () => {
      details.screens = [laptop, { label: 'Panasonic PT', left: 1440, top: 0, width: 1280, height: 800, isPrimary: false, isExtended: true }];
      details.dispatchEvent(new Event('screenschange'));
    };
  });
  try {
    await signedIn(page);
    const created = shell.waitForCreatedRoom();
    await (await openCase(page)).click();
    const room = await created;
    const start = page.getByRole('button', { name: 'Start case' });
    await page.evaluate(sessionId => {
      const channel = new BroadcastChannel('case-room-local');
      channel.postMessage({ t: 'projector_hello', sessionId });
      channel.close();
    }, room.sessionId);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await expect(start).toBeEnabled();
    await page.evaluate(() => window.__caseSwapProjector());
    await expect(start).toBeEnabled();
    await expect(page.getByText('The projector connection changed. Check the room screen if needed.')).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-002] the facilitator opts in to screen identity, which never prompts by itself and then sees a projector swap (CASE-167)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const laptop = { label: 'Built-in', left: 0, top: 0, width: 1440, height: 900, isPrimary: true, isExtended: true };
    const details = new EventTarget();
    details.screens = [laptop, { label: 'EPSON PJ', left: 1440, top: 0, width: 1920, height: 1080, isPrimary: false, isExtended: true }];
    details.currentScreen = laptop;
    let state = 'prompt';
    window.__caseScreenRequests = 0;
    Object.defineProperty(navigator, 'permissions', { configurable: true,
      value: { query: async () => ({ state }) } });
    window.getScreenDetails = async () => { window.__caseScreenRequests += 1; state = 'granted'; return details; };
    window.__caseSwapProjector = () => {
      details.screens = [laptop, { label: 'Panasonic PT', left: 1440, top: 0, width: 1280, height: 800, isPrimary: false, isExtended: true }];
      details.dispatchEvent(new Event('screenschange'));
    };
  });
  try {
    await signedIn(page);
    const created = shell.waitForCreatedRoom();
    await (await openCase(page)).click();
    const room = await created;
    const start = page.getByRole('button', { name: 'Start case' });
    await page.evaluate(sessionId => {
      const channel = new BroadcastChannel('case-room-local');
      channel.postMessage({ t: 'projector_hello', sessionId });
      channel.close();
    }, room.sessionId);
    await openProjectorOptions(page);
    const optIn = page.getByRole('button', { name: 'Identify screens' });
    await expect(optIn).toBeVisible();
    expect(await page.evaluate(() => window.__caseScreenRequests)).toBe(0);
    await optIn.click();
    await expect(page.getByText('Case can now tell your screens apart.')).toBeVisible();
    await expect(optIn).toHaveCount(0);
    expect(await page.evaluate(() => window.__caseScreenRequests)).toBe(1);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await expect(start).toBeEnabled();
    await page.waitForTimeout(2500);
    await expect(start).toBeEnabled();
    await page.evaluate(() => window.__caseSwapProjector());
    await expect(start).toBeEnabled();
    await openProjectorOptions(page);
    await expect(page.getByRole('button', { name: 'Dismiss display reminder' })).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-002] approving or replacing a display through the console renews the advisory display reminder without blocking start (CASE-165)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const displays = [];
  try {
    const page = await context.newPage();
    await signedIn(page);
    await (await openCase(page)).click();
    const start = page.getByRole('button', { name: 'Start case' });
    await expect(start).toBeEnabled();
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await expect(start).toBeEnabled();
    for (const round of ['first', 'replacement']) {
      const displayContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      displays.push(displayContext);
      const display = await displayContext.newPage();
      await display.goto(displayPairUrl('00000000', shell.origin));
      await expect(display.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
      const code = (await display.locator('.pair-code').textContent()).replace(/\s/g, '');
      await openRoomSetup(page);
      await openProjectorOptions(page);
      await page.getByLabel('Display pairing code').fill(code);
      await openProjectorOptions(page);
      await page.getByRole('button', { name: 'Connect projector' }).click();
      await expect(display.locator('.joinpanel'), `${round} display paired`).toBeVisible();
      await projectorRun(page);
      await expect(start, `${round} display approval clears the confirmation`).toBeEnabled();
      await expect(page.getByText('Confirm the display check first')).toHaveCount(0);
      await expect(page.getByText('The projector connection changed. Check the room screen if needed.')).toBeVisible();
      await closeRoomSetup(page);
      await openProjectorOptions(page);
      await dismissProjectorReminder(page);
      await expect(start).toBeEnabled();
    }
  } finally { for (const c of displays) await c.close(); await context.close(); }
});

test('[AS-036] served PC pairing hands an approved room into the actual console without an account session', async ({ browser }) => {
  const created = await fetch(apiUrl(worker.origin, 'sessions'), { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(created.status).toBe(201);
  const room = await created.json();
  worker.fake.replies.set('list_owned_active_sessions', [{ session_id: room.sessionId,
    join_code: room.joinCode, expires_at: room.expiresAt }]);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const pc = await context.newPage();
  await pc.goto(`${shell.origin}/P`);
  await expect(pc.getByLabel('PC approval code')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
  const code = (await pc.getByLabel('PC approval code').textContent()).replace(/\s/g, '');
  const approved = await fetch(apiUrl(worker.origin, 'console-pairs', 'approve'), { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code, sessionId: room.sessionId }) });
  expect(approved.status).toBe(200);
  await expect(pc.getByRole('status').filter({ hasText: 'PC ready' })).toBeVisible();
  await consoleReady(pc);
  await consoleReady(pc);
  const stored = await pc.evaluate(() => ({ session: Object.keys(sessionStorage), local: Object.keys(localStorage) }));
  expect(stored.session.filter(key => key.startsWith('case:auth:'))).toEqual([]);
  expect(stored.local.filter(key => key.startsWith('case:auth:'))).toEqual([]);
  await endCase(pc);
  // Card 40 slice 6 (ruling D): the shared computer shows the ended summary first, with the debrief and no feedback count.
  const summary = pc.locator('.ended-summary');
  await expect(summary.getByRole('button', { name: 'Download debrief (PDF)' })).toBeVisible();
  await expect(summary).not.toContainText('so far');
  await summary.getByRole('button', { name: 'Back to Present' }).click();
  await expect(pc.getByRole('heading', { name: 'Room ended', exact: true })).toBeVisible();
  await expect(pc.getByRole('button', { name: 'Approve a new session' })).toBeVisible();
  await expect(pc.locator('.console-room .console-primary')).toHaveCount(0);
  await context.close();
});

test('[AS-036] paired PC capability loss clears its console without claiming the live room ended', async ({ browser }) => {
  const created = await fetch(apiUrl(worker.origin, 'sessions'), { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(created.status).toBe(201);
  const room = await created.json();
  worker.fake.replies.set('list_owned_active_sessions', [{ session_id: room.sessionId,
    join_code: room.joinCode, expires_at: room.expiresAt }]);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const pc = await context.newPage();
  await pc.goto(`${shell.origin}/P`);
  await expect(pc.getByLabel('PC approval code')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
  const code = (await pc.getByLabel('PC approval code').textContent()).replace(/\s/g, '');
  const approved = await fetch(apiUrl(worker.origin, 'console-pairs', 'approve'), { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code, sessionId: room.sessionId }) });
  expect(approved.status).toBe(200);
  await expect(pc.getByRole('status').filter({ hasText: 'PC ready' })).toBeVisible();
  await consoleReady(pc);
  await consoleReady(pc);
  const minted = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'facilitator-token'), {
    method: 'POST', headers: { authorization: `Bearer ${worker.jwt}` },
  });
  expect(minted.status).toBe(201);
  const successor = await minted.json();
  const before = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'snapshot'), {
    headers: { authorization: `Bearer ${successor.facilitatorToken}` },
  });
  expect(before.status).toBe(200);
  const frame = await before.json();
  const taken = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'commands'), {
    method: 'POST', headers: { authorization: `Bearer ${successor.facilitatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'takeover', epoch: frame.epoch, clientEventId: uuidv7() }),
  });
  expect(taken.status).toBe(200);
  expect((await taken.json()).receipt.receipt).toBe('accepted');
  await expect(pc.getByRole('heading', { name: 'Console access ended', exact: true })).toBeVisible();
  await expect(pc.getByRole('heading', { name: 'Room ended', exact: true })).toHaveCount(0);
  await expect(pc.locator('.console-room .console-primary')).toHaveCount(0);
  await expect(pc.getByText('The room may still be running.', { exact: false })).toBeVisible();
  expect((await serverMirror(worker.origin, { ...room, facilitatorToken: successor.facilitatorToken })).phase).toBe('lobby');
  await context.close();
});

test('[AS-109] the starter stops a shared computer from the Room tab: the PC shows Console access ended and the starter console carries on', async ({ browser }) => {
  const created = await fetch(apiUrl(worker.origin, 'sessions'), { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(created.status).toBe(201);
  const room = await created.json();
  listRooms(room);
  const pcContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const starterContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const pc = await pcContext.newPage();
    await pc.goto(`${shell.origin}/P`);
    await expect(pc.getByLabel('PC approval code')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
    const code = (await pc.getByLabel('PC approval code').textContent()).replace(/\s/g, '');
    expect((await fetch(apiUrl(worker.origin, 'console-pairs', 'approve'), { method: 'POST',
      headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code, sessionId: room.sessionId }) })).status).toBe(200);
    await expect(pc.getByRole('status').filter({ hasText: 'PC ready' })).toBeVisible();
    // The starter rejoins on their signed-in device (a fresh console credential, no takeover), so both run the room.
    const page = await starterContext.newPage();
    await signedIn(page);
    await page.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) }).click();
    await consoleReady(page);
    await openRoomSetup(page);
    await expect(page.getByText(/^Signed-in device · since /)).toHaveCount(1);
    const stop = page.getByRole('button', { name: /^Stop shared computer \(since / });
    await expect(stop).toHaveCount(1);
    // The shared computer has no account: it never lists or stops consoles.
    await openRoomSetup(pc);
    await expect(pc.getByRole('heading', { name: 'Consoles' })).toHaveCount(0);
    // Two consoles run the room, so Take over is offered too (console layout v2); Stop confirms in place.
    await expect(page.getByRole('button', { name: 'Take over this session' })).toHaveCount(1);
    await confirmInPlace(page, page.locator('[data-focus-key^="arm-revoke-console-"]'), 'Press again: stop it');
    await expect(pc.getByRole('heading', { name: 'Console access ended', exact: true })).toBeVisible();
    await expect(pc.getByText('the room starter stopped it', { exact: false })).toBeVisible();
    await expect(pc.locator('.console-room .console-primary')).toHaveCount(0);
    // The starter's console is untouched and still commands the room.
    await expect(page.getByRole('status').filter({ hasText: 'Shared computer stopped.' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Stop shared computer/ })).toHaveCount(0);
    await expect(page.getByText(/^Signed-in device · since /)).toHaveCount(1);
    await page.getByRole('button', { name: 'Stop new joins' }).click();
    await expect(page.getByRole('button', { name: 'Allow new joins' })).toBeVisible();
    await consoleReady(page);
    // A reload of the PC finds no room: its credential was in memory only and is revoked on the server.
    await pc.reload();
    await expect(pc.locator('.console-room .console-primary')).toHaveCount(0);
  } finally { unlistRooms(); await pcContext.close(); await starterContext.close(); }
});

test('[AS-036] background room update keeps display input and keyboard focus, then phase change announces heading', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signedIn(page);
  const created = shell.waitForCreatedRoom();
  await (await openCase(page)).click();
  const room = await created;
  await consoleReady(page);
  await openRoomSetup(page);
  await openProjectorOptions(page);
  const input = page.getByLabel('Display pairing code');
  await input.fill('7K3QX9AB');
  await input.focus();
  const joined = await fetch(apiUrl(worker.origin, 'join'), { method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.78' },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName: 'Learner', avatarId: 'shadows-01' }) });
  expect(joined.status).toBe(201);
  await expect(page.locator('.console-people-count strong')).toHaveText('1');
  await expect(input).toHaveValue('7K3QX9AB');
  expect(await input.evaluate(element => element === document.activeElement)).toBe(true);
  let approvals = 0;
  const countApproval = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/display-pairs/approve')) approvals++;
  };
  page.on('request', countApproval);
  await openProjectorOptions(page);
  const approval = await page.getByRole('button', { name: 'Connect projector' }).elementHandle();
  const box = await approval.boundingBox();
  let connectedDuringActivation;
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Let the real input-blur timer run before the matching native mouseup.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    connectedDuringActivation = await approval.evaluate(button => button.isConnected);
  } finally {
    await page.mouse.up();
    await approval.dispose();
  }
  expect(connectedDuringActivation).toBe(true);
  await expect.poll(() => approvals).toBe(1);
  page.off('request', countApproval);
  await expect(page.getByRole('status').filter({ hasText: 'display code could not be approved' })).toBeVisible();
  await openProjectorOptions(page);
  await dismissProjectorReminder(page);
  await page.getByRole('button', { name: 'Start case' }).click();
  await expect(page.locator('.console-orientation h1')).toBeFocused();
  await context.close();
});

test('[AS-061] reload keeps only explicit manual notes; one failed automatic rejoin leaves the notes and a Rejoin press that restores the same room (card 38)', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await context.newPage();
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') void dialog.accept(); });
  try {
    await signedIn(page);
    const created = shell.waitForCreatedRoom();
    await (await openCase(page)).click();
    const room = await created;
    listRooms(room);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case' }).click();
    await openRoomSetup(page);
    await enterManualRoom(page);
    await expect(page.locator('.console-manual-tray')).toBeVisible();
    page.once('dialog', dialog => dialog.accept('Local only marker'));
    await page.getByRole('button', { name: 'Add spoken marker' }).click();
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
      .filter(key => key.startsWith('case-lab:segment:')).length)).toBe(1);
    // The one automatic re-mint of this load fails; it is never retried by itself.
    let mints = 0;
    await page.route(/\/api\/v1\/sessions\/[0-9a-f-]{36}\/facilitator-token$/, route => {
      mints++; return mints === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.continue();
    });
    await page.reload();
    const rejoin = page.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) });
    await expect(rejoin).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download saved manual notes' })).toBeVisible();
    await expect.poll(() => page.evaluate(async name => (await navigator.locks.query()).held.some(lock => lock.name === name), `room-owner:${room.sessionId}`)).toBe(false);
    await page.waitForTimeout(300);
    expect(mints).toBe(1);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => /facilitator.*token/.test(key)))).toEqual([]);
    const [download] = await Promise.all([page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download saved manual notes' }).click()]);
    const notes = Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');
    expect(notes).toContain('Manual session segment');
    expect(notes).toContain('Marker: Local only marker');
    expect(notes).not.toContain('Published case');
    await rejoin.click();
    await consoleReady(page);
    expect(mints).toBe(2);
    await openRoomSetup(page);
    await expect(page.locator('.console-manual-tray')).toBeVisible();
    await signOutFromVisibleUi(page); // runs under the refresh lock
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('case-lab:segment:')))).toEqual([]);
  } finally { unlistRooms(); await context.close(); }
});

test('[AS-080] PC approval admits one flight and cannot overwrite success with a second room', async ({ browser }) => {
  // Card 29 removed the library entry; the room-list approval remains on the phone's /P handoff.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  const pc = await context.newPage();
  const pending = deferred();
  const requests = [];
  try {
    const rooms = [];
    for (let index = 0; index < 2; index++) {
      const response = await fetch(apiUrl(worker.origin, 'sessions'), { method: 'POST',
        headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
      expect(response.status).toBe(201); rooms.push(await response.json());
    }
    worker.fake.replies.set('list_owned_active_sessions', rooms.map(room => ({
      session_id: room.sessionId, join_code: room.joinCode, expires_at: room.expiresAt,
    })));
    await pc.goto(`${shell.origin}/P`);
    const pcCode = pc.getByLabel('PC approval code');
    await expect(pcCode).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
    const code = (await pcCode.textContent()).replace(/\s/g, '');
    await page.goto(`${shell.origin}/P`);
    await page.getByRole('button', { name: 'Use a shared computer' }).click();
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill('123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Approve a PC', exact: true }).click();
    await page.getByLabel('PC code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Preview device' }).click();
    const choices = page.getByRole('button', { name: /^Approve room / });
    await expect(choices).toHaveCount(2);
    await page.route('**/api/v1/console-pairs/approve', async route => {
      requests.push(route.request().postDataJSON()); await pending.promise;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approved: true }) });
    });
    await choices.nth(0).click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(choices.nth(1)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Preview device' })).toBeDisabled();
    await choices.nth(1).evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await afterBrowserResponse(page); expect(requests).toHaveLength(1);
    pending.resolve();
    await expect(page.getByRole('status').filter({ hasText: 'PC approved.' })).toBeVisible();
    expect(requests).toHaveLength(1);
  } finally { pending.resolve(); unlistRooms(); await context.close(); }
});


test('[AS-061] live participant transport overrides a false browser offline hint and preserves real outage replay', async ({ browser }) => {
  const facContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 } });
  await phoneContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
  });
  const outage = await roomNetwork(phoneContext);
  const fac = await facContext.newPage();
  const phone = await phoneContext.newPage();
  const requests = [], responses = [], responseTasks = [], publicFrames = [], publicUrls = [];
  let welcomes = 0, snapshots = 0, primaryFailure;
  phone.on('request', request => {
    publicUrls.push(request.url());
    if (request.method() === 'POST' && /\/api\/v1\/sessions\/[^/]+\/commands$/.test(new URL(request.url()).pathname))
      requests.push(request.postDataJSON());
  });
  phone.on('response', response => {
    if (/\/api\/v1\/sessions\/[^/]+\/commands$/.test(new URL(response.url()).pathname))
      responseTasks.push(response.json().then(body => responses.push({ status: response.status(), body })));
  });
  phone.on('websocket', socket => {
    publicUrls.push(socket.url());
    socket.on('framereceived', frame => {
      publicFrames.push(String(frame.payload));
      const value = JSON.parse(String(frame.payload));
      if (value.t === 'welcome') welcomes++;
      if (value.t === 'snapshot') snapshots++;
    });
  });
  try {
    await signedIn(fac);
    const created = shell.waitForCreatedRoom();
    await (await openCase(fac)).click();
    const room = await created;
    const projector = await projectorPage(fac); // Present opened it in its own click (console layout v2)
    await expect(projector.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
    await expect(projector.locator('.names .arrival-note')).toHaveText('0 joined');
    await expect(projector.getByRole('heading', { name: 'Joining is closed', exact: true })).toHaveCount(0);
    await closeRoomSetup(fac);
    await openProjectorOptions(fac);
    await dismissProjectorReminder(fac);
    await phone.goto(joinUrl(room.joinCode, shell.origin));
    await phone.getByLabel('Your name').fill('Learner');
    await phone.getByRole('button', { name: 'Join case' }).click();
    await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
    await expect.poll(() => new URL(phone.url()).pathname).toBe(
      new URL(sessionUrl(room.sessionId, 'play', shell.origin)).pathname);
    expect(await phone.evaluate(() => navigator.onLine)).toBe(false);
    await expect.poll(() => welcomes > 0 && snapshots > 0).toBe(true);
    await fac.getByRole('button', { name: 'Start case' }).click();
    await openFirstDecisionWithContext(fac);
    await phone.getByRole('radio', { name: /S00175 workshop label. Record a s/ }).check();
    await expect(phone.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
    await expect(phone.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
    await expect.poll(() => responses.some(x => x.status === 200 &&
      x.body.receipt?.receipt === 'accepted')).toBe(true);
    expect(requests.length > 0).toBe(true);
    expect(responses.every(x => requests.some(r => r.clientEventId === x.body.receipt?.clientEventId))).toBe(true);
    const beforeOutage = await serverMirror(worker.origin, room);
    expect(Object.keys(beforeOutage.round.responses)).toHaveLength(1);
    const initialResponseId = Object.values(beforeOutage.round.responses)[0].id;
    const initialEventId = Object.values(beforeOutage.round.responses)[0].clientEventId;
    expect(requests.some(request => request.type === 'vote' && request.clientEventId === initialEventId)).toBe(true);

    await outage.offline(phone);
    await expect(phone.getByText('Connection lost · follow the room', { exact: true })).toBeVisible();
    const requestCount = requests.length, receiptCount = responses.length;
    await phone.getByRole('button', { name: 'Change decision', exact: true }).click();
    const savedChoice = phone.getByRole('radio', { name: /S00175 workshop label. Record a s/ });
    await expect(savedChoice).toBeChecked();
    await expect(savedChoice).toBeFocused();
    await expect(phone.getByText('Not sent yet · 1', { exact: true })).toHaveCount(0);
    expect(requests.length).toBe(requestCount);
    expect(responses.length).toBe(receiptCount);
    await phone.getByRole('radio', { name: /S00173 workshop label. Record az/ }).check();
    await expect(phone.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
    await expect(phone.getByText('Waiting for connection · your answer will send automatically', { exact: true })).toBeVisible();
    expect(requests.length).toBe(requestCount);
    expect(responses.length).toBe(receiptCount);
    const queued = await phone.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('case:phone-outbox', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('votes', 'readonly');
        const read = transaction.objectStore('votes').getAll();
        transaction.oncomplete = () => {
          db.close();
          const live = read.result.filter(row => !row.superseded);
          resolve({ count: live.length, id: live[0]?.envelope.clientEventId });
        };
        transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    }));
    expect(queued.count).toBe(1);
    expect(typeof queued.id === 'string' && queued.id.length > 0).toBe(true);
    expect(queued.id).not.toBe(initialEventId);
    await outage.online();
    await expect(phone.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
    await expect.poll(() => responses.slice(receiptCount).some(x => x.status === 200 &&
      x.body.receipt?.receipt === 'accepted' && x.body.receipt.clientEventId === queued.id)).toBe(true);
    expect(await phone.evaluate(() => navigator.onLine)).toBe(false);
    expect(requests.slice(requestCount).every(x => x.clientEventId === queued.id)).toBe(true);
    expect(requests.slice(requestCount).length > 0).toBe(true);
    await expect(phone.getByText('Not sent yet · 1', { exact: true })).toHaveCount(0);
    const afterOutage = await serverMirror(worker.origin, room);
    expect(Object.keys(afterOutage.round.responses)).toHaveLength(1);
    const restored = Object.values(afterOutage.round.responses)[0];
    expect(restored.id === initialResponseId && restored.clientEventId === queued.id).toBe(true);
    expect(restored.response.option_id === FIXTURE.decisions[0].interaction.options[0].id).toBe(true);
    const disclosed = [publicFrames.join('\n'), await phone.locator('body').innerText()].join('\n');
    for (const privatePart of ['"rationale"', '"caseDoc"', '"document_text"',
      FIXTURE.surfaces[0].notes.slice(0, 60), FIXTURE.decisions[0].paths[0].rationale.slice(0, 60),
      room.facilitatorToken, worker.jwt]) expect(disclosed).not.toContain(privatePart);
    expect(publicUrls.every(url => !url.includes(room.facilitatorToken) &&
      !url.includes(worker.jwt) && !url.includes('Learner'))).toBe(true);
  } catch (error) {
    primaryFailure = error;
  } finally {
    const settled = await Promise.allSettled(responseTasks);
    const closed = await Promise.allSettled([facContext.close(), phoneContext.close()]);
    const failures = [...settled, ...closed].filter(x => x.status === 'rejected').map(x => x.reason);
    if (primaryFailure && failures.length)
      throw new AggregateError([primaryFailure, ...failures], 'AS061 primary and cleanup failures', { cause: primaryFailure });
    if (primaryFailure) throw primaryFailure;
    if (failures.length) throw new AggregateError(failures, 'AS061 context cleanup failed');
  }
});

// Card 38 (CASE-175): the facilitator session persists on the device, a live room warns before leaving, and the
// console rejoins its room. Local Auth stub, local Worker and fake RPC only.
const leaveArmed = page => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

test('[card 38] the Leave site? warning is armed only while a room is live', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.type()); if (dialog.type() === 'beforeunload') void dialog.dismiss(); });
  try {
    await signedIn(page);
    expect(await leaveArmed(page)).toBe(false);
    await liveRoom(page, { signIn: false });
    expect(await leaveArmed(page)).toBe(true);
    // A real reload asks first; dismissing it keeps the room.
    await page.reload({ timeout: 2000 }).catch(() => {});
    expect(dialogs).toContain('beforeunload');
    await consoleReady(page);
    await endCase(page);
    await page.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click(); // card 40 slice 6: the ended summary comes first
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
    expect(await leaveArmed(page)).toBe(false);
  } finally { unlistRooms(); await context.close(); }
});

test('[card 38] Back then Forward, and a reload, reopen the same room at the same phase with no press', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload' || dialog.type() === 'confirm') void dialog.accept(); });
  try {
    await page.goto(`${shell.origin}/help`);
    const room = await liveRoom(page);
    await openProjectorOptions(page);
    await dismissProjectorReminder(page);
    await page.getByRole('button', { name: 'Start case' }).click();
    const phase = await page.locator('.console-phase').getAttribute('data-phase');
    expect(phase).not.toBe('lobby');
    // Back leaves the document (an in-app entry such as the case page comes first).
    // The active-console pop guard deliberately reloads an in-document destination. Observe native
    // history and its visible result, rather than treating that replacement as a failed goBack RPC.
    const traverse = async direction => {
      const changed = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
      await page.evaluate(value => history[value](), direction); await changed;
      if (!/\/help$/.test(page.url())) await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', phase);
    };
    for (let step = 0; step < 4 && !/\/help$/.test(page.url()); step++) await traverse('back');
    await expect(page).toHaveURL(/\/help$/);
    await traverse('forward');
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', phase);
    expect(await page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBe(room.sessionId);
    await page.reload();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', phase);
    await expect(page.getByLabel('Email')).toBeHidden();
  } finally { unlistRooms(); await context.close(); }
});

test('[card 38] after a fresh sign-in one Rejoin room press reopens the room; two rooms are listed and neither opens', async ({ browser }) => {
  const first = await browser.newContext({ ignoreHTTPSErrors: true });
  let fresh, restored, two;
  try {
    const room = await liveRoom(await first.newPage());
    const state = await first.storageState();
    await first.close();
    // A browser restart: the same storage, no tab marker. Signed in, and the room is offered, not opened.
    restored = await browser.newContext({ ignoreHTTPSErrors: true, storageState: state });
    const back = await restored.newPage(); await back.goto(casesUrl(shell.origin));
    await expect(back.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) })).toBeVisible();
    await expect(back.locator('.console-room .console-primary')).toHaveCount(0);
    await restored.close();
    // A fresh sign-in on another browser.
    fresh = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await fresh.newPage();
    await signedIn(page);
    const rejoin = page.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) });
    await expect(rejoin).toHaveCount(1);
    await expect(page.locator('.console-room .console-primary')).toHaveCount(0);
    await rejoin.click();
    await consoleReady(page);
    await fresh.close();
    // Two running rooms: both listed, neither opens by itself.
    const response = await fetch(apiUrl(worker.origin, 'sessions'), { method: 'POST',
      headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
    expect(response.status).toBe(201);
    const other = await response.json();
    listRooms(room, other);
    two = await browser.newContext({ ignoreHTTPSErrors: true });
    const both = await two.newPage();
    await signedIn(both);
    await expect(both.getByRole('button', { name: /^Rejoin session · / })).toHaveCount(2);
    await both.waitForTimeout(300);
    await expect(both.locator('.console-room .console-primary')).toHaveCount(0);
  } finally { unlistRooms(); await two?.close(); await fresh?.close(); await restored?.close(); await first.close(); }
});

test('[card 38] across a full room flow, a reload and the end, the case pack never enters web storage', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') void dialog.accept(); });
  // Every authored string of the case document long enough to be distinctive.
  const texts = [];
  (function collect(value) {
    if (typeof value === 'string') { if (value.length >= 16) texts.push(value); }
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
  })(FIXTURE);
  expect(texts.length).toBeGreaterThan(20);
  const audit = async () => {
    const values = await page.evaluate(() => [sessionStorage, localStorage].flatMap(store =>
      Object.keys(store).map(key => `${key}=${store.getItem(key)}`)));
    expect(values.filter(entry => texts.some(text => entry.includes(text)))).toEqual([]);
    expect(await caseStorageFootprint(page)).toEqual({ privateKeys: [], privateValues: false,
      cachedApi: [], privateDatabases: [] });
  };
  try {
    const { room } = await lockedRoomWithOneVote(page);
    listRooms(room);
    await audit();
    await page.reload();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    await audit();
    await endCase(page);
    await page.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click(); // card 40 slice 6: the ended summary comes first
    await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
    await audit();
  } finally { unlistRooms(); await context.close(); }
});

test('[card 38] a tab opened from the console copies the room marker but offers Rejoin room instead of joining by itself', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    const room = await liveRoom(page);
    // window.open without noopener copies sessionStorage, including this tab's room marker.
    const [copy] = await Promise.all([context.waitForEvent('page'),
      page.evaluate(url => { window.open(url, '_blank'); }, casesUrl(shell.origin))]);
    await copy.waitForLoadState();
    expect(await copy.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBe(room.sessionId);
    await expect(copy.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) })).toBeVisible();
    await copy.waitForTimeout(300);
    await expect(copy.locator('.console-room .console-primary')).toHaveCount(0);
  } finally { unlistRooms(); await context.close(); }
});

test('[card 38] a duplicated tab (history restored as back_forward) offers Rejoin room while the original tab owns the room', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    const room = await liveRoom(page);
    // Chrome's Duplicate tab copies sessionStorage and restores history, so the copy reports back_forward.
    const copy = await context.newPage();
    await copy.addInitScript(id => {
      sessionStorage.setItem('case:console:active-room', id);
      const original = performance.getEntriesByType.bind(performance);
      performance.getEntriesByType = type => type === 'navigation' ? [{ type: 'back_forward' }] : original(type);
    }, room.sessionId);
    await copy.goto(casesUrl(shell.origin));
    await expect(copy.getByRole('button', { name: new RegExp(`^Rejoin session · ${room.joinCode} · until `) })).toBeVisible();
    await copy.waitForTimeout(300);
    await expect(copy.locator('.console-room .console-primary')).toHaveCount(0);
    // The original tab still owns its room.
    await consoleReady(page);
  } finally { unlistRooms(); await context.close(); }
});


// Sign out is a deliberate confirmed action in the shared menu on every route.
async function signOutFromVisibleUi(page) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
}

// Route cards are page-local until one explicit atomic Reveal. Observe real requests and authority.
async function chooseLocalRoute(page, room, route = page.locator('.console-routes').getByRole('radio', { disabled: false }).first()) {
  // Snapshot only after the preceding Lock is confirmed, never while its request is pending.
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
  const before = await serverMirror(worker.origin, room), commands = [];
  expect(before.phase).toBe('responses_locked');
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

// Console layout v2: the projector's other-screen and screen-check controls live in the Use another screen card.
async function openProjectorOptions(page) {
  if (await page.locator('#console-setup .console-pairing').isVisible().catch(() => false)) return;
  await openPairing(page);
}


test('[audit] held projector approval prevents repeated keyboard sends and preserves input and focus on refusal', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const release = deferred(); let attempts = 0;
  try {
    await startedRoom(page); await openProjectorOptions(page);
    const input = page.getByLabel('Display pairing code'); await input.fill('7K3Q X9A2');
    await page.route('**/display-pairs/approve', async route => { attempts++; await release.promise; await route.fulfill({ status: 404, json: { error: 'unknown_pair' } }); });
    const approve = page.getByRole('button', { name: 'Connect projector', exact: true });
    await approve.focus(); await page.keyboard.press('Enter');
    await expect(approve).toHaveAttribute('aria-busy', 'true');
    await expect(approve).toBeFocused(); await page.keyboard.press('Enter');
    await input.focus(); release.resolve();
    await expect(page.getByRole('status').filter({ hasText: 'That display code could not be approved.' })).toBeVisible();
    expect(attempts).toBe(1); await expect(input).toHaveValue('7K3Q X9A2'); await expect(input).toBeFocused();
    await approve.focus(); await expect(approve).not.toHaveAttribute('aria-busy', 'true');
    await projectorRun(page);
    await expect(page.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
  } finally { release.resolve(); await context.close(); }
});

test('[audit] a blocked Start-room projector leaves Open projector in the rail; its fallback link appears beside it and a late handshake clears it', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // Pop-ups blocked: Start room's own window and Open projector both get null (console layout v2).
  await context.addInitScript(() => { window.open = () => null; });
  const page = await context.newPage();
  try {
    const created = shell.waitForCreatedRoom(); await startedRoom(page); const room = await created;
    const card = page.locator('.console-rail .console-projector');
    await expect(card.locator('.tag')).toHaveText('Not open');
    await expect(card).toHaveClass(/is-off/);
    await page.clock.install(); // The deliberate 3s popup timer need not consume real fixture time.
    const opener = card.getByRole('button', { name: 'Open projector', exact: true });
    await opener.click(); await page.clock.fastForward(3001);
    await expect(card.getByRole('link', { name: 'Open projector manually' })).toBeVisible();
    await expect(opener).toBeFocused();
    await expect(page.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
    await page.evaluate(sessionId => { const channel = new BroadcastChannel('case-room-local'); channel.postMessage({ t: 'projector_hello', sessionId }); channel.close(); }, room.sessionId);
    await expect(card.getByRole('link', { name: 'Open projector manually' })).toHaveCount(0);
    await expect(card.locator('.tag')).toHaveText(/^(Connected|One screen)$/);
    await expect(page.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
  } finally { await context.close(); }
});


test('[audit] keyboard command timeout reports uncertainty in the dock and respects a later focus move', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(); const release = deferred(); let attempts = 0;
  try {
    await startedRoom(page);
    await page.getByRole('button', { name: 'Start case', exact: true }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    await page.route(/\/commands$/, async route => {
      attempts++; const command = route.request().postDataJSON(); await release.promise;
      await route.fulfill({ json: { receipt: { v: 1, t: 'receipt', clientEventId: command.clientEventId,
        epoch: command.epoch, revision: command.expectRevision, receipt: 'timeout' } } });
    });
    const primary = page.locator('.console-primary'); await primary.focus(); await page.keyboard.press('Enter');
    await expect(primary).toHaveAttribute('aria-busy', 'true'); await expect(primary).toBeFocused();
    await page.keyboard.press('Enter');
    const roomTab = page.locator('.console-rail [data-focus-key="room-setup"]'); await roomTab.focus();
    const recovered = page.waitForResponse(response => response.url().endsWith('/snapshot'));
    release.resolve(); await (await recovered).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.locator('.console-action-dock [role="status"]')).toHaveText('No confirmation from the session. Check the case before continuing.');
    await expect(roomTab).toBeFocused(); expect(attempts).toBe(1);
    await expect(primary).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
  } finally { release.resolve(); await context.close(); }
});


test('[audit] a late projector approval cannot restore room controls after sign-out', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(); const release = deferred(), requested = deferred(), replied = deferred();
  try {
    await startedRoom(page); await openProjectorOptions(page);
    await page.getByLabel('Display pairing code').fill('7K3Q X9A2');
    await page.route('**/display-pairs/approve', async route => { requested.resolve(); await release.promise; await route.fulfill({ json: { ok: true } }); replied.resolve(); });
    await page.getByRole('button', { name: 'Connect projector', exact: true }).click();
    await requested.promise; await signOutFromVisibleUi(page);
    // Sign-out aborts the request: a browser response event need not arrive. Await the released reply itself.
    release.resolve(); await replied.promise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.getByRole('button', { name: 'Email me a sign-in code', exact: true })).toBeVisible();
    await expect(page.locator('.console-room')).toHaveCount(0);
    await expect(page.getByText('Projector connected.', { exact: true })).toHaveCount(0);
  } finally { release.resolve(); await context.close(); }
});

// Audit AUD-06: releasing the console must release its real browser lock while the page remains open.
test('[AS-110] room ownership ends on room end and Sign out without closing the page', async ({ browser }) => {
  for (const exit of ['end', 'sign_out']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      const room = await liveRoom(page);
      const held = () => page.evaluate(async name => (await navigator.locks.query()).held.some(lock => lock.name === name), `room-owner:${room.sessionId}`);
      await expect.poll(held).toBe(true);
      if (exit === 'end') {
        await endCase(page);
        await page.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click(); // card 40 slice 6: the ended summary comes first
        await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
      } else {
        await signOutFromVisibleUi(page);
        await expect(page.getByLabel('Email')).toBeVisible();
      }
      await expect.poll(held).toBe(false);
      expect(page.isClosed()).toBe(false);
      // The released lock is really obtainable from another live page in the same origin.
      const other = await context.newPage();
      await other.goto(`${shell.origin}/help`);
      expect(await other.evaluate(name => navigator.locks.request(name, { ifAvailable: true }, lock => Boolean(lock)), `room-owner:${room.sessionId}`)).toBe(true);
    } finally { unlistRooms(); await context.close(); }
  }
});


test('[AS-111] sign-out clears immediately and a deliberate sign-in survives a queued cleanup fence', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await signedIn(page);
    const blocker = await context.newPage();
    await blocker.goto(shell.origin);
    await blocker.evaluate(() => new Promise(ready => {
      void navigator.locks.request('case:auth:refresh', () => new Promise(release => {
        window.releaseAuditLock = release; ready();
      }));
    }));
    const cleanupGeneration = await page.evaluate(key => Number(localStorage.getItem(key)), STORAGE_FENCE_KEY);
    expect(Number.isSafeInteger(cleanupGeneration) && cleanupGeneration > 0).toBe(true);
    // Hold real cleanup independently of the refresh lock. Shell caches are intentionally preserved.
    // Sample the browser wall time once; reserve the existing test budget as installation headroom.
    // Pause at that genuine timestamp, so setup does not advance beyond the real present.
    const clockTime = await page.evaluate(() => Date.now());
    await page.clock.install({ time: clockTime - 60_000 });
    await page.clock.pauseAt(clockTime);
    await page.evaluate(async () => {
      const name = 'case-auth-cleanup-audit';
      await caches.open(name);
      const remove = caches.delete.bind(caches);
      window.auditCleanupDone = false;
      caches.delete = cacheName => cacheName !== name ? remove(cacheName) : new Promise(resolve => {
        window.releaseAuditCleanup = async () => {
          const result = await remove(cacheName);
          window.auditCleanupDone = true; resolve(result);
        };
      });
    });
    await signOutFromVisibleUi(page);
    await expect(page.getByLabel('Email')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
    // The secure callback advances generation and clears storage synchronously; wait past that turn.
    await expect.poll(() => page.evaluate(key => Number(localStorage.getItem(key)), STORAGE_FENCE_KEY)).toBe(cleanupGeneration + 1);
    await expect.poll(() => page.evaluate(() => typeof window.releaseAuditCleanup)).toBe('function');
    // Model a rotation already past its comparison, while the real browser lock is held.
    await blocker.evaluate(() => localStorage.setItem('case:auth:refresh', 'late-rotation'));
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeEnabled();
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill('123456');
    const verified = page.waitForResponse(response => response.url().includes('/auth/v1/verify'));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await verified;
    await page.clock.runFor(34);
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('late-rotation');
    await blocker.evaluate(() => window.releaseAuditLock());
    await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
    expect(await page.evaluate(() => window.auditCleanupDone)).toBe(false);
    await page.evaluate(() => window.releaseAuditCleanup());
    await page.clock.runFor(34);
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Menu', exact: true }).locator('.site-account-email')).toHaveText('owner@example.invalid');
    await page.getByRole('button', { name: 'Close menu', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
    expect(await page.evaluate(() => window.auditCleanupDone)).toBe(true);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

// Console layout v2: the Projector card is always in the rail; Room setup holds the rest.
async function projectorRoom(page) {
  await consoleReady(page);
  await expect(page.locator('.console-rail .console-projector')).toBeVisible();
}
async function projectorRun(page) {
  const cancel = page.locator('#console-setup .console-pairing [data-focus-key="pairing-cancel"]');
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  await closeRoomSetup(page);
}
async function dismissProjectorReminder(page) {
  await page.locator('#console-setup .console-pairing').getByRole('button', { name: 'Dismiss display reminder', exact: true }).click();
  await projectorRun(page);
}
