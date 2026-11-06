import {fillSearch} from '../tests/helpers/collapsed-search.mjs';
// Card21b: actual standalone static shell/common Auth; strict local Admin HTTP contract only.
// Real server integration is a separate required gate after reviewed Card21a is on main.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdirSync} from 'node:fs';
import {startAdminShell} from '../tests/helpers/admin-shell.mjs';
import { docShotsDir } from '../tests/helpers/doc-shots.mjs';
let fixture;
test.describe.configure({mode:'default'});
test.beforeEach(async()=>{fixture=await startAdminShell();});
test.afterEach(async()=>{await fixture?.stop();fixture=null;});
async function context(browser,options={}){return browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1920,height:1080},...options});}
async function signIn(page){await page.goto(fixture.origin+'/admin');await page.getByLabel('Email',{exact:true}).fill(fixture.email);await page.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();await page.getByLabel('One-time code',{exact:true}).fill(fixture.otp);await page.getByRole('button',{name:'Sign in',exact:true}).click();}
async function ready(page){await expect(page.getByRole('heading',{name:'People',exact:true})).toBeVisible();}
async function selectFacilitator(page){await page.getByRole('button',{name:'facilitator@example.invalid',exact:true}).click();await expect(page.getByRole('dialog',{name:'Selected record'}).getByRole('button',{name:'Close record'})).toBeFocused();}
// R-a (card 35): the first destructive action asks for a code; later ones in the same sign-in run on one press (A5: the dialog states its consequences first).
async function confirm(page,action,{elevated=false}={}){await page.getByRole('button',{name:action,exact:true}).click();if(!elevated){await page.getByRole('button',{name:'Email me a code',exact:true}).click();await page.getByLabel('Six-digit code',{exact:true}).fill(fixture.stepupCode);}await page.locator('#adminConfirmation[open]').getByRole('button',{name:action==='Disable…'?'Disable and end 1 room':action,exact:true}).click();}

test('Card21b admin entitlement gates are distinct and no private table appears before a verified response',async({browser})=>{
 for(const [mode,message] of [['forbidden',"This account doesn't have administrator access"],['unavailable','Administration is unavailable.'],['unauthorised','Sign in to continue.']]){
  fixture.state.mode=mode;const ctx=await context(browser),page=await ctx.newPage();try{await page.goto(fixture.origin+'/admin');await expect(page.getByRole('table')).toHaveCount(0);await signIn(page);await expect(mode==='unauthorised'?page.getByRole('region',{name:'Account access'}).getByRole('heading',{name:'Sign in',exact:true}):mode==='forbidden'?page.locator('#adminSurface').getByRole('heading',{name:message}):page.locator('#adminSurface').getByRole('status').filter({hasText:message})).toBeVisible();await expect(page.getByRole('table')).toHaveCount(0);if(mode==='unauthorised'){await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeHidden();expect(await page.evaluate(()=>sessionStorage.getItem('case:auth:refresh'))).toBeNull();}else{await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();}}finally{await ctx.close();}
 }
});
// CASE-339: invitations moved to Administration -> Invitations and POST /api/v1/invitations (e2e/access-invitations.spec.mjs).
test('Card21b sparse search paging keeps the personal query in the body, never a URL',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();try{
  const urls=[];page.on('request',request=>urls.push(request.url()));await signIn(page);await ready(page);
  await fillSearch(page,'Search people by email','sparse');await page.getByRole('button',{name:'Search',exact:true}).click();await expect(page.getByText('No records on this page.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.getByText('Page 2',{exact:true})).toBeVisible();
  expect(urls.every(url=>!url.includes('sparse')&&!url.includes(fixture.otp))).toBe(true);
 }finally{await ctx.close();}
});
test('Card21b fresh email step-up performs one disable, returns focus to the person and shows its actual recorded audit phases in words',async({browser})=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1920,height:1080}}),page=await ctx.newPage();try{
  await signIn(page);await ready(page);await selectFacilitator(page);await page.getByRole('button',{name:'Disable…',exact:true}).click();
  await expect(page.locator('#adminConfirmation[open]')).toContainText('They are signed out on every device and cannot sign in.');expect(fixture.state.calls.filter(call=>call.operation==='stepup_start')).toHaveLength(0);
  await page.getByRole('button',{name:'Email me a code',exact:true}).click();await expect(page.getByLabel('Six-digit code',{exact:true})).toBeFocused();expect(fixture.state.calls.filter(call=>call.operation==='stepup_start')).toHaveLength(1);
  await page.getByLabel('Six-digit code',{exact:true}).fill(fixture.stepupCode);await page.getByRole('button',{name:'Disable and end 1 room',exact:true}).click();await expect(page.locator('#adminConfirmation[open]')).toHaveCount(0);await expect(page.getByRole('cell',{name:'Disabled',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'facilitator@example.invalid',exact:true})).toBeFocused();expect(fixture.state.mutations).toBe(1);
  await page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name:'Activity',exact:true}).click();
  await page.getByRole('combobox',{name:'Workspace',exact:true}).and(page.locator('button')).click();await page.getByRole('option',{name:/^Deployment-wide/}).click();
  await expect(page.locator('.workbench-rows')).toContainText('disabled an account');await page.getByRole('button',{name:/administrator@example.invalid disabled an account/}).click();await expect(page.getByRole('dialog',{name:'Selected record'})).toContainText('administrator@example.invalid');await expect(page.getByRole('dialog',{name:'Selected record'})).toContainText('Outcome time');await expect(page.getByRole('dialog',{name:'Selected record'})).not.toContainText('facilitator_disable');
 }finally{await ctx.close();}
});
test('workspace case and room inspection apply exact elevated actions without private content',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();let releaseInventory;const inventory=new Promise(resolve=>{releaseInventory=resolve;});
 await page.route('**/api/v1/admin/workspaces/query',async route=>{await inventory;await route.continue();});try{
  await signIn(page);await ready(page);
  const nav=async name=>{const close=page.getByRole('button',{name:'Close record',exact:true});if(await close.isVisible())await close.click();await page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name,exact:true}).click();};
  await nav('Cases');
  // Hold inventory so the hidden-native/enhanced-control transition is deterministic.
  await expect(page.locator('.workspace-workbench select[aria-label="Workspace"]')).toHaveCount(1);await expect(page.locator('.workspace-workbench button.shared-select-trigger[aria-label="Workspace"]')).toHaveCount(0);releaseInventory();
  const ws=fixture.state.workspaces.find(w=>w.name==='Teaching');const picker=page.getByRole('combobox',{name:'Workspace',exact:true}).and(page.locator('button'));await picker.click();await page.getByRole('option',{name:new RegExp(`^${ws.name}(?: ✓)?$`)}).click();
  const region=page.getByRole('dialog',{name:'Selected record'});
  await page.getByRole('button',{name:'Teaching case',exact:true}).click();await confirm(page,'Withdraw version');await expect(page.locator('.workbench-rows')).toContainText('Withdrawn');expect(fixture.state.version.admin_revision).toBe(1);
  await page.getByRole('button',{name:'Teaching case',exact:true}).click();await confirm(page,'Republish version',{elevated:true});await expect(page.locator('.workbench-rows')).toContainText('Published');expect(fixture.state.version.admin_revision).toBe(2);
  await nav('Sessions');await page.getByRole('button',{name:'Teaching case',exact:true}).click();await expect(region).toContainText('Recorded state');await expect(page.getByRole('link',{name:'Rejoin session'})).toHaveCount(0);await confirm(page,'End case',{elevated:true});expect(fixture.state.stepups).toBe(1);await expect(page.locator('.workbench-rows li')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'Session ended. Current information loaded.'})).toBeVisible();
  expect(fixture.state.calls.every(call=>!['case-pack','document','participants'].includes(call.operation))).toBe(true);await expect(page.locator('body')).not.toContainText('private answer');
 }finally{releaseInventory();await ctx.close();}
});
test('Card21b a code being checked cannot be cancelled, and sign-out fences a held refresh and erases retained DOM plus web-storage values',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();let held;try{
  await signIn(page);await ready(page);await selectFacilitator(page);await page.getByRole('button',{name:'Disable…',exact:true}).click();await page.getByRole('button',{name:'Email me a code',exact:true}).click();held=fixture.hold('stepup_verify');await page.getByLabel('Six-digit code',{exact:true}).fill(fixture.stepupCode);await page.getByRole('button',{name:'Disable and end 1 room',exact:true}).click();await held.ready;
  await expect(page.locator('#adminConfirmation[open]').getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();expect(fixture.state.mutations).toBe(0);held.release();held=null;await expect(page.locator('#adminConfirmation[open]')).toHaveCount(0);expect(fixture.state.mutations).toBe(1);
  await page.evaluate(()=>window.retainedAdminNodes=[...document.querySelectorAll('#adminSurface *')]);held=fixture.hold('facilitators_list');await page.getByRole('button',{name:'Refresh information',exact:true}).click();await held.ready;
  await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Confirm sign out',exact:true}).click();await expect(page.getByRole('table')).toHaveCount(0);held.release();held=null;await expect(page.getByRole('status').filter({hasText:'Signed out.'})).toBeVisible();await expect(page.getByRole('table')).toHaveCount(0);
  expect(await page.evaluate(()=>window.retainedAdminNodes.filter(node=>node.textContent||node.value||node.getAttribute('data-record')).map(node=>({tag:node.tagName,text:node.textContent,value:node.value,record:node.getAttribute('data-record')})))).toEqual([]);
  expect(await page.evaluate(()=>[...Object.values(sessionStorage),...Object.values(localStorage)].some(value=>value.includes('facilitator@example.invalid')||value.includes('case-pack')))).toBe(false);
 }finally{held?.release();await ctx.close();}
});
test('Card21b ten-minute inactivity pauses polling without locking and activity refreshes one real table read',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();try{
  await page.clock.install();await signIn(page);await ready(page);const before=fixture.state.calls.filter(call=>call.operation==='facilitators_list').length;
  await page.clock.fastForward(601000);await expect(page.getByRole('status').filter({hasText:'Automatic refresh is paused after inactivity.'})).toBeVisible();await expect(page.getByRole('button',{name:'facilitator@example.invalid',exact:true})).toBeEnabled();expect(fixture.state.calls.filter(call=>call.operation==='facilitators_list')).toHaveLength(before);expect(fixture.state.mutations).toBe(0);
  await page.locator('.admin-people-table caption').click();await expect.poll(()=>fixture.state.calls.filter(call=>call.operation==='facilitators_list').length).toBe(before+1);await expect(page.getByRole('heading',{name:'People',exact:true})).toBeVisible();await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 }finally{await ctx.close();}
});
for(const theme of ['light','dark'])test(`Card21b ${theme} admin layout has keyboard drawer/dialog focus and accessible responsive tables`,async({browser})=>{
 const ctx=await context(browser,{colorScheme:theme}),page=await ctx.newPage();try{
  await signIn(page);await ready(page);await selectFacilitator(page);await page.getByRole('button',{name:'Disable…',exact:true}).click();await expect(page.getByRole('button',{name:'Email me a code',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(page.locator('#adminConfirmation[open]')).toHaveCount(0);await expect(page.getByRole('button',{name:'Disable…',exact:true})).toBeFocused();
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(result.violations).toEqual([]);await page.screenshot({path:`${docShotsDir('21-screenshots')}/facilitators-${theme}-1920.png`});
  await page.setViewportSize({width:1366,height:768});await page.screenshot({path:`${docShotsDir('21-screenshots')}/facilitators-${theme}-1366.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await ctx.close();}
});

test('Card21b conflict compensation reconciliation and protected-target errors are explicit without automatic mutation retries',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();try{
  await signIn(page);await ready(page);
  // The vehicle is Enable (a non-destructive action) on a disabled account; the retired Resend invitation used to be it.
  const person=fixture.state.users.find(user=>user.email==='facilitator@example.invalid');person.profile.disabled_at=new Date().toISOString();
  await page.getByRole('button',{name:'Refresh information',exact:true}).click();await expect(page.getByRole('cell',{name:'Disabled',exact:true})).toBeVisible();
  for(const [mode,message] of [['conflict','This record changed. Current information has been loaded.'],['reverted','The change was reverted because audit recording is unavailable.'],['reconciliation','Manual reconciliation is needed. Do not repeat this action.'],['protected','Your access does not allow this action. Check Account → Your access or ask a Case administrator.']]){
   await selectFacilitator(page);fixture.state.actionMode=mode;const before=fixture.state.calls.filter(call=>call.operation==='facilitators_enable').length;
   await page.getByRole('button',{name:'Enable',exact:true}).click();await expect(page.locator('.surface-toast').filter({hasText:message})).toBeVisible();expect(fixture.state.calls.filter(call=>call.operation==='facilitators_enable')).toHaveLength(before+1);expect(fixture.state.mutations).toBe(0);fixture.state.actionMode=null;await page.getByRole('button',{name:'Dismiss notification'}).click();const closeRecord=page.getByRole('button',{name:'Close record',exact:true});if(await closeRecord.isVisible())await closeRecord.click();
  }
  person.profile.disabled_at=null;await page.getByRole('button',{name:'Refresh information',exact:true}).click();await expect(page.getByRole('cell',{name:'Active',exact:true})).toBeVisible();
  await selectFacilitator(page);await page.getByRole('button',{name:'Disable…',exact:true}).click();await page.getByRole('button',{name:'Email me a code',exact:true}).click();fixture.state.stepupMode='rate_limited';await page.getByLabel('Six-digit code',{exact:true}).fill(fixture.stepupCode);await page.getByRole('button',{name:'Disable and end 1 room',exact:true}).click();await expect(page.locator('.surface-toast')).toContainText('Too many code attempts');expect(fixture.state.mutations).toBe(0);expect(fixture.state.calls.filter(call=>call.operation==='stepup_verify')).toHaveLength(1);
 }finally{await ctx.close();}
});

test('Card21b background polling never replaces a focused unsent search draft',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();try{
  await page.clock.install();await signIn(page);await ready(page);
  for(const label of ['Search people by email']){
   await fillSearch(page,label,'draft@example.invalid');const input=page.getByRole('searchbox',{name:label,exact:true});await input.focus();const before=fixture.state.calls.filter(call=>call.operation==='facilitators_list').length;await page.clock.fastForward(31000);
   await expect(input).toHaveValue('draft@example.invalid');await expect(input).toBeFocused();expect(fixture.state.calls.filter(call=>call.operation==='facilitators_list')).toHaveLength(before);expect(fixture.state.invites).toBe(0);await input.fill('');
  }
  const record=page.getByRole('button',{name:'facilitator@example.invalid',exact:true});await record.focus();const before=fixture.state.calls.filter(call=>call.operation==='facilitators_list').length;await page.clock.fastForward(31000);await expect.poll(()=>fixture.state.calls.filter(call=>call.operation==='facilitators_list').length).toBe(before+1);await expect(record).toBeFocused();
 }finally{await ctx.close();}
});
