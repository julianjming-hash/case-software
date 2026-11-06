-- Card 30 (CASE-168 (3), docs/PERMISSIONS.md P-12, P-18 to P-20, E14, E16): workspace-scoped case groups.
--
--   case_app.case_groups  one workspace each; a name (cleanText rules, 1-60) unique among the workspace's live
--     groups (case-insensitively; an archived name can be reused); an optional description (<= 200); one of
--     ten curated tints (Julian, 2026-10-06: never a free picker); archived, never deleted; CAS revision.
--   case_app.cases.group_id  one group per case, or null (Ungrouped). The composite foreign key
--     (group_id, workspace_id) -> case_groups (id, workspace_id) means the database refuses a case joining
--     another workspace's group (E14); a trigger refuses joining an archived one. group_revision is the CAS
--     revision of the assignment.
--   Groups never grant or revoke access (invariant 8): no authorization predicate reads them.
--
-- RPCs (service_role only; each authorizes through case_app.authorize and binds every child id to the
-- workspace it authorizes, invariant 6): list_groups (P-12), create_group and edit_group (P-18),
-- archive_group (P-19; an admin names a recorded step-up, R-a), assign_case_group (P-20). Every write names
-- its expected revision and writes case_app.workspace_audit in the same transaction, actor_kind 'owner' or
-- 'admin'. Archive moves its cases to a named live group of the same workspace, or to Ungrouped, and never
-- deletes a case. Audit rows carry ids and revisions only, never a name or description (invariant 12).
--
-- Catalogue (card 29 signatures are dropped and recreated, never edited, AGENTS.md rule 7). EXPAND step: the
-- running Workers call the card 35 list_case_catalogue (11 arguments) and refuse a row with unknown keys, so
-- that signature stays unchanged beside a NEW 13-argument overload that takes p_group_id and p_ungrouped
-- (no defaults, so a named call resolves to exactly one) and returns group_id, group_name and tint. The later
-- contract migration drops the 11-argument one. get_case_version_for_workspace (room start reads the tint the
-- room freezes in its Durable Object) and list_admin_case_versions keep their arguments and append columns;
-- the running Workers read named fields and ignore the extra ones.
-- No grants to anon or authenticated (AGENTS.md rule 5).
begin;

-- ─── validation ───────────────────────────────────────────────────────────────────────────────────
-- The same rules as src/shared/text.mjs cleanText: no C0/C1 controls, bidi overrides or isolates, BOM,
-- leading or trailing space, or runs of whitespace. The Worker cleans; the database refuses anything else.
create function case_app.group_text_ok(p_text text, p_max integer)
returns boolean language sql immutable set search_path = '' as $$
  select p_text is not null and char_length(p_text) between 1 and p_max and
         p_text !~ '[[:cntrl:]\u0080-\u009f\u202a-\u202e\u2066-\u2069\ufeff]' and
         -- Invisible characters (Unicode Default_Ignorable_Code_Point; card 30 red-team), the same set as
         -- src/shared/groups.mjs; tests/groups.test.mjs proves the two lists equal.
         p_text !~ -- DEFAULT_IGNORABLE
           '[\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]' and
         p_text !~ '^\s' and p_text !~ '\s$' and p_text !~ '\s\s';
$$;
create function case_app.group_tint_ok(p_tint text)
returns boolean language sql immutable set search_path = '' as $$
  select p_tint is not null and p_tint in ('petrol', 'sage', 'olive', 'ochre', 'coral', 'rose', 'plum', 'periwinkle', 'sky', 'neutral');
$$;

-- ─── schema ───────────────────────────────────────────────────────────────────────────────────────
create table case_app.case_groups (
  id            uuid primary key default case_app.uuid_v7(),
  workspace_id  uuid not null references case_app.workspaces (id) on delete restrict,
  name          text not null check (case_app.group_text_ok(name, 60)),
  description   text check (description is null or case_app.group_text_ok(description, 200)),
  tint          text not null default 'neutral' check (case_app.group_tint_ok(tint)),
  archived_at   timestamptz,
  revision      bigint not null default 0 check (revision >= 0),
  created_by    uuid references case_app.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index case_groups_live_name_idx on case_app.case_groups (workspace_id, lower(name)) where archived_at is null;
revoke all on case_app.case_groups from public, anon, authenticated, service_role;

alter table case_app.cases
  add column group_id uuid,
  add column group_revision bigint not null default 0 check (group_revision >= 0),
  add constraint cases_group_same_workspace foreign key (group_id, workspace_id)
    references case_app.case_groups (id, workspace_id) on delete restrict;
create index cases_group_idx on case_app.cases (group_id) where group_id is not null;

-- A case never joins an archived group (archive moves its cases first, then archives). The group row is read
-- FOR SHARE: an archive in flight holds it FOR UPDATE, so this waits and then re-reads the committed row
-- (card 30 red-team: an assignment racing an archive must not land in the archived group).
create function case_app.guard_case_group()
returns trigger language plpgsql set search_path = '' as $$
declare v_archived timestamptz;
begin
  if new.group_id is not null and (tg_op = 'INSERT' or new.group_id is distinct from old.group_id) then
    select g.archived_at into v_archived from case_app.case_groups g where g.id = new.group_id for share;
    if v_archived is not null then
      raise exception 'archived_group: a case cannot join an archived group' using errcode = '23514'; end if;
  end if;
  return new;
end;
$$;
create trigger cases_group_live
  before insert or update of group_id on case_app.cases
  for each row execute function case_app.guard_case_group();

-- The group actions join card 35's workspace audit allow-list.
alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check (action in ('workspace_create',
  'case_create', 'draft_save', 'version_publish', 'version_withdraw', 'version_republish', 'room_start',
  'workspace_ownerless', 'member_invite', 'owner_assign', 'group_create', 'group_edit', 'group_archive', 'case_group'));
alter table case_app.workspace_audit drop constraint workspace_audit_target_type_check;
alter table case_app.workspace_audit add constraint workspace_audit_target_type_check
  check (target_type in ('workspace', 'case', 'version', 'room', 'member', 'group'));

-- One audit writer for group actions: the owner path (no email) or the admin path (its email, and the step-up
-- that admitted it, if any).
create function case_app.audit_group(
  p_workspace_id uuid, p_user_id uuid, p_role text, p_admin_email text, p_action text, p_target_type text,
  p_target_id uuid, p_revision bigint, p_elevation_id uuid default null
) returns void language sql set search_path = '' as $$
  insert into case_app.workspace_audit
    (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id, revision, elevation_id)
  values (p_workspace_id, case when p_role = 'admin' then 'admin' else 'owner' end, p_user_id,
          case when p_role = 'admin' then p_admin_email end, p_action, p_target_type, p_target_id, p_revision,
          case when p_role = 'admin' then p_elevation_id end);
$$;

create function case_app.check_group_fields(p_name text, p_description text, p_tint text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if not case_app.group_text_ok(p_name, 60) or (p_description is not null and not case_app.group_text_ok(p_description, 200)) or
     not case_app.group_tint_ok(p_tint) then
    raise exception 'invalid_group' using errcode = '23514'; end if;
end;
$$;

-- A live group of this workspace, or P0002 (refused, never filtered: invariant 6). Locked FOR SHARE until the
-- caller commits, so a concurrent archive of it waits for this write, or this write waits for the archive and
-- then sees it archived (card 30 red-team: crossed archives, an assignment racing an archive).
create function case_app.live_group(p_workspace_id uuid, p_group_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
begin
  perform 1 from case_app.case_groups g
   where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null for share;
  if p_group_id is null or not found then
    raise exception 'no_such_group' using errcode = 'P0002'; end if;
end;
$$;

-- ─── group RPCs ───────────────────────────────────────────────────────────────────────────────────

create function case_api.list_groups(p_user_id uuid, p_workspace_id uuid, p_admin boolean, p_admin_email text)
returns table (id uuid, name text, description text, tint text, revision bigint, case_count bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-12', p_admin, p_admin_email);
  return query
    select g.id, g.name, g.description, g.tint, g.revision,
           (select count(*) from case_app.cases c where c.group_id = g.id and c.archived_at is null)
      from case_app.case_groups g
     where g.workspace_id = p_workspace_id and g.archived_at is null
     order by lower(g.name), g.id
     limit 100;
end;
$$;

create function case_api.create_group(
  p_user_id uuid, p_workspace_id uuid, p_name text, p_description text, p_tint text, p_admin boolean, p_admin_email text
) returns table (id uuid, revision bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_role text; v_id uuid;
begin
  v_role := case_app.authorize(p_user_id, p_workspace_id, 'P-18', p_admin, p_admin_email);
  perform case_app.check_group_fields(p_name, p_description, p_tint);
  -- Serialise creates per workspace so two at 99 cannot both pass the cap (card 30 red-team).
  perform 1 from case_app.workspaces w where w.id = p_workspace_id for update;
  if (select count(*) from case_app.case_groups g where g.workspace_id = p_workspace_id and g.archived_at is null) >= 100 then
    raise exception 'group_limit' using errcode = '23514'; end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  insert into case_app.case_groups (workspace_id, name, description, tint, created_by)
  values (p_workspace_id, p_name, p_description, p_tint, p_user_id) returning case_groups.id into v_id;
  perform case_app.audit_group(p_workspace_id, p_user_id, v_role, p_admin_email, 'group_create', 'group', v_id, 0);
  return query select v_id, 0::bigint;
end;
$$;

create function case_api.edit_group(
  p_user_id uuid, p_workspace_id uuid, p_group_id uuid, p_expected_revision bigint,
  p_name text, p_description text, p_tint text, p_admin boolean, p_admin_email text
) returns table (id uuid, revision bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_role text; v_rev bigint;
begin
  v_role := case_app.authorize(p_user_id, p_workspace_id, 'P-18', p_admin, p_admin_email);
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'invalid_revision' using errcode = '22023'; end if;
  perform case_app.check_group_fields(p_name, p_description, p_tint);
  perform case_app.live_group(p_workspace_id, p_group_id);
  update case_app.case_groups g
     set name = p_name, description = p_description, tint = p_tint, revision = g.revision + 1, updated_at = now()
   where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null and g.revision = p_expected_revision
  returning g.revision into v_rev;
  if v_rev is null then
    raise exception 'revision_conflict: group % is not at revision %', p_group_id, p_expected_revision using errcode = '40001'; end if;
  perform case_app.audit_group(p_workspace_id, p_user_id, v_role, p_admin_email, 'group_edit', 'group', p_group_id, v_rev);
  return query select p_group_id, v_rev;
end;
$$;

-- The case is named with its workspace, and both are checked: a case of another workspace, or a group of
-- another workspace, is P0002 (E14); the composite foreign key is the backstop.
create function case_api.assign_case_group(
  p_user_id uuid, p_workspace_id uuid, p_case_id uuid, p_expected_revision bigint, p_group_id uuid,
  p_admin boolean, p_admin_email text
) returns table (case_id uuid, group_id uuid, group_revision bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_role text; v_rev bigint;
begin
  v_role := case_app.authorize(p_user_id, p_workspace_id, 'P-20', p_admin, p_admin_email);
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'invalid_revision' using errcode = '22023'; end if;
  if p_case_id is null or not exists (select 1 from case_app.cases c
      where c.id = p_case_id and c.workspace_id = p_workspace_id and c.archived_at is null) then
    raise exception 'no_such_case' using errcode = 'P0002'; end if;
  if p_group_id is not null then perform case_app.live_group(p_workspace_id, p_group_id); end if;
  update case_app.cases c set group_id = p_group_id, group_revision = c.group_revision + 1
   where c.id = p_case_id and c.workspace_id = p_workspace_id and c.group_revision = p_expected_revision
  returning c.group_revision into v_rev;
  if v_rev is null then
    raise exception 'revision_conflict: case % group is not at revision %', p_case_id, p_expected_revision using errcode = '40001'; end if;
  perform case_app.audit_group(p_workspace_id, p_user_id, v_role, p_admin_email, 'case_group', 'case', p_case_id, v_rev);
  return query select p_case_id, p_group_id, v_rev;
end;
$$;

-- Archive (P-19): the exact name typed, an explicit disposition (a live group of this workspace, or null for
-- Ungrouped), CAS on the group revision. An admin needs a step-up recorded for this admin in the admin scope
-- (owners keep type-to-confirm only; PERMISSIONS §4). Cases move first, each audited; then the group archives.
create function case_api.archive_group(
  p_user_id uuid, p_workspace_id uuid, p_group_id uuid, p_expected_revision bigint, p_confirm_name text,
  p_move_to uuid, p_admin boolean, p_admin_email text, p_elevation_id uuid
) returns table (id uuid, revision bigint, moved bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_role text; v_name text; v_rev bigint; v_moved bigint;
begin
  -- Lock the group and its disposition target together, in id order, before anything else: crossed archives
  -- (D into C while C into D) then serialise instead of deadlocking (40P01; card 30 re-check).
  perform 1 from case_app.case_groups g where g.id in (p_group_id, p_move_to) order by g.id for update;
  v_role := case_app.authorize(p_user_id, p_workspace_id, 'P-19', p_admin, p_admin_email);
  if v_role = 'admin' then perform case_app.assert_elevation(p_elevation_id, p_admin_email, 'admin'); end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'invalid_revision' using errcode = '22023'; end if;
  select g.name, g.revision into v_name, v_rev from case_app.case_groups g
   where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null for update;
  if not found then raise exception 'no_such_group' using errcode = 'P0002'; end if;
  if v_rev <> p_expected_revision then
    raise exception 'revision_conflict: group % is not at revision %', p_group_id, p_expected_revision using errcode = '40001'; end if;
  if p_confirm_name is distinct from v_name then raise exception 'confirm_mismatch' using errcode = '23514'; end if;
  if p_move_to is not null then
    if p_move_to = p_group_id then raise exception 'no_such_group' using errcode = 'P0002'; end if;
    perform case_app.live_group(p_workspace_id, p_move_to);
  end if;
  with moved as (
    update case_app.cases c set group_id = p_move_to, group_revision = c.group_revision + 1
     where c.group_id = p_group_id and c.workspace_id = p_workspace_id
    returning c.id, c.group_revision
  ), audited as (
    insert into case_app.workspace_audit
      (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id, revision, elevation_id)
    select p_workspace_id, case when v_role = 'admin' then 'admin' else 'owner' end, p_user_id,
           case when v_role = 'admin' then p_admin_email end, 'case_group', 'case', m.id, m.group_revision,
           case when v_role = 'admin' then p_elevation_id end
      from moved m
    returning 1
  ) select count(*) into v_moved from audited;
  update case_app.case_groups g set archived_at = now(), revision = g.revision + 1, updated_at = now()
   where g.id = p_group_id returning g.revision into v_rev;
  perform case_app.audit_group(p_workspace_id, p_user_id, v_role, p_admin_email, 'group_archive', 'group', p_group_id,
    v_rev, p_elevation_id);
  return query select p_group_id, v_rev, v_moved;
end;
$$;

-- Case detail's group (P-12): the case's workspace is derived from the case, never supplied.
create function case_api.get_case_group(p_user_id uuid, p_case_id uuid, p_admin boolean, p_admin_email text)
returns table (case_id uuid, workspace_id uuid, group_id uuid, group_name text, tint text, group_revision bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_ws uuid := case_app.workspace_of_case(p_case_id);
begin
  if v_ws is null then return; end if;
  perform case_app.authorize(p_user_id, v_ws, 'P-12', p_admin, p_admin_email);
  return query
    select c.id, c.workspace_id, c.group_id, g.name, coalesce(g.tint, 'neutral'), c.group_revision
      from case_app.cases c left join case_app.case_groups g on g.id = c.group_id
     where c.id = p_case_id;
end;
$$;

-- ─── catalogue (card 29), expand step ─────────────────────────────────────────────────────────────
-- The new overload: the card 35 body plus the group filter (a live group of this workspace, or Ungrouped),
-- the group sort (named groups by name, Ungrouped last) and the group columns. Tint is 'neutral' when Ungrouped.
create function case_api.list_case_catalogue(
  p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text,
  p_duration integer, p_audience text, p_limit integer, p_offset integer,
  p_group_id uuid, p_ungrouped boolean, p_admin boolean, p_admin_email text
) returns table (
  version_id uuid, case_id uuid, title text, summary text, audience text, setting text,
  duration_min integer, version_no integer, published_at timestamptz, content_sha256 bytea,
  art jsonb, group_id uuid, group_name text, tint text, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience', 'group') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15, 45)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) or
     p_ungrouped is null or (p_ungrouped and p_group_id is not null) or
     (p_group_id is not null and not exists (select 1 from case_app.case_groups g
        where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null)) then
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
             v.content_sha256::bytea as l_digest, a.descriptor as l_art,
             c.group_id as l_group, g.name as l_group_name, coalesce(g.tint, 'neutral') as l_tint
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_groups g on g.id = c.group_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
         and (p_group_id is null or l.l_group = p_group_id)
         and (not p_ungrouped or l.l_group is null)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, f.l_group, f.l_group_name, f.l_tint, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'group' and not p_descending then lower(f.l_group_name) end asc nulls last,
       case when p_sort = 'group' and p_descending then lower(f.l_group_name) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$$;

-- The library's group filter and board columns: each live group with its catalogue count, then Ungrouped
-- (a null id, tint neutral). Bounded by the 100-group limit.
create function case_api.list_case_catalogue_groups(p_user_id uuid, p_workspace_id uuid, p_admin boolean, p_admin_email text)
returns table (group_id uuid, name text, tint text, case_count bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  return query
    with listed as (
      select c.group_id as l_group from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.cases c on c.id = lv.case_id where lv.latest
    ), grp_rows as (
      select g.id as r_id, g.name as r_name, g.tint as r_tint,
             (select count(*) from listed l where l.l_group = g.id) as r_count, 0 as r_ord, lower(g.name) as r_key
        from case_app.case_groups g where g.workspace_id = p_workspace_id and g.archived_at is null
      union all
      select null, null, 'neutral', (select count(*) from listed l where l.l_group is null), 1, null
    )
    select r.r_id, r.r_name, r.r_tint, r.r_count from grp_rows r order by r.r_ord, r.r_key, r.r_id;
end;
$$;

-- Room start reads the case's current tint with the version; the room keeps it for its life (CASE-168 (4)).
drop function case_api.get_case_version_for_workspace(uuid, uuid, uuid, boolean, text);
create function case_api.get_case_version_for_workspace(
  p_version_id uuid, p_workspace_id uuid, p_user_id uuid,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  case_id uuid, version_no integer, schema_version integer,
  document jsonb, document_text text, content_sha256 bytea, art jsonb, tint text
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  return query select v.case_id, v.version_no, v.schema_version,
    v.document, v.document::text, v.content_sha256::bytea, a.descriptor, coalesce(g.tint, 'neutral')
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
    left join case_app.case_groups g on g.id = c.group_id
    left join case_app.case_version_art a on a.case_version_id = v.id
    where v.id = p_version_id and c.workspace_id = p_workspace_id and
      not exists (select 1 from case_app.admin_version_state av
        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

-- Admin -> Cases gains a Group column and Change group (the case's workspace and assignment revision).
drop function case_api.list_admin_case_versions(integer, uuid);
create function case_api.list_admin_case_versions(p_limit integer default 100, p_after uuid default null)
returns table (case_id uuid, version_id uuid, version_no integer, title text, status text, admin_revision bigint,
  workspace_id uuid, group_id uuid, group_name text, tint text, group_revision bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'invalid_version_page' using errcode='22023'; end if;
  if p_after is not null and not exists(select 1 from case_app.case_versions v where v.id=p_after) then
    raise exception 'invalid_page_cursor' using errcode='22023'; end if;
  return query select c.id,v.id,v.version_no,c.title,coalesce(s.status,'published'),coalesce(s.admin_revision,0::bigint),
         c.workspace_id,c.group_id,g.name,coalesce(g.tint,'neutral'),c.group_revision
    from case_app.case_versions v join case_app.cases c on c.id=v.case_id
    left join case_app.admin_version_state s on s.case_version_id=v.id
    left join case_app.case_groups g on g.id=c.group_id
   where p_after is null or v.id<p_after order by v.id desc limit p_limit;
end;
$$;

-- ─── privileges ───────────────────────────────────────────────────────────────────────────────────
revoke all on function
  case_app.group_text_ok(text, integer), case_app.group_tint_ok(text), case_app.guard_case_group(),
  case_app.audit_group(uuid, uuid, text, text, text, text, uuid, bigint, uuid),
  case_app.check_group_fields(text, text, text), case_app.live_group(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  case_api.list_groups(uuid, uuid, boolean, text),
  case_api.create_group(uuid, uuid, text, text, text, boolean, text),
  case_api.edit_group(uuid, uuid, uuid, bigint, text, text, text, boolean, text),
  case_api.assign_case_group(uuid, uuid, uuid, bigint, uuid, boolean, text),
  case_api.archive_group(uuid, uuid, uuid, bigint, text, uuid, boolean, text, uuid),
  case_api.get_case_group(uuid, uuid, boolean, text),
  case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer, uuid, boolean, boolean, text),
  case_api.list_case_catalogue_groups(uuid, uuid, boolean, text),
  case_api.get_case_version_for_workspace(uuid, uuid, uuid, boolean, text),
  case_api.list_admin_case_versions(integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  case_api.list_groups(uuid, uuid, boolean, text),
  case_api.create_group(uuid, uuid, text, text, text, boolean, text),
  case_api.edit_group(uuid, uuid, uuid, bigint, text, text, text, boolean, text),
  case_api.assign_case_group(uuid, uuid, uuid, bigint, uuid, boolean, text),
  case_api.archive_group(uuid, uuid, uuid, bigint, text, uuid, boolean, text, uuid),
  case_api.get_case_group(uuid, uuid, boolean, text),
  case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer, uuid, boolean, boolean, text),
  case_api.list_case_catalogue_groups(uuid, uuid, boolean, text),
  case_api.get_case_version_for_workspace(uuid, uuid, uuid, boolean, text),
  case_api.list_admin_case_versions(integer, uuid)
  to service_role;

commit;
