-- History interpretation knows the room music kind (CASE-334). The facilitator's track and Build choice is journalled as
-- music_set {choice, intensity}: public, non-personal room state. read_session_portfolio marks a record "limited" when the
-- journal holds a kind outside its list, so without this every session that touched the music would read as limited.
-- This redefines the function from 20261109000000 with only the kind list extended; its signature, privileges and every
-- other rule are unchanged. Apply before the Worker that writes the new kind.
begin;
create or replace function case_api.read_session_portfolio(p_user_id uuid,p_session_id uuid,p_after bigint,p_boundary text,p_admin boolean,p_admin_email text)
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
 e.kind not in ('beat_entered','responses_opened','responses_locked','path_selected','selection_cleared','consequence_revealed','teaching_corrected','clarification_shown','clarification_returned','recovery_confirmation','checkpoint_reset','discussion_paused','discussion_resumed','manual_entered','manual_marker','manual_exited','room_ended','round_closed','participant_joined','participant_renamed','participant_removed','response_recorded','names_shown','results_shown','results_page','ranked_page','timer_set','lobby_shown','facilitator_takeover','joining_closed','presentation_group_revealed',
 'debrief_started','debrief_left','media_control','responses_closing','lock_cancelled','auto_lock_set','music_set')
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
commit;
