import test from 'node:test';
import assert from 'node:assert/strict';
import {rpcClient} from '../src/worker/rpc.mjs';
import {uuidv7,newCapabilityToken} from '../src/shared/ids.mjs';
const id=uuidv7(),workspace=uuidv7(),authId='12345678-1234-4234-8234-123456789abc';
const contracts={
 admin_claim_due_profile_deletion:{args:{p_user_id:authId,p_expected_revision:2,p_intent_id:id},data:true},
 list_admin_due_profiles:{args:{p_limit:100,p_after:null},data:[{user_id:authId,disabled_at:"2026-09-01T00:00:00Z",soft_deleted_at:"2026-09-01T00:00:00Z",delete_due_at:"2026-10-01T00:00:00Z",admin_revision:2}]},
 admin_delete_due_profile:{args:{p_user_id:authId,p_expected_revision:2},data:true},
 admin_read_case_version:{args:{p_version_id:id},data:[{case_id:workspace,version_id:id,version_no:1,title:"Case",status:"published",admin_revision:0}]},
 list_admin_case_versions:{args:{p_limit:20,p_after:null},data:[{case_id:workspace,version_id:id,version_no:1,title:"Case",status:"published",admin_revision:0}]},
 admin_read_profiles:{args:{p_user_ids:[authId]},data:[{user_id:authId,disabled_at:null,soft_deleted_at:null,delete_due_at:null,admin_revision:2}]},
 admin_revert_profile:{args:{p_user_id:authId,p_expected_revision:3,p_disabled_at:null,p_soft_deleted_at:null,p_delete_due_at:null,p_admin:true,p_admin_email:'admin@example.test'},data:[{user_id:authId,disabled_at:null,soft_deleted_at:null,delete_due_at:null,admin_revision:4}]},
 admin_account_active:{args:{p_user_id:authId},data:true},
 admin_teaching_workspace_exists:{args:{p_workspace_id:workspace},data:true},
 admin_provision_facilitator:{args:{p_user_id:authId,p_workspace_id:workspace,p_actor_user_id:id,p_admin:true,p_admin_email:'admin@example.test'},data:null},
 admin_set_workspace_owner:{args:{p_workspace_id:workspace,p_user_id:authId,p_actor_user_id:id,p_admin:true,p_admin_email:'admin@example.test'},data:null},
 get_session_workspace:{args:{p_session_id:id},data:workspace},
 admin_transition_profile:{args:{p_user_id:authId,p_expected_revision:2,p_action:'disable',p_admin:true,p_admin_email:'admin@example.test'},data:[{user_id:authId,disabled_at:'2026-10-03T00:00:00Z',soft_deleted_at:null,delete_due_at:null,admin_revision:3}]},
 admin_set_version_state:{args:{p_version_id:id,p_expected_revision:1,p_action:'withdraw',p_user_id:authId,p_admin:true,p_admin_email:'admin@example.test',p_elevation_id:uuidv7()},data:[{version_id:id,status:'withdrawn',admin_revision:2}]},
 record_admin_elevation:{args:{p_jti:id,p_actor_email:'admin@example.test',p_scope:'admin',p_session_id:workspace},data:true},
 claim_admin_stepup_attempt:{args:{p_event_id:id,p_actor_email:'admin@example.test',p_action:'stepup_verify',p_from_prefix:null},data:true},
 write_admin_audit:{args:{p_event_id:id,p_intent_id:id,p_phase:'intent',p_action:'facilitator_disable',p_target_type:'facilitator',p_target_id:authId,p_actor_email:'admin@example.test',p_before:{status:'active'},p_after:{},p_from_prefix:null},data:id},
 list_admin_audit:{args:{p_limit:2,p_after:null},data:[{event_id:id,intent_id:uuidv7(),phase:'outcome',action:'room_end',target_type:'room',target_id:uuidv7(),actor_email:'admin@example.test',before:{status:'active'},after:{status:'ended'},at:'2026-10-03T00:00:00Z',from_prefix:null}]},
};
for(const [name,{args,data}] of Object.entries(contracts)) {
 test(`Card 21a ${name} RPC admits exact service signature and refuses extra or missing arguments`,async()=>{
  const calls=[];
  const client=rpcClient({SUPABASE_URL:'https://admin-rpc.invalid',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`},{fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(data);}});
  assert.deepEqual(await client.call(name,args),{ok:true,data});
  assert.equal(calls[0].url,`https://admin-rpc.invalid/rest/v1/rpc/${name}`);
  assert.deepEqual(JSON.parse(calls[0].options.body),args);
  assert.equal(calls[0].options.redirect,'manual');
  assert.equal((await client.call(name,{...args,p_private_note:'never sent'})).code,'invalid_arguments');
  const missing={...args};delete missing[Object.keys(args)[0]];
  assert.equal((await client.call(name,missing)).code,'invalid_arguments');
  assert.equal(calls.length,1);
 });
}
