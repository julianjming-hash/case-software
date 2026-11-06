// Emulated devices against a local published Worker, HTTPS Auth fake and built CSP shell.
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import {test,expect}from '@playwright/test';
import {startLocalAuthStub}from '../tests/helpers/local-auth-stub.mjs';
import {startPublishedWorker}from '../tests/helpers/published-worker.mjs';
import {startServedAuthShell}from '../tests/helpers/served-auth-shell.mjs';
import {serverMirror,FIXTURE}from '../tests/helpers/local-worker.mjs';
import {joinUrl,sessionUrl}from '../src/shared/urls.mjs';
import {socketNetwork}from '../tests/helpers/socket-network.mjs';
import { consoleReady, projectorPage, dismissDisplayReminder } from '../tests/helpers/console-v2.mjs';
let auth,worker,shell;
const screenOf=page=>page.evaluate(()=>`${screen.width}x${screen.height}`);
test.beforeAll(async()=>{
 auth=await startLocalAuthStub({appOrigin:null,jwt:null});worker=await startPublishedWorker({authOrigin:auth.origin});auth.setJwt(worker.jwt);
 shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:`${auth.origin}/auth/v1`,SUPABASE_JWKS_URL:`${auth.origin}/auth/v1/.well-known/jwks.json`}});auth.setAppOrigin(shell.origin);
});
test.afterAll(async()=>{await shell?.stop();await worker?.stop();await auth?.stop();});
test('[AS-099] [AS-096] mobile slow/lossy join, background, offline replay and tab recreation preserve one participant',async({browser,context,page})=>{
 // Playwright's setViewportSize also sets screen to the new viewport, whatever `screen` the context began
 // with, so every console resize emulates a monitor change, which the display check rightly treats as a new
 // display (CASE-167). The console's width checks therefore all run before the check is confirmed, and its
 // screen never changes after it: a 2 s display poll that landed between two resizes cleared the check.
 await context.addInitScript(()=>{window.__networkHints={offline:0,online:0};addEventListener('offline',()=>window.__networkHints.offline++);addEventListener('online',()=>window.__networkHints.online++)});
 const facContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1366,height:900},screen:{width:1920,height:1080}});let closed=false;
 const fac=await facContext.newPage();
 try{
  await fac.goto(casesUrl(shell.origin));await fac.getByLabel('Email').fill('owner@example.invalid');await fac.getByRole('button',{name:'Email me a sign-in code'}).click();await fac.getByLabel('One-time code').fill('123456');await fac.getByRole('button',{name:'Sign in'}).click();
  const created=shell.waitForCreatedRoom();await (await openCase(fac)).click();const room=await created;
  await consoleReady(fac);
  for(const width of [1366,1920]){await fac.setViewportSize({width,height:1080});await expect(fac.getByRole('button',{name:'Start case'})).toBeVisible();expect(await fac.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await expect.poll(()=>screenOf(fac)).toBe('1920x1080');
  const projector=await projectorPage(fac); // Present opened it in its own click (console layout v2)
  // The word appears only after the console took the projector's hello, which re-reads the settled screen.
  await expect(projector.locator('#projectorCheck')).toBeVisible();
  for(const width of [1280,1920]){await projector.setViewportSize({width,height:1080});await expect(projector.getByRole('heading',{name:'Join the case',exact:true})).toBeVisible();await expect(projector.locator('.names .arrival-note')).toHaveText('0 joined');expect(await projector.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await dismissDisplayReminder(fac);const confirmedScreen=await screenOf(fac);
  await expect(fac.getByRole('button',{name:'Start case'})).toBeEnabled();
  let lostJoin=false,lostVote=false,voteLoss=null;const joinRequests=[];
  // Browser setOffline does not cut route.fetch (Node-side) or every WebKit socket.
  // Cut both transports explicitly; a real welcome rightly overrides a false browser offline hint (CASE-152).
  const network = socketNetwork();
  await context.routeWebSocket(url => new URL(url).pathname.endsWith('/ws'), socket => network.route(socket));
  await context.route('**/api/v1/**',async route=>{
   const request=route.request(), generation=network.generation;
   const cut=()=>network.offline||network.generation!==generation;
   if(cut()){await route.abort('failed');return;}
   await new Promise(resolve=>setTimeout(resolve,400));
   if(cut()){await route.abort('failed');return;}
   if(new URL(request.url()).pathname.endsWith('/join')){
    joinRequests.push(request.postDataJSON());if(!lostJoin){lostJoin=true;await route.fetch();await route.abort('failed');return;}
   }
   let response;
   try { response=await route.fetch(); }
   catch (error) {
    if(voteLoss?.completed&&request.method()==='POST'&&new URL(request.url()).pathname===`/api/v1/sessions/${room.sessionId}/commands`){
     const sent=request.postDataJSON();
     if(sent?.type==='vote'&&sent.clientEventId===voteLoss.clientEventId){await route.abort('failed');return;}
    }
    throw error;
   }
   const body=await response.body();
   await new Promise(resolve=>setTimeout(resolve,body.byteLength/50000*1000));
   if(cut()){await route.abort('failed');return;}
   await route.fulfill({response,body});
  });
  await page.goto(joinUrl(room.joinCode,shell.origin));await page.getByLabel('Your name').fill('Learner');await page.getByRole('button',{name:'Join case'}).click();
  await expect(page.getByRole('heading',{name:'Waiting to start'})).toBeVisible();
  expect(joinRequests.length).toBe(2);expect(joinRequests[0].joinToken===joinRequests[1].joinToken).toBe(true);
  expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(1);
  expect(await screenOf(fac),'the console screen changed after the display check').toBe(confirmedScreen);
  await fac.getByRole('button',{name:'Start case'}).click();
  for(const name of ['Reveal findings','Show decision context','Reveal observations','Reveal findings','Open responses'])await fac.getByRole('button',{name,exact:true}).click();
  await expect(page.locator('.decision')).toBeVisible();
  await expect(page.locator('#conn')).toBeEmpty();
  await visibility(page, 'hidden');
  await network.setOffline(true);
  await context.setOffline(true);
  // Chromium's emulated offline network does not deliver a native offline event in this harness.
  // Inject that lifecycle hint only when absent, just as visibility is explicitly emulated below.
  // Real WS and HTTP traffic are already cut independently; no server welcome or receipt is mocked.
  const hint=await page.evaluate(()=>({online:navigator.onLine,events:window.__networkHints.offline}));
  expect(hint.online).toBe(false);
  if(hint.events===0)await page.evaluate(()=>dispatchEvent(new Event('offline')));
  console.log('OFFLINE_PROOF',JSON.stringify(await page.evaluate(()=>({online:navigator.onLine,hints:window.__networkHints,visibility:document.visibilityState,status:document.querySelector('#conn')?.textContent}))));
  await expect(page.getByText('Connection lost · follow the room',{exact:true})).toBeVisible();
  // Return to the foreground while still offline; retries may say Reconnecting, but cannot reach the server.
  await visibility(page, 'visible');
  expect(await page.evaluate(()=>navigator.onLine)).toBe(false);
  await page.getByRole('radio',{name:FIXTURE.decisions[0].interaction.options[2].label}).check();
  await expect(page.getByRole('button',{name:'Send answer',exact:true})).toBeHidden();
  await expect(page.getByText('Not sent yet · 1',{exact:true})).toBeVisible();
  await expect(page.getByText(/^Answer saved · (you can change it until responses lock|already received)$/)).toHaveCount(0);
  expect(Object.keys((await serverMirror(worker.origin,room)).round.responses)).toHaveLength(0);
  const play=sessionUrl(room.sessionId,'play',shell.origin);await page.close();closed=true;
  voteLoss=shell.armVoteReceiptLoss(room.sessionId);
  await network.setOffline(false);
  await context.setOffline(false);const restored=await context.newPage();
  await restored.goto(play);await visibility(restored, 'visible');
  await expect(restored.getByText(/^Answer saved · (you can change it until responses lock|already received)$/)).toBeVisible();
  await expect(restored.getByText('Not sent yet · 1',{exact:true})).toHaveCount(0);
  await expect.poll(()=>voteLoss.error??voteLoss.completed,{timeout:10_000,message:'The local proxy drops the real accepted vote response before completing this proof'}).toBe(true);
  expect(voteLoss.receipt.clientEventId).toBe(voteLoss.clientEventId);
  expect(['accepted','already_accepted']).toContain(voteLoss.receipt.receipt);lostVote=voteLoss.completed;
  await expect(restored.getByRole('button',{name:'Change decision',exact:true})).toBeVisible();expect(lostVote).toBe(true);
  const mirror=await serverMirror(worker.origin,room);expect(Object.keys(mirror.participants)).toHaveLength(1);expect(Object.keys(mirror.round.responses)).toHaveLength(1);
  expect(Object.values(mirror.round.responses)[0].response.option_id).toBe(FIXTURE.decisions[0].interaction.options.find(option=>option.label.includes('S00175 workshop label. Record a s')).id);
 }finally{await facContext.close();if(!closed)await page.close();}
});


// Emulate the document lifecycle consistently for transport and phone handlers; this is not physical iOS backgrounding.
async function visibility(page, state) {
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
