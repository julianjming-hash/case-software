-- Card 11: a caller sees only bounded, active rooms they created. No names or case data leave SQL.
\set QUIET on

-- [AS-080] Cursor paging is bounded, stable and caller-owned, including a UUIDv4 Auth subject.
do $$
declare
  v_owner uuid := '0199a000-0000-7000-8000-000000000001';
  v_other uuid := '550e8400-e29b-41d4-a716-446655440099';
  v_workspace uuid := '0199a000-0000-7000-8000-00000000000a';
  v_version uuid;
  v_foreign uuid;
  v_ended uuid;
  v_after uuid := null;
  v_seen uuid[] := '{}';
  v_row record;
  v_page integer;
  v_total integer := 0;
  v_expected integer;
  v_invalid boolean := false;
begin
  select id into v_version from case_app.case_versions where case_id =
    '0199a000-0000-7000-8000-0000000000c1' order by version_no limit 1;
  insert into auth.users values (v_other);
  perform case_api.ensure_profile(v_other, 'Other owner');
  -- Card 35 (R-c): rooms list only where the starter is still a member, so the fixture makes them one.
  insert into case_app.workspace_members (workspace_id, user_id, role) values (v_workspace, v_other, 'facilitator')
    on conflict do nothing;
  insert into case_app.sessions (case_version_id, workspace_id, facilitator_id, join_code,
    status, created_at, expires_at)
  select v_version, v_workspace, v_owner, 'K' || lpad(g::text, 5, '0'),
    case when g % 2 = 0 then 'live' else 'lobby' end,
    now() - g * interval '1 second', now() + interval '1 hour'
    from generate_series(1, 105) g;
  insert into case_app.sessions (case_version_id, workspace_id, facilitator_id, join_code,
    status, expires_at) values (v_version, v_workspace, v_other, 'K90001', 'live', now() + interval '1 hour')
    returning id into v_foreign;
  insert into case_app.sessions (case_version_id, workspace_id, facilitator_id, join_code,
    status, expires_at) values (v_version, v_workspace, v_owner, 'K90002', 'ended', now() + interval '1 hour')
    returning id into v_ended;
  insert into case_app.sessions (case_version_id, workspace_id, facilitator_id, join_code,
    status, created_at, expires_at) values (v_version, v_workspace, v_owner, 'K90003', 'live',
      now() - interval '2 hours', now() - interval '1 second');

  select count(*) into v_expected from case_app.sessions
    where facilitator_id = v_owner and status in ('lobby', 'live') and expires_at > now();
  loop
    v_page := 0;
    for v_row in select * from case_api.list_owned_active_sessions(v_owner, 40, v_after) loop
      v_page := v_page + 1;
      if v_page > 40 or v_row.session_id = any(v_seen) then
        raise exception 'owned room paging exceeded limit or repeated a row'; end if;
      if not exists (select 1 from case_app.sessions s where s.id = v_row.session_id
          and s.facilitator_id = v_owner and s.status in ('lobby', 'live') and s.expires_at > now()
          and s.join_code::text = v_row.join_code and s.expires_at = v_row.expires_at) then
        raise exception 'owned room list leaked or altered a session'; end if;
      v_seen := array_append(v_seen, v_row.session_id);
      v_total := v_total + 1;
      v_after := v_row.session_id;
    end loop;
    exit when v_page < 40;
    if v_total > 200 then raise exception 'owned room paging did not terminate'; end if;
  end loop;
  if v_total <> v_expected or
     (select count(*) from case_api.list_owned_active_sessions(v_owner, 10000, null)) > 100 then
    raise exception 'owned room pagination lost rows or exceeded 100'; end if;
  if (select count(*) from case_api.list_owned_active_sessions(v_other, 100, null)) <> 1 then
    raise exception 'UUIDv4 owner did not receive exactly its own room'; end if;
  begin
    perform * from case_api.list_owned_active_sessions(v_owner, 10, v_foreign);
  exception when invalid_parameter_value then v_invalid := true; end;
  if not v_invalid then raise exception 'owned room list accepted foreign cursor'; end if;
  v_invalid := false;
  begin
    perform * from case_api.list_owned_active_sessions(v_owner, 10, v_ended);
  exception when invalid_parameter_value then v_invalid := true; end;
  if not v_invalid then raise exception 'owned room list accepted inactive cursor'; end if;
  raise notice 'ok owned active rooms, paging and cursor ownership: % rows', v_total;
end $$;

-- [AS-080] The new RPC is service-role only and exposes no case_app grant.
do $$
begin
  if not has_function_privilege('service_role',
      'case_api.list_owned_active_sessions(uuid,integer,uuid,boolean,text)', 'execute') then
    raise exception 'service_role cannot execute owned room list'; end if;
  if has_function_privilege('anon',
      'case_api.list_owned_active_sessions(uuid,integer,uuid,boolean,text)', 'execute') or
     has_function_privilege('authenticated',
      'case_api.list_owned_active_sessions(uuid,integer,uuid,boolean,text)', 'execute') then
    raise exception 'public role can execute owned room list'; end if;
  raise notice 'ok owned room RPC privileges';
end $$;
