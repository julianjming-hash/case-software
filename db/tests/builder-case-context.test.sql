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

do $$
declare r record; c uuid:='0199a000-0000-7000-8000-00000000c820'; u uuid:='0199a000-0000-7000-8000-00000000c801'; v uuid:=case_app.uuid_v7(); d jsonb:='{"schema_version":1,"title":"Private version body"}';
begin
  select * into r from case_api.get_case_authoring_access(c,u,false,null);
  if r.title<>'Fallback title' or r.source_version_id is not null or r.source_version_no is not null then raise exception 'new case context invents source or loses title'; end if;
  if exists(select 1 from case_api.get_case_authoring_access(c,'0199a000-0000-7000-8000-00000000c803',false,null)) then raise exception 'facilitator gained authoring context'; end if;
  if exists(select 1 from case_api.get_case_authoring_access('0199a000-0000-7000-8000-00000000c821',u,false,null)) then raise exception 'archived case context exposed'; end if;
  insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values(v,c,1,1,d,sha256(convert_to(d::text,'UTF8')),u);
  select * into r from case_api.get_case_authoring_access(c,u,false,null);
  if r.source_version_id<>v or r.source_version_no<>1 then raise exception 'published source identity not bound to case'; end if;
  if position('Private version body' in row_to_json(r)::text)>0 then raise exception 'context contains source body'; end if;
  insert into case_app.admin_version_state(case_version_id,status) values(v,'withdrawn');
  select * into r from case_api.get_case_authoring_access(c,u,false,null);
  if r.source_version_id is not null then raise exception 'withdrawn source offered for new authoring'; end if;
  if has_function_privilege('authenticated','case_api.get_case_authoring_access(uuid,uuid,boolean,text)','execute') or not has_function_privilege('service_role','case_api.get_case_authoring_access(uuid,uuid,boolean,text)','execute') then raise exception 'context grants changed'; end if;
end $$;
rollback;
