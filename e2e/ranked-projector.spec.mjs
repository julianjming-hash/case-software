import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markFor } from '../src/client/projector-marks.mjs';
import { randomInt, createHash } from 'node:crypto';
import { uuidv7 } from '../src/shared/ids.mjs';
import { apiUrl, authApiUrl, displayPairUrl, joinUrl } from '../src/shared/urls.mjs';
import { miniCase } from '../tests/helpers/mini-case.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { startLocalWorker, createRoom, facilitatorCommand, serverMirror } from '../tests/helpers/local-worker.mjs';
import { dismissDisplayReminder } from '../tests/helpers/console-v2.mjs';
import { docShotsDir } from '../tests/helpers/doc-shots.mjs';

function rankedCase(count=3,label=null) {
  const f=miniCase(),d=f.doc.decisions[0];d.interaction.type='ranking';d.interaction.rank_count=count;
  while(d.interaction.options.length<count)d.interaction.options.push({id:uuidv7(),label:`Option ${d.interaction.options.length+1}`});
  if(label!==null)d.interaction.options.forEach((o,i)=>{o.label=label(i);});
  d.paths.forEach(p=>{delete p.option_ids;});d.rules=[{when:{top:[f.o.decompress]},path_id:f.p.decompress}];
  return f;
}
async function post(origin,parts,token,body) {
  const response=await fetch(apiUrl(origin,...parts),{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  expect(response.ok).toBe(true);return response.json();
}
async function pair(page,origin,apiOrigin,room) {
  await page.goto(displayPairUrl('00000000',origin));await expect(page.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  const code=(await page.locator('.pair-code').textContent()).replace(/\s/g,'');
  await post(apiOrigin,['sessions',room.sessionId,'display-pairs','approve'],room.facilitatorToken,{code});
  await expect(page.locator('.joinpanel')).toBeVisible();
}
async function voteApi(origin,room,participant,order) {
  const mirror=await serverMirror(origin,room);
  const result=await post(origin,['sessions',room.sessionId,'commands'],participant.token,{v:1,type:'vote',epoch:mirror.epoch,clientEventId:uuidv7(),roundId:mirror.round.id,response:{order}});
  expect(result.receipt.receipt).toBe('accepted');
}


test('[AS-091] Card25 actual authenticated Other Back direct selection and pending focus preserve anonymous closed authority',async({browser})=>{
  const fixture=rankedCase(),decision=fixture.doc.decisions[0],otp=String(randomInt(0,1000000)).padStart(6,'0');
  let auth,worker,shell,facilitator,display,phone,facilitatorContext,displayContext,phoneContext,release=()=>{},finish=async()=>{};
  try {
    auth=await startLocalAuthStub({appOrigin:null,jwt:null,otp});
    worker=await startPublishedWorker({authOrigin:auth.origin,caseDocument:fixture.doc});auth.setJwt(worker.jwt);
    const base=authApiUrl(auth.origin,'base');shell=await startServedAuthShell({apiOrigin:worker.origin,buildAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:base.slice(0,-1),SUPABASE_JWKS_URL:new URL('.well-known/jwks.json',base).href}});auth.setAppOrigin(shell.origin);
    // Axe must not measure a colour mid-transition (.btn transitions its background): reduced motion removes it.
    facilitatorContext=await browser.newContext({ignoreHTTPSErrors:true,reducedMotion:'reduce'});displayContext=await browser.newContext({viewport:{width:1280,height:720},reducedMotion:'reduce'});phoneContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    facilitator=await facilitatorContext.newPage();display=await displayContext.newPage();phone=await phoneContext.newPage();
    await facilitator.goto(casesUrl(shell.origin));await facilitator.getByLabel('Email').fill('owner@example.invalid');await facilitator.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();
    await expect(facilitator.getByLabel('One-time code')).toBeVisible();await facilitator.getByLabel('One-time code').fill(otp);await facilitator.getByRole('button',{name:'Sign in',exact:true}).click();
    const created=shell.waitForCreatedRoom();await (await openCase(facilitator)).click();const room=await created;
    await pair(display,shell.origin,worker.origin,room);await phone.goto(joinUrl(room.joinCode,shell.origin));await phone.getByLabel('Your name',{exact:true}).fill('Private learner');await phone.getByRole('button',{name:'Join case',exact:true}).click();await expect(phone.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
    const people=[];for(let i=0;i<17;i++)people.push(await post(worker.origin,['join'],null,{v:1,code:room.joinCode,displayName:'Private learner',avatarId:'shadows-01'}));
    await dismissDisplayReminder(facilitator);await facilitator.getByRole('button',{name:'Start case',exact:true}).click();await facilitator.getByRole('button',{name:'Show decision context',exact:true}).click();await facilitator.getByRole('button',{name:'Open responses',exact:true}).click();
    const chart=display.getByRole('region',{name:'Responses closed',exact:true});await expect(chart).toHaveCount(0);
    for(const option of decision.interaction.options)await phone.getByRole('button',{name:`Add to ranking: ${option.label}`,exact:true}).click();await phone.getByRole('button',{name:'Send answer',exact:true}).click();
    const tuples=[...Array(9).fill('012'),...Array(5).fill('021'),...Array(2).fill('102'),'210'],ids=decision.interaction.options.map(o=>o.id);
    for(let i=0;i<people.length;i++)await voteApi(worker.origin,room,people[i],[...tuples[i]].map(index=>ids[Number(index)]));
    await expect.poll(async()=>Object.keys((await serverMirror(worker.origin,room)).round.responses).length).toBe(18);
    await facilitator.getByRole('button',{name:'Lock responses & review',exact:true}).click();
    await expect(facilitator.getByRole('button',{name:'Other responses',exact:true})).toBeVisible();
    await expect(chart.locator('.ranked-total')).toHaveText(['10 responses','5 responses']);await expect(chart.locator('.ranked-overall')).toHaveText('18 responses · 4 orders');await expect(chart.locator('.ranked-residual')).toHaveText('3 other responses');
    const frozen=(await serverMirror(worker.origin,room)).round.aggregate;
    const held=new Promise(resolve=>{release=resolve;}),handlers=[];let sent=0;const commandUrl=apiUrl(shell.origin,'sessions',room.sessionId,'commands');
    const hold=route=>{const task=(async()=>{if(route.request().postDataJSON()?.type==='ranked_page'){sent++;await held;}const response=await route.fetch();await route.fulfill({response});})();handlers.push(task);return task;};
    await facilitator.route(commandUrl,hold);finish=async()=>{release();await Promise.all(handlers);await facilitator.unroute(commandUrl,hold);};
    await facilitator.getByRole('button',{name:'Other responses',exact:true}).click();await expect.poll(()=>sent).toBe(1);
    await expect(facilitator.getByRole('button',{name:'Other responses',exact:true})).toBeDisabled();await expect(facilitator.getByRole('combobox',{name:'Select response order',exact:true})).toBeDisabled();
    await expect(chart.locator('.ranked-total')).toHaveText(['10 responses','5 responses']);release();await finish();
    const back=facilitator.getByRole('button',{name:'Back to common responses',exact:true});await expect(back).toBeFocused();
    await expect(chart.locator('.ranked-total')).toHaveText(['2 responses','1 response']);await expect(chart.locator('.ranked-label')).toHaveText([ids[1],ids[0],ids[2],ids[2],ids[1],ids[0]].map(id=>decision.interaction.options.find(o=>o.id===id).label));
    await expect(chart.locator('.ranked-overall')).toHaveText('18 responses · 4 orders');await back.click();await expect(facilitator.getByRole('button',{name:'Other responses',exact:true})).toBeFocused();await expect(chart.locator('.ranked-total')).toHaveText(['10 responses','5 responses']);
    const orderChoice=facilitator.getByRole('combobox',{name:'Select response order',exact:true});
    const choiceId=await orderChoice.getAttribute('id');await orderChoice.click();await orderChoice.press('End');
    const activeOption=await orderChoice.getAttribute('aria-activedescendant');
    await post(worker.origin,['join'],null,{v:1,code:room.joinCode,displayName:'Late control witness',avatarId:'shadows-01'});
    await expect(facilitator.locator('.console-people-count strong')).toHaveText('19');
    await expect(orderChoice).toHaveAttribute('id',choiceId);await expect(orderChoice).toHaveAttribute('aria-expanded','true');
    await expect(orderChoice).toHaveAttribute('aria-activedescendant',activeOption);await expect(orderChoice).toBeFocused();
    const latestRevision=(await serverMirror(worker.origin,room)).revision,selection=[];
    facilitator.on('request',request=>{if(request.method()==='POST'&&request.url()===commandUrl&&request.postDataJSON()?.type==='ranked_page')selection.push(request.postDataJSON());});
    await orderChoice.press('Enter');await expect(chart.locator('.ranked-total')).toHaveText(['1 response']);
    expect(selection).toHaveLength(1);expect(selection[0].expectRevision).toBe(latestRevision);
    await expect(chart).not.toContainText('Private learner');expect((await serverMirror(worker.origin,room)).round.aggregate).toEqual(frozen);expect((await serverMirror(worker.origin,room)).selectedPathId).toBeNull();
    await facilitator.getByRole('button',{name:'Hide responses on projector',exact:true}).click();await expect(chart).toHaveCount(0);await display.reload();await expect(chart).toHaveCount(0);
    await facilitator.getByRole('button',{name:'Show responses on projector',exact:true}).click();await expect(chart.locator('.ranked-total')).toHaveText(['1 response']);
    await expect(phone.getByRole('region',{name:'Group result',exact:true})).toHaveCount(0);
    for(const theme of ['light','dark']){await facilitator.evaluate(t=>document.documentElement.dataset.theme=t,theme);await display.evaluate(t=>document.documentElement.dataset.theme=t,theme);expect((await new AxeBuilder({page:facilitator}).analyze()).violations).toEqual([]);expect((await new AxeBuilder({page:display}).analyze()).violations).toEqual([]);}
    // The auth shell proxies HTTP only. Observe actual native Worker WebSocket
    // frames separately with the normally paired display credential, never a synthetic frame.
    const credential=await display.evaluate(()=>JSON.parse(sessionStorage.getItem('case:display:main:token')));
    expect(credential.sessionId).toBe(room.sessionId);
    const wirePage=await displayContext.newPage();
    await wirePage.evaluate(({url,credential})=>{
      window.c25wireFrames=[];window.c25wire=new WebSocket(url);
      window.c25wire.addEventListener('open',()=>window.c25wire.send(JSON.stringify({v:1,t:'hello',token:credential.token,lastRevision:0,lastEpoch:0})));
      window.c25wire.addEventListener('message',event=>window.c25wireFrames.push(event.data));
    },{url:apiUrl(worker.origin,'sessions',room.sessionId,'ws').replace(/^http/,'ws'),credential});
    await expect.poll(()=>wirePage.evaluate(()=>window.c25wireFrames.filter(frame=>frame.includes('"responseResult":{')).length)).toBeGreaterThan(0);
    const publicFrames=await wirePage.evaluate(()=>window.c25wireFrames);
    expect(publicFrames.some(frame=>frame.includes('completeOrders'))).toBe(false);
    const closedFrames=publicFrames.filter(frame=>frame.includes('"responseResult":{'));expect(closedFrames.length).toBeGreaterThan(0);for(const frame of closedFrames){expect(frame).not.toContain('Private learner');for(const person of people){expect(frame).not.toContain(person.participantId);expect(frame).not.toContain(person.token);}}
  } finally {release();await finish();await facilitatorContext?.close();await displayContext?.close();await phoneContext?.close();await shell?.stop();await worker?.stop();await auth?.stop();}
});

test.describe(() => {
  test.describe.configure({ mode: 'default' });
// One test per rank count and authored-text kind (each owns one local Worker and four rooms), so
// no single test carries all four kinds' Worker starts and 2 s pairing polls against the 60 s
// timeout on a 2-vCPU runner. Every assertion is unchanged; the matrix checks are per kind.
for (let count=2;count<=8;count++) for(const kind of ['short','latin','unicode','unbroken']) test(`Card25 loaded-font full labels count ${count} ${kind} fit both real projector shells and themes with aligned ranks and totals`,async({browser})=>{
  const completedMatrix=[],normalRooms=[],normalContexts=new Set();
  const expectedMatrix=[];
  for(const width of [1280,1920])for(const theme of ['light','dark'])for(let position=0;position<count;position+=kind==='short'?Math.min(3,count):1)expectedMatrix.push(`${kind}-${width}-${theme}-${position}`);
  {
    // Each authored-text case owns one ordinary local Worker. Four independent
    // rooms and isolated pages complete normal pairing together. Each room keeps
    // rank positions serial while independent pages progress concurrently.
    // No production clock or rate bucket changes.
    const worker=await startLocalWorker(),pages=[];
    let primaryFailure,hasPrimaryFailure=false;
    try {
      const label=kind==='short'?i=>`Option ${i+1}`:kind==='latin'?i=>(`Option ${i+1}: `+'An authored intervention with full clinical context '.repeat(4)).slice(0,120):kind==='unicode'?i=>String(i+1)+'界'.repeat(119):i=>String(i+1)+'W'.repeat(119);
      const fixture=rankedCase(count,label),d=fixture.doc.decisions[0];
      d.prompt=kind==='unicode'?'界'.repeat(200):kind==='unbroken'?'W'.repeat(200):('Choose every authored intervention in the complete ranked response order. ').repeat(4).slice(0,200);
      expect(d.prompt.length).toBe(200);
      const variants=[[1280,720,'light'],[1280,720,'dark'],[1920,1080,'light'],[1920,1080,'dark']];
      const setups=await Promise.allSettled(variants.map(async([width,height,theme])=>{
      const display=await browser.newPage({viewport:{width:1280,height:720}});pages.push(display);normalContexts.add(display.context());
      const room=await createRoom(worker.origin,{caseDocument:fixture.doc});
      // Two identical distinct order groups exercise real aligned columns when the authority permits them.
      const people=[];for(let i=0;i<2;i++)people.push(await post(worker.origin,['join'],null,{v:1,code:room.joinCode,displayName:'Fit learner',avatarId:'shadows-01'}));
      await pair(display,worker.origin,worker.origin,room);
      const credential=await display.evaluate(()=>JSON.parse(sessionStorage.getItem('case:display:main:token')));
      expect(credential.sessionId).toBe(room.sessionId);expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      normalRooms.push({sessionId:room.sessionId,facilitatorCapability:createHash('sha256').update(room.facilitatorToken).digest('hex'),displayCapability:createHash('sha256').update(credential.token).digest('hex')});
      for(const type of ['start','advance','advance'])expect((await facilitatorCommand(worker.origin,room,type)).receipt).toBe('accepted');
      const ids=d.interaction.options.map(o=>o.id);await voteApi(worker.origin,room,people[0],ids.slice(0,count));await voteApi(worker.origin,room,people[1],[...ids.slice(0,count)].reverse());expect((await facilitatorCommand(worker.origin,room,'lock')).receipt).toBe('accepted');
      const chart=display.getByRole('region',{name:'Responses closed',exact:true});await expect(chart).toBeVisible();
        await display.setViewportSize({width,height});await display.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        const loaded=await display.evaluate(async()=>{
          const requests=[['500 26px Montserrat','Full authored clinical label'],['600 26px Montserrat','Full authored clinical label'],['500 26px Montserrat','Évaluation complète'],['600 32px "JetBrains Mono"','12345678']];
          const result=[];for(const [font,sample]of requests){const faces=await document.fonts.load(font,sample);result.push({font,count:faces.length,loaded:faces.every(face=>face.status==='loaded')});}await document.fonts.ready;return result;
        });for(const font of loaded){expect(font.count).toBeGreaterThan(0);expect(font.loaded).toBe(true);}
        return {display,room,chart,loaded,width,height,theme};
      }));
      expect(setups.filter(result=>result.status==='rejected').map(result=>String(result.reason)),'every independent normal setup completed').toEqual([]);
      const measurements=await Promise.allSettled(setups.map(async result=>{
        const {display,room,chart,loaded,width,height,theme}=result.value;
        const span=kind==='short'?Math.min(3,count):1,seen=[]; // CASE-327: three positions under a long prompt
        for(let position=0;position<count;position+=span){
          const mirror=await serverMirror(worker.origin,room),receipt=await facilitatorCommand(worker.origin,room,'ranked_page',{group:0,position,closedRoundId:mirror.round.id,expectRevision:mirror.revision});expect(receipt,JSON.stringify({kind,width,theme,position,receipt})).toMatchObject({receipt:'accepted'});
          await expect(chart.locator('.ranked-rank').first()).toHaveText(String(position+1));
          const geometry=await display.evaluate(()=>{
            const root=document.querySelector('.ranked-result');
            const rectangle=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
            const tiles=[...root.querySelectorAll('.ranked-tile')],labels=[...root.querySelectorAll('.ranked-label')],columns=[...root.querySelectorAll('.ranked-column')],totals=[...root.querySelectorAll('.ranked-total')];
            return{prompt:{...rectangle(root.querySelector('h2')),text:root.querySelector('h2').textContent,font:parseFloat(getComputedStyle(root.querySelector('h2')).fontSize),clipped:root.querySelector('h2').scrollHeight>root.querySelector('h2').clientHeight+1||root.querySelector('h2').scrollWidth>root.querySelector('h2').clientWidth+1},marks:tiles.map(tile=>({name:tile.querySelector('.mark').getAttribute('aria-label'),fill:tile.querySelector('.mark rect').getAttribute('fill'),ink:tile.querySelector('.mark path').getAttribute('fill'),...rectangle(tile.querySelector('.mark'))})),columns:columns.map(rectangle),totals:totals.map(rectangle),tiles:tiles.map(rectangle),labels:labels.map(node=>({...rectangle(node),font:parseFloat(getComputedStyle(node).fontSize),clipped:node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1,text:node.textContent})),rankFonts:[...root.querySelectorAll('.ranked-rank')].map(n=>parseFloat(getComputedStyle(n).fontSize)),mainOverflow:document.querySelector('main').dataset.overflow,scrolling:document.documentElement.scrollHeight>innerHeight+1||document.documentElement.scrollWidth>innerWidth+1};
          });
          expect(geometry.prompt.text).toBe(d.prompt);expect(geometry.prompt.font).toBeGreaterThanOrEqual(24);expect(geometry.prompt.clipped).toBe(false);expect(geometry.prompt.right).toBeLessThanOrEqual(width);expect(geometry.prompt.bottom).toBeLessThanOrEqual(height);
          expect(geometry.columns.length).toBe(kind==='short'?2:1);
          if(geometry.columns.length===2){expect(Math.abs(geometry.columns[0].y-geometry.columns[1].y)).toBeLessThanOrEqual(1);expect(Math.abs(geometry.totals[0].y-geometry.totals[1].y)).toBeLessThanOrEqual(1);}
          for(const [index,item]of geometry.labels.entries()){expect(item.font).toBeGreaterThanOrEqual(24);expect(item.clipped).toBe(false);expect(item.right).toBeLessThanOrEqual(width);expect(item.bottom).toBeLessThanOrEqual(height);const visible=Math.min(span,count-position), rank=position+(index%visible);const authored=kind==='short'&&index>=visible?count-1-rank:rank;expect(item.text).toBe(d.interaction.options[authored].label);const mark=markFor(authored);expect(geometry.marks[index].name).toBe(mark.name);expect(geometry.marks[index].fill).toBe(mark.fill);expect(geometry.marks[index].ink).toBe(mark.ink);expect(geometry.marks[index].width).toBeGreaterThanOrEqual(40);const tile=geometry.tiles[index];expect(item.x).toBeGreaterThanOrEqual(tile.x);expect(item.y).toBeGreaterThanOrEqual(tile.y);expect(item.right).toBeLessThanOrEqual(tile.right+1);expect(item.bottom).toBeLessThanOrEqual(tile.bottom+1);if(index%visible)expect(geometry.tiles[index-1].bottom).toBeLessThanOrEqual(tile.y+1);}
          for(const font of geometry.rankFonts)expect(font).toBeGreaterThanOrEqual(24);expect(geometry.scrolling).toBe(false);expect(geometry.mainOverflow).toBe('false');
          seen.push(...geometry.labels.slice(0,Math.min(span,count-position)).map(item=>item.text));
          if(position===0||position+span>=count){const captures=docShotsDir('25-screenshots');await display.screenshot({path:`${captures}/count${count}-${kind}-${width}-${theme}-position${position+1}.png`});}
          await test.info().attach(`count${count}-${kind}-${width}-${theme}-position${position}`,{body:JSON.stringify({loaded,...geometry}),contentType:'application/json'});
          completedMatrix.push(`${kind}-${width}-${theme}-${position}`);
        }
        expect(seen).toEqual(d.interaction.options.slice(0,count).map(o=>o.label));
        await display.close();
      }));
      for(const result of measurements)if(result.status==='rejected')throw result.reason;
    }catch(error){
      primaryFailure=error;hasPrimaryFailure=true;
    }finally{
      const closed=await Promise.allSettled(pages.map(page=>page.close()));
      const cleanupFailures=closed.filter(result=>result.status==='rejected').map(result=>result.reason);
      try{await worker.stop();}catch(error){cleanupFailures.push(error);}
      if(hasPrimaryFailure){
        if(cleanupFailures.length)throw new AggregateError([primaryFailure,...cleanupFailures],'Ranked projector measurement and cleanup failed',{cause:primaryFailure});
        throw primaryFailure;
      }
      if(cleanupFailures.length===1)throw cleanupFailures[0];
      if(cleanupFailures.length>1)throw new AggregateError(cleanupFailures,'Ranked projector cleanup failed');
    }
  }
  expect(completedMatrix.sort(),'complete kind/viewport/theme/position matrix').toEqual(expectedMatrix.sort());
  expect(normalRooms,'four normal independent room fixtures').toHaveLength(4);
  expect(normalContexts.size,'four isolated normal browser contexts').toBe(4);
  for(const field of ['sessionId','facilitatorCapability','displayCapability'])expect(new Set(normalRooms.map(room=>room[field])).size,`distinct normal ${field}`).toBe(4);
  await test.info().attach(`count${count}-${kind}-normal-fixture-matrix`,{body:JSON.stringify({normalRooms,completedMatrix}),contentType:'application/json'});
});
});
