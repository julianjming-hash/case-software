-- Access, invitations and images (facilitator-UX Access PR, plan docs/plans/2026-11-02-facilitator-ux-build-plan.md
-- §3 A2; inventory docs/plans/2026-11-02-access-inventory.md). CASE-336 access = person × place × level, CASE-337
-- workspace policies, CASE-338 managers approve and release, CASE-339 invitations as records, CASE-342 image
-- approval removed and per-workspace storage.
--
-- Additive and backward-compatible with the deployed Worker (staging and production share this database, CASE-159):
-- case_app.authorize keeps its signature (an overload with a default would make its existing calls ambiguous); every
-- existing case_api signature is kept, get_me gains one result column; new behaviour is in new functions.
--   1. case_grants, workspace_policies (a row for every workspace), invitations, case_assets, a per-workspace quota.
--   2. case_app.effective_role, authorize_case (the case-level core) and authorize (now reads policy cells).
--   3. workspace_audit records the real actor kind (admin | owner | author | system).
--   4-5. The case-level RPCs become case-aware through authorize_case, the case always derived from the version,
--      draft, candidate or session row; candidate approve and release audit by real kind; record reads widen for
--      owners under managers_see_records; own live rooms need a membership or a grant.
--   6. Images are usable at once: release, readiness and room media exclude only taken-down images; the sweep no
--      longer closes "unapproved" ones; case-keyed media RPCs scope a case-only editor to that case's images; storage
--      usage, quota and the unused-image listing and deletion.
--   7-9. Access facts, Shared with you, the Share dialog, policies, invitations, /me grants.
--   10. Privileges.
begin;

-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)
create or replace function case_app.action_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then array[]::text[]
    when 'P-02' then array[]::text[]
    when 'P-03' then array[]::text[]
    when 'P-04' then array[]::text[]
    when 'P-05' then array[]::text[]
    when 'P-07' then array[]::text[]
    when 'P-10' then array['owner', 'author', 'facilitator']
    when 'P-11' then array['owner', 'author', 'facilitator']
    when 'P-12' then array['owner', 'author', 'facilitator']
    when 'P-13' then array['owner', 'author']
    when 'P-14' then array['owner', 'author']
    when 'P-15' then array['owner']
    when 'P-16' then array['owner']
    when 'P-17' then array['owner']
    when 'P-18' then array['owner']
    when 'P-19' then array['owner']
    when 'P-20' then array['owner']
    when 'P-21' then array['owner', 'author', 'facilitator']
    when 'P-22' then array[]::text[]
    when 'P-32' then array['owner', 'author', 'facilitator']
    when 'P-33' then array['owner']
    when 'P-34' then array['owner', 'author', 'facilitator']
    when 'P-37' then array['owner', 'author', 'facilitator']
    when 'P-38' then array['owner', 'author']
    when 'P-39' then array[]::text[]
    when 'P-42' then array['owner']
    when 'P-43' then array['owner']
    when 'P-44' then array[]::text[]
    when 'P-45' then array[]::text[]
  end;
$$;
create or replace function case_app.action_admin(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then true
    when 'P-02' then true
    when 'P-03' then true
    when 'P-04' then true
    when 'P-05' then true
    when 'P-07' then true
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
    when 'P-32' then true
    when 'P-33' then true
    when 'P-34' then true
    when 'P-37' then true
    when 'P-38' then true
    when 'P-39' then true
    when 'P-42' then true
    when 'P-43' then true
    when 'P-44' then true
    when 'P-45' then true
  end;
$$;
-- The roles (author, facilitator) a case grant of that level reaches on its own case (CASE-336).
create or replace function case_app.action_case_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then array[]::text[]
    when 'P-02' then array[]::text[]
    when 'P-03' then array[]::text[]
    when 'P-04' then array[]::text[]
    when 'P-05' then array[]::text[]
    when 'P-07' then array[]::text[]
    when 'P-10' then array[]::text[]
    when 'P-11' then array['author', 'facilitator']
    when 'P-12' then array[]::text[]
    when 'P-13' then array[]::text[]
    when 'P-14' then array['author']
    when 'P-15' then array[]::text[]
    when 'P-16' then array[]::text[]
    when 'P-17' then array[]::text[]
    when 'P-18' then array[]::text[]
    when 'P-19' then array[]::text[]
    when 'P-20' then array[]::text[]
    when 'P-21' then array['author', 'facilitator']
    when 'P-22' then array[]::text[]
    when 'P-32' then array['author', 'facilitator']
    when 'P-33' then array[]::text[]
    when 'P-34' then array['author', 'facilitator']
    when 'P-37' then array['author', 'facilitator']
    when 'P-38' then array['author']
    when 'P-39' then array[]::text[]
    when 'P-42' then array[]::text[]
    when 'P-43' then array[]::text[]
    when 'P-44' then array[]::text[]
    when 'P-45' then array[]::text[]
  end;
$$;
-- True when the role's cell is pol or own+pol and the row's workspace policy is a JSON true in p_policies
-- (CASE-337): pol then grants, own+pol widens own to every room in the workspace. Anything else is false.
create or replace function case_app.policy_allows(p_action text, p_role text, p_policies jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case
    when p_action = 'P-03' and p_role = any (array['owner']) then p_policies -> 'managers_invite' = 'true'::jsonb
    when p_action = 'P-15' and p_role = any (array['author']) then p_policies -> 'editors_publish' = 'true'::jsonb
    when p_action = 'P-32' and p_role = any (array['owner']) then p_policies -> 'managers_see_records' = 'true'::jsonb
    when p_action = 'P-33' and p_role = any (array['author']) then p_policies -> 'editors_publish' = 'true'::jsonb
    when p_action = 'P-34' and p_role = any (array['owner']) then p_policies -> 'managers_see_records' = 'true'::jsonb
    when p_action = 'P-37' and p_role = any (array['owner']) then p_policies -> 'managers_see_records' = 'true'::jsonb
    when p_action = 'P-43' and p_role = any (array['author', 'facilitator']) then p_policies -> 'runners_share' = 'true'::jsonb
    when p_action = 'P-44' and p_role = any (array['owner']) then p_policies -> 'managers_invite' = 'true'::jsonb
  end, false);
$$;
revoke all on function case_app.action_roles(text), case_app.action_admin(text), case_app.action_case_roles(text),
  case_app.policy_allows(text, text, jsonb) from public, anon, authenticated, service_role;
-- END GENERATED permission roles

-- ─── 1. Places, levels and policies (CASE-336, CASE-337) ─────────────────────────────────────────────────────
-- A case grant names its workspace too, and a composite key ties it to the case's own workspace, so a grant can
-- never point at a case in another workspace (invariant 6).
alter table case_app.cases add constraint cases_id_workspace_key unique (id, workspace_id);

-- Four switches per workspace, set by an admin (P-45). Defaults per CASE-337; a row for every workspace, existing
-- ones included (managers see records ON for them too, plan §0.3). A new workspace gets its row from a trigger.
create table case_app.workspace_policies (
  workspace_id uuid primary key references case_app.workspaces(id) on delete cascade,
  managers_invite boolean not null default true,
  editors_publish boolean not null default false,
  runners_share boolean not null default false,
  managers_see_records boolean not null default true,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references case_app.profiles(id) on delete set null
);
insert into case_app.workspace_policies (workspace_id) select w.id from case_app.workspaces w on conflict do nothing;
create function case_app.seed_workspace_policies() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into case_app.workspace_policies (workspace_id) values (new.id) on conflict do nothing;
  return null;
end;
$$;
create trigger workspaces_seed_policies after insert on case_app.workspaces
  for each row execute function case_app.seed_workspace_policies();

-- Per-workspace image storage quota (CASE-342, plan §3 A7): 2 GB by default, so five workspaces fit R2's free 10 GB.
alter table case_app.workspaces add column media_quota_bytes bigint not null default 2000000000
  check (media_quota_bytes between 0 and 10000000000);

-- Invitations are records (CASE-339): one place (a workspace, or one case in it) and one level; the reference is
-- stored only as its SHA-256 (CASE-341). The address is personal data: purge_invitation_addresses nulls it 30 days
-- after the invitation ends (expiry, revoke, or the expiry date of an accepted one).
create table case_app.invitations (
  id uuid primary key default case_app.uuid_v7(),
  workspace_id uuid not null references case_app.workspaces(id) on delete restrict,
  case_id uuid,
  level text not null check (level in ('run', 'edit', 'manage')),
  email text check (email is null or (length(email) <= 320 and
    email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$')),
  ref_hash case_app.sha256 not null unique,
  invited_by uuid references case_app.profiles(id) on delete set null,
  inviter_kind text not null check (inviter_kind in ('admin', 'owner', 'author', 'facilitator')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references case_app.profiles(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references case_app.profiles(id) on delete set null,
  send_state text not null default 'not_sent'
    check (send_state in ('not_sent', 'sent', 'failed', 'email_limit', 'email_not_configured')),
  send_count integer not null default 0 check (send_count between 0 and 1000),
  last_send_at timestamptz,
  retry_after timestamptz,
  address_purged_at timestamptz,
  foreign key (case_id, workspace_id) references case_app.cases(id, workspace_id) on delete restrict,
  check (level <> 'manage' or case_id is null),
  check (expires_at > created_at and expires_at <= created_at + interval '90 days'),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check ((email is null) = (address_purged_at is not null)),
  check (address_purged_at is null or status <> 'pending')
);
create unique index invitations_one_pending on case_app.invitations
  (workspace_id, coalesce(case_id, workspace_id), email) where status = 'pending';
create index invitations_workspace on case_app.invitations (workspace_id, created_at desc, id desc);

-- Creations and resends per inviter, for the daily cap (no address, no reference).
create table case_app.invitation_events (
  id uuid primary key default case_app.uuid_v7(),
  invitation_id uuid not null references case_app.invitations(id) on delete cascade,
  actor_user_id uuid not null,
  kind text not null check (kind in ('create', 'resend')),
  at timestamptz not null default clock_timestamp()
);
create index invitation_events_actor on case_app.invitation_events (actor_user_id, at);

-- One live grant per case and person; Can manage is never a grant (CASE-336). Revoked rows stay as the record.
create table case_app.case_grants (
  id uuid primary key default case_app.uuid_v7(),
  case_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references case_app.profiles(id) on delete cascade,
  level text not null check (level in ('run', 'edit')),
  granted_by uuid references case_app.profiles(id) on delete set null,
  invitation_id uuid references case_app.invitations(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid references case_app.profiles(id) on delete set null,
  foreign key (case_id, workspace_id) references case_app.cases(id, workspace_id) on delete restrict
);
create unique index case_grants_live on case_app.case_grants (case_id, user_id) where revoked_at is null;
create index case_grants_user on case_app.case_grants (user_id) where revoked_at is null;

-- Which case an image was added for (CASE-342, plan §0.5): a case-only editor sees only its case's images. Existing
-- images are linked to every case whose versions, draft, candidates or checkpoints name them.
create table case_app.case_assets (
  asset_id uuid not null references case_app.assets(id) on delete cascade,
  case_id uuid not null references case_app.cases(id) on delete restrict,
  linked_by uuid references case_app.profiles(id) on delete set null,
  linked_at timestamptz not null default clock_timestamp(),
  primary key (asset_id, case_id)
);
create index case_assets_case on case_app.case_assets (case_id);
-- "Delete unused" queues the stored files of the images it removes for the hourly sweep (CASE-270).
alter table case_app.media_purge_queue drop constraint media_purge_queue_reason_check;
alter table case_app.media_purge_queue add constraint media_purge_queue_reason_check
  check (reason in ('withdrawn', 'rejected', 'abandoned', 'unused'));

-- The image ids a schema-3 document names (image blocks and surfaces), as guard_version_asset_set reads them.
create function case_app.document_asset_ids(p_doc jsonb) returns uuid[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct x order by x), '{}') from (
    select (b->>'asset_id')::uuid x from jsonb_array_elements(case when jsonb_typeof(p_doc->'blocks') = 'array' then p_doc->'blocks' else '[]'::jsonb end) b
      where b->>'type' = 'image' and b->>'asset_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    union select s::uuid from jsonb_array_elements(case when jsonb_typeof(p_doc->'surfaces') = 'array' then p_doc->'surfaces' else '[]'::jsonb end) f,
      jsonb_array_elements_text(case when jsonb_typeof(f->'asset_ids') = 'array' then f->'asset_ids' else '[]'::jsonb end) s
      where s ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') w;
$$;
insert into case_app.case_assets (asset_id, case_id, linked_at)
select distinct a.id, refs.case_id, a.created_at from (
    select v.case_id, cva.asset_id from case_app.case_version_assets cva join case_app.case_versions v on v.id = cva.case_version_id
    union select d.case_id, unnest(case_app.document_asset_ids(d.document)) from case_app.case_drafts d
    union select b.case_id, unnest(case_app.document_asset_ids(b.document)) from case_app.builder_candidates b where b.document is not null
    union select k.case_id, unnest(case_app.document_asset_ids(k.document)) from case_app.builder_checkpoints k where k.deleted_at is null
  ) refs
  join case_app.cases c on c.id = refs.case_id
  join case_app.assets a on a.id = refs.asset_id and a.workspace_id = c.workspace_id
on conflict do nothing;

-- ─── 2. The resolution core ─────────────────────────────────────────────────────────────────────────────────
create function case_app.role_rank(p_role text) returns integer language sql immutable set search_path = '' as $$
  select case p_role when 'owner' then 3 when 'author' then 2 when 'facilitator' then 1 end;
$$;

-- The workspace's policies as the JSON booleans case_app.policy_allows reads; a missing row is every policy off.
create function case_app.policies_of(p_workspace_id uuid) returns jsonb language sql stable set search_path = '' as $$
  select coalesce((select jsonb_build_object('managers_invite', p.managers_invite, 'editors_publish', p.editors_publish,
      'runners_share', p.runners_share, 'managers_see_records', p.managers_see_records)
    from case_app.workspace_policies p where p.workspace_id = p_workspace_id), '{}'::jsonb);
$$;

-- The role a live grant on THIS case gives (edit → author, run → facilitator); null when none. A revoked grant, or
-- any grant on an archived case, is inert. An inactive account is refused by the callers' account check.
create function case_app.grant_role(p_user_id uuid, p_case_id uuid) returns text language sql stable set search_path = '' as $$
  select case g.level when 'edit' then 'author' when 'run' then 'facilitator' end
    from case_app.case_grants g join case_app.cases c on c.id = g.case_id and c.workspace_id = g.workspace_id
   where g.case_id = p_case_id and g.user_id = p_user_id and g.revoked_at is null and c.archived_at is null;
$$;

-- The highest level a person holds on one case (CASE-336), in the existing role vocabulary, with where it comes from:
-- scope 'workspace' (a membership; a tie keeps the workspace) or 'case' (a grant on this case). No row: neither.
-- A case of another workspace contributes nothing. src/shared/permissions.mjs effectiveLevel is the JS reference.
create function case_app.effective_role(p_user_id uuid, p_workspace_id uuid, p_case_id uuid)
returns table(role text, scope text) language sql stable set search_path = '' as $$
  with m as (select case_app.member_role(p_user_id, p_workspace_id) as r),
       g as (select case when p_case_id is not null and case_app.workspace_of_case(p_case_id) = p_workspace_id
                         then case_app.grant_role(p_user_id, p_case_id) end as r)
  select case when g.r is not null and (m.r is null or case_app.role_rank(g.r) > case_app.role_rank(m.r)) then g.r else m.r end,
         case when g.r is not null and (m.r is null or case_app.role_rank(g.r) > case_app.role_rank(m.r)) then 'case' else 'workspace' end
    from m, g where m.r is not null or g.r is not null;
$$;

-- The case a version belongs to (null for an unknown version, which authorize_case refuses).
create function case_app.case_of_version(p_version_id uuid) returns uuid language sql stable set search_path = '' as $$
  select v.case_id from case_app.case_versions v where v.id = p_version_id;
$$;

-- Workspace actions (unchanged signature, 81 callers): a policy cell is now decided by case_app.policy_allows with
-- the workspace's own policies (CASE-337). Everything else is as before.
create or replace function case_app.authorize(p_user_id uuid, p_workspace_id uuid, p_action text, p_admin boolean, p_admin_email text)
returns text language plpgsql stable set search_path = '' as $$
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
  if v_role is null or not (v_role = any (v_roles) or
      case_app.policy_allows(p_action, v_role, case_app.policies_of(p_workspace_id))) then
    raise exception 'not_authorised: % in workspace %', p_action, p_workspace_id using errcode = '42501'; end if;
  return v_role;
end;
$$;

-- Case actions (invariant 2): the workspace comes from the case row, never from the request. A membership reaches
-- what its role reaches (action_roles); a live grant on THIS case reaches what action_case_roles gives its level;
-- either may be widened by a policy cell. Returns the strongest role that is allowed, in the existing vocabulary
-- ('admin', 'owner', 'author', 'facilitator'), so the existing callers' role checks keep working. No defaults: an
-- overload of authorize with a default would make its existing calls ambiguous.
create function case_app.authorize_case(p_user_id uuid, p_case_id uuid, p_action text, p_admin boolean, p_admin_email text)
returns text language plpgsql stable set search_path = '' as $$
declare v_ws uuid; v_member text; v_grant text; v_policies jsonb; v_member_ok boolean; v_grant_ok boolean;
begin
  if case_app.action_roles(p_action) is null then raise exception 'unknown_action' using errcode = '22023'; end if;
  if p_user_id is null or p_case_id is null then
    raise exception 'not_authorised: no caller or case' using errcode = '42501'; end if;
  if case_app.check_admin_flag(p_admin, p_admin_email) then
    if not case_app.action_admin(p_action) then
      raise exception 'not_authorised: admin may not %', p_action using errcode = '42501'; end if;
  end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  select c.workspace_id into v_ws from case_app.cases c where c.id = p_case_id;
  if v_ws is null then raise exception 'not_authorised: no such case' using errcode = '42501'; end if;
  if p_admin then return 'admin'; end if;
  v_member := case_app.member_role(p_user_id, v_ws);
  v_grant := case_app.grant_role(p_user_id, p_case_id);
  v_policies := case_app.policies_of(v_ws);
  v_member_ok := v_member is not null and (v_member = any (case_app.action_roles(p_action)) or
    case_app.policy_allows(p_action, v_member, v_policies));
  v_grant_ok := v_grant is not null and (v_grant = any (case_app.action_case_roles(p_action)) or
    case_app.policy_allows(p_action, v_grant, v_policies));
  if v_member_ok and v_grant_ok then
    return case when case_app.role_rank(v_grant) > case_app.role_rank(v_member) then v_grant else v_member end; end if;
  if v_member_ok then return v_member; end if;
  if v_grant_ok then return v_grant; end if;
  raise exception 'not_authorised: % on case %', p_action, p_case_id using errcode = '42501';
end;
$$;

-- Workspace-wide record lists (P-32): a member as authorize decides, or else a person whose live grants in the
-- workspace reach the action (their own rooms of those cases only; the caller filters).
create function case_app.authorize_records(p_user_id uuid, p_workspace_id uuid, p_action text, p_admin boolean, p_admin_email text)
returns text language plpgsql stable set search_path = '' as $$
declare v_role text;
begin
  begin
    return case_app.authorize(p_user_id, p_workspace_id, p_action, p_admin, p_admin_email);
  exception when insufficient_privilege then
    if p_admin or p_user_id is null or p_workspace_id is null or not case_api.admin_account_active(p_user_id) then raise; end if;
    select r into v_role from (
      select case_app.grant_role(p_user_id, g.case_id) r from case_app.case_grants g
       where g.user_id = p_user_id and g.workspace_id = p_workspace_id and g.revoked_at is null) x
     where r = any (case_app.action_case_roles(p_action)) order by case_app.role_rank(r) desc limit 1;
    if v_role is null then raise; end if;
    return v_role;
  end;
end;
$$;

-- Whether a record row is visible: every row for an admin or an owner while managers_see_records is on (p_all);
-- otherwise only the caller's own rooms, and for a person without a membership only on cases they still hold.
create function case_app.record_visible(p_user_id uuid, p_member boolean, p_all boolean, p_starter uuid, p_case_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_all or (p_starter = p_user_id and (p_member or case_app.grant_role(p_user_id, p_case_id) is not null));
$$;

-- ─── 3. The workspace audit records the real actor (CASE-338) ──────────────────────────────────────────────
alter table case_app.workspace_audit drop constraint workspace_audit_actor_kind_check;
alter table case_app.workspace_audit add constraint workspace_audit_actor_kind_check
  check (actor_kind in ('admin', 'owner', 'author', 'facilitator', 'system'));
-- The email stays for admins only (workspace_audit_check). A system row is the ownerless alert, or an acceptance by
-- verified email and the grant it creates (the invitee is not yet a principal of the place).
alter table case_app.workspace_audit drop constraint workspace_audit_check1;
alter table case_app.workspace_audit add constraint workspace_audit_check1
  check ((action <> 'workspace_ownerless' or actor_kind = 'system') and
         (actor_kind <> 'system' or action in ('workspace_ownerless', 'invitation_accept', 'case_grant')));
alter table case_app.workspace_audit drop constraint workspace_audit_target_type_check;
alter table case_app.workspace_audit add constraint workspace_audit_target_type_check
  check (target_type in ('workspace', 'case', 'version', 'room', 'member', 'group', 'checkpoint', 'candidate', 'asset',
    'invitation', 'grant'));
alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check
  check (action in ('workspace_create', 'case_create', 'draft_save', 'version_publish', 'version_withdraw', 'version_republish',
    'room_start', 'workspace_ownerless', 'member_invite', 'owner_assign', 'group_create', 'group_edit', 'group_archive', 'case_group',
    'draft_checkpoint_create', 'draft_checkpoint_delete', 'draft_checkpoint_restore', 'builder_candidate_submit',
    'builder_candidate_cancel', 'builder_candidate_approve', 'builder_candidate_delete', 'member_role', 'member_remove',
    'owner_transfer', 'asset_approve', 'asset_reject', 'asset_withdraw', 'case_archive',
    'case_grant', 'case_grant_revoke', 'invitation_create', 'invitation_resend', 'invitation_revoke', 'invitation_accept',
    'policy_set', 'quota_set', 'asset_delete_unused'));

-- One audit row by the actor's real kind: admin (with the verified email), owner, author or facilitator (a runner who
-- shares under runners_share, orchestrator ruling R2). Any other role raises, so a write that must be audited can never
-- be written unaudited by mistake.
create function case_app.audit_actor(p_workspace_id uuid, p_user_id uuid, p_admin_email text, p_role text, p_action text,
  p_target_type text, p_target_id uuid, p_revision bigint, p_elevation_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if p_role is null or p_role not in ('admin', 'owner', 'author', 'facilitator') then
    raise exception 'audit_actor_kind: %', p_role using errcode = '42501'; end if;
  insert into case_app.workspace_audit
    (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id, revision, elevation_id)
  values (p_workspace_id, p_role, p_user_id, case when p_role = 'admin' then p_admin_email end, p_action, p_target_type,
    p_target_id, p_revision, p_elevation_id);
end;
$$;

-- ─── 4. Case-level RPCs become case-aware (invariant 2; inventory §2) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION case_api.builder_get_draft(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(revision bigint, schema_version integer, document jsonb, authoring_metadata jsonb, updated_at timestamptz, intent_digest bytea)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  return query select d.revision,d.schema_version,d.document,d.authoring_metadata,d.updated_at,
      case_app.builder_intent_digest(d.document,d.authoring_metadata)::bytea
    from case_app.case_drafts d where d.case_id=p_case_id;
  if not found then return query select 0::bigint,null::integer,null::jsonb,null::jsonb,null::timestamptz,null::bytea; end if;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_open_save_window(p_case_id uuid, p_base_revision bigint, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(operation_id uuid, base_revision bigint, expires_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_id uuid; v_exp timestamptz; v_created timestamptz;
begin
  perform case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
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
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_get_save_receipt(p_case_id uuid, p_operation_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(operation_id uuid, base_revision bigint, revision bigint, intent_digest bytea, status text, committed_at timestamptz, expires_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  return query select r.operation_id,r.base_revision,r.revision,r.intent_digest::bytea,r.status,r.committed_at,r.expires_at from case_app.builder_save_receipts r
   where r.case_id=p_case_id and r.operation_id=p_operation_id and r.actor_id=p_user_id and r.expires_at>clock_timestamp();
  if found then return; end if;
  return query select w.operation_id,w.base_revision,null::bigint,null::bytea,
      case when w.expires_at>clock_timestamp() and w.used_at is null then 'issued' else 'expired' end,
      null::timestamptz,w.expires_at
    from case_app.builder_save_windows w where w.case_id=p_case_id and w.operation_id=p_operation_id and w.actor_id=p_user_id;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_save_draft(p_case_id uuid, p_operation_id uuid, p_document jsonb, p_authoring_metadata jsonb, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(operation_id uuid, revision bigint, intent_digest bytea, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_role text; w case_app.builder_save_windows%rowtype; old case_app.builder_save_receipts%rowtype; d case_app.case_drafts%rowtype; v_digest bytea; v_rev bigint; v_status text;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  if p_authoring_metadata is null or not case_app.builder_snapshot_ok(p_document,p_authoring_metadata) then raise exception 'invalid_builder_snapshot' using errcode='22023'; end if;
  v_digest:=case_app.builder_intent_digest(p_document,p_authoring_metadata);
  perform pg_advisory_xact_lock(4242,42);
  select * into old from case_app.builder_save_receipts r where r.operation_id=p_operation_id and r.case_id=p_case_id and r.actor_id=p_user_id;
  if found then
    if old.expires_at<=clock_timestamp() then raise exception 'receipt_expired' using errcode='P0002'; end if;
    if old.intent_digest<>v_digest or old.operation_kind<>'save' then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.operation_id,old.revision,old.intent_digest::bytea,old.status; return;
  end if;
  select * into w from case_app.builder_save_windows win where win.operation_id=p_operation_id and win.case_id=p_case_id and win.actor_id=p_user_id for update;
  if not found or w.expires_at<=clock_timestamp() or w.used_at is not null or w.operation_kind<>'save' then raise exception 'save_window_missing_or_expired' using errcode='P0002'; end if;
  if (select count(*) from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at>clock_timestamp())>=10000 or
     (select count(*) from case_app.builder_save_receipts r join case_app.cases c on c.id=r.case_id where c.workspace_id=v_ws and r.expires_at>clock_timestamp())>=100000 then
    raise exception 'builder_receipt_quota' using errcode='23514'; end if;
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into d from case_app.case_drafts where case_id=p_case_id for update;
  if (d.case_id is null and w.base_revision<>0) or (d.case_id is not null and d.revision<>w.base_revision) then raise exception 'revision_conflict' using errcode='40001'; end if;
  if not (d.case_id is not null and d.document=p_document and d.authoring_metadata is not distinct from p_authoring_metadata) then
    perform case_app.builder_assert_quota(v_ws,
      pg_column_size(p_document)+coalesce(pg_column_size(p_authoring_metadata),0)-
      case when d.case_id is null then 0 else pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0) end + 256);
    if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  else
    perform case_app.builder_assert_quota(v_ws,256);
  end if;
  if d.case_id is not null and d.document=p_document and d.authoring_metadata is not distinct from p_authoring_metadata then v_rev:=d.revision; v_status:='noop';
  elsif d.case_id is null then insert into case_app.case_drafts(case_id,revision,schema_version,document,authoring_metadata,updated_by,builder_managed)
       values(p_case_id,1,(p_document->>'schema_version')::integer,p_document,p_authoring_metadata,p_user_id,true) returning case_drafts.revision into v_rev; v_status:='saved';
  else update case_app.case_drafts current_draft set revision=current_draft.revision+1,schema_version=(p_document->>'schema_version')::integer,document=p_document,authoring_metadata=p_authoring_metadata,builder_managed=true,updated_by=p_user_id,updated_at=clock_timestamp()
       where current_draft.case_id=p_case_id returning current_draft.revision into v_rev; v_status:='saved'; end if;
  update case_app.builder_save_windows sw set used_at=clock_timestamp() where sw.operation_id=p_operation_id;
  insert into case_app.builder_save_receipts(operation_id,case_id,actor_id,base_revision,revision,intent_digest,status,operation_kind)
    values(p_operation_id,p_case_id,p_user_id,w.base_revision,v_rev,v_digest,v_status,'save');
  if v_status='saved' then
    update case_app.cases set updated_at=clock_timestamp() where id=p_case_id;
    if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_save','case',p_case_id,v_rev); end if;
  end if;
  perform case_app.link_draft_assets(p_user_id, v_role, p_case_id, p_document);
  return query select p_operation_id,v_rev,v_digest,v_status;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_list_checkpoints(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(id uuid, name text, revision bigint, schema_version integer, created_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  return query select c.id,c.name,c.revision,c.schema_version,c.created_at from case_app.builder_checkpoints c where c.case_id=p_case_id and c.deleted_at is null order by c.created_at,c.id;
end; $function$;

create or replace function case_api.builder_create_checkpoint(p_case_id uuid,p_name text,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(id uuid,name text,revision bigint,created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; d case_app.case_drafts%rowtype; v_id uuid; v_digest bytea; v_created timestamptz;
begin
  v_role:=case_app.authorize_case(p_user_id,p_case_id,'P-14',p_admin,p_admin_email);
  if not case_app.group_text_ok(p_name,60) then raise exception 'invalid_checkpoint_name' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  if (select count(*) from case_app.builder_checkpoints where case_id=p_case_id and deleted_at is null)>=3 then raise exception 'checkpoint_limit' using errcode='23514'; end if;
  select * into d from case_app.case_drafts where case_id=p_case_id;
  if not found then raise exception 'no_draft' using errcode='P0002'; end if;
  perform case_app.builder_assert_quota(v_ws,pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0));
  v_digest:=case_app.builder_intent_digest(d.document,d.authoring_metadata);
  insert into case_app.builder_checkpoints(case_id,workspace_id,name,revision,schema_version,document,authoring_metadata,intent_digest,created_by)
    values(p_case_id,v_ws,p_name,d.revision,d.schema_version,d.document,d.authoring_metadata,v_digest,p_user_id) returning builder_checkpoints.id,builder_checkpoints.created_at into v_id,v_created;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_checkpoint_create','checkpoint',v_id,d.revision); end if;
  return query select v_id,p_name,d.revision,v_created;
end; $$;

CREATE OR REPLACE FUNCTION case_api.builder_create_checkpoint(p_case_id uuid, p_name text, p_expected_revision bigint, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(id uuid, name text, revision bigint, created_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; v_revision bigint;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select d.revision into v_revision from case_app.case_drafts d where d.case_id=p_case_id;
  if p_expected_revision is null or p_expected_revision<1 or v_revision is distinct from p_expected_revision then
    raise exception 'revision_conflict' using errcode='40001';
  end if;
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  return query select * from case_api.builder_create_checkpoint(p_case_id,p_name,p_user_id,p_admin,p_admin_email);
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_delete_checkpoint(p_case_id uuid, p_checkpoint_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(deleted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; v_rev bigint;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  -- A user-requested checkpoint delete removes its snapshot bytes; the fixed-scalar audit row remains.
  delete from case_app.builder_checkpoints where id=p_checkpoint_id and case_id=p_case_id and deleted_at is null returning revision into v_rev;
  if not found then raise exception 'checkpoint_missing' using errcode='P0002'; end if;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_checkpoint_delete','checkpoint',p_checkpoint_id,v_rev); end if;
  return query select true;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_restore_checkpoint(p_case_id uuid, p_checkpoint_id uuid, p_operation_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(operation_id uuid, revision bigint, intent_digest bytea, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; w case_app.builder_save_windows%rowtype; old case_app.builder_save_receipts%rowtype;
  c case_app.builder_checkpoints%rowtype; d case_app.case_drafts%rowtype; v_digest bytea; v_rev bigint;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  -- Lost acknowledgement replay is receipt-only and remains possible after window expiry,
  -- but only for the same actor/case/checkpoint operation, while currently entitled.
  select * into old from case_app.builder_save_receipts r where r.operation_id=p_operation_id and r.case_id=p_case_id and r.actor_id=p_user_id;
  if found then
    if old.expires_at<=clock_timestamp() then raise exception 'receipt_expired' using errcode='P0002'; end if;
    if old.operation_kind<>'restore' or old.target_id<>p_checkpoint_id then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.operation_id,old.revision,old.intent_digest::bytea,old.status; return;
  end if;
  select * into w from case_app.builder_save_windows win where win.operation_id=p_operation_id and win.case_id=p_case_id and win.actor_id=p_user_id for update;
  if not found or w.expires_at<=clock_timestamp() or w.used_at is not null then raise exception 'save_window_missing_or_expired' using errcode='P0002'; end if;
  if (select count(*) from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at>clock_timestamp())>=10000 or
     (select count(*) from case_app.builder_save_receipts r join case_app.cases cs on cs.id=r.case_id where cs.workspace_id=v_ws and r.expires_at>clock_timestamp())>=100000 then
    raise exception 'builder_receipt_quota' using errcode='23514'; end if;
  perform 1 from case_app.cases cs where cs.id=p_case_id for update;
  select * into c from case_app.builder_checkpoints where id=p_checkpoint_id and case_id=p_case_id and deleted_at is null;
  if not found then raise exception 'checkpoint_missing' using errcode='P0002'; end if;
  select * into d from case_app.case_drafts where case_id=p_case_id for update;
  if (d.case_id is null and w.base_revision<>0) or (d.case_id is not null and d.revision<>w.base_revision) then raise exception 'revision_conflict' using errcode='40001'; end if;
  perform case_app.builder_assert_quota(v_ws,
    pg_column_size(c.document)+coalesce(pg_column_size(c.authoring_metadata),0)
    - case when d.case_id is null then 0 else pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0) end
    + 256);
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  if d.case_id is null then
    insert into case_app.case_drafts(case_id,revision,schema_version,document,authoring_metadata,updated_by,builder_managed)
      values(p_case_id,1,c.schema_version,c.document,c.authoring_metadata,p_user_id,true) returning case_drafts.revision into v_rev;
  else
    update case_app.case_drafts current_draft set revision=current_draft.revision+1,schema_version=c.schema_version,document=c.document,
      authoring_metadata=c.authoring_metadata,builder_managed=true,updated_by=p_user_id,updated_at=clock_timestamp() where current_draft.case_id=p_case_id returning current_draft.revision into v_rev;
  end if;
  v_digest:=c.intent_digest;
  update case_app.builder_save_windows sw set used_at=clock_timestamp(),operation_kind='restore',target_id=p_checkpoint_id where sw.operation_id=p_operation_id;
  insert into case_app.builder_save_receipts(operation_id,case_id,actor_id,base_revision,revision,intent_digest,status,operation_kind,target_id)
    values(p_operation_id,p_case_id,p_user_id,w.base_revision,v_rev,v_digest,'restored','restore',p_checkpoint_id);
  update case_app.cases set updated_at=clock_timestamp() where id=p_case_id;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_checkpoint_restore','checkpoint',p_checkpoint_id,v_rev); end if;
  perform case_app.link_draft_assets(p_user_id, v_role, p_case_id, c.document);
  return query select p_operation_id,v_rev,v_digest,'restored'::text;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_submit_candidate(p_case_id uuid, p_request_id uuid, p_expected_revision bigint, p_document jsonb, p_authoring_metadata jsonb, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, revision bigint, intent_digest bytea, content_sha256 bytea, status text, submitted_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; d case_app.case_drafts%rowtype; old case_app.builder_candidates%rowtype;
  v_intent case_app.sha256; v_content case_app.sha256; v_id uuid; v_at timestamptz;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  if p_request_id is null or substring(p_request_id::text,15,1)<>'7' or substring(p_request_id::text,20,1) not in ('8','9','a','b') then
    raise exception 'invalid_request_id' using errcode='22023'; end if;
  if p_expected_revision<1 or p_expected_revision>9007199254740991 or p_document is null or p_authoring_metadata is null or
     not case_app.builder_snapshot_ok(p_document,p_authoring_metadata) then raise exception 'invalid_builder_snapshot' using errcode='22023'; end if;
  v_intent:=case_app.builder_intent_digest(p_document,p_authoring_metadata);
  v_content:=sha256(convert_to(p_document::text,'UTF8'));
  perform pg_advisory_xact_lock(4242,42);
  select * into old from case_app.builder_candidates b where b.case_id=p_case_id and ((b.submitted_by=p_user_id and b.request_id=p_request_id) or exists(
    select 1 from case_app.builder_submission_receipts r where r.case_id=p_case_id and r.submitted_by=p_user_id and r.request_id=p_request_id and r.candidate_id=b.candidate_id));
  if found then
    if old.revision<>p_expected_revision or old.intent_digest<>v_intent or old.content_sha256<>v_content then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.candidate_id,old.revision,old.intent_digest::bytea,old.content_sha256::bytea,old.status,old.submitted_at; return;
  end if;
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or not d.builder_managed or d.revision<>p_expected_revision or d.document is distinct from p_document or
     d.authoring_metadata is distinct from p_authoring_metadata then raise exception 'revision_conflict' using errcode='40001'; end if;
  -- Reusing the exact snapshot must never supersede its approval, including a retry after release.
  select * into old from case_app.builder_candidates b where b.case_id=p_case_id and b.revision=p_expected_revision
    and b.intent_digest=v_intent and b.content_sha256=v_content and b.status in ('pending','approved','released')
    order by b.submitted_at desc limit 1;
  if found then
    if ((select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id)+(select count(*) from case_app.builder_candidates c where c.case_id=p_case_id))>=1000 then
      raise exception 'builder_candidate_history_limit' using errcode='23514';
    end if;
    perform case_app.builder_assert_quota(v_ws,128);
    insert into case_app.builder_submission_receipts(case_id,submitted_by,request_id,candidate_id)
      values(p_case_id,p_user_id,p_request_id,old.candidate_id);
    return query select old.candidate_id,old.revision,old.intent_digest::bytea,old.content_sha256::bytea,old.status,old.submitted_at; return;
  end if;
  if ((select count(*) from case_app.builder_candidates b where b.case_id=p_case_id)+(select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id))>=1000 then raise exception 'builder_candidate_history_limit' using errcode='23514'; end if;
  if not case_app.builder_sources_release_ready(p_document,p_authoring_metadata) then raise exception 'builder_review_metadata_unresolved' using errcode='23514'; end if;
  perform case_app.builder_supersede_active_candidate(p_case_id);
  perform case_app.builder_assert_quota(v_ws,pg_column_size(p_document)+pg_column_size(p_authoring_metadata)+512);
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  insert into case_app.builder_candidates(case_id,workspace_id,submitted_by,request_id,revision,schema_version,document,authoring_metadata,intent_digest,content_sha256,status)
    values(p_case_id,v_ws,p_user_id,p_request_id,p_expected_revision,(p_document->>'schema_version')::integer,p_document,p_authoring_metadata,v_intent,v_content,'pending')
    returning builder_candidates.candidate_id,builder_candidates.submitted_at into v_id,v_at;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_submit','candidate',v_id,p_expected_revision); end if;
  return query select v_id,p_expected_revision,v_intent::bytea,v_content::bytea,'pending'::text,v_at;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_list_candidates(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, revision bigint, status text, submitted_at timestamptz, approved_at timestamptz, released_version_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  return query select b.candidate_id,b.revision,b.status,b.submitted_at,b.approved_at,b.released_version_id
    from case_app.builder_candidates b where b.case_id=p_case_id order by b.submitted_at desc,b.candidate_id desc;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_cancel_candidate(p_case_id uuid, p_candidate_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, status text, revision bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; b case_app.builder_candidates%rowtype;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  if b.status in ('pending','approved') then
    -- Cancellation is explicit discard of this candidate payload; its identity and prior approval stay.
    update case_app.builder_candidates as target set status='cancelled',document=null,authoring_metadata=null,body_deleted_at=clock_timestamp(),ended_at=clock_timestamp()
      where target.candidate_id=p_candidate_id returning target.* into b;
    if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_cancel','candidate',p_candidate_id,b.revision); end if;
  end if;
  return query select b.candidate_id,b.status,b.revision;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_delete_candidate_body(p_case_id uuid, p_candidate_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, deleted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; b case_app.builder_candidates%rowtype; v_deleted boolean:=false;
begin
  v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  if b.status not in ('superseded','cancelled') then raise exception 'candidate_body_not_deletable' using errcode='42501'; end if;
  if b.document is not null then
    update case_app.builder_candidates as target set document=null,authoring_metadata=null,body_deleted_at=clock_timestamp() where target.candidate_id=p_candidate_id;
    v_deleted:=true;
    if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_delete','candidate',p_candidate_id,b.revision); end if;
  end if;
  return query select p_candidate_id,v_deleted;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.builder_get_review_candidate(p_case_id uuid, p_candidate_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, revision bigint, schema_version integer, document jsonb, authoring_metadata jsonb, intent_digest bytea, content_sha256 bytea, status text, submitted_by uuid, submitted_at timestamptz, approved_by uuid, approved_at timestamptz, approved_intent_digest bytea, approved_content_sha256 bytea, released_version_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_case(p_user_id, p_case_id,'P-33',p_admin,p_admin_email);
  return query select b.candidate_id,b.revision,b.schema_version,b.document,b.authoring_metadata,b.intent_digest::bytea,b.content_sha256::bytea,b.status,
    b.submitted_by,b.submitted_at,b.approved_by,b.approved_at,b.approved_intent_digest::bytea,b.approved_content_sha256::bytea,b.released_version_id
    from case_app.builder_candidates b where b.case_id=p_case_id and b.candidate_id=p_candidate_id;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.get_case_authoring_access(p_case_id uuid, p_user_id uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(case_id uuid, workspace_id uuid, role text, title text, source_version_id uuid, source_version_no integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text;
begin
  if v_ws is null then return; end if;
  begin
    v_role:=case_app.authorize_case(p_user_id, p_case_id,'P-14',p_admin,p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query select c.id,c.workspace_id,v_role,c.title,v.id,v.version_no
    from case_app.cases c left join lateral (
      select cv.id,cv.version_no from case_app.case_versions cv
      where cv.case_id=c.id and not exists(select 1 from case_app.admin_version_state av where av.case_version_id=cv.id and av.status='withdrawn') order by cv.version_no desc limit 1
    ) v on true where c.id=p_case_id and c.archived_at is null;
end; $function$;

CREATE OR REPLACE FUNCTION case_api.get_draft(p_case_id uuid, p_user_id uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(revision bigint, schema_version integer, document jsonb, updated_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  return query select d.revision, d.schema_version, d.document, d.updated_at
    from case_app.case_drafts d where d.case_id = p_case_id;
end;
$function$;

CREATE OR REPLACE FUNCTION case_api.save_draft(p_case_id uuid, p_expected_revision bigint, p_schema_version integer, p_document jsonb, p_user_id uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_rev bigint; v_ws uuid := case_app.workspace_of_case(p_case_id); v_role text; v_old_bytes bigint:=0; v_new_bytes bigint;
begin
  v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases cs where cs.id=p_case_id for update;
  select pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0) into v_old_bytes from case_app.case_drafts d where d.case_id=p_case_id for update;
  if exists (select 1 from case_app.case_drafts where case_id = p_case_id and builder_managed) then
    raise exception 'builder_draft_requires_paired_save' using errcode = '42501';
  end if;
  if p_schema_version <> 1 or p_document->>'schema_version' <> '1' then
    raise exception 'legacy_save_schema_mismatch' using errcode = '22023';
  end if;
  v_new_bytes:=pg_column_size(p_document);
  perform case_app.builder_assert_quota(v_ws,v_new_bytes-coalesce(v_old_bytes,0));
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  if p_expected_revision = 0 then
    insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
    values (p_case_id, 1, p_schema_version, p_document, p_user_id) on conflict (case_id) do nothing returning revision into v_rev;
  else
    update case_app.case_drafts set revision = revision + 1, schema_version = p_schema_version, document = p_document,
      updated_by = p_user_id, updated_at = now()
     where case_id = p_case_id and revision = p_expected_revision and authoring_metadata is null returning revision into v_rev;
  end if;
  if v_rev is null then raise exception 'revision_conflict' using errcode = '40001'; end if;
  update case_app.cases set updated_at = now() where id = p_case_id;
  if v_role = 'admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_save','case',p_case_id,v_rev); end if;
  perform case_app.link_draft_assets(p_user_id, v_role, p_case_id, p_document);
  return v_rev;
end;
$function$;

CREATE OR REPLACE FUNCTION case_api.get_catalogue_case(p_user_id uuid, p_case_id uuid, p_version_no integer, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text, audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer, published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title),
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
$function$;

CREATE OR REPLACE FUNCTION case_api.get_catalogue_case_current(p_user_id uuid, p_case_id uuid, p_version_no integer, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text, audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer, published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title),
           case_app.catalogue_text(v.document, 'summary', 1200),
           case_app.catalogue_text(v.document, 'audience', 200),
           case_app.catalogue_text(v.document, 'setting', 200),
           case_app.catalogue_duration_current(v.document),
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
$function$;

CREATE OR REPLACE FUNCTION case_api.get_catalogue_case_history(p_user_id uuid, p_case_id uuid, p_version_no integer, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text, audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer, published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title),
           case_app.catalogue_text(v.document, 'summary', 1200),
           case_app.catalogue_text(v.document, 'audience', 200),
           case_app.catalogue_text(v.document, 'setting', 200),
           case_app.catalogue_duration_current(v.document),
           case when jsonb_typeof(v.document -> 'learning_objectives') = 'array' then coalesce((
             select jsonb_agg(left(btrim(o.value #>> '{}'), 300) order by o.n)
               from jsonb_array_elements(v.document -> 'learning_objectives') with ordinality as o(value, n)
              where jsonb_typeof(o.value) = 'string' and btrim(o.value #>> '{}') <> '' and o.n <= 8), '[]'::jsonb)
             else '[]'::jsonb end,
           v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor,
           (select coalesce(jsonb_agg(jsonb_build_object('version_id', o.id, 'version_no', o.version_no,
                     'edition', exists(select 1 from case_app.publication_history h where h.version_id=o.id and h.new_edition),
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
$function$;

CREATE OR REPLACE FUNCTION case_api.case_feedback_summary(p_user_id uuid, p_case_id uuid, p_version_no integer, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare v_version uuid; v_workspace uuid;
begin
  select v.id, c.workspace_id into v_version, v_workspace from case_app.case_versions v join case_app.cases c on c.id = v.case_id
   where c.id = p_case_id and v.version_no = p_version_no;
  if not found then raise exception 'version_not_found' using errcode = 'P0002'; end if;
  perform case_app.authorize_case(p_user_id, p_case_id, 'P-38', p_admin, p_admin_email);
  return jsonb_set(case_app.feedback_case_body(v_version), '{case,workspaceId}', to_jsonb(v_workspace));
end;
$function$;

CREATE OR REPLACE FUNCTION case_api.get_case_version_for_workspace(p_version_id uuid, p_workspace_id uuid, p_user_id uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(case_id uuid, version_no integer, schema_version integer, document jsonb, document_text text, content_sha256 bytea, art jsonb, tint text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Preserve the deployed Worker's empty/404 contract for missing and foreign versions.
  -- A matching version still requires access to that exact case, including for grant-only callers.
  perform case_app.authorize_records(p_user_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  if not exists (select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
                 where v.id = p_version_id and c.workspace_id = p_workspace_id) then return; end if;
  perform case_app.authorize_case(p_user_id, case_app.case_of_version(p_version_id), 'P-21', p_admin, p_admin_email);
  return query select v.case_id, v.version_no, v.schema_version,
    v.document, v.document::text, v.content_sha256::bytea, a.descriptor, coalesce(g.tint, 'neutral')
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
    left join case_app.case_groups g on g.id = c.group_id
    left join case_app.case_version_art a on a.case_version_id = v.id
    where v.id = p_version_id and c.workspace_id = p_workspace_id and
      not exists (select 1 from case_app.admin_version_state av
        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$function$;

CREATE OR REPLACE FUNCTION case_api.room_media_manifest(p_version_id uuid, p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(asset_id uuid, status text, width integer, height integer, attribution text, display_key text, phone_key text, poster_key text, media_type text, duration_ms integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
begin
  -- Preserve the deployed Worker's empty/404 contract for missing and foreign versions.
  -- A matching version still requires access to that exact case, including for grant-only callers.
  perform case_app.authorize_records(p_user_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  if not exists (select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
                 where v.id = p_version_id and c.workspace_id = p_workspace_id) then return; end if;
  perform case_app.authorize_case(p_user_id, case_app.case_of_version(p_version_id), 'P-21', p_admin, p_admin_email);
  return query select a.id, a.status, a.width, a.height, a.attribution, d.r2_key, ph.r2_key, po.r2_key, a.media_type, a.duration_ms
    from case_app.case_version_assets cva
    join case_app.case_versions v on v.id = cva.case_version_id
    join case_app.cases c on c.id = v.case_id
    join case_app.assets a on a.id = cva.asset_id
    left join case_app.asset_renditions d on d.asset_id = a.id and d.rendition = 'display'
    left join case_app.asset_renditions ph on ph.asset_id = a.id and ph.rendition = 'phone'
    left join case_app.asset_renditions po on po.asset_id = a.id and po.rendition = 'poster'
    where cva.case_version_id = p_version_id and c.workspace_id = p_workspace_id and a.workspace_id = p_workspace_id and a.kind in ('image', 'video')
    order by a.id;
end;
$function$;

-- ─── 5. Case-aware rewrites with behaviour changes (inventory §2-§3) ─────────────────────────────────────────
-- P-33 approve: case-aware (an owner, or an author of the workspace or this case under editors_publish); audited by real kind.
CREATE OR REPLACE FUNCTION case_api.builder_approve_candidate(p_case_id uuid, p_candidate_id uuid, p_expected_revision bigint, p_intent_digest bytea, p_content_sha256 bytea, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, revision bigint, status text, approved_at timestamptz, intent_digest bytea, content_sha256 bytea)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); b case_app.builder_candidates%rowtype; d case_app.case_drafts%rowtype; v_at timestamptz; v_role text;
begin
  v_role:=case_app.authorize_case(p_user_id,p_case_id,'P-33',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  if b.revision<>p_expected_revision or b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 then raise exception 'candidate_digest_conflict' using errcode='40001'; end if;
  if b.approved_at is not null then
    if b.approved_intent_digest<>b.intent_digest or b.approved_content_sha256<>b.content_sha256 then raise exception 'candidate_approval_corrupt' using errcode='23514'; end if;
    return query select b.candidate_id,b.revision,b.status,b.approved_at,b.intent_digest::bytea,b.content_sha256::bytea; return;
  end if;
  if b.status<>'pending' or b.document is null or not case_app.builder_sources_release_ready(b.document,b.authoring_metadata) then raise exception 'candidate_not_reviewable' using errcode='23514'; end if;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or d.revision<>b.revision or d.document is distinct from b.document or d.authoring_metadata is distinct from b.authoring_metadata then raise exception 'candidate_stale' using errcode='40001'; end if;
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  update case_app.builder_candidates as target set status='approved',approved_by=p_user_id,approved_at=clock_timestamp(),
    approved_intent_digest=b.intent_digest,approved_content_sha256=b.content_sha256 where target.candidate_id=p_candidate_id returning target.approved_at into v_at;
  perform case_app.audit_actor(v_ws,p_user_id,p_admin_email,v_role,'builder_candidate_approve','candidate',p_candidate_id,b.revision,null);
  return query select p_candidate_id,b.revision,'approved'::text,v_at,b.intent_digest::bytea,b.content_sha256::bytea;
end; $function$;

-- P-15 release: case-aware, audited by real kind; image approval removed (CASE-342): only a taken-down or missing image refuses.
CREATE OR REPLACE FUNCTION case_api.builder_release_candidate(p_case_id uuid, p_candidate_id uuid, p_expected_revision bigint, p_intent_digest bytea, p_content_sha256 bytea, p_asset_ids uuid[], p_art jsonb, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, version_id uuid, version_no integer, content_sha256 bytea, intent_digest bytea, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); b case_app.builder_candidates%rowtype; d case_app.case_drafts%rowtype;
  v_no integer; v_id uuid; v_content case_app.sha256; v_release case_app.sha256; v_bad integer; v_delta bigint;
  v_assets uuid[]; v_role text; v_scope text;
begin
  v_role:=case_app.authorize_case(p_user_id,p_case_id,'P-15',p_admin,p_admin_email);
  select e.scope into v_scope from case_app.effective_role(p_user_id,v_ws,p_case_id) e;
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  select array_agg(distinct a order by a) into v_assets from unnest(coalesce(p_asset_ids,'{}')) a;
  v_release:=sha256(convert_to('builder-release-v1'||E'\n'||jsonb_build_object('candidate_id',p_candidate_id,'asset_ids',coalesce(to_jsonb(v_assets),'[]'::jsonb),'art',p_art)::text,'UTF8'));
  if b.status='released' then
    if b.released_version_id is null or b.release_digest<>v_release or b.revision<>p_expected_revision or
       b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 then raise exception 'release_replay_changed' using errcode='23514'; end if;
    return query select b.candidate_id,v.id,v.version_no,v.content_sha256::bytea,b.intent_digest::bytea,'released'::text
      from case_app.case_versions v where v.id=b.released_version_id; return;
  end if;
  if b.status<>'approved' or b.document is null or b.revision<>p_expected_revision or b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 or
     b.approved_intent_digest<>b.intent_digest or b.approved_content_sha256<>b.content_sha256 then raise exception 'candidate_not_releasable' using errcode='23514'; end if;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or d.revision<>b.revision or d.document is distinct from b.document or d.authoring_metadata is distinct from b.authoring_metadata then raise exception 'candidate_stale' using errcode='40001'; end if;
  if not case_app.builder_sources_release_ready(b.document,b.authoring_metadata) then raise exception 'builder_review_metadata_unresolved' using errcode='23514'; end if;
  if p_art is null or not case_app.art_shape_ok(p_art) or (p_art-'attempt'-'summarised'-'renderer')<>case_app.art_structure(b.document) then raise exception 'art_mismatch' using errcode='22023'; end if;
  if cardinality(coalesce(p_asset_ids,'{}'))<>cardinality(coalesce(v_assets,'{}')) then raise exception 'duplicate_asset' using errcode='22023'; end if;
  select count(*) into v_bad from unnest(coalesce(v_assets,'{}')) a(id) join case_app.assets s on s.id=a.id where s.workspace_id<>v_ws;
  if v_bad>0 then raise exception 'asset_not_in_workspace: % asset(s)',v_bad using errcode='23514'; end if;
  select count(*) into v_bad from unnest(coalesce(v_assets,'{}')) a(id) left join case_app.assets s on s.id=a.id where s.id is null or s.status not in ('quarantined','approved');
  if v_bad>0 then raise exception 'asset_unavailable: % asset(s)',v_bad using errcode='23514'; end if;
  -- Plan §0.5: a releaser who holds this case only by a grant may release only this case's images.
  if v_role<>'admin' and v_scope='case' and exists (select 1 from unnest(coalesce(v_assets,'{}')) a(id)
      where not exists (select 1 from case_app.case_assets ca where ca.asset_id=a.id and ca.case_id=p_case_id)) then
    raise exception 'asset_unavailable: not this case''s image' using errcode='23514'; end if;
  -- The candidate body moves into case_versions (net document bytes cancel); private metadata is
  -- removed and the immutable version's descriptor is newly retained.
  v_delta:=-coalesce(pg_column_size(b.authoring_metadata),0)+pg_column_size(p_art);
  perform case_app.builder_assert_quota(v_ws,v_delta);
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  select coalesce(max(v.version_no),0)+1 into v_no from case_app.case_versions v where v.case_id=p_case_id;
  v_content:=sha256(convert_to(b.document::text,'UTF8'));
  insert into case_app.case_versions(case_id,version_no,schema_version,document,content_sha256,published_by)
    values(p_case_id,v_no,b.schema_version,b.document,v_content,p_user_id) returning id into v_id;
  insert into case_app.case_version_assets(case_version_id,asset_id) select v_id,a.id from unnest(coalesce(v_assets,'{}')) a(id) on conflict do nothing;
  set constraints case_app.case_versions_asset_set immediate;
  set constraints case_app.case_versions_asset_set deferred;
  insert into case_app.case_version_art(case_version_id,descriptor,renderer_version) values(v_id,p_art,(p_art->>'renderer')::integer);
  update case_app.builder_candidates as target set status='released',document=null,authoring_metadata=null,body_deleted_at=clock_timestamp(),
    released_version_id=v_id,release_digest=v_release,released_at=clock_timestamp() where target.candidate_id=p_candidate_id;
  update case_app.cases as target set updated_at=clock_timestamp() where target.id=p_case_id;
  insert into case_app.case_assets(asset_id,case_id,linked_by) select a.id,p_case_id,p_user_id from unnest(coalesce(v_assets,'{}')) a(id) on conflict do nothing;
  perform case_app.audit_actor(v_ws,p_user_id,p_admin_email,v_role,'version_publish','version',v_id,v_no::bigint,null);
  return query select p_candidate_id,v_id,v_no,v_content::bytea,b.intent_digest::bytea,'released'::text;
end; $function$;

-- P-14 readiness: case-aware; asset_not_approved now reports only a missing, foreign or taken-down image (CASE-342).
CREATE OR REPLACE FUNCTION case_api.builder_publication_readiness(p_case_id uuid, p_expected_revision bigint, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ws uuid:=case_app.workspace_of_case(p_case_id); d case_app.case_drafts%rowtype; b case_app.builder_candidates%rowtype; delta bigint; release_delta bigint;
begin
  perform case_app.authorize_case(p_user_id,p_case_id,'P-14',p_admin,p_admin_email);
  select * into d from case_app.case_drafts where case_id=p_case_id;
  if not found or not d.builder_managed or d.revision<>p_expected_revision then return query select 'revision_conflict'::text; return; end if;
  if not case_app.builder_sources_release_ready(d.document,d.authoring_metadata) then return query select 'builder_review_metadata_unresolved'::text; end if;
  select * into b from case_app.builder_candidates c where c.case_id=p_case_id and c.revision=d.revision
    and c.intent_digest=case_app.builder_intent_digest(d.document,d.authoring_metadata) and c.status in ('pending','approved','released') order by c.submitted_at desc limit 1;
  if b.status='released' then return; end if;
  release_delta:=greatest(0,-pg_column_size(d.authoring_metadata)+pg_column_size(case_app.art_structure(d.document)||'{"attempt":0,"summarised":false,"renderer":1}'::jsonb));
  if b.candidate_id is null then
    if ((select count(*) from case_app.builder_candidates c where c.case_id=p_case_id)+(select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id))>=1000 then return query select 'builder_candidate_history_limit'::text; end if;
    if (select count(*) from case_app.builder_candidates c where c.case_id=p_case_id and c.status in ('superseded','cancelled') and c.document is not null)>=3 then return query select 'builder_retained_candidate_limit'::text; end if;
    delta:=pg_column_size(d.document)+pg_column_size(d.authoring_metadata)+512+release_delta;
  else delta:=release_delta; end if;
  if case_app.builder_usage_bytes(ws)+delta>104857600 or case_app.builder_usage_bytes(null)+delta>262144000 then return query select 'builder_storage_quota'::text; end if;
  if exists(select 1 from (
    select jsonb_array_elements_text(s->'asset_ids')::uuid id from jsonb_array_elements(coalesce(d.document->'surfaces','[]')) s
    union select (x->>'asset_id')::uuid from jsonb_array_elements(coalesce(d.document->'blocks','[]')) x where x->>'type'='image'
  ) refs left join case_app.assets a on a.id=refs.id where a.id is null or a.status not in ('quarantined','approved') or a.workspace_id<>ws) then return query select 'asset_not_approved'::text; end if;
end; $function$;

-- P-21 start a room: case-aware, the case derived from the version (still bound to p_workspace_id below).
CREATE OR REPLACE FUNCTION case_api.create_session(p_session_id uuid, p_case_version_id uuid, p_workspace_id uuid, p_facilitator_id uuid, p_join_code text, p_ttl interval DEFAULT '12:00:00'::interval, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_role text;
begin
  if p_session_id is null or p_session_id::text !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'session_id_must_be_uuidv7' using errcode = '23514';
  end if;
  v_role := case_app.authorize_case(p_facilitator_id, case_app.case_of_version(p_case_version_id), 'P-21', p_admin, p_admin_email);
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
$function$;

-- P-34 per-room read: case-aware (case from the session's version); owners read every room under managers_see_records.
CREATE OR REPLACE FUNCTION case_api.read_session_portfolio(p_user_id uuid, p_session_id uuid, p_after bigint, p_boundary text, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare s case_app.sessions; v case_app.case_versions; role text; boundary text; hi bigint; n bigint; rounds_digest text; items jsonb; next_after bigint;
begin
 select * into s from case_app.sessions where id=p_session_id;
 if not found then raise exception 'session_not_found' using errcode='P0002';end if;
 role:=case_app.authorize_case(p_user_id, case_app.case_of_version(s.case_version_id), 'P-34',p_admin,p_admin_email);
 if role<>'admin' and s.facilitator_id is distinct from p_user_id and not (role='owner' and case_app.policy_allows('P-34','owner',case_app.policies_of(s.workspace_id))) then raise exception 'not_starter' using errcode='42501'; end if;
 if p_after is null or p_after<0 or p_after>1010000 or (p_after>0 and p_boundary is null) then raise exception 'invalid_record_cursor' using errcode='22023';end if;
 select * into v from case_app.case_versions where id=s.case_version_id;
 select coalesce(max(seq),0),count(*) into hi,n from case_app.session_events where session_id=s.id;
 if hi>1000000 or (select count(*) from case_app.session_rounds where session_id=s.id)>10000 then raise exception 'record_budget' using errcode='23514';end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.id)::text,'[]'),'UTF8')),'hex') into rounds_digest from case_app.session_rounds r where session_id=s.id;
 boundary:=encode(sha256(convert_to(jsonb_build_array(s.id,s.case_version_id,s.status,s.started_at,s.ended_at,s.expires_at,s.portfolio_manifest,hi,n,rounds_digest)::text,'UTF8')),'hex');
 if p_boundary is not null and p_boundary<>boundary then raise exception 'record_changed' using errcode='40001';end if;
 select coalesce(jsonb_agg(value order by position),'[]'),max(position) into items,next_after from (
 select * from (
  select e.seq position,jsonb_build_object('type','event','position',e.seq,'seq',e.seq,'eventId',e.event_id,'epoch',e.epoch,'kind',e.kind,'at',e.occurred_at,'payload',jsonb_strip_nulls(jsonb_build_object('decisionId',e.payload->'decisionId','pathId',e.payload->'pathId','beatId',e.payload->'beatId','checkpointBeatId',e.payload->'checkpointBeatId','roundId',e.payload->'roundId','sourceRoundId',e.payload->'sourceRoundId','targetEventId',e.payload->'targetEventId','occurrenceId',e.payload->'occurrenceId','contextOccurrenceId',e.payload->'contextOccurrenceId','restoresOccurrenceId',e.payload->'restoresOccurrenceId','segmentId',e.payload->'segmentId','clarificationId',e.payload->'clarificationId','groupsShown',e.payload->'groupsShown','markerNo',e.payload->'markerNo','total',e.payload->'total','resolutionKind',e.payload->'resolutionKind','mode',e.payload->'mode','actionKind',e.payload->'actionKind','roundNo',e.payload->'roundNo','status',e.payload->'status','confirmed',e.payload->'confirmed','publication',case when jsonb_typeof(e.payload->'publication')='object' then jsonb_strip_nulls(jsonb_build_object('occurrenceId',e.payload->'publication'->'occurrenceId','surfaceId',e.payload->'publication'->'surfaceId','beatId',e.payload->'publication'->'beatId','checkpointOf',e.payload->'publication'->'checkpointOf','correctionOf',e.payload->'publication'->'correctionOf','restoresOccurrenceId',e.payload->'publication'->'restoresOccurrenceId','groupsShown',e.payload->'publication'->'groupsShown','manual',e.payload->'publication'->'manual')) else null end))) value from case_app.session_events e where e.session_id=s.id and e.kind not in ('participant_joined','participant_renamed','participant_removed','response_recorded')
  union all
  select hi+row_number() over(order by r.round_no,r.id),jsonb_build_object('type','round','position',hi+row_number() over(order by r.round_no,r.id),'id',r.id,'decisionId',r.decision_id,'number',r.round_no,'status',r.status,'openedAt',r.opened_at,'closedAt',r.closed_at,'aggregate',r.aggregate,'pathId',r.selected_path_id,'resolution',r.resolution_kind) from case_app.session_rounds r where r.session_id=s.id
 ) all_items where position>p_after order by position limit 100) page;
 return jsonb_build_object('session',jsonb_build_object('id',s.id,'workspaceId',s.workspace_id,'caseId',v.case_id,'versionId',v.id,'versionNo',v.version_no,'digest',encode(v.content_sha256,'hex'),'title',coalesce(v.document->>'title',(select title from case_app.cases where id=v.case_id)),
 'status',s.status,'sourceStatus',coalesce((select status from case_app.admin_version_state where case_version_id=v.id),'published'),'createdAt',s.created_at,'startedAt',s.started_at,'endedAt',s.ended_at,'expiresAt',s.expires_at,'own',s.facilitator_id=p_user_id,'manifest',s.portfolio_manifest),
 'interpretationLimited',exists(select 1 from case_app.session_events e where e.session_id=s.id and (
 e.kind not in ('beat_entered','responses_opened','responses_locked','path_selected','selection_cleared','consequence_revealed','teaching_corrected','clarification_shown','clarification_returned','recovery_confirmation','checkpoint_reset','discussion_paused','discussion_resumed','manual_entered','manual_marker','manual_exited','room_ended','round_closed','participant_joined','participant_renamed','participant_removed','response_recorded','names_shown','results_shown','results_page','ranked_page','timer_set','lobby_shown','facilitator_takeover','joining_closed','presentation_group_revealed',
 'debrief_started','debrief_left','media_control','responses_closing','lock_cancelled','auto_lock_set','music_set')
 or (e.kind in ('beat_entered','consequence_revealed') and coalesce(e.payload->'publication'->>'occurrenceId','')='')
 or (e.payload->>'decisionId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'decisions') d where d->>'id'=e.payload->>'decisionId'))
 or (e.payload->>'pathId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'decisions') d cross join lateral jsonb_array_elements(d->'paths') p where d->>'id'=e.payload->>'decisionId' and p->>'id'=e.payload->>'pathId'))
 or (e.payload->>'beatId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'beats') b where b->>'id'=e.payload->>'beatId'))
 or (e.payload->>'checkpointBeatId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'beats') b where b->>'id'=e.payload->>'checkpointBeatId'))
 )) or exists(select 1 from case_app.session_rounds r where r.session_id=s.id and (
 not exists(select 1 from jsonb_array_elements(v.document->'decisions') d where d->>'id'=r.decision_id::text)
 or (r.selected_path_id is not null and not exists(select 1 from jsonb_array_elements(v.document->'decisions') d cross join lateral jsonb_array_elements(d->'paths') p where d->>'id'=r.decision_id::text and p->>'id'=r.selected_path_id::text))
 )), 'boundary',boundary,'document',v.document,'items',items,'nextPosition',case when jsonb_array_length(items)=100 then next_after else null end,'eventCount',n,'maxSeq',hi);
end;$function$;

-- P-34 per-room read: case-aware (case from the session's version); owners read every room under managers_see_records.
CREATE OR REPLACE FUNCTION case_api.session_media_rendition(p_user_id uuid, p_session_id uuid, p_asset_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(status text, r2_key text, byte_size integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare s case_app.sessions; role text;
begin
  select * into s from case_app.sessions where id = p_session_id;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  role := case_app.authorize_case(p_user_id, case_app.case_of_version(s.case_version_id), 'P-34', p_admin, p_admin_email);
  if role<>'admin' and s.facilitator_id is distinct from p_user_id and not (role='owner' and case_app.policy_allows('P-34','owner',case_app.policies_of(s.workspace_id))) then raise exception 'not_starter' using errcode='42501'; end if;
  return query select a.status, case when a.status in ('quarantined', 'approved') then r.r2_key end, r.byte_size
    from case_app.case_version_assets cva
    join case_app.assets a on a.id = cva.asset_id and a.workspace_id = s.workspace_id
    join case_app.asset_renditions r on r.asset_id = a.id and r.rendition = case when a.media_type = 'image/jpeg' then 'phone' else 'poster' end
    where cva.case_version_id = s.case_version_id and cva.asset_id = p_asset_id and a.kind in ('image', 'video');
end;
$function$;

-- P-37 per-room read: case-aware (case from the session's version); owners read every room under managers_see_records.
CREATE OR REPLACE FUNCTION case_api.session_feedback_summary(p_user_id uuid, p_session_id uuid, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare s case_app.sessions; v_role text; v_body jsonb;
begin
  select * into s from case_app.sessions where id = p_session_id;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  v_role := case_app.authorize_case(p_user_id, case_app.case_of_version(s.case_version_id), 'P-37', p_admin, p_admin_email);
  if v_role<>'admin' and s.facilitator_id is distinct from p_user_id and not (v_role='owner' and case_app.policy_allows('P-37','owner',case_app.policies_of(s.workspace_id))) then raise exception 'not_starter' using errcode='42501'; end if;
  v_body := case_app.feedback_session_body(s.id);
  -- The Worker rechecks the workspace role and the starter flag (W), then drops both before the client sees the result.
  return jsonb_set(jsonb_set(v_body, '{session,workspaceId}', to_jsonb(s.workspace_id)), '{session,own}', to_jsonb(s.facilitator_id = p_user_id));
end;
$function$;

-- P-32 history list: members as before, owners see every room under managers_see_records, case-only runners their own rooms of cases they hold.
CREATE OR REPLACE FUNCTION case_api.list_room_history(p_user_id uuid, p_workspace_id uuid, p_filter text, p_limit integer, p_after_at timestamptz, p_after_id uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(session_id uuid, case_version_id uuid, title text, version_no integer, status text, created_at timestamptz, started_at timestamptz, ended_at timestamptz, expires_at timestamptz, archive_state text, own boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_role text; v_member boolean; v_all boolean;
begin
 v_role:=case_app.authorize_records(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 v_member:=v_role='admin' or case_app.member_role(p_user_id,p_workspace_id) is not null;
 v_all:=v_role='admin' or (v_role='owner' and case_app.policy_allows('P-32','owner',case_app.policies_of(p_workspace_id)));
 if p_filter is null or p_filter not in ('running','ended','all') or p_limit is null or p_limit<1 or p_limit>100
    or (p_after_at is null)<>(p_after_id is null) or (p_after_at is not null and not isfinite(p_after_at)) then
  raise exception 'invalid_history_page' using errcode='22023';
 end if;
 -- An anchor must still be visible to this actor in the exact workspace/filter. It carries no grant.
 if p_after_id is not null and not exists (
  select 1 from case_app.sessions s where s.id=p_after_id and s.created_at=p_after_at
   and s.workspace_id=p_workspace_id and case_app.record_visible(p_user_id,v_member,v_all,s.facilitator_id,(select cv.case_id from case_app.case_versions cv where cv.id=s.case_version_id))
   and ((p_filter in ('running','all') and s.status in ('lobby','live') and s.ended_at is null and s.expires_at>now())
     or (p_filter in ('ended','all') and s.status in ('ended','expired')))
 ) then raise exception 'invalid_history_cursor' using errcode='22023'; end if;
 return query
 select s.id,s.case_version_id,coalesce(v.document->>'title',c.title),v.version_no,s.status,
   s.created_at,s.started_at,s.ended_at,s.expires_at,'pending'::text,s.facilitator_id=p_user_id
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id
 join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and case_app.record_visible(p_user_id,v_member,v_all,s.facilitator_id,v.case_id)
  and ((p_filter in ('running','all') and s.status in ('lobby','live') and s.ended_at is null and s.expires_at>now())
    or (p_filter in ('ended','all') and s.status in ('ended','expired')))
  and (p_after_id is null or (s.created_at,s.id)<(p_after_at,p_after_id))
 order by s.created_at desc,s.id desc limit p_limit;
end;
$function$;

-- P-32 record search: as list_room_history.
CREATE OR REPLACE FUNCTION case_api.query_session_portfolio(p_user_id uuid, p_workspace_id uuid, p_query text, p_status text, p_from timestamptz, p_until timestamptz, p_after uuid, p_personal boolean, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare role text; items jsonb; v_member boolean; v_all boolean;
begin
 role:=case_app.authorize_records(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 v_member:=role='admin' or case_app.member_role(p_user_id,p_workspace_id) is not null;
 v_all:=role='admin' or (role='owner' and case_app.policy_allows('P-32','owner',case_app.policies_of(p_workspace_id)));
 if p_query is null or length(p_query)>200 or p_query~'[[:cntrl:]]' or p_status is null or p_status not in ('all','running','ended') or p_personal is null or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until)) or p_from>=p_until then raise exception 'invalid_portfolio_query' using errcode='22023';end if;
 if p_after is not null and not exists(select 1 from case_app.sessions x where x.id=p_after and x.workspace_id=p_workspace_id and case_app.record_visible(p_user_id,v_member,v_all and not p_personal,x.facilitator_id,case_app.case_of_version(x.case_version_id))) then raise exception 'invalid_cursor' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into items from (
 select s.id,s.case_version_id,c.id case_id,coalesce(v.document->>'title',c.title) title,v.version_no,s.status,s.created_at,s.started_at,s.ended_at,s.expires_at,
  case when s.portfolio_manifest is not null then 'complete' when s.status in ('ended','expired') then 'limited' else 'pending' end archive_state,s.facilitator_id=p_user_id own
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and case_app.record_visible(p_user_id,v_member,v_all and not p_personal,s.facilitator_id,c.id) and (p_after is null or s.id<p_after)
  and position(lower(p_query) in lower(coalesce(v.document->>'title',c.title)))>0
  and (p_status='all' or p_status='running' and s.status in ('lobby','live') and s.expires_at>now() or p_status='ended' and (s.status in ('ended','expired') or s.expires_at<=now()))
  and (p_from is null or s.created_at>=p_from) and (p_until is null or s.created_at<p_until)
 order by s.id desc limit 20) r;
 return jsonb_build_object('rooms',items,'nextAfter',case when jsonb_array_length(items)=20 then items->19->>'id' else null end);
end;$function$;

-- P-32 personal stats: own rooms; a case-only runner counts own rooms of cases they hold.
CREATE OR REPLACE FUNCTION case_api.personal_portfolio_stats(p_user_id uuid, p_workspace_id uuid, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare result jsonb; v_role text; v_member boolean;
begin
 v_role:=case_app.authorize_records(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 v_member:=v_role='admin' or case_app.member_role(p_user_id,p_workspace_id) is not null;
 select jsonb_build_object('asOf',now(),'firstSessionAt',min(created_at),'sessions',count(*),'active',count(*) filter(where status in ('lobby','live') and expires_at>now()),
 'ended',count(*) filter(where status in ('ended','expired') or expires_at<=now()),'completeRecords',count(*) filter(where portfolio_manifest is not null),'uniqueVersions',count(distinct case_version_id),
 'recordedTeachingSeconds',coalesce(sum(greatest(0,extract(epoch from least(ended_at,expires_at)-started_at))) filter(where ended_at is not null and started_at is not null),0)::bigint)
 into result from case_app.sessions x where x.workspace_id=p_workspace_id and case_app.record_visible(p_user_id,v_member,false,x.facilitator_id,case_app.case_of_version(x.case_version_id));
 return result;
end;$function$;

-- Own live rooms: the caller's own rooms while a membership or a live grant on the room's case remains.
CREATE OR REPLACE FUNCTION case_api.list_owned_active_sessions(p_user_id uuid, p_limit integer DEFAULT 100, p_after uuid DEFAULT NULL::uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(session_id uuid, join_code text, expires_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
       and (v_admin or case_app.member_role(p_user_id, s.workspace_id) is not null
            or case_app.grant_role(p_user_id, case_app.case_of_version(s.case_version_id)) is not null)
       and (p_after is null or (s.created_at, s.id) < (v_after_at, p_after))
     order by s.created_at desc, s.id desc
     limit v_limit;
end;
$function$;

-- P-42 archive: also ends the case's grants and pending invitations (audited).
CREATE OR REPLACE FUNCTION case_api.builder_archive_case(p_case_id uuid, p_user_id uuid, p_confirm_title text, p_admin boolean, p_admin_email text)
 RETURNS TABLE(case_id uuid, outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_title text; v_role text;
begin
  -- Authorise first: an unentitled caller learns nothing about whether the case exists (a missing case has no workspace).
  v_role := case_app.authorize(p_user_id, v_ws, 'P-42', p_admin, p_admin_email);
  perform 1 from case_app.cases c where c.id = p_case_id and c.archived_at is null for update;
  if not found then raise exception 'no_such_case' using errcode = 'P0002'; end if;
  select coalesce(case_app.catalogue_text(d.document, 'title', 200), '') into v_title
    from (select 1) one left join case_app.case_drafts d on d.case_id = p_case_id;
  if exists (select 1 from case_app.case_versions v where v.case_id = p_case_id) then
    return query select p_case_id, 'published'::text; return; end if;
  if exists (select 1 from case_app.builder_candidates b where b.case_id = p_case_id and b.status in ('pending', 'approved')) then
    return query select p_case_id, 'in_review'::text; return; end if;
  if p_confirm_title is distinct from v_title then
    return query select p_case_id, 'title_mismatch'::text; return; end if;
  update case_app.cases c set archived_at = now(), updated_at = now() where c.id = p_case_id;
  insert into case_app.workspace_audit (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id)
  values (v_ws, case when v_role = 'admin' then 'admin' else 'owner' end, p_user_id,
          case when v_role = 'admin' then p_admin_email end, 'case_archive', 'case', p_case_id);
  insert into case_app.workspace_audit (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id)
  select v_ws, case when v_role = 'admin' then 'admin' else 'owner' end, p_user_id, case when v_role = 'admin' then p_admin_email end,
         'case_grant_revoke', 'grant', g.id from case_app.case_grants g where g.case_id = p_case_id and g.revoked_at is null;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  update case_app.case_grants g set revoked_at = clock_timestamp(), revoked_by = p_user_id, updated_at = clock_timestamp()
   where g.case_id = p_case_id and g.revoked_at is null;
  update case_app.invitations i set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id
   where i.case_id = p_case_id and i.status = 'pending';
  return query select p_case_id, 'archived'::text;
end;
$function$;

-- Admin only: P-03's owner policy cell (CASE-337/338) does not reach this deployment RPC.
CREATE OR REPLACE FUNCTION case_api.admin_workspace_query(p_user_id uuid, p_workspace_id uuid, p_tab text, p_query text, p_status text, p_from timestamptz, p_until timestamptz, p_after uuid, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare v_rows jsonb; v_revision bigint; v_name text;
begin
  perform case_app.authorize_admin(p_user_id, 'P-03', p_admin, p_admin_email);
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
end; $function$;

-- Admin only: P-03's owner policy cell (CASE-337/338) does not reach this deployment RPC.
CREATE OR REPLACE FUNCTION case_api.admin_provision_facilitator(p_user_id uuid, p_workspace_id uuid, p_actor_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize_admin(p_actor_user_id, 'P-03', p_admin, p_admin_email);
  perform case_app.authorize(p_actor_user_id, p_workspace_id, 'P-03', p_admin, p_admin_email);
  perform case_app.admin_provision_facilitator(p_user_id, p_workspace_id);
  perform case_app.audit_admin(p_workspace_id, p_actor_user_id, p_admin_email, 'member_invite', 'member', p_user_id);
end;
$function$;

-- Admin only: P-33's owner policy cell (CASE-337/338) does not reach this deployment RPC.
CREATE OR REPLACE FUNCTION case_api.admin_review_asset(p_workspace_id uuid, p_asset_id uuid, p_decision text, p_expected jsonb, p_acknowledged text[], p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare v_row case_app.assets; v_open text[];
begin
  perform case_app.authorize_admin(p_user_id, 'P-33', p_admin, p_admin_email);
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-33', p_admin, p_admin_email);
  if p_decision is null or p_decision not in ('approve','reject') then raise exception 'invalid_decision' using errcode = '22023'; end if;
  if p_decision = 'approve' and (jsonb_typeof(p_expected) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_expected) k) is distinct from array['attested','attribution','creator','licence','rights_basis','rights_note','source_url']
      or p_acknowledged is null or array_position(p_acknowledged, null) is not null
      or not p_acknowledged <@ array['not_deidentified','licence_caution','no_licence','source_unknown','credit_missing','licence_terms_missing']::text[]) then
    raise exception 'invalid_review' using errcode = '22023';
  end if;
  perform case_app.ensure_admin_profile(p_user_id);
  select * into v_row from case_app.assets a where a.id = p_asset_id and a.workspace_id = p_workspace_id for update;
  if not found then raise exception 'asset_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'quarantined' then raise exception 'asset_not_pending' using errcode = '40001'; end if;
  if p_decision = 'approve' then
    v_open := case_app.asset_open_warnings(v_row);
    if case_app.asset_review_state(v_row) is distinct from p_expected
       or v_open is distinct from (select coalesce(array_agg(distinct c collate "C" order by c collate "C"), '{}') from unnest(p_acknowledged) c) then
      raise exception 'asset_details_changed' using errcode = '40001';
    end if;
  end if;
  update case_app.assets set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      approved_by = case when p_decision = 'approve' then p_user_id end, approved_at = case when p_decision = 'approve' then clock_timestamp() end
    where id = p_asset_id returning * into v_row;
  if p_decision = 'reject' then perform case_app.enqueue_asset_keys(p_asset_id, 'rejected'); end if;
  insert into case_app.workspace_audit (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id, acknowledged)
    values (p_workspace_id, 'admin', p_user_id, p_admin_email, 'asset_' || p_decision, 'asset', p_asset_id, v_open);
  return case_app.asset_row(v_row);
end;
$function$;

-- Retention sweep: leases queued keys only.
CREATE OR REPLACE FUNCTION case_api.media_purge_claim(p_limit integer)
 RETURNS TABLE(r2_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
begin
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'invalid_limit' using errcode = '22023'; end if;
  -- CASE-342: an uploaded image is usable at once, so none is closed for age; unused ones go by Delete unused.
  return query
    update case_app.media_purge_queue q set claimed_at = clock_timestamp()
    where q.r2_key in (select x.r2_key from case_app.media_purge_queue x
        where x.done_at is null and (x.claimed_at is null or x.claimed_at < clock_timestamp() - interval '15 minutes')
          and not exists (select 1 from case_app.asset_renditions o join case_app.assets a on a.id = o.asset_id where o.r2_key = x.r2_key and a.status in ('quarantined', 'approved'))
        order by x.queued_at limit p_limit for update skip locked)
    returning q.r2_key;
end;
$function$;

-- The image registration core, shared by the workspace-keyed and the case-keyed RPC (CASE-342).
CREATE FUNCTION case_app.media_create(p_workspace_id uuid, p_user_id uuid, p_display jsonb, p_phone jsonb, p_details jsonb, p_poster jsonb, p_strict boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_display case_app.sha256; v_phone case_app.sha256; v_existing case_app.assets; v_row case_app.assets;
  v_licence text := p_details->>'licence'; v_type text := coalesce(p_display->>'type', 'image/jpeg'); v_moving boolean;
  v_attested boolean := coalesce((p_details->>'attested')::boolean, false); v_new_bytes bigint;
begin
  v_moving := v_type in ('image/gif', 'video/mp4');
  if jsonb_typeof(p_display) <> 'object' or jsonb_typeof(p_phone) <> 'object' or jsonb_typeof(p_details) <> 'object' or
     coalesce(p_display->>'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(p_phone->>'sha256', '') !~ '^[0-9a-f]{64}$' or
     v_type not in ('image/jpeg', 'image/gif', 'video/mp4') or coalesce(p_phone->>'type', 'image/jpeg') <> (case when v_moving then v_type else 'image/jpeg' end) or
     -- A GIF or video is one object for display and phone, with a JPEG poster; a still has no poster.
     (v_moving and (p_phone->>'sha256' <> p_display->>'sha256' or jsonb_typeof(p_poster) is distinct from 'object' or
       coalesce(p_poster->>'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(p_poster->>'type', 'image/jpeg') <> 'image/jpeg')) or
     (not v_moving and p_poster is not null and jsonb_typeof(p_poster) <> 'null') or
     (v_type = 'video/mp4' and coalesce(p_details->>'duration_ms', '') !~ '^[0-9]{1,6}$') then
    raise exception 'invalid_asset' using errcode = '22023'; end if;
  v_display := decode(p_display->>'sha256', 'hex'); v_phone := decode(p_phone->>'sha256', 'hex');
  perform pg_advisory_xact_lock(4242, 59);
  select * into v_existing from case_app.assets a where a.workspace_id = p_workspace_id and a.content_sha256 = v_display;
  if found then
    -- 23505: this exact file is already known to the workspace, and closed.
    if v_existing.status in ('rejected','withdrawn') then raise exception 'asset_closed' using errcode = '23505'; end if;
    return case_app.asset_row(v_existing) || jsonb_build_object('created', false);
  end if;
  -- Red-team S5: a new asset may not name a stored file another asset already names (a decoy sharing a key would keep
  -- its bytes alive through the other's takedown). Re-uploading the same display file is the asset above, not a new one.
  if exists (select 1 from case_app.asset_renditions r where r.r2_key in (case_app.media_key(p_workspace_id, v_display, v_type),
      case_app.media_key(p_workspace_id, v_phone, case when v_moving then v_type else 'image/jpeg' end),
      case when v_moving then case_app.media_key(p_workspace_id, decode(p_poster->>'sha256', 'hex')) end)) then
    raise exception 'rendition_in_use' using errcode = '40001'; end if;
  -- Bounds: 60 uploads an hour per person, 1 GiB of stored objects per workspace.
  if (select count(*) from case_app.assets a where a.uploaded_by = p_user_id and a.created_at > clock_timestamp() - interval '1 hour') >= 60 then
    raise exception 'media_rate' using errcode = '23514'; end if;
  v_new_bytes := (p_display->>'bytes')::bigint + case when v_moving then (p_poster->>'bytes')::bigint else (p_phone->>'bytes')::bigint end;
  -- Only images still in use count against the workspace (red-team S8); closed ones are being deleted.
  if case_app.media_bytes_in_use(p_workspace_id) + v_new_bytes > case_app.media_quota_of(p_workspace_id) then
    if p_strict then raise exception 'media_quota' using errcode = '23514'; end if;
    raise exception 'storage_full: used % of % bytes', case_app.media_bytes_in_use(p_workspace_id), case_app.media_quota_of(p_workspace_id)
      using errcode = '23514'; end if;
  insert into case_app.assets (workspace_id, uploaded_by, kind, media_type, byte_size, content_sha256, r2_key, status, rights_basis, rights_note,
      deidentified_attested_by, deidentified_attested_at, alt_text, licence, creator, attribution, source_url, evidence_kind, width, height, duration_ms)
    values (p_workspace_id, p_user_id, case when v_type = 'video/mp4' then 'video' else 'image' end, v_type, (p_display->>'bytes')::bigint, v_display,
      case_app.media_key(p_workspace_id, v_display, v_type), 'quarantined', p_details->>'rights_basis', nullif(p_details->>'rights_note', ''),
      case when v_attested then p_user_id end, case when v_attested then clock_timestamp() end, p_details->>'alt_text', v_licence,
      nullif(p_details->>'creator', ''), nullif(p_details->>'attribution', ''), nullif(p_details->>'source_url', ''), p_details->>'evidence_kind',
      (p_display->>'width')::integer, (p_display->>'height')::integer, case when v_type = 'video/mp4' then (p_details->>'duration_ms')::integer end)
    returning * into v_row;
  insert into case_app.asset_renditions (asset_id, rendition, content_type, content_sha256, byte_size, width, height, r2_key) values
    (v_row.id, 'display', v_type, v_display, (p_display->>'bytes')::integer, (p_display->>'width')::integer, (p_display->>'height')::integer,
      case_app.media_key(p_workspace_id, v_display, v_type)),
    (v_row.id, 'phone', case when v_moving then v_type else 'image/jpeg' end, v_phone, (p_phone->>'bytes')::integer, (p_phone->>'width')::integer,
      (p_phone->>'height')::integer, case_app.media_key(p_workspace_id, v_phone, case when v_moving then v_type else 'image/jpeg' end));
  if v_moving then
    insert into case_app.asset_renditions (asset_id, rendition, content_type, content_sha256, byte_size, width, height, r2_key) values
      (v_row.id, 'poster', 'image/jpeg', decode(p_poster->>'sha256', 'hex'), (p_poster->>'bytes')::integer, (p_poster->>'width')::integer,
        (p_poster->>'height')::integer, case_app.media_key(p_workspace_id, decode(p_poster->>'sha256', 'hex')));
  end if;
  -- Strict (the workspace-keyed RPC the deployed Builder calls): every detail it has always required. Otherwise
  -- (CASE-342, plan §3 A6): a description and the uploader's de-identification and permission confirmation; the
  -- credit (licence, creator, source) is optional.
  if p_strict and (v_row.rights_basis is null or v_row.licence is null or v_row.evidence_kind is null or nullif(btrim(v_row.alt_text), '') is null) then
    raise exception 'asset_details_incomplete' using errcode = '22023'; end if;
  if not p_strict and (nullif(btrim(v_row.alt_text), '') is null or not v_attested) then
    raise exception 'asset_details_incomplete' using errcode = '22023'; end if;
  return case_app.asset_row(v_row) || jsonb_build_object('created', true);
end;
$function$;

-- The storage allowance core (rate, closed files, the per-workspace quota), shared likewise.
CREATE FUNCTION case_app.media_allow_put(p_workspace_id uuid, p_user_id uuid, p_sha256 text, p_bytes integer, p_type text, p_strict boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare v_key text; v_held boolean;
begin
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes not between 1 and 26214400 or
     coalesce(p_type, '') not in ('image/jpeg', 'image/gif', 'video/mp4') then raise exception 'invalid_rendition' using errcode = '22023'; end if;
  v_key := case_app.media_key(p_workspace_id, decode(p_sha256, 'hex'), p_type);
  perform pg_advisory_xact_lock(4242, 59);
  delete from case_app.media_put_log where at < clock_timestamp() - interval '1 hour';
  if (select count(*) from case_app.media_put_log l where l.user_id = p_user_id) >= 150 then raise exception 'media_rate' using errcode = '23514'; end if;
  if exists (select 1 from case_app.asset_renditions r join case_app.assets a on a.id = r.asset_id where r.r2_key = v_key and a.status in ('rejected', 'withdrawn'))
     and not exists (select 1 from case_app.asset_renditions r join case_app.assets a on a.id = r.asset_id where r.r2_key = v_key and a.status in ('quarantined', 'approved')) then
    raise exception 'asset_closed' using errcode = '23505';
  end if;
  -- A file a live image already names costs nothing more: the workspace holds it once (dedup by content hash, CASE-342).
  v_held := exists (select 1 from case_app.asset_renditions r join case_app.assets a on a.id = r.asset_id
    where r.r2_key = v_key and a.status in ('quarantined', 'approved'));
  if not v_held and case_app.media_bytes_in_use(p_workspace_id) + p_bytes > case_app.media_quota_of(p_workspace_id) then
    if p_strict then raise exception 'media_quota' using errcode = '23514'; end if;
    raise exception 'storage_full: used % of % bytes', case_app.media_bytes_in_use(p_workspace_id), case_app.media_quota_of(p_workspace_id)
      using errcode = '23514';
  end if;
  insert into case_app.media_put_log (user_id, workspace_id) values (p_user_id, p_workspace_id);
  return true;
end;
$function$;

-- ─── 6. Images: usable at once, per-case visibility, storage (CASE-342) ────────────────────────────────────
create function case_app.media_quota_of(p_workspace_id uuid) returns bigint language sql stable set search_path = '' as $$
  select w.media_quota_bytes from case_app.workspaces w where w.id = p_workspace_id;
$$;

-- The workspace-keyed RPCs the deployed Builder calls keep their signatures and checks (members see every image).
create or replace function case_api.builder_create_asset(p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text,
  p_display jsonb, p_phone jsonb, p_details jsonb, p_poster jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-14', p_admin, p_admin_email);
  if p_admin then perform case_app.ensure_admin_profile(p_user_id); end if;
  return case_app.media_create(p_workspace_id, p_user_id, p_display, p_phone, p_details, p_poster, true);
end;
$$;
create or replace function case_api.builder_media_put_allowance(p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text,
  p_sha256 text, p_bytes integer, p_type text default 'image/jpeg')
returns boolean language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-14', p_admin, p_admin_email);
  return case_app.media_allow_put(p_workspace_id, p_user_id, p_sha256, p_bytes, p_type, true);
end;
$$;

-- Whether this caller sees this image through this case: an admin or a member of the case's workspace sees every
-- image of the workspace; a person who holds the case only by a grant sees the images linked to it (plan §0.5).
create function case_app.case_sees_asset(p_user_id uuid, p_role text, p_case_id uuid, p_asset_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from case_app.assets a join case_app.cases c on c.id = p_case_id and c.workspace_id = a.workspace_id
    where a.id = p_asset_id and (p_role = 'admin' or case_app.member_role(p_user_id, c.workspace_id) is not null
      or exists (select 1 from case_app.case_assets ca where ca.asset_id = a.id and ca.case_id = p_case_id)));
$$;

-- Persist only image associations the saving actor already has permission to use. A guessed ID in a
-- case-only draft must not grant image access. Reference writers already hold the builder lock.
create function case_app.link_draft_assets(p_user_id uuid, p_role text, p_case_id uuid, p_document jsonb)
returns void language sql set search_path = '' as $$
  insert into case_app.case_assets(asset_id, case_id, linked_by)
    select a.id, p_case_id, p_user_id from case_app.assets a
     where a.id = any(case_app.document_asset_ids(p_document))
       and case_app.case_sees_asset(p_user_id, p_role, p_case_id, a.id)
    on conflict do nothing;
$$;
revoke all on function case_app.link_draft_assets(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- The case-keyed RPCs (A3 moves the Builder to these): P-14 on the case, so a Can edit grant uploads and reads.
create function case_api.builder_case_media_put_allowance(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text,
  p_sha256 text, p_bytes integer, p_type text)
returns boolean language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
begin
  perform case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  return case_app.media_allow_put(case_app.workspace_of_case(p_case_id), p_user_id, p_sha256, p_bytes, p_type, false);
end;
$$;

-- Registers an image for a case, usable at once. The same file already in the workspace is that image (dedup by
-- content hash), now linked to this case too. A description and the uploader's confirmation are required.
create function case_api.builder_create_case_asset(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text,
  p_display jsonb, p_phone jsonb, p_details jsonb, p_poster jsonb)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare v_role text; v_row jsonb;
begin
  v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  if exists (select 1 from case_app.cases c where c.id = p_case_id and c.archived_at is not null) then
    raise exception 'case_archived' using errcode = '23514'; end if;
  v_row := case_app.media_create(case_app.workspace_of_case(p_case_id), p_user_id, p_display, p_phone, p_details, p_poster, false);
  if v_row->>'status' in ('quarantined', 'approved') then
    insert into case_app.case_assets (asset_id, case_id, linked_by) values ((v_row->>'asset_id')::uuid, p_case_id, p_user_id)
      on conflict do nothing;
  end if;
  return v_row;
end;
$$;

create function case_api.builder_list_case_assets(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text, p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_role text; v_ws uuid := case_app.workspace_of_case(p_case_id); v_all boolean;
begin
  v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  if p_ids is not null and cardinality(p_ids) > 64 then raise exception 'invalid_asset' using errcode = '22023'; end if;
  v_all := v_role = 'admin' or case_app.member_role(p_user_id, v_ws) is not null;
  return coalesce((select jsonb_agg(case_app.asset_row(a) order by a.created_at desc, a.id desc) from case_app.assets a
    where a.id in (select b.id from case_app.assets b where b.workspace_id = v_ws and b.kind in ('image', 'video')
      and (p_ids is null or b.id = any (p_ids))
      and (v_all or exists (select 1 from case_app.case_assets ca where ca.asset_id = b.id and ca.case_id = p_case_id))
      order by b.created_at desc, b.id desc limit 200)), '[]'::jsonb);
end;
$$;

create function case_api.builder_case_asset_rendition(p_case_id uuid, p_asset_id uuid, p_rendition text, p_user_id uuid,
  p_admin boolean, p_admin_email text)
returns table(status text, r2_key text, content_sha256 text, byte_size integer, content_type text)
language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_role text;
begin
  v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  if not case_app.case_sees_asset(p_user_id, v_role, p_case_id, p_asset_id) then return; end if;
  return query select a.status, case when a.status in ('quarantined','approved') then r.r2_key end,
      case when a.status in ('quarantined','approved') then encode(r.content_sha256, 'hex') end, r.byte_size, r.content_type
    from case_app.assets a join case_app.asset_renditions r on r.asset_id = a.id and r.rendition = p_rendition
    where a.id = p_asset_id and a.workspace_id = case_app.workspace_of_case(p_case_id);
end;
$$;

-- Live images of a workspace that nothing uses (CASE-342, plan §3 A7): referenced by no version, no draft, no retained
-- candidate body and no live checkpoint, not taken down (a closed image is already queued by CASE-270), and at least
-- a day old (the CASE-270 orphan rule: an image being placed now is not offered for deletion).
create function case_app.unused_assets(p_workspace_id uuid) returns setof case_app.assets language sql stable set search_path = '' as $$
  select a.* from case_app.assets a
   where a.workspace_id = p_workspace_id and a.status in ('quarantined', 'approved') and a.kind in ('image', 'video')
     and a.created_at < clock_timestamp() - interval '1 day'
     and not exists (select 1 from case_app.case_version_assets v where v.asset_id = a.id)
     and not exists (select 1 from case_app.case_drafts d join case_app.cases c on c.id = d.case_id
       where c.workspace_id = p_workspace_id and a.id = any (case_app.document_asset_ids(d.document)))
     and not exists (select 1 from case_app.builder_candidates b where b.workspace_id = p_workspace_id and b.document is not null
       and a.id = any (case_app.document_asset_ids(b.document)))
     and not exists (select 1 from case_app.builder_checkpoints k where k.workspace_id = p_workspace_id and k.deleted_at is null
       and a.id = any (case_app.document_asset_ids(k.document)));
$$;

-- Admin → Workspaces: storage used against the quota, and the unused images (at most 200, oldest first).
create function case_api.admin_workspace_storage(p_user_id uuid, p_workspace_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
begin
  perform case_app.authorize_admin(p_user_id, 'P-45', p_admin, p_admin_email);
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-45', p_admin, p_admin_email);
  return jsonb_build_object('workspaceId', p_workspace_id, 'usedBytes', case_app.media_bytes_in_use(p_workspace_id),
    'quotaBytes', case_app.media_quota_of(p_workspace_id),
    -- A5: the workspace's four policies and their revision travel with its storage, so Administration -> Workspaces
    -- reads one answer; setting them is admin_set_workspace_policies against this revision.
    'policies', case_app.policies_of(p_workspace_id),
    'policyRevision', coalesce((select x.revision from case_app.workspace_policies x where x.workspace_id = p_workspace_id), 0),
    'unusedBytes', (select coalesce(sum(r.byte_size), 0) from case_app.unused_assets(p_workspace_id) u join case_app.asset_renditions r on r.asset_id = u.id),
    'unused', coalesce((select jsonb_agg(jsonb_build_object('assetId', u.id, 'kind', u.kind, 'mediaType', u.media_type,
        'altText', u.alt_text, 'createdAt', u.created_at,
        'bytes', (select coalesce(sum(r.byte_size), 0) from case_app.asset_renditions r where r.asset_id = u.id)) order by u.created_at, u.id)
      from (select * from case_app.unused_assets(p_workspace_id) x order by x.created_at, x.id limit 200) u), '[]'::jsonb));
end;
$$;

-- "Delete unused": an admin, with this session's step-up (invariant 11), deletes images that are still unused at this
-- moment; anything used since the listing is kept and not counted. The stored files are queued for the hourly sweep
-- (CASE-270), and the rows go so the same file may be added again later. One audit row per image.
create function case_api.admin_delete_unused_assets(p_user_id uuid, p_workspace_id uuid, p_asset_ids uuid[], p_elevation_id uuid,
  p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare v_id uuid; v_deleted uuid[] := '{}'; v_keys text[] := '{}';
begin
  perform case_app.authorize_admin(p_user_id, 'P-16', p_admin, p_admin_email);
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-16', p_admin, p_admin_email);
  perform case_app.assert_elevation(p_elevation_id, p_admin_email, 'admin');
  if p_asset_ids is null or cardinality(p_asset_ids) not between 1 and 200 then raise exception 'invalid_asset' using errcode = '22023'; end if;
  -- Reference writers (save, restore, submit and release) take the builder lock first.
  perform pg_advisory_xact_lock(4242, 42);
  perform pg_advisory_xact_lock(4242, 59);
  for v_id in select u.id from case_app.unused_assets(p_workspace_id) u where u.id = any (p_asset_ids) order by u.id loop
    perform 1 from case_app.assets a where a.id = v_id for update;
    -- Re-checked under the row lock: an image placed or released since the listing is kept.
    if not exists (select 1 from case_app.unused_assets(p_workspace_id) u where u.id = v_id) then continue; end if;
    v_keys := v_keys || array(select k from case_app.enqueue_asset_keys(v_id, 'unused') k);
    perform case_app.audit_actor(p_workspace_id, p_user_id, p_admin_email, 'admin', 'asset_delete_unused', 'asset', v_id, null, p_elevation_id);
    delete from case_app.assets a where a.id = v_id;
    v_deleted := v_deleted || v_id;
  end loop;
  return jsonb_build_object('deleted', to_jsonb(v_deleted), 'queuedKeys', cardinality(v_keys));
end;
$$;

-- ─── 7. Access facts, sharing and policies ──────────────────────────────────────────────────────────────────
-- What the caller holds on a place, read once per request by the Worker's authorize (A3). With a case, the workspace
-- is the case's (a different p_workspace_id answers nothing). No row when the caller holds nothing there.
create function case_api.get_access(p_user_id uuid, p_workspace_id uuid, p_case_id uuid, p_admin boolean, p_admin_email text)
returns table(workspace_id uuid, case_id uuid, member_role text, grant_level text, role text, scope text, policies jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid := coalesce(case_app.workspace_of_case(p_case_id), p_workspace_id); v_admin boolean;
begin
  v_admin := case_app.check_admin_flag(p_admin, p_admin_email);
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then raise exception 'account_not_active' using errcode = '42501'; end if;
  if v_ws is null or (p_case_id is not null and p_workspace_id is not null and p_workspace_id <> v_ws)
     or (p_case_id is not null and case_app.workspace_of_case(p_case_id) is null)
     or not exists (select 1 from case_app.workspaces w where w.id = v_ws) then return; end if;
  if v_admin then
    return query select v_ws, p_case_id, case_app.member_role(p_user_id, v_ws), null::text, 'admin'::text, 'workspace'::text, case_app.policies_of(v_ws);
    return;
  end if;
  return query select v_ws, p_case_id, case_app.member_role(p_user_id, v_ws),
      (select g.level from case_app.case_grants g where g.case_id = p_case_id and g.user_id = p_user_id and g.revoked_at is null
         and case_app.grant_role(p_user_id, p_case_id) is not null),
      e.role, e.scope, case_app.policies_of(v_ws)
    from case_app.effective_role(p_user_id, v_ws, p_case_id) e;
end;
$$;

-- "Shared with you" (CASE-336, plan §3 A6): the caller's live grants, by workspace. A Can run grant never shows a case
-- that has never been published; a withdrawn-only case is listed (withdrawn = true) and cannot be started.
create function case_api.list_shared_cases(p_user_id uuid)
returns table(grant_id uuid, case_id uuid, workspace_id uuid, workspace_name text, title text, level text, member_role text,
  version_id uuid, version_no integer, withdrawn boolean, has_draft boolean, granted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then raise exception 'account_not_active' using errcode = '42501'; end if;
  return query
    select g.id, c.id, w.id, w.name, coalesce(case_app.catalogue_text(lv.document, 'title', 200), c.title), g.level,
           case_app.member_role(p_user_id, w.id), lv.id, lv.version_no,
           exists (select 1 from case_app.case_versions v where v.case_id = c.id) and lv.id is null,
           exists (select 1 from case_app.case_drafts d where d.case_id = c.id), g.created_at
      from case_app.case_grants g
      join case_app.cases c on c.id = g.case_id and c.workspace_id = g.workspace_id and c.archived_at is null
      join case_app.workspaces w on w.id = g.workspace_id
      left join lateral (select v.id, v.version_no, v.document from case_app.case_versions v where v.case_id = c.id
          and not exists (select 1 from case_app.admin_version_state av where av.case_version_id = v.id and av.status = 'withdrawn')
          order by v.version_no desc limit 1) lv on true
     where g.user_id = p_user_id and g.revoked_at is null
       and (g.level = 'edit' or exists (select 1 from case_app.case_versions v where v.case_id = c.id))
     order by w.name, w.id, 5, c.id;
end;
$$;

-- Who has access to one case and its pending invitations (the Share dialog, P-43).
create function case_api.list_case_access(p_user_id uuid, p_case_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_ws uuid := case_app.workspace_of_case(p_case_id);
begin
  perform case_app.authorize_case(p_user_id, p_case_id, 'P-43', p_admin, p_admin_email);
  return jsonb_build_object('caseId', p_case_id, 'workspaceId', v_ws,
    'members', coalesce((select jsonb_agg(jsonb_build_object('userId', m.user_id, 'name', coalesce(p.display_name, 'Facilitator'),
        'role', m.role) order by case_app.role_rank(m.role) desc, p.display_name, m.user_id)
      from (select * from case_app.workspace_members x where x.workspace_id = v_ws order by x.user_id limit 200) m
      left join case_app.profiles p on p.id = m.user_id), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('grantId', g.id, 'userId', g.user_id, 'name', coalesce(p.display_name, 'Facilitator'),
        'level', g.level, 'grantedAt', g.created_at) order by g.created_at, g.id)
      from case_app.case_grants g left join case_app.profiles p on p.id = g.user_id
      where g.case_id = p_case_id and g.revoked_at is null), '[]'::jsonb),
    'invitations', coalesce((select jsonb_agg(jsonb_build_object('invitationId', i.id, 'email', i.email, 'level', i.level,
        'createdAt', i.created_at, 'expiresAt', i.expires_at, 'sendState', i.send_state) order by i.created_at, i.id)
      from case_app.invitations i where i.case_id = p_case_id and i.status = 'pending' and i.expires_at > clock_timestamp()), '[]'::jsonb));
end;
$$;

-- Ends one person's grant on a case. Only those who manage the case (its workspace's owners, or an admin) remove access.
create function case_api.revoke_case_grant(p_user_id uuid, p_grant_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g case_app.case_grants; v_role text;
begin
  select * into g from case_app.case_grants x where x.id = p_grant_id;
  v_role := case_app.authorize_case(p_user_id, g.case_id, 'P-43', p_admin, p_admin_email);
  if v_role not in ('admin', 'owner') then raise exception 'not_authorised: only a manager removes access' using errcode = '42501'; end if;
  select * into g from case_app.case_grants x where x.id = p_grant_id for update;
  if g.revoked_at is not null then return jsonb_build_object('outcome', 'ended', 'grantId', g.id); end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  update case_app.case_grants x set revoked_at = clock_timestamp(), revoked_by = p_user_id, updated_at = clock_timestamp() where x.id = g.id;
  perform case_app.audit_actor(g.workspace_id, p_user_id, p_admin_email, v_role, 'case_grant_revoke', 'grant', g.id, null, null);
  return jsonb_build_object('outcome', 'revoked', 'grantId', g.id);
end;
$$;

-- An admin sets a workspace's four policies (P-45) and, optionally, its image quota, against the policy revision.
-- Missing keys keep their value; only JSON booleans are accepted.
create function case_api.admin_set_workspace_policies(p_user_id uuid, p_workspace_id uuid, p_expected_revision bigint, p_policies jsonb,
  p_media_quota_bytes bigint, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v case_app.workspace_policies; v_key text;
begin
  perform case_app.authorize_admin(p_user_id, 'P-45', p_admin, p_admin_email);
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-45', p_admin, p_admin_email);
  if p_policies is null or jsonb_typeof(p_policies) <> 'object' then raise exception 'invalid_policies' using errcode = '22023'; end if;
  for v_key in select jsonb_object_keys(p_policies) loop
    if v_key not in ('managers_invite', 'editors_publish', 'runners_share', 'managers_see_records')
       or jsonb_typeof(p_policies -> v_key) <> 'boolean' then raise exception 'invalid_policies' using errcode = '22023'; end if;
  end loop;
  if p_media_quota_bytes is not null and p_media_quota_bytes not between 0 and 10000000000 then
    raise exception 'invalid_quota' using errcode = '22023'; end if;
  perform case_app.ensure_admin_profile(p_user_id);
  insert into case_app.workspace_policies (workspace_id) values (p_workspace_id) on conflict do nothing;
  select * into v from case_app.workspace_policies x where x.workspace_id = p_workspace_id for update;
  if p_expected_revision is distinct from v.revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
  update case_app.workspace_policies x set
      managers_invite = coalesce((p_policies ->> 'managers_invite')::boolean, x.managers_invite),
      editors_publish = coalesce((p_policies ->> 'editors_publish')::boolean, x.editors_publish),
      runners_share = coalesce((p_policies ->> 'runners_share')::boolean, x.runners_share),
      managers_see_records = coalesce((p_policies ->> 'managers_see_records')::boolean, x.managers_see_records),
      revision = x.revision + 1, updated_at = clock_timestamp(), updated_by = p_user_id
    where x.workspace_id = p_workspace_id returning * into v;
  perform case_app.audit_actor(p_workspace_id, p_user_id, p_admin_email, 'admin', 'policy_set', 'workspace', p_workspace_id, v.revision, null);
  if p_media_quota_bytes is not null and p_media_quota_bytes is distinct from case_app.media_quota_of(p_workspace_id) then
    update case_app.workspaces w set media_quota_bytes = p_media_quota_bytes where w.id = p_workspace_id;
    perform case_app.audit_actor(p_workspace_id, p_user_id, p_admin_email, 'admin', 'quota_set', 'workspace', p_workspace_id, null, null);
  end if;
  return case_app.policies_of(p_workspace_id) || jsonb_build_object('revision', v.revision, 'mediaQuotaBytes', case_app.media_quota_of(p_workspace_id));
end;
$$;

-- ─── 8. Invitations (CASE-339, CASE-341) ────────────────────────────────────────────────────────────────────
create function case_app.level_role(p_level text) returns text language sql immutable set search_path = '' as $$
  select case p_level when 'manage' then 'owner' when 'edit' then 'author' when 'run' then 'facilitator' end;
$$;
-- Creations plus resends per inviter in a rolling day (CASE-339). Resend's free tier sends 100 a day for the whole
-- deployment; 50 per inviter keeps one person from exhausting it.
create function case_app.invitation_daily_cap() returns integer language sql immutable set search_path = '' as $$ select 50 $$;
create function case_app.invitation_cap_retry(p_user_id uuid) returns timestamptz language sql stable set search_path = '' as $$
  select case when count(*) >= case_app.invitation_daily_cap() then min(e.at) + interval '1 day' end
    from (select x.at from case_app.invitation_events x where x.actor_user_id = p_user_id and x.at > clock_timestamp() - interval '1 day'
          order by x.at desc limit case_app.invitation_daily_cap()) e;
$$;
-- What an invitation email and the invite page show: the address, who invited, the place and the level only.
create function case_app.invitation_facts(i case_app.invitations) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('invitationId', i.id, 'email', i.email, 'level', i.level, 'workspaceId', i.workspace_id,
    'workspaceName', (select w.name from case_app.workspaces w where w.id = i.workspace_id), 'caseId', i.case_id,
    'caseTitle', (select c.title from case_app.cases c where c.id = i.case_id),
    'inviterName', coalesce((select p.display_name from case_app.profiles p where p.id = i.invited_by), 'Facilitator'),
    'expiresAt', i.expires_at);
$$;

-- Creates an invitation (P-03 for a workspace, P-43 for one case). The Worker first finds or creates the account and
-- passes its id (p_invitee_user_id), and passes the SHA-256 of a fresh reference (never the reference itself).
-- Outcomes: created | already_has_access | already_invited | cap_reached (with retryAfter). Nothing is written for the
-- last three.
create function case_api.create_invitation(p_user_id uuid, p_workspace_id uuid, p_case_id uuid, p_level text, p_email text,
  p_ref_hash bytea, p_invitee_user_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text; v_ws uuid := p_workspace_id; v_existing text; v_at timestamptz := clock_timestamp(); v_retry timestamptz;
  v_row case_app.invitations;
begin
  if p_level is null or p_level not in ('run', 'edit', 'manage') or (p_case_id is not null and p_level = 'manage')
     or p_email is null or p_email <> lower(p_email) or length(p_email) > 320
     or p_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
     or p_ref_hash is null or octet_length(p_ref_hash) <> 32 then
    raise exception 'invalid_invitation' using errcode = '22023'; end if;
  if p_case_id is null then
    v_role := case_app.authorize(p_user_id, p_workspace_id, 'P-03', p_admin, p_admin_email);
    -- An owner invites into their own workspace as author or facilitator, never owner (P-03, CASE-337).
    if v_role <> 'admin' and p_level = 'manage' then
      raise exception 'not_authorised: only an admin invites a manager' using errcode = '42501'; end if;
  else
    v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-43', p_admin, p_admin_email);
    v_ws := case_app.workspace_of_case(p_case_id);
    if p_workspace_id is distinct from v_ws then raise exception 'not_authorised: case not in workspace' using errcode = '42501'; end if;
    -- Under runners_share a runner or editor shares Can run only (P-43).
    if v_role not in ('admin', 'owner') and p_level <> 'run' then
      raise exception 'not_authorised: share to run only' using errcode = '42501'; end if;
    if exists (select 1 from case_app.cases c where c.id = p_case_id and c.archived_at is not null) then
      raise exception 'case_archived' using errcode = '23514'; end if;
  end if;
  if p_invitee_user_id is not null then
    if not exists (select 1 from auth.users u where u.id = p_invitee_user_id and lower(u.email) = p_email) then
      raise exception 'invalid_invitation: account does not match' using errcode = '22023'; end if;
    select e.role into v_existing from case_app.effective_role(p_invitee_user_id, v_ws, p_case_id) e;
    if case_app.role_rank(v_existing) >= case_app.role_rank(case_app.level_role(p_level)) then
      return jsonb_build_object('outcome', 'already_has_access', 'role', v_existing); end if;
  end if;
  perform pg_advisory_xact_lock(4242, 339);
  update case_app.invitations i set status = 'expired' where i.status = 'pending' and i.expires_at <= v_at
     and i.workspace_id = v_ws and i.case_id is not distinct from p_case_id and i.email = p_email;
  select * into v_row from case_app.invitations i where i.status = 'pending' and i.workspace_id = v_ws
     and i.case_id is not distinct from p_case_id and i.email = p_email;
  if found then return jsonb_build_object('outcome', 'already_invited') || case_app.invitation_facts(v_row); end if;
  v_retry := case_app.invitation_cap_retry(p_user_id);
  if v_retry is not null then return jsonb_build_object('outcome', 'cap_reached', 'retryAfter', v_retry); end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  insert into case_app.invitations (workspace_id, case_id, level, email, ref_hash, invited_by, inviter_kind, created_at, expires_at)
    values (v_ws, p_case_id, p_level, p_email, p_ref_hash, p_user_id, v_role, v_at, v_at + interval '90 days') returning * into v_row;
  insert into case_app.invitation_events (invitation_id, actor_user_id, kind) values (v_row.id, p_user_id, 'create');
  -- Audited by the inviter's real kind; a runner sharing under runners_share is 'facilitator' (ruling R2).
  perform case_app.audit_actor(v_ws, p_user_id, p_admin_email, v_role, 'invitation_create', 'invitation', v_row.id, null, null);
  return jsonb_build_object('outcome', 'created') || case_app.invitation_facts(v_row);
end;
$$;

-- The invitations of one workspace, newest first, 50 a page (P-44). An address shows until it is purged.
create function case_api.list_invitations(p_user_id uuid, p_workspace_id uuid, p_after uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_items jsonb;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-44', p_admin, p_admin_email);
  select coalesce(jsonb_agg(x.item order by x.id desc), '[]'::jsonb) into v_items from (
    select i.id, case_app.invitation_facts(i) || jsonb_build_object(
        'status', case when i.status = 'pending' and i.expires_at <= clock_timestamp() then 'expired' else i.status end,
        'sendState', i.send_state, 'sendCount', i.send_count, 'lastSendAt', i.last_send_at, 'retryAfter', i.retry_after,
        'createdAt', i.created_at, 'acceptedAt', i.accepted_at, 'revokedAt', i.revoked_at, 'inviterKind', i.inviter_kind) item
      from case_app.invitations i where i.workspace_id = p_workspace_id and (p_after is null or i.id < p_after)
     order by i.id desc limit 50) x;
  return jsonb_build_object('invitations', v_items,
    'nextAfter', case when jsonb_array_length(v_items) = 50 then v_items -> 49 ->> 'invitationId' end);
end;
$$;

-- Resend (P-44): a fresh reference replaces the old one (only its hash is stored, so the old link stops working),
-- counted against the daily cap. Outcomes: resend (with the facts to send) | ended | cap_reached.
create function case_api.resend_invitation(p_user_id uuid, p_invitation_id uuid, p_ref_hash bytea, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row case_app.invitations; v_role text; v_retry timestamptz;
begin
  select * into v_row from case_app.invitations i where i.id = p_invitation_id;
  if not found then raise exception 'not_authorised: no such invitation' using errcode = '42501'; end if;
  v_role := case_app.authorize(p_user_id, v_row.workspace_id, 'P-44', p_admin, p_admin_email);
  if p_ref_hash is null or octet_length(p_ref_hash) <> 32 then raise exception 'invalid_invitation' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(4242, 339);
  select * into v_row from case_app.invitations i where i.id = p_invitation_id for update;
  if v_row.status <> 'pending' or v_row.expires_at <= clock_timestamp() then return jsonb_build_object('outcome', 'ended'); end if;
  v_retry := case_app.invitation_cap_retry(p_user_id);
  if v_retry is not null then return jsonb_build_object('outcome', 'cap_reached', 'retryAfter', v_retry); end if;
  update case_app.invitations i set ref_hash = p_ref_hash where i.id = p_invitation_id returning * into v_row;
  insert into case_app.invitation_events (invitation_id, actor_user_id, kind) values (v_row.id, p_user_id, 'resend');
  perform case_app.audit_actor(v_row.workspace_id, p_user_id, p_admin_email, v_role, 'invitation_resend', 'invitation', v_row.id, null, null);
  return jsonb_build_object('outcome', 'resend') || case_app.invitation_facts(v_row);
end;
$$;

-- The send outcome the Worker records after each attempt it made for an authorized create or resend.
create function case_api.record_invitation_delivery(p_invitation_id uuid, p_outcome text, p_retry_after timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row case_app.invitations;
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'email_limit', 'email_not_configured')
     or (p_retry_after is not null and not isfinite(p_retry_after)) then raise exception 'invalid_delivery' using errcode = '22023'; end if;
  update case_app.invitations i set send_state = p_outcome,
      send_count = i.send_count + case when p_outcome = 'sent' then 1 else 0 end,
      last_send_at = case when p_outcome = 'sent' then clock_timestamp() else i.last_send_at end,
      retry_after = case when p_outcome = 'email_limit' then p_retry_after end
    where i.id = p_invitation_id and i.status = 'pending' returning * into v_row;
  if not found then return jsonb_build_object('outcome', 'ended'); end if;
  return jsonb_build_object('outcome', 'recorded', 'sendState', v_row.send_state);
end;
$$;

-- Revoke (P-44): a pending invitation ends at once; its reference reads as ended.
create function case_api.revoke_invitation(p_user_id uuid, p_invitation_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row case_app.invitations; v_role text;
begin
  select * into v_row from case_app.invitations i where i.id = p_invitation_id;
  if not found then raise exception 'not_authorised: no such invitation' using errcode = '42501'; end if;
  v_role := case_app.authorize(p_user_id, v_row.workspace_id, 'P-44', p_admin, p_admin_email);
  select * into v_row from case_app.invitations i where i.id = p_invitation_id for update;
  if v_row.status <> 'pending' then return jsonb_build_object('outcome', 'ended'); end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  update case_app.invitations i set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id where i.id = p_invitation_id;
  perform case_app.audit_actor(v_row.workspace_id, p_user_id, p_admin_email, v_role, 'invitation_revoke', 'invitation', v_row.id, null, null);
  return jsonb_build_object('outcome', 'revoked');
end;
$$;

-- P-46: what the holder of a reference may read (CASE-341). Only a pending, unexpired invitation answers, and only
-- with the address, inviter, place and level; an ended or unknown reference answers nothing.
create function case_api.peek_invitation(p_ref_hash bytea)
returns table(email text, inviter_name text, workspace_name text, case_title text, level text)
language sql stable security definer set search_path = '' as $$
  select f->>'email', f->>'inviterName', f->>'workspaceName', f->>'caseTitle', f->>'level'
    from case_app.invitations i cross join lateral case_app.invitation_facts(i) f
   where i.ref_hash = p_ref_hash and octet_length(p_ref_hash) = 32 and i.status = 'pending' and i.expires_at > clock_timestamp();
$$;

-- Acceptance at sign-in by the verified email (CASE-339): every pending, unexpired invitation to that exact address
-- becomes a membership or a case grant. A level is only ever raised, never lowered (an owner invited as facilitator
-- stays owner; a Can edit grant invited as Can run stays Can edit). VOLATILE, separate from the STABLE get_me.
create function case_api.accept_invitations(p_user_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i case_app.invitations; v_out jsonb := '[]'; v_current text; v_change text; v_grant case_app.case_grants;
begin
  if p_user_id is null or p_email is null or p_email <> lower(p_email) then raise exception 'invalid_user' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then raise exception 'account_not_active' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id and lower(u.email) = p_email) then return v_out; end if;
  insert into case_app.profiles (id, display_name) values (p_user_id, 'Facilitator') on conflict (id) do nothing;
  for i in select * from case_app.invitations x where x.email = p_email and x.status = 'pending' and x.expires_at > clock_timestamp()
      order by x.created_at, x.id for update loop
    if i.case_id is null then
      v_current := case_app.member_role(p_user_id, i.workspace_id);
      if v_current is null then
        insert into case_app.workspace_members (workspace_id, user_id, role) values (i.workspace_id, p_user_id, case_app.level_role(i.level));
        v_change := 'new';
      elsif case_app.role_rank(case_app.level_role(i.level)) > case_app.role_rank(v_current) then
        update case_app.workspace_members m set role = case_app.level_role(i.level) where m.workspace_id = i.workspace_id and m.user_id = p_user_id;
        v_change := 'raised';
      else v_change := 'unchanged'; end if;
    else
      select * into v_grant from case_app.case_grants g where g.case_id = i.case_id and g.user_id = p_user_id and g.revoked_at is null for update;
      if not found then
        insert into case_app.case_grants (case_id, workspace_id, user_id, level, granted_by, invitation_id)
          values (i.case_id, i.workspace_id, p_user_id, i.level, i.invited_by, i.id) returning * into v_grant;
        insert into case_app.workspace_audit (workspace_id, actor_kind, action, target_type, target_id)
          values (i.workspace_id, 'system', 'case_grant', 'grant', v_grant.id);
        v_change := case when case_app.role_rank(case_app.member_role(p_user_id, i.workspace_id)) >= case_app.role_rank(case_app.level_role(i.level))
          then 'unchanged' else 'new' end;
      elsif v_grant.level = 'run' and i.level = 'edit' then
        update case_app.case_grants g set level = 'edit', invitation_id = i.id, updated_at = clock_timestamp() where g.id = v_grant.id;
        v_change := 'raised';
      else v_change := 'unchanged'; end if;
    end if;
    update case_app.invitations x set status = 'accepted', accepted_at = clock_timestamp(), accepted_by = p_user_id where x.id = i.id;
    insert into case_app.workspace_audit (workspace_id, actor_kind, action, target_type, target_id)
      values (i.workspace_id, 'system', 'invitation_accept', 'invitation', i.id);
    v_out := v_out || jsonb_build_array(case_app.invitation_facts(i) - 'email' || jsonb_build_object('change', v_change));
  end loop;
  return v_out;
end;
$$;

-- Personal data (hard rule 8, plan §3 A4): an ended invitation's address is nulled 30 days after it ended — revoke,
-- expiry, or for an accepted one its expiry date. The Worker's ADMIN_PURGE_CRON sweep calls this (A4).
create function case_api.purge_invitation_addresses()
returns integer language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare v_count integer;
begin
  update case_app.invitations i set status = 'expired' where i.status = 'pending' and i.expires_at <= clock_timestamp() - interval '30 days';
  update case_app.invitations i set email = null, address_purged_at = clock_timestamp()
   where i.email is not null and i.status <> 'pending'
     and coalesce(case when i.status = 'revoked' then i.revoked_at end, i.expires_at) <= clock_timestamp() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Ruling R7 (A4): the case a version belongs to, an id lookup the Worker makes before a case-only holder's version read,
-- so a version of a case they hold no grant on is refused in the Worker (403) and never by SQL (42501, which alerts).
-- Answers an id only (null for an unknown version); authorizes nothing, and every version read still decides in SQL.
create function case_api.version_case(p_version_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case_app.case_of_version(p_version_id);
$$;

-- A5 (People): what each listed account holds, for Administration -> People: its workspace roles and its live case
-- grants. A deployment read behind the Worker admin gate (like admin_read_facilitator_labels): it takes account ids
-- only, answers ids, names and levels, and authorizes nothing. At most 1,000 ids, as one GoTrue page.
create function case_api.admin_read_access(p_user_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(r.row order by r.sort), '[]'::jsonb) from (
    select jsonb_build_object('userId', m.user_id, 'kind', 'member', 'workspaceId', m.workspace_id, 'workspaceName', w.name,
        'role', m.role, 'caseId', null, 'caseTitle', null) as row, w.name || m.user_id::text as sort
      from case_app.workspace_members m join case_app.workspaces w on w.id = m.workspace_id
     where m.user_id = any (p_user_ids) and cardinality(p_user_ids) <= 1000
    union all
    select jsonb_build_object('userId', g.user_id, 'kind', 'grant', 'workspaceId', g.workspace_id, 'workspaceName', w.name,
        'role', g.level, 'caseId', g.case_id, 'caseTitle', c.title), w.name || c.title || g.user_id::text
      from case_app.case_grants g join case_app.cases c on c.id = g.case_id and c.workspace_id = g.workspace_id
      join case_app.workspaces w on w.id = g.workspace_id
     where g.user_id = any (p_user_ids) and g.revoked_at is null and c.archived_at is null and cardinality(p_user_ids) <= 1000
  ) r;
$$;

-- ─── 9. /me gains the caller's live case grants (CASE-336) ─────────────────────────────────────────────────
-- Same arguments, one more result column, so the function is recreated (an OUT column cannot be added in place);
-- the deployed Worker reads columns by name and ignores the new one. Acceptance is case_api.accept_invitations.
drop function case_api.get_me(uuid, integer, uuid, uuid, boolean, text);
create function case_api.get_me(p_user_id uuid, p_limit integer default 100, p_after uuid default null,
  p_workspace_id uuid default null, p_admin boolean default false, p_admin_email text default null)
returns table(user_id uuid, display_name text, memberships jsonb, next_after uuid, admin boolean, facilitator_role text,
  label_confirmed_at timestamptz, grants jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_admin boolean := case_app.check_admin_flag(p_admin, p_admin_email);
  v_display_name text;
  v_role text;
  v_confirmed timestamptz;
  v_memberships jsonb;
  v_next_after uuid;
  v_grants jsonb;
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
  select p.display_name, p.facilitator_role, p.label_confirmed_at into v_display_name, v_role, v_confirmed
    from case_app.profiles p where p.id = p_user_id;
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
  -- Each place carries its workspace's policies (CASE-337), so the Worker's authorize reads membership, grant and
  -- policies in this one call (plan §3 A3).
  select coalesce(jsonb_agg(jsonb_build_object(
           'workspace_id', workspace_id, 'slug', slug, 'name', name, 'role', role,
           'policies', case_app.policies_of(workspace_id)
         ) order by workspace_id) filter (where rn <= v_limit), '[]'::jsonb),
         case when count(*) > v_limit then (array_agg(workspace_id) filter (where rn = v_limit))[1] else null end
    into v_memberships, v_next_after from page;
  -- Live grants on live cases (at most 200), with the place's names for the picker and "Shared with you".
  select coalesce(jsonb_agg(jsonb_build_object('case_id', g.case_id, 'workspace_id', g.workspace_id, 'workspace_name', w.name,
           'title', c.title, 'level', g.level, 'policies', case_app.policies_of(g.workspace_id)) order by w.name, c.title, g.case_id), '[]'::jsonb)
    into v_grants
    from (select x.* from case_app.case_grants x where x.user_id = p_user_id and x.revoked_at is null
           and (p_workspace_id is null or x.workspace_id = p_workspace_id) order by x.case_id limit 200) g
    join case_app.cases c on c.id = g.case_id and c.archived_at is null
    join case_app.workspaces w on w.id = g.workspace_id;
  return query select p_user_id, v_display_name, v_memberships, v_next_after, v_admin, v_role, v_confirmed, v_grants;
end;
$$;

-- ─── 10. Privileges: tables closed; new functions revoked from the client roles; RPCs to service_role by signature ─
alter table case_app.workspace_policies enable row level security;
alter table case_app.invitations enable row level security;
alter table case_app.invitation_events enable row level security;
alter table case_app.case_grants enable row level security;
alter table case_app.case_assets enable row level security;
revoke all on case_app.workspace_policies, case_app.invitations, case_app.invitation_events, case_app.case_grants,
  case_app.case_assets from public, anon, authenticated, service_role;

revoke all on function case_app.seed_workspace_policies(), case_app.document_asset_ids(jsonb), case_app.role_rank(text),
  case_app.policies_of(uuid), case_app.grant_role(uuid, uuid), case_app.effective_role(uuid, uuid, uuid),
  case_app.case_of_version(uuid), case_app.authorize_case(uuid, uuid, text, boolean, text),
  case_app.authorize_records(uuid, uuid, text, boolean, text), case_app.record_visible(uuid, boolean, boolean, uuid, uuid),
  case_app.audit_actor(uuid, uuid, text, text, text, text, uuid, bigint, uuid), case_app.media_quota_of(uuid),
  case_app.media_create(uuid, uuid, jsonb, jsonb, jsonb, jsonb, boolean),
  case_app.media_allow_put(uuid, uuid, text, integer, text, boolean),
  case_app.case_sees_asset(uuid, text, uuid, uuid), case_app.unused_assets(uuid), case_app.level_role(text),
  case_app.invitation_daily_cap(), case_app.invitation_cap_retry(uuid), case_app.invitation_facts(case_app.invitations)
  from public, anon, authenticated;

revoke all on function
  case_api.get_me(uuid, integer, uuid, uuid, boolean, text),
  case_api.builder_case_media_put_allowance(uuid, uuid, boolean, text, text, integer, text),
  case_api.builder_create_case_asset(uuid, uuid, boolean, text, jsonb, jsonb, jsonb, jsonb),
  case_api.builder_list_case_assets(uuid, uuid, boolean, text, uuid[]),
  case_api.builder_case_asset_rendition(uuid, uuid, text, uuid, boolean, text),
  case_api.admin_workspace_storage(uuid, uuid, boolean, text),
  case_api.admin_delete_unused_assets(uuid, uuid, uuid[], uuid, boolean, text),
  case_api.get_access(uuid, uuid, uuid, boolean, text),
  case_api.list_shared_cases(uuid),
  case_api.list_case_access(uuid, uuid, boolean, text),
  case_api.revoke_case_grant(uuid, uuid, boolean, text),
  case_api.admin_set_workspace_policies(uuid, uuid, bigint, jsonb, bigint, boolean, text),
  case_api.create_invitation(uuid, uuid, uuid, text, text, bytea, uuid, boolean, text),
  case_api.list_invitations(uuid, uuid, uuid, boolean, text),
  case_api.resend_invitation(uuid, uuid, bytea, boolean, text),
  case_api.record_invitation_delivery(uuid, text, timestamptz),
  case_api.revoke_invitation(uuid, uuid, boolean, text),
  case_api.peek_invitation(bytea),
  case_api.accept_invitations(uuid, text),
  case_api.purge_invitation_addresses(),
  case_api.version_case(uuid),
  case_api.admin_read_access(uuid[])
  from public, anon, authenticated;
grant execute on function
  case_api.get_me(uuid, integer, uuid, uuid, boolean, text),
  case_api.builder_case_media_put_allowance(uuid, uuid, boolean, text, text, integer, text),
  case_api.builder_create_case_asset(uuid, uuid, boolean, text, jsonb, jsonb, jsonb, jsonb),
  case_api.builder_list_case_assets(uuid, uuid, boolean, text, uuid[]),
  case_api.builder_case_asset_rendition(uuid, uuid, text, uuid, boolean, text),
  case_api.admin_workspace_storage(uuid, uuid, boolean, text),
  case_api.admin_delete_unused_assets(uuid, uuid, uuid[], uuid, boolean, text),
  case_api.get_access(uuid, uuid, uuid, boolean, text),
  case_api.list_shared_cases(uuid),
  case_api.list_case_access(uuid, uuid, boolean, text),
  case_api.revoke_case_grant(uuid, uuid, boolean, text),
  case_api.admin_set_workspace_policies(uuid, uuid, bigint, jsonb, bigint, boolean, text),
  case_api.create_invitation(uuid, uuid, uuid, text, text, bytea, uuid, boolean, text),
  case_api.list_invitations(uuid, uuid, uuid, boolean, text),
  case_api.resend_invitation(uuid, uuid, bytea, boolean, text),
  case_api.record_invitation_delivery(uuid, text, timestamptz),
  case_api.revoke_invitation(uuid, uuid, boolean, text),
  case_api.peek_invitation(bytea),
  case_api.accept_invitations(uuid, text),
  case_api.purge_invitation_addresses(),
  case_api.version_case(uuid),
  case_api.admin_read_access(uuid[])
  to service_role;

commit;
