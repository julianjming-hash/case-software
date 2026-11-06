// Card26 full MVC simulations. Local by default; staging requires the owner's explicit opt-in.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { voteDiagnostics } from './load-diagnostics.mjs';
import { connect, requestDisplayPair } from '../src/client/transport.mjs';
import { uuidv7, isUuidV7 } from '../src/shared/ids.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';
import { resolvePilotTarget } from './pilot-target.mjs';
import { latencySummary, percentile, stageRoom, LOAD_FACILITATOR } from './load-room.mjs';
import { composeLabel } from '../src/shared/facilitator-label.mjs';
import { assertPublicDisclosure } from '../tests/helpers/public-disclosure.mjs';
export const LOAD_WORKSPACE='01a10b7b-f665-7a0b-bb0a-b9c901663b94';
export const LOAD_VERSION='01a10b7c-1957-707c-a8a3-0a3b4fdbb8b4';
export function parseSimulation(args) {
 const o={clients:25,rooms:1,stagger:0,target:null,own:false};
 for(let i=0;i<args.length;i++) {
  const flag=args[i];if(flag==='--i-own-this-origin'){o.own=true;continue;}
  if(flag==='--full-path')continue;
  if(!['--clients','--rooms','--stagger','--target'].includes(flag)||!args[i+1]||args[i+1].startsWith('--'))throw Error('load_options_invalid');
  const value=args[++i];o[flag.slice(2)]=flag==='--target'?value:Number(value);
 }
 if(![25,50].includes(o.clients)||!Number.isInteger(o.rooms)||![1,5,10].includes(o.rooms)||!Number.isFinite(o.stagger)||o.stagger<0||o.stagger>30)throw Error('load_options_invalid');
 if(o.target==='https://case-staging.iatrogenic.app/')o.target=o.target.slice(0,-1);
 return {...o,target:resolvePilotTarget(o)};
}
export function authorityAtRevision(mirrors,revision) {
 if(!mirrors.some(s=>s.revision>=revision))return null;
 return mirrors.filter(s=>s.revision<=revision).at(-1)??null;
}
export function assertRoomEvidence(r) {
 for(const key of ['lost_votes','duplicate_votes'])if(r[key]!==0)throw Error(`load_${key}`);
 if(r.participants!==r.clients)throw Error('load_duplicate_join');
 if(r.decisions!==3||!r.ended)throw Error('load_full_path_missing');
 if(!(r.public_payloads>0))throw Error('load_public_payloads_missing');
 // Homogeneous answers would make the per-participant recap entitlement check vacuous.
 if(!(r.answer_variety>=2))throw Error('load_answer_variety_missing');
 if(!(r.acknowledgement_ms.p95<1000))throw Error(`load_p95_exceeded ${latencySummary(r.acknowledgement_ms)}`);
 return r;
}
const distribution=values=>Object.fromEntries([50,95,99].map(p=>[`p${p}`,percentile(values,p)]));
export function summarizeRooms(rooms) {
 rooms.forEach(assertRoomEvidence);
 const keys=['clients','expected_votes','receipted_votes','lost_votes','duplicate_votes','join_recoveries','public_payloads','facilitator_paced'];
 const total=Object.fromEntries(keys.map(k=>[k,rooms.reduce((n,r)=>n+(r[k]??0),0)]));
 const actions={},transport_modes={},http_by_route={};
 for(const r of rooms){for(const [k,n]of Object.entries(r.actions))actions[k]=(actions[k]??0)+n;for(const[k,n]of Object.entries(r.transport_modes??{}))transport_modes[k]=(transport_modes[k]??0)+n;for(const[k,n]of Object.entries(r.http_by_route??{}))http_by_route[k]=(http_by_route[k]??0)+n;}
 return {...total,rooms:rooms.length,acknowledgement_ms:distribution(rooms.flatMap(r=>r.samples)),fanout_lag_ms:distribution(rooms.flatMap(r=>r.fanout_samples)),actions,transport_modes,http_by_route};
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,error) {const end=Date.now()+10000;while(Date.now()<end){if(predicate())return;await sleep(10);}throw Error(error);}
function privateStrings(pack) {return [...pack.surfaces.map(s=>s.notes),...pack.decisions.flatMap(d=>d.paths.flatMap(p=>[p.cue,p.rationale]))].filter(Boolean);}
// Independent RT04 occurrence ledger: never use a runtime projection to derive reveal expectations.
function withheldStrings(pack,mirror) {
 const groups=['scene','observations','findings','investigations'];
 const allowed=new Set();
 for(const entry of mirror.revealed){
  const surface=pack.surfaces.find(s=>s.id===entry.surfaceId);
  const populated=groups.filter(g=>g==='scene'?!!surface.scene:g==='observations'?!!surface.observations?.length:g==='findings'?!!surface.points?.length:!!surface.investigations?.length);
  for(const g of populated.slice(0,entry.groupsShown)){
   const values=g==='scene'?[surface.scene]:g==='observations'?surface.observations.flatMap(o=>[o.label,o.value]):g==='findings'?surface.points:surface.investigations;
   values.forEach(v=>allowed.add(v));
  }
 }
 return pack.surfaces.flatMap(s=>[s.scene,...(s.observations??[]).flatMap(o=>[o.label,o.value]),...(s.points??[]),...(s.investigations??[])]).filter(v=>v&&!allowed.has(v));
}
// The facilitator's compact historical mirror contains control references, not private answers.
// Independently retain only commands whose matching receipt proved actual acceptance.
export function recordAcceptedVote(ledger,{participantId,roundId,clientEventId,response},receipt) {
 assert.ok([participantId,roundId,clientEventId].every(isUuidV7),'accepted vote identity');
 assert.deepEqual(Object.keys(response).sort(),['option_id'],'simulation single-choice response');
 assert.ok(isUuidV7(response.option_id),'accepted vote option');
 assert.equal(receipt?.clientEventId,clientEventId,'accepted vote receipt identity');
 assert.ok(['accepted','already_accepted'].includes(receipt.receipt),'accepted vote receipt');
 assert.ok(Number.isSafeInteger(receipt.revision)&&receipt.revision>=0,'accepted vote receipt revision');
 const key=`${roundId}:${participantId}`,record={clientEventId,response:structuredClone(response),receipt:structuredClone(receipt)};
 if(ledger.has(key))assert.deepEqual(ledger.get(key),record,'one proven final simulation vote per owner/round');
 else ledger.set(key,record);
}
export function disclosurePayload(payload,pack,mirror,acceptedVotes,facilitatorLabel=null){
 const copy=structuredClone(payload),view=copy.view;
 // The facilitator's label (Name & role, fixed at start) reaches only an ended phone's own recap, exactly.
 const scrubbed=view?.recap?{...copy,view:{...view,recap:{...view.recap,facilitator:null}}}:copy;
 if(facilitatorLabel)assert.equal(JSON.stringify(scrubbed).includes(facilitatorLabel),false,'facilitator label outside an ended recap');
 if(!view?.recap)return copy;
 assert.equal(view.recap.facilitator,facilitatorLabel??undefined,'recap facilitator label');
 assert.equal(view.role,'participant','only the participant gets an own recap');
 assert.equal(mirror.phase,'ended','recap must wait until end');
 const owner=view.you?.id;assert.ok(mirror.participants[owner],'recap participant is known');
 for(const round of view.recap.rounds){
  // Room PDFs v2: `room` (the room's split) is the only optional key, and only for a result the projector drew (checked below).
  assert.deepEqual(Object.keys(round).filter(k=>k!=='room').sort(),['decisionId','prompt','roundNo','status','optionIds','yourResponse','yourAnswer','yourClassification','why','doDifferently','teamChoice','whatHappened','revealIndex'].sort(),'recap schema');
  // Card 40 slice 3 (I4): revealIndex points only into this phone's own revealed timeline, at the slide the round revealed.
  if(round.revealIndex===null)assert.equal(round.whatHappened,null,'no reveal index without a revealed outcome');
  else{assert.ok(Number.isSafeInteger(round.revealIndex)&&round.revealIndex>=0&&round.revealIndex<(view.timeline?.length??0),'reveal index inside the own timeline');assert.equal(view.timeline[round.revealIndex].title,round.whatHappened,'reveal index names the revealed slide');}
  const stored=mirror.rounds.find(r=>r.decisionId===round.decisionId&&r.no===round.roundNo);
  assert.ok(stored,'recap round has exact authoritative control');
  const accepted=acceptedVotes.get(`${stored.id}:${owner}`);
  assert.ok(accepted,'own recap requires a matching accepted submission');
  assert.deepEqual(round.yourResponse,accepted.response,'own recap response');
  const decision=pack.decisions.find(d=>d.id===round.decisionId);
  if(round.room!==undefined){
   // Exactly the shown result: a resolved round the projector drew, its total, and each option's label and count in the shared order.
   assert.equal(stored.status,'resolved','room split only for a resolved round');
   assert.equal(stored.shown,true,'room split only for a result the room was shown');
   assert.deepEqual(Object.keys(round.room).sort(),['options','total'],'room split schema');
   assert.notEqual(decision.interaction.type,'free_text','no room split for free text');
   assert.equal(round.room.total,stored.aggregate.total,'room split total');
   assert.ok(round.room.options.every(o=>Number.isSafeInteger(o.count)&&o.count>=0),'room split counts are integers, never position arrays');
   // A ranking's split counts first places (its positions when the aggregate keeps them); any other shape, the shared counts.
   const ranking=decision.interaction.type==='ranking',first=o=>ranking?stored.aggregate.positionCounts?.[o.id]?.[0]:stored.aggregate.counts[o.id];
   if(!ranking||stored.aggregate.positionCounts)assert.deepEqual(round.room.options,(decision.interaction.options??[]).map(o=>({label:o.label,count:first(o)??0})),'room split counts and labels');
   else{assert.deepEqual(round.room.options.map(o=>o.label),(decision.interaction.options??[]).map(o=>o.label),'room split labels');assert.ok(round.room.options.reduce((n,o)=>n+o.count,0)<=round.room.total,'first places within the total');}
  }
  const mine=decision.paths.find(p=>p.option_ids?.includes(round.yourResponse?.option_id));
  const recommended=decision.paths.find(p=>p.recommended);
  const label=recommended?(decision.interaction.options??[]).filter(o=>(recommended.option_ids??[]).includes(o.id)).map(o=>o.label).join(' / ')||recommended.label:null;
  assert.equal(round.why,mine?.rationale??null,'own recap teaching rationale');
  assert.equal(round.yourClassification,mine?.classification??null,'own recap classification');
  assert.equal(round.doDifferently,mine&&!mine.recommended&&label?`Recommended here: ${label}. ${recommended.rationale}`:null,'own recap alternative');
  // Only the contract-checked own teaching fields are entitled at end (CASE-082).
  round.why=null;round.doDifferently=null;
 }
 return copy;
}
// Pure admission: target, size and pinned staging workspace/version. The CLI calls this before it reads a credential.
export function admitSimulation(options,environment=process.env) {
 // Re-admit supplied objects before IO, not only CLI arguments.
 const target=resolvePilotTarget({target:options.target?.origin??null,own:options.own===true});
 if(![1,5,10].includes(options.rooms)||![25,50].includes(options.clients)||!Number.isFinite(options.stagger)||options.stagger<0||options.stagger>30)throw Error('load_options_invalid');
 if(target.kind==='staging'&&options.clients!==25)throw Error('staging_load_size_refused');
 if(target.kind==='staging'&&(environment.CASE_LOAD_WORKSPACE_ID!==LOAD_WORKSPACE||environment.CASE_LOAD_CASE_VERSION_ID!==LOAD_VERSION))throw Error('staging_load_workspace_refused');
 return target;
}
export async function runSimulatedRooms(options,{fetchImpl=fetch,startLocal,createLocalRoom,environment=process.env}={}) {
 const target=admitSimulation(options,environment);
 let worker;const links=new Set();let stopping=false;const start=new Date().toISOString();
 try {
  // An inline local room has no label; a staging room starts with the load account's this-session override.
  let origin,makeRoom,facilitatorLabel=null;
  if(target.kind==='local'){
   const helpers=await import('../tests/helpers/local-worker.mjs');
   // Direct workerd, without wrangler dev's ProxyWorker, which drops connections under vote bursts (AS-097).
   worker=await(startLocal??(await import('../tests/helpers/direct-worker.mjs')).startDirectWorker)();origin=worker.origin;
   if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('load_local_origin_refused');
   makeRoom=fetch=> (createLocalRoom??helpers.createRoom)(origin,{fetchImpl:fetch});
  }else{origin=target.origin;makeRoom=()=>stageRoom(origin,environment,fetchImpl,{own:true});facilitatorLabel=composeLabel(LOAD_FACILITATOR.name,LOAD_FACILITATOR.role);}
  const tasks=Array.from({length:options.rooms},(_,index)=>(async()=>{await sleep(index*options.stagger*1000);if(stopping)throw Error('load_aborted');try{return await runRoom(index,origin,makeRoom,facilitatorLabel);}catch(error){stopping=true;throw error;}})());
  const results=await Promise.allSettled(tasks);const failures=results.filter(r=>r.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(r=>r.reason),`load_room_failed: ${failures.map(r=>String(r.reason?.message).split('\n')[0].slice(0,80)).join(', ')}`);
  const rooms=results.map(r=>r.value);return {started_at:start,ended_at:new Date().toISOString(),target:target.kind,stagger_seconds:options.stagger,total:summarizeRooms(rooms),rooms};
 }finally{stopping=true;for(const link of links)link.close();await worker?.stop();}
 // The label is the try block's own (let), so each room takes it as an argument.
 async function runRoom(index,origin,makeRoom,facilitatorLabel){
  let facilitator,room,pack,mirror,ended=false,publicPayloads=0,joinRecoveries=0,loss=false,joinLoss=false,paced=0;
  let failure,publicFailure;const own=[];const actions={http:0,ws_in:0,ws_out:0,long_poll_cycles:0,poll_cycles:0};const routeCounts={};
  const diagnostics=voteDiagnostics();
  const phones=[],counts=[],samples=[],fanout=[],receiptIds=[],expectedIds=[];const transportMix={};
  const waitingPublic=[], mirrors=[];const chosenByRound={},acceptedVotes=new Map();
  const check=payload=>{
    waitingPublic.push(payload);
    for(let i=waitingPublic.length-1;i>=0;i--){
      const pending=waitingPublic[i];
      const authority=authorityAtRevision(mirrors,pending.revision);
      if(!pack||!authority)continue;
      try{assertPublicDisclosure(disclosurePayload(pending,pack,authority.mirror,acceptedVotes,facilitatorLabel),[...privateStrings(pack),room.facilitatorToken,environment.CASE_LOAD_AUTH_TOKEN].filter(Boolean),withheldStrings(pack,authority.mirror));publicPayloads++;}catch(error){publicFailure??=error;}
      waitingPublic.splice(i,1);
    }
  };
  const checkEnvelope=payload=>{
   const envelope=structuredClone(payload);delete envelope.snapshot;
   try{assertPublicDisclosure(envelope,[...privateStrings(pack),room.facilitatorToken,environment.CASE_LOAD_AUTH_TOKEN].filter(Boolean));}catch(error){publicFailure??=error;}
  };
  const meterSocket=(count=null,isPublic=false)=>class extends globalThis.WebSocket{
    constructor(url){super(url);this.addEventListener('message',event=>{actions.ws_in++;if(count)count.ws_in++;if(isPublic){const frame=JSON.parse(event.data);if(frame.t==='snapshot')check(frame);else checkEnvelope(frame);}});}
    send(frame){actions.ws_out++;if(count)count.ws_out++;super.send(frame);}
  };
  const acquire=link=>{links.add(link);own.push(link);return link;};
  const guard=async(url,init={})=>{
   if(new URL(String(url)).origin!==origin)throw Error('load_cross_origin_refused');
   if(++actions.http>options.clients*400)throw Error('load_action_budget_exceeded');
   const path=new URL(String(url)).pathname.replace(/\/sessions\/[^/]+/,'/sessions/:room').replace(/\/display-pairs\/[^/]+/,'/display-pairs/:pair');
   const route=`${init.method??'GET'} ${path}`;routeCounts[route]=(routeCounts[route]??0)+1;
   return fetchImpl(url,{...init,redirect:'manual'});
  };
  try{
   room=target.kind==='staging'?await stageRoom(origin,environment,guard,{own:true}):await makeRoom(guard);facilitator=acquire(connect({role:'facilitator',WebSocketImpl:meterSocket(),api:origin,sessionId:room.sessionId,token:room.facilitatorToken,fetchImpl:guard,telemetryImpl:()=>{}}));
   await until(()=>facilitator.casePack&&facilitator.snapshot?.mirror,'load_facilitator_missing');pack=facilitator.casePack;mirror=facilitator.snapshot.mirror;
   mirrors.push(facilitator.snapshot);
   facilitator.on('snapshot',s=>{mirror=s.mirror;mirrors.push(s);for(const payload of [...waitingPublic]){waitingPublic.splice(waitingPublic.indexOf(payload),1);check(payload);}});
   const pair=await requestDisplayPair({api:origin,fetchImpl:guard});if(!pair.code)throw Error('load_pair_failed');
   if(!(await facilitator.approveDisplay(pair.code)).ok)throw Error('load_pair_failed');const credential=await pair.poll();
   const display=acquire(connect({role:'display',WebSocketImpl:meterSocket(null,true),api:origin,...credential,fetchImpl:async(url,init)=>{const response=await guard(url,init);if(response.status===200){const body=await response.clone().json();if(body.t==='snapshot')check(body);else checkEnvelope(body);if(body.snapshot)check(body.snapshot);}return response;},telemetryImpl:()=>{}}));
   display.on('snapshot',check);await until(()=>display.snapshot,'load_display_missing');
   for(let i=0;i<options.clients;i++){
    const count={http:0,ws_in:0,ws_out:0,long_poll_cycles:0,poll_cycles:0};counts.push(count);
    let hooks;const lifecycle={visible:()=>true,on:(...args)=>{hooks=args;},off:()=>{}};
    const Socket=meterSocket(count,true);
    const phoneFetch=async(url,init={})=>{
     count.http++;const path=new URL(String(url)).pathname;const command=init.method==='POST'&&path.endsWith('/commands')?JSON.parse(init.body):null;
     if(path.endsWith('/updates')){count.long_poll_cycles++;actions.long_poll_cycles++;if(i%3===2)return Response.json({error:'unavailable'},{status:503});}
     if(path.endsWith('/snapshot')){count.poll_cycles++;actions.poll_cycles++;}
     const diagnostic=command?.type==='vote'?diagnostics.attempt(command.clientEventId):null;
     let failed=false;
     try {
     const response=await guard(url,init);diagnostic?.headers(response.status);
     if(i===0&&path.endsWith('/join')&&response.status===201&&!joinLoss){await response.clone().json();joinLoss=true;joinRecoveries++;throw new TypeError('load_join_response_loss');}
     if(response.status===200){const body=await response.clone().json();if(body.t==='snapshot')check(body);else checkEnvelope(body);if(body.snapshot)check(body.snapshot);diagnostic?.inspected();
      if(i===0&&command?.type==='vote'&&!loss&&body.receipt?.receipt==='accepted'){loss=true;throw new TypeError('load_vote_response_loss');}}
     return response;
     } catch(error) {failed=true;throw error;}
     finally {diagnostic?.finish({failed,aborted:init.signal?.aborted===true});}
    };
    class BlockedSocket{constructor(){throw Error('local_socket_blocked');}}
    const phone=acquire(connect({role:'participant',slot:`room-${index}-phone-${i}`,api:origin,fetchImpl:phoneFetch,WebSocketImpl:i%3===0?Socket:BlockedSocket,lifecycle,telemetryImpl:()=>{}}));
    phone.on('snapshot',check);phones.push({phone,cycle:()=>{hooks?.[0]?.();hooks?.[1]?.();}});
   }
   const joins=await Promise.all(phones.map(({phone},i)=>phone.join(room.joinCode,`Phone ${i+1}`,AVATAR_IDS[i%AVATAR_IDS.length])));
   if(joins.some(j=>!j.ok))throw Error('load_join_failed');
   await facilitator.refetch();
   if(facilitator.snapshot.view.participants.length!==options.clients)throw Error('load_duplicate_join');
   if(new Set(joins.map(j=>j.participantId)).size!==options.clients)throw Error('load_duplicate_join');
   // The room limits each credential to a burst of 20 commands refilled at 2/s (BUCKET in room-do).
   // A scripted facilitator outpaces a person once rounds drain fast, so a rate-limited command waits
   // for the refill and is sent again (CASE-169); the count is reported, and votes are never retried here.
   const send=async(type,extra={})=>{if(publicFailure)throw publicFailure;let receipt=await facilitator.send(type,extra);for(let wait=0;receipt.receipt==='rejected'&&receipt.reason==='rate_limited'&&wait<20;wait++){paced++;await sleep(600);receipt=await facilitator.send(type,extra);}if(!['accepted','already_accepted'].includes(receipt.receipt))throw Error(`load_${type}_refused`);await until(()=>facilitator.snapshot.revision>=receipt.revision,'load_facilitator_fanout');return receipt;};
   await send('start');let decisions=0;
   for(let step=0;step<100;step++){
    const view=facilitator.snapshot.view;
    if(view.phase==='responses_open'){
     decisions++;const roundId=view.round.id;
     await until(()=>phones.every(({phone})=>phone.snapshot?.view?.decision?.roundId===roundId),'load_phone_fanout');
     await Promise.all(phones.map(async({phone,cycle},i)=>{
      if(i%5===0)cycle();const options_=phone.snapshot.view.decision.interaction.options,chosen=options_[i%options_.length].id;(chosenByRound[roundId]??=new Set()).add(chosen);const id=uuidv7();expectedIds.push(id);diagnostics.begin(id,i,decisions);const at=performance.now();
      const rb=await phone.sendFrame({v:1,t:'command',type:'vote',epoch:phone.snapshot.epoch,clientEventId:id,roundId,response:{option_id:chosen}});
      if(rb.clientEventId!==id||!['accepted','already_accepted'].includes(rb.receipt))throw Error('load_lost_votes');
      recordAcceptedVote(acceptedVotes,{participantId:joins[i].participantId,roundId,clientEventId:id,response:{option_id:chosen}},rb);
      const receivedAt=performance.now();samples.push(receivedAt-at);diagnostics.receipt(id);receiptIds.push(rb.clientEventId);
      await until(()=>facilitator.snapshot.revision>=rb.revision,'load_fanout_missing');fanout.push(Math.max(0,performance.now()-receivedAt));
     }));
     if(Object.keys(facilitator.snapshot.mirror.round.responses).length!==options.clients)throw Error('load_recorded_vote_count_mismatch');
     await send('lock');const decision=pack.decisions.find(d=>d.id===facilitator.snapshot.mirror.decisionId);
     // Fixed authored path only; votes do not choose it. MVC's first path continues through all decisions.
     await send('select_path',{pathId:decision.paths[0].id});await send('show_results',{on:false});await send('reveal');
    }else if(['surface_live','consequence_revealed'].includes(view.phase)){
     const last=mirror.revealed.at(-1),surface=pack.surfaces.find(s=>s.id===last?.surfaceId);
     const groups=[surface?.scene,surface?.observations?.length,surface?.points?.length,surface?.investigations?.length].filter(Boolean).length;
     if(!mirror.nextBeatId&&!mirror.decisionId&&last?.groupsShown>=groups){await send('end');ended=true;break;}
     await send('advance');
    }else throw Error('load_full_path_unexpected');
   }
   if(!ended)throw Error('load_full_path_missing');
   await until(()=>phones.every(({phone})=>phone.snapshot?.view?.recap),'load_recap_missing');
   for(const{phone}of phones)transportMix[phone.mode]=(transportMix[phone.mode]??0)+1;
   if(publicFailure)throw publicFailure;
   if(waitingPublic.length)throw Error('load_unchecked_public_payload');
   if(!loss||!joinLoss)throw Error('load_loss_injection_missing');
   const unique=new Set(receiptIds);return assertRoomEvidence({room_index:index,facilitator_paced:paced,answer_variety:Math.min(...Object.values(chosenByRound).map(set=>set.size)),clients:options.clients,decisions,ended,participants:facilitator.snapshot.view.participants.length,expected_votes:expectedIds.length,receipted_votes:unique.size,lost_votes:expectedIds.length-unique.size,duplicate_votes:receiptIds.length-unique.size,join_recoveries:joinRecoveries,public_payloads:publicPayloads,acknowledgement_ms:distribution(samples),fanout_lag_ms:distribution(fanout),transport_modes:transportMix,per_phone_messages:counts,actions,http_by_route:routeCounts,samples,fanout_samples:fanout});
  }catch(error){failure=error;if(error.stagePostAttempted)throw new AggregateError([error,Error('load_room_ttl_fallback')],'load_room_ttl_fallback');throw error;}
  finally{
   let cleanup;
   if(room&&!ended&&facilitator){try{await facilitator.refetch();let timer;const rb=await Promise.race([facilitator.send('end'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('load_end_unconfirmed')),10000);})]).finally(()=>{clearTimeout(timer);facilitator.dropPending();});if(!['accepted','already_accepted'].includes(rb.receipt))cleanup=Error('load_end_unconfirmed');}catch{cleanup=Error('load_end_unconfirmed');}}
   for(const link of own){link.close();links.delete(link);}
   // Same failure retention as Worker logs. Numeric evidence only; never write a staging capability or case.
   if(target.kind==='local'&&environment.CASE_WORKER_LOG_DIR){
    try {mkdirSync(environment.CASE_WORKER_LOG_DIR,{recursive:true});
    writeFileSync(join(environment.CASE_WORKER_LOG_DIR,`simulated-${options.rooms}-${index}.json`),JSON.stringify({room_index:index,clients:options.clients,node:process.versions.node,undici:process.versions.undici??null,votes:diagnostics.report()})+'\n');}
    catch {console.error('load_diagnostic_write_failed',JSON.stringify({room_index:index,votes:diagnostics.report()}));}
   }
   if(cleanup)throw new AggregateError([...(failure?[failure]:[]),cleanup],'load_cleanup_failed',{cause:failure});
  }
 }
}
