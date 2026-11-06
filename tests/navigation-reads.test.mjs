import test from 'node:test';
import assert from 'node:assert/strict';
import {uuidv7} from '../src/shared/ids.mjs';
import {handleFacilitatorApi} from '../src/worker/facilitator-api.mjs';
import {handleSessionPortfolio} from '../src/worker/session-portfolio.mjs';
const user=uuidv7(),workspace=uuidv7(),caseId=uuidv7(),session=uuidv7(),version=uuidv7();
const verifyUser=async token=>token==='local-jwt'?{userId:user,email:'owner@example.test'}:null;
function request(path,body,token='local-jwt'){return new Request('https://case.test/api/v1/'+path,{method:body?'POST':'GET',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
test('neutral bookmarks use only a verified subject and bounded metadata; foreign/withdrawn/malformed results do not become runnable',async()=>{
 const calls=[];let rows=[{workspace_id:workspace,role:'author',version_no:2}];const deps={env:{},verifyUser,rpc:{async call(name,args){if(name==='admin_account_active')return{ok:true,data:true};calls.push({name,args});assert.equal(name,'resolve_catalogue_case');return{ok:true,data:rows};}}};
 let r=await handleFacilitatorApi(request('cases/'+caseId),deps);assert.equal(r.status,200);assert.deepEqual(await r.json(),{caseId,workspaceId:workspace,versionNo:2,editable:true});assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(calls[0].args,{p_user_id:user,p_case_id:caseId,p_admin:false,p_admin_email:null});
 rows=[];assert.equal((await handleFacilitatorApi(request('cases/'+caseId),deps)).status,404);
 rows=[{workspace_id:workspace,role:'facilitator',version_no:null}];assert.deepEqual(await(await handleFacilitatorApi(request('cases/'+caseId),deps)).json(),{caseId,workspaceId:workspace,versionNo:null,editable:false});
 rows=[{workspace_id:workspace,role:'admin',version_no:2}];assert.equal((await handleFacilitatorApi(request('cases/'+caseId),deps)).status,503);
 rows=[{workspace_id:workspace,role:'author',version_no:2,document:'PRIVATE'}];assert.equal((await handleFacilitatorApi(request('cases/'+caseId),deps)).status,503);
 const before=calls.length;assert.equal((await handleFacilitatorApi(request('cases/'+caseId+'?token=private'),deps)).status,400);assert.equal((await handleFacilitatorApi(request('cases/'+caseId,undefined,null),deps)).status,401);assert.equal(calls.length,before);
});
test('case-scoped Session cursors bind case identity and keep the legacy query; upstream case mismatches fail closed',async()=>{
 const calls=[];let poisoned=false;const row=()=>({id:session,case_id:poisoned?uuidv7():caseId,case_version_id:version,title:'A case',version_no:1,status:'ended',created_at:'2026-11-01T00:00:00Z',started_at:null,ended_at:null,expires_at:'2026-11-01T01:00:00Z',archive_state:'limited',own:true});
 const deps={env:{},verifyUser,rpc:{async call(name,args){if(name==='admin_account_active')return{ok:true,data:true};if(name==='get_me')return{ok:true,data:[{user_id:user,admin:false,display_name:'Owner',next_after:null,memberships:[{workspace_id:workspace,role:'owner'}]}]};calls.push({name,args});assert.ok(['query_session_portfolio','query_case_session_portfolio'].includes(name));return{ok:true,data:{rooms:[row()],nextAfter:session}};}}};
 const body={workspaceId:workspace,query:'',status:'all',from:null,until:null,after:null,personal:true,caseId};let r=await handleSessionPortfolio(request('portfolio/query',body),deps);assert.equal(r.status,200);const page=await r.json();assert.equal(calls.at(-1).name,'query_case_session_portfolio');assert.equal(calls.at(-1).args.p_case_id,caseId);
 const before=calls.length;assert.equal((await handleSessionPortfolio(request('portfolio/query',{...body,caseId:uuidv7(),after:page.nextAfter}),deps)).status,400);assert.equal(calls.length,before);
 poisoned=true;assert.equal((await handleSessionPortfolio(request('portfolio/query',body),deps)).status,503);poisoned=false;
 const {caseId:omitted,...legacy}=body;assert.equal((await handleSessionPortfolio(request('portfolio/query',legacy),deps)).status,200);assert.equal(calls.at(-1).name,'query_session_portfolio');assert.equal(Object.hasOwn(calls.at(-1).args,'p_case_id'),false);
 assert.equal((await handleSessionPortfolio(request('portfolio/query',{...body,caseId:'private-token'}),deps)).status,400);
});
