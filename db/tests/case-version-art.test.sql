-- db/tests/case-version-art.test.sql
-- Assertions for migrations/20261006000000_case_version_art.sql (card 28, CASE-164): the SQL
-- derivation matches describeCase, the RPC stores only a verified descriptor, the row is immutable,
-- delivery carries one numbers-only `art` column, and nobody but service_role executes anything.
-- The dollar-quoted doc/expected pairs below are also asserted against the JS describeCase by
-- tests/art-sql-parity.test.mjs, so the two derivations cannot drift apart silently.
\set QUIET on
\set mvc `cat src/fixtures/synthetic-workshop.case.json`

create temp table art_fixture as select :'mvc'::jsonb as doc;

-- fixtures: an author in a workspace with one case
insert into auth.users values ('0199a000-0000-7000-8000-00000000a801');
insert into case_app.profiles (id, display_name) values ('0199a000-0000-7000-8000-00000000a801', 'Art author');
insert into auth.users values ('0199a000-0000-7000-8000-00000000a802');
insert into case_app.profiles (id, display_name) values ('0199a000-0000-7000-8000-00000000a802', 'Art outsider');
insert into case_app.workspaces (id, slug, name) values ('0199a000-0000-7000-8000-00000000a80a', 'c28-art', 'Card 28');
insert into case_app.workspace_members (workspace_id, user_id, role)
values ('0199a000-0000-7000-8000-00000000a80a', '0199a000-0000-7000-8000-00000000a801', 'author');
insert into case_app.cases (id, workspace_id, owner_id, title)
values ('0199a000-0000-7000-8000-00000000a8c1', '0199a000-0000-7000-8000-00000000a80a',
        '0199a000-0000-7000-8000-00000000a801', 'Art case');

-- The SQL derivation equals describeCase on the real MVC fixture.
do $$
begin
  if case_app.art_structure((select doc from art_fixture)) <>
     $exp${"v":1,"stops":5,"decisions":[{"stop":1,"strands":[{"rejoin":2},{"rejoin":2}],"resets":1,"ends":0},{"stop":2,"strands":[{"rejoin":3},{"rejoin":3}],"resets":0,"ends":0},{"stop":3,"strands":[{"rejoin":4},{"rejoin":4}],"resets":0,"ends":0}]}$exp$::jsonb then
    raise exception 'art_structure(MVC) = %', case_app.art_structure((select doc from art_fixture)); end if;
  raise notice 'ok art_structure on the MVC fixture';
end $$;

-- Parity pairs: a skip, a terminal reset, an upstream return, a dead end, a missing next beat.
create temp table art_pairs (doc jsonb, expected jsonb);
insert into art_pairs values
($doc${"start_beat_id":"a","beats":[{"id":"a","kind":"surface","next_beat_id":"b"},{"id":"b","kind":"decision","decision_id":"D1"},{"id":"c","kind":"decision","decision_id":"D2"},{"id":"d","kind":"debrief"},{"id":"x","kind":"surface","next_beat_id":"d"}],"decisions":[{"id":"D1","paths":[{"id":"p1","recommended":true,"next_beat_id":"c"},{"id":"p2","next_beat_id":"x"},{"id":"p3","terminal":{"checkpoint_beat_id":"b"}},{"id":"p4","next_beat_id":"c"}]},{"id":"D2","paths":[{"id":"q1","next_beat_id":"b"},{"id":"q2","recommended":true,"next_beat_id":"d"},{"id":"q3","next_beat_id":"y"},{"id":"q4"}]}]}$doc$,
 $exp${"v":1,"stops":4,"decisions":[{"stop":1,"strands":[{"rejoin":3},{"rejoin":2}],"resets":1,"ends":0},{"stop":2,"strands":[],"resets":1,"ends":2}]}$exp$),
($doc${"start_beat_id":"s","beats":[{"id":"s","kind":"decision","decision_id":"D"},{"id":"e","kind":"debrief"},{"id":"loop1","kind":"surface","next_beat_id":"loop2"},{"id":"loop2","kind":"surface","next_beat_id":"loop1"}],"decisions":[{"id":"D","paths":[{"id":"r","recommended":true,"next_beat_id":"e"},{"id":"l","next_beat_id":"loop1"},{"id":"f","terminal":false,"next_beat_id":"e"}]}]}$doc$,
 $exp${"v":1,"stops":2,"decisions":[{"stop":0,"strands":[{"rejoin":1}],"resets":0,"ends":1}]}$exp$),
-- Only a strictly true recommended flag counts; a route back into its own decision is a reset.
($doc${"start_beat_id":"s","beats":[{"id":"s","kind":"surface","next_beat_id":"k"},{"id":"k","kind":"decision","decision_id":"D"},{"id":"e","kind":"debrief"},{"id":"x","kind":"surface","next_beat_id":"e"}],"decisions":[{"id":"D","paths":[{"id":"a","recommended":"no","next_beat_id":"x"},{"id":"b","recommended":1,"next_beat_id":"e"},{"id":"c","recommended":true,"next_beat_id":"e"},{"id":"d","next_beat_id":"k"}]}]}$doc$,
 $exp${"v":1,"stops":3,"decisions":[{"stop":1,"strands":[{"rejoin":2},{"rejoin":2}],"resets":1,"ends":0}]}$exp$);

do $$
declare r record;
begin
  for r in select * from art_pairs loop
    if case_app.art_structure(r.doc) <> r.expected then
      raise exception 'art_structure parity: got %, expected %', case_app.art_structure(r.doc), r.expected; end if;
  end loop;
  raise notice 'ok art_structure parity pairs';
end $$;

-- [CASE-164] The RPC refuses a tampered or malformed descriptor and stores only a verified one.
do $$
declare
  v_author uuid := '0199a000-0000-7000-8000-00000000a801';
  v_case uuid := '0199a000-0000-7000-8000-00000000a8c1';
  v_good jsonb;
  v_bad jsonb;
  v_rev bigint;
  v_row record;
  v_versions integer;
  v_refused integer := 0;
begin
  v_rev := case_api.save_draft(v_case, 0, 1, (select doc from art_fixture), v_author);
  v_good := case_app.art_structure((select doc from art_fixture)) || '{"attempt":2,"summarised":false,"renderer":1}'::jsonb;
  foreach v_bad in array array[
    jsonb_set(v_good, '{decisions,0,resets}', '0'),                         -- a structure that is not the draft's
    jsonb_set(v_good, '{stops}', '6'),
    v_good - 'attempt',                                                     -- unsolved
    v_good - 'renderer', v_good || '{"renderer":0}', v_good || '{"renderer":"1"}',   -- no renderer version
    v_good || '{"attempt":16}', v_good || '{"attempt":-1}', v_good || '{"attempt":1.5}',
    v_good || '{"summarised":"no"}',
    v_good || '{"label":"Tension pneumothorax"}',                            -- any extra key, including text
    jsonb_set(v_good, '{decisions,0,id}', '"0199a000-0000-7000-8000-00000000a8c1"'),
    'null'::jsonb
  ] loop
    begin
      perform * from case_api.publish_draft_with_art(v_case, v_rev, v_author, '{}', v_bad, true, 'admin@example.org');
      raise exception 'publish_draft_with_art accepted %', v_bad;
    exception when invalid_parameter_value then v_refused := v_refused + 1; end;
  end loop;
  begin
    perform * from case_api.publish_draft_with_art(v_case, v_rev, v_author, '{}', null, true, 'admin@example.org');
    raise exception 'publish_draft_with_art accepted a null descriptor';
  exception when invalid_parameter_value then v_refused := v_refused + 1; end;
  select count(*) into v_versions from case_app.case_versions where case_id = v_case;
  -- Scoped to this case: since card 35b, case-init.test.sql publishes through publish_draft_with_art too.
  if v_versions <> 0 or exists (select 1 from case_app.case_version_art a join case_app.case_versions v
      on v.id = a.case_version_id where v.case_id = v_case) then
    raise exception 'a refused publish left a version or art row'; end if;

  select * into v_row from case_api.publish_draft_with_art(v_case, v_rev, v_author, '{}', v_good, true, 'admin@example.org');
  if v_row.version_no <> 1 or v_row.content_sha256 is null then raise exception 'publish_draft_with_art did not publish'; end if;
  if (select descriptor from case_app.case_version_art where case_version_id = v_row.version_id) <> v_good then
    raise exception 'stored descriptor differs from the verified one'; end if;
  if (select renderer_version from case_app.case_version_art where case_version_id = v_row.version_id) <> 1 then
    raise exception 'renderer version not stored with the version'; end if;
  raise notice 'ok publish_draft_with_art refused % tampered descriptors and stored the verified one', v_refused;
end $$;

-- A stale revision is a conflict before any art check; an outsider cannot publish.
do $$
declare
  v_case uuid := '0199a000-0000-7000-8000-00000000a8c1';
  v_good jsonb := case_app.art_structure((select doc from art_fixture)) || '{"attempt":0,"summarised":true,"renderer":1}'::jsonb;
  v_conflict boolean := false; v_denied boolean := false;
begin
  begin perform * from case_api.publish_draft_with_art(v_case, 99, '0199a000-0000-7000-8000-00000000a801', '{}', v_good, true, 'admin@example.org');
  exception when serialization_failure then v_conflict := true; end;
  begin perform * from case_api.publish_draft_with_art(v_case, 1, '0199a000-0000-7000-8000-00000000a802', '{}', v_good);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_conflict or not v_denied then raise exception 'revision or membership gate missing'; end if;
  raise notice 'ok publish_draft_with_art revision and account gates';
end $$;

-- The stored descriptor is immutable, and the table's check refuses a malformed row even from the owner.
do $$
declare v_version uuid; v_blocked integer := 0;
begin
  select case_version_id into v_version from case_app.case_version_art limit 1;
  begin update case_app.case_version_art set descriptor = descriptor || '{"attempt":3}' where case_version_id = v_version;
  exception when insufficient_privilege then v_blocked := v_blocked + 1; end;
  begin delete from case_app.case_version_art where case_version_id = v_version;
  exception when insufficient_privilege then v_blocked := v_blocked + 1; end;
  begin insert into case_app.case_version_art (case_version_id, descriptor, renderer_version) values (v_version, '{"v":1,"label":"x"}', 1);
  exception when check_violation then v_blocked := v_blocked + 1; end;
  begin truncate case_app.case_version_art;
  exception when insufficient_privilege then v_blocked := v_blocked + 1; end;
  if not exists (select 1 from case_app.case_version_art) then raise exception 'truncate emptied case_version_art'; end if;
  if v_blocked <> 4 then raise exception 'case_version_art is mutable or unchecked'; end if;
  raise notice 'ok case_version_art immutable and checked';
end $$;

-- Delivery: both reads return the stored descriptor as their one new column; an older version reads null.
do $$
declare
  v_author uuid := '0199a000-0000-7000-8000-00000000a801';
  v_ws uuid := '0199a000-0000-7000-8000-00000000a80a';
  v_case uuid := '0199a000-0000-7000-8000-00000000a8c1';
  v_listed record; v_read record; v_plain record; v_rev bigint;
begin
  select * into v_listed from case_api.list_published_versions(v_author, v_ws, 10, null);
  if v_listed.art is null or jsonb_typeof(v_listed.art) <> 'object' or v_listed.title is distinct from (select doc->>'title' from art_fixture) then
    raise exception 'list_published_versions did not carry art'; end if;
  select * into v_read from case_api.get_case_version_for_workspace(v_listed.version_id, v_ws, v_author);
  if v_read.art is distinct from v_listed.art or v_read.document_text is null then
    raise exception 'get_case_version_for_workspace did not carry art'; end if;
  -- A version published by the legacy RPC has no art row: delivery reads null, never invents one. The legacy
  -- art-less publish_draft is dropped (card 35b contract), so the legacy row is written directly, as it stands.
  v_rev := case_api.save_draft(v_case, 1, 1, (select doc from art_fixture), v_author);
  insert into case_app.case_versions (case_id, version_no, schema_version, document, content_sha256, published_by)
    select v_case, (select max(version_no) + 1 from case_app.case_versions where case_id = v_case), 1, doc,
      sha256(convert_to(doc::text, 'UTF8')), v_author from art_fixture
    returning id as version_id into v_plain;
  if (select art from case_api.get_case_version_for_workspace(v_plain.version_id, v_ws, v_author)) is not null then
    raise exception 'a version without art read back art'; end if;
  if (select count(*) from case_api.list_published_versions(v_author, v_ws, 10, null) where art is null) <> 1 then
    raise exception 'list_published_versions art column wrong for a legacy version'; end if;
  raise notice 'ok delivery carries the stored descriptor only';
end $$;

-- Privileges: service_role executes the RPCs; anon and authenticated touch nothing; no table grants.
do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'case_api.publish_draft_with_art(uuid,bigint,uuid,uuid[],jsonb,boolean,text)',
    'case_api.list_published_versions(uuid,uuid,integer,uuid,boolean,text)',
    'case_api.get_case_version_for_workspace(uuid,uuid,uuid,boolean,text)'] loop
    if v_signature = 'case_api.publish_draft_with_art(uuid,bigint,uuid,uuid[],jsonb,boolean,text)'::text then
      if has_function_privilege('service_role', v_signature, 'execute') then raise exception 'legacy first-publish RPC remains executable by service_role'; end if;
    elsif not has_function_privilege('service_role', v_signature, 'execute') then raise exception '% lost service_role', v_signature; end if;
    if has_function_privilege('anon', v_signature, 'execute') or has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception '% is executable by a client role', v_signature; end if;
    if not (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = v_signature::regprocedure) then
      raise exception '% is not a pinned security definer', v_signature; end if;
  end loop;
  foreach v_signature in array array['case_app.art_structure(jsonb)', 'case_app.art_next(jsonb,jsonb)', 'case_app.art_shape_ok(jsonb)'] loop
    if has_function_privilege('anon', v_signature, 'execute') or has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception '% is executable by a client role', v_signature; end if;
  end loop;
  if has_table_privilege('anon', 'case_app.case_version_art', 'select') or has_table_privilege('authenticated', 'case_app.case_version_art', 'select')
     or has_table_privilege('service_role', 'case_app.case_version_art', 'select') or has_table_privilege('service_role', 'case_app.case_version_art', 'insert') then
    raise exception 'case_version_art has a table grant'; end if;
  if not (select relrowsecurity from pg_class where oid = 'case_app.case_version_art'::regclass) then
    raise exception 'case_version_art without row level security'; end if;
  if to_regprocedure('case_api.publish_draft(uuid,bigint,uuid,uuid[])') is not null then
    raise exception 'the art-less publish RPC still exists (card 35b contract drops it)'; end if;
  if exists (select 1 from case_app._lockdown_alerts) then raise exception 'the art migration tripped the lockdown backstop'; end if;
  raise notice 'ok art privileges';
end $$;
