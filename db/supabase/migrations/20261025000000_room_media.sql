-- Room image, GIF and video delivery, card 59 M3 (CASE-269). At room start the Worker reads the media the version pins,
-- in the room's workspace, with their public facts and storage keys; the room Durable Object then mints an opaque
-- handle per image and serves a rendition only to a role whose released steps include it. The keys never leave the
-- Worker and the Durable Object. A withdrawn or rejected image is listed with its status so the room shows it as
-- withdrawn instead of failing to start.
begin;

create function case_api.room_media_manifest(p_version_id uuid, p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
returns table(asset_id uuid, status text, width integer, height integer, attribution text, display_key text, phone_key text,
  poster_key text, media_type text, duration_ms integer)
language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  return query select a.id, a.status, a.width, a.height, a.attribution, d.r2_key, ph.r2_key, po.r2_key, a.media_type, a.duration_ms
    from case_app.case_version_assets cva
    join case_app.case_versions v on v.id = cva.case_version_id
    join case_app.cases c on c.id = v.case_id
    join case_app.assets a on a.id = cva.asset_id
    left join case_app.asset_renditions d on d.asset_id = a.id and d.rendition = 'display'
    left join case_app.asset_renditions ph on ph.asset_id = a.id and ph.rendition = 'phone'
    left join case_app.asset_renditions po on po.asset_id = a.id and po.rendition = 'poster'
    where cva.case_version_id = p_version_id and c.workspace_id = p_workspace_id and a.workspace_id = p_workspace_id and a.kind in ('image', 'video')
    order by a.id;
end;
$$;
-- A version pins exactly the images its document shows (red-team S4): the set of `case_version_assets` must equal the
-- image blocks' asset ids plus any legacy surface asset ids, checked when the release transaction commits, so a release
-- cannot pin an image the document does not show or leave out one it does.
create function case_app.guard_version_asset_set()
returns trigger language plpgsql set search_path = '' as $$
declare v_doc jsonb; v_want uuid[]; v_have uuid[];
begin
  select document into v_doc from case_app.case_versions where id = new.id;
  select coalesce(array_agg(distinct x order by x), '{}') into v_want from (
    select (b->>'asset_id')::uuid x from jsonb_array_elements(case when jsonb_typeof(v_doc->'blocks') = 'array' then v_doc->'blocks' else '[]'::jsonb end) b
      where b->>'type' = 'image' and b->>'asset_id' ~ '^[0-9a-f-]{36}$'
    union select s::uuid from jsonb_array_elements(case when jsonb_typeof(v_doc->'surfaces') = 'array' then v_doc->'surfaces' else '[]'::jsonb end) f,
      jsonb_array_elements_text(case when jsonb_typeof(f->'asset_ids') = 'array' then f->'asset_ids' else '[]'::jsonb end) s where s ~ '^[0-9a-f-]{36}$') w;
  select coalesce(array_agg(distinct asset_id order by asset_id), '{}') into v_have from case_app.case_version_assets where case_version_id = new.id;
  if v_want is distinct from v_have then raise exception 'version_assets_mismatch' using errcode = '23514'; end if;
  return null;
end;
$$;
create constraint trigger case_versions_asset_set after insert on case_app.case_versions deferrable initially deferred
  for each row execute function case_app.guard_version_asset_set();
revoke all on function case_app.guard_version_asset_set() from public, anon, authenticated, service_role;

-- J10 (Julian, 2026-10-15: images in the facilitator's session PDF): where the session's starter (or a configured admin)
-- reads one image the session's own version pins, after the room is gone. P-34 and the starter rule exactly as the record
-- read (read_session_portfolio). The key is always a JPEG: a still's phone copy, or a GIF's or video's poster. A withdrawn
-- or rejected image answers its status and no key.
create function case_api.session_media_rendition(p_user_id uuid, p_session_id uuid, p_asset_id uuid, p_admin boolean, p_admin_email text)
returns table(status text, r2_key text, byte_size integer)
language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare s case_app.sessions; role text;
begin
  select * into s from case_app.sessions where id = p_session_id;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  role := case_app.authorize(p_user_id, s.workspace_id, 'P-34', p_admin, p_admin_email);
  if role <> 'admin' and s.facilitator_id <> p_user_id then raise exception 'not_starter' using errcode = '42501'; end if;
  return query select a.status, case when a.status = 'approved' then r.r2_key end, r.byte_size
    from case_app.case_version_assets cva
    join case_app.assets a on a.id = cva.asset_id and a.workspace_id = s.workspace_id
    join case_app.asset_renditions r on r.asset_id = a.id and r.rendition = case when a.media_type = 'image/jpeg' then 'phone' else 'poster' end
    where cva.case_version_id = s.case_version_id and cva.asset_id = p_asset_id and a.kind in ('image', 'video');
end;
$$;

revoke all on function case_api.room_media_manifest(uuid,uuid,uuid,boolean,text), case_api.session_media_rendition(uuid,uuid,uuid,boolean,text) from public, anon, authenticated, service_role;
grant execute on function case_api.room_media_manifest(uuid,uuid,uuid,boolean,text), case_api.session_media_rendition(uuid,uuid,uuid,boolean,text) to service_role;
commit;
