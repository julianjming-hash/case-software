-- Card 59 M4 (CASE-270): takedown needs the admin's recorded step-up and is audited; withdrawn, rejected and abandoned
-- images queue their bytes; a key another live image uses is never queued or leased; leases complete once.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000e701'),('0199a000-0000-7000-8000-00000000e709');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000e701','Owner'),('0199a000-0000-7000-8000-00000000e709','Admin');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000e710','media-retention','Media retention');
insert into case_app.workspace_members(workspace_id,user_id,role) values ('0199a000-0000-7000-8000-00000000e710','0199a000-0000-7000-8000-00000000e701','owner');
select case_api.record_admin_elevation('0199a000-0000-7000-8000-00000000e71f', 'admin@example.com', 'admin', '0199a000-0000-7000-8000-00000000e70f');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
create function pg_temp.upload(p_display text, p_phone text) returns uuid language sql as $$
  select (case_api.builder_create_asset('0199a000-0000-7000-8000-00000000e710', '0199a000-0000-7000-8000-00000000e701', false, null,
    jsonb_build_object('sha256', p_display, 'bytes', 4000, 'width', 1200, 'height', 800), jsonb_build_object('sha256', p_phone, 'bytes', 2000, 'width', 640, 'height', 427),
    jsonb_build_object('alt_text', 'ECG', 'evidence_kind', 'ecg', 'rights_basis', 'own_work', 'licence', 'own-work'))->>'asset_id')::uuid $$;

do $$
declare ws constant uuid := '0199a000-0000-7000-8000-00000000e710'; adm constant uuid := '0199a000-0000-7000-8000-00000000e709';
  a uuid; b uuid; c uuid; v_err text; n int; keys text[];
begin
  a := pg_temp.upload(repeat('a',64), repeat('b',64));
  -- Registration refuses an image that names another image's file (red-team S5).
  v_err := pg_temp.refused($q$select pg_temp.upload(repeat('c',64), repeat('b',64))$q$);
  if v_err is null or v_err not like '40001 rendition_in_use%' then raise exception 'a decoy shared a file: %', v_err; end if;
  -- A share that exists anyway (written directly, as an older row could be) must still survive a's takedown.
  b := pg_temp.upload(repeat('c',64), repeat('c',63)||'0');
  update case_app.asset_renditions set r2_key = 'media/'||ws||'/'||repeat('b',64)||'.jpg', content_sha256 = decode(repeat('b',64), 'hex')
    where asset_id = b and rendition = 'phone';
  perform case_api.admin_review_asset(ws, a, 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = a), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = a), adm, true, 'admin@example.com');
  -- An owner cannot take an image down, and an admin needs the recorded step-up.
  v_err := pg_temp.refused(format($q$select * from case_api.admin_withdraw_asset(%L,%L,'Rights complaint','0199a000-0000-7000-8000-00000000e701',false,null,null)$q$, ws, a));
  if v_err is null or v_err not like '42501%' then raise exception 'owner withdrew: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select * from case_api.admin_withdraw_asset(%L,%L,'Rights complaint',%L,true,'admin@example.com',null)$q$, ws, a, adm));
  if v_err is null or v_err not like '42501%' then raise exception 'withdrawal without step-up: %', v_err; end if;
  select array_agg(r2_key order by r2_key) into keys from case_api.admin_withdraw_asset(ws, a, 'Rights complaint', adm, true, 'admin@example.com', '0199a000-0000-7000-8000-00000000e71f');
  if keys is distinct from array['media/'||ws||'/'||repeat('a',64)||'.jpg'] then raise exception 'withdrawal queued %, expected only the unshared display key', keys; end if;
  if (select status from case_app.assets where id = a) <> 'withdrawn' or (select withdrawn_reason from case_app.assets where id = a) <> 'Rights complaint' then raise exception 'not withdrawn'; end if;
  if not exists (select 1 from case_app.workspace_audit where action = 'asset_withdraw' and target_id = a and elevation_id = '0199a000-0000-7000-8000-00000000e71f') then raise exception 'takedown not audited with its elevation'; end if;
  v_err := pg_temp.refused(format($q$select * from case_api.admin_withdraw_asset(%L,%L,'Again',%L,true,'admin@example.com','0199a000-0000-7000-8000-00000000e71f')$q$, ws, a, adm));
  if v_err is null or v_err not like '40001 asset_not_withdrawable%' then raise exception 'second withdrawal: %', v_err; end if;
  raise notice 'ok a takedown needs the admin step-up, is audited with it, and queues only keys no live image uses';

  -- Rejecting queues the rejected image's keys (except the one a live image shares).
  perform case_api.admin_review_asset(ws, b, 'reject', null, null, adm, true, 'admin@example.com');
  select count(*) into n from case_app.media_purge_queue where r2_key = 'media/'||ws||'/'||repeat('c',64)||'.jpg' and reason = 'rejected';
  if n <> 1 then raise exception 'rejected display key not queued'; end if;
  -- With both a and b closed, their shared phone key is no longer live and is queued too.
  if not exists (select 1 from case_app.media_purge_queue where r2_key = 'media/'||ws||'/'||repeat('b',64)||'.jpg') then raise exception 'shared key not queued once unused'; end if;
  -- CASE-342: an upload is usable at once, so the sweep never closes one for age (31 days here); a live image's keys are never leased.
  c := pg_temp.upload(repeat('d',64), repeat('e',64));
  update case_app.assets set created_at = now() - interval '31 days' where id = c;
  perform pg_temp.upload(repeat('9',64), repeat('8',64));
  select array_agg(r2_key order by r2_key) into keys from case_api.media_purge_claim(50);
  if keys is distinct from (select array_agg(k order by k) from unnest(array['a','b','c']) x(n), lateral (select 'media/'||ws||'/'||repeat(x.n,64)||'.jpg' k) y) then
    raise exception 'lease %', keys; end if;
  if (select status from case_app.assets where id = c) <> 'quarantined' then raise exception 'the sweep closed a live upload for age'; end if;
  if (select count(*) from case_api.media_purge_claim(50)) <> 0 then raise exception 'a leased key was leased again within its lease'; end if;
  if case_api.media_purge_complete(keys) <> cardinality(keys) or case_api.media_purge_complete(keys) <> 0 then raise exception 'completion count'; end if;
  if (select count(*) from case_api.media_known_keys(array['media/'||ws||'/'||repeat('9',64)||'.jpg', 'media/'||ws||'/'||repeat('a',64)||'.jpg', 'media/'||ws||'/'||repeat('f',64)||'.jpg'])) <> 1 then raise exception 'known keys'; end if;
  raise notice 'ok rejected images queue their keys, old uploads stay live; leases are bounded and complete once; orphans are identifiable';
end $$;
-- Red-team B1/S5: a withdrawn file cannot be stored again and is not a known key; the 30-day sweep never touches an
-- approved image, and an approved image leaves approval only by withdrawal.
do $$
declare ws constant uuid := '0199a000-0000-7000-8000-00000000e710'; adm constant uuid := '0199a000-0000-7000-8000-00000000e709';
  o constant uuid := '0199a000-0000-7000-8000-00000000e701'; f uuid; g uuid; h uuid; v_err text; v jsonb; keys text[];
begin
  f := pg_temp.upload(repeat('f',64), repeat('0',64));
  perform case_api.admin_review_asset(ws, f, 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = f), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = f), adm, true, 'admin@example.com');
  perform * from case_api.admin_withdraw_asset(ws, f, 'Consent withdrawn', adm, true, 'admin@example.com', '0199a000-0000-7000-8000-00000000e71f');
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L,%L,false,null,repeat('f',64),4000)$q$, ws, o));
  if v_err is null or v_err not like '23505 asset_closed%' then raise exception 'a withdrawn file was allowed again: %', v_err; end if;
  if exists (select 1 from case_api.media_known_keys(array['media/'||ws||'/'||repeat('f',64)||'.jpg'])) then raise exception 'a withdrawn key counts as known'; end if;
  g := pg_temp.upload(repeat('5',64), repeat('4',64));
  update case_app.assets set created_at = now() - interval '40 days' where id = g;
  perform case_api.admin_review_asset(ws, g, 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = g), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = g), adm, true, 'admin@example.com');
  perform * from case_api.media_purge_claim(50);
  if (select status from case_app.assets where id = g) <> 'approved' then raise exception 'the sweep closed an approved image'; end if;
  v_err := pg_temp.refused(format($q$update case_app.assets set status = 'rejected' where id = %L$q$, g));
  if v_err is null or v_err not like '42501 approved_asset_immutable%' then raise exception 'approved -> rejected: %', v_err; end if;
  if (select resume_after from case_api.media_sweep_position(null)) <> '' then raise exception 'fresh position'; end if;
  perform * from case_api.media_sweep_position('media/'||ws||'/'||repeat('f',64)||'.jpg');
  if (select resume_after from case_api.media_sweep_position(null)) <> 'media/'||ws||'/'||repeat('f',64)||'.jpg' then raise exception 'position not kept'; end if;
  v_err := pg_temp.refused($q$select * from case_api.media_sweep_position('javascript:alert(1)')$q$);
  if v_err is null or v_err not like '23514%' then raise exception 'a malformed position was kept: %', v_err; end if;
  -- A stray object under media/ that is not a rendition key is still a position the walk can pass.
  perform * from case_api.media_sweep_position('media/'||ws||'/notes.txt');
  if (select resume_after from case_api.media_sweep_position(null)) <> 'media/'||ws||'/notes.txt' then raise exception 'stray position refused'; end if;
  -- A small image whose display and phone copies are the same bytes: withdrawing it queues that one key once.
  h := pg_temp.upload(repeat('7',64), repeat('7',64));
  perform case_api.admin_review_asset(ws, h, 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = h), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = h), adm, true, 'admin@example.com');
  if (select count(*) from case_api.admin_withdraw_asset(ws, h, 'Rights complaint', adm, true, 'admin@example.com', '0199a000-0000-7000-8000-00000000e71f')) <> 1 then
    raise exception 'a shared display and phone key was not queued exactly once'; end if;
  -- A video (card 59, Julian 2026-10-15): its one file (display and phone) and its poster are both queued on withdrawal.
  v := case_api.builder_create_asset(ws, o, false, null, jsonb_build_object('sha256', repeat('6',64), 'bytes', 20000000, 'width', 1280, 'height', 720, 'type', 'video/mp4'),
    jsonb_build_object('sha256', repeat('6',64), 'bytes', 20000000, 'width', 1280, 'height', 720, 'type', 'video/mp4'),
    jsonb_build_object('alt_text', 'Echo', 'evidence_kind', 'imaging', 'rights_basis', 'own_work', 'licence', 'own-work', 'duration_ms', 42000),
    jsonb_build_object('sha256', repeat('6',63)||'5', 'bytes', 90000, 'width', 1280, 'height', 720, 'type', 'image/jpeg'));
  perform case_api.admin_review_asset(ws, (v->>'asset_id')::uuid, 'approve', (select case_app.asset_review_state(r) from case_app.assets r where r.id = (v->>'asset_id')::uuid), (select case_app.asset_open_warnings(r) from case_app.assets r where r.id = (v->>'asset_id')::uuid), adm, true, 'admin@example.com');
  select array_agg(r2_key order by r2_key) into keys from case_api.admin_withdraw_asset(ws, (v->>'asset_id')::uuid, 'Consent withdrawn', adm, true, 'admin@example.com', '0199a000-0000-7000-8000-00000000e71f');
  if keys is distinct from array['media/'||ws||'/'||repeat('6',63)||'5.jpg', 'media/'||ws||'/'||repeat('6',64)||'.mp4'] then raise exception 'video withdrawal queued %', keys; end if;
  raise notice 'ok withdrawn files stay out; the sweep spares approved images; the walk position is kept';
end $$;
rollback;
