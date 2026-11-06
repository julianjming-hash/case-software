-- Image retention and takedown, card 59 M4 (CASE-270; Julian's J8). A configured admin withdraws an image with a
-- recorded step-up (P-16): it becomes `withdrawn` (audited with the elevation), and its stored renditions are queued for
-- deletion. The Worker deletes queued bytes at once on withdrawal and again on its hourly sweep, which also queues
-- rejected images and images left unapproved for 30 days. Rows stay as tombstones; rooms then answer 410. A key another
-- live image still uses is never queued or deleted.
begin;

create table case_app.media_purge_queue (
  r2_key     text primary key check (r2_key ~ '^media/[0-9a-f-]{36}/[0-9a-f]{64}\.(jpg|gif|mp4)$'),
  reason     text not null check (reason in ('withdrawn', 'rejected', 'abandoned')),
  queued_at  timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  done_at    timestamptz
);
create index media_purge_queue_open_idx on case_app.media_purge_queue (queued_at) where done_at is null;
alter table case_app.media_purge_queue enable row level security;
revoke all on case_app.media_purge_queue from public, anon, authenticated, service_role;

-- Queue an asset's keys that no other quarantined or approved image uses. A small image's display and phone copies can
-- be the same bytes, so one key is queued once.
create function case_app.enqueue_asset_keys(p_asset_id uuid, p_reason text)
returns setof text language sql set search_path = '' as $$
  insert into case_app.media_purge_queue (r2_key, reason)
  select distinct r.r2_key, p_reason from case_app.asset_renditions r where r.asset_id = p_asset_id
    and not exists (select 1 from case_app.asset_renditions o join case_app.assets a on a.id = o.asset_id
      where o.r2_key = r.r2_key and o.asset_id <> p_asset_id and a.status in ('quarantined', 'approved'))
  on conflict (r2_key) do update set done_at = null, claimed_at = null
  returning r2_key;
$$;

-- Admin takedown (J8): withdrawn for every past and future room, bytes queued, audited with the step-up elevation.
create function case_api.admin_withdraw_asset(p_workspace_id uuid, p_asset_id uuid, p_reason text, p_user_id uuid, p_admin boolean, p_admin_email text, p_elevation_id uuid)
returns table(asset_id uuid, status text, r2_key text)
language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_row case_app.assets;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-16', p_admin, p_admin_email);
  -- An owner's withdrawal with an owner step-up is a later card (P-16 owner, card 32); today only the admin path runs.
  if not coalesce(p_admin, false) then raise exception 'not_authorised: image withdrawal is admin only' using errcode = '42501'; end if;
  perform case_app.assert_elevation(p_elevation_id, p_admin_email, 'admin');
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'invalid_reason' using errcode = '22023'; end if;
  -- The registration lock (red-team S5): no new image can name these files while they are being queued.
  perform pg_advisory_xact_lock(4242, 59);
  select * into v_row from case_app.assets a where a.id = p_asset_id and a.workspace_id = p_workspace_id for update;
  if not found then raise exception 'asset_not_found' using errcode = 'P0002'; end if;
  if v_row.status not in ('quarantined', 'approved') then raise exception 'asset_not_withdrawable' using errcode = '40001'; end if;
  update case_app.assets set status = 'withdrawn', withdrawn_at = clock_timestamp(), withdrawn_reason = btrim(p_reason) where id = p_asset_id;
  perform case_app.audit_admin(p_workspace_id, p_user_id, p_admin_email, 'asset_withdraw', 'asset', p_asset_id, null, p_elevation_id);
  return query select p_asset_id, 'withdrawn'::text, k from case_app.enqueue_asset_keys(p_asset_id, 'withdrawn') k;
end;
$$;

-- A rejected image's bytes are queued as soon as it is rejected (M2's review, unchanged otherwise).
create or replace function case_api.admin_review_asset(p_workspace_id uuid, p_asset_id uuid, p_decision text, p_user_id uuid, p_admin boolean, p_admin_email text)
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
  if p_decision = 'reject' then perform case_app.enqueue_asset_keys(p_asset_id, 'rejected'); end if;
  perform case_app.audit_admin(p_workspace_id, p_user_id, p_admin_email, 'asset_' || p_decision, 'asset', p_asset_id);
  return case_app.asset_row(v_row);
end;
$$;

-- The hourly sweep (system actor): an image left unapproved for 30 days is closed and its bytes queued; then a bounded
-- batch of due keys is leased to the Worker. A key a live image uses again is skipped, never deleted.
create function case_api.media_purge_claim(p_limit integer)
returns table(r2_key text) language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare v_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'invalid_limit' using errcode = '22023'; end if;
  for v_id in select a.id from case_app.assets a where a.status = 'quarantined' and a.created_at < clock_timestamp() - interval '30 days' order by a.created_at limit 200 loop
    -- Only an image still quarantined is closed: one an admin approved meanwhile is left alone (red-team S5).
    update case_app.assets set status = 'rejected' where id = v_id and status = 'quarantined';
    if found then perform case_app.enqueue_asset_keys(v_id, 'abandoned'); end if;
  end loop;
  return query
    update case_app.media_purge_queue q set claimed_at = clock_timestamp()
    where q.r2_key in (select x.r2_key from case_app.media_purge_queue x
        where x.done_at is null and (x.claimed_at is null or x.claimed_at < clock_timestamp() - interval '15 minutes')
          and not exists (select 1 from case_app.asset_renditions o join case_app.assets a on a.id = o.asset_id where o.r2_key = x.r2_key and a.status in ('quarantined', 'approved'))
        order by x.queued_at limit p_limit for update skip locked)
    returning q.r2_key;
end;
$$;
create function case_api.media_purge_complete(p_keys text[])
returns integer language sql security definer set search_path = '' set statement_timeout = '2s' as $$
  with done as (update case_app.media_purge_queue set done_at = clock_timestamp() where r2_key = any (coalesce(p_keys, '{}')) and claimed_at is not null and done_at is null returning 1)
  select count(*)::integer from done;
$$;
-- Which of these stored keys a quarantined or approved image names. Any other object (never registered, or the file
-- of a closed image stored again) is deleted by the Worker once it is a day old (red-team B1).
create function case_api.media_known_keys(p_keys text[])
returns table(r2_key text) language sql stable security definer set search_path = '' set statement_timeout = '2s' as $$
  select distinct r.r2_key from case_app.asset_renditions r join case_app.assets a on a.id = r.asset_id
    where r.r2_key = any (coalesce(p_keys, '{}')) and a.status in ('quarantined', 'approved');
$$;

-- Where the orphan walk resumes (red-team B2): the last key it reached, or '' to start again at the beginning. Any key
-- under media/ is a valid position, so a stray object the walk cannot parse never wedges it.
create table case_app.media_sweep_state (
  singleton    boolean primary key default true check (singleton),
  start_after  text not null default '' check (start_after = '' or (start_after like 'media/_%' and octet_length(start_after) <= 1024)),
  updated_at   timestamptz not null default clock_timestamp()
);
alter table case_app.media_sweep_state enable row level security;
revoke all on case_app.media_sweep_state from public, anon, authenticated, service_role;
create function case_api.media_sweep_position(p_start_after text)
returns table(resume_after text) language plpgsql security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_previous text;
begin
  select start_after into v_previous from case_app.media_sweep_state where singleton for update;
  if p_start_after is not null then
    insert into case_app.media_sweep_state (singleton, start_after, updated_at) values (true, p_start_after, clock_timestamp())
      on conflict (singleton) do update set start_after = excluded.start_after, updated_at = excluded.updated_at;
  end if;
  return query select coalesce(v_previous, '');
end;
$$;

-- An approved image is never closed except by withdrawal (red-team S5): approved -> rejected, the sweep's transition, is
-- refused. It may go back to quarantine for a fresh attestation (Card 21a), which only stops it being served.
create or replace function case_app.guard_approved_asset()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'approved' and new.status not in ('approved', 'quarantined', 'withdrawn') then
    raise exception 'approved_asset_immutable' using errcode = '42501';
  end if;
  if old.status = 'approved' and new.status = 'approved' and
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

alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check(action in (
 'workspace_create','case_create','draft_save','version_publish','version_withdraw','version_republish','room_start','workspace_ownerless',
 'member_invite','owner_assign','group_create','group_edit','group_archive','case_group',
 'draft_checkpoint_create','draft_checkpoint_delete','draft_checkpoint_restore','builder_candidate_submit','builder_candidate_cancel','builder_candidate_approve','builder_candidate_delete',
 'member_role','member_remove','owner_transfer','asset_approve','asset_reject','asset_withdraw'));

revoke all on function case_app.enqueue_asset_keys(uuid, text) from public, anon, authenticated, service_role;
revoke all on function case_api.admin_withdraw_asset(uuid,uuid,text,uuid,boolean,text,uuid), case_api.media_purge_claim(integer),
  case_api.media_purge_complete(text[]), case_api.media_known_keys(text[]), case_api.media_sweep_position(text) from public, anon, authenticated, service_role;
grant execute on function case_api.admin_withdraw_asset(uuid,uuid,text,uuid,boolean,text,uuid), case_api.media_purge_claim(integer),
  case_api.media_purge_complete(text[]), case_api.media_known_keys(text[]), case_api.media_sweep_position(text) to service_role;
commit;
