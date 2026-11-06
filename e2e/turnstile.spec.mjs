// Built phone UI against local workerd; vendor script and challenge verdict are explicitly local fakes.
import { test, expect } from '@playwright/test';
import { startLocalWorker, createRoom, serverMirror } from '../tests/helpers/local-worker.mjs';
import { joinUrl, joinEntryUrl, sessionUrl, apiPath, turnstileWidgetScriptUrl } from '../src/shared/urls.mjs';
import { newCapabilityToken, newJoinCode, uuidv7 } from '../src/shared/ids.mjs';
let worker;
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{worker=await startLocalWorker();});
test.afterAll(async()=>{await worker?.stop();});
test.use({viewport:{width:390,height:844}});

async function fakeChallenge(page,{failScript=false}={}) {
 const siteKey=newCapabilityToken(),token=newCapabilityToken(),payloads=[],urls=[];
 let attempts=0;
 await page.route(turnstileWidgetScriptUrl(),route=>failScript?route.abort('connectionfailed'):route.fulfill({contentType:'application/javascript',body:`
  window.turnstile={render(container,options){if(options.sitekey!==${JSON.stringify(siteKey)}||options.action!=='join')throw Error('fixture_options');const button=document.createElement('button');button.type='button';button.textContent='Verify local challenge';button.addEventListener('click',()=>options.callback(${JSON.stringify(token)}));container.append(button);return 'fixture';},remove(){document.querySelectorAll('[data-turnstile-challenge] button').forEach(button=>button.remove());}};
 `}));
 await page.route('**'+apiPath('join'),async route=>{
  payloads.push(route.request().postDataJSON());attempts++;
  return route.fulfill({status:attempts<=3?404:payloads.at(-1).turnstileToken?403:428,contentType:'application/json',body:JSON.stringify(attempts<=3?{error:'unknown_code'}:payloads.at(-1).turnstileToken?{error:'challenge_failed'}:{error:'challenge_required',siteKey})});
 });
 page.on('request',request=>urls.push(request.url()));
 await page.goto(joinUrl(newJoinCode(),worker.origin));await page.getByLabel('Your name',{exact:true}).fill('Sam');
 for(let n=0;n<4;n++){await page.getByRole('button',{name:'Join case',exact:true}).click();await expect(page.getByRole('button',{name:'Join case',exact:true})).toBeEnabled();}
 return {siteKey,token,payloads,urls};
}

test('[AS-083] served join renders optional local challenge and sends one-use token only in JSON with strict Trusted Types',async({page})=>{
 const f=await fakeChallenge(page);
 await expect(page.getByRole('button',{name:'Verify local challenge',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Verify local challenge',exact:true}).click();
 await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect.poll(()=>f.payloads.at(-1)?.turnstileToken).toBe(f.token);
 await expect(page.getByText('Verification expired · try again',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect.poll(()=>f.payloads.length).toBe(6);expect(f.payloads.at(-1)).not.toHaveProperty('turnstileToken');
 expect(f.urls.every(url=>!url.includes(f.token)&&!url.includes('Sam'))).toBe(true);
 expect(await page.evaluate(()=>{try{document.createElement('div').innerHTML='fixture';return false;}catch{return true;}})).toBe(true);
});

test('served join still accepts a correct code after the optional widget cannot load',async({page})=>{
 await fakeChallenge(page,{failScript:true});
 await expect(page.getByText('Verification unavailable · check your code and try Join again',{exact:true})).toBeVisible();
 await page.unroute('**'+apiPath('join'));
 const room=await createRoom(worker.origin);await page.getByLabel('Session code').fill(room.joinCode);
 await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
});

test('lost saved place links from strict playback to the actual join document before loading a widget',async({page})=>{
 await page.goto(sessionUrl(uuidv7(),'play',worker.origin));
 await expect(page.getByRole('heading',{name:'Your saved place is unavailable',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Join case',exact:true})).toHaveCount(0);
 const entry=page.getByRole('link',{name:'Enter a session code',exact:true});await expect(entry).toHaveAttribute('href',joinEntryUrl(worker.origin));
 await entry.click();await expect(page).toHaveURL(joinEntryUrl(worker.origin));await expect(page.getByRole('heading',{name:'Join the case',exact:true})).toBeVisible();
});

test('successful join replaces the entry document before private play and retains exactly one participant',async({page})=>{
 const room=await createRoom(worker.origin),marker=true,documents=[];
 page.on('response',response=>{if(response.request().isNavigationRequest()&&response.url().includes('/sessions/'))documents.push(response);});
 await fakeChallenge(page);
 await expect(page.getByRole('button',{name:'Verify local challenge',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>typeof window.turnstile)).toBe('object');
 await page.unroute('**'+apiPath('join'));
 await page.getByLabel('Session code').fill(room.joinCode);
 // A document-global sentinel represents code already executed on an entry document: removing its script cannot erase it.
 await page.evaluate(value=>{window.fixtureEntryDocument=value;},marker);
 await page.getByLabel('Your name',{exact:true}).fill('Sam');await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>window.fixtureEntryDocument)).toBeUndefined();
 expect(await page.evaluate(()=>window.turnstile)).toBeUndefined();
 expect(documents).toHaveLength(1);expect(documents[0].headers()['content-security-policy']).not.toContain('challenges.cloudflare.com');
 expect(await page.evaluate(sessionId=>JSON.parse(localStorage.getItem(`case:participant:${sessionId}:token`)).sessionId,room.sessionId)).toBe(room.sessionId);
 expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(1);
});

test('QR recovery replaces the entry document with original credential expiry and no duplicate join or queued send',async({page})=>{
 const room=await createRoom(worker.origin);let joins=0,commands=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===apiPath('join'))joins++;if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/commands'))commands++;});
 await page.goto(joinUrl(room.joinCode,worker.origin));await page.getByLabel('Your name',{exact:true}).fill('Sam');await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 const credential=await page.evaluate(sessionId=>localStorage.getItem(`case:participant:${sessionId}:token`),room.sessionId);
 expect(credential).not.toBeNull();
 expect(JSON.parse(credential)).toMatchObject({sessionId:room.sessionId,token:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
 await page.goto(joinUrl(room.joinCode,worker.origin));
 await expect(page).toHaveURL(sessionUrl(room.sessionId,'play',worker.origin));
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 expect(await page.evaluate(sessionId=>localStorage.getItem(`case:participant:${sessionId}:token`),room.sessionId)).toBe(credential);
 expect(joins).toBe(1);expect(commands).toBe(0);expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(1);
});

test('offline private navigation keeps the installed strict shell after an online join-entry response',async({page,context})=>{
 await page.goto(worker.origin);await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));await page.reload();
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
 await page.goto(joinEntryUrl(worker.origin));
 const policy=await page.evaluate(async()=>{for(const name of await caches.keys()){const response=await(await caches.open(name)).match('/index.html');if(response)return response.headers.get('content-security-policy');}});
 expect(policy).not.toContain('challenges.cloudflare.com');expect(policy).not.toContain('case-turnstile');
 await context.setOffline(true);
 try{const response=await page.goto(sessionUrl(uuidv7(),'play',worker.origin));expect(response.headers()['content-security-policy']).toBe(policy);expect(response.headers()['content-security-policy']).not.toContain('challenges.cloudflare.com');}
 finally{await context.setOffline(false);}
});
