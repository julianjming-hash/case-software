-- Card 21a: account cutoff, anonymous historical attribution, and admin audit.
-- Auth deletion remains external-first. This migration changes no applied file.
begin;

alter table case_app.profiles
  add column disabled_at timestamptz,
  add column soft_deleted_at timestamptz,
  add column delete_due_at timestamptz,
  add column admin_revision bigint not null default 0,
  add column admin_delete_claim_id uuid,
  add column admin_delete_claimed_at timestamptz,
  add constraint profiles_admin_delete_claim_ck check (
    (admin_delete_claim_id is null and admin_delete_claimed_at is null) or
    (admin_delete_claim_id is not null and admin_delete_claimed_at is not null and
     disabled_at is not null and soft_deleted_at is not null and delete_due_at is not null)
  ),
  add constraint profiles_admin_revision_ck check (admin_revision >= 0),
  add constraint profiles_soft_delete_ck check (
    (soft_deleted_at is null and delete_due_at is null) or
      (soft_deleted_at is not null and disabled_at is not null and delete_due_at is not null and
      delete_due_at = soft_deleted_at + interval '30 days')
  );
create index profiles_due_delete_idx on case_app.profiles (delete_due_at)
  where delete_due_at is not null;

-- A fresh invite has an Auth user but may not yet have a Case profile. A deleted
-- Auth user with an unexpired JWT does not pass, and cannot recreate its profile.
create function case_api.admin_account_active(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
      left join case_app.profiles p on p.id = u.id
     where u.id = p_user_id and p.disabled_at is null and p.soft_deleted_at is null
  );
$$;

create function case_api.admin_teaching_workspace_exists(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_workspace_id is not null and exists (
    select 1 from case_app.workspaces w where w.id = p_workspace_id
  );
$$;

-- Called only after a successful or already-existing GoTrue invite. No role is
-- downgraded, and a missing Auth user or selected workspace cannot be created.
create function case_api.admin_provision_facilitator(
  p_user_id uuid, p_workspace_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_workspace_id is null or
     p_workspace_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     not exists (select 1 from auth.users u where u.id = p_user_id) or
     not exists (select 1 from case_app.workspaces w where w.id = p_workspace_id) then
    raise exception 'invalid_teaching_workspace_or_user' using errcode = '22023';
  end if;
  if exists (select 1 from case_app.profiles p where p.id = p_user_id and
      (p.disabled_at is not null or p.soft_deleted_at is not null)) then
    raise exception 'account_not_active' using errcode = '42501';
  end if;
  insert into case_app.profiles (id, display_name) values (p_user_id, 'Facilitator')
    on conflict (id) do nothing;
  insert into case_app.workspace_members (workspace_id, user_id, role)
    values (p_workspace_id, p_user_id, 'facilitator')
    on conflict (workspace_id, user_id) do nothing;
end;
$$;

-- Only administrative state is projected; invited Auth users may not have a profile yet.
create function case_api.admin_read_profiles(p_user_ids uuid[])
returns table (user_id uuid, disabled_at timestamptz, soft_deleted_at timestamptz,
  delete_due_at timestamptz, admin_revision bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_user_ids is null or cardinality(p_user_ids)>1000 or array_position(p_user_ids,null) is not null then
    raise exception 'invalid_profile_read' using errcode='22023'; end if;
  return query select p.id,p.disabled_at,p.soft_deleted_at,p.delete_due_at,p.admin_revision
    from case_app.profiles p where p.id=any(p_user_ids) order by p.id;
end;
$$;
revoke all on function case_api.admin_read_profiles(uuid[]) from public,anon,authenticated,service_role;
grant execute on function case_api.admin_read_profiles(uuid[]) to service_role;

create function case_api.list_admin_due_profiles(p_limit integer default 100,p_after uuid default null)
returns table (user_id uuid,disabled_at timestamptz,soft_deleted_at timestamptz,
  delete_due_at timestamptz,admin_revision bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'invalid_due_profile_page' using errcode='22023'; end if;
  return query select p.id,p.disabled_at,p.soft_deleted_at,p.delete_due_at,p.admin_revision
    from case_app.profiles p where p.disabled_at is not null and p.soft_deleted_at is not null
      and p.delete_due_at<=clock_timestamp() and p.admin_delete_claim_id is null
      and (p_after is null or p.id>p_after)
    order by p.id asc limit p_limit;
end;
$$;
revoke all on function case_api.list_admin_due_profiles(integer,uuid) from public,anon,authenticated,service_role;
grant execute on function case_api.list_admin_due_profiles(integer,uuid) to service_role;

create function case_api.admin_delete_due_profile(p_user_id uuid,p_expected_revision bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_profile case_app.profiles%rowtype;
begin
  if p_user_id is null or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9999999999 then
    raise exception 'invalid_profile_deletion' using errcode='22023'; end if;
  select * into current_profile from case_app.profiles where id=p_user_id for update;
  -- Auth absence is required even on the idempotent, already-cascaded profile path.
  if exists(select 1 from auth.users where id=p_user_id) then return false; end if;
  if not found then return true; end if;
  if current_profile.admin_delete_claim_id is null or
     current_profile.admin_revision<>p_expected_revision or current_profile.disabled_at is null or
     current_profile.soft_deleted_at is null or current_profile.delete_due_at is null or
     current_profile.delete_due_at<>current_profile.soft_deleted_at+interval '30 days' or
     current_profile.delete_due_at>clock_timestamp() then return false; end if;
  delete from case_app.profiles where id=p_user_id;
  return true;
end;
$$;
revoke all on function case_api.admin_delete_due_profile(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function case_api.admin_delete_due_profile(uuid,bigint) to service_role;


-- The expected revision is the admin compare-and-swap arbiter. A profile is
-- never created by this path; a fresh invited user provisions one on first use.
create function case_api.admin_transition_profile(
  p_user_id uuid, p_expected_revision bigint, p_action text
) returns table (
  user_id uuid, disabled_at timestamptz, soft_deleted_at timestamptz,
  delete_due_at timestamptz, admin_revision bigint
) language plpgsql security definer set search_path = '' as $$
declare p case_app.profiles%rowtype;
begin
  if p_user_id is null or p_expected_revision is null or p_expected_revision < 0 or
     p_action is null or p_action not in ('disable', 'enable', 'soft_delete', 'restore') then
    raise exception 'invalid_admin_transition' using errcode = '22023';
  end if;
  select * into p from case_app.profiles where id = p_user_id for update;
  if not found then raise exception 'missing_profile' using errcode = '22023'; end if;
  if p.admin_delete_claim_id is not null then
    raise exception 'profile_deletion_claimed' using errcode='23514'; end if;
  if p.admin_revision <> p_expected_revision then
    raise exception 'stale_admin_revision' using errcode = '40001';
  end if;
  if p_action = 'disable' then
    if p.disabled_at is not null or p.soft_deleted_at is not null then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = now(), admin_revision = t.admin_revision + 1
      where t.id = p_user_id;
  elsif p_action = 'enable' then
    if p.disabled_at is null or p.soft_deleted_at is not null then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = null, admin_revision = t.admin_revision + 1
      where t.id = p_user_id;
  elsif p_action = 'soft_delete' then
    if p.soft_deleted_at is not null then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = coalesce(t.disabled_at, now()),
      soft_deleted_at = now(), delete_due_at = now() + interval '30 days',
      admin_revision = t.admin_revision + 1 where t.id = p_user_id;
  else
    if p.soft_deleted_at is null or p.delete_due_at <= clock_timestamp() then
      raise exception 'invalid_admin_state' using errcode = '23514'; end if;
    update case_app.profiles t set disabled_at = null, soft_deleted_at = null,
      delete_due_at = null, admin_revision = t.admin_revision + 1 where t.id = p_user_id;
  end if;
  return query select t.id, t.disabled_at, t.soft_deleted_at, t.delete_due_at,
    t.admin_revision from case_app.profiles t where t.id = p_user_id;
end;
$$;

-- Compensating a known provider rollback is a new compare-and-swap revision.
create function case_api.admin_revert_profile(
  p_user_id uuid,p_expected_revision bigint,p_disabled_at timestamptz,
  p_soft_deleted_at timestamptz,p_delete_due_at timestamptz
) returns table (user_id uuid,disabled_at timestamptz,soft_deleted_at timestamptz,
  delete_due_at timestamptz,admin_revision bigint)
language plpgsql security definer set search_path = '' as $$
declare current_profile case_app.profiles%rowtype;
begin
  if p_user_id is null or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9999999998 or
     (p_soft_deleted_at is null and p_delete_due_at is not null) or
     (p_soft_deleted_at is not null and (p_disabled_at is null or p_delete_due_at is null or
       p_delete_due_at<>p_soft_deleted_at+interval '30 days')) then
    raise exception 'invalid_profile_compensation' using errcode='22023'; end if;
  select * into current_profile from case_app.profiles where id=p_user_id for update;
  if not found then raise exception 'missing_profile' using errcode='22023'; end if;
  if current_profile.admin_delete_claim_id is not null then
    raise exception 'profile_deletion_claimed' using errcode='23514'; end if;
  if current_profile.admin_revision<>p_expected_revision then
    raise exception 'stale_admin_revision' using errcode='40001'; end if;
  update case_app.profiles p set disabled_at=p_disabled_at,soft_deleted_at=p_soft_deleted_at,
    delete_due_at=p_delete_due_at,admin_revision=p.admin_revision+1 where p.id=p_user_id;
  return query select p.id,p.disabled_at,p.soft_deleted_at,p.delete_due_at,p.admin_revision
    from case_app.profiles p where p.id=p_user_id;
end;
$$;
revoke all on function case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz) to service_role;

-- Historical rows keep their immutable documents and aggregates after the
-- identifying Auth/profile row is hard-deleted. Membership still cascades.
alter table case_app.cases alter column owner_id drop not null;
alter table case_app.cases drop constraint cases_owner_id_fkey;
alter table case_app.cases add constraint cases_owner_id_fkey
  foreign key (owner_id) references case_app.profiles (id) on delete set null;

alter table case_app.case_drafts alter column updated_by drop not null;
alter table case_app.case_drafts drop constraint case_drafts_updated_by_fkey;
alter table case_app.case_drafts add constraint case_drafts_updated_by_fkey
  foreign key (updated_by) references case_app.profiles (id) on delete set null;

alter table case_app.case_versions alter column published_by drop not null;
alter table case_app.case_versions drop constraint case_versions_published_by_fkey;
alter table case_app.case_versions add constraint case_versions_published_by_fkey
  foreign key (published_by) references case_app.profiles (id) on delete set null;

alter table case_app.assets alter column uploaded_by drop not null;
alter table case_app.assets drop constraint assets_uploaded_by_fkey;
alter table case_app.assets add constraint assets_uploaded_by_fkey
  foreign key (uploaded_by) references case_app.profiles (id) on delete set null;
alter table case_app.assets drop constraint assets_deidentified_attested_by_fkey;
alter table case_app.assets add constraint assets_deidentified_attested_by_fkey
  foreign key (deidentified_attested_by) references case_app.profiles (id) on delete set null;

alter table case_app.sources alter column created_by drop not null;
alter table case_app.sources drop constraint sources_created_by_fkey;
alter table case_app.sources add constraint sources_created_by_fkey
  foreign key (created_by) references case_app.profiles (id) on delete set null;

alter table case_app.agent_runs alter column requested_by drop not null;
alter table case_app.agent_runs drop constraint agent_runs_requested_by_fkey;
alter table case_app.agent_runs add constraint agent_runs_requested_by_fkey
  foreign key (requested_by) references case_app.profiles (id) on delete set null;

alter table case_app.agent_proposal_groups drop constraint agent_proposal_groups_decided_by_fkey;
alter table case_app.agent_proposal_groups add constraint agent_proposal_groups_decided_by_fkey
  foreign key (decided_by) references case_app.profiles (id) on delete set null;

alter table case_app.sessions alter column facilitator_id drop not null;
alter table case_app.sessions drop constraint sessions_facilitator_id_fkey;
alter table case_app.sessions add constraint sessions_facilitator_id_fkey
  foreign key (facilitator_id) references case_app.profiles (id) on delete set null;

-- The one permitted change to a published version is the FK action that nulls
-- deleted attribution. It cannot change document bytes, hash or any other field.
create function case_app.guard_version_anonymization()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 and
     old.published_by is not null and new.published_by is null and
     not exists (select 1 from case_app.profiles p where p.id = old.published_by) and
     (to_jsonb(new) - 'published_by') = (to_jsonb(old) - 'published_by') then
    return new;
  end if;
  raise exception 'case_versions is immutable' using errcode = '42501';
end;
$$;
drop trigger case_versions_immutable on case_app.case_versions;
create trigger case_versions_immutable
  before update or delete on case_app.case_versions
  for each row execute function case_app.guard_version_anonymization();

-- A deleted attester remains represented only by an anonymous proof bit and
-- timestamp. Direct flag insertion or updates cannot manufacture that proof.
alter table case_app.assets add column deidentified_attestation_anonymized boolean not null default false;
alter table case_app.assets drop constraint assets_approval_complete;
alter table case_app.assets add constraint assets_approval_complete check (
  status <> 'approved' or (
    rights_basis is not null and deidentified_attested_at is not null and
    (deidentified_attested_by is not null or deidentified_attestation_anonymized) and
    coalesce(alt_text, transcript) is not null
  )
);
create function case_app.guard_asset_attestation_anonymity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.deidentified_attestation_anonymized then
      raise exception 'anonymous attestation cannot be inserted' using errcode = '42501';
    end if;
    return new;
  end if;
  if not old.deidentified_attestation_anonymized and new.deidentified_attestation_anonymized then
    if pg_trigger_depth() <= 1 or old.deidentified_attested_by is null or
       new.deidentified_attested_by is not null or
       exists (select 1 from case_app.profiles p where p.id = old.deidentified_attested_by) or
       (to_jsonb(new) - 'deidentified_attested_by' - 'deidentified_attestation_anonymized') <>
       (to_jsonb(old) - 'deidentified_attested_by' - 'deidentified_attestation_anonymized') then
      raise exception 'anonymous attestation requires profile deletion' using errcode = '42501';
    end if;
  elsif old.deidentified_attestation_anonymized then
    if new.status <> 'approved' then
      new.deidentified_attestation_anonymized := false;
    elsif not new.deidentified_attestation_anonymized or
       (new.kind, new.media_type, new.byte_size, new.content_sha256, new.r2_key,
        new.rights_basis, new.rights_note, new.deidentified_attested_at) is distinct from
       (old.kind, old.media_type, old.byte_size, old.content_sha256, old.r2_key,
        old.rights_basis, old.rights_note, old.deidentified_attested_at) then
      raise exception 'approved anonymous attestation is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger assets_anonymous_attestation
  before insert or update on case_app.assets
  for each row execute function case_app.guard_asset_attestation_anonymity();

-- The FK SET NULL action needs to mark the preserved attestation at the same
-- instant, before the approval check evaluates the updated row.
create function case_app.mark_deleted_asset_attester()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deidentified_attested_by is not null and new.deidentified_attested_by is null and
     pg_trigger_depth() > 1 and
     not exists (select 1 from case_app.profiles p where p.id = old.deidentified_attested_by) and
     (to_jsonb(new) - 'deidentified_attested_by') =
       (to_jsonb(old) - 'deidentified_attested_by') then
    new.deidentified_attestation_anonymized := true;
  end if;
  return new;
end;
$$;
create trigger assets_deleted_attester
  before update on case_app.assets
  for each row execute function case_app.mark_deleted_asset_attester();
revoke all on function case_app.guard_version_anonymization(),
  case_app.guard_asset_attestation_anonymity(),
  case_app.mark_deleted_asset_attester()
  from public, anon, authenticated, service_role;

-- Administrative audit never accepts pack, participant, token, name, note or
-- raw GoTrue data. State snapshots are small flat administrative scalars only.
create function case_app.admin_audit_snapshot_ok(p_value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare field record; v text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' or
     pg_column_size(p_value) > 2048 then return false; end if;
  for field in select key, value from jsonb_each(p_value) loop
    v := field.value #>> '{}';
    if field.key = 'status' then
      if jsonb_typeof(field.value) <> 'string' or v not in
         ('active','disabled','soft_deleted','restored','invited','withdrawn',
          'published','ended','accepted','rejected','rate_limited','unknown',
          'reconciliation_needed','completed','failed','unknown_outcome',
          'manual_reconciliation_needed') then return false; end if;
    elsif field.key = 'email' then
      if jsonb_typeof(field.value) <> 'string' or length(v) > 320 or
         v !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$' then
        return false; end if;
    elsif field.key in ('admin_revision','version_no') then
      if jsonb_typeof(field.value) <> 'number' or v !~ '^[0-9]{1,10}$' then
        return false; end if;
    else return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function case_app.admin_audit_snapshot_ok(jsonb)
  from public, anon, authenticated, service_role;

create table case_app.admin_audit_log (
  id uuid primary key default case_app.uuid_v7(),
  intent_id uuid,
  phase text not null check (phase in ('intent','outcome','attempt')),
  action text not null check (action in (
    'stepup_start','stepup_verify','facilitator_invite','facilitator_resend',
    'facilitator_disable','facilitator_enable','facilitator_soft_delete',
    'facilitator_restore','facilitator_hard_delete','case_publish',
    'version_withdraw','room_end')),
  target_type text not null check (target_type in ('admin','facilitator','case','version','room')),
  target_id uuid,
  actor_email text not null check (actor_email ~
    '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$' and length(actor_email) <= 320),
  before jsonb not null default '{}'::jsonb check (case_app.admin_audit_snapshot_ok(before)),
  after jsonb not null default '{}'::jsonb check (case_app.admin_audit_snapshot_ok(after)),
  at timestamptz not null default clock_timestamp(),
  from_prefix cidr check (from_prefix is null or
    (family(from_prefix) = 4 and masklen(from_prefix) = 24) or
    (family(from_prefix) = 6 and masklen(from_prefix) = 64)),
  check ((phase = 'intent' and intent_id = id) or
         (phase = 'outcome' and intent_id is not null and intent_id <> id) or
         (phase = 'attempt' and intent_id is null))
);
create index admin_audit_recent_idx on case_app.admin_audit_log (at desc, id desc);
create index admin_audit_intent_idx on case_app.admin_audit_log (intent_id, at desc)
  where intent_id is not null;
create trigger admin_audit_immutable
  before update or delete on case_app.admin_audit_log
  for each row execute function case_app.forbid_change();
create trigger admin_audit_no_truncate
  before truncate on case_app.admin_audit_log
  for each statement execute function case_app.forbid_change();
revoke all on case_app.admin_audit_log from public, anon, authenticated, service_role;

create function case_api.write_admin_audit(
  p_event_id uuid, p_intent_id uuid, p_phase text, p_action text,
  p_target_type text, p_target_id uuid, p_actor_email text,
  p_before jsonb, p_after jsonb, p_from_prefix cidr
) returns uuid language plpgsql security definer set search_path = '' as $$
declare prior case_app.admin_audit_log%rowtype;
begin
  if p_event_id is null or p_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_phase is null or p_action is null or p_target_type is null or
     p_actor_email is null or p_before is null or p_after is null or
     (p_phase = 'intent' and p_intent_id is distinct from p_event_id) or
     (p_phase = 'outcome' and (p_intent_id is null or p_intent_id = p_event_id)) or
     (p_phase = 'attempt' and p_intent_id is not null) then
    raise exception 'invalid_admin_audit' using errcode = '22023';
  end if;
  if p_phase = 'outcome' and not exists (
    select 1 from case_app.admin_audit_log a where a.id = p_intent_id and
      a.phase = 'intent' and a.action = p_action and
      a.actor_email = p_actor_email and a.target_type = p_target_type and
      a.target_id is not distinct from p_target_id
  ) then raise exception 'missing_admin_intent' using errcode = '22023'; end if;
  if (p_action like 'stepup_%' and (p_target_type <> 'admin' or p_target_id is not null)) or
     (p_action like 'facilitator_%' and
       (p_target_type <> 'facilitator' or
        (p_target_id is null and p_action <> 'facilitator_invite'))) or
     (p_action = 'case_publish' and (p_target_type <> 'case' or p_target_id is null)) or
     (p_action = 'version_withdraw' and (p_target_type <> 'version' or p_target_id is null)) or
     (p_action = 'room_end' and (p_target_type <> 'room' or p_target_id is null)) then
    raise exception 'invalid_admin_audit_target' using errcode = '23514';
  end if;
  insert into case_app.admin_audit_log
    (id, intent_id, phase, action, target_type, target_id, actor_email,
      before, after, from_prefix)
  values (p_event_id, p_intent_id, p_phase, p_action, p_target_type,
    p_target_id, p_actor_email, p_before, p_after, p_from_prefix)
  on conflict (id) do nothing;
  select * into prior from case_app.admin_audit_log where id = p_event_id;
  if prior.intent_id is distinct from p_intent_id or prior.phase <> p_phase or
     prior.action <> p_action or prior.target_type <> p_target_type or
     prior.target_id is distinct from p_target_id or
     prior.actor_email <> p_actor_email or prior.before <> p_before or
     prior.after <> p_after or prior.from_prefix is distinct from p_from_prefix then
    raise exception 'changed_admin_audit_replay' using errcode = '23505';
  end if;
  return p_event_id;
end;
$$;

-- Serialize this actor's admission and durable attempt as one transaction.
-- Denied attempts are audited but never extend the rolling accepted-attempt window.
create function case_api.claim_admin_stepup_attempt(
  p_event_id uuid, p_actor_email text, p_action text, p_from_prefix cidr
) returns boolean language plpgsql security definer set search_path = '' as $$
declare accepted boolean; decision_at timestamptz;
begin
  if p_event_id is null or p_actor_email is null or length(p_actor_email) > 320 or
     p_actor_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$' or
     p_action is null or p_action not in ('stepup_start','stepup_verify') then
    raise exception 'invalid_admin_attempt' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_email, 0));
  if exists (select 1 from case_app.admin_audit_log a where a.id = p_event_id) then
    raise exception 'replayed_admin_attempt' using errcode = '23505';
  end if;
  decision_at := clock_timestamp();
  select count(*) < 5 into accepted from case_app.admin_audit_log a
    where a.actor_email = p_actor_email and a.phase = 'attempt' and
      a.action in ('stepup_start','stepup_verify') and
      coalesce(a.after->>'status', '') = 'accepted' and
      a.at > decision_at - interval '15 minutes';
  perform case_api.write_admin_audit(p_event_id, null, 'attempt', p_action,
    'admin', null, p_actor_email, '{}'::jsonb,
    jsonb_build_object('status', case when accepted then 'accepted' else 'rate_limited' end),
    p_from_prefix);
  return accepted;
end;
$$;

create function case_api.list_admin_audit(p_limit integer default 100, p_after uuid default null)
returns table (
  event_id uuid, intent_id uuid, phase text, action text, target_type text,
  target_id uuid, actor_email text, before jsonb, after jsonb, at timestamptz,
  from_prefix cidr
) language plpgsql stable security definer set search_path = '' as $$
declare cursor_at timestamptz;
begin
  if p_after is not null then
    select a.at into cursor_at from case_app.admin_audit_log a where a.id = p_after;
    if not found then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  end if;
  return query
    select a.id, a.intent_id, a.phase, a.action, a.target_type, a.target_id,
      a.actor_email, a.before, a.after, a.at, a.from_prefix
      from case_app.admin_audit_log a
     where p_after is null or (a.at, a.id) < (cursor_at, p_after)
     order by a.at desc, a.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;

-- Publication availability is mutable without modifying an immutable version's
-- document/hash. An absent row means the historical version is published.
create table case_app.admin_version_state (
  case_version_id uuid primary key references case_app.case_versions (id) on delete restrict,
  status text not null check (status in ('published','withdrawn')),
  admin_revision bigint not null default 0 check (admin_revision >= 0),
  changed_at timestamptz not null default now()
);
revoke all on case_app.admin_version_state from public, anon, authenticated, service_role;

create function case_api.admin_read_case_version(p_version_id uuid)
returns table (case_id uuid,version_id uuid,version_no integer,title text,status text,admin_revision bigint)
language sql stable security definer set search_path = '' as $$
  select c.id,v.id,v.version_no,c.title,coalesce(s.status,'published'),coalesce(s.admin_revision,0::bigint)
    from case_app.case_versions v join case_app.cases c on c.id=v.case_id
    left join case_app.admin_version_state s on s.case_version_id=v.id
   where v.id=p_version_id;
$$;
revoke all on function case_api.admin_read_case_version(uuid) from public,anon,authenticated,service_role;
grant execute on function case_api.admin_read_case_version(uuid) to service_role;

create function case_api.list_admin_case_versions(p_limit integer default 100,p_after uuid default null)
returns table (case_id uuid,version_id uuid,version_no integer,title text,status text,admin_revision bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'invalid_version_page' using errcode='22023'; end if;
  if p_after is not null and not exists(select 1 from case_app.case_versions v where v.id=p_after) then
    raise exception 'invalid_page_cursor' using errcode='22023'; end if;
  return query select c.id,v.id,v.version_no,c.title,coalesce(s.status,'published'),coalesce(s.admin_revision,0::bigint)
    from case_app.case_versions v join case_app.cases c on c.id=v.case_id
    left join case_app.admin_version_state s on s.case_version_id=v.id
   where p_after is null or v.id<p_after order by v.id desc limit p_limit;
end;
$$;
revoke all on function case_api.list_admin_case_versions(integer,uuid) from public,anon,authenticated,service_role;
grant execute on function case_api.list_admin_case_versions(integer,uuid) to service_role;

create function case_api.admin_set_version_state(
  p_version_id uuid, p_expected_revision bigint, p_action text
) returns table (version_id uuid, status text, admin_revision bigint)
language plpgsql security definer set search_path = '' as $$
declare current_state case_app.admin_version_state%rowtype;
begin
  if p_version_id is null or p_expected_revision is null or p_expected_revision < 0 or
     p_action is null or p_action not in ('withdraw','publish') then
    raise exception 'invalid_version_transition' using errcode = '22023'; end if;
  if not exists (select 1 from case_app.case_versions v where v.id = p_version_id) then
    raise exception 'missing_version' using errcode = '22023'; end if;
  insert into case_app.admin_version_state (case_version_id, status)
    values (p_version_id, 'published') on conflict (case_version_id) do nothing;
  select * into current_state from case_app.admin_version_state
    where case_version_id = p_version_id for update;
  if current_state.admin_revision <> p_expected_revision then
    raise exception 'stale_admin_version' using errcode = '40001'; end if;
  if (p_action = 'withdraw' and current_state.status <> 'published') or
     (p_action = 'publish' and current_state.status <> 'withdrawn') then
    raise exception 'invalid_version_state' using errcode = '23514'; end if;
  update case_app.admin_version_state s
     set status = case when p_action = 'withdraw' then 'withdrawn' else 'published' end,
         admin_revision = s.admin_revision + 1, changed_at = now()
   where s.case_version_id = p_version_id;
  return query select s.case_version_id, s.status, s.admin_revision
    from case_app.admin_version_state s where s.case_version_id = p_version_id;
end;
$$;

-- New-room version reads obey withdrawal; existing live rooms retain their pinned pack.
create or replace function case_api.get_case_version_for_workspace(
  p_version_id uuid, p_workspace_id uuid, p_user_id uuid
) returns table (
  case_id uuid, version_no integer, schema_version integer,
  document jsonb, document_text text, content_sha256 bytea
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.assert_member(p_user_id, p_workspace_id, array['owner', 'author', 'facilitator']);
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  return query select v.case_id, v.version_no, v.schema_version,
    v.document, v.document::text, v.content_sha256::bytea
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
    where v.id = p_version_id and c.workspace_id = p_workspace_id and
      not exists (select 1 from case_app.admin_version_state av
        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;

-- Replace only existing service-callable signatures inside this new migration.
create or replace function case_api.list_published_versions(
  p_user_id uuid, p_workspace_id uuid, p_limit integer, p_after uuid
) returns table (
  version_id uuid, case_id uuid, title text, version_no integer,
  published_at timestamptz, content_sha256 bytea
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
    select v.id, v.case_id, c.title, v.version_no, v.published_at, v.content_sha256::bytea
      from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where c.workspace_id = p_workspace_id and c.archived_at is null and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn') and
       (p_after is null or (v.published_at, v.id) < (v_after_at, p_after))
     order by v.published_at desc, v.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;

create or replace function case_api.create_session(
  p_session_id uuid, p_case_version_id uuid, p_workspace_id uuid,
  p_facilitator_id uuid, p_join_code text, p_ttl interval default interval '12 hours'
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_session_id is null or p_session_id::text !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'session_id_must_be_uuidv7' using errcode = '23514';
  end if;
  if not case_api.admin_account_active(p_facilitator_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  perform case_app.assert_member(p_facilitator_id, p_workspace_id,
    array['owner', 'author', 'facilitator']);
  if not exists (
    select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_case_version_id and c.workspace_id = p_workspace_id and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn')
  ) then
    raise exception 'not_authorised: version unavailable' using errcode = '42501';
  end if;
  insert into case_app.sessions (id, case_version_id, workspace_id, facilitator_id, join_code, expires_at)
  values (p_session_id, p_case_version_id, p_workspace_id, p_facilitator_id, p_join_code,
          now() + greatest(interval '1 minute', least(coalesce(p_ttl, interval '12 hours'), interval '24 hours')));
  return p_session_id;
end;
$$;

revoke all on function case_api.admin_account_active(uuid)
  from public, anon, authenticated, service_role;
grant execute on function case_api.admin_account_active(uuid) to service_role;
revoke all on function case_api.admin_teaching_workspace_exists(uuid)
  from public, anon, authenticated, service_role;
grant execute on function case_api.admin_teaching_workspace_exists(uuid) to service_role;
revoke all on function case_api.admin_provision_facilitator(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function case_api.admin_provision_facilitator(uuid,uuid) to service_role;
revoke all on function case_api.write_admin_audit(uuid,uuid,text,text,text,uuid,text,jsonb,jsonb,cidr)
  from public, anon, authenticated, service_role;
grant execute on function case_api.write_admin_audit(uuid,uuid,text,text,text,uuid,text,jsonb,jsonb,cidr)
  to service_role;
revoke all on function case_api.list_admin_audit(integer,uuid)
  from public, anon, authenticated, service_role;
grant execute on function case_api.list_admin_audit(integer,uuid) to service_role;
revoke all on function case_api.admin_set_version_state(uuid,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function case_api.admin_set_version_state(uuid,bigint,text) to service_role;
revoke all on function case_api.admin_transition_profile(uuid,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function case_api.admin_transition_profile(uuid,bigint,text) to service_role;

revoke all on function case_api.claim_admin_stepup_attempt(uuid,text,text,cidr)
  from public, anon, authenticated, service_role;
grant execute on function case_api.claim_admin_stepup_attempt(uuid,text,text,cidr)
  to service_role;

-- A durable intent-bound claim excludes ambiguous irreversible writes from later sweeps.
create function case_api.admin_claim_due_profile_deletion(
  p_user_id uuid,p_expected_revision bigint,p_intent_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare current_profile case_app.profiles%rowtype;
begin
  if p_user_id is null or p_expected_revision is null or
     p_expected_revision<0 or p_expected_revision>9999999999 or p_intent_id is null
    then return false; end if;
  select * into current_profile from case_app.profiles where id=p_user_id for update;
  if not found or current_profile.admin_revision<>p_expected_revision or
     current_profile.disabled_at is null or current_profile.soft_deleted_at is null or
     current_profile.delete_due_at is null or
     current_profile.delete_due_at<>current_profile.soft_deleted_at+interval '30 days' or
     current_profile.delete_due_at>clock_timestamp() then return false; end if;
  if not exists(select 1 from case_app.admin_audit_log a where a.id=p_intent_id and
      a.intent_id=p_intent_id and a.phase='intent' and a.action='facilitator_hard_delete' and
      a.target_type='facilitator' and a.target_id=p_user_id and
      coalesce(a.before->>'status','')='soft_deleted' and
      coalesce((a.before->>'admin_revision')::bigint,-1)=p_expected_revision)
    then return false; end if;
  if current_profile.admin_delete_claim_id is not null
    then return current_profile.admin_delete_claim_id=p_intent_id; end if;
  update case_app.profiles set admin_delete_claim_id=p_intent_id,
    admin_delete_claimed_at=clock_timestamp() where id=p_user_id;
  return true;
end;
$$;
revoke all on function case_api.admin_claim_due_profile_deletion(uuid,bigint,uuid)
  from public,anon,authenticated,service_role;
grant execute on function case_api.admin_claim_due_profile_deletion(uuid,bigint,uuid) to service_role;

commit;
