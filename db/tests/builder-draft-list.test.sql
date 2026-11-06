-- C48: entitled private draft inventory returns bounded summary fields only.
\set QUIET on
begin;
insert into auth.users values
 ('0199a000-0000-7000-8000-00000000c801'),('0199a000-0000-7000-8000-00000000c802'),('0199a000-0000-7000-8000-00000000c803');
insert into case_app.profiles(id,display_name) values
 ('0199a000-0000-7000-8000-00000000c801','Owner'),('0199a000-0000-7000-8000-00000000c802','Author'),('0199a000-0000-7000-8000-00000000c803','Facilitator');
insert into case_app.workspaces(id,slug,name) values
 ('0199a000-0000-7000-8000-00000000c810','c48-list-a','C48 list A'),('0199a000-0000-7000-8000-00000000c811','c48-list-b','C48 list B');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','owner'),
 ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c802','author'),
 ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c803','facilitator');
insert into case_app.cases(id,workspace_id,owner_id,title,archived_at) values
 ('0199a000-0000-7000-8000-00000000c820','0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','Fallback title',null),
 ('0199a000-0000-7000-8000-00000000c821','0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c802','Archived title',now()),
 ('0199a000-0000-7000-8000-00000000c822','0199a000-0000-7000-8000-00000000c811','0199a000-0000-7000-8000-00000000c801','Other workspace',null);
insert into case_app.case_drafts(case_id,revision,schema_version,document,updated_by,updated_at) values
 ('0199a000-0000-7000-8000-00000000c820',3,1,'{"schema_version":1,"title":"Private title","scene":"PRIVATE BODY SENTINEL"}','0199a000-0000-7000-8000-00000000c802','2026-10-09T12:00:00Z'),
 ('0199a000-0000-7000-8000-00000000c821',4,1,'{"schema_version":1,"title":"Archived"}','0199a000-0000-7000-8000-00000000c802','2026-10-09T13:00:00Z'),
 ('0199a000-0000-7000-8000-00000000c822',5,1,'{"schema_version":1,"title":"Other"}','0199a000-0000-7000-8000-00000000c802','2026-10-09T14:00:00Z');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
do $$
declare v_row record; v_err text;
begin
  select * into v_row from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',1,0,'0199a000-0000-7000-8000-00000000c802',false,null);
  if v_row.case_id<>'0199a000-0000-7000-8000-00000000c820' or v_row.title<>'Private title' or v_row.revision<>3 then
    raise exception 'C48 author list omitted or misrepresented the private saved draft'; end if;
  if (select count(*) from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c801',false,null))<>1 then
    raise exception 'C48 owner list leaked archived or cross-workspace drafts'; end if;
  v_err:=pg_temp.refused($q$select * from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c803',false,null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'C48 facilitator could list private drafts: %',v_err; end if;
  v_err:=pg_temp.refused($q$select * from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',51,0,'0199a000-0000-7000-8000-00000000c802',false,null)$q$);
  if v_err is null or v_err not like '22023%' then raise exception 'C48 unbounded page size was not refused: %',v_err; end if;
  v_err:=pg_temp.refused($q$select * from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,10001,'0199a000-0000-7000-8000-00000000c802',false,null)$q$);
  if v_err is null or v_err not like '22023%' then raise exception 'C48 unbounded offset was not refused: %',v_err; end if;
  if has_function_privilege('anon','case_api.builder_list_drafts(uuid,integer,integer,uuid,boolean,text)','execute') or
     has_function_privilege('authenticated','case_api.builder_list_drafts(uuid,integer,integer,uuid,boolean,text)','execute') or
     not has_function_privilege('service_role','case_api.builder_list_drafts(uuid,integer,integer,uuid,boolean,text)','execute') then
    raise exception 'C48 list RPC grants are not service-role only'; end if;
  if exists(select 1 from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c802',false,null) as x
    where position('PRIVATE BODY SENTINEL' in row_to_json(x)::text)>0) then
    raise exception 'C48 list RPC exposed draft body text'; end if;
  insert into case_app.cases(id,workspace_id,owner_id,title) values('0199a000-0000-7000-8000-00000000c823','0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','Created but not saved');
  if not exists(select 1 from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c801',false,null) where case_id='0199a000-0000-7000-8000-00000000c823' and revision=0 and title='Created but not saved') then raise exception 'never-saved case cannot be recovered after lost create acknowledgement'; end if;
  raise notice 'ok C48 P-14 private draft list is workspace-scoped, paged, content-free, and service-role only';
end $$;
rollback;
