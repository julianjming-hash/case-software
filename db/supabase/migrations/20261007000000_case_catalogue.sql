-- Card 29 (CASE-166): the facilitator case catalogue and case detail, on existing case-document fields.
--
-- The catalogue lists one row per case (Julian, 2026-10-06): the case's latest published, non-withdrawn
-- version, in one workspace, with the public library fields the case document already carries: title,
-- summary, audience, setting and duration_min, plus version, published date, content digest (the
-- Worker labels the environment's pilot pin from it) and the numbers-only art descriptor (CASE-164).
-- Never beats, decisions, paths, notes or any other case-pack field. Older published versions (a
-- pilot-pinned one included) are not cards: case detail lists them, and each stays startable there.
--
-- Sort and filter run here, over the whole matching set, before the page is cut. Every order ends in
-- the version id, so it is total and a page boundary can never reorder or repeat a row. total_count is
-- the size of the whole filtered set, so the client can say "Showing N of M" honestly. The page is
-- bounded (1..50 rows) and the offset bounded (0..10000).
--
-- Authorization: the caller must hold a role in the workspace (the Worker preflights it as for the
-- versions read) and be an active account. Case detail is addressed by case id and version number;
-- a caller who is not a member of that case's workspace gets no row at all (the Worker answers 404),
-- the same shape as a missing case, so the read cannot probe another workspace.
-- No grants to anon or authenticated; execute to service_role only.
begin;

-- The listable versions: published, not withdrawn, in a live case. Latest per case is chosen by the reads.
create function case_app.catalogue_versions(p_workspace_id uuid)
returns table (version_id uuid, case_id uuid, version_no integer, latest boolean)
language sql stable set search_path = '' as $$
  select v.id, v.case_id, v.version_no,
         row_number() over (partition by v.case_id order by v.version_no desc) = 1
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
   where c.workspace_id = p_workspace_id and c.archived_at is null and
         not exists (select 1 from case_app.admin_version_state av
                      where av.case_version_id = v.id and av.status = 'withdrawn');
$$;

-- One row of public library fields per listed version. Type-checked: a value of the wrong JSON type, an
-- empty string or an unknown duration is null, which the client shows as "not set".
create function case_app.catalogue_text(p_doc jsonb, p_key text, p_max integer)
returns text language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_doc -> p_key) = 'string'
              then nullif(left(btrim(p_doc ->> p_key), p_max), '') end;
$$;

create function case_app.catalogue_duration(p_doc jsonb)
returns integer language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_doc -> 'duration_min') = 'number' and (p_doc ->> 'duration_min') in ('15', '45')
              then (p_doc ->> 'duration_min')::integer end;
$$;

create function case_api.list_case_catalogue(
  p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text,
  p_duration integer, p_audience text, p_limit integer, p_offset integer
) returns table (
  version_id uuid, case_id uuid, title text, summary text, audience text, setting text,
  duration_min integer, version_no integer, published_at timestamptz, content_sha256 bytea,
  art jsonb, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15, 45)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) then
    raise exception 'invalid_catalogue_query' using errcode = '22023'; end if;
  -- A literal substring match: LIKE metacharacters in the query are escaped, never interpreted.
  v_pattern := '%' || replace(replace(replace(lower(coalesce(v_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with listed as (
      select v.id as l_id, v.case_id as l_case, c.title as l_title,
             case_app.catalogue_text(v.document, 'summary', 1200) as l_summary,
             case_app.catalogue_text(v.document, 'audience', 200) as l_audience,
             case_app.catalogue_text(v.document, 'setting', 200) as l_setting,
             case_app.catalogue_duration(v.document) as l_duration,
             v.version_no as l_version, v.published_at as l_published,
             v.content_sha256::bytea as l_digest, a.descriptor as l_art
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       -- Ties (and every secondary order) fall back to the newest version, then the id: a total order.
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$$;

-- The audiences present in a workspace's catalogue, for the Audience filter and board columns.
-- Bounded: the 50 most common values.
create function case_api.list_case_catalogue_audiences(
  p_user_id uuid, p_workspace_id uuid
) returns table (
  audience text, case_count bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  return query
    select x.a, count(*)
      from (select case_app.catalogue_text(v.document, 'audience', 200) as a
              from case_app.catalogue_versions(p_workspace_id) lv
              join case_app.case_versions v on v.id = lv.version_id
             where lv.latest) x
     where x.a is not null
     group by x.a
     order by count(*) desc, x.a asc
     limit 50;
end;
$$;

-- Case detail: the catalogue fields plus the learning objectives (at most eight strings of at most
-- 300 characters), the workspace, the caller's role there, and every published, non-withdrawn version of
-- the case (newest first, at most 50; metadata only) so an older or pilot-pinned version stays startable.
create function case_api.get_catalogue_case(
  p_user_id uuid, p_case_id uuid, p_version_no integer
) returns table (
  workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text,
  audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb
) language plpgsql stable security definer set search_path = '' as $$
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  return query
    select c.workspace_id, m.role::text, v.id, v.case_id, c.title,
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
      join case_app.workspace_members m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
           and m.role in ('owner', 'author', 'facilitator')
      left join case_app.case_version_art a on a.case_version_id = v.id
     where v.case_id = p_case_id and v.version_no = p_version_no and c.archived_at is null and
           not exists (select 1 from case_app.admin_version_state av
                        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

-- ─── privileges: service role executes the three RPCs; nobody else touches anything ────────────────
revoke all on function case_app.catalogue_text(jsonb, text, integer), case_app.catalogue_duration(jsonb),
  case_app.catalogue_versions(uuid)
  from public, anon, authenticated;
revoke all on function
  case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer),
  case_api.list_case_catalogue_audiences(uuid, uuid),
  case_api.get_catalogue_case(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  case_api.list_case_catalogue(uuid, uuid, text, boolean, text, integer, text, integer, integer),
  case_api.list_case_catalogue_audiences(uuid, uuid),
  case_api.get_catalogue_case(uuid, uuid, integer)
  to service_role;

commit;
