import { test,expect } from '@playwright/test';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import AxeBuilder from '@axe-core/playwright';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
test.use({ignoreHTTPSErrors:true});
let auth,worker,shell;
test.beforeAll(async()=>{auth=await startLocalAuthStub({appOrigin:null,jwt:null});worker=await startPublishedWorker({authOrigin:auth.origin});auth.setJwt(worker.jwt);shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:`${auth.origin}/auth/v1`,SUPABASE_JWKS_URL:`${auth.origin}/auth/v1/.well-known/jwks.json`}});auth.setAppOrigin(shell.origin);});
test.afterAll(async()=>{await shell?.stop();await worker?.stop();await auth?.stop();});
// The library's Preview runs a published version in the Run preview window (CASE-226): the same surface as the Builder,
// labelled with the version, on the memory-only room machine. Real Chromium, local published worker.
async function signIn(page){await page.goto(`${shell.origin}/cases`);await page.getByLabel('Email',{exact:true}).fill('owner@example.invalid');await page.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();await page.getByLabel('One-time code').fill('123456');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('link',{name:'Published case',exact:true}).click();}
async function open(page){
 await signIn(page);
 await page.evaluate(()=>{window.previewStorageBefore={local:{...localStorage},session:{...sessionStorage}};window.previewChannels=[];const Native=window.BroadcastChannel;window.BroadcastChannel=class extends Native{constructor(name){super(name);window.previewChannels.push(name);}};});
 await page.getByRole('button',{name:'Preview',exact:true}).click();
 const [child]=await Promise.all([page.waitForEvent('popup'),page.getByRole('dialog',{name:'Preview case',exact:true}).getByRole('button',{name:'Preview',exact:true}).click()]);
 await expect(child.getByRole('heading',{name:/^Preview · /})).toBeVisible();
 return child;
}
const stage=child=>child.frameLocator('iframe[title="Projector"]'),primary=child=>child.locator('.run-preview-rail .console-primary');

test('[AS-121] the library Preview runs the published version in the Run preview: Online and Manual, Reveal, Undo, no room effects',async({page},info)=>{
 const calls=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/sessions'))calls.push(r.url());});
 const child=await open(page);
 const before=await page.evaluate(()=>window.previewStorageBefore);
 const date=(await page.locator('.case-record').getByRole('button',{name:/· v\d+$/}).textContent()).replace(/\s*· v\d+$/,'');
 await expect(child.locator('.run-preview-status')).toContainText(`Published ${date}.`);
 await expect(child.locator('.run-preview-status')).not.toContainText(/Published version \d+/i);
 await expect(stage(child).locator('.joinpanel')).toContainText('No session code in a preview');
 for(const mode of ['Online','Manual']){
  await child.getByRole('group',{name:'Session mode',exact:true}).getByRole('button',{name:mode,exact:true}).click();
  await child.getByRole('button',{name:'Restart preview',exact:true}).click();
  await expect(primary(child)).toHaveText('Start case');
  for(let i=0;i<15;i++){const label=await primary(child).innerText();if(label==='Select a path')break;if(/Lock responses/.test(label)&&mode==='Online')await child.getByRole('button',{name:/Simulate answers/}).click();await primary(child).click();}
  await child.locator('.run-preview-rail .console-routes button').first().click();await expect(primary(child)).toHaveText(/^Reveal:/);await primary(child).click(); // a click is one press; only Space arms first (CASE-251)
  await expect(child.locator('select[aria-label="Jump to stage"]')).toHaveValue(/\|/);
  await child.locator('.run-preview-rail .console-undo').click();
  await expect(child.locator('select[aria-label="Jump to stage"]')).not.toHaveValue(/\|/);
 }
 expect(calls).toEqual([]);expect(await page.evaluate(()=>window.previewChannels)).toEqual([]);expect(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}))).toEqual(before);
 await child.screenshot({path:info.outputPath('run-preview-library.png'),fullPage:true});
 // Leaving the case closes the window; the case detail is unchanged behind it.
 const closed=child.waitForEvent('close');await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link').first().click();await closed;
});

test('[AS-121] Run preview fits narrow and wide windows in both themes with no axe violations',async({page})=>{
 const child=await open(page);
 for(const theme of ['light','dark'])for(const width of [390,768,1440]){
  await child.setViewportSize({width,height:900});await child.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await child.getByRole('button',{name:'Restart preview',exact:true}).click();
  expect(await child.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect((await new AxeBuilder({page:child}).include('.run-preview').exclude('iframe').analyze()).violations).toEqual([]);
 }
});

test('[AS-121] cross-tab sign-out closes the Run preview window',async({page,context})=>{
 const child=await open(page);const closed=child.waitForEvent('close');
 const other=await context.newPage();await other.goto(`${shell.origin}/cases`);await other.getByRole('button',{name:'Open menu',exact:true}).click();await other.getByRole('dialog',{name:'Menu',exact:true}).getByRole('button',{name:'Sign out',exact:true}).click();await other.getByRole('button',{name:'Confirm sign out',exact:true}).click();
 await closed;expect(child.isClosed()).toBe(true);
});

test('[AS-121] leaving the case fences a late pack: the closed window never receives private content',async({page})=>{
 let release;const held=new Promise(resolve=>{release=resolve;});let arrived;const reached=new Promise(resolve=>{arrived=resolve;});
 await page.route(url=>url.pathname.endsWith('/pack'),async route=>{const response=await route.fetch();arrived();await held;await route.fulfill({response});});
 await signIn(page);
 await page.getByRole('button',{name:'Preview',exact:true}).click();
 const [child]=await Promise.all([page.waitForEvent('popup'),page.getByRole('dialog',{name:'Preview case',exact:true}).getByRole('button',{name:'Preview',exact:true}).click()]);await reached;
 await expect(child.locator('.run-preview-status')).toContainText('Preparing preview');
 const closed=child.waitForEvent('close');await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link').first().click();await closed;release();
 await expect(page.getByRole('link',{name:'Published case',exact:true})).toBeVisible();
});

test('[AS-160] a long published case jumps to its last stage by replaying the whole route',async({page})=>{
 await page.route(url=>url.pathname.endsWith('/pack'),async route=>{const response=await route.fetch(),body=await response.json(),doc=body.document,first=doc.beats.find(b=>b.id===doc.start_beat_id);
  const added=Array.from({length:55},(_,i)=>({...first,id:uuidv7(),title:`Additional authored beat ${i+1}`}));added.forEach((b,i)=>{b.next_beat_id=added[i+1]?.id??first.id;});doc.start_beat_id=added[0].id;doc.beats.unshift(...added);expect(validateCaseDocument(doc)).toMatchObject({ok:true});await route.fulfill({response,json:body});
 });
 const child=await open(page);const jump=child.locator('select[aria-label="Jump to stage"]');
 const last=await jump.locator('option',{hasText:'Additional authored beat 55'}).getAttribute('value');
 await jump.selectOption(last, { force: true });
 await expect(child.locator('.run-preview-status')).toContainText('Replayed the route to Additional authored beat 55.');
 await expect(jump).toHaveValue(last);
});

test('[AS-121] pop-ups blocked: the library shows the same Run preview inline, styled, and Close preview removes it',async({page})=>{
 await page.addInitScript(()=>{window.open=()=>null;});
 await signIn(page);await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByRole('dialog',{name:'Preview case',exact:true}).getByRole('button',{name:'Preview',exact:true}).click();
 const inline=page.getByRole('region',{name:'Preview shown here',exact:true});await expect(inline).toBeVisible();
 const frame=page.locator('.builder-inline-preview-frame');
 expect((await frame.boundingBox()).height).toBeGreaterThan(400);
 const date=(await page.locator('.case-record').getByRole('button',{name:/· v\d+$/}).textContent()).replace(/\s*· v\d+$/,'');
 await expect(page.frameLocator('.builder-inline-preview-frame').locator('.run-preview-status')).toContainText(`Published ${date}.`);
 await expect(page.frameLocator('.builder-inline-preview-frame').locator('.run-preview-status')).not.toContainText(/Published version \d+/i);
 await inline.getByRole('button',{name:'Leave preview',exact:true}).click();await expect(inline).toBeHidden();await expect(frame).toHaveCount(0);
});
