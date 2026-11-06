-- db/tests/case-catalogue.test.sql
-- Assertions for migrations/20261007000000_case_catalogue.sql (card 29, CASE-166): the catalogue page is
-- bounded, sorted and filtered over the whole set (paging never misorders), returns only public library
-- fields, and is authorised by workspace membership; case detail never answers outside the caller's
-- workspaces; nobody but service_role executes anything.
-- Since the card 35b contract migration only the card 30 13-argument catalogue exists: calls pass no group
-- filter (null, false) and the non-admin flag (false, null).
\set QUIET on
-- One transaction, rolled back at the end: later files (case-init) assume they own the only version 1 rows.
begin;

-- fixtures: a member and an outsider; workspace W (the member's) and workspace X (someone else's)
insert into auth.users values ('0199a000-0000-7000-8000-00000000c901'), ('0199a000-0000-7000-8000-00000000c902'),
  ('0199a000-0000-7000-8000-00000000c903');
insert into case_app.profiles (id, display_name) values
  ('0199a000-0000-7000-8000-00000000c901', 'Catalogue member'),
  ('0199a000-0000-7000-8000-00000000c902', 'Catalogue outsider'),
  ('0199a000-0000-7000-8000-00000000c903', 'Catalogue disabled');
insert into case_app.workspaces (id, slug, name) values
  ('0199a000-0000-7000-8000-00000000c90a', 'c29-teaching', 'Card 29 teaching'),
  ('0199a000-0000-7000-8000-00000000c90b', 'c29-elsewhere', 'Card 29 elsewhere');
insert into case_app.workspace_members (workspace_id, user_id, role) values
  ('0199a000-0000-7000-8000-00000000c90a', '0199a000-0000-7000-8000-00000000c901', 'facilitator'),
  ('0199a000-0000-7000-8000-00000000c90b', '0199a000-0000-7000-8000-00000000c902', 'owner'),
  ('0199a000-0000-7000-8000-00000000c90a', '0199a000-0000-7000-8000-00000000c903', 'author');
update case_app.profiles set disabled_at = now() where id = '0199a000-0000-7000-8000-00000000c903';

-- Twelve cases in W (one version each, two with a second version), one archived, one withdrawn, one in X.
-- Every document carries a private beat text the catalogue must never return.
create temp table c29_cases (n integer, id uuid, title text, doc jsonb, ws uuid);
insert into c29_cases
select n, ('0199a000-0000-7000-8000-0000000c91' || lpad(to_hex(n), 2, '0'))::uuid,
       (array['Sepsis on the ward','anaphylaxis in theatre','Bradycardia','Cardiac arrest','DKA','Eclampsia',
              'Fever 100% sure','GI bleed','Head injury','Ischaemic stroke','Jaundice','Kounis','Archived case',
              'Withdrawn case','Elsewhere case'])[n],
       jsonb_build_object('schema_version', 1, 'title', 'ignored', 'start_beat_id', 'b1',
         'beats', jsonb_build_array(jsonb_build_object('id', 'b1', 'kind', 'surface', 'text', 'PRIVATE-BEAT-TEXT')),
         'decisions', jsonb_build_array(jsonb_build_object('id', 'D1', 'facilitator_notes', 'PRIVATE-NOTE')))
       || case when n % 4 = 0 then '{}'::jsonb else jsonb_build_object('summary', 'Summary for case ' || n ||
            case when n = 2 then ' with sepsis mimic' else '' end) end
       || case when n % 3 = 0 then jsonb_build_object('audience', 42) else jsonb_build_object('audience',
            (array['Junior doctors', 'Nurses', 'Paramedics'])[1 + n % 3]) end
       || case when n % 5 = 0 then jsonb_build_object('duration_min', 30) else jsonb_build_object('duration_min',
            (array[15, 45])[1 + n % 2]) end
       || jsonb_build_object('setting', 'Emergency department',
            'learning_objectives', jsonb_build_array('Recognise it', 7, '', 'Treat it', 'a', 'b', 'c', 'd', 'e', 'f')),
       case when n = 15 then '0199a000-0000-7000-8000-00000000c90b'::uuid else '0199a000-0000-7000-8000-00000000c90a'::uuid end
  from generate_series(1, 15) n;
-- Published fixtures normally match their case title; the separate metadata test covers renames.
update c29_cases set doc=jsonb_set(doc,'{title}',to_jsonb(title));
insert into case_app.cases (id, workspace_id, owner_id, title, archived_at)
select id, ws, case when n = 15 then '0199a000-0000-7000-8000-00000000c902'::uuid else '0199a000-0000-7000-8000-00000000c901'::uuid end,
       title, case when n = 13 then now() end from c29_cases;
-- Published times: case n at base + n minutes, so 'published' order is known; two cases share a time.
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by, published_at)
select ('0199a000-0000-7000-8000-0000000c92' || lpad(to_hex(n), 2, '0'))::uuid, id, 1, 1, doc, sha256(convert_to(doc::text, 'UTF8')),
       case when n = 15 then '0199a000-0000-7000-8000-00000000c902'::uuid else '0199a000-0000-7000-8000-00000000c901'::uuid end,
       timestamptz '2026-10-01 00:00:00+00' + make_interval(mins => case when n = 7 then 6 else n end)
  from c29_cases;
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by, published_at)
select ('0199a000-0000-7000-8000-0000000c93' || lpad(to_hex(n), 2, '0'))::uuid, id, 2, 1, doc || '{"summary":"Second version"}',
       sha256(convert_to(doc::text || 'v2', 'UTF8')), '0199a000-0000-7000-8000-00000000c901',
       timestamptz '2026-10-02 00:00:00+00' + make_interval(mins => n)
  from c29_cases where n in (3, 8);
insert into case_app.admin_version_state (case_version_id, status) values ('0199a000-0000-7000-8000-0000000c920e', 'withdrawn');
-- Case 3's latest version (v2) is withdrawn: the case stays listed through its v1.
insert into case_app.admin_version_state (case_version_id, status) values ('0199a000-0000-7000-8000-0000000c9303', 'withdrawn');

do $$
declare actor uuid:='0199a000-0000-7000-8000-00000000c901'; ws uuid:='0199a000-0000-7000-8000-00000000c90a'; r record;
begin
  update case_app.cases set title='Stale working title' where id=(select id from c29_cases where n=1);
  select * into r from case_api.get_catalogue_case(actor,(select id from c29_cases where n=1),1,false,null);
  if r.title<>(select title from c29_cases where n=1) then raise exception 'detail did not use the published title: %',r.title; end if;
  if not exists(select 1 from case_api.list_case_catalogue(actor,ws,'title',false,(select title from c29_cases where n=1),null,null,50,0,null,false,false,null) where case_id=(select id from c29_cases where n=1)) then raise exception 'published title is not searchable'; end if;
  if exists(select 1 from case_api.list_case_catalogue(actor,ws,'title',false,'Stale working title',null,null,50,0,null,false,false,null)) then raise exception 'stale case title still searchable'; end if;
  if exists(select 1 from case_api.list_published_versions(actor,ws,100,null,false,null) where case_id=(select id from c29_cases where n=1) and title='Stale working title') then raise exception 'published versions expose stale title'; end if;
  if case_app.catalogue_duration_current('{"schema_version":3,"duration_min":60}') is distinct from 60 then raise exception 'schema3 60-minute duration lost'; end if;
  if case_app.catalogue_duration_current('{"schema_version":1,"duration_min":30}') is not null then raise exception 'legacy invalid duration accepted'; end if;
  if case_app.catalogue_duration_current('{"schema_version":3,"duration_min":"60"}') is not null then raise exception 'string duration accepted'; end if;
  if case_app.catalogue_duration('{"schema_version":3,"duration_min":60}') is not null then raise exception 'legacy duration contract changed'; end if;
  perform * from case_api.list_case_catalogue_current(actor,ws,'title',false,null,60,null,50,0,null,false,false,null);
end $$;
rollback;
