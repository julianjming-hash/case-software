import { it } from 'vitest';
import assert from 'node:assert/strict';
import { handleBuilderReviewApi } from '../../src/worker/builder-review-api.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';

const CASE='0199a000-0000-7000-8000-00000000c620', AUTHOR='0199a000-0000-7000-8000-00000000c601';
const ADMIN='0199a000-0000-7000-8000-00000000c602', CANDIDATE='0199a000-0000-7000-8000-00000000c630';
const HEX='\\x'+'a'.repeat(64), DOC={schema_version:1,title:'Synthetic',start_beat_id:uuidv7(),beats:[],decisions:[]};
const META={metadata_version:1,sources:[],provenance:[]};
function request(path,method='GET',body){return new Request(`https://case.test/api/v1/builder/cases/${CASE}${path}`,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});}
function fixture({admin=false,validation={ok:true,errors:[],warnings:[]},replies={}}={}){
  const calls=[], user={userId:admin?ADMIN:AUTHOR,email:admin?'admin@example.test':'author@example.test'};
  const rpc={async call(name,args){calls.push({name,args});if(name==='admin_account_active')return {ok:true,data:true};if(name==='get_case_authoring_access')return {ok:true,data:[{case_id:CASE,workspace_id:'0199a000-0000-7000-8000-00000000c610',role:admin?'admin':'author'}]};if(name==='get_access')return {ok:true,data:[{case_id:CASE,workspace_id:'0199a000-0000-7000-8000-00000000c610',member_role:admin?null:'author',grant_level:null,role:admin?'admin':'author',scope:'workspace',policies:{managers_invite:true,editors_publish:false,runners_share:false,managers_see_records:true}}]};return replies[name]??{ok:true,data:[]};}};
  const deps={rpc,env:{ADMIN_EMAILS:admin?'admin@example.test':''},verifyUser:async()=>user,parseJson:(text,options)=>({ok:true,value:JSON.parse(text)}),
    validateDraft:()=>validation,hashSources:async()=>true};
  return {calls,deps};
}
const digestArgs={revision:3,intentDigest:HEX,contentSha256:HEX};

it('candidate submission validates strict readiness and sends exact paired snapshot with UUIDv7 request identity',async()=>{
  const requestId=uuidv7(),{calls,deps}=fixture({replies:{builder_submit_candidate:{ok:true,data:[{candidate_id:CANDIDATE,revision:3,intent_digest:HEX,content_sha256:HEX,status:'pending',submitted_at:'2026-10-09T00:00:00Z'}]}}});
  const response=await handleBuilderReviewApi(request('/candidates','POST',{requestId,revision:3,document:DOC,authoringMetadata:META}),deps);
  assert.equal(response.status,201);assert.equal((await response.json()).candidateId,CANDIDATE);
  const write=calls.find(item=>item.name==='builder_submit_candidate');
  assert.equal(write.args.p_request_id,requestId);assert.deepEqual(write.args.p_document,DOC);assert.deepEqual(write.args.p_authoring_metadata,META);
  assert.deepEqual(calls.map(item=>item.name),['admin_account_active','get_access','builder_submit_candidate']);
});

it('unresolved rights or provenance diagnostics refuse before creating Pending',async()=>{
  for(const code of ['rights_unresolved','rights_restricted','source_missing','source_range','source_range_missing','provenance_unreviewed','provenance_stale']){
    const {calls,deps}=fixture({validation:{ok:true,errors:[],warnings:[{code}]}});
    const response=await handleBuilderReviewApi(request('/candidates','POST',{requestId:uuidv7(),revision:3,document:DOC,authoringMetadata:META}),deps);
    assert.equal(response.status,422,code);assert.equal(calls.some(item=>item.name==='builder_submit_candidate'),false,code);
  }
});

it('candidate readiness binds supplied provenance to an existing entity and field in the exact document',async()=>{
  const surfaceId='0199a000-0000-7000-8000-00000000c650';
  const document={...DOC,surfaces:[{id:surfaceId,scene:'Synthetic scene'}]};
  const metadata={metadata_version:1,provenance:[{entity_id:surfaceId,field:'surfaces.scene',transformation:'editorial',visibility:'public',review_status:'confirmed'}]};
  const validFixture=fixture({replies:{builder_submit_candidate:{ok:true,data:[{candidate_id:CANDIDATE,revision:3,intent_digest:HEX,content_sha256:HEX,status:'pending',submitted_at:'2026-10-09T00:00:00Z'}]}}});
  let response=await handleBuilderReviewApi(request('/candidates','POST',{requestId:uuidv7(),revision:3,document,authoringMetadata:metadata}),validFixture.deps);
  assert.equal(response.status,201);
  const invalidFixture=fixture();
  response=await handleBuilderReviewApi(request('/candidates','POST',{requestId:uuidv7(),revision:3,document,authoringMetadata:{...metadata,provenance:[{...metadata.provenance[0],field:'surfaces.missing'}]}}),invalidFixture.deps);
  assert.equal(response.status,422);assert.equal((await response.json()).error,'review_metadata_unresolved');
  assert.equal(invalidFixture.calls.some(item=>item.name==='builder_submit_candidate'),false);
});

it('author cannot fetch private review content or approve despite identifying the candidate',async()=>{
  for(const [path,method,body] of [[`/candidates/${CANDIDATE}`,'GET',undefined],[`/candidates/${CANDIDATE}/approve`,'POST',digestArgs]]){
    const {calls,deps}=fixture();const response=await handleBuilderReviewApi(request(path,method,body),deps);
    assert.equal(response.status,403);assert.equal(calls.some(item=>item.name==='builder_get_review_candidate'||item.name==='builder_approve_candidate'),false);
  }
});

it('configured admin can approve exact digests and release only through the admin P-15 path',async()=>{
  const {calls,deps}=fixture({admin:true,replies:{
    builder_approve_candidate:{ok:true,data:[{candidate_id:CANDIDATE,revision:3,status:'approved',approved_at:'2026-10-09T00:00:00Z',intent_digest:HEX,content_sha256:HEX}]},
    builder_release_candidate:{ok:true,data:[{candidate_id:CANDIDATE,version_id:uuidv7(),version_no:4,content_sha256:HEX,intent_digest:HEX,status:'released'}]},
  }});
  const approved=await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}/approve`,'POST',digestArgs),deps);
  assert.equal(approved.status,200);assert.equal(calls.find(item=>item.name==='builder_approve_candidate').args.p_admin,true);
  const art={v:1,stops:1,decisions:[],attempt:0,summarised:false,renderer:1};
  const released=await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}/release`,'POST',{...digestArgs,assetIds:[],art}),deps);
  assert.equal(released.status,200);assert.equal(calls.find(item=>item.name==='builder_release_candidate').args.p_admin,true);
});

it('all candidate review reads and mutations refuse after current account deactivation',async()=>{
  const {calls,deps}=fixture();deps.rpc.call=async(name,args)=>{calls.push({name,args});if(name==='admin_account_active')return {ok:true,data:false};return {ok:true,data:[]};};
  const response=await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}`),deps);
  assert.equal(response.status,403);assert.deepEqual(calls.map(item=>item.name),['admin_account_active']);
});

it('quiet updates bind an explicit edition flag to the exact release RPC and refuse other types',async()=>{
  const reply={ok:true,data:[{candidate_id:CANDIDATE,version_id:uuidv7(),version_no:4,content_sha256:HEX,intent_digest:HEX,status:'released'}]};
  for(const newEdition of [false,true]) {
    const {calls,deps}=fixture({admin:true,replies:{builder_release_update:reply}});
    const body={...digestArgs,assetIds:[],art:{v:1},newEdition};
    assert.equal((await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}/release`,'POST',body),deps)).status,200);
    assert.equal(calls.find(item=>item.name==='builder_release_update').args.p_new_edition,newEdition);
    assert.equal(calls.some(item=>item.name==='builder_release_candidate'),false);
  }
  const {calls,deps}=fixture({admin:true});
  assert.equal((await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}/release`,'POST',{...digestArgs,assetIds:[],art:{v:1},newEdition:'yes'}),deps)).status,400);
  assert.equal(calls.some(item=>item.name==='builder_release_update'),false);
});


it('approved review reads accept Supabase Auth UUIDv4 approvers while keeping Case identities strict',async()=>{
  const authId='0199a000-0000-4000-8000-00000000c602';
  const row={candidate_id:CANDIDATE,revision:243,schema_version:3,document:{...DOC,schema_version:3},authoring_metadata:META,
    intent_digest:HEX,content_sha256:HEX,status:'approved',submitted_by:authId,submitted_at:'2026-10-16T02:46:53Z',
    approved_by:authId,approved_at:'2026-10-16T02:54:03Z',approved_intent_digest:HEX,approved_content_sha256:HEX,released_version_id:null};
  const {deps}=fixture({admin:true,replies:{builder_get_review_candidate:{ok:true,data:[row]}}});
  const response=await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}`),deps);
  assert.equal(response.status,200);
  assert.equal((await response.json()).candidate.approvedBy,authId);
  row.approved_by='not-an-account-id';
  assert.equal((await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}`),deps)).status,503);
  row.approved_by=authId; row.candidate_id=authId;
  assert.equal((await handleBuilderReviewApi(request(`/candidates/${CANDIDATE}`),deps)).status,503);
});

it('publication readiness reports local and server blockers together without writes',async()=>{
 const {calls,deps}=fixture({validation:{ok:true,errors:[],warnings:[{code:'provenance_stale',at:'/provenance/0'}]},replies:{
  builder_get_draft:{ok:true,data:[{revision:3,document:DOC,authoring_metadata:META}]},
  builder_publication_readiness:{ok:true,data:[{code:'builder_storage_quota'},{code:'asset_not_approved'}]},
 }});
 const response=await handleBuilderReviewApi(request('/readiness','POST',{revision:3}),deps);
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.ready,false);
 assert.deepEqual(body.issues.map(item=>item.code),['provenance_stale','builder_storage_quota','asset_not_approved']);
 assert.deepEqual(calls.map(item=>item.name),['admin_account_active','get_access','builder_get_draft','builder_publication_readiness']);
 // CASE-342: no image needs approval; the image item names only a missing, foreign or taken-down image.
 assert.equal(body.issues.find(item=>item.code==='asset_not_approved').message,'An image is missing, belongs to another workspace, or was taken down.');
});
it('unavailable server readiness never claims a saved draft is publishable',async()=>{
 const {deps}=fixture({replies:{builder_get_draft:{ok:true,data:[{revision:3,document:DOC,authoring_metadata:META}]},builder_publication_readiness:{ok:false,kind:'unavailable'}}});
 assert.equal((await handleBuilderReviewApi(request('/readiness','POST',{revision:3}),deps)).status,503);
});
