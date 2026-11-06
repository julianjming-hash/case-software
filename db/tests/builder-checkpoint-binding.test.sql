-- C48: a delayed checkpoint gesture cannot snapshot an unseen newer revision.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000c801');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000c801','Owner');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000c810','c48-checkpoint','C48');
insert into case_app.workspace_members(workspace_id,user_id,role) values ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','owner');
insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199a000-0000-7000-8000-00000000c820','0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','Checkpoint');
do $$
declare c uuid:='0199a000-0000-7000-8000-00000000c820'; u uuid:='0199a000-0000-7000-8000-00000000c801'; op uuid; r bigint; refused boolean:=false;
begin
  select operation_id into op from case_api.builder_open_save_window(c,0,u,false,null);
  perform case_api.builder_save_draft(c,op,'{"schema_version":2,"title":"First"}','{"metadata_version":1}',u,false,null);
  select operation_id into op from case_api.builder_open_save_window(c,1,u,false,null);
  perform case_api.builder_save_draft(c,op,'{"schema_version":2,"title":"Newer"}','{"metadata_version":1}',u,false,null);
  begin perform case_api.builder_create_checkpoint(c,'Seen revision',1,u,false,null);
  exception when serialization_failure then refused:=true; end;
  if not refused or exists(select 1 from case_app.builder_checkpoints where case_id=c) then raise exception 'stale checkpoint created or was not refused'; end if;
  select revision into r from case_api.builder_create_checkpoint(c,'Current revision',2,u,false,null);
  if r<>2 or not exists(select 1 from case_app.builder_checkpoints where case_id=c and document->>'title'='Newer') then raise exception 'exact checkpoint content missing'; end if;
  if has_function_privilege('service_role','case_api.builder_create_checkpoint(uuid,text,uuid,boolean,text)','EXECUTE') then raise exception 'unbound service checkpoint bypass'; end if;
  if not has_function_privilege('service_role','case_api.builder_create_checkpoint(uuid,text,bigint,uuid,boolean,text)','EXECUTE') then raise exception 'bound service checkpoint unavailable'; end if;
end $$;
rollback;
