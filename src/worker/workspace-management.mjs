import { cleanText } from '../shared/text.mjs';
// Workspace details and canonical-case placement. JWT identity and scope checks precede every RPC;
// transactional SQL repeats both scope checks and CAS. Additional case access never grants workspace management.
import { isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { authorize, adminArgs } from './authorize.mjs';
const ID='([0-9a-f-]{36})';
const rev=v=>Number.isSafeInteger(v)&&v>=0;
const name=v=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=120&&!/[\u0000-\u001f\u007f]/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=(error,status)=>({ok:false,error,status});
export function matchWorkspaceManagement(path,method){
 let m=new RegExp('^/api/v1/workspaces/'+ID+'/details$').exec(path);
 if(m&&['GET','PUT'].includes(method))return {kind:method==='GET'?'details':'rename',id:m[1]};
 m=new RegExp('^/api/v1/cases/'+ID+'/workspaces$').exec(path);
 if(m&&['GET','PUT','POST'].includes(method))return {kind:method==='GET'?'placement':method==='PUT'?'share':'move',id:m[1]};
 return null;
}
export function validWorkspaceDetails(v){return exact(v,['id','name','revision'])&&isUuidV7(v.id)&&name(v.name)&&rev(v.revision);}
export function validCasePlacement(v){return exact(v,['caseId','homeWorkspaceId','homeWorkspaceName','revision','canManage','access','destinations'])&&isUuidV7(v.caseId)&&isUuidV7(v.homeWorkspaceId)&&name(v.homeWorkspaceName)&&rev(v.revision)&&typeof v.canManage==='boolean'&&Array.isArray(v.access)&&v.access.length<=100&&v.access.every(x=>exact(x,['id','name','level'])&&isUuidV7(x.id)&&name(x.name)&&['run','edit'].includes(x.level))&&Array.isArray(v.destinations)&&v.destinations.length<=100&&v.destinations.every(x=>exact(x,['id','name','canMove'])&&isUuidV7(x.id)&&name(x.name)&&typeof x.canMove==='boolean')&&v.access.every(x=>x.id!==v.homeWorkspaceId)&&v.destinations.every(x=>x.id!==v.homeWorkspaceId)&&new Set(v.access.map(x=>x.id)).size===v.access.length&&new Set(v.destinations.map(x=>x.id)).size===v.destinations.length&&(v.canManage||(!v.access.length&&!v.destinations.length));}
function failure(r){if(r?.code==='42501')return fail('forbidden',403);if(r?.code==='40001'||r?.kind==='conflict')return fail('conflict',409);if(r?.code==='55006')return fail('case_in_use',409);if(r?.code==='P0002')return fail('not_found',404);if(['22023','23514','22P02'].includes(r?.code))return fail('bad_request',400);return fail('unavailable',503);}
export async function handleWorkspaceManagement(client,{route,actor,readBody}){
 const {kind,id}=route;if(!isUuidV7(id))return fail('bad_request',400);
 const caseAction=['placement','share','move'].includes(kind);
 const held=await authorize(client,actor,caseAction?{caseId:id}:id,caseAction?ACTIONS.browseLibrary:kind==='rename'?ACTIONS.editDetails:ACTIONS.readSettings);
 if(!held.ok)return held;
 let input={};if(!['details','placement'].includes(kind)){const parsed=await readBody();if(parsed.error)return fail(parsed.error,parsed.error==='too_large'?413:parsed.error==='request_timeout'?408:400);input=parsed.body;
  if(kind==='rename'?!exact(input,['expectedRevision','name'])||!rev(input.expectedRevision)||!name(input.name):!exact(input,kind==='share'?['expectedRevision','workspaceId','level']:['expectedRevision','workspaceId'])||!rev(input.expectedRevision)||!isUuidV7(input.workspaceId)||(kind==='share'&&input.level!==null&&!['run','edit'].includes(input.level)))return fail('bad_request',400);
 }
 if(['share','move'].includes(kind)){
  const home=await authorize(client,actor,held.workspaceId,ACTIONS.editDetails);if(!home.ok)return home;
  if(kind==='move'||input.level!==null){const target=await authorize(client,actor,input.workspaceId,kind==='move'?ACTIONS.editDetails:ACTIONS.draft);if(!target.ok)return target;}
 }
 const fn=({details:'workspace_details',rename:'update_workspace_details',placement:'case_workspace_access',share:'set_case_workspace_access',move:'move_case_workspace'})[kind];
 const args={p_user_id:actor.userId,...adminArgs(actor),...(caseAction?{p_case_id:id}:{p_workspace_id:id}),...(!['details','placement'].includes(kind)?{p_expected_revision:input.expectedRevision}:{}),...(kind==='rename'?{p_name:cleanText(input.name,120)}:{}),...(['share','move'].includes(kind)?{p_workspace_id:input.workspaceId}:{}),...(kind==='share'?{p_level:input.level}:{})};
 const result=await client.call(fn,args);if(!result?.ok)return failure(result);
 const valid=caseAction?validCasePlacement(result.data)&&result.data.caseId===id&&result.data.homeWorkspaceId===(kind==='move'?input.workspaceId:held.workspaceId)&&(!['share','move'].includes(kind)||result.data.revision===input.expectedRevision+1):validWorkspaceDetails(result.data)&&result.data.id===id&&(kind!=='rename'||result.data.name===cleanText(input.name,120));
 return valid?{ok:true,status:200,body:result.data}:fail('unavailable',503);
}
