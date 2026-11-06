-- db/tests/case-init.test.sql
-- Assertions for migrations/20261001000000_case_init.sql. Each block raises on failure;
-- run with ON_ERROR_STOP (scripts/test-db.sh).
-- Since the card 35b contract migration the retired publish_draft, get_case_version and 4/5-argument
-- create_session are gone: these blocks drive their successors (publish_draft_with_art,
-- get_case_version_for_workspace and the create_session that takes the room's UUIDv7) with the same assertions.
\set QUIET on

-- fixtures
create function pg_temp.art_of(p_case uuid) returns jsonb language sql as $f$
  select case_app.art_structure(document) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb
    from case_app.case_drafts where case_id = p_case $f$;
insert into auth.users values ('0199a000-0000-7000-8000-000000000001');
insert into case_app.profiles (id, display_name) values ('0199a000-0000-7000-8000-000000000001', 'Julian');
insert into case_app.workspaces (id, slug, name) values ('0199a000-0000-7000-8000-00000000000a', 'fsh-icu', 'FSH ICU');
insert into case_app.workspace_members (workspace_id, user_id, role) values ('0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', 'owner');
-- an outsider with an auth account but no membership
insert into auth.users values ('0199a000-0000-7000-8000-000000000002');
insert into case_app.profiles (id, display_name) values ('0199a000-0000-7000-8000-000000000002', 'Outsider');
insert into case_app.cases (id, workspace_id, owner_id, title)
values ('0199a000-0000-7000-8000-0000000000c1', '0199a000-0000-7000-8000-00000000000a',
        '0199a000-0000-7000-8000-000000000001', 'Pressure on the Right');

do $$
declare a uuid; b uuid;
begin
  a := case_app.uuid_v7(); perform pg_sleep(0.002); b := case_app.uuid_v7();
  if a::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'uuid_v7 format: %', a; end if;
  if not (a < b) then raise exception 'uuid_v7 not time-ordered: % !< %', a, b; end if;
  if abs(extract(epoch from now()) * 1000 - ('x' || lpad(replace(left(a::text, 13), '-', ''), 16, '0'))::bit(64)::bigint) > 60000 then
    raise exception 'uuid_v7 timestamp far from now'; end if;
  raise notice 'ok uuid_v7';
end $$;

do $$
declare r bigint; failed boolean := false;
begin
  r := case_api.save_draft('0199a000-0000-7000-8000-0000000000c1', 0, 1, '{"beats":[]}', '0199a000-0000-7000-8000-000000000001');
  if r <> 1 then raise exception 'first save should be revision 1, got %', r; end if;
  begin
    perform case_api.save_draft('0199a000-0000-7000-8000-0000000000c1', 0, 1, '{}', '0199a000-0000-7000-8000-000000000001');
  exception when serialization_failure then failed := true; end;
  if not failed then raise exception 'stale revision was accepted'; end if;
  r := case_api.save_draft('0199a000-0000-7000-8000-0000000000c1', 1, 1, '{"beats":[{"id":"x"}]}', '0199a000-0000-7000-8000-000000000001');
  if r <> 2 then raise exception 'second save should be revision 2, got %', r; end if;
  raise notice 'ok save_draft CAS';
end $$;

do $$
declare v record; failed boolean := false; asset uuid;
begin
  -- The current P-15 contract is admin-only; this is a privileged fixture exercising the legacy
  -- immutable-version/asset SQL mechanics, not an author publication permission assertion.
  select * into v from case_api.publish_draft_with_art('0199a000-0000-7000-8000-0000000000c1', 2, '0199a000-0000-7000-8000-000000000001', '{}', pg_temp.art_of('0199a000-0000-7000-8000-0000000000c1'), true, 'admin@example.org');
  if v.version_no <> 1 or octet_length(v.content_sha256) <> 32 then raise exception 'publish result %', v; end if;
  begin
    update case_app.case_versions set version_no = 9 where id = v.version_id;
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'case_versions update was allowed'; end if;

  insert into case_app.assets (workspace_id, uploaded_by, kind, media_type, byte_size, content_sha256, r2_key)
  values ('0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', 'image', 'image/png', 10,
          sha256('x'), 'assets/a/b.png') returning id into asset;
  failed := false;
  begin
    perform case_api.publish_draft_with_art('0199a000-0000-7000-8000-0000000000c1', 2, '0199a000-0000-7000-8000-000000000001', array[asset], pg_temp.art_of('0199a000-0000-7000-8000-0000000000c1'), true, 'admin@example.org');
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'unapproved asset was published'; end if;
  failed := false;
  begin
    update case_app.assets set status = 'approved' where id = asset;
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'asset approved without rights/de-identification/alt'; end if;
  -- CASE-268: an approved image also carries its licence, kind and pixel size.
  update case_app.assets set status = 'approved', rights_basis = 'own_work', alt_text = 'CXR', licence = 'own-work', evidence_kind = 'imaging', width = 800, height = 600,
         deidentified_attested_by = '0199a000-0000-7000-8000-000000000001', deidentified_attested_at = now()
   where id = asset;
  -- CASE-269: a version pins exactly the images its document shows, so the draft names the asset on a surface.
  perform case_api.save_draft('0199a000-0000-7000-8000-0000000000c1', 2, 1, jsonb_build_object('beats', '[{"id":"x"}]'::jsonb, 'surfaces', jsonb_build_array(jsonb_build_object('id', 's', 'asset_ids', jsonb_build_array(asset)))), '0199a000-0000-7000-8000-000000000001');
  select * into v from case_api.publish_draft_with_art('0199a000-0000-7000-8000-0000000000c1', 3, '0199a000-0000-7000-8000-000000000001', array[asset], pg_temp.art_of('0199a000-0000-7000-8000-0000000000c1'), true, 'admin@example.org');
  if v.version_no <> 2 then raise exception 'second publish should be v2'; end if;
  raise notice 'ok publish_draft_with_art, immutability, asset gate';
end $$;

do $$
declare s1 uuid; s2 uuid; ver uuid; failed boolean := false; r record;
begin
  select id into ver from case_app.case_versions where version_no = 1;
  s1 := case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', '7K3QX9');
  begin
    perform case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', '7K3QX9');
  exception when unique_violation then failed := true; end;
  if not failed then raise exception 'duplicate active join code accepted'; end if;
  failed := false;
  begin
    perform case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', '7K3QXU');
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'non-Crockford join code accepted'; end if;

  select * into r from case_api.resolve_join_code('7k3qx9');
  if r.session_id <> s1 then raise exception 'resolve_join_code failed'; end if;

  perform case_api.end_session(s1, 10, 0);
  s2 := case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', '7K3QX9');
  if s2 is null then raise exception 'join code not recycled after end'; end if;
  perform case_api.end_session(s2, 0, 0);
  raise notice 'ok sessions + join codes';
end $$;

do $$
declare s uuid; ver uuid; b jsonb; m bigint; n int; failed boolean := false;
begin
  select id into ver from case_app.case_versions where version_no = 1;
  s := case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', 'ABC123');
  b := jsonb_build_object(
    'status', 'live', 'started_at', now(),
    'participants', jsonb_build_array(jsonb_build_object('id', '0199a000-0000-7000-8000-0000000000b1',
        'display_name', 'Adrenaline Junkie', 'token_sha256', encode(sha256('tok'), 'hex'), 'joined_at', now())),
    'rounds', jsonb_build_array(
        jsonb_build_object('id', '0199a000-0000-7000-8000-0000000000d0', 'decision_id', '0199a000-0000-7000-8000-0000000000e1',
          'round_no', 1, 'status', 'superseded', 'opened_at', now(), 'aggregate', '{"counts":{"0199a000-0000-7000-8000-0000000000aa":3},"total":3}'::jsonb),
        jsonb_build_object('id', '0199a000-0000-7000-8000-0000000000d1', 'decision_id', '0199a000-0000-7000-8000-0000000000e1',
          'round_no', 2, 'status', 'resolved', 'opened_at', now(), 'aggregate', '{"counts":{"0199a000-0000-7000-8000-0000000000aa":17},"total":22}'::jsonb, 'resolution_kind', 'majority')),
    'responses', jsonb_build_array(jsonb_build_object('id', '0199a000-0000-7000-8000-0000000000f1', 'round_id', '0199a000-0000-7000-8000-0000000000d1',
        'participant_id', '0199a000-0000-7000-8000-0000000000b1', 'response', '{"option_id":"0199a000-0000-7000-8000-0000000000aa"}'::jsonb, 'last_client_event_id', '0199a000-0000-7000-8000-000000000ce1',
        'first_submitted_at', now(), 'last_submitted_at', now())),
    'events', jsonb_build_array(
        jsonb_build_object('seq', 1, 'event_id', case_app.uuid_v7(), 'epoch', 0, 'kind', 'room_started', 'occurred_at', now()),
        jsonb_build_object('seq', 2, 'event_id', case_app.uuid_v7(), 'epoch', 0, 'kind', 'responses_locked', 'occurred_at', now())));
  m := case_api.archive_session_batch(s, b);
  m := case_api.archive_session_batch(s, b);  -- replay must be a no-op
  if m <> 2 then raise exception 'archived_through should be 2, got %', m; end if;
  select count(*) into n from case_app.session_events where session_id = s;
  if n <> 2 then raise exception 'events duplicated on replay: %', n; end if;
  select count(*) into n from case_app.session_responses where session_id = s;
  if n <> 1 then raise exception 'responses duplicated on replay: %', n; end if;
  if (select status from case_app.sessions where id = s) <> 'live' then raise exception 'status not applied'; end if;

  begin
    update case_app.session_events set kind = 'x' where session_id = s;
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'session_events update allowed'; end if;

  perform case_api.end_session(s, 2, 0);
  perform case_api.archive_session_batch(s, jsonb_build_object('status', 'live'));
  if (select status from case_app.sessions where id = s) <> 'ended' then raise exception 'late batch reopened an ended session'; end if;

  -- [AS-018] 25 h after the end: names, tokens and per-person answers go; pseudonymous aggregates stay.
  update case_app.sessions set ended_at = now() - interval '25 hours' where id = s;
  n := case_api.purge_expired_participant_data();
  if n < 1 then raise exception 'purge touched no sessions'; end if;
  if exists (select 1 from case_app.session_responses where session_id = s) then raise exception 'responses survived purge'; end if;
  if exists (select 1 from case_app.session_participants where session_id = s and (display_name is not null or token_sha256 is not null)) then
    raise exception 'names or tokens survived purge'; end if;
  if exists (select 1 from case_app.session_rounds where session_id = s and aggregate is null) then raise exception 'aggregate lost in purge'; end if;
  if (select aggregate -> 'counts' from case_app.session_rounds where id = '0199a000-0000-7000-8000-0000000000d1') is null then
    raise exception 'aggregate stored as a string, not jsonb'; end if;
  if (select rows from case_app.job_heartbeats where job = 'purge_participant_data') is null then raise exception 'purge heartbeat missing'; end if;

  perform case_api.archive_session_batch(s, b);  -- a late replay must not resurrect personal data
  if exists (select 1 from case_app.session_responses where session_id = s) then raise exception 'replay resurrected responses'; end if;
  if exists (select 1 from case_app.session_participants where session_id = s and display_name is not null) then
    raise exception 'replay resurrected names'; end if;
  raise notice 'ok archive idempotency, journal immutability, retention purge';
end $$;

do $$
declare failed boolean := false; ver uuid; sid uuid;
begin
  select id into ver from case_app.case_versions where version_no = 1;
  begin
    perform case_api.save_draft('0199a000-0000-7000-8000-0000000000c1', 2, 1, '{}', '0199a000-0000-7000-8000-000000000002');
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'outsider could save another workspace''s draft'; end if;
  failed := false;
  begin
    perform * from case_api.get_case_version_for_workspace(ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000002');
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'outsider could read an answer key'; end if;
  failed := false;
  begin
    perform case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000002', 'TTX001');
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'outsider could start a room'; end if;
  sid := case_api.create_session(case_app.uuid_v7(), ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', 'TTX002', interval '100 years');
  if (select expires_at - created_at from case_app.sessions where id = sid) > interval '24 hours 1 minute' then
    raise exception 'room lifetime not clamped to 24 h'; end if;
  if (select document_text from case_api.get_case_version_for_workspace(ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001')) is null
     or sha256(convert_to((select document_text from case_api.get_case_version_for_workspace(ver, '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001')), 'UTF8'))
        <> (select content_sha256 from case_app.case_versions where id = ver) then
    raise exception 'document_text does not hash to content_sha256'; end if;
  perform case_api.end_session(sid, 0, 0);
  raise notice 'ok authorisation inside RPCs, TTL clamp, pack hash';
end $$;

-- privileges
set role anon;
do $$
declare failed boolean := false;
begin
  begin perform 1 from case_app.cases; exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'anon can read case_app.cases'; end if;
  failed := false;
  begin perform case_api.resolve_join_code('ABC123'); exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'anon can execute case_api'; end if;
end $$;
reset role;
set role authenticated;
do $$
declare failed boolean := false;
begin
  begin perform 1 from case_app.session_responses; exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'authenticated can read responses'; end if;
end $$;
reset role;
set role service_role;
do $$
begin
  perform case_api.resolve_join_code('ABC123');
  raise notice 'ok lockdown (anon/authenticated denied, service_role via case_api only)';
end $$;
reset role;
