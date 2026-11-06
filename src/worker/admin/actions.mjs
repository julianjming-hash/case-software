// Durable audit envelopes for server-only mutations. No provider error or free text enters the log.
import { uuidv7, isUuid } from '../../shared/ids.mjs';

const actions = new Set(['facilitator_invite','facilitator_resend','facilitator_disable',
  'facilitator_enable','facilitator_soft_delete','facilitator_restore','facilitator_hard_delete','facilitator_label_edit',
  'case_publish','version_withdraw','room_end']);
const statuses = new Set(['active','disabled','soft_deleted','invited','published','withdrawn',
  'ended','completed','failed','unknown_outcome','manual_reconciliation_needed']);
const email = value => typeof value === 'string' && value.length <= 320 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value);
function snapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, data]) =>
    key === 'status' ? statuses.has(data) : key === 'email' ? email(data) :
      ['admin_revision','version_no'].includes(key) && Number.isSafeInteger(data) && data >= 0 && data <= 9999999999);
}
const failure = (status,error) => ({ok:false,status,error});

export async function runAuditedAction({rpc,action,targetType,targetId,actorEmail,fromPrefix,
  before,write,revert,after,irreversible=false}) {
  if (!actions.has(action) || !['facilitator','case','version','room'].includes(targetType) ||
      !(isUuid(targetId) || (action === 'facilitator_invite' && targetId === null)) ||
      !email(actorEmail) || !snapshot(before) || typeof write !== 'function' ||
      typeof after !== 'function' || (!irreversible && typeof revert !== 'function'))
    return failure(400,'bad_request');
  if (!rpc?.call) return failure(503,'audit_unavailable');
  const intentId = uuidv7();
  const common = {p_action:action,p_target_type:targetType,p_target_id:targetId,
    p_actor_email:actorEmail,p_before:before,p_from_prefix:fromPrefix};
  async function audit(phase, state) {
    try {
      const result = await rpc.call('write_admin_audit',{...common,
        p_event_id:phase === 'intent' ? intentId : uuidv7(),p_intent_id:intentId,
        p_phase:phase,p_after:state});
      return result?.ok === true;
    } catch { return false; }
  }
  if (!await audit('intent',{})) return failure(503,'audit_unavailable');
  let result;
  try { result = await write({intentId}); }
  catch {
    await audit('outcome',{status:'unknown_outcome'});
    return failure(500,'manual_reconciliation_needed');
  }
  if (result?.ok === false) {
    if (!await audit('outcome',{status:'failed'})) return failure(503,'audit_unavailable');
    if (result.status === 403) return failure(403,'forbidden');
    return result.status === 409 ? failure(409,'conflict') : failure(503,'admin_unavailable');
  }
  let state;
  try { state = after(result); } catch { state = null; }
  if (snapshot(state) && await audit('outcome',state)) return {ok:true,result};
  if (irreversible) return failure(500,'manual_reconciliation_needed');
  try {
    if ((await revert(result))?.ok === true)
      return failure(500,'change_reverted_audit_unavailable');
  } catch { /* A failed compensating write requires an explicit operator handoff. */ }
  return failure(500,'manual_reconciliation_needed');
}
