-- db/supabase/migrations/20261001000000_case_init.sql
--
-- Initial schema for the Case Supabase project (separate from iatrogenic; CASE-046).
-- Design record: docs/ARCHITECTURE.md. Conventions: docs/CONVENTIONS.md.
--
-- Shape of the data:
--   case_app  — private tables. RLS on, no policies, and no privileges for anon or
--               authenticated. Nothing reaches a table directly.
--   case_api  — SECURITY DEFINER functions. The ONLY entry point, executable only by
--               service_role, which the Case Worker holds. Expose `case_api` (not
--               `case_app`) in the Supabase API settings.
--
-- Hot path is NOT here. A live room runs inside one SQLite-backed Durable Object
-- (db/durable-object/room-schema.sql) and archives to this database in
-- idempotent batches. Postgres takes zero writes per vote.
--
-- IDs: every row id is a UUIDv7 (time-ordered). case_app.uuid_v7() below is used
-- until the project runs Postgres 18, which has native uuidv7(). Workers and the DO
-- generate the same format via src/shared/ids.mjs.
--
-- Enumerations are text + CHECK, not Postgres ENUM types, so adding a value is a
-- one-line constraint change rather than an ALTER TYPE migration.

begin;

create schema if not exists case_app;
create schema if not exists case_api;

-- ─── identifiers ────────────────────────────────────────────────────────────

create or replace function case_app.uuid_v7()
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  b  bytea  := uuid_send(gen_random_uuid());
begin
  b := overlay(b placing substring(int8send(ms) from 3 for 6) from 1 for 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);   -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);   -- variant 10
  return encode(b, 'hex')::uuid;
end;
$$;

-- Crockford base32, upper case, no I/L/O/U (src/shared/ids.mjs CROCKFORD).
create domain case_app.join_code as text
  check (value ~ '^[0-9A-HJKMNP-TV-Z]{6}$');

create domain case_app.sha256 as bytea
  check (octet_length(value) = 32);

-- ─── people and workspaces ──────────────────────────────────────────────────

create table case_app.workspaces (
  id          uuid primary key default case_app.uuid_v7(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 48),
  name        text not null check (length(name) between 1 and 120),
  created_at  timestamptz not null default now()
);

create table case_app.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text check (length(display_name) <= 80),
  created_at    timestamptz not null default now()
);

create table case_app.workspace_members (
  workspace_id  uuid not null references case_app.workspaces (id) on delete cascade,
  user_id       uuid not null references case_app.profiles (id) on delete cascade,
  role          text not null check (role in ('owner', 'author', 'facilitator')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on case_app.workspace_members (user_id);

-- ─── authoring ──────────────────────────────────────────────────────────────
-- A case is ONE JSON document (beats, decisions, options, paths, surfaces, flags,
-- each carrying its own UUIDv7). It is read and written whole; the Worker validates
-- it with src/shared/case-document.mjs (validateCaseDocument, CASE-065) before any write.

create table case_app.cases (
  id                      uuid primary key default case_app.uuid_v7(),
  workspace_id            uuid not null references case_app.workspaces (id) on delete restrict,
  owner_id                uuid not null references case_app.profiles (id) on delete restrict,
  title                   text not null check (length(title) between 1 and 200),
  visibility              text not null default 'private'
                            check (visibility in ('private', 'organisation', 'public')),
  submission_state        text not null default 'private'
                            check (submission_state in ('private', 'submitted', 'approved', 'rejected', 'withdrawn')),
  forked_from_version_id  uuid,  -- FK added after case_versions exists
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  archived_at             timestamptz
);
create index cases_workspace_recent_idx on case_app.cases (workspace_id, updated_at desc) where archived_at is null;
create index cases_owner_recent_idx on case_app.cases (owner_id, updated_at desc) where archived_at is null;

-- One mutable draft per case. `revision` is the optimistic-concurrency counter every
-- write must name (`expected_revision`), for people and agents alike.
create table case_app.case_drafts (
  case_id         uuid primary key references case_app.cases (id) on delete cascade,
  revision        bigint not null default 0 check (revision >= 0),
  schema_version  integer not null check (schema_version >= 1),
  document        jsonb not null
                    check (jsonb_typeof(document) = 'object' and pg_column_size(document) <= 1048576),
  updated_by      uuid not null references case_app.profiles (id),
  updated_at      timestamptz not null default now()
);

-- Immutable published versions. A live session pins exactly one.
create table case_app.case_versions (
  id              uuid primary key default case_app.uuid_v7(),
  case_id         uuid not null references case_app.cases (id) on delete restrict,
  version_no      integer not null check (version_no >= 1),
  schema_version  integer not null check (schema_version >= 1),
  document        jsonb not null check (jsonb_typeof(document) = 'object'),
  content_sha256  case_app.sha256 not null,
  published_by    uuid not null references case_app.profiles (id),
  published_at    timestamptz not null default now(),
  unique (case_id, version_no)
);

alter table case_app.cases
  add constraint cases_forked_from_fk
  foreign key (forked_from_version_id) references case_app.case_versions (id) on delete set null;

create table case_app.assets (
  id                        uuid primary key default case_app.uuid_v7(),
  workspace_id              uuid not null references case_app.workspaces (id) on delete restrict,
  uploaded_by               uuid not null references case_app.profiles (id),
  kind                      text not null check (kind in ('image', 'video', 'audio', 'document')),
  media_type                text not null check (media_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  byte_size                 bigint not null check (byte_size > 0),
  content_sha256            case_app.sha256 not null,
  r2_key                    text not null unique,  -- assets/<asset_id>/<sha256hex>.<ext>
  status                    text not null default 'quarantined'
                              check (status in ('quarantined', 'approved', 'rejected')),
  rights_basis              text check (rights_basis in
                              ('own_work', 'licensed', 'creative_commons', 'public_domain', 'consented_patient', 'stock')),
  rights_note               text check (length(rights_note) <= 2000),
  deidentified_attested_by  uuid references case_app.profiles (id),
  deidentified_attested_at  timestamptz,
  alt_text                  text check (length(alt_text) <= 1000),
  caption                   text check (length(caption) <= 1000),
  transcript                text,
  created_at                timestamptz not null default now(),
  unique (workspace_id, content_sha256),
  -- An asset can only become revealable once a person has supplied a rights basis,
  -- attested de-identification, and given a text alternative (HANDOFF §Resource safeguards).
  constraint assets_approval_complete check (
    status <> 'approved' or (
      rights_basis is not null
      and deidentified_attested_by is not null
      and deidentified_attested_at is not null
      and coalesce(alt_text, transcript) is not null
    )
  )
);
create index assets_workspace_recent_idx on case_app.assets (workspace_id, created_at desc);

create table case_app.case_version_assets (
  case_version_id  uuid not null references case_app.case_versions (id) on delete cascade,
  asset_id         uuid not null references case_app.assets (id) on delete restrict,
  primary key (case_version_id, asset_id)
);
create index case_version_assets_asset_idx on case_app.case_version_assets (asset_id);

-- AI authoring provenance (in-app gateway only in V1; CASE-045).
create table case_app.sources (
  id               uuid primary key default case_app.uuid_v7(),
  case_id          uuid not null references case_app.cases (id) on delete cascade,
  kind             text not null check (kind in ('url', 'upload', 'local_policy')),
  title            text not null check (length(title) between 1 and 300),
  url              text check (url ~ '^https://'),
  asset_id         uuid references case_app.assets (id),
  policy_review_by date,
  created_by       uuid not null references case_app.profiles (id),
  created_at       timestamptz not null default now()
);
create index sources_case_idx on case_app.sources (case_id);

create table case_app.source_fragments (
  id              uuid primary key default case_app.uuid_v7(),
  source_id       uuid not null references case_app.sources (id) on delete cascade,
  locator         text not null check (length(locator) <= 200),  -- page, section, or timestamp
  excerpt         text not null check (length(excerpt) between 1 and 4000),
  excerpt_sha256  case_app.sha256 not null,
  created_at      timestamptz not null default now()
);
create index source_fragments_source_idx on case_app.source_fragments (source_id);

create table case_app.agent_runs (
  id                   uuid primary key default case_app.uuid_v7(),
  case_id              uuid not null references case_app.cases (id) on delete cascade,
  base_revision        bigint not null,
  task                 text not null check (task in ('propose_changes', 'explain', 'check_readiness')),
  provider             text not null,
  model                text not null,
  region               text,
  template_sha256      case_app.sha256 not null,
  source_fragment_ids  uuid[] not null default '{}',
  status               text not null default 'running'
                         check (status in ('running', 'succeeded', 'failed', 'rejected')),
  error                text,
  requested_by         uuid not null references case_app.profiles (id),
  created_at           timestamptz not null default now(),
  finished_at          timestamptz
);
create index agent_runs_case_recent_idx on case_app.agent_runs (case_id, created_at desc);

create table case_app.agent_proposal_groups (
  id               uuid primary key default case_app.uuid_v7(),
  run_id           uuid not null references case_app.agent_runs (id) on delete cascade,
  ordinal          integer not null,
  intent           text not null check (length(intent) <= 500),
  patch            jsonb not null check (jsonb_typeof(patch) = 'array'),
  depends_on       uuid[] not null default '{}',
  decision         text not null default 'pending' check (decision in ('pending', 'accepted', 'rejected')),
  decided_by       uuid references case_app.profiles (id),
  decided_at       timestamptz,
  applied_revision bigint,
  unique (run_id, ordinal)
);

-- ─── live sessions (archive of the Durable Object) ──────────────────────────

create table case_app.sessions (
  id                    uuid primary key default case_app.uuid_v7(),
  case_version_id       uuid not null references case_app.case_versions (id) on delete restrict,
  workspace_id          uuid not null references case_app.workspaces (id) on delete restrict,
  facilitator_id        uuid not null references case_app.profiles (id),
  join_code             case_app.join_code not null,
  status                text not null default 'lobby' check (status in ('lobby', 'live', 'ended', 'expired')),
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  ended_at              timestamptz,
  expires_at            timestamptz not null,
  final_revision        bigint,
  final_epoch           integer,
  archived_through_seq  bigint not null default 0,
  retention_purged_at   timestamptz,
  check (expires_at > created_at)
);
-- A join code is unique only among rooms that can still be joined; codes recycle.
create unique index sessions_active_join_code_uq on case_app.sessions (join_code) where status in ('lobby', 'live');
create index sessions_facilitator_recent_idx on case_app.sessions (facilitator_id, created_at desc);
create index sessions_sweep_idx on case_app.sessions (expires_at) where status in ('lobby', 'live');
create index sessions_case_version_idx on case_app.sessions (case_version_id);
create index sessions_workspace_idx on case_app.sessions (workspace_id);
create index sessions_purge_idx on case_app.sessions (ended_at) where retention_purged_at is null;

-- id is the pseudonymous participant id that survives the 24 h purge; name and token do not.
create table case_app.session_participants (
  id            uuid primary key,
  session_id    uuid not null references case_app.sessions (id) on delete cascade,
  display_name  text check (length(display_name) <= 40),
  token_sha256  case_app.sha256,
  joined_at     timestamptz not null,
  removed_at    timestamptz,
  purged_at     timestamptz
);
create index session_participants_session_idx on case_app.session_participants (session_id);

create table case_app.session_rounds (
  id                uuid primary key,
  session_id        uuid not null references case_app.sessions (id) on delete cascade,
  decision_id       uuid not null,  -- item id inside the pinned case_versions.document
  round_no          integer not null check (round_no >= 1),
  status            text not null check (status in ('open', 'locked', 'resolved', 'abandoned', 'superseded')),
  opened_at         timestamptz not null,
  locked_at         timestamptz,
  closed_at         timestamptz,
  aggregate         jsonb,          -- counts only; kept after purge
  selected_path_id  uuid,
  resolution_kind   text check (resolution_kind in ('majority', 'minority', 'override')),  -- manual selections never have a round
  unique (session_id, decision_id, round_no)
);

-- Final answer per participant per round. Deleted by the 24 h purge (CASE-043).
create table case_app.session_responses (
  id                    uuid primary key,
  session_id            uuid not null references case_app.sessions (id) on delete cascade,
  round_id              uuid not null references case_app.session_rounds (id) on delete cascade,
  participant_id        uuid not null references case_app.session_participants (id) on delete cascade,
  response              jsonb not null,
  last_client_event_id  uuid not null,
  first_submitted_at    timestamptz not null,
  last_submitted_at     timestamptz not null,
  unique (round_id, participant_id)
);
create index session_responses_session_idx on case_app.session_responses (session_id);
create index session_responses_participant_idx on case_app.session_responses (participant_id);

-- Append-only journal. By contract payloads carry ids, never names or free text.
create table case_app.session_events (
  session_id   uuid not null references case_app.sessions (id) on delete cascade,
  seq          bigint not null check (seq >= 1),
  event_id     uuid not null unique,
  epoch        integer not null check (epoch >= 0),
  kind         text not null check (kind ~ '^[a-z][a-z_]*$'),
  payload      jsonb not null default '{}',
  occurred_at  timestamptz not null,
  primary key (session_id, seq)
);

-- ─── remaining foreign-key indexes (every FK is indexed: ARCHITECTURE §3) ────

create index cases_forked_from_idx on case_app.cases (forked_from_version_id) where forked_from_version_id is not null;
create index case_drafts_updated_by_idx on case_app.case_drafts (updated_by);
create index case_versions_published_by_idx on case_app.case_versions (published_by);
create index assets_uploaded_by_idx on case_app.assets (uploaded_by);
create index assets_attested_by_idx on case_app.assets (deidentified_attested_by) where deidentified_attested_by is not null;
create index sources_asset_idx on case_app.sources (asset_id) where asset_id is not null;
create index sources_created_by_idx on case_app.sources (created_by);
create index agent_runs_requested_by_idx on case_app.agent_runs (requested_by);
create index agent_proposal_groups_decided_by_idx on case_app.agent_proposal_groups (decided_by) where decided_by is not null;

-- ─── operations: job heartbeats (alert when a job's ran_at goes stale) ───────

create table case_app.job_heartbeats (
  job     text primary key,
  ran_at  timestamptz not null,
  rows    integer not null default 0
);

-- ─── immutability ───────────────────────────────────────────────────────────

create or replace function case_app.forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on %.% is not allowed (immutable)', tg_op, tg_table_schema, tg_table_name
    using errcode = '42501';
end;
$$;

create trigger case_versions_immutable
  before update or delete on case_app.case_versions
  for each row execute function case_app.forbid_change();

create trigger session_events_immutable
  before update on case_app.session_events
  for each row execute function case_app.forbid_change();

-- ─── lockdown ───────────────────────────────────────────────────────────────

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'case_app' loop
    execute format('alter table case_app.%I enable row level security', t.tablename);
  end loop;
end;
$$;

revoke all on schema case_app from public;
revoke all on all tables in schema case_app from public;
revoke all on all functions in schema case_app from public;
revoke all on schema case_api from public;
alter default privileges in schema case_app revoke all on tables from public;
alter default privileges in schema case_app revoke all on functions from public;
alter default privileges in schema case_api revoke all on functions from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema case_app, case_api from anon, authenticated';
    execute 'revoke all on all tables in schema case_app from anon, authenticated';
  end if;
end;
$$;

-- ─── authorisation (checked INSIDE every RPC; never trust the caller alone) ──

create or replace function case_app.assert_member(p_user_id uuid, p_workspace_id uuid, p_roles text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (
    select 1 from case_app.workspace_members m
     where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.role = any (p_roles)
  ) then
    raise exception 'not_authorised: user % lacks % in workspace %', p_user_id, p_roles, p_workspace_id
      using errcode = '42501';
  end if;
end;
$$;

create or replace function case_app.workspace_of_case(p_case_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$ select workspace_id from case_app.cases where id = p_case_id; $$;

-- ─── API (service_role only) ────────────────────────────────────────────────
-- Error contract: optimistic-concurrency conflicts raise SQLSTATE 40001 with a
-- message starting 'revision_conflict'; the Worker maps it to HTTP 409.

create or replace function case_api.save_draft(
  p_case_id uuid, p_expected_revision bigint, p_schema_version integer, p_document jsonb, p_user_id uuid
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_rev bigint;
begin
  perform case_app.assert_member(p_user_id, case_app.workspace_of_case(p_case_id), array['owner', 'author']);
  if p_expected_revision = 0 then
    insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
    values (p_case_id, 1, p_schema_version, p_document, p_user_id)
    on conflict (case_id) do nothing
    returning revision into v_rev;
  else
    update case_app.case_drafts
       set revision = revision + 1, schema_version = p_schema_version, document = p_document,
           updated_by = p_user_id, updated_at = now()
     where case_id = p_case_id and revision = p_expected_revision
    returning revision into v_rev;
  end if;
  if v_rev is null then
    raise exception 'revision_conflict: case % is not at revision %', p_case_id, p_expected_revision
      using errcode = '40001';
  end if;
  update case_app.cases set updated_at = now() where id = p_case_id;
  return v_rev;
end;
$$;

create or replace function case_api.get_draft(p_case_id uuid, p_user_id uuid)
returns table (revision bigint, schema_version integer, document jsonb, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform case_app.assert_member(p_user_id, case_app.workspace_of_case(p_case_id), array['owner', 'author']);
  return query select d.revision, d.schema_version, d.document, d.updated_at
    from case_app.case_drafts d where d.case_id = p_case_id;
end;
$$;

-- Freezes the current draft into the next immutable version. Every asset the version
-- reveals must be approved (rights + de-identification + text alternative).
create or replace function case_api.publish_draft(
  p_case_id uuid, p_expected_revision bigint, p_user_id uuid, p_asset_ids uuid[]
) returns table (version_id uuid, version_no integer, content_sha256 bytea)
language plpgsql
security definer
set search_path = ''
as $$
declare
  d case_app.case_drafts%rowtype;
  v_no integer;
  v_id uuid;
  v_hash bytea;
  v_unapproved integer;
begin
  perform case_app.assert_member(p_user_id, case_app.workspace_of_case(p_case_id), array['owner', 'author']);
  select * into d from case_app.case_drafts where case_id = p_case_id for update;
  if not found or d.revision <> p_expected_revision then
    raise exception 'revision_conflict: case % is not at revision %', p_case_id, p_expected_revision
      using errcode = '40001';
  end if;

  select count(*) into v_unapproved
    from unnest(coalesce(p_asset_ids, '{}')) a(id)
    left join case_app.assets s on s.id = a.id
   where s.id is null or s.status <> 'approved';
  if v_unapproved > 0 then
    raise exception 'asset_not_approved: % asset(s) lack approval', v_unapproved using errcode = '23514';
  end if;

  select coalesce(max(v.version_no), 0) + 1 into v_no
    from case_app.case_versions v where v.case_id = p_case_id;
  v_hash := sha256(convert_to(d.document::text, 'UTF8'));

  insert into case_app.case_versions (case_id, version_no, schema_version, document, content_sha256, published_by)
  values (p_case_id, v_no, d.schema_version, d.document, v_hash, p_user_id)
  returning id into v_id;

  insert into case_app.case_version_assets (case_version_id, asset_id)
  select v_id, a.id from unnest(coalesce(p_asset_ids, '{}')) a(id) on conflict do nothing;

  return query select v_id, v_no, v_hash;
end;
$$;

-- `document_text` is the exact jsonb::text that `content_sha256` hashes. The Worker stores THAT
-- text as the R2 pack, so the pack bytes and the recorded hash always agree (red team P2).
create or replace function case_api.get_case_version(p_version_id uuid, p_user_id uuid)
returns table (case_id uuid, version_no integer, schema_version integer, document jsonb, document_text text, content_sha256 bytea)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform case_app.assert_member(p_user_id,
    (select c.workspace_id from case_app.case_versions v join case_app.cases c on c.id = v.case_id where v.id = p_version_id),
    array['owner', 'author', 'facilitator']);
  return query select v.case_id, v.version_no, v.schema_version, v.document, v.document::text, v.content_sha256::bytea
    from case_app.case_versions v where v.id = p_version_id;
end;
$$;

-- The Worker generates the join code (ids.mjs newJoinCode) and retries on 23505.
-- Room lifetime is clamped to (0, 24 h]: an unbounded TTL would hold a join code and its
-- personal data forever (red team P2).
create or replace function case_api.create_session(
  p_case_version_id uuid, p_workspace_id uuid, p_facilitator_id uuid, p_join_code text,
  p_ttl interval default interval '12 hours'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform case_app.assert_member(p_facilitator_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not exists (
    select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_case_version_id and c.workspace_id = p_workspace_id
  ) then
    raise exception 'not_authorised: version % is not in workspace %', p_case_version_id, p_workspace_id using errcode = '42501';
  end if;
  insert into case_app.sessions (case_version_id, workspace_id, facilitator_id, join_code, expires_at)
  values (p_case_version_id, p_workspace_id, p_facilitator_id, p_join_code,
          now() + greatest(interval '1 minute', least(coalesce(p_ttl, interval '12 hours'), interval '24 hours')))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function case_api.resolve_join_code(p_join_code text)
returns table (session_id uuid, status text, case_version_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.status, s.case_version_id
    from case_app.sessions s
   where s.join_code = upper(p_join_code) and s.status in ('lobby', 'live') and s.expires_at > now();
$$;

-- Idempotent archive of one Durable Object batch. Safe to replay: every insert is
-- keyed, events never change, and rounds/responses converge to the DO's latest state.
-- p_batch = { status?, started_at?, participants: [...], rounds: [...], responses: [...], events: [...] }
create or replace function case_api.archive_session_batch(p_session_id uuid, p_batch jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_max bigint;
begin
  perform 1 from case_app.sessions where id = p_session_id for update;
  if not found then
    raise exception 'unknown session %', p_session_id using errcode = '23503';
  end if;

  insert into case_app.session_participants (id, session_id, display_name, token_sha256, joined_at, removed_at)
  select x.id, p_session_id, x.display_name, decode(x.token_sha256, 'hex'), x.joined_at, x.removed_at
    from jsonb_to_recordset(coalesce(p_batch -> 'participants', '[]'))
         as x(id uuid, display_name text, token_sha256 text, joined_at timestamptz, removed_at timestamptz)
    join case_app.sessions s on s.id = p_session_id and s.retention_purged_at is null
  on conflict (id) do update
     set display_name = excluded.display_name, removed_at = excluded.removed_at
   where case_app.session_participants.purged_at is null;

  insert into case_app.session_rounds
         (id, session_id, decision_id, round_no, status, opened_at, locked_at, closed_at,
          aggregate, selected_path_id, resolution_kind)
  select x.id, p_session_id, x.decision_id, x.round_no, x.status, x.opened_at, x.locked_at, x.closed_at,
         x.aggregate, x.selected_path_id, x.resolution_kind
    from jsonb_to_recordset(coalesce(p_batch -> 'rounds', '[]'))
         as x(id uuid, decision_id uuid, round_no integer, status text, opened_at timestamptz,
              locked_at timestamptz, closed_at timestamptz, aggregate jsonb, selected_path_id uuid,
              resolution_kind text)
  on conflict (id) do update
     set status = excluded.status, locked_at = excluded.locked_at, closed_at = excluded.closed_at,
         aggregate = excluded.aggregate, selected_path_id = excluded.selected_path_id,
         resolution_kind = excluded.resolution_kind;

  insert into case_app.session_responses
         (id, session_id, round_id, participant_id, response, last_client_event_id,
          first_submitted_at, last_submitted_at)
  select x.id, p_session_id, x.round_id, x.participant_id, x.response, x.last_client_event_id,
         x.first_submitted_at, x.last_submitted_at
    from jsonb_to_recordset(coalesce(p_batch -> 'responses', '[]'))
         as x(id uuid, round_id uuid, participant_id uuid, response jsonb, last_client_event_id uuid,
              first_submitted_at timestamptz, last_submitted_at timestamptz)
    join case_app.sessions s on s.id = p_session_id and s.retention_purged_at is null
  on conflict (round_id, participant_id) do update
     set response = excluded.response, last_client_event_id = excluded.last_client_event_id,
         last_submitted_at = excluded.last_submitted_at
   where excluded.last_submitted_at >= case_app.session_responses.last_submitted_at;

  insert into case_app.session_events (session_id, seq, event_id, epoch, kind, payload, occurred_at)
  select p_session_id, x.seq, x.event_id, x.epoch, x.kind, coalesce(x.payload, '{}'), x.occurred_at
    from jsonb_to_recordset(coalesce(p_batch -> 'events', '[]'))
         as x(seq bigint, event_id uuid, epoch integer, kind text, payload jsonb, occurred_at timestamptz)
  on conflict do nothing;

  select coalesce(max(seq), 0) into v_max from case_app.session_events where session_id = p_session_id;

  update case_app.sessions
     set archived_through_seq = greatest(archived_through_seq, v_max),
         status     = case when status in ('lobby', 'live')
                           then coalesce(p_batch ->> 'status', status) else status end,
         started_at = coalesce(started_at, (p_batch ->> 'started_at')::timestamptz)
   where id = p_session_id;

  return v_max;
end;
$$;

create or replace function case_api.end_session(p_session_id uuid, p_final_revision bigint, p_final_epoch integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update case_app.sessions
     set status = 'ended', ended_at = coalesce(ended_at, now()),
         final_revision = p_final_revision, final_epoch = p_final_epoch
   where id = p_session_id and status in ('lobby', 'live', 'expired');
$$;

-- Hourly. Expires abandoned rooms, then applies the 24 h participant-data purge
-- (CASE-043): delete per-person answers, null names and token hashes. Aggregates,
-- rounds, pseudonymous participant ids and the journal remain.
create or replace function case_api.purge_expired_participant_data(p_retention interval default interval '24 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  v_batch integer;
begin
  update case_app.sessions
     set status = 'expired', ended_at = expires_at
   where status in ('lobby', 'live') and expires_at <= now();

  -- Bounded batches: a long outage never turns one run into one giant transaction.
  loop
    with due as (
      select id from case_app.sessions
       where retention_purged_at is null and ended_at is not null and ended_at <= now() - p_retention
       limit 200
       for update skip locked
    ), del as (
      delete from case_app.session_responses r using due where r.session_id = due.id
    ), anon as (
      update case_app.session_participants p
         set display_name = null, token_sha256 = null, purged_at = now()
        from due where p.session_id = due.id
    ), done as (
      update case_app.sessions s set retention_purged_at = now() from due where s.id = due.id returning 1
    )
    select count(*) into v_batch from done;
    v_total := v_total + v_batch;
    exit when v_batch < 200;
  end loop;

  insert into case_app.job_heartbeats (job, ran_at, rows) values ('purge_participant_data', now(), v_total)
  on conflict (job) do update set ran_at = excluded.ran_at, rows = excluded.rows;
  return v_total;
end;
$$;

revoke all on all functions in schema case_api from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema case_api to service_role';
    execute 'grant execute on all functions in schema case_api to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema case_api from anon, authenticated';
  end if;
end;
$$;

-- ─── schedule ───────────────────────────────────────────────────────────────
-- pg_cron exists on Supabase; skipped silently on a plain local Postgres.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('case-purge-participant-data', '*/15 * * * *',
                          'select case_api.purge_expired_participant_data()');
  end if;
end;
$$;

commit;
