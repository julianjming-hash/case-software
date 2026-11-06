-- Card 35b (CASE-168, CASE-170; docs/PERMISSIONS.md §7.1): the CONTRACT step of the card 35 rollout
-- (docs/RUNBOOK-INCIDENT.md §Card 35 database rollout, step 4).
--
-- APPLY ONLY AFTER BOTH the production and the staging Workers serve a build that contains card 35
-- (20261008000000_permissions_core.sql's callers) and card 30 (the 13-argument list_case_catalogue).
-- Production must be redeployed to main first. A Worker older than that calls the signatures dropped here and
-- fails (publishing, invites, account actions, version state, room start and the catalogue). Rolling either
-- Worker back past this migration is unsafe; fix forward instead.
--
--   1. The old admin-only bodies move into case_app under the same names (no SECURITY DEFINER, no grant),
--      callable only from the case_api wrappers that check the admin flag, actor, elevation and audit.
--   2. The wrappers are recreated (same signatures, so their grants stay) to call case_app.
--   3. The expand-window overloads and the retired functions are dropped:
--        admin_provision_facilitator(uuid,uuid), admin_set_version_state(uuid,bigint,text),
--        admin_transition_profile(uuid,bigint,text), admin_revert_profile(uuid,bigint,timestamptz x3),
--        bootstrap_workspace(uuid,text,text), the 11-argument list_case_catalogue (card 30's expand window),
--        publish_draft(uuid,bigint,uuid,uuid[]), get_case_version(uuid,uuid) and the obsolete
--        create_session(uuid,uuid,uuid,text,interval).
-- Functions only: no table, row or column changes, so no data is lost. DROP ... IF EXISTS keeps a re-run harmless.
-- case_app.assert_member stays (no caller remains; card 35 kept it as the documented wrapper).
-- No GRANT to anon or authenticated (AGENTS.md rule 5).
begin;

-- ─── 1. the old admin-only bodies, folded into case_app (bodies unchanged) ─────────────────────────
create or replace function case_app.admin_provision_facilitator(p_user_id uuid, p_workspace_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if p_user_id is null or p_workspace_id is null or
     p_workspace_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     not exists (select 1 from auth.users u where u.id = p_user_id) or
     not exists (select 1 from case_app.workspaces w where w.id = p_workspace_id) then
    raise exception 'invalid_teaching_workspace_or_user' using errcode = '22023';
  end if;
  if exists (select 1 from case_app.profiles p where p.id = p_user_id and
      (p.disabled_at is not null or p.soft_deleted_at is not null)) then
    raise exception 'account_not_active' using errcode = '42501';
  end if;
  insert into case_app.profiles (id, display_name) values (p_user_id, 'Facilitator')
    on conflict (id) do nothing;
  insert into case_app.workspace_members (workspace_id, user_id, role)
    values (p_workspace_id, p_user_id, 'facilitator')
    on conflict (workspace_id, user_id) do nothing;
end;
$$;

create or replace function case_app.admin_set_version_state(p_version_id uuid, p_expected_revision bigint, p_action text)
returns table (version_id uuid, status text, admin_revision bigint) language plpgsql set search_path = '' as $$
declare current_state case_app.admin_version_state%rowtype;
begin
  if p_version_id is null or p_expected_revision is null or p_expected_revision < 0 or
     p_action is null or p_action not in ('withdraw','publish') then
    raise exception 'invalid_version_transition' using errcode = '22023'; end if;
  if not exists (select 1 from case_app.case_versions v where v.id = p_version_id) then
    raise exception 'missing_version' using errcode = '22023'; end if;
  insert into case_app.admin_version_state (case_version_id, status)
    values (p_version_id, 'published') on conflict (case_version_id) do nothing;
  select * into current_state from case_app.admin_version_state
    where case_version_id = p_version_id for update;
  if current_state.admin_revision <> p_expected_revision then
    raise exception 'stale_admin_version' using errcode = '40001'; end if;
  if (p_action = 'withdraw' and current_state.status <> 'published') or
     (p_action = 'publish' and current_state.status <> 'withdrawn') then
    raise exception 'invalid_version_state' using errcode = '23514'; end if;
  update case_app.admin_version_state s
     set status = case when p_action = 'withdraw' then 'withdrawn' else 'published' end,
         admin_revision = s.admin_revision + 1, changed_at = now()
   where s.case_version_id = p_version_id;
  return query select s.case_version_id, s.status, s.admin_revision
    from case_app.admin_version_state s where s.case_version_id = p_version_id;
end;
$$;

create or replace function case_app.admin_transition_profile(p_user_id uuid, p_expected_revision bigint, p_action text)
returns table (user_id uuid, disabled_at timestamp with time zone, soft_deleted_at timestamp with time zone, delete_due_at timestamp with time zone, admin_revision bigint) language plpgsql set search_path = '' as $$
declare p case_app.profiles%rowtype;
begin
  if p_user_id is null or p_expected_revision is null or p_expected_revision < 0 or
     p_action is null or p_action not in ('disable', 'enable', 'soft_delete', 'restore') then
    raise exception 'invalid_admin_transition' using errcode = '22023';
  end if;
  select * into p from case_app.profiles where id = p_user_id for update;
  if not found then raise exception 'missing_profile' using errcode = '22023'; end if;
  if p.admin_delete_claim_id is not null then
    raise exception 'profile_deletion_claimed' using errcode='23514'; end if;
  if p.admin_revision <> p_expected_revision then
    raise exception 'stale_admin_revision' using errcode = '40001';
  end if;
  if p_action = 'disable' then
    if p.disabled_at is not null or p.soft_deleted_at is not null then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = now(), admin_revision = t.admin_revision + 1
      where t.id = p_user_id;
  elsif p_action = 'enable' then
    if p.disabled_at is null or p.soft_deleted_at is not null then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = null, admin_revision = t.admin_revision + 1
      where t.id = p_user_id;
  elsif p_action = 'soft_delete' then
    if p.soft_deleted_at is not null then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = coalesce(t.disabled_at, now()),
      soft_deleted_at = now(), delete_due_at = now() + interval '30 days',
      admin_revision = t.admin_revision + 1 where t.id = p_user_id;
  else
    if p.soft_deleted_at is null or p.delete_due_at <= clock_timestamp() then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = null, soft_deleted_at = null,
      delete_due_at = null, admin_revision = t.admin_revision + 1 where t.id = p_user_id;
  end if;
  return query select t.id, t.disabled_at, t.soft_deleted_at, t.delete_due_at,
    t.admin_revision from case_app.profiles t where t.id = p_user_id;
end;
$$;

create or replace function case_app.admin_revert_profile(p_user_id uuid, p_expected_revision bigint, p_disabled_at timestamp with time zone, p_soft_deleted_at timestamp with time zone, p_delete_due_at timestamp with time zone)
returns table (user_id uuid, disabled_at timestamp with time zone, soft_deleted_at timestamp with time zone, delete_due_at timestamp with time zone, admin_revision bigint) language plpgsql set search_path = '' as $$
declare current_profile case_app.profiles%rowtype;
begin
  if p_user_id is null or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9999999998 or
     (p_soft_deleted_at is null and p_delete_due_at is not null) or
     (p_soft_deleted_at is not null and (p_disabled_at is null or p_delete_due_at is null or
       p_delete_due_at<>p_soft_deleted_at+interval '30 days')) then
    raise exception 'invalid_profile_compensation' using errcode='22023'; end if;
  select * into current_profile from case_app.profiles where id=p_user_id for update;
  if not found then raise exception 'missing_profile' using errcode='22023'; end if;
  if current_profile.admin_delete_claim_id is not null then
    raise exception 'profile_deletion_claimed' using errcode='23514'; end if;
  if current_profile.admin_revision<>p_expected_revision then
    raise exception 'stale_admin_revision' using errcode='40001'; end if;
  update case_app.profiles p set disabled_at=p_disabled_at,soft_deleted_at=p_soft_deleted_at,
    delete_due_at=p_delete_due_at,admin_revision=p.admin_revision+1 where p.id=p_user_id;
  return query select p.id,p.disabled_at,p.soft_deleted_at,p.delete_due_at,p.admin_revision
    from case_app.profiles p where p.id=p_user_id;
end;
$$;

revoke all on function
  case_app.admin_provision_facilitator(uuid, uuid),
  case_app.admin_set_version_state(uuid, bigint, text),
  case_app.admin_transition_profile(uuid, bigint, text),
  case_app.admin_revert_profile(uuid, bigint, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

-- ─── 2. the admin wrappers call case_app (same signatures; grants unchanged) ─────────────────────────
create or replace function case_api.admin_provision_facilitator(
  p_user_id uuid, p_workspace_id uuid, p_actor_user_id uuid, p_admin boolean, p_admin_email text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_actor_user_id, p_workspace_id, 'P-03', p_admin, p_admin_email);
  perform case_app.admin_provision_facilitator(p_user_id, p_workspace_id);
  perform case_app.audit_admin(p_workspace_id, p_actor_user_id, p_admin_email, 'member_invite', 'member', p_user_id);
end;
$$;

create or replace function case_api.admin_set_version_state(
  p_version_id uuid, p_expected_revision bigint, p_action text,
  p_user_id uuid, p_admin boolean, p_admin_email text, p_elevation_id uuid
) returns table (version_id uuid, status text, admin_revision bigint)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; r record;
begin
  select c.workspace_id into v_ws
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id where v.id = p_version_id;
  if v_ws is null then raise exception 'missing_version' using errcode = '22023'; end if;
  if not coalesce(case_app.check_admin_flag(p_admin, p_admin_email), false) then
    raise exception 'not_authorised: version state is admin only here' using errcode = '42501'; end if;
  perform case_app.authorize(p_user_id, v_ws, 'P-16', p_admin, p_admin_email);
  perform case_app.assert_elevation(p_elevation_id, p_admin_email, 'admin');
  select * into r from case_app.admin_set_version_state(p_version_id, p_expected_revision, p_action);
  perform case_app.audit_admin(v_ws, p_user_id, p_admin_email,
    case when p_action = 'withdraw' then 'version_withdraw' else 'version_republish' end,
    'version', p_version_id, r.admin_revision, p_elevation_id);
  return query select r.version_id, r.status, r.admin_revision;
end;
$$;

create or replace function case_api.admin_transition_profile(
  p_user_id uuid, p_expected_revision bigint, p_action text, p_admin boolean, p_admin_email text
) returns table (
  user_id uuid, disabled_at timestamptz, soft_deleted_at timestamptz,
  delete_due_at timestamptz, admin_revision bigint
) language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(case_app.check_admin_flag(p_admin, p_admin_email), false) then
    raise exception 'not_authorised: account lifecycle is admin only' using errcode = '42501'; end if;
  return query select * from case_app.admin_transition_profile(p_user_id, p_expected_revision, p_action);
end;
$$;

create or replace function case_api.admin_revert_profile(
  p_user_id uuid, p_expected_revision bigint, p_disabled_at timestamptz,
  p_soft_deleted_at timestamptz, p_delete_due_at timestamptz, p_admin boolean, p_admin_email text
) returns table (user_id uuid, disabled_at timestamptz, soft_deleted_at timestamptz,
  delete_due_at timestamptz, admin_revision bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(case_app.check_admin_flag(p_admin, p_admin_email), false) then
    raise exception 'not_authorised: account lifecycle is admin only' using errcode = '42501'; end if;
  return query select * from case_app.admin_revert_profile(p_user_id, p_expected_revision, p_disabled_at,
    p_soft_deleted_at, p_delete_due_at);
end;
$$;

-- ─── 3. drop the expand-window overloads and the retired functions ─────────────────────────────────
drop function if exists case_api.admin_provision_facilitator(uuid, uuid);
drop function if exists case_api.admin_set_version_state(uuid, bigint, text);
drop function if exists case_api.admin_transition_profile(uuid, bigint, text);
drop function if exists case_api.admin_revert_profile(uuid, bigint, timestamptz, timestamptz, timestamptz);
drop function if exists case_api.bootstrap_workspace(uuid, text, text);
drop function if exists case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer, boolean, text);
drop function if exists case_api.publish_draft(uuid, bigint, uuid, uuid[]);
drop function if exists case_api.get_case_version(uuid, uuid);
drop function if exists case_api.create_session(uuid, uuid, uuid, text, interval);

commit;
