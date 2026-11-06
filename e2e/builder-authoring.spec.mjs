import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { uuidv7 } from '../src/shared/ids.mjs';
import { createBuilderStarter } from '../src/client/builder-templates.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { settled } from '../tests/helpers/settled.mjs';

test.use({ ignoreHTTPSErrors: true });
let auth,worker,shell;
test.beforeAll(async()=>{
  auth=await startLocalAuthStub({appOrigin:null,jwt:null});worker=await startPublishedWorker({authOrigin:auth.origin});auth.setJwt(worker.jwt);
  shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:`${auth.origin}/auth/v1`,SUPABASE_JWKS_URL:`${auth.origin}/auth/v1/.well-known/jwks.json`}});auth.setAppOrigin(shell.origin);
});
test.afterAll(async()=>{await shell?.stop();await worker?.stop();await auth?.stop();});
// Checkpoints, Transfer and review, and Case details live in the app bar's More menu (Round 4 study).
// Case details is in More (CASE-321); preparation, first stage and new-case setup sit under its Advanced settings.
const caseDetails=async page=>{await more(page,'Case details');await page.locator('.builder-case-advanced > summary').click();};
const more=async(page,name)=>{await page.getByRole('button',{name:'More',exact:true}).click();await page.getByRole('group',{name:'More',exact:true}).getByRole('button',{name,exact:true}).click();};
async function enter(page,type='single_choice',{newCase=false,testInfo=null,collectionOnly=false,openDetails=true}={}){
  const caseId=worker.caseId, workspaceId=worker.workspaceId;
  const starter=createBuilderStarter(type);starter.document.title='Private writing exercise';starter.document.surfaces[0].scene='Opening source text';
  const cases=new Map([[caseId,{title:starter.document.title,revision:1,pair:{document:starter.document,authoringMetadata:starter.authoringMetadata}}]]);
  const windows=new Map(),receipts=new Map(),checkpoints=new Map(),writes=[],created=[],pending=[];let hold=false;
  const reply=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  const copy=value=>structuredClone(value);
  const context=id=>({case:{capabilities:['slide_composition'],caseId:id,workspaceId,role:'owner',title:cases.get(id)?.title??'Untitled case',sourceVersion:null}});
  await page.route(url=>url.pathname==='/api/v1/cases'&&url.search==='',async route=>{
    if(route.request().method()!=='POST')return reply(route,{error:'not_found'},404);
    const body=route.request().postDataJSON();if(body.workspaceId!==workspaceId||!body.title)return reply(route,{error:'bad_request'},400);
    const id=uuidv7();cases.set(id,{title:body.title,revision:0,pair:null});created.push({id,...body});return reply(route,{caseId:id},201);
  });
  await page.route(url=>url.pathname.startsWith('/api/v1/builder/'),async route=>{
    const url=new URL(route.request().url()),method=route.request().method(),body=method==='GET'?null:route.request().postDataJSON();
    const match=/^\/api\/v1\/builder\/cases\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(url.pathname);
    if(!match)return route.fallback();
    const id=match[1],suffix=match[2]??'';let state=cases.get(id);
    if(!state){state={title:'Untitled case',revision:0,pair:null};cases.set(id,state);}
    let owned=checkpoints.get(id);if(!owned){owned=[];checkpoints.set(id,owned);}
    if(suffix==='draft'&&method==='GET')return reply(route,state.revision===0
      ?{...context(id),revision:0,draft:null}
      :{...context(id),revision:state.revision,draft:{revision:state.revision,...copy(state.pair),intentDigest:'\\x'+'a'.repeat(64)}});
    if(suffix==='save-windows'&&method==='POST'){
      if(body.baseRevision!==state.revision)return reply(route,{error:'revision_conflict'},409);
      const operationId=uuidv7();windows.set(operationId,{caseId:id,baseRevision:state.revision});return reply(route,{operationId,baseRevision:state.revision});
    }
    if(suffix==='draft'&&method==='PUT'){
      const window=windows.get(body.operationId);
      if(!window||window.caseId!==id||window.baseRevision!==state.revision)return reply(route,{error:'revision_conflict'},409);
      const checked=validateBuilderDocument(body.document,body.authoringMetadata,{mode:'preserve',validateSlides:validateSlideParts});
      if(!checked.ok)return reply(route,{error:'invalid_draft',issues:checked.errors},422);
      writes.push({caseId:id,...copy(body)});state.pair={document:copy(body.document),authoringMetadata:copy(body.authoringMetadata)};
      state.title=body.document.title;state.revision++;
      const receipt={operationId:body.operationId,revision:state.revision,intentDigest:'\\x'+'a'.repeat(64),status:'saved'};receipts.set(body.operationId,receipt);if(hold)await new Promise(resolve=>pending.push(resolve));return reply(route,receipt);
    }
    if(suffix==='checkpoints'&&method==='GET')return reply(route,{checkpoints:owned.map(({pair,...item})=>item)});
    if(suffix==='checkpoints'&&method==='POST'){
      if(body.expectedRevision!==state.revision||!state.pair)return reply(route,{error:'revision_conflict'},409);
      // As the database: three checkpoints per case (checkpoint_limit), named by the Worker (D12).
      if(owned.length>=3)return reply(route,{error:'checkpoint_limit'},409);
      const checkpoint={id:uuidv7(),name:body.name,revision:state.revision,schemaVersion:2,createdAt:new Date().toISOString(),pair:copy(state.pair)};owned.push(checkpoint);
      return reply(route,{id:checkpoint.id,name:checkpoint.name,revision:checkpoint.revision,schemaVersion:checkpoint.schemaVersion,createdAt:checkpoint.createdAt});
    }
    const restore=suffix.match(/^checkpoints\/([0-9a-f-]{36})\/restore$/);
    if(restore&&method==='POST'){
      const checkpoint=owned.find(item=>item.id===restore[1]),window=windows.get(body.operationId);
      if(!checkpoint||!window||window.caseId!==id||window.baseRevision!==state.revision)return reply(route,{error:'revision_conflict'},409);
      state.pair=copy(checkpoint.pair);state.revision++;state.title=state.pair.document.title;
      const receipt={operationId:body.operationId,revision:state.revision,intentDigest:'\\x'+'a'.repeat(64),status:'restored'};receipts.set(body.operationId,receipt);return reply(route,receipt);
    }
    const checkpointDelete=suffix.match(/^checkpoints\/([0-9a-f-]{36})$/);
    if(checkpointDelete&&method==='DELETE'){const n=owned.findIndex(item=>item.id===checkpointDelete[1]);if(n<0)return reply(route,{error:'not_found'},404);owned.splice(n,1);return reply(route,{id:checkpointDelete[1],deleted:true});}
    const receipt=suffix.match(/^save-windows\/([0-9a-f-]{36})$/);
    if(receipt&&method==='GET'){
      const saved=receipts.get(receipt[1]);if(saved)return reply(route,saved);
      const window=windows.get(receipt[1]);return window?reply(route,{operationId:receipt[1],baseRevision:window.baseRevision,status:'issued',expiresAt:new Date(Date.now()+60_000).toISOString()}):reply(route,{error:'not_found'},404);
    }
    return reply(route,{error:'not_found'},404);
  });
  await page.goto(`${shell.origin}${newCase?'/cases/new':'/cases'}`);
  await page.getByLabel('Email',{exact:true}).fill('owner@example.invalid');await page.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();
  await page.getByLabel('One-time code').fill('123456');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  if(newCase){
    await expect(page.getByRole('heading',{name:'Create a case draft',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Email me a sign-in code',exact:true})).toBeHidden();
    await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeHidden();
    if(type==='single_choice'){
      for(const theme of ['light','dark'])for(const width of [320,390,768,1280]){
        await page.setViewportSize({width,height:900});await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      }
      const targets=await page.locator('.builder-new-case-form button,.builder-new-case-form input,.builder-new-case-form select').evaluateAll(nodes=>nodes
        .filter(node=>node.getClientRects().length&&node.type!=='hidden'&&node.type!=='checkbox'&&node.type!=='radio')
        .map(node=>({name:node.labels?.[0]?.innerText||node.innerText||node.type||node.tagName,rect:node.getBoundingClientRect().toJSON()}))
        .filter(({rect})=>rect.width<32||rect.height<32));
      expect(targets).toEqual([]);
      await page.setViewportSize({width:1280,height:900});
      if(testInfo)await page.screenshot({path:testInfo.outputPath('builder-new-case-desktop.png'),fullPage:true});
    }
    await page.getByLabel('Case title',{exact:true}).fill('New Builder case');
    await expect(page.locator('.builder-new-case-form select')).toHaveCount(1);
    await page.getByRole('button',{name:'Create case draft',exact:true}).click();
  }else if(!collectionOnly){
    await page.getByRole('link',{name:'Published case',exact:true}).click();await page.getByRole('button',{name:'Edit case',exact:true}).click();
  }
  if(!collectionOnly){
    await expect(page.locator('.builder-studio')).toBeVisible();
    if(openDetails)await caseDetails(page);
  }
  return {writes,created,cases,getPair(id=caseId){return copy(cases.get(id)?.pair??null);},state(id=caseId){return copy(cases.get(id));},checkpoints(id=caseId){return copy(checkpoints.get(id)??[]);},addCheckpoint(name,id=caseId){const owned=checkpoints.get(id)??[];checkpoints.set(id,owned);const state=cases.get(id);owned.push({id:uuidv7(),name,revision:state.revision,schemaVersion:2,createdAt:new Date().toISOString(),pair:copy(state.pair)});},receipt(id){return copy(receipts.get(id)??null);},ids(){return [...cases.keys()];},hold(){hold=true;},release(){hold=false;for(const release of pending.splice(0))release();}};
}

// CASE-225: the Builder's dropdowns are Case's own; each keeps its native select (hidden) as the value and change
// contract, so tests drive that select directly. One test below also operates the visible dropdown.
const choose = (scope, label, value) => scope.locator(`select[aria-label="${label}"]`).first().selectOption(value, { force: true });

test('[AS-124] served save freezes the submitted pair, preserves later typing and reloads the acknowledged result',async({page})=>{
  // The in-page rehearsal is the Preview fallback when the window is blocked (Inspect merged into Preview); block it here.
  await page.addInitScript(() => { window.open = () => null; });
  const model=await enter(page,'single_choice',{openDetails:false}),studio=page.locator('.builder-studio'),scene=studio.getByLabel('Learner scene',{exact:true});
  const text='Long source passage. '.repeat(150);
  await scene.fill(text);model.hold();await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect.poll(()=>model.writes.length).toBe(1);
  await scene.fill(text+' Later writing');model.release();
  await expect(scene).toHaveValue(text+' Later writing');await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
  expect(model.writes[0].document.surfaces[0].scene).toBe(text);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>model.writes.length).toBe(2);
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
  // A write counted by the mock is not yet a clean client: reload only once it shows Saved, or its beforeunload guard
  // cancels the reload (PR232 shard 4). Save draft is also disabled while a save is still in flight.
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  await page.reload();await expect(page.locator('.builder-studio').getByLabel('Learner scene',{exact:true})).toHaveValue(text+' Later writing');
  // Readiness is a counted context under the stage; opening it lists every repair.
  await page.locator('.builder-studio .builder-zone-readiness > summary').click();
  await expect(page.locator('.builder-issues li').first()).toBeVisible();
  // The direct preview URL shows the Run preview inline (CASE-226); a draft that cannot run says why, and nothing changes.
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit/preview`);
  await expect(page.getByRole('region',{name:'Private preview shown here',exact:true})).toBeVisible();
  // The status line says the run waits; the projector's place says why in words, not as an empty frame (round 21),
  // and "cannot run" is said once (r23 P3).
  await expect(page.frameLocator('.builder-inline-preview-frame').locator('.run-preview-status')).toHaveText('Waiting for a runnable draft.');
  await expect(page.frameLocator('.builder-inline-preview-frame').locator('.run-preview-blocked')).toContainText('This draft cannot run yet.');
  expect(await page.frameLocator('.builder-inline-preview-frame').locator('body').innerText().then(text => text.match(/cannot run/g)?.length)).toBe(1);
  await expect(page.frameLocator('.builder-inline-preview-frame').locator('.run-preview-frame').first()).toBeHidden();
  expect(model.getPair().document.surfaces[0].scene).toBe(text+' Later writing');
});

test('Builder keeps the editor readable and opens the Run preview inline at its direct URL with a direct return',async({page})=>{
  await enter(page,'single_choice',{openDetails:false});
  const studio=page.locator('.builder-studio'),workspace=studio.locator('.builder-workspace');
  const details=studio.locator('.builder-global-details');
  // Case details is its own view (in More); the slide view never carries it.
  await expect(details).toBeHidden();
  await caseDetails(page);
  await expect(details).toBeVisible();
  await expect(details.getByRole('button',{name:'Add learning objective',exact:true})).toBeVisible();
  // Case's own dropdown, operated by keyboard: arrows open it and move, Enter commits, focus stays on the control.
  const firstStage=details.getByRole('combobox',{name:'First teaching stage',exact:true});
  const chosen=details.locator('select[aria-label="First teaching stage"]');
  const before=await chosen.inputValue();
  await firstStage.focus();
  await firstStage.press('ArrowDown');
  await expect(page.getByRole('listbox',{name:'First teaching stage'})).toBeVisible();
  await firstStage.press('ArrowDown');await firstStage.press('Enter');
  await expect(chosen).not.toHaveValue(before);
  await expect(firstStage).toBeFocused();
  await expect(details).toBeVisible();
  // [AS-192] The Overview (CASE-321) has its own address: the case at a glance, its flow, and every branch opens its slide.
  await studio.getByRole('button',{name:'Overview',exact:true}).click();
  // A published case's draft keeps its source version in the address (caseEditSourceViewUrl).
  await expect(page).toHaveURL(new RegExp(`/cases/${worker.caseId}/edit(/source/[0-9a-f-]+/\\d+)?/overview$`));
  const overview=studio.getByRole('region',{name:'Case overview',exact:true});
  await expect(overview.locator('.builder-overview-title')).toHaveText('Private writing exercise');
  await expect(overview.locator('.builder-overview-counts .tag').nth(0)).toHaveText(/^\d+ slides?$/);
  await expect(overview.locator('.builder-overview-counts .tag').nth(1)).toHaveText(/^\d+ questions?$/);
  await expect(overview.getByRole('region',{name:'Before you publish',exact:true})).toBeVisible();
  const firstBranch=overview.locator('.builder-flow-branch').first();
  await expect(firstBranch).not.toContainText(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
  await expect(firstBranch).toHaveAttribute('data-classification',/./);
  await firstBranch.click();
  await expect(studio.getByLabel('Consequence name',{exact:true})).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/cases/${worker.caseId}/edit(/source/[0-9a-f-]+/\\d+)?$`));
  // Back and Forward move between the Overview and the slide it opened.
  await page.goBack();await expect(overview).toBeVisible();
  await page.goForward();await expect(studio.getByLabel('Consequence name',{exact:true})).toBeVisible();
  // The consequence chosen above is shown under a breadcrumb back to its stage.
  await expect(studio.locator('.builder-canvas-location .builder-crumb')).toBeVisible();
  // The direct preview URL is a launcher (CASE-226): the Run preview inline below the slide, the editor still beside it.
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit/preview`);
  const inline=page.getByRole('region',{name:'Private preview shown here',exact:true});
  await expect(inline).toBeVisible();
  await expect(workspace).toBeVisible();
  await expect(page.frameLocator('.builder-inline-preview-frame').locator('.run-preview-status')).toHaveText('Waiting for a runnable draft.');
  await inline.getByRole('button',{name:'Leave preview',exact:true}).click();
  await expect(inline).toBeHidden();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(studio.getByLabel('Slide title',{exact:true})).toBeVisible();
});

for(const type of ['single_choice','multi_select','ranking','free_text'])test(`served ${type} template retains its own interaction and private writing through save`,async({page})=>{
  const model=await enter(page,type),studio=page.locator('.builder-studio');
  await studio.getByLabel('Private preparation requirements',{exact:true}).fill('Private preparation sentinel');
  await expect.poll(()=>model.writes.length).toBe(1);
  expect(model.getPair().document.decisions[0].interaction.type).toBe(type);
  expect(model.getPair().authoringMetadata.preparation_requirements).toBe('Private preparation sentinel');
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
});

test('served incomplete editor supports keyboard and responsive themes without accessibility violations',async({page},testInfo)=>{
  await enter(page);
  for(const theme of ['light','dark'])for(const width of [320,390,768,1280]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    // Regions settle after the browser reports the new size (ResizeObserver), then geometry is measured.
    await expect(page.locator('.builder-workspace')).toHaveAttribute('data-layout',width<912?'single':'wide');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    // Outline (card 50): readable 44px targets, captions inside their buttons, no overflow and no chip over a caption (BWA33).
    // In one-region layouts the Outline is opened explicitly, measured, then the Slide is restored.
    const regionNav=page.locator('.builder-regions');
    if(width<912)await regionNav.getByRole('button',{name:'Outline',exact:true}).click();
    const outline = await page.locator('.builder-outline').evaluate(nav => nav.hidden ? null : ({
      escaped: [...nav.querySelectorAll('li:not([hidden]) .builder-outline-target')].filter(button => {
        const outer = button.getBoundingClientRect(), inner = button.querySelector('.builder-outline-name').getBoundingClientRect();
        return inner.left < outer.left - 1 || inner.right > outer.right + 1 || inner.bottom > outer.bottom + 1;
      }).length,
      overflow: nav.scrollWidth - nav.clientWidth,
      bad: [...nav.querySelectorAll('li:not([hidden]) button')].filter(button => button.getBoundingClientRect().height < 32).map(button => button.textContent),
      overlaps: [...nav.querySelectorAll('.builder-outline-foot button')].filter(chip => {
        const a = chip.getBoundingClientRect(), b = chip.closest('li').querySelector('.builder-outline-name').getBoundingClientRect();
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      }).length,
    }));
    expect(outline).not.toBeNull();
    expect(outline.overflow).toBeLessThanOrEqual(1); expect(outline.bad).toEqual([]); expect(outline.overlaps).toBe(0); expect(outline.escaped).toBe(0);
    if(width<912)await regionNav.getByRole('button',{name:'Slide',exact:true}).click();
    const design = await page.locator('.builder-studio').evaluate(studio => {
      const root = getComputedStyle(document.documentElement), field = studio.querySelector('input'), danger = studio.querySelector('.builder-danger');
      const style = getComputedStyle(danger), probe = document.createElement('span');
      probe.style.color='var(--alert)'; studio.append(probe); const alertColor=getComputedStyle(probe).color;probe.remove();
      return { font: getComputedStyle(studio).fontFamily, bodyFont: getComputedStyle(document.body).fontFamily,
        radius: getComputedStyle(field).borderRadius, controlRadius: root.getPropertyValue('--radius-sm').trim(),
        dangerBackground: style.backgroundColor, dangerBorder: style.borderColor,
        expectedDanger: alertColor,
        smallTargets: [...studio.querySelectorAll('button')].filter(button => { const r=button.getBoundingClientRect();return r.width>0&&r.height>0&&(r.width<32||r.height<32); }).map(button=>button.textContent) };
    });
    expect(design.font).toBe(design.bodyFont); expect(design.radius).toBe(design.controlRadius);
    expect(design.dangerBackground).toBe('rgba(0, 0, 0, 0)'); expect(design.dangerBorder).toBe(design.expectedDanger); expect(design.smallTargets).toEqual([]);
    const title = page.locator('.builder-studio').getByLabel('Case title',{exact:true});
    await title.focus(); await expect(title).toHaveCSS('outline-width','3px'); await expect(title).toHaveCSS('outline-offset','2px');

    // The one-region switch fades the region in (140 ms); contrast is read once it has settled, never mid-fade (CASE-249).
    await settled(page);
    expect((await new AxeBuilder({page}).include('.builder-studio').analyze()).violations).toEqual([]);
  }
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await page.screenshot({path:testInfo.outputPath('builder-studio-mobile.png'),fullPage:true});
  await page.locator('.builder-studio').getByLabel('Case title',{exact:true}).focus();
  await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
});

test('served /cases/new creates a blank modern story and autosaves its private draft',async({page},testInfo)=>{
  const model=await enter(page,'single_choice',{newCase:true,testInfo}),studio=page.locator('.builder-studio');
  expect(model.created).toHaveLength(1);
  expect(model.created[0]).toMatchObject({workspaceId:worker.workspaceId,title:'New Builder case'});
  await expect(studio.getByLabel('Case title',{exact:true})).toHaveValue('New Builder case');
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
  await expect.poll(()=>model.writes.length).toBe(1);
  expect(model.writes[0].caseId).toBe(model.created[0].id);
  expect(model.writes[0].document.schema_version).toBe(3); expect(model.writes[0].document.decisions).toHaveLength(0); expect(model.writes[0].document.beats).toHaveLength(1);
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
});

test('served scratch action creates a separate case and leaves the prior saved case intact',async({page})=>{
  const model=await enter(page),original=worker.caseId,originalBefore=model.getPair(original);
  const studio=page.locator('.builder-studio');
  await studio.getByRole('button',{name:'Start from scratch',exact:true}).click();
  await studio.getByRole('group',{name:'Review new draft',exact:true}).getByRole('button',{name:'Create this new case',exact:true}).click();
  await expect.poll(()=>model.created.length).toBe(1);
  await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
  const createdId=model.created[0].id;
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect.poll(()=>model.writes.filter(write=>write.caseId===createdId).length).toBe(1);
  expect(model.getPair(original)).toEqual(originalBefore);
  expect(model.getPair(createdId).document.schema_version).toBe(3); expect(model.getPair(createdId).document.decisions).toHaveLength(0);
});

test('native formatted field keeps selection, browser Undo, composition events and plain-text paste semantics',async({page})=>{
  const model=await enter(page,'single_choice',{openDetails:false}),studio=page.locator('.builder-studio');
  await choose(studio,'Text with formatting',{label:'Learner scene'});
  await studio.getByRole('button',{name:'Turn on bold and lists for Learner scene',exact:true}).click();
  const field=studio.getByRole('textbox',{name:'Learner scene',exact:true});
  await expect(field).toBeVisible();await field.click();await page.keyboard.insertText('Native undo probe');
  const undoModifier=process.platform==='darwin'?'Meta':'Control';
  await page.keyboard.press(`${undoModifier}+z`);await expect(field).not.toContainText('Native undo probe');
  await page.keyboard.press(`${undoModifier}+Shift+z`);await expect(field).toContainText('Native undo probe');
  await page.keyboard.press('End');await page.keyboard.insertText(' —');
  // This validates the browser composition-event contract; it does not stand in for physical OS IME testing.
  await field.evaluate(element=>{
    element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    document.execCommand('insertText',false,' 漢字');
    element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:' 漢字'}));
  });
  await expect(field).toContainText('Native undo probe — 漢字');
  await field.evaluate(element=>{
    const textNode=[...element.childNodes].find(node=>node.nodeType===Node.TEXT_NODE)??element.querySelector('p,div')?.firstChild;
    if(!textNode||textNode.nodeType!==Node.TEXT_NODE)throw new Error('No first text node to select.');
    const range=document.createRange();range.setStart(textNode,0);range.setEnd(textNode,6);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await studio.getByRole('button',{name:'Bold selection',exact:true}).click();
  await expect(field.locator('strong,b').first()).toContainText('Openin');
  await studio.getByRole('button',{name:'Undo format',exact:true}).click();
  await expect(field.locator('strong,b')).toHaveCount(0);
  await field.evaluate(element=>{
    const textNode=[...element.querySelectorAll('p,div')].flatMap(node=>[...node.childNodes]).find(node=>node.nodeType===Node.TEXT_NODE);
    if(!textNode)throw new Error('No paragraph text to select.');
    const range=document.createRange();range.setStart(textNode,0);range.setEnd(textNode,6);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await studio.getByRole('button',{name:'Bold selection',exact:true}).click();
  await studio.getByRole('button',{name:'Make bulleted list',exact:true}).click();
  await field.evaluate(element=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let last=null;while(walker.nextNode())last=walker.currentNode;
    if(!last)throw new Error('No list text to place the caret after.');
    const range=document.createRange();range.setStart(last,last.nodeValue.length);range.collapse(true);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await field.evaluate(element=>{
    const data=new DataTransfer();data.setData('text/plain','plain clipboard item');data.setData('text/html','<img src=x onerror=alert(1)>');
    element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  await expect(studio.getByRole('status').last()).toContainText('Clipboard formatting and other content were not imported');
  await expect(field.locator('img,script')).toHaveCount(0);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>model.writes.length).toBe(1);
  const saved=model.getPair().document.surfaces[0].scene;
  expect(saved.blocks[0].type).toBe('list');expect(saved.blocks[0].ordered).toBe(false);
  expect(saved.blocks[0].items[0].runs.some(run=>run.text==='Openin'&&run.bold===true)).toBe(true);
  expect(JSON.stringify(saved)).toContain('plain clipboard item');
  expect(JSON.stringify(saved)).not.toContain('<img');
});

test('checkpoint restores the named saved pair as a new revision after reload',async({page})=>{
  const model=await enter(page,'single_choice',{openDetails:false}),studio=page.locator('.builder-studio'),scene=studio.getByLabel('Learner scene',{exact:true});
  await scene.fill('Checkpoint source text');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>model.writes.length).toBe(1);
  // D1/D2 (round 24): no native prompt; one in-page panel, refreshed in place, with a labelled name field that refuses rather than truncates.
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});
  await more(page,'Manage checkpoints');await more(page,'Manage checkpoints');
  const panel=studio.getByRole('region',{name:'Saved checkpoints',exact:true});await expect(panel).toHaveCount(1);
  const name=panel.getByRole('textbox',{name:'Checkpoint name',exact:true});await expect(name).toBeFocused();
  const long='A checkpoint name that runs well past the sixty character limit';expect(long.length).toBeGreaterThan(60);
  await name.fill(long);await expect(panel.getByText(`${long.length} of 60 characters: shorten the name to create it.`,{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Create checkpoint',exact:true}).click();
  expect(model.checkpoints()).toHaveLength(0);await expect(name).toHaveValue(long);await expect(name).toHaveAttribute('aria-invalid','true');
  await name.fill('Writing checkpoint');await name.press('Enter');
  await expect(page.locator('.builder-studio-status')).toContainText(/Checkpoint “Writing checkpoint” created/);
  await expect(studio.getByText(/Checkpoint “Writing checkpoint” created/)).toHaveCount(1);
  await expect(studio.getByRole('region',{name:'Saved checkpoints',exact:true})).toHaveCount(1);
  await expect(panel.locator('.builder-checkpoint-row')).toHaveCount(1);await expect(panel.getByText('No checkpoints yet.')).toHaveCount(0);
  expect(model.checkpoints().map(item=>item.name)).toEqual(['Writing checkpoint']);expect(dialogs).toEqual([]);
  await scene.fill('Later text to replace');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>model.writes.length).toBe(2);
  // Clean before the reload: the dialog handler above dismisses a beforeunload guard, which would cancel it (PR232 shard 4).
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  await page.reload();
  const reloaded=page.locator('.builder-studio');await expect(reloaded.getByLabel('Learner scene',{exact:true})).toHaveValue('Later text to replace');
  await more(page,'Manage checkpoints');
  const row=reloaded.locator('.builder-checkpoint-row').filter({hasText:'Writing checkpoint'});
  await expect(row).toBeVisible();await row.getByRole('button',{name:'Restore Writing checkpoint',exact:true}).click();
  await reloaded.getByRole('group',{name:'Review checkpoint restore',exact:true}).getByRole('button',{name:'Restore as new revision',exact:true}).click();
  await expect(reloaded.getByLabel('Learner scene',{exact:true})).toHaveValue('Checkpoint source text');
  expect(model.state().revision).toBe(4);
});


test('D12: a case keeps three checkpoints; the panel says so plainly, disables Create at the limit and never shows a raw code',async({page})=>{
  const model=await enter(page,'single_choice',{openDetails:false}),studio=page.locator('.builder-studio');
  await studio.getByLabel('Learner scene',{exact:true}).fill('Checkpoint limit text');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>model.writes.length).toBe(1);
  await more(page,'Manage checkpoints');
  const panel=studio.getByRole('region',{name:'Saved checkpoints',exact:true}),name=panel.getByRole('textbox',{name:'Checkpoint name',exact:true}),create=panel.getByRole('button',{name:'Create checkpoint',exact:true});
  await expect(panel).toContainText('0 of 3 checkpoints kept.');
  for(const label of ['First','Second']){await name.fill(label);await create.click();await expect(panel.locator('.builder-checkpoint-row')).toHaveCount(['First','Second'].indexOf(label)+1);}
  await expect(panel).toContainText('2 of 3 checkpoints kept.');await expect(create).toBeEnabled();
  // Full since the panel was drawn (another tab): the refusal is said in words and the panel redraws at the limit.
  model.addCheckpoint('From another tab');
  await name.fill('Third');await create.click();
  await expect(panel.locator('.builder-checkpoint-note')).toHaveText('3 of 3 checkpoints. Delete one to save another.');
  await expect(page.locator('.builder-studio-status')).toHaveText('3 of 3 checkpoints. Delete one to save another.');
  await expect(create).toBeDisabled();await expect(panel.locator('.builder-checkpoint-row')).toHaveCount(3);
  await expect(studio.getByText('request_unavailable')).toHaveCount(0);
  expect(model.checkpoints().map(item=>item.name)).toEqual(['First','Second','From another tab']);
  // Deleting one frees a slot: Create is offered again.
  await panel.getByRole('button',{name:'Delete First',exact:true}).click();
  await studio.getByRole('group',{name:'Review checkpoint deletion',exact:true}).getByRole('button',{name:'Delete checkpoint',exact:true}).click();
  await expect(panel.locator('.builder-checkpoint-row')).toHaveCount(2);await expect(create).toBeEnabled();
  await expect(panel).toContainText('2 of 3 checkpoints kept.');
});

test('[AS-125] authoring discovery preserves admin/owner/author authority and refuses facilitator draft URLs',async({browser},testInfo)=>{
 for(const role of ['admin','owner','author','facilitator']){
  const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:900},reducedMotion:'reduce'});try{
   const page=await ctx.newPage();let draftReads=0;
   await page.route(url=>url.pathname==='/api/v1/me',route=>route.fulfill({json:{profile:{user_id:worker.userId},memberships:[{workspace_id:worker.workspaceId,role,name:'Teaching'}],nextAfter:null,account:{email:'owner@example.invalid',administration:role==='admin'}}}));
   await page.route(url=>url.pathname.endsWith('/drafts'),route=>{draftReads++;return route.fulfill({json:{workspaceId:worker.workspaceId,drafts:[{caseId:worker.caseId,title:'Private writing exercise',revision:1,updatedAt:'2026-10-09T12:00:00.000Z'}],limit:50,offset:0,nextOffset:1,hasMore:false}});});
   await enter(page,'single_choice',{collectionOnly:true});await page.getByRole('button',{name:'Open menu',exact:true}).click();const menu=page.getByRole('dialog',{name:'Menu',exact:true});
   await expect(menu.locator('.site-account-email')).toHaveText('owner@example.invalid');
   if(role==='facilitator'){
    await expect(menu.getByRole('link',{name:'Create',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Close menu',exact:true}).click();await expect(page.getByRole('link',{name:'Drafts',exact:true})).toBeHidden();await expect(page.getByRole('button',{name:'New case',exact:true})).toBeHidden();
    await page.goto(shell.origin+'/cases?view=drafts');await expect(page.locator('.library')).toContainText('does not grant draft access');expect(draftReads).toBe(0);await page.goto(shell.origin+'/cases/new');await expect(page.getByRole('button',{name:'Create case draft',exact:true})).toBeDisabled();continue;
   }
   await expect(menu.getByRole('link',{name:'Create',exact:true})).toBeVisible();await menu.getByRole('link',{name:'Create',exact:true}).press('Enter');await expect(page).toHaveURL(/\/create(?:\?|$)/);await expect(page.getByRole('button',{name:'New case',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Grid',exact:true})).toBeHidden();await expect(page.getByRole('link',{name:'Published case',exact:true})).toHaveCount(0);await expect(page.locator('.builder-saved-drafts')).toContainText('Private draft');
   if(role==='admin'){await page.getByRole('button',{name:'New case',exact:true}).click();await expect(page.getByRole('button',{name:'Create case draft',exact:true})).toBeEnabled();await page.getByRole('navigation',{name:'Breadcrumb',exact:true}).getByRole('link',{name:'Create',exact:true}).click();await expect(page.locator('.builder-saved-drafts')).toContainText('Private draft');}
   for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await page.locator('.library button,.library a').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({label:n.getAttribute('aria-label')??n.textContent,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})).filter(r=>r.width<44||r.height<44))).toEqual([]);if(role==='owner')await page.screenshot({path:testInfo.outputPath(`drafts-${theme}-390.png`)});}
   await page.getByRole('button',{name:'Open draft: Private writing exercise',exact:true}).click();await page.getByRole('dialog',{name:'Private writing exercise',exact:true}).getByRole('button',{name:'Edit case',exact:true}).click();await expect(page.locator('.builder-studio')).toBeVisible();await expect(page.locator('.builder-page-account .auth-form')).toBeHidden();await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.getByRole('dialog',{name:'Menu',exact:true}).locator('.site-account-email')).toHaveText('owner@example.invalid');await expect(page.getByRole('link',{name:'Sign in',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Close menu',exact:true}).click();
   await page.reload();await expect(page.locator('.builder-studio')).toBeVisible();await expect(page.locator('.builder-page-account .auth-form')).toBeHidden();await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.getByRole('dialog',{name:'Menu',exact:true}).locator('.site-account-email')).toHaveText('owner@example.invalid');await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Confirm sign out',exact:true}).click();await expect(page.getByLabel('Email',{exact:true})).toBeVisible();await expect(page.locator('.builder-studio')).toHaveCount(0);await expect(page.locator('.site-account-email')).toHaveCount(0);
  }finally{await ctx.close();}
 }
});

test('[AS-125] Drafts distinguishes error, empty and workspace results without published catalogue reads',async({page})=>{
 const secondWorkspace=uuidv7(),foreignWorkspace=uuidv7();let failed=true,reads=[];
 await page.route(url=>url.pathname==='/api/v1/me',route=>route.fulfill({json:{profile:{user_id:worker.userId},memberships:[{workspace_id:worker.workspaceId,role:'owner',name:'Teaching'},{workspace_id:secondWorkspace,role:'author',name:'Second workspace'}],nextAfter:null,account:{email:'owner@example.invalid',administration:false}}}));
 await page.route(url=>url.pathname.endsWith('/drafts'),route=>{const ws=new URL(route.request().url()).pathname.split('/')[5];reads.push(ws);return failed?route.fulfill({status:503,json:{error:'unavailable'}}):route.fulfill({json:{workspaceId:ws,drafts:[],limit:50,offset:0,nextOffset:0,hasMore:false}});});
 await enter(page,'single_choice',{collectionOnly:true});await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:'Create',exact:true}).click();await expect(page.locator('.builder-saved-drafts')).toContainText('could not be loaded');failed=false;await page.getByRole('button',{name:'Refresh saved drafts',exact:true}).click();await expect(page.locator('.builder-saved-drafts')).toContainText('No saved drafts yet');
 await page.getByRole('combobox',{name:'Workspace',exact:true}).click();await page.getByRole('option',{name:'Second workspace',exact:true}).click();await expect(page).toHaveURL(new RegExp(secondWorkspace));await expect(page.locator('.builder-saved-drafts')).toContainText('No saved drafts yet');expect(reads.at(-1)).toBe(secondWorkspace);
 const previousReads=reads.length;await page.goto(shell.origin+'/cases?view=drafts&workspace='+foreignWorkspace);await expect(page.locator('.library')).toContainText('does not grant draft access');expect(reads.length).toBe(previousReads);await page.goto(shell.origin+'/cases?view=drafts&workspace='+secondWorkspace);await expect(page.locator('.builder-saved-drafts')).toContainText('No saved drafts yet');
 await page.getByRole('button',{name:'New case',exact:true}).click();await expect(page).toHaveURL(new RegExp('/create/new\\?workspace='+secondWorkspace));await expect(page.getByRole('heading',{name:'Create a case draft',exact:true})).toBeVisible();await expect(page.locator('.builder-new-case-form select').first()).toHaveValue(secondWorkspace);
});

test('[AS-132] Outline follows the authored spine, discloses consequences by chip and keeps regions usable by keyboard and pointer',async({page},testInfo)=>{
  await page.setViewportSize({width:1600,height:900});
  await enter(page,'single_choice',{openDetails:false});
  const studio=page.locator('.builder-studio'),outline=studio.getByRole('navigation',{name:'Outline',exact:true});
  const targets=outline.locator('li:not([hidden]) .builder-outline-target');
  await expect(targets.locator('.builder-outline-name > span')).toHaveText(['Opening','Decision','Reassessment']);
  const chip=outline.getByRole('button',{name:'2 consequences of Decision',exact:true});
  await expect(chip).toHaveAttribute('aria-expanded','false');await expect(chip).toHaveText(/2/);
  await chip.click();await expect(chip).toHaveAttribute('aria-expanded','true');
  await expect(outline.getByText('Recommended',{exact:true})).toHaveCount(1);
  await expect(outline.getByText('Joins Reassessment',{exact:true})).toBeVisible();
  const consequences=outline.locator('.builder-outline-consequence:not([hidden]) .builder-outline-target');
  await expect(consequences).toHaveCount(2);
  await consequences.nth(1).click();
  await expect(consequences.nth(1)).toHaveAttribute('aria-current','true');
  await expect(studio.getByLabel('Consequence name',{exact:true})).toBeVisible();
  // Collapsing the group hides its siblings but never the selected consequence.
  await chip.click();await expect(chip).toHaveAttribute('aria-expanded','false');
  await expect(consequences).toHaveCount(1);await expect(consequences.first()).toHaveAttribute('aria-current','true');
  if(testInfo)await page.screenshot({path:testInfo.outputPath('builder-outline-1600.png')});
  // A long consequence name wraps in full beside its own destination; renaming is a navigation input.
  const renamed=studio.getByLabel('Consequence name',{exact:true});
  await renamed.fill('Treat as decompression illness with a very long consequence name that must wrap');await renamed.blur();
  await expect(outline.getByText('Treat as decompression illness with a very long consequence name that must wrap',{exact:true})).toBeVisible();
  // Learner text is not a navigation input: the Outline keeps its nodes and repaints only the thumbnail.
  await targets.first().click();
  const held=await targets.first().elementHandle();
  await studio.getByLabel('Learner scene',{exact:true}).fill('Thumbnail sentinel scene');
  await expect(targets.first().locator('.builder-thumb')).toContainText('Thumbnail sentinel scene');
  expect(await held.evaluate(node=>node.isConnected)).toBe(true);
  // Keyboard resize, collapse and reopen with focus returned to the named control (BWR07).
  const resize=studio.getByRole('separator',{name:'Resize Outline',exact:true});
  await resize.focus();await expect(resize).toHaveAttribute('aria-valuenow','204');
  await page.keyboard.press('ArrowRight');await expect(resize).toHaveAttribute('aria-valuenow','220');
  await page.keyboard.press('End');await expect(resize).toHaveAttribute('aria-valuenow','280');
  await page.keyboard.press('Home');await expect(resize).toHaveAttribute('aria-valuenow','164');
  await page.keyboard.press('Enter');await expect(outline).toBeHidden();
  const reopen=studio.getByRole('button',{name:'Show Outline',exact:true});await expect(reopen).toBeFocused();
  await page.keyboard.press('Enter');await expect(outline).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.querySelector('.builder-outline').contains(document.activeElement))).toBe(true);
  // Pointer resize of the Inspector within its live budget.
  const tools=studio.getByRole('separator',{name:'Resize Inspector',exact:true}),box=await tools.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+20);await page.mouse.down();await page.mouse.move(box.x+box.width/2-40,box.y+20,{steps:4});await page.mouse.up();
  await expect(tools).toHaveAttribute('aria-valuenow','324');
  // The Inspector collapses first when the canvas would drop below 640px; a manual hide survives growth.
  // Focus inside a region that collapses for lack of width moves to that region's named reopen control.
  await studio.getByRole('complementary',{name:'Inspector',exact:true}).focus();
  await page.setViewportSize({width:1000,height:800});
  await expect(studio.getByRole('complementary',{name:'Inspector',exact:true})).toBeHidden();
  await expect(studio.getByRole('button',{name:'Show Inspector',exact:true})).toBeFocused();
  await studio.getByRole('button',{name:'Hide Outline',exact:true}).click();
  await page.setViewportSize({width:1600,height:900});
  await expect(studio.getByRole('complementary',{name:'Inspector',exact:true})).toBeVisible();await expect(outline).toBeHidden();
  await studio.getByRole('button',{name:'Show Outline',exact:true}).click();
  // One region at phone width, with explicit Outline/Slide/Inspector navigation; choosing a stage returns to the slide.
  await page.setViewportSize({width:390,height:844});
  const regions=studio.getByRole('navigation',{name:'Create regions',exact:true});
  await expect(regions.getByRole('button',{name:'Slide',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(outline).toBeHidden();
  await regions.getByRole('button',{name:'Outline',exact:true}).click();await expect(outline).toBeVisible();
  await expect(studio.locator('.builder-sheet')).toBeHidden();
  // Region navigation waits for native composition to finish (synthetic events prove the guard, not OS IME).
  await page.evaluate(()=>document.querySelector('.builder-workspace').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await regions.getByRole('button',{name:'Slide',exact:true}).click();
  await expect(outline).toBeVisible();await expect(studio.getByRole('status').first()).toContainText('Finish composing');
  await page.evaluate(()=>document.querySelector('.builder-workspace').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await outline.locator('.builder-outline-stage .builder-outline-target').first().click();
  await expect(studio.locator('.builder-sheet')).toBeVisible();await expect(outline).toBeHidden();
  await expect(studio.locator('.builder-sheet h2').first()).toBeFocused();
  await expect(studio.getByLabel('Slide title',{exact:true})).toHaveValue('Opening');
  for(const theme of ['light','dark'])for(const width of [320,390,768,1024,1280,1920]){
    await page.setViewportSize({width,height:width<800?844:900});await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
    await expect(page.locator('.builder-workspace')).toHaveAttribute('data-layout',width<912?'single':'wide');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),`${theme} ${width}`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({width:1600,height:900});await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await settled(page); // the theme switch eases tile colours over 120 ms; contrast is read once settled (CASE-249)
  expect((await new AxeBuilder({page}).include('.builder-studio').analyze()).violations).toEqual([]);
});
