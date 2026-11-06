-- Card 59 M3 (CASE-269): a room reads only the images its version pins, in its own workspace, with their keys.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000e601'),('0199a000-0000-7000-8000-00000000e602'),('0199a000-0000-7000-8000-00000000e609');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000e601','Owner'),('0199a000-0000-7000-8000-00000000e602','Other'),('0199a000-0000-7000-8000-00000000e609','Admin');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000e610','room-media-a','Room media A'),('0199a000-0000-7000-8000-00000000e611','room-media-b','Room media B');
insert into case_app.workspace_members(workspace_id,user_id,role) values ('0199a000-0000-7000-8000-00000000e610','0199a000-0000-7000-8000-00000000e601','owner'),
  ('0199a000-0000-7000-8000-00000000e611','0199a000-0000-7000-8000-00000000e602','owner');
insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199a000-0000-7000-8000-00000000e620','0199a000-0000-7000-8000-00000000e610','0199a000-0000-7000-8000-00000000e601','Room media case');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
do $$
declare ws constant uuid := '0199a000-0000-7000-8000-00000000e610'; o constant uuid := '0199a000-0000-7000-8000-00000000e601'; a jsonb; b jsonb; v_err text; r record; n int;
  rend jsonb := jsonb_build_object('bytes', 4000, 'width', 1200, 'height', 800);
  det jsonb := jsonb_build_object('alt_text', 'ECG', 'evidence_kind', 'ecg', 'rights_basis', 'creative_commons', 'licence', 'CC-BY-4.0', 'attribution', 'Photo: A. Author, CC BY 4.0');
begin
  a := case_api.builder_create_asset(ws, o, false, null, rend || jsonb_build_object('sha256', repeat('a',64)), rend || jsonb_build_object('sha256', repeat('b',64)), det);
  b := case_api.builder_create_asset(ws, o, false, null, rend || jsonb_build_object('sha256', repeat('c',64)), rend || jsonb_build_object('sha256', repeat('d',64)), det);
  perform case_api.admin_review_asset(ws, (a->>'asset_id')::uuid, 'approve', (select case_app.asset_review_state(shown) from case_app.assets shown where shown.id = (a->>'asset_id')::uuid), (select case_app.asset_open_warnings(shown) from case_app.assets shown where shown.id = (a->>'asset_id')::uuid), '0199a000-0000-7000-8000-00000000e609', true, 'admin@example.com');
  -- The version shows image a, so it pins exactly a (CASE-269 S4).
  insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values
    ('0199a000-0000-7000-8000-00000000e630','0199a000-0000-7000-8000-00000000e620',1,3,
     jsonb_build_object('schema_version',3,'blocks',jsonb_build_array(jsonb_build_object('id','x','type','image','asset_id',a->>'asset_id'))),sha256('v'),o);
  insert into case_app.case_version_assets(case_version_id, asset_id) values ('0199a000-0000-7000-8000-00000000e630', (a->>'asset_id')::uuid);
  -- b exists in the workspace but is not pinned by the version: it is not listed.
  select count(*) into n from case_api.room_media_manifest('0199a000-0000-7000-8000-00000000e630', ws, o, false, null);
  if n <> 1 then raise exception 'manifest lists % images, expected the 1 pinned', n; end if;
  select * into r from case_api.room_media_manifest('0199a000-0000-7000-8000-00000000e630', ws, o, false, null);
  if r.asset_id <> (a->>'asset_id')::uuid or r.status <> 'approved' or r.width <> 1200 or r.attribution <> 'Photo: A. Author, CC BY 4.0'
     or r.display_key <> 'media/'||ws||'/'||repeat('a',64)||'.jpg' or r.phone_key <> 'media/'||ws||'/'||repeat('b',64)||'.jpg' then raise exception 'manifest row %', r; end if;
  -- Another workspace's owner cannot read it. An entitled caller naming a foreign version gets empty rows for deployed-Worker compatibility.
  v_err := pg_temp.refused($q$select * from case_api.room_media_manifest('0199a000-0000-7000-8000-00000000e630','0199a000-0000-7000-8000-00000000e610','0199a000-0000-7000-8000-00000000e602',false,null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'foreign owner read the manifest: %', v_err; end if;
  if exists (select 1 from case_api.room_media_manifest('0199a000-0000-7000-8000-00000000e630','0199a000-0000-7000-8000-00000000e611','0199a000-0000-7000-8000-00000000e602',false,null)) then
    raise exception 'a foreign workspace listed this version''s images'; end if;
  raise notice 'ok a room manifest lists only the version''s pinned images in its own workspace';
end $$;
-- Red-team S4: a version pins exactly the images its document shows (checked at commit; forced here).
do $$
declare v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e610'; o constant uuid := '0199a000-0000-7000-8000-00000000e601'; a uuid; b uuid;
begin
  select id into a from case_app.assets where workspace_id = ws and status = 'approved' limit 1;
  select id into b from case_app.assets where workspace_id = ws and id <> a limit 1;
  insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values
    ('0199a000-0000-7000-8000-00000000e631','0199a000-0000-7000-8000-00000000e620',2,3,
     jsonb_build_object('schema_version',3,'blocks',jsonb_build_array(jsonb_build_object('id','x','type','image','asset_id',a))),sha256('v2'),o);
  v_err := pg_temp.refused($q$set constraints case_app.case_versions_asset_set immediate$q$);
  if v_err is null or v_err not like '23514 version_assets_mismatch%' then raise exception 'a version that pins none of its image passed: %', v_err; end if;
  set constraints case_app.case_versions_asset_set deferred;
  insert into case_app.case_version_assets(case_version_id, asset_id) values ('0199a000-0000-7000-8000-00000000e631', a), ('0199a000-0000-7000-8000-00000000e631', b);
  v_err := pg_temp.refused($q$set constraints case_app.case_versions_asset_set immediate$q$);
  if v_err is null or v_err not like '23514 version_assets_mismatch%' then raise exception 'a version pinning an image it does not show passed: %', v_err; end if;
  set constraints case_app.case_versions_asset_set deferred;
  delete from case_app.case_version_assets where case_version_id = '0199a000-0000-7000-8000-00000000e631' and asset_id = b;
  set constraints case_app.case_versions_asset_set immediate;
  set constraints case_app.case_versions_asset_set deferred;
  raise notice 'ok a version pins exactly the images its document shows';
end $$;
-- J10: the session's starter (or a configured admin) reads a pinned image's JPEG for the session record; nobody else.
do $$
declare ws constant uuid := '0199a000-0000-7000-8000-00000000e610'; o constant uuid := '0199a000-0000-7000-8000-00000000e601'; r record; n int; v_err text;
  sess constant uuid := '0199a000-0000-7000-8000-00000000e650'; a uuid := (select asset_id from case_app.case_version_assets where case_version_id = '0199a000-0000-7000-8000-00000000e630' limit 1);
begin
  insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,expires_at)
    values (sess, '0199a000-0000-7000-8000-00000000e630', ws, o, '7K3QX9', now(), now() + interval '1 hour');
  select * into r from case_api.session_media_rendition(o, sess, a, false, null);
  if r.status <> 'approved' or r.r2_key <> 'media/'||ws||'/'||repeat('b',64)||'.jpg' then raise exception 'starter read %', r; end if;
  -- An image the version does not pin: no row, whatever the workspace holds.
  select count(*) into n from case_api.session_media_rendition(o, sess, (select id from case_app.assets where workspace_id = ws and id <> a limit 1), false, null);
  if n <> 0 then raise exception 'an unpinned image was readable'; end if;
  -- Another workspace's owner is refused; a configured admin may read.
  v_err := pg_temp.refused(format($q$select * from case_api.session_media_rendition('0199a000-0000-7000-8000-00000000e602',%L,%L,false,null)$q$, sess, a));
  if v_err is null or v_err not like '42501%' then raise exception 'foreign owner read a session image: %', v_err; end if;
  if (select count(*) from case_api.session_media_rendition('0199a000-0000-7000-8000-00000000e609', sess, a, true, 'admin@example.com')) <> 1 then raise exception 'admin read'; end if;
  raise notice 'ok a session record reads only its own pinned images, as a JPEG, for its starter or an admin';
end $$;
rollback;
