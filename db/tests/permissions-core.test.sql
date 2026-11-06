-- db/tests/permissions-core.test.sql
-- Assertions for migrations/20261008000000_permissions_core.sql (card 35, docs/PERMISSIONS.md): the admin
-- path, same-transaction workspace audit, the admin-only refusals, the last-owner guard, the asset binding,
-- the one authorization core (no inline membership joins remain), and the append-only audit. Test ids are
-- the PERMISSIONS §7 catalogue's (PM-NN). The per-row matrix itself is db/tests/permission-matrix.test.sql.
\set QUIET on
begin;

-- fixtures: workspace H (owner, author, facilitator), workspace Y (its own owner), an admin with no
-- membership, an outsider, and a second H owner used by the last-owner cases.
insert into auth.users values
  ('0199a000-0000-7000-8000-000000003601'), ('0199a000-0000-7000-8000-000000003602'),
  ('0199a000-0000-7000-8000-000000003603'), ('0199a000-0000-7000-8000-000000003604'),
  ('0199a000-0000-7000-8000-000000003605'), ('0199a000-0000-7000-8000-000000003606'),
  ('0199a000-0000-7000-8000-000000003607');
insert into case_app.profiles (id, display_name) values
  ('0199a000-0000-7000-8000-000000003601', 'H owner'), ('0199a000-0000-7000-8000-000000003602', 'H author'),
  ('0199a000-0000-7000-8000-000000003603', 'H facilitator'), ('0199a000-0000-7000-8000-000000003604', 'Y owner'),
  ('0199a000-0000-7000-8000-000000003607', 'Lone owner');
insert into case_app.workspaces (id, slug, name) values
  ('0199a000-0000-7000-8000-00000000360a', 'c35-home', 'Card 35 home'),
  ('0199a000-0000-7000-8000-00000000360b', 'c35-other', 'Card 35 other'),
  ('0199a000-0000-7000-8000-00000000360c', 'c35-lone', 'Card 35 lone');
insert into case_app.workspace_members (workspace_id, user_id, role) values
  ('0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003601', 'owner'),
  ('0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003602', 'author'),
  ('0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003603', 'facilitator'),
  ('0199a000-0000-7000-8000-00000000360b', '0199a000-0000-7000-8000-000000003604', 'owner'),
  ('0199a000-0000-7000-8000-00000000360c', '0199a000-0000-7000-8000-000000003607', 'owner');
-- One case per workspace, with a published version each.
insert into case_app.cases (id, workspace_id, owner_id, title) values
  ('0199a000-0000-7000-8000-0000000036c1', '0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003602', 'H case'),
  ('0199a000-0000-7000-8000-0000000036c2', '0199a000-0000-7000-8000-00000000360b', '0199a000-0000-7000-8000-000000003604', 'Y case');
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by) values
  ('0199a000-0000-7000-8000-0000000036e1', '0199a000-0000-7000-8000-0000000036c1', 1, 1, '{"title":"H"}', sha256('h'), '0199a000-0000-7000-8000-000000003602'),
  ('0199a000-0000-7000-8000-0000000036e2', '0199a000-0000-7000-8000-0000000036c2', 1, 1, '{"title":"Y"}', sha256('y'), '0199a000-0000-7000-8000-000000003604');
create temp table c35_doc as select '{"schema_version":1,"start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb as doc;
create function pg_temp.c35_art() returns jsonb language sql as $f$
  select case_app.art_structure((select doc from c35_doc)) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb;
$f$;
create function pg_temp.refused(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return null;
exception when others then return sqlstate || ' ' || sqlerrm;
end;
$f$;

-- [PM-08] An admin with no membership creates, saves and publishes a case; each write is audited as admin.
do $$
declare
  v_admin uuid := '0199a000-0000-7000-8000-000000003605';
  v_ws uuid := '0199a000-0000-7000-8000-00000000360a';
  v_case uuid; v_rev bigint; v_version uuid;
begin
  v_case := case_api.create_case(v_admin, v_ws, 'Admin case', true, 'admin@example.org');
  v_rev := case_api.save_draft(v_case, 0, 1, (select doc from c35_doc), v_admin, true, 'admin@example.org');
  select r.version_id into v_version from case_api.publish_draft_with_art(v_case, v_rev, v_admin, '{}', pg_temp.c35_art(), true, 'admin@example.org') r;
  if v_version is null or (select display_name from case_app.profiles where id = v_admin) <> 'Facilitator' then
    raise exception 'PM-08: admin write or admin profile missing'; end if;
  if (select array_agg(action order by at, id) from case_app.workspace_audit where workspace_id = v_ws and actor_user_id = v_admin)
     is distinct from array['case_create', 'draft_save', 'version_publish'] or
     exists (select 1 from case_app.workspace_audit where actor_user_id = v_admin and
             (actor_kind <> 'admin' or actor_email <> 'admin@example.org')) or
     (select target_id from case_app.workspace_audit where action = 'version_publish' and actor_user_id = v_admin) <> v_version or
     (select revision from case_app.workspace_audit where action = 'draft_save' and actor_user_id = v_admin) <> v_rev then
    raise exception 'PM-08: admin writes were not each audited as admin'; end if;
  -- A member's own write is not an admin action and leaves no admin audit row.
  perform case_api.create_case('0199a000-0000-7000-8000-000000003602', v_ws, 'Author case');
  if exists (select 1 from case_app.workspace_audit where actor_user_id = '0199a000-0000-7000-8000-000000003602') then
    raise exception 'PM-08: a member write was audited as admin'; end if;
  raise notice 'ok PM-08 admin authors without membership, every write audited as admin';
end $$;

-- [PM-09] An admin starts a room in a workspace they do not belong to; audited; the admin is the starter.
do $$
declare v_admin uuid := '0199a000-0000-7000-8000-000000003605'; v_room uuid := case_app.uuid_v7();
begin
  perform case_api.create_session(v_room, '0199a000-0000-7000-8000-0000000036e2', '0199a000-0000-7000-8000-00000000360b',
    v_admin, 'C35AD1', interval '1 hour', true, 'admin@example.org');
  if (select facilitator_id from case_app.sessions where id = v_room) <> v_admin or
     not exists (select 1 from case_app.workspace_audit where action = 'room_start' and target_id = v_room and
                 actor_kind = 'admin' and workspace_id = '0199a000-0000-7000-8000-00000000360b') then
    raise exception 'PM-09: admin room start not recorded or not audited'; end if;
  raise notice 'ok PM-09 admin starts a room anywhere, audited';
end $$;

-- [PM-37] If the audit insert fails, the admin write rolls back with it.
create function pg_temp.c35_audit_fails() returns trigger language plpgsql as $f$
begin raise exception 'audit unavailable' using errcode = '53100'; end;
$f$;
create trigger c35_audit_fails before insert on case_app.workspace_audit
  for each row execute function pg_temp.c35_audit_fails();
do $$
declare v_before bigint := (select count(*) from case_app.cases); v_room uuid := case_app.uuid_v7(); v_err text;
begin
  v_err := pg_temp.refused($q$select case_api.create_case('0199a000-0000-7000-8000-000000003605',
    '0199a000-0000-7000-8000-00000000360a', 'Unaudited', true, 'admin@example.org')$q$);
  if v_err is null or v_err not like '53100%' or (select count(*) from case_app.cases) <> v_before then
    raise exception 'PM-37: an admin case survived a failed audit insert (%)', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_session(%L, '0199a000-0000-7000-8000-0000000036e1',
    '0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003605', 'C35AD2', interval '1 hour', true, 'admin@example.org')$q$, v_room));
  if v_err is null or exists (select 1 from case_app.sessions where id = v_room) then
    raise exception 'PM-37: an admin room survived a failed audit insert'; end if;
  raise notice 'ok PM-37 a failed audit insert rolls the admin write back';
end $$;
drop trigger c35_audit_fails on case_app.workspace_audit;

-- [PM-18] [PM-19] [PM-40] The admin-only RPCs refuse in SQL without the admin flag and an admin email.
do $$
declare v_owner uuid := '0199a000-0000-7000-8000-000000003601'; v_err text;
begin
  foreach v_err in array array[
    pg_temp.refused($q$select case_api.bootstrap_workspace('0199a000-0000-7000-8000-000000003601', 'c35-squat', 'Squat', false, null)$q$),
    pg_temp.refused($q$select case_api.bootstrap_workspace('0199a000-0000-7000-8000-000000003601', 'c35-squat', 'Squat', true, null)$q$),
    pg_temp.refused($q$select case_api.bootstrap_workspace('0199a000-0000-7000-8000-000000003601', 'c35-squat', 'Squat', null, null)$q$),
    pg_temp.refused($q$select case_api.bootstrap_workspace('0199a000-0000-7000-8000-000000003601', 'c35-squat', 'Squat', false, 'admin@example.org')$q$),
    pg_temp.refused($q$select case_api.admin_provision_facilitator('0199a000-0000-7000-8000-000000003606', '0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003605', false, null)$q$),
    pg_temp.refused($q$select case_api.admin_provision_facilitator('0199a000-0000-7000-8000-000000003606', '0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003605', true, 'Admin@Example.org')$q$),
    pg_temp.refused($q$select case_api.admin_set_workspace_owner('0199a000-0000-7000-8000-00000000360a', '0199a000-0000-7000-8000-000000003602', '0199a000-0000-7000-8000-000000003601', false, null)$q$),
    pg_temp.refused($q$select * from case_api.admin_transition_profile('0199a000-0000-7000-8000-000000003602', 0, 'disable', false, null)$q$),
    pg_temp.refused($q$select * from case_api.admin_revert_profile('0199a000-0000-7000-8000-000000003602', 0, null, null, null, false, null)$q$),
    pg_temp.refused($q$select * from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 0, 'withdraw', '0199a000-0000-7000-8000-000000003601', false, null, case_app.uuid_v7())$q$),
    pg_temp.refused($q$select * from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 0, 'withdraw', '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', null)$q$)
  ] loop
    if v_err is null or v_err not like '42501%' then raise exception 'PM-18/PM-40: an admin-only RPC ran without the admin flag (%)', v_err; end if;
  end loop;
  if exists (select 1 from case_app.workspaces where slug = 'c35-squat') or
     exists (select 1 from case_app.workspace_members where user_id = '0199a000-0000-7000-8000-000000003606') then
    raise exception 'PM-19: a refused admin-only call still wrote'; end if;
  raise notice 'ok PM-18 PM-19 PM-40 admin-only RPCs refuse in SQL without the admin flag';
end $$;

-- [PM-19] An admin creates a workspace: audited, and the admin is its first owner (it never starts ownerless).
do $$
declare v_ws uuid;
begin
  v_ws := case_api.bootstrap_workspace('0199a000-0000-7000-8000-000000003605', 'c35-admin-made', 'Admin made', true, 'admin@example.org');
  if case_app.member_role('0199a000-0000-7000-8000-000000003605', v_ws) <> 'owner' or
     not exists (select 1 from case_app.workspace_audit where workspace_id = v_ws and action = 'workspace_create' and actor_kind = 'admin') then
    raise exception 'PM-19: admin workspace creation not owned or not audited'; end if;
  raise notice 'ok PM-19 only the admin path creates a workspace';
end $$;

-- [PM-15] [PM-38] Admin withdraw AND republish each need a recorded step-up issued to this admin in the admin
-- scope (red-team items 4 and 5); a made-up id, another admin's or another scope's is refused. One step-up
-- serves the whole session (R-a), so the same id admits both. Both are workspace-audited with it.
do $$
declare v_jti uuid := case_app.uuid_v7(); v_other uuid := case_app.uuid_v7(); v_owner_scope uuid := case_app.uuid_v7();
  r record; v_err text;
begin
  perform case_api.record_admin_elevation(v_jti, 'admin@example.org', 'admin', case_app.uuid_v7());
  perform case_api.record_admin_elevation(v_other, 'other-admin@example.org', 'admin', case_app.uuid_v7());
  perform case_api.record_admin_elevation(v_owner_scope, 'admin@example.org', 'owner:0199a000-0000-7000-8000-00000000360a', case_app.uuid_v7());
  if case_api.record_admin_elevation(v_jti, 'admin@example.org', 'admin', case_app.uuid_v7()) then
    raise exception 'PM-38: an elevation id was recorded twice'; end if;
  foreach v_err in array array[
    pg_temp.refused($q$select * from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 0, 'withdraw',
      '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', '0199a000-0000-7000-8000-0000000036ff')$q$),
    pg_temp.refused(format($q$select * from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 0, 'withdraw',
      '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', %L)$q$, v_other)),
    pg_temp.refused(format($q$select * from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 0, 'withdraw',
      '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', %L)$q$, v_owner_scope))
  ] loop
    if v_err is null or v_err not like '42501%' then raise exception 'PM-15: a version state change took a non-matching step-up (%)', v_err; end if;
  end loop;
  select * into r from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 0, 'withdraw',
    '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', v_jti);
  v_err := pg_temp.refused($q$select * from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 1, 'publish',
    '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-15: republish ran without a step-up (%)', v_err; end if;
  select * into r from case_api.admin_set_version_state('0199a000-0000-7000-8000-0000000036e1', 1, 'publish',
    '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org', v_jti);
  if (select array_agg(action || ':' || coalesce(elevation_id::text, '-') order by at, id) from case_app.workspace_audit
       where target_id = '0199a000-0000-7000-8000-0000000036e1') is distinct from
     array['version_withdraw:' || v_jti::text, 'version_republish:' || v_jti::text] then
    raise exception 'PM-15: version state changes not audited with the elevation id'; end if;
  raise notice 'ok PM-15 PM-38 withdraw and republish need a matching recorded step-up, audited with it';
end $$;

-- [PM-20] No membership write leaves a workspace without an owner, whatever the route.
do $$
declare v_err text;
begin
  v_err := pg_temp.refused($q$update case_app.workspace_members set role = 'author'
    where workspace_id = '0199a000-0000-7000-8000-00000000360b' and user_id = '0199a000-0000-7000-8000-000000003604'$q$);
  if v_err is null or v_err not like '23514 last_owner%' then raise exception 'PM-20: last owner demoted (%)', v_err; end if;
  v_err := pg_temp.refused($q$delete from case_app.workspace_members
    where workspace_id = '0199a000-0000-7000-8000-00000000360b' and user_id = '0199a000-0000-7000-8000-000000003604'$q$);
  if v_err is null or v_err not like '23514 last_owner%' then raise exception 'PM-20: last owner removed (%)', v_err; end if;
  v_err := pg_temp.refused($q$update case_app.workspace_members set workspace_id = '0199a000-0000-7000-8000-00000000360a'
    where workspace_id = '0199a000-0000-7000-8000-00000000360b' and user_id = '0199a000-0000-7000-8000-000000003604'$q$);
  if v_err is null or v_err not like '23514 last_owner%' then raise exception 'PM-20: last owner moved away (%)', v_err; end if;
  v_err := pg_temp.refused($q$truncate case_app.workspace_members$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-20: membership truncate allowed (%)', v_err; end if;
  -- With a second owner, either may go.
  insert into case_app.workspace_members (workspace_id, user_id, role)
    values ('0199a000-0000-7000-8000-00000000360b', '0199a000-0000-7000-8000-000000003601', 'owner');
  update case_app.workspace_members set role = 'author'
   where workspace_id = '0199a000-0000-7000-8000-00000000360b' and user_id = '0199a000-0000-7000-8000-000000003604';
  v_err := pg_temp.refused($q$delete from case_app.workspace_members where workspace_id = '0199a000-0000-7000-8000-00000000360b'
    and role = 'owner'$q$);
  if v_err is null then raise exception 'PM-20: the remaining owner was removed'; end if;
  if (select count(*) from case_app.workspace_members where workspace_id = '0199a000-0000-7000-8000-00000000360b' and role = 'owner') <> 1 then
    raise exception 'PM-20: owner count changed'; end if;
  raise notice 'ok PM-20 the last owner cannot be demoted, removed or moved';
end $$;

-- [PM-21] The last owner's account is hard-deleted: the cascade proceeds, audited and alerted.
do $$
declare v_alerts bigint := (select count(*) from case_app._lockdown_alerts);
begin
  delete from auth.users where id = '0199a000-0000-7000-8000-000000003607';
  if exists (select 1 from case_app.workspace_members where workspace_id = '0199a000-0000-7000-8000-00000000360c') or
     not exists (select 1 from case_app.workspace_audit where workspace_id = '0199a000-0000-7000-8000-00000000360c' and
                 action = 'workspace_ownerless' and actor_kind = 'system' and actor_user_id is null) or
     (select count(*) from case_app._lockdown_alerts) <> v_alerts + 1 or
     exists (select 1 from case_app._lockdown_alerts where detail ~ '[0-9a-f]{8}-') then
    raise exception 'PM-21: ownerless workspace not audited and alerted'; end if;
  raise notice 'ok PM-21 an owner hard deletion is audited and alerted, never blocked';
end $$;

-- [PM-13] An author cannot publish another workspace's asset; an approved asset of their own is fine.
do $$
declare
  v_author uuid := '0199a000-0000-7000-8000-000000003602';
  v_case uuid; v_rev bigint; v_own uuid; v_foreign uuid; v_err text; v_version uuid;
begin
  v_case := case_api.create_case(v_author, '0199a000-0000-7000-8000-00000000360a', 'Asset case');
  v_rev := case_api.save_draft(v_case, 0, 1, (select doc from c35_doc), v_author);
  insert into case_app.assets (workspace_id, uploaded_by, kind, media_type, byte_size, content_sha256, r2_key, status,
      rights_basis, alt_text, deidentified_attested_by, deidentified_attested_at, licence, evidence_kind, width, height) values
    ('0199a000-0000-7000-8000-00000000360a', v_author, 'image', 'image/png', 10, sha256('own'), 'assets/c35/own.png',
     'approved', 'own_work', 'Own', v_author, now(), 'own-work', 'photo', 800, 600) returning id into v_own;
  insert into case_app.assets (workspace_id, uploaded_by, kind, media_type, byte_size, content_sha256, r2_key, status,
      rights_basis, alt_text, deidentified_attested_by, deidentified_attested_at, licence, evidence_kind, width, height) values
    ('0199a000-0000-7000-8000-00000000360b', '0199a000-0000-7000-8000-000000003604', 'image', 'image/png', 10, sha256('foreign'),
     'assets/c35/foreign.png', 'approved', 'own_work', 'Foreign', '0199a000-0000-7000-8000-000000003604', now(), 'own-work', 'photo', 800, 600) returning id into v_foreign;
  v_err := pg_temp.refused(format($q$select * from case_api.publish_draft_with_art(%L, %s, %L, array[%L, %L]::uuid[], pg_temp.c35_art(), true, 'admin@example.org')$q$,
    v_case, v_rev, v_author, v_own, v_foreign));
  if v_err is null or v_err not like '23514 asset_not_in_workspace%' then raise exception 'PM-13: foreign asset published (%)', v_err; end if;
  select r.version_id into v_version from case_api.publish_draft_with_art(v_case, v_rev, v_author, array[v_own], pg_temp.c35_art(), true, 'admin@example.org') r;
  if not exists (select 1 from case_app.case_version_assets where case_version_id = v_version and asset_id = v_own) then
    raise exception 'PM-13: own approved asset refused'; end if;
  raise notice 'ok PM-13 publish binds assets to the case''s workspace';
end $$;

-- [PM-10] [PM-11] [PM-12] Cross-workspace reads and writes stay refused (regressions through the core).
do $$
declare v_err text;
begin
  v_err := pg_temp.refused($q$select * from case_api.list_published_versions('0199a000-0000-7000-8000-000000003603',
    '0199a000-0000-7000-8000-00000000360b', 10, null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-10: a facilitator listed another workspace'; end if;
  v_err := pg_temp.refused($q$select case_api.create_session(case_app.uuid_v7(), '0199a000-0000-7000-8000-0000000036e2'::uuid,
    '0199a000-0000-7000-8000-00000000360a'::uuid, '0199a000-0000-7000-8000-000000003603'::uuid, 'C35X11'::text)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-11: a room started from another workspace''s version (%)', v_err; end if;
  v_err := pg_temp.refused($q$select case_api.save_draft('0199a000-0000-7000-8000-0000000036c2', 0, 1, '{}'::jsonb,
    '0199a000-0000-7000-8000-000000003602')$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-12: an author saved another workspace''s case'; end if;
  if exists (select 1 from case_api.get_case_authoring_access('0199a000-0000-7000-8000-0000000036c2', '0199a000-0000-7000-8000-000000003602')) or
     exists (select 1 from case_api.get_catalogue_case('0199a000-0000-7000-8000-000000003602', '0199a000-0000-7000-8000-0000000036c2', 1)) then
    raise exception 'PM-12: a case-addressed read answered outside the caller''s workspace'; end if;
  raise notice 'ok PM-10 PM-11 PM-12 cross-workspace access stays refused';
end $$;

-- [PM-34] An admin taken off the list keeps no reach: the same person without the flag is an outsider,
-- and what they made (versions, audit) remains.
do $$
declare v_err text;
begin
  v_err := pg_temp.refused($q$select case_api.create_case('0199a000-0000-7000-8000-000000003605',
    '0199a000-0000-7000-8000-00000000360a', 'After removal')$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-34: a former admin kept reach'; end if;
  if not exists (select 1 from case_app.workspace_audit where actor_user_id = '0199a000-0000-7000-8000-000000003605' and actor_kind = 'admin') or
     not exists (select 1 from case_app.case_versions where published_by = '0199a000-0000-7000-8000-000000003605') then
    raise exception 'PM-34: an admin''s versions or audit disappeared'; end if;
  raise notice 'ok PM-34 a former admin keeps no reach; their work and audit remain';
end $$;

-- [PM-35] An invite never lowers a role.
do $$
begin
  perform case_api.admin_provision_facilitator('0199a000-0000-7000-8000-000000003602', '0199a000-0000-7000-8000-00000000360a',
    '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org');
  if not exists (select 1 from case_app.workspace_audit where action = 'member_invite' and target_id = '0199a000-0000-7000-8000-000000003602'
                 and actor_user_id = '0199a000-0000-7000-8000-000000003605') then
    raise exception 'PM-35: an admin invite was not workspace-audited'; end if;
  if case_app.member_role('0199a000-0000-7000-8000-000000003602', '0199a000-0000-7000-8000-00000000360a') <> 'author' then
    raise exception 'PM-35: an invite lowered an author'; end if;
  raise notice 'ok PM-35 an invite never lowers a role';
end $$;

-- [PM-05] get_me: an admin sees every workspace, each as 'admin'; a member sees only their own roles; an
-- inconsistent flag is refused.
do $$
declare r record; v_count bigint := (select count(*) from case_app.workspaces); v_err text;
begin
  select * into r from case_api.get_me('0199a000-0000-7000-8000-000000003605', 100, null, null, true, 'admin@example.org');
  if r.admin is not true or jsonb_array_length(r.memberships) <> least(v_count, 100) or
     exists (select 1 from jsonb_array_elements(r.memberships) m where m ->> 'role' <> 'admin') then
    raise exception 'PM-05: admin get_me did not list every workspace as admin'; end if;
  select * into r from case_api.get_me('0199a000-0000-7000-8000-000000003603');
  if r.admin is not false or r.memberships <> jsonb_build_array(jsonb_build_object('workspace_id', '0199a000-0000-7000-8000-00000000360a',
       'slug', 'c35-home', 'name', 'Card 35 home', 'role', 'facilitator',
       -- facilitator-UX A3: each membership carries its workspace's policies (CASE-337 defaults here).
       'policies', jsonb_build_object('managers_invite', true, 'editors_publish', false, 'runners_share', false,
         'managers_see_records', true))) then
    raise exception 'PM-05: member get_me changed'; end if;
  v_err := pg_temp.refused($q$select * from case_api.get_me('0199a000-0000-7000-8000-000000003603', 100, null, null, true, null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'PM-05: admin flag without email accepted by get_me'; end if;
  raise notice 'ok PM-05 get_me shows admin reach only to a flagged, emailed admin';
end $$;

-- [PM-audit] workspace_audit is append-only and holds fixed scalars only.
do $$
declare v_err text;
begin
  foreach v_err in array array[
    pg_temp.refused($q$update case_app.workspace_audit set action = 'case_create'$q$),
    pg_temp.refused($q$delete from case_app.workspace_audit$q$),
    pg_temp.refused($q$truncate case_app.workspace_audit$q$)
  ] loop
    if v_err is null or v_err not like '42501%' then raise exception 'PM-audit: workspace_audit changed (%)', v_err; end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'case_app' and table_name = 'workspace_audit'
             and data_type in ('jsonb', 'json', 'text') and column_name not in ('actor_kind', 'actor_email', 'action', 'target_type')) then
    raise exception 'PM-audit: workspace_audit grew a free-form column'; end if;
  v_err := pg_temp.refused($q$insert into case_app.workspace_audit (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id)
    values ('0199a000-0000-7000-8000-00000000360a', 'admin', '0199a000-0000-7000-8000-000000003605', 'admin@example.org', 'participant_joined', 'room', case_app.uuid_v7())$q$);
  if v_err is null then raise exception 'PM-audit: an action outside the allow-list was recorded'; end if;
  if has_table_privilege('service_role', 'case_app.workspace_audit', 'select') or
     has_table_privilege('authenticated', 'case_app.workspace_audit', 'select') or
     has_table_privilege('anon', 'case_app.workspace_audit', 'select') then
    raise exception 'PM-audit: workspace_audit is readable outside the RPCs'; end if;
  raise notice 'ok PM-audit workspace_audit is append-only, allow-listed and private';
end $$;

-- [PM-core] One authorization core: no service-callable RPC joins workspace_members or lists roles inline,
-- except the membership RPCs; nothing service-callable still calls assert_member.
do $$
declare v_bad text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('case_api', 'case_app')
     and (n.nspname = 'case_app' or has_function_privilege('service_role', p.oid, 'execute'))
     and p.prosrc ~ 'workspace_members'
     and n.nspname || '.' || p.proname not in ('case_app.member_role', 'case_api.get_me', 'case_api.bootstrap_workspace',
       'case_app.admin_provision_facilitator', 'case_api.admin_set_workspace_owner', 'case_app.guard_last_owner', 'case_app.enforce_lockdown',
       'case_api.admin_workspace_query', 'case_api.admin_change_membership',
       -- CASE-339: acceptance writes the membership an invitation names; the Share dialog lists who has access. Neither
       -- authorizes from that read: both enter case_app.authorize_case / the verified-email check first.
       'case_api.accept_invitations', 'case_api.list_case_access',
       -- A5: People lists each account's roles for the admin gate in the Worker; it authorizes nothing.
       'case_api.admin_read_access');
  if v_bad is not null then raise exception 'PM-core: inline membership read in %', v_bad; end if;
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'case_api' and has_function_privilege('service_role', p.oid, 'execute')
     and (p.prosrc ~ 'assert_member' or p.prosrc ~ $re$array\['owner'$re$ or p.prosrc ~ $re$role in \($re$);
  if v_bad is not null then raise exception 'PM-core: an RPC authorizes outside case_app.authorize: %', v_bad; end if;
  -- The new membership inventory/mutation RPCs necessarily read their targets. These reads never
  -- authorize the actor: both enter the same P-03/P-04/P-05 admin-only core before touching targets.
  -- Keep this exception exact and prove the authorization entry point; behavioral role-matrix and
  -- admin-workbench tests additionally exercise owner refusal, elevation, CAS and last-owner safety.
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='case_api' and p.proname in ('admin_workspace_query','admin_change_membership')
    and p.prosrc !~ 'begin[[:space:]]+perform case_app.authorize(_admin)?\(') then
    raise exception 'PM-core: membership inventory/mutation bypasses the authorization core';
  end if;
  if to_regprocedure('case_api.get_case_version(uuid,uuid)') is not null or
     to_regprocedure('case_api.publish_draft(uuid,bigint,uuid,uuid[])') is not null then
    raise exception 'PM-core: a retired member-only RPC remains (card 35b contract drops them)'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'case_app' and (has_function_privilege('anon', p.oid, 'execute') or
                    has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))) then
    raise exception 'PM-core: a case_app helper is callable from outside'; end if;
  raise notice 'ok PM-core every RPC authorizes through case_app.authorize';
end $$;

-- [PM-expand] removed by the card 35b contract migration (20261010000000_permissions_contract.sql): the old
-- Worker signatures it kept callable are dropped; db/tests/permissions-contract.test.sql proves they are gone.

-- [PM-21] recovery: an admin names a new owner for an ownerless workspace; audited.
do $$
begin
  perform case_api.admin_set_workspace_owner('0199a000-0000-7000-8000-00000000360c', '0199a000-0000-7000-8000-000000003602',
    '0199a000-0000-7000-8000-000000003605', true, 'admin@example.org');
  if case_app.member_role('0199a000-0000-7000-8000-000000003602', '0199a000-0000-7000-8000-00000000360c') <> 'owner' or
     not exists (select 1 from case_app.workspace_audit where workspace_id = '0199a000-0000-7000-8000-00000000360c'
                 and action = 'owner_assign' and actor_kind = 'admin') then
    raise exception 'PM-21: ownerless recovery failed'; end if;
  raise notice 'ok PM-21 an admin assigns an owner to an ownerless workspace';
end $$;

-- [PM-audit-delete] workspace_audit never blocks deleting a workspace; its trail stays (archived by id).
do $$
declare v_ws uuid; v_rows bigint;
begin
  v_ws := case_api.bootstrap_workspace('0199a000-0000-7000-8000-000000003605', 'c35-doomed', 'Doomed', true, 'admin@example.org');
  select count(*) into v_rows from case_app.workspace_audit where workspace_id = v_ws;
  delete from case_app.workspaces where id = v_ws;
  if exists (select 1 from case_app.workspaces where id = v_ws) or v_rows = 0 or
     (select count(*) from case_app.workspace_audit where workspace_id = v_ws) <> v_rows then
    raise exception 'PM-audit-delete: deletion blocked or audit lost'; end if;
  raise notice 'ok PM-audit-delete a workspace deletes and its audit trail remains';
end $$;

-- [PM-rooms] R-c: a starter's live-room list shows only rooms where they are still a member, or an admin.
do $$
declare v_room uuid := case_app.uuid_v7(); n bigint;
begin
  perform case_api.create_session(v_room, '0199a000-0000-7000-8000-0000000036e1'::uuid, '0199a000-0000-7000-8000-00000000360a'::uuid,
    '0199a000-0000-7000-8000-000000003603'::uuid, 'C35RMS'::text, interval '1 hour', false, null);
  select count(*) into n from case_api.list_owned_active_sessions('0199a000-0000-7000-8000-000000003603') where session_id = v_room;
  if n <> 1 then raise exception 'PM-rooms: a member does not see their room'; end if;
  delete from case_app.workspace_members where user_id = '0199a000-0000-7000-8000-000000003603'
    and workspace_id = '0199a000-0000-7000-8000-00000000360a';
  select count(*) into n from case_api.list_owned_active_sessions('0199a000-0000-7000-8000-000000003603') where session_id = v_room;
  if n <> 0 then raise exception 'PM-rooms: a removed member still lists their room'; end if;
  select count(*) into n from case_api.list_owned_active_sessions('0199a000-0000-7000-8000-000000003603', 100, null, true, 'admin@example.org')
    where session_id = v_room;
  if n <> 1 then raise exception 'PM-rooms: an admin starter lost a room'; end if;
  if case_api.get_session_workspace(v_room) <> '0199a000-0000-7000-8000-00000000360a' or case_api.get_session_workspace(case_app.uuid_v7()) is not null then
    raise exception 'PM-22: the session workspace fallback is wrong'; end if;
  raise notice 'ok PM-rooms stale rooms hidden; PM-22 session workspace fallback';
end $$;

-- [P-22] Only admins read a workspace's audit; an owner never does (Julian, 2026-10-07).
do $$
declare v_err text; v_rows bigint;
begin
  v_err := pg_temp.refused($q$select * from case_api.list_workspace_audit('0199a000-0000-7000-8000-000000003601',
    '0199a000-0000-7000-8000-00000000360a', 10, null, false, null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'P-22: an owner read the workspace audit (%)', v_err; end if;
  select count(*) into v_rows from case_api.list_workspace_audit('0199a000-0000-7000-8000-000000003605',
    '0199a000-0000-7000-8000-00000000360a', 100, null, true, 'admin@example.org');
  if v_rows <> (select count(*) from case_app.workspace_audit where workspace_id = '0199a000-0000-7000-8000-00000000360a') or v_rows = 0 then
    raise exception 'P-22: the admin audit read is incomplete'; end if;
  raise notice 'ok P-22 workspace audit is admin-only';
end $$;

rollback;
