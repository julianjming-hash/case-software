// Actual served account/history documents against the real local Worker. Local PostgREST fixtures
// model archive summaries; they do not stand in for the SQL entitlement/retention assertions.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startHistoryHarness, signInHistory, forbidRoomClaims, chooseHistory } from '../tests/helpers/history-controls.mjs';
import { assertNoHorizontalOverflow } from '../tests/helpers/live-console-controls.mjs';

test.describe.configure({ mode: 'serial' });
let harness;
test.beforeAll(async () => { harness = await startHistoryHarness(); });
test.afterAll(async () => { await harness?.stop(); });
test.beforeEach(() => {
  Object.assign(harness.state, { memberships: harness.workspaces.map(row => ({ ...row })), rows: harness.makeRows(),
    failMembershipPage: false, failInitialMe: false, removed: false, foreign: false, hold: null });
  harness.worker.fake.inactiveActors.clear();
});

test('Sessions titles show case names and cumulative unique participants while Lobby attempts stay outside teaching inventory', async ({ browser }) => {
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:900}});
 try {
  const rows=harness.makeRows(3);rows[0]={...rows[0],title:'Every Breath You Take',joined:37,joined_exact:true,archive_state:'complete'};rows[1]={...rows[1],title:'Diving Deeper',joined:9};rows[2]={...rows[2],title:'Not Yet Stable',joined:null};
  harness.state.rows=[...harness.makeRows(25,'LOBBY_ONLY_SENTINEL').map(r=>({...r,started_at:null,status:'lobby'})),...rows].sort((a,b)=>b.session_id.localeCompare(a.session_id));
  const page=await context.newPage(),claims=forbidRoomClaims(context);await signInHistory(page,harness);await expect(page.locator('.portfolio-rows li')).toHaveCount(3);
  await expect(page.getByRole('link',{name:/Every Breath You Take · 37 participants/})).toHaveCount(1);await expect(page.getByRole('link',{name:/Diving Deeper · ≥9 participants/})).toHaveCount(1);await expect(page.getByRole('link',{name:/Not Yet Stable · participants not recorded/})).toHaveCount(1);await expect(page.locator('.portfolio-rows')).not.toContainText('LOBBY_ONLY_SENTINEL');
  expect(claims).toEqual([]);await assertNoHorizontalOverflow(page);
 } finally {await context.close();}
});

for (const theme of ['light','dark']) test(`history membership paging is one page per press; styled choices work by keyboard at 320px in ${theme}`, async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: theme, reducedMotion: 'reduce', viewport: { width: 320, height: 900 } });
  try {
    const claims = forbidRoomClaims(context), page = await context.newPage();
    await signInHistory(page, harness);
    await expect(page.locator('.portfolio-rows li')).toHaveCount(20);
    const before = harness.calls('get_me').filter(row => row.args.p_workspace_id === null && row.args.p_after !== null).length;
    await page.getByRole('button', { name: 'More workspaces', exact: true }).click();
    await expect(page.getByRole('button', { name: 'More workspaces', exact: true })).toHaveCount(0);
    expect(harness.calls('get_me').filter(row => row.args.p_workspace_id === null && row.args.p_after !== null).length).toBe(before + 1);
    const workspace = page.getByRole('combobox', { name: 'Workspace', exact: true });
    await workspace.focus(); await page.keyboard.press('End');
    await expect(page.getByRole('listbox', { name: 'Workspace', exact: true }).getByRole('option')).toHaveCount(22);
    await page.keyboard.press('Enter'); await expect(workspace).toHaveText('Workspace 22 · Can manage');
    await expect.poll(() => harness.calls('query_teaching_session_portfolio').at(-1)?.args.p_workspace_id).toBe(harness.workspaces.at(-1).workspace_id);
    await expect(page.locator('.portfolio-rows li')).toHaveCount(20);
    await chooseHistory(page,'Status','Ended');await page.getByRole('button',{name:'Apply filters',exact:true}).click();
    await expect(page.locator('.portfolio-rows li')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Open session options', exact: true })).toHaveCount(0);
    expect(harness.calls('query_teaching_session_portfolio').at(-1).args.p_status).toBe('ended');
    await assertNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(claims).toEqual([]);
  } finally { await context.close(); }
});

for (const mode of ['history','account']) test(`${mode} membership refusal clears private content and disposed choices; repeated Retry rechecks fresh account access`, async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
  try {
    const claims = forbidRoomClaims(context), page = await context.newPage();
    await signInHistory(page, harness, mode);
    if (mode === 'history') {
      await expect(page.locator('.portfolio-rows li')).toHaveCount(20);
      await expect(page.locator('.portfolio-rows [data-session]').first()).toBeVisible();
      expect(await page.locator('.shared-select-options').count()).toBe(2);
    } else await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
    harness.state.failMembershipPage = true;
    await page.getByRole('button', { name: 'More workspaces', exact: true }).click();
    const retry = page.getByRole('button', { name: 'Retry account access', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.locator('.portfolio-rows li')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open session options', exact: true })).toHaveCount(0);
    await expect(page.locator('.shared-select-options')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toHaveCount(0);
    harness.state.failInitialMe = true;
    const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me' && response.status() === 503);
    await retry.click(); await refused;
    await expect(retry).toBeVisible();
    await expect(page.locator('.portfolio-rows li')).toHaveCount(0);
    harness.state.failInitialMe = false; harness.state.failMembershipPage = false;
    harness.state.memberships = [{ ...harness.workspaces.at(-1), name: 'Fresh current workspace' }];
    harness.state.rows = harness.makeRows(1, 'Fresh current summary');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me' && response.status() === 200);
    await retry.click(); await refreshed;
    await expect(page.getByRole('heading', { name: mode === 'history' ? 'Sessions' : 'Account', exact: true })).toBeVisible();
    if (mode === 'history') {
      await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveText('Fresh current workspace · Can manage');
      await expect(page.locator('.portfolio-rows li')).toHaveCount(1);
      await expect(page.locator('.portfolio-rows li')).toContainText('Fresh current summary');
    } else await expect(page.locator('main')).toContainText('Fresh current workspace');
    await expect(page.getByRole('button', { name: 'More workspaces', exact: true })).toHaveCount(0);
    expect(claims).toEqual([]);
  } finally { await context.close(); }
});

test('history next-page revocation clears prior links; every Retry repeats current account and membership checks', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
  try {
    const claims = forbidRoomClaims(context), page = await context.newPage();
    await signInHistory(page, harness); await expect(page.locator('.portfolio-rows li')).toHaveCount(20);
    const calls = harness.calls('query_teaching_session_portfolio').length;
    harness.state.removed = true;
    const refused = page.waitForResponse(response => /\/portfolio\/query$/.test(new URL(response.url()).pathname) && response.status() === 403);
    await page.getByRole('button', { name: 'Next page', exact: true }).click(); await refused;
    await expect(page.locator('.portfolio-rows li')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open session options', exact: true })).toHaveCount(0);
    expect(harness.calls('query_teaching_session_portfolio').length).toBe(calls);
    const retry = page.getByRole('button', { name: 'Refresh sessions', exact: true });
    harness.worker.fake.inactiveActors.add(harness.worker.userId);
    await retry.click(); await expect(retry).toBeEnabled();
    await expect(page.locator('.portfolio-rows li')).toHaveCount(0);
    expect(harness.calls('query_teaching_session_portfolio').length).toBe(calls);
    harness.worker.fake.inactiveActors.clear(); harness.state.removed = false;
    harness.state.rows = [{ ...harness.makeRows(1, 'Current ended room')[0], status: 'ended', ended_at: new Date().toISOString() }];
    await retry.click(); await expect(page.locator('.portfolio-rows li')).toHaveCount(1);
    await expect(page.locator('.portfolio-rows li')).toContainText('Current ended room');
    await expect(page.getByRole('link', { name: 'Open session options', exact: true })).toHaveCount(0);
    expect(harness.calls('query_teaching_session_portfolio').at(-1).args.p_after).toBeNull();
    expect(claims).toEqual([]);
  } finally { await context.close(); }
});

test('non-admin history never renders a foreign own=false summary, and sign-out fences a late permitted page', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' }); let held;
  const stages = [], network = [];
  const nextHistory = request => /\/portfolio\/query$/.test(new URL(request.url()).pathname) && request.postDataJSON()?.after!==null;
  let markFailed;
  const nativeFailure = new Promise(resolve => { markFailed = resolve; });
  const onFailure = request => { if (nextHistory(request)) markFailed(request); };
  context.on('requestfailed', onFailure);
  const stage = async (name, run) => test.step(name, async () => {
    stages.push({ name, state: 'started' });
    const result = await run(); stages.push({ name, state: 'completed' }); return result;
  });
  // Observe real native request completion. Keep cursor, authorization and response bodies out of diagnostics.
  for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) context.on(event, value => {
    const request = event === 'response' ? value.request() : value;
    const url = new URL(request.url());
    if (!/\/(?:history|logout)$/.test(url.pathname)) return;
    network.push({ event, path: url.pathname, method: request.method(), page: request.method()==='POST'&&request.postDataJSON()?.after ? 'next' : 'first',
      ...(event === 'response' ? { status: value.status() } : {}) });
  });
  try {
    const claims = forbidRoomClaims(context), page = await context.newPage();
    harness.state.foreign = true;
    await signInHistory(page, harness);
    const retry = page.getByRole('button', { name: 'Refresh sessions', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.locator('body')).not.toContainText('FOREIGN_ROOM_PRIVATE_SENTINEL');
    await expect(page.locator('.portfolio-rows li')).toHaveCount(0);
    harness.state.foreign = false;
    harness.state.memberships = harness.workspaces.map(row => ({ ...row, role: 'author' }));
    await retry.click(); await expect(page.locator('.portfolio-rows li')).toHaveCount(20);
    held = harness.holdNextHistory();
    const nextRequest = page.waitForRequest(nextHistory);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    const heldRequest = await nextRequest; await held.ready;
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button',{name:'Confirm sign out',exact:true}).click();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await stage('Release abandoned permitted history read and await native abort',async()=>{
      held.release();held=null;const failed=await nativeFailure;expect(failed).toBe(heldRequest);expect(failed.failure()?.errorText).toBe('net::ERR_ABORTED');
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.portfolio-rows li')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open session options', exact: true })).toHaveCount(0);
    await expect(page.locator('.shared-select-options')).toHaveCount(0);
    expect(await page.evaluate(() => Object.values(sessionStorage).some(value => /Every Breath You Take|FOREIGN_ROOM_PRIVATE/.test(value)))).toBe(false);
    expect(claims).toEqual([]);
    stages.push({ name: 'Post-sign-out privacy assertions', state: 'completed' });
  } finally {
    held?.release();
    context.off('requestfailed', onFailure);
    await test.info().attach('late-history-native-lifecycle', {
      body: JSON.stringify({ stages, network }), contentType: 'application/json',
    });
    await stage('Close history browser context after native completion', () => context.close());
  }
});

// CASE-365: visual enhancement cannot remove authorised evidence from an export.
test('session PDF retains validated feedback when its screen stylesheet fails',async({browser})=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});try{const page=await context.newPage();await signInHistory(page,harness);const {uuidv7}=await import('../src/shared/ids.mjs'),{sessionRecordUrl}=await import('../src/shared/urls.mjs'),{readPdf}=await import('../tests/helpers/pdf-read.mjs'),{readFile}=await import('node:fs/promises');const id=uuidv7(),caseId=uuidv7(),stamp=new Date().toISOString();
 const session={id,workspaceId:harness.worker.workspaceId,caseId,versionId:uuidv7(),versionNo:1,digest:'a'.repeat(64),title:'Feedback export check',status:'ended',sourceStatus:'published',createdAt:stamp,startedAt:stamp,endedAt:stamp,expiresAt:stamp,own:true};
 const record={schema:'case.session-record.v1',session,boundary:'b'.repeat(64),interpretation:1,completeness:'complete',sourceAvailable:true,joined:1,eventCount:0,intendedObjectives:[],items:[],nextAfter:null,images:[]};
 let styleReads=0;await page.route('**/assets/feedback-presentation.*.css',route=>{styleReads++;return route.abort('failed');});await page.route('**/api/v1/portfolio/record',route=>route.fulfill({json:record}));let reads=0;await page.route('**/api/v1/portfolio/sessions/*/feedback',route=>{reads++;return route.fulfill({json:{session:{id,caseId,versionNo:1,title:session.title,date:'2026-11-04'},closed:true,responses:{total:1,joined:1,qr:0},ratings:Object.fromEntries(['session','case','app'].map(key=>[key,{counts:[0,0,0,0,1],n:1}])),comments:[{kind:'takeaway',about:'session',body:'Feedback must survive a stylesheet failure.'}]}});});
 await page.goto(sessionRecordUrl(id,harness.shell.origin));await page.getByRole('button',{name:'Export',exact:true}).click();const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF',exact:true}).click();const download=await event,text=readPdf(await readFile(await download.path())).lines.join('\n');expect(text).toContain('Feedback must survive a stylesheet failure.');expect(reads).toBe(1);expect(styleReads).toBeGreaterThan(0);await page.unroute('**/assets/feedback-presentation.*.css');await page.getByRole('button',{name:'Retry feedback display',exact:true}).click();await expect(page.locator('.feedback-results')).toContainText('Feedback must survive a stylesheet failure.');expect(reads).toBe(1);
 }finally{await context.close();}
});

// A later membership page is a discovery hint, never current authority for the menu.
test('menu rereads known later-page author access before showing Create and drops it after revocation',async({browser})=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true});try{const page=await context.newPage();harness.state.memberships=harness.workspaces.map((row,index)=>({...row,role:index===20?'author':'facilitator'}));await signInHistory(page,harness);await page.getByRole('button',{name:'More workspaces',exact:true}).click();await expect(page.getByRole('button',{name:'More workspaces',exact:true})).toHaveCount(0);const menu=page.getByRole('dialog',{name:'Menu',exact:true});await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect.poll(()=>harness.calls('get_me').at(-1).args.p_workspace_id).toBe(harness.workspaces[20].workspace_id);await expect(menu.locator('.site-menu-notice')).toBeEmpty();await expect(menu.getByRole('link',{name:'Create',exact:true})).toBeVisible();await menu.getByRole('button',{name:'Close menu',exact:true}).click();harness.state.memberships[20].role='facilitator';await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(menu.locator('.site-menu-notice')).toBeEmpty();await expect(menu.getByRole('link',{name:'Create',exact:true})).toHaveCount(0);expect(harness.calls('get_me').at(-1).args.p_workspace_id).toBe(harness.workspaces[20].workspace_id);
 }finally{await context.close();}
});
