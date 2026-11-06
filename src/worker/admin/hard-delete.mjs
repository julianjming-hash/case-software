// Retention deletion is external-first: a failed Auth delete must never create a ghost account.
import {isUuid} from '../../shared/ids.mjs';
import {isAdminUser} from './gate.mjs';
import {runAuditedAction} from './actions.mjs';
const failure=(status,error)=>({ok:false,status,error});
const date=value=>typeof value==='string' ? Date.parse(value) : NaN;

export async function hardDeleteFacilitator({profile,env,actorEmail,fromPrefix=null,rpc,gotrue,
  nowMs=()=>Date.now()}) {
  if (!profile || !isUuid(profile.user_id) || !Number.isSafeInteger(profile.admin_revision) ||
      profile.admin_revision<0 || !Number.isFinite(date(profile.disabled_at)) ||
      !Number.isFinite(date(profile.soft_deleted_at)) || !Number.isFinite(date(profile.delete_due_at)))
    return failure(400,'bad_request');
  const due=date(profile.delete_due_at);
  if (due!==date(profile.soft_deleted_at)+30*86400000 || due>nowMs())
    return failure(409,'conflict');
  if (!rpc?.call || !gotrue?.getUser || !gotrue?.deleteUser) return failure(503,'admin_unavailable');
  const target=await gotrue.getUser(profile.user_id);
  if (!target?.ok && target?.kind!=='not_found') return failure(503,'admin_unavailable');
  if (target?.ok && target.user?.id!==profile.user_id) return failure(503,'admin_unavailable');
  if (target?.ok && isAdminUser(target.user,env)) return failure(403,'forbidden');
  if (due>nowMs()) return failure(409,'conflict');
  const result=await runAuditedAction({rpc,action:'facilitator_hard_delete',targetType:'facilitator',
    targetId:profile.user_id,actorEmail,fromPrefix,before:{status:'soft_deleted',admin_revision:profile.admin_revision},
    irreversible:true,
    write:async({intentId})=>{
      const claimed=await rpc.call('admin_claim_due_profile_deletion',{
        p_user_id:profile.user_id,p_expected_revision:profile.admin_revision,p_intent_id:intentId});
      if(!claimed?.ok) throw new Error('profile_deletion_claim_unknown');
      if(claimed.data===false) return {ok:false,status:409};
      if(claimed.data!==true) throw new Error('profile_deletion_claim_unknown');
      const removed=await gotrue.deleteUser(profile.user_id);
      if (!removed?.ok) throw new Error('auth_delete_outcome_unknown');
      const deleted=await rpc.call('admin_delete_due_profile',{
        p_user_id:profile.user_id,p_expected_revision:profile.admin_revision});
      if (!deleted?.ok || deleted.data!==true) throw new Error('profile_delete_incomplete');
      return {completed:true};
    },after:()=>({status:'completed'})});
  return result.ok ? {ok:true} : failure(result.status,result.error);
}
