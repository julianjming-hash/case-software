// Card21a: real administrator end, actual console socket and common private cleanup.
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import {test,expect} from '@playwright/test';
import {randomInt} from 'node:crypto';
import {startLocalAuthStub} from '../tests/helpers/local-auth-stub.mjs';
import {startPublishedWorker} from '../tests/helpers/published-worker.mjs';
import {startServedAuthShell} from '../tests/helpers/served-auth-shell.mjs';
import {apiUrl} from '../src/shared/urls.mjs';
import {newCapabilityToken} from '../src/shared/ids.mjs';
import {mintElevation} from '../src/worker/admin/stepup.mjs';
import {STORAGE_FENCE_KEY} from '../src/client/storage-generation.mjs';
import { consoleReady } from '../tests/helpers/console-v2.mjs';

test('[AS-086] Card21a actual admin end revokes the served console and clears private room storage',async({browser})=>{
 const email='owner@example.invalid',stepupSecret=newCapabilityToken(),origin='https://case.test';
 const otp=String(randomInt(1000000)).padStart(6,'0');
 let auth,worker,shell,context;
 try {
  auth=await startLocalAuthStub({appOrigin:null,jwt:null,otp});
  worker=await startPublishedWorker({authOrigin:auth.origin,admin:{email,stepupSecret,origin}});
  auth.setJwt(worker.jwt);
  shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,
   SUPABASE_JWT_ISSUER:`${auth.origin}/auth/v1`,SUPABASE_JWKS_URL:`${auth.origin}/auth/v1/.well-known/jwks.json`}});
  auth.setAppOrigin(shell.origin);
  context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
  const sockets={connected:false,closed:false};
  page.on('websocket',socket=>{
   if(!/^\/api\/v1\/sessions\/[0-9a-f-]{36}\/ws$/.test(new URL(socket.url()).pathname))return;
   socket.on('framereceived',frame=>{if(typeof frame.payload==='string'&&JSON.parse(frame.payload).t==='welcome')sockets.connected=true;});
   socket.on('close',()=>{sockets.closed=true;});
  });
  await page.goto(casesUrl(shell.origin));await page.getByLabel('Email').fill(email);
  await page.getByRole('button',{name:'Email me a sign-in code'}).click();await page.getByLabel('One-time code').fill(otp);
  await page.getByRole('button',{name:'Sign in'}).click();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
  const created=shell.waitForCreatedRoom();await (await openCase(page)).click();const room=await created;
  await consoleReady(page);await expect.poll(()=>sockets.connected).toBe(true);
  // Fresh next_load cleanup creates generation1; the one accepted End cleanup advances it once.
  expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_FENCE_KEY)).toBe('1');
  const response=await fetch(apiUrl(worker.origin,'admin','rooms',room.sessionId,'end'),{method:'POST',redirect:'manual',
   headers:{authorization:`Bearer ${worker.jwt}`,origin,'content-type':'application/json',
    'X-Admin-Elevation':(await mintElevation(email,worker.sessionId,stepupSecret)).token},body:'{}'});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({ended:true});
  // Card 38 (CASE-175): the room's end clears its state but keeps the account signed in, back on the case.
  await expect.poll(()=>sockets.closed).toBe(true);await expect(page.getByRole('button',{name:'Present',exact:true})).toBeVisible();
  await expect(page.locator('.console-room')).toHaveCount(0);await expect(page.getByLabel('Email')).toBeHidden();
  expect(await page.evaluate(async key=>({
   keys:[...Object.keys(sessionStorage),...Object.keys(localStorage)].filter(key=>(key.startsWith('case:')||key.startsWith('case-lab:'))&&key!=='case:auth:refresh'),
   generation:localStorage.getItem(key),
   privateDatabases:(await indexedDB.databases()).map(item=>item.name).filter(name=>name?.startsWith('case:')),
   caches:(await caches.keys()).filter(name=>name.startsWith('case:private')),
  }),STORAGE_FENCE_KEY)).toEqual({keys:[STORAGE_FENCE_KEY],generation:'2',privateDatabases:[],caches:[]});
  const audits=worker.fake.requests.filter(request=>request.name==='write_admin_audit');
  expect(audits.map(request=>request.args.p_phase)).toEqual(['intent','outcome']);
  expect(audits.every(request=>request.args.p_target_id===room.sessionId&&request.args.p_action==='room_end')).toBe(true);
 } finally {await context?.close();await shell?.stop();await worker?.stop();await auth?.stop();}
});
