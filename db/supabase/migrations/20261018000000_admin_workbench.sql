-- Private workspace workbench and serialized, audited membership controls. Additive only.
begin;
alter table case_app.workspaces add column membership_revision bigint not null default 0 check(membership_revision>=0);
create function case_app.advance_membership_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update case_app.workspaces set membership_revision=membership_revision+1 where id=coalesce(new.workspace_id,old.workspace_id);
 return null;
end; $$;
create trigger workspace_members_revision after insert or update or delete on case_app.workspace_members
 for each row execute function case_app.advance_membership_revision();
create table case_app.membership_audit (
 audit_id uuid primary key, -- immutable audit id, installed with its envelope in one transaction
 before_role text check(before_role in ('owner','author','facilitator')),
 after_role text check(after_role in ('owner','author','facilitator')),
 transfer_from uuid
);
revoke all on case_app.membership_audit from public,anon,authenticated,service_role;
create trigger membership_audit_no_truncate before truncate on case_app.membership_audit for each statement execute function case_app.forbid_change();
create trigger membership_audit_immutable before update or delete on case_app.membership_audit for each row execute function case_app.forbid_change();
alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check(action in (
 'workspace_create','case_create','draft_save','version_publish','version_withdraw','version_republish','room_start','workspace_ownerless',
 'member_invite','owner_assign','group_create','group_edit','group_archive','case_group',
 'draft_checkpoint_create','draft_checkpoint_delete','draft_checkpoint_restore','builder_candidate_submit','builder_candidate_cancel','builder_candidate_approve','builder_candidate_delete',
 'member_role','member_remove','owner_transfer'));

create function case_api.admin_list_workspaces(p_user_id uuid,p_after uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare v_rows jsonb;
begin
 perform case_app.authorize_admin(p_user_id,'P-03',p_admin,p_admin_email);
 if p_after is not null and not exists(select 1 from case_app.workspaces where id=p_after) then raise exception 'invalid_cursor' using errcode='22023'; end if;
 select coalesce(jsonb_agg(to_jsonb(w) order by w.id),'[]') into v_rows from (
  select id,name,membership_revision from case_app.workspaces where p_after is null or id>p_after order by id limit 50
 ) w;
 return jsonb_build_object('workspaces',v_rows,'nextAfter',case when jsonb_array_length(v_rows)=50 then v_rows->49->>'id' else null end);
end; $$;

create function case_api.admin_workspace_query(p_user_id uuid,p_workspace_id uuid,p_tab text,p_query text,p_status text,p_from timestamptz,p_until timestamptz,p_after uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare v_rows jsonb; v_revision bigint; v_name text;
begin
 perform case_app.authorize(p_user_id,p_workspace_id,'P-03',p_admin,p_admin_email);
 if p_tab not in ('members','cases','rooms','audit') or p_tab is null or p_query is null or length(p_query)>200 or p_query~'[[:cntrl:]]'
  or p_status is null or p_status not in ('all','lobby','live','ended','expired','published','withdrawn')
  or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until)) or p_from>p_until then
  raise exception 'invalid_query' using errcode='22023'; end if;
 select name,membership_revision into v_name,v_revision from case_app.workspaces where id=p_workspace_id;
 if p_tab='members' then
  if p_after is not null and not exists(select 1 from case_app.workspace_members where workspace_id=p_workspace_id and user_id=p_after) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into v_rows from (
   select m.user_id id,u.email,m.role,m.created_at,case when p.soft_deleted_at is not null then 'deleted' when p.disabled_at is not null then 'disabled' else 'active' end account_state
   from case_app.workspace_members m join auth.users u on u.id=m.user_id join case_app.profiles p on p.id=m.user_id
   where m.workspace_id=p_workspace_id and (p_after is null or m.user_id<p_after)
    and position(lower(p_query) in lower(coalesce(u.email,'')))>0 order by m.user_id desc limit 20
  ) r;
 elsif p_tab='cases' then
  if p_after is not null and not exists(select 1 from case_app.case_versions v join case_app.cases c on c.id=v.case_id where v.id=p_after and c.workspace_id=p_workspace_id) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into v_rows from (
   select v.id,c.id case_id,v.version_no,coalesce(v.document->>'title',c.title) title,coalesce(av.status,'published') status,coalesce(av.admin_revision,0) admin_revision,
    c.group_id,g.name group_name,coalesce(g.tint,'neutral') tint,c.group_revision
   from case_app.case_versions v join case_app.cases c on c.id=v.case_id left join case_app.case_groups g on g.id=c.group_id and g.archived_at is null left join case_app.admin_version_state av on av.case_version_id=v.id
   where c.workspace_id=p_workspace_id and (p_after is null or v.id<p_after)
    and (p_status='all' or coalesce(av.status,'published')=p_status) and position(lower(p_query) in lower(coalesce(v.document->>'title',c.title)))>0
    and (p_from is null or v.published_at>=p_from) and (p_until is null or v.published_at<p_until)
   order by v.id desc limit 20
  ) r;
 elsif p_tab='rooms' then
  if p_after is not null and not exists(select 1 from case_app.sessions where id=p_after and workspace_id=p_workspace_id) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into v_rows from (
   select s.id,s.case_version_id,coalesce(v.document->>'title',c.title) title,v.version_no,s.status,s.created_at,s.started_at,s.ended_at,s.expires_at,s.facilitator_id=p_user_id own
   from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id join case_app.cases c on c.id=v.case_id
   where s.workspace_id=p_workspace_id and (p_after is null or s.id<p_after) and (p_status='all' or s.status=p_status)
    and position(lower(p_query) in lower(coalesce(v.document->>'title',c.title)))>0
    and (p_from is null or s.created_at>=p_from) and (p_until is null or s.created_at<p_until)
   order by s.id desc limit 20
  ) r;
 else
  if p_after is not null and not exists(select 1 from case_app.workspace_audit where id=p_after and workspace_id=p_workspace_id) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into v_rows from (
   select a.id,a.action,a.actor_kind,a.actor_email,a.target_type,a.target_id,a.revision,a.at,case when ma.audit_id is null then '{}'::jsonb else jsonb_build_object('role',ma.before_role,'transferFrom',ma.transfer_from) end before_state,case when ma.audit_id is null then '{}'::jsonb else jsonb_build_object('role',ma.after_role) end after_state
   from case_app.workspace_audit a left join case_app.membership_audit ma on ma.audit_id=a.id where a.workspace_id=p_workspace_id and (p_after is null or a.id<p_after)
    and position(lower(p_query) in lower(a.action||' '||coalesce(a.actor_email,'')||' '||a.target_id::text))>0
    and (p_from is null or a.at>=p_from) and (p_until is null or a.at<p_until)
   order by a.id desc limit 20
  ) r;
 end if;
 return jsonb_build_object('workspace',jsonb_build_object('id',p_workspace_id,'name',v_name,'membership_revision',v_revision),
  'rows',v_rows,'nextAfter',case when jsonb_array_length(v_rows)=20 then v_rows->19->>'id' else null end);
end; $$;

create function case_api.admin_change_membership(p_actor_user_id uuid,p_workspace_id uuid,p_email text,p_role text,p_transfer_from uuid,p_expected_revision bigint,p_confirm_email text,p_elevation_id uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='2s' as $$
declare v_user uuid; v_role text; v_revision bigint; v_action text; v_audit_id uuid;
begin
 perform case_app.authorize(p_actor_user_id,p_workspace_id,case when p_role is null then 'P-05' else 'P-04' end,p_admin,p_admin_email);
 perform case_app.assert_elevation(p_elevation_id,p_admin_email,'admin');
 if p_email is null or length(p_email)>320 or p_email<>lower(btrim(p_email)) or p_email<>p_confirm_email or p_confirm_email is null
  or p_expected_revision is null or p_expected_revision<0 or (p_role is not null and p_role not in ('owner','author','facilitator'))
  or (p_transfer_from is not null and p_role is distinct from 'owner') then raise exception 'invalid_membership' using errcode='22023'; end if;
 select membership_revision into v_revision from case_app.workspaces where id=p_workspace_id for update;
 if v_revision is distinct from p_expected_revision then raise exception 'membership_conflict' using errcode='40001'; end if;
 select u.id into v_user from auth.users u where lower(u.email)=p_email;
 if v_user is null or not case_api.admin_account_active(v_user) then raise exception 'account_not_active' using errcode='P0002'; end if;
 select role into v_role from case_app.workspace_members where workspace_id=p_workspace_id and user_id=v_user;
 if v_role is null and p_role is not null then perform case_app.authorize(p_actor_user_id,p_workspace_id,'P-03',p_admin,p_admin_email); end if;
 if p_transfer_from is not null and (p_transfer_from=v_user or not exists(select 1 from case_app.workspace_members where workspace_id=p_workspace_id and user_id=p_transfer_from and role='owner')) then raise exception 'invalid_owner' using errcode='22023'; end if;
 if v_role is not distinct from p_role and p_transfer_from is null then return jsonb_build_object('membership_revision',v_revision,'changed',false); end if;
 if p_role is null then
  delete from case_app.workspace_members where workspace_id=p_workspace_id and user_id=v_user;
 else
  insert into case_app.profiles(id) values(v_user) on conflict(id) do nothing;
  insert into case_app.workspace_members(workspace_id,user_id,role) values(p_workspace_id,v_user,p_role)
   on conflict(workspace_id,user_id) do update set role=excluded.role;
 end if;
 if p_transfer_from is not null then update case_app.workspace_members set role='author' where workspace_id=p_workspace_id and user_id=p_transfer_from; end if;
 select membership_revision into v_revision from case_app.workspaces where id=p_workspace_id;
 v_action:=case when p_transfer_from is not null then 'owner_transfer' when p_role is null then 'member_remove' when v_role is null then 'member_invite' else 'member_role' end;
 insert into case_app.workspace_audit(workspace_id,actor_kind,actor_user_id,actor_email,action,target_type,target_id,revision,elevation_id)
 values(p_workspace_id,'admin',p_actor_user_id,p_admin_email,v_action,'member',v_user,v_revision,p_elevation_id) returning id into v_audit_id;
 insert into case_app.membership_audit(audit_id,before_role,after_role,transfer_from) values(v_audit_id,v_role,p_role,p_transfer_from);
 return jsonb_build_object('membership_revision',v_revision,'changed',true);
end; $$;

create function case_api.admin_query_operations(p_user_id uuid,p_query text,p_after uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare v_rows jsonb;
begin
 perform case_app.authorize_admin(p_user_id,'P-07',p_admin,p_admin_email);
 if p_query is null or length(p_query)>200 or p_query~'[[:cntrl:]]' then raise exception 'invalid_query' using errcode='22023'; end if;
 if p_after is not null and not exists(select 1 from case_app.admin_audit_log where id=p_after and phase in ('intent','attempt')) then raise exception 'invalid_cursor' using errcode='22023'; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into v_rows from (
  select a.id,a.action,a.actor_email,a.target_type,a.target_id,a.at,a.before,
   case when a.phase='attempt' then a.after else o.after end after,
   case when a.phase='attempt' then 'attempt' when o.id is null then 'unresolved' else 'outcome' end phase,
   o.id outcome_id,o.at outcome_at
  from case_app.admin_audit_log a left join lateral (select b.id,b.at,b.after from case_app.admin_audit_log b where b.intent_id=a.id and b.phase='outcome' order by b.at desc,b.id desc limit 1) o on true
  where a.phase in ('intent','attempt') and (p_after is null or a.id<p_after)
   and position(lower(p_query) in lower(a.action||' '||a.actor_email||' '||coalesce(a.target_id::text,'')))>0
  order by a.id desc limit 20
 ) r;
 return jsonb_build_object('rows',v_rows,'nextAfter',case when jsonb_array_length(v_rows)=20 then v_rows->19->>'id' else null end);
end; $$;
revoke all on function case_app.advance_membership_revision() from public,anon,authenticated,service_role;
revoke all on function case_api.admin_list_workspaces(uuid,uuid,boolean,text),case_api.admin_workspace_query(uuid,uuid,text,text,text,timestamptz,timestamptz,uuid,boolean,text),case_api.admin_change_membership(uuid,uuid,text,text,uuid,bigint,text,uuid,boolean,text),case_api.admin_query_operations(uuid,text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function case_api.admin_list_workspaces(uuid,uuid,boolean,text),case_api.admin_workspace_query(uuid,uuid,text,text,text,timestamptz,timestamptz,uuid,boolean,text),case_api.admin_change_membership(uuid,uuid,text,text,uuid,bigint,text,uuid,boolean,text),case_api.admin_query_operations(uuid,text,uuid,boolean,text) to service_role;
commit;
