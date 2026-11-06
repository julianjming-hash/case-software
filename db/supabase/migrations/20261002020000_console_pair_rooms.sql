-- Card 11: a bounded list of the caller's active rooms for fresh-tab shared-PC approval.
-- The Worker supplies only the verified JWT subject; room ownership is rechecked by RoomDO at mint.
begin;

create function case_api.list_owned_active_sessions(
  p_user_id uuid, p_limit integer default 100, p_after uuid default null
) returns table (session_id uuid, join_code text, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_after_at timestamptz;
begin
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  if p_after is not null then
    select s.created_at into v_after_at from case_app.sessions s
     where s.id = p_after and s.facilitator_id = p_user_id
       and s.status in ('lobby', 'live') and s.expires_at > now();
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select s.id, s.join_code::text, s.expires_at
      from case_app.sessions s
     where s.facilitator_id = p_user_id and s.status in ('lobby', 'live')
       and s.expires_at > now()
       and (p_after is null or (s.created_at, s.id) < (v_after_at, p_after))
     order by s.created_at desc, s.id desc
     limit v_limit;
end;
$$;

revoke all on function case_api.list_owned_active_sessions(uuid,integer,uuid)
  from public, anon, authenticated, service_role;
grant execute on function case_api.list_owned_active_sessions(uuid,integer,uuid) to service_role;

commit;
