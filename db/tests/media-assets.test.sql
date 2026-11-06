-- Card 59 M2 (CASE-268): image, GIF and video assets with their stored renditions, quarantined until a configured admin
-- approves them, rights fixed once approved, workspace-scoped reads, bounded uploads and audited admin decisions. Rights
-- cautions and the de-identification tick are recorded, never refused (Julian, 2026-10-15).
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000e509'),('0199a000-0000-7000-8000-00000000e501'),('0199a000-0000-7000-8000-00000000e502'),('0199a000-0000-7000-8000-00000000e503'),('0199a000-0000-7000-8000-00000000e504');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000e501','Owner'),('0199a000-0000-7000-8000-00000000e502','Author'),
  ('0199a000-0000-7000-8000-00000000e503','Facilitator'),('0199a000-0000-7000-8000-00000000e504','Other author');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000e510','media-a','Media A'),('0199a000-0000-7000-8000-00000000e511','media-b','Media B');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-00000000e510','0199a000-0000-7000-8000-00000000e501','owner'),
 ('0199a000-0000-7000-8000-00000000e510','0199a000-0000-7000-8000-00000000e502','author'),
 ('0199a000-0000-7000-8000-00000000e510','0199a000-0000-7000-8000-00000000e503','facilitator'),
 ('0199a000-0000-7000-8000-00000000e511','0199a000-0000-7000-8000-00000000e504','author');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
create function pg_temp.r(p_sha text, p_bytes int default 4000, p_w int default 1200, p_h int default 800, p_type text default 'image/jpeg') returns jsonb language sql as $$
  select jsonb_build_object('sha256', p_sha, 'bytes', p_bytes, 'width', p_w, 'height', p_h, 'type', p_type) $$;
create function pg_temp.details(p_licence text default 'own-work', p_basis text default 'own_work', p_attr text default null, p_attested boolean default null,
  p_duration int default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('alt_text', '12-lead ECG, 25 mm/s', 'evidence_kind', 'ecg', 'rights_basis', p_basis, 'licence', p_licence,
    'attribution', p_attr, 'attested', p_attested, 'duration_ms', p_duration)) $$;
create temp table ids(name text primary key, id uuid);

do $$
declare v jsonb; v2 jsonb; v_err text;
  a constant uuid := '0199a000-0000-7000-8000-00000000e502'; ws constant uuid := '0199a000-0000-7000-8000-00000000e510';
begin
  v := case_api.builder_create_asset(ws, a, false, null, pg_temp.r(repeat('a',64)), pg_temp.r(repeat('b',64), 2000, 640, 427), pg_temp.details());
  if v->>'status' <> 'quarantined' or (v->>'created')::boolean is not true or v->'renditions'->'phone'->>'width' <> '640' then raise exception 'create returned %', v; end if;
  insert into ids values ('ecg', (v->>'asset_id')::uuid);
  if (select r2_key from case_app.asset_renditions where asset_id = (v->>'asset_id')::uuid and rendition = 'display') <> 'media/'||ws||'/'||repeat('a',64)||'.jpg' then
    raise exception 'display key is not content-addressed in its workspace'; end if;
  -- The same display bytes again are the same asset (idempotent upload), not a second row.
  v2 := case_api.builder_create_asset(ws, a, false, null, pg_temp.r(repeat('a',64)), pg_temp.r(repeat('b',64), 2000, 640, 427), pg_temp.details());
  if v2->>'asset_id' <> v->>'asset_id' or (v2->>'created')::boolean then raise exception 'repeat upload made a second asset'; end if;
  -- Uploader identity and attestation names never appear in a listed row.
  if v ? 'uploaded_by' or v ? 'deidentified_attested_by' or v::text like '%e502%' then raise exception 'asset row exposes a person: %', v; end if;
  raise notice 'ok an upload is one quarantined asset with two content-addressed renditions, idempotent on its bytes';

  -- A facilitator, an author of another workspace and an unknown caller cannot upload or read.
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('c',64)),pg_temp.r(repeat('d',64)),pg_temp.details())$q$, ws, '0199a000-0000-7000-8000-00000000e503'));
  if v_err is null or v_err not like '42501%' then raise exception 'facilitator upload: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_list_assets(%L,%L,false,null,null)$q$, ws, '0199a000-0000-7000-8000-00000000e504'));
  if v_err is null or v_err not like '42501%' then raise exception 'foreign author listed: %', v_err; end if;
  if (select count(*) from case_api.builder_asset_rendition('0199a000-0000-7000-8000-00000000e511', (v->>'asset_id')::uuid, 'display', '0199a000-0000-7000-8000-00000000e504', false, null)) <> 0 then
    raise exception 'another workspace read a rendition key'; end if;
  raise notice 'ok uploads and reads need P-14 in the asset''s own workspace';

  -- Rights cautions never refuse (J2 as re-ruled): CC BY without a credit, a non-commercial licence, an unlicensed
  -- publication figure. A licence must still name its own rights basis, and a JPEG still has its size bound.
  v := case_api.builder_create_asset(ws, a, false, null, pg_temp.r(repeat('e',64)), pg_temp.r(repeat('f',64)), pg_temp.details('CC-BY-4.0','creative_commons'));
  if v->>'status' <> 'quarantined' or (v->>'attested')::boolean then raise exception 'CC BY without a credit: %', v; end if;
  v := case_api.builder_create_asset(ws, a, false, null, pg_temp.r(repeat('0',63)||'1'), pg_temp.r(repeat('0',63)||'2'), pg_temp.details('CC-BY-NC-ND-4.0','creative_commons'));
  insert into ids values ('nc', (v->>'asset_id')::uuid);
  v := case_api.builder_create_asset(ws, a, false, null, pg_temp.r(repeat('0',63)||'3'), pg_temp.r(repeat('0',63)||'4'), pg_temp.details('unlicensed','unlicensed','Figure 2, Textbook of X', true));
  if v->>'licence' <> 'unlicensed' or not (v->>'attested')::boolean then raise exception 'publication figure: %', v; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('e',63)||'0'),pg_temp.r(repeat('f',63)||'1'),pg_temp.details('CC-BY-4.0','own_work','x'))$q$, ws, a));
  if v_err is null or v_err not like '23514%assets_licence_basis%' then raise exception 'mismatched licence: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('e',62)||'00',700000),pg_temp.r(repeat('f',63)||'2'),pg_temp.details())$q$, ws, a));
  if v_err is null or v_err not like '23514%' then raise exception 'oversize rendition: %', v_err; end if;
  raise notice 'ok rights cautions are stored, never refused; a mismatched licence and an oversize JPEG are refused';
end $$;

-- CASE-273: a Block checkbox is editable while pending; false is still publishable after admin approval.
do $$
declare ws uuid:='0199a000-0000-7000-8000-00000000e510'; a uuid:='0199a000-0000-7000-8000-00000000e502';
  asset uuid:=(select id from ids where name='ecg'); v jsonb; stamp timestamptz; err text;
begin
  v:=case_api.builder_set_asset_attestation(ws,asset,false,true,a,false,null);
  if v->>'attested'<>'true' or v::text like '%e502%' then raise exception 'tick not saved privately'; end if;
  select deidentified_attested_at into stamp from case_app.assets where id=asset;
  perform case_api.builder_set_asset_attestation(ws,asset,false,true,a,false,null);
  if (select deidentified_attested_at from case_app.assets where id=asset)<>stamp then raise exception 'retry changed attestation'; end if;
  err:=pg_temp.refused(format('select case_api.builder_set_asset_attestation(%L,%L,false,false,%L,false,null)',ws,asset,a));
  if err not like '40001%' or err is null then raise exception 'stale checkbox overwrote: %',err; end if;
  err:=pg_temp.refused(format('select case_api.builder_set_asset_attestation(%L,%L,true,false,%L,false,null)',ws,asset,'0199a000-0000-7000-8000-00000000e504'));
  if err not like '42501%' or err is null then raise exception 'foreign author edited: %',err; end if;
  v:=case_api.builder_set_asset_attestation(ws,asset,true,false,a,false,null);
  if v->>'attested'<>'false' then raise exception 'untick failed'; end if;
  if exists(select 1 from case_app.assets where id=asset and (deidentified_attested_by is not null or deidentified_attested_at is not null)) then raise exception 'untick retained identity'; end if;
end $$;

-- Only a configured admin approves; approval is audited; approved rights and bytes are fixed.
do $$
declare v jsonb; v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e510'; v_id uuid := (select i.id from ids i where i.name = 'ecg');
begin
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve',%L::jsonb,%L::text[],'0199a000-0000-7000-8000-00000000e501',false,null)$q$, ws, v_id,
    (select case_app.asset_review_state(r) from case_app.assets r where r.id = v_id), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = v_id)));
  if v_err is null or v_err not like '42501%' then raise exception 'owner approved an asset: %', v_err; end if;
  v := case_api.admin_review_asset(ws, v_id, 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = v_id), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = v_id), '0199a000-0000-7000-8000-00000000e509', true, 'admin@example.com');
  if v->>'status' <> 'approved' or v->>'approved_at' is null then raise exception 'approve returned %', v; end if;
  if not exists (select 1 from case_app.workspace_audit where action = 'asset_approve' and target_type = 'asset' and target_id = v_id and actor_kind = 'admin') then
    raise exception 'approval was not audited'; end if;
  v_err := pg_temp.refused(format($q$update case_app.assets set attribution='changed' where id=%L$q$, v_id));
  if v_err is null or v_err not like '42501 approved_asset_immutable%' then raise exception 'approved rights changed: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'reject',null,null,'0199a000-0000-7000-8000-00000000e509',true,'admin@example.com')$q$, ws, v_id));
  if v_err is null or v_err not like '40001 asset_not_pending%' then raise exception 're-review: %', v_err; end if;
  v_err:=pg_temp.refused(format('select case_api.builder_set_asset_attestation(%L,%L,false,true,%L,false,null)',ws,v_id,'0199a000-0000-7000-8000-00000000e502'));
  if v_err not like '40001%' or v_err is null then raise exception 'approved checkbox edited: %',v_err; end if;
  raise notice 'ok only a configured admin approves, audited, and approved rights are fixed';
end $$;

-- A rejected image cannot be uploaded again or reopened, and its rendition key is no longer handed out.
do $$
declare v jsonb; v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e510'; a constant uuid := '0199a000-0000-7000-8000-00000000e502';
begin
  v := case_api.builder_create_asset(ws, a, false, null, pg_temp.r(repeat('1',64)), pg_temp.r(repeat('2',64)), pg_temp.details());
  perform case_api.admin_review_asset(ws, (v->>'asset_id')::uuid, 'reject', null, null, '0199a000-0000-7000-8000-00000000e509', true, 'admin@example.com');
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('1',64)),pg_temp.r(repeat('2',64)),pg_temp.details())$q$, ws, a));
  if v_err is null or v_err not like '23505 asset_closed%' then raise exception 'rejected file came back: %', v_err; end if;
  v_err := pg_temp.refused(format($q$update case_app.assets set status='quarantined' where id=%L$q$, v->>'asset_id'));
  if v_err is null or v_err not like '42501 asset_closed%' then raise exception 'rejected asset reopened: %', v_err; end if;
  if (select r2_key from case_api.builder_asset_rendition(ws, (v->>'asset_id')::uuid, 'display', a, false, null)) is not null then raise exception 'rejected key handed out'; end if;
  raise notice 'ok a rejected image stays closed';
end $$;

-- Sixty uploads an hour per person.
do $$
declare v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e510'; o constant uuid := '0199a000-0000-7000-8000-00000000e501';
begin
  for i in 1..60 loop perform case_api.builder_create_asset(ws, o, false, null, pg_temp.r(lpad(to_hex(1000 + i), 64, '7')), pg_temp.r(lpad(to_hex(1000 + i), 64, '8')), pg_temp.details()); end loop;
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('9',64)),pg_temp.r(repeat('8',64)),pg_temp.details())$q$, ws, o));
  if v_err is null or v_err not like '23514 media_rate%' then raise exception 'sixty-first upload in an hour: %', v_err; end if;
  if jsonb_array_length(case_api.builder_list_assets(ws, o, false, null, null)) <> 65 then raise exception 'list count'; end if;
  if jsonb_array_length(case_api.builder_list_assets(ws, o, false, null, array[(select id from ids where name='ecg')])) <> 1 then raise exception 'list by id'; end if;
  raise notice 'ok uploads are rate-bounded and the list filters by id';
end $$;

-- Red-team S2/B1/S8: a stored rendition is allowed first; a rejected file's bytes are never allowed again unless a live
-- image uses them; closed images no longer count against the workspace; 150 stored renditions an hour per person.
do $$
declare v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e510'; a constant uuid := '0199a000-0000-7000-8000-00000000e502';
begin
  if not case_api.builder_media_put_allowance(ws, a, false, null, repeat('6',64), 4000) then raise exception 'allowance'; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L,%L,false,null,repeat('1',64),4000)$q$, ws, a));
  if v_err is null or v_err not like '23505 asset_closed%' then raise exception 'a rejected file was allowed again: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L,'0199a000-0000-7000-8000-00000000e503',false,null,repeat('6',64),4000)$q$, ws));
  if v_err is null or v_err not like '42501%' then raise exception 'facilitator allowed: %', v_err; end if;
  if not case_api.builder_media_put_allowance(ws, a, false, null, repeat('5',64), 25 * 1024 * 1024, 'video/mp4') then raise exception 'video allowance'; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L,%L,false,null,repeat('6',64),26214401,'video/mp4')$q$, ws, a));
  if v_err is null or v_err not like '22023%' then raise exception 'oversize allowed: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L,%L,false,null,repeat('6',64),4000,'image/png')$q$, ws, a));
  if v_err is null or v_err not like '22023%' then raise exception 'an unstored type allowed: %', v_err; end if;
  insert into case_app.media_put_log(user_id, workspace_id) select a, ws from generate_series(1, 148);
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L,%L,false,null,repeat('6',64),4000)$q$, ws, a));
  if v_err is null or v_err not like '23514 media_rate%' then raise exception 'the 151st put in an hour: %', v_err; end if;
  raise notice 'ok renditions are allowed before storage: rate, size, role and closed files';
end $$;

-- Animated GIFs and videos (J1 as re-ruled): one cleaned object serving display and phone, a JPEG poster, their own
-- size bounds; a still never has a poster; the kind and duration are recorded.
do $$
declare v jsonb; v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e510'; a constant uuid := '0199a000-0000-7000-8000-00000000e502';
  gif jsonb := pg_temp.r(repeat('c',64), 9 * 1024 * 1024, 480, 270, 'image/gif'); mp4 jsonb := pg_temp.r(repeat('d',64), 20 * 1024 * 1024, 1920, 1080, 'video/mp4');
  poster jsonb := pg_temp.r(repeat('a',63)||'f', 90000, 1280, 720);
begin
  v := case_api.builder_create_asset(ws, a, false, null, gif, gif, pg_temp.details(), poster);
  if v->>'kind' <> 'image' or v->>'media_type' <> 'image/gif' or v->'renditions'->'poster'->>'type' <> 'image/jpeg' or v->'renditions'->'phone'->>'type' <> 'image/gif' then raise exception 'gif: %', v; end if;
  if (select array_agg(r2_key order by rendition) from case_app.asset_renditions where asset_id = (v->>'asset_id')::uuid) <>
     array['media/'||ws||'/'||repeat('c',64)||'.gif', 'media/'||ws||'/'||repeat('c',64)||'.gif', 'media/'||ws||'/'||repeat('a',63)||'f.jpg'] then raise exception 'gif keys'; end if;
  insert into ids values ('gif', (v->>'asset_id')::uuid);
  v := case_api.builder_create_asset(ws, a, false, null, mp4, mp4, pg_temp.details(p_duration => 42000), pg_temp.r(repeat('a',62)||'ef', 120000, 1920, 1080));
  if v->>'kind' <> 'video' or v->>'media_type' <> 'video/mp4' or (v->>'duration_ms')::int <> 42000 or v->>'width' <> '1920' then raise exception 'video: %', v; end if;
  insert into ids values ('video', (v->>'asset_id')::uuid);
  for v_err in select pg_temp.refused(q) from unnest(array[
      format($q$select case_api.builder_create_asset(%L,%L,false,null,%L,%L,pg_temp.details())$q$, ws, a, gif, gif),
      format($q$select case_api.builder_create_asset(%L,%L,false,null,%L,pg_temp.r(repeat('b',64)),pg_temp.details(),%L)$q$, ws, a, gif, poster),
      format($q$select case_api.builder_create_asset(%L,%L,false,null,%L,%L,pg_temp.details(),%L)$q$, ws, a, mp4, mp4, poster),
      format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('9',62)||'aa'),pg_temp.r(repeat('9',62)||'ab'),pg_temp.details(),%L)$q$, ws, a, poster),
      format($q$select case_api.builder_create_asset(%L,%L,false,null,%L,%L,pg_temp.details(),pg_temp.r(repeat('9',62)||'ac',4000,640,360,'image/gif'))$q$, ws, a, gif, gif)]) q loop
    if v_err is null or v_err not like '22023 invalid_asset%' then raise exception 'malformed GIF or video registration: %', v_err; end if;
  end loop;
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,%L,%L,pg_temp.details(p_duration => 1),%L)$q$, ws, a,
    pg_temp.r(repeat('9',62)||'ad', 26214401, 640, 360, 'video/mp4'), pg_temp.r(repeat('9',62)||'ad', 26214401, 640, 360, 'video/mp4'), pg_temp.r(repeat('9',62)||'b0', 90000, 1280, 720)));
  if v_err is null or v_err not like '23514%' then raise exception 'a video over 25 MB: %', v_err; end if;
  -- Approval needs no de-identification tick for images or video; the row still says whether it was ticked.
  v := case_api.admin_review_asset(ws, (select id from ids where name = 'video'), 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = (select id from ids where name = 'video')), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = (select id from ids where name = 'video')), '0199a000-0000-7000-8000-00000000e509', true, 'admin@example.com');
  if v->>'status' <> 'approved' or (v->>'attested')::boolean then raise exception 'unticked video approval: %', v; end if;
  v := case_api.admin_review_asset(ws, (select id from ids where name = 'nc'), 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = (select id from ids where name = 'nc')), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = (select id from ids where name = 'nc')), '0199a000-0000-7000-8000-00000000e509', true, 'admin@example.com');
  if v->>'licence' <> 'CC-BY-NC-ND-4.0' then raise exception 'NC-ND approval: %', v; end if;
  -- Red-team S5: a new image cannot name a stored file another image names (its phone copy or its poster).
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,pg_temp.r(repeat('9',62)||'ae'),pg_temp.r(repeat('b',64)),pg_temp.details())$q$, ws, a));
  if v_err is null or v_err not like '40001 rendition_in_use%' then raise exception 'a decoy shared another image''s phone copy: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_create_asset(%L,%L,false,null,%L,%L,pg_temp.details(),%L)$q$, ws, a,
    pg_temp.r(repeat('9',62)||'af', 4000, 480, 270, 'image/gif'), pg_temp.r(repeat('9',62)||'af', 4000, 480, 270, 'image/gif'), poster));
  if v_err is null or v_err not like '40001 rendition_in_use%' then raise exception 'a decoy shared another image''s poster: %', v_err; end if;
  raise notice 'ok GIFs and videos store one object, a JPEG poster and their kind; approval needs no tick and reports it';
end $$;

-- Red-team S3: a version pins at most 64 images or videos and 150 MiB of stored objects (each object once); a release
-- over either limit rolls back.
do $$
declare v_err text; ws constant uuid := '0199a000-0000-7000-8000-00000000e510'; o constant uuid := '0199a000-0000-7000-8000-00000000e501'; v uuid; ids uuid[] := '{}';
begin
  insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199a000-0000-7000-8000-00000000e520', ws, o, 'Media limit case');
  insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
    values ('0199a000-0000-7000-8000-00000000e530','0199a000-0000-7000-8000-00000000e520',1,3,'{"schema_version":3}'::jsonb,sha256('m'),o) returning id into v;
  -- Seven videos of 24 MB: 168 MB is over the limit even though each object is counted once.
  for i in 1..7 loop
    ids := ids || (case_api.builder_create_asset(ws, '0199a000-0000-7000-8000-00000000e502', false, null, pg_temp.r(lpad(to_hex(4000 + i), 64, 'd'), 24 * 1024 * 1024, 1280, 720, 'video/mp4'),
      pg_temp.r(lpad(to_hex(4000 + i), 64, 'd'), 24 * 1024 * 1024, 1280, 720, 'video/mp4'), pg_temp.details(p_duration => 60000), pg_temp.r(lpad(to_hex(4000 + i), 64, 'e'), 1000, 1280, 720))->>'asset_id')::uuid;
  end loop;
  v_err := pg_temp.refused(format($q$insert into case_app.case_version_assets(case_version_id, asset_id) select %L, unnest(%L::uuid[])$q$, v, ids));
  if v_err is null or v_err not like '23514 version_media_limit%' then raise exception 'seven 24 MB videos (168 MB) pinned: %', v_err; end if;
  -- Six are 144 MB: within the limit, so a display and phone that are one object were not counted twice (288 MB).
  insert into case_app.case_version_assets(case_version_id, asset_id) select v, unnest(ids[1:6]);
  raise notice 'ok a version pins at most 150 MiB of stored objects, each counted once';
end $$;

-- Nothing on the new table is reachable except through the RPCs.
do $$ begin
  if has_table_privilege('service_role', 'case_app.asset_renditions', 'select') or has_table_privilege('authenticated', 'case_app.asset_renditions', 'select') then
    raise exception 'asset_renditions is directly readable'; end if;
  if not (select relrowsecurity from pg_class where oid = 'case_app.asset_renditions'::regclass) then raise exception 'row security off'; end if;
  if has_function_privilege('authenticated', 'case_api.builder_create_asset(uuid,uuid,boolean,text,jsonb,jsonb,jsonb,jsonb)', 'execute') then raise exception 'authenticated may upload'; end if;
  raise notice 'ok renditions are reachable only through the service-role RPCs';
end $$;
rollback;
