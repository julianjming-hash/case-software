-- CASE-274: catalogue metadata comes from the immutable version, never the mutable working title.
-- Existing authorization, output shapes, pagination and execute grants are preserved.
begin;
create or replace function case_app.catalogue_duration_current(p_doc jsonb)
returns integer language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_doc->'duration_min')='number' and
    ((p_doc->>'duration_min') in ('15','45') or
     (p_doc->>'schema_version' in ('2','3') and p_doc->>'duration_min' in ('20','25','30','35','40','50','55','60','65','70','75','80','85','90')))
    then (p_doc->>'duration_min')::integer end;
$$;
create or replace function case_api.list_case_catalogue(
  p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text,
  p_duration integer, p_audience text, p_limit integer, p_offset integer,
  p_group_id uuid, p_ungrouped boolean, p_admin boolean, p_admin_email text
) returns table (
  version_id uuid, case_id uuid, title text, summary text, audience text, setting text,
  duration_min integer, version_no integer, published_at timestamptz, content_sha256 bytea,
  art jsonb, group_id uuid, group_name text, tint text, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience', 'group') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15, 45)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) or
     p_ungrouped is null or (p_ungrouped and p_group_id is not null) or
     (p_group_id is not null and not exists (select 1 from case_app.case_groups g
        where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null)) then
    raise exception 'invalid_catalogue_query' using errcode = '22023'; end if;
  v_pattern := '%' || replace(replace(replace(lower(coalesce(v_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with listed as (
      select v.id as l_id, v.case_id as l_case, coalesce(case_app.catalogue_text(v.document,'title',200),c.title) as l_title,
             case_app.catalogue_text(v.document, 'summary', 1200) as l_summary,
             case_app.catalogue_text(v.document, 'audience', 200) as l_audience,
             case_app.catalogue_text(v.document, 'setting', 200) as l_setting,
             case_app.catalogue_duration(v.document) as l_duration,
             v.version_no as l_version, v.published_at as l_published,
             v.content_sha256::bytea as l_digest, a.descriptor as l_art,
             c.group_id as l_group, g.name as l_group_name, coalesce(g.tint, 'neutral') as l_tint
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_groups g on g.id = c.group_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
         and (p_group_id is null or l.l_group = p_group_id)
         and (not p_ungrouped or l.l_group is null)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, f.l_group, f.l_group_name, f.l_tint, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'group' and not p_descending then lower(f.l_group_name) end asc nulls last,
       case when p_sort = 'group' and p_descending then lower(f.l_group_name) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$$;

create or replace function case_api.get_catalogue_case(
  p_user_id uuid, p_case_id uuid, p_version_no integer,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text,
  audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize(p_user_id, v_ws, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title),
           case_app.catalogue_text(v.document, 'summary', 1200),
           case_app.catalogue_text(v.document, 'audience', 200),
           case_app.catalogue_text(v.document, 'setting', 200),
           case_app.catalogue_duration(v.document),
           case when jsonb_typeof(v.document -> 'learning_objectives') = 'array' then coalesce((
             select jsonb_agg(left(btrim(o.value #>> '{}'), 300) order by o.n)
               from jsonb_array_elements(v.document -> 'learning_objectives') with ordinality as o(value, n)
              where jsonb_typeof(o.value) = 'string' and btrim(o.value #>> '{}') <> '' and o.n <= 8), '[]'::jsonb)
             else '[]'::jsonb end,
           v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor,
           (select coalesce(jsonb_agg(jsonb_build_object('version_id', o.id, 'version_no', o.version_no,
                     'published_at', o.published_at, 'content_sha256', '\x' || encode(o.content_sha256, 'hex'))
                     order by o.version_no desc), '[]'::jsonb)
              from (select ov.id, ov.version_no, ov.published_at, ov.content_sha256
                      from case_app.case_versions ov
                     where ov.case_id = v.case_id and
                           not exists (select 1 from case_app.admin_version_state av
                                        where av.case_version_id = ov.id and av.status = 'withdrawn')
                     order by ov.version_no desc limit 50) o)
      from case_app.case_versions v
      join case_app.cases c on c.id = v.case_id
      left join case_app.case_version_art a on a.case_version_id = v.id
     where v.case_id = p_case_id and v.version_no = p_version_no and c.archived_at is null and
           not exists (select 1 from case_app.admin_version_state av
                        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

create or replace function case_api.list_published_versions(
  p_user_id uuid, p_workspace_id uuid, p_limit integer, p_after uuid,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  version_id uuid, case_id uuid, title text, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_after_at timestamptz;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_after is not null then
    select v.published_at into v_after_at
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_after and c.workspace_id = p_workspace_id and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn');
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title), v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
      left join case_app.case_version_art a on a.case_version_id = v.id
     where c.workspace_id = p_workspace_id and c.archived_at is null and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn') and
       (p_after is null or (v.published_at, v.id) < (v_after_at, p_after))
     order by v.published_at desc, v.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;
create or replace function case_api.list_case_catalogue_current(
  p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text,
  p_duration integer, p_audience text, p_limit integer, p_offset integer,
  p_group_id uuid, p_ungrouped boolean, p_admin boolean, p_admin_email text
) returns table (
  version_id uuid, case_id uuid, title text, summary text, audience text, setting text,
  duration_min integer, version_no integer, published_at timestamptz, content_sha256 bytea,
  art jsonb, group_id uuid, group_name text, tint text, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience', 'group') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) or
     p_ungrouped is null or (p_ungrouped and p_group_id is not null) or
     (p_group_id is not null and not exists (select 1 from case_app.case_groups g
        where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null)) then
    raise exception 'invalid_catalogue_query' using errcode = '22023'; end if;
  v_pattern := '%' || replace(replace(replace(lower(coalesce(v_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with listed as (
      select v.id as l_id, v.case_id as l_case, coalesce(case_app.catalogue_text(v.document,'title',200),c.title) as l_title,
             case_app.catalogue_text(v.document, 'summary', 1200) as l_summary,
             case_app.catalogue_text(v.document, 'audience', 200) as l_audience,
             case_app.catalogue_text(v.document, 'setting', 200) as l_setting,
             case_app.catalogue_duration_current(v.document) as l_duration,
             v.version_no as l_version, v.published_at as l_published,
             v.content_sha256::bytea as l_digest, a.descriptor as l_art,
             c.group_id as l_group, g.name as l_group_name, coalesce(g.tint, 'neutral') as l_tint
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_groups g on g.id = c.group_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
         and (p_group_id is null or l.l_group = p_group_id)
         and (not p_ungrouped or l.l_group is null)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, f.l_group, f.l_group_name, f.l_tint, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'group' and not p_descending then lower(f.l_group_name) end asc nulls last,
       case when p_sort = 'group' and p_descending then lower(f.l_group_name) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$$;
create or replace function case_api.get_catalogue_case_current(
  p_user_id uuid, p_case_id uuid, p_version_no integer,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text,
  audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize(p_user_id, v_ws, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title),
           case_app.catalogue_text(v.document, 'summary', 1200),
           case_app.catalogue_text(v.document, 'audience', 200),
           case_app.catalogue_text(v.document, 'setting', 200),
           case_app.catalogue_duration_current(v.document),
           case when jsonb_typeof(v.document -> 'learning_objectives') = 'array' then coalesce((
             select jsonb_agg(left(btrim(o.value #>> '{}'), 300) order by o.n)
               from jsonb_array_elements(v.document -> 'learning_objectives') with ordinality as o(value, n)
              where jsonb_typeof(o.value) = 'string' and btrim(o.value #>> '{}') <> '' and o.n <= 8), '[]'::jsonb)
             else '[]'::jsonb end,
           v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor,
           (select coalesce(jsonb_agg(jsonb_build_object('version_id', o.id, 'version_no', o.version_no,
                     'published_at', o.published_at, 'content_sha256', '\x' || encode(o.content_sha256, 'hex'))
                     order by o.version_no desc), '[]'::jsonb)
              from (select ov.id, ov.version_no, ov.published_at, ov.content_sha256
                      from case_app.case_versions ov
                     where ov.case_id = v.case_id and
                           not exists (select 1 from case_app.admin_version_state av
                                        where av.case_version_id = ov.id and av.status = 'withdrawn')
                     order by ov.version_no desc limit 50) o)
      from case_app.case_versions v
      join case_app.cases c on c.id = v.case_id
      left join case_app.case_version_art a on a.case_version_id = v.id
     where v.case_id = p_case_id and v.version_no = p_version_no and c.archived_at is null and
           not exists (select 1 from case_app.admin_version_state av
                        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;
revoke all on function case_app.catalogue_duration_current(jsonb) from public,anon,authenticated,service_role;
revoke all on function case_api.list_case_catalogue_current(uuid,uuid,text,boolean,text,integer,text,integer,integer,uuid,boolean,boolean,text),
  case_api.get_catalogue_case_current(uuid,uuid,integer,boolean,text) from public,anon,authenticated;
grant execute on function case_api.list_case_catalogue_current(uuid,uuid,text,boolean,text,integer,text,integer,integer,uuid,boolean,boolean,text),
  case_api.get_catalogue_case_current(uuid,uuid,integer,boolean,text) to service_role;
commit;
