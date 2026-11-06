import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createAdminModel} from '../src/client/admin-model.mjs';
import {createAdminElevation} from '../src/client/admin-elevation.mjs';
const user=()=>({id:randomUUID(),email:'facilitator@example.invalid',profile:{admin_revision:2},access:null});
const success=rows=>({ok:true,data:{users:rows,nextPage:null}});
// The elevation is the session's (admin-elevation.mjs); the model reads it and drops it on a 403.
function held(api){const elevation=createAdminElevation(api);return elevation;}
async function elevated(api){const elevation=createAdminElevation({call:async op=>op==='stepup_verify'?{ok:true,data:{elevation:randomBytes(24).toString('hex')}}:{ok:true,data:{accepted:true}}});await elevation.verify('123456');return elevation;}
test('Card21b table generation fences stale paging and account cleanup before private rows can return',async()=>{
 let resolve,closed=0;const api={call:()=>new Promise(done=>resolve=done),close(){closed++;}};const model=createAdminModel({api,elevation:held(api)});
 const loading=model.load();model.clear('sign_out');resolve(success([user()]));await loading;
 assert.equal(model.state.gate,'sign_in');assert.deepEqual(model.state.rows,[]);assert.equal(model.state.query,'');
 assert.equal(closed,0,'leaving People never closes the shell\'s API client');
});
test('Card21b sparse search retains truthful continuation while unavailable and forbidden remain distinct',async()=>{
 let result={ok:true,data:{users:[],nextPage:3}};const calls=[];
 const api={call:async(op,args)=>{calls.push([op,args]);return result;},close(){}};const model=createAdminModel({api,elevation:held(api)});
 await model.search('facilitator');assert.equal(model.state.next,3);assert.deepEqual(model.state.rows,[]);assert.equal(calls[0][0],'facilitators_search');assert.equal(calls[0][1].body.query,'facilitator');
 result={ok:false,status:503,error:'admin_unavailable'};await model.load();assert.equal(model.state.gate,'ready','a screen that loaded once keeps its last data');assert.equal(model.state.refreshFailed,true);
 const fresh=createAdminModel({api,elevation:held(api)});await fresh.load();assert.equal(fresh.state.gate,'unavailable','nothing was ever shown, so it is unavailable');
 result={ok:false,status:403,error:'forbidden'};await model.load();assert.equal(model.state.gate,'admin_only');assert.deepEqual(model.state.rows,[]);model.clear();
});
test('Card21b null profiles cannot mutate and destructive actions use captured revision with one flight and no automatic retry',async()=>{
 let resolve;const calls=[];const target=user();const api={call:async(op,args)=>{calls.push([op,args]);return new Promise(done=>resolve=done);},close(){}};
 const elevation=await elevated(api);const model=createAdminModel({api,elevation});
 assert.deepEqual(await model.act('facilitators_disable',{record:{...target,profile:null}}),{ok:false,status:0,error:'bad_request'});assert.equal(calls.length,0);
 const pending=model.act('facilitators_disable',{record:target});const second=await model.act('facilitators_disable',{record:target});assert.equal(calls.length,1);assert.equal(second.ok,false);assert.deepEqual(calls[0][1].body,{expectedRevision:2,confirmEmail:target.email});
 resolve({ok:false,status:500,error:'manual_reconciliation_needed'});const result=await pending;
 assert.equal(calls.length,1);assert.deepEqual(result,{ok:false,status:500,error:'manual_reconciliation_needed'});model.clear();
});
test('Card21b a destructive action without this session\'s code is refused before any request',async()=>{
 const calls=[];const api={call:async op=>{calls.push(op);return success([]);},close(){}};const model=createAdminModel({api,elevation:held(api)});
 const result=await model.act('facilitators_soft_delete',{record:user()});assert.deepEqual(result,{ok:false,status:403,error:'step_up_required'});assert.deepEqual(calls,[]);
});
test('Card21b conflict refreshes authoritative metadata without replaying an irreversible write and reconciliation remains explicit',async()=>{
 const calls=[];let actionResult={ok:false,status:409,error:'conflict'};const target=user();
 const api={call:async op=>{calls.push(op);return op==='facilitators_list'?success([target]):actionResult;},close(){}};
 const model=createAdminModel({api,elevation:await elevated(api)});
 await model.act('facilitators_disable',{record:target});
 assert.deepEqual(calls,['facilitators_disable','facilitators_list']);assert.match(model.state.notice,/changed/i);
 actionResult={ok:false,status:500,error:'manual_reconciliation_needed'};const result=await model.act('facilitators_disable',{record:target});assert.equal(result.error,'manual_reconciliation_needed');model.clear();
});
test('Card21b R-a: a refused action drops the session\'s step-up so the next one asks again',async()=>{
 const api={close(){},async call(op){return op==='facilitators_disable'?{ok:false,status:403,error:'forbidden'}:success([])}};
 const elevation=await elevated(api);const model=createAdminModel({api,elevation});
 assert.equal(elevation.has(),true);assert.equal((await model.act('facilitators_disable',{record:user()})).status,403);assert.equal(elevation.has(),false);
 assert.equal(JSON.stringify(model.state).includes('token'),false);
});
