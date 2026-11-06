import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
const userId=uuidv7(),workspaceId=uuidv7(),versionId=uuidv7();
const doc=JSON.parse(await readFile(new URL('../src/fixtures/synthetic-workshop.case.json',import.meta.url)));
const text=JSON.stringify(doc),hash='\\x'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
function setup({role='facilitator',member=true,withdrawn=false,corrupt=false,active=true}={}){
 const calls=[];const rpc={call:async(name,args)=>{calls.push({name,args});
  if(name==='admin_account_active')return{ok:true,data:active};
  if(name==='get_me')return{ok:true,data:[{user_id:userId,display_name:'F',admin:false,next_after:null,memberships:member?[{workspace_id:workspaceId,role}]:[]}]};
  if(name==='get_case_version_for_workspace')return{ok:true,data:withdrawn?[]:[{version_no:1,schema_version:doc.schema_version,document_text:text,content_sha256:corrupt?'\\x'+'0'.repeat(64):hash,art:null,tint:'neutral'}]};
  throw Error('Unexpected RPC '+name);
 }};return{calls,deps:{rpc,env:{},verifyUser:async token=>token==='jwt'?{userId}:null}};
}
const request=(token='jwt',query='')=>new Request(`https://case.test/api/v1/workspaces/${workspaceId}/versions/${versionId}/pack${query}`,{headers:{authorization:`Bearer ${token}`}});
test('[AS-121] private pack is entitled, intact and no-store, without any room side effect',async()=>{
 for(const role of ['owner','author','facilitator']){const s=setup({role}),res=await handleFacilitatorApi(request(),s.deps);assert.ok(res);assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/no-store/);const body=await res.json();assert.deepEqual(body.document,doc);assert.equal(body.versionId,versionId);assert.ok(s.calls.every(c=>['admin_account_active','get_me','get_case_version_for_workspace'].includes(c.name)));}
});
test('[AS-121] pack refuses capability, nonmember, withdrawn, disabled, tampered and query requests',async()=>{
 for(const [over,token,status]of [[{},'projector',401],[{member:false},'jwt',403],[{role:'participant'},'jwt',403],[{withdrawn:true},'jwt',404],[{corrupt:true},'jwt',502],[{active:false},'jwt',403]]){
  const s=setup(over),res=await handleFacilitatorApi(request(token),s.deps);assert.ok(res);assert.equal(res.status,status,JSON.stringify(over));assert.ok(!JSON.stringify(await res.json()).includes(doc.surfaces[0].scene));
 }
 const s=setup();assert.equal((await handleFacilitatorApi(request('jwt','?userId=other'),s.deps)).status,400);assert.ok(!s.calls.some(c=>c.name==='get_case_version_for_workspace'));
});
