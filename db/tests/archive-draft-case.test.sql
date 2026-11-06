-- CASE-316 / P-42: an owner or a configured admin archives a never-published draft case; it leaves every list, is audited,
-- and nothing is deleted. Authors and facilitators are refused; a published case, an open review and a wrong title are
-- returned as outcomes and leave the case untouched.
\set QUIET on
begin;
insert into auth.users values
 ('0199a000-0000-7000-8000-00000000d301'),('0199a000-0000-7000-8000-00000000d302'),('0199a000-0000-7000-8000-00000000d303'),('0199a000-0000-7000-8000-00000000d304');
insert into case_app.profiles(id,display_name) values
 ('0199a000-0000-7000-8000-00000000d301','Owner'),('0199a000-0000-7000-8000-00000000d302','Author'),
 ('0199a000-0000-7000-8000-00000000d303','Facilitator'),('0199a000-0000-7000-8000-00000000d304','Admin');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000d310','d3-archive','D3 archive');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d301','owner'),
 ('0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','author'),
 ('0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d303','facilitator');
insert into case_app.cases(id,workspace_id,owner_id,title) values
 ('0199a000-0000-7000-8000-00000000d320','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','Draft to archive'),
 ('0199a000-0000-7000-8000-00000000d321','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','Published case'),
 ('0199a000-0000-7000-8000-00000000d322','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','In review'),
 ('0199a000-0000-7000-8000-00000000d323','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','Admin archives');
insert into case_app.case_drafts(case_id,revision,schema_version,document,updated_by,updated_at) values
 ('0199a000-0000-7000-8000-00000000d320',2,1,'{"schema_version":1,"title":"Draft to archive"}','0199a000-0000-7000-8000-00000000d302',now()),
 ('0199a000-0000-7000-8000-00000000d323',1,1,'{"schema_version":1,"title":"Renamed in the draft"}','0199a000-0000-7000-8000-00000000d302',now());
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values
 ('0199a000-0000-7000-8000-00000000d330','0199a000-0000-7000-8000-00000000d321',1,1,'{"schema_version":1}',sha256(convert_to('{"schema_version":1}','UTF8')),'0199a000-0000-7000-8000-00000000d301');
insert into case_app.builder_candidates(case_id,workspace_id,submitted_by,request_id,revision,schema_version,document,authoring_metadata,intent_digest,content_sha256,status) values
 ('0199a000-0000-7000-8000-00000000d322','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','0199a000-0000-7000-8000-00000000d340',1,1,
  '{"schema_version":"1"}','{}',sha256('\x01'::bytea),sha256('\x02'::bytea),'pending');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
do $$
declare v_row record; v_err text; d uuid := '0199a000-0000-7000-8000-00000000d320';
begin
  -- An author and a facilitator are refused, and the case stays live.
  v_err := pg_temp.refused($q$select * from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d320','0199a000-0000-7000-8000-00000000d302','Draft to archive',false,null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'P-42 author could archive: %', v_err; end if;
  v_err := pg_temp.refused($q$select * from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d320','0199a000-0000-7000-8000-00000000d303','Draft to archive',false,null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'P-42 facilitator could archive: %', v_err; end if;
  -- A wrong title archives nothing.
  select * into v_row from case_api.builder_archive_case(d,'0199a000-0000-7000-8000-00000000d301','Draft to archiv',false,null);
  if v_row.outcome is distinct from 'title_mismatch' or (select archived_at from case_app.cases where id = d) is not null then
    raise exception 'P-42 wrong title was not refused as title_mismatch'; end if;
  -- The owner archives with the exact title: hidden from the drafts list, audited, nothing deleted.
  select * into v_row from case_api.builder_archive_case(d,'0199a000-0000-7000-8000-00000000d301','Draft to archive',false,null);
  if v_row.case_id is distinct from d or v_row.outcome is distinct from 'archived' or (select archived_at from case_app.cases where id = d) is null then
    raise exception 'P-42 owner archive did not stamp archived_at'; end if;
  if exists (select 1 from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000d310',50,0,'0199a000-0000-7000-8000-00000000d301',false,null) where case_id = d) then
    raise exception 'P-42 archived draft still listed'; end if;
  if (select count(*) from case_app.case_drafts where case_id = d) <> 1 then raise exception 'P-42 archive deleted the draft'; end if;
  if not exists (select 1 from case_app.workspace_audit where action = 'case_archive' and target_type = 'case' and target_id = d
      and actor_kind = 'owner' and actor_user_id = '0199a000-0000-7000-8000-00000000d301' and actor_email is null) then
    raise exception 'P-42 owner archive was not audited as the owner'; end if;
  -- Archiving twice is a missing case, never a second stamp.
  v_err := pg_temp.refused($q$select * from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d320','0199a000-0000-7000-8000-00000000d301','Draft to archive',false,null)$q$);
  if v_err is null or v_err not like 'P0002%' then raise exception 'P-42 second archive was not refused: %', v_err; end if;
  -- A published case and a case under review are named, not archived.
  select * into v_row from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d321','0199a000-0000-7000-8000-00000000d301','Published case',false,null);
  if v_row.outcome is distinct from 'published' or (select archived_at from case_app.cases where id = '0199a000-0000-7000-8000-00000000d321') is not null then
    raise exception 'P-42 archived a published case'; end if;
  select * into v_row from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d322','0199a000-0000-7000-8000-00000000d301','In review',false,null);
  if v_row.outcome is distinct from 'in_review' or (select archived_at from case_app.cases where id = '0199a000-0000-7000-8000-00000000d322') is not null then
    raise exception 'P-42 archived a case under review'; end if;
  -- The title to confirm is the draft's own, as the drafts list normalises it, never the case's creation title.
  select * into v_row from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d323','0199a000-0000-7000-8000-00000000d304','Admin archives',true,'admin@example.org');
  if v_row.outcome is distinct from 'title_mismatch' then raise exception 'P-42 confirmed against the stale case title'; end if;
  -- A configured admin archives without step-up and is audited as admin with its email.
  select * into v_row from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d323','0199a000-0000-7000-8000-00000000d304','Renamed in the draft',true,'admin@example.org');
  if v_row.outcome is distinct from 'archived' or not exists (select 1 from case_app.workspace_audit where action = 'case_archive'
      and target_id = '0199a000-0000-7000-8000-00000000d323' and actor_kind = 'admin' and actor_email = 'admin@example.org') then
    raise exception 'P-42 admin archive was not stamped and audited as admin'; end if;
  -- An untitled draft confirms with an empty title; a review submission on an archived case is refused.
  insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199a000-0000-7000-8000-00000000d324','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','Never saved');
  select * into v_row from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d324','0199a000-0000-7000-8000-00000000d301','',false,null);
  if v_row.outcome is distinct from 'archived' then raise exception 'P-42 untitled draft could not be archived'; end if;
  v_err := pg_temp.refused($q$insert into case_app.builder_candidates(case_id,workspace_id,submitted_by,request_id,revision,schema_version,document,authoring_metadata,intent_digest,content_sha256,status)
    values ('0199a000-0000-7000-8000-00000000d320','0199a000-0000-7000-8000-00000000d310','0199a000-0000-7000-8000-00000000d302','0199a000-0000-7000-8000-00000000d341',1,1,'{"schema_version":"1"}','{}',sha256('\x03'::bytea),sha256('\x04'::bytea),'pending')$q$);
  if v_err is null or v_err not like 'P0002%' then raise exception 'P-42 a review submission landed on an archived case: %', v_err; end if;
  -- An unentitled caller cannot tell a missing case from a refused one.
  v_err := pg_temp.refused($q$select * from case_api.builder_archive_case('0199a000-0000-7000-8000-0000000000ff','0199a000-0000-7000-8000-00000000d302','x',false,null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'P-42 revealed a missing case to an unentitled caller: %', v_err; end if;
  -- An inconsistent admin flag is refused.
  v_err := pg_temp.refused($q$select * from case_api.builder_archive_case('0199a000-0000-7000-8000-00000000d321','0199a000-0000-7000-8000-00000000d301','Published case',false,'owner@example.org')$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'P-42 accepted an inconsistent admin flag: %', v_err; end if;
  if has_function_privilege('anon','case_api.builder_archive_case(uuid,uuid,text,boolean,text)','execute') or
     has_function_privilege('authenticated','case_api.builder_archive_case(uuid,uuid,text,boolean,text)','execute') or
     not has_function_privilege('service_role','case_api.builder_archive_case(uuid,uuid,text,boolean,text)','execute') then
    raise exception 'P-42 archive RPC grants are not service-role only'; end if;
  raise notice 'ok CASE-316 P-42 owner/admin archive a never-published draft: listed out, audited, nothing deleted';
end $$;
rollback;
