// October device audit: real hit areas and readable entry codes on the built local shell.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startAdminShell } from '../tests/helpers/admin-shell.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';

let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin }); auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
    SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } }); auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });
const variants = [320, 390].flatMap(width => ['light', 'dark'].map(colorScheme => ({ width, colorScheme })));
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

test('audit: Administration sign-in and OTP use 44 px fields and stacked actions on narrow phones', async ({ browser }) => {
  const fixture = await startAdminShell();
  try {
    for (const { width, colorScheme } of variants) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, colorScheme });
      const page = await context.newPage();
      try {
        await page.goto(fixture.origin + '/admin');
        const email = page.getByLabel('Email', { exact: true });
        await expect(email).toBeVisible();
        await expect(page.getByRole('region',{name:'Account access'}).getByRole('heading',{name:'Sign in',exact:true})).toHaveCount(1);
        await expect(page.locator('#adminSurface')).toHaveCount(0);
        await expect(page.getByLabel('One-time code', { exact: true }), 'OTP stays hidden until requested').toBeHidden();
        expect((await email.boundingBox()).height, 'email field reaches phone target size').toBeGreaterThanOrEqual(44);
        const emailButton = page.getByRole('button', { name: 'Email me a sign-in code', exact: true });
        expect((await emailButton.boundingBox()).y).toBeGreaterThanOrEqual((await email.boundingBox()).y + (await email.boundingBox()).height);
        await email.fill(fixture.email); await emailButton.click();
        const code = page.getByLabel('One-time code', { exact: true });
        await expect(code).toBeVisible();
        expect((await code.boundingBox()).height, 'OTP field reaches phone target size').toBeGreaterThanOrEqual(44);
        expect(await code.evaluate(node => getComputedStyle(node).fontFamily)).toMatch(/mono/i);
        expect(await overflow(page)).toBe(false);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await fixture.stop(); }
});

test('audit: the shared-computer pairing code is large monospace text and fits narrow phones', async ({ browser }) => {
  for (const { width, colorScheme } of variants) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, colorScheme });
    const page = await context.newPage();
    try {
      await page.goto(shell.origin + '/P');
      await expect(page.getByRole('heading', { name: 'Pair this PC', exact: true })).toBeVisible();
      const code = page.locator('.pair-code');
      await expect(code).toHaveText(/^[0-9A-Z]{4} [0-9A-Z]{4}$/);
      const style = await code.evaluate(node => ({ size: parseFloat(getComputedStyle(node).fontSize), family: getComputedStyle(node).fontFamily }));
      expect(style.size, 'pairing code stays legible').toBeGreaterThanOrEqual(24);
      expect(style.family).toMatch(/mono/i);
      expect(await overflow(page)).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    } finally { await context.close(); }
  }
});

test('audit: header Cases breadcrumb is a 44 px target with visible keyboard focus', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(shell.origin + '/cases');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await page.getByLabel('One-time code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await openCase(page,undefined,{confirm:false});
    const back = page.getByRole('navigation', {name:'Breadcrumb',exact:true}).getByRole('link', {name:'Present',exact:true});
    expect((await back.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await back.boundingBox()).width).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    await back.focus();
    await expect(back).toBeFocused();
    expect(await back.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2);
    expect(await overflow(page)).toBe(false);
    await page.keyboard.press('Enter');
    await expect(page.locator('.library-head')).toBeVisible();
  } finally { await context.close(); }
});
