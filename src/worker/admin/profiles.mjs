// Concrete facilitator transitions: current target state, fresh elevation, CAS, bounded provider and compensation.
import {isUuid} from '../../shared/ids.mjs';
import {isAdminUser,adminAuditPrefix} from './gate.mjs';
import {verifyElevation} from './stepup.mjs';
import {runAuditedAction} from './actions.mjs';
import {withSecurityHeaders} from '../headers.mjs';
const response=(status,body)=>withSecurityHeaders(Response.json(body,{status}));
const failure=(status,error)=>response(status,{error});
const unavailable=()=>failure(503,'admin_unavailable');
const timestamp=value=>value===null || (typeof value==='string' && Number.isFinite(Date.parse(value)));
function validState(row,id) {
 return row?.user_id===id && Number.isSafeInteger(row.admin_revision) && row.admin_revision>=0 &&
  row.admin_revision<=9999999999 && ['disabled_at','soft_deleted_at','delete_due_at'].every(key=>timestamp(row[key])) &&
  (row.soft_deleted_at===null ? row.delete_due_at===null : row.disabled_at!==null &&
    Date.parse(row.delete_due_at)===Date.parse(row.soft_deleted_at)+30*86400000);
}
const status=row=>row.soft_deleted_at!==null?'soft_deleted':row.disabled_at!==null?'disabled':'active';
export function adminProfileMetadata(row,id) {
 if(!validState(row,id))return null;
 return Object.fromEntries(['user_id','disabled_at','soft_deleted_at','delete_due_at','admin_revision'].map(key=>[key,row[key]]));
}

export async function handleProfileAction({request,route,user,env,body,rpc,gotrue,rooms,nowMs=()=>Date.now()}) {
 if (!isAdminUser(user,env)) return failure(403,'forbidden');
 const action=route.key.replace('facilitators_','');
 if (!['disable','enable','soft_delete','restore'].includes(action)) return failure(400,'bad_request');
 const destructive=action==='disable'||action==='soft_delete';
 if (!body || Object.keys(body).some(key=>!['expectedRevision','confirmEmail'].includes(key)) ||
     !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.expectedRevision>9999999997)
  return failure(400,'bad_request');
 const targetId=route.pattern.exec(new URL(request.url).pathname)?.[1];
 if (!isUuid(targetId)) return failure(400,'bad_request');
 if (!rpc?.call || !gotrue?.getUser || !gotrue?.updateUser || (destructive && !rooms?.endOwned)) return unavailable();
 const lookup=await gotrue.getUser(targetId);
 if (!lookup?.ok) return lookup?.kind==='not_found'?failure(404,'not_found'):unavailable();
 const target=lookup.user;
 if (target?.id!==targetId) return unavailable();
 if (destructive && isAdminUser(target,env)) return failure(403,'forbidden');
 if ((destructive || body.confirmEmail!==undefined) && body.confirmEmail!==target.email)
  return failure(400,'bad_request');
 const read=await rpc.call('admin_read_profiles',{p_user_ids:[targetId]});
 if (!read?.ok || !Array.isArray(read.data) || read.data.length!==1 || !validState(read.data[0],targetId)) return unavailable();
 const before=read.data[0],oldStatus=status(before);
 if (before.admin_revision!==body.expectedRevision ||
     (action==='disable'&&oldStatus!=='active') || (action==='enable'&&oldStatus!=='disabled') ||
     (action==='soft_delete'&&oldStatus==='soft_deleted') ||
     (action==='restore'&&(oldStatus!=='soft_deleted'||Date.parse(before.delete_due_at)<=nowMs())))
  return failure(409,'conflict');
 // This admin's elevation for this sign-in session (card 35, R-a).
 const elevated=async()=>Boolean(await verifyElevation(request.headers.get('X-Admin-Elevation'),user.email,user.sessionId,env.STEPUP_SECRET));
 if (destructive && !await elevated()) return failure(403,'forbidden');
 const actor=await rpc.call('admin_account_active',{p_user_id:user.userId});
 if (!actor?.ok || typeof actor.data !== 'boolean') return unavailable();
 if (actor.data!==true) return failure(403,'forbidden');
 const prefix=adminAuditPrefix(request.headers.get('CF-Connecting-IP'));
 let persistedDestructive=false;
 const result=await runAuditedAction({rpc,action:`facilitator_${action}`,targetType:'facilitator',
  targetId,actorEmail:user.email,fromPrefix:prefix,before:{status:oldStatus,admin_revision:before.admin_revision},
  write:async()=>{
   if (destructive && !await elevated()) return {ok:false,status:403};
   const change=await rpc.call('admin_transition_profile',{p_user_id:targetId,p_expected_revision:before.admin_revision,p_action:action,p_admin:true,p_admin_email:user.email});
   if (!change?.ok) return {ok:false,status:change?.kind==='conflict'||['23514','40001'].includes(change?.code)?409:503};
   if (!Array.isArray(change.data)||change.data.length!==1||!validState(change.data[0],targetId)||
       change.data[0].admin_revision!==before.admin_revision+1) throw new Error('profile_write_outcome_unknown');
   const changed=change.data[0];
   persistedDestructive=destructive;
   const ban=await gotrue.updateUser(targetId,{banDuration:destructive?'876000h':'none'});
   if (!ban?.ok) throw new Error('provider_write_outcome_unknown');
   return changed;
  },after:changed=>({status:status(changed),admin_revision:changed.admin_revision}),
  revert:async changed=>{
   let banDuration='none';
   if (target.bannedUntil!==null) {
    const remaining=Date.parse(target.bannedUntil)-nowMs();
    if (!Number.isSafeInteger(remaining)||remaining>3153600000000) return {ok:false};
    if (remaining>0) banDuration=`${remaining}ms`;
   }
   if (!(await gotrue.updateUser(targetId,{banDuration}))?.ok) return {ok:false};
   const undo=await rpc.call('admin_revert_profile',{p_user_id:targetId,p_expected_revision:changed.admin_revision,
    p_disabled_at:before.disabled_at,p_soft_deleted_at:before.soft_deleted_at,p_delete_due_at:before.delete_due_at,p_admin:true,p_admin_email:user.email});
   return {ok:undo?.ok===true&&Array.isArray(undo.data)&&undo.data.length===1&&validState(undo.data[0],targetId)&&
    undo.data[0].admin_revision===changed.admin_revision+1&&
    ['disabled_at','soft_deleted_at','delete_due_at'].every(key=>undo.data[0][key]===before[key])};
  }});
 if (!result.ok) {
  // A provider failure cannot undo a known DB disable. Re-read before irreversible room ends.
  if(persistedDestructive&&result.error!=='change_reverted_audit_unavailable') {
   try {
    const current=await rpc.call('admin_read_profiles',{p_user_ids:[targetId]});
    if(!current?.ok||!Array.isArray(current.data)||current.data.length!==1||!validState(current.data[0],targetId))
     return failure(500,'manual_reconciliation_needed');
    if(status(current.data[0])!=='active')
     await rooms.endOwned({userId:targetId,actorEmail:user.email,fromPrefix:prefix,admitted:elevated});
   } catch { return failure(500,'manual_reconciliation_needed'); }
  }
  return failure(result.status,result.error);
 }
 if (destructive) {
  const ended=await rooms.endOwned({userId:targetId,actorEmail:user.email,fromPrefix:prefix,admitted:elevated});
  if (!ended?.ok) return failure(500,'manual_reconciliation_needed');
 }
 return response(200,{profile:result.result});
}
