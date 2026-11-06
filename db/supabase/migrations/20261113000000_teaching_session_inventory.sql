-- CASE-359: opt-in teaching inventory, anonymous lifetime join totals, bounded abandoned-Lobby cleanup.
-- Legacy RPCs are immutable in behaviour; v2 HTTP readers select these new service-only functions.
begin;
CREATE FUNCTION case_app.has_teaching_evidence(p_session_id uuid,p_started_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 select p_started_at is not null
  or exists(select 1 from case_app.session_rounds r where r.session_id=p_session_id)
  or exists(select 1 from case_app.session_events e where e.session_id=p_session_id and e.kind in ('beat_entered','manual_entered','debrief_started'));
$$;
CREATE FUNCTION case_app.session_joined_total(p_session_id uuid,p_manifest jsonb)
RETURNS bigint LANGUAGE sql STABLE SET search_path='' AS $$
 select case when p_manifest is not null then greatest((p_manifest->>'joined')::bigint,count(*))
  when count(*)>0 then count(*) else null end from case_app.session_participants where session_id=p_session_id;
$$;
REVOKE ALL ON FUNCTION case_app.has_teaching_evidence(uuid,timestamptz),case_app.session_joined_total(uuid,jsonb) FROM public,anon,authenticated;
-- CASE-356: bounded case-scoped Sessions. Read-only; the existing query and P-32 authority remain unchanged.
CREATE FUNCTION case_api.query_teaching_session_portfolio(p_user_id uuid, p_workspace_id uuid, p_query text, p_status text, p_from timestamptz, p_until timestamptz, p_after uuid, p_personal boolean, p_admin boolean, p_admin_email text, p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare role text; items jsonb; v_member boolean; v_all boolean;
begin
 role:=case_app.authorize_records(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 v_member:=role='admin' or case_app.member_role(p_user_id,p_workspace_id) is not null;
 v_all:=role='admin' or (role='owner' and case_app.policy_allows('P-32','owner',case_app.policies_of(p_workspace_id)));
 if p_query is null or length(p_query)>200 or p_query~'[[:cntrl:]]' or p_status is null or p_status not in ('all','running','ended') or p_personal is null or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until)) or p_from>=p_until then raise exception 'invalid_portfolio_query' using errcode='22023';end if;
 if p_after is not null and not exists(select 1 from case_app.sessions x where x.id=p_after and x.workspace_id=p_workspace_id and (p_case_id is null or case_app.case_of_version(x.case_version_id)=p_case_id) and case_app.has_teaching_evidence(x.id,x.started_at) and case_app.record_visible(p_user_id,v_member,v_all and not p_personal,x.facilitator_id,case_app.case_of_version(x.case_version_id))) then raise exception 'invalid_cursor' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into items from (
 select s.id,s.case_version_id,c.id case_id,coalesce(v.document->>'title',c.title) title,v.version_no,s.status,s.created_at,s.started_at,s.ended_at,s.expires_at,
  case when s.portfolio_manifest is not null then 'complete' when s.status in ('ended','expired') then 'limited' else 'pending' end archive_state,s.facilitator_id=p_user_id own, case_app.session_joined_total(s.id,s.portfolio_manifest) joined, s.portfolio_manifest is not null joined_exact
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and (p_case_id is null or c.id=p_case_id) and case_app.has_teaching_evidence(s.id,s.started_at) and case_app.record_visible(p_user_id,v_member,v_all and not p_personal,s.facilitator_id,c.id) and (p_after is null or s.id<p_after)
  and position(lower(p_query) in lower(coalesce(v.document->>'title',c.title)))>0
  and (p_status='all' or p_status='running' and s.status in ('lobby','live') and s.expires_at>now() or p_status='ended' and (s.status in ('ended','expired') or s.expires_at<=now()))
  and (p_from is null or coalesce(s.started_at,s.created_at)>=p_from) and (p_until is null or coalesce(s.started_at,s.created_at)<p_until)
 order by s.id desc limit 20) r;
 return jsonb_build_object('rooms',items,'nextAfter',case when jsonb_array_length(items)=20 then items->19->>'id' else null end);
end;$function$;

CREATE FUNCTION case_api.personal_teaching_portfolio_stats(p_user_id uuid, p_workspace_id uuid, p_admin boolean, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare result jsonb; v_role text; v_member boolean;
begin
 v_role:=case_app.authorize_records(p_user_id,p_workspace_id,'P-32',p_admin,p_admin_email);
 v_member:=v_role='admin' or case_app.member_role(p_user_id,p_workspace_id) is not null;
 select jsonb_build_object('asOf',now(),'firstSessionAt',min(coalesce(started_at,created_at)),'sessions',count(*),'active',count(*) filter(where status in ('lobby','live') and expires_at>now()),
 'ended',count(*) filter(where status in ('ended','expired') or expires_at<=now()),'completeRecords',count(*) filter(where portfolio_manifest is not null),'uniqueVersions',count(distinct case_version_id),
 'recordedTeachingSeconds',coalesce(sum(greatest(0,extract(epoch from least(ended_at,expires_at)-started_at))) filter(where ended_at is not null and started_at is not null),0)::bigint)
 into result from case_app.sessions x where x.workspace_id=p_workspace_id and case_app.has_teaching_evidence(x.id,x.started_at) and case_app.record_visible(p_user_id,v_member,false,x.facilitator_id,case_app.case_of_version(x.case_version_id));
 return result;
end;$function$;

CREATE INDEX sessions_abandoned_lobby_cleanup_idx ON case_app.sessions(created_at,id) WHERE started_at IS NULL;

-- Rooms already expire within 24 h and DO personal state within another 24 h. Never extend either lifetime.
-- An anomalous future expiry or unknown/teaching evidence is retained, rather than guessed to be an abandoned Lobby.
CREATE FUNCTION case_api.purge_abandoned_lobbies(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2s' AS $$
declare removed integer;
begin
 if p_limit is null or p_limit<1 or p_limit>200 then raise exception 'invalid_cleanup_limit' using errcode='22023';end if;
 with due as (
  select s.id from case_app.sessions s
   where s.started_at is null and s.created_at<=clock_timestamp()-interval '30 days'
    and s.expires_at<=clock_timestamp()-interval '24 hours'
    and not case_app.has_teaching_evidence(s.id,s.started_at)
    and not exists(select 1 from case_app.session_events e where e.session_id=s.id and e.kind not in
     ('participant_joined','participant_renamed','participant_removed','room_ended','lobby_shown','facilitator_takeover','joining_closed','names_shown','music_set','timer_set','auto_lock_set'))
   order by s.created_at,s.id limit p_limit for update skip locked
 ), gone as (delete from case_app.sessions s using due where s.id=due.id returning 1)
 select count(*) into removed from gone;
 insert into case_app.job_heartbeats(job,ran_at,rows) values('purge_abandoned_lobbies',clock_timestamp(),removed)
 on conflict(job) do update set ran_at=excluded.ran_at,rows=excluded.rows;
 return removed;
end;$$;
REVOKE ALL ON FUNCTION case_api.query_teaching_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid),case_api.personal_teaching_portfolio_stats(uuid,uuid,boolean,text),case_api.purge_abandoned_lobbies(integer) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION case_api.query_teaching_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid),case_api.personal_teaching_portfolio_stats(uuid,uuid,boolean,text),case_api.purge_abandoned_lobbies(integer) TO service_role;
commit;
