-- CASE-356: bounded case-scoped Sessions. Read-only; the existing query and P-32 authority remain unchanged.
CREATE FUNCTION case_api.query_case_session_portfolio(p_user_id uuid, p_workspace_id uuid, p_query text, p_status text, p_from timestamptz, p_until timestamptz, p_after uuid, p_personal boolean, p_admin boolean, p_admin_email text, p_case_id uuid)
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
 if p_case_id is null then raise exception 'invalid_case_filter' using errcode='22023';end if;
 if p_query is null or length(p_query)>200 or p_query~'[[:cntrl:]]' or p_status is null or p_status not in ('all','running','ended') or p_personal is null or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until)) or p_from>=p_until then raise exception 'invalid_portfolio_query' using errcode='22023';end if;
 if p_after is not null and not exists(select 1 from case_app.sessions x where x.id=p_after and x.workspace_id=p_workspace_id and case_app.case_of_version(x.case_version_id)=p_case_id and case_app.record_visible(p_user_id,v_member,v_all and not p_personal,x.facilitator_id,case_app.case_of_version(x.case_version_id))) then raise exception 'invalid_cursor' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') into items from (
 select s.id,s.case_version_id,c.id case_id,coalesce(v.document->>'title',c.title) title,v.version_no,s.status,s.created_at,s.started_at,s.ended_at,s.expires_at,
  case when s.portfolio_manifest is not null then 'complete' when s.status in ('ended','expired') then 'limited' else 'pending' end archive_state,s.facilitator_id=p_user_id own
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and c.id=p_case_id and case_app.record_visible(p_user_id,v_member,v_all and not p_personal,s.facilitator_id,c.id) and (p_after is null or s.id<p_after)
  and position(lower(p_query) in lower(coalesce(v.document->>'title',c.title)))>0
  and (p_status='all' or p_status='running' and s.status in ('lobby','live') and s.expires_at>now() or p_status='ended' and (s.status in ('ended','expired') or s.expires_at<=now()))
  and (p_from is null or s.created_at>=p_from) and (p_until is null or s.created_at<p_until)
 order by s.id desc limit 20) r;
 return jsonb_build_object('rooms',items,'nextAfter',case when jsonb_array_length(items)=20 then items->19->>'id' else null end);
end;$function$;

REVOKE ALL ON FUNCTION case_api.query_case_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION case_api.query_case_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid) TO service_role;

-- A stable neutral case bookmark resolves independently of the current catalogue page.
CREATE FUNCTION case_api.resolve_catalogue_case(p_user_id uuid,p_case_id uuid,p_admin boolean,p_admin_email text)
RETURNS TABLE(workspace_id uuid,role text,version_no integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
declare held text;
begin
 if p_user_id is null or p_case_id is null then raise exception 'invalid_case' using errcode='22023';end if;
 if not case_api.admin_account_active(p_user_id) then raise exception 'account_not_active' using errcode='42501';end if;
 begin held:=case_app.authorize_case(p_user_id,p_case_id,'P-11',p_admin,p_admin_email);exception when insufficient_privilege then return;end;
 return query select c.workspace_id,held,(select case when coalesce(av.status,'published')='published' then v.version_no else null end from case_app.case_versions v left join case_app.admin_version_state av on av.case_version_id=v.id where v.case_id=c.id order by v.version_no desc limit 1) from case_app.cases c where c.id=p_case_id;
end $$;
REVOKE ALL ON FUNCTION case_api.resolve_catalogue_case(uuid,uuid,boolean,text) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION case_api.resolve_catalogue_case(uuid,uuid,boolean,text) TO service_role;
