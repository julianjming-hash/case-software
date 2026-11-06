-- Entitled context for direct Builder routes and recovery of never-saved case shells.
begin;
drop function case_api.get_case_authoring_access(uuid,uuid,boolean,text);
create function case_api.get_case_authoring_access(
  p_case_id uuid,p_user_id uuid,p_admin boolean default false,p_admin_email text default null
) returns table(case_id uuid,workspace_id uuid,role text,title text,source_version_id uuid,source_version_no integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text;
begin
  if v_ws is null then return; end if;
  begin
    v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query select c.id,c.workspace_id,v_role,c.title,v.id,v.version_no
    from case_app.cases c left join lateral (
      select cv.id,cv.version_no from case_app.case_versions cv
      where cv.case_id=c.id and not exists(select 1 from case_app.admin_version_state av where av.case_version_id=cv.id and av.status='withdrawn') order by cv.version_no desc limit 1
    ) v on true where c.id=p_case_id and c.archived_at is null;
end; $$;
revoke all on function case_api.get_case_authoring_access(uuid,uuid,boolean,text) from public,anon,authenticated,service_role;
grant execute on function case_api.get_case_authoring_access(uuid,uuid,boolean,text) to service_role;
commit;
