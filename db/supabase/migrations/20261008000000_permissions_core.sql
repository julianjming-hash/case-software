-- Card 35 (CASE-168, CASE-170): one authorization core for every workspace RPC (docs/PERMISSIONS.md).
--
--   case_app.authorize(user, workspace, action, admin, admin_email)  the only authorization predicate.
--     Roles per action come from the generated role table below (scripts/gen-permissions.mjs, from
--     src/shared/permissions.mjs, which tests/permissions-matrix.test.mjs checks against PERMISSIONS §4).
--     It refuses inactive accounts, an admin flag without a valid admin email (and an email without the
--     flag), and every principal the matrix does not name. It returns the effective role, 'admin' on the
--     admin path. assert_member stays as a wrapper for the retired functions that still call it.
--   case_app.workspace_audit  append-only, fixed scalars; every write an admin performs inside a
--     workspace inserts its row in the same transaction (invariants 4, 12, 14).
--   bootstrap_workspace, admin_provision_facilitator and admin_set_version_state refuse without the
--     admin flag and an admin email (invariant 5, CASE-076): the Worker gate is no longer the only check.
--   A workspace_members trigger refuses any update or delete that leaves a workspace with no owner
--     (`last_owner`, 23514), except the cascade from a profile's hard deletion, which is audited as
--     `workspace_ownerless` and raises the lockdown alert path (invariant 7).
--   publish refuses an asset outside the case's workspace (invariant 6).
--
-- Expand/contract (deploy order in docs/RUNBOOK-INCIDENT.md §Card 35 database rollout). This is the EXPAND
-- step: the Workers running when it applies (production 2e8037f, staging 5435a5a) must keep working.
--   * Member RPCs are dropped and recreated with the admin arguments appended, defaulting to false and null:
--     an old Worker's named-argument call resolves to the new function with non-admin semantics.
--   * Admin-only RPCs keep their OLD signature, unchanged, beside a new signature that checks the admin flag
--     (and actor, elevation and audit) and then calls the old one. Only the old Worker's admin routes call
--     the old signatures, after its own ADMIN_EMAILS gate and step-up, so their old behaviour is kept.
--   * The one exception is the old bootstrap_workspace(uuid, text, text): the old Worker calls it for ANY
--     signed-in user (the live open-creation gap), so it now refuses (42501) instead of creating.
-- A later CONTRACT migration, after both Workers run this branch, folds the old bodies into case_app, drops
-- the old signatures and the retired publish_draft, get_case_version and 5-argument create_session.
-- Execute goes to service_role by exact signature; no GRANT to anon or authenticated (AGENTS.md rule 5).
begin;

-- ─── the generated role table ─────────────────────────────────────────────────────────────────────
-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)
create function case_app.action_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then array[]::text[]
    when 'P-02' then array[]::text[]
    when 'P-03' then array[]::text[]
    when 'P-04' then array[]::text[]
    when 'P-05' then array[]::text[]
    when 'P-10' then array['owner', 'author', 'facilitator']
    when 'P-11' then array['owner', 'author', 'facilitator']
    when 'P-12' then array['owner', 'author', 'facilitator']
    when 'P-13' then array['owner', 'author']
    when 'P-14' then array['owner', 'author']
    when 'P-15' then array['owner', 'author']
    when 'P-16' then array['owner']
    when 'P-17' then array['owner']
    when 'P-18' then array['owner']
    when 'P-19' then array['owner']
    when 'P-20' then array['owner']
    when 'P-21' then array['owner', 'author', 'facilitator']
    when 'P-22' then array[]::text[]
  end;
$$;
create function case_app.action_admin(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then true
    when 'P-02' then true
    when 'P-03' then true
    when 'P-04' then true
    when 'P-05' then true
    when 'P-10' then true
    when 'P-11' then true
    when 'P-12' then true
    when 'P-13' then true
    when 'P-14' then true
    when 'P-15' then true
    when 'P-16' then true
    when 'P-17' then true
    when 'P-18' then true
    when 'P-19' then true
    when 'P-20' then true
    when 'P-21' then true
    when 'P-22' then true
  end;
$$;
-- END GENERATED permission roles

-- ─── the core ─────────────────────────────────────────────────────────────────────────────────────

-- The admin flag is set only by the Worker after it verified the JWT email against ADMIN_EMAILS. The
-- database cannot see that list; it refuses a flag without an admin email and an email without the flag,
-- so a Worker bug that forgets either half fails here instead of acting with the wrong authority.
create function case_app.check_admin_flag(p_admin boolean, p_admin_email text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_admin is null or (p_admin and (p_admin_email is null or length(p_admin_email) > 320 or
     p_admin_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$')) or
     (not p_admin and p_admin_email is not null) then
    raise exception 'not_authorised: inconsistent admin flag' using errcode = '42501';
  end if;
  return p_admin;
end;
$$;

-- The only reader of a person's role for authorization. get_me, bootstrap and provisioning are the
-- membership RPCs; the last-owner trigger guards membership writes. Nothing else joins workspace_members.
create function case_app.member_role(p_user_id uuid, p_workspace_id uuid)
returns text language sql stable set search_path = '' as $$
  select m.role from case_app.workspace_members m
   where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
$$;

create function case_app.authorize(
  p_user_id uuid, p_workspace_id uuid, p_action text, p_admin boolean, p_admin_email text
) returns text language plpgsql stable set search_path = '' as $$
declare v_roles text[] := case_app.action_roles(p_action); v_role text;
begin
  if v_roles is null then raise exception 'unknown_action' using errcode = '22023'; end if;
  if p_user_id is null or p_workspace_id is null then
    raise exception 'not_authorised: no caller or workspace' using errcode = '42501'; end if;
  if case_app.check_admin_flag(p_admin, p_admin_email) then
    if not case_app.action_admin(p_action) then
      raise exception 'not_authorised: admin may not %', p_action using errcode = '42501'; end if;
  end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  if not exists (select 1 from case_app.workspaces w where w.id = p_workspace_id) then
    raise exception 'not_authorised: no such workspace' using errcode = '42501'; end if;
  if p_admin then return 'admin'; end if;
  v_role := case_app.member_role(p_user_id, p_workspace_id);
  if v_role is null or not (v_role = any (v_roles)) then
    raise exception 'not_authorised: % in workspace %', p_action, p_workspace_id using errcode = '42501'; end if;
  return v_role;
end;
$$;

-- Admin-only actions with no workspace yet (P-01) or a deployment scope.
create function case_app.authorize_admin(p_user_id uuid, p_action text, p_admin boolean, p_admin_email text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if case_app.action_roles(p_action) is null then raise exception 'unknown_action' using errcode = '22023'; end if;
  if p_user_id is null or not case_app.check_admin_flag(p_admin, p_admin_email) or not case_app.action_admin(p_action) then
    raise exception 'not_authorised: % is admin only', p_action using errcode = '42501'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
end;
$$;

-- Kept for the retired functions that still call it (publish_draft, get_case_version, the obsolete
-- create_session overload); none is executable by service_role. Member-only, via the one reader.
create or replace function case_app.assert_member(p_user_id uuid, p_workspace_id uuid, p_roles text[])
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_user_id is null or not coalesce(case_app.member_role(p_user_id, p_workspace_id) = any (p_roles), false) then
    raise exception 'not_authorised: user % lacks % in workspace %', p_user_id, p_roles, p_workspace_id
      using errcode = '42501';
  end if;
end;
$$;

-- An admin acting without membership still needs a profile row for authorship foreign keys. Admins are not
-- marked (Julian, 2026-10-07, R-b): a profile-less admin gets the same neutral name an invited facilitator
-- gets, 'Facilitator'; the workspace audit is the record of who acted as admin.
create function case_app.ensure_admin_profile(p_user_id uuid)
returns void language sql set search_path = '' as $$
  insert into case_app.profiles (id, display_name) values (p_user_id, 'Facilitator') on conflict (id) do nothing;
$$;

-- ─── workspace audit ──────────────────────────────────────────────────────────────────────────────
create table case_app.workspace_audit (
  id            uuid primary key default case_app.uuid_v7(),
  -- No foreign key (decided for item 7 of the card 35 red-team): the audit outlives its workspace. Deleting
  -- a workspace (no route does today) leaves its audit trail archived under the old id, never blocked by it.
  workspace_id  uuid not null,
  actor_kind    text not null check (actor_kind in ('admin', 'owner', 'system')),
  actor_user_id uuid,  -- no foreign key: pseudonymous after an account's hard deletion (PERMISSIONS §10)
  actor_email   text check (actor_email is null or (length(actor_email) <= 320 and
                  actor_email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$')),
  action        text not null check (action in ('workspace_create', 'case_create', 'draft_save',
                  'version_publish', 'version_withdraw', 'version_republish', 'room_start', 'workspace_ownerless',
                  'member_invite', 'owner_assign')),
  target_type   text not null check (target_type in ('workspace', 'case', 'version', 'room', 'member')),
  target_id     uuid not null,
  revision      bigint check (revision is null or revision >= 0),
  elevation_id  uuid,  -- the step-up token id (jti) that admitted this action, when one did
  at            timestamptz not null default clock_timestamp(),
  check ((actor_kind = 'admin') = (actor_email is not null)),
  check ((actor_kind = 'system') = (action = 'workspace_ownerless')),
  check (actor_kind = 'system' or actor_user_id is not null),
  check (actor_kind <> 'system' or actor_user_id is null)
);
create index workspace_audit_recent_idx on case_app.workspace_audit (workspace_id, at desc, id desc);
create trigger workspace_audit_immutable
  before update or delete on case_app.workspace_audit
  for each row execute function case_app.forbid_change();
create trigger workspace_audit_no_truncate
  before truncate on case_app.workspace_audit
  for each statement execute function case_app.forbid_change();
revoke all on case_app.workspace_audit from public, anon, authenticated, service_role;

create function case_app.audit_admin(
  p_workspace_id uuid, p_user_id uuid, p_admin_email text, p_action text, p_target_type text,
  p_target_id uuid, p_revision bigint default null, p_elevation_id uuid default null
) returns void language sql set search_path = '' as $$
  insert into case_app.workspace_audit
    (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id, revision, elevation_id)
  values (p_workspace_id, 'admin', p_user_id, p_admin_email, p_action, p_target_type, p_target_id, p_revision, p_elevation_id);
$$;

-- ─── last-owner guard ─────────────────────────────────────────────────────────────────────────────
create function case_app.guard_last_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role <> 'owner' then return null; end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.workspace_id = old.workspace_id then return null; end if;
  if not exists (select 1 from case_app.workspaces w where w.id = old.workspace_id) then return null; end if;
  if exists (select 1 from case_app.workspace_members m
              where m.workspace_id = old.workspace_id and m.role = 'owner') then return null; end if;
  -- An account's hard deletion cascades its memberships away; it proceeds, audited and alerted.
  if tg_op = 'DELETE' and not exists (select 1 from case_app.profiles p where p.id = old.user_id) then
    insert into case_app.workspace_audit (workspace_id, actor_kind, action, target_type, target_id)
    values (old.workspace_id, 'system', 'workspace_ownerless', 'workspace', old.workspace_id);
    insert into case_app._lockdown_alerts (detail) values ('workspace_ownerless: an owner account was deleted');
    return null;
  end if;
  raise exception 'last_owner: the workspace would have no owner' using errcode = '23514';
end;
$$;
create trigger workspace_members_last_owner
  after update or delete on case_app.workspace_members
  for each row execute function case_app.guard_last_owner();
create trigger workspace_members_no_truncate
  before truncate on case_app.workspace_members
  for each statement execute function case_app.forbid_change();

-- ─── session-wide elevation (Julian, 2026-10-07, R-a; invariant 11) ──────────────────────────────
-- One email code opens a window for every destructive admin action for the rest of that sign-in session.
-- The Worker signs {email, scope, sid, jti} and refuses it for any other email or session; this records each
-- issued elevation so a write that names one (p_elevation_id) is checked against a real, matching issue.
create table case_app.admin_elevations (
  jti          uuid primary key,
  actor_email  text not null check (length(actor_email) <= 320 and
                 actor_email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  scope        text not null check (scope = 'admin' or
                 scope ~ '^owner:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  session_id   uuid not null,
  issued_at    timestamptz not null default clock_timestamp()
);
create trigger admin_elevations_immutable
  before update or delete on case_app.admin_elevations
  for each row execute function case_app.forbid_change();
create trigger admin_elevations_no_truncate
  before truncate on case_app.admin_elevations
  for each statement execute function case_app.forbid_change();
revoke all on case_app.admin_elevations from public, anon, authenticated, service_role;

create function case_api.record_admin_elevation(
  p_jti uuid, p_actor_email text, p_scope text, p_session_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_jti is null or p_actor_email is null or p_scope is null or p_session_id is null then
    raise exception 'invalid_elevation' using errcode = '22023'; end if;
  insert into case_app.admin_elevations (jti, actor_email, scope, session_id)
  values (p_jti, p_actor_email, p_scope, p_session_id) on conflict (jti) do nothing;
  return found;
end;
$$;

-- A write that needs a step-up names an elevation issued to this admin, in this scope.
create function case_app.assert_elevation(p_elevation_id uuid, p_admin_email text, p_scope text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_elevation_id is null or not exists (select 1 from case_app.admin_elevations e
      where e.jti = p_elevation_id and e.actor_email = p_admin_email and e.scope = p_scope) then
    raise exception 'not_authorised: no matching step-up' using errcode = '42501'; end if;
end;
$$;

-- ─── membership RPCs ──────────────────────────────────────────────────────────────────────────────

-- Admins see every workspace, each with role 'admin' (display only, invariant 9).
drop function case_api.get_me(uuid, integer, uuid, uuid);
create function case_api.get_me(
  p_user_id uuid, p_limit integer default 100, p_after uuid default null,
  p_workspace_id uuid default null, p_admin boolean default false, p_admin_email text default null
) returns table (
  user_id uuid, display_name text, memberships jsonb, next_after uuid, admin boolean
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_admin boolean := case_app.check_admin_flag(p_admin, p_admin_email);
  v_display_name text;
  v_memberships jsonb;
  v_next_after uuid;
begin
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  -- P-10: an inactive account sees no workspace (the Worker refuses it first; this is the backstop).
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  if p_after is not null and not exists (
    select 1 from case_app.workspaces w
      left join case_app.workspace_members m on m.workspace_id = w.id and m.user_id = p_user_id
     where w.id = p_after and (v_admin or m.user_id is not null)
       and (p_workspace_id is null or w.id = p_workspace_id)
  ) then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  select p.display_name into v_display_name from case_app.profiles p where p.id = p_user_id;
  with page as (
    select w.id as workspace_id, w.slug, w.name, case when v_admin then 'admin' else m.role end as role,
           row_number() over (order by w.id) as rn
      from case_app.workspaces w
      left join case_app.workspace_members m on m.workspace_id = w.id and m.user_id = p_user_id
     where (v_admin or m.user_id is not null)
       and (p_workspace_id is null or w.id = p_workspace_id)
       and (p_after is null or w.id > p_after)
     order by w.id
     limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'workspace_id', workspace_id, 'slug', slug, 'name', name, 'role', role
         ) order by workspace_id) filter (where rn <= v_limit), '[]'::jsonb),
         case when count(*) > v_limit then (array_agg(workspace_id) filter (where rn = v_limit))[1] else null end
    into v_memberships, v_next_after from page;
  return query select p_user_id, v_display_name, v_memberships, v_next_after, v_admin;
end;
$$;

-- P-01: admins only. Until card 32's admin_create_workspace names a first owner, the admin who creates the
-- workspace becomes its owner (today's behaviour, card 35 scope), so it never starts ownerless.
-- The old signature (open to any signed-in user on the old Worker) refuses from now on.
create or replace function case_api.bootstrap_workspace(p_user_id uuid, p_slug text, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'not_authorised: workspace creation is admin only (card 35)' using errcode = '42501';
end;
$$;
create function case_api.bootstrap_workspace(
  p_user_id uuid, p_slug text, p_name text, p_admin boolean, p_admin_email text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform case_app.authorize_admin(p_user_id, 'P-01', p_admin, p_admin_email);
  if p_name is null or length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_workspace_name' using errcode = '23514';
  end if;
  perform case_app.ensure_admin_profile(p_user_id);
  insert into case_app.workspaces (slug, name) values (p_slug, btrim(p_name)) returning id into v_id;
  insert into case_app.workspace_members (workspace_id, user_id, role) values (v_id, p_user_id, 'owner');
  perform case_app.audit_admin(v_id, p_user_id, p_admin_email, 'workspace_create', 'workspace', v_id);
  return v_id;
end;
$$;

-- P-03: admins only, with the acting admin named and the invite workspace-audited. The old 2-argument
-- signature stays unchanged for the old Worker's admin invite route (its ADMIN_EMAILS gate already ran).
create function case_api.admin_provision_facilitator(
  p_user_id uuid, p_workspace_id uuid, p_actor_user_id uuid, p_admin boolean, p_admin_email text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_actor_user_id, p_workspace_id, 'P-03', p_admin, p_admin_email);
  perform case_api.admin_provision_facilitator(p_user_id, p_workspace_id);
  perform case_app.audit_admin(p_workspace_id, p_actor_user_id, p_admin_email, 'member_invite', 'member', p_user_id);
end;
$$;

-- Ownerless recovery (E21): an admin names an owner. Card 32 adds the route, its step-up and the UI.
create function case_api.admin_set_workspace_owner(
  p_workspace_id uuid, p_user_id uuid, p_actor_user_id uuid, p_admin boolean, p_admin_email text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_actor_user_id, p_workspace_id, 'P-04', p_admin, p_admin_email);
  if p_user_id is null or not case_api.admin_account_active(p_user_id) or
     not exists (select 1 from case_app.profiles p where p.id = p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  insert into case_app.workspace_members (workspace_id, user_id, role) values (p_workspace_id, p_user_id, 'owner')
    on conflict (workspace_id, user_id) do update set role = 'owner';
  perform case_app.audit_admin(p_workspace_id, p_actor_user_id, p_admin_email, 'owner_assign', 'member', p_user_id);
end;
$$;

-- ─── authoring ────────────────────────────────────────────────────────────────────────────────────

-- Case-addressed routes learn the workspace from the case, never from the caller. A refusal is no row.
drop function case_api.get_case_authoring_access(uuid, uuid);
create function case_api.get_case_authoring_access(
  p_case_id uuid, p_user_id uuid, p_admin boolean default false, p_admin_email text default null
) returns table (case_id uuid, workspace_id uuid, role text)
language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_role text;
begin
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize(p_user_id, v_ws, 'P-14', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query select p_case_id, v_ws, v_role;
end;
$$;

drop function case_api.create_case(uuid, uuid, text);
create function case_api.create_case(
  p_user_id uuid, p_workspace_id uuid, p_title text, p_admin boolean default false, p_admin_email text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_role text;
begin
  v_role := case_app.authorize(p_user_id, p_workspace_id, 'P-13', p_admin, p_admin_email);
  if p_title is null or length(btrim(p_title)) not between 1 and 200 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid_case_title' using errcode = '23514';
  end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  insert into case_app.cases (workspace_id, owner_id, title)
  values (p_workspace_id, p_user_id, btrim(p_title)) returning id into v_id;
  if v_role = 'admin' then
    perform case_app.audit_admin(p_workspace_id, p_user_id, p_admin_email, 'case_create', 'case', v_id);
  end if;
  return v_id;
end;
$$;

drop function case_api.save_draft(uuid, bigint, integer, jsonb, uuid);
create function case_api.save_draft(
  p_case_id uuid, p_expected_revision bigint, p_schema_version integer, p_document jsonb, p_user_id uuid,
  p_admin boolean default false, p_admin_email text default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_rev bigint; v_ws uuid := case_app.workspace_of_case(p_case_id); v_role text;
begin
  v_role := case_app.authorize(p_user_id, v_ws, 'P-14', p_admin, p_admin_email);
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  if p_expected_revision = 0 then
    insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
    values (p_case_id, 1, p_schema_version, p_document, p_user_id)
    on conflict (case_id) do nothing
    returning revision into v_rev;
  else
    update case_app.case_drafts
       set revision = revision + 1, schema_version = p_schema_version, document = p_document,
           updated_by = p_user_id, updated_at = now()
     where case_id = p_case_id and revision = p_expected_revision
    returning revision into v_rev;
  end if;
  if v_rev is null then
    raise exception 'revision_conflict: case % is not at revision %', p_case_id, p_expected_revision
      using errcode = '40001';
  end if;
  update case_app.cases set updated_at = now() where id = p_case_id;
  if v_role = 'admin' then
    perform case_app.audit_admin(v_ws, p_user_id, p_admin_email, 'draft_save', 'case', p_case_id, v_rev);
  end if;
  return v_rev;
end;
$$;

drop function case_api.get_draft(uuid, uuid);
create function case_api.get_draft(
  p_case_id uuid, p_user_id uuid, p_admin boolean default false, p_admin_email text default null
) returns table (revision bigint, schema_version integer, document jsonb, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id, case_app.workspace_of_case(p_case_id), 'P-14', p_admin, p_admin_email);
  return query select d.revision, d.schema_version, d.document, d.updated_at
    from case_app.case_drafts d where d.case_id = p_case_id;
end;
$$;

-- Publish no longer delegates to the member-only publish_draft (which stays retired): it freezes the draft
-- itself, so the admin path and the asset binding apply.
drop function case_api.publish_draft_with_art(uuid, bigint, uuid, uuid[], jsonb);
create function case_api.publish_draft_with_art(
  p_case_id uuid, p_expected_revision bigint, p_user_id uuid, p_asset_ids uuid[], p_art jsonb,
  p_admin boolean default false, p_admin_email text default null
) returns table (version_id uuid, version_no integer, content_sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  d case_app.case_drafts%rowtype;
  v_ws uuid := case_app.workspace_of_case(p_case_id);
  v_role text;
  v_no integer;
  v_id uuid;
  v_hash bytea;
  v_bad integer;
begin
  v_role := case_app.authorize(p_user_id, v_ws, 'P-15', p_admin, p_admin_email);
  select * into d from case_app.case_drafts where case_id = p_case_id for update;
  if not found or d.revision <> p_expected_revision then
    raise exception 'revision_conflict: case % is not at revision %', p_case_id, p_expected_revision
      using errcode = '40001';
  end if;
  if p_art is null or not case_app.art_shape_ok(p_art) or
     (p_art - 'attempt' - 'summarised' - 'renderer') <> case_app.art_structure(d.document) then
    raise exception 'art_mismatch' using errcode = '22023';
  end if;
  -- Every asset the version reveals belongs to the case's own workspace (invariant 6, E13) and is approved.
  select count(*) into v_bad
    from unnest(coalesce(p_asset_ids, '{}')) a(id)
    join case_app.assets s on s.id = a.id
   where s.workspace_id <> v_ws;
  if v_bad > 0 then
    raise exception 'asset_not_in_workspace: % asset(s) belong to another workspace', v_bad using errcode = '23514';
  end if;
  select count(*) into v_bad
    from unnest(coalesce(p_asset_ids, '{}')) a(id)
    left join case_app.assets s on s.id = a.id
   where s.id is null or s.status <> 'approved';
  if v_bad > 0 then
    raise exception 'asset_not_approved: % asset(s) lack approval', v_bad using errcode = '23514';
  end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  select coalesce(max(v.version_no), 0) + 1 into v_no
    from case_app.case_versions v where v.case_id = p_case_id;
  v_hash := sha256(convert_to(d.document::text, 'UTF8'));
  insert into case_app.case_versions (case_id, version_no, schema_version, document, content_sha256, published_by)
  values (p_case_id, v_no, d.schema_version, d.document, v_hash, p_user_id)
  returning id into v_id;
  insert into case_app.case_version_assets (case_version_id, asset_id)
  select v_id, a.id from unnest(coalesce(p_asset_ids, '{}')) a(id) on conflict do nothing;
  insert into case_app.case_version_art (case_version_id, descriptor, renderer_version)
  values (v_id, p_art, (p_art ->> 'renderer')::integer);
  if v_role = 'admin' then
    perform case_app.audit_admin(v_ws, p_user_id, p_admin_email, 'version_publish', 'version', v_id, v_no::bigint);
  end if;
  return query select v_id, v_no, v_hash;
end;
$$;

-- ─── library and rooms ────────────────────────────────────────────────────────────────────────────

drop function case_api.list_published_versions(uuid, uuid, integer, uuid);
create function case_api.list_published_versions(
  p_user_id uuid, p_workspace_id uuid, p_limit integer, p_after uuid,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  version_id uuid, case_id uuid, title text, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_after_at timestamptz;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_after is not null then
    select v.published_at into v_after_at
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_after and c.workspace_id = p_workspace_id and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn');
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select v.id, v.case_id, c.title, v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
      left join case_app.case_version_art a on a.case_version_id = v.id
     where c.workspace_id = p_workspace_id and c.archived_at is null and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn') and
       (p_after is null or (v.published_at, v.id) < (v_after_at, p_after))
     order by v.published_at desc, v.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;

drop function case_api.get_case_version_for_workspace(uuid, uuid, uuid);
create function case_api.get_case_version_for_workspace(
  p_version_id uuid, p_workspace_id uuid, p_user_id uuid,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  case_id uuid, version_no integer, schema_version integer,
  document jsonb, document_text text, content_sha256 bytea, art jsonb
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  return query select v.case_id, v.version_no, v.schema_version,
    v.document, v.document::text, v.content_sha256::bytea, a.descriptor
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
    left join case_app.case_version_art a on a.case_version_id = v.id
    where v.id = p_version_id and c.workspace_id = p_workspace_id and
      not exists (select 1 from case_app.admin_version_state av
        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

drop function case_api.create_session(uuid, uuid, uuid, uuid, text, interval);
create function case_api.create_session(
  p_session_id uuid, p_case_version_id uuid, p_workspace_id uuid,
  p_facilitator_id uuid, p_join_code text, p_ttl interval default interval '12 hours',
  p_admin boolean default false, p_admin_email text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if p_session_id is null or p_session_id::text !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'session_id_must_be_uuidv7' using errcode = '23514';
  end if;
  v_role := case_app.authorize(p_facilitator_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  if not exists (
    select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_case_version_id and c.workspace_id = p_workspace_id and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn')
  ) then
    raise exception 'not_authorised: version unavailable' using errcode = '42501';
  end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_facilitator_id); end if;
  insert into case_app.sessions (id, case_version_id, workspace_id, facilitator_id, join_code, expires_at)
  values (p_session_id, p_case_version_id, p_workspace_id, p_facilitator_id, p_join_code,
          now() + greatest(interval '1 minute', least(coalesce(p_ttl, interval '12 hours'), interval '24 hours')));
  if v_role = 'admin' then
    perform case_app.audit_admin(p_workspace_id, p_facilitator_id, p_admin_email, 'room_start', 'room', p_session_id);
  end if;
  return p_session_id;
end;
$$;

drop function case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer);
create function case_api.list_case_catalogue(
  p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text,
  p_duration integer, p_audience text, p_limit integer, p_offset integer,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  version_id uuid, case_id uuid, title text, summary text, audience text, setting text,
  duration_min integer, version_no integer, published_at timestamptz, content_sha256 bytea,
  art jsonb, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15, 45)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) then
    raise exception 'invalid_catalogue_query' using errcode = '22023'; end if;
  v_pattern := '%' || replace(replace(replace(lower(coalesce(v_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with listed as (
      select v.id as l_id, v.case_id as l_case, c.title as l_title,
             case_app.catalogue_text(v.document, 'summary', 1200) as l_summary,
             case_app.catalogue_text(v.document, 'audience', 200) as l_audience,
             case_app.catalogue_text(v.document, 'setting', 200) as l_setting,
             case_app.catalogue_duration(v.document) as l_duration,
             v.version_no as l_version, v.published_at as l_published,
             v.content_sha256::bytea as l_digest, a.descriptor as l_art
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$$;

drop function case_api.list_case_catalogue_audiences(uuid, uuid);
create function case_api.list_case_catalogue_audiences(
  p_user_id uuid, p_workspace_id uuid, p_admin boolean default false, p_admin_email text default null
) returns table (
  audience text, case_count bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  return query
    select x.a, count(*)
      from (select case_app.catalogue_text(v.document, 'audience', 200) as a
              from case_app.catalogue_versions(p_workspace_id) lv
              join case_app.case_versions v on v.id = lv.version_id
             where lv.latest) x
     where x.a is not null
     group by x.a
     order by count(*) desc, x.a asc
     limit 50;
end;
$$;

-- Case detail: a caller outside the case's workspace gets no row (the same shape as a missing case).
drop function case_api.get_catalogue_case(uuid, uuid, integer);
create function case_api.get_catalogue_case(
  p_user_id uuid, p_case_id uuid, p_version_no integer,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text,
  audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize(p_user_id, v_ws, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, c.title,
           case_app.catalogue_text(v.document, 'summary', 1200),
           case_app.catalogue_text(v.document, 'audience', 200),
           case_app.catalogue_text(v.document, 'setting', 200),
           case_app.catalogue_duration(v.document),
           case when jsonb_typeof(v.document -> 'learning_objectives') = 'array' then coalesce((
             select jsonb_agg(left(btrim(o.value #>> '{}'), 300) order by o.n)
               from jsonb_array_elements(v.document -> 'learning_objectives') with ordinality as o(value, n)
              where jsonb_typeof(o.value) = 'string' and btrim(o.value #>> '{}') <> '' and o.n <= 8), '[]'::jsonb)
             else '[]'::jsonb end,
           v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor,
           (select coalesce(jsonb_agg(jsonb_build_object('version_id', o.id, 'version_no', o.version_no,
                     'published_at', o.published_at, 'content_sha256', '\x' || encode(o.content_sha256, 'hex'))
                     order by o.version_no desc), '[]'::jsonb)
              from (select ov.id, ov.version_no, ov.published_at, ov.content_sha256
                      from case_app.case_versions ov
                     where ov.case_id = v.case_id and
                           not exists (select 1 from case_app.admin_version_state av
                                        where av.case_version_id = ov.id and av.status = 'withdrawn')
                     order by ov.version_no desc limit 50) o)
      from case_app.case_versions v
      join case_app.cases c on c.id = v.case_id
      left join case_app.case_version_art a on a.case_version_id = v.id
     where v.case_id = p_case_id and v.version_no = p_version_no and c.archived_at is null and
           not exists (select 1 from case_app.admin_version_state av
                        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

-- ─── admin-only version state (P-16 admin path) ──────────────────────────────────────────────────
-- Withdraw and republish both need a recorded step-up issued to this admin (red-team items 4 and 5); both
-- are workspace-audited with it. The old 3-argument signature stays for the old Worker's admin routes.
create function case_api.admin_set_version_state(
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
  select * into r from case_api.admin_set_version_state(p_version_id, p_expected_revision, p_action);
  perform case_app.audit_admin(v_ws, p_user_id, p_admin_email,
    case when p_action = 'withdraw' then 'version_withdraw' else 'version_republish' end,
    'version', p_version_id, r.admin_revision, p_elevation_id);
  return query select r.version_id, r.status, r.admin_revision;
end;
$$;

-- ─── deployment-scope account writes (P-06): the admin flag in SQL too (invariant 5) ─────────────────
-- Old signatures stay for the old Worker's admin routes and the scheduled hard-delete sweep.
create function case_api.admin_transition_profile(
  p_user_id uuid, p_expected_revision bigint, p_action text, p_admin boolean, p_admin_email text
) returns table (
  user_id uuid, disabled_at timestamptz, soft_deleted_at timestamptz,
  delete_due_at timestamptz, admin_revision bigint
) language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(case_app.check_admin_flag(p_admin, p_admin_email), false) then
    raise exception 'not_authorised: account lifecycle is admin only' using errcode = '42501'; end if;
  return query select * from case_api.admin_transition_profile(p_user_id, p_expected_revision, p_action);
end;
$$;
create function case_api.admin_revert_profile(
  p_user_id uuid, p_expected_revision bigint, p_disabled_at timestamptz,
  p_soft_deleted_at timestamptz, p_delete_due_at timestamptz, p_admin boolean, p_admin_email text
) returns table (user_id uuid, disabled_at timestamptz, soft_deleted_at timestamptz,
  delete_due_at timestamptz, admin_revision bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(case_app.check_admin_flag(p_admin, p_admin_email), false) then
    raise exception 'not_authorised: account lifecycle is admin only' using errcode = '42501'; end if;
  return query select * from case_api.admin_revert_profile(p_user_id, p_expected_revision, p_disabled_at,
    p_soft_deleted_at, p_delete_due_at);
end;
$$;

-- ─── room capability fallback (red-team item 3) ──────────────────────────────────────────────────────
-- Rooms started before this branch's Worker have no workspace in their Durable Object; the Worker reads the
-- room's workspace from its session row to recheck the starter before a mint. Ids only.
create function case_api.get_session_workspace(p_session_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.workspace_id from case_app.sessions s where s.id = p_session_id;
$$;

-- ─── stale rooms (R-c): a starter's live rooms, only where they are still a member or an admin ────────
drop function case_api.list_owned_active_sessions(uuid, integer, uuid);
create function case_api.list_owned_active_sessions(
  p_user_id uuid, p_limit integer default 100, p_after uuid default null,
  p_admin boolean default false, p_admin_email text default null
) returns table (session_id uuid, join_code text, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_admin boolean := case_app.check_admin_flag(p_admin, p_admin_email);
  v_after_at timestamptz;
begin
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  if p_after is not null then
    select s.created_at into v_after_at from case_app.sessions s
     where s.id = p_after and s.facilitator_id = p_user_id
       and s.status in ('lobby', 'live') and s.expires_at > now();
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select s.id, s.join_code::text, s.expires_at
      from case_app.sessions s
     where s.facilitator_id = p_user_id and s.status in ('lobby', 'live')
       and s.expires_at > now()
       and (v_admin or case_app.member_role(p_user_id, s.workspace_id) is not null)
       and (p_after is null or (s.created_at, s.id) < (v_after_at, p_after))
     order by s.created_at desc, s.id desc
     limit v_limit;
end;
$$;

-- ─── workspace audit read (P-22): admins only; owners do not see audit (Julian, 2026-10-07) ────────
create function case_api.list_workspace_audit(
  p_user_id uuid, p_workspace_id uuid, p_limit integer, p_after uuid, p_admin boolean, p_admin_email text
) returns table (
  event_id uuid, actor_kind text, actor_user_id uuid, actor_email text, action text, target_type text,
  target_id uuid, revision bigint, elevation_id uuid, at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
declare v_after_at timestamptz;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-22', p_admin, p_admin_email);
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_audit_page' using errcode = '22023'; end if;
  if p_after is not null then
    select a.at into v_after_at from case_app.workspace_audit a where a.id = p_after and a.workspace_id = p_workspace_id;
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select a.id, a.actor_kind, a.actor_user_id, a.actor_email, a.action, a.target_type, a.target_id,
           a.revision, a.elevation_id, a.at
      from case_app.workspace_audit a
     where a.workspace_id = p_workspace_id and (p_after is null or (a.at, a.id) < (v_after_at, p_after))
     order by a.at desc, a.id desc
     limit p_limit;
end;
$$;

-- ─── privileges ───────────────────────────────────────────────────────────────────────────────────
revoke all on function
  case_app.action_roles(text), case_app.action_admin(text), case_app.check_admin_flag(boolean, text),
  case_app.member_role(uuid, uuid), case_app.authorize(uuid, uuid, text, boolean, text),
  case_app.authorize_admin(uuid, text, boolean, text), case_app.ensure_admin_profile(uuid),
  case_app.audit_admin(uuid, uuid, text, text, text, uuid, bigint, uuid), case_app.guard_last_owner(),
  case_app.assert_elevation(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function
  case_api.get_me(uuid, integer, uuid, uuid, boolean, text),
  case_api.bootstrap_workspace(uuid, text, text, boolean, text),
  case_api.admin_provision_facilitator(uuid, uuid, uuid, boolean, text),
  case_api.get_case_authoring_access(uuid, uuid, boolean, text),
  case_api.create_case(uuid, uuid, text, boolean, text),
  case_api.save_draft(uuid, bigint, integer, jsonb, uuid, boolean, text),
  case_api.get_draft(uuid, uuid, boolean, text),
  case_api.publish_draft_with_art(uuid, bigint, uuid, uuid[], jsonb, boolean, text),
  case_api.list_published_versions(uuid, uuid, integer, uuid, boolean, text),
  case_api.get_case_version_for_workspace(uuid, uuid, uuid, boolean, text),
  case_api.create_session(uuid, uuid, uuid, uuid, text, interval, boolean, text),
  case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer, boolean, text),
  case_api.list_case_catalogue_audiences(uuid, uuid, boolean, text),
  case_api.get_catalogue_case(uuid, uuid, integer, boolean, text),
  case_api.admin_set_version_state(uuid, bigint, text, uuid, boolean, text, uuid),
  case_api.record_admin_elevation(uuid, text, text, uuid),
  case_api.list_workspace_audit(uuid, uuid, integer, uuid, boolean, text),
  case_api.admin_set_workspace_owner(uuid, uuid, uuid, boolean, text),
  case_api.admin_transition_profile(uuid, bigint, text, boolean, text),
  case_api.admin_revert_profile(uuid, bigint, timestamptz, timestamptz, timestamptz, boolean, text),
  case_api.get_session_workspace(uuid),
  case_api.list_owned_active_sessions(uuid, integer, uuid, boolean, text)
  from public, anon, authenticated, service_role;
-- The member-only version read is retired: nothing calls it, and it cannot take the admin path.
revoke execute on function case_api.get_case_version(uuid,uuid) from service_role;
grant execute on function
  case_api.get_me(uuid, integer, uuid, uuid, boolean, text),
  case_api.bootstrap_workspace(uuid, text, text, boolean, text),
  case_api.admin_provision_facilitator(uuid, uuid, uuid, boolean, text),
  case_api.get_case_authoring_access(uuid, uuid, boolean, text),
  case_api.create_case(uuid, uuid, text, boolean, text),
  case_api.save_draft(uuid, bigint, integer, jsonb, uuid, boolean, text),
  case_api.get_draft(uuid, uuid, boolean, text),
  case_api.publish_draft_with_art(uuid, bigint, uuid, uuid[], jsonb, boolean, text),
  case_api.list_published_versions(uuid, uuid, integer, uuid, boolean, text),
  case_api.get_case_version_for_workspace(uuid, uuid, uuid, boolean, text),
  case_api.create_session(uuid, uuid, uuid, uuid, text, interval, boolean, text),
  case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer, boolean, text),
  case_api.list_case_catalogue_audiences(uuid, uuid, boolean, text),
  case_api.get_catalogue_case(uuid, uuid, integer, boolean, text),
  case_api.admin_set_version_state(uuid, bigint, text, uuid, boolean, text, uuid),
  case_api.record_admin_elevation(uuid, text, text, uuid),
  case_api.list_workspace_audit(uuid, uuid, integer, uuid, boolean, text),
  case_api.admin_set_workspace_owner(uuid, uuid, uuid, boolean, text),
  case_api.admin_transition_profile(uuid, bigint, text, boolean, text),
  case_api.admin_revert_profile(uuid, bigint, timestamptz, timestamptz, timestamptz, boolean, text),
  case_api.get_session_workspace(uuid),
  case_api.list_owned_active_sessions(uuid, integer, uuid, boolean, text)
  to service_role;

commit;
