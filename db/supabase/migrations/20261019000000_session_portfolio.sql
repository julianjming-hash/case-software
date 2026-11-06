-- Participant-deidentified portfolio; no personal purge or DO lifetime extension.
begin;
-- Generated permission block follows. No applied migration is modified.
-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)
create or replace function case_app.action_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then array[]::text[]
    when 'P-02' then array[]::text[]
    when 'P-03' then array[]::text[]
    when 'P-04' then array[]::text[]
    when 'P-05' then array[]::text[]
    when 'P-07' then array[]::text[]
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
    when 'P-34' then array['owner', 'author', 'facilitator']
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
    when 'P-07' then true
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
    when 'P-34' then true
  end;
$$;
-- END GENERATED permission roles
revoke all on function case_app.action_roles(text),case_app.action_admin(text) from public,anon,authenticated;
alter table case_app.sessions add column portfolio_manifest jsonb;

-- Freeze finalized anonymous evidence. Retention may still purge personal rows on its original deadline.
create function case_app.guard_portfolio_evidence() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from case_app.sessions where id=new.session_id and portfolio_manifest is not null) then raise exception 'finalized_evidence' using errcode='23514';end if;
 return new;
end;$$;
create trigger portfolio_events_frozen before insert on case_app.session_events for each row execute function case_app.guard_portfolio_evidence();
create trigger portfolio_rounds_frozen before insert or update on case_app.session_rounds for each row execute function case_app.guard_portfolio_evidence();
create function case_app.guard_portfolio_manifest() returns trigger language plpgsql set search_path='' as $$
begin
 if old.portfolio_manifest is not null and (new.portfolio_manifest,new.case_version_id,new.final_revision,new.final_epoch,new.status,new.ended_at) is distinct from (old.portfolio_manifest,old.case_version_id,old.final_revision,old.final_epoch,old.status,old.ended_at) then raise exception 'finalized_manifest' using errcode='23514';end if;
 return new;
end;$$;
create trigger portfolio_manifest_frozen before update on case_app.sessions for each row execute function case_app.guard_portfolio_manifest();
alter function case_api.archive_session_batch(uuid,jsonb) rename to archive_session_batch_v4;
revoke all on function case_api.archive_session_batch_v4(uuid,jsonb) from public,anon,authenticated,service_role;
create function case_api.archive_session_batch(p_session_id uuid,p_batch jsonb) returns bigint language plpgsql security definer set search_path='' as $$
declare s case_app.sessions;
begin
 select * into s from case_app.sessions where id=p_session_id for update;
 if s.portfolio_manifest is not null then return s.archived_through_seq;end if;
 return case_api.archive_session_batch_v4(p_session_id,p_batch);
end;$$;
revoke all on function case_api.archive_session_batch(uuid,jsonb) from public,anon,authenticated;
grant execute on function case_api.archive_session_batch(uuid,jsonb) to service_role;
revoke all on function case_app.guard_portfolio_evidence(),case_app.guard_portfolio_manifest() from public,anon,authenticated,service_role;

create function case_api.finalize_session_portfolio(p_session_id uuid,p_version_id uuid,p_revision bigint,p_epoch integer,p_seq bigint,p_round_count integer,p_joined integer)
returns boolean language plpgsql security definer set search_path='' set statement_timeout='2s' as $$
declare s case_app.sessions; n bigint; lo bigint; hi bigint; manifest jsonb;
begin
 select * into s from case_app.sessions where id=p_session_id for update;
 if not found or s.case_version_id is distinct from p_version_id or s.status not in ('ended','expired') or s.final_revision is distinct from p_revision or s.final_epoch is distinct from p_epoch
  or p_seq is null or p_seq<>p_revision or p_seq<1 or p_seq>1000000 or p_round_count is null or p_round_count<0 or p_round_count>10000 or p_joined is null or p_joined<0 or p_joined>1000000 then raise exception 'invalid_final_manifest' using errcode='23514';end if;
 select count(*),min(seq),max(seq) into n,lo,hi from case_app.session_events where session_id=s.id;
 if n<>p_seq or lo<>1 or hi<>p_seq or exists(select 1 from case_app.session_events where session_id=s.id and epoch>p_epoch) or not exists(select 1 from case_app.session_events where session_id=s.id and seq=p_seq and kind='room_ended' and epoch=p_epoch)
  or (select count(*) from case_app.session_rounds where session_id=s.id)<>p_round_count
  or exists(select 1 from case_app.session_rounds where session_id=s.id and (status in ('open','locked') or closed_at is null))
  or exists(select 1 from case_app.session_events e where e.session_id=s.id and e.kind='responses_locked' and not exists(select 1 from case_app.session_rounds r where r.session_id=s.id and r.id::text=e.payload->>'roundId' and (r.aggregate is not null or r.status='abandoned'))) then
  raise exception 'archive_not_final' using errcode='23514';end if;
 manifest:=jsonb_build_object('interpretation',1,'versionId',p_version_id,'revision',p_revision,'epoch',p_epoch,'seq',p_seq,'roundCount',p_round_count,'joined',p_joined);
 if s.portfolio_manifest is not null and s.portfolio_manifest<>manifest then raise exception 'manifest_conflict' using errcode='40001';end if;
 update case_app.sessions set portfolio_manifest=manifest where id=s.id and portfolio_manifest is null;
 return true;
end;$$;

create function case_api.query_session_portfolio(p_user_id uuid,p_workspace_id uuid,p_query text,p_status text,p_from timestamptz,p_until timestamptz,p_after uuid,p_personal boolean,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare role text; items jsonb;
begin
 role:=case_app.authorize(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 if p_query is null or length(p_query)>200 or p_query~'[[:cntrl:]]' or p_status is null or p_status not in ('all','running','ended') or p_personal is null or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until)) or p_from>=p_until then raise exception 'invalid_portfolio_query' using errcode='22023';end if;
 if p_after is not null and not exists(select 1 from case_app.sessions where id=p_after and workspace_id=p_workspace_id and (facilitator_id=p_user_id or role='admin' and not p_personal)) then raise exception 'invalid_cursor' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into items from (
 select s.id,s.case_version_id,c.id case_id,coalesce(v.document->>'title',c.title) title,v.version_no,s.status,s.created_at,s.started_at,s.ended_at,s.expires_at,
  case when s.portfolio_manifest is not null then 'complete' when s.status in ('ended','expired') then 'limited' else 'pending' end archive_state,s.facilitator_id=p_user_id own
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and (s.facilitator_id=p_user_id or role='admin' and not p_personal) and (p_after is null or s.id<p_after)
  and position(lower(p_query) in lower(coalesce(v.document->>'title',c.title)))>0
  and (p_status='all' or p_status='running' and s.status in ('lobby','live') and s.expires_at>now() or p_status='ended' and (s.status in ('ended','expired') or s.expires_at<=now()))
  and (p_from is null or s.created_at>=p_from) and (p_until is null or s.created_at<p_until)
 order by s.id desc limit 20) r;
 return jsonb_build_object('rooms',items,'nextAfter',case when jsonb_array_length(items)=20 then items->19->>'id' else null end);
end;$$;

create function case_api.personal_portfolio_stats(p_user_id uuid,p_workspace_id uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare result jsonb;
begin
 perform case_app.authorize(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 select jsonb_build_object('asOf',now(),'firstSessionAt',min(created_at),'sessions',count(*),'active',count(*) filter(where status in ('lobby','live') and expires_at>now()),
 'ended',count(*) filter(where status in ('ended','expired') or expires_at<=now()),'completeRecords',count(*) filter(where portfolio_manifest is not null),'uniqueVersions',count(distinct case_version_id),
 'recordedTeachingSeconds',coalesce(sum(greatest(0,extract(epoch from least(ended_at,expires_at)-started_at))) filter(where ended_at is not null and started_at is not null),0)::bigint)
 into result from case_app.sessions where workspace_id=p_workspace_id and facilitator_id=p_user_id;
 return result;
end;$$;

create function case_api.read_session_portfolio(p_user_id uuid,p_session_id uuid,p_after bigint,p_boundary text,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare s case_app.sessions; v case_app.case_versions; role text; boundary text; hi bigint; n bigint; rounds_digest text; items jsonb; next_after bigint;
begin
 select * into s from case_app.sessions where id=p_session_id;
 if not found then raise exception 'session_not_found' using errcode='P0002';end if;
 role:=case_app.authorize(p_user_id,s.workspace_id,'P-34',p_admin,p_admin_email);
 if role<>'admin' and s.facilitator_id<>p_user_id then raise exception 'not_starter' using errcode='42501';end if;
 if p_after is null or p_after<0 or p_after>1010000 or (p_after>0 and p_boundary is null) then raise exception 'invalid_record_cursor' using errcode='22023';end if;
 select * into v from case_app.case_versions where id=s.case_version_id;
 select coalesce(max(seq),0),count(*) into hi,n from case_app.session_events where session_id=s.id;
 if hi>1000000 or (select count(*) from case_app.session_rounds where session_id=s.id)>10000 then raise exception 'record_budget' using errcode='23514';end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.id)::text,'[]'),'UTF8')),'hex') into rounds_digest from case_app.session_rounds r where session_id=s.id;
 boundary:=encode(sha256(convert_to(jsonb_build_array(s.id,s.case_version_id,s.status,s.started_at,s.ended_at,s.expires_at,s.portfolio_manifest,hi,n,rounds_digest)::text,'UTF8')),'hex');
 if p_boundary is not null and p_boundary<>boundary then raise exception 'record_changed' using errcode='40001';end if;
 select coalesce(jsonb_agg(value order by position),'[]'),max(position) into items,next_after from (
 select * from (
  select e.seq position,jsonb_build_object('type','event','position',e.seq,'seq',e.seq,'eventId',e.event_id,'epoch',e.epoch,'kind',e.kind,'at',e.occurred_at,'payload',jsonb_strip_nulls(jsonb_build_object('decisionId',e.payload->'decisionId','pathId',e.payload->'pathId','beatId',e.payload->'beatId','checkpointBeatId',e.payload->'checkpointBeatId','roundId',e.payload->'roundId','sourceRoundId',e.payload->'sourceRoundId','targetEventId',e.payload->'targetEventId','occurrenceId',e.payload->'occurrenceId','contextOccurrenceId',e.payload->'contextOccurrenceId','restoresOccurrenceId',e.payload->'restoresOccurrenceId','segmentId',e.payload->'segmentId','clarificationId',e.payload->'clarificationId','groupsShown',e.payload->'groupsShown','markerNo',e.payload->'markerNo','total',e.payload->'total','resolutionKind',e.payload->'resolutionKind','mode',e.payload->'mode','actionKind',e.payload->'actionKind','roundNo',e.payload->'roundNo','status',e.payload->'status','confirmed',e.payload->'confirmed','publication',case when jsonb_typeof(e.payload->'publication')='object' then jsonb_strip_nulls(jsonb_build_object('occurrenceId',e.payload->'publication'->'occurrenceId','surfaceId',e.payload->'publication'->'surfaceId','beatId',e.payload->'publication'->'beatId','checkpointOf',e.payload->'publication'->'checkpointOf','correctionOf',e.payload->'publication'->'correctionOf','restoresOccurrenceId',e.payload->'publication'->'restoresOccurrenceId','groupsShown',e.payload->'publication'->'groupsShown','manual',e.payload->'publication'->'manual')) else null end))) value from case_app.session_events e where e.session_id=s.id and e.kind not in ('participant_joined','participant_renamed','participant_removed','response_recorded')
  union all
  select hi+row_number() over(order by r.round_no,r.id),jsonb_build_object('type','round','position',hi+row_number() over(order by r.round_no,r.id),'id',r.id,'decisionId',r.decision_id,'number',r.round_no,'status',r.status,'openedAt',r.opened_at,'closedAt',r.closed_at,'aggregate',r.aggregate,'pathId',r.selected_path_id,'resolution',r.resolution_kind) from case_app.session_rounds r where r.session_id=s.id
 ) all_items where position>p_after order by position limit 100) page;
 return jsonb_build_object('session',jsonb_build_object('id',s.id,'workspaceId',s.workspace_id,'caseId',v.case_id,'versionId',v.id,'versionNo',v.version_no,'digest',encode(v.content_sha256,'hex'),'title',coalesce(v.document->>'title',(select title from case_app.cases where id=v.case_id)),
 'status',s.status,'sourceStatus',coalesce((select status from case_app.admin_version_state where case_version_id=v.id),'published'),'createdAt',s.created_at,'startedAt',s.started_at,'endedAt',s.ended_at,'expiresAt',s.expires_at,'own',s.facilitator_id=p_user_id,'manifest',s.portfolio_manifest),
 'interpretationLimited',exists(select 1 from case_app.session_events e where e.session_id=s.id and (
 e.kind not in ('beat_entered','responses_opened','responses_locked','path_selected','selection_cleared','consequence_revealed','teaching_corrected','clarification_shown','clarification_returned','recovery_confirmation','checkpoint_reset','discussion_paused','discussion_resumed','manual_entered','manual_marker','manual_exited','room_ended','round_closed','participant_joined','participant_renamed','participant_removed','response_recorded','names_shown','results_shown','results_page','ranked_page','timer_set','lobby_shown','facilitator_takeover','joining_closed','presentation_group_revealed')
 or (e.kind in ('beat_entered','consequence_revealed') and coalesce(e.payload->'publication'->>'occurrenceId','')='')
 or (e.payload->>'decisionId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'decisions') d where d->>'id'=e.payload->>'decisionId'))
 or (e.payload->>'pathId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'decisions') d cross join lateral jsonb_array_elements(d->'paths') p where d->>'id'=e.payload->>'decisionId' and p->>'id'=e.payload->>'pathId'))
 or (e.payload->>'beatId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'beats') b where b->>'id'=e.payload->>'beatId'))
 or (e.payload->>'checkpointBeatId' is not null and not exists(select 1 from jsonb_array_elements(v.document->'beats') b where b->>'id'=e.payload->>'checkpointBeatId'))
 )) or exists(select 1 from case_app.session_rounds r where r.session_id=s.id and (
 not exists(select 1 from jsonb_array_elements(v.document->'decisions') d where d->>'id'=r.decision_id::text)
 or (r.selected_path_id is not null and not exists(select 1 from jsonb_array_elements(v.document->'decisions') d cross join lateral jsonb_array_elements(d->'paths') p where d->>'id'=r.decision_id::text and p->>'id'=r.selected_path_id::text))
 )), 'boundary',boundary,'document',v.document,'items',items,'nextPosition',case when jsonb_array_length(items)=100 then next_after else null end,'eventCount',n,'maxSeq',hi);
end;$$;
-- Preserve the old summary endpoint for older clients while removing the visibility window.
create or replace function case_api.list_room_history(
 p_user_id uuid,p_workspace_id uuid,p_filter text,p_limit integer,p_after_at timestamptz,p_after_id uuid,
 p_admin boolean default false,p_admin_email text default null
) returns table (
 session_id uuid,case_version_id uuid,title text,version_no integer,status text,
 created_at timestamptz,started_at timestamptz,ended_at timestamptz,expires_at timestamptz,
 archive_state text,own boolean
) language plpgsql stable security definer set search_path = '' as $$
declare v_role text;
begin
 v_role:=case_app.authorize(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 if p_filter is null or p_filter not in ('running','ended','all') or p_limit is null or p_limit<1 or p_limit>100
    or (p_after_at is null)<>(p_after_id is null) or (p_after_at is not null and not isfinite(p_after_at)) then
  raise exception 'invalid_history_page' using errcode='22023';
 end if;
 -- An anchor must still be visible to this actor in the exact workspace/filter. It carries no grant.
 if p_after_id is not null and not exists (
  select 1 from case_app.sessions s where s.id=p_after_id and s.created_at=p_after_at
   and s.workspace_id=p_workspace_id and (v_role='admin' or s.facilitator_id=p_user_id)
   and ((p_filter in ('running','all') and s.status in ('lobby','live') and s.ended_at is null and s.expires_at>now())
     or (p_filter in ('ended','all') and s.status in ('ended','expired')))
 ) then raise exception 'invalid_history_cursor' using errcode='22023'; end if;
 return query
 select s.id,s.case_version_id,coalesce(v.document->>'title',c.title),v.version_no,s.status,
   s.created_at,s.started_at,s.ended_at,s.expires_at,'pending'::text,s.facilitator_id=p_user_id
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id
 join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and (v_role='admin' or s.facilitator_id=p_user_id)
  and ((p_filter in ('running','all') and s.status in ('lobby','live') and s.ended_at is null and s.expires_at>now())
    or (p_filter in ('ended','all') and s.status in ('ended','expired')))
  and (p_after_id is null or (s.created_at,s.id)<(p_after_at,p_after_id))
 order by s.created_at desc,s.id desc limit p_limit;
end;
$$;

revoke all on function case_api.finalize_session_portfolio(uuid,uuid,bigint,integer,bigint,integer,integer),case_api.query_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text),case_api.personal_portfolio_stats(uuid,uuid,boolean,text),case_api.read_session_portfolio(uuid,uuid,bigint,text,boolean,text) from public,anon,authenticated;
grant execute on function case_api.finalize_session_portfolio(uuid,uuid,bigint,integer,bigint,integer,integer),case_api.query_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text),case_api.personal_portfolio_stats(uuid,uuid,boolean,text),case_api.read_session_portfolio(uuid,uuid,bigint,text,boolean,text) to service_role;
commit;
