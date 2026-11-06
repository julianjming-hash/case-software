// Actual local-Worker room, native gesture AudioContext and browser ESM failure/cache semantics.
import { test, expect } from '@playwright/test';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { consoleReady } from '../tests/helpers/console-v2.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let auth, worker, shell;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin }); auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } }); auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });
async function room(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', reducedMotion: 'no-preference', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { if (!localStorage.getItem('case:auth:refresh')) localStorage.setItem('case:auth:refresh', 'local-refresh-only'); });
  const page = await context.newPage(), wavs = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.wav')) wavs.push('wav'); });
  await page.goto(casesUrl(shell.origin)); await (await openCase(page)).click();
  await consoleReady(page);
  return { context, page, wavs };
}
async function menu(page) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Menu', exact: true }); await expect(panel).toBeVisible(); return panel;
}

test('native enable held at import is cancelled by the actual device-settings mute control', async ({ browser }) => {
  const f = await room(browser), requested = deferred(), release = deferred();
  await f.page.route(url => /^\/assets\/console-tones\.[a-f0-9]{64}\.mjs$/.test(url.pathname), async route => {
    requested.resolve(); await release.promise; await route.continue();
  });
  try {
    expect(f.wavs).toEqual([]);
    await (await menu(f.page)).getByRole('button', { name: 'Enable console sounds', exact: true }).click();
    await requested.promise;
    const panel = await menu(f.page);
    await expect(panel.getByRole('button', { name: 'Cancel enabling console sounds', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByRole('switch', { name: 'Interface sounds', exact: true }).uncheck();
    const response = f.page.waitForResponse(value => /^\/assets\/console-tones\.[a-f0-9]{64}\.mjs$/.test(new URL(value.url()).pathname));
    release.resolve(); await response;
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(panel.getByRole('button', { name: 'Enable console sounds', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Disable console sounds', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('switch', { name: 'Interface sounds', exact: true })).not.toBeChecked();
    expect(await f.page.evaluate(() => localStorage.getItem('case:preferences:ui-tones'))).toBe('false');
    await panel.getByRole('button', { name: 'Close menu', exact: true }).click();
    await f.page.locator('.console-rail [data-focus-key="use-another-screen"]').click(); expect(f.wavs).toEqual([]);
  } finally { release.resolve(); await f.context.close(); }
});

test('cached tone-module failure exposes an honest Reload page action and reloads the actual document', async ({ browser }) => {
  const f = await room(browser); let moduleRequests = 0;
  await f.page.route(url => /^\/assets\/console-tones\.[a-f0-9]{64}\.mjs$/.test(url.pathname), route => { moduleRequests++; return route.abort('failed'); });
  try {
    await (await menu(f.page)).getByRole('button', { name: 'Enable console sounds', exact: true }).click();
    await expect(f.page.getByText('Console sound module could not load. Reload the page to try again.', { exact: true })).toBeVisible();
    const panel = await menu(f.page);
    await expect(panel.getByRole('button', { name: 'Reload page for console sounds', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Enable console sounds', exact: true })).toHaveCount(0);
    expect(moduleRequests).toBe(1); expect(f.wavs).toEqual([]);
    const reloaded = f.page.waitForEvent('domcontentloaded');
    f.page.once('dialog', async dialog => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); });
    await panel.getByRole('button', { name: 'Reload page for console sounds', exact: true }).click(); await reloaded;
    await expect(f.page.getByRole('heading', { name: 'Published case', exact: true })).toBeVisible();
    expect(moduleRequests).toBe(1); expect(f.wavs).toEqual([]);
  } finally { await f.context.close(); }
});
