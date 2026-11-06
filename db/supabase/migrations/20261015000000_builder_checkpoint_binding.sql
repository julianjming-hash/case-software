-- Bind named checkpoints to the acknowledged revision shown by the served Builder.
begin;
create function case_api.builder_create_checkpoint(p_case_id uuid,p_name text,p_expected_revision bigint,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(id uuid,name text,revision bigint,created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; v_revision bigint;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select d.revision into v_revision from case_app.case_drafts d where d.case_id=p_case_id;
  if p_expected_revision is null or p_expected_revision<1 or v_revision is distinct from p_expected_revision then
    raise exception 'revision_conflict' using errcode='40001';
  end if;
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  return query select * from case_api.builder_create_checkpoint(p_case_id,p_name,p_user_id,p_admin,p_admin_email);
end; $$;
revoke all on function case_api.builder_create_checkpoint(uuid,text,bigint,uuid,boolean,text) from public,anon,authenticated;
grant execute on function case_api.builder_create_checkpoint(uuid,text,bigint,uuid,boolean,text) to service_role;
revoke execute on function case_api.builder_create_checkpoint(uuid,text,uuid,boolean,text) from service_role;
commit;
