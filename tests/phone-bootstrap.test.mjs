import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneBootstrap } from '../src/client/phone-bootstrap.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { recoverJoinCapability, readParticipantRecovery } from '../src/client/phone-recovery.mjs';
const state=()=>({sessionId:uuidv7(),token:'x'.repeat(32),expiresAt:Date.now()+60_000});
test('transient QR recovery retains only validated queue counts and Retry confirms the same room before readiness',async()=>{
 const credential=state(), events=[];let calls=0;
 const bootstrap=createPhoneBootstrap({code:'ABCDEF',credential,knownInventory:true,
  readRecovery:async()=>({preserve:true,count:3}),cleanup:async(reason,selected)=>{events.push({reason,selected});return {complete:true};},
  preflight:async()=>++calls===1?{status:'unavailable'}:{status:'recovered',sessionId:credential.sessionId}});
 assert.deepEqual(await bootstrap.start(),{status:'unavailable',count:3});assert.deepEqual(events,[{reason:'next_load',selected:true}]);
 assert.equal(calls,1);assert.deepEqual(await bootstrap.retry(),{status:'ready',count:3,sessionId:credential.sessionId});assert.equal(calls,2);
 assert.ok(!JSON.stringify(await bootstrap.retry()).includes(credential.token));
});
test('participant bootstrap refuses route mismatch invalid inventory and recovery rejection through full common cleanup',async()=>{
 for(const change of [{sessionId:uuidv7()},{knownInventory:false},{readRecovery:async()=>({preserve:false,count:0})},{preflight:async()=>({status:'refused'})}]){
  const credential=state(),events=[];
  const bootstrap=createPhoneBootstrap({code:'ABCDEF',credential,knownInventory:true,readRecovery:async()=>({preserve:true,count:1}),preflight:async()=>({status:'recovered',sessionId:credential.sessionId}),cleanup:async(reason,selected)=>{events.push({reason,selected});return {complete:true};},...change});
  assert.deepEqual(await bootstrap.start(),{status:'refused',count:0});assert.ok(events.some(event=>event.selected===false));
  assert.deepEqual(await bootstrap.retry(),{status:'refused',count:0});
 }
 const blocked=createPhoneBootstrap({credential:state(),knownInventory:false,cleanup:async()=>({complete:false})});
 assert.deepEqual(await blocked.start(),{status:'storage_unavailable',count:0});
 assert.deepEqual(await blocked.retry(),{status:'storage_unavailable',count:0});
 const broken=createPhoneBootstrap({credential:state(),knownInventory:false,cleanup:async()=>{throw Error('blocked');}});
 assert.deepEqual(await broken.start(),{status:'storage_unavailable',count:0});
});

test('participant bootstrap disposal fences held queue cleanup and capability preflight before readiness or retry',async()=>{
 for(const boundary of ['queue','cleanup','preflight','preflight rejection']){
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),hold=()=>{entered();return new Promise((resolve,reject)=>{release=value=>value instanceof Error?reject(value):resolve(value);});};
  let preflights=0,cleanups=0;
  const credential=Object.freeze(state());
  const bootstrap=createPhoneBootstrap({credential,knownInventory:true,code:'ABCDEF',
   readRecovery:()=>boundary==='queue'?hold():Promise.resolve({preserve:true,count:2}),
   cleanup:()=>{cleanups++;return boundary==='cleanup'?hold():Promise.resolve({complete:true});},
   preflight:()=>{preflights++;return boundary.startsWith('preflight')?hold():Promise.resolve({status:'recovered',sessionId:credential.sessionId});}});
  const pending=bootstrap.start();await ready;bootstrap.dispose();
  release(boundary==='preflight rejection'?Error('private preflight failure'):boundary==='queue'?{preserve:true,count:2}:boundary==='cleanup'?{complete:true}:{status:'recovered',sessionId:credential.sessionId});
  assert.deepEqual(await pending,{status:'disposed',count:0});
  assert.deepEqual(await bootstrap.retry(),{status:'disposed',count:0});
  assert.equal(preflights,boundary.startsWith('preflight')?1:0);assert.equal(cleanups,boundary==='queue'?0:1);assert.equal(credential.token,'x'.repeat(32));
 }
});

test('completed participant bootstrap releases capability binding while unavailable recovery keeps explicit Retry',async()=>{
 const credential=Object.freeze(state());let calls=0;
 const bootstrap=createPhoneBootstrap({credential,knownInventory:true,code:'ABCDEF',readRecovery:async()=>({preserve:true,count:1}),cleanup:async()=>({complete:true}),
  preflight:async()=>++calls===1?{status:'unavailable'}:{status:'recovered',sessionId:credential.sessionId}});
 assert.deepEqual(await bootstrap.start(),{status:'unavailable',count:1});
 const ready={status:'ready',count:1,sessionId:credential.sessionId};assert.deepEqual(await bootstrap.retry(),ready);
 assert.deepEqual(await bootstrap.retry(),ready);assert.equal(calls,2);
 bootstrap.dispose();assert.deepEqual(await bootstrap.retry(),{status:'disposed',count:0});assert.equal(calls,2);assert.equal(credential.token,'x'.repeat(32));
});

 test('storage Retry repeats bounded validation and cleanup without classifying temporary failure as invalid', async () => {
  const credential=state();let reads=0,cleans=0;
  const bootstrap=createPhoneBootstrap({credential,knownInventory:true,readRecovery:async()=>{reads++;return reads===1?{preserve:false,count:0,status:'unavailable'}:{preserve:true,count:1};},cleanup:async()=>{cleans++;return {complete:true};}});
  assert.deepEqual(await bootstrap.start(),{status:'storage_unavailable',count:0});assert.equal(cleans,0);
  assert.deepEqual(await bootstrap.retry(),{status:'ready',count:1,sessionId:credential.sessionId});assert.equal(reads,2);assert.equal(cleans,1);
 });

test('definitive invalid capability proof survives a temporarily unavailable erasure and Retry',async()=>{
 const credential=state(),proofs=[];let erased=0;
 const bootstrap=createPhoneBootstrap({credential,code:'ABCDEF',knownInventory:true,readRecovery:async()=>({preserve:true,count:0}),preflight:async()=>({status:'refused'}),cleanup:async(reason,selected,proof)=>{if(reason==='token_loss'){proofs.push(proof);return {complete:++erased>1};}return {complete:true};}});
 assert.deepEqual(await bootstrap.start(),{status:'storage_unavailable',count:0});
 assert.deepEqual(await bootstrap.retry(),{status:'refused',count:0});
 assert.deepEqual(proofs,[{provenInvalid:true},{provenInvalid:true}]);
});

test('public QR resolves strict multiple rooms including legacy without erasing foreign capabilities',async()=>{
 const a=state(),b=state(),selected=[],erased=[],probes=[];
 const bootstrap=createPhoneBootstrap({credential:a,code:'ABCDEF',knownInventory:true,candidateCredentials:()=>[a,b],onCandidate:c=>selected.push(c?.sessionId),readRecovery:async()=>({preserve:true,count:1}),cleanup:async reason=>{if(reason==='token_loss')erased.push(reason);return {complete:true};},preflight:async({credential,timeoutMs})=>{probes.push([credential.sessionId,timeoutMs]);return credential===a?{status:'foreign'}:{status:'recovered',sessionId:b.sessionId};}});
 assert.deepEqual(await bootstrap.start(),{status:'ready',count:1,sessionId:b.sessionId});assert.deepEqual(selected,[a.sessionId,b.sessionId]);assert.deepEqual(erased,[]);assert.deepEqual(probes.map(row=>row[0]),[a.sessionId,b.sessionId]);assert.ok(probes.every(row=>row[1]>0&&row[1]<=10000));
});
test('public QR candidate cap, conflicting ownership and unavailable probes never erase other rooms',async()=>{
 const a=state(),b=state();
 for(const candidates of [Array.from({length:21},state),[a,{...a,token:'b'.repeat(32)}]]){let erased=0;const bootstrap=createPhoneBootstrap({code:'ABCDEF',knownInventory:true,candidateCredentials:()=>candidates,cleanup:async()=>{erased++;return {complete:true};}});assert.deepEqual(await bootstrap.start(),{status:'storage_unavailable',count:0});assert.equal(erased,0);}
 let calls=0,erased=0;const captured=[];const bootstrap=createPhoneBootstrap({code:'ABCDEF',knownInventory:true,candidateCredentials:()=>[a,b],onCandidate:c=>captured.push(c),readRecovery:async()=>({preserve:true,count:0}),cleanup:async reason=>{if(reason==='token_loss')erased++;return {complete:true};},preflight:async()=>++calls===1?{status:'unavailable'}:{status:'foreign'}});
 assert.deepEqual(await bootstrap.start(),{status:'unavailable',count:0});assert.deepEqual(await bootstrap.retry(),{status:'refused',count:0});assert.equal(erased,0);assert.equal(captured.at(-1),null);assert.equal(calls,3);
});

test('disposing held multiroom QR probes prevents late scoped erasure and private readiness',async()=>{
 const candidates=[state(),state()];let entered,release,erasures=0;const started=new Promise(resolve=>entered=resolve);
 const bootstrap=createPhoneBootstrap({code:'ABCDEF',knownInventory:true,candidateCredentials:()=>candidates,readRecovery:async()=>({preserve:true,count:0}),cleanup:async reason=>{if(reason==='token_loss')erasures++;return {complete:true};},preflight:()=>{entered();return new Promise(resolve=>release=resolve);}});
 const pending=bootstrap.start();await started;bootstrap.dispose();release({status:'refused'});assert.deepEqual(await pending,{status:'disposed',count:0});assert.equal(erasures,0);
});

test('actual malformed recovery retains validated counts and durable identity through 503 then same-room Retry',async()=>{
 for(const malformed of ['not JSON','{"sessionId":']){
  const credential=state(),tokenBytes=JSON.stringify(credential),events=[],requests=[];
  const rows=[{roomId:credential.sessionId,participantId:uuidv7(),superseded:false,envelope:{v:1,type:'vote',epoch:1,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'Queued private answer'}}}];
  const rowBytes=JSON.stringify(rows);let savedToken=tokenBytes,savedRows=rowBytes,closed=0;
  const replies=[new Response(malformed,{status:200,headers:{'content-type':'application/json'}}),Response.json({error:'unavailable'},{status:503}),Response.json({sessionId:credential.sessionId})];
  const bootstrap=createPhoneBootstrap({code:'ABCDEF',credential,knownInventory:true,
   readRecovery:options=>readParticipantRecovery({...options,openStore:async()=>({read:async room=>{assert.equal(room,credential.sessionId);return JSON.parse(savedRows);},close:async()=>{closed++;}})}),
   cleanup:async(reason,selected,proof)=>{events.push({reason,selected,proof});if(reason==='token_loss'){savedToken=null;savedRows='[]';}return {complete:true};},
   preflight:options=>recoverJoinCapability({...options,fetch:async(url,request)=>{requests.push({url,request});return replies.shift();}})});
  const pending={status:'unavailable',count:1};
  assert.deepEqual(await bootstrap.start(),pending);
  assert.deepEqual(await bootstrap.retry(),pending);
  assert.equal(savedToken,tokenBytes);assert.equal(savedRows,rowBytes);assert.equal(closed,2);
  assert.deepEqual(events.map(({reason,selected})=>({reason,selected})),[{reason:'next_load',selected:true},{reason:'next_load',selected:true}]);
  assert.ok(events.every(event=>event.reason!=='token_loss'));
  assert.deepEqual(await bootstrap.retry(),{status:'ready',count:1,sessionId:credential.sessionId});
  assert.equal(savedToken,tokenBytes);assert.equal(savedRows,rowBytes);assert.equal(closed,3);assert.equal(requests.length,3);
  for(const {url,request} of requests){assert.equal(url,'/api/v1/join/recover');assert.deepEqual(JSON.parse(request.body),{code:'ABCDEF',sessionId:credential.sessionId});assert.equal(request.headers.authorization,'Bearer '+credential.token);}
  assert.deepEqual(await bootstrap.retry(),{status:'ready',count:1,sessionId:credential.sessionId});assert.equal(requests.length,3);
 }
});
