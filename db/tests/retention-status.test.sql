-- Card 20: service-only retention evidence is scoped to one archived room.
-- These fixtures roll back; no deployed project or Durable Object is queried.
\set QUIET on
begin;

create temporary table retention_fixture (
  owner_id uuid not null,
  workspace_id uuid not null,
  version_id uuid not null
);
do $$
declare
  v_owner uuid := case_app.uuid_v7();
  v_workspace uuid := case_app.uuid_v7();
  v_case uuid := case_app.uuid_v7();
  v_version uuid := case_app.uuid_v7();
begin
  insert into auth.users (id) values (v_owner);
  insert into case_app.profiles (id, display_name) values (v_owner, 'Retention fixture');
  insert into case_app.workspaces (id, slug, name)
    values (v_workspace, 'retention-status-fixture', 'Retention fixture');
  insert into case_app.cases (id, workspace_id, owner_id, title)
    values (v_case, v_workspace, v_owner, 'Retention fixture');
  insert into case_app.case_versions
    (id, case_id, version_no, schema_version, document, content_sha256, published_by)
    values (v_version, v_case, 1, 1, '{}', sha256('retention fixture'), v_owner);
  insert into retention_fixture values (v_owner, v_workspace, v_version);
end $$;
create function pg_temp.retention_room() returns uuid language plpgsql as $$
declare
  v_id uuid := case_app.uuid_v7();
  v_fixture retention_fixture%rowtype;
begin
  select * into v_fixture from retention_fixture;
  insert into case_app.sessions
    (id, case_version_id, workspace_id, facilitator_id, join_code, status,
     created_at, expires_at)
    values (v_id, v_fixture.version_id, v_fixture.workspace_id,
      v_fixture.owner_id, '000000', 'ended',
      clock_timestamp() - interval '2 days', clock_timestamp() + interval '1 day');
  return v_id;
end $$;
create function pg_temp.retention_end(p_id uuid, p_at timestamptz)
returns void language plpgsql as $$
begin
  update case_app.sessions set status = 'ended', ended_at = p_at,
    personal_data_delete_at = p_at + interval '24 hours'
    where id = p_id;
  insert into case_app.session_events
    (session_id, seq, event_id, epoch, kind, occurred_at)
    values (p_id, 1, case_app.uuid_v7(), 0, 'room_ended',
      p_at - interval '1 millisecond');
end $$;

-- Unknown UUIDs have no row; compensated SQL creation has no DO-end evidence.
do $$
declare
  v_unknown uuid := case_app.uuid_v7();
  v_sql_only uuid := pg_temp.retention_room();
  v_other uuid := pg_temp.retention_room();
  v_row record;
  v_at timestamptz := clock_timestamp() - interval '1 hour';
begin
  if exists (select 1 from case_api.retention_status(v_unknown)) then
    raise exception 'retention status invented an unknown room'; end if;
  perform pg_temp.retention_end(v_other, v_at);
  update case_app.sessions set status = 'ended', ended_at = v_at,
    personal_data_delete_at = v_at + interval '24 hours'
    where id = v_sql_only;
  select * into v_row from case_api.retention_status(v_sql_only);
  if v_row.session_id is distinct from v_sql_only or
     v_row.archived_room_ended_count <> 0 or
     v_row.archived_room_ended_at is not null or
     v_row.archived_event_count <> 0 then
    raise exception 'retention status borrowed another room end or hid SQL-only creation'; end if;
  raise notice 'ok retention unknown and SQL-only rooms have no archived-end proof';
end $$;

-- Even a genuine zero-participant room is corroborated by its own immutable end.
do $$
declare
  v_id uuid := pg_temp.retention_room();
  v_at timestamptz := clock_timestamp() - interval '1 hour';
  v_row record;
begin
  perform pg_temp.retention_end(v_id, v_at);
  select * into v_row from case_api.retention_status(v_id);
  if v_row.session_id is distinct from v_id or v_row.status <> 'ended' or
     v_row.ended_at is distinct from v_at or
     v_row.archived_room_ended_at is distinct from v_at - interval '1 millisecond' or
     v_row.archived_room_ended_count <> 1 or v_row.archived_event_count <> 1 or
     v_row.response_count <> 0 or v_row.participant_count <> 0 or
     v_row.named_participant_count <> 0 or v_row.token_participant_count <> 0 or
     v_row.personal_data_delete_at is distinct from v_at + interval '24 hours' or
     v_row.server_time is null or v_row.server_time < v_at then
    raise exception 'retention status lost same-room empty archive evidence'; end if;
  raise notice 'ok retention same-room immutable end includes legal empty room';
end $$;

-- A purge stamp alone never hides residual names, tokens, or answer rows.
do $$
declare
  v_id uuid := pg_temp.retention_room();
  v_participant uuid := case_app.uuid_v7();
  v_round uuid := case_app.uuid_v7();
  v_at timestamptz := clock_timestamp() - interval '1 hour';
  v_row record;
begin
  perform pg_temp.retention_end(v_id, v_at);
  insert into case_app.session_participants
    (id, session_id, display_name, token_sha256, joined_at)
    values (v_participant, v_id, 'Private fixture', sha256('private fixture'), v_at);
  insert into case_app.session_rounds
    (id, session_id, decision_id, round_no, status, opened_at)
    values (v_round, v_id, case_app.uuid_v7(), 1, 'resolved', v_at);
  insert into case_app.session_responses
    (id, session_id, round_id, participant_id, response, last_client_event_id,
     first_submitted_at, last_submitted_at)
    values (case_app.uuid_v7(), v_id, v_round, v_participant,
      '{"text":"Private fixture"}', case_app.uuid_v7(), v_at, v_at);
  update case_app.sessions set retention_purged_at = clock_timestamp() where id = v_id;
  select * into v_row from case_api.retention_status(v_id);
  if v_row.retention_purged_at is null or v_row.response_count <> 1 or
     v_row.participant_count <> 1 or v_row.named_participant_count <> 1 or
     v_row.token_participant_count <> 1 then
    raise exception 'retention stamp hid residual personal rows'; end if;
  if to_jsonb(v_row) ?| array['join_code','facilitator_id','display_name',
      'token_sha256','response','document','payload','case_version_id'] then
    raise exception 'retention RPC projected a private field'; end if;
  update case_app.session_participants set display_name = null,
    token_sha256 = null where session_id = v_id;
  delete from case_app.session_responses where session_id = v_id;
  select * into v_row from case_api.retention_status(v_id);
  if v_row.response_count <> 0 or v_row.named_participant_count <> 0 or
     v_row.token_participant_count <> 0 or v_row.participant_count <> 1 then
    raise exception 'retention status confused pseudonymous rows with personal rows'; end if;
  raise notice 'ok retention residual personal counts and fixed projection';
end $$;

-- The only executable function privilege is the exact service-role RPC.
do $$
declare
  v_signature text := 'case_api.retention_status(uuid)';
  v_function regprocedure;
begin
  v_function := to_regprocedure(v_signature);
  if v_function is null or
     not has_function_privilege('service_role', v_signature, 'execute') or
     has_function_privilege('anon', v_signature, 'execute') or
     has_function_privilege('authenticated', v_signature, 'execute') then
    raise exception 'retention status RPC was not service-role-only'; end if;
  if not (select prosecdef and proconfig @> array['search_path=""']
      from pg_proc where oid = v_function) then
    raise exception 'retention status RPC lost definer or empty search path'; end if;
  raise notice 'ok retention status exact service-only execution';
end $$;
rollback;
