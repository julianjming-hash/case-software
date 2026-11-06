import test from 'node:test';
import assert from 'node:assert/strict';
import { hardDeleteFacilitator } from '../src/worker/admin/hard-delete.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
const now=Date.parse('2026-10-03T00:00:00Z');
function fixture({auth={ok:true},deleted=true,email='target@example.test'}={}) {
 const calls=[];const profile={user_id:uuidv7(),admin_revision:3,disabled_at:'2026-09-01T00:00:00Z',soft_deleted_at:'2026-09-01T00:00:00Z',delete_due_at:'2026-10-01T00:00:00Z'};
 return {calls,input:{profile,env:{ADMIN_EMAILS:'admin@example.test'},actorEmail:'admin@example.test',fromPrefix:null,nowMs:()=>now,
  gotrue:{getUser:async()=>({ok:true,user:{id:profile.user_id,email}}),deleteUser:async id=>{calls.push(['auth',id]);return auth;}},
  rpc:{call:async(name,args)=>{calls.push([name,args]);return {ok:true,data:name==='admin_delete_due_profile'?deleted:true};}}}};
}
test('Card 21a hard deletion persists intent then deletes Auth before conditional profile deletion',async()=>{
 const {calls,input}=fixture();assert.deepEqual(await hardDeleteFacilitator(input),{ok:true});
 assert.deepEqual(calls.map(x=>x[0]),['write_admin_audit','admin_claim_due_profile_deletion','auth','admin_delete_due_profile','write_admin_audit']);
 assert.equal(calls[0][1].p_phase,'intent');
 assert.deepEqual(calls[1][1],{p_user_id:input.profile.user_id,p_expected_revision:3,p_intent_id:calls[0][1].p_event_id});
 assert.deepEqual(calls[3][1],{p_user_id:input.profile.user_id,p_expected_revision:3});
 assert.equal(calls[4][1].p_after.status,'completed');
});
test('Card 21a failed or ambiguous Auth deletion keeps profile and failed profile deletion requires reconciliation',async()=>{
 const failed=fixture({auth:{ok:false,kind:'unknown_outcome'}});
 assert.deepEqual(await hardDeleteFacilitator(failed.input),{ok:false,status:500,error:'manual_reconciliation_needed'});
 assert.equal(failed.calls.some(x=>x[0]==='admin_delete_due_profile'),false);
 const profileFailed=fixture({deleted:false});
 assert.deepEqual(await hardDeleteFacilitator(profileFailed.input),{ok:false,status:500,error:'manual_reconciliation_needed'});
 assert.equal(profileFailed.calls.filter(x=>x[0]==='auth').length,1);
});
test('Card 21a hard deletion refuses protected admin and non-due profile before audit or mutation',async()=>{
 const protectedTarget=fixture({email:'admin@example.test'});
 assert.deepEqual(await hardDeleteFacilitator(protectedTarget.input),{ok:false,status:403,error:'forbidden'});
 assert.deepEqual(protectedTarget.calls,[]);
 const fresh=fixture();fresh.input.profile.delete_due_at='2026-10-31T00:00:00Z';
 assert.deepEqual(await hardDeleteFacilitator(fresh.input),{ok:false,status:409,error:'conflict'});
 assert.deepEqual(fresh.calls,[]);
});
test('Card 21a a restored profile after audit intent is not deleted from a stale due snapshot',async()=>{
 const {input,calls}=fixture();const original=input.rpc.call;
 input.rpc.call=async(name,args)=>{
  if(name==='admin_claim_due_profile_deletion') {calls.push([name,args]);return {ok:true,data:false};}
  return original(name,args);
 };
 const result=await hardDeleteFacilitator(input);
 assert.deepEqual(result,{ok:false,status:409,error:'conflict'});
 const claim=calls.find(x=>x[0]==='admin_claim_due_profile_deletion');
 assert.deepEqual(claim?.[1],{p_user_id:input.profile.user_id,p_expected_revision:3,p_intent_id:calls[0][1].p_event_id});
 assert.equal(calls.some(x=>x[0]==='auth'),false);
 assert.equal(calls.some(x=>x[0]==='admin_delete_due_profile'),false);
 assert.equal(calls.filter(x=>x[0]==='write_admin_audit'&&x[1].p_phase==='intent').length,1);
});
test('Card 21a unknown deletion claim outcome requires reconciliation without touching Auth',async()=>{
 const {input,calls}=fixture();const original=input.rpc.call;
 input.rpc.call=async(name,args)=>{
  if(name==='admin_claim_due_profile_deletion'){calls.push([name,args]);return {ok:false,kind:'unavailable'};}
  return original(name,args);
 };
 assert.deepEqual(await hardDeleteFacilitator(input),{ok:false,status:500,error:'manual_reconciliation_needed'});
 assert.equal(calls.some(x=>x[0]==='auth'||x[0]==='admin_delete_due_profile'),false);
 assert.equal(calls.filter(x=>x[0]==='admin_claim_due_profile_deletion').length,1);
 assert.equal(calls.at(-1)[1].p_after.status,'unknown_outcome');
});
test('Card 21a malformed successful claim body is unknown outcome rather than a known conflict',async()=>{
 const {input,calls}=fixture();const original=input.rpc.call;
 input.rpc.call=async(name,args)=>name==='admin_claim_due_profile_deletion'?{ok:true,data:{}}:original(name,args);
 assert.deepEqual(await hardDeleteFacilitator(input),{ok:false,status:500,error:'manual_reconciliation_needed'});
 assert.equal(calls.some(x=>x[0]==='auth'||x[0]==='admin_delete_due_profile'),false);
 assert.equal(calls.at(-1)[1].p_after.status,'unknown_outcome');
});
