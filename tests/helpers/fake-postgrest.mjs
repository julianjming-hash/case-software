// In-memory PostgREST contract; this module never imports or calls a network client.
import { uuidv7 } from '../../src/shared/ids.mjs';
export const FAKE_RPC_CONTRACT = Object.freeze({
  beta_issue_dispatch: {args:['p_actor','p_action','p_input'],optional:[],shape:'object'},
  beta_issue_sweep: {args:['p_action','p_input'],optional:[],shape:'object'},
  admin_list_workspaces: { args: ['p_user_id', 'p_after', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  admin_workspace_query: { args: ['p_user_id', 'p_workspace_id', 'p_tab', 'p_query', 'p_status', 'p_from', 'p_until', 'p_after', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  admin_change_membership: { args: ['p_actor_user_id', 'p_workspace_id', 'p_email', 'p_role', 'p_transfer_from', 'p_expected_revision', 'p_confirm_email', 'p_elevation_id', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  admin_query_operations: { args: ['p_user_id', 'p_query', 'p_after', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  finalize_session_portfolio: { args: ['p_session_id', 'p_version_id', 'p_revision', 'p_epoch', 'p_seq', 'p_round_count', 'p_joined'], optional: [], shape: 'boolean' },
  resolve_catalogue_case:{args:['p_user_id','p_case_id','p_admin','p_admin_email'],optional:[],fields:['workspace_id','role','version_no']},
  purge_abandoned_lobbies:{args:['p_limit'],optional:[],shape:'number'},
  query_teaching_session_portfolio:{args:['p_user_id','p_workspace_id','p_query','p_status','p_from','p_until','p_after','p_personal','p_admin','p_admin_email','p_case_id'],optional:[],shape:'object'},
  personal_teaching_portfolio_stats:{args:['p_user_id','p_workspace_id','p_admin','p_admin_email'],optional:[],shape:'object'},
  query_case_session_portfolio: { args: ['p_user_id','p_workspace_id','p_query','p_status','p_from','p_until','p_after','p_personal','p_admin','p_admin_email','p_case_id'], optional: [], shape: 'object' },
  query_session_portfolio: { args: ['p_user_id', 'p_workspace_id', 'p_query', 'p_status', 'p_from', 'p_until', 'p_after', 'p_personal', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  personal_portfolio_stats: { args: ['p_user_id', 'p_workspace_id', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  read_session_portfolio: { args: ['p_user_id', 'p_session_id', 'p_after', 'p_boundary', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  save_draft: { args: ['p_case_id', 'p_expected_revision', 'p_schema_version', 'p_document', 'p_user_id', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], shape: 'number' },
  get_draft: { args: ['p_case_id', 'p_user_id', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['revision', 'schema_version', 'document', 'updated_at'] },
  builder_set_asset_attestation: { args: ['p_workspace_id','p_asset_id','p_expected','p_attested','p_user_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  builder_create_asset: { args: ['p_workspace_id','p_user_id','p_admin','p_admin_email','p_display','p_phone','p_details','p_poster'], optional: ['p_poster'], shape: 'object' },
  builder_media_put_allowance: { args: ['p_workspace_id','p_user_id','p_admin','p_admin_email','p_sha256','p_bytes','p_type'], optional: ['p_type'], shape: 'boolean' },
  builder_list_assets: { args: ['p_workspace_id','p_user_id','p_admin','p_admin_email','p_ids'], optional: [], shape: 'object' },
  builder_asset_rendition: { args: ['p_workspace_id','p_asset_id','p_rendition','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['status','r2_key','content_sha256','byte_size','content_type'] },
  admin_withdraw_asset: { args: ['p_workspace_id','p_asset_id','p_reason','p_user_id','p_admin','p_admin_email','p_elevation_id'], optional: [], fields: ['asset_id','status','r2_key'] },
  media_purge_claim: { args: ['p_limit'], optional: [], fields: ['r2_key'] },
  media_purge_complete: { args: ['p_keys'], optional: [], shape: 'number' },
  media_known_keys: { args: ['p_keys'], optional: [], fields: ['r2_key'] },
  media_sweep_position: { args: ['p_start_after'], optional: [], fields: ['resume_after'] },
  session_media_rendition: { args: ['p_user_id','p_session_id','p_asset_id','p_admin','p_admin_email'], optional: [], fields: ['status','r2_key','byte_size'] },
  room_media_manifest: { args: ['p_version_id','p_workspace_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['asset_id','status','width','height','attribution','display_key','phone_key','poster_key','media_type','duration_ms'] },
  admin_review_asset: { args: ['p_workspace_id','p_asset_id','p_decision','p_expected','p_acknowledged','p_user_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  builder_list_draft_summaries: { args: ['p_workspace_id','p_limit','p_offset','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['case_id','title','revision','updated_at','audience','duration_min','art_structure','publication_version','publication_at','publication_state','review_status'] },
  builder_list_drafts: { args: ['p_workspace_id','p_limit','p_offset','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['case_id','title','revision','updated_at'] },
  builder_get_draft: { args: ['p_case_id', 'p_user_id', 'p_admin', 'p_admin_email'], optional: [], fields: ['revision', 'schema_version', 'document', 'authoring_metadata', 'updated_at', 'intent_digest'] },
  builder_open_save_window: { args: ['p_case_id','p_base_revision','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['operation_id','base_revision','expires_at'] },
  builder_save_draft: { args: ['p_case_id','p_operation_id','p_document','p_authoring_metadata','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['operation_id','revision','intent_digest','status'] },
  builder_get_save_receipt: { args: ['p_case_id','p_operation_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['operation_id','base_revision','revision','intent_digest','status','committed_at','expires_at'] },
  builder_list_checkpoints: { args: ['p_case_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['id','name','revision','schema_version','created_at'] },
  builder_create_checkpoint: { args: ['p_case_id','p_name','p_expected_revision','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['id','name','revision','created_at'] },
  builder_delete_checkpoint: { args: ['p_case_id','p_checkpoint_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['deleted'] },
  builder_archive_case: { args: ['p_case_id','p_user_id','p_confirm_title','p_admin','p_admin_email'], optional: [], fields: ['case_id','outcome'] },
  builder_restore_checkpoint: { args: ['p_case_id','p_checkpoint_id','p_operation_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['operation_id','revision','intent_digest','status'] },
  builder_cleanup_expired_state: { args: ['p_case_id'], optional: ['p_case_id'], shape: 'number' },
  builder_publication_readiness: { args: ['p_case_id','p_expected_revision','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['code'] },
  builder_submit_candidate: { args: ['p_case_id','p_request_id','p_expected_revision','p_document','p_authoring_metadata','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','revision','intent_digest','content_sha256','status','submitted_at'] },
  builder_list_candidates: { args: ['p_case_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','revision','status','submitted_at','approved_at','released_version_id'] },
  builder_get_review_candidate: { args: ['p_case_id','p_candidate_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','revision','schema_version','document','authoring_metadata','intent_digest','content_sha256','status','submitted_by','submitted_at','approved_by','approved_at','approved_intent_digest','approved_content_sha256','released_version_id'] },
  builder_cancel_candidate: { args: ['p_case_id','p_candidate_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','status','revision'] },
  builder_delete_candidate_body: { args: ['p_case_id','p_candidate_id','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','deleted'] },
  builder_approve_candidate: { args: ['p_case_id','p_candidate_id','p_expected_revision','p_intent_digest','p_content_sha256','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','revision','status','approved_at','intent_digest','content_sha256'] },
  builder_release_candidate: { args: ['p_case_id','p_candidate_id','p_expected_revision','p_intent_digest','p_content_sha256','p_asset_ids','p_art','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','version_id','version_no','content_sha256','intent_digest','status'] },
  builder_release_update: { args: ['p_case_id','p_candidate_id','p_expected_revision','p_intent_digest','p_content_sha256','p_asset_ids','p_art','p_new_edition','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['candidate_id','version_id','version_no','content_sha256','intent_digest','status'] },
  get_case_version_for_workspace: { args: ['p_version_id', 'p_workspace_id', 'p_user_id', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['case_id', 'version_no', 'schema_version', 'document', 'document_text', 'content_sha256', 'art', 'tint'] },
  get_case_authoring_access: { args: ['p_case_id', 'p_user_id', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['case_id', 'workspace_id', 'role', 'title', 'source_version_id', 'source_version_no'] },
  create_session: { args: ['p_session_id', 'p_case_version_id', 'p_workspace_id', 'p_facilitator_id', 'p_join_code', 'p_ttl', 'p_admin', 'p_admin_email'], optional: ['p_ttl', 'p_admin', 'p_admin_email'], shape: 'uuid' },
  resolve_join_code: { args: ['p_join_code'], optional: [], fields: ['session_id', 'status', 'case_version_id'] },
  feedback_resolve: { args: ['p_code'], optional: [], shape: 'object' },
  feedback_upsert: { args: ['p_session_id', 'p_respondent_sha256', 'p_source', 'p_answers', 'p_expected_revision'], optional: ['p_expected_revision'], shape: 'object' },
  feedback_mine: { args: ['p_session_id', 'p_respondent_sha256'], optional: [], shape: 'object' },
  session_feedback_code: { args: ['p_session_id'], optional: [], shape: 'object' },
  set_session_debrief: { args: ['p_session_id', 'p_on'], optional: [], shape: 'boolean' },
  session_feedback_summary: { args: ['p_user_id', 'p_session_id', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  case_feedback_summary: { args: ['p_user_id', 'p_case_id', 'p_version_no', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  admin_feedback_page: { args: ['p_user_id', 'p_filter', 'p_after', 'p_admin', 'p_admin_email'], optional: [], shape: 'object' },
  archive_session_batch: { args: ['p_session_id', 'p_batch'], optional: [], shape: 'number' },
  end_session: { args: ['p_session_id', 'p_final_revision', 'p_final_epoch'], optional: [], shape: 'null' },
  purge_expired_participant_data: { args: ['p_retention'], optional: ['p_retention'], shape: 'number' },
  ensure_profile: { args: ['p_user_id', 'p_display_name'], optional: [], shape: 'null' },
  get_me: { args: ['p_user_id', 'p_limit', 'p_after', 'p_workspace_id', 'p_admin', 'p_admin_email'], optional: ['p_limit', 'p_after', 'p_workspace_id', 'p_admin', 'p_admin_email'], fields: ['user_id', 'display_name', 'memberships', 'next_after', 'admin', 'facilitator_role', 'label_confirmed_at', 'grants'] },
  list_room_history: { args: ['p_user_id','p_workspace_id','p_filter','p_limit','p_after_at','p_after_id','p_admin','p_admin_email'], optional: ['p_admin','p_admin_email'], fields: ['session_id','case_version_id','title','version_no','status','created_at','started_at','ended_at','expires_at','archive_state','own'] },
  list_owned_active_sessions: { args: ['p_user_id', 'p_limit', 'p_after', 'p_admin', 'p_admin_email'], optional: ['p_limit', 'p_after', 'p_admin', 'p_admin_email'], fields: ['session_id', 'join_code', 'expires_at'] },
  bootstrap_workspace: { args: ['p_user_id', 'p_slug', 'p_name', 'p_admin', 'p_admin_email'], optional: [], shape: 'uuid' },
  create_case: { args: ['p_user_id', 'p_workspace_id', 'p_title', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], shape: 'uuid' },
  list_published_versions: { args: ['p_user_id', 'p_workspace_id', 'p_limit', 'p_after', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['version_id', 'case_id', 'title', 'version_no', 'published_at', 'content_sha256', 'art'] },
  list_case_catalogue: { args: ['p_user_id', 'p_workspace_id', 'p_sort', 'p_descending', 'p_query', 'p_duration', 'p_audience', 'p_limit', 'p_offset', 'p_group_id', 'p_ungrouped', 'p_admin', 'p_admin_email'], optional: [], fields: ['version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'version_no', 'published_at', 'content_sha256', 'art', 'group_id', 'group_name', 'tint', 'total_count'] },
  list_case_catalogue_current: { args: ['p_user_id', 'p_workspace_id', 'p_sort', 'p_descending', 'p_query', 'p_duration', 'p_audience', 'p_limit', 'p_offset', 'p_group_id', 'p_ungrouped', 'p_admin', 'p_admin_email'], optional: [], fields: ['version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'version_no', 'published_at', 'content_sha256', 'art', 'group_id', 'group_name', 'tint', 'total_count'] },
  list_case_catalogue_groups: { args: ['p_user_id', 'p_workspace_id', 'p_admin', 'p_admin_email'], optional: [], fields: ['group_id', 'name', 'tint', 'case_count'] },
  list_groups: { args: ['p_user_id', 'p_workspace_id', 'p_admin', 'p_admin_email'], optional: [], fields: ['id', 'name', 'description', 'tint', 'revision', 'case_count'] },
  create_group: { args: ['p_user_id', 'p_workspace_id', 'p_name', 'p_description', 'p_tint', 'p_admin', 'p_admin_email'], optional: [], fields: ['id', 'revision'] },
  edit_group: { args: ['p_user_id', 'p_workspace_id', 'p_group_id', 'p_expected_revision', 'p_name', 'p_description', 'p_tint', 'p_admin', 'p_admin_email'], optional: [], fields: ['id', 'revision'] },
  assign_case_group: { args: ['p_user_id', 'p_workspace_id', 'p_case_id', 'p_expected_revision', 'p_group_id', 'p_admin', 'p_admin_email'], optional: [], fields: ['case_id', 'group_id', 'group_revision'] },
  archive_group: { args: ['p_user_id', 'p_workspace_id', 'p_group_id', 'p_expected_revision', 'p_confirm_name', 'p_move_to', 'p_admin', 'p_admin_email', 'p_elevation_id'], optional: [], fields: ['id', 'revision', 'moved'] },
  get_case_group: { args: ['p_user_id', 'p_case_id', 'p_admin', 'p_admin_email'], optional: [], fields: ['case_id', 'workspace_id', 'group_id', 'group_name', 'tint', 'group_revision'] },
  list_case_catalogue_audiences: { args: ['p_user_id', 'p_workspace_id', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['audience', 'case_count'] },
  get_catalogue_case: { args: ['p_user_id', 'p_case_id', 'p_version_no', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['workspace_id', 'role', 'version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'learning_objectives', 'version_no', 'published_at', 'content_sha256', 'art', 'versions'] },
  get_catalogue_case_current: { args: ['p_user_id', 'p_case_id', 'p_version_no', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['workspace_id', 'role', 'version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'learning_objectives', 'version_no', 'published_at', 'content_sha256', 'art', 'versions'] },
  get_catalogue_case_history: { args: ['p_user_id', 'p_case_id', 'p_version_no', 'p_admin', 'p_admin_email'], optional: ['p_admin', 'p_admin_email'], fields: ['workspace_id', 'role', 'version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'learning_objectives', 'version_no', 'published_at', 'content_sha256', 'art', 'versions'] },
  admin_account_active: { args: ['p_user_id'], optional: [], shape: 'boolean' },
  admin_teaching_workspace_exists: { args: ['p_workspace_id'], optional: [], shape: 'boolean' },
  admin_provision_facilitator: { args: ['p_user_id','p_workspace_id','p_actor_user_id','p_admin','p_admin_email'], optional: [], shape: 'null' },
  admin_set_workspace_owner: { args: ['p_workspace_id','p_user_id','p_actor_user_id','p_admin','p_admin_email'], optional: [], shape: 'null' },
  get_session_workspace: { args: ['p_session_id'], optional: [], shape: 'uuid' },
  admin_transition_profile: { args: ['p_user_id','p_expected_revision','p_action','p_admin','p_admin_email'], optional: [], fields: ['user_id','disabled_at','soft_deleted_at','delete_due_at','admin_revision'] },
  list_admin_due_profiles: { args: ['p_limit','p_after'], optional: ['p_limit','p_after'], fields: ['user_id','disabled_at','soft_deleted_at','delete_due_at','admin_revision'] },
  admin_delete_due_profile: { args: ['p_user_id','p_expected_revision'], optional: [], shape: 'boolean' },
  admin_claim_due_profile_deletion: { args: ['p_user_id','p_expected_revision','p_intent_id'], optional: [], shape: 'boolean' },
  admin_read_case_version: { args: ['p_version_id'], optional: [], fields: ['case_id','version_id','version_no','title','status','admin_revision'] },
  list_admin_case_versions: { args: ['p_limit','p_after'], optional: ['p_limit','p_after'], fields: ['case_id','version_id','version_no','title','status','admin_revision','workspace_id','group_id','group_name','tint','group_revision'] },
  admin_read_profiles: { args: ['p_user_ids'], optional: [], fields: ['user_id','disabled_at','soft_deleted_at','delete_due_at','admin_revision'] },
  set_own_facilitator_label: { args: ['p_user_id','p_name','p_role'], optional: [], fields: ['display_name','facilitator_role','label_confirmed_at'] },
  admin_set_facilitator_label: { args: ['p_user_id','p_expected_revision','p_name','p_role','p_admin','p_admin_email'], optional: [], fields: ['user_id','admin_revision','display_name','facilitator_role','label_confirmed_at'] },
  admin_read_facilitator_labels: { args: ['p_user_ids'], optional: [], fields: ['user_id','display_name','facilitator_role','label_confirmed_at'] },
  set_session_facilitator_label: { args: ['p_session_id','p_label'], optional: [], shape: 'boolean' },
  admin_revert_profile: { args: ['p_user_id','p_expected_revision','p_disabled_at','p_soft_deleted_at','p_delete_due_at','p_admin','p_admin_email'], optional: [], fields: ['user_id','disabled_at','soft_deleted_at','delete_due_at','admin_revision'] },
  admin_set_version_state: { args: ['p_version_id','p_expected_revision','p_action','p_user_id','p_admin','p_admin_email','p_elevation_id'], optional: [], fields: ['version_id','status','admin_revision'] },
  record_admin_elevation: { args: ['p_jti','p_actor_email','p_scope','p_session_id'], optional: [], shape: 'boolean' },
  claim_admin_stepup_attempt: { args: ['p_event_id','p_actor_email','p_action','p_from_prefix'], optional: [], shape: 'boolean' },
  write_admin_audit: { args: ['p_event_id','p_intent_id','p_phase','p_action','p_target_type','p_target_id','p_actor_email','p_before','p_after','p_from_prefix'], optional: [], shape: 'uuid' },
  list_admin_audit: { args: ['p_limit','p_after'], optional: ['p_limit','p_after'], fields: ['event_id','intent_id','phase','action','target_type','target_id','actor_email','before','after','at','from_prefix'] },
  list_workspace_audit: { args: ['p_user_id','p_workspace_id','p_limit','p_after','p_admin','p_admin_email'], optional: [], fields: ['event_id','actor_kind','actor_user_id','actor_email','action','target_type','target_id','revision','elevation_id','at'] },
  retention_status: { args: ['p_session_id'], optional: [], fields: ['session_id','status','created_at','started_at','ended_at','expires_at','personal_data_delete_at','retention_purged_at','server_time','response_count','participant_count','named_participant_count','token_participant_count','archived_event_count','archived_room_ended_count','archived_room_ended_at'] },
  ping: { args: [], optional: [], shape: 'timestamp' },
  heartbeats: { args: [], optional: [], fields: ['job', 'ran_at', 'rows'] },
  lockdown_alerts_since: { args: ['p_since', 'p_limit', 'p_after'], optional: ['p_limit', 'p_after'], fields: ['id', 'at', 'detail'] },
  // Facilitator-UX A2 (20261111000000_access_invitations_images.sql).
  builder_case_media_put_allowance: { args: ['p_case_id','p_user_id','p_admin','p_admin_email','p_sha256','p_bytes','p_type'], optional: [], shape: 'boolean' },
  builder_create_case_asset: { args: ['p_case_id','p_user_id','p_admin','p_admin_email','p_display','p_phone','p_details','p_poster'], optional: [], shape: 'object' },
  builder_list_case_assets: { args: ['p_case_id','p_user_id','p_admin','p_admin_email','p_ids'], optional: [], shape: 'object' },
  builder_case_asset_rendition: { args: ['p_case_id','p_asset_id','p_rendition','p_user_id','p_admin','p_admin_email'], optional: [], fields: ['status','r2_key','content_sha256','byte_size','content_type'] },
  admin_workspace_storage: { args: ['p_user_id','p_workspace_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  admin_delete_unused_assets: { args: ['p_user_id','p_workspace_id','p_asset_ids','p_elevation_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  personal_record_workspaces: {args:['p_user_id','p_after'],optional:[],shape:'object'},
  personal_record_workspace_access: {args:['p_user_id','p_workspace_id'],optional:[],shape:'object'},
  workspace_details: {args:['p_user_id','p_workspace_id','p_admin','p_admin_email'],optional:[],shape:'object'},
  update_workspace_details: {args:['p_user_id','p_workspace_id','p_expected_revision','p_name','p_admin','p_admin_email'],optional:[],shape:'object'},
  case_workspace_access: {args:['p_user_id','p_case_id','p_admin','p_admin_email'],optional:[],shape:'object'},
  set_case_workspace_access: {args:['p_user_id','p_case_id','p_workspace_id','p_level','p_expected_revision','p_admin','p_admin_email'],optional:[],shape:'object'},
  move_case_workspace: {args:['p_user_id','p_case_id','p_workspace_id','p_expected_revision','p_admin','p_admin_email'],optional:[],shape:'object'},
  get_access: { args: ['p_user_id','p_workspace_id','p_case_id','p_admin','p_admin_email'], optional: [], fields: ['workspace_id','case_id','member_role','grant_level','role','scope','policies'] },
  list_shared_cases: { args: ['p_user_id'], optional: [], fields: ['grant_id','case_id','workspace_id','workspace_name','title','level','member_role','version_id','version_no','withdrawn','has_draft','granted_at'] },
  list_case_access: { args: ['p_user_id','p_case_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  revoke_case_grant: { args: ['p_user_id','p_grant_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  admin_set_workspace_policies: { args: ['p_user_id','p_workspace_id','p_expected_revision','p_policies','p_media_quota_bytes','p_admin','p_admin_email'], optional: [], shape: 'object' },
  create_invitation: { args: ['p_user_id','p_workspace_id','p_case_id','p_level','p_email','p_ref_hash','p_invitee_user_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  list_invitations: { args: ['p_user_id','p_workspace_id','p_after','p_admin','p_admin_email'], optional: [], shape: 'object' },
  resend_invitation: { args: ['p_user_id','p_invitation_id','p_ref_hash','p_admin','p_admin_email'], optional: [], shape: 'object' },
  record_invitation_delivery: { args: ['p_invitation_id','p_outcome','p_retry_after'], optional: [], shape: 'object' },
  revoke_invitation: { args: ['p_user_id','p_invitation_id','p_admin','p_admin_email'], optional: [], shape: 'object' },
  peek_invitation: { args: ['p_ref_hash'], optional: [], fields: ['email','inviter_name','workspace_name','case_title','level'] },
  accept_invitations: { args: ['p_user_id','p_email'], optional: [], shape: 'object' },
  purge_invitation_addresses: { args: [], optional: [], shape: 'number' },
  version_case: { args: ['p_version_id'], optional: [], shape: 'uuid' },
  admin_read_access: { args: ['p_user_ids'], optional: [], shape: 'object' },
});
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
export function fakePostgrest({ versions = [], alerts = [], origin = 'https://postgrest.test', catalogueWorkspace = null } = {}) {
  const requests = [], faults = [], replies = new Map(), claimed = new Set();
  // Card 30: a small model of the group SQL (proved in db/tests/case-groups.test.sql). Authorization is the
  // Worker's here; the model keeps names unique among live groups, CAS revisions, and archive dispositions.
  const groups = { rows: [], cases: new Map() };
  const wsOf = row => row.workspace_id ?? catalogueWorkspace;
  const liveGroup = (ws, id) => groups.rows.find(g => g.id === id && g.workspace_id === ws && !g.archived_at);
  const caseGroup = caseId => {
    const held = groups.cases.get(caseId) ?? { group_id: null, group_revision: 0 };
    const group = groups.rows.find(g => g.id === held.group_id);
    return { group_id: group?.id ?? null, group_name: group?.name ?? null, tint: group?.tint ?? 'neutral', group_revision: held.group_revision };
  };
  const caseIds = ws => [...new Set(versions.filter(v => wsOf(v) === ws).map(v => v.case_id))];
  const nameTaken = (ws, name, except = null) => groups.rows.some(g => g.workspace_id === ws && !g.archived_at && g.id !== except &&
    g.name.toLowerCase() === name.toLowerCase());
  const error = (status, code, message = 'test error') => response({ code, message, details: 'echoed inputs', hint: null }, status);
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== origin) throw new Error('Non-fake host refused');
    const name = url.pathname.split('/').at(-1);
    const contract = Object.hasOwn(FAKE_RPC_CONTRACT,name) ? FAKE_RPC_CONTRACT[name] : null;
    const headers = new Headers(init.headers), args = JSON.parse(init.body);
    requests.push({ url: url.href, name, headers, args, signal: init.signal, redirect: init.redirect });
    if (init.method !== 'POST' || !contract || url.pathname !== `/rest/v1/rpc/${name}`) return error(404, 'PGRST202');
    if (headers.get('content-profile') !== 'case_api' || headers.get('accept-profile') !== 'case_api' || headers.has('authorization')) return error(403, '42501');
    if (Object.keys(args).some(key => !contract.args.includes(key)) || contract.args.some(key => !contract.optional.includes(key) && !(key in args))) return error(404, 'PGRST202');
    if (faults.length) { const f = faults.shift(); return error(f.status, f.code, f.message); }
    // Card 35: an issued elevation is recorded once (case_api.record_admin_elevation).
    if (name === 'record_admin_elevation' && !replies.has(name)) { const fresh = !claimed.has(args.p_jti); claimed.add(args.p_jti); return response(fresh); }
    // A reply may be a function of the arguments (card 35: get_me answers the admin flag it was asked).
    if(name==='purge_abandoned_lobbies'&&!replies.has(name))return response(0);
    if(name==='builder_list_draft_summaries'&&!replies.has(name)){const old=replies.get('builder_list_drafts')??[];const rows=typeof old==='function'?old(args):old;return response(rows.map(row=>({...row,audience:null,duration_min:null,art_structure:null,publication_version:null,publication_at:null,publication_state:'none',review_status:null})));}
    if (replies.has(name)) { const reply = replies.get(name); return response(typeof reply === 'function' ? reply(args) : reply); }
    if (['list_groups', 'create_group', 'edit_group', 'archive_group', 'assign_case_group', 'get_case_group'].includes(name)) {
      const ws = args.p_workspace_id;
      if (name === 'list_groups') return response(groups.rows.filter(g => g.workspace_id === ws && !g.archived_at)
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
        .map(g => ({ id: g.id, name: g.name, description: g.description, tint: g.tint, revision: g.revision,
          case_count: caseIds(ws).filter(id => groups.cases.get(id)?.group_id === g.id).length })));
      if (name === 'create_group') {
        if (nameTaken(ws, args.p_name)) return error(409, '23505');
        const group = { id: uuidv7(), workspace_id: ws, name: args.p_name, description: args.p_description, tint: args.p_tint, revision: 0, archived_at: null };
        groups.rows.push(group); return response([{ id: group.id, revision: 0 }]);
      }
      if (name === 'edit_group') {
        const group = liveGroup(ws, args.p_group_id);
        if (!group) return error(404, 'P0002');
        if (group.revision !== args.p_expected_revision) return error(409, '40001');
        if (nameTaken(ws, args.p_name, group.id)) return error(409, '23505');
        Object.assign(group, { name: args.p_name, description: args.p_description, tint: args.p_tint, revision: group.revision + 1 });
        return response([{ id: group.id, revision: group.revision }]);
      }
      if (name === 'archive_group') {
        const group = liveGroup(ws, args.p_group_id);
        if (!group) return error(404, 'P0002');
        if (group.revision !== args.p_expected_revision) return error(409, '40001');
        if (args.p_confirm_name !== group.name) return error(400, '23514');
        if (args.p_move_to !== null && (args.p_move_to === group.id || !liveGroup(ws, args.p_move_to))) return error(404, 'P0002');
        let moved = 0;
        for (const [id, held] of groups.cases) if (held.group_id === group.id) { groups.cases.set(id, { group_id: args.p_move_to, group_revision: held.group_revision + 1 }); moved++; }
        group.archived_at = new Date().toISOString(); group.revision++;
        return response([{ id: group.id, revision: group.revision, moved }]);
      }
      if (name === 'assign_case_group') {
        if (!caseIds(ws).includes(args.p_case_id)) return error(404, 'P0002');
        if (args.p_group_id !== null && !liveGroup(ws, args.p_group_id)) return error(404, 'P0002');
        const held = caseGroup(args.p_case_id);
        if (held.group_revision !== args.p_expected_revision) return error(409, '40001');
        groups.cases.set(args.p_case_id, { group_id: args.p_group_id, group_revision: held.group_revision + 1 });
        return response([{ case_id: args.p_case_id, group_id: args.p_group_id, group_revision: held.group_revision + 1 }]);
      }
      const version = versions.find(v => v.case_id === args.p_case_id);
      return response(version ? [{ case_id: args.p_case_id, workspace_id: wsOf(version), ...caseGroup(args.p_case_id) }] : []);
    }
    if (name === 'list_published_versions' || name === 'lockdown_alerts_since') {
      const published = name === 'list_published_versions', field = published ? 'version_id' : 'id', time = published ? 'published_at' : 'at';
      let rows = [...(published ? versions : alerts)].sort((a, b) => a[time].localeCompare(b[time]) || a[field].localeCompare(b[field]));
      if (published) rows.reverse(); else rows = rows.filter(row => row.at >= args.p_since);
      if (args.p_after != null) {
        const index = rows.findIndex(row => row[field] === args.p_after);
        if (index < 0) return error(400, '22023');
        rows = rows.slice(index + 1);
      }
      return response(rows.slice(0, Math.max(1, Math.min(args.p_limit ?? 100, 100)))
        .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => contract.fields.includes(key)))));
    }
    // A small model of the catalogue SQL (proved in db/tests/case-catalogue.test.sql) over `versions`.
    if(name==='get_access'){
      const row=versions.find(v=>v.case_id===args.p_case_id);if(!row)return response([]);const role=row.role??groups.detailRole??'owner';
      return response([{case_id:args.p_case_id,workspace_id:wsOf(row),member_role:role,grant_level:null,role:args.p_admin?'admin':role,scope:'workspace',policies:{}}]);
    }
    if(name==='case_workspace_access'){
      const row=versions.find(v=>v.case_id===args.p_case_id);if(!row)return error(404,'P0002');
      return response({caseId:args.p_case_id,homeWorkspaceId:wsOf(row),homeWorkspaceName:'Teaching',revision:0,canManage:args.p_admin||(row.role??groups.detailRole??'owner')==='owner',access:[],destinations:[]});
    }
    if(name==='personal_record_workspaces')return response({workspaces:[],nextAfter:null});
    if(name==='personal_record_workspace_access')return error(403,'42501');
    if(name==='workspace_details')return response({id:args.p_workspace_id,name:'Teaching',revision:0});
    if(name==='resolve_catalogue_case'){const row=versions.filter(v=>v.case_id===args.p_case_id).sort((a,b)=>b.version_no-a.version_no)[0];return response(row?[{workspace_id:row.workspace_id??catalogueWorkspace,role:args.p_admin?'admin':row.role??groups.detailRole??'owner',version_no:row.status==='withdrawn'?null:row.version_no}]:[]);}
    if (name === 'list_case_catalogue_current' || name === 'get_catalogue_case_current' || name === 'get_catalogue_case_history' || name === 'list_case_catalogue' || name === 'list_case_catalogue_audiences' || name === 'get_catalogue_case' || name === 'list_case_catalogue_groups') {
      // One card per case: its latest version (Julian, 2026-10-06).
      const latest = versions.filter(v => !versions.some(o => o.case_id === v.case_id && o.version_no > v.version_no));
      const pub = row => ({ version_id: row.version_id, case_id: row.case_id, title: row.title, summary: row.summary ?? null,
        audience: row.audience ?? null, setting: row.setting ?? null, duration_min: row.duration_min ?? null,
        version_no: row.version_no, published_at: row.published_at, content_sha256: row.content_sha256, art: row.art ?? null });
      if (name === 'get_catalogue_case' || name === 'get_catalogue_case_current' || name === 'get_catalogue_case_history') {
        const row = versions.find(v => v.case_id === args.p_case_id && v.version_no === args.p_version_no);
        const versionsOf = versions.filter(v => v.case_id === args.p_case_id).sort((a, b) => b.version_no - a.version_no)
          .map(v => ({ version_id: v.version_id, version_no: v.version_no, published_at: v.published_at, content_sha256: v.content_sha256, ...(name === 'get_catalogue_case_history' ? { edition: v.edition === true } : {}) }));
        return response(row ? [{ workspace_id: row.workspace_id ?? catalogueWorkspace, role: args.p_admin ? 'admin' : row.role ?? groups.detailRole ?? 'owner', ...pub(row),
          learning_objectives: row.learning_objectives ?? [], versions: versionsOf }] : []);
      }
      if (name === 'list_case_catalogue_groups') {
        const ws = args.p_workspace_id, listed = latest.filter(v => wsOf(v) === ws).map(v => caseGroup(v.case_id).group_id);
        return response([...groups.rows.filter(g => g.workspace_id === ws && !g.archived_at)
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
          .map(g => ({ group_id: g.id, name: g.name, tint: g.tint, case_count: listed.filter(id => id === g.id).length })),
          { group_id: null, name: null, tint: 'neutral', case_count: listed.filter(id => id === null).length }]);
      }
      if (name === 'list_case_catalogue_audiences') {
        const counts = new Map();
        for (const row of latest) if (row.audience) counts.set(row.audience, (counts.get(row.audience) ?? 0) + 1);
        return response([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([audience, n]) => ({ audience, case_count: n })));
      }
      const q = (args.p_query ?? '').toLowerCase();
      const key = { title: r => r.title.toLowerCase(), length: r => r.duration_min ?? null, audience: r => r.audience?.toLowerCase() ?? null,
        published: r => r.published_at, group: r => caseGroup(r.case_id).group_name?.toLowerCase() ?? null }[args.p_sort];
      if (args.p_group_id != null && !liveGroup(args.p_workspace_id, args.p_group_id)) return error(400, '22023');
      const rows = latest.filter(r => (!q || [r.title, r.summary ?? '', r.audience ?? ''].some(t => t.toLowerCase().includes(q))) &&
        (args.p_duration == null || r.duration_min === args.p_duration) && (args.p_audience == null || r.audience === args.p_audience) &&
        (args.p_group_id == null || caseGroup(r.case_id).group_id === args.p_group_id) && (!args.p_ungrouped || caseGroup(r.case_id).group_id === null))
        .sort((a, b) => {
          const x = key(a), y = key(b);
          if (x !== y) { if (x === null) return 1; if (y === null) return -1; return (x < y ? -1 : 1) * (args.p_descending ? -1 : 1); }
          return b.published_at.localeCompare(a.published_at) || b.version_id.localeCompare(a.version_id);
        });
      const limit = Math.max(1, Math.min(args.p_limit ?? 24, 50));
      return response(rows.slice(args.p_offset, args.p_offset + limit).map(row => {
        const { group_id, group_name, tint } = caseGroup(row.case_id);
        return { ...pub(row), group_id, group_name, tint, total_count: rows.length };
      }));
    }
    if (contract.fields) return response([]);
    return response(contract.shape === 'uuid' ? (args.p_session_id ?? uuidv7()) : contract.shape === 'timestamp' ? new Date().toISOString() : contract.shape === 'number' ? 0 : contract.shape === 'boolean' ? false : null);
  };
  return { fetchImpl, requests, faults, replies, groups };
}
