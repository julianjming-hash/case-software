// Card 68: facilitator and admin surface polish (SURFACE-01 to 05). Built shell, local fixtures only.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startHistoryHarness, signInHistory, forbidRoomClaims } from '../tests/helpers/history-controls.mjs';
import { assertNoHorizontalOverflow } from '../tests/helpers/live-console-controls.mjs';
import { startAdminShell } from '../tests/helpers/admin-shell.mjs';
import { mkdirSync } from 'node:fs';
import { uuidv7 } from '../src/shared/ids.mjs';
test.describe.configure({ mode: 'serial' });
let h, a;
test.beforeAll(async () => { h = await startHistoryHarness(); a = await startAdminShell(); });
test.afterAll(async () => { await h?.stop(); await a?.stop(); });
const SHOTS = process.env.CASE_C68_SHOTS || null;
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); } };
const axe = async page => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
async function signInAdmin(page) {
  await page.goto(a.origin + '/admin');
  await page.getByLabel('Email', { exact: true }).fill(a.email);
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill(a.otp);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
}
const when = new Date().toISOString();

for (const theme of ['light', 'dark']) test(`[AS-126] audit rows read as sentences with a readable target; empty Before and After say Not recorded, in ${theme}`, async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: theme, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  try {
    const target = uuidv7();
    a.state.workspaceEvents = [
      { id: uuidv7(), action: 'version_publish', actor_kind: 'admin', actor_email: a.email, target_type: 'version', target_id: target, revision: null, at: when, before_state: {}, after_state: {} },
      { id: uuidv7(), action: 'case_group', actor_kind: 'owner', actor_email: a.email, target_type: 'case', target_id: uuidv7(), revision: null, at: when, before_state: {}, after_state: {} },
    ];
    const intent = uuidv7();
    a.state.events = [{ id: intent, intent_id: intent, phase: 'intent', action: 'stepup_start', target_type: 'admin', target_id: null, actor_email: a.email, before: {}, after: {}, at: when, from_prefix: null }];
    const page = await context.newPage();
    await signInAdmin(page);
    await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: 'Activity', exact: true }).click();
    const rows = page.locator('.workbench-rows');
    await expect(rows.getByRole('button', { name: `${a.email} published a version`, exact: true })).toBeVisible();
    await expect(rows.getByRole('button', { name: `${a.email} moved a case to another group`, exact: true })).toBeVisible();
    await expect(rows).not.toContainText('version_publish');
    await expect(rows.locator('li').filter({ hasText: 'published a version' })).toContainText(`Case version …${target.slice(-8)}`);
    await rows.getByRole('button', { name: `${a.email} published a version`, exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Selected record' });
    await expect(detail).toContainText('Version published');
    await expect(detail).not.toContainText('version_publish');
    for (const name of ['Before', 'After']) await expect(detail.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(detail.locator('h4 + p').filter({ hasText: 'Not recorded' })).toHaveCount(2);
    await axe(page);
    await shot(page, `audit-detail-${theme}`);
    await detail.getByRole('button', { name: 'Close record', exact: true }).click();
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).and(page.locator('button')).click();
    await page.getByRole('option', { name: /^Deployment-wide/ }).click();
    await expect(rows.getByRole('button', { name: `${a.email} asked for a verification code (outcome not yet recorded)`, exact: true })).toBeVisible();
    await expect(rows).not.toContainText('stepup_start');
    await axe(page);
  } finally { await context.close(); }
});

for (const theme of ['light', 'dark']) test(`[AS-126] Admin lists use one compact row per record, named by its title, in ${theme}`, async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: theme, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    await signInAdmin(page);
    await page.getByRole('button', { name: 'Cases', exact: true }).click();
    const rows = page.locator('.workbench-rows > li');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row.getByRole('button')).toHaveCount(1);
    await expect(row.getByRole('button', { name: 'Teaching case', exact: true })).toBeVisible();
    await expect(row).toContainText('v1');
    expect((await row.boundingBox()).height).toBeLessThan(64);
    // The title and its metadata share a line on a wide screen.
    const [title, meta] = await Promise.all([row.locator('.record-title').boundingBox(), row.locator('.record-meta').boundingBox()]);
    expect(Math.abs(title.y - meta.y)).toBeLessThan(12);
    await axe(page);
    await shot(page, `admin-cases-${theme}`);
    await page.setViewportSize({ width: 390, height: 900 });
    await assertNoHorizontalOverflow(page);
    await axe(page);
  } finally { await context.close(); }
});

for (const theme of ['light', 'dark']) test(`[AS-125] Account separates profile/access from Sessions, whose versioned rows stay compact, in ${theme}`, async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: theme, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  try {
    const claims = forbidRoomClaims(context), page = await context.newPage();
    h.state.rows = h.makeRows(3, 'Teaching session');
    const originalMe=h.worker.fake.replies.get('get_me');
    h.worker.fake.replies.set('get_me',args=>originalMe(args).map(row=>({...row,grants:[{case_id:h.worker.caseId,workspace_id:h.worker.workspaceId,title:'Shared clinical case',level:'edit',access_source:'workspace',source_workspace_name:'Albany Education'}]})));
    try {
    await signInHistory(page, h, 'account');
    await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your access', exact: true })).toBeVisible();
    await expect(page.locator('.portfolio-stats,.portfolio-rows')).toHaveCount(0);
    const accessRow=page.locator('.account-memberships > li').filter({hasText:'Shared clinical case'});
    await expect(accessRow).toContainText('Can edit · Via Albany Education');
    await expect(accessRow.getByRole('link',{name:'Edit case: Shared clinical case',exact:true})).toBeVisible();
    } finally {h.worker.fake.replies.set('get_me',originalMe);}
    await axe(page); await shot(page, `account-${theme}`);
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page.locator('.portfolio-stats').getByRole('heading', { name: 'Your workspace totals', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search sessions', exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search sessions', exact: true })).toBeHidden();
    await expect(page.locator('.portfolio-rows > li')).toHaveCount(3);
    const row = page.locator('.portfolio-rows > li').first();
    await expect(row.getByRole('link')).toHaveCount(1);
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(row).toContainText('v1');
    // CASE-364: factual two-line rows have a 76px minimum, including their readable padding.
    expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(76);
    expect((await row.boundingBox()).height).toBeLessThanOrEqual(80);
    await axe(page);
    await shot(page, `sessions-${theme}`);
    await page.setViewportSize({ width: 390, height: 900 });
    await assertNoHorizontalOverflow(page);
    await axe(page);
    await shot(page, `sessions-${theme}-390`);
    expect(claims).toEqual([]);
  } finally { await context.close(); }
});
