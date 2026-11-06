import test from 'node:test';
import assert from 'node:assert/strict';
import {readAdminInventory} from '../src/worker/admin/inventory.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
const now=Date.now(),owner=uuidv7(),session=uuidv7();
const entry={code:'A00001',sessionId:session,registeredAt:null,expiresAt:new Date(now+60000).toISOString()};
function fixture(){
 const calls=[];
 return {calls,input:{query:new URLSearchParams('limit=1&after=A'),
 directoryFor:shard=>({adminInventory:async args=>{calls.push([shard,args]);return {rows:[entry],nextCode:entry.code};}}),
 roomFor:()=>({adminSummary:async()=>({sessionId:session,ownerUserId:owner,status:'live',expiresAt:entry.expiresAt,phase:'lobby',participantCount:2,participants:[{private:'name'}]})}),
 gotrue:{getUser:async()=>({ok:true,user:{id:owner,email:'owner@example.test',name:'private'}})}}};
}
test('Card 21a live inventory keeps bounded shard cursor and only approved aggregate metadata',async()=>{
 const f=fixture(),result=await readAdminInventory(f.input);
 assert.deepEqual(result,{ok:true,rooms:[{...entry,ownerEmail:'owner@example.test',phase:'lobby',participantCount:2}],nextCursor:'A:A00001'});
 assert.deepEqual(f.calls,[['A',{limit:1,afterCode:null}]]);
});
test('Card 21a inventory refuses malformed cursor and unavailable owner without false empty success',async()=>{
 const f=fixture();f.input.query=new URLSearchParams('after=A:B00001');assert.equal((await readAdminInventory(f.input)).status,400);assert.deepEqual(f.calls,[]);
 const failed=fixture();failed.input.gotrue.getUser=async()=>({ok:false,kind:'unavailable'});assert.equal((await readAdminInventory(failed.input)).status,503);
});
test('Card 21a inventory accepts every canonical active phase including consequence and terminal teaching',async()=>{
 for(const phase of ['lobby','surface_live','responses_open','responses_locked','path_selected','consequence_revealed','terminal_teaching','discussion_paused']){
  const f=fixture();f.input.roomFor=()=>({adminSummary:async()=>({sessionId:session,ownerUserId:owner,status:'live',expiresAt:entry.expiresAt,phase,participantCount:2})});
  const result=await readAdminInventory(f.input);
  assert.deepEqual(result,{ok:true,rooms:[{...entry,ownerEmail:'owner@example.test',phase,participantCount:2}],nextCursor:'A:A00001'},phase);
 }
});
test('Card 21a inventory refuses inconsistent live ended or unknown phases while skipping authoritative ended rooms',async()=>{
 for(const phase of ['ended','unknown_phase']){
  const f=fixture();f.input.roomFor=()=>({adminSummary:async()=>({sessionId:session,ownerUserId:owner,status:'live',expiresAt:entry.expiresAt,phase,participantCount:2})});
  assert.equal((await readAdminInventory(f.input)).status,503,phase);
 }
 const ended=fixture();ended.input.directoryFor=shard=>({adminInventory:async()=>({rows:shard==='A'?[entry]:[],nextCode:null})});
 ended.input.roomFor=()=>({adminSummary:async()=>({sessionId:session,status:'ended',phase:'ended'})});
 assert.deepEqual(await readAdminInventory(ended.input),{ok:true,rooms:[],nextCursor:null});
});
