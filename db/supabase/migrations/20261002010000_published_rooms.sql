-- Card 05: bounded own-profile membership lookup and workspace-scoped version read.
-- The Worker passes only the verified facilitator JWT subject as p_user_id.
begin;

create function case_api.get_me(
  p_user_id uuid, p_limit integer default 100, p_after uuid default null,
  p_workspace_id uuid default null
) returns table (
  user_id uuid, display_name text, memberships jsonb, next_after uuid
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_display_name text;
  v_memberships jsonb;
  v_next_after uuid;
begin
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  if p_after is not null and not exists (
    select 1 from case_app.workspace_members m
     where m.user_id = p_user_id and m.workspace_id = p_after
       and (p_workspace_id is null or m.workspace_id = p_workspace_id)
  ) then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  select p.display_name into v_display_name from case_app.profiles p where p.id = p_user_id;
  with page as (
    select m.workspace_id, w.slug, w.name, m.role,
           row_number() over (order by m.workspace_id) as rn
      from case_app.workspace_members m
      join case_app.workspaces w on w.id = m.workspace_id
     where m.user_id = p_user_id
       and (p_workspace_id is null or m.workspace_id = p_workspace_id)
       and (p_after is null or m.workspace_id > p_after)
     order by m.workspace_id
     limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'workspace_id', workspace_id, 'slug', slug, 'name', name, 'role', role
         ) order by workspace_id) filter (where rn <= v_limit), '[]'::jsonb),
         case when count(*) > v_limit then (array_agg(workspace_id) filter (where rn = v_limit))[1] else null end
    into v_memberships, v_next_after from page;
  return query select p_user_id, v_display_name, v_memberships, v_next_after;
end;
$$;

create function case_api.get_case_version_for_workspace(
  p_version_id uuid, p_workspace_id uuid, p_user_id uuid
) returns table (
  case_id uuid, version_no integer, schema_version integer,
  document jsonb, document_text text, content_sha256 bytea
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  return query
    select v.case_id, v.version_no, v.schema_version, v.document,
           v.document::text, v.content_sha256::bytea
      from case_app.case_versions v
      join case_app.cases c on c.id = v.case_id
     where v.id = p_version_id and c.workspace_id = p_workspace_id;
end;
$$;

-- A denied or missing case returns no metadata; the Worker translates [] to 403.
-- The write RPCs still enforce membership themselves and their unexpected 42501 is a 500 alert.
create function case_api.get_case_authoring_access(p_case_id uuid, p_user_id uuid)
returns table (case_id uuid, workspace_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id
    from case_app.cases c
    join case_app.workspace_members m on m.workspace_id = c.workspace_id
   where c.id = p_case_id and m.user_id = p_user_id
     and m.role in ('owner', 'author');
$$;

-- Only the exact new entry points become service-role callable; case_app remains private.
revoke all on function case_api.get_me(uuid,integer,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function case_api.get_case_version_for_workspace(uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function case_api.get_case_authoring_access(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function
  case_api.get_me(uuid,integer,uuid,uuid),
  case_api.get_case_version_for_workspace(uuid,uuid,uuid),
  case_api.get_case_authoring_access(uuid,uuid)
to service_role;

commit;
