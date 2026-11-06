-- db/tests/case-groups.test.sql
-- Assertions for migrations/20261009000000_case_groups.sql (card 30, CASE-168 (3), docs/PERMISSIONS.md P-12,
-- P-18 to P-20, E14, E16): workspace-scoped groups, one per case, ten curated tints; names unique per workspace
-- among live groups; the composite foreign key keeps a case and its group in one workspace; archive moves cases
-- inside the workspace and never deletes one; every write is CAS-checked and audited in its own transaction
-- with the actor kind; the catalogue filters and labels by group; rooms read the tint they start with.
\set QUIET on
begin;

-- fixtures: workspace X (owner, author, facilitator), workspace Y (its own owner), an admin with no membership.
insert into auth.users values
  ('0199a000-0000-7000-8000-000000003001'), ('0199a000-0000-7000-8000-000000003002'),
  ('0199a000-0000-7000-8000-000000003003'), ('0199a000-0000-7000-8000-000000003004'),
  ('0199a000-0000-7000-8000-000000003005');
insert into case_app.profiles (id, display_name) values
  ('0199a000-0000-7000-8000-000000003001', 'X owner'), ('0199a000-0000-7000-8000-000000003002', 'X author'),
  ('0199a000-0000-7000-8000-000000003003', 'X facilitator'), ('0199a000-0000-7000-8000-000000003004', 'Y owner');
insert into case_app.workspaces (id, slug, name) values
  ('0199a000-0000-7000-8000-00000000300a', 'c30-x', 'Card 30 X'),
  ('0199a000-0000-7000-8000-00000000300b', 'c30-y', 'Card 30 Y');
insert into case_app.workspace_members (workspace_id, user_id, role) values
  ('0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003001', 'owner'),
  ('0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003002', 'author'),
  ('0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003003', 'facilitator'),
  ('0199a000-0000-7000-8000-00000000300b', '0199a000-0000-7000-8000-000000003004', 'owner');
-- Three published cases in X, one in Y.
insert into case_app.cases (id, workspace_id, owner_id, title) values
  ('0199a000-0000-7000-8000-0000000030c1', '0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003002', 'Anaphylaxis'),
  ('0199a000-0000-7000-8000-0000000030c2', '0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003002', 'Bradycardia'),
  ('0199a000-0000-7000-8000-0000000030c3', '0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003002', 'Cardiac arrest'),
  ('0199a000-0000-7000-8000-0000000030c4', '0199a000-0000-7000-8000-00000000300b', '0199a000-0000-7000-8000-000000003004', 'Y case');
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by, published_at)
select ('0199a000-0000-7000-8000-0000000030e' || n)::uuid, ('0199a000-0000-7000-8000-0000000030c' || n)::uuid, 1, 1,
       jsonb_build_object('schema_version', 1, 'summary', 'Case ' || n), sha256(convert_to('c30-' || n, 'UTF8')),
       '0199a000-0000-7000-8000-000000003002', timestamptz '2026-10-01 00:00:00+00' + make_interval(mins => n)
  from generate_series(1, 4) n;
create function pg_temp.refused(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return null;
exception when others then return sqlstate;
end;
$f$;
create function pg_temp.g(p_ws uuid, p_name text) returns uuid language sql as $f$
  select id from case_app.case_groups where workspace_id = p_ws and name = p_name and archived_at is null;
$f$;
-- One step-up recorded for the admin (R-a), as the Worker records it before handing it out.
select case_api.record_admin_elevation('0199a000-0000-7000-8000-0000000030f1', 'admin@example.org', 'admin',
  '0199a000-0000-7000-8000-0000000030f0');

-- [G-1] Names follow cleanText rules (1-60, trimmed, no controls, bidi overrides or doubled spaces);
-- descriptions are optional and at most 200; the tint is one of the ten.
do $$
declare v_owner uuid := '0199a000-0000-7000-8000-000000003001'; v_ws uuid := '0199a000-0000-7000-8000-00000000300a';
  v_bad text[] := array[
    format($s$select case_api.create_group(%L, %L, '', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, %L, null, 'sage', false, null)$s$, v_owner, v_ws, repeat('n', 61)),
    format($s$select case_api.create_group(%L, %L, ' Leading', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, 'Two  spaces', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, E'Tab\there', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, E'Bidi‮override', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, E'Zero​width', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, E'Soft­hyphen', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, E'Joiner‍here', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, E'Grapheme͏joiner', null, 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, 'Fine', E'Word⁠joiner', 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, 'Fine', %L, 'sage', false, null)$s$, v_owner, v_ws, repeat('d', 201)),
    format($s$select case_api.create_group(%L, %L, 'Fine', '', 'sage', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, 'Fine', null, 'magenta', false, null)$s$, v_owner, v_ws),
    format($s$select case_api.create_group(%L, %L, 'Fine', null, null, false, null)$s$, v_owner, v_ws)];
  v_sql text; v_code text;
begin
  foreach v_sql in array v_bad loop
    v_code := pg_temp.refused(v_sql);
    if v_code is distinct from '23514' then raise exception 'G-1: % was not refused as invalid (got %)', v_sql, v_code; end if;
  end loop;
  perform case_api.create_group(v_owner, v_ws, repeat('n', 60), repeat('d', 200), 'neutral', false, null);
  -- The table refuses a bad row even from a writer that skips the RPC.
  if pg_temp.refused(format($s$insert into case_app.case_groups (workspace_id, name, tint) values (%L, 'Direct', 'teal')$s$, v_ws))
     is distinct from '23514' then raise exception 'G-1: the table accepted an unknown tint'; end if;
  raise notice 'ok G-1 group names, descriptions and tints are validated';
end $$;

-- [G-2] Names are unique per workspace among live groups (case-insensitively); the same name in another
-- workspace is allowed; an archived name can be reused.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_y uuid := '0199a000-0000-7000-8000-00000000300b';
  v_owner uuid := '0199a000-0000-7000-8000-000000003001'; v_group uuid;
begin
  select id into v_group from case_api.create_group(v_owner, v_x, 'Emergency', 'Undifferentiated presentations', 'petrol', false, null);
  perform case_api.create_group('0199a000-0000-7000-8000-000000003004', v_y, 'Emergency', null, 'coral', false, null);
  if pg_temp.refused(format($s$select case_api.create_group(%L, %L, 'EMERGENCY', null, 'sky', false, null)$s$, v_owner, v_x))
     is distinct from '23505' then raise exception 'G-2: a duplicate live name in one workspace was accepted'; end if;
  perform case_api.archive_group(v_owner, v_x, v_group, 0, 'Emergency', null, false, null, null);
  perform case_api.create_group(v_owner, v_x, 'Emergency', null, 'sky', false, null);
  if (select count(*) from case_app.case_groups where workspace_id = v_x and lower(name) = 'emergency') <> 2 then
    raise exception 'G-2: the archived name was not reusable'; end if;
  raise notice 'ok G-2 names are unique per workspace among live groups';
end $$;

-- [G-3] One group per case, or Ungrouped; assignment is CAS-checked on the case's group revision.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_owner uuid := '0199a000-0000-7000-8000-000000003001';
  v_case uuid := '0199a000-0000-7000-8000-0000000030c1'; v_a uuid; v_b uuid; r record;
begin
  select id into v_a from case_api.create_group(v_owner, v_x, 'Critical care', null, 'coral', false, null);
  select id into v_b from case_api.create_group(v_owner, v_x, 'Anaesthesia', null, 'periwinkle', false, null);
  select * into r from case_api.assign_case_group(v_owner, v_x, v_case, 0, v_a, false, null);
  if r.group_id <> v_a or r.group_revision <> 1 then raise exception 'G-3: first assignment wrong'; end if;
  perform case_api.assign_case_group(v_owner, v_x, v_case, 1, v_b, false, null);
  if (select group_id from case_app.cases where id = v_case) <> v_b or
     exists (select 1 from case_app.cases where group_id = v_a) then raise exception 'G-3: a case holds more than one group'; end if;
  if pg_temp.refused(format($s$select case_api.assign_case_group(%L, %L, %L, 1, null, false, null)$s$, v_owner, v_x, v_case))
     is distinct from '40001' then raise exception 'G-3: a stale assignment revision was accepted'; end if;
  perform case_api.assign_case_group(v_owner, v_x, v_case, 2, null, false, null);
  if (select group_id from case_app.cases where id = v_case) is not null then raise exception 'G-3: Ungrouped not stored as null'; end if;
  perform case_api.assign_case_group(v_owner, v_x, v_case, 3, v_a, false, null);
  perform case_api.assign_case_group(v_owner, v_x, '0199a000-0000-7000-8000-0000000030c2', 0, v_a, false, null);
  raise notice 'ok G-3 one group per case, CAS-checked';
end $$;

-- [G-4 / E14] A case cannot join another workspace's group: the composite foreign key refuses it directly,
-- the RPC refuses it (and a case of another workspace) as not found, and an archived group cannot be joined.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_y uuid := '0199a000-0000-7000-8000-00000000300b';
  v_owner uuid := '0199a000-0000-7000-8000-000000003001'; v_ygroup uuid := pg_temp.g(v_y, 'Emergency');
begin
  if pg_temp.refused(format($s$update case_app.cases set group_id = %L where id = '0199a000-0000-7000-8000-0000000030c3'$s$, v_ygroup))
     is distinct from '23503' then raise exception 'G-4: the composite foreign key let a case join another workspace''s group'; end if;
  if pg_temp.refused(format($s$select case_api.assign_case_group(%L, %L, '0199a000-0000-7000-8000-0000000030c3', 0, %L, false, null)$s$,
       v_owner, v_x, v_ygroup)) is distinct from 'P0002' then raise exception 'E14: the RPC let a case join another workspace''s group'; end if;
  if pg_temp.refused(format($s$select case_api.assign_case_group(%L, %L, '0199a000-0000-7000-8000-0000000030c4', 0, null, false, null)$s$,
       v_owner, v_x)) is distinct from 'P0002' then raise exception 'E14: the RPC wrote a case of another workspace'; end if;
  if pg_temp.refused(format($s$update case_app.cases set group_id = (select id from case_app.case_groups where workspace_id = %L
       and archived_at is not null limit 1) where id = '0199a000-0000-7000-8000-0000000030c3'$s$, v_x)) is distinct from '23514'
     then raise exception 'G-4: a case joined an archived group'; end if;
  raise notice 'ok G-4 E14 a case and its group stay in one workspace';
end $$;

-- [G-5 / P-12, P-18 to P-20, E16] Owners of the workspace and admins write; authors, facilitators and owners of
-- another workspace are refused every write; an admin archive needs a recorded step-up; members read.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_a uuid := pg_temp.g('0199a000-0000-7000-8000-00000000300a', 'Critical care');
  v_who uuid; v_sql text; v_admin uuid := '0199a000-0000-7000-8000-000000003005';
begin
  foreach v_who in array array['0199a000-0000-7000-8000-000000003002', '0199a000-0000-7000-8000-000000003003',
                               '0199a000-0000-7000-8000-000000003004']::uuid[] loop
    foreach v_sql in array array[
      format($s$select case_api.create_group(%L, %L, 'Nope', null, 'sage', false, null)$s$, v_who, v_x),
      format($s$select case_api.edit_group(%L, %L, %L, 0, 'Nope', null, 'sage', false, null)$s$, v_who, v_x, v_a),
      format($s$select case_api.assign_case_group(%L, %L, '0199a000-0000-7000-8000-0000000030c3', 0, %L, false, null)$s$, v_who, v_x, v_a),
      format($s$select case_api.archive_group(%L, %L, %L, 0, 'Critical care', null, false, null, null)$s$, v_who, v_x, v_a)] loop
      if pg_temp.refused(v_sql) is distinct from '42501' then raise exception 'G-5: % was not refused (42501)', v_sql; end if;
    end loop;
  end loop;
  -- Members read the groups (P-12); an owner of another workspace does not.
  if (select count(*) from case_api.list_groups('0199a000-0000-7000-8000-000000003003', v_x, false, null)) < 3 then
    raise exception 'G-5: a facilitator could not read the groups'; end if;
  if pg_temp.refused(format($s$select * from case_api.list_groups('0199a000-0000-7000-8000-000000003004', %L, false, null)$s$, v_x))
     is distinct from '42501' then raise exception 'G-5: an outsider read the groups'; end if;
  -- An admin without membership writes in any workspace; archive refuses without a matching recorded step-up.
  perform case_api.edit_group(v_admin, v_x, v_a, 0, 'Critical care', 'Admin edit', 'rose', true, 'admin@example.org');
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 1, 'Critical care', null, true, 'admin@example.org', null)$s$,
       v_admin, v_x, v_a)) is distinct from '42501' then raise exception 'G-5: an admin archived without a step-up'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 1, 'Critical care', null, true, 'other@example.org', '0199a000-0000-7000-8000-0000000030f1')$s$,
       v_admin, v_x, v_a)) is distinct from '42501' then raise exception 'G-5: another admin''s step-up was accepted'; end if;
  if pg_temp.refused(format($s$select case_api.edit_group(%L, %L, %L, 1, 'Critical care', null, 'rose', true, null)$s$, v_admin, v_x, v_a))
     is distinct from '42501' then raise exception 'G-5: an admin flag without an email was accepted'; end if;
  raise notice 'ok G-5 E16 only owners of the workspace and admins write groups';
end $$;

-- [G-6] Edit is CAS-checked, keeps the per-workspace unique name, and refuses a group of another workspace.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_owner uuid := '0199a000-0000-7000-8000-000000003001';
  v_a uuid := pg_temp.g('0199a000-0000-7000-8000-00000000300a', 'Critical care'); r record;
begin
  if pg_temp.refused(format($s$select case_api.edit_group(%L, %L, %L, 0, 'Critical care', null, 'sage', false, null)$s$, v_owner, v_x, v_a))
     is distinct from '40001' then raise exception 'G-6: a stale edit was accepted'; end if;
  if pg_temp.refused(format($s$select case_api.edit_group(%L, %L, %L, 1, 'anaesthesia', null, 'sage', false, null)$s$, v_owner, v_x, v_a))
     is distinct from '23505' then raise exception 'G-6: an edit took another live group''s name'; end if;
  if pg_temp.refused(format($s$select case_api.edit_group(%L, %L, %L, 1, 'Moved', null, 'sage', false, null)$s$,
       v_owner, '0199a000-0000-7000-8000-00000000300b', v_a)) is distinct from '42501' then
    raise exception 'G-6: an owner of X edited through workspace Y'; end if;
  if pg_temp.refused(format($s$select case_api.edit_group('0199a000-0000-7000-8000-000000003004', '0199a000-0000-7000-8000-00000000300b', %L, 1, 'Moved', null, 'sage', false, null)$s$,
       v_a)) is distinct from 'P0002' then raise exception 'G-6: an owner of Y edited X''s group through Y'; end if;
  select * into r from case_api.edit_group(v_owner, v_x, v_a, 1, 'Critical care', 'Shock and organ support', 'sage', false, null);
  if r.revision <> 2 or (select tint from case_app.case_groups where id = v_a) <> 'sage' then raise exception 'G-6: edit not applied'; end if;
  raise notice 'ok G-6 edit is CAS-checked and bound to its workspace';
end $$;

-- [G-7] Archive: its disposition is explicit (a live group in the same workspace, or Ungrouped); it moves the
-- cases, never deletes one, needs the exact name typed, and frees the name. A move into another workspace's
-- group, an archived group or itself is refused.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_owner uuid := '0199a000-0000-7000-8000-000000003001';
  v_a uuid := pg_temp.g('0199a000-0000-7000-8000-00000000300a', 'Critical care');
  v_b uuid := pg_temp.g('0199a000-0000-7000-8000-00000000300a', 'Anaesthesia');
  v_y uuid := pg_temp.g('0199a000-0000-7000-8000-00000000300b', 'Emergency');
  v_cases bigint := (select count(*) from case_app.cases); r record;
begin
  if (select count(*) from case_app.cases where group_id = v_a) <> 2 then raise exception 'G-7: fixture expects two cases in A'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 2, 'critical care', null, false, null, null)$s$, v_owner, v_x, v_a))
     is distinct from '23514' then raise exception 'G-7: archive accepted an inexact confirmation'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 2, 'Critical care', %L, false, null, null)$s$, v_owner, v_x, v_a, v_y))
     is distinct from 'P0002' then raise exception 'G-7: archive moved cases into another workspace''s group'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 2, 'Critical care', %L, false, null, null)$s$, v_owner, v_x, v_a, v_a))
     is distinct from 'P0002' then raise exception 'G-7: archive moved cases into the group being archived'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 1, 'Critical care', %L, false, null, null)$s$, v_owner, v_x, v_a, v_b))
     is distinct from '40001' then raise exception 'G-7: a stale archive was accepted'; end if;
  select * into r from case_api.archive_group(v_owner, v_x, v_a, 2, 'Critical care', v_b, false, null, null);
  if r.moved <> 2 or r.revision <> 3 or (select count(*) from case_app.cases where group_id = v_b) <> 2 or
     (select count(*) from case_app.cases) <> v_cases or exists (select 1 from case_app.cases where group_id = v_a) or
     (select archived_at from case_app.case_groups where id = v_a) is null then
    raise exception 'G-7: archive did not move exactly its cases, or deleted one'; end if;
  -- Every moved case's group revision moved on, so a stale assignment from before the archive is refused.
  if pg_temp.refused(format($s$select case_api.assign_case_group(%L, %L, '0199a000-0000-7000-8000-0000000030c2', 1, null, false, null)$s$, v_owner, v_x))
     is distinct from '40001' then raise exception 'G-7: a moved case kept its old revision'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 3, 'Critical care', null, false, null, null)$s$, v_owner, v_x, v_a))
     is distinct from 'P0002' then raise exception 'G-7: an archived group was archived again'; end if;
  if pg_temp.refused(format($s$select case_api.archive_group(%L, %L, %L, 0, 'Anaesthesia', %L, false, null, null)$s$, v_owner, v_x, v_b, v_a))
     is distinct from 'P0002' then raise exception 'G-7: archive moved cases into an archived group'; end if;
  -- An admin archive with this admin's recorded step-up; the cases go to Ungrouped.
  select * into r from case_api.archive_group('0199a000-0000-7000-8000-000000003005', v_x, v_b, 0, 'Anaesthesia', null, true,
    'admin@example.org', '0199a000-0000-7000-8000-0000000030f1');
  if r.moved <> 2 or exists (select 1 from case_app.cases where workspace_id = v_x and group_id is not null) then
    raise exception 'G-7: an archive to Ungrouped left cases grouped'; end if;
  raise notice 'ok G-7 archive moves cases only inside the workspace and never deletes one';
end $$;

-- [G-8] Every write is audited in its own transaction, with the actor kind, the target and the revision; an
-- admin archive names its step-up. Audit rows never carry the group name or description.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a';
  v_a uuid := (select id from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-00000000300a' and name = 'Critical care');
  v_b uuid := (select id from case_app.case_groups where workspace_id = '0199a000-0000-7000-8000-00000000300a' and name = 'Anaesthesia');
begin
  if not exists (select 1 from case_app.workspace_audit where workspace_id = v_x and action = 'group_create' and target_type = 'group'
                 and target_id = v_a and actor_kind = 'owner' and actor_user_id = '0199a000-0000-7000-8000-000000003001' and actor_email is null
                 and revision = 0) then raise exception 'G-8: owner group_create not audited'; end if;
  if not exists (select 1 from case_app.workspace_audit where action = 'group_edit' and target_id = v_a and actor_kind = 'admin'
                 and actor_email = 'admin@example.org' and revision = 1) then raise exception 'G-8: admin group_edit not audited as admin'; end if;
  if not exists (select 1 from case_app.workspace_audit where action = 'group_archive' and target_id = v_b and actor_kind = 'admin'
                 and elevation_id = '0199a000-0000-7000-8000-0000000030f1') then raise exception 'G-8: admin archive did not name its step-up'; end if;
  if (select count(*) from case_app.workspace_audit where action = 'case_group' and target_type = 'case' and workspace_id = v_x) < 8 then
    raise exception 'G-8: assignments and archive moves were not each audited'; end if;
  if exists (select 1 from case_app.workspace_audit where action like 'group%' and workspace_id <> (select workspace_id from case_app.case_groups g where g.id = target_id)) then
    raise exception 'G-8: a group audit row left its workspace'; end if;
  raise notice 'ok G-8 every group write audited with its actor kind';
end $$;

-- [G-9] The catalogue filters by group or Ungrouped on the server, returns the group's name and tint (neutral
-- when Ungrouped), sorts by group, refuses a foreign or archived group, and counts each live group.
do $$
declare v_x uuid := '0199a000-0000-7000-8000-00000000300a'; v_fac uuid := '0199a000-0000-7000-8000-000000003003';
  v_owner uuid := '0199a000-0000-7000-8000-000000003001'; v_e uuid := pg_temp.g('0199a000-0000-7000-8000-00000000300a', 'Emergency');
  v_rows bigint; r record;
begin
  perform case_api.assign_case_group(v_owner, v_x, '0199a000-0000-7000-8000-0000000030c3', 0, v_e, false, null);
  select count(*) into v_rows from case_api.list_case_catalogue(v_fac, v_x, 'title', false, null, null, null, 50, 0, v_e, false, false, null);
  if v_rows <> 1 then raise exception 'G-9: the group filter returned % rows', v_rows; end if;
  select * into r from case_api.list_case_catalogue(v_fac, v_x, 'title', false, null, null, null, 50, 0, v_e, false, false, null);
  if r.case_id <> '0199a000-0000-7000-8000-0000000030c3' or r.group_id <> v_e or r.group_name <> 'Emergency' or r.tint <> 'sky' or r.total_count <> 1 then
    raise exception 'G-9: the filtered row lacks its group'; end if;
  select count(*) into v_rows from case_api.list_case_catalogue(v_fac, v_x, 'title', false, null, null, null, 50, 0, null, true, false, null);
  if v_rows <> 2 or exists (select 1 from case_api.list_case_catalogue(v_fac, v_x, 'title', false, null, null, null, 50, 0, null, true, false, null)
                            where group_id is not null or group_name is not null or tint <> 'neutral') then
    raise exception 'G-9: Ungrouped returned the wrong rows'; end if;
  -- Sort by group: named groups by name, Ungrouped last.
  if (select array_agg(group_name order by n) from (select group_name, row_number() over () n
        from case_api.list_case_catalogue(v_fac, v_x, 'group', false, null, null, null, 50, 0, null, false, false, null)) s)
     is distinct from array['Emergency', null, null] then raise exception 'G-9: group sort wrong'; end if;
  if pg_temp.refused(format($s$select * from case_api.list_case_catalogue(%L, %L, 'title', false, null, null, null, 50, 0, %L, false, false, null)$s$,
       v_fac, v_x, pg_temp.g('0199a000-0000-7000-8000-00000000300b', 'Emergency'))) is distinct from '22023' then
    raise exception 'G-9: a foreign group filter was not refused'; end if;
  if pg_temp.refused(format($s$select * from case_api.list_case_catalogue(%L, %L, 'title', false, null, null, null, 50, 0, %L, true, false, null)$s$,
       v_fac, v_x, v_e)) is distinct from '22023' then raise exception 'G-9: group and Ungrouped together were not refused'; end if;
  -- The card 35 11-argument signature (expand window) is dropped by the card 35b contract migration.
  if to_regprocedure('case_api.list_case_catalogue(uuid,uuid,text,boolean,text,integer,text,integer,integer,boolean,text)') is not null then
    raise exception 'G-9: the expand-window catalogue signature still exists'; end if;
  -- Groups with catalogue counts; Ungrouped is its own row (null id), last.
  if (select jsonb_agg(jsonb_build_object('n', name, 't', tint, 'c', case_count) order by n)
        from (select *, row_number() over () n from case_api.list_case_catalogue_groups(v_fac, v_x, false, null)) s)
     is distinct from '[{"n":"Emergency","t":"sky","c":1},{"n":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","t":"neutral","c":0},{"n":null,"t":"neutral","c":2}]'::jsonb then
    raise exception 'G-9: catalogue group counts wrong: %', (select jsonb_agg(x) from case_api.list_case_catalogue_groups(v_fac, v_x, false, null) x); end if;
  -- Case detail's group read, bound to the case's workspace.
  select * into r from case_api.get_case_group(v_fac, '0199a000-0000-7000-8000-0000000030c3', false, null);
  if r.workspace_id <> v_x or r.group_id <> v_e or r.tint <> 'sky' or r.group_revision <> 1 then raise exception 'G-9: case group read wrong'; end if;
  if pg_temp.refused($s$select * from case_api.get_case_group('0199a000-0000-7000-8000-000000003004', '0199a000-0000-7000-8000-0000000030c3', false, null)$s$)
     is distinct from '42501' then raise exception 'G-9: an outsider read a case group'; end if;
  raise notice 'ok G-9 catalogue filters, labels and counts by group';
end $$;

-- [G-10] Room start reads the case's current tint with the version (a running room keeps the one it started
-- with in its Durable Object); the admin case list carries each case's group for Admin -> Cases.
do $$
declare v_tint text; r record;
begin
  select tint into v_tint from case_api.get_case_version_for_workspace('0199a000-0000-7000-8000-0000000030e3',
    '0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003003', false, null);
  if v_tint is distinct from 'sky' then raise exception 'G-10: room start did not read the tint (%)', v_tint; end if;
  select tint into v_tint from case_api.get_case_version_for_workspace('0199a000-0000-7000-8000-0000000030e1',
    '0199a000-0000-7000-8000-00000000300a', '0199a000-0000-7000-8000-000000003003', false, null);
  if v_tint is distinct from 'neutral' then raise exception 'G-10: an Ungrouped case did not start neutral'; end if;
  select * into r from case_api.list_admin_case_versions(100, null) where version_id = '0199a000-0000-7000-8000-0000000030e3';
  if r.workspace_id <> '0199a000-0000-7000-8000-00000000300a' or r.group_name <> 'Emergency' or r.tint <> 'sky' or r.group_revision <> 1 then
    raise exception 'G-10: the admin case list lacks the group'; end if;
  raise notice 'ok G-10 room start and the admin case list read the group';
end $$;

-- [G-11] No grants: the table is service-definer only; every group RPC executes for service_role only.
do $$
declare sig text;
begin
  if has_table_privilege('anon', 'case_app.case_groups', 'select') or has_table_privilege('authenticated', 'case_app.case_groups', 'select') or
     has_table_privilege('service_role', 'case_app.case_groups', 'select') or has_table_privilege('service_role', 'case_app.case_groups', 'insert')
    then raise exception 'G-11: case_groups is granted'; end if;
  foreach sig in array array['case_api.list_groups(uuid,uuid,boolean,text)', 'case_api.create_group(uuid,uuid,text,text,text,boolean,text)',
    'case_api.edit_group(uuid,uuid,uuid,bigint,text,text,text,boolean,text)', 'case_api.assign_case_group(uuid,uuid,uuid,bigint,uuid,boolean,text)',
    'case_api.archive_group(uuid,uuid,uuid,bigint,text,uuid,boolean,text,uuid)',
    'case_api.list_case_catalogue(uuid,uuid,text,boolean,text,integer,text,integer,integer,uuid,boolean,boolean,text)',
    'case_api.list_case_catalogue_groups(uuid,uuid,boolean,text)', 'case_api.get_case_group(uuid,uuid,boolean,text)',
    'case_api.get_case_version_for_workspace(uuid,uuid,uuid,boolean,text)', 'case_api.list_admin_case_versions(integer,uuid)'] loop
    if not has_function_privilege('service_role', sig, 'execute') then raise exception 'G-11: service_role cannot execute %', sig; end if;
    if has_function_privilege('anon', sig, 'execute') or has_function_privilege('authenticated', sig, 'execute') then
      raise exception 'G-11: a public role can execute %', sig; end if;
  end loop;
  raise notice 'ok G-11 group privileges';
end $$;

rollback;
