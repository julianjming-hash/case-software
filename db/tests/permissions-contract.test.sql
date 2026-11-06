-- db/tests/permissions-contract.test.sql: assertions for 20261010000000_permissions_contract.sql (card 35b), the
-- CONTRACT step of the card 35 rollout (docs/RUNBOOK-INCIDENT.md §Card 35 database rollout, step 4).
\set QUIET on

-- [PM-contract] The expand-window overloads and the retired functions are gone, so a Worker bug can no longer
-- reach an admin-only body without the admin flag (PERMISSIONS §7.1). The old admin-only bodies live on in
-- case_app, callable only from the case_api wrappers that check the flag, the actor and the audit.
do $$
declare v text; v_bad text;
begin
  foreach v in array array[
      'case_api.admin_provision_facilitator(uuid,uuid)',
      'case_api.admin_set_version_state(uuid,bigint,text)',
      'case_api.admin_transition_profile(uuid,bigint,text)',
      'case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz)',
      'case_api.bootstrap_workspace(uuid,text,text)',
      'case_api.list_case_catalogue(uuid,uuid,text,boolean,text,integer,text,integer,integer,boolean,text)',
      'case_api.publish_draft(uuid,bigint,uuid,uuid[])',
      'case_api.get_case_version(uuid,uuid)',
      'case_api.create_session(uuid,uuid,uuid,text,interval)'] loop
    if to_regprocedure(v) is not null then raise exception 'PM-contract: % still exists', v; end if;
  end loop;
  -- Exactly one signature is left for each name the Worker calls, so a named call cannot resolve elsewhere.
  select string_agg(p.proname, ', ') into v_bad from (
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'case_api' and p.proname in ('admin_provision_facilitator', 'admin_set_version_state',
       'admin_transition_profile', 'admin_revert_profile', 'bootstrap_workspace', 'list_case_catalogue', 'create_session')
     group by p.proname having count(*) <> 1) p;
  if v_bad is not null then raise exception 'PM-contract: more or fewer than one signature for %', v_bad; end if;
  foreach v in array array[
      'case_app.admin_provision_facilitator(uuid,uuid)',
      'case_app.admin_set_version_state(uuid,bigint,text)',
      'case_app.admin_transition_profile(uuid,bigint,text)',
      'case_app.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz)'] loop
    if to_regprocedure(v) is null then raise exception 'PM-contract: the folded body % is missing', v; end if;
    if has_function_privilege('service_role', v, 'execute') or has_function_privilege('authenticated', v, 'execute') or
       has_function_privilege('anon', v, 'execute') then raise exception 'PM-contract: % is callable from outside', v; end if;
  end loop;
  -- No remaining body calls a dropped function (plpgsql resolves calls only at run time).
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('case_api', 'case_app')
     and p.prosrc ~ 'case_api\.(admin_provision_facilitator|admin_set_version_state|admin_transition_profile|admin_revert_profile|publish_draft|get_case_version|bootstrap_workspace)\s*\(';
  if v_bad is not null then raise exception 'PM-contract: a body still calls a case_api admin or retired function: %', v_bad; end if;
  -- Each admin wrapper reaches its folded body.
  foreach v in array array['case_api.admin_provision_facilitator(uuid,uuid,uuid,boolean,text)',
      'case_api.admin_set_version_state(uuid,bigint,text,uuid,boolean,text,uuid)',
      'case_api.admin_transition_profile(uuid,bigint,text,boolean,text)',
      'case_api.admin_revert_profile(uuid,bigint,timestamptz,timestamptz,timestamptz,boolean,text)'] loop
    if (select prosrc from pg_proc where oid = to_regprocedure(v)) !~ ('case_app\.' || split_part(split_part(v, '.', 2), '(', 1) || '\s*\(') then
      raise exception 'PM-contract: % does not call its folded body', v; end if;
    if not has_function_privilege('service_role', v, 'execute') then raise exception 'PM-contract: % lost its grant', v; end if;
  end loop;
  raise notice 'ok PM-contract old overloads and retired functions dropped; admin bodies folded into case_app';
end $$;

-- [PM-contract] The admin wrappers still do their work through the folded bodies, refuse without the flag, and
-- audit inside the workspace (the old 2-argument invite is gone, so no unaudited path remains).
begin;
insert into auth.users values ('0199a000-0000-7000-8000-0000000035b1'), ('0199a000-0000-7000-8000-0000000035b2'),
  ('0199a000-0000-7000-8000-0000000035b3');
insert into case_app.profiles (id, display_name) values ('0199a000-0000-7000-8000-0000000035b1', 'CB admin'),
  ('0199a000-0000-7000-8000-0000000035b3', 'CB target');
insert into case_app.workspaces (id, slug, name) values ('0199a000-0000-7000-8000-0000000035ba', 'cb-home', 'CB home');
do $$
declare a uuid := '0199a000-0000-7000-8000-0000000035b1'; w uuid := '0199a000-0000-7000-8000-0000000035ba';
  t uuid := '0199a000-0000-7000-8000-0000000035b2'; p uuid := '0199a000-0000-7000-8000-0000000035b3'; r record; refused boolean := false;
begin
  begin perform case_api.admin_provision_facilitator(t, w, a, false, null);
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'PM-contract: invite without the admin flag'; end if;
  perform case_api.admin_provision_facilitator(t, w, a, true, 'cb-admin@example.org');
  if (select role from case_app.workspace_members where workspace_id = w and user_id = t) is distinct from 'facilitator' then
    raise exception 'PM-contract: the folded invite body did not run'; end if;
  if not exists (select 1 from case_app.workspace_audit where workspace_id = w and action = 'member_invite' and target_id = t) then
    raise exception 'PM-contract: the invite was not audited'; end if;
  select * into r from case_api.admin_transition_profile(p, 0, 'disable', true, 'cb-admin@example.org');
  if r.disabled_at is null or r.admin_revision <> 1 then raise exception 'PM-contract: the folded transition did not run'; end if;
  select * into r from case_api.admin_revert_profile(p, 1, null, null, null, true, 'cb-admin@example.org');
  if r.disabled_at is not null or r.admin_revision <> 2 then raise exception 'PM-contract: the folded revert did not run'; end if;
  raise notice 'ok PM-contract admin wrappers run the folded bodies, refuse without the flag and audit';
end $$;
rollback;
