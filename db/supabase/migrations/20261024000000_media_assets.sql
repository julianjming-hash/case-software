-- Visual evidence media, card 59 M2 (CASE-268; G10 approved by Julian 2026-10-15, re-ruled the same day).
-- Images, animated GIFs and videos are workspace assets stored in a private R2 bucket the Worker alone reads: a still
-- as two JPEG renditions (display, phone); a GIF or video as one cleaned object serving display and phone, plus a JPEG
-- poster. An asset is immutable bytes: re-cropping makes a new asset, and its rights are fixed once a configured admin
-- approves it. Nothing about content or rights is refused (J1, J2 as re-ruled): the author's source, credit and
-- de-identification tick are recorded and shown as warnings; the admin's approval (P-33, audited) is the one gate. The
-- controls on bytes are the Worker's format and size checks.
begin;

-- The stricter approval check below must not meet an approved image that predates it. Read-only pre-check for the
-- operator: select count(*) from case_app.assets where status = 'approved' and kind = 'image'; (expected 0: no upload
-- route existed before this migration). Any such row stops the migration here, with this message, before any change.
do $$
begin
  if exists (select 1 from case_app.assets where status = 'approved' and kind = 'image') then
    raise exception 'media_assets: approved image rows predate this migration; backfill licence, evidence_kind, width and height first' using errcode = '23514';
  end if;
end $$;

alter table case_app.assets
  add column licence text check (licence in ('own-work','CC0-1.0','CC-BY-4.0','CC-BY-SA-4.0','PDM','licensed-other',
    'CC-BY-NC-4.0','CC-BY-NC-SA-4.0','CC-BY-ND-4.0','CC-BY-NC-ND-4.0','unlicensed','unknown')),
  add column creator text check (length(creator) <= 200),
  add column attribution text check (length(attribution) <= 300),
  add column source_url text check (length(source_url) <= 2000 and source_url ~ '^https://[^[:space:]]+$'),
  add column evidence_kind text check (evidence_kind in ('photo','ecg','imaging','diagram','other')),
  add column width integer check (width between 16 and 4096),
  add column height integer check (height between 16 and 4096),
  add column duration_ms integer check (duration_ms between 0 and 121000),
  add column approved_by uuid references case_app.profiles (id) on delete set null,
  add column approved_at timestamptz,
  add column withdrawn_at timestamptz,
  add column withdrawn_reason text check (length(withdrawn_reason) <= 500);
create index assets_approved_by_idx on case_app.assets (approved_by) where approved_by is not null;

alter table case_app.assets drop constraint assets_status_check;
alter table case_app.assets add constraint assets_status_check check (status in ('quarantined','approved','rejected','withdrawn'));
-- Any source can be named (J2 as re-ruled), including an unlicensed publication figure or an unknown source.
alter table case_app.assets drop constraint assets_rights_basis_check;
alter table case_app.assets add constraint assets_rights_basis_check check (rights_basis in
  ('own_work', 'licensed', 'creative_commons', 'public_domain', 'consented_patient', 'stock', 'unlicensed'));
-- The licence names the same source the rights basis does.
alter table case_app.assets add constraint assets_licence_basis check (licence is null or (rights_basis, licence) in (
  ('own_work','own-work'),('consented_patient','own-work'),('creative_commons','CC0-1.0'),('creative_commons','CC-BY-4.0'),
  ('creative_commons','CC-BY-SA-4.0'),('public_domain','PDM'),('licensed','licensed-other'),('creative_commons','CC-BY-NC-4.0'),
  ('creative_commons','CC-BY-NC-SA-4.0'),('creative_commons','CC-BY-ND-4.0'),('creative_commons','CC-BY-NC-ND-4.0'),
  ('unlicensed','unlicensed'),('unlicensed','unknown')));
-- An approved image or video carries its source, licence, pixel size, kind and a text alternative. The
-- de-identification tick is a warning for images and video (Julian, 2026-10-15: "soft warning only"), so approval no
-- longer requires it there; any other asset kind keeps the attestation the platform has always required.
alter table case_app.assets drop constraint assets_approval_complete;
alter table case_app.assets add constraint assets_approval_complete check (
  status <> 'approved' or (
    rights_basis is not null and coalesce(alt_text, transcript) is not null and
    (kind not in ('image','video') or (licence is not null and evidence_kind is not null and width is not null and height is not null and
      nullif(btrim(alt_text), '') is not null)) and
    (kind in ('image','video') or (deidentified_attested_at is not null and
      (deidentified_attested_by is not null or deidentified_attestation_anonymized)))
  )
);
-- Rights and bytes are fixed once approved; only withdrawal (M4) changes an approved image.
create function case_app.guard_approved_asset()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'approved' and new.status = 'approved' and
     -- Person references may still clear when an account is deleted (foreign keys set null); nothing else changes.
     (to_jsonb(new) - 'uploaded_by' - 'deidentified_attested_by' - 'deidentified_attestation_anonymized' - 'approved_by') is distinct from
     (to_jsonb(old) - 'uploaded_by' - 'deidentified_attested_by' - 'deidentified_attestation_anonymized' - 'approved_by') then
    raise exception 'approved_asset_immutable' using errcode = '42501';
  end if;
  if old.status in ('rejected','withdrawn') and new.status <> old.status then
    raise exception 'asset_closed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger assets_approved_immutable before update on case_app.assets for each row execute function case_app.guard_approved_asset();

-- The stored renditions, content-addressed by workspace and SHA-256 with the stored type's extension. Bytes are written
-- before this row. A still has display and phone JPEGs; a GIF or video has one object as display and phone, and a
-- JPEG poster. Each type keeps its own size bound (J3: 12 MB for GIFs; video 25 MB).
create table case_app.asset_renditions (
  asset_id       uuid not null references case_app.assets (id) on delete cascade,
  rendition      text not null check (rendition in ('display','phone','poster')),
  content_type   text not null default 'image/jpeg' check (content_type in ('image/jpeg','image/gif','video/mp4')),
  content_sha256 case_app.sha256 not null,
  byte_size      integer not null check (byte_size between 1 and 26214400),
  width          integer not null check (width between 16 and 4096),
  height         integer not null check (height between 16 and 4096),
  r2_key         text not null check (r2_key ~ '^media/[0-9a-f-]{36}/[0-9a-f]{64}\.(jpg|gif|mp4)$'),
  primary key (asset_id, rendition),
  constraint asset_renditions_type_key check (r2_key like '%.' || case content_type when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif' else 'mp4' end),
  constraint asset_renditions_type_size check (
    (content_type = 'image/jpeg' and byte_size <= 614400 and greatest(width, height) <= 2400) or
    (content_type = 'image/gif' and byte_size <= 12582912) or
    (content_type = 'video/mp4' and greatest(width, height) <= 3840)),
  constraint asset_renditions_poster_jpeg check (rendition <> 'poster' or content_type = 'image/jpeg')
);
create index asset_renditions_key_idx on case_app.asset_renditions (r2_key);
alter table case_app.asset_renditions enable row level security;
revoke all on case_app.asset_renditions from public, anon, authenticated, service_role;

alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check(action in (
 'workspace_create','case_create','draft_save','version_publish','version_withdraw','version_republish','room_start','workspace_ownerless',
 'member_invite','owner_assign','group_create','group_edit','group_archive','case_group',
 'draft_checkpoint_create','draft_checkpoint_delete','draft_checkpoint_restore','builder_candidate_submit','builder_candidate_cancel','builder_candidate_approve','builder_candidate_delete',
 'member_role','member_remove','owner_transfer','asset_approve','asset_reject'));
alter table case_app.workspace_audit drop constraint workspace_audit_target_type_check;
alter table case_app.workspace_audit add constraint workspace_audit_target_type_check
  check (target_type in ('workspace','case','version','room','member','group','checkpoint','candidate','asset'));

create function case_app.media_key(p_workspace_id uuid, p_sha256 case_app.sha256, p_type text default 'image/jpeg')
returns text language sql immutable set search_path = '' as $$
  select 'media/' || p_workspace_id::text || '/' || encode(p_sha256, 'hex') || '.' ||
    case p_type when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif' when 'video/mp4' then 'mp4' end;
$$;
-- Stored bytes of a workspace's images still in use, each object once (a GIF's or video's display and phone are one object).
create function case_app.media_bytes_in_use(p_workspace_id uuid)
returns bigint language sql stable set search_path = '' as $$
  select coalesce(sum(x.byte_size), 0)::bigint from (select distinct on (r.r2_key) r.byte_size from case_app.asset_renditions r
    join case_app.assets a on a.id = r.asset_id where a.workspace_id = p_workspace_id and a.status in ('quarantined', 'approved')) x;
$$;

-- One row per asset, as the Builder lists it. Never includes uploader identity or attestation names.
create function case_app.asset_row(a case_app.assets)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('asset_id', a.id, 'status', a.status, 'kind', a.kind, 'media_type', a.media_type, 'evidence_kind', a.evidence_kind,
    'alt_text', a.alt_text, 'width', a.width, 'height', a.height, 'duration_ms', a.duration_ms, 'licence', a.licence, 'rights_basis', a.rights_basis,
    'creator', a.creator, 'attribution', a.attribution, 'rights_note', a.rights_note, 'source_url', a.source_url, 'created_at', a.created_at,
    'approved_at', a.approved_at, 'withdrawn_at', a.withdrawn_at,
    -- Whether the author ticked de-identification: true only while the tick still has an attester or its anonymous proof.
    'attested', a.deidentified_attested_at is not null and (a.deidentified_attested_by is not null or a.deidentified_attestation_anonymized),
    'renditions', (select jsonb_object_agg(r.rendition, jsonb_build_object('sha256', encode(r.content_sha256, 'hex'), 'type', r.content_type,
      'bytes', r.byte_size, 'width', r.width, 'height', r.height)) from case_app.asset_renditions r where r.asset_id = a.id));
$$;

-- Register an uploaded image, GIF or video after the Worker stored and checked its renditions. Idempotent on the display
-- bytes in a workspace: the same file again returns the existing asset. A withdrawn or rejected file cannot come back.
-- Each rendition is { sha256, bytes, width, height, type }; a GIF or video names one object as display and phone and
-- needs a JPEG poster.
create function case_api.builder_create_asset(p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text,
  p_display jsonb, p_phone jsonb, p_details jsonb, p_poster jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare v_display case_app.sha256; v_phone case_app.sha256; v_existing case_app.assets; v_row case_app.assets;
  v_licence text := p_details->>'licence'; v_type text := coalesce(p_display->>'type', 'image/jpeg'); v_moving boolean;
  v_attested boolean := coalesce((p_details->>'attested')::boolean, false); v_new_bytes bigint;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-14', p_admin, p_admin_email);
  if p_admin then perform case_app.ensure_admin_profile(p_user_id); end if;
  v_moving := v_type in ('image/gif', 'video/mp4');
  if jsonb_typeof(p_display) <> 'object' or jsonb_typeof(p_phone) <> 'object' or jsonb_typeof(p_details) <> 'object' or
     coalesce(p_display->>'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(p_phone->>'sha256', '') !~ '^[0-9a-f]{64}$' or
     v_type not in ('image/jpeg', 'image/gif', 'video/mp4') or coalesce(p_phone->>'type', 'image/jpeg') <> (case when v_moving then v_type else 'image/jpeg' end) or
     -- A GIF or video is one object for display and phone, with a JPEG poster; a still has no poster.
     (v_moving and (p_phone->>'sha256' <> p_display->>'sha256' or jsonb_typeof(p_poster) is distinct from 'object' or
       coalesce(p_poster->>'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(p_poster->>'type', 'image/jpeg') <> 'image/jpeg')) or
     (not v_moving and p_poster is not null and jsonb_typeof(p_poster) <> 'null') or
     (v_type = 'video/mp4' and coalesce(p_details->>'duration_ms', '') !~ '^[0-9]{1,6}$') then
    raise exception 'invalid_asset' using errcode = '22023'; end if;
  v_display := decode(p_display->>'sha256', 'hex'); v_phone := decode(p_phone->>'sha256', 'hex');
  perform pg_advisory_xact_lock(4242, 59);
  select * into v_existing from case_app.assets a where a.workspace_id = p_workspace_id and a.content_sha256 = v_display;
  if found then
    -- 23505: this exact file is already known to the workspace, and closed.
    if v_existing.status in ('rejected','withdrawn') then raise exception 'asset_closed' using errcode = '23505'; end if;
    return case_app.asset_row(v_existing) || jsonb_build_object('created', false);
  end if;
  -- Red-team S5: a new asset may not name a stored file another asset already names (a decoy sharing a key would keep
  -- its bytes alive through the other's takedown). Re-uploading the same display file is the asset above, not a new one.
  if exists (select 1 from case_app.asset_renditions r where r.r2_key in (case_app.media_key(p_workspace_id, v_display, v_type),
      case_app.media_key(p_workspace_id, v_phone, case when v_moving then v_type else 'image/jpeg' end),
      case when v_moving then case_app.media_key(p_workspace_id, decode(p_poster->>'sha256', 'hex')) end)) then
    raise exception 'rendition_in_use' using errcode = '40001'; end if;
  -- Bounds: 60 uploads an hour per person, 1 GiB of stored objects per workspace.
  if (select count(*) from case_app.assets a where a.uploaded_by = p_user_id and a.created_at > clock_timestamp() - interval '1 hour') >= 60 then
    raise exception 'media_rate' using errcode = '23514'; end if;
  v_new_bytes := (p_display->>'bytes')::bigint + case when v_moving then (p_poster->>'bytes')::bigint else (p_phone->>'bytes')::bigint end;
  -- Only images still in use count against the workspace (red-team S8); closed ones are being deleted.
  if case_app.media_bytes_in_use(p_workspace_id) + v_new_bytes > 1073741824 then
    raise exception 'media_quota' using errcode = '23514'; end if;
  insert into case_app.assets (workspace_id, uploaded_by, kind, media_type, byte_size, content_sha256, r2_key, status, rights_basis, rights_note,
      deidentified_attested_by, deidentified_attested_at, alt_text, licence, creator, attribution, source_url, evidence_kind, width, height, duration_ms)
    values (p_workspace_id, p_user_id, case when v_type = 'video/mp4' then 'video' else 'image' end, v_type, (p_display->>'bytes')::bigint, v_display,
      case_app.media_key(p_workspace_id, v_display, v_type), 'quarantined', p_details->>'rights_basis', nullif(p_details->>'rights_note', ''),
      case when v_attested then p_user_id end, case when v_attested then clock_timestamp() end, p_details->>'alt_text', v_licence,
      nullif(p_details->>'creator', ''), nullif(p_details->>'attribution', ''), nullif(p_details->>'source_url', ''), p_details->>'evidence_kind',
      (p_display->>'width')::integer, (p_display->>'height')::integer, case when v_type = 'video/mp4' then (p_details->>'duration_ms')::integer end)
    returning * into v_row;
  insert into case_app.asset_renditions (asset_id, rendition, content_type, content_sha256, byte_size, width, height, r2_key) values
    (v_row.id, 'display', v_type, v_display, (p_display->>'bytes')::integer, (p_display->>'width')::integer, (p_display->>'height')::integer,
      case_app.media_key(p_workspace_id, v_display, v_type)),
    (v_row.id, 'phone', case when v_moving then v_type else 'image/jpeg' end, v_phone, (p_phone->>'bytes')::integer, (p_phone->>'width')::integer,
      (p_phone->>'height')::integer, case_app.media_key(p_workspace_id, v_phone, case when v_moving then v_type else 'image/jpeg' end));
  if v_moving then
    insert into case_app.asset_renditions (asset_id, rendition, content_type, content_sha256, byte_size, width, height, r2_key) values
      (v_row.id, 'poster', 'image/jpeg', decode(p_poster->>'sha256', 'hex'), (p_poster->>'bytes')::integer, (p_poster->>'width')::integer,
        (p_poster->>'height')::integer, case_app.media_key(p_workspace_id, decode(p_poster->>'sha256', 'hex')));
  end if;
  -- What every row needs to be approvable later; rights cautions and the tick are warnings, never checked here.
  if v_row.rights_basis is null or v_row.licence is null or v_row.evidence_kind is null or nullif(btrim(v_row.alt_text), '') is null then
    raise exception 'asset_details_incomplete' using errcode = '22023'; end if;
  return case_app.asset_row(v_row) || jsonb_build_object('created', true);
end;
$$;

-- Every stored rendition is allowed here first, before the Worker writes a byte (red-team S2, B1): at most 150 stored
-- renditions an hour per person, the workspace's 1 GiB of images still in use, and never again a file that was
-- rejected or withdrawn in this workspace while no live image uses it. The Worker has already checked the bytes against
-- their type's own bound; 25 MB (a video) is the largest any type allows.
create table case_app.media_put_log (
  user_id      uuid not null,
  workspace_id uuid not null,
  at           timestamptz not null default clock_timestamp()
);
create index media_put_log_user_idx on case_app.media_put_log (user_id, at);
alter table case_app.media_put_log enable row level security;
revoke all on case_app.media_put_log from public, anon, authenticated, service_role;

create function case_api.builder_media_put_allowance(p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text, p_sha256 text, p_bytes integer,
  p_type text default 'image/jpeg')
returns boolean language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_key text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-14', p_admin, p_admin_email);
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes not between 1 and 26214400 or
     coalesce(p_type, '') not in ('image/jpeg', 'image/gif', 'video/mp4') then raise exception 'invalid_rendition' using errcode = '22023'; end if;
  v_key := case_app.media_key(p_workspace_id, decode(p_sha256, 'hex'), p_type);
  perform pg_advisory_xact_lock(4242, 59);
  delete from case_app.media_put_log where at < clock_timestamp() - interval '1 hour';
  if (select count(*) from case_app.media_put_log l where l.user_id = p_user_id) >= 150 then raise exception 'media_rate' using errcode = '23514'; end if;
  if exists (select 1 from case_app.asset_renditions r join case_app.assets a on a.id = r.asset_id where r.r2_key = v_key and a.status in ('rejected', 'withdrawn'))
     and not exists (select 1 from case_app.asset_renditions r join case_app.assets a on a.id = r.asset_id where r.r2_key = v_key and a.status in ('quarantined', 'approved')) then
    raise exception 'asset_closed' using errcode = '23505';
  end if;
  if case_app.media_bytes_in_use(p_workspace_id) + p_bytes > 1073741824 then
    raise exception 'media_quota' using errcode = '23514';
  end if;
  insert into case_app.media_put_log (user_id, workspace_id) values (p_user_id, p_workspace_id);
  return true;
end;
$$;

-- A published version pins at most 64 images or videos and 150 MiB of stored objects (red-team S3; raised from 12 MiB
-- for 25 MB videos, Julian 2026-10-15). Checked as each pin is written, so a release over the limit rolls back whole.
create function case_app.guard_version_media()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select count(*) from case_app.case_version_assets v join case_app.assets a on a.id = v.asset_id where v.case_version_id = new.case_version_id and a.kind in ('image', 'video')) > 64
     or (select coalesce(sum(x.byte_size), 0) from (select distinct on (r.r2_key) r.byte_size from case_app.case_version_assets v
          join case_app.asset_renditions r on r.asset_id = v.asset_id where v.case_version_id = new.case_version_id) x) > 157286400 then
    raise exception 'version_media_limit' using errcode = '23514';
  end if;
  return null;
end;
$$;
create trigger case_version_assets_media_limit after insert on case_app.case_version_assets for each row execute function case_app.guard_version_media();

-- The workspace's images, newest first, or exactly the requested ids (a Pending review lists a candidate's images).
create function case_api.builder_list_assets(p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text, p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-14', p_admin, p_admin_email);
  if p_ids is not null and cardinality(p_ids) > 64 then raise exception 'invalid_asset' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(case_app.asset_row(a) order by a.created_at desc, a.id desc) from case_app.assets a
    where a.id in (select b.id from case_app.assets b where b.workspace_id = p_workspace_id and b.kind in ('image', 'video')
      and (p_ids is null or b.id = any (p_ids)) order by b.created_at desc, b.id desc limit 200)), '[]'::jsonb);
end;
$$;

-- Where the Builder reads one rendition's bytes. A withdrawn or rejected image answers its status and no key.
create function case_api.builder_asset_rendition(p_workspace_id uuid, p_asset_id uuid, p_rendition text, p_user_id uuid, p_admin boolean, p_admin_email text)
returns table(status text, r2_key text, content_sha256 text, byte_size integer, content_type text)
language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-14', p_admin, p_admin_email);
  return query select a.status, case when a.status in ('quarantined','approved') then r.r2_key end,
      case when a.status in ('quarantined','approved') then encode(r.content_sha256, 'hex') end, r.byte_size, r.content_type
    from case_app.assets a join case_app.asset_renditions r on r.asset_id = a.id and r.rendition = p_rendition
    where a.id = p_asset_id and a.workspace_id = p_workspace_id;
end;
$$;

-- A configured admin approves or rejects a quarantined image (J7), audited in the same transaction.
create function case_api.admin_review_asset(p_workspace_id uuid, p_asset_id uuid, p_decision text, p_user_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_row case_app.assets;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-33', p_admin, p_admin_email);
  if p_decision not in ('approve','reject') then raise exception 'invalid_decision' using errcode = '22023'; end if;
  perform case_app.ensure_admin_profile(p_user_id);
  select * into v_row from case_app.assets a where a.id = p_asset_id and a.workspace_id = p_workspace_id for update;
  if not found then raise exception 'asset_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'quarantined' then raise exception 'asset_not_pending' using errcode = '40001'; end if;
  update case_app.assets set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      approved_by = case when p_decision = 'approve' then p_user_id end, approved_at = case when p_decision = 'approve' then clock_timestamp() end
    where id = p_asset_id returning * into v_row;
  perform case_app.audit_admin(p_workspace_id, p_user_id, p_admin_email, 'asset_' || p_decision, 'asset', p_asset_id);
  return case_app.asset_row(v_row);
end;
$$;

revoke all on function case_app.guard_version_media() from public, anon, authenticated, service_role;
revoke all on function case_api.builder_media_put_allowance(uuid,uuid,boolean,text,text,integer,text) from public, anon, authenticated, service_role;
grant execute on function case_api.builder_media_put_allowance(uuid,uuid,boolean,text,text,integer,text) to service_role;
revoke all on function case_app.guard_approved_asset(), case_app.media_key(uuid, case_app.sha256, text), case_app.asset_row(case_app.assets),
  case_app.media_bytes_in_use(uuid) from public, anon, authenticated, service_role;
revoke all on function case_api.builder_create_asset(uuid,uuid,boolean,text,jsonb,jsonb,jsonb,jsonb), case_api.builder_list_assets(uuid,uuid,boolean,text,uuid[]),
  case_api.builder_asset_rendition(uuid,uuid,text,uuid,boolean,text), case_api.admin_review_asset(uuid,uuid,text,uuid,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function case_api.builder_create_asset(uuid,uuid,boolean,text,jsonb,jsonb,jsonb,jsonb), case_api.builder_list_assets(uuid,uuid,boolean,text,uuid[]),
  case_api.builder_asset_rendition(uuid,uuid,text,uuid,boolean,text), case_api.admin_review_asset(uuid,uuid,text,uuid,boolean,text)
  to service_role;
commit;
