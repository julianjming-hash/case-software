-- CASE Builder card 46: private review candidates and admin-only release of exact approved candidates.
begin;

create table case_app.builder_candidates (
  candidate_id uuid primary key default case_app.uuid_v7(),
  case_id uuid not null references case_app.cases(id) on delete cascade,
  workspace_id uuid not null,
  submitted_by uuid not null,
  request_id uuid not null,
  revision bigint not null check (revision >= 1),
  schema_version integer not null check (schema_version in (1,2)),
  document jsonb,
  authoring_metadata jsonb,
  intent_digest case_app.sha256 not null,
  content_sha256 case_app.sha256 not null,
  status text not null check (status in ('pending','approved','superseded','cancelled','released')),
  submitted_at timestamptz not null default clock_timestamp(),
  approved_by uuid,
  approved_at timestamptz,
  approved_intent_digest case_app.sha256,
  approved_content_sha256 case_app.sha256,
  ended_at timestamptz,
  released_version_id uuid unique references case_app.case_versions(id) on delete restrict,
  release_digest case_app.sha256,
  released_at timestamptz,
  body_deleted_at timestamptz,
  unique(case_id,submitted_by,request_id),
  check ((document is null) = (authoring_metadata is null)),
  check (document is null or (jsonb_typeof(document)='object' and pg_column_size(document)<=1048576)),
  check (authoring_metadata is null or (jsonb_typeof(authoring_metadata)='object' and pg_column_size(authoring_metadata)<=131072)),
  check (document is null or document->>'schema_version'=schema_version::text),
  check (status not in ('pending','approved') or document is not null),
  check (status<>'released' or document is null),
  check ((approved_by is null and approved_at is null and approved_intent_digest is null and approved_content_sha256 is null) or
         (approved_by is not null and approved_at is not null and approved_intent_digest is not null and approved_content_sha256 is not null)),
  check ((status='released') = (released_version_id is not null and release_digest is not null and released_at is not null))
);
create unique index builder_candidates_one_active_idx on case_app.builder_candidates(case_id) where status in ('pending','approved');
create index builder_candidates_case_history_idx on case_app.builder_candidates(case_id,submitted_at desc,candidate_id);
create index builder_candidates_workspace_idx on case_app.builder_candidates(workspace_id,submitted_at desc);
alter table case_app.builder_candidates enable row level security;
revoke all on case_app.builder_candidates from public,anon,authenticated,service_role;

create function case_app.guard_builder_candidate_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.candidate_id<>old.candidate_id or new.case_id<>old.case_id or new.workspace_id<>old.workspace_id or new.submitted_by<>old.submitted_by or
     new.request_id<>old.request_id or new.revision<>old.revision or new.schema_version<>old.schema_version or
     new.intent_digest<>old.intent_digest or new.content_sha256<>old.content_sha256 or new.submitted_at<>old.submitted_at then
    raise exception 'candidate_identity_immutable' using errcode='42501';
  end if;
  if old.document is null and new.document is not null or (old.document is distinct from new.document and new.document is not null) or
     old.authoring_metadata is null and new.authoring_metadata is not null or (old.authoring_metadata is distinct from new.authoring_metadata and new.authoring_metadata is not null) then
    raise exception 'candidate_body_immutable' using errcode='42501';
  end if;
  if old.approved_by is not null and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at or
     new.approved_intent_digest is distinct from old.approved_intent_digest or new.approved_content_sha256 is distinct from old.approved_content_sha256) then
    raise exception 'candidate_approval_immutable' using errcode='42501';
  end if;
  if old.released_version_id is not null and (new.released_version_id is distinct from old.released_version_id or
     new.release_digest is distinct from old.release_digest or new.released_at is distinct from old.released_at) then
    raise exception 'candidate_release_immutable' using errcode='42501';
  end if;
  if (old.status='pending' and new.status not in ('pending','approved','superseded','cancelled')) or
     (old.status='approved' and new.status not in ('approved','superseded','cancelled','released')) or
     (old.status in ('superseded','cancelled','released') and new.status<>old.status) then
    raise exception 'candidate_transition_invalid' using errcode='42501';
  end if;
  if new.document is null and old.document is not null and new.status not in ('superseded','cancelled','released') then
    raise exception 'candidate_body_delete_invalid' using errcode='42501';
  end if;
  return new;
end; $$;
create trigger builder_candidate_history_guard before update on case_app.builder_candidates
  for each row execute function case_app.guard_builder_candidate_history();

alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check (action in (
  'workspace_create','case_create','draft_save','version_publish','version_withdraw','version_republish','room_start',
  'workspace_ownerless','member_invite','owner_assign','group_create','group_edit','group_archive','case_group',
  'draft_checkpoint_create','draft_checkpoint_delete','draft_checkpoint_restore',
  'builder_candidate_submit','builder_candidate_cancel','builder_candidate_approve','builder_candidate_delete'));
alter table case_app.workspace_audit drop constraint workspace_audit_target_type_check;
alter table case_app.workspace_audit add constraint workspace_audit_target_type_check
  check (target_type in ('workspace','case','version','room','member','group','checkpoint','candidate'));

-- Candidate bodies, immutable versions, and C42 state all consume the same transaction-locked budget.
create or replace function case_app.builder_usage_bytes(p_workspace_id uuid default null)
returns bigint language sql volatile set search_path = '' as $$
  select coalesce((select sum(pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0))
    from case_app.case_drafts d join case_app.cases c on c.id=d.case_id
    where p_workspace_id is null or c.workspace_id=p_workspace_id),0)::bigint
  + coalesce((select sum(pg_column_size(k.document)+coalesce(pg_column_size(k.authoring_metadata),0))
    from case_app.builder_checkpoints k join case_app.cases c on c.id=k.case_id
    where k.deleted_at is null and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint
  + coalesce((select sum(pg_column_size(v.document)) from case_app.case_versions v join case_app.cases c on c.id=v.case_id
    where p_workspace_id is null or c.workspace_id=p_workspace_id),0)::bigint
  + coalesce((select sum(pg_column_size(a.descriptor)) from case_app.case_version_art a join case_app.case_versions v on v.id=a.case_version_id join case_app.cases c on c.id=v.case_id
    where p_workspace_id is null or c.workspace_id=p_workspace_id),0)::bigint
  + coalesce((select sum(coalesce(pg_column_size(b.document),0)+coalesce(pg_column_size(b.authoring_metadata),0))+count(*)*512
    from case_app.builder_candidates b join case_app.cases c on c.id=b.case_id
    where p_workspace_id is null or c.workspace_id=p_workspace_id),0)::bigint
  + coalesce((select count(*)*256 from case_app.builder_save_receipts r join case_app.cases c on c.id=r.case_id
    where r.expires_at>clock_timestamp() and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint
  + coalesce((select count(*)*128 from case_app.builder_save_windows w join case_app.cases c on c.id=w.case_id
    where w.expires_at>clock_timestamp() and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint;
$$;

create function case_app.builder_provenance_paths_ok(p_document jsonb,p_metadata jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_entry jsonb; v_entities jsonb; v_entity_id text; v_entity jsonb; v_target jsonb; v_field text; v_rest text;
  v_match text[]; v_collection text; v_segments text[]; v_segment text; v_index integer;
begin
  if not case_app.builder_metadata_ok(p_metadata) then return false; end if;
  with recursive walk(value) as (
    select p_document
    union all
    select child.value from walk
    cross join lateral (
      select e.value from jsonb_each(case when jsonb_typeof(walk.value)='object' then walk.value else '{}'::jsonb end) e
      union all
      select a.value from jsonb_array_elements(case when jsonb_typeof(walk.value)='array' then walk.value else '[]'::jsonb end) a
    ) child
  )
  select coalesce(jsonb_object_agg(w.value->>'id',w.value) filter (where jsonb_typeof(w.value)='object' and w.value->>'id' is not null),'{}'::jsonb)
    into v_entities from walk w;
  for v_entry in select value from jsonb_array_elements(case when jsonb_typeof(p_metadata->'provenance')='array' then p_metadata->'provenance' else '[]'::jsonb end) loop
    v_entity_id:=v_entry->>'entity_id'; v_entity:=v_entities->v_entity_id;
    if v_entity is null then return false; end if;
    v_target:=v_entity; v_field:=v_entry->>'field'; v_rest:=v_field;
    if v_field !~ '^[a-z][a-z0-9_]*(\[[0-9]+\])*(\.[a-z][a-z0-9_]*(\[[0-9]+\])*)*$' and
       v_field !~ '^[a-z][a-z0-9_]*\[[0-9a-f-]{36}\]\.[a-z][a-z0-9_]*(\[[0-9]+\])*(\.[a-z][a-z0-9_]*(\[[0-9]+\])*)*$' then return false; end if;
    if (v_entry ? 'start_line' or v_entry ? 'end_line') and v_entry->>'source_id' is null then return false; end if;
    v_match:=regexp_match(v_field,'^([a-z][a-z0-9_]*)\[([0-9a-f-]{36})\](?:\.(.*))?$');
    if v_match is not null then
      if v_match[2]<>v_entity_id or jsonb_typeof(p_document->v_match[1])<>'array' or not exists(
        select 1 from jsonb_array_elements(p_document->v_match[1]) item where item->>'id'=v_entity_id) then return false; end if;
      v_rest:=coalesce(v_match[3],'');
    else
      v_collection:=split_part(v_field,'.',1);
      if position('.' in v_field)>0 and jsonb_typeof(p_document->v_collection)='array' and exists(
        select 1 from jsonb_array_elements(p_document->v_collection) item where item->>'id'=v_entity_id) then
        v_rest:=substring(v_field from length(v_collection)+2);
      end if;
    end if;
    if v_rest='' then return false; end if;
    v_segments:=string_to_array(regexp_replace(v_rest,'\[([0-9]+)\]','.'||'\1','g'),'.');
    foreach v_segment in array v_segments loop
      if jsonb_typeof(v_target)='object' then
        if not (v_target ? v_segment) then return false; end if;
        v_target:=v_target->v_segment;
      elsif jsonb_typeof(v_target)='array' then
        if v_segment !~ '^[0-9]+$' or v_segment::numeric>=jsonb_array_length(v_target) then return false; end if;
        v_index:=v_segment::integer; v_target:=v_target->v_index;
      else return false; end if;
    end loop;
  end loop;
  return true;
end; $$;

create function case_app.builder_sources_release_ready(p_document jsonb,p_metadata jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when not case_app.builder_metadata_ok(p_metadata) or not case_app.builder_provenance_paths_ok(p_document,p_metadata) then false else
    not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_metadata->'sources')='array' then p_metadata->'sources' else '[]'::jsonb end) s
      where s->>'rights_status'<>'permitted' or encode(sha256(convert_to(s->>'text','UTF8')),'hex')<>(s->>'sha256')) and
    not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_metadata->'provenance')='array' then p_metadata->'provenance' else '[]'::jsonb end) p
      where p->>'review_status' is distinct from 'confirmed' or
        (p->>'transformation'<>'editorial' and (p->>'source_id' is null or p->>'start_line' is null or p->>'end_line' is null)) or
        (p->>'source_id' is not null and not exists(select 1 from jsonb_array_elements(p_metadata->'sources') s where s->>'id'=p->>'source_id')) or
        (p->>'source_id' is not null and exists(select 1 from jsonb_array_elements(p_metadata->'sources') s where s->>'id'=p->>'source_id'
          and (p->>'end_line')::bigint>regexp_count(s->>'text',E'\r\n|\n|\r')+1))) end;
$$;

create function case_app.builder_supersede_active_candidate(p_case_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  -- Once the retained-body cap is reached, further real draft mutation must stop even if
  -- no candidate is currently active. Otherwise users can keep changing the draft and
  -- strand more retained candidate bodies by cycling submit/mutate.
  if (select count(*) from case_app.builder_candidates b where b.case_id=p_case_id and b.status in ('superseded','cancelled') and b.document is not null)>=3 then
    raise exception 'builder_retained_candidate_limit' using errcode='23514';
  end if;
  if exists(select 1 from case_app.builder_candidates b where b.case_id=p_case_id and b.status in ('pending','approved')) then
    update case_app.builder_candidates as target set status='superseded',ended_at=clock_timestamp()
      where target.case_id=p_case_id and target.status in ('pending','approved');
  end if;
end; $$;

-- Save/restore already hold C42's advisory lock before touching case_drafts. No-op saves do not UPDATE
-- the row; every real revision advance, including restore-to-identical, invalidates active approval.
create function case_app.builder_candidate_draft_changed()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.builder_managed and new.revision<>old.revision then
    perform pg_advisory_xact_lock(4242,42);
    perform case_app.builder_supersede_active_candidate(new.case_id);
  end if;
  return new;
end; $$;
create trigger builder_candidate_draft_changed
  after update of revision,document,authoring_metadata on case_app.case_drafts
  for each row when (new.revision is distinct from old.revision)
  execute function case_app.builder_candidate_draft_changed();

create function case_api.builder_submit_candidate(
  p_case_id uuid,p_request_id uuid,p_expected_revision bigint,p_document jsonb,p_authoring_metadata jsonb,
  p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,revision bigint,intent_digest bytea,content_sha256 bytea,status text,submitted_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; d case_app.case_drafts%rowtype; old case_app.builder_candidates%rowtype;
  v_intent case_app.sha256; v_content case_app.sha256; v_id uuid; v_at timestamptz;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  if p_request_id is null or substring(p_request_id::text,15,1)<>'7' or substring(p_request_id::text,20,1) not in ('8','9','a','b') then
    raise exception 'invalid_request_id' using errcode='22023'; end if;
  if p_expected_revision<1 or p_expected_revision>9007199254740991 or p_document is null or p_authoring_metadata is null or
     not case_app.builder_snapshot_ok(p_document,p_authoring_metadata) then raise exception 'invalid_builder_snapshot' using errcode='22023'; end if;
  v_intent:=case_app.builder_intent_digest(p_document,p_authoring_metadata);
  v_content:=sha256(convert_to(p_document::text,'UTF8'));
  perform pg_advisory_xact_lock(4242,42);
  select * into old from case_app.builder_candidates b where b.case_id=p_case_id and b.submitted_by=p_user_id and b.request_id=p_request_id;
  if found then
    if old.revision<>p_expected_revision or old.intent_digest<>v_intent or old.content_sha256<>v_content then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.candidate_id,old.revision,old.intent_digest::bytea,old.content_sha256::bytea,old.status,old.submitted_at; return;
  end if;
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or not d.builder_managed or d.revision<>p_expected_revision or d.document is distinct from p_document or
     d.authoring_metadata is distinct from p_authoring_metadata then raise exception 'revision_conflict' using errcode='40001'; end if;
  if (select count(*) from case_app.builder_candidates b where b.case_id=p_case_id)>=1000 then raise exception 'builder_candidate_history_limit' using errcode='23514'; end if;
  if not case_app.builder_sources_release_ready(p_document,p_authoring_metadata) then raise exception 'builder_review_metadata_unresolved' using errcode='23514'; end if;
  perform case_app.builder_supersede_active_candidate(p_case_id);
  perform case_app.builder_assert_quota(v_ws,pg_column_size(p_document)+pg_column_size(p_authoring_metadata)+512);
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  insert into case_app.builder_candidates(case_id,workspace_id,submitted_by,request_id,revision,schema_version,document,authoring_metadata,intent_digest,content_sha256,status)
    values(p_case_id,v_ws,p_user_id,p_request_id,p_expected_revision,(p_document->>'schema_version')::integer,p_document,p_authoring_metadata,v_intent,v_content,'pending')
    returning builder_candidates.candidate_id,builder_candidates.submitted_at into v_id,v_at;
  if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_submit','candidate',v_id,p_expected_revision); end if;
  return query select v_id,p_expected_revision,v_intent::bytea,v_content::bytea,'pending'::text,v_at;
end; $$;

create function case_api.builder_list_candidates(p_case_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,revision bigint,status text,submitted_at timestamptz,approved_at timestamptz,released_version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id,case_app.workspace_of_case(p_case_id),'P-14',p_admin,p_admin_email);
  return query select b.candidate_id,b.revision,b.status,b.submitted_at,b.approved_at,b.released_version_id
    from case_app.builder_candidates b where b.case_id=p_case_id order by b.submitted_at desc,b.candidate_id desc;
end; $$;

create function case_api.builder_get_review_candidate(p_case_id uuid,p_candidate_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,revision bigint,schema_version integer,document jsonb,authoring_metadata jsonb,intent_digest bytea,content_sha256 bytea,status text,
  submitted_by uuid,submitted_at timestamptz,approved_by uuid,approved_at timestamptz,approved_intent_digest bytea,approved_content_sha256 bytea,released_version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id,case_app.workspace_of_case(p_case_id),'P-33',p_admin,p_admin_email);
  return query select b.candidate_id,b.revision,b.schema_version,b.document,b.authoring_metadata,b.intent_digest::bytea,b.content_sha256::bytea,b.status,
    b.submitted_by,b.submitted_at,b.approved_by,b.approved_at,b.approved_intent_digest::bytea,b.approved_content_sha256::bytea,b.released_version_id
    from case_app.builder_candidates b where b.case_id=p_case_id and b.candidate_id=p_candidate_id;
end; $$;

create function case_api.builder_cancel_candidate(p_case_id uuid,p_candidate_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,status text,revision bigint)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; b case_app.builder_candidates%rowtype;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  if b.status in ('pending','approved') then
    -- Cancellation is explicit discard of this candidate payload; its identity and prior approval stay.
    update case_app.builder_candidates as target set status='cancelled',document=null,authoring_metadata=null,body_deleted_at=clock_timestamp(),ended_at=clock_timestamp()
      where target.candidate_id=p_candidate_id returning target.* into b;
    if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_cancel','candidate',p_candidate_id,b.revision); end if;
  end if;
  return query select b.candidate_id,b.status,b.revision;
end; $$;

create function case_api.builder_delete_candidate_body(p_case_id uuid,p_candidate_id uuid,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,deleted boolean)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); v_role text; b case_app.builder_candidates%rowtype; v_deleted boolean:=false;
begin
  v_role:=case_app.authorize(p_user_id,v_ws,'P-14',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  if b.status not in ('superseded','cancelled') then raise exception 'candidate_body_not_deletable' using errcode='42501'; end if;
  if b.document is not null then
    update case_app.builder_candidates as target set document=null,authoring_metadata=null,body_deleted_at=clock_timestamp() where target.candidate_id=p_candidate_id;
    v_deleted:=true;
    if v_role='admin' then perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_delete','candidate',p_candidate_id,b.revision); end if;
  end if;
  return query select p_candidate_id,v_deleted;
end; $$;

create function case_api.builder_approve_candidate(p_case_id uuid,p_candidate_id uuid,p_expected_revision bigint,p_intent_digest bytea,p_content_sha256 bytea,
  p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,revision bigint,status text,approved_at timestamptz,intent_digest bytea,content_sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); b case_app.builder_candidates%rowtype; d case_app.case_drafts%rowtype; v_at timestamptz;
begin
  perform case_app.authorize(p_user_id,v_ws,'P-33',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  if b.revision<>p_expected_revision or b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 then raise exception 'candidate_digest_conflict' using errcode='40001'; end if;
  if b.approved_at is not null then
    if b.approved_intent_digest<>b.intent_digest or b.approved_content_sha256<>b.content_sha256 then raise exception 'candidate_approval_corrupt' using errcode='23514'; end if;
    return query select b.candidate_id,b.revision,b.status,b.approved_at,b.intent_digest::bytea,b.content_sha256::bytea; return;
  end if;
  if b.status<>'pending' or b.document is null or not case_app.builder_sources_release_ready(b.document,b.authoring_metadata) then raise exception 'candidate_not_reviewable' using errcode='23514'; end if;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or d.revision<>b.revision or d.document is distinct from b.document or d.authoring_metadata is distinct from b.authoring_metadata then raise exception 'candidate_stale' using errcode='40001'; end if;
  perform case_app.ensure_admin_profile(p_user_id);
  update case_app.builder_candidates as target set status='approved',approved_by=p_user_id,approved_at=clock_timestamp(),
    approved_intent_digest=b.intent_digest,approved_content_sha256=b.content_sha256 where target.candidate_id=p_candidate_id returning target.approved_at into v_at;
  perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'builder_candidate_approve','candidate',p_candidate_id,b.revision);
  return query select p_candidate_id,b.revision,'approved'::text,v_at,b.intent_digest::bytea,b.content_sha256::bytea;
end; $$;

create function case_api.builder_release_candidate(p_case_id uuid,p_candidate_id uuid,p_expected_revision bigint,p_intent_digest bytea,p_content_sha256 bytea,
  p_asset_ids uuid[],p_art jsonb,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,version_id uuid,version_no integer,content_sha256 bytea,intent_digest bytea,status text)
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); b case_app.builder_candidates%rowtype; d case_app.case_drafts%rowtype;
  v_no integer; v_id uuid; v_content case_app.sha256; v_release case_app.sha256; v_bad integer; v_delta bigint;
  v_assets uuid[];
begin
  perform case_app.authorize(p_user_id,v_ws,'P-15',p_admin,p_admin_email);
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  select array_agg(distinct a order by a) into v_assets from unnest(coalesce(p_asset_ids,'{}')) a;
  v_release:=sha256(convert_to('builder-release-v1'||E'\n'||jsonb_build_object('candidate_id',p_candidate_id,'asset_ids',coalesce(to_jsonb(v_assets),'[]'::jsonb),'art',p_art)::text,'UTF8'));
  if b.status='released' then
    if b.released_version_id is null or b.release_digest<>v_release or b.revision<>p_expected_revision or
       b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 then raise exception 'release_replay_changed' using errcode='23514'; end if;
    return query select b.candidate_id,v.id,v.version_no,v.content_sha256::bytea,b.intent_digest::bytea,'released'::text
      from case_app.case_versions v where v.id=b.released_version_id; return;
  end if;
  if b.status<>'approved' or b.document is null or b.revision<>p_expected_revision or b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 or
     b.approved_intent_digest<>b.intent_digest or b.approved_content_sha256<>b.content_sha256 then raise exception 'candidate_not_releasable' using errcode='23514'; end if;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or d.revision<>b.revision or d.document is distinct from b.document or d.authoring_metadata is distinct from b.authoring_metadata then raise exception 'candidate_stale' using errcode='40001'; end if;
  if not case_app.builder_sources_release_ready(b.document,b.authoring_metadata) then raise exception 'builder_review_metadata_unresolved' using errcode='23514'; end if;
  if p_art is null or not case_app.art_shape_ok(p_art) or (p_art-'attempt'-'summarised'-'renderer')<>case_app.art_structure(b.document) then raise exception 'art_mismatch' using errcode='22023'; end if;
  if cardinality(coalesce(p_asset_ids,'{}'))<>cardinality(coalesce(v_assets,'{}')) then raise exception 'duplicate_asset' using errcode='22023'; end if;
  select count(*) into v_bad from unnest(coalesce(v_assets,'{}')) a(id) join case_app.assets s on s.id=a.id where s.workspace_id<>v_ws;
  if v_bad>0 then raise exception 'asset_not_in_workspace: % asset(s)',v_bad using errcode='23514'; end if;
  select count(*) into v_bad from unnest(coalesce(v_assets,'{}')) a(id) left join case_app.assets s on s.id=a.id where s.id is null or s.status<>'approved';
  if v_bad>0 then raise exception 'asset_not_approved: % asset(s)',v_bad using errcode='23514'; end if;
  -- The candidate body moves into case_versions (net document bytes cancel); private metadata is
  -- removed and the immutable version's descriptor is newly retained.
  v_delta:=-coalesce(pg_column_size(b.authoring_metadata),0)+pg_column_size(p_art);
  perform case_app.builder_assert_quota(v_ws,v_delta);
  perform case_app.ensure_admin_profile(p_user_id);
  select coalesce(max(v.version_no),0)+1 into v_no from case_app.case_versions v where v.case_id=p_case_id;
  v_content:=sha256(convert_to(b.document::text,'UTF8'));
  insert into case_app.case_versions(case_id,version_no,schema_version,document,content_sha256,published_by)
    values(p_case_id,v_no,b.schema_version,b.document,v_content,p_user_id) returning id into v_id;
  insert into case_app.case_version_assets(case_version_id,asset_id) select v_id,a.id from unnest(coalesce(v_assets,'{}')) a(id) on conflict do nothing;
  insert into case_app.case_version_art(case_version_id,descriptor,renderer_version) values(v_id,p_art,(p_art->>'renderer')::integer);
  update case_app.builder_candidates as target set status='released',document=null,authoring_metadata=null,body_deleted_at=clock_timestamp(),
    released_version_id=v_id,release_digest=v_release,released_at=clock_timestamp() where target.candidate_id=p_candidate_id;
  update case_app.cases as target set updated_at=clock_timestamp() where target.id=p_case_id;
  perform case_app.audit_admin(v_ws,p_user_id,p_admin_email,'version_publish','version',v_id,v_no::bigint);
  return query select p_candidate_id,v_id,v_no,v_content::bytea,b.intent_digest::bytea,'released'::text;
end; $$;

-- The old first-publication surface cannot bypass approval, even when called with service_role directly.
revoke execute on function case_api.publish_draft_with_art(uuid,bigint,uuid,uuid[],jsonb,boolean,text) from public,anon,authenticated,service_role;

revoke all on function case_api.builder_submit_candidate(uuid,uuid,bigint,jsonb,jsonb,uuid,boolean,text),
  case_api.builder_list_candidates(uuid,uuid,boolean,text),case_api.builder_get_review_candidate(uuid,uuid,uuid,boolean,text),
  case_api.builder_cancel_candidate(uuid,uuid,uuid,boolean,text),case_api.builder_delete_candidate_body(uuid,uuid,uuid,boolean,text),
  case_api.builder_approve_candidate(uuid,uuid,bigint,bytea,bytea,uuid,boolean,text),
  case_api.builder_release_candidate(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,uuid,boolean,text),
  case_app.builder_sources_release_ready(jsonb,jsonb),case_app.builder_provenance_paths_ok(jsonb,jsonb),case_app.builder_supersede_active_candidate(uuid),case_app.builder_candidate_draft_changed()
  ,case_app.guard_builder_candidate_history()
  from public,anon,authenticated,service_role;
grant execute on function case_api.builder_submit_candidate(uuid,uuid,bigint,jsonb,jsonb,uuid,boolean,text),
  case_api.builder_list_candidates(uuid,uuid,boolean,text),case_api.builder_get_review_candidate(uuid,uuid,uuid,boolean,text),
  case_api.builder_cancel_candidate(uuid,uuid,uuid,boolean,text),case_api.builder_delete_candidate_body(uuid,uuid,uuid,boolean,text),
  case_api.builder_approve_candidate(uuid,uuid,bigint,bytea,bytea,uuid,boolean,text),
  case_api.builder_release_candidate(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,uuid,boolean,text) to service_role;

-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)
create or replace function case_app.action_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then array[]::text[]
    when 'P-02' then array[]::text[]
    when 'P-03' then array[]::text[]
    when 'P-04' then array[]::text[]
    when 'P-05' then array[]::text[]
    when 'P-10' then array['owner', 'author', 'facilitator']
    when 'P-11' then array['owner', 'author', 'facilitator']
    when 'P-12' then array['owner', 'author', 'facilitator']
    when 'P-13' then array['owner', 'author']
    when 'P-14' then array['owner', 'author']
    when 'P-15' then array[]::text[]
    when 'P-16' then array['owner']
    when 'P-17' then array['owner']
    when 'P-18' then array['owner']
    when 'P-19' then array['owner']
    when 'P-20' then array['owner']
    when 'P-21' then array['owner', 'author', 'facilitator']
    when 'P-22' then array[]::text[]
    when 'P-32' then array['owner', 'author', 'facilitator']
    when 'P-33' then array[]::text[]
  end;
$$;
create or replace function case_app.action_admin(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then true
    when 'P-02' then true
    when 'P-03' then true
    when 'P-04' then true
    when 'P-05' then true
    when 'P-10' then true
    when 'P-11' then true
    when 'P-12' then true
    when 'P-13' then true
    when 'P-14' then true
    when 'P-15' then true
    when 'P-16' then true
    when 'P-17' then true
    when 'P-18' then true
    when 'P-19' then true
    when 'P-20' then true
    when 'P-21' then true
    when 'P-22' then true
    when 'P-32' then true
    when 'P-33' then true
  end;
$$;
-- END GENERATED permission roles

commit;
