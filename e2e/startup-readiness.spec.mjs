// Public first paint and asynchronous surface readiness against the built local Worker shell.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { startLocalWorker } from '../tests/helpers/local-worker.mjs';
import { homeUrl, joinUrl, checkUrl } from '../src/shared/urls.mjs';

let worker;
const capture = async (page, name) => {
  const directory = process.env.CASE_STARTUP_SHOTS;
  if (directory) { mkdirSync(directory, { recursive: true }); await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true }); }
};
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });

for (const theme of ['light', 'dark']) test(`public static splash is readable before the route loads in ${theme}`, async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 320, height: 640 },
    reducedMotion: 'reduce', colorScheme: theme });
  const page = await context.newPage(); let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/assets/home.*.mjs', async route => { await held; await route.continue(); });
  try {
    await page.goto(homeUrl(worker.origin), { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'Case', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Opening Case…');
    await expect(page.getByRole('link', { name: 'Network check', exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await capture(page, `splash-${theme}-320`);
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `splash-${theme}-1920`);
    await page.getByText('Trouble opening Case?', { exact: true }).click();
    await expect(page.getByRole('link', { name: 'Network check', exact: true })).toHaveAttribute('href', '/check');
    expect(await page.locator('main').innerText()).not.toMatch(/high-speed MVC|participant|token/);
    release();
    await expect(page.getByRole('textbox', { name: 'Session code', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Opening Case' })).toHaveCount(0);
  } finally { release(); await context.close(); }
});

test('no-JavaScript shell gives public browser guidance without a perpetual loading status', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 640 } });
  try {
    const page = await context.newPage(); await page.goto(homeUrl(worker.origin));
    await expect(page.getByRole('heading', { name: 'Case', exact: true })).toBeVisible();
    // Playwright's text/ARIA engines exclude noscript nodes. Check the actual rendered paragraph.
    await expect(page.locator('noscript > p')).toBeVisible();
    await expect(page.locator('noscript > p')).toContainText('Case needs JavaScript. Enable it, then reload this page.');
    await expect(page.locator('#startupStatus')).toBeHidden();
    const help = page.locator('details.startup-help'), summary = help.locator('summary');
    const network = page.getByRole('link', { name: 'Network check', exact: true });
    await expect(summary).toHaveAccessibleName('Trouble opening Case? Show');
    await expect(help.locator('.startup-help-show')).toBeVisible();
    await expect(help.locator('.startup-help-hide')).toBeHidden();
    await expect(network).toBeHidden();
    expect((await summary.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(summary).toHaveCSS('list-style-type', 'none');
    expect(await summary.evaluate(el => getComputedStyle(el, '::marker').content)).toBe('""');
    await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveCSS('outline-width', '3px');
    await capture(page, 'splash-no-js-320');
    await page.keyboard.press('Enter');
    await expect(help).toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAccessibleName('Trouble opening Case? Hide');
    await expect(summary.getByText('Trouble opening Case?', { exact: true })).toBeVisible();
    await expect(help.locator('.startup-help-show')).toBeHidden();
    await expect(help.locator('.startup-help-hide')).toBeVisible();
    await expect(network).toBeVisible();
    await page.keyboard.press('Space');
    await expect(help).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAccessibleName('Trouble opening Case? Show');
    await expect(network).toBeHidden();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(network).toBeFocused();
    await expect(network).toHaveAttribute('href', '/check');
  } finally { await context.close(); }
});

test('held or failed optional artwork leaves root code controls immediately usable', async ({ browser }) => {
  for (const fail of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    let release; const hold = new Promise(resolve => { release = resolve; });
    // Holding the renderer itself also fails the original root's eager mosaic import.
    await page.route('**/assets/mosaic.*.mjs', async route => { if (fail) await route.abort(); else { await hold; await route.continue(); } });
    try {
      await page.goto(homeUrl(worker.origin), { waitUntil: 'commit' });
      await expect(page.getByRole('textbox', { name: 'Session code', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Enter the six-character session code shown on the projector.');
      await page.getByRole('textbox', { name: 'Session code', exact: true }).fill('7K3QX9');
      await expect(page.getByRole('alert')).toBeHidden();
      await expect(page.locator('.home-art svg')).toHaveCount(0);
      if (!fail) { release(); await expect(page.locator('.home-art svg')).toBeVisible(); }
      await expect(page.getByRole('textbox', { name: 'Session code', exact: true })).toHaveValue('7K3QX9');
    } finally { release(); await context.close(); }
  }
});

test('an asynchronous phone mount failure is caught and document Reload page actually retries it', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
  try {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let mounts = 0;
    await page.route('**/assets/phone.*.mjs', async route => {
      mounts++;
      if (mounts === 1) await route.fulfill({ contentType: 'text/javascript', body: 'export async function mount() { await Promise.resolve(); throw new Error("private fixture diagnostic"); }' });
      else await route.continue();
    });
    await page.goto(joinUrl('7K3QX9', worker.origin));
    await expect(page.getByRole('heading', { name: 'Case could not load this page', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible();
    await capture(page, 'async-failure');
    await expect(page.getByRole('link', { name: 'Network check', exact: true })).toHaveAttribute('href', checkUrl(worker.origin));
    expect(await page.locator('main').innerText()).not.toContain('private fixture diagnostic');
    await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
    expect(mounts).toBe(2); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('a held async mount does not block SW recovery and deadline never starts a second mount', async ({ page }) => {
  await page.clock.install();
  // Playwright's clock replaces Performance and does not retain native mark entries.
  await page.addInitScript(() => {
    globalThis.fixtureMarks = [];
    const original = performance.mark.bind(performance);
    performance.mark = name => { fixtureMarks.push(name); return original(name); };
  });
  await page.route('**/assets/phone.*.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function mount() {
      globalThis.fixtureMounts = (globalThis.fixtureMounts || 0) + 1;
      await new Promise(resolve => { globalThis.finishSurface = resolve; });
      const main = document.querySelector('main'), button = document.createElement('button');
      button.textContent = 'Usable fixture control'; main.replaceChildren(button);
    }` }));
  await page.goto(joinUrl('7K3QX9', worker.origin), { waitUntil: 'commit' });
  await expect.poll(() => page.evaluate(() => typeof finishSurface)).toBe('function');
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()))).toBe(true);
  await page.clock.fastForward(15_001);
  await expect(page.getByRole('heading', { name: 'Case is taking longer to open', exact: true })).toBeVisible();
  await page.evaluate(() => finishSurface());
  await expect(page.getByRole('button', { name: 'Usable fixture control', exact: true })).toBeVisible();
  expect(await page.evaluate(() => fixtureMounts)).toBe(1);
  expect(await page.evaluate(() => fixtureMarks.filter(name => name === 'case-route-module-loaded').length)).toBe(1);
  expect(await page.evaluate(() => fixtureMarks.filter(name => name === 'case-surface-mounted').length)).toBe(1);
});
