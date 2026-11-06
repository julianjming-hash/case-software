// Dedicated hourly scheduled purge. In-flight irreversible work finishes; no automatic retries.
import {isUuid} from '../../shared/ids.mjs';
import {adminEmails} from './gate.mjs';
import {hardDeleteFacilitator} from './hard-delete.mjs';
export const ADMIN_PURGE_CRON='47 * * * *';
const failure=(error,deleted)=>({ok:false,error,deleted});

export async function runAdminDeletionSweep({env,rpc,gotrue,nowMs=()=>Date.now()}) {
  let deleted=0;
  if (!adminEmails(env) || !rpc?.call || !gotrue?.getUser || !gotrue?.deleteUser)
    return failure('admin_unavailable',deleted);
  const started=nowMs();let after=null;
  for (;;) {
    if (deleted>=10 || nowMs()-started>=60000) return {ok:true,deleted,remaining:true};
    let page;
    try { page=await rpc.call('list_admin_due_profiles',{p_limit:100,p_after:after}); }
    catch { return failure('admin_unavailable',deleted); }
    if (!page?.ok || !Array.isArray(page.data) || page.data.length>100)
      return failure('admin_unavailable',deleted);
    let previous=after;
    for (const profile of page.data) {
      if (!isUuid(profile?.user_id) || (previous!==null && profile.user_id<=previous))
        return failure('admin_unavailable',deleted);
      previous=profile.user_id;
    }
    for (const profile of page.data) {
      if (deleted>=10 || nowMs()-started>=60000) return {ok:true,deleted,remaining:true};
      let result;
      try {
        result=await hardDeleteFacilitator({profile,env,rpc,gotrue,nowMs,
          actorEmail:'system@case.iatrogenic.app',fromPrefix:null});
      } catch { return failure('manual_reconciliation_needed',deleted); }
      if (!result?.ok) return failure(result?.error ?? 'admin_unavailable',deleted);
      deleted++;
    }
    if (page.data.length<100) return {ok:true,deleted,remaining:false};
    after=previous;
  }
}
