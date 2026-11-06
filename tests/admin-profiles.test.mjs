import test from 'node:test';
import assert from 'node:assert/strict';
import {handleProfileAction} from '../src/worker/admin/profiles.mjs';
import {matchAdminRoute} from '../src/worker/admin/routes.mjs';
import {mintElevation} from '../src/worker/admin/stepup.mjs';
import {uuidv7,newCapabilityToken} from '../src/shared/ids.mjs';
const now=Date.parse('2026-10-03T00:00:00Z');
async function fixture({outcome=true,rollback=true,email='target@example.test',provider=true}={}) {
 const targetId=uuidv7(),actorId=uuidv7(),secret=newCapabilityToken(),session=uuidv7(),events=[];
 const env={ADMIN_EMAILS:'admin@example.test',STEPUP_SECRET:secret};
 const state={user_id:targetId,disabled_at:null,soft_deleted_at:null,delete_due_at:null,admin_revision:2};
 const next={...state,disabled_at:new Date(now).toISOString(),admin_revision:3};
 let clock=now;
 const {token}=await mintElevation('admin@example.test',session,secret);
 const request=new Request(`https://case.invalid/api/v1/admin/facilitators/${targetId}/disable`,{method:'POST',headers:{'x-admin-elevation':token}});
 const input={request,route:matchAdminRoute(new URL(request.url).pathname,'POST'),user:{userId:actorId,email:'admin@example.test',sessionId:session},env,body:{expectedRevision:2,confirmEmail:email},nowMs:()=>clock,
  gotrue:{getUser:async()=>({ok:true,user:{id:targetId,email,bannedUntil:null}}),updateUser:async(id,args)=>{events.push(['ban',id,args]);return {ok:provider};}},
  rpc:{call:async(name,args)=>{events.push([name,args]);if(name==='admin_read_profiles')return {ok:true,data:[state]};if(name==='admin_account_active')return {ok:true,data:true};if(name==='admin_transition_profile')return {ok:true,data:[next]};if(name==='admin_revert_profile')return {ok:rollback,data:[{...state,admin_revision:4}]};return {ok:args.p_phase!=='outcome'||outcome,data:args.p_event_id};}},
  rooms:{endOwned:async args=>{events.push(['endOwned',args]);return {ok:true};}}};
 return {input,events,state,next,session,setClock:value=>clock=value};
}
test('Card 21a profile disable uses target CAS then ban and audited success before owned-room termination',async()=>{
 const f=await fixture();const response=await handleProfileAction(f.input);
 assert.equal(response.status,200);
 assert.deepEqual(f.events.map(x=>x[0]),['admin_read_profiles','admin_account_active','write_admin_audit','admin_transition_profile','ban','write_admin_audit','endOwned']);
 assert.equal(f.events[2][1].p_phase,'intent');
 assert.deepEqual(f.events[3][1],{p_user_id:f.state.user_id,p_expected_revision:2,p_action:'disable',p_admin:true,p_admin_email:'admin@example.test'});
 assert.deepEqual(f.events[4][2],{banDuration:'876000h'});
 assert.equal(f.events[6][1].userId,f.state.user_id);
 // [PM-38] R-a: the same session elevation admits the next destructive action too.
 f.state.admin_revision=2;assert.equal((await handleProfileAction(f.input)).status,200);
});
test('Card 21a destructive profile actions refuse protected admin and expired or other-email elevation without writes',async()=>{
 const protectedTarget=await fixture({email:'admin@example.test'});
 assert.equal((await handleProfileAction(protectedTarget.input)).status,403);
 assert.deepEqual(protectedTarget.events,[]);
 for(const kind of ['missing','session','other']) {
  const f=await fixture();
  if(kind==='missing')f.input.request.headers.delete('x-admin-elevation');
  if(kind==='session')f.input.user={...f.input.user,sessionId:uuidv7()};
  if(kind==='other')f.input.request.headers.set('x-admin-elevation',(await mintElevation('other@example.test',f.session,f.input.env.STEPUP_SECRET)).token);
  assert.equal((await handleProfileAction(f.input)).status,403);
  assert.equal(f.events.some(x=>['write_admin_audit','admin_transition_profile','ban','endOwned'].includes(x[0])),false);
 }
 const f=await fixture(),call=f.input.rpc.call;
 f.input.rpc.call=async(name,args)=>name==='admin_account_active' ? {ok:true,data:{}} : call(name,args);
 const malformed=await handleProfileAction(f.input);
 assert.equal(malformed.status,503);assert.deepEqual(await malformed.json(),{error:'admin_unavailable'});
 assert.equal(f.events.some(x=>['write_admin_audit','admin_transition_profile','ban','endOwned'].includes(x[0])),false);
});
test('Card 21a profile audit failure restores prior ban and exact state by new revision or reports reconciliation',async()=>{
 const f=await fixture({outcome:false});assert.equal((await handleProfileAction(f.input)).status,500);
 assert.deepEqual(f.events.filter(x=>x[0]==='ban').map(x=>x[2]),[{banDuration:'876000h'},{banDuration:'none'}]);
 assert.deepEqual(f.events.find(x=>x[0]==='admin_revert_profile')[1],{p_user_id:f.state.user_id,p_expected_revision:3,p_disabled_at:null,p_soft_deleted_at:null,p_delete_due_at:null,p_admin:true,p_admin_email:'admin@example.test'});
 assert.equal(f.events.some(x=>x[0]==='endOwned'),false);
 const failed=await fixture({outcome:false,rollback:false});
 assert.deepEqual(await (await handleProfileAction(failed.input)).json(),{error:'manual_reconciliation_needed'});
});
test('Card 21a uncertain ban after DB write is not retried or falsely reported reverted',async()=>{
 const f=await fixture({provider:false});
 assert.deepEqual(await (await handleProfileAction(f.input)).json(),{error:'manual_reconciliation_needed'});
 assert.equal(f.events.filter(x=>x[0]==='ban').length,1);
 assert.equal(f.events.some(x=>['admin_revert_profile','endOwned'].includes(x[0])),false);
});
test('Card 21a profile elevation that stops verifying during intent audit (secret rotated) refuses the write with 403',async()=>{
 const f=await fixture();const call=f.input.rpc.call;
 f.input.rpc.call=async(name,args)=>{
  const result=await call(name,args);
  if(name==='write_admin_audit'&&args.p_phase==='intent')f.input.env.STEPUP_SECRET=newCapabilityToken();
  return result;
 };
 const response=await handleProfileAction(f.input);
 assert.equal(response.status,403);
 assert.deepEqual(await response.json(),{error:'forbidden'});
 assert.equal(f.events.some(x=>['admin_transition_profile','ban','endOwned'].includes(x[0])),false);
 assert.equal(f.events.filter(x=>x[0]==='write_admin_audit').at(-1)[1].p_after.status,'failed');
});

test('Card 21a profile compensation retains prior ban deadline at millisecond precision',async()=>{
 const f=await fixture({outcome:false});
 f.input.gotrue.getUser=async()=>({ok:true,user:{id:f.state.user_id,email:'target@example.test',bannedUntil:new Date(now+1501).toISOString()}});
 const response=await handleProfileAction(f.input);
 assert.deepEqual(await response.json(),{error:'change_reverted_audit_unavailable'});
 assert.deepEqual(f.events.filter(x=>x[0]==='ban').map(x=>x[2]),[{banDuration:'876000h'},{banDuration:'1501ms'}]);
});

test('Card 21a profile CAS serialization conflict performs no provider or owned-room write',async()=>{
 const f=await fixture(),call=f.input.rpc.call;
 f.input.rpc.call=async(name,args)=>name==='admin_transition_profile'?{ok:false,code:'40001'}:call(name,args);
 const response=await handleProfileAction(f.input);
 assert.equal(response.status,409);
 assert.deepEqual(await response.json(),{error:'conflict'});
 assert.equal(f.events.some(x=>['ban','admin_revert_profile','endOwned'].includes(x[0])),false);
 assert.equal(f.events.filter(x=>x[0]==='write_admin_audit').at(-1)[1].p_after.status,'failed');
});

test('Card 21a persisted destructive profile with uncertain ban still attempts audited owned-room termination',async()=>{
 const f=await fixture({provider:false}),call=f.input.rpc.call;let changed=false;
 f.input.rpc.call=async(name,args)=>{
  if(name==='admin_read_profiles'&&changed){f.events.push([name,args]);return {ok:true,data:[f.next]};}
  const result=await call(name,args);if(name==='admin_transition_profile')changed=true;return result;
 };
 const response=await handleProfileAction(f.input);
 assert.deepEqual(await response.json(),{error:'manual_reconciliation_needed'});
 assert.equal(f.events.filter(x=>x[0]==='ban').length,1);
 assert.equal(f.events.filter(x=>x[0]==='endOwned').length,1);
 assert.equal(typeof f.events.find(x=>x[0]==='endOwned')[1].admitted,'function');
 assert.equal(await f.events.find(x=>x[0]==='endOwned')[1].admitted(),true);
 f.input.env.STEPUP_SECRET=newCapabilityToken();
 assert.equal(await f.events.find(x=>x[0]==='endOwned')[1].admitted(),false);
});
