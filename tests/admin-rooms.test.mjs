import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminRooms} from '../src/worker/admin/rooms.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
const email='admin@example.test';
function fixture({foreign=false,audit=true,unavailable=false}={}){
 const owner=uuidv7(),ids=Array.from({length:101},()=>uuidv7()),events=[];
 const rpc={call:async(name,args)=>{
  events.push([name,args]);
  if(name==='list_owned_active_sessions'){
   if(unavailable)return {ok:false};
   return {ok:true,data:(args.p_after===null?ids.slice(0,100):ids.slice(100)).map(session_id=>({session_id,join_code:'AB1234',expires_at:new Date(Date.now()+60000).toISOString()}))};
  }
  return {ok:audit||args.p_phase==='intent',data:args.p_event_id};
 }};
 const roomFor= id=>({adminSummary:async sessionId=>({sessionId,ownerUserId:foreign?uuidv7():owner,status:'live',expiresAt:new Date(Date.now()+60000).toISOString(),phase:'lobby',participantCount:0}),
 adminEnd:async args=>{events.push(['end',id,args]);return {ok:true,status:'ended'};}});
 return {owner,ids,events,rooms:createAdminRooms({rpc,roomFor})};
}
test('Card 21a owned-room termination prefetches next active cursor before audited ends and drains every page',async()=>{
 const f=fixture();assert.deepEqual(await f.rooms.endOwned({userId:f.owner,actorEmail:email,fromPrefix:null}),{ok:true});
 assert.equal(f.events.filter(x=>x[0]==='end').length,101);
 const secondRead=f.events.findIndex(x=>x[0]==='list_owned_active_sessions'&&x[1].p_after!==null);
 assert.ok(secondRead<f.events.findIndex(x=>x[0]==='end'));
 for(const id of f.ids){const index=f.events.findIndex(x=>x[0]==='end'&&x[1]===id);assert.equal(f.events[index-1][0],'write_admin_audit');assert.equal(f.events[index-1][1].p_phase,'intent');assert.equal(f.events[index+1][1].p_phase,'outcome');}
});
test('Card 21a room end refuses foreign current owner and never treats incomplete inventory as success',async()=>{
 for(const options of [{foreign:true},{unavailable:true}]){const f=fixture(options);assert.equal((await f.rooms.endOwned({userId:f.owner,actorEmail:email,fromPrefix:null})).ok,false);assert.equal(f.events.some(x=>x[0]==='end'),false);}
});
test('Card 21a irreversible room end audit failure reports reconciliation without retry or reopening',async()=>{
 const f=fixture({audit:false});const result=await f.rooms.endOwned({userId:f.owner,actorEmail:email,fromPrefix:null});
 assert.equal(result.ok,false);assert.equal(result.error,'manual_reconciliation_needed');assert.equal(f.events.filter(x=>x[0]==='end').length,1);
});

test('Card 21a room end rechecks elevation after durable intent before irreversible DO write',async()=>{
 const owner=uuidv7(),sessionId=uuidv7(),events=[];let fresh=true;
 const rpc={call:async(name,args)=>{events.push(args.p_phase);if(args.p_phase==='intent')fresh=false;return {ok:true,data:args.p_event_id};}};
 const roomFor=()=>({adminSummary:async()=>({sessionId,ownerUserId:owner,status:'live'}),adminEnd:async()=>{events.push('end');return {ok:true,status:'ended'};}});
 const rooms=createAdminRooms({rpc,roomFor});
 const result=await rooms.endOne({sessionId,userId:owner,actorEmail:email,fromPrefix:null,admitted:()=>fresh});
 assert.equal(result.status,403);assert.equal(result.error,'forbidden');assert.deepEqual(events,['intent','outcome']);
});

test('Card 21a owned-room cursor cycle or next-page failure refuses before partial end success',async()=>{
 for(const cycle of [true,false]){
  const f=fixture(),id=f.ids[99];let summaries=0;
  const rpc={call:async(name,args)=>name==='list_owned_active_sessions'?{ok:true,data:args.p_after===null?f.ids.slice(0,100).map(session_id=>({session_id,join_code:'AB1234',expires_at:new Date(Date.now()+60000).toISOString()})):cycle?[{session_id:id,join_code:'AB1234',expires_at:new Date(Date.now()+60000).toISOString()}]:null}:{ok:true}};
  const rooms=createAdminRooms({rpc,roomFor:()=>({adminSummary:async()=>{summaries++;return {sessionId:f.ids[0],ownerUserId:f.owner,status:'live'};}})});
  assert.equal((await rooms.endOwned({userId:f.owner,actorEmail:email,fromPrefix:null})).ok,false);
  assert.equal(summaries,0);
 }
});

test('Card 21a already-ended room still audits and revokes facilitator access without extending participant retention',async()=>{
 const owner=uuidv7(),sessionId=uuidv7(),events=[],cutoff=Date.now()+1000;let facilitatorAccess=true;
 const rpc={call:async(name,args)=>{events.push([args.p_phase,args]);return {ok:true,data:args.p_event_id};}};
 const roomFor=()=>({adminSummary:async()=>({sessionId,ownerUserId:owner,status:'ended'}),adminEnd:async args=>{
  assert.equal(args.sessionId,sessionId);assert.equal(args.expectedOwnerUserId,owner);
  assert.match(args.eventId,/^[0-9a-f-]{36}$/);events.push(['end',args]);facilitatorAccess=false;
  return {ok:true,status:'ended',recapDeleteAt:cutoff};
 }});
 const rooms=createAdminRooms({rpc,roomFor});
 assert.deepEqual(await rooms.endOne({sessionId,userId:owner,actorEmail:email,fromPrefix:null}),{ok:true});
 assert.deepEqual(events.map(x=>x[0]),['intent','end','outcome']);
 assert.deepEqual(events[0][1].p_before,{status:'ended'});
 assert.equal(facilitatorAccess,false);
 assert.deepEqual(Object.keys(events[1][1]).sort(),['eventId','expectedOwnerUserId','sessionId']);
});

async function observed(promise) {
 let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve('still_pending'),150);})]);}finally{clearTimeout(timer);}
}
test('Card 21a stalled native summaries are bounded before intent including the exposed summary method',async()=>{
 const owner=uuidv7(),sessionId=uuidv7(),events=[];
 const rooms=createAdminRooms({budgetMs:20,rpc:{call:async()=>{events.push('audit');return {ok:true};}},roomFor:()=>({adminSummary:()=>new Promise(()=>{}),adminEnd:async()=>{events.push('end');return {ok:true,status:'ended'};}})});
 assert.deepEqual(await observed(rooms.endOne({sessionId,userId:owner,actorEmail:email,fromPrefix:null})),{ok:false,error:'manual_reconciliation_needed'});
 assert.equal(await observed(rooms.summary(sessionId)),null);assert.deepEqual(events,[]);
});
test('Card 21a admitted stalled native end reports unknown outcome without retry or late success',async()=>{
 const owner=uuidv7(),sessionId=uuidv7(),events=[];let finish;
 const rooms=createAdminRooms({budgetMs:20,rpc:{call:async(name,args)=>{events.push(args.p_phase);return {ok:true};}},roomFor:()=>({adminSummary:async()=>({sessionId,ownerUserId:owner,status:'live'}),adminEnd:()=>{events.push('end');return new Promise(resolve=>{finish=resolve;});}})});
 const result=await observed(rooms.endOne({sessionId,userId:owner,actorEmail:email,fromPrefix:null}));
 assert.notEqual(result,'still_pending');assert.equal(result.ok,false);assert.equal(result.error,'manual_reconciliation_needed');
 assert.deepEqual(events.slice(0,2),['intent','end']);assert.equal(events.filter(x=>x==='end').length,1);
 finish({ok:true,status:'ended'});await Promise.resolve();assert.equal(result.ok,false);assert.equal(events.filter(x=>x==='end').length,1);
});
test('Card 21a owned inventory reads share a bounded whole deadline and never admit an expired end',async()=>{
 const owner=uuidv7(),sessionId=uuidv7();let ends=0;
 const stalled=createAdminRooms({budgetMs:20,rpc:{call:()=>new Promise(()=>{})},roomFor:()=>{throw Error('unexpected');}});
 assert.deepEqual(await observed(stalled.endOwned({userId:owner,actorEmail:email,fromPrefix:null})),{ok:false,error:'manual_reconciliation_needed'});
 const rooms=createAdminRooms({budgetMs:20,rpc:{call:async(name)=>name==='list_owned_active_sessions'?{ok:true,data:[{session_id:sessionId,join_code:'AB1234',expires_at:new Date(Date.now()+1000).toISOString()}]}:{ok:true}},roomFor:()=>({adminSummary:async()=>({sessionId,ownerUserId:owner,status:'live'}),adminEnd:async()=>{ends++;return {ok:true,status:'ended'};}})});
 let admissions=0;
 const result=await rooms.endOwned({userId:owner,actorEmail:email,fromPrefix:null,admitted:()=>++admissions===1?true:new Promise(resolve=>setTimeout(()=>resolve(true),40))});
 assert.equal(result.ok,false);assert.equal(ends,0);
});
