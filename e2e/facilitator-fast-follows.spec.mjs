// Fast-follow end-user proof: built shell + real local Worker, disposable SQL/provider contracts only.
import {chooseOption} from '../tests/helpers/choose-option.mjs';
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
import {startHistoryHarness,signInHistory,forbidRoomClaims} from '../tests/helpers/history-controls.mjs';
import {assertNoHorizontalOverflow,openControlsDecision,mirror} from '../tests/helpers/live-console-controls.mjs';
import {caseVersionUrl} from '../src/shared/urls.mjs';
import {startAdminShell} from '../tests/helpers/admin-shell.mjs';
import {recordPage} from '../src/shared/session-record-wire.mjs';
test.describe.configure({mode:'serial'});
let h,a;
test.beforeAll(async()=>{h=await startHistoryHarness();a=await startAdminShell();});
test.afterAll(async()=>{await h?.stop();await a?.stop();});
for(const theme of ['light','dark'])test(`[AS-125] compact Cases and Account/History retain canonical controls at 320/390/768/1366/1920 in ${theme}`,async({browser},testInfo)=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,colorScheme:theme,reducedMotion:'reduce'});try{
  const page=await ctx.newPage(),claims=forbidRoomClaims(ctx);h.state.rows=h.makeRows(1,'Long teaching session title '.repeat(5));await signInHistory(page,h,'account');
  await expect(page.getByRole('heading',{name:'Your profile',exact:true})).toBeVisible();
  await expect(page.locator('.portfolio-stats')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Your access',exact:true})).toBeVisible();
  for(const width of [320,390,768,1366,1920]){await page.setViewportSize({width,height:1000});await assertNoHorizontalOverflow(page);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:testInfo.outputPath(`account-${theme}-${width}.png`)});}
  await page.getByRole('button',{name:'Open menu',exact:true}).click();const menu=page.getByRole('dialog',{name:'Menu',exact:true});
  await expect(menu.getByRole('link',{name:'Open account',exact:true})).toBeVisible();await expect(menu).not.toContainText('Opens a new tab');await expect(menu.getByRole('link',{name:'Present',exact:true})).not.toHaveAttribute('target','_blank');
  await menu.getByRole('button',{name:'Sign out',exact:true}).click();await expect(menu.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await menu.getByRole('button',{name:'Cancel',exact:true}).click();await expect(menu.getByRole('button',{name:'Sign out',exact:true})).toBeFocused();
  await menu.getByRole('link',{name:'Present',exact:true}).click();await expect(page.locator('.library-head')).toBeVisible();await expect(page.locator('.auth-panel')).toBeHidden();await expect(page.locator('.console-saved-notes')).toBeHidden();await expect(page.locator('.auth-form').getByRole('button',{name:'Sign out',exact:true})).toBeHidden();
  for(const width of [320,390,768,1366,1920]){await page.setViewportSize({width,height:1000});await assertNoHorizontalOverflow(page);await expect(page.locator('.library-head')).toBeVisible();await expect(page.locator('.library-toolbar')).toBeVisible();await expect(page.locator('.library-sections')).toHaveCount(0);await page.screenshot({path:testInfo.outputPath(`cases-${theme}-${width}.png`)});}
  await page.getByRole('button',{name:'Table',exact:true}).click();await page.setViewportSize({width:320,height:1000});await expect(page.locator('.case-stacked-list')).toBeVisible();await assertNoHorizontalOverflow(page);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(claims).toEqual([]);
 }finally{await ctx.close();}
});
test('[AS-128] ordered private export checks access, produces real PDF/JSON and isolates HTML print with teardown',async({browser})=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,reducedMotion:'reduce'});try{
  h.state.rows=h.makeRows(1,'Teaching café').map(r=>({...r,status:'ended',ended_at:r.created_at}));h.state.removed=false;h.state.foreign=false;const page=await ctx.newPage();await signInHistory(page,h);
  await page.locator('.portfolio-rows [data-session]').first().click();await expect(page.getByRole('heading',{name:'Session record',exact:true})).toBeVisible();await expect(page.locator('.session-detail')).toContainText('Limited archive evidence');await expect(page.getByRole('link',{name:'Rejoin session',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'Teach again: check this version',exact:true})).toHaveAttribute('href',caseVersionUrl(h.state.rows[0].case_id,h.state.rows[0].version_no,h.shell.origin));
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const jsonDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download JSON',exact:true}).click();const json=JSON.parse(await readFile(await (await jsonDownload).path(),'utf8'));expect(json.schema).toBe('case.session-record-export.v1');expect(json.part).toBe(1);expect(json.lastPart).toBe(true);expect(json.record.nextAfter).toBeNull();recordPage(json.record);expect(JSON.stringify(json)).not.toMatch(/participantId|displayName|facilitatorToken|PRIVATE_SENTINEL/);
  const pdfDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF',exact:true}).click();const pdf=await readFile(await (await pdfDownload).path());expect(pdf.subarray(0,8).toString()).toBe('%PDF-1.7');expect(pdf.toString()).toContain('/StructTreeRoot');
  const title=await page.title();await page.evaluate(()=>{window.print=()=>{window.printProof={text:document.querySelector('.private-session-print').textContent,title:document.title,isolated:document.body.classList.contains('printing-session-record'),classes:[...document.body.children].filter(e=>e.classList.contains('private-session-print')).map(e=>e.className)};};});await page.getByRole('button',{name:'Print accessible HTML',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Boolean(window.printProof))).toBe(true);const proof=await page.evaluate(()=>window.printProof);expect(proof.text).toContain('Teaching café');expect(proof.isolated).toBe(true);expect(proof.classes).toEqual(['private-session-print']);expect(proof.title).toBe(h.state.rows[0].title);await expect(page.locator('.private-session-print')).toHaveCount(0);expect(await page.title()).toBe(title);await page.emulateMedia({media:'screen'});
  h.state.removed=true;await page.getByRole('button',{name:'Download JSON',exact:true}).click();await expect(page.locator('.session-export-tools')).toContainText('Export cancelled');expect(h.calls('get_access').at(-1).args.p_case_id).toBe(h.state.rows[0].case_id);h.state.removed=false;
  await page.getByRole('button',{name:'Back to sessions',exact:true}).click();await expect(page.locator('.session-detail')).toHaveCount(0);await expect(page.locator('.portfolio-rows [data-session]').first()).toBeFocused();
 }finally{h.state.removed=false;await ctx.close();}
});
test('[AS-126] People verifies an elevated role change, the last-owner refusal and a fresh workspace audit at narrow width',async({browser})=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:1000},reducedMotion:'reduce'});try{
  const page=await ctx.newPage();await page.goto(a.origin+'/admin');await page.getByLabel('Email',{exact:true}).fill(a.email);await page.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();await page.getByLabel('One-time code',{exact:true}).fill(a.otp);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name:'People',exact:true})).toBeVisible();
  const drawer=page.getByRole('dialog',{name:'Selected record'}),dialog=page.locator('#adminConfirmation[open]');
  await page.getByRole('button',{name:'facilitator@example.invalid',exact:true}).click();await assertNoHorizontalOverflow(page);
  // The only owner cannot be removed: the dialog states it, the code is asked for once, and the refusal is said in words.
  await chooseOption(drawer.getByRole('combobox',{name:'Access in Teaching'}),'Remove from Teaching');await expect(dialog).toContainText('loses access to every case in Teaching');await dialog.getByRole('button',{name:'Email me a code',exact:true}).click();await dialog.getByLabel('Six-digit code',{exact:true}).fill(a.stepupCode);await dialog.getByRole('button',{name:'Remove access',exact:true}).click();
  await expect(dialog).toHaveCount(0);expect(a.state.membershipRevision??0).toBe(0);await expect(page.locator('.surface-toast').filter({hasText:'would leave the workspace without an owner'})).toBeVisible();
  await drawer.getByText('+ Add to a workspace',{exact:true}).click();await chooseOption(drawer.getByRole('combobox',{name:'Workspace to add to'}),'Bondi SLSC');await chooseOption(drawer.getByRole('combobox',{name:'Access to add'}),'Can manage');await drawer.getByRole('button',{name:'Add',exact:true}).click();await expect(dialog).toContainText('joins Bondi SLSC with Can manage access');await dialog.getByRole('button',{name:'Add person',exact:true}).click();await expect(dialog).toHaveCount(0);expect(a.state.membershipRevision).toBe(1);await expect(drawer.getByRole('combobox',{name:'Access in Bondi SLSC'})).toContainText('Can manage');
  const close=page.getByRole('button',{name:'Close record',exact:true});if(await close.isVisible())await close.click();await page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name:'Activity',exact:true}).click();await expect(page.locator('.workbench-rows')).toContainText('changed a member\u2019s role');await page.getByRole('button',{name:/changed a member\u2019s role/}).click();await expect(page.getByRole('dialog',{name:'Selected record'})).toContainText('Before');await assertNoHorizontalOverflow(page);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 }finally{await ctx.close();}
});

test('[AS-127] actual active history record rejoins only after fresh owner admission and preserves the authoritative room',async({browser})=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,reducedMotion:'reduce'});try{
  h.state.removed=h.state.foreign=false;
  const {page,room}=await openControlsDecision(ctx,h),before=await mirror(h,room);
  h.state.rows=h.makeRows(1,'Current running teaching').map(row=>({...row,session_id:room.sessionId,status:'live',expires_at:room.expiresAt,ended_at:null}));
  h.worker.fake.replies.set('list_owned_active_sessions',[{session_id:room.sessionId,join_code:room.joinCode,expires_at:room.expiresAt}]);
  let mints=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/facilitator-token'))mints++;});
  await page.getByRole('button',{name:'Open menu',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:'Sessions',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sessions',exact:true})).toBeVisible();await page.locator('.portfolio-rows [data-session]').first().click();await expect(page.getByRole('link',{name:'Rejoin session',exact:true})).toBeVisible();expect(mints).toBe(0);
  await page.getByRole('link',{name:'Rejoin session',exact:true}).click();await expect(page.getByRole('button',{name:/^Rejoin session ·/})).toBeVisible();expect(mints).toBe(0);
  await page.getByRole('button',{name:/^Rejoin session ·/}).click();await expect(page.locator('.console-phase')).toHaveAttribute('data-phase','responses_open');expect(mints).toBe(1);
  const after=await mirror(h,room);expect(after.revision).toBe(before.revision);expect(after.epoch).toBe(before.epoch);
 }finally{h.worker.fake.replies.delete('list_owned_active_sessions');await ctx.close();}
});
