import { uuidv7 } from '../src/shared/ids.mjs';
import { chooseOption } from '../tests/helpers/choose-option.mjs';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';

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
async function signedContext(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1366, height: 900 } });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('navigation-fixture-seeded')) {
      localStorage.setItem('case:auth:refresh', 'local-refresh-only');
      sessionStorage.setItem('navigation-fixture-seeded', '1');
    }
  }); return context;
}
for (const path of ['/cases', '/cases?view=drafts', '/history', '/account', '/cases/new', '/admin.html']) {
  test(`[AS-125] saved session never presents sign-in while restoration is pending: ${path}`, async ({ browser }) => {
    const context = await signedContext(browser); const page = await context.newPage(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered; const requested = new Promise(resolve => { entered = resolve; });
    await page.route('**/auth/v1/token?grant_type=refresh_token', async route => { entered(); await gate; await route.continue(); });
    try {
      await page.goto(shell.origin + path); await requested;
      await expect(page.getByText('Checking your session…', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeHidden();
      await expect(page.getByText('Sign in to continue.', { exact: true })).toBeHidden();
      await expect(page.locator('.auth-art')).toBeHidden();
      await expect(page.getByLabel('Email', { exact: true })).toBeHidden();
      const bar = await page.locator('.site-bar').boundingBox();
      release(); await expect(page.locator('.auth-form.is-signed-in')).toHaveCount(1);
      expect((await page.locator('.site-bar').boundingBox()).y).toBe(bar.y);
    } finally { release(); await context.close(); }
  });
}
test('[AS-125] unavailable refresh keeps the session and offers recovery without sign-in artwork', async ({ browser }) => {
  const context = await signedContext(browser); const page = await context.newPage();
  await page.route('**/auth/v1/token?grant_type=refresh_token', route => route.abort());
  try {
    await page.goto(shell.origin + '/cases');
    await expect(page.getByRole('button', { name: 'Retry session' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeHidden();
    await expect(page.locator('.auth-art')).toBeHidden();
    expect(await page.evaluate(() => Boolean(localStorage.getItem('case:auth:refresh')))).toBe(true);
    await page.unroute('**/auth/v1/token?grant_type=refresh_token');
    await page.getByRole('button', { name: 'Retry session' }).click();
    await expect(page.getByRole('heading', { name: 'Present', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
    await page.reload(); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('.auth-art')).toBeVisible();
  } finally { await context.close(); }
});

test('[AS-125] a refused saved session shows sign-in and clears the expired credential', async ({ browser }) => {
  const context = await signedContext(browser); const page = await context.newPage();
  await page.route('**/auth/v1/token?grant_type=refresh_token', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_grant"}' }));
  try {
    await page.goto(shell.origin + '/cases');
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await expect(page.locator('.auth-art')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
  } finally { await context.close(); }
});

// CASE-356 replaces the collection toggle with separate same-tab destinations. Workspace
// changes inside either collection remain in-document; old bookmarks canonicalise without an extra entry.
test('[AS-125] canonical Present/Create preserve sign-in, workspace and browser history; old collection links remain compatible',async({browser})=>{
 const context=await signedContext(browser),page=await context.newPage();try{
  const ws=worker.workspaceId;await page.goto(`${shell.origin}/cases?workspace=${ws}`);await expect(page.locator('.library-head')).toBeVisible();await expect(page).toHaveURL(`${shell.origin}/present?workspace=${ws}`);await expect(page.locator('.library-sections')).toHaveCount(0);
  const codes=()=>auth.requests.filter(r=>r.method==='POST'&&r.path==='/auth/v1/otp').length,before=codes();
  await page.getByRole('button',{name:'Open menu',exact:true}).click();const menu=page.getByRole('dialog',{name:'Menu',exact:true});await expect(menu.getByRole('link',{name:'Create',exact:true})).toHaveAttribute('href',`${shell.origin}/create?workspace=${ws}`);await menu.getByRole('link',{name:'Create',exact:true}).click();await expect(page.getByRole('region',{name:'Saved private drafts'})).toBeVisible();await expect(page).toHaveURL(`${shell.origin}/create?workspace=${ws}`);await expect(page.locator('.auth-art')).toBeHidden();
  await page.goBack();await expect(page).toHaveURL(`${shell.origin}/present?workspace=${ws}`);await expect(page.locator('.library-head')).toBeVisible();await page.goForward();await expect(page).toHaveURL(`${shell.origin}/create?workspace=${ws}`);await expect(page.locator('.library-workspace select')).toHaveValue(ws);expect(codes()).toBe(before);
  await page.goto(`${shell.origin}/cases?view=drafts&workspace=${ws}`);await expect(page).toHaveURL(`${shell.origin}/create?workspace=${ws}`);await expect(page.locator('.auth-form.is-signed-in')).toHaveCount(1);
 }finally{await context.close();}
});

for (const theme of ['light', 'dark']) test(`[AS-125] neutral session frame aligns across surfaces in ${theme} at desktop and mobile widths`, async ({ browser }) => {
  const context = await signedContext(browser); const page = await context.newPage();
  await context.addInitScript(theme => localStorage.setItem('case:appearance', theme), theme);
  try {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 }); let edge, top;
      for (const path of ['/cases', '/admin.html', '/cases/new']) {
        let release, entered; const gate = new Promise(resolve => { release = resolve; });
        const requested = new Promise(resolve => { entered = resolve; });
        const hold = async route => { entered(); await gate; await route.continue(); };
        await page.route('**/auth/v1/token?grant_type=refresh_token', hold);
        try {
          await page.goto(shell.origin + path); await requested;
          await expect(page.getByText('Checking your session…', { exact: true })).toBeVisible();
          const bar = await page.locator('.site-bar').boundingBox(); expect(bar.y).toBe(0);
          await expect.poll(async () => (await page.locator('.auth-status').boundingBox()).x).toBeCloseTo(edge ?? (edge = (await page.locator('.auth-status').boundingBox()).x), 0);
          const statusBox = await page.locator('.auth-status').boundingBox();
          expect(statusBox.y).toBeCloseTo(top ?? (top = statusBox.y), 0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const audit = await new AxeBuilder({ page }).analyze(); expect(audit.violations).toEqual([]);
          mkdirSync('/tmp/case-navigation-review', { recursive: true });
          await page.screenshot({ path: `/tmp/case-navigation-review/${theme}-${width}-${path.replaceAll('/', '') || 'home'}.png` });
        } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
        await expect(page.locator('.auth-form.is-signed-in')).toHaveCount(1);
      }
    }
  } finally { await context.close(); }
});

test('[AS-125] departed draft requests cannot reopen content, and modified menu links keep native navigation',async({browser})=>{
 const context=await signedContext(browser),page=await context.newPage();let release,entered;const gate=new Promise(r=>release=r),requested=new Promise(r=>entered=r);
 await page.route('**/api/v1/builder/workspaces/*/drafts?*',async route=>{entered();await gate;try{await route.fulfill({json:{workspaceId:worker.workspaceId,limit:50,offset:0,hasMore:false,nextOffset:1,drafts:[{caseId:worker.caseId,title:'Late private draft',revision:1,updatedAt:new Date().toISOString()}]}});}catch{/* A document navigation is allowed to abort the obsolete response. */}});
 try{
  await page.goto(`${shell.origin}/create?workspace=${worker.workspaceId}`);await requested;await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu'}).getByRole('link',{name:'Present',exact:true}).click();release();await expect(page.locator('.library-head')).toBeVisible();await expect(page.getByText('Late private draft',{exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'Saved private drafts'})).toHaveCount(0);
  await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.locator('.site-menu-notice')).toBeEmpty();const create=page.getByRole('dialog',{name:'Menu'}).getByRole('link',{name:'Create',exact:true});await page.evaluate(()=>{window.modifiedClicks=[];addEventListener('click',e=>{if(e.target.closest?.('a'))window.modifiedClicks.push({modifier:e.ctrlKey||e.metaKey,prevented:e.defaultPrevented});});});
  await create.click({modifiers:['ControlOrMeta']});expect(await page.evaluate(()=>window.modifiedClicks)).toEqual([{modifier:true,prevented:false}]);
  // Assert the retained browser state: a transient page notification can be absent even when the new document loaded.
  await expect.poll(()=>context.pages().filter(other=>other!==page&&!other.isClosed()).length).toBe(1);
  const other=context.pages().find(other=>other!==page&&!other.isClosed());await expect(other).toHaveURL(`${shell.origin}/create?workspace=${worker.workspaceId}`);await expect(page).toHaveURL(`${shell.origin}/present?workspace=${worker.workspaceId}`);await other.close();
 }finally{release();await context.close();}
});

test('[AS-125] workspace changes and Back retain the same authenticated collection document', async ({ browser }) => {
  const context = await signedContext(browser); const page = await context.newPage(); const secondWorkspace = uuidv7();
  await page.route('**/api/v1/me?limit=20', async route => {
    const response = await route.fetch(), body = await response.json();
    body.memberships[0].name = 'First workspace';
    body.memberships.push({ ...body.memberships[0], workspace_id: secondWorkspace, name: 'Second workspace' });
    await route.fulfill({ response, json: body });
  });
  try {
    await page.goto(`${shell.origin}/cases?workspace=${worker.workspaceId}`);
    await page.goto(`${shell.origin}/create?workspace=${worker.workspaceId}`);await expect(page.locator('.library-workspace select')).toHaveValue(worker.workspaceId);
    await page.evaluate(() => { window.navigationDocumentSentinel = 'workspace-document'; });
    await chooseOption(page.getByRole('combobox', { name: 'Workspace', exact: true }), 'Second workspace');
    await expect(page).toHaveURL(`${shell.origin}/create?workspace=${secondWorkspace}`);
    expect(await page.evaluate(() => window.navigationDocumentSentinel)).toBe('workspace-document');
    await page.goBack();
    await expect(page).toHaveURL(`${shell.origin}/create?workspace=${worker.workspaceId}`);
    await expect(page.locator('.library-workspace select')).toHaveValue(worker.workspaceId);
    expect(await page.evaluate(() => window.navigationDocumentSentinel)).toBe('workspace-document');
  } finally { await context.close(); }
});
