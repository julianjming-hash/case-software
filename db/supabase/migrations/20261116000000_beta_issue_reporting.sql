-- Beta reports: service-role-only boundary; Worker supplies verified authority, never client identity.
begin;
create table case_app.beta_issues (
 id uuid primary key default case_app.uuid_v7(), reference text not null unique check(reference ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),
 deployment text not null check(deployment in ('local','staging','production')), operation_id uuid,
 principal text, user_id uuid, session_id uuid references case_app.sessions(id) on delete set null,
 incident boolean not null default false, operation_digest text, original jsonb,
 title text not null, summary text, status text not null default 'New', severity text not null default 'unknown',
 priority text not null default 'untriaged', owner_email text, reproducibility text not null default 'unknown',
 verified_build text, duplicate_of uuid references case_app.beta_issues(id),
 revision integer not null default 1, created_at timestamptz not null default clock_timestamp(),
 server_build text, environment text, accepted_at timestamptz, updated_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz, evidence_purged_at timestamptz,
 check(status in ('New','Investigating','Needs information','Planned','Fixed','Closed','Duplicate')),
 check(severity in ('unknown','minor','moderate','major','critical')),
 check(priority in ('untriaged','low','normal','high','urgent')),
 check(reproducibility in ('unknown','not_attempted','reproduced','not_reproduced')),
 check((status='Duplicate')=(duplicate_of is not null)),
 check(char_length(title)<=160 and char_length(summary)<=2000)
);
create unique index beta_issues_operation_idx on case_app.beta_issues(deployment,principal,operation_id);
create index beta_issues_queue_idx on case_app.beta_issues(incident,updated_at desc,id desc) where accepted_at is not null;
create index beta_issues_principal_idx on case_app.beta_issues(principal,created_at desc);
create index beta_issues_session_idx on case_app.beta_issues(session_id) where session_id is not null;
create table case_app.beta_issue_files (
 id uuid not null, issue_id uuid not null references case_app.beta_issues(id) on delete cascade,
 primary key(issue_id,id),
 r2_key text not null unique, sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 bytes integer not null check(bytes between 1 and 5000000), type text not null check(type in ('image/png','image/jpeg')),
 stored boolean not null default false
);
create table case_app.beta_issue_events (
 id uuid primary key default case_app.uuid_v7(), issue_id uuid not null references case_app.beta_issues(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(), action text not null,
 actor_email text, changes jsonb, body text check(char_length(body)<=2000), public boolean not null default false
);
create index beta_issue_events_issue_idx on case_app.beta_issue_events(issue_id,created_at,id);
create table case_app.beta_issue_deletes (r2_key text primary key, deployment text not null default 'local', created_at timestamptz not null default clock_timestamp());
create table case_app.beta_issue_sweep_state(id text primary key check(id in ('local','staging','production')), cursor text);
alter table case_app.beta_issue_sweep_state enable row level security;
revoke all on case_app.beta_issue_sweep_state from public,anon,authenticated;
alter table case_app.beta_issues enable row level security;
alter table case_app.beta_issue_files enable row level security;
alter table case_app.beta_issue_events enable row level security;
alter table case_app.beta_issue_deletes enable row level security;
revoke all on case_app.beta_issues,case_app.beta_issue_files,case_app.beta_issue_events,case_app.beta_issue_deletes from public,anon,authenticated;


-- Parent-session deletion must never unlink participant originals into the ordinary indefinite lifetime.
create function case_app.beta_issue_session_deleted() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into case_app.beta_issue_deletes(r2_key,deployment) select f.r2_key,b.deployment from case_app.beta_issue_files f join case_app.beta_issues b on b.id=f.issue_id where b.session_id=old.id on conflict do nothing;
 delete from case_app.beta_issue_files f using case_app.beta_issues b where f.issue_id=b.id and b.session_id=old.id;
 delete from case_app.beta_issue_events e using case_app.beta_issues b where e.issue_id=b.id and b.session_id=old.id;
 update case_app.beta_issues set original=null,title=coalesce(left(summary,160),'Evidence expired before review'),principal=null,user_id=null,session_id=null,
 operation_digest=null,operation_id=null,owner_email=null,evidence_purged_at=clock_timestamp(),updated_at=clock_timestamp() where session_id=old.id;
 return old;
end;
$$;
revoke all on function case_app.beta_issue_session_deleted() from public,anon,authenticated;
create trigger beta_issue_session_delete before delete on case_app.sessions for each row execute function case_app.beta_issue_session_deleted();


create function case_app.beta_issue_resolution(i case_app.beta_issues) returns timestamptz
language sql stable set search_path='' as $$
 select case when i.status='Duplicate' then (with recursive chain as(
 select b.id,b.duplicate_of,b.resolved_at from case_app.beta_issues b where b.id=i.duplicate_of union
 select b.id,b.duplicate_of,b.resolved_at from case_app.beta_issues b join chain c on b.id=c.duplicate_of)
 select resolved_at from chain where duplicate_of is null limit 1) else i.resolved_at end
$$;
create function case_app.beta_issue_outcome(i case_app.beta_issues) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(v.value||jsonb_build_object('state',case when f.stored then 'stored' else 'missing' end) order by v.ordinality),'[]'::jsonb)
 from jsonb_array_elements(coalesce(i.original->'attachments','[]'::jsonb)) with ordinality v(value,ordinality)
 left join case_app.beta_issue_files f on f.issue_id=i.id and f.id=(v.value->>'id')::uuid
$$;
revoke all on function case_app.beta_issue_resolution(case_app.beta_issues),case_app.beta_issue_outcome(case_app.beta_issues) from public,anon,authenticated;

-- All reads enforce expiry immediately, independently of sweep timing and storage deletion retries.
create function case_app.beta_issue_live(i case_app.beta_issues) returns boolean
language sql stable set search_path='' as $$
 select i.evidence_purged_at is null and coalesce(case_app.beta_issue_resolution(i)+interval '30 days','infinity'::timestamptz)>statement_timestamp()
 and (i.session_id is null or exists(select 1 from case_app.sessions s where s.id=i.session_id and s.retention_purged_at is null
 and least(s.personal_data_delete_at,s.ended_at+interval '24 hours',s.expires_at+interval '24 hours')>statement_timestamp()))
$$;
create function case_app.beta_issue_dto(i case_app.beta_issues, administrative boolean) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',i.id,'reference',i.reference,'status',i.status,'revision',i.revision,
 'title',case when case_app.beta_issue_live(i) then i.title else case when coalesce(case_app.beta_issue_resolution(i)+interval '30 days','infinity'::timestamptz)>statement_timestamp() then coalesce(left(i.summary,160),'Evidence expired before review') else 'Evidence deleted' end end,
 'summary',case when coalesce(case_app.beta_issue_resolution(i)+interval '30 days','infinity'::timestamptz)>statement_timestamp() then i.summary else null end,'attachmentOutcome',case when case_app.beta_issue_live(i) then case_app.beta_issue_outcome(i) else '[]'::jsonb end,'serverBuild',i.server_build,'environment',i.environment,'accepted_at',i.accepted_at,'updated_at',i.updated_at,'incident',i.incident,
 'evidenceDeleted',not case_app.beta_issue_live(i),
 'evidenceExpiresAt',least(case_app.beta_issue_resolution(i)+interval '30 days',(select least(s.personal_data_delete_at,s.ended_at+interval '24 hours',s.expires_at+interval '24 hours') from case_app.sessions s where s.id=i.session_id)),
 'summaryExpiresAt',case_app.beta_issue_resolution(i)+interval '30 days',
 'original',case when case_app.beta_issue_live(i) then i.original else null end,
 'attachments',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'type',f.type,'bytes',f.bytes) order by f.id)
 from case_app.beta_issue_files f where f.issue_id=i.id and f.stored and case_app.beta_issue_live(i)),'[]'::jsonb),
 'followups',coalesce((select jsonb_agg(jsonb_build_object('at',e.created_at,'action',e.action,'body',e.body,'public',e.public,
 'actor',case when administrative then e.actor_email else null end,'changes',case when administrative then e.changes else null end) order by e.created_at,e.id)
 from case_app.beta_issue_events e where e.issue_id=i.id and (administrative or e.public) and case_app.beta_issue_live(i)),'[]'::jsonb))
 ||case when administrative then jsonb_build_object('severity',i.severity,'priority',i.priority,'owner',i.owner_email,
 'reproducibility',i.reproducibility,'verified_build',i.verified_build,'duplicate_of',i.duplicate_of) else '{}'::jsonb end
$$;

-- JSON actor is an internal Worker envelope (not a client payload): admin and incident are recalculated each request.
create function case_api.beta_issue_dispatch(p_actor jsonb,p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a boolean:=coalesce((p_actor->>'admin')::boolean,false); restricted boolean:=coalesce((p_actor->>'incident')::boolean,false);
 deployment text:=coalesce(p_actor->>'deployment','local');
 principal text:=p_actor->>'principal'; uid uuid:=(p_actor->>'userId')::uuid; sid uuid:=(p_actor->>'sessionId')::uuid;
 i case_app.beta_issues; target case_app.beta_issues; f case_app.beta_issue_files; v jsonb; d jsonb; n integer; at timestamptz:=clock_timestamp();
 admin_view boolean:=coalesce((p_input->>'adminView')::boolean,false); incident_view boolean:=coalesce((p_input->>'incidentView')::boolean,false);
 after_id uuid; after_at timestamptz; rows jsonb; filt jsonb; cursor jsonb;
begin
 if deployment not in ('local','staging','production') then return jsonb_build_object('error','forbidden','status',403);end if;
 if (uid is not null and principal is distinct from 'user:'||uid) or (uid is null and principal !~ '^room:[0-9a-f]{64}$') or principal is null or length(principal)>140 or (uid is null and sid is null) then return jsonb_build_object('error','unauthorised','status',401);end if;
 if uid is not null and not coalesce(case_api.admin_account_active(uid),false) then return jsonb_build_object('error','forbidden','status',403);end if;
 if uid is null and not exists(select 1 from case_app.sessions s where s.id=sid and s.retention_purged_at is null and least(s.personal_data_delete_at,s.ended_at+interval '24 hours',s.expires_at+interval '24 hours')>at) then return jsonb_build_object('error','forbidden','status',403);end if;
 if admin_view and (not a or (incident_view and not restricted)) then return jsonb_build_object('error','forbidden','status',403);end if;
 if p_action='reserve' then
  d:=p_input->'draft';
  -- UUIDv7 timestamp is validated independently in SQL; expired operations cannot be recreated after privacy deletion.
  if (d->>'operationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
   to_timestamp(('x'||replace(substr(d->>'operationId',1,13),'-',''))::bit(48)::bigint/1000.0) not between at-interval '24 hours' and at+interval '5 minutes'
   then return jsonb_build_object('error','operation_expired','status',409);end if;
  perform pg_advisory_xact_lock(hashtextextended(deployment||':'||principal,714));
  select * into i from case_app.beta_issues where operation_id=(d->>'operationId')::uuid and beta_issues.principal=principal and beta_issues.deployment=deployment for update;
  if found then
   if i.principal is distinct from principal or i.operation_digest is distinct from p_input->>'digest' then return jsonb_build_object('error','conflict','status',409);end if;
  else
   if jsonb_typeof(d->'attachments') is distinct from 'array' or jsonb_array_length(d->'attachments')>3 or
    length(d->>'description') not between 1 and 2000 or length(d->>'context')>160 then return jsonb_build_object('error','bad_request','status',400);end if;
   select count(*) into n from case_app.beta_issues b where b.deployment=deployment and b.principal=principal and b.created_at>at-interval '1 hour';
   if n>=10 then return jsonb_build_object('error','rate_limited','status',429);end if;
   select count(*) into n from case_app.beta_issues b where b.deployment=deployment and b.principal=principal and b.created_at>at-interval '24 hours';
   if n>=30 then return jsonb_build_object('error','rate_limited','status',429);end if;
   -- Deployment flood bound, checked under a short common transaction lock.
   perform pg_advisory_xact_lock(714,715);
   select count(*) into n from case_app.beta_issues b where b.deployment=deployment and b.created_at>at-interval '1 hour';
   if n>=1000 then return jsonb_build_object('error','rate_limited','status',429);end if;
   insert into case_app.beta_issues(operation_id,deployment,reference,principal,user_id,session_id,incident,operation_digest,original,title)
   values((d->>'operationId')::uuid,deployment,p_input->>'reference',principal,uid,sid,coalesce((d->>'incident')::boolean,false),p_input->>'digest',case when (d->>'contactConsent')::boolean and uid is not null then d||jsonb_build_object('contactEmail',p_actor->>'email') else d end,
   case when coalesce(d->>'context','')<>'' then d->>'context' else left(split_part(d->>'description',E'\n',1),160) end) returning * into i;
   for v in select value from jsonb_array_elements(d->'attachments') loop
    insert into case_app.beta_issue_files(id,issue_id,r2_key,sha256,bytes,type) values((v->>'id')::uuid,i.id,
     'issues/'||i.id||'/'||(v->>'id'),v->>'sha256',(v->>'bytes')::integer,v->>'type');
   end loop;
  end if;
  if not case_app.beta_issue_live(i) then return jsonb_build_object('error','evidence_expired','status',410);end if;
 elsif p_action='list' then
  filt:=jsonb_build_object('query',coalesce(p_input->>'query',''),'status',coalesce(p_input->>'status',''),
   'severity',coalesce(p_input->>'severity',''),'owner',coalesce(p_input->>'owner',''),'build',coalesce(p_input->>'build',''),
   'reproducibility',coalesce(p_input->>'reproducibility',''),'duplicates',coalesce(p_input->>'duplicates',''),
   'adminView',admin_view,'incidentView',incident_view);
  cursor:=p_input->'cursor';
  if cursor is not null and cursor<>'null'::jsonb then
   if cursor->'filters' is distinct from filt then return jsonb_build_object('error','bad_cursor','status',400);end if;
   after_at:=(cursor->>'at')::timestamptz;after_id:=(cursor->>'id')::uuid;
   if not exists(select 1 from case_app.beta_issues b where b.id=after_id and b.deployment=deployment and b.accepted_at is not null and (case when admin_view then b.incident=incident_view else b.principal=principal end)) then return jsonb_build_object('error','bad_cursor','status',400);end if;
  end if;
  select coalesce(jsonb_agg(x.dto order by x.updated_at desc,x.id desc),'[]'::jsonb) into rows from (
   select b.id,b.updated_at,case_app.beta_issue_dto(b,admin_view) - 'original' - 'attachments' - 'followups' dto
   from case_app.beta_issues b where b.deployment=deployment and b.accepted_at is not null
   and (case when admin_view then b.incident=incident_view else b.principal=principal end)
   and (after_at is null or (b.updated_at,b.id)<(after_at,after_id))
   and (coalesce(p_input->>'query','')='' or b.reference ilike '%'||(p_input->>'query')||'%' or
     coalesce(b.summary,case when case_app.beta_issue_live(b) and b.session_id is null then b.title else '' end) ilike '%'||(p_input->>'query')||'%')
   and (coalesce(p_input->>'status','')='' or b.status=p_input->>'status')
   and (coalesce(p_input->>'severity','')='' or b.severity=p_input->>'severity')
   and (coalesce(p_input->>'owner','')='' or b.owner_email=p_input->>'owner')
   and (coalesce(p_input->>'build','')='' or b.verified_build=p_input->>'build')
   and (coalesce(p_input->>'reproducibility','')='' or b.reproducibility=p_input->>'reproducibility')
   and (coalesce(p_input->>'duplicates','')<>'hide' or b.duplicate_of is null)
   order by b.updated_at desc,b.id desc limit 21) x;
  cursor:=null;if jsonb_array_length(rows)>20 then
   cursor:=jsonb_build_object('at',rows->19->>'updated_at','id',rows->19->>'id','filters',filt);rows:=rows-20;
  end if;
  return jsonb_build_object('rows',rows,'cursor',cursor,'asOf',at,'canIncidents',a and restricted);
 else
  if p_action='triage' then perform pg_advisory_xact_lock(714,716);end if;
  if p_action='receipt' then
   select * into i from case_app.beta_issues where operation_id=(p_input->>'id')::uuid and beta_issues.deployment=deployment and beta_issues.principal=principal for update;
  else
   select * into i from case_app.beta_issues where id=(p_input->>'id')::uuid and beta_issues.deployment=deployment for update;
  end if;
  if not found or (admin_view and (i.accepted_at is null or i.incident<>incident_view)) or
   (not admin_view and i.principal is distinct from principal) then return jsonb_build_object('error','not_found','status',404);end if;
 end if;
 if p_action in ('reserve','receipt','accept') then
  if i.principal is distinct from principal then return jsonb_build_object('error','not_found','status',404);end if;
  if i.operation_digest is distinct from p_input->>'digest' then return jsonb_build_object('error','conflict','status',409);end if;
  if not case_app.beta_issue_live(i) then return jsonb_build_object('error','evidence_expired','status',410);end if;
  if p_action='accept' and i.accepted_at is null then
   if not case_app.beta_issue_live(i) or i.created_at<at-interval '24 hours' then return jsonb_build_object('error','evidence_expired','status',410);end if;
   insert into case_app.beta_issue_deletes(r2_key,deployment) select r2_key,i.deployment from case_app.beta_issue_files where issue_id=i.id and not stored on conflict do nothing;
   delete from case_app.beta_issue_files where issue_id=i.id and not stored;
   update case_app.beta_issues set accepted_at=at,updated_at=at,server_build=p_input->>'serverBuild',environment=p_input->>'environment' where id=i.id returning * into i;
   insert into case_app.beta_issue_events(issue_id,action,public) values(i.id,'Submitted',true);
  end if;
  return jsonb_build_object('state',case when i.accepted_at is null then 'pending' else 'accepted' end,
   'operationId',i.operation_id,'digest',i.operation_digest,'id',i.id,'reference',i.reference,'acceptedAt',i.accepted_at,'attachmentOutcome',case_app.beta_issue_outcome(i));
 elsif p_action in ('upload','stored','file') then
  if not case_app.beta_issue_live(i) then return jsonb_build_object('error','not_found','status',404);end if;
  if p_action<>'file' and (admin_view or i.accepted_at is not null or i.created_at<at-interval '24 hours') then return jsonb_build_object('error','conflict','status',409);end if;
  select * into f from case_app.beta_issue_files where id=(p_input->>'fileId')::uuid and issue_id=i.id;
  if not found or (p_action='file' and not f.stored) then return jsonb_build_object('error','not_found','status',404);end if;
  if p_action='stored' then update case_app.beta_issue_files set stored=true where issue_id=i.id and id=f.id;end if;
  return jsonb_build_object('key',f.r2_key,'sha256',f.sha256,'bytes',f.bytes,'type',f.type);
 elsif p_action='read' then
  if i.accepted_at is null then return jsonb_build_object('error','not_found','status',404);end if;
  return case_app.beta_issue_dto(i,admin_view);
 elsif p_action='triage' then
  if not admin_view or not a then return jsonb_build_object('error','forbidden','status',403);end if;
  if i.revision<>(p_input->>'expectedRevision')::integer then return jsonb_build_object('error','conflict','status',409);end if;
  -- Retire overdue duplicate descendants before changing the canonical resolution or classification.
  -- Otherwise a reopen could make a not-yet-swept child's original visible again.
  if case_app.beta_issue_resolution(i)+interval '30 days'<=at then
   for target in with recursive related as(select i.id id union select b.id from case_app.beta_issues b join related x on b.duplicate_of=x.id where b.deployment=deployment and b.incident=i.incident)
    select b.* from case_app.beta_issues b join related x on x.id=b.id order by b.created_at,b.id for update of b loop
    insert into case_app.beta_issue_deletes(r2_key,deployment) select r2_key,target.deployment from case_app.beta_issue_files where issue_id=target.id on conflict do nothing;
    delete from case_app.beta_issue_files where issue_id=target.id;delete from case_app.beta_issue_events where issue_id=target.id;
    update case_app.beta_issues set original=null,summary=null,title='Evidence deleted',principal=null,user_id=null,session_id=null,
     operation_digest=null,operation_id=null,owner_email=null,evidence_purged_at=coalesce(evidence_purged_at,at),updated_at=at where id=target.id;
   end loop;
   select * into i from case_app.beta_issues where beta_issues.id=i.id;
  end if;
  if not case_app.beta_issue_live(i) then
   insert into case_app.beta_issue_deletes(r2_key,deployment) select r2_key,i.deployment from case_app.beta_issue_files where issue_id=i.id on conflict do nothing;
   delete from case_app.beta_issue_files where issue_id=i.id;delete from case_app.beta_issue_events where issue_id=i.id;
   update case_app.beta_issues set original=null,principal=null,user_id=null,session_id=null,operation_digest=null,operation_id=null,owner_email=null,
    summary=case when coalesce(case_app.beta_issue_resolution(i)+interval '30 days','infinity'::timestamptz)>at then summary else null end,
    title='Evidence expired before review',evidence_purged_at=coalesce(evidence_purged_at,at) where id=i.id returning * into i;
  end if;
  d:=p_input->'change';
  if d ? 'summary' and coalesce((d->>'reviewedNonpersonal')::boolean,false) is not true then return jsonb_build_object('error','review_required','status',400);end if;
  if d ? 'owner' and coalesce(d->>'owner','')<>'' and (not (p_input->'eligibleOwners' ? (d->>'owner')) or not exists(select 1 from auth.users u where u.email=d->>'owner' and coalesce(case_api.admin_account_active(u.id),false))) then return jsonb_build_object('error','bad_owner','status',400);end if;
  if d->>'status'='Fixed' and (coalesce(d->>'verified_build',i.verified_build,'')='' or (coalesce(d->>'note','')='' and not(coalesce(d->>'summary','')<>'' and coalesce((d->>'reviewedNonpersonal')::boolean,false)))) then return jsonb_build_object('error','verification_required','status',400);end if;
  -- Serialize duplicate graph changes, then reject cross-class links and all cycles.
  perform pg_advisory_xact_lock(714,716);
  if coalesce(d->>'status',i.status)='Duplicate' then
   select * into target from case_app.beta_issues where id=case when d ? 'duplicate_of' then nullif(d->>'duplicate_of','')::uuid else i.duplicate_of end and beta_issues.deployment=deployment and accepted_at is not null and incident=i.incident;
   if not found or target.id=i.id then return jsonb_build_object('error','bad_duplicate','status',400);end if;
   if exists(with recursive links as(select id,duplicate_of from case_app.beta_issues where id=target.id union
    select b.id,b.duplicate_of from case_app.beta_issues b join links l on b.id=l.duplicate_of) select 1 from links where id=i.id)
    then return jsonb_build_object('error','bad_duplicate','status',400);end if;
  elsif coalesce(d->>'duplicate_of','')<>'' then return jsonb_build_object('error','bad_duplicate','status',400);end if;
  if not case_app.beta_issue_live(i) and (coalesce(d->>'note','')<>'' or coalesce(d->>'publicReply','')<>'') then return jsonb_build_object('error','evidence_expired','status',410);end if;
  if coalesce((d->>'restrict')::boolean,false) then
   update case_app.beta_issues set duplicate_of=null,status='Investigating',resolved_at=null,revision=revision+1,updated_at=at where duplicate_of=i.id;
   update case_app.beta_issues set incident=true,duplicate_of=null,status=case when status='Duplicate' then 'Investigating' else status end,resolved_at=case when status='Duplicate' then null else resolved_at end,revision=revision+1,updated_at=at where id=i.id;
   return jsonb_build_object('restricted',true);
  end if;
  update case_app.beta_issues set status=coalesce(d->>'status',status),severity=coalesce(d->>'severity',severity),priority=coalesce(d->>'priority',priority),
   owner_email=case when d ? 'owner' then nullif(d->>'owner','') else owner_email end,
   reproducibility=coalesce(d->>'reproducibility',reproducibility),verified_build=coalesce(d->>'verified_build',verified_build),
   summary=case when d ? 'summary' then nullif(d->>'summary','') else summary end,
   duplicate_of=case when coalesce(d->>'status',status)='Duplicate' then target.id else null end,
   resolved_at=case when coalesce(d->>'status',status)='Duplicate' then case_app.beta_issue_resolution(target)
    when coalesce(d->>'status',status) in ('Fixed','Closed') then coalesce(resolved_at,at) else null end,
   revision=revision+1,updated_at=at where id=i.id returning * into i;
  insert into case_app.beta_issue_events(issue_id,action,actor_email,changes,body,public) values(i.id,'Triage',p_actor->>'email',d-'note'-'publicReply'-'summary',nullif(d->>'note',''),false);
  if coalesce(d->>'publicReply','')<>'' then insert into case_app.beta_issue_events(issue_id,action,actor_email,body,public) values(i.id,'Reply',p_actor->>'email',d->>'publicReply',true);end if;
  return case_app.beta_issue_dto(i,true);
 end if;
 return jsonb_build_object('error','bad_request','status',400);
end;
$$;

create function case_api.beta_issue_sweep(p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare i case_app.beta_issues; n integer:=0; deployment text:=coalesce(p_input->>'deployment','local');
begin
 if p_action='purge' then
  -- Participant cutoff always wins, including originals copied into title/events/operation metadata.
  for i in select b.* from case_app.beta_issues b where b.evidence_purged_at is null and
   (not case_app.beta_issue_live(b) or (b.accepted_at is null and b.created_at<clock_timestamp()-interval '25 hours'))
   order by b.created_at,b.id limit 2000 for update skip locked loop
   insert into case_app.beta_issue_deletes(r2_key,deployment) select r2_key,i.deployment from case_app.beta_issue_files where issue_id=i.id on conflict do nothing;
   delete from case_app.beta_issue_files where issue_id=i.id;
   delete from case_app.beta_issue_events where issue_id=i.id;
   update case_app.beta_issues set original=null,title=coalesce(left(summary,160),'Evidence expired before review'),principal=null,user_id=null,session_id=null,
    operation_digest=null,operation_id=null,owner_email=null,evidence_purged_at=clock_timestamp(),updated_at=clock_timestamp() where id=i.id;
   n:=n+1;
  end loop;
  with due as(select b.id from case_app.beta_issues b where b.summary is not null and case_app.beta_issue_resolution(b)+interval '30 days'<=clock_timestamp() order by b.id limit 2000 for update skip locked)
  update case_app.beta_issues b set summary=null,title='Evidence deleted',owner_email=null from due where b.id=due.id;
  -- Canonical resolution is derived recursively at read/purge time; no stale copied deadline can revive a duplicate.
  return to_jsonb(n);
 elsif p_action='cursor' then return coalesce((select to_jsonb(cursor) from case_app.beta_issue_sweep_state where id=deployment),'null'::jsonb);
 elsif p_action='advance' then insert into case_app.beta_issue_sweep_state(id,cursor) values(deployment,p_input->>'cursor') on conflict(id) do update set cursor=excluded.cursor;return 'true'::jsonb;
 elsif p_action='deletes' then return coalesce((select jsonb_agg(r2_key) from(select r2_key from case_app.beta_issue_deletes where beta_issue_deletes.deployment=deployment order by created_at,r2_key limit 1000)x),'[]'::jsonb);
 elsif p_action='deleted' then delete from case_app.beta_issue_deletes where r2_key in(select jsonb_array_elements_text(p_input->'keys')) and beta_issue_deletes.deployment=deployment;return 'true'::jsonb;
 elsif p_action='known' then return to_jsonb(exists(select 1 from case_app.beta_issue_files f join case_app.beta_issues b on b.id=f.issue_id where f.r2_key=p_input->>'key' and b.deployment=deployment and case_app.beta_issue_live(b)));
 end if;return 'null'::jsonb;
end;
$$;
-- Preserve the existing feedback fold/identity purge; extend its one authoritative entry point.
create or replace function case_api.purge_expired_participant_data(p_retention interval default interval '24 hours')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_total integer:=0; v_batch integer;
begin
 if p_retention is null or p_retention<interval '0 seconds' then raise exception 'invalid_retention' using errcode='23514'; end if;
 loop
   with due as (select id from case_app.sessions where status in ('lobby','live') and expires_at<=clock_timestamp()
     order by expires_at,id limit 200 for update skip locked), done as (
    update case_app.sessions s set status='expired',ended_at=coalesce(ended_at,expires_at),
      personal_data_delete_at=least(personal_data_delete_at,ended_at+interval '24 hours',expires_at+interval '24 hours')
      from due where s.id=due.id returning 1)
   select count(*) into v_batch from done;
   exit when v_batch<200;
 end loop;
 loop
  with due as (
   select id from case_app.sessions where retention_purged_at is null
    and least(personal_data_delete_at,ended_at+least(p_retention,interval '24 hours'),expires_at+interval '24 hours')<=clock_timestamp()
    order by least(personal_data_delete_at,ended_at+least(p_retention,interval '24 hours'),expires_at+interval '24 hours'),id
    limit 200 for update skip locked
  ), del as (delete from case_app.session_responses r using due where r.session_id=due.id),
  anon as (update case_app.session_participants p set display_name=null,token_sha256=null,purged_at=coalesce(purged_at,clock_timestamp()) from due where p.session_id=due.id),
  done as (update case_app.sessions s set retention_purged_at=clock_timestamp() from due where s.id=due.id returning 1)
  select count(*) into v_batch from done;
  v_total:=v_total+v_batch;
  exit when v_batch<200;
 end loop;
 loop
  with due as (
   select id from case_app.sessions where feedback_closed_at is null
    and least(personal_data_delete_at,ended_at+least(p_retention,interval '24 hours'),expires_at+interval '24 hours')<=clock_timestamp()
    order by id limit 200 for update skip locked
  ), fb as (select f.* from case_app.session_feedback f join due on due.id=f.session_id),
  tal as (insert into case_app.session_feedback_tallies(session_id,question,value,n)
   select fb.session_id,x.q,x.v,count(*) from fb cross join lateral (values ('session',fb.rating_session),('case',fb.rating_case),('app',fb.rating_app)) x(q,v)
    where x.v is not null group by fb.session_id,x.q,x.v),
  tot as (insert into case_app.session_feedback_totals(session_id,joined,qr)
   select session_id,count(*) filter (where source='joined'),count(*) filter (where source='qr') from fb group by session_id),
  com as (insert into case_app.session_feedback_comments(session_id,kind,about,body)
   select u.session_id,u.kind,u.about,u.body from (
    select session_id,'takeaway' kind,'session' about,takeaway body from fb where takeaway is not null
    union all select session_id,'improve',improve_about,improve from fb where improve is not null
    union all select session_id,'comment','session',comment_session from fb where comment_session is not null
    union all select session_id,'comment','case',comment_case from fb where comment_case is not null
    union all select session_id,'comment','app',comment_app from fb where comment_app is not null) u order by random()),
  del as (delete from case_app.session_feedback f using due where f.session_id=due.id),
  done as (update case_app.sessions s set feedback_closed_at=clock_timestamp() from due where s.id=due.id returning 1)
  select count(*) into v_batch from done;
  exit when v_batch<200;
 end loop;
 insert into case_app.job_heartbeats(job,ran_at,rows) values('purge_participant_data',clock_timestamp(),v_total)
 on conflict(job) do update set ran_at=excluded.ran_at,rows=excluded.rows;
 perform case_api.beta_issue_sweep('purge','{}'::jsonb);
 return v_total;
end;
$$;

revoke all on function case_api.beta_issue_dispatch(jsonb,text,jsonb),case_api.beta_issue_sweep(text,jsonb),case_app.beta_issue_live(case_app.beta_issues),case_app.beta_issue_dto(case_app.beta_issues,boolean) from public,anon,authenticated;
grant execute on function case_api.beta_issue_dispatch(jsonb,text,jsonb),case_api.beta_issue_sweep(text,jsonb) to service_role;
commit;
