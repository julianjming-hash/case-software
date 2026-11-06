// A4: coherent local Auth + actual Worker authority; held responses expose fresh-visit races.
import { test, expect } from '@playwright/test';
import { startStartupMemberFixture } from '../tests/helpers/startup-member-fixture.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { apiUrl, casesUrl } from '../src/shared/urls.mjs';
import { consoleReady } from '../tests/helpers/console-v2.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let fixture, roomShell;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  fixture = await startStartupMemberFixture(process.cwd(), { latencyMs: 0, bytesPerSecond: 100_000_000 });
  // Measurement relay shapes HTTP only. Room interaction uses the existing local WebSocket proxy.
  roomShell = await startServedAuthShell({ apiOrigin: fixture.worker.origin, buildAuthBindings: { SUPABASE_URL: fixture.auth.origin, SUPABASE_JWT_ISSUER: `${fixture.auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${fixture.auth.origin}/auth/v1/.well-known/jwks.json` } });
  fixture.origin = roomShell.origin; fixture.auth.setAppOrigin(roomShell.origin);
});
test.afterAll(async () => { await roomShell?.stop(); await fixture?.stop(); });
async function runningRoom() {
  const response = await fetch(apiUrl(fixture.worker.origin, ['sessions']), { method: 'POST', headers: {
    authorization: `Bearer ${fixture.worker.jwt}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ workspaceId: fixture.worker.workspaceId, caseVersionId: fixture.worker.versionId, ttlMinutes: 60 }) });
  expect(response.status).toBe(201);
  const room = await response.json();
  fixture.worker.fake.replies.set('list_owned_active_sessions', [{ session_id: room.sessionId, join_code: room.joinCode, expires_at: room.expiresAt }]);
  return room;
}
async function fresh(browser, marker = null) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(marker => {
    if (!localStorage.getItem('case:auth:refresh')) localStorage.setItem('case:auth:refresh', 'local-refresh-only');
    if (marker) sessionStorage.setItem('case:console:active-room', marker);
  }, marker);
  const page = await context.newPage(), requested = deferred(), release = deferred();
  await page.route(url => url.pathname === '/api/v1/me/rooms', async route => {
    const response = await route.fetch(); requested.resolve(); await release.promise; await route.fulfill({ response });
  });
  const mintRequests = [];
  page.on('request', request => { if (/\/facilitator-token$/.test(new URL(request.url()).pathname)) mintRequests.push(request.method()); });
  return { context, page, requested, release, mintRequests };
}
async function publishedStart(page) {
  await page.getByRole('button', { name: 'Search cases', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search cases' }).fill('Published case');
  return openCase(page);
}
async function afterResponse(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function privacy(page) {
  return page.evaluate(async () => {
    const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
    const credential = keys.some(key => /"(?:facilitatorToken|casePack|document_text|access_token)"/.test(localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? ''));
    let privateCache = false;
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) privateCache ||= /^\/(?:api|sessions)(?:\/|$)/.test(new URL(request.url).pathname);
    return { credential, privateCache };
  });
}

test('fresh verified catalogue is useful while owned rooms are held; the eventual offer never claims automatically', async ({ browser }) => {
  const old = await runningRoom(), f = await fresh(browser);
  try {
    await f.page.goto(casesUrl(fixture.origin)); await f.requested.promise;
    await expect(f.page.getByRole('link', { name: 'Local case 01', exact: true })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Search cases', exact: true })).toBeEnabled();
    await f.page.getByRole('button', { name: 'Search cases', exact: true }).click();
    await expect(f.page.getByRole('searchbox', { name: 'Search cases' })).toBeEnabled();
    expect(f.mintRequests).toEqual([]);
    const response = f.page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/me/rooms');
    f.release.resolve(); await response;
    await expect(f.page.getByRole('button', { name: new RegExp(`^Rejoin session · ${old.joinCode}`) })).toBeVisible();
    expect(f.mintRequests).toEqual([]);
    expect(await f.page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBeNull();
    expect(await privacy(f.page)).toEqual({ credential: false, privateCache: false });
  } finally { f.release.resolve(); await f.context.close(); }
});

test('Start fences late owned-room UI and mint while a real new-room creation response is held', async ({ browser }) => {
  const old = await runningRoom(), f = await fresh(browser), creating = deferred(), created = deferred(), releaseCreation = deferred();
  await f.page.route(url => url.pathname === '/api/v1/sessions', async route => {
    const response = await route.fetch(); expect(response.status()).toBe(201);
    created.resolve(await response.json()); creating.resolve(); await releaseCreation.promise; await route.fulfill({ response });
  });
  try {
    await f.page.goto(casesUrl(fixture.origin)); await f.requested.promise;
    await (await publishedStart(f.page)).click(); await creating.promise;
    const response = f.page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/me/rooms');
    f.release.resolve(); await response; await afterResponse(f.page);
    await expect(f.page.locator('.console-rejoin')).toHaveCount(0);
    expect(f.mintRequests).toEqual([]);
    expect(await f.page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBeNull();
    const room = await created.promise; expect(room.sessionId).not.toBe(old.sessionId);
    releaseCreation.resolve(); await consoleReady(f.page);
    expect(await f.page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBe(room.sessionId);
    expect(f.mintRequests).toEqual([]);
    expect(await privacy(f.page)).toEqual({ credential: false, privateCache: false });
  } finally { f.release.resolve(); releaseCreation.resolve(); await f.context.close(); }
});

for (const status of [400,503]) test(`deliberate Start ${status===400?'refusal stays retryable':'uncertainty blocks duplicate creation'} without reviving the late owner offer`, async ({ browser }) => {
  await runningRoom(); const f = await fresh(browser), creationSeen = deferred(), failCreation = deferred(); let creationRequests=0;
  await f.page.route(url => url.pathname === '/api/v1/sessions', async route => {
    creationRequests++;creationSeen.resolve(); await failCreation.promise; await route.fulfill({ status, json: { error: 'temporarily_unavailable' } });
  }, { times: 1 });
  try {
    await f.page.goto(casesUrl(fixture.origin)); await f.requested.promise;
    const confirmation = await publishedStart(f.page); await confirmation.click(); await creationSeen.promise;const start=f.page.locator('.case-present').getByRole('button',{name:'Present',exact:true});
    failCreation.resolve(); await expect(f.page.getByText(status===400?'The session was not created. Try again.':'Session setup could not be confirmed. Check active sessions before trying again.', { exact: true })).toBeVisible();
    if(status===400)await expect(start).toBeEnabled();else await expect(start).toBeDisabled();
    const response = f.page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/me/rooms');
    f.release.resolve(); await response; await afterResponse(f.page);
    await expect(f.page.locator('.console-rejoin')).toHaveCount(0); expect(f.mintRequests).toEqual([]);
    if(status===400){await start.click();await f.page.getByRole('dialog',{name:'Present case',exact:true}).getByRole('button',{name:'Present',exact:true}).click();await consoleReady(f.page);}else{await expect(start).toBeDisabled();expect(creationRequests).toBe(1);await expect(f.page.getByRole('status').filter({hasText:'Preparing session…'})).toHaveCount(0);const recovery=f.page.getByRole('link',{name:'Check active sessions',exact:true});await expect(recovery).toHaveAttribute('href',casesUrl(fixture.origin));const checked=f.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/me/rooms');await recovery.click();await checked;await expect(f.page.locator('.console-rejoin').getByRole('button',{name:/Rejoin session/})).toBeVisible();expect(f.mintRequests).toEqual([]);expect(creationRequests).toBe(1);}
    expect(await privacy(f.page)).toEqual({ credential: false, privateCache: false });
  } finally { f.release.resolve(); failCreation.resolve(); await f.context.close(); }
});

test('same-tab marker preserves serial owner recovery and exactly one automatic re-mint', async ({ browser }) => {
  const room = await runningRoom(), f = await fresh(browser, room.sessionId);
  try {
    await f.page.goto(casesUrl(fixture.origin)); await f.requested.promise;
    await expect(f.page.locator('.library')).toHaveCount(0); expect(f.mintRequests).toEqual([]);
    f.release.resolve(); await consoleReady(f.page);
    expect(f.mintRequests).toEqual(['POST']);
    expect(await f.page.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBe(room.sessionId);
    await expect(f.page.locator('.library')).toHaveCount(0);
    expect(await privacy(f.page)).toEqual({ credential: false, privateCache: false });
  } finally { f.release.resolve(); await f.context.close(); }
});
