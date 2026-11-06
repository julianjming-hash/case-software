-- Card 21a: historical attribution becomes anonymous after Auth-first hard deletion.
-- Every block raises on failure; scripts/test-db.sh uses ON_ERROR_STOP.
\set QUIET on

do $$
declare
  fresh uuid := case_app.uuid_v7();
  deleted uuid := case_app.uuid_v7();
begin
  insert into auth.users (id) values (fresh);
  if not case_api.admin_account_active(fresh) then
    raise exception 'fresh invited Auth user without profile was denied'; end if;
  if case_api.admin_account_active(deleted) then
    raise exception 'deleted Auth user with stale JWT remained active'; end if;
  insert into case_app.profiles (id, display_name) values (fresh, 'Facilitator');
  if not case_api.admin_account_active(fresh) then
    raise exception 'active profile was denied'; end if;
  update case_app.profiles set disabled_at = now() where id = fresh;
  if case_api.admin_account_active(fresh) then
    raise exception 'disabled profile remained active'; end if;
  update case_app.profiles set disabled_at = now(),
    soft_deleted_at = now(), delete_due_at = now() + interval '30 days' where id = fresh;
  if case_api.admin_account_active(fresh) then
    raise exception 'soft-deleted profile remained active'; end if;
  raise notice 'ok Card21a active preflight distinguishes fresh invite and stale deleted JWT';
end $$;

do $$
declare signature text;
begin
  foreach signature in array array[
    'case_api.admin_account_active(uuid)',
    'case_api.admin_teaching_workspace_exists(uuid)',
    'case_api.admin_provision_facilitator(uuid,uuid,uuid,boolean,text)',
    'case_api.admin_transition_profile(uuid,bigint,text,boolean,text)',
    'case_api.write_admin_audit(uuid,uuid,text,text,text,uuid,text,jsonb,jsonb,cidr)',
    'case_api.claim_admin_stepup_attempt(uuid,text,text,cidr)',
    'case_api.list_admin_audit(integer,uuid)',
    'case_api.admin_set_version_state(uuid,bigint,text,uuid,boolean,text,uuid)'
  ] loop
    if not has_function_privilege('service_role', signature, 'execute') or
       has_function_privilege('anon', signature, 'execute') or
       has_function_privilege('authenticated', signature, 'execute') then
      raise exception 'Card21a function privilege mismatch: %', signature; end if;
  end loop;
  if has_table_privilege('service_role', 'case_app.admin_audit_log', 'select') or
     has_table_privilege('service_role', 'case_app.admin_audit_log', 'insert') or
     has_table_privilege('anon', 'case_app.admin_audit_log', 'select') or
     has_table_privilege('authenticated', 'case_app.admin_version_state', 'select') then
    raise exception 'Card21a exposed a case_app admin table'; end if;
  raise notice 'ok Card21a exact service RPC privilege and private admin tables';
end $$;

-- These are the fixed outcome envelopes actually emitted by the server mutation helpers.
do $$
declare outcome text;
begin
  foreach outcome in array array['completed','failed','unknown_outcome','manual_reconciliation_needed'] loop
    if not case_app.admin_audit_snapshot_ok(jsonb_build_object('status',outcome)) then
      raise exception 'Card21a actual server outcome rejected by SQL: %',outcome; end if;
  end loop;
  if not case_app.admin_audit_snapshot_ok('{"admin_revision":9999999999}'::jsonb) or
     case_app.admin_audit_snapshot_ok('{"admin_revision":10000000000}'::jsonb) or
     case_app.admin_audit_snapshot_ok('{"status":"free private answer"}'::jsonb) then
    raise exception 'Card21a audit shared scalar bounds or fixed statuses drifted'; end if;
  raise notice 'ok Card21a actual server fixed outcomes and ten-digit revision ceiling';
end $$;

-- Simulate admission after time has passed inside the transaction (for example an actor lock wait).
-- The immutable audit timestamp must record admission time, not transaction start.
do $$
declare
  attempt_id uuid := case_app.uuid_v7();
  admitted_after timestamptz;
  recorded_at timestamptz;
begin
  perform pg_sleep(0.02);
  admitted_after := clock_timestamp();
  if not case_api.claim_admin_stepup_attempt(attempt_id,
      'admission-clock@example.test', 'stepup_verify', null) then
    raise exception 'Card21a fresh admission-clock actor was refused'; end if;
  select at into recorded_at from case_app.admin_audit_log where id = attempt_id;
  if recorded_at is null or recorded_at < admitted_after then
    raise exception 'Card21a audit attempt backdated before actual admission'; end if;
  raise notice 'ok Card21a audit attempt uses actual admission wall clock';
end $$;

do $$
declare
  attempt_id uuid;
  accepted boolean;
  reused boolean := false;
begin
  for i in 1..5 loop
    attempt_id := case_app.uuid_v7();
    accepted := case_api.claim_admin_stepup_attempt(attempt_id,
      'rate@example.test', case when i % 2 = 0 then 'stepup_verify' else 'stepup_start' end,
      '2001:db8::/64'::cidr);
    if not accepted then raise exception 'Card21a blocked step-up attempt before sixth request'; end if;
  end loop;
  attempt_id := case_app.uuid_v7();
  if case_api.claim_admin_stepup_attempt(attempt_id,
      'rate@example.test', 'stepup_verify', '2001:db8::/64'::cidr) then
    raise exception 'Card21a accepted sixth step-up attempt in 15 minutes';
  end if;
  if (select count(*) from case_app.admin_audit_log
      where actor_email = 'rate@example.test' and phase = 'attempt'
        and action in ('stepup_start','stepup_verify')) <> 6 or
     (select after->>'status' from case_app.admin_audit_log where id = attempt_id) <> 'rate_limited' then
    raise exception 'Card21a step-up rate decision was not durably audited';
  end if;
  if not case_api.claim_admin_stepup_attempt(case_app.uuid_v7(),
      'separate@example.test', 'stepup_start', null) then
    raise exception 'Card21a another admin inherited the first admin rate limit';
  end if;
  begin
    perform case_api.claim_admin_stepup_attempt(attempt_id,
      'rate@example.test', 'stepup_verify', '2001:db8::/64'::cidr);
  exception when unique_violation then reused := true; end;
  if not reused then raise exception 'Card21a replayed a one-shot step-up attempt'; end if;
  raise notice 'ok Card21a durable per-admin step-up 5/15 and every-attempt audit';
end $$;

do $$
declare
  v_version uuid;
  v_room uuid := case_app.uuid_v7();
  member_id uuid := case_app.uuid_v7();
  workspace_id uuid;
  state record;
  blocked boolean := false;
  stale boolean := false;
begin
  select id into v_version from case_app.case_versions
    where case_id = '0199a000-0000-7000-8000-0000000000c1'
    order by version_no limit 1;
  select c.workspace_id into workspace_id from case_app.case_versions v
    join case_app.cases c on c.id = v.case_id where v.id = v_version;
  insert into auth.users (id) values (member_id);
  insert into case_app.profiles (id, display_name) values (member_id, 'Version reader');
  insert into case_app.workspace_members (workspace_id, user_id, role)
    values (workspace_id, member_id, 'facilitator');
  if (select count(*) from case_api.get_case_version_for_workspace(
      v_version, workspace_id, member_id)) <> 1 then
    raise exception 'active member could not read published version'; end if;
  perform case_api.create_session(v_room, v_version,
    '0199a000-0000-7000-8000-00000000000a'::uuid,
    '0199a000-0000-7000-8000-000000000001'::uuid, 'AB1234');
  select * into state from case_app.admin_set_version_state(v_version, 0, 'withdraw');
  if state.status <> 'withdrawn' or state.admin_revision <> 1 or
     exists (select 1 from case_api.list_published_versions(
       '0199a000-0000-7000-8000-000000000001',
       '0199a000-0000-7000-8000-00000000000a', 100, null)
       where version_id = v_version) then
    raise exception 'withdrawn version remained offered to start'; end if;
  if exists (select 1 from case_api.get_case_version_for_workspace(
      v_version, workspace_id, member_id)) then
    raise exception 'withdrawn version remained readable for new room'; end if;
  begin
    perform case_api.create_session(case_app.uuid_v7(), v_version,
      '0199a000-0000-7000-8000-00000000000a'::uuid,
      '0199a000-0000-7000-8000-000000000001'::uuid, 'AB1235');
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'withdrawn version started a new room'; end if;
  if not exists (select 1 from case_app.sessions where id = v_room and status = 'lobby') then
    raise exception 'withdrawal altered a live pinned room'; end if;
  begin
    perform * from case_app.admin_set_version_state(v_version, 0, 'publish');
  exception when serialization_failure then stale := true; end;
  if not stale then raise exception 'stale version publication CAS was accepted'; end if;
  select * into state from case_app.admin_set_version_state(v_version, 1, 'publish');
  if state.status <> 'published' or state.admin_revision <> 2 then
    raise exception 'republish did not restore availability'; end if;
  update case_app.profiles set disabled_at = now() where id = member_id;
  blocked := false;
  begin
    perform * from case_api.get_case_version_for_workspace(
      v_version, workspace_id, member_id);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'disabled caller read a published version'; end if;
  perform case_api.end_session(v_room, 0, 0);
  raise notice 'ok Card21a version CAS and withdrawn new-room refusal';
end $$;

do $$
declare
  v_intent uuid := case_app.uuid_v7();
  invite_intent uuid := case_app.uuid_v7();
  outcome_id uuid := case_app.uuid_v7();
  target_id uuid := case_app.uuid_v7();
  rejected boolean;
  v_event uuid;
  row_count integer;
  expected_total integer;
  first_ids uuid[];
  after_id uuid;
begin
  -- A new invited Auth user has no UUID until the one-shot external call returns.
  perform case_api.write_admin_audit(invite_intent, invite_intent, 'intent',
    'facilitator_invite', 'facilitator', null, 'admin@example.test',
    '{}'::jsonb, '{"email":"new@example.test"}'::jsonb, null);
  perform case_api.write_admin_audit(case_app.uuid_v7(), invite_intent, 'outcome',
    'facilitator_invite', 'facilitator', null, 'admin@example.test',
    '{"email":"new@example.test"}'::jsonb,
    '{"email":"new@example.test","status":"invited"}'::jsonb, null);
  v_event := case_api.write_admin_audit(v_intent, v_intent, 'intent',
    'facilitator_disable', 'facilitator', target_id, 'admin@example.test',
    '{"status":"active"}'::jsonb, '{"status":"disabled"}'::jsonb, '192.0.2.0/24'::cidr);
  if v_event <> v_intent or
     case_api.write_admin_audit(v_intent, v_intent, 'intent',
       'facilitator_disable', 'facilitator', target_id, 'admin@example.test',
       '{"status":"active"}'::jsonb, '{"status":"disabled"}'::jsonb, '192.0.2.0/24'::cidr) <> v_intent or
     (select count(*) from case_app.admin_audit_log where id = v_intent) <> 1 then
    raise exception 'audit intent identical replay duplicated or changed event'; end if;
  rejected := false;
  begin
    perform case_api.write_admin_audit(v_intent, v_intent, 'intent',
      'facilitator_disable', 'facilitator', target_id, 'admin@example.test',
      '{"status":"active"}'::jsonb, '{"status":"soft_deleted"}'::jsonb, null);
  exception when unique_violation then rejected := true; end;
  if not rejected then raise exception 'changed audit replay was accepted'; end if;
  rejected := false;
  begin
    perform case_api.write_admin_audit(case_app.uuid_v7(), null, 'attempt',
      'stepup_start', 'admin', null, 'admin@example.test',
      '{"pack":{"private":true}}'::jsonb, '{}'::jsonb, null);
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'audit accepted pack/private nested field'; end if;
  rejected := false;
  begin
    perform case_api.write_admin_audit(case_app.uuid_v7(), null, 'attempt',
      'stepup_start', 'admin', null, 'admin@example.test',
      '{}'::jsonb, '{}'::jsonb, '192.0.2.1/32'::cidr);
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'audit accepted full IPv4 address'; end if;
  rejected := false;
  begin
    perform case_api.write_admin_audit(outcome_id, case_app.uuid_v7(), 'outcome',
      'facilitator_disable', 'facilitator', target_id, 'admin@example.test',
      '{}'::jsonb, '{"status":"disabled"}'::jsonb, null);
  exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise exception 'outcome without durable intent was accepted'; end if;
  perform case_api.write_admin_audit(outcome_id, v_intent, 'outcome',
    'facilitator_disable', 'facilitator', target_id, 'admin@example.test',
    '{}'::jsonb, '{"status":"disabled"}'::jsonb, null);
  rejected := false;
  begin
    update case_app.admin_audit_log set actor_email = 'other@example.test' where id = v_intent;
  exception when insufficient_privilege then rejected := true; end;
  if not rejected then raise exception 'audit event update was accepted'; end if;
  rejected := false;
  begin
    delete from case_app.admin_audit_log where id = v_intent;
  exception when insufficient_privilege then rejected := true; end;
  if not rejected then raise exception 'audit event delete was accepted'; end if;
  rejected := false;
  begin
    truncate case_app.admin_audit_log;
  exception when insufficient_privilege then rejected := true; end;
  if not rejected then raise exception 'audit table truncation was accepted'; end if;

  for i in 1..105 loop
    perform case_api.write_admin_audit(case_app.uuid_v7(), null, 'attempt',
      'stepup_start', 'admin', null, 'admin@example.test',
      '{}'::jsonb, '{"status":"accepted"}'::jsonb, null);
  end loop;
  select count(*) into expected_total from case_app.admin_audit_log;
  select array_agg(event_id) into first_ids from case_api.list_admin_audit(100,null);
  select count(*) into row_count from case_api.list_admin_audit(100, null);
  select event_id into after_id from case_api.list_admin_audit(100, null)
    order by at asc, event_id asc limit 1;
  if row_count <> 100 or after_id is null or
     (select count(*) from case_api.list_admin_audit(100, after_id)) <> expected_total-100 or
     exists(select 1 from case_api.list_admin_audit(100,after_id) where event_id=any(first_ids)) then
    raise exception 'admin audit keyset paging lost or repeated rows'; end if;
  raise notice 'ok Card21a append-only audit, strict fields, intent and bounded paging';
end $$;

do $$
declare
  invited uuid := case_app.uuid_v7();
  teaching uuid := case_app.uuid_v7();
  other_workspace uuid := case_app.uuid_v7();
  missing_workspace uuid := case_app.uuid_v7();
  rejected boolean := false;
begin
  insert into case_app.workspaces (id, slug, name)
    values (teaching, 'admin-teaching-v1', 'Teaching'),
           (other_workspace, 'admin-other-v1', 'Other');
  if not case_api.admin_teaching_workspace_exists(teaching) or
     case_api.admin_teaching_workspace_exists(missing_workspace) then
    raise exception 'teaching workspace preflight did not fail closed'; end if;
  insert into auth.users (id) values (invited);
  perform case_app.admin_provision_facilitator(invited, teaching);
  perform case_app.admin_provision_facilitator(invited, teaching);
  if (select count(*) from case_app.profiles where id = invited) <> 1 or
     (select role from case_app.workspace_members
       where workspace_id = teaching and user_id = invited) <> 'facilitator' or
     exists (select 1 from case_app.workspace_members
       where workspace_id = other_workspace and user_id = invited) then
    raise exception 'invite did not provision exactly one teaching membership'; end if;
  update case_app.workspace_members set role = 'author'
    where workspace_id = teaching and user_id = invited;
  perform case_app.admin_provision_facilitator(invited, teaching);
  if (select role from case_app.workspace_members
      where workspace_id = teaching and user_id = invited) <> 'author' then
    raise exception 'invite downgraded existing author'; end if;
  begin
    perform case_app.admin_provision_facilitator(invited, missing_workspace);
  exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise exception 'missing teaching workspace was provisioned'; end if;
  raise notice 'ok Card21a exact teaching membership and idempotent provisioning';
end $$;

do $$
declare
  target_id uuid := case_app.uuid_v7();
  expired_id uuid := case_app.uuid_v7();
  state record;
  stale boolean := false;
  rejected boolean := false;
begin
  insert into auth.users (id) values (target_id);
  insert into case_app.profiles (id, display_name) values (target_id, 'Managed facilitator');
  insert into auth.users (id) values (expired_id);
  insert into case_app.profiles (id, display_name) values (expired_id, 'Expired facilitator');
  begin
    update case_app.profiles set disabled_at = now(),
      soft_deleted_at = now(), delete_due_at = null where id = expired_id;
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'soft-delete NULL deadline bypassed check'; end if;
  rejected := false;
  begin
    update case_app.profiles set disabled_at = now(),
      soft_deleted_at = now(), delete_due_at = now() + interval '31 days'
      where id = expired_id;
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'soft-delete extended beyond exact 30-day deadline'; end if;
  update case_app.profiles set disabled_at = now() - interval '31 days',
    soft_deleted_at = now() - interval '31 days',
    delete_due_at = now() - interval '1 day' where id = expired_id;
  rejected := false;
  begin
    perform * from case_app.admin_transition_profile(expired_id, 0, 'restore');
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'expired soft-delete restored after deadline'; end if;
  select * into state from case_app.admin_transition_profile(target_id, 0, 'disable');
  if state.admin_revision <> 1 or state.disabled_at is null or
     case_api.admin_account_active(target_id) then
    raise exception 'disable did not cut off active account'; end if;
  begin
    perform * from case_app.admin_transition_profile(target_id, 0, 'enable');
  exception when serialization_failure then stale := true; end;
  if not stale then raise exception 'stale profile transition was accepted'; end if;
  select * into state from case_app.admin_transition_profile(target_id, 1, 'soft_delete');
  if state.admin_revision <> 2 or state.soft_deleted_at is null or
     state.delete_due_at <> state.soft_deleted_at + interval '30 days' or
     case_api.admin_account_active(target_id) then
    raise exception 'soft deletion did not set bounded delete window and cutoff'; end if;
  select * into state from case_app.admin_transition_profile(target_id, 2, 'restore');
  if state.admin_revision <> 3 or state.disabled_at is not null or
     state.soft_deleted_at is not null or state.delete_due_at is not null or
     not case_api.admin_account_active(target_id) then
    raise exception 'restore did not clear account cutoff'; end if;
  raise notice 'ok Card21a profile CAS disable, soft-delete and restore';
end $$;

do $$
declare
  u uuid := case_app.uuid_v7();
  v_workspace uuid := case_app.uuid_v7();
  v_case uuid := case_app.uuid_v7();
  v_version uuid := case_app.uuid_v7();
  v_asset uuid := case_app.uuid_v7();
  v_source uuid := case_app.uuid_v7();
  v_run uuid := case_app.uuid_v7();
  v_proposal uuid := case_app.uuid_v7();
  v_session uuid := case_app.uuid_v7();
  original_document jsonb := '{"beats":[],"private_authoring":"unchanged"}'::jsonb;
  original_hash bytea := sha256(convert_to('{"beats":[],"private_authoring":"unchanged"}', 'UTF8'));
  blocked boolean := false;
begin
  insert into auth.users (id) values (u);
  insert into case_app.profiles (id, display_name) values (u, 'Deleted author');
  insert into case_app.workspaces (id, slug, name)
    values (v_workspace, 'admin-anonymous-history', 'Anonymous history test');
  insert into case_app.workspace_members (workspace_id, user_id, role)
    values (v_workspace, u, 'owner');
  insert into case_app.cases (id, workspace_id, owner_id, title)
    values (v_case, v_workspace, u, 'Historical case');
  insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
    values (v_case, 1, 1, original_document, u);
  insert into case_app.case_versions (id, case_id, version_no, schema_version,
    document, content_sha256, published_by)
    values (v_version, v_case, 1, 1, original_document, original_hash, u);
  insert into case_app.assets (id, workspace_id, uploaded_by, kind, media_type,
    byte_size, content_sha256, r2_key, status, rights_basis, alt_text,
    deidentified_attested_by, deidentified_attested_at, licence, evidence_kind, width, height)
    values (v_asset, v_workspace, u, 'image', 'image/png', 1, sha256('asset'),
      'assets/admin-anonymous-history/fixture.png', 'approved', 'own_work', 'Alt text', u, now(), 'own-work', 'photo', 800, 600);
  insert into case_app.sources (id, case_id, kind, title, created_by)
    values (v_source, v_case, 'local_policy', 'Historical source', u);
  insert into case_app.agent_runs (id, case_id, base_revision, task, provider, model,
    template_sha256, requested_by)
    values (v_run, v_case, 1, 'explain', 'fixture', 'fixture', sha256('template'), u);
  insert into case_app.agent_proposal_groups (id, run_id, ordinal, intent, patch, decided_by)
    values (v_proposal, v_run, 1, 'Historical decision', '[]'::jsonb, u);
  insert into case_app.sessions (id, case_version_id, workspace_id, facilitator_id,
    join_code, status, expires_at, ended_at)
    values (v_session, v_version, v_workspace, u, 'AA1234', 'ended', now() + interval '1 hour', now());

  begin
    update case_app.case_versions set published_by = null where id = v_version;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'published_by could be directly anonymized while profile exists'; end if;
  blocked := false;
  begin
    update case_app.assets set deidentified_attestation_anonymized = true where id = v_asset;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'asset anonymity proof could be directly forged'; end if;

  delete from auth.users where id = u;
  if exists (select 1 from case_app.profiles where id = u) or
     exists (select 1 from case_app.workspace_members where user_id = u) then
    raise exception 'Auth-first deletion left identifying profile or membership'; end if;
  if not exists (select 1 from case_app.cases where id = v_case and owner_id is null) or
     not exists (select 1 from case_app.case_drafts where case_id = v_case and updated_by is null) or
     not exists (select 1 from case_app.case_versions where id = v_version and published_by is null
       and document = original_document and content_sha256 = original_hash) or
     not exists (select 1 from case_app.assets where id = v_asset and uploaded_by is null
       and deidentified_attested_by is null and deidentified_attestation_anonymized
       and deidentified_attested_at is not null and status = 'approved'
       and content_sha256 = sha256('asset')) or
     not exists (select 1 from case_app.sources where id = v_source and created_by is null) or
     not exists (select 1 from case_app.agent_runs where id = v_run and requested_by is null) or
     not exists (select 1 from case_app.agent_proposal_groups where id = v_proposal and decided_by is null) or
     not exists (select 1 from case_app.sessions where id = v_session and facilitator_id is null) then
    raise exception 'Auth-first deletion lost history or retained identifying attribution'; end if;

  blocked := false;
  begin
    update case_app.case_versions set document = '{"changed":true}'::jsonb where id = v_version;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'anonymous published document could be changed'; end if;
  blocked := false;
  begin
    delete from case_app.case_versions where id = v_version;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'anonymous published version could be deleted'; end if;
  blocked := false;
  begin
    update case_app.assets set content_sha256 = sha256('changed') where id = v_asset;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'changed approved asset inherited anonymous attestation'; end if;
  update case_app.assets set status = 'quarantined', content_sha256 = sha256('changed')
    where id = v_asset;
  if (select deidentified_attestation_anonymized from case_app.assets where id = v_asset) then
    raise exception 'changed quarantined asset retained anonymous attestation'; end if;
  -- Julian, 2026-10-15: for images and video the de-identification tick is a warning, not an approval gate (CASE-268),
  -- so the changed image may be approved again; what must hold is that it no longer claims the old attestation.
  update case_app.assets set status = 'approved' where id = v_asset;
  if (case_app.asset_row(a.*)->>'attested')::boolean from case_app.assets a where a.id = v_asset then
    raise exception 'changed asset still reports the deleted attester''s attestation'; end if;
  -- Any other asset kind still needs a fresh attestation before approval.
  update case_app.assets set status = 'quarantined' where id = v_asset;
  blocked := false;
  begin
    update case_app.assets set status = 'approved', kind = 'document', media_type = 'application/pdf' where id = v_asset;
  exception when check_violation then blocked := true; end;
  if not blocked then raise exception 'changed document reapproved without fresh attestation'; end if;
  raise notice 'ok Card21a Auth-first anonymous history and version immutability';
end $$;

-- Admin profile actions read only bounded administrative state, never display names.
do $$
declare
  target uuid := case_app.uuid_v7();
  other uuid := case_app.uuid_v7();
  row_state record;
  keys text[];
  rejected boolean := false;
begin
  insert into auth.users(id) values(target),(other);
  insert into case_app.profiles(id,display_name) values(target,'Never in admin state'),(other,'Other private name');
  select * into row_state from case_api.admin_read_profiles(array[target]);
  select array_agg(key order by key) into keys from jsonb_object_keys(to_jsonb(row_state)) key;
  if row_state.user_id <> target or row_state.admin_revision <> 0 or
     keys <> array['admin_revision','delete_due_at','disabled_at','soft_deleted_at','user_id'] then
    raise exception 'Card21a bounded profile read leaked or omitted administrative state'; end if;
  if (select count(*) from case_api.admin_read_profiles(array[target])) <> 1 then
    raise exception 'Card21a profile read escaped requested user set'; end if;
  begin perform * from case_api.admin_read_profiles(array_fill(target,array[1001]));
  exception when invalid_parameter_value then rejected:=true; end;
  if not rejected then raise exception 'Card21a profile metadata read accepted unbounded IDs'; end if;
  if not has_function_privilege('service_role','case_api.admin_read_profiles(uuid[])','execute') or
     has_function_privilege('anon','case_api.admin_read_profiles(uuid[])','execute') or
     has_function_privilege('authenticated','case_api.admin_read_profiles(uuid[])','execute') then
    raise exception 'Card21a profile metadata read escaped service-only gate'; end if;
  raise notice 'ok Card21a bounded administrative profile read shape and privilege';
end $$;

-- Compensation is a new CAS transition, never a revision rewind or a partial timestamp reset.
do $$
declare
  target uuid := case_app.uuid_v7();
  changed record;
  restored record;
  rejected boolean := false;
begin
  insert into auth.users(id) values(target);
  insert into case_app.profiles(id,display_name) values(target,'Private target');
  select * into changed from case_app.admin_transition_profile(target,0,'disable');
  select * into restored from case_app.admin_revert_profile(target,1,null,null,null);
  if restored.user_id<>target or restored.admin_revision<>2 or
     restored.disabled_at is not null or restored.soft_deleted_at is not null or restored.delete_due_at is not null then
    raise exception 'Card21a compensating CAS rewound revision or failed exact state restoration'; end if;
  begin perform * from case_app.admin_revert_profile(target,1,null,null,null);
  exception when serialization_failure then rejected:=true; end;
  if not rejected then raise exception 'Card21a stale compensation overwrote a later profile change'; end if;
  rejected:=false;
  begin perform * from case_app.admin_revert_profile(target,2,null,clock_timestamp(),null);
  exception when invalid_parameter_value then rejected:=true; end;
  if not rejected then raise exception 'Card21a compensation accepted malformed deletion state'; end if;
  if not has_function_privilege('service_role','case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz,boolean,text)','execute') or
     has_function_privilege('anon','case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz,boolean,text)','execute') or
     has_function_privilege('authenticated','case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz,boolean,text)','execute') then
    raise exception 'Card21a compensation escaped service-only gate'; end if;
  raise notice 'ok Card21a exact monotonic compensation CAS and privilege';
end $$;

-- Case administration projects immutable-version metadata only; withdrawal does not alter its pack.
do $$
declare
  actor uuid:=case_app.uuid_v7(); workspace uuid:=case_app.uuid_v7(); case_id uuid:=case_app.uuid_v7();
  first_version uuid:=case_app.uuid_v7(); second_version uuid:=case_app.uuid_v7();
  state record; keys text[]; rejected boolean:=false; signature text;
begin
  insert into auth.users(id) values(actor);
  insert into case_app.profiles(id,display_name) values(actor,'Never projected author');
  insert into case_app.workspaces(id,slug,name) values(workspace,'admin-version-metadata','Version metadata');
  insert into case_app.cases(id,workspace_id,owner_id,title) values(case_id,workspace,actor,'Teaching title');
  insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
  values(first_version,case_id,1,1,'{"unrevealed":"never in admin metadata"}',sha256('one'),actor),
        (second_version,case_id,2,1,'{"unrevealed":"second private pack"}',sha256('two'),actor);
  select * into state from case_api.admin_read_case_version(first_version);
  select array_agg(key order by key) into keys from jsonb_object_keys(to_jsonb(state)) key;
  if state.case_id<>case_id or state.version_id<>first_version or state.status<>'published' or state.admin_revision<>0 or
     keys<>array['admin_revision','case_id','status','title','version_id','version_no'] then
    raise exception 'Card21a admin version metadata binding or private projection drifted'; end if;
  perform * from case_app.admin_set_version_state(first_version,0,'withdraw');
  select * into state from case_api.admin_read_case_version(first_version);
  if state.status<>'withdrawn' or state.admin_revision<>1 then raise exception 'Card21a metadata concealed withdrawn status'; end if;
  if (select document from case_app.case_versions where id=first_version)<>'{"unrevealed":"never in admin metadata"}'::jsonb then
    raise exception 'Card21a withdrawal altered immutable pack'; end if;
  select * into state from case_api.list_admin_case_versions(1,null);
  if state.version_id<>greatest(first_version,second_version) then raise exception 'Card21a admin version list order not UUIDv7 descending'; end if;
  select * into state from case_api.list_admin_case_versions(1,greatest(first_version,second_version));
  if state.version_id<>least(first_version,second_version) then raise exception 'Card21a version cursor skipped explicit next row'; end if;
  begin perform * from case_api.list_admin_case_versions(101,null);
  exception when invalid_parameter_value then rejected:=true; end;
  if not rejected then raise exception 'Card21a version list allowed unbounded page'; end if;
  foreach signature in array array['case_api.admin_read_case_version(uuid)','case_api.list_admin_case_versions(integer,uuid)'] loop
    if not has_function_privilege('service_role',signature,'execute') or has_function_privilege('anon',signature,'execute') or
       has_function_privilege('authenticated',signature,'execute') then raise exception 'Card21a version metadata privilege mismatch'; end if;
  end loop;
  raise notice 'ok Card21a bounded case version metadata, binding, status and cursor';
end $$;

-- Due selection uses server wall clock and deletion can never precede Auth absence.
do $$
declare target uuid:=case_app.uuid_v7(); future_target uuid:=case_app.uuid_v7(); ended timestamptz:=clock_timestamp()-interval '31 days'; rejected boolean:=false;
begin
  insert into auth.users(id) values(target),(future_target);
  insert into case_app.profiles(id,display_name,disabled_at,soft_deleted_at,delete_due_at)
  values(target,'Due private target',ended,ended,ended+interval '30 days'),
        (future_target,'Future private target',now(),now(),now()+interval '30 days');
  if not exists(select 1 from case_api.list_admin_due_profiles(100,null) where user_id=target) or
     exists(select 1 from case_api.list_admin_due_profiles(100,null) where user_id=future_target) then
    raise exception 'Card21a due list included future or omitted due account';end if;
  if case_api.admin_delete_due_profile(target,0) then raise exception 'Card21a profile deletion ran before Auth removal'; end if;
  if not exists(select 1 from case_app.profiles where id=target) then raise exception 'Card21a Auth failure created ghost profile'; end if;
  delete from auth.users where id=target;
  if not case_api.admin_delete_due_profile(target,0) or not case_api.admin_delete_due_profile(target,0) then
    raise exception 'Card21a Auth-first profile deletion replay not idempotent'; end if;
  if case_api.admin_delete_due_profile(future_target,0) then raise exception 'Card21a future profile was deleted'; end if;
  begin perform * from case_api.list_admin_due_profiles(101,null);
  exception when invalid_parameter_value then rejected:=true;end;
  if not rejected then raise exception 'Card21a hard-delete sweep page unbounded';end if;
  if not has_function_privilege('service_role','case_api.list_admin_due_profiles(integer,uuid)','execute') or
     has_function_privilege('authenticated','case_api.list_admin_due_profiles(integer,uuid)','execute') or
     has_function_privilege('anon','case_api.admin_delete_due_profile(uuid,bigint)','execute') then
    raise exception 'Card21a due sweep service boundary escaped';end if;
  raise notice 'ok Card21a server-due Auth-first deletion ordering and replay';
end $$;

-- A provider-unknown deletion is claimed once and requires explicit reconciliation.
do $$
declare target uuid:=case_app.uuid_v7(); other_target uuid:=case_app.uuid_v7(); future_target uuid:=case_app.uuid_v7();
  intent uuid:=case_app.uuid_v7(); other_intent uuid:=case_app.uuid_v7(); future_intent uuid:=case_app.uuid_v7();
  ended timestamptz:=clock_timestamp()-interval '31 days'; future_end timestamptz:=clock_timestamp(); rejected boolean:=false;
begin
  insert into auth.users(id) values(target),(other_target),(future_target);
  insert into case_app.profiles(id,display_name,disabled_at,soft_deleted_at,delete_due_at)
    values(target,'Claim private target',ended,ended,ended+interval '30 days'),
      (other_target,'Other claim private target',ended,ended,ended+interval '30 days'),
      (future_target,'Future claim private target',future_end,future_end,future_end+interval '30 days');
  if case_api.admin_claim_due_profile_deletion(target,0,intent) then
    raise exception 'Card21a deletion claim admitted without its durable intent'; end if;
  perform case_api.write_admin_audit(intent,intent,'intent','facilitator_hard_delete','facilitator',target,
    'system@case.iatrogenic.app','{"status":"soft_deleted","admin_revision":0}','{}',null);
  if case_api.admin_claim_due_profile_deletion(other_target,0,intent) then
    raise exception 'Card21a deletion claim used another target intent'; end if;
  perform case_api.write_admin_audit(future_intent,future_intent,'intent','facilitator_hard_delete','facilitator',future_target,
    'system@case.iatrogenic.app','{"status":"soft_deleted","admin_revision":0}','{}',null);
  if case_api.admin_claim_due_profile_deletion(future_target,0,future_intent) then
    raise exception 'Card21a deletion claim admitted before server due time'; end if;
  if case_api.admin_claim_due_profile_deletion(target,0,null) then
    raise exception 'Card21a deletion claim accepted null intent'; end if;
  if case_api.admin_claim_due_profile_deletion(target,1,intent) then
    raise exception 'Card21a deletion claim ignored expected revision'; end if;
  if not case_api.admin_claim_due_profile_deletion(target,0,intent) or
     not case_api.admin_claim_due_profile_deletion(target,0,intent) then
    raise exception 'Card21a due deletion claim or exact replay was refused'; end if;
  if case_api.admin_claim_due_profile_deletion(target,0,other_intent) then
    raise exception 'Card21a unresolved deletion claim was replaced'; end if;
  if (select admin_delete_claim_id from case_app.profiles where id=target)<>intent or
     (select admin_delete_claimed_at from case_app.profiles where id=target) is null then
    raise exception 'Card21a irreversible deletion claim was not durable'; end if;
  if exists(select 1 from case_api.list_admin_due_profiles(100,null) where user_id=target) then
    raise exception 'Card21a later sweep retried unresolved irreversible deletion'; end if;
  begin perform * from case_app.admin_revert_profile(target,0,null,null,null);
  exception when check_violation then rejected:=true; end;
  if not rejected then raise exception 'Card21a compensation cleared claimed deletion cutoff'; end if;
  if not exists(select 1 from auth.users where id=target) then
    raise exception 'Card21a SQL claim itself deleted Auth'; end if;
  if not has_function_privilege('service_role','case_api.admin_claim_due_profile_deletion(uuid,bigint,uuid)','execute') or
     has_function_privilege('anon','case_api.admin_claim_due_profile_deletion(uuid,bigint,uuid)','execute') or
     has_function_privilege('authenticated','case_api.admin_claim_due_profile_deletion(uuid,bigint,uuid)','execute') then
    raise exception 'Card21a deletion claim escaped service-only boundary'; end if;
  raise notice 'ok Card21a durable intent-bound deletion claim excludes unresolved retries and compensation';
end $$;
