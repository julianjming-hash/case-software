// Worker-only PostgREST client. Bindings are read exclusively through the credential accessor.
import { supabaseConfig, ConfigError } from './supabase-keys.mjs';
import { isUuidV7 } from '../shared/ids.mjs';

export const RPC_ARGUMENTS = Object.freeze(Object.fromEntries(Object.entries({
  beta_issue_dispatch:['p_actor','p_action','p_input'], beta_issue_sweep:['p_action','p_input'],
  save_draft: ['p_case_id','p_expected_revision','p_schema_version','p_document','p_user_id','p_admin','p_admin_email'],
  get_draft: ['p_case_id','p_user_id','p_admin','p_admin_email'],
  builder_get_draft: ['p_case_id','p_user_id','p_admin','p_admin_email'],
  builder_open_save_window: ['p_case_id','p_base_revision','p_user_id','p_admin','p_admin_email'],
  builder_save_draft: ['p_case_id','p_operation_id','p_document','p_authoring_metadata','p_user_id','p_admin','p_admin_email'],
  builder_get_save_receipt: ['p_case_id','p_operation_id','p_user_id','p_admin','p_admin_email'],
  builder_list_checkpoints: ['p_case_id','p_user_id','p_admin','p_admin_email'],
  builder_list_draft_summaries: ['p_workspace_id','p_limit','p_offset','p_user_id','p_admin','p_admin_email'],
  builder_list_drafts: ['p_workspace_id','p_limit','p_offset','p_user_id','p_admin','p_admin_email'],
  builder_create_checkpoint: ['p_case_id','p_name','p_expected_revision','p_user_id','p_admin','p_admin_email'],
  builder_delete_checkpoint: ['p_case_id','p_checkpoint_id','p_user_id','p_admin','p_admin_email'],
  builder_archive_case: ['p_case_id','p_user_id','p_confirm_title','p_admin','p_admin_email'],
  builder_restore_checkpoint: ['p_case_id','p_checkpoint_id','p_operation_id','p_user_id','p_admin','p_admin_email'],
  builder_cleanup_expired_state: ['p_case_id'],
  builder_publication_readiness: ['p_case_id','p_expected_revision','p_user_id','p_admin','p_admin_email'],
  builder_submit_candidate: ['p_case_id','p_request_id','p_expected_revision','p_document','p_authoring_metadata','p_user_id','p_admin','p_admin_email'],
  builder_list_candidates: ['p_case_id','p_user_id','p_admin','p_admin_email'],
  builder_get_review_candidate: ['p_case_id','p_candidate_id','p_user_id','p_admin','p_admin_email'],
  builder_cancel_candidate: ['p_case_id','p_candidate_id','p_user_id','p_admin','p_admin_email'],
  builder_delete_candidate_body: ['p_case_id','p_candidate_id','p_user_id','p_admin','p_admin_email'],
  builder_approve_candidate: ['p_case_id','p_candidate_id','p_expected_revision','p_intent_digest','p_content_sha256','p_user_id','p_admin','p_admin_email'],
  builder_release_candidate: ['p_case_id','p_candidate_id','p_expected_revision','p_intent_digest','p_content_sha256','p_asset_ids','p_art','p_user_id','p_admin','p_admin_email'],
  builder_release_update: ['p_case_id','p_candidate_id','p_expected_revision','p_intent_digest','p_content_sha256','p_asset_ids','p_art','p_new_edition','p_user_id','p_admin','p_admin_email'],
  get_case_version_for_workspace: ['p_version_id','p_workspace_id','p_user_id','p_admin','p_admin_email'],
  get_case_authoring_access: ['p_case_id','p_user_id','p_admin','p_admin_email'],
  create_session: ['p_session_id','p_case_version_id','p_workspace_id','p_facilitator_id','p_join_code','p_ttl','p_admin','p_admin_email'],
  resolve_join_code: ['p_join_code'], archive_session_batch: ['p_session_id','p_batch'],
  // Participant feedback (CASE-284): capability paths; the Worker derives the respondent hash, never a client.
  feedback_resolve: ['p_code'], feedback_upsert: ['p_session_id','p_respondent_sha256','p_source','p_answers','p_expected_revision'], feedback_mine: ['p_session_id','p_respondent_sha256'], session_feedback_code: ['p_session_id'],
  end_session: ['p_session_id','p_final_revision','p_final_epoch'], purge_expired_participant_data: ['p_retention'],
  // Console layout v2: the room tells Postgres it is in Debrief, so the feedback page opens before End.
  set_session_debrief: ['p_session_id','p_on'],
  ensure_profile: ['p_user_id','p_display_name'], bootstrap_workspace: ['p_user_id','p_slug','p_name','p_admin','p_admin_email'],
  get_me: ['p_user_id','p_limit','p_after','p_workspace_id','p_admin','p_admin_email'],
  admin_list_workspaces: ['p_user_id','p_after','p_admin','p_admin_email'],
  admin_workspace_query: ['p_user_id','p_workspace_id','p_tab','p_query','p_status','p_from','p_until','p_after','p_admin','p_admin_email'],
  admin_change_membership: ['p_actor_user_id','p_workspace_id','p_email','p_role','p_transfer_from','p_expected_revision','p_confirm_email','p_elevation_id','p_admin','p_admin_email'],
  admin_query_operations: ['p_user_id','p_query','p_after','p_admin','p_admin_email'],
  finalize_session_portfolio: ['p_session_id','p_version_id','p_revision','p_epoch','p_seq','p_round_count','p_joined'],
  resolve_catalogue_case:['p_user_id','p_case_id','p_admin','p_admin_email'],
  purge_abandoned_lobbies:['p_limit'],
  query_teaching_session_portfolio:['p_user_id','p_workspace_id','p_query','p_status','p_from','p_until','p_after','p_personal','p_admin','p_admin_email','p_case_id'],
  personal_teaching_portfolio_stats:['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  query_case_session_portfolio: ['p_user_id','p_workspace_id','p_query','p_status','p_from','p_until','p_after','p_personal','p_admin','p_admin_email','p_case_id'],
  query_session_portfolio: ['p_user_id','p_workspace_id','p_query','p_status','p_from','p_until','p_after','p_personal','p_admin','p_admin_email'],
  personal_portfolio_stats: ['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  read_session_portfolio: ['p_user_id','p_session_id','p_after','p_boundary','p_admin','p_admin_email'],
  list_room_history: ['p_user_id','p_workspace_id','p_filter','p_limit','p_after_at','p_after_id','p_admin','p_admin_email'],
  list_owned_active_sessions: ['p_user_id','p_limit','p_after','p_admin','p_admin_email'],
  create_case: ['p_user_id','p_workspace_id','p_title','p_admin','p_admin_email'],
  list_published_versions: ['p_user_id','p_workspace_id','p_limit','p_after','p_admin','p_admin_email'],
  list_case_catalogue: ['p_user_id','p_workspace_id','p_sort','p_descending','p_query','p_duration','p_audience','p_limit','p_offset','p_group_id','p_ungrouped','p_admin','p_admin_email'],
  list_case_catalogue_current: ['p_user_id','p_workspace_id','p_sort','p_descending','p_query','p_duration','p_audience','p_limit','p_offset','p_group_id','p_ungrouped','p_admin','p_admin_email'],
  list_case_catalogue_groups: ['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  list_groups: ['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  create_group: ['p_user_id','p_workspace_id','p_name','p_description','p_tint','p_admin','p_admin_email'],
  edit_group: ['p_user_id','p_workspace_id','p_group_id','p_expected_revision','p_name','p_description','p_tint','p_admin','p_admin_email'],
  assign_case_group: ['p_user_id','p_workspace_id','p_case_id','p_expected_revision','p_group_id','p_admin','p_admin_email'],
  archive_group: ['p_user_id','p_workspace_id','p_group_id','p_expected_revision','p_confirm_name','p_move_to','p_admin','p_admin_email','p_elevation_id'],
  get_case_group: ['p_user_id','p_case_id','p_admin','p_admin_email'],
  list_case_catalogue_audiences: ['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  get_catalogue_case: ['p_user_id','p_case_id','p_version_no','p_admin','p_admin_email'],
  get_catalogue_case_current: ['p_user_id','p_case_id','p_version_no','p_admin','p_admin_email'],
  get_catalogue_case_history: ['p_user_id','p_case_id','p_version_no','p_admin','p_admin_email'],
  list_admin_due_profiles: ['p_limit','p_after'],
  admin_delete_due_profile: ['p_user_id','p_expected_revision'],
  admin_claim_due_profile_deletion: ['p_user_id','p_expected_revision','p_intent_id'],
  admin_read_case_version: ['p_version_id'],
  list_admin_case_versions: ['p_limit','p_after'],
  admin_account_active: ['p_user_id'],
  admin_teaching_workspace_exists: ['p_workspace_id'],
  admin_provision_facilitator: ['p_user_id','p_workspace_id','p_actor_user_id','p_admin','p_admin_email'],
  admin_set_workspace_owner: ['p_workspace_id','p_user_id','p_actor_user_id','p_admin','p_admin_email'],
  get_session_workspace: ['p_session_id'],
  admin_transition_profile: ['p_user_id','p_expected_revision','p_action','p_admin','p_admin_email'],
  admin_read_profiles: ['p_user_ids'],
  // The facilitator's Name & role (P-40 self, P-41 admin) and the room's label fixed at start.
  set_own_facilitator_label: ['p_user_id','p_name','p_role'],
  admin_set_facilitator_label: ['p_user_id','p_expected_revision','p_name','p_role','p_admin','p_admin_email'],
  admin_read_facilitator_labels: ['p_user_ids'],
  set_session_facilitator_label: ['p_session_id','p_label'],
  admin_revert_profile: ['p_user_id','p_expected_revision','p_disabled_at','p_soft_deleted_at','p_delete_due_at','p_admin','p_admin_email'],
  admin_set_version_state: ['p_version_id','p_expected_revision','p_action','p_user_id','p_admin','p_admin_email','p_elevation_id'],
  record_admin_elevation: ['p_jti','p_actor_email','p_scope','p_session_id'],
  claim_admin_stepup_attempt: ['p_event_id','p_actor_email','p_action','p_from_prefix'],
  write_admin_audit: ['p_event_id','p_intent_id','p_phase','p_action','p_target_type','p_target_id','p_actor_email','p_before','p_after','p_from_prefix'],
  list_admin_audit: ['p_limit','p_after'],
  list_workspace_audit: ['p_user_id','p_workspace_id','p_limit','p_after','p_admin','p_admin_email'],
  retention_status: ['p_session_id'],
  // Card 59 M2 (CASE-268): Builder images.
  builder_set_asset_attestation: ['p_workspace_id','p_asset_id','p_expected','p_attested','p_user_id','p_admin','p_admin_email'],
  builder_create_asset: ['p_workspace_id','p_user_id','p_admin','p_admin_email','p_display','p_phone','p_details','p_poster'],
  builder_list_assets: ['p_workspace_id','p_user_id','p_admin','p_admin_email','p_ids'],
  builder_media_put_allowance: ['p_workspace_id','p_user_id','p_admin','p_admin_email','p_sha256','p_bytes','p_type'],
  builder_asset_rendition: ['p_workspace_id','p_asset_id','p_rendition','p_user_id','p_admin','p_admin_email'],
  admin_review_asset: ['p_workspace_id','p_asset_id','p_decision','p_expected','p_acknowledged','p_user_id','p_admin','p_admin_email'],
  room_media_manifest: ['p_version_id','p_workspace_id','p_user_id','p_admin','p_admin_email'],
  // Card 59 M4 (CASE-270): takedown and the hourly retention sweep.
  admin_withdraw_asset: ['p_workspace_id','p_asset_id','p_reason','p_user_id','p_admin','p_admin_email','p_elevation_id'],
  media_purge_claim: ['p_limit'], media_purge_complete: ['p_keys'], media_known_keys: ['p_keys'], media_sweep_position: ['p_start_after'],
  session_media_rendition: ['p_user_id','p_session_id','p_asset_id','p_admin','p_admin_email'],
  // Card 40 + feedback slice 9: P-37, P-38 and P-39 reads; aggregates and unlinked comments only.
  session_feedback_summary: ['p_user_id','p_session_id','p_admin','p_admin_email'],
  case_feedback_summary: ['p_user_id','p_case_id','p_version_no','p_admin','p_admin_email'],
  admin_feedback_page: ['p_user_id','p_filter','p_after','p_admin','p_admin_email'],
  ping: [], heartbeats: [], lockdown_alerts_since: ['p_since','p_limit','p_after'],
  // Facilitator-UX A2 (CASE-336 to CASE-342): case-keyed images, storage, access facts, sharing, policies and
  // invitations. Allowlisted with the migration; steps A3 to A6 make the calls.
  builder_case_media_put_allowance: ['p_case_id','p_user_id','p_admin','p_admin_email','p_sha256','p_bytes','p_type'],
  builder_create_case_asset: ['p_case_id','p_user_id','p_admin','p_admin_email','p_display','p_phone','p_details','p_poster'],
  builder_list_case_assets: ['p_case_id','p_user_id','p_admin','p_admin_email','p_ids'],
  builder_case_asset_rendition: ['p_case_id','p_asset_id','p_rendition','p_user_id','p_admin','p_admin_email'],
  admin_workspace_storage: ['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  admin_delete_unused_assets: ['p_user_id','p_workspace_id','p_asset_ids','p_elevation_id','p_admin','p_admin_email'],
  personal_record_workspaces: ['p_user_id','p_after'],
  personal_record_workspace_access: ['p_user_id','p_workspace_id'],
  workspace_details: ['p_user_id','p_workspace_id','p_admin','p_admin_email'],
  update_workspace_details: ['p_user_id','p_workspace_id','p_expected_revision','p_name','p_admin','p_admin_email'],
  case_workspace_access: ['p_user_id','p_case_id','p_admin','p_admin_email'],
  set_case_workspace_access: ['p_user_id','p_case_id','p_workspace_id','p_level','p_expected_revision','p_admin','p_admin_email'],
  move_case_workspace: ['p_user_id','p_case_id','p_workspace_id','p_expected_revision','p_admin','p_admin_email'],
  get_access: ['p_user_id','p_workspace_id','p_case_id','p_admin','p_admin_email'],
  list_shared_cases: ['p_user_id'],
  list_case_access: ['p_user_id','p_case_id','p_admin','p_admin_email'],
  revoke_case_grant: ['p_user_id','p_grant_id','p_admin','p_admin_email'],
  admin_set_workspace_policies: ['p_user_id','p_workspace_id','p_expected_revision','p_policies','p_media_quota_bytes','p_admin','p_admin_email'],
  create_invitation: ['p_user_id','p_workspace_id','p_case_id','p_level','p_email','p_ref_hash','p_invitee_user_id','p_admin','p_admin_email'],
  list_invitations: ['p_user_id','p_workspace_id','p_after','p_admin','p_admin_email'],
  resend_invitation: ['p_user_id','p_invitation_id','p_ref_hash','p_admin','p_admin_email'],
  record_invitation_delivery: ['p_invitation_id','p_outcome','p_retry_after'],
  revoke_invitation: ['p_user_id','p_invitation_id','p_admin','p_admin_email'],
  peek_invitation: ['p_ref_hash'],
  accept_invitations: ['p_user_id','p_email'],
  purge_invitation_addresses: [],
  // Ruling R7 (A4): the version's case, looked up before a case-only holder's version read.
  version_case: ['p_version_id'],
  admin_read_access: ['p_user_ids'],
}).map(([name,args]) => [name,Object.freeze(args)])));
export const RPC_ALLOWLIST = Object.freeze(Object.keys(RPC_ARGUMENTS));
const ALLOWED = new Set(RPC_ALLOWLIST);
const OPTIONAL = { create_session:['p_ttl'],purge_expired_participant_data:['p_retention'],lockdown_alerts_since:['p_limit','p_after'],get_me:['p_limit','p_after','p_workspace_id'],list_owned_active_sessions:['p_limit','p_after'],builder_cleanup_expired_state:['p_case_id'],feedback_upsert:['p_expected_revision'] };
const CURSORS = { list_published_versions:'version_id',list_owned_active_sessions:'session_id',lockdown_alerts_since:'id' };
// Upstream codes may echo arbitrary inputs. Unknown codes are discarded, never logged or returned.
const SQL_CODES = new Set(['40001','40P01','42501','23505','23514','22023','22P02','P0002','PGRST202','PGRST116']);
const failure = (kind,status,code) => ({ ok:false,kind,status,code });
function mapError(status, body) {
  const code = SQL_CODES.has(body?.code) ? body.code : null;
  if (code === '42501') return failure('forbidden',500,code);
  // A deadlock (40P01) rolled the write back whole: the caller reloads and retries, as for a CAS conflict.
  if (code === '40P01') return failure('conflict',409,code);
  if (status >= 500) return failure('unavailable',503,code);
  if (code === '40001') return failure('conflict',409,code);
  if (code === '23505') return failure('unique',409,code);
  // P0002: a child id that is not in the authorized workspace (card 30 group RPCs; refused, never filtered).
  if (status === 404 || code === 'PGRST116' || code === 'P0002') return failure('not_found',404,code);
  // CASE-342: a workspace's full image storage is the one refusal whose message the Worker reads, and only its two
  // numbers (case_app.media_allow_put raises exactly this text); any other message is discarded as before.
  const full = code === '23514' && typeof body?.message === 'string' ? STORAGE_FULL.exec(body.message) : null;
  if (full) return { ...failure('storage_full',507,code), usedBytes:Number(full[1]), quotaBytes:Number(full[2]) };
  return failure('bad_request',400,code);
}
const STORAGE_FULL = /^storage_full: used (\d{1,15}) of (\d{1,15}) bytes$/;
export class RpcPageError extends Error {
  constructor(result) {
    super('RPC page failed'); this.name='RpcPageError';
    this.kind=result.kind; this.status=result.status; this.code=result.code;
  }
}
const pageError = code => new RpcPageError(failure('unavailable',503,code));
const plainArgs = args => args !== null && typeof args === 'object' && !Array.isArray(args) && [Object.prototype,null].includes(Object.getPrototypeOf(args));

// Published packs accept <=1 MiB of exact document_text. Allow both document and
// its escaped text duplicate, even conservative sixfold JSON escaping, plus an
// envelope allowance. Draft documents use this same larger bound. Metadata RPCs
// include bounded pages and up to 1000 small profile rows; errors use a separate cap.
export const RPC_RESPONSE_MAX_BYTES = 8 * 1_048_576 + 65_536;
export const RPC_METADATA_MAX_BYTES = 1_048_576;
export const RPC_ERROR_MAX_BYTES = 65_536;
const DOCUMENT_RPCS = new Set(['get_draft','builder_get_draft','builder_get_review_candidate','get_case_version_for_workspace','read_session_portfolio']);

function cancelReader(reader) {
  try { void Promise.resolve(reader?.cancel()).catch(()=>{}); } catch { /* cancellation cannot delay refusal */ }
}

async function readResponse(response, limit, controller, setReader) {
  const declared=response.headers?.get('content-length');
  const reader=response.body?.getReader();
  if (reader) setReader(reader);
  if (declared !== null && declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    controller.abort(); cancelReader(reader); return { ok:false,code:'response_too_large' };
  }
  if (!reader) return { ok:false,code:'invalid_response' };
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let size=0, text='';
  try {
    for (;;) {
      if (controller.signal.aborted) { cancelReader(reader); return { ok:false,code:'timeout' }; }
      const {done,value}=await reader.read();
      if (controller.signal.aborted) { cancelReader(reader); return { ok:false,code:'timeout' }; }
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > limit) {
        controller.abort(); cancelReader(reader); return { ok:false,code:'response_too_large' };
      }
      size+=value.byteLength;
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
    return { ok:true,data:JSON.parse(text) };
  } catch { cancelReader(reader); return { ok:false,code:'invalid_response' }; }
  finally { setReader(null); }
}

export function rpcClient(env, { fetchImpl=fetch, timeoutMs=5000, onAlert } = {}) {
  const { url,secretKey }=supabaseConfig(env);
  let base;
  try { base=new URL(url); } catch { throw new ConfigError('Invalid RPC configuration'); }
  if (!secretKey || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || (onAlert !== undefined && typeof onAlert !== 'function')) throw new ConfigError('Invalid RPC configuration');
  async function call(name,args={}) {
    if (!ALLOWED.has(name)) return failure('bad_request',400,'invalid_rpc');
    let body;
    try {
      if (!plainArgs(args) || Object.keys(args).some(key=>!RPC_ARGUMENTS[name].includes(key)) || RPC_ARGUMENTS[name].some(key=>!(OPTIONAL[name]??[]).includes(key) && (!(key in args) || args[key] === undefined))) return failure('bad_request',400,'invalid_arguments');
      body=JSON.stringify(args);
    } catch { return failure('bad_request',400,'invalid_arguments'); }
    const controller=new AbortController();
    let timer, reader=null;
    const timeout=new Promise(resolve=> { timer=setTimeout(()=> { controller.abort(); cancelReader(reader); resolve(failure('unavailable',503,'timeout')); },timeoutMs); });
    const request=(async()=> {
      try {
        // Supabase: "Send publishable and secret keys on the apikey header, not on Authorization: Bearer."
        // https://supabase.com/docs/guides/getting-started/api-keys#known-limitations
        const response=await fetchImpl(`${base.origin}/rest/v1/rpc/${name}`, { method:'POST',redirect:'manual',signal:controller.signal,
          headers:{ apikey:secretKey,'content-profile':'case_api','accept-profile':'case_api','content-type':'application/json' },body });
        if (controller.signal.aborted) { cancelReader(response.body); return failure('unavailable',503,'timeout'); }
        // workerd supports manual, not error. Never follow a Location with the service key.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          controller.abort(); cancelReader(response.body);
          return failure('unavailable',503,'redirect');
        }
        let data=null;
        if (response.status !== 204) {
          const limit=response.ok ? (DOCUMENT_RPCS.has(name) ? RPC_RESPONSE_MAX_BYTES : RPC_METADATA_MAX_BYTES) : RPC_ERROR_MAX_BYTES;
          const parsed=await readResponse(response,limit,controller,value=> { reader=value; });
          if (!parsed.ok) return parsed.code === 'response_too_large' || response.ok ? failure('unavailable',503,parsed.code) : mapError(response.status,null);
          data=parsed.data;
        }
        return response.ok ? { ok:true,data } : mapError(response.status,data);
      } catch { return failure('unavailable',503,'network'); }
    })();
    let result;
    try { result=await Promise.race([request,timeout]); } finally { clearTimeout(timer); }
    // Never await an alert backend. Rejections are contained; only fixed, allowlisted metadata leaves.
    if ((result.kind === 'forbidden' || result.kind === 'unavailable' || result.code === 'PGRST202') && onAlert) {
      // Invoke trusted hooks immediately for reliable handoff (e.g. ctx.waitUntil).
      // Async delivery is never awaited; trusted synchronous work must stay short.
      try { void Promise.resolve(onAlert(Object.freeze({ kind:result.kind,code:result.code,name }))).catch(()=>{}); }
      catch { /* hook failure is isolated */ }
    }
    return result;
  }
  async function* page(name,args={}, { limit=100 }={}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RpcPageError(failure('bad_request',400,'invalid_limit'));
    const cursorField=CURSORS[name], seen=new Set();
    let nextArgs;
    try { if (!plainArgs(args)) throw new Error(); nextArgs={...args}; }
    catch { throw new RpcPageError(failure('bad_request',400,'invalid_arguments')); }
    if (cursorField) nextArgs={...nextArgs,p_limit:limit,p_after:nextArgs.p_after??null};
    for (;;) {
      const result=await call(name,nextArgs);
      if (!result.ok) throw new RpcPageError(result);
      const rows=result.data;
      if (!Array.isArray(rows)) throw pageError('invalid_page');
      if (!cursorField && rows.length >= 1000) throw pageError('cursor_required');
      if (cursorField && rows.length > limit) throw pageError('invalid_page');
      // Validate the complete page before yielding; never silently accept duplicate/stalled cursors.
      if (cursorField) for (const row of rows) {
        const cursor=row?.[cursorField];
        if (!isUuidV7(cursor) || seen.has(cursor) || cursor === nextArgs.p_after) throw pageError('invalid_page');
        seen.add(cursor);
      }
      for (const row of rows) yield row;
      if (!cursorField || rows.length < limit) return;
      nextArgs={...nextArgs,p_after:rows.at(-1)[cursorField]};
    }
  }
  return Object.freeze({call,page});
}
