// Card 29 (CASE-166): the participant-first root, the menu and Appearance, the case catalogue and case
// detail, and the Room tab's shared-computer entry. Built shell, real local Worker/rooms, fake PostgREST
// and a throwaway HTTPS Auth stub only; no metered backend is reached.
import { fillSearch } from '../tests/helpers/collapsed-search.mjs';
import { test, expect } from '@playwright/test';
import { chooseOption } from '../tests/helpers/choose-option.mjs';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { mkdirSync } from 'node:fs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { startLocalWorker } from '../tests/helpers/local-worker.mjs';
import { casesUrl, caseVersionUrl, homeUrl, joinUrl, turnstileWidgetScriptUrl } from '../src/shared/urls.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { divingArt } from '../tests/helpers/diving-art.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { FIXTURE } from '../tests/helpers/local-worker.mjs';
import { consoleReady, openRoomSetup } from '../tests/helpers/console-v2.mjs';

const SHOTS = process.env.CASE_C29_SHOTS || null; // screenshots for the PR, outside the repo when set
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); } };
const art = withSolution(describeCase(FIXTURE), { attempt: 0, summarised: false });
const AUDIENCES = ['Junior doctors', 'Nurses', 'Paramedics'];
// 30 published versions: varied length, audience and summary, some without art or fields ("not set").
const CATALOGUE = Array.from({ length: 30 }, (_, i) => ({
  version_id: uuidv7(), case_id: uuidv7(), version_no: 1 + (i % 3), edition: i === 1,
  title: `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? 'z' : ''} case ${String(i + 1).padStart(2, '0')}`,
  summary: i % 5 === 0 ? null : `Summary of case ${i + 1}${i === 7 ? ' with sepsis' : ''}.`,
  audience: i % 4 === 0 ? null : AUDIENCES[i % 3], setting: i % 6 === 0 ? null : 'Emergency department',
  duration_min: i % 7 === 0 ? null : [15, 45][i % 2], learning_objectives: i === 1 ? ['Recognise shock', 'Treat early'] : [],
  published_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), art: i % 3 === 2 ? null : art,
}));

// An older published version of case 2 (Julian, 2026-10-06: one card per case, older versions on detail).
const OLDER = { ...CATALOGUE[1], edition: false, version_id: uuidv7(), version_no: 1, summary: 'Older version summary.',
  published_at: new Date(Date.UTC(2026, 8, 1)).toISOString() };
let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin, catalogue: [...CATALOGUE, OLDER] });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: { SUPABASE_URL: auth.origin,
    SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

async function signIn(page, origin = shell.origin) {
  await page.goto(casesUrl(origin));
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Present', exact: true })).toBeVisible();
}
const axe = async (page, label) => {
  await settled(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => `${label}: ${v.id} ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
};

test('[AS-102] the root is room-code entry signed out and with a kept sign-in, and never touches the account or a saved place', async ({ browser }) => {
  for (const kept of [false, true]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const stored = { 'case:participant:main:token': JSON.stringify({ sessionId: uuidv7(), token: 'opaque' }),
      ...(kept ? { 'case:auth:refresh': 'kept-refresh-token' } : {}) };
    await context.addInitScript(entries => { if (!sessionStorage.getItem('seeded')) { for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, stored);
    const page = await context.newPage();
    const requests = [];
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/') || url.origin === auth.origin) requests.push(url.pathname); });
    const before = auth.requests.length;
    await page.goto(homeUrl(shell.origin));
    await expect(page.getByRole('heading', { level: 1, name: 'Join the Case' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Session code' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(requests.filter(path => path !== '/api/v1/config')).toEqual([]);
    expect(auth.requests.length).toBe(before);
    const after = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('case:')).map(k => [k, localStorage.getItem(k)])));
    expect(after).toEqual(stored);
    // The menu on the root never shows account state, even when a sign-in is kept on this device.
    await page.getByRole('button', { name: 'Open menu' }).click();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    if(kept)await expect(menu.getByRole('status')).toContainText('unavailable');else await expect(menu.getByRole('link', { name: 'Sign in',exact:true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: /^Admin(?: Opens a new tab)?$/ })).toHaveCount(0);
    if (!kept) await shot(page, 'menu-signed-out-light');
    await context.close();
  }
});

test('[AS-102] code entry: paste with spaces and hyphens, aliases, caret editing, a spoken name, Enter only when valid, never auto-submit', async ({ page }) => {
  await page.goto(homeUrl(shell.origin));
  const input = page.getByRole('textbox', { name: 'Session code' });
  await expect(page.locator('#roomCodeHint')).toHaveCount(0); // the hint was deleted (card 36a); the boxes show the length
  // Six valid characters typed: nothing is submitted.
  await input.pressSequentially('A7K2M9');
  await page.waitForTimeout(400);
  expect(new URL(page.url()).pathname).toBe('/');
  // Caret editing: the value is masked to the code's characters and the caret stays where the person put it.
  await input.fill('A7K2M');
  await input.press('Home'); await input.press('ArrowRight'); await input.type('x');
  await expect(input).toHaveValue('AX7K2M');
  // Enter with an invalid code shows the error in the field's slot and stays.
  await input.fill('A7K');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Enter the six-character session code shown on the projector.');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(new URL(page.url()).pathname).toBe('/');
  await shot(page, 'root-code-error-light');
  // Paste with spaces, hyphens and the O→0, I/L→1 aliases; Enter submits the normalised code to the join document.
  await input.fill(' a7k-2m9 ');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.press('Enter');
  await expect(page).toHaveURL(joinUrl('A7K2M9', shell.origin));
  await expect(page.getByLabel('Your name')).toBeVisible();
  await expect(page.getByLabel('Session code', { exact: true })).toHaveValue('A7K2M9');
  await page.goto(homeUrl(shell.origin));
  await page.getByRole('textbox', { name: 'Session code' }).fill('olk il0');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(joinUrl('01K110', shell.origin));
});

test('[36a] facilitator sign-in: mosaic splash, one short line, one primary action and a quiet alternative', async ({ browser }) => {
  for (const t of ['light', 'dark']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: t, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(casesUrl(shell.origin));
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await expect(page.locator('.auth-art')).toHaveAttribute('data-art', 'brand');
      await expect.poll(() => page.locator('.auth-art svg polygon').count()).toBeGreaterThan(20);
      await shot(page, `signin-${t}`);
      await expect(page.getByText('Sign in to run and manage cases.', { exact: true })).toHaveCount(1);
      const text = await page.locator('main').innerText();
      expect(text).not.toContain('Sign in to see published cases.');
      expect(text).not.toContain('Sign in to continue.');
      const primary = page.getByRole('button', { name: 'Email me a sign-in code', exact: true });
      const quiet = page.getByRole('button', { name: 'Or email me a link instead', exact: true });
      await expect(primary).toBeVisible();
      await expect(quiet).toBeVisible();
      await expect(primary).toHaveClass(/primary/);
      await expect(quiet).toHaveClass(/tertiary/);
      await expect(page.getByRole('button', { name: /^Send code$|^Email sign-in link$/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await axe(page, `sign-in ${t}`);
    } finally { await context.close(); }
  }
});

test('[AS-102] Turnstile stays on the join documents: the root policy never admits it and the handoff is a document navigation', async ({ browser }) => {
  const local = await startLocalWorker();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const challenge = [];
    page.on('request', request => { if (request.url().startsWith(new URL(turnstileWidgetScriptUrl()).origin)) challenge.push(request.url()); });
    const root = await page.goto(homeUrl(local.origin));
    expect(root.headers()['content-security-policy']).not.toContain('challenges.cloudflare.com');
    expect(root.headers()['content-security-policy']).not.toContain('case-turnstile');
    await page.getByRole('textbox', { name: 'Session code' }).fill('A7K2M9');
    const [join] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/J/A7K2M9'),
      page.getByRole('button', { name: 'Continue' }).click()]);
    expect(join.request().isNavigationRequest()).toBe(true);
    expect(join.headers()['content-security-policy']).toContain('challenges.cloudflare.com');
    expect(challenge).toEqual([]);
  } finally { await context.close(); await local.stop(); }
});

test('[AS-103] Appearance applies before first paint, Auto follows the OS live, and the projector follows its own device', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(homeUrl(shell.origin));
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('case:appearance'))).toBe('dark');
  // First paint with the app module held back: only the pre-paint script and the stylesheets have run. A
  // fresh context without a service worker (so the route sees the module), holding the stored choice.
  const cold = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: 'light', serviceWorkers: 'block' });
  await cold.addInitScript(() => localStorage.setItem('case:appearance', 'dark'));
  const coldPage = await cold.newPage();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let heldRequests = 0;
  await coldPage.route(/\/assets\/app\.[0-9a-f]+\.mjs$/, async route => { heldRequests++; await held; await route.continue(); });
  await coldPage.goto(homeUrl(shell.origin), { waitUntil: 'commit' });
  await coldPage.waitForFunction(() => document.body && document.querySelector('main'));
  await expect.poll(() => heldRequests).toBe(1);
  const firstPaint = await coldPage.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'),
    background: getComputedStyle(document.body).backgroundColor, appRan: Boolean(document.querySelector('.home-panel')) }));
  expect(firstPaint).toEqual({ theme: 'dark', background: 'rgb(18, 24, 27)', appRan: false });
  if (SHOTS) await coldPage.screenshot({ path: `${SHOTS}/first-paint-dark-no-flash.png` });
  release();
  await expect(coldPage.getByRole('heading', { name: 'Join the Case' })).toBeVisible();
  await cold.close();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Join the Case' })).toBeVisible();
  await shot(page, 'root-desktop-dark');
  // A projector document ignores the stored choice.
  const projector = await context.newPage();
  await projector.goto(`${shell.origin}/D/ABCD2345`, { waitUntil: 'domcontentloaded' });
  expect(await projector.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
  await projector.close();
  // Auto: no attribute, and the page follows prefers-color-scheme as it changes.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Auto' }).check();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => [document.documentElement.hasAttribute('data-theme'), localStorage.getItem('case:appearance')])).toEqual([false, null]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(18, 24, 27)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(243, 245, 245)');
  await context.close();
});

test('[AS-104] the menu is a modal dialog: focus is trapped, Escape closes it and focus returns to the menu button', async ({ page }) => {
  await page.goto(homeUrl(shell.origin));
  const open = page.getByRole('button', { name: 'Open menu' });
  await open.click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  for (const name of ['Join', 'Privacy']) await expect(menu.getByRole('link', { name })).toBeVisible();
  await expect(menu.getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', casesUrl(shell.origin));
  await expect(menu.getByText('Help', { exact: true })).toBeVisible();
  await menu.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(menu.getByRole('group', { name: 'Appearance' })).toBeVisible();
  for (const name of ['Account', 'Sessions', 'Present', 'Admin']) await expect(menu.getByRole('link', { name: new RegExp(`^${name}(?: Opens a new tab)?$`) })).toHaveCount(0);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog.site-menu')))).toBe(true);
  }
  // Shift+Tab wraps backwards inside the menu too.
  await menu.getByRole('button', { name: 'Close menu' }).focus();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog.site-menu')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(open).toBeFocused();
});

test('[AS-104] signed in, the menu names the account with Sign out and Present; Administration only for an entitled account', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signIn(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('link', { name: /^Present/ })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(menu.getByRole('link', { name: /^Admin(?: Opens a new tab)?$/ })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: /Sign in/ })).toHaveCount(0);
  await shot(page, 'menu-signed-in-light');
  await menu.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await context.close();
  // An entitled account (the Worker's admin allowlist) sees Administration.
  const adminAuth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  const adminWorker = await startPublishedWorker({ authOrigin: adminAuth.origin,
    admin: { email: 'owner@example.invalid', stepupSecret: 'x'.repeat(64), origin: 'https://case.test' } });
  adminAuth.setJwt(adminWorker.jwt);
  const adminShell = await startServedAuthShell({ apiOrigin: adminWorker.origin, buildAuthBindings: { SUPABASE_URL: adminAuth.origin,
    SUPABASE_JWT_ISSUER: `${adminAuth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${adminAuth.origin}/auth/v1/.well-known/jwks.json` } });
  adminAuth.setAppOrigin(adminShell.origin);
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, adminShell.origin);
    await adminPage.getByRole('button', { name: 'Open menu' }).click();
    await expect(adminPage.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
  } finally { await adminContext.close(); await adminShell.stop(); await adminWorker.stop(); await adminAuth.stop(); }
});

test('[AS-105] the catalogue: honest paging, server sort and filters, three views over one dataset, "not set", no unconfigured pilot badge', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const queries = [];
  page.on('request', request => { const url = new URL(request.url()); if (/\/catalogue$/.test(url.pathname)) queries.push(Object.fromEntries(url.searchParams)); });
  await signIn(page);
  const status = page.locator('.library-status');
  await expect(status).toHaveText('Showing 24 of 31 published cases');
  await expect(page.locator('.case-grid > .case-card')).toHaveCount(24);
  // Each card is a single link named by the title.
  const first = page.locator('.case-grid > .case-card').first();
  await expect(first.getByRole('link')).toHaveCount(1);
  await expect(first.getByRole('link')).toHaveText(/case|Published/);
  await expect(page.getByText('Summary not set').first()).toBeVisible();
  await expect(page.getByText('Length not set').first()).toBeVisible();
  await expect(page.getByText('Audience not set').first()).toBeVisible();
  const brandCover = page.locator('.case-grid .cover[data-art="brand"]').first();
  await expect(brandCover).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => brandCover.locator('canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(1);
  await expect(page.getByText('Artwork unavailable')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Abstract branching mosaic artwork' }).first()).toBeVisible();
  // CASE-277: an unconfigured pin adds no badge and makes no approval claim.
  await expect(page.locator('.pilot-tag')).toHaveCount(0);
  await shot(page, 'library-grid-light');
  await page.getByRole('button', { name: 'Show more cases' }).click();
  await expect(status).toHaveText('Showing 31 of 31 published cases');
  await expect(page.getByRole('button', { name: 'Show more cases' })).toBeHidden();
  expect(queries.at(-1)).toMatchObject({ sort: 'title', order: 'asc', offset: '24', limit: '24' });
  // Server-side search and filters.
  await fillSearch(page,'Search cases','sepsis');
  await expect(status).toHaveText('Showing 1 of 1 published case');
  expect(queries.at(-1)).toMatchObject({ q: 'sepsis', offset: '0' });
  await fillSearch(page,'Search cases','');
  await page.locator('.library-filters > summary').click();
  const lengthFilter = page.getByRole('combobox', { name: 'Length', exact: true });
  await chooseOption(lengthFilter, '45 min');
  await expect.poll(() => queries.at(-1)?.length).toBe('45');
  await expect(page.locator('.case-grid > .case-card .case-meta')).not.toContainText(['15 min']);
  await chooseOption(lengthFilter, 'All lengths');
  await chooseOption(page.getByRole('combobox', { name: 'Audience', exact: true }), 'Nurses');
  await expect.poll(() => queries.at(-1)?.audience).toBe('Nurses');
  await chooseOption(page.getByRole('combobox', { name: 'Audience', exact: true }), 'All audiences');
  // Table: headers sort on the server with aria-sort, by keyboard.
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.locator('.case-table .cover[data-art="brand"]').first()).toHaveAttribute('aria-hidden', 'true');
  const titleHeader = page.getByRole('columnheader', { name: /Title/ });
  await expect(titleHeader).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('button', { name: 'Title' }).focus();
  await page.keyboard.press('Enter');
  await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');
  expect(queries.at(-1)).toMatchObject({ sort: 'title', order: 'desc', offset: '0' });
  await page.getByRole('button', { name: 'Length' }).press('Enter');
  await expect(page.getByRole('columnheader', { name: /Length/ })).toHaveAttribute('aria-sort', 'ascending');
  await expect(titleHeader).toHaveAttribute('aria-sort', 'none');
  expect(queries.at(-1)).toMatchObject({ sort: 'length', order: 'asc' });
  await shot(page, 'library-table-light');
  // Board: Length or Audience columns over the same dataset, filled in server order.
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.locator('.case-board .cover[data-art="brand"]').first()).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => queries.at(-1)?.sort).toBe('length');
  await expect(page.getByRole('region', { name: '15 min' })).toBeVisible();
  // Missing lengths sort last on the server, so their column appears only once its page is loaded.
  await expect(page.getByRole('region', { name: 'Length not set' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show more cases' }).click();
  await expect(page.getByRole('region', { name: 'Length not set' })).toBeVisible();
  expect(queries.at(-1)).toMatchObject({ sort: 'length', order: 'asc', offset: '24' });
  await chooseOption(page.getByRole('combobox', { name: 'Columns', exact: true }), 'Audience');
  await expect(page.getByRole('region', { name: 'Nurses' })).toBeVisible();
  await page.getByRole('button', { name: 'Show more cases' }).click();
  await expect(page.getByRole('region', { name: 'Audience not set' })).toBeVisible();
  await shot(page, 'library-board-light');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const view of ['Grid', 'Table', 'Board']) { await page.getByRole('button', { name: view, exact: true }).click(); await page.waitForTimeout(150); await expect(page.locator('.pilot-tag')).toHaveCount(0); await axe(page, `library ${view} ${scheme}`); }
  }
  await shot(page, 'library-board-dark');
  await page.getByRole('button', { name: 'Grid', exact: true }).click(); await page.waitForTimeout(300);
  await shot(page, 'library-grid-dark');
  await page.getByRole('button', { name: 'Table', exact: true }).click(); await page.waitForTimeout(300);
  await shot(page, 'library-table-dark');
  await context.close();
});

test('[AS-105] a late catalogue response re-renders the table without taking keyboard focus off the sort header', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await signIn(page);
  await expect(page.locator('.library-status')).toHaveText('Showing 24 of 31 published cases');
  await page.getByRole('button', { name: 'Table' }).click();
  // Hold every catalogue response so a debounced search reload lands while a header has focus.
  await page.route(/\/catalogue(\?|$)/, async route => { await new Promise(resolve => setTimeout(resolve, 600)); await route.continue(); });
  await fillSearch(page,'Search cases','sepsis');
  await page.getByRole('button', { name: 'Length' }).focus();
  await expect(page.locator('.library-status')).toHaveText('Showing 1 of 1 published case');
  // The table was rebuilt under the focused header: focus must still be on the Length sort button, so a key
  // pressed at that instant sorts instead of vanishing with the replaced element.
  expect(await page.evaluate(() => document.activeElement?.dataset?.sort)).toBe('length');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('columnheader', { name: /Length/ })).toHaveAttribute('aria-sort', 'ascending');
  await context.close();
});

test('missing artwork stays quiet when the shared renderer cannot load', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.route(/\/assets\/splash\.[a-f0-9]+\.mjs$/, route => route.abort('failed'));
  await signIn(page);
  await expect(page.locator('.library-status')).toHaveText('Showing 24 of 31 published cases');
  const brand = page.locator('.case-grid .cover[data-art="brand"]').first();
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAttribute('aria-hidden', 'true');
  await expect(brand.locator('canvas')).toHaveJSProperty('width', 1);
  await expect(page.getByText('Artwork unavailable')).toHaveCount(0);
  await shot(page, 'artwork-renderer-unavailable');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('.case-table')).toBeVisible();
  await context.close();
});

test('case detail uses decorative brand artwork for a version without an art descriptor', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signIn(page);
  const target = CATALOGUE[2];
  await page.goto(caseVersionUrl(target.case_id, target.version_no, shell.origin));
  await expect(page.getByRole('heading', { level: 1, name: target.title })).toBeVisible();
  const cover = page.locator('.case-detail .cover.large');
  await expect(cover).toHaveAttribute('data-art', 'brand');
  await expect(cover).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => cover.locator('canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(1);
  await expect(page.getByText('Artwork unavailable')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeEnabled();
  await expect(page.locator('.case-start-note')).toHaveCount(0);
  await shot(page, 'artwork-brand-detail');
  const created = shell.waitForCreatedRoom();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog',{name:'Present case',exact:true}).getByRole('button',{name:'Present',exact:true}).click();
  await created;
  await expect(page.locator('.console-room')).toBeVisible();
  await context.close();
});

test('[AS-105] case detail: a card opens its detail, Start room opens the lobby, and a detail address loads directly', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await signIn(page);
  const target = CATALOGUE[1];
  await fillSearch(page,'Search cases',target.title);
  // One card per case: the older version is not its own card.
  await expect(page.locator('.case-grid > .case-card')).toHaveCount(1);
  await page.getByRole('link', { name: target.title }).click();
  await expect(page).toHaveURL(caseVersionUrl(target.case_id, target.version_no, shell.origin));
  await expect(page.getByRole('heading', { level: 1, name: target.title })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Recognise shock' })).toBeVisible();
  await expect(page.locator('.pilot-tag')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Present', exact: true })).not.toHaveAttribute('aria-describedby');
  // CASE-356 supersedes the five-button row: preparation and teaching have two aligned rows;
  // Versions/Edit stay quiet in publication metadata, and Share is the top-right icon.
  const actions=page.locator('.case-present');
  await expect(actions.getByRole('button',{name:'Share case',exact:true})).toBeVisible();
  await expect(actions.getByRole('button',{name:'Preview',exact:true})).not.toHaveClass(/quiet/);
  await expect(page.locator('.case-record').getByRole('button',{name:'Edit case',exact:true})).toHaveClass(/tertiary/);
  await actions.getByRole('button',{name:'Briefing',exact:true}).click();
  await expect(page.locator('.case-briefing').getByRole('button')).toHaveText(['Download briefing (PDF)','Print briefing']);
  for(const [width,height] of [[1440,1000],[390,844]])for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    const boxes=await actions.locator('.case-present-foot > button').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,right:r.right,height:r.height};}));
    expect(boxes.every(b=>b.height>=44&&b.right<=width)).toBe(true);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
  }
  await page.setViewportSize({width:1440,height:1000});
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(150); await axe(page, `detail ${scheme}`); await shot(page, `case-detail-${scheme}`); }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('.case-record').getByRole('button',{name:/v\d/}).click();
  const versions = page.getByRole('dialog', { name: 'Versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  await expect(versions.getByRole('listitem').first()).toContainText('New edition');
  // Card 68 (SURFACE-04, BUTTON-01): each entry names its version, and Restore as draft is a filled button.
  await shot(page, 'case-history-light');
  for (const item of await versions.getByRole('listitem').all()) await expect(item).toContainText(/^v\d+ · /);
  for (const restore of await versions.getByRole('button', { name: 'Restore as draft', exact: true }).all()) await expect(restore).not.toHaveClass(/tertiary/);
  await expect(versions.getByRole('listitem').nth(1)).not.toContainText('New edition');
  await expect(versions.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(2);
  await expect(versions.getByRole('button', { name: 'Restore as draft', exact: true })).toHaveCount(2);
  await expect(versions.getByRole('button', { name: /Present/ })).toHaveCount(0);
  await versions.getByRole('button', { name: 'Close versions', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Present', exact: true })).toBeVisible();
  // Card 38 (CASE-175): the session persists, so the detail address loads directly, still signed in.
  await page.goto(caseVersionUrl(target.case_id, target.version_no, shell.origin));
  await expect(page.getByRole('heading', { level: 1, name: target.title })).toBeVisible();
  // The older version stays startable from detail, with the same Start room authority.
  const bodies = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/sessions') bodies.push(request.postDataJSON()); });
  const created = shell.waitForCreatedRoom();
  await page.goto(caseVersionUrl(OLDER.case_id, OLDER.version_no, shell.origin));
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog',{name:'Present case',exact:true}).getByRole('button',{name:'Present',exact:true}).click();
  await created;
  await expect(page.getByRole('heading', { level: 1, name: 'Lobby' })).toBeVisible();
  expect(bodies).toEqual([{ workspaceId: worker.workspaceId, caseVersionId: OLDER.version_id, ttlMinutes: 60 }]);
  await context.close();
});

test('[AS-106] Use a shared computer: the Room tab preselects this room, reviews the computer, and the approval fences this console', async ({ browser }) => {
  const facilitator = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
  const pcContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await facilitator.newPage();
    await signIn(page);
    await page.getByRole('link', { name: 'Published case' }).click();
    const created = shell.waitForCreatedRoom();
    await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog',{name:'Present case',exact:true}).getByRole('button',{name:'Present',exact:true}).click();
    const room = await created;
    await openRoomSetup(page);
    const section = page.locator('.console-shared-computer');
    await expect(section.getByRole('heading', { name: 'Use a shared computer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve a PC' })).toHaveCount(0);
    await expect(section.getByRole('textbox', { name: 'Computer code' })).toHaveAttribute('aria-describedby', 'computerCodeHint');
    await shot(page, 'console-room-shared-computer-light');
    const pc = await pcContext.newPage();
    await pc.goto(`${shell.origin}/P`);
    const pcCode = pc.getByLabel('PC approval code');
    await expect(pcCode).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
    await expect(pc.getByText('choose Room, then Use a shared computer')).toBeVisible();
    await shot(pc, 'pair-pc-light');
    // The phone's /P page names the same entry (Julian, 2026-10-06: rename only).
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    try {
      const phonePage = await phone.newPage();
      await phonePage.goto(`${shell.origin}/P`);
      await expect(phonePage.getByRole('button', { name: 'Use a shared computer' })).toBeVisible();
      await expect(phonePage.getByRole('button', { name: /Approve a PC/ })).toHaveCount(0);
      await shot(phonePage, 'pair-phone-light');
    } finally { await phone.close(); }
    const code = (await pcCode.textContent()).replace(/\s/g, '');
    const approvals = [];
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/console-pairs/approve')) approvals.push(request.postDataJSON()); });
    await section.getByRole('textbox', { name: 'Computer code' }).fill(code.toLowerCase());
    await section.getByRole('button', { name: 'Review computer' }).click();
    const dialog = page.getByRole('dialog', { name: `Use this computer for room ${room.joinCode.slice(0, 3)} ${room.joinCode.slice(3)}?` });
    await expect(dialog).toBeVisible();
    for (const term of ['Code', 'Browser', 'Location', 'Requested', 'Expires']) await expect(dialog.getByRole('term').filter({ hasText: term })).toBeVisible();
    await axe(page, 'shared computer review');
    await shot(page, 'console-pair-review-light');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(section.getByRole('button', { name: 'Review computer' })).toBeFocused();
    expect(approvals).toEqual([]);
    await section.getByRole('button', { name: 'Review computer' }).click();
    await dialog.getByRole('button', { name: `Approve room ${room.joinCode.slice(0, 3)} ${room.joinCode.slice(3)}` }).click();
    await expect.poll(() => approvals.length).toBe(1);
    expect(approvals[0]).toEqual({ code, sessionId: room.sessionId });
    await expect(pc.getByRole('status').filter({ hasText: 'PC ready' })).toBeVisible();
    await consoleReady(pc);
    // The previous console is fenced once the computer takes over.
    await expect(page.getByText('Console access ended', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.console-room .console-primary')).toHaveCount(0);
  } finally { await facilitator.close(); await pcContext.close(); }
});

test('[AS-102] the root passes axe in light and dark at 320 and 390 px, and at 200% zoom keeps the code and Continue usable without sideways scroll', async ({ browser }) => {
  for (const scheme of ['light', 'dark']) {
    for (const [width, height, name] of [[320, 568, 'phone-320'], [390, 844, 'phone-390'], [640, 400, 'zoom-200'], [1440, 900, 'desktop']]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(homeUrl(shell.origin));
      await expect(page.getByRole('heading', { name: 'Join the Case' })).toBeVisible();
      await axe(page, `root ${name} ${scheme}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (width <= 390) {
        // The code and Continue fit the first viewport on a phone.
        const box = await page.getByRole('button', { name: 'Continue' }).boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      await page.getByRole('textbox', { name: 'Session code' }).focus();
      await expect(page.getByRole('textbox', { name: 'Session code' })).toBeInViewport();
      await page.getByRole('button', { name: 'Continue' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeInViewport();
      if (name !== 'zoom-200') await shot(page, `root-${name}-${scheme}`);
      if (name === 'desktop') {
        await page.getByRole('button', { name: 'Open menu' }).click();
        await axe(page, `menu ${scheme}`);
        await shot(page, `menu-${scheme}`);
      }
      await context.close();
    }
  }
});

test('[AS-102] sign-in keeps its own six-digit code field, distinct from the room code', async ({ page }) => {
  // The axe pass below reads colours; under motion it can read a button mid-transition (as AS-091 found).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(casesUrl(shell.origin));
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  const otp = page.getByLabel('One-time code');
  await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(otp).toHaveAttribute('inputmode', 'numeric');
  await expect(page.getByRole('textbox', { name: 'Session code' })).toHaveCount(0);
  await axe(page, 'sign-in');
  await shot(page, 'signin-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await axe(page, 'sign-in dark');
  await shot(page, 'signin-dark');
});


test('[AS-105] published Diving metadata and full braid render on the actual detail page', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await signIn(page);
  await page.route('**/api/v1/cases/*/versions/*', async route => {
    const response = await route.fetch(), body = await response.json();
    Object.assign(body.case, { title: 'Diving Deeper', duration_min: 60, art: divingArt });
    await route.fulfill({ response, json: body });
  });
  const target = CATALOGUE[1];
  await page.goto(caseVersionUrl(target.case_id, target.version_no, shell.origin));
  await expect(page.getByRole('heading', { level: 1, name: 'Diving Deeper' })).toBeVisible();
  await expect(page.locator('.case-present-meta')).toContainText('60 min');
  for (const scheme of ['light','dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => page.locator('.case-detail .cover canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data; let coral = 0;
      for(let i=0;i<pixels.length;i+=4) if(pixels[i]>pixels[i+1]*1.4 && pixels[i]>pixels[i+2]*1.4) coral++;
      return coral;
    })).toBeGreaterThan(100);
    await settled(page); await axe(page, `Diving detail ${scheme}`);
    await page.screenshot({ path: `/tmp/case-diving-detail-${scheme}.png`, fullPage: true });
  }
  await context.close();
});
