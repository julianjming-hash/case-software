-- db/tests/phase-1b-rpcs.test.sql
-- Assertions for the Phase 1b RPC and lockdown migration. Run with ON_ERROR_STOP.
\set QUIET on

-- [AS-068] Phase 1b authoring RPCs preserve tenancy and reject unsafe input.
do $$
declare v_workspace uuid; v_case uuid; failed boolean; v_owner uuid := '0199a000-0000-7000-8000-000000000001'; v_before text;
begin
  -- Insert-only since 20261106000000_facilitator_label.sql: it fills a missing name, never replaces a stored one.
  select display_name into v_before from case_app.profiles where id = v_owner;
  perform case_api.ensure_profile(v_owner, 'Updated Owner');
  perform case_api.ensure_profile(v_owner, 'Updated Owner');
  if (select display_name from case_app.profiles where id = v_owner) is distinct from coalesce(v_before, 'Updated Owner') then
    raise exception 'ensure_profile replaced a stored name or did not fill a missing one'; end if;
  v_workspace := case_api.bootstrap_workspace(v_owner, 'phase-one-b', 'Phase One B', true, 'admin@example.org');
  if (select role from case_app.workspace_members where workspace_id = v_workspace and user_id = v_owner) <> 'owner' then
    raise exception 'bootstrap did not create owner membership'; end if;
  failed := false;
  begin perform case_api.bootstrap_workspace(v_owner, 'phase-one-b', 'Hijacked', true, 'admin@example.org');
  exception when unique_violation then failed := true; end;
  if not failed then raise exception 'existing slug could be claimed'; end if;
  v_case := case_api.create_case(v_owner, v_workspace, 'A new case');
  if (select owner_id from case_app.cases where id = v_case) <> v_owner then raise exception 'create_case owner mismatch'; end if;
  failed := false;
  begin perform case_api.create_case('0199a000-0000-7000-8000-000000000002', v_workspace, 'Intruder');
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'outsider created a case'; end if;
  failed := false;
  begin perform case_api.create_case(v_owner, v_workspace, 'Bad' || chr(1));
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'control character accepted in title'; end if;
  raise notice 'ok Phase 1b authoring and tenancy';
end $$;



-- [AS-069] Published versions page deterministically, including equal timestamps.
do $$
declare v_case uuid := '0199a000-0000-7000-8000-0000000000c1';
  v_owner uuid := '0199a000-0000-7000-8000-000000000001';
  v_workspace uuid := '0199a000-0000-7000-8000-00000000000a';
  v_after uuid; r record; seen uuid[] := '{}'; n integer := 0; page_no integer := 0; failed boolean := false;
begin
  insert into case_app.case_versions (case_id, version_no, schema_version, document, content_sha256, published_by, published_at)
  select v_case, 1000 + g, 1, '{}'::jsonb, sha256(convert_to(g::text, 'UTF8')), v_owner,
         timestamp with time zone '2026-10-02 00:00:00+00' + (g / 5) * interval '1 second'
    from generate_series(1, 250) g;
  loop
    page_no := page_no + 1;
    if page_no > 10 then raise exception 'paging did not terminate'; end if;
    for r in select * from case_api.list_published_versions(v_owner, v_workspace, 41, v_after) loop
      if r.version_id = any(seen) then raise exception 'duplicate version across pages: %', r.version_id; end if;
      seen := array_append(seen, r.version_id);
      v_after := r.version_id;
      n := n + 1;
    end loop;
    exit when not found;
  end loop;
  if n <> (select count(*) from case_app.case_versions v join case_app.cases c on c.id = v.case_id where c.workspace_id = v_workspace) then
    raise exception 'paging lost versions: %', n; end if;
  if (select count(*) from case_api.list_published_versions(v_owner, v_workspace, 10000, null)) > 100 then
    raise exception 'paging limit not clamped'; end if;
  begin perform * from case_api.list_published_versions('0199a000-0000-7000-8000-000000000002', v_workspace, 10, null);
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'outsider listed published versions'; end if;
  raise notice 'ok published-version keyset paging: % rows', n;
end $$;

-- [AS-070] A caller-supplied UUIDv7 is the durable session id; old minting RPC is closed.
do $$
declare v_id uuid := '0199a000-0000-7000-8000-000000000777'; v_version uuid; failed boolean;
begin
  select id into v_version from case_app.case_versions where case_id = '0199a000-0000-7000-8000-0000000000c1' order by version_no limit 1;
  if case_api.create_session(v_id, v_version, '0199a000-0000-7000-8000-00000000000a',
       '0199a000-0000-7000-8000-000000000001', 'P1B777', interval '12 hours') <> v_id then
    raise exception 'supplied session id not returned'; end if;
  if (select id from case_app.sessions where id = v_id) <> v_id then raise exception 'supplied session id not stored'; end if;
  failed := false;
  begin perform case_api.create_session('0199a000-0000-4000-8000-000000000778', v_version,
      '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', 'P1B778', interval '1 hour');
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'non-v7 session id accepted'; end if;
  failed := false;
  begin perform case_api.create_session(case_app.uuid_v7(), v_version,
      '0199a000-0000-7000-8000-00000000000a', '0199a000-0000-7000-8000-000000000001', 'P1B777', interval '1 hour');
  exception when unique_violation then failed := true; end;
  if not failed then raise exception 'duplicate active join code accepted'; end if;
  raise notice 'ok caller-owned session id and join-code collision';
end $$;

-- [AS-071] The keepalive and lockdown backstop report their work.
do $$
declare v_before timestamptz := clock_timestamp() - interval '1 second'; v_alerts integer;
begin
  if exists (select 1 from case_app._lockdown_alerts) then raise exception 'fresh migration created a lockdown alert'; end if;
  perform case_app.enforce_lockdown();
  if exists (select 1 from case_app._lockdown_alerts) then
    raise exception 'no-op first sweep created a lockdown alert: %',
      (select string_agg(detail, '; ') from case_app._lockdown_alerts); end if;
  perform case_api.ping();
  if not exists (select 1 from case_api.heartbeats() where job = 'keepalive' and ran_at >= v_before) then
    raise exception 'ping heartbeat not visible'; end if;
  select count(*) into v_alerts from case_app._lockdown_alerts;
  grant select on case_app.sessions to anon;
  if has_table_privilege('anon', 'case_app.sessions', 'select') then raise exception 'event trigger left anon SELECT'; end if;
  if (select count(*) from case_api.lockdown_alerts_since(v_before)) <= v_alerts then
    raise exception 'event-trigger revoke was not alerted'; end if;
  alter event trigger case_app_lockdown_ddl disable;
  grant select on case_app.sessions to anon;
  if not has_table_privilege('anon', 'case_app.sessions', 'select') then raise exception 'disabled trigger still revoked grant'; end if;
  perform case_app.enforce_lockdown();
  alter event trigger case_app_lockdown_ddl enable;
  if has_table_privilege('anon', 'case_app.sessions', 'select') then raise exception 'hourly backstop left anon SELECT'; end if;
  if (select count(*) from case_app._lockdown_alerts) < v_alerts + 2 then
    raise exception 'hourly backstop did not alert'; end if;
  grant execute on function case_app.uuid_v7() to authenticated;
  if has_function_privilege('authenticated', 'case_app.uuid_v7()', 'execute') then
    raise exception 'event trigger left authenticated function EXECUTE'; end if;
  alter default privileges in schema case_app grant select on tables to anon;
  execute 'create table case_app.lockdown_probe (id integer)';
  if has_table_privilege('anon', 'case_app.lockdown_probe', 'select') then
    raise exception 'CREATE TABLE trigger left default anon SELECT'; end if;
  drop table case_app.lockdown_probe;
  alter default privileges in schema case_app revoke select on tables from anon;
  raise notice 'ok keepalive, event trigger and hourly lockdown';
end $$;

-- [AS-071] The alert feed crosses PostgREST's 1000-row boundary exactly once.
do $$
declare v_since timestamptz := clock_timestamp() - interval '1 second';
  v_after uuid; v_seen uuid[] := '{}'; v_expected integer; v_count integer := 0;
  v_pages integer := 0; r record; v_bad_cursor boolean := false;
begin
  insert into case_app._lockdown_alerts (detail)
  select 'local paging probe' from generate_series(1, 1101);
  select count(*) into v_expected from case_app._lockdown_alerts where at >= v_since;
  loop
    v_pages := v_pages + 1;
    if v_pages > 20 then raise exception 'alert paging did not terminate'; end if;
    for r in select * from case_api.lockdown_alerts_since(v_since, 73, v_after) loop
      if r.id = any(v_seen) then raise exception 'duplicate alert across pages: %', r.id; end if;
      v_seen := array_append(v_seen, r.id);
      v_after := r.id;
      v_count := v_count + 1;
    end loop;
    exit when not found;
  end loop;
  if v_count <> v_expected or v_count <= 1000 then
    raise exception 'alert paging lost rows: % of %', v_count, v_expected; end if;
  if (select count(*) from case_api.lockdown_alerts_since(v_since)) > 100 or
     (select count(*) from case_api.lockdown_alerts_since(v_since, 500, null)) > 100 or
     (select count(*) from case_api.lockdown_alerts_since(v_since, 0, null)) <> 1 then
    raise exception 'alert limit not clamped to 1..100'; end if;
  begin
    perform * from case_api.lockdown_alerts_since(v_since, 10, '0199a000-0000-7000-8000-00000000ffff');
  exception when invalid_parameter_value then v_bad_cursor := true; end;
  if not v_bad_cursor then raise exception 'unknown alert cursor accepted'; end if;
  raise notice 'ok alert keyset paging: % rows', v_count;
end $$;

-- Every new entry point is service-role only; the obsolete overload stays installed but inaccessible.
do $$
declare sig text;
begin
  foreach sig in array array[
    'case_api.ensure_profile(uuid,text)', 'case_api.bootstrap_workspace(uuid,text,text,boolean,text)',
    'case_api.create_case(uuid,uuid,text,boolean,text)', 'case_api.list_published_versions(uuid,uuid,integer,uuid,boolean,text)',
    'case_api.create_session(uuid,uuid,uuid,uuid,text,interval,boolean,text)', 'case_api.ping()',
    'case_api.heartbeats()', 'case_api.lockdown_alerts_since(timestamp with time zone,integer,uuid)'
  ] loop
    if not has_function_privilege('service_role', sig, 'execute') then raise exception 'service_role cannot execute %', sig; end if;
    if has_function_privilege('anon', sig, 'execute') then raise exception 'anon can execute %', sig; end if;
    if has_function_privilege('authenticated', sig, 'execute') then raise exception 'authenticated can execute %', sig; end if;
  end loop;
  if to_regprocedure('case_api.create_session(uuid,uuid,uuid,text,interval)') is not null then
    raise exception 'obsolete create_session overload still exists (card 35b contract drops it)'; end if;
  raise notice 'ok Phase 1b RPC privileges';
end $$;

-- A future RPC must start closed until its exact service_role grant is made.
-- This probe is created after both migrations, exercising default privileges.
create function case_api._default_privilege_probe()
returns integer language sql set search_path = '' as $$ select 1 $$;
do $$
begin
  if has_function_privilege('anon', 'case_api._default_privilege_probe()', 'execute') then
    raise exception 'future case_api function is executable by anon through PUBLIC default'; end if;
  if has_function_privilege('authenticated', 'case_api._default_privilege_probe()', 'execute') then
    raise exception 'future case_api function is executable by authenticated through PUBLIC default'; end if;
  if has_function_privilege('service_role', 'case_api._default_privilege_probe()', 'execute') then
    raise exception 'future case_api function inherited service_role EXECUTE before explicit grant'; end if;
  raise notice 'ok future RPC starts closed';
end $$;
drop function case_api._default_privilege_probe();
