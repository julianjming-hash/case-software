// A4 exact-build distributions. Local Auth/Worker only; explicit opt-in, no runtime optimization.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import {join} from 'node:path';
import {startStartupMemberFixture} from '../tests/helpers/startup-member-fixture.mjs';
import {casesUrl} from '../src/shared/urls.mjs';
const root=process.env.CASE_STARTUP_ROOT||process.cwd(),output=process.env.CASE_STARTUP_OUTPUT;
const samples=Number(process.env.CASE_STARTUP_SAMPLES||20),preflight=process.env.CASE_STARTUP_PREFLIGHT==='1';
if(!output||!Number.isInteger(samples)||samples!==(preflight?1:20))throw Error('member_measure_options');
const conditions={latencyMs:75,bytesPerSecond:1_000_000,cpuSlowdown:4,viewport:{width:390,height:844},motion:'reduce',observationAfterControlsMs:500,ownerHeldMs:1200,
  shaping:'One FIFO16KiB response byte lane shared by all HTTP page/SW targets. HTTPSAuth stub is local and unshaped; CPU throttle applies page only.'};
const states=[{name:'cold-sw-blocked'},{name:'cold-owner-held',ownerDelayMs:conditions.ownerHeldMs},
  {name:'cold-first-install',sw:true},{name:'cold-first-install-owner-held',sw:true,ownerDelayMs:conditions.ownerHeldMs},
  {name:'warm-controlled',sw:true,warm:true},{name:'cold-art-held',holdArt:true}];
const selected=process.env.CASE_STARTUP_MODES?.split(',');if(selected?.some(name=>!states.some(state=>state.name===name)))throw Error('member_measure_scope');
const method=createHash('sha256');for(const path of ['scripts/startup-member-measure.mjs','tests/helpers/startup-member-fixture.mjs','tests/helpers/startup-network.mjs']){method.update(path);method.update(await readFile(new URL('../'+path,import.meta.url)));}method.update(JSON.stringify(conditions));
const result={source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),root,date:new Date().toISOString(),samples,preflight,conditions,methodFingerprint:method.digest('hex'),
  definitions:{member:'ActualAuthrefresh + knownJWT account guard + Worker get_me facilitator membership + validated catalogue response and enabled rendered controls.',
    controls:'First visible enabled library Search cases control AND a returned validated catalogue card link.',art:'First Canvas2DdrawImage bitmap blit on a connected case-card canvas; may be below the fold; not all covers complete.',
    owner:'Real /me/rooms request remains empty; no active-room/segment marker, automatic rejoin or mint.',firstInstall:'Fresh browser context; initial registration/cache inventory empty; allow actual complete SW install, first document remains uncontrolled.',
    warm:'Actual completed shell precache and confirmed controller before measured reload.',privacy:'Only existing fake Auth refresh key is seeded; no access token, capabilities, tab-room marker or private API cache allowed.',
    comparison:'Origin-wide server shaping is a new A4 method; do not compare directly with prior page-CDP throughput-only distributions.'},states:[]};
let fixture,browser;
try{
  fixture=await startStartupMemberFixture(root,conditions);const hash=createHash('sha256');
  for(const file of ['index.html','sw.mjs',...(await readdir(join(fixture.assetDir,'assets'))).sort().map(name=>'assets/'+name)]){hash.update(file);hash.update(await readFile(join(fixture.assetDir,file)));}
  result.buildFingerprint=hash.digest('hex');result.headersFingerprint=createHash('sha256').update(await readFile(join(fixture.assetDir,'_headers'))).digest('hex');
  result.sourceFixtureFingerprint=createHash('sha256').update(await readFile(join(root,'src/fixtures/synthetic-workshop.case.json'))).digest('hex');
  result.precache=JSON.parse((await readFile(join(fixture.assetDir,'sw.mjs'),'utf8')).match(/const SHELL = (\[[\s\S]*?\]);/)[1]);
  browser=await chromium.launch();result.browser=browser.version();
  for(const state of states.filter(state=>!selected||selected.includes(state.name))){const rows=[];
    for(let i=0;i<samples;i++){
      const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:state.sw?'allow':'block',viewport:conditions.viewport,reducedMotion:'reduce'});
      const page=await context.newPage(),cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:conditions.cpuSlowdown});
      await context.addInitScript(()=>{
        // Existing legitimate Auth storage only. Measurement state stays in this document's memory.
        if(!localStorage.getItem('case:auth:refresh'))localStorage.setItem('case:auth:refresh','local-refresh-only');
        const data=globalThis.__memberMeasure={controls:null,art:null,registrationBefore:null,cacheBefore:null,membershipVerified:false,catalogueVerified:false,longTasks:[],shifts:[]};
        const nativeFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{const response=await nativeFetch(...args),path=new URL(args[0]?.url??args[0],location.href).pathname;
          if(path==='/api/v1/me'||/\/catalogue$/.test(path))void response.clone().json().then(value=>{if(!response.ok)return;if(path==='/api/v1/me')data.membershipVerified=Array.isArray(value.memberships)&&value.memberships.some(m=>m.role==='facilitator');else data.catalogueVerified=Array.isArray(value.cases)&&value.cases.length>0;}).catch(()=>{});return response;};
        navigator.serviceWorker?.getRegistrations().then(rows=>data.registrationBefore=rows.length).catch(()=>data.registrationBefore=0);
        caches.keys().then(rows=>data.cacheBefore=rows.length);
        new PerformanceObserver(list=>data.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
        new PerformanceObserver(list=>data.shifts.push(...list.getEntries().filter(e=>!e.hadRecentInput).map(e=>({start:e.startTime,value:e.value})))).observe({type:'layout-shift',buffered:true});
        const observe=()=>{const input=document.querySelector('.library-search input'),link=document.querySelector('.case-card a.case-link');if(data.controls===null&&input&&!input.disabled&&input.getClientRects().length&&link?.getClientRects().length)data.controls=performance.now();};
        new MutationObserver(observe).observe(document,{subtree:true,childList:true,attributes:true});
        const draw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){const value=draw.apply(this,args);if(data.art===null&&this.canvas.isConnected&&this.canvas.closest('.case-card'))data.art=performance.now();return value;};
      });
      const responses=[];page.on('response',async response=>{const url=new URL(response.url());if(url.pathname==='/api/v1/me'||/\/catalogue$/.test(url.pathname)){const json=await response.json().catch(()=>null);responses.push({kind:url.pathname==='/api/v1/me'?'membership':'catalogue',ok:response.ok(),valid:!!json&&(url.pathname==='/api/v1/me'?json.memberships?.some(m=>m.role==='facilitator'):Array.isArray(json.cases)&&json.cases.length>0)});}});
      if(state.warm){fixture.begin({});await page.goto(casesUrl(fixture.origin));await page.waitForFunction(()=>__memberMeasure.controls!==null);await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();if(!await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)))throw Error('member_warm_not_controlled');await page.waitForFunction(()=>__memberMeasure.controls!==null);}
      const trial=fixture.begin(state),authBefore=fixture.auth.requests.length;let failure=null,installedMs=null;
      try{await page.goto(casesUrl(fixture.origin));await page.waitForFunction(()=>__memberMeasure.controls!==null&&__memberMeasure.membershipVerified&&__memberMeasure.catalogueVerified,{},{timeout:15_000});}catch{failure='catalogue_controls_unavailable';}
      await page.waitForTimeout(conditions.observationAfterControlsMs);
      const row=await page.evaluate(async failure=>{
        const data=__memberMeasure,localKeys=Object.keys(localStorage),sessionKeys=Object.keys(sessionStorage),all=[...localKeys,...sessionKeys];
        const cachedPrivate=[];for(const name of await caches.keys()){const cache=await caches.open(name);for(const request of await cache.keys()){const path=new URL(request.url).pathname;if(path.startsWith('/api/')||path.startsWith('/sessions/'))cachedPrivate.push('private-path');}}
        return{failure,verifiedMember:data.membershipVerified&&data.catalogueVerified,timeOrigin:performance.timeOrigin,controlsMs:data.controls,artMs:data.art,publicPaintMs:performance.getEntriesByType('paint').find(e=>e.name==='first-contentful-paint')?.startTime??null,
          longTasks:data.longTasks,layoutShift:data.shifts.reduce((sum,e)=>sum+e.value,0),controlled:Boolean(navigator.serviceWorker.controller),registrationBefore:data.registrationBefore,cacheBefore:data.cacheBefore,
          resourceStages:performance.getEntriesByType('resource').map(e=>({stage:e.name.includes('/assets/')?new URL(e.name).pathname.split('/').at(-1):'local-public-or-api',start:e.startTime,end:e.responseEnd,transferBytes:e.transferSize,initiator:e.initiatorType})),
          privacy:{refreshPresent:localKeys.includes('case:auth:refresh'),roomMarkerPresent:sessionKeys.includes('case:console:active-room'),extraCaseKeys:all.filter(key=>(key.startsWith('case:')||key.startsWith('case-lab:'))&&key!=='case:auth:refresh'),
            privateJSON:all.some(key=>/"(?:casePack|mirror|facilitatorToken|document_text|access_token)"/.test(localStorage.getItem(key)??sessionStorage.getItem(key)??'')),cachedPrivate,caseDatabases:(await indexedDB.databases()).map(db=>db.name).filter(name=>name?.startsWith('case:')||name?.startsWith('case-lab:'))}};
      },failure);
      if(state.sw){try{await page.evaluate(()=>Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('install_timeout')),12_000))]));installedMs=await page.evaluate(()=>performance.now());}catch{throw Error('member_install_failed');}}
      if(state.sw){row.completeShell=await page.evaluate(async()=>{let count=0,privatePath=false;for(const name of await caches.keys()){const cache=await caches.open(name);for(const request of await cache.keys()){count++;privatePath ||= /^\/(?:api|sessions)(?:\/|$)/.test(new URL(request.url).pathname);}}return{count,privatePath};});if(row.completeShell.privatePath||row.completeShell.count!==result.precache.length)throw Error('member_complete_shell_inventory');}
      trial.releaseArt();
      row.installedMs=installedMs;row.authRequests=fixture.auth.requests.slice(authBefore);row.serverStages=trial.requests.map(item=>({...item,start:item.start-row.timeOrigin,end:item.end===null?null:item.end-row.timeOrigin}));delete row.timeOrigin;
      row.playwrightResponseChecks=responses;
      if(!failure&&!row.verifiedMember){await writeFile(output,JSON.stringify({...result,preflightFailure:{state:state.name,row,responses}},null,2));throw Error('member_validation_not_proven');}
      if(row.privacy.roomMarkerPresent||row.privacy.extraCaseKeys.length||row.privacy.privateJSON||row.privacy.cachedPrivate.length||row.privacy.caseDatabases.length)throw Error('member_private_storage');
      if(row.serverStages.some(s=>s.stage==='other-api'&&s.method!=='GET'))throw Error('member_implicit_room_claim');
      if(!state.warm&&(row.registrationBefore!==0||row.cacheBefore!==0||row.controlled))throw Error('member_cold_state_not_proven');
      rows.push(row);await context.close();
    }
    const stats=field=>{const values=rows.map(row=>row[field]).filter(Number.isFinite).sort((a,b)=>a-b);return{n:values.length,median:values[Math.floor(values.length/2)]??null,p95:values[Math.ceil(values.length*.95)-1]??null};};
    result.states.push({state:state.name,failures:rows.filter(row=>row.failure).length,summary:Object.fromEntries(['publicPaintMs','controlsMs','artMs','layoutShift','installedMs'].map(field=>[field,stats(field)])),rows});
    await writeFile(output,JSON.stringify(result,null,2));console.log(`${state.name}: ${rows.length} samples; ${rows.filter(row=>row.failure).length} unavailable`);
  }
}finally{await browser?.close();await fixture?.stop();}
