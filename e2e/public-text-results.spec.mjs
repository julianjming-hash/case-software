import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { test, expect } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { miniCase } from '../tests/helpers/mini-case.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { serverMirror, facilitatorCommand } from '../tests/helpers/local-worker.mjs';
import { apiUrl, authApiUrl, displayPairUrl, joinUrl, sessionUrl } from '../src/shared/urls.mjs';

let auth, worker, shell;
const fixture = miniCase();
fixture.doc = convertSchema1ToBuilderDocument(fixture.doc, { metadata_version: 1 }).candidate;
const decision = fixture.doc.decisions[0];
decision.interaction = { type: 'free_text', max_length: 500 };
decision.paths = [decision.paths[0]]; delete decision.paths[0].option_ids; decision.rules = [{ when: { keywords: ['unmatched-keyword'] }, path_id: decision.paths[0].id }];
if (!validateRuntimeDocument(fixture.doc).ok) throw new Error('invalid_public_response_fixture');
const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null, otp });
  worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: fixture.doc }); auth.setJwt(worker.jwt);
  const base = authApiUrl(auth.origin, 'base');
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: base.slice(0, -1),
    SUPABASE_JWKS_URL: new URL('.well-known/jwks.json', base).href,
  } }); auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

import AxeBuilder from '@axe-core/playwright';
async function phoneBatches(phones, action) {
 for(let at=0;at<phones.length;at+=3) await Promise.all(phones.slice(at,at+3).map((phone,i)=>action(phone,at+i)));
}
for (const scenario of ['paging', 'twelve chips', 'wide glyphs']) test(`[AS-089][AS-119] public free-text ${scenario}, disclosure and sole route work through the actual console and projector`,async({browser})=>{
 const displayContext=await browser.newContext({viewport:{width:1280,height:720}});
 const facilitator=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}), display=await displayContext.newPage();
 // Twelve isolated offline installs overwhelm the local static fixture; this scenario measures online responses.
 // Paging retains service workers, and the dedicated offline suites cover cache installation and recovery.
 const phones=await Promise.all(Array.from({length:scenario === 'paging' ? 3 : 12}).map(()=>browser.newPage({serviceWorkers:scenario === 'paging' ? 'allow' : 'block',reducedMotion:'reduce',viewport:{width:390,height:844}})));
 const answers=['A '+ 'Review the evolving observations and compare the findings. '.repeat(10), 'B '+ '考虑新的观察结果并解释下一步行动。'.repeat(40), 'C <img src=x onerror=alert(1)> The final discussion answer'].map(s=>s.slice(0,500));
 try{
  await facilitator.goto(casesUrl(shell.origin));await facilitator.getByLabel('Email').fill('owner@example.invalid');
  await facilitator.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();await facilitator.getByLabel('One-time code').fill(otp);await facilitator.getByRole('button',{name:'Sign in',exact:true}).click();
  const created=shell.waitForCreatedRoom();await(await openCase(facilitator)).click();const room=await created;
  await display.goto(displayPairUrl('00000000',shell.origin));await expect(display.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  const code=(await display.locator('.pair-code').textContent()).replace(/\s/g,'');
  expect((await fetch(apiUrl(worker.origin,'sessions',room.sessionId,'display-pairs','approve'),{method:'POST',headers:{authorization:`Bearer ${room.facilitatorToken}`,'content-type':'application/json'},body:JSON.stringify({code})})).ok).toBe(true);
  await phoneBatches(phones,async phone=>{
   await phone.goto(joinUrl(room.joinCode,shell.origin));await phone.getByLabel('Your name',{exact:true}).fill('Private learner');await phone.getByRole('button',{name:'Join case',exact:true}).click();
   const lobby=phone.getByRole('heading',{name:'Waiting to start',exact:true}),recovery=phone.getByRole('heading',{name:'Answer storage unavailable',exact:true});
   // Cold isolated installs may reach the documented storage boundary. Exercise its
   // one public Retry action; a blank screen, persistent fault or duplicate join still fails.
   await expect(lobby.or(recovery)).toBeVisible();
   if(await recovery.isVisible()){await expect(phone.locator('body')).not.toContainText('Private learner');await phone.getByRole('button',{name:'Retry',exact:true}).click();}
   await expect(lobby).toBeVisible();
  });
  expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(phones.length);
  expect((await facilitatorCommand(worker.origin,room,'start')).receipt).toBe('accepted');
  for(let i=0;i<10&&(await serverMirror(worker.origin,room)).phase!=='responses_open';i++)expect((await facilitatorCommand(worker.origin,room,'advance')).receipt).toBe('accepted');
  if (scenario === 'paging') {
  for(const [i,phone] of phones.slice(0,3).entries()){
   await expect(phone.getByText('Responses are shown to the group without names after responses close. Do not include identifying details.',{exact:true})).toBeVisible();
   await phone.locator('#ftext').fill(answers[i]);await phone.getByRole('button',{name:'Send answer',exact:true}).click();
  }
  await expect.poll(async()=>Object.keys((await serverMirror(worker.origin,room)).round.responses).length).toBe(3);
  await expect(display.locator('.text-answer')).toHaveCount(0);
  await facilitator.getByRole('button',{name:'Lock responses & review',exact:true}).click();
  await expect(facilitator.getByRole('radio',{name:'Choose Decompress',exact:true})).toHaveAttribute('aria-checked','true');
  await expect(facilitator.getByRole('button',{name:/^Reveal:/})).toBeEnabled();
  expect((await serverMirror(worker.origin,room)).selectedPathId).toBeNull();
  for(const theme of ['light','dark']){
   await display.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await expect(display.locator('.text-answer')).toHaveText([answers[0]]);
   const geometry=await display.locator('.text-answer').evaluateAll(nodes=>nodes.map(n=>({bottom:n.getBoundingClientRect().bottom,width:n.scrollWidth,client:n.clientWidth,font:parseFloat(getComputedStyle(n).fontSize)})));
   for(const box of geometry){expect(box.bottom).toBeLessThanOrEqual(720);expect(box.width).toBeLessThanOrEqual(box.client+1);expect(box.font).toBeGreaterThanOrEqual(24);}
   expect((await new AxeBuilder({page:display}).analyze()).violations).toEqual([]);
  }
  await expect(display.locator('body')).not.toContainText('Private learner');
  expect(await display.locator('.text-result').evaluate(n=>n.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await display.locator('footer').evaluate(n=>n.getBoundingClientRect().top));
  await facilitator.getByRole('button',{name:'Next responses page',exact:true}).click();await expect(display.locator('.text-answer')).toHaveText([answers[1]]);
  expect(await display.locator('.text-result').evaluate(n=>n.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await display.locator('footer').evaluate(n=>n.getBoundingClientRect().top));
  await facilitator.getByRole('button',{name:'Next responses page',exact:true}).click();await expect(display.locator('.text-answer')).toHaveText([answers[2]]);
  await expect(facilitator.getByRole('button',{name:'Next responses page',exact:true})).toBeDisabled();
  await expect(display.locator('.text-answer img')).toHaveCount(0);
  await facilitator.getByRole('button',{name:'Previous responses page',exact:true}).click();await expect(display.locator('.text-answer')).toHaveText([answers[1]]);
  await facilitator.getByRole('button',{name:'Previous responses page',exact:true}).click();await expect(display.locator('.text-answer')).toHaveText([answers[0]]);
  await facilitator.getByRole('button',{name:'Hide responses on projector',exact:true}).click();await expect(display.locator('.text-answer')).toHaveCount(0);
  await facilitator.getByRole('button',{name:'Show responses on projector',exact:true}).click();await expect(display.locator('.text-answer')).toHaveText([answers[0]]);
  await display.screenshot({path:'/tmp/case-public-text-projector.png'});
  }
  if (scenario === 'twelve chips') {
  const shortAnswers=['Clarify the timeline','Compare observations','Other explanations','Recheck the history','Review the trend','What does not fit?','Check examination','Ask about exposure','Compare both legs','Review medication','Specialist advice','Reassess patient'];
  await phoneBatches(phones,async(phone,i)=>{
   await phone.locator('#ftext').fill(shortAnswers[i]);await phone.getByRole('button',{name:'Send answer',exact:true}).click();
  });
  await expect.poll(async()=>Object.keys((await serverMirror(worker.origin,room)).round.responses).length).toBe(12);
  await facilitator.getByRole('button',{name:'Lock responses & review',exact:true}).click();
  for(const [width,height] of [[1280,720],[1920,1080]])for(const theme of ['light','dark']){
   await display.setViewportSize({width,height});await display.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await expect(display.locator('.text-answer')).toHaveText([...shortAnswers].sort());
   // Resize renders replace the chips; query and measure in one task so captured nodes cannot detach between protocol calls.
   const boxes=await display.evaluate(()=>Array.from(document.querySelectorAll('.text-answer'),n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,radius:parseFloat(s.borderRadius),border:parseFloat(s.borderWidth),font:parseFloat(s.fontSize),clipped:n.scrollHeight>n.clientHeight||n.scrollWidth>n.clientWidth};}));
   expect(boxes).toHaveLength(12);
   for(const b of boxes){expect(b.radius).toBeGreaterThanOrEqual(6);expect(b.border).toBeGreaterThanOrEqual(1);expect(b.font).toBeGreaterThanOrEqual(24);expect(b.clipped).toBe(false);}
   // CASE-318: answers flow down columns; chips in a column, and the columns, stay at least 16px apart.
   const cols=[...new Set(boxes.map(b=>Math.round(b.x)))].sort((a,b)=>a-b);expect(cols.length).toBeGreaterThanOrEqual(2);
   for(const x of cols){const col=boxes.filter(b=>Math.round(b.x)===x);for(let i=1;i<col.length;i++)expect(col[i].y-col[i-1].bottom).toBeGreaterThanOrEqual(16);}
   for(let i=1;i<cols.length;i++)expect(cols[i]-Math.max(...boxes.filter(b=>Math.round(b.x)===cols[i-1]).map(b=>b.right))).toBeGreaterThanOrEqual(16);
   expect(await display.locator('.text-result').evaluate(n=>n.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await display.locator('footer').evaluate(n=>n.getBoundingClientRect().top));
   expect((await new AxeBuilder({page:display}).analyze()).violations).toEqual([]);
   await display.screenshot({path:`/tmp/case-response-chips-${width}-${theme}.png`});
  }

  }
  if (scenario === 'wide glyphs') {
  const dense=Array.from({length:12},(_,i)=>`${String(i).padStart(2,'0')} ${'观察'.repeat(8)}`);
  await phoneBatches(phones,async(phone,i)=>{await phone.locator('#ftext').fill(dense[i]);await phone.getByRole('button',{name:'Send answer',exact:true}).click();});
  await expect.poll(async()=>Object.keys((await serverMirror(worker.origin,room)).round.responses).length).toBe(12);
  await facilitator.getByRole('button',{name:'Lock responses & review',exact:true}).click();
  await display.setViewportSize({width:1280,height:720});await expect(display.locator('.text-answer')).toHaveText(dense);
  expect(await display.locator('.text-result').evaluate(n=>n.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await display.locator('footer').evaluate(n=>n.getBoundingClientRect().top));
  }
  if (scenario !== 'wide glyphs') {
   expect((await facilitatorCommand(worker.origin,room,'reopen')).receipt).toBe('accepted');
   await facilitator.getByRole('button',{name:'Lock responses & review',exact:true}).click();
  }
  await facilitator.getByRole('button',{name:/^Reveal:/}).click();await expect.poll(async()=>(await serverMirror(worker.origin,room)).phase).toBe('consequence_revealed');
 }finally{await Promise.allSettled([facilitator.close(),displayContext.close(),...phones.map(phone=>phone.close())]);}
});
