// Card 36a (surface parity, access denied): a signed-in account without administrator access sees its
// own address and two actions; signed out and unavailable keep their own strings. Local fixtures only.
// CASE_SHOTS_DIR, when set, saves a screenshot per state (outside the repo).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { startAdminShell } from '../tests/helpers/admin-shell.mjs';

const SHOTS = process.env.CASE_SHOTS_DIR || null;
const shot = async (page, state, t, w) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${state}-${t}-${w}.png`, fullPage: true });
};
let fixture;
test.describe.configure({ mode: 'default' });
test.beforeEach(async () => { fixture = await startAdminShell(); });
test.afterEach(async () => { await fixture?.stop(); fixture = null; });

async function signIn(page) {
  await page.goto(fixture.origin + '/admin');
  await page.getByLabel('Email', { exact: true }).fill(fixture.email);
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill(fixture.otp);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
const surface = page => page.locator('#adminSurface');
const DENIED = "This account doesn't have administrator access";

test('[36a] admin denied: a signed-in non-administrator sees the account address, why signing in again will not help, and two actions, light and dark', async ({ browser }) => {
  for (const [t, w, h] of [['light', 1366, 768], ['dark', 1366, 768], ['light', 390, 844], ['dark', 390, 844]]) {
    fixture.state.mode = 'forbidden';
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, colorScheme: t });
    const page = await ctx.newPage();
    const urls = [];
    page.on('request', request => urls.push(request.url()));
    try {
      await signIn(page);
      await expect(surface(page).getByRole('heading', { name: DENIED })).toBeVisible();
      await shot(page, 'admin-denied', t, w);
      await expect(surface(page)).toContainText(`You're signed in as ${fixture.email}. Signing in again won't change this.`);
      await expect(surface(page).getByText('If you should have access, ask the Case owner to add this address.', { exact: true })).toBeVisible();
      await expect(surface(page).getByRole('link', { name: 'Back to Present', exact: true })).toHaveAttribute('href', /\/present$/);
      await expect(surface(page).getByRole('button', { name: 'Sign in with another account', exact: true })).toBeVisible();
      await expect(surface(page).getByRole('table')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(urls.every(url => !url.includes(encodeURIComponent(fixture.email)) && !url.includes(fixture.email))).toBe(true);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations.map(x => `${x.id} ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
      // The other account: the existing sign-out, then the existing sign-in; nothing of the account stays in the page.
      await surface(page).getByRole('button', { name: 'Sign in with another account', exact: true }).click();
      await expect(page.getByRole('region',{name:'Account access'}).getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
      await expect(surface(page)).toBeHidden();
      await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
      expect(await page.locator('body').innerText()).not.toContain(fixture.email);
      await expect(surface(page).getByRole('heading', { name: DENIED })).toHaveCount(0);
    } finally { await ctx.close(); }
  }
});

test('[36a] admin denied: an unknown address reads "this account"; signed out and unavailable keep their own strings and no denied page', async ({ browser }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  try {
    fixture.state.mode = 'forbidden';
    fixture.state.meMode = 'unavailable';
    await signIn(page);
    // The shared private admission cannot infer Admin access while /me is unavailable.
    await expect(page.getByRole('button',{name:'Retry account access',exact:true})).toBeVisible();
    await expect(surface(page)).toHaveCount(0);
    await expect(page.getByRole('heading',{name:DENIED,exact:true})).toHaveCount(0);
    // A current identity without an email still gets the established, factual denial copy.
    fixture.state.meMode='no_email';await page.getByRole('button',{name:'Retry account access',exact:true}).click();
    await expect(surface(page)).toContainText("You're signed in as this account. Signing in again won't change this.");
  } finally { await ctx.close(); }
  for (const [mode, text] of [['unauthorised', 'Sign in to continue.'], ['unavailable', 'Administration is unavailable.']]) {
    fixture.state.mode = mode; fixture.state.meMode = null;
    const c = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await c.newPage();
    try {
      await signIn(p);
      if(mode==='unauthorised'){await expect(p.getByRole('region',{name:'Account access'}).getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(p.getByLabel('Email',{exact:true})).toBeVisible();await expect(surface(p)).toBeHidden();}else await expect(surface(p).getByRole('status').filter({ hasText: text })).toBeVisible();
      await expect(surface(p).getByRole('heading', { name: DENIED })).toHaveCount(0);
      if (mode === 'unavailable') await expect(surface(p).getByRole('button', { name: 'Refresh information', exact: true })).toBeVisible();
    } finally { await c.close(); }
  }
});
