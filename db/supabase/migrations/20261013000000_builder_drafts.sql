-- CASE Builder card 42: explicit save windows, paired snapshots, receipts and named checkpoints.
-- The old route remains available for schema-1 legacy drafts, but cannot overwrite a paired Builder draft.
begin;

alter table case_app.case_drafts add column authoring_metadata jsonb;
alter table case_app.case_drafts add column builder_managed boolean not null default false;
alter table case_app.case_drafts add constraint case_drafts_metadata_shape check (
  authoring_metadata is null or (jsonb_typeof(authoring_metadata) = 'object' and pg_column_size(authoring_metadata) <= 131072)
);

create table case_app.builder_save_windows (
  operation_id uuid primary key default case_app.uuid_v7(),
  case_id uuid not null references case_app.cases(id) on delete cascade,
  actor_id uuid not null,
  base_revision bigint not null check (base_revision >= 0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz,
  operation_kind text not null default 'save' check (operation_kind in ('save','restore')),
  target_id uuid,
  check (abs(extract(epoch from (expires_at-created_at-interval '24 hours'))) < 1),
  check ((operation_kind = 'save' and target_id is null) or (operation_kind = 'restore' and target_id is not null))
);
create index builder_save_windows_case_actor_idx on case_app.builder_save_windows(case_id, actor_id, expires_at);

create table case_app.builder_save_receipts (
  operation_id uuid primary key,
  case_id uuid not null references case_app.cases(id) on delete cascade,
  actor_id uuid not null,
  base_revision bigint not null check (base_revision >= 0),
  revision bigint not null check (revision >= 0),
  intent_digest case_app.sha256 not null,
  status text not null check (status in ('saved','noop','restored')),
  operation_kind text not null check (operation_kind in ('save','restore')),
  target_id uuid,
  committed_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days'),
  check ((operation_kind = 'save' and status in ('saved','noop') and target_id is null) or
         (operation_kind = 'restore' and status = 'restored' and target_id is not null))
);
create index builder_save_receipts_case_expiry_idx on case_app.builder_save_receipts(case_id, expires_at);

create table case_app.builder_checkpoints (
  id uuid primary key default case_app.uuid_v7(),
  case_id uuid not null references case_app.cases(id) on delete cascade,
  workspace_id uuid not null,
  name text not null check (case_app.group_text_ok(name, 60)),
  revision bigint not null check (revision >= 0),
  schema_version integer not null check (schema_version in (1,2)),
  document jsonb not null check (jsonb_typeof(document) = 'object' and pg_column_size(document) <= 1048576),
  authoring_metadata jsonb check (authoring_metadata is null or (jsonb_typeof(authoring_metadata) = 'object' and pg_column_size(authoring_metadata) <= 131072)),
  intent_digest case_app.sha256 not null,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);
create unique index builder_checkpoints_live_name_idx on case_app.builder_checkpoints(case_id, lower(name)) where deleted_at is null;
create index builder_checkpoints_live_case_idx on case_app.builder_checkpoints(case_id, created_at desc) where deleted_at is null;
revoke all on case_app.builder_save_windows, case_app.builder_save_receipts, case_app.builder_checkpoints from public, anon, authenticated, service_role;

-- Extend the fixed-scalar audit vocabulary while preserving every prior action and target value.
alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check (action in (
  'workspace_create','case_create','draft_save','version_publish','version_withdraw','version_republish','room_start',
  'workspace_ownerless','member_invite','owner_assign','group_create','group_edit','group_archive','case_group',
  'draft_checkpoint_create','draft_checkpoint_delete','draft_checkpoint_restore'));
alter table case_app.workspace_audit drop constraint workspace_audit_target_type_check;
alter table case_app.workspace_audit add constraint workspace_audit_target_type_check
  check (target_type in ('workspace','case','version','room','member','group','checkpoint'));

create function case_app.builder_intent_digest(p_document jsonb, p_metadata jsonb)
returns case_app.sha256 language sql immutable set search_path = '' as $$
  select sha256(convert_to('builder-intent-v1' || E'\n' || jsonb_build_object('document',p_document,'authoring_metadata',p_metadata)::text,'UTF8'))::case_app.sha256;
$$;

create function case_app.builder_metadata_ok(p_metadata jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare x jsonb; k text; n integer;
begin
  if p_metadata is null then return true; end if;
  if jsonb_typeof(p_metadata)<>'object' or pg_column_size(p_metadata)>131072 or p_metadata->>'metadata_version'<>'1' then return false; end if;
  if exists(select 1 from jsonb_object_keys(p_metadata) key where key not in ('metadata_version','preparation_requirements','sources','provenance','lineage')) then return false; end if;
  if p_metadata ? 'preparation_requirements' and jsonb_typeof(p_metadata->'preparation_requirements')<>'string' then return false; end if;
  if p_metadata ? 'sources' then
    if jsonb_typeof(p_metadata->'sources')<>'array' or jsonb_array_length(p_metadata->'sources')>32 then return false; end if;
    for x in select value from jsonb_array_elements(p_metadata->'sources') loop
      if jsonb_typeof(x)<>'object' or (select count(*) from jsonb_object_keys(x))<>5 or
         not (x ?& array['id','title','text','sha256','rights_status']) or
         jsonb_typeof(x->'id')<>'string' or (x->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
         jsonb_typeof(x->'title')<>'string' or jsonb_typeof(x->'text')<>'string' or
         jsonb_typeof(x->'sha256')<>'string' or (x->>'sha256') !~ '^[0-9a-f]{64}$' or
         jsonb_typeof(x->'rights_status')<>'string' or x->>'rights_status' not in ('unknown','permitted','restricted') then return false; end if;
    end loop;
  end if;
  if p_metadata ? 'provenance' then
    if jsonb_typeof(p_metadata->'provenance')<>'array' or jsonb_array_length(p_metadata->'provenance')>2000 then return false; end if;
    for x in select value from jsonb_array_elements(p_metadata->'provenance') loop
      if jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) key where key not in ('entity_id','field','source_id','start_line','end_line','transformation','visibility','review_status')) or
         not (x ?& array['entity_id','field','transformation','visibility','review_status']) or
         jsonb_typeof(x->'entity_id')<>'string' or (x->>'entity_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
         jsonb_typeof(x->'field')<>'string' or length(x->>'field') not between 1 and 200 or (x->>'field') !~ '^[a-z][a-z0-9_.\[\]-]*$' or
         jsonb_typeof(x->'transformation')<>'string' or x->>'transformation' not in ('verbatim','adapted','editorial') or
         jsonb_typeof(x->'visibility')<>'string' or x->>'visibility' not in ('public','private') or
         jsonb_typeof(x->'review_status')<>'string' or x->>'review_status' not in ('unreviewed','confirmed','stale') then return false; end if;
      if x ? 'source_id' and (jsonb_typeof(x->'source_id')<>'string' or (x->>'source_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
      if (x ? 'start_line')<>(x ? 'end_line') then return false; end if;
      if x ? 'start_line' and (jsonb_typeof(x->'start_line')<>'number' or jsonb_typeof(x->'end_line')<>'number' or
          (x->>'start_line')::numeric<1 or trunc((x->>'start_line')::numeric)<>(x->>'start_line')::numeric or
          trunc((x->>'end_line')::numeric)<>(x->>'end_line')::numeric or (x->>'end_line')::numeric<(x->>'start_line')::numeric) then return false; end if;
    end loop;
  end if;
  if p_metadata ? 'lineage' then
    x:=p_metadata->'lineage';
    if jsonb_typeof(x)<>'object' or (select count(*) from jsonb_object_keys(x))<>2 or
       not (x ?& array['source_case_id','source_version_id']) or
       jsonb_typeof(x->'source_case_id')<>'string' or (x->>'source_case_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
       jsonb_typeof(x->'source_version_id')<>'string' or (x->>'source_version_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  end if;
  return true;
end;
$$;

create function case_app.builder_snapshot_ok(p_document jsonb, p_metadata jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_version integer;
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' or pg_column_size(p_document) > 1048576 then return false; end if;
  begin v_version := (p_document->>'schema_version')::integer; exception when others then return false; end;
  if v_version not in (1,2) then return false; end if;
  if not case_app.builder_metadata_ok(p_metadata) then return false; end if;
  return true;
end;
$$;

-- All Builder body and operation admissions serialize on this transaction lock. Pending-state work
-- must use the same lock and count its payload in these totals before it is admitted.
create function case_app.builder_usage_bytes(p_workspace_id uuid default null)
returns bigint language sql volatile set search_path = '' as $$
  select coalesce((select sum(pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0))
    from case_app.case_drafts d join case_app.cases c on c.id=d.case_id
    where p_workspace_id is null or c.workspace_id=p_workspace_id),0)::bigint
  + coalesce((select sum(pg_column_size(k.document)+coalesce(pg_column_size(k.authoring_metadata),0))
    from case_app.builder_checkpoints k join case_app.cases c on c.id=k.case_id
    where k.deleted_at is null and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint
  + coalesce((select count(*)*256 from case_app.builder_save_receipts r join case_app.cases c on c.id=r.case_id
    where r.expires_at>clock_timestamp() and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint
  + coalesce((select count(*)*128 from case_app.builder_save_windows w join case_app.cases c on c.id=w.case_id
    where w.expires_at>clock_timestamp() and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint;
$$;
create function case_app.builder_assert_quota(p_workspace_id uuid,p_delta bigint)
returns void language plpgsql volatile set search_path = '' as $$
declare v_workspace bigint; v_global bigint;
begin
  v_workspace:=case_app.builder_usage_bytes(p_workspace_id)+p_delta;
  v_global:=case_app.builder_usage_bytes(null)+p_delta;
  if v_workspace<0 or v_workspace>104857600 or v_global<0 or v_global>262144000 then
    raise exception 'builder_storage_quota' using errcode='23514'; end if;
end;
$$;

-- Old schema-1 API remains for legacy-only callers. It may never discard metadata from a Builder snapshot.
create or replace function case_api.save_draft(
  p_case_id uuid, p_expected_revision bigint, p_schema_version integer, p_document jsonb, p_user_id uuid,
  p_admin boolean default false, p_admin_email text default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_rev bigint; v_ws uuid := case_app.workspace_of_case(p_case_id); v_role text; v_old_bytes bigint:=0; v_new_bytes bigint;
begin
  v_role := case_app.authorize(p_user_id, v_ws, 'P-14', p_admin, p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases cs where cs.id=p_case_id for update;
  select pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0) into v_old_bytes from case_app.case_drafts d where d.case_id=p_case_id for update;
  if exists (select 1 from case_app.case_drafts where case_id = p_case_id and builder_managed) then
    raise exception 'builder_draft_requires_paired_save' using errcode = '42501';
  end if;
  if p_schema_version <> 1 or p_document->>'schema_version' <> '1' then
    raise exception 'legacy_save_schema_mismatch' using errcode = '22023';
  end if;
  v_new_bytes:=pg_column_size(p_document);
  perform case_app.builder_assert_quota(v_ws,v_new_bytes-coalesce(v_old_bytes,0));
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  if p_expected_revision = 0 then
    insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
    values (p_case_id, 1, p_schema_version, p_document, p_user_id) on conflict (case_id) do nothing returning revision into v_rev;
  else
    update case_app.case_drafts set revision = revision + 1, schema_version = p_schema_version, document = p_document,
      updated_by = p_user_id, updated_at = now()
     where case_id = p_case_id and revision = p_expected_revision and authoring_metadata is null returning revision into v_rev;
  end if;
  if v_rev is null then raise exception 'revision_conflict' using errcode = '40001'; end if;
  update case_app.cases set updated_at = now() where id = p_case_id;
  if v_role = 'admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_save','case',p_case_id,v_rev); end if;
  return v_rev;
end;
$$;

create function case_api.builder_get_draft(p_case_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(revision bigint,schema_version integer,document jsonb,authoring_metadata jsonb,updated_at timestamptz,intent_digest bytea)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id,case_app.workspace_of_case(p_case_id),'P-14',p_admin,p_admin_email);
  return query select d.revision,d.schema_version,d.document,d.authoring_metadata,d.updated_at,
      case_app.builder_intent_digest(d.document,d.authoring_metadata)::bytea
    from case_app.case_drafts d where d.case_id=p_case_id;
  if not found then return query select 0::bigint,null::integer,null::jsonb,null::jsonb,null::timestamptz,null::bytea; end if;
end; $$;

create function case_api.builder_open_save_window(p_case_id uuid,p_base_revision bigint,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(operation_id uuid,base_revision bigint,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_id uuid; v_exp timestamptz; v_created timestamptz;
begin
  perform case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  delete from case_app.builder_save_windows w where w.case_id=p_case_id and w.expires_at<=clock_timestamp();
  delete from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at<=clock_timestamp();
  perform 1 from case_app.case_drafts where case_id=p_case_id for update;
  if p_base_revision<0 or p_base_revision>9007199254740991 then raise exception 'invalid_base_revision' using errcode='22023'; end if;
  if not exists(select 1 from case_app.case_drafts d where d.case_id=p_case_id and d.revision=p_base_revision) then
    if not (p_base_revision=0 and not exists(select 1 from case_app.case_drafts where case_id=p_case_id)) then raise exception 'revision_conflict' using errcode='40001'; end if;
  end if;
  if (select count(*) from case_app.builder_save_windows w where w.case_id=p_case_id and w.actor_id=p_user_id and w.expires_at>clock_timestamp())>=8 or
     (select count(*) from case_app.builder_save_windows w where w.case_id=p_case_id and w.expires_at>clock_timestamp())>=32 or
     (select count(*) from case_app.builder_save_windows w join case_app.cases c on c.id=w.case_id where c.workspace_id=v_ws and w.expires_at>clock_timestamp())>=100000 or
     (select count(*) from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at>clock_timestamp())>=10000 or
     (select count(*) from case_app.builder_save_receipts r join case_app.cases c on c.id=r.case_id where c.workspace_id=v_ws and r.expires_at>clock_timestamp())>=100000 then
    raise exception 'builder_quota' using errcode='23514';
  end if;
  perform case_app.builder_assert_quota(v_ws,128);
  v_created := clock_timestamp();
  insert into case_app.builder_save_windows(case_id,actor_id,base_revision,created_at,expires_at) values(p_case_id,p_user_id,p_base_revision,v_created,v_created+interval '24 hours') returning builder_save_windows.operation_id,builder_save_windows.expires_at into v_id,v_exp;
  return query select v_id,p_base_revision,v_exp;
end; $$;

create function case_api.builder_save_draft(p_case_id uuid,p_operation_id uuid,p_document jsonb,p_authoring_metadata jsonb,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(operation_id uuid,revision bigint,intent_digest bytea,status text)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_role text; w case_app.builder_save_windows%rowtype; old case_app.builder_save_receipts%rowtype; d case_app.case_drafts%rowtype; v_digest bytea; v_rev bigint; v_status text;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  if p_authoring_metadata is null or not case_app.builder_snapshot_ok(p_document,p_authoring_metadata) then raise exception 'invalid_builder_snapshot' using errcode='22023'; end if;
  v_digest:=case_app.builder_intent_digest(p_document,p_authoring_metadata);
  perform pg_advisory_xact_lock(4242,42);
  select * into old from case_app.builder_save_receipts r where r.operation_id=p_operation_id and r.case_id=p_case_id and r.actor_id=p_user_id;
  if found then
    if old.expires_at<=clock_timestamp() then raise exception 'receipt_expired' using errcode='P0002'; end if;
    if old.intent_digest<>v_digest or old.operation_kind<>'save' then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.operation_id,old.revision,old.intent_digest::bytea,old.status; return;
  end if;
  select * into w from case_app.builder_save_windows win where win.operation_id=p_operation_id and win.case_id=p_case_id and win.actor_id=p_user_id for update;
  if not found or w.expires_at<=clock_timestamp() or w.used_at is not null or w.operation_kind<>'save' then raise exception 'save_window_missing_or_expired' using errcode='P0002'; end if;
  if (select count(*) from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at>clock_timestamp())>=10000 or
     (select count(*) from case_app.builder_save_receipts r join case_app.cases c on c.id=r.case_id where c.workspace_id=v_ws and r.expires_at>clock_timestamp())>=100000 then
    raise exception 'builder_receipt_quota' using errcode='23514'; end if;
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into d from case_app.case_drafts where case_id=p_case_id for update;
  if (d.case_id is null and w.base_revision<>0) or (d.case_id is not null and d.revision<>w.base_revision) then raise exception 'revision_conflict' using errcode='40001'; end if;
  if not (d.case_id is not null and d.document=p_document and d.authoring_metadata is not distinct from p_authoring_metadata) then
    perform case_app.builder_assert_quota(v_ws,
      pg_column_size(p_document)+coalesce(pg_column_size(p_authoring_metadata),0)-
      case when d.case_id is null then 0 else pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0) end + 256);
    if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  else
    perform case_app.builder_assert_quota(v_ws,256);
  end if;
  if d.case_id is not null and d.document=p_document and d.authoring_metadata is not distinct from p_authoring_metadata then v_rev:=d.revision; v_status:='noop';
  elsif d.case_id is null then insert into case_app.case_drafts(case_id,revision,schema_version,document,authoring_metadata,updated_by,builder_managed)
       values(p_case_id,1,(p_document->>'schema_version')::integer,p_document,p_authoring_metadata,p_user_id,true) returning case_drafts.revision into v_rev; v_status:='saved';
  else update case_app.case_drafts current_draft set revision=current_draft.revision+1,schema_version=(p_document->>'schema_version')::integer,document=p_document,authoring_metadata=p_authoring_metadata,builder_managed=true,updated_by=p_user_id,updated_at=clock_timestamp()
       where current_draft.case_id=p_case_id returning current_draft.revision into v_rev; v_status:='saved'; end if;
  update case_app.builder_save_windows sw set used_at=clock_timestamp() where sw.operation_id=p_operation_id;
  insert into case_app.builder_save_receipts(operation_id,case_id,actor_id,base_revision,revision,intent_digest,status,operation_kind)
    values(p_operation_id,p_case_id,p_user_id,w.base_revision,v_rev,v_digest,v_status,'save');
  if v_status='saved' then
    update case_app.cases set updated_at=clock_timestamp() where id=p_case_id;
    if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_save','case',p_case_id,v_rev); end if;
  end if;
  return query select p_operation_id,v_rev,v_digest,v_status;
end; $$;

create function case_api.builder_get_save_receipt(p_case_id uuid,p_operation_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(operation_id uuid,base_revision bigint,revision bigint,intent_digest bytea,status text,committed_at timestamptz,expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id,case_app.workspace_of_case(p_case_id),'P-14',p_admin,p_admin_email);
  return query select r.operation_id,r.base_revision,r.revision,r.intent_digest::bytea,r.status,r.committed_at,r.expires_at from case_app.builder_save_receipts r
   where r.case_id=p_case_id and r.operation_id=p_operation_id and r.actor_id=p_user_id and r.expires_at>clock_timestamp();
  if found then return; end if;
  return query select w.operation_id,w.base_revision,null::bigint,null::bytea,
      case when w.expires_at>clock_timestamp() and w.used_at is null then 'issued' else 'expired' end,
      null::timestamptz,w.expires_at
    from case_app.builder_save_windows w where w.case_id=p_case_id and w.operation_id=p_operation_id and w.actor_id=p_user_id;
end; $$;

create function case_api.builder_list_checkpoints(p_case_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(id uuid,name text,revision bigint,schema_version integer,created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id,case_app.workspace_of_case(p_case_id),'P-14',p_admin,p_admin_email);
  return query select c.id,c.name,c.revision,c.schema_version,c.created_at from case_app.builder_checkpoints c where c.case_id=p_case_id and c.deleted_at is null order by c.created_at,c.id;
end; $$;

create function case_api.builder_create_checkpoint(p_case_id uuid,p_name text,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(id uuid,name text,revision bigint,created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; d case_app.case_drafts%rowtype; v_id uuid; v_digest bytea; v_created timestamptz;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  if not case_app.group_text_ok(p_name,60) then raise exception 'invalid_checkpoint_name' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  if (select count(*) from case_app.builder_checkpoints where case_id=p_case_id and deleted_at is null)>=3 then raise exception 'checkpoint_limit' using errcode='23514'; end if;
  select * into d from case_app.case_drafts where case_id=p_case_id;
  if not found then raise exception 'no_draft' using errcode='P0002'; end if;
  perform case_app.builder_assert_quota(v_ws,pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0));
  v_digest:=case_app.builder_intent_digest(d.document,d.authoring_metadata);
  insert into case_app.builder_checkpoints(case_id,workspace_id,name,revision,schema_version,document,authoring_metadata,intent_digest,created_by)
    values(p_case_id,v_ws,p_name,d.revision,d.schema_version,d.document,d.authoring_metadata,v_digest,p_user_id) returning builder_checkpoints.id,builder_checkpoints.created_at into v_id,v_created;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_checkpoint_create','checkpoint',v_id,d.revision); end if;
  return query select v_id,p_name,d.revision,v_created;
end; $$;

create function case_api.builder_delete_checkpoint(p_case_id uuid,p_checkpoint_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(deleted boolean)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; v_rev bigint;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  -- A user-requested checkpoint delete removes its snapshot bytes; the fixed-scalar audit row remains.
  delete from case_app.builder_checkpoints where id=p_checkpoint_id and case_id=p_case_id and deleted_at is null returning revision into v_rev;
  if not found then raise exception 'checkpoint_missing' using errcode='P0002'; end if;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_checkpoint_delete','checkpoint',p_checkpoint_id,v_rev); end if;
  return query select true;
end; $$;

create function case_api.builder_restore_checkpoint(p_case_id uuid,p_checkpoint_id uuid,p_operation_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(operation_id uuid,revision bigint,intent_digest bytea,status text)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; w case_app.builder_save_windows%rowtype; old case_app.builder_save_receipts%rowtype;
  c case_app.builder_checkpoints%rowtype; d case_app.case_drafts%rowtype; v_digest bytea; v_rev bigint;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42);
  -- Lost acknowledgement replay is receipt-only and remains possible after window expiry,
  -- but only for the same actor/case/checkpoint operation, while currently entitled.
  select * into old from case_app.builder_save_receipts r where r.operation_id=p_operation_id and r.case_id=p_case_id and r.actor_id=p_user_id;
  if found then
    if old.expires_at<=clock_timestamp() then raise exception 'receipt_expired' using errcode='P0002'; end if;
    if old.operation_kind<>'restore' or old.target_id<>p_checkpoint_id then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.operation_id,old.revision,old.intent_digest::bytea,old.status; return;
  end if;
  select * into w from case_app.builder_save_windows win where win.operation_id=p_operation_id and win.case_id=p_case_id and win.actor_id=p_user_id for update;
  if not found or w.expires_at<=clock_timestamp() or w.used_at is not null then raise exception 'save_window_missing_or_expired' using errcode='P0002'; end if;
  if (select count(*) from case_app.builder_save_receipts r where r.case_id=p_case_id and r.expires_at>clock_timestamp())>=10000 or
     (select count(*) from case_app.builder_save_receipts r join case_app.cases cs on cs.id=r.case_id where cs.workspace_id=v_ws and r.expires_at>clock_timestamp())>=100000 then
    raise exception 'builder_receipt_quota' using errcode='23514'; end if;
  perform 1 from case_app.cases cs where cs.id=p_case_id for update;
  select * into c from case_app.builder_checkpoints where id=p_checkpoint_id and case_id=p_case_id and deleted_at is null;
  if not found then raise exception 'checkpoint_missing' using errcode='P0002'; end if;
  select * into d from case_app.case_drafts where case_id=p_case_id for update;
  if (d.case_id is null and w.base_revision<>0) or (d.case_id is not null and d.revision<>w.base_revision) then raise exception 'revision_conflict' using errcode='40001'; end if;
  perform case_app.builder_assert_quota(v_ws,
    pg_column_size(c.document)+coalesce(pg_column_size(c.authoring_metadata),0)
    - case when d.case_id is null then 0 else pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0) end
    + 256);
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  if d.case_id is null then
    insert into case_app.case_drafts(case_id,revision,schema_version,document,authoring_metadata,updated_by,builder_managed)
      values(p_case_id,1,c.schema_version,c.document,c.authoring_metadata,p_user_id,true) returning case_drafts.revision into v_rev;
  else
    update case_app.case_drafts current_draft set revision=current_draft.revision+1,schema_version=c.schema_version,document=c.document,
      authoring_metadata=c.authoring_metadata,builder_managed=true,updated_by=p_user_id,updated_at=clock_timestamp() where current_draft.case_id=p_case_id returning current_draft.revision into v_rev;
  end if;
  v_digest:=c.intent_digest;
  update case_app.builder_save_windows sw set used_at=clock_timestamp(),operation_kind='restore',target_id=p_checkpoint_id where sw.operation_id=p_operation_id;
  insert into case_app.builder_save_receipts(operation_id,case_id,actor_id,base_revision,revision,intent_digest,status,operation_kind,target_id)
    values(p_operation_id,p_case_id,p_user_id,w.base_revision,v_rev,v_digest,'restored','restore',p_checkpoint_id);
  update case_app.cases set updated_at=clock_timestamp() where id=p_case_id;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'draft_checkpoint_restore','checkpoint',p_checkpoint_id,v_rev); end if;
  return query select p_operation_id,v_rev,v_digest,'restored'::text;
end; $$;

-- Scheduler-owned bounded retention cleanup; it deletes only expired opaque tickets and receipts.
create function case_api.builder_cleanup_expired_state(p_case_id uuid default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_windows bigint; v_receipts bigint;
begin
  perform pg_advisory_xact_lock(4242,42);
  delete from case_app.builder_save_windows where expires_at<=clock_timestamp() and (p_case_id is null or case_id=p_case_id);
  get diagnostics v_windows=row_count;
  delete from case_app.builder_save_receipts where expires_at<=clock_timestamp() and (p_case_id is null or case_id=p_case_id);
  get diagnostics v_receipts=row_count;
  return v_windows+v_receipts;
end; $$;

-- Grants are the only public surface: exact security-definer RPC signatures to service_role only.
revoke all on function case_api.builder_get_draft(uuid,uuid,boolean,text),case_api.builder_open_save_window(uuid,bigint,uuid,boolean,text),
  case_api.builder_save_draft(uuid,uuid,jsonb,jsonb,uuid,boolean,text),case_api.builder_get_save_receipt(uuid,uuid,uuid,boolean,text),
  case_api.builder_list_checkpoints(uuid,uuid,boolean,text),case_api.builder_create_checkpoint(uuid,text,uuid,boolean,text),
  case_api.builder_delete_checkpoint(uuid,uuid,uuid,boolean,text),case_api.builder_restore_checkpoint(uuid,uuid,uuid,uuid,boolean,text),
  case_api.builder_cleanup_expired_state(uuid),case_app.builder_intent_digest(jsonb,jsonb),case_app.builder_metadata_ok(jsonb),case_app.builder_snapshot_ok(jsonb,jsonb),
  case_app.builder_usage_bytes(uuid),case_app.builder_assert_quota(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function case_api.builder_get_draft(uuid,uuid,boolean,text),case_api.builder_open_save_window(uuid,bigint,uuid,boolean,text),
  case_api.builder_save_draft(uuid,uuid,jsonb,jsonb,uuid,boolean,text),case_api.builder_get_save_receipt(uuid,uuid,uuid,boolean,text),
  case_api.builder_list_checkpoints(uuid,uuid,boolean,text),case_api.builder_create_checkpoint(uuid,text,uuid,boolean,text),
  case_api.builder_delete_checkpoint(uuid,uuid,uuid,boolean,text),case_api.builder_restore_checkpoint(uuid,uuid,uuid,uuid,boolean,text),
  case_api.builder_cleanup_expired_state(uuid) to service_role;
commit;
