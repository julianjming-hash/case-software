import test from 'node:test';
import assert from 'node:assert/strict';
import {handleCaseRequest} from '../src/worker/admin/cases.mjs';
import {matchAdminRoute} from '../src/worker/admin/routes.mjs';
import {mintElevation} from '../src/worker/admin/stepup.mjs';
import {uuidv7,newCapabilityToken,isUuidV7} from '../src/shared/ids.mjs';
import {apiUrl} from '../src/shared/urls.mjs';
const now=Date.parse('2026-10-03T00:00:00Z');
const ADMIN_ID=uuidv7(),SESSION=uuidv7();
const adminArgs={p_user_id:ADMIN_ID,p_admin:true,p_admin_email:'admin@example.test'};
async function fixture({audit=true,rollback=true}={}){
 const caseId=uuidv7(),versionId=uuidv7(),events=[],secret=newCapabilityToken();
 const state={case_id:caseId,version_id:versionId,version_no:2,title:'Teaching case',status:'published',admin_revision:0};
 const elevation=await mintElevation('admin@example.test',SESSION,secret);
 const request=new Request(`https://case.invalid/api/v1/admin/versions/${versionId}/withdraw`,{method:'POST',headers:{'x-admin-elevation':elevation.token}});
 let clock=now;
 const input={request,route:matchAdminRoute(new URL(request.url).pathname,'POST'),user:{email:'admin@example.test',userId:ADMIN_ID,sessionId:SESSION},env:{ADMIN_EMAILS:'admin@example.test',STEPUP_SECRET:secret},body:{expectedRevision:0},nowMs:()=>clock,
 rpc:{call:async(name,args)=>{events.push([name,args]);if(name==='admin_read_case_version')return {ok:true,data:[state]};if(name==='admin_set_version_state')return {ok:rollback||args.p_action==='withdraw',data:[{version_id:versionId,status:args.p_action==='withdraw'?'withdrawn':'published',admin_revision:args.p_expected_revision+1}]};return {ok:audit||args.p_phase==='intent',data:args.p_event_id};}}};
 return {input,state,events,jti:elevation.jti,token:elevation.token,setClock:value=>clock=value};
}
test('Card 21a version withdraw has fresh elevation and CAS with new-revision status compensation on audit failure',async()=>{
 const f=await fixture({audit:false});const response=await handleCaseRequest(f.input);
 assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'change_reverted_audit_unavailable'});
 assert.deepEqual(f.events.filter(x=>x[0]==='admin_set_version_state').map(x=>x[1]),[{p_version_id:f.state.version_id,p_expected_revision:0,p_action:'withdraw',...adminArgs,p_elevation_id:f.jti},{p_version_id:f.state.version_id,p_expected_revision:1,p_action:'publish',...adminArgs,p_elevation_id:f.jti}]);
 const failed=await fixture({audit:false,rollback:false});assert.deepEqual(await (await handleCaseRequest(failed.input)).json(),{error:'manual_reconciliation_needed'});
});
test('Card 21a publish refuses foreign case-version binding and a withdraw from another session before writes',async()=>{
 const f=await fixture();f.input.request=new Request(`https://case.invalid/api/v1/admin/cases/${uuidv7()}/publish`,{method:'POST',headers:{'x-admin-elevation':f.token}});f.input.route=matchAdminRoute(new URL(f.input.request.url).pathname,'POST');f.input.body={versionId:f.state.version_id,expectedRevision:0};f.state.status='withdrawn';
 assert.equal((await handleCaseRequest(f.input)).status,409);assert.equal(f.events.some(x=>x[0]==='write_admin_audit'),false);
 const expired=await fixture();expired.input.user={...expired.input.user,sessionId:uuidv7()};assert.equal((await handleCaseRequest(expired.input)).status,403);assert.equal(expired.events.some(x=>x[0]==='admin_set_version_state'),false);
});
test('Card 21a case list preserves explicit cursor and projects metadata without pack or personal provider fields',async()=>{
 const f=await fixture(),after=uuidv7();f.input.request=new Request(`https://case.invalid/api/v1/admin/cases?limit=1&after=${after}`);f.input.route=matchAdminRoute(new URL(f.input.request.url).pathname,'GET');
 // Card 30: each row carries its case's workspace and group (Admin -> Cases: Group column and Change group).
 const group={workspace_id:uuidv7(),group_id:uuidv7(),group_name:'Emergency',tint:'petrol',group_revision:3};
 f.input.rpc.call=async(name,args)=>{assert.equal(name,'list_admin_case_versions');assert.deepEqual(args,{p_limit:1,p_after:after});return {ok:true,data:[{...f.state,...group,document:{unrevealed:'never'},email:'private@example.test'}]};};
 const response=await handleCaseRequest(f.input);assert.equal(response.status,200);assert.deepEqual(await response.json(),{versions:[{...f.state,...group}],nextCursor:f.state.version_id});
 for(const bad of [{tint:'teal'},{group_name:''},{group_id:null},{workspace_id:'x'},{group_revision:-1}]){
  f.input.rpc.call=async()=>({ok:true,data:[{...f.state,...group,...bad}]});
  assert.equal((await handleCaseRequest(f.input)).status,503,JSON.stringify(bad));
 }
 f.input.rpc.call=async()=>({ok:true,data:[{...f.state,...group,group_id:null,group_name:null,tint:'neutral'}]});
 assert.equal((await handleCaseRequest(f.input)).status,200,'an Ungrouped case is listed');
});


test('Card 21a republish audits the bound case while CAS writes the immutable version',async()=>{
 const f=await fixture(); f.state.status='withdrawn';
 // [PM-15] Red-team item 4: republish needs the step-up too; without it nothing is read or written.
 f.input.request=new Request(apiUrl('https://case.invalid','admin','cases',f.state.case_id,'publish'),{method:'POST'});
 f.input.route=matchAdminRoute(new URL(f.input.request.url).pathname,'POST');
 f.input.body={versionId:f.state.version_id,expectedRevision:0};
 assert.equal((await handleCaseRequest(f.input)).status,403);assert.equal(f.events.some(x=>x[0]==='admin_set_version_state'),false);
 f.input.request=new Request(apiUrl('https://case.invalid','admin','cases',f.state.case_id,'publish'),{method:'POST',headers:{'x-admin-elevation':f.token}});
 const auditRows=[]; let writes=0;
 f.input.rpc.call=async(name,args)=>{
  if(name==='admin_read_case_version')return {ok:true,data:[f.state]};
  if(name==='write_admin_audit'){
   // Actual SQL contract: case_publish targets a CASE; version_withdraw targets a VERSION.
   if(args.p_action!=='case_publish'||args.p_target_type!=='case'||args.p_target_id!==f.state.case_id)
    return {ok:false,code:'23514'};
   auditRows.push(args); return {ok:true,data:args.p_event_id};
  }
  assert.equal(name,'admin_set_version_state');
  assert.deepEqual(args,{p_version_id:f.state.version_id,p_expected_revision:0,p_action:'publish',...adminArgs,p_elevation_id:f.jti});
  writes++; return {ok:true,data:[{version_id:f.state.version_id,status:'published',admin_revision:1}]};
 };
 const response=await handleCaseRequest(f.input);
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{version:{version_id:f.state.version_id,status:'published',admin_revision:1}});
 assert.equal(writes,1); assert.deepEqual(auditRows.map(row=>row.p_phase),['intent','outcome']);
 assert.equal(auditRows[0].p_intent_id,auditRows[0].p_event_id);
 assert.equal(auditRows[1].p_intent_id,auditRows[0].p_event_id);
 assert.ok(isUuidV7(auditRows[0].p_event_id)&&isUuidV7(auditRows[1].p_event_id));
 assert.notEqual(auditRows[0].p_event_id,auditRows[1].p_event_id);
 assert.deepEqual(auditRows[0].p_before,{status:'withdrawn',admin_revision:0});
 assert.deepEqual(auditRows[0].p_after,{});
 assert.deepEqual(auditRows[1].p_after,{status:'published',admin_revision:1});
});

test('[PM-38] R-a: the session elevation admits a second destructive action; another session or admin never does',async()=>{
 const f=await fixture();
 assert.equal((await handleCaseRequest(f.input)).status,200);
 assert.equal(f.events.find(x=>x[0]==='admin_set_version_state')[1].p_elevation_id,f.jti);
 // The same session, the same token, a second withdraw: admitted, and recorded with the same elevation id.
 f.events.length=0;f.state.admin_revision=0;f.state.status='published';
 f.input.request=new Request(f.input.request.url,{method:'POST',headers:{'x-admin-elevation':f.token}});
 assert.equal((await handleCaseRequest(f.input)).status,200);
 assert.equal(f.events.find(x=>x[0]==='admin_set_version_state')[1].p_elevation_id,f.jti);
 // Another session of the same admin, or another admin in this session: refused before any write.
 for(const user of [{...f.input.user,sessionId:uuidv7()},{...f.input.user,email:'other@example.test'}]){
  const g=await fixture();g.input.user=user;g.input.env={...g.input.env,ADMIN_EMAILS:'admin@example.test,other@example.test'};
  assert.equal((await handleCaseRequest(g.input)).status,403);assert.equal(g.events.some(x=>x[0]==='admin_set_version_state'),false);
 }
});
