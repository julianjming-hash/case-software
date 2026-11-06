-- Real transactional assertions, including audit failure rollback and last-owner protection.
begin;
do $$
declare
 a uuid:=case_app.uuid_v7(); o uuid:=case_app.uuid_v7(); m uuid:=case_app.uuid_v7(); w uuid:=case_app.uuid_v7(); x uuid:=case_app.uuid_v7();
 rev bigint; r jsonb; before_count bigint; tab text;
begin
 insert into auth.users(id,email) values(a,'workbench-admin@example.org'),(o,'workbench-owner@example.org'),(m,'workbench-member@example.org');
 insert into case_app.profiles(id) values(a),(o),(m);
 insert into case_app.workspaces(id,slug,name) values(w,'workbench-test','Teaching'),(x,'workbench-other','Other');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(w,o,'owner');
 select membership_revision into rev from case_app.workspaces where id=w;
 if rev<>1 then raise exception 'membership trigger missing'; end if;
 begin perform case_api.admin_list_workspaces(o,null,false,null);raise exception 'owner inventory granted';exception when insufficient_privilege then null;end;
 begin perform case_api.admin_workspace_query(o,w,'members','','all',null,null,null,false,null);raise exception 'owner member read granted';exception when insufficient_privilege then null;end;
 r:=case_api.admin_workspace_query(a,w,'members','','all',null,null,null,true,'workbench-admin@example.org');
 if jsonb_array_length(r->'rows')<>1 or r->'rows'->0->>'email'<>'workbench-owner@example.org' then raise exception 'member read invalid';end if;
 begin perform case_api.admin_change_membership(a,w,'workbench-member@example.org','owner',null,rev,'workbench-member@example.org',null,true,'workbench-admin@example.org');raise exception 'missing elevation granted';exception when insufficient_privilege then null;end;
 insert into case_app.admin_elevations(jti,actor_email,scope,session_id) values(a,'workbench-admin@example.org','admin',a);
 begin perform case_api.admin_change_membership(o,w,'workbench-member@example.org','owner',null,rev,'workbench-member@example.org',a,false,null);raise exception 'owner role change granted';exception when insufficient_privilege then null;end;
 begin perform case_api.admin_change_membership(a,w,'workbench-owner@example.org',null,null,rev,'workbench-owner@example.org',a,true,'workbench-admin@example.org');raise exception 'last owner removed';exception when check_violation then null;end;
 if not exists(select 1 from case_app.workspace_members where workspace_id=w and user_id=o and role='owner') then raise exception 'last owner rollback failed';end if;
 r:=case_api.admin_change_membership(a,w,'workbench-member@example.org','author',null,rev,'workbench-member@example.org',a,true,'workbench-admin@example.org');
 if r->>'changed'<>'true' or (r->>'membership_revision')::bigint<>rev+1 then raise exception 'add outcome invalid';end if;
 begin perform case_api.admin_change_membership(a,w,'workbench-member@example.org','owner',null,rev,'workbench-member@example.org',a,true,'workbench-admin@example.org');raise exception 'stale revision granted';exception when serialization_failure then null;end;
 rev:=rev+1;
 r:=case_api.admin_change_membership(a,w,'workbench-member@example.org','owner',o,rev,'workbench-member@example.org',a,true,'workbench-admin@example.org');
 if not exists(select 1 from case_app.workspace_members where workspace_id=w and user_id=m and role='owner') or not exists(select 1 from case_app.workspace_members where workspace_id=w and user_id=o and role='author') then raise exception 'atomic owner transfer missing';end if;
 if not exists(select 1 from case_app.workspace_audit wa join case_app.membership_audit ma on ma.audit_id=wa.id where workspace_id=w and action='owner_transfer' and elevation_id=a and before_role='author' and after_role='owner') then raise exception 'transactional audit missing';end if;
 foreach tab in array array['members','cases','rooms','audit'] loop
  r:=case_api.admin_workspace_query(a,w,tab,'','all',null,null,null,true,'workbench-admin@example.org');
  if r->'workspace'->>'id'<>w::text or jsonb_typeof(r->'rows')<>'array' then raise exception 'invalid scoped % page',tab;end if;
 end loop;
 r:=case_api.admin_workspace_query(a,w,'audit','owner_transfer','all',null,null,null,true,'workbench-admin@example.org');
 if jsonb_array_length(r->'rows')<>1 or r->'rows'->0->'before_state'->>'role'<>'author' or r->'rows'->0->'after_state'->>'role'<>'owner' then raise exception 'readable role audit absent';end if;

 begin perform case_api.admin_workspace_query(a,x,'members','','all',null,null,o,true,'workbench-admin@example.org');raise exception 'foreign member cursor accepted';exception when invalid_parameter_value then null;end;
 if has_function_privilege('anon','case_api.admin_change_membership(uuid,uuid,text,text,uuid,bigint,text,uuid,boolean,text)','EXECUTE') or has_function_privilege('authenticated','case_api.admin_workspace_query(uuid,uuid,text,text,text,timestamptz,timestamptz,uuid,boolean,text)','EXECUTE') then raise exception 'public workbench RPC grant';end if;
end $$;
create function pg_temp.refuse_member_audit() returns trigger language plpgsql as $$begin if new.action='member_role' then raise exception 'test audit refusal';end if;return new;end $$;
create trigger workbench_test_audit before insert on case_app.workspace_audit for each row execute function pg_temp.refuse_member_audit();
do $$
declare a uuid:=case_app.uuid_v7();m uuid:=case_app.uuid_v7();w uuid:=case_app.uuid_v7();rev bigint;
begin
 insert into auth.users(id,email) values(a,'workbench-fault-admin@example.org'),(m,'workbench-fault-member@example.org');
 insert into case_app.profiles(id) values(a),(m);insert into case_app.workspaces(id,slug,name) values(w,'workbench-fault','Fault');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(w,a,'owner'),(w,m,'facilitator');
 insert into case_app.admin_elevations(jti,actor_email,scope,session_id) values(a,'workbench-fault-admin@example.org','admin',a);
 select membership_revision into rev from case_app.workspaces where id=w;
 begin perform case_api.admin_change_membership(a,w,'workbench-fault-member@example.org','author',null,rev,'workbench-fault-member@example.org',a,true,'workbench-fault-admin@example.org');raise exception 'audit fault ignored';exception when others then if sqlerrm<>'test audit refusal' then raise;end if;end;
 if (select role from case_app.workspace_members where workspace_id=w and user_id=m)<>'facilitator' or (select membership_revision from case_app.workspaces where id=w)<>rev then raise exception 'audit failure committed membership';end if;
end $$;
rollback;
