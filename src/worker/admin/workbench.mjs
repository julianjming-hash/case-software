// Tagged admin routes. The RPC rechecks the actor and owns transactional CAS/audit enforcement.
import { isAdminUser } from './gate.mjs';
import { verifyElevation } from './stepup.mjs';
import { actorFor, adminArgs } from '../authorize.mjs';
import { isUuid, isUuidV7 } from '../../shared/ids.mjs';
import { exact, workspacePage, workbenchPage } from '../../shared/admin-workbench.mjs';
import { withSecurityHeaders } from '../headers.mjs';
const reply=(status,body)=>withSecurityHeaders(Response.json(body,{status}));
const fail=(status,error)=>reply(status,{error});
const queryText=v=>typeof v==='string'&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v);
const date=v=>v===null||typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const enc=new TextEncoder();
async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(value)));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
const encode=value=>btoa(JSON.stringify(value)).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
async function anchor(value,context){
 if(value===null)return {id:null};
 if(typeof value!=='string'||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))return null;
 try{const claim=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)));return exact(claim,['id','context'])&&isUuid(claim.id)&&claim.context===await digest(context)?claim:null;}catch{return null;}
}
const mapped=result=>result.code==='42501'?fail(403,'forbidden'):['40001','40P01','23514'].includes(result.code)?fail(409,'conflict'):result.code==='P0002'?fail(404,'not_found'):['22023','22P02'].includes(result.code)?fail(400,'bad_request'):fail(503,'admin_unavailable');
export async function handleWorkbench({request,route,user,env,body,rpc}) {
 if(!isAdminUser(user,env))return fail(403,'forbidden');
 if(new URL(request.url).search)return fail(400,'bad_request');
 const admin=adminArgs(actorFor(user,env));
 if(route.key==='workspaces_query'){
  if(!exact(body,['after'])||body.after!==null&&!isUuidV7(body.after))return fail(400,'bad_request');
  const result=await rpc.call('admin_list_workspaces',{p_user_id:user.userId,p_after:body.after,...admin});
  if(!result?.ok)return mapped(result??{});const page=workspacePage(result.data);return page?reply(200,page):fail(503,'admin_unavailable');
 }
 if(route.key==='membership_change'){
  if(!exact(body,['workspaceId','email','role','transferFrom','expectedRevision','confirmEmail'])||!isUuidV7(body.workspaceId)||typeof body.email!=='string'||body.email.length>320||body.email!==body.email.trim().toLowerCase()||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)||body.confirmEmail!==body.email||body.role!==null&&!['owner','author','facilitator'].includes(body.role)||body.transferFrom!==null&&!isUuid(body.transferFrom)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.expectedRevision>=9999999999)return fail(400,'bad_request');
  const elevation=await verifyElevation(request.headers.get('X-Admin-Elevation'),user.email,user.sessionId,env.STEPUP_SECRET);
  if(!elevation)return fail(403,'forbidden');
  const result=await rpc.call('admin_change_membership',{p_actor_user_id:user.userId,p_workspace_id:body.workspaceId,p_email:body.email,p_role:body.role,p_transfer_from:body.transferFrom,p_expected_revision:body.expectedRevision,p_confirm_email:body.confirmEmail,p_elevation_id:elevation.jti,...admin});
  if(!result?.ok)return mapped(result??{});
  const value=result.data;return exact(value,['membership_revision','changed'])&&Number.isSafeInteger(value.membership_revision)&&value.membership_revision>=body.expectedRevision&&value.membership_revision<9999999999&&typeof value.changed==='boolean'?reply(200,value):fail(503,'manual_reconciliation_needed');
 }
 const global=route.key==='operations_query';
 if(!exact(body,global?['query','after']:['workspaceId','tab','query','status','from','until','after'])||!queryText(body.query)||!global&&(!isUuidV7(body.workspaceId)||!['members','cases','rooms','audit'].includes(body.tab)||!['all','lobby','live','ended','expired','published','withdrawn'].includes(body.status)||!date(body.from)||!date(body.until)||body.from!==null&&body.until!==null&&body.from>=body.until))return fail(400,'bad_request');
 const context=['admin-workbench-v1',user.userId,global?'operations':body.workspaceId,global?'operations':body.tab,body.query,...(global?[]:[body.status,body.from,body.until])];
 const after=await anchor(body.after,context);if(!after)return fail(400,'bad_request');
 const result=await rpc.call(global?'admin_query_operations':'admin_workspace_query',global?{p_user_id:user.userId,p_query:body.query,p_after:after.id,...admin}:{p_user_id:user.userId,p_workspace_id:body.workspaceId,p_tab:body.tab,p_query:body.query,p_status:body.status,p_from:body.from,p_until:body.until,p_after:after.id,...admin});
 if(!result?.ok)return mapped(result??{});
 const page=workbenchPage(global?'operations':body.tab,result.data);if(!page||!global&&page.workspace.id!==body.workspaceId||after.id!==null&&page.rows.some(r=>r.id>=after.id))return fail(503,'admin_unavailable');
 return reply(200,{...page,nextAfter:page.nextAfter===null?null:encode({id:page.nextAfter,context:await digest(context)})});
}
