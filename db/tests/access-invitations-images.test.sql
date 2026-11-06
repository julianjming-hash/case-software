-- Facilitator-UX A2 (20261111000000_access_invitations_images.sql): access = person × place × level (CASE-336),
-- workspace policies (CASE-337), managers approve and release (CASE-338), invitations (CASE-339) and images without
-- approval, with per-case visibility and per-workspace storage (CASE-342). Plan §3 A2 "DB tests".
\set QUIET on
begin;
-- People: a201 owner, a202 author, a203 facilitator (members of a210); a204 holds Can edit and a205 Can run on case
-- a220 only; a206 owns the other workspace a211; a207 is a configured admin; a208/a209 are invitees.
insert into auth.users (id, email) values
  ('0199a000-0000-7000-8000-00000000a201', 'owner@a2.test'), ('0199a000-0000-7000-8000-00000000a202', 'author@a2.test'),
  ('0199a000-0000-7000-8000-00000000a203', 'runner@a2.test'), ('0199a000-0000-7000-8000-00000000a204', 'editor@a2.test'),
  ('0199a000-0000-7000-8000-00000000a205', 'caserunner@a2.test'), ('0199a000-0000-7000-8000-00000000a206', 'other@a2.test'),
  ('0199a000-0000-7000-8000-00000000a207', 'admin@a2.test'), ('0199a000-0000-7000-8000-00000000a208', 'invitee@a2.test'),
  ('0199a000-0000-7000-8000-00000000a209', 'second@a2.test');
insert into case_app.profiles (id, display_name) values
  ('0199a000-0000-7000-8000-00000000a201', 'Olive Owner'), ('0199a000-0000-7000-8000-00000000a202', 'Ada Author'),
  ('0199a000-0000-7000-8000-00000000a203', 'Fay Runner'), ('0199a000-0000-7000-8000-00000000a204', 'Ed Editor'),
  ('0199a000-0000-7000-8000-00000000a205', 'Cass Runner'), ('0199a000-0000-7000-8000-00000000a206', 'Otto Other'),
  ('0199a000-0000-7000-8000-00000000a207', 'Admin');
insert into case_app.workspaces (id, slug, name) values ('0199a000-0000-7000-8000-00000000a210', 'a2-home', 'A2 home'),
  ('0199a000-0000-7000-8000-00000000a211', 'a2-other', 'A2 other');
insert into case_app.workspace_members (workspace_id, user_id, role) values
  ('0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a201', 'owner'),
  ('0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a202', 'author'),
  ('0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a203', 'facilitator'),
  ('0199a000-0000-7000-8000-00000000a211', '0199a000-0000-7000-8000-00000000a206', 'owner');
insert into case_app.cases (id, workspace_id, owner_id, title) values
  ('0199a000-0000-7000-8000-00000000a220', '0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a202', 'Shared case'),
  ('0199a000-0000-7000-8000-00000000a221', '0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a202', 'Unshared case'),
  ('0199a000-0000-7000-8000-00000000a222', '0199a000-0000-7000-8000-00000000a211', '0199a000-0000-7000-8000-00000000a206', 'Other workspace case');
create temp table a2_doc as select d as doc, case_app.art_structure(d) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb as art
  from (select '{"schema_version":1,"case_title":"A2","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb d) x;
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by)
  select v.id, v.case_id, 1, 1, doc, sha256(convert_to(doc::text, 'UTF8')), '0199a000-0000-7000-8000-00000000a202'
    from a2_doc, (values ('0199a000-0000-7000-8000-00000000a230'::uuid, '0199a000-0000-7000-8000-00000000a220'::uuid),
                         ('0199a000-0000-7000-8000-00000000a231'::uuid, '0199a000-0000-7000-8000-00000000a221'::uuid)) v(id, case_id);
insert into case_app.case_grants (id, case_id, workspace_id, user_id, level) values
  ('0199a000-0000-7000-8000-00000000a240', '0199a000-0000-7000-8000-00000000a220', '0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a204', 'edit'),
  ('0199a000-0000-7000-8000-00000000a241', '0199a000-0000-7000-8000-00000000a220', '0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a205', 'run'),
  -- The workspace runner also holds Can edit on the shared case.
  ('0199a000-0000-7000-8000-00000000a242', '0199a000-0000-7000-8000-00000000a220', '0199a000-0000-7000-8000-00000000a210', '0199a000-0000-7000-8000-00000000a203', 'edit');
select case_api.record_admin_elevation('0199a000-0000-7000-8000-00000000a2ff', 'admin@a2.test', 'admin', '0199a000-0000-7000-8000-00000000a2fe');

create function pg_temp.refused(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
-- The role authorize_case answers, or null when it refuses with 42501.
create function pg_temp.on_case(p_user uuid, p_case uuid, p_action text) returns text language plpgsql as $$
begin return case_app.authorize_case(p_user, p_case, p_action, false, null);
exception when insufficient_privilege then return null; end $$;
create function pg_temp.on_ws(p_user uuid, p_ws uuid, p_action text) returns text language plpgsql as $$
begin return case_app.authorize(p_user, p_ws, p_action, false, null);
exception when insufficient_privilege then return null; end $$;
create function pg_temp.set_policy(p_ws uuid, p_key text, p_on boolean) returns void language plpgsql as $$
begin execute format('update case_app.workspace_policies set %I = %L where workspace_id = %L', p_key, p_on, p_ws); end $$;
create function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('0199a000-0000-7000-8000-00000000a2' || p)::uuid $$;

-- [AS-206] The highest level a person holds on a case wins, and a grant never reaches another case.
do $$
declare r record;
begin
  select * into r from case_app.effective_role(pg_temp.u('03'), pg_temp.u('10'), pg_temp.u('20'));
  if r.role <> 'author' or r.scope <> 'case' then raise exception 'runner + Can edit on the case: %', r; end if;
  select * into r from case_app.effective_role(pg_temp.u('03'), pg_temp.u('10'), pg_temp.u('21'));
  if r.role <> 'facilitator' or r.scope <> 'workspace' then raise exception 'runner on an unshared case: %', r; end if;
  -- A grant never lowers a workspace role: the owner keeps owner, a tie keeps the workspace.
  insert into case_app.case_grants (case_id, workspace_id, user_id, level) values (pg_temp.u('20'), pg_temp.u('10'), pg_temp.u('01'), 'run'),
    (pg_temp.u('20'), pg_temp.u('10'), pg_temp.u('02'), 'edit');
  select * into r from case_app.effective_role(pg_temp.u('01'), pg_temp.u('10'), pg_temp.u('20'));
  if r.role <> 'owner' or r.scope <> 'workspace' then raise exception 'a grant lowered the owner: %', r; end if;
  select * into r from case_app.effective_role(pg_temp.u('02'), pg_temp.u('10'), pg_temp.u('20'));
  if r.role <> 'author' or r.scope <> 'workspace' then raise exception 'a tie did not keep the workspace: %', r; end if;
  if pg_temp.on_case(pg_temp.u('01'), pg_temp.u('20'), 'P-16') is distinct from 'owner' then raise exception 'owner lost P-16 to a grant'; end if;
  delete from case_app.case_grants where user_id in (pg_temp.u('01'), pg_temp.u('02'));
  -- The runner edits the shared case only, and still runs every case of the workspace.
  if pg_temp.on_case(pg_temp.u('03'), pg_temp.u('20'), 'P-14') is distinct from 'author' then raise exception 'runner + Can edit cannot edit'; end if;
  if pg_temp.on_case(pg_temp.u('03'), pg_temp.u('21'), 'P-14') is not null then raise exception 'Can edit on one case reached another'; end if;
  if pg_temp.on_case(pg_temp.u('03'), pg_temp.u('21'), 'P-21') is distinct from 'facilitator' then raise exception 'runner lost P-21'; end if;
  -- Case-only people: nothing on another case, in this workspace or another.
  for r in select * from (values (pg_temp.u('04')), (pg_temp.u('05'))) p(id) loop
    if pg_temp.on_case(r.id, pg_temp.u('21'), 'P-11') is not null or pg_temp.on_case(r.id, pg_temp.u('22'), 'P-11') is not null
       or pg_temp.on_case(r.id, pg_temp.u('21'), 'P-21') is not null then raise exception 'a grant reached another case (%)', r.id; end if;
    if exists (select 1 from case_app.effective_role(r.id, pg_temp.u('10'), pg_temp.u('21'))) then raise exception 'effective_role leaked to case B'; end if;
    if exists (select 1 from case_app.effective_role(r.id, pg_temp.u('11'), pg_temp.u('20'))) then raise exception 'effective_role crossed workspaces'; end if;
  end loop;
  if pg_temp.on_case(pg_temp.u('04'), pg_temp.u('20'), 'P-14') is distinct from 'author' or pg_temp.on_case(pg_temp.u('05'), pg_temp.u('20'), 'P-21') is distinct from 'facilitator'
     or pg_temp.on_case(pg_temp.u('05'), pg_temp.u('20'), 'P-14') is not null then raise exception 'case-only levels wrong on their case'; end if;
  -- No workspace action through a grant: the picker, settings and groups, P-16 and archive.
  if pg_temp.on_ws(pg_temp.u('04'), pg_temp.u('10'), 'P-10') is not null or pg_temp.on_ws(pg_temp.u('04'), pg_temp.u('10'), 'P-12') is not null
     or pg_temp.on_case(pg_temp.u('04'), pg_temp.u('20'), 'P-16') is not null or pg_temp.on_case(pg_temp.u('04'), pg_temp.u('20'), 'P-42') is not null
     -- Even asked through the case: a grant reaches only action_case_roles (create a case, settings, the picker are not).
     or pg_temp.on_case(pg_temp.u('04'), pg_temp.u('20'), 'P-13') is not null or pg_temp.on_case(pg_temp.u('04'), pg_temp.u('20'), 'P-12') is not null
     or pg_temp.on_case(pg_temp.u('05'), pg_temp.u('20'), 'P-10') is not null then
    raise exception 'a case grant reached a workspace action'; end if;
  raise notice 'ok AS-206 highest level per case; grants never reach another case or a workspace action';
end $$;

-- [AS-206] Can manage is never a grant, and the case keeps the grant's workspace honest.
do $$
declare v_err text;
begin
  v_err := pg_temp.refused($q$insert into case_app.case_grants (case_id, workspace_id, user_id, level) values (pg_temp.u('21'), pg_temp.u('10'), pg_temp.u('08'), 'manage')$q$);
  if v_err is null or v_err not like '23514%' then raise exception 'a manage grant was stored: %', v_err; end if;
  insert into case_app.profiles (id, display_name) values (pg_temp.u('08'), 'Invitee') on conflict do nothing;
  v_err := pg_temp.refused($q$insert into case_app.case_grants (case_id, workspace_id, user_id, level) values (pg_temp.u('22'), pg_temp.u('10'), pg_temp.u('08'), 'run')$q$);
  if v_err is null or v_err not like '23503%' then raise exception 'a grant named a foreign workspace: %', v_err; end if;
  v_err := pg_temp.refused($q$insert into case_app.case_grants (case_id, workspace_id, user_id, level) values (pg_temp.u('20'), pg_temp.u('10'), pg_temp.u('04'), 'run')$q$);
  if v_err is null or v_err not like '23505%' then raise exception 'two live grants on one case: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, %L, 'manage', 'x@a2.test', sha256('m'::bytea), null, false, null)$q$, pg_temp.u('01'), pg_temp.u('10'), pg_temp.u('20')));
  if v_err is null or v_err not like '22023%' then raise exception 'a case invitation as Can manage: %', v_err; end if;
  raise notice 'ok AS-206 Can manage is never a grant; one live grant per case; the grant''s workspace is the case''s';
end $$;

-- [AS-206] The old five-argument authorize still resolves, alone (no overload), and authorize_case has no defaults.
do $$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'case_app' and p.proname = 'authorize') <> 1
     or to_regprocedure('case_app.authorize(uuid,uuid,text,boolean,text)') is null then raise exception 'authorize was overloaded or changed'; end if;
  if (select pronargdefaults from pg_proc where oid = 'case_app.authorize_case(uuid,uuid,text,boolean,text)'::regprocedure) <> 0 then
    raise exception 'authorize_case has defaults'; end if;
  if case_app.authorize(pg_temp.u('03'), pg_temp.u('10'), 'P-11', false, null) <> 'facilitator'
     or case_app.authorize(pg_temp.u('07'), pg_temp.u('10'), 'P-11', true, 'admin@a2.test') <> 'admin' then raise exception 'old authorize call'; end if;
  if case_app.authorize_case(pg_temp.u('07'), pg_temp.u('20'), 'P-14', true, 'admin@a2.test') <> 'admin' then raise exception 'admin on a case'; end if;
  raise notice 'ok the five-argument authorize resolves unchanged; authorize_case takes no defaults';
end $$;

-- [AS-206] Revoked grants, grants on an archived case and grants of a disabled account are inert.
do $$
begin
  update case_app.case_grants set revoked_at = now() where id = pg_temp.u('41');
  if pg_temp.on_case(pg_temp.u('05'), pg_temp.u('20'), 'P-21') is not null then raise exception 'a revoked grant still runs'; end if;
  update case_app.case_grants set revoked_at = null where id = pg_temp.u('41');
  update case_app.profiles set disabled_at = now() where id = pg_temp.u('05');
  if pg_temp.refused(format($q$select case_app.authorize_case(%L, %L, 'P-21', false, null)$q$, pg_temp.u('05'), pg_temp.u('20'))) not like '42501%account_not_active%' then
    raise exception 'a disabled account''s grant still runs'; end if;
  update case_app.profiles set disabled_at = null where id = pg_temp.u('05');
  update case_app.cases set archived_at = now() where id = pg_temp.u('20');
  if pg_temp.on_case(pg_temp.u('04'), pg_temp.u('20'), 'P-14') is not null then raise exception 'a grant on an archived case still edits'; end if;
  if pg_temp.on_case(pg_temp.u('02'), pg_temp.u('20'), 'P-14') is distinct from 'author' then raise exception 'archiving changed a membership'; end if;
  update case_app.cases set archived_at = null where id = pg_temp.u('20');
  raise notice 'ok revoked, archived-case and disabled-account grants are inert';
end $$;

-- [AS-210] Every workspace has a policy row; existing workspaces got the CASE-337 defaults with managers_see_records ON;
-- a new workspace gets them from the trigger; each policy flips exactly its own cells.
do $$
declare p jsonb; k text; o uuid := pg_temp.u('01'); a uuid := pg_temp.u('02'); f uuid := pg_temp.u('03'); e uuid := pg_temp.u('04');
  c uuid := pg_temp.u('05'); ws uuid := pg_temp.u('10'); sc uuid := pg_temp.u('20');
begin
  if exists (select 1 from case_app.workspaces w left join case_app.workspace_policies x on x.workspace_id = w.id where x.workspace_id is null) then
    raise exception 'a workspace has no policy row'; end if;
  p := case_app.policies_of(ws);
  if p <> '{"managers_invite":true,"editors_publish":false,"runners_share":false,"managers_see_records":true}'::jsonb then raise exception 'defaults %', p; end if;
  if case_app.policies_of(case_app.uuid_v7()) <> '{}'::jsonb then raise exception 'a missing workspace has policies'; end if;
  -- Start from every policy off, then turn each on alone: only its cells change.
  foreach k in array array['managers_invite', 'editors_publish', 'runners_share', 'managers_see_records'] loop perform pg_temp.set_policy(ws, k, false); end loop;
  if pg_temp.on_ws(o, ws, 'P-03') is not null or pg_temp.on_ws(o, ws, 'P-44') is not null or pg_temp.on_case(a, sc, 'P-15') is not null
     or pg_temp.on_case(e, sc, 'P-33') is not null or pg_temp.on_case(f, sc, 'P-43') is not null or pg_temp.on_case(c, sc, 'P-43') is not null then
    raise exception 'a policy cell was on with every policy off'; end if;
  foreach k in array array['managers_invite', 'editors_publish', 'runners_share', 'managers_see_records'] loop
    perform pg_temp.set_policy(ws, k, true);
    if (pg_temp.on_ws(o, ws, 'P-03') is not null) <> (k = 'managers_invite') or (pg_temp.on_ws(o, ws, 'P-44') is not null) <> (k = 'managers_invite')
       or (pg_temp.on_case(a, sc, 'P-15') is not null) <> (k = 'editors_publish') or (pg_temp.on_case(a, sc, 'P-33') is not null) <> (k = 'editors_publish')
       or (pg_temp.on_case(e, sc, 'P-15') is not null) <> (k = 'editors_publish') or (pg_temp.on_case(e, sc, 'P-33') is not null) <> (k = 'editors_publish')
       or (pg_temp.on_case(f, sc, 'P-43') is not null) <> (k = 'runners_share') or (pg_temp.on_case(a, sc, 'P-43') is not null) <> (k = 'runners_share')
       or (pg_temp.on_case(c, sc, 'P-43') is not null) <> (k = 'runners_share') or (pg_temp.on_case(e, sc, 'P-43') is not null) <> (k = 'runners_share') then
      raise exception 'policy % flipped a cell that is not its own', k; end if;
    -- Never-policy cells stay as the matrix says: runners never publish, a case runner never edits, nobody but an admin sets policies.
    if pg_temp.on_case(f, pg_temp.u('21'), 'P-15') is not null or pg_temp.on_case(c, sc, 'P-14') is not null or pg_temp.on_ws(o, ws, 'P-45') is not null
       or pg_temp.on_case(o, sc, 'P-15') is distinct from 'owner' or pg_temp.on_case(o, sc, 'P-43') is distinct from 'owner' then
      raise exception 'policy % changed a fixed cell', k; end if;
    perform pg_temp.set_policy(ws, k, false);
  end loop;
  -- Another workspace's policy reaches nothing here.
  update case_app.workspace_policies set managers_invite = true, editors_publish = true, runners_share = true where workspace_id = pg_temp.u('11');
  if pg_temp.on_case(a, sc, 'P-15') is not null or pg_temp.on_ws(o, ws, 'P-03') is not null then raise exception 'a foreign policy applied'; end if;
  update case_app.workspace_policies set managers_invite = true, managers_see_records = true where workspace_id = ws;
  insert into case_app.workspaces (id, slug, name) values (pg_temp.u('12'), 'a2-new', 'A2 new');
  if case_app.policies_of(pg_temp.u('12')) <> '{"managers_invite":true,"editors_publish":false,"runners_share":false,"managers_see_records":true}'::jsonb then
    raise exception 'a new workspace missed the defaults'; end if;
  raise notice 'ok AS-210 policy rows with CASE-337 defaults (managers see records on); each policy flips exactly its cells';
end $$;

-- [AS-210] Only an admin sets policies (P-45), against the revision, with JSON booleans only; audited as policy_set.
do $$
declare v jsonb; v_err text; ws uuid := pg_temp.u('10');
begin
  v_err := pg_temp.refused(format($q$select case_api.admin_set_workspace_policies(%L, %L, 0, '{"runners_share":true}', null, false, null)$q$, pg_temp.u('01'), ws));
  if v_err is null or v_err not like '42501%' then raise exception 'an owner set policies: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.admin_set_workspace_policies(%L, %L, 0, '{"runners_share":"true"}', null, true, 'admin@a2.test')$q$, pg_temp.u('07'), ws));
  if v_err is null or v_err not like '22023%' then raise exception 'a string policy value: %', v_err; end if;
  v := case_api.admin_set_workspace_policies(pg_temp.u('07'), ws, (select revision from case_app.workspace_policies where workspace_id = ws),
    '{"runners_share":true}', 3000000000, true, 'admin@a2.test');
  if (v->>'runners_share')::boolean is not true or (v->>'managers_invite')::boolean is not true or (v->>'mediaQuotaBytes')::bigint <> 3000000000 then raise exception 'set %', v; end if;
  v_err := pg_temp.refused(format($q$select case_api.admin_set_workspace_policies(%L, %L, 0, '{}', null, true, 'admin@a2.test')$q$, pg_temp.u('07'), ws));
  if v_err is null or v_err not like '40001%' then raise exception 'a stale revision: %', v_err; end if;
  if (select count(*) from case_app.workspace_audit where workspace_id = ws and action in ('policy_set', 'quota_set') and actor_kind = 'admin') <> 2 then
    raise exception 'policy and quota changes not audited'; end if;
  update case_app.workspace_policies set runners_share = false where workspace_id = ws;
  update case_app.workspaces set media_quota_bytes = 2000000000 where id = ws;
  raise notice 'ok AS-210 only an admin sets policies, by revision, booleans only, audited';
end $$;

-- [AS-211] An owner approves and releases the workspace's candidate, audited as owner; an author releases only while
-- editors_publish is on, audited as author; withdraw and republish (P-16) stay with owners.
do $$
declare o uuid := pg_temp.u('01'); a uuid := pg_temp.u('02'); e uuid := pg_temp.u('04'); sc uuid := pg_temp.u('21'); b record; r record; v_err text;
  op uuid; d jsonb := (select doc from a2_doc); m jsonb := '{"metadata_version":1,"sources":[],"provenance":[]}';
begin
  select operation_id into op from case_api.builder_open_save_window(sc, 0, a, false, null);
  perform case_api.builder_save_draft(sc, op, d, m, a, false, null);
  select * into b from case_api.builder_submit_candidate(sc, case_app.uuid_v7(), 1, d, m, a, false, null);
  v_err := pg_temp.refused(format($q$select * from case_api.builder_approve_candidate(%L,%L,1,%L::bytea,%L::bytea,%L,false,null)$q$, sc, b.candidate_id, b.intent_digest, b.content_sha256, a));
  if v_err is null or v_err not like '42501%' then raise exception 'an author approved with editors_publish off: %', v_err; end if;
  if (select count(*) from case_api.builder_get_review_candidate(sc, b.candidate_id, o, false, null)) <> 1 then raise exception 'owner cannot inspect'; end if;
  perform * from case_api.builder_approve_candidate(sc, b.candidate_id, 1, b.intent_digest, b.content_sha256, o, false, null);
  if not exists (select 1 from case_app.workspace_audit where target_id = b.candidate_id and action = 'builder_candidate_approve' and actor_kind = 'owner'
      and actor_user_id = o and actor_email is null) then raise exception 'owner approval not audited as owner'; end if;
  v_err := pg_temp.refused(format($q$select * from case_api.builder_release_candidate(%L,%L,1,%L::bytea,%L::bytea,'{}',%L::jsonb,%L,false,null)$q$,
    sc, b.candidate_id, b.intent_digest, b.content_sha256, (select art from a2_doc), a));
  if v_err is null or v_err not like '42501%' then raise exception 'an author released with editors_publish off: %', v_err; end if;
  select * into r from case_api.builder_release_update(sc, b.candidate_id, 1, b.intent_digest, b.content_sha256, '{}', (select art from a2_doc), false, o, false, null);
  if not exists (select 1 from case_app.workspace_audit where target_id = r.version_id and action = 'version_publish' and actor_kind = 'owner') then
    raise exception 'owner release not audited as owner'; end if;
  -- editors_publish on: the author and the case-only editor approve and release, audited as author.
  update case_app.workspace_policies set editors_publish = true where workspace_id = pg_temp.u('10');
  select operation_id into op from case_api.builder_open_save_window(sc, 1, a, false, null);
  perform case_api.builder_save_draft(sc, op, jsonb_set(d, '{case_title}', '"A2 two"'), m, a, false, null);
  select * into b from case_api.builder_submit_candidate(sc, case_app.uuid_v7(), 2, jsonb_set(d, '{case_title}', '"A2 two"'), m, a, false, null);
  perform * from case_api.builder_approve_candidate(sc, b.candidate_id, 2, b.intent_digest, b.content_sha256, a, false, null);
  select * into r from case_api.builder_release_candidate(sc, b.candidate_id, 2, b.intent_digest, b.content_sha256, '{}',
    case_app.art_structure(jsonb_set(d, '{case_title}', '"A2 two"')) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb, a, false, null);
  if not exists (select 1 from case_app.workspace_audit where target_id = r.version_id and action = 'version_publish' and actor_kind = 'author' and actor_email is null) then
    raise exception 'author release not audited as author'; end if;
  if pg_temp.on_case(e, pg_temp.u('20'), 'P-15') is distinct from 'author' then raise exception 'case-only editor cannot release under the policy'; end if;
  update case_app.workspace_policies set editors_publish = false where workspace_id = pg_temp.u('10');
  if pg_temp.on_case(o, sc, 'P-16') is distinct from 'owner' or pg_temp.on_case(a, sc, 'P-16') is not null or pg_temp.on_case(e, pg_temp.u('20'), 'P-16') is not null then
    raise exception 'P-16 moved'; end if;
  raise notice 'ok AS-211 owners approve and release audited as owner; editors only under editors_publish, audited as author';
end $$;

-- [AS-205] A case-only editor edits that case, uploads an image usable at once, sees only that case's images and
-- cannot create a case; the workspace-keyed media RPCs refuse them.
do $$
declare e uuid := pg_temp.u('04'); a uuid := pg_temp.u('02'); sc uuid := pg_temp.u('20'); ws uuid := pg_temp.u('10'); op uuid; v_err text;
  mine jsonb; theirs jsonb; again jsonb; rend jsonb := jsonb_build_object('bytes', 4000, 'width', 1200, 'height', 800); listed jsonb;
begin
  select operation_id into op from case_api.builder_open_save_window(sc, 0, e, false, null);
  if (select count(*) from case_api.builder_save_draft(sc, op, (select doc from a2_doc), '{"metadata_version":1,"sources":[],"provenance":[]}', e, false, null)) <> 1 then
    raise exception 'the case-only editor cannot save'; end if;
  if (select count(*) from case_api.builder_create_checkpoint(sc, 'Shared editor checkpoint', 1, e, false, null)) <> 1 then raise exception 'case editor checkpoint'; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_case(%L, %L, 'New', false, null)$q$, e, ws));
  if v_err is null or v_err not like '42501%' then raise exception 'a case-only editor created a case: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_list_assets(%L, %L, false, null, null)$q$, ws, e));
  if v_err is null or v_err not like '42501%' then raise exception 'the workspace image library opened to a case grant: %', v_err; end if;
  if not case_api.builder_case_media_put_allowance(sc, e, false, null, repeat('1', 64), 4000, 'image/jpeg') then raise exception 'allowance'; end if;
  -- An image needs a description and the uploader's confirmation; the credit is optional.
  v_err := pg_temp.refused(format($q$select case_api.builder_create_case_asset(%L, %L, false, null, %L, %L, '{"alt_text":"ECG"}', null)$q$, sc, e,
    rend || jsonb_build_object('sha256', repeat('1', 64)), rend || jsonb_build_object('sha256', repeat('2', 64))));
  if v_err is null or v_err not like '22023%asset_details_incomplete%' then raise exception 'an unconfirmed upload: %', v_err; end if;
  mine := case_api.builder_create_case_asset(sc, e, false, null, rend || jsonb_build_object('sha256', repeat('1', 64)),
    rend || jsonb_build_object('sha256', repeat('2', 64)), '{"alt_text":"ECG lead II","attested":true}', null);
  if mine->>'status' <> 'quarantined' or (mine->>'created')::boolean is not true or mine->>'licence' is not null then raise exception 'upload %', mine; end if;
  -- A member's image in the same workspace, for the unshared case.
  theirs := case_api.builder_create_case_asset(pg_temp.u('21'), a, false, null, rend || jsonb_build_object('sha256', repeat('3', 64)),
    rend || jsonb_build_object('sha256', repeat('4', 64)), '{"alt_text":"CXR","attested":true}', null);
  listed := case_api.builder_list_case_assets(sc, e, false, null, null);
  if jsonb_array_length(listed) <> 1 or listed->0->>'asset_id' <> mine->>'asset_id' then raise exception 'the editor saw other cases'' images: %', listed; end if;
  if (select count(*) from case_api.builder_case_asset_rendition(sc, (theirs->>'asset_id')::uuid, 'display', e, false, null)) <> 0 then
    raise exception 'the editor read another case''s image'; end if;
  if (select r2_key from case_api.builder_case_asset_rendition(sc, (mine->>'asset_id')::uuid, 'display', e, false, null)) is null then
    raise exception 'the editor cannot read their own upload'; end if;
  -- A member sees every image of the workspace through any case.
  if jsonb_array_length(case_api.builder_list_case_assets(sc, a, false, null, null)) < 2 then raise exception 'a member lost the workspace library'; end if;
  -- Saving an image ID alone cannot expand a case editor's image access.
  select operation_id into op from case_api.builder_open_save_window(sc, 1, e, false, null);
  perform case_api.builder_save_draft(sc, op, (select doc from a2_doc) || jsonb_build_object('surfaces', jsonb_build_array(jsonb_build_object('id', 's1', 'asset_ids', jsonb_build_array(theirs->>'asset_id')))),
    '{"metadata_version":1,"sources":[],"provenance":[]}', e, false, null);
  if exists (select 1 from case_api.builder_case_asset_rendition(sc, (theirs->>'asset_id')::uuid, 'display', e, false, null)) then
    raise exception 'guessing an image ID granted access'; end if;
  -- A workspace author legitimately reusing that image links it for this case's editors, even on a no-op save.
  select operation_id into op from case_api.builder_open_save_window(sc, 2, a, false, null);
  perform case_api.builder_save_draft(sc, op, (select document from case_app.case_drafts where case_id=sc),
    '{"metadata_version":1,"sources":[],"provenance":[]}', a, false, null);
  if not exists (select 1 from case_api.builder_case_asset_rendition(sc, (theirs->>'asset_id')::uuid, 'display', e, false, null)) then
    raise exception 'a reused draft image was not linked for the case editor'; end if;
  -- [AS-213] Dedup by content hash in the workspace: the same file is the same image, now linked to this case too.
  again := case_api.builder_create_case_asset(sc, e, false, null, rend || jsonb_build_object('sha256', repeat('3', 64)),
    rend || jsonb_build_object('sha256', repeat('4', 64)), '{"alt_text":"CXR again","attested":true}', null);
  if again->>'asset_id' <> theirs->>'asset_id' or (again->>'created')::boolean then raise exception 'dedup %', again; end if;
  if jsonb_array_length(case_api.builder_list_case_assets(sc, e, false, null, null)) <> 2 then raise exception 'a deduplicated image is not linked to the case'; end if;
  -- A case runner cannot upload.
  v_err := pg_temp.refused(format($q$select case_api.builder_case_media_put_allowance(%L, %L, false, null, repeat('5', 64), 4000, 'image/jpeg')$q$, sc, pg_temp.u('05')));
  if v_err is null or v_err not like '42501%' then raise exception 'a Can run grant uploaded: %', v_err; end if;
  raise notice 'ok AS-205 a case-only editor edits, uploads, sees only that case''s images and cannot create a case';
end $$;

-- [AS-213] Images are usable at once: readiness and release ignore approval, only a taken-down image refuses; an
-- unapproved legacy image is now releasable; a case-only releaser may release only that case's images.
do $$
declare a uuid := pg_temp.u('02'); o uuid := pg_temp.u('01'); sc uuid := pg_temp.u('21'); ws uuid := pg_temp.u('10'); img uuid; gone uuid; op uuid; b record; r record;
  d jsonb; m jsonb := '{"metadata_version":1,"sources":[],"provenance":[]}'; rend jsonb := jsonb_build_object('bytes', 4000, 'width', 1200, 'height', 800);
  det jsonb := jsonb_build_object('alt_text', 'ECG', 'evidence_kind', 'ecg', 'rights_basis', 'own_work', 'licence', 'own-work'); v_err text; rev bigint;
begin
  -- A legacy upload through the deployed workspace-keyed RPC, never approved.
  img := (case_api.builder_create_asset(ws, a, false, null, rend || jsonb_build_object('sha256', repeat('6', 64)), rend || jsonb_build_object('sha256', repeat('7', 64)), det)->>'asset_id')::uuid;
  gone := (case_api.builder_create_asset(ws, a, false, null, rend || jsonb_build_object('sha256', repeat('8', 64)), rend || jsonb_build_object('sha256', repeat('9', 64)), det)->>'asset_id')::uuid;
  update case_app.assets set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'Takedown' where id = gone;
  d := (select doc from a2_doc) || jsonb_build_object('surfaces', jsonb_build_array(jsonb_build_object('id', 's1', 'asset_ids', jsonb_build_array(img))));
  rev := (select revision from case_app.case_drafts where case_id = sc);
  select operation_id into op from case_api.builder_open_save_window(sc, rev, a, false, null);
  perform case_api.builder_save_draft(sc, op, d, m, a, false, null);
  rev := rev + 1;
  if exists (select 1 from case_api.builder_publication_readiness(sc, rev, a, false, null) x where x.code = 'asset_not_approved') then
    raise exception 'readiness still asks for approval'; end if;
  select * into b from case_api.builder_submit_candidate(sc, case_app.uuid_v7(), rev, d, m, a, false, null);
  perform * from case_api.builder_approve_candidate(sc, b.candidate_id, rev, b.intent_digest, b.content_sha256, o, false, null);
  v_err := pg_temp.refused(format($q$select * from case_api.builder_release_candidate(%L,%L,%s,%L::bytea,%L::bytea,%L::uuid[],%L::jsonb,%L,false,null)$q$,
    sc, b.candidate_id, rev, b.intent_digest, b.content_sha256, array[img, gone], case_app.art_structure(d) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb, o));
  if v_err is null or v_err not like '23514%asset_unavailable%' then raise exception 'a taken-down image was releasable: %', v_err; end if;
  select * into r from case_api.builder_release_candidate(sc, b.candidate_id, rev, b.intent_digest, b.content_sha256, array[img],
    case_app.art_structure(d) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb, o, false, null);
  if (select status from case_app.assets where id = img) <> 'quarantined' or not exists (select 1 from case_app.case_version_assets where case_version_id = r.version_id and asset_id = img) then
    raise exception 'the unapproved image was not released'; end if;
  if not exists (select 1 from case_app.case_assets where asset_id = img and case_id = sc) then raise exception 'release did not link the image to its case'; end if;
  -- Room media: the version's unapproved image is served; a taken-down one is not.
  insert into case_app.sessions (id, case_version_id, workspace_id, facilitator_id, join_code, expires_at)
    values (pg_temp.u('50'), r.version_id, ws, o, 'A2AAAA', now() + interval '1 hour');
  if (select x.r2_key from case_api.session_media_rendition(o, pg_temp.u('50'), img, false, null) x) is null then raise exception 'room media refused a live image'; end if;
  update case_app.assets set status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'Takedown' where id = img;
  if (select x.r2_key from case_api.session_media_rendition(o, pg_temp.u('50'), img, false, null) x) is not null then raise exception 'room media served a taken-down image'; end if;
  -- The sweep never closes an old live image (approval is gone).
  update case_app.assets set created_at = now() - interval '60 days' where id = (select id from case_app.assets where workspace_id = ws and status = 'quarantined' order by created_at limit 1);
  perform case_api.media_purge_claim(10);
  if exists (select 1 from case_app.assets where workspace_id = ws and status = 'rejected') then raise exception 'the sweep closed an old live image'; end if;
  raise notice 'ok AS-213 images are usable at once; only a taken-down image is refused in release and room media';
end $$;

-- [AS-212] People: admin_read_access answers each listed account's workspace roles and live case grants, and nothing else.
do $$
declare a jsonb;
begin
  a := case_api.admin_read_access(array[pg_temp.u('01'), pg_temp.u('03'), pg_temp.u('04')]);
  if jsonb_array_length(a) <> 4 then raise exception 'access rows: %', a; end if;
  if not (a @> jsonb_build_array(jsonb_build_object('userId', pg_temp.u('01'), 'kind', 'member', 'role', 'owner', 'workspaceName', 'A2 home')))
     or not (a @> jsonb_build_array(jsonb_build_object('userId', pg_temp.u('03'), 'kind', 'member', 'role', 'facilitator')))
     or not (a @> jsonb_build_array(jsonb_build_object('userId', pg_temp.u('03'), 'kind', 'grant', 'role', 'edit', 'caseTitle', 'Shared case')))
     or not (a @> jsonb_build_array(jsonb_build_object('userId', pg_temp.u('04'), 'kind', 'grant', 'role', 'edit', 'caseId', pg_temp.u('20')))) then
    raise exception 'access content: %', a; end if;
  if exists (select 1 from jsonb_array_elements(a) x where (x->>'userId')::uuid = pg_temp.u('02')) then raise exception 'an unlisted account was answered'; end if;
  -- A revoked grant and a grant on an archived case are not listed.
  update case_app.case_grants set revoked_at = now() where id = '0199a000-0000-7000-8000-00000000a241';
  update case_app.cases set archived_at = now() where id = pg_temp.u('21');
  if jsonb_array_length(case_api.admin_read_access(array[pg_temp.u('05')])) <> 0 then raise exception 'a revoked grant was listed'; end if;
  update case_app.cases set archived_at = now() where id = pg_temp.u('20');
  if jsonb_array_length(case_api.admin_read_access(array[pg_temp.u('03'), pg_temp.u('04')])) <> 1 then raise exception 'a grant on an archived case was listed'; end if;
  update case_app.cases set archived_at = null where id in (pg_temp.u('20'), pg_temp.u('21'));
  update case_app.case_grants set revoked_at = null where id = '0199a000-0000-7000-8000-00000000a241';
  raise notice 'ok admin_read_access: roles and live grants only';
end $$;

-- [AS-213] Storage: usage against a per-workspace quota (2 GB default), a storage_full refusal naming both, the unused
-- listing (no draft, version, candidate or checkpoint; not taken down; a day old) and Delete unused with the step-up.
do $$
declare adm uuid := pg_temp.u('07'); e uuid := pg_temp.u('04'); ws uuid := pg_temp.u('10'); s jsonb; v_err text; unused uuid; used uuid; out jsonb;
  rend jsonb := jsonb_build_object('bytes', 4000, 'width', 1200, 'height', 800);
begin
  if (select media_quota_bytes from case_app.workspaces where id = ws) <> 2000000000 then raise exception 'default quota'; end if;
  v_err := pg_temp.refused(format($q$select case_api.admin_workspace_storage(%L, %L, false, null)$q$, pg_temp.u('01'), ws));
  if v_err is null or v_err not like '42501%' then raise exception 'an owner read storage: %', v_err; end if;
  s := case_api.admin_workspace_storage(adm, ws, true, 'admin@a2.test');
  if (s->>'usedBytes')::bigint <> case_app.media_bytes_in_use(ws) or (s->>'usedBytes')::bigint <= 0 or (s->>'quotaBytes')::bigint <> 2000000000 then raise exception 'storage %', s; end if;
  -- A5: the workspace's policies and their revision travel with its storage (Administration -> Workspaces reads one answer).
  if s->'policies' is distinct from case_app.policies_of(ws) or (s->'policies') is null or jsonb_typeof(s->'policies') <> 'object'
     or (s->>'policyRevision')::bigint is distinct from (select p.revision from case_app.workspace_policies p where p.workspace_id = ws) then
    raise exception 'storage lost the policies: %', s; end if;
  update case_app.workspaces set media_quota_bytes = case_app.media_bytes_in_use(ws) where id = ws;
  v_err := pg_temp.refused(format($q$select case_api.builder_case_media_put_allowance(%L, %L, false, null, repeat('e', 64), 4000, 'image/jpeg')$q$, pg_temp.u('20'), e));
  if v_err is null or v_err not like '23514%storage_full: used % of % bytes' then raise exception 'quota refusal: %', v_err; end if;
  -- A file the workspace already holds is not counted again (dedup by content hash): its upload is allowed at a full quota.
  if not case_api.builder_case_media_put_allowance(pg_temp.u('20'), e, false, null,
      (select encode(a.content_sha256, 'hex') from case_app.assets a where a.workspace_id = ws and a.status in ('quarantined', 'approved')
        and a.media_type = 'image/jpeg' order by a.id limit 1), 4000, 'image/jpeg') then raise exception 'a held file counted twice'; end if;
  v_err := pg_temp.refused(format($q$select case_api.builder_media_put_allowance(%L, %L, false, null, repeat('e', 64), 4000)$q$, ws, pg_temp.u('02')));
  if v_err is null or v_err not like '23514%media_quota%' then raise exception 'the deployed path lost its quota refusal: %', v_err; end if;
  update case_app.workspaces set media_quota_bytes = 2000000000 where id = ws;
  -- One image nothing uses, one only a draft uses; both two days old.
  unused := (case_api.builder_create_case_asset(pg_temp.u('20'), e, false, null, rend || jsonb_build_object('sha256', repeat('a', 64)), rend || jsonb_build_object('sha256', repeat('b', 64)), '{"alt_text":"Spare","attested":true}', null)->>'asset_id')::uuid;
  used := (case_api.builder_create_case_asset(pg_temp.u('20'), e, false, null, rend || jsonb_build_object('sha256', repeat('c', 64)), rend || jsonb_build_object('sha256', repeat('d', 64)), '{"alt_text":"Placed","attested":true}', null)->>'asset_id')::uuid;
  update case_app.case_drafts set document = document || jsonb_build_object('surfaces', jsonb_build_array(jsonb_build_object('id', 's', 'asset_ids', jsonb_build_array(used)))) where case_id = pg_temp.u('20');
  if exists (select 1 from case_app.unused_assets(ws) u where u.id = unused) then raise exception 'a fresh upload was offered for deletion'; end if;
  update case_app.assets set created_at = now() - interval '2 days' where workspace_id = ws;
  s := case_api.admin_workspace_storage(adm, ws, true, 'admin@a2.test');
  if not (s->'unused' @> jsonb_build_array(jsonb_build_object('assetId', unused))) or s->'unused' @> jsonb_build_array(jsonb_build_object('assetId', used)) then
    raise exception 'unused listing %', s->'unused'; end if;
  if exists (select 1 from case_app.unused_assets(ws) u where u.status in ('withdrawn', 'rejected')
      or exists (select 1 from case_app.case_version_assets v where v.asset_id = u.id)) then raise exception 'a taken-down or released image is listed'; end if;
  v_err := pg_temp.refused(format($q$select case_api.admin_delete_unused_assets(%L, %L, array[%L, %L]::uuid[], null, true, 'admin@a2.test')$q$, adm, ws, unused, used));
  if v_err is null or v_err not like '42501%' then raise exception 'Delete unused without the step-up: %', v_err; end if;
  out := case_api.admin_delete_unused_assets(adm, ws, array[unused, used], pg_temp.u('ff'), true, 'admin@a2.test');
  if out->'deleted' <> jsonb_build_array(unused) or (out->>'queuedKeys')::int <> 2 then raise exception 'delete %', out; end if;
  if exists (select 1 from case_app.assets where id = unused) or not exists (select 1 from case_app.assets where id = used) then raise exception 'delete removed the wrong image'; end if;
  if not exists (select 1 from case_app.workspace_audit where target_id = unused and action = 'asset_delete_unused' and actor_kind = 'admin' and elevation_id = pg_temp.u('ff')) then
    raise exception 'Delete unused not audited with the step-up'; end if;
  if (select count(*) from case_app.media_purge_queue where reason = 'unused') <> 2 then raise exception 'stored files not queued'; end if;
  raise notice 'ok AS-213 storage meter, per-workspace quota with storage_full, unused listing and Delete unused';
end $$;

-- [AS-207] A case-only runner starts a room, sees it among their live rooms, and reads only their own records.
do $$
declare c uuid := pg_temp.u('05'); o uuid := pg_temp.u('01'); f uuid := pg_temp.u('03'); ws uuid := pg_temp.u('10'); room uuid := case_app.uuid_v7(); other uuid := case_app.uuid_v7(); v_err text;
begin
  if (select count(*) from case_api.get_case_version_for_workspace(pg_temp.u('30'), ws, c, false, null)) <> 1 then raise exception 'rehearsal read'; end if;
  -- Ruling R7: the id lookup the Worker makes first answers the version's case (null for an unknown one) and nothing else.
  -- Rolling deploy: the old Worker expects empty rows (404), not 42501, for a missing or foreign version.
  if exists (select 1 from case_api.get_case_version_for_workspace(pg_temp.u('ff'), ws, f, false, null))
     or exists (select 1 from case_api.room_media_manifest(pg_temp.u('ff'), ws, f, false, null))
     or exists (select 1 from case_api.get_case_version_for_workspace(pg_temp.u('30'), pg_temp.u('11'), pg_temp.u('06'), false, null))
     or exists (select 1 from case_api.room_media_manifest(pg_temp.u('30'), pg_temp.u('11'), pg_temp.u('06'), false, null)) then
    raise exception 'missing or foreign version exposed rows'; end if;
  v_err := pg_temp.refused(format($q$select * from case_api.get_case_version_for_workspace(%L, %L, %L, false, null)$q$, pg_temp.u('31'), ws, c));
  if v_err is null or v_err not like '42501%' then raise exception 'unshared case was authorised: %', v_err; end if;
  if case_api.version_case(pg_temp.u('31')) is distinct from case_app.case_of_version(pg_temp.u('31')) or case_api.version_case(pg_temp.u('31')) is null
     or case_api.version_case(pg_temp.u('30')) = case_api.version_case(pg_temp.u('31')) or case_api.version_case(case_app.uuid_v7()) is not null then
    raise exception 'version_case lookup'; end if;
  perform case_api.create_session(room, pg_temp.u('30'), ws, c, 'A2BBBB', interval '1 hour', false, null);
  v_err := pg_temp.refused(format($q$select case_api.create_session(%L, %L, %L, %L, 'A2CCCC', interval '1 hour', false, null)$q$, case_app.uuid_v7(), pg_temp.u('31'), ws, c));
  if v_err is null or v_err not like '42501%' then raise exception 'a case runner started an unshared case: %', v_err; end if;
  perform case_api.create_session(other, pg_temp.u('31'), ws, f, 'A2DDDD', interval '1 hour', false, null);
  if (select array_agg(session_id) from case_api.list_owned_active_sessions(c, 100, null, false, null)) is distinct from array[room] then raise exception 'own live rooms'; end if;
  if (select array_agg(session_id) from case_api.list_room_history(c, ws, 'all', 100, null, null, false, null)) is distinct from array[room] then raise exception 'own history'; end if;
  if jsonb_array_length(case_api.query_session_portfolio(c, ws, '', 'all', null, null, null, false, false, null)->'rooms') <> 1 then raise exception 'own records search'; end if;
  if (case_api.personal_portfolio_stats(c, ws, false, null)->>'sessions')::int <> 1 then raise exception 'own stats'; end if;
  if case_api.read_session_portfolio(c, room, 0, null, false, null) is null then raise exception 'own record'; end if;
  v_err := pg_temp.refused(format($q$select case_api.read_session_portfolio(%L, %L, 0, null, false, null)$q$, c, other));
  if v_err is null or v_err not like '42501%' then raise exception 'a case runner read another room: %', v_err; end if;
  if case_api.session_feedback_summary(c, room, false, null) is null then raise exception 'own feedback'; end if;
  -- managers_see_records (on): the owner reads both rooms; off, only their own (none here).
  if (select count(*) from case_api.list_room_history(o, ws, 'all', 100, null, null, false, null) h where h.session_id in (room, other)) <> 2 then raise exception 'owner records'; end if;
  update case_app.workspace_policies set managers_see_records = false where workspace_id = ws;
  if (select count(*) from case_api.list_room_history(o, ws, 'all', 100, null, null, false, null) h where h.session_id in (room, other)) <> 0 then raise exception 'owner records with the policy off'; end if;
  update case_app.workspace_policies set managers_see_records = true where workspace_id = ws;
  -- Once the grant ends the room leaves their live list and their records list.
  update case_app.case_grants set revoked_at = now() where id = pg_temp.u('41');
  if exists (select 1 from case_api.list_owned_active_sessions(c, 100, null, false, null)) then raise exception 'live room survived the grant'; end if;
  v_err := pg_temp.refused(format($q$select * from case_api.list_room_history(%L, %L, 'all', 100, null, null, false, null)$q$, c, ws));
  if v_err is null or v_err not like '42501%' then raise exception 'records list survived the grant: %', v_err; end if;
  update case_app.case_grants set revoked_at = null where id = pg_temp.u('41');
  raise notice 'ok AS-207 a case-only runner starts, lists and reads only their own rooms of the case they hold';
end $$;

-- [AS-214] /me lists live grants; access facts; Shared with you hides a never-published case from Can run and marks a withdrawn one.
do $$
declare v record; r record; n int;
begin
  select * into v from case_api.get_me(pg_temp.u('04'), 100, null, null, false, null);
  if v.memberships <> '[]'::jsonb or jsonb_array_length(v.grants) <> 1 or v.grants->0->>'level' <> 'edit' or v.grants->0->>'case_id' <> pg_temp.u('20')::text then
    raise exception 'get_me grants %', v.grants; end if;
  -- Each membership and grant carries its workspace's policies, so the Worker's authorize reads membership, grant and
  -- policies in this one call (plan §3 A3).
  if v.grants->0->'policies' is distinct from case_app.policies_of(pg_temp.u('10')) then raise exception 'get_me grant policies %', v.grants; end if;
  select * into v from case_api.get_me(pg_temp.u('01'), 1, null, pg_temp.u('10'), false, null);
  if v.memberships->0->'policies' is distinct from case_app.policies_of(pg_temp.u('10')) or v.memberships->0->>'role' is distinct from 'owner' then
    raise exception 'get_me membership policies %', v.memberships; end if;
  select * into r from case_api.get_access(pg_temp.u('03'), null, pg_temp.u('20'), false, null);
  if r.member_role <> 'facilitator' or r.grant_level <> 'edit' or r.role <> 'author' or r.scope <> 'case' or r.workspace_id <> pg_temp.u('10') then raise exception 'access %', r; end if;
  if exists (select 1 from case_api.get_access(pg_temp.u('04'), pg_temp.u('11'), pg_temp.u('20'), false, null)) or
     exists (select 1 from case_api.get_access(pg_temp.u('04'), null, pg_temp.u('21'), false, null)) then raise exception 'access answered a foreign place'; end if;
  insert into case_app.cases (id, workspace_id, title) values (pg_temp.u('23'), pg_temp.u('10'), 'Draft only');
  insert into case_app.case_grants (case_id, workspace_id, user_id, level) values (pg_temp.u('23'), pg_temp.u('10'), pg_temp.u('05'), 'run'), (pg_temp.u('23'), pg_temp.u('10'), pg_temp.u('04'), 'edit');
  select count(*) into n from case_api.list_shared_cases(pg_temp.u('05')) s where s.case_id = pg_temp.u('23');
  if n <> 0 then raise exception 'Can run saw a draft-only case'; end if;
  select count(*) into n from case_api.list_shared_cases(pg_temp.u('04')) s where s.case_id = pg_temp.u('23') and s.level = 'edit';
  if n <> 1 then raise exception 'Can edit lost a draft-only case'; end if;
  insert into case_app.admin_version_state (case_version_id, status) values (pg_temp.u('30'), 'withdrawn');
  if not (select s.withdrawn from case_api.list_shared_cases(pg_temp.u('05')) s where s.case_id = pg_temp.u('20')) then raise exception 'a withdrawn shared case not marked'; end if;
  delete from case_app.admin_version_state where case_version_id = pg_temp.u('30');
  raise notice 'ok /me grants, access facts and Shared with you';
end $$;

-- [AS-208] Invitations: create with defined outcomes and caps, peek reveals only live facts, expiry and revoke end the
-- reference without leaking the address, acceptance is by the verified email and never lowers a role.
do $$
declare o uuid := pg_temp.u('01'); f uuid := pg_temp.u('03'); adm uuid := pg_temp.u('07'); ws uuid := pg_temp.u('10'); sc uuid := pg_temp.u('20');
  v jsonb; inv uuid; p record; n int; v_err text; acc jsonb;
begin
  -- An owner invites into the workspace (managers_invite on) as author, never as manager.
  v := case_api.create_invitation(o, ws, null, 'edit', 'invitee@a2.test', sha256('ref-1'::bytea), null, false, null);
  if v->>'outcome' <> 'created' or v->>'workspaceName' <> 'A2 home' or v->>'inviterName' <> 'Olive Owner' then raise exception 'create %', v; end if;
  inv := (v->>'invitationId')::uuid;
  if (select expires_at - created_at from case_app.invitations where id = inv) <> interval '90 days' then raise exception '90-day life'; end if;
  if not exists (select 1 from case_app.workspace_audit where target_id = inv and action = 'invitation_create' and actor_kind = 'owner') then raise exception 'create not audited'; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, null, 'manage', 'boss@a2.test', sha256('ref-x'::bytea), null, false, null)$q$, o, ws));
  if v_err is null or v_err not like '42501%' then raise exception 'an owner invited a manager: %', v_err; end if;
  if (case_api.create_invitation(o, ws, null, 'edit', 'invitee@a2.test', sha256('ref-2'::bytea), null, false, null))->>'outcome' <> 'already_invited' then raise exception 'duplicate'; end if;
  if (case_api.create_invitation(o, ws, null, 'run', 'runner@a2.test', sha256('ref-3'::bytea), f, false, null))->>'outcome' <> 'already_has_access' then raise exception 'already has access'; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, null, 'run', 'someone@a2.test', sha256('ref-4'::bytea), %L, false, null)$q$, o, ws, f));
  if v_err is null or v_err not like '22023%' then raise exception 'an account id that is not the address: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, null, 'run', 'Mixed@a2.test', sha256('ref-5'::bytea), null, false, null)$q$, o, ws));
  if v_err is null or v_err not like '22023%' then raise exception 'an unnormalised address: %', v_err; end if;
  -- managers_invite off: the owner cannot invite into the workspace, but still shares a case (P-43 is the owner's own cell).
  update case_app.workspace_policies set managers_invite = false where workspace_id = ws;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, null, 'run', 'nope@a2.test', sha256('ref-6'::bytea), null, false, null)$q$, o, ws));
  if v_err is null or v_err not like '42501%' then raise exception 'an owner invited with managers_invite off: %', v_err; end if;
  if (case_api.create_invitation(o, ws, sc, 'edit', 'second@a2.test', sha256('ref-7'::bytea), null, false, null))->>'outcome' <> 'created' then raise exception 'owner share'; end if;
  update case_app.workspace_policies set managers_invite = true where workspace_id = ws;
  -- A runner shares only under runners_share, and only as Can run.
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, %L, 'run', 'r1@a2.test', sha256('ref-8'::bytea), null, false, null)$q$, pg_temp.u('05'), ws, sc));
  if v_err is null or v_err not like '42501%' then raise exception 'a runner shared with runners_share off: %', v_err; end if;
  update case_app.workspace_policies set runners_share = true where workspace_id = ws;
  if (case_api.create_invitation(pg_temp.u('05'), ws, sc, 'run', 'r1@a2.test', sha256('ref-8'::bytea), null, false, null))->>'outcome' <> 'created' then raise exception 'runner share'; end if;
  -- A runner who shares is audited as their real kind (orchestrator ruling R2, CASE-338).
  if not exists (select 1 from case_app.workspace_audit a join case_app.invitations i on i.id = a.target_id
      where i.ref_hash = sha256('ref-8'::bytea) and a.action = 'invitation_create' and a.actor_kind = 'facilitator'
        and a.actor_user_id = pg_temp.u('05') and a.actor_email is null) then raise exception 'a runner share was not audited as facilitator'; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, %L, 'edit', 'r2@a2.test', sha256('ref-9'::bytea), null, false, null)$q$, pg_temp.u('05'), ws, sc));
  if v_err is null or v_err not like '42501%' then raise exception 'a runner shared Can edit: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.create_invitation(%L, %L, %L, 'run', 'r3@a2.test', sha256('ref-10'::bytea), null, false, null)$q$, pg_temp.u('05'), pg_temp.u('11'), sc));
  if v_err is null or v_err not like '42501%' then raise exception 'a case invitation named another workspace: %', v_err; end if;
  update case_app.workspace_policies set runners_share = false where workspace_id = ws;
  -- Peek: the live reference shows the address, inviter, place and level only.
  select * into p from case_api.peek_invitation(sha256('ref-1'::bytea));
  if p.email <> 'invitee@a2.test' or p.inviter_name <> 'Olive Owner' or p.workspace_name <> 'A2 home' or p.case_title is not null or p.level <> 'edit' then raise exception 'peek %', p; end if;
  if exists (select 1 from case_api.peek_invitation(sha256('nonsense'::bytea))) or exists (select 1 from case_api.peek_invitation('\x00'::bytea)) then raise exception 'peek of an unknown reference'; end if;
  -- Resend replaces the reference (only its hash is stored): the old link ends.
  if (case_api.resend_invitation(o, inv, sha256('ref-1b'::bytea), false, null))->>'outcome' <> 'resend' then raise exception 'resend'; end if;
  if exists (select 1 from case_api.peek_invitation(sha256('ref-1'::bytea))) or not exists (select 1 from case_api.peek_invitation(sha256('ref-1b'::bytea))) then raise exception 'resend kept the old reference'; end if;
  if (case_api.record_invitation_delivery(inv, 'sent', null))->>'sendState' <> 'sent' then raise exception 'delivery'; end if;
  if (select send_count from case_app.invitations where id = inv) <> 1 then raise exception 'delivery count'; end if;
  perform case_api.record_invitation_delivery(inv, 'email_limit', now() + interval '1 hour');
  if (select retry_after from case_app.invitations where id = inv) is null or (select send_state from case_app.invitations where id = inv) <> 'email_limit' then raise exception 'email limit retry time'; end if;
  -- Listing: managers_invite owners and admins; runners never.
  if jsonb_array_length(case_api.list_invitations(o, ws, null, false, null)->'invitations') < 3 then raise exception 'list'; end if;
  v_err := pg_temp.refused(format($q$select case_api.list_invitations(%L, %L, null, false, null)$q$, f, ws));
  if v_err is null or v_err not like '42501%' then raise exception 'a runner listed invitations: %', v_err; end if;
  -- Wrong address: accepting as someone else changes nothing and reveals nothing.
  insert into auth.users (id, email) values (pg_temp.u('0a'), 'mallory@a2.test');
  if case_api.accept_invitations(pg_temp.u('0a'), 'invitee@a2.test') <> '[]'::jsonb then raise exception 'accepted with an unverified address'; end if;
  if (select status from case_app.invitations where id = inv) <> 'pending' then raise exception 'a wrong address ended the invitation'; end if;
  -- Revoke ends it; an expired one ends too: neither reveals the address.
  v := case_api.create_invitation(adm, ws, null, 'run', 'late@a2.test', sha256('ref-11'::bytea), null, true, 'admin@a2.test');
  update case_app.invitations set created_at = now() - interval '91 days', expires_at = now() - interval '1 day' where id = (v->>'invitationId')::uuid;
  if exists (select 1 from case_api.peek_invitation(sha256('ref-11'::bytea))) then raise exception 'an expired reference answered'; end if;
  if (case_api.resend_invitation(adm, (v->>'invitationId')::uuid, sha256('ref-11b'::bytea), true, 'admin@a2.test'))->>'outcome' <> 'ended' then raise exception 'resend of an expired invitation'; end if;
  if (case_api.revoke_invitation(o, inv, false, null))->>'outcome' <> 'revoked' then raise exception 'revoke'; end if;
  if exists (select 1 from case_api.peek_invitation(sha256('ref-1b'::bytea))) then raise exception 'a revoked reference answered'; end if;
  if not exists (select 1 from case_app.workspace_audit where target_id = inv and action = 'invitation_revoke' and actor_kind = 'owner') then raise exception 'revoke not audited'; end if;
  if case_api.accept_invitations(pg_temp.u('08'), 'invitee@a2.test') <> '[]'::jsonb then raise exception 'a revoked invitation was accepted'; end if;
  if (case_api.revoke_invitation(o, inv, false, null))->>'outcome' <> 'ended' then raise exception 'second revoke'; end if;
  -- An invitation to a new address in the same place after expiry is allowed again.
  if (case_api.create_invitation(adm, ws, null, 'run', 'late@a2.test', sha256('ref-12'::bytea), null, true, 'admin@a2.test'))->>'outcome' <> 'created' then raise exception 're-invite after expiry'; end if;
  raise notice 'ok AS-208 invitation outcomes, peek of live facts only, resend rotates, expiry and revoke end without the address';
end $$;

-- [AS-208] Acceptance by the verified email: a membership or a grant; a role is only ever raised; last owner holds.
do $$
declare o uuid := pg_temp.u('01'); adm uuid := pg_temp.u('07'); ws uuid := pg_temp.u('10'); sc uuid := pg_temp.u('20'); acc jsonb; v_err text;
begin
  -- second@ holds a pending Can edit on the shared case (from the owner) and gets a Can run on it too and a workspace run.
  perform case_api.create_invitation(adm, ws, null, 'run', 'second@a2.test', sha256('ref-20'::bytea), null, true, 'admin@a2.test');
  acc := case_api.accept_invitations(pg_temp.u('09'), 'second@a2.test');
  if jsonb_array_length(acc) <> 2 or acc::text like '%second@a2.test%' then raise exception 'accept %', acc; end if;
  if case_app.member_role(pg_temp.u('09'), ws) <> 'facilitator' or case_app.grant_role(pg_temp.u('09'), sc) <> 'author' then raise exception 'accepted places'; end if;
  if not (acc @> '[{"change":"new","level":"edit"}]'::jsonb) or not (acc @> '[{"change":"new","level":"run"}]'::jsonb) then raise exception 'what is new: %', acc; end if;
  if (select count(*) from case_app.workspace_audit where action = 'invitation_accept' and actor_kind = 'system' and actor_user_id is null and workspace_id = ws) <> 2 then
    raise exception 'acceptance not audited'; end if;
  if not exists (select 1 from case_app.workspace_audit a join case_app.case_grants g on g.id = a.target_id
      where a.action = 'case_grant' and a.actor_kind = 'system' and g.user_id = pg_temp.u('09') and g.case_id = sc) then raise exception 'the new grant not audited'; end if;
  -- Never lowers: Can run on a case with Can edit stays edit; an owner invited to run stays owner.
  perform case_api.create_invitation(o, ws, sc, 'run', 'second@a2.test', sha256('ref-21'::bytea), null, false, null);
  perform case_api.create_invitation(adm, ws, null, 'run', 'owner@a2.test', sha256('ref-22'::bytea), null, true, 'admin@a2.test');
  acc := case_api.accept_invitations(pg_temp.u('09'), 'second@a2.test') || case_api.accept_invitations(o, 'owner@a2.test');
  if case_app.grant_role(pg_temp.u('09'), sc) <> 'author' or case_app.member_role(o, ws) <> 'owner' or not (acc @> '[{"change":"unchanged"}]'::jsonb) then
    raise exception 'acceptance lowered a role: %', acc; end if;
  -- Raised: a Can run grant invited to Can edit; a facilitator invited as author.
  insert into case_app.case_grants (case_id, workspace_id, user_id, level) values (pg_temp.u('21'), ws, pg_temp.u('09'), 'run');
  perform case_api.create_invitation(o, ws, pg_temp.u('21'), 'edit', 'second@a2.test', sha256('ref-23'::bytea), null, false, null);
  perform case_api.create_invitation(o, ws, null, 'edit', 'second@a2.test', sha256('ref-24'::bytea), null, false, null);
  acc := case_api.accept_invitations(pg_temp.u('09'), 'second@a2.test');
  if case_app.grant_role(pg_temp.u('09'), pg_temp.u('21')) <> 'author' or case_app.member_role(pg_temp.u('09'), ws) <> 'author' or not (acc @> '[{"change":"raised"}]'::jsonb) then
    raise exception 'raise %', acc; end if;
  -- The last-owner guard still holds.
  v_err := pg_temp.refused(format($q$delete from case_app.workspace_members where workspace_id = %L and user_id = %L$q$, pg_temp.u('11'), pg_temp.u('06')));
  if v_err is null then raise exception 'the last owner was removed'; end if;
  -- [AS-214] Revoking a grant: only a manager; archiving a case ends its grants and invitations, audited.
  v_err := pg_temp.refused(format($q$select case_api.revoke_case_grant(%L, %L, false, null)$q$, pg_temp.u('02'), pg_temp.u('40')));
  if v_err is null or v_err not like '42501%' then raise exception 'an author removed access: %', v_err; end if;
  if (case_api.revoke_case_grant(o, (select id from case_app.case_grants where case_id = pg_temp.u('21') and user_id = pg_temp.u('09') and revoked_at is null), false, null))->>'outcome' <> 'revoked' then
    raise exception 'owner revoke'; end if;
  perform case_api.create_invitation(o, ws, pg_temp.u('23'), 'edit', 'pending@a2.test', sha256('ref-25'::bytea), null, false, null);
  if (select outcome from case_api.builder_archive_case(pg_temp.u('23'), o, '', false, null)) <> 'archived' then raise exception 'archive'; end if;
  if exists (select 1 from case_app.case_grants where case_id = pg_temp.u('23') and revoked_at is null)
     or exists (select 1 from case_app.invitations where case_id = pg_temp.u('23') and status = 'pending')
     or (select count(*) from case_app.workspace_audit where action = 'case_grant_revoke' and target_type = 'grant' and actor_kind = 'owner') < 3 then
    raise exception 'archiving left shares'; end if;
  raise notice 'ok AS-208 acceptance by verified email raises only; last owner holds; archive and revoke end shares';
end $$;

-- [AS-209] The per-inviter daily cap counts creates and resends; nothing is written past it.
do $$
declare o uuid := pg_temp.u('01'); ws uuid := pg_temp.u('10'); v jsonb; before int;
begin
  insert into case_app.invitation_events (invitation_id, actor_user_id, kind, at)
    select (select id from case_app.invitations order by created_at limit 1), o, 'resend', now() - interval '1 hour' from generate_series(1, 50);
  select count(*) into before from case_app.invitations;
  v := case_api.create_invitation(o, ws, null, 'run', 'capped@a2.test', sha256('ref-30'::bytea), null, false, null);
  if v->>'outcome' <> 'cap_reached' or (v->>'retryAfter')::timestamptz <= now() or (select count(*) from case_app.invitations) <> before then raise exception 'cap %', v; end if;
  update case_app.invitation_events set at = now() - interval '25 hours' where actor_user_id = o;
  if (case_api.create_invitation(o, ws, null, 'run', 'capped@a2.test', sha256('ref-30'::bytea), null, false, null))->>'outcome' <> 'created' then raise exception 'cap did not roll over'; end if;
  raise notice 'ok AS-209 the daily cap counts creates and resends and rolls over after a day';
end $$;

-- [AS-208] Invitation addresses are personal data: nulled 30 days after the invitation ends; live ones are kept.
do $$
declare n int;
begin
  update case_app.invitations set revoked_at = now() - interval '31 days' where status = 'revoked';
  update case_app.invitations set created_at = now() - interval '200 days', expires_at = now() - interval '110 days' where ref_hash = sha256('ref-11'::bytea);
  -- Ended recently: an invitation revoked today and the accepted ones keep their address for now.
  perform case_api.revoke_invitation(pg_temp.u('07'), ((case_api.create_invitation(pg_temp.u('07'), pg_temp.u('10'), null, 'run', 'recent@a2.test',
    sha256('ref-40'::bytea), null, true, 'admin@a2.test'))->>'invitationId')::uuid, true, 'admin@a2.test');
  n := case_api.purge_invitation_addresses();
  if (select email from case_app.invitations where ref_hash = sha256('ref-40'::bytea)) is null
     or exists (select 1 from case_app.invitations where status = 'accepted' and email is null) then raise exception 'purged an address too early'; end if;
  if n < 2 or exists (select 1 from case_app.invitations where status = 'revoked' and email is not null and revoked_at < now() - interval '30 days')
     or exists (select 1 from case_app.invitations where status = 'pending' and email is null) then raise exception 'purge %', n; end if;
  if (select status from case_app.invitations where ref_hash = sha256('ref-11'::bytea)) <> 'expired' or (select email from case_app.invitations where ref_hash = sha256('ref-11'::bytea)) is not null then
    raise exception 'an expired invitation kept its address'; end if;
  if case_api.purge_invitation_addresses() <> 0 then raise exception 'purge is not idempotent'; end if;
  raise notice 'ok AS-208 ended invitations lose their address after 30 days';
end $$;

-- Privileges: no new table or helper is reachable from the client roles; every new RPC is service-only by signature.
do $$
begin
  if exists (select 1 from unnest(array['case_app.workspace_policies', 'case_app.invitations', 'case_app.invitation_events', 'case_app.case_grants', 'case_app.case_assets']) t
      where has_table_privilege('anon', t, 'select') or has_table_privilege('authenticated', t, 'select') or has_table_privilege('service_role', t, 'select')) then
    raise exception 'a new table is readable from outside'; end if;
  if has_function_privilege('anon', 'case_api.peek_invitation(bytea)', 'execute') or has_function_privilege('authenticated', 'case_api.accept_invitations(uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'case_api.create_invitation(uuid,uuid,uuid,text,text,bytea,uuid,boolean,text)', 'execute')
     or not has_function_privilege('service_role', 'case_api.get_me(uuid,integer,uuid,uuid,boolean,text)', 'execute')
     or has_function_privilege('authenticated', 'case_api.admin_read_access(uuid[])', 'execute') or has_function_privilege('anon', 'case_api.admin_read_access(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'case_api.admin_read_access(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'case_api.version_case(uuid)', 'execute') or not has_function_privilege('service_role', 'case_api.version_case(uuid)', 'execute')
     or has_function_privilege('service_role', 'case_app.authorize_case(uuid,uuid,text,boolean,text)', 'execute') then raise exception 'new function privileges'; end if;
  raise notice 'ok new tables closed, helpers internal, RPCs service-only';
end $$;
rollback;
