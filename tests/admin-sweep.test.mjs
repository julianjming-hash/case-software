import test from 'node:test';
import assert from 'node:assert/strict';
import {runAdminDeletionSweep} from '../src/worker/admin/sweep.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
const now=Date.parse('2026-10-03T00:00:00Z');
function fixture(count=12) {
 const rows=Array.from({length:count},()=>({user_id:uuidv7(),admin_revision:0,
  disabled_at:'2026-09-01T00:00:00Z',soft_deleted_at:'2026-09-01T00:00:00Z',delete_due_at:'2026-10-01T00:00:00Z'})).sort((a,b)=>a.user_id.localeCompare(b.user_id));
 const calls=[];const input={env:{ADMIN_EMAILS:'admin@example.test'},nowMs:()=>now,
  rpc:{call:async(name,args)=>{calls.push([name,args]);return {ok:true,data:name==='list_admin_due_profiles'?rows:true};}},
  gotrue:{getUser:async id=>({ok:true,user:{id,email:'target@example.test'}}),deleteUser:async id=>{calls.push(['delete',id]);return {ok:true};}}};
 return {rows,calls,input};
}
test('Card 21a scheduled purge limits irreversible actions and uses fixed system attribution',async()=>{
 const {input,calls}=fixture();
 assert.deepEqual(await runAdminDeletionSweep(input),{ok:true,deleted:10,remaining:true});
 assert.deepEqual(calls[0],['list_admin_due_profiles',{p_limit:100,p_after:null}]);
 assert.equal(calls.filter(x=>x[0]==='delete').length,10);
 for(const [,args] of calls.filter(x=>x[0]==='write_admin_audit')) {
  assert.equal(args.p_actor_email,'system@case.iatrogenic.app');assert.equal(args.p_from_prefix,null);
 }
});
test('Card 21a scheduled purge finishes admitted action but starts none after sixty seconds',async()=>{
 const {input,calls}=fixture(2);let elapsed=0;input.nowMs=()=>now+elapsed;
 input.gotrue.deleteUser=async id=>{calls.push(['delete',id]);elapsed=60001;return {ok:true};};
 assert.deepEqual(await runAdminDeletionSweep(input),{ok:true,deleted:1,remaining:true});
 assert.equal(calls.filter(x=>x[0]==='delete').length,1);
 assert.equal(calls.filter(x=>x[0]==='write_admin_audit'&&x[1].p_phase==='outcome').length,1);
});
test('Card 21a scheduled purge refuses missing protection and stops ambiguous writes without retry',async()=>{
 const missing=fixture();missing.input.env={};
 assert.deepEqual(await runAdminDeletionSweep(missing.input),{ok:false,error:'admin_unavailable',deleted:0});assert.deepEqual(missing.calls,[]);
 const failed=fixture(2);failed.input.gotrue.deleteUser=async id=>{failed.calls.push(['delete',id]);return {ok:false,kind:'unknown_outcome'};};
 assert.deepEqual(await runAdminDeletionSweep(failed.input),{ok:false,error:'manual_reconciliation_needed',deleted:0});
 assert.equal(failed.calls.filter(x=>x[0]==='delete').length,1);
 assert.equal(failed.calls.some(x=>x[0]==='admin_delete_due_profile'),false);
});
