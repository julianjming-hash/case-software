-- Builder save-window caps count open windows only (CASE-239). builder_save_draft and builder_restore_checkpoint
-- mark a consumed window used and write its receipt in the same transaction, so a used window is already
-- bounded by the receipt caps below; counting it again blocked a ninth save per author per case per day.
-- Open, unused windows keep the 8 per actor, 32 per case and 100000 per workspace caps. Body unchanged otherwise.
begin;

create or replace function case_api.builder_open_save_window(p_case_id uuid,p_base_revision bigint,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(operation_id uuid,base_revision bigint,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_id uuid; v_exp timestamptz; v_created timestamptz;
begin
  perform case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  delete from case_app.builder_save_windows w where w.case_id=p_case_id and w.expires_at<=clock_timestamp();
  delete from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at<=clock_timestamp();
  perform 1 from case_app.case_drafts where case_id=p_case_id for update;
  if p_base_revision<0 or p_base_revision>9007199254740991 then raise exception 'invalid_base_revision' using errcode='22023'; end if;
  if not exists(select 1 from case_app.case_drafts d where d.case_id=p_case_id and d.revision=p_base_revision) then
    if not (p_base_revision=0 and not exists(select 1 from case_app.case_drafts where case_id=p_case_id)) then raise exception 'revision_conflict' using errcode='40001'; end if;
  end if;
  if (select count(*) from case_app.builder_save_windows w where w.case_id=p_case_id and w.actor_id=p_user_id and w.used_at is null and w.expires_at>clock_timestamp())>=8 or
     (select count(*) from case_app.builder_save_windows w where w.case_id=p_case_id and w.used_at is null and w.expires_at>clock_timestamp())>=32 or
     (select count(*) from case_app.builder_save_windows w join case_app.cases c on c.id=w.case_id where c.workspace_id=v_ws and w.used_at is null and w.expires_at>clock_timestamp())>=100000 or
     (select count(*) from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at>clock_timestamp())>=10000 or
     (select count(*) from case_app.builder_save_receipts r join case_app.cases c on c.id=r.case_id where c.workspace_id=v_ws and r.expires_at>clock_timestamp())>=100000 then
    raise exception 'builder_quota' using errcode='23514';
  end if;
  perform case_app.builder_assert_quota(v_ws,128);
  v_created := clock_timestamp();
  insert into case_app.builder_save_windows(case_id,actor_id,base_revision,created_at,expires_at) values(p_case_id,p_user_id,p_base_revision,v_created,v_created+interval '24 hours') returning builder_save_windows.operation_id,builder_save_windows.expires_at into v_id,v_exp;
  return query select v_id,p_base_revision,v_exp;
end; $$;

revoke all on function case_api.builder_open_save_window(uuid,bigint,uuid,boolean,text) from public,anon,authenticated,service_role;
grant execute on function case_api.builder_open_save_window(uuid,bigint,uuid,boolean,text) to service_role;
commit;
