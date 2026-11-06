-- CASE-356: exact-case filtering happens before paging and grants no additional record visibility.
begin;
do $$
declare u uuid:=case_app.uuid_v7(); outsider uuid:=case_app.uuid_v7(); w uuid:=case_app.uuid_v7(); c uuid:=case_app.uuid_v7(); other_case uuid:=case_app.uuid_v7(); v uuid:=case_app.uuid_v7(); other_v uuid:=case_app.uuid_v7(); s uuid; first_page jsonb; next_page jsonb; cursor_id uuid; doc jsonb:='{"schema_version":1,"title":"Case filter","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}';
begin
 insert into auth.users(id,email) values(u,'case-filter-owner@example.org'),(outsider,'case-filter-outsider@example.org');
 insert into case_app.profiles(id) values(u),(outsider);
 insert into case_app.workspaces(id,slug,name) values(w,'case-filter-test','Case filter');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(w,u,'owner');
 insert into case_app.cases(id,workspace_id,owner_id,title) values(c,w,u,'Target'),(other_case,w,u,'Other');
 insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values(v,c,1,1,doc,sha256(convert_to(doc::text,'UTF8')),u),(other_v,other_case,1,1,doc,sha256(convert_to(doc::text,'UTF8')),u);
 for i in 1..22 loop
  s:=case_app.uuid_v7();
  insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,expires_at) values(s,case when i=11 then other_v else v end,w,u,'CS'||lpad(i::text,4,'0'),'lobby',now()+interval '1 hour');
 end loop;
 if (select version_no from case_api.resolve_catalogue_case(u,c,false,null)) is distinct from 1 then raise exception 'bare bookmark failed';end if;
 insert into case_app.admin_version_state(case_version_id,status) values(v,'withdrawn');
 if (select version_no from case_api.resolve_catalogue_case(u,c,false,null)) is not null then raise exception 'withdrawn version offered';end if;
 delete from case_app.admin_version_state where case_version_id=v;
 update case_app.profiles set disabled_at=now() where id=u;
 begin perform * from case_api.resolve_catalogue_case(u,c,false,null);raise exception 'disabled bookmark accepted';exception when insufficient_privilege then null;end;
 update case_app.profiles set disabled_at=null where id=u;

 if exists(select 1 from case_api.resolve_catalogue_case(outsider,c,false,null)) then raise exception 'bookmark leaked access';end if;
 first_page:=case_api.query_case_session_portfolio(u,w,'','all',null,null,null,true,false,null,c);
 if jsonb_array_length(first_page->'rooms')<>20 or exists(select 1 from jsonb_array_elements(first_page->'rooms') r where (r->>'case_id')::uuid<>c) then raise exception 'case filter must precede limit';end if;
 cursor_id:=(first_page->>'nextAfter')::uuid;
 next_page:=case_api.query_case_session_portfolio(u,w,'','all',null,null,cursor_id,true,false,null,c);
 if jsonb_array_length(next_page->'rooms')<>1 or next_page->>'nextAfter' is not null then raise exception 'case continuation lost or invented rows';end if;
 if jsonb_array_length(case_api.query_case_session_portfolio(u,w,'','all',null,null,null,true,false,null,other_case)->'rooms')<>1 then raise exception 'other case filter';end if;
 if jsonb_array_length(case_api.query_session_portfolio(u,w,'','all',null,null,null,true,false,null)->'rooms')<>20 then raise exception 'legacy query changed';end if;
 begin perform case_api.query_case_session_portfolio(outsider,w,'','all',null,null,null,true,false,null,c);raise exception 'case filter granted access';exception when insufficient_privilege then null;end;
 begin perform case_api.query_case_session_portfolio(u,w,'','all',null,null,cursor_id,true,false,null,other_case);raise exception 'cross-case cursor accepted';exception when invalid_parameter_value then null;end;
 if has_function_privilege('anon','case_api.query_case_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid)','EXECUTE') or has_function_privilege('authenticated','case_api.query_case_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid)','EXECUTE') or not has_function_privilege('service_role','case_api.query_case_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid)','EXECUTE') then raise exception 'case filter privilege boundary';end if;
 if has_function_privilege('authenticated','case_api.resolve_catalogue_case(uuid,uuid,boolean,text)','EXECUTE') or has_function_privilege('anon','case_api.resolve_catalogue_case(uuid,uuid,boolean,text)','EXECUTE') then raise exception 'bookmark public execute';end if;
end $$;
rollback;
