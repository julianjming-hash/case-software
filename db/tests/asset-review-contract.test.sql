-- [AS-172] Card 62 contract step: the unfenced six-argument admin_review_asset is gone; the fenced overload is the only
-- approval, and it still refuses non-admins, stale state and a missing fence.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-000000006309'),('0199a000-0000-7000-8000-000000006301'),('0199a000-0000-7000-8000-000000006302');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-000000006301','Owner'),('0199a000-0000-7000-8000-000000006302','Author');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-000000006310','contract-a','Contract A');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-000000006310','0199a000-0000-7000-8000-000000006301','owner'),
 ('0199a000-0000-7000-8000-000000006310','0199a000-0000-7000-8000-000000006302','author');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;

do $$
declare v_err text; v_id uuid; v_shown jsonb; v_open text[]; ws constant uuid := '0199a000-0000-7000-8000-000000006310';
begin
  -- The old signature no longer exists, and no other overload stands in for it.
  if to_regprocedure('case_api.admin_review_asset(uuid,uuid,text,uuid,boolean,text)') is not null then raise exception 'the unfenced signature still exists'; end if;
  if (select array_agg(p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'case_api' and p.proname = 'admin_review_asset')
     is distinct from array['case_api.admin_review_asset(uuid,uuid,text,jsonb,text[],uuid,boolean,text)'] then
    raise exception 'admin_review_asset overloads: %', (select array_agg(p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'case_api' and p.proname = 'admin_review_asset');
  end if;
  v_id := (case_api.builder_create_asset(ws, '0199a000-0000-7000-8000-000000006302', false, null,
    jsonb_build_object('sha256', repeat('6',63)||'1', 'bytes', 4000, 'width', 1200, 'height', 800), jsonb_build_object('sha256', repeat('6',63)||'2', 'bytes', 2000, 'width', 640, 'height', 427),
    '{"alt_text":"Chest film","evidence_kind":"imaging","rights_basis":"unlicensed","licence":"unknown"}'::jsonb)->>'asset_id')::uuid;
  select case_app.asset_review_state(a), case_app.asset_open_warnings(a) into v_shown, v_open from case_app.assets a where a.id = v_id;
  -- An admin calling the old shape now finds no function at all (42883), so nothing is approved by it.
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve','0199a000-0000-7000-8000-000000006309',true,'admin@example.com')$q$, ws, v_id));
  if v_err is null or v_err not like '42883%' then raise exception 'old shape: %', v_err; end if;
  -- The fenced overload still refuses an owner with the exact shown state (42501) ...
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve',%L::jsonb,%L::text[],'0199a000-0000-7000-8000-000000006301',false,null)$q$, ws, v_id, v_shown, v_open));
  if v_err is null or v_err not like '42501%' then raise exception 'owner approved: %', v_err; end if;
  -- ... an admin with a stale tick, or without the acknowledgements (40001) ...
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve',%L::jsonb,%L::text[],'0199a000-0000-7000-8000-000000006309',true,'admin@example.com')$q$, ws, v_id, v_shown || '{"attested": true}', v_open));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'stale state approved: %', v_err; end if;
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve',%L::jsonb,'{}'::text[],'0199a000-0000-7000-8000-000000006309',true,'admin@example.com')$q$, ws, v_id, v_shown));
  if v_err is null or v_err not like '40001%asset_details_changed%' then raise exception 'unacknowledged approved: %', v_err; end if;
  -- ... and an admin with no fence at all (22023).
  v_err := pg_temp.refused(format($q$select case_api.admin_review_asset(%L,%L,'approve',null,null,'0199a000-0000-7000-8000-000000006309',true,'admin@example.com')$q$, ws, v_id));
  if v_err is null or v_err not like '22023%' then raise exception 'unfenced approve: %', v_err; end if;
  if (select status from case_app.assets where id = v_id) <> 'quarantined' or exists (select 1 from case_app.workspace_audit where target_id = v_id) then
    raise exception 'a refused approval changed the image or wrote audit'; end if;
  -- The exact shown state with its warnings acknowledged still approves.
  if case_api.admin_review_asset(ws, v_id, 'approve', v_shown, v_open, '0199a000-0000-7000-8000-000000006309', true, 'admin@example.com')->>'status' <> 'approved' then
    raise exception 'fenced approval failed'; end if;
  raise notice 'ok the unfenced approval is gone; the fenced one refuses non-admins, stale state and a missing fence, and approves as shown';
end $$;
rollback;
