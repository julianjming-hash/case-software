-- Summary-only account history. No detail/export grants or destructive retention rollout.
begin;
-- Replace immutable function definitions through a new migration, preserving private ACLs.
drop function case_app.action_roles(text);
drop function case_app.action_admin(text);
-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)
create function case_app.action_roles(p_action text)
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
    when 'P-15' then array['owner', 'author']
    when 'P-16' then array['owner']
    when 'P-17' then array['owner']
    when 'P-18' then array['owner']
    when 'P-19' then array['owner']
    when 'P-20' then array['owner']
    when 'P-21' then array['owner', 'author', 'facilitator']
    when 'P-22' then array[]::text[]
    when 'P-32' then array['owner', 'author', 'facilitator']
  end;
$$;
create function case_app.action_admin(p_action text)
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
  end;
$$;
-- END GENERATED permission roles
revoke all on function case_app.action_roles(text), case_app.action_admin(text) from public, anon, authenticated;
create index sessions_history_owner_idx on case_app.sessions(workspace_id,facilitator_id,created_at desc,id desc);
create index sessions_history_admin_idx on case_app.sessions(workspace_id,created_at desc,id desc);

create function case_api.list_room_history(
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
     or (p_filter in ('ended','all') and s.status in ('ended','expired') and s.ended_at>now()-interval '90 days'))
 ) then raise exception 'invalid_history_cursor' using errcode='22023'; end if;
 return query
 select s.id,s.case_version_id,coalesce(v.document->>'title',c.title),v.version_no,s.status,
   s.created_at,s.started_at,s.ended_at,s.expires_at,'pending'::text,s.facilitator_id=p_user_id
 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id
 join case_app.cases c on c.id=v.case_id
 where s.workspace_id=p_workspace_id and (v_role='admin' or s.facilitator_id=p_user_id)
  and ((p_filter in ('running','all') and s.status in ('lobby','live') and s.ended_at is null and s.expires_at>now())
    or (p_filter in ('ended','all') and s.status in ('ended','expired') and s.ended_at>now()-interval '90 days'))
  and (p_after_id is null or (s.created_at,s.id)<(p_after_at,p_after_id))
 order by s.created_at desc,s.id desc limit p_limit;
end;
$$;
revoke all on function case_api.list_room_history(uuid,uuid,text,integer,timestamptz,uuid,boolean,text) from public,anon,authenticated;
grant execute on function case_api.list_room_history(uuid,uuid,text,integer,timestamptz,uuid,boolean,text) to service_role;
-- Existing rows older than End+90d are excluded from this new list only. Installation deletes nothing.
-- The existing personal purge remains End+24h. Aggregate destructive cleanup/card40 finalization is separate.
commit;
