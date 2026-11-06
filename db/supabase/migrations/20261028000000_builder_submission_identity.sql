-- Repeated submission of the same saved snapshot reuses its existing review.
-- Alias receipts bind new request IDs without retaining another candidate body.
begin;
create table case_app.builder_submission_receipts (
  case_id uuid not null references case_app.cases(id) on delete cascade,
  submitted_by uuid not null,
  request_id uuid not null,
  candidate_id uuid not null references case_app.builder_candidates(candidate_id) on delete cascade,
  primary key(case_id,submitted_by,request_id),
  check (substring(request_id::text,15,1)='7' and substring(request_id::text,20,1) in ('8','9','a','b'))
);
alter table case_app.builder_submission_receipts enable row level security;
revoke all on case_app.builder_submission_receipts from public,anon,authenticated,service_role;
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
    where w.expires_at>clock_timestamp() and (p_workspace_id is null or c.workspace_id=p_workspace_id)),0)::bigint
  + coalesce((select count(*)*128 from case_app.builder_submission_receipts r join case_app.cases c on c.id=r.case_id
    where p_workspace_id is null or c.workspace_id=p_workspace_id),0)::bigint;
$$;

create or replace function case_api.builder_submit_candidate(
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
  select * into old from case_app.builder_candidates b where b.case_id=p_case_id and ((b.submitted_by=p_user_id and b.request_id=p_request_id) or exists(
    select 1 from case_app.builder_submission_receipts r where r.case_id=p_case_id and r.submitted_by=p_user_id and r.request_id=p_request_id and r.candidate_id=b.candidate_id));
  if found then
    if old.revision<>p_expected_revision or old.intent_digest<>v_intent or old.content_sha256<>v_content then raise exception 'operation_replay_changed' using errcode='23514'; end if;
    return query select old.candidate_id,old.revision,old.intent_digest::bytea,old.content_sha256::bytea,old.status,old.submitted_at; return;
  end if;
  perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or not d.builder_managed or d.revision<>p_expected_revision or d.document is distinct from p_document or
     d.authoring_metadata is distinct from p_authoring_metadata then raise exception 'revision_conflict' using errcode='40001'; end if;
  -- Reusing the exact snapshot must never supersede its approval, including a retry after release.
  select * into old from case_app.builder_candidates b where b.case_id=p_case_id and b.revision=p_expected_revision
    and b.intent_digest=v_intent and b.content_sha256=v_content and b.status in ('pending','approved','released')
    order by b.submitted_at desc limit 1;
  if found then
    if ((select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id)+(select count(*) from case_app.builder_candidates c where c.case_id=p_case_id))>=1000 then
      raise exception 'builder_candidate_history_limit' using errcode='23514';
    end if;
    perform case_app.builder_assert_quota(v_ws,128);
    insert into case_app.builder_submission_receipts(case_id,submitted_by,request_id,candidate_id)
      values(p_case_id,p_user_id,p_request_id,old.candidate_id);
    return query select old.candidate_id,old.revision,old.intent_digest::bytea,old.content_sha256::bytea,old.status,old.submitted_at; return;
  end if;
  if ((select count(*) from case_app.builder_candidates b where b.case_id=p_case_id)+(select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id))>=1000 then raise exception 'builder_candidate_history_limit' using errcode='23514'; end if;
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

create function case_api.builder_publication_readiness(p_case_id uuid,p_expected_revision bigint,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(code text) language plpgsql security definer set search_path='' as $$
declare ws uuid:=case_app.workspace_of_case(p_case_id); d case_app.case_drafts%rowtype; b case_app.builder_candidates%rowtype; delta bigint; release_delta bigint;
begin
  perform case_app.authorize(p_user_id,ws,'P-14',p_admin,p_admin_email);
  select * into d from case_app.case_drafts where case_id=p_case_id;
  if not found or not d.builder_managed or d.revision<>p_expected_revision then return query select 'revision_conflict'::text; return; end if;
  if not case_app.builder_sources_release_ready(d.document,d.authoring_metadata) then return query select 'builder_review_metadata_unresolved'::text; end if;
  select * into b from case_app.builder_candidates c where c.case_id=p_case_id and c.revision=d.revision
    and c.intent_digest=case_app.builder_intent_digest(d.document,d.authoring_metadata) and c.status in ('pending','approved','released') order by c.submitted_at desc limit 1;
  if b.status='released' then return; end if;
  release_delta:=greatest(0,-pg_column_size(d.authoring_metadata)+pg_column_size(case_app.art_structure(d.document)||'{"attempt":0,"summarised":false,"renderer":1}'::jsonb));
  if b.candidate_id is null then
    if ((select count(*) from case_app.builder_candidates c where c.case_id=p_case_id)+(select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id))>=1000 then return query select 'builder_candidate_history_limit'::text; end if;
    if (select count(*) from case_app.builder_candidates c where c.case_id=p_case_id and c.status in ('superseded','cancelled') and c.document is not null)>=3 then return query select 'builder_retained_candidate_limit'::text; end if;
    delta:=pg_column_size(d.document)+pg_column_size(d.authoring_metadata)+512+release_delta;
  else delta:=release_delta; end if;
  if case_app.builder_usage_bytes(ws)+delta>104857600 or case_app.builder_usage_bytes(null)+delta>262144000 then return query select 'builder_storage_quota'::text; end if;
  if exists(select 1 from (
    select jsonb_array_elements_text(s->'asset_ids')::uuid id from jsonb_array_elements(coalesce(d.document->'surfaces','[]')) s
    union select (x->>'asset_id')::uuid from jsonb_array_elements(coalesce(d.document->'blocks','[]')) x where x->>'type'='image'
  ) refs left join case_app.assets a on a.id=refs.id where a.id is null or a.status<>'approved' or a.workspace_id<>ws) then return query select 'asset_not_approved'::text; end if;
end; $$;
revoke all on function case_api.builder_publication_readiness(uuid,bigint,uuid,boolean,text) from public,anon,authenticated;
grant execute on function case_api.builder_publication_readiness(uuid,bigint,uuid,boolean,text) to service_role;

commit;
