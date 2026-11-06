-- [AS-172] Card 62 (CASE-285 R1, MEDIA-03): an admin approves exactly the image they were shown. The server works out the open
-- warnings itself, refuses an approval whose shown state or acknowledged warnings differ (40001 asset_details_changed),
-- and records the acknowledged warnings on the asset_approve audit row. Warnings stay soft: acknowledged, never blocked.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-000000006209'),('0199a000-0000-7000-8000-000000006201'),('0199a000-0000-7000-8000-000000006202'),
  ('0199a000-0000-7000-8000-000000006203'),('0199a000-0000-7000-8000-000000006204');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-000000006201','Owner'),('0199a000-0000-7000-8000-000000006202','Author'),
  ('0199a000-0000-7000-8000-000000006203','Facilitator'),('0199a000-0000-7000-8000-000000006204','Outsider');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-000000006210','fence-a','Fence A');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-000000006210','0199a000-0000-7000-8000-000000006201','owner'),
 ('0199a000-0000-7000-8000-000000006210','0199a000-0000-7000-8000-000000006202','author'),
 ('0199a000-0000-7000-8000-000000006210','0199a000-0000-7000-8000-000000006203','facilitator');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
-- One uploaded image: its display and phone bytes are made from a seed so each call is a new asset.
create function pg_temp.image(p_seed text, p_licence text, p_basis text, p_attr text default null, p_note text default null, p_attested boolean default null) returns uuid language sql as $$
  select (case_api.builder_create_asset('0199a000-0000-7000-8000-000000006210', '0199a000-0000-7000-8000-000000006202', false, null,
    jsonb_build_object('sha256', encode(sha256(convert_to(p_seed||'d','UTF8')),'hex'), 'bytes', 4000, 'width', 1200, 'height', 800),
    jsonb_build_object('sha256', encode(sha256(convert_to(p_seed||'p','UTF8')),'hex'), 'bytes', 2000, 'width', 640, 'height', 427),
    jsonb_strip_nulls(jsonb_build_object('alt_text', 'Chest film', 'evidence_kind', 'imaging', 'rights_basis', p_basis, 'licence', p_licence,
      'attribution', p_attr, 'rights_note', p_note, 'attested', p_attested)))->>'asset_id')::uuid $$;
-- What the Builder showed the admin: the listed row's attestation and rights fields, exactly.
create function pg_temp.shown(p_id uuid) returns jsonb language sql as $$
  select jsonb_build_object('attested', r->'attested', 'rights_basis', r->'rights_basis', 'licence', r->'licence', 'creator', r->'creator',
    'attribution', r->'attribution', 'rights_note', r->'rights_note', 'source_url', r->'source_url')
  from (select case_app.asset_row(a) r from case_app.assets a where a.id = p_id) x $$;
create function pg_temp.approve(p_id uuid, p_expected jsonb, p_ack text[], p_user uuid default '0199a000-0000-7000-8000-000000006209', p_admin boolean default true,
  p_email text default 'admin@example.com') returns text language sql as $$
  select format('select case_api.admin_review_asset(%L,%L,%L,%L::jsonb,%L::text[],%L,%L,%L)', '0199a000-0000-7000-8000-000000006210', p_id, 'approve', p_expected, p_ack, p_user, p_admin, p_email) $$;
create temp table ids(name text primary key, id uuid);

do $$
declare v_id uuid;
begin
  -- The open warnings, as the author was warned at upload (src/shared/media.mjs assetDetails), named by code.
  insert into ids values ('clean', pg_temp.image('clean', 'own-work', 'own_work', null, null, true)),
    ('unknown', pg_temp.image('unknown', 'unknown', 'unlicensed')),
    ('ccby', pg_temp.image('ccby', 'CC-BY-4.0', 'creative_commons', null, null, true)),
    ('nc', pg_temp.image('nc', 'CC-BY-NC-ND-4.0', 'creative_commons', 'Fig 1, A. Author', null, true)),
    ('publication', pg_temp.image('publication', 'unlicensed', 'unlicensed', 'Figure 2, Textbook of X', null, true)),
    ('licensed', pg_temp.image('licensed', 'licensed-other', 'licensed', 'Hospital library', null, true)),
    ('licensed-note', pg_temp.image('licensed-note', 'licensed-other', 'licensed', 'Hospital library', 'Teaching licence 2026', true));
  if (select array_agg(i.name || '=' || array_to_string(case_app.asset_open_warnings(a), ',') order by i.name collate "C") from ids i join case_app.assets a on a.id = i.id) is distinct from
     array['ccby=credit_missing', 'clean=', 'licensed=licence_terms_missing', 'licensed-note=', 'nc=licence_caution', 'publication=no_licence', 'unknown=not_deidentified,source_unknown'] then
    raise exception 'open warnings: %', (select array_agg(i.name || '=' || array_to_string(case_app.asset_open_warnings(a), ',') order by i.name collate "C") from ids i join case_app.assets a on a.id = i.id);
  end if;
  raise notice 'ok the server names each open warning by code';
end $$;

do $$
declare v_err text; v_id uuid := (select id from ids where name = 'unknown'); v_ok text := pg_temp.approve((select id from ids where name = 'unknown'), pg_temp.shown((select id from ids where name = 'unknown')), '{not_deidentified,source_unknown}');
  who record;
begin
  -- Every non-admin is still refused, even with the exact shown state and acknowledgements (P-33).
  for who in select * from (values ('owner','0199a000-0000-7000-8000-000000006201'::uuid,false,null::text), ('author','0199a000-0000-7000-8000-000000006202',false,null),
      ('facilitator','0199a000-0000-7000-8000-000000006203',false,null), ('outsider','0199a000-0000-7000-8000-000000006204',false,null),
      ('admin flag without email','0199a000-0000-7000-8000-000000006201',true,null)) x(name, id, admin, email) loop
    v_err := pg_temp.refused(pg_temp.approve(v_id, pg_temp.shown(v_id), '{not_deidentified,source_unknown}', who.id, who.admin, who.email));
    if v_err is null or v_err not like '42501%' then raise exception '% approved: %', who.name, v_err; end if;
  end loop;
  -- The unfenced six-argument signature was dropped by the contract migration (20261105000000): no caller reaches it.
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve','0199a000-0000-7000-8000-000000006209',true,'admin@example.com')$q$, '0199a000-0000-7000-8000-000000006210', v_id));
  if v_err is null or v_err not like '42883%' then raise exception 'admin on the old signature: %', v_err; end if;
  if (select status from case_app.assets where id = v_id) <> 'quarantined' then raise exception 'a refused caller changed the image'; end if;
  raise notice 'ok owners, authors, facilitators, outsiders and an email-less admin flag are refused (42501); the unfenced signature is gone';

  -- Missing acknowledgements are refused: none, one of two, or one that is not open.
  for v_err in select pg_temp.refused(pg_temp.approve(v_id, pg_temp.shown(v_id), ack::text[])) from unnest(array['{}', '{not_deidentified}', '{source_unknown,not_deidentified,credit_missing}']::text[]) ack loop
    if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'unacknowledged warnings approved: %', v_err; end if;
  end loop;
  v_err := pg_temp.refused(pg_temp.approve((select id from ids where name = 'clean'), pg_temp.shown((select id from ids where name = 'clean')), '{not_deidentified}'));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'acknowledging a warning that is not open: %', v_err; end if;
  raise notice 'ok an approval must acknowledge exactly the open warnings (40001 asset_details_changed)';

  -- A stale shown state is refused: the tick, or any rights field, as the admin saw it.
  v_err := pg_temp.refused(pg_temp.approve(v_id, pg_temp.shown(v_id) || '{"attested": true}', '{not_deidentified,source_unknown}'));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'stale tick approved: %', v_err; end if;
  v_err := pg_temp.refused(pg_temp.approve(v_id, pg_temp.shown(v_id) || '{"licence": "own-work"}', '{not_deidentified,source_unknown}'));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'stale licence approved: %', v_err; end if;
  v_err := pg_temp.refused(pg_temp.approve(v_id, pg_temp.shown(v_id) || '{"creator": "Someone"}', '{not_deidentified,source_unknown}'));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'stale creator approved: %', v_err; end if;
  -- An author's tick after the admin looked: the approval that showed it unticked no longer matches.
  perform case_api.builder_set_asset_attestation('0199a000-0000-7000-8000-000000006210', (select id from ids where name = 'ccby'), false, true, '0199a000-0000-7000-8000-000000006202', false, null);
  v_err := pg_temp.refused(pg_temp.approve((select id from ids where name = 'ccby'), pg_temp.shown((select id from ids where name = 'ccby')) || '{"attested": false}', '{credit_missing,not_deidentified}'));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'approval over a changed tick: %', v_err; end if;
  raise notice 'ok an approval of a state that is no longer stored is refused (40001 asset_details_changed)';

  -- Malformed fences are bad input, not a mismatch.
  for v_err in select pg_temp.refused(sql) from unnest(array[
      pg_temp.approve(v_id, null, '{not_deidentified,source_unknown}'), pg_temp.approve(v_id, '[]', '{not_deidentified,source_unknown}'),
      pg_temp.approve(v_id, pg_temp.shown(v_id) - 'source_url', '{not_deidentified,source_unknown}'), pg_temp.approve(v_id, pg_temp.shown(v_id) || '{"extra": 1}', '{not_deidentified,source_unknown}'),
      pg_temp.approve(v_id, pg_temp.shown(v_id), null), pg_temp.approve(v_id, pg_temp.shown(v_id), '{not_deidentified,source_unknown,made_up}'),
      pg_temp.approve(v_id, pg_temp.shown(v_id), array['not_deidentified', null])]) sql loop
    if v_err is null or v_err not like '22023%' then raise exception 'malformed fence: %', v_err; end if;
  end loop;
  if (select status from case_app.assets where id = v_id) <> 'quarantined' or exists (select 1 from case_app.workspace_audit where target_id = v_id) then
    raise exception 'a refused approval changed the image or wrote audit'; end if;
  raise notice 'ok a malformed shown state or acknowledgement list is refused as bad input (22023)';

  -- The exact shown state with every open warning acknowledged approves, and the audit row names the warnings.
  execute v_ok;
  if (select status from case_app.assets where id = v_id) <> 'approved' then raise exception 'acknowledged approval did not approve'; end if;
  if (select acknowledged from case_app.workspace_audit where action = 'asset_approve' and target_id = v_id and actor_kind = 'admin') is distinct from '{not_deidentified,source_unknown}'::text[] then
    raise exception 'audit acknowledged: %', (select acknowledged from case_app.workspace_audit where target_id = v_id); end if;
  -- An image with nothing open records an explicit empty list; an acknowledgement list given in any order or repeated is the same set.
  v_id := (select id from ids where name = 'clean');
  execute pg_temp.approve(v_id, pg_temp.shown(v_id), '{}');
  if (select acknowledged from case_app.workspace_audit where action = 'asset_approve' and target_id = v_id) is distinct from '{}'::text[] then raise exception 'clean audit acknowledged is not empty'; end if;
  v_id := (select id from ids where name = 'nc');
  execute pg_temp.approve(v_id, pg_temp.shown(v_id), '{licence_caution,licence_caution}');
  if (select acknowledged from case_app.workspace_audit where action = 'asset_approve' and target_id = v_id) is distinct from '{licence_caution}'::text[] then raise exception 'repeated acknowledgement not normalised'; end if;
  -- A second approval of the same image is refused as changed (it is no longer pending), so the admin looks again.
  v_err := pg_temp.refused(pg_temp.approve(v_id, pg_temp.shown(v_id), '{licence_caution}'));
  if v_err is null or v_err not like '40001%' then raise exception 'second approval: %', v_err; end if;
  raise notice 'ok an acknowledged approval approves and its audit row carries exactly the acknowledged warnings';

  -- Rejecting needs no acknowledgement and records none.
  v_id := (select id from ids where name = 'publication');
  perform case_api.admin_review_asset('0199a000-0000-7000-8000-000000006210', v_id, 'reject', null, null, '0199a000-0000-7000-8000-000000006209', true, 'admin@example.com');
  if (select status from case_app.assets where id = v_id) <> 'rejected' or (select acknowledged from case_app.workspace_audit where action = 'asset_reject' and target_id = v_id) is not null then
    raise exception 'reject with the new signature'; end if;
  raise notice 'ok a rejection needs no acknowledgement and records none';

  -- Only an asset_approve row may carry acknowledgements, and only known codes.
  v_err := pg_temp.refused($q$insert into case_app.workspace_audit (workspace_id, actor_kind, action, target_type, target_id, acknowledged)
    values ('0199a000-0000-7000-8000-000000006210', 'admin', 'asset_reject', 'asset', case_app.uuid_v7(), '{not_deidentified}')$q$);
  if v_err is null or v_err not like '23514%' then raise exception 'acknowledged on a reject row: %', v_err; end if;
  v_err := pg_temp.refused($q$insert into case_app.workspace_audit (workspace_id, actor_kind, action, target_type, target_id, acknowledged)
    values ('0199a000-0000-7000-8000-000000006210', 'admin', 'asset_approve', 'asset', case_app.uuid_v7(), '{made_up}')$q$);
  if v_err is null or v_err not like '23514%' then raise exception 'unknown code in audit: %', v_err; end if;
  raise notice 'ok only an asset_approve audit row carries acknowledgements, and only known codes';

  -- The new signature is service-role only; the helpers are not callable by any client role.
  if has_function_privilege('authenticated', 'case_api.admin_review_asset(uuid,uuid,text,jsonb,text[],uuid,boolean,text)', 'execute')
     or has_function_privilege('anon', 'case_api.admin_review_asset(uuid,uuid,text,jsonb,text[],uuid,boolean,text)', 'execute')
     or not has_function_privilege('service_role', 'case_api.admin_review_asset(uuid,uuid,text,jsonb,text[],uuid,boolean,text)', 'execute')
     or has_function_privilege('service_role', 'case_app.asset_open_warnings(case_app.assets)', 'execute')
     or has_function_privilege('service_role', 'case_app.asset_review_state(case_app.assets)', 'execute') then
    raise exception 'review fence privileges'; end if;
  raise notice 'ok the fenced approval is service-role only';
end $$;
rollback;
