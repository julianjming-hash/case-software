-- Card 28 (CASE-164): the numbers-only art descriptor, stored with the immutable published version.
--
-- The builder solves the layout and submits {v, stops, decisions, attempt, summarised, renderer}; the
-- renderer (geometry) version is stored with the version so a renderer change never alters its art. The Worker
-- re-derives the structure from the draft and refuses a mismatch; this RPC derives it again in SQL
-- from the exact draft it freezes, so the database can never store a descriptor that does not match
-- the published document. The layout search itself never runs here or in the Worker.
--
-- Delivery: the facilitator version list and the workspace version read (room start) gain one `art`
-- column. Nothing else is added. No grants to anon or authenticated; execute to service_role only.
begin;

-- ─── derivation (a SQL port of describeCase in src/shared/art-descriptor.mjs) ──────────────────────
-- The next beat on the authored default route: a decision follows its recommended path.
create function case_app.art_next(p_beat jsonb, p_decisions jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when p_beat ->> 'kind' = 'decision' then (
      select nullif(p ->> 'next_beat_id', '')
        from jsonb_array_elements(coalesce(p_decisions -> (p_beat ->> 'decision_id') -> 'paths', '[]'::jsonb))
             with ordinality as x(p, n)
       where p -> 'recommended' = 'true'::jsonb
       order by n limit 1)
    else nullif(p_beat ->> 'next_beat_id', '') end;
$$;

create function case_app.art_structure(p_doc jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_beats jsonb; v_decisions jsonb;
  v_index jsonb := '{}'::jsonb;
  v_route text[] := '{}';
  v_id text; v_seen jsonb; v_rejoin integer;
  v_i integer; v_beat jsonb; v_path jsonb;
  v_strands jsonb; v_resets integer; v_ends integer;
  v_out jsonb := '[]'::jsonb;
begin
  select coalesce(jsonb_object_agg(b ->> 'id', b), '{}'::jsonb) into v_beats
    from jsonb_array_elements(coalesce(p_doc -> 'beats', '[]'::jsonb)) b;
  select coalesce(jsonb_object_agg(d ->> 'id', d), '{}'::jsonb) into v_decisions
    from jsonb_array_elements(coalesce(p_doc -> 'decisions', '[]'::jsonb)) d;
  v_id := p_doc ->> 'start_beat_id';
  while v_id is not null and v_beats ? v_id and not v_index ? v_id loop
    v_index := v_index || jsonb_build_object(v_id, cardinality(v_route));
    v_route := v_route || v_id;
    v_id := case_app.art_next(v_beats -> v_id, v_decisions);
  end loop;
  for v_i in 1 .. cardinality(v_route) loop
    v_beat := v_beats -> v_route[v_i];
    continue when (v_beat ->> 'kind') is distinct from 'decision';
    v_strands := '[]'::jsonb; v_resets := 0; v_ends := 0;
    for v_path in select p from jsonb_array_elements(coalesce(v_decisions -> (v_beat ->> 'decision_id') -> 'paths', '[]'::jsonb))
                  with ordinality as x(p, n) order by n loop
      continue when v_path -> 'recommended' = 'true'::jsonb;
      if coalesce(v_path -> 'terminal', 'null'::jsonb) not in ('null'::jsonb, 'false'::jsonb) then
        v_resets := v_resets + 1; continue;
      end if;
      -- Follow the path forward until it touches the default route (bounded by a seen set).
      v_rejoin := null; v_seen := '{}'::jsonb; v_id := nullif(v_path ->> 'next_beat_id', '');
      while v_id is not null and not v_seen ? v_id loop
        if v_index ? v_id then v_rejoin := (v_index ->> v_id)::integer; exit; end if;
        v_seen := v_seen || jsonb_build_object(v_id, true);
        exit when not v_beats ? v_id;
        v_id := case_app.art_next(v_beats -> v_id, v_decisions);
      end loop;
      if v_rejoin is not null and v_rejoin > v_i - 1 then v_strands := v_strands || jsonb_build_array(jsonb_build_object('rejoin', v_rejoin));
      elsif v_rejoin is not null then v_resets := v_resets + 1;
      else v_ends := v_ends + 1; end if;
    end loop;
    v_out := v_out || jsonb_build_array(jsonb_build_object('stop', v_i - 1, 'strands', v_strands, 'resets', v_resets, 'ends', v_ends));
  end loop;
  return jsonb_build_object('v', 1, 'stops', cardinality(v_route), 'decisions', v_out);
end;
$$;

-- Stored shape: exactly the six delivered keys, a solved attempt in [0, 16), a boolean flag and a
-- positive integer renderer version (the Worker checks it is one the clients can draw).
create function case_app.art_shape_ok(p_art jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_art) = 'object'
     and (select array_agg(k order by k) from jsonb_object_keys(p_art) k) = array['attempt', 'decisions', 'renderer', 'stops', 'summarised', 'v']
     and jsonb_typeof(p_art -> 'attempt') = 'number' and (p_art ->> 'attempt') ~ '^(0|[1-9]|1[0-5])$'
     and jsonb_typeof(p_art -> 'summarised') = 'boolean'
     and jsonb_typeof(p_art -> 'renderer') = 'number' and (p_art ->> 'renderer') ~ '^[1-9][0-9]{0,3}$'
     and p_art -> 'v' = '1'::jsonb
     and jsonb_typeof(p_art -> 'stops') = 'number' and jsonb_typeof(p_art -> 'decisions') = 'array';
$$;

-- ─── storage: one immutable row per published version ─────────────────────────────────────────────
create table case_app.case_version_art (
  case_version_id uuid primary key references case_app.case_versions (id) on delete restrict,
  descriptor      jsonb not null check (case_app.art_shape_ok(descriptor)),
  renderer_version integer not null check (renderer_version >= 1),
  created_at      timestamptz not null default now(),
  check (descriptor -> 'renderer' = to_jsonb(renderer_version))
);
alter table case_app.case_version_art enable row level security;
create trigger case_version_art_immutable
  before update or delete on case_app.case_version_art
  for each row execute function case_app.forbid_change();
-- Statement-level TRUNCATE bypasses row triggers. (case_app.case_versions has no such guard: a
-- pre-existing gap, out of this card's scope.)
create trigger case_version_art_no_truncate
  before truncate on case_app.case_version_art
  for each statement execute function case_app.forbid_change();

-- ─── publish with art ─────────────────────────────────────────────────────────────────────────────
create function case_api.publish_draft_with_art(
  p_case_id uuid, p_expected_revision bigint, p_user_id uuid, p_asset_ids uuid[], p_art jsonb
) returns table (version_id uuid, version_no integer, content_sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  d case_app.case_drafts%rowtype;
  v record;
begin
  perform case_app.assert_member(p_user_id, case_app.workspace_of_case(p_case_id), array['owner', 'author']);
  select * into d from case_app.case_drafts where case_id = p_case_id for update;
  if not found or d.revision <> p_expected_revision then
    raise exception 'revision_conflict: case % is not at revision %', p_case_id, p_expected_revision
      using errcode = '40001';
  end if;
  -- The descriptor must be exactly the structure of the draft being frozen, plus a solved attempt.
  if p_art is null or not case_app.art_shape_ok(p_art) or
     (p_art - 'attempt' - 'summarised' - 'renderer') <> case_app.art_structure(d.document) then
    raise exception 'art_mismatch' using errcode = '22023';
  end if;
  select * into v from case_api.publish_draft(p_case_id, p_expected_revision, p_user_id, p_asset_ids);
  insert into case_app.case_version_art (case_version_id, descriptor, renderer_version)
  values (v.version_id, p_art, (p_art ->> 'renderer')::integer);
  return query select v.version_id, v.version_no, v.content_sha256;
end;
$$;

-- ─── delivery: one `art` column on the two reads that already identify the case ────────────────────
drop function case_api.list_published_versions(uuid, uuid, integer, uuid);
create function case_api.list_published_versions(
  p_user_id uuid, p_workspace_id uuid, p_limit integer, p_after uuid
) returns table (
  version_id uuid, case_id uuid, title text, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_after_at timestamptz;
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  if p_after is not null then
    select v.published_at into v_after_at
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_after and c.workspace_id = p_workspace_id and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn');
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select v.id, v.case_id, c.title, v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor
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

drop function case_api.get_case_version_for_workspace(uuid, uuid, uuid);
create function case_api.get_case_version_for_workspace(
  p_version_id uuid, p_workspace_id uuid, p_user_id uuid
) returns table (
  case_id uuid, version_no integer, schema_version integer,
  document jsonb, document_text text, content_sha256 bytea, art jsonb
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  return query select v.case_id, v.version_no, v.schema_version,
    v.document, v.document::text, v.content_sha256::bytea, a.descriptor
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
    left join case_app.case_version_art a on a.case_version_id = v.id
    where v.id = p_version_id and c.workspace_id = p_workspace_id and
      not exists (select 1 from case_app.admin_version_state av
        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

-- ─── privileges: service role executes the three RPCs; nobody else touches anything ────────────────
revoke all on function case_app.art_next(jsonb, jsonb), case_app.art_structure(jsonb), case_app.art_shape_ok(jsonb)
  from public, anon, authenticated;
revoke all on table case_app.case_version_art from public, anon, authenticated;
revoke all on function
  case_api.publish_draft_with_art(uuid, bigint, uuid, uuid[], jsonb),
  case_api.list_published_versions(uuid, uuid, integer, uuid),
  case_api.get_case_version_for_workspace(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
-- The art-less publish RPC is retired for callers: the Worker publishes only with verified art. It stays
-- installed because publish_draft_with_art calls it as its definer.
revoke execute on function case_api.publish_draft(uuid,bigint,uuid,uuid[]) from service_role;
grant execute on function
  case_api.publish_draft_with_art(uuid, bigint, uuid, uuid[], jsonb),
  case_api.list_published_versions(uuid, uuid, integer, uuid),
  case_api.get_case_version_for_workspace(uuid, uuid, uuid)
  to service_role;

commit;
