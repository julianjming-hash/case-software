// Real reviewed Worker/admin routing; only its declared external providers/RPCs are local fakes.
import {test,expect} from '@playwright/test';
import {adminPageUrl,adminApiUrl} from '../src/shared/urls.mjs';
import {startAdminShell} from '../tests/helpers/admin-shell.mjs';
let fixture;
test.beforeEach(async()=>{fixture=await startAdminShell({integrated:true});});
test.afterEach(async({},info)=>{try{if(fixture?.worker)await info.attach('fixed-fixture-admission',{body:JSON.stringify(fixture.worker.state.calls.slice(-100)),contentType:'application/json'});}finally{await fixture?.stop();fixture=null;}});
async function signIn(page){
 await page.goto(adminPageUrl(fixture.origin));
 await page.getByLabel('Email',{exact:true}).fill(fixture.email);
 await page.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();
 await page.getByLabel('One-time code',{exact:true}).fill(fixture.otp);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('heading',{name:'People',exact:true})).toBeVisible();
}
test('[AS-087] [AS-209] Card21b actual Worker invites (account created, invitation saved) and disables a typed target with fresh server elevation and linked audit',async({browser})=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true}),page=await ctx.newPage();
 try{
  const requests=[];page.on('request',request=>requests.push(request.url()));
  await signIn(page);const target=fixture.worker.target,invitee=fixture.worker.invitee;
  // CASE-339/340: Invitations -> Send invitation creates the account (email confirmed) and saves the invitation; with no
  // RESEND_INVITE_API_KEY nothing is sent and Administration says so in exactly these words.
  await page.getByRole('button',{name:'Invitations',exact:true}).click();
 await page.getByRole('button',{name:'+ Invite person',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(invitee);
  await page.getByRole('button',{name:'Send invitation',exact:true}).click();
  await expect(page.locator('.surface-toast').filter({hasText:"Email isn't set up yet: invitations are saved; press Resend once it is."})).toBeVisible();
  await expect(page.getByRole('cell',{name:invitee,exact:true})).toBeVisible();
  expect(fixture.worker.state.calls.filter(call=>['create_invitation','provider_create','record_invitation_delivery'].includes(call.operation)).map(call=>call.operation))
   .toEqual(['create_invitation','provider_create','record_invitation_delivery']);
  expect(fixture.worker.state.invitations[0].sendState).toBe('email_not_configured');
  expect(fixture.worker.state.memberships.has(fixture.worker.state.users.find(user=>user.email===invitee).id),'access waits for the first sign-in').toBe(false);
  const id=fixture.worker.state.users.find(user=>user.email===target)?.id;
  // A5: Revoke states what it does, then revokes (CASE-339); the list says so.
  await page.getByRole('button',{name:`Revoke the invitation to ${invitee}`}).click();
  await expect(page.locator('#adminConfirmation[open]')).toContainText('stops working at once');
  await page.locator('#adminConfirmation[open]').getByRole('button',{name:'Revoke invitation',exact:true}).click();
  await expect(page.locator('.surface-toast').filter({hasText:`The invitation to ${invitee} is revoked.`})).toBeVisible();
  expect(fixture.worker.state.invitations[0].status).toBe('revoked');
  const navTo=async name=>{const close=page.getByRole('button',{name:'Close record',exact:true});if(await close.isVisible())await close.click();await page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name,exact:true}).click();};
  await navTo('People');await expect(page.getByRole('heading',{name:'People',exact:true})).toBeVisible();
  await expect(page.getByText('Can run · Teaching',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:target,exact:true}).click();
  await page.getByRole('button',{name:'Disable…',exact:true}).click();
  await expect(page.locator('#adminConfirmation[open]')).toContainText('They are signed out on every device and cannot sign in.');
  await page.getByRole('button',{name:'Email me a code',exact:true}).click();
  await page.getByLabel('Six-digit code',{exact:true}).fill(fixture.worker.stepupCode);
  await page.locator('#adminConfirmation[open]').getByRole('button',{name:'Disable',exact:true}).click();
  await expect(page.getByRole('cell',{name:'Disabled',exact:true})).toBeVisible();
  expect(fixture.worker.state.profiles.get(id)?.admin_revision).toBe(1);
  expect(fixture.worker.state.calls.filter(call=>call.operation==='provider_ban')).toHaveLength(1);
  expect(Date.parse(fixture.worker.state.users.find(user=>user.id===id).banned_until)).toBeGreaterThan(Date.now());
  const events=fixture.worker.state.events.filter(event=>event.action==='facilitator_disable');
  expect(events.map(event=>event.phase)).toEqual(['intent','outcome']);
  expect(events[0].intent_id).toBe(events[0].event_id);expect(events[1].intent_id).toBe(events[0].event_id);
  expect(events[0].target_id).toBe(id);expect(events[1].after).toEqual({status:'disabled',admin_revision:1});
  const calls=fixture.worker.state.calls.map(call=>call.operation);
  expect(calls.indexOf('disable_intent')).toBeLessThan(calls.indexOf('profile_disable'));
  expect(calls.indexOf('profile_disable')).toBeLessThan(calls.indexOf('disable_outcome'));
  expect(calls.filter(operation=>operation==='provider_verify')).toHaveLength(1);
  await navTo('Activity');
  await page.getByRole('combobox',{name:'Workspace',exact:true}).and(page.locator('button')).click();await page.getByRole('option',{name:/^Deployment-wide/}).click();
  const row=page.getByRole('button',{name:/administrator@example.invalid disabled an account/});await expect(row).toHaveCount(1);await row.click();await expect(page.getByRole('dialog',{name:'Selected record'})).toContainText('Outcome time');
  expect(requests.every(url=>!url.includes(target)&&!url.includes(invitee)&&!url.includes(fixture.otp)&&!url.includes(fixture.worker.stepupCode))).toBe(true);
 }finally{await ctx.close();}
});
test('[AS-087] Card21b actual Worker refuses missing and verified nonadmin credentials before provider or private table admission',async({browser})=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true}),page=await ctx.newPage();
 try{
  await page.goto(adminPageUrl(fixture.origin));await expect(page.getByRole('table')).toHaveCount(0);
  const before=fixture.worker.state.calls.length;
  const route=adminApiUrl(fixture.origin,'facilitators_list');
  const missing=await ctx.request.get(route);expect(missing.status()).toBe(401);expect(await missing.json()).toEqual({error:'unauthorised'});
  const foreign=await ctx.request.get(route,{headers:{authorization:`Bearer ${fixture.worker.nonadminJwt}`}});
  expect(foreign.status()).toBe(403);expect(await foreign.json()).toEqual({error:'forbidden'});
  expect(fixture.worker.state.calls).toHaveLength(before);await expect(page.getByRole('table')).toHaveCount(0);
 }finally{await ctx.close();}
});
