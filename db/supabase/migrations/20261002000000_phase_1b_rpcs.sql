-- Phase 1b: authoring/bootstrap RPCs, caller-owned session ids, keepalive and
-- an independent privilege-lockdown backstop (CASE-053, CASE-076, CASE-127).
begin;

create or replace function case_api.ensure_profile(p_user_id uuid, p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_display_name is null or
     length(btrim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_profile' using errcode = '23514';
  end if;
  insert into case_app.profiles (id, display_name) values (p_user_id, btrim(p_display_name))
  on conflict (id) do update set display_name = excluded.display_name;
end;
$$;

create or replace function case_api.bootstrap_workspace(p_user_id uuid, p_slug text, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_user_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120 or
     p_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_workspace_name' using errcode = '23514';
  end if;
  -- The unique slug constraint is the arbiter; ON CONFLICT would let an outsider
  -- make an existing workspace appear to be theirs.
  insert into case_app.workspaces (slug, name) values (p_slug, btrim(p_name)) returning id into v_id;
  insert into case_app.workspace_members (workspace_id, user_id, role) values (v_id, p_user_id, 'owner');
  return v_id;
end;
$$;

create or replace function case_api.create_case(p_user_id uuid, p_workspace_id uuid, p_title text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author']);
  if p_title is null or length(btrim(p_title)) not between 1 and 200 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid_case_title' using errcode = '23514';
  end if;
  insert into case_app.cases (workspace_id, owner_id, title)
  values (p_workspace_id, p_user_id, btrim(p_title)) returning id into v_id;
  return v_id;
end;
$$;

create or replace function case_api.list_published_versions(
  p_user_id uuid, p_workspace_id uuid, p_limit integer, p_after uuid
) returns table (
  version_id uuid, case_id uuid, title text, version_no integer,
  published_at timestamptz, content_sha256 bytea
) language plpgsql stable security definer set search_path = '' as $$
declare v_after_at timestamptz;
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if p_after is not null then
    select v.published_at into v_after_at
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_after and c.workspace_id = p_workspace_id;
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select v.id, v.case_id, c.title, v.version_no, v.published_at, v.content_sha256::bytea
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where c.workspace_id = p_workspace_id and c.archived_at is null
       and (p_after is null or (v.published_at, v.id) < (v_after_at, p_after))
     order by v.published_at desc, v.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;

-- The DO owns the room id. The old overload is retained for migration history,
-- but revoked below because it silently minted a different id.
create or replace function case_api.create_session(
  p_session_id uuid, p_case_version_id uuid, p_workspace_id uuid,
  p_facilitator_id uuid, p_join_code text, p_ttl interval default interval '12 hours'
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_session_id is null or p_session_id::text !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'session_id_must_be_uuidv7' using errcode = '23514';
  end if;
  perform case_app.assert_member(p_facilitator_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not exists (
    select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_case_version_id and c.workspace_id = p_workspace_id
  ) then
    raise exception 'not_authorised: version is not in workspace' using errcode = '42501';
  end if;
  insert into case_app.sessions (id, case_version_id, workspace_id, facilitator_id, join_code, expires_at)
  values (p_session_id, p_case_version_id, p_workspace_id, p_facilitator_id, p_join_code,
          now() + greatest(interval '1 minute', least(coalesce(p_ttl, interval '12 hours'), interval '24 hours')));
  return p_session_id;
end;
$$;
comment on function case_api.create_session(uuid,uuid,uuid,text,interval) is
  'Obsolete 2026-10-02: revoked from service_role because it mints an id different from the Durable Object id.';

create or replace function case_api.ping()
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := now();
begin
  insert into case_app.job_heartbeats (job, ran_at, rows) values ('keepalive', v_now, 0)
  on conflict (job) do update set ran_at = excluded.ran_at, rows = 0;
  return v_now;
end;
$$;

create or replace function case_api.heartbeats()
returns table (job text, ran_at timestamptz, rows integer)
language sql stable security definer set search_path = '' as $$
  select h.job, h.ran_at, h.rows from case_app.job_heartbeats h order by h.job;
$$;

create table case_app._lockdown_alerts (
  id uuid primary key default case_app.uuid_v7(),
  at timestamptz not null default now(),
  detail text not null
);
create index lockdown_alerts_page_idx on case_app._lockdown_alerts (at, id);
alter table case_app._lockdown_alerts enable row level security;

create or replace function case_app.enforce_lockdown()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_rel integer; v_fn integer; v_schema integer; v_total integer;
begin
  select count(*) into v_schema
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner))) a
   where n.nspname = 'case_app'
     and a.grantee in (0, (select oid from pg_catalog.pg_roles where rolname = 'anon'),
                          (select oid from pg_catalog.pg_roles where rolname = 'authenticated'));
  select count(*) into v_rel
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,
      pg_catalog.acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
   where n.nspname = 'case_app' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and a.grantee in (0, (select oid from pg_catalog.pg_roles where rolname = 'anon'),
                          (select oid from pg_catalog.pg_roles where rolname = 'authenticated'));
  select count(*) into v_fn
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))) a
   where n.nspname = 'case_app'
     and a.grantee in (0, (select oid from pg_catalog.pg_roles where rolname = 'anon'),
                          (select oid from pg_catalog.pg_roles where rolname = 'authenticated'));
  v_total := v_schema + v_rel + v_fn;
  revoke all on all tables in schema case_app from public, anon, authenticated;
  revoke all on all sequences in schema case_app from public, anon, authenticated;
  revoke all on all functions in schema case_app from public, anon, authenticated;
  revoke all on schema case_app from public, anon, authenticated;
  if v_total > 0 then
    insert into case_app._lockdown_alerts (detail)
    values (format('Reverted %s schema, %s relation and %s function privilege entries in case_app',
                   v_schema, v_rel, v_fn));
  end if;
  return v_total;
end;
$$;

create or replace function case_app.enforce_lockdown_ddl()
returns event_trigger language plpgsql security definer set search_path = '' as $$
begin
  perform case_app.enforce_lockdown();
end;
$$;

create or replace function case_api.lockdown_alerts_since(
  p_since timestamptz, p_limit integer default 100, p_after uuid default null
)
returns table (id uuid, at timestamptz, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare v_after_at timestamptz;
begin
  if p_after is not null then
    select a.at into v_after_at from case_app._lockdown_alerts a where a.id = p_after;
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select a.id, a.at, a.detail from case_app._lockdown_alerts a
     where a.at >= p_since and (p_after is null or (a.at, a.id) > (v_after_at, p_after))
     order by a.at, a.id
     limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;

-- Close implicit PUBLIC EXECUTE, including the obsolete overload, then grant
-- each current RPC by exact signature. Service role never receives case_app grants.
-- PostgreSQL's function EXECUTE default is global for the role creating the
-- function; a schema-scoped REVOKE alone cannot subtract that PUBLIC default.
-- Omit FOR ROLE so this applies to the role executing this migration.
alter default privileges revoke execute on functions from public;
alter default privileges in schema case_api revoke execute on functions from public, anon, authenticated;
revoke all on all functions in schema case_api from public, anon, authenticated, service_role;
grant execute on function
  case_api.save_draft(uuid,bigint,integer,jsonb,uuid),
  case_api.get_draft(uuid,uuid),
  case_api.publish_draft(uuid,bigint,uuid,uuid[]),
  case_api.get_case_version(uuid,uuid),
  case_api.resolve_join_code(text),
  case_api.archive_session_batch(uuid,jsonb),
  case_api.end_session(uuid,bigint,integer),
  case_api.purge_expired_participant_data(interval),
  case_api.ensure_profile(uuid,text),
  case_api.bootstrap_workspace(uuid,text,text),
  case_api.create_case(uuid,uuid,text),
  case_api.list_published_versions(uuid,uuid,integer,uuid),
  case_api.create_session(uuid,uuid,uuid,uuid,text,interval),
  case_api.ping(),
  case_api.heartbeats(),
  case_api.lockdown_alerts_since(timestamptz,integer,uuid)
to service_role;

-- The init migration's private helpers, as well as the new helpers above,
-- inherited PUBLIC EXECUTE. Close the current set before enabling the trigger,
-- so the first hourly sweep does not alert on migration-created functions.
revoke execute on all functions in schema case_app from public, anon, authenticated;

-- Install last so applying this migration never recursively fires the backstop.
create event trigger case_app_lockdown_ddl on ddl_command_end
  when tag in ('GRANT', 'CREATE TABLE', 'CREATE SEQUENCE', 'CREATE FUNCTION')
  execute function case_app.enforce_lockdown_ddl();

-- pg_cron is optional on local Postgres; the function remains testable without it.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule('case-enforce-lockdown', '0 * * * *', 'select case_app.enforce_lockdown()');
  end if;
end;
$$;

commit;
