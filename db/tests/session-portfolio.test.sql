-- P-34, long-term visibility, exact-source finalization and immutable deidentified evidence.
begin;
do $$
declare u uuid:=case_app.uuid_v7();o uuid:=case_app.uuid_v7();a uuid:=case_app.uuid_v7();w uuid:=case_app.uuid_v7();c uuid:=case_app.uuid_v7();v uuid:=case_app.uuid_v7();s uuid:=case_app.uuid_v7();pid uuid:=case_app.uuid_v7();doc jsonb:='{"schema_version":1,"title":"Portfolio case","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'; r jsonb;b text;
begin
 insert into auth.users(id,email) values(u,'portfolio-owner@example.org'),(o,'portfolio-other@example.org'),(a,'portfolio-admin@example.org');
 insert into case_app.profiles(id) values(u),(o),(a);insert into case_app.workspaces(id,slug,name) values(w,'portfolio-test','Portfolio');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(w,u,'owner'),(w,o,'owner');
 insert into case_app.cases(id,workspace_id,owner_id,title) values(c,w,u,'Portfolio case');
 insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values(v,c,1,1,doc,sha256(convert_to(doc::text,'UTF8')),u);
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,started_at,ended_at,expires_at,final_revision,final_epoch,personal_data_delete_at)
 values(s,v,w,u,'PF0001','ended',now()-interval '120 days',now()-interval '120 days',now()-interval '120 days'+interval '1 hour',now()-interval '120 days'+interval '2 hours',2,0,now()-interval '119 days');
 if jsonb_array_length(case_api.query_session_portfolio(u,w,'Portfolio','ended',null,null,null,true,false,null)->'rooms')<>1 then raise exception 'long-term own history absent';end if;
 if (select count(*) from case_api.list_room_history(u,w,'ended',20,null,null,false,null))<>1 then raise exception 'old summary endpoint still limits visibility';end if;
 -- CASE-337: managers_see_records (on by default) lets the owner read it; off, only the starter does.
 if case_api.read_session_portfolio(o,s,0,null,false,null) is null then raise exception 'managers_see_records owner read failed';end if;
 update case_app.workspace_policies set managers_see_records=false where workspace_id=w;
 begin perform case_api.read_session_portfolio(o,s,0,null,false,null);raise exception 'owner read another starter detail';exception when insufficient_privilege then null;end;
 update case_app.workspace_policies set managers_see_records=true where workspace_id=w;
 if case_api.read_session_portfolio(a,s,0,null,true,'portfolio-admin@example.org')->'session'->>'id'<>s::text then raise exception 'admin read refused';end if;
 update case_app.profiles set disabled_at=now() where id=u;
 begin perform case_api.read_session_portfolio(u,s,0,null,false,null);raise exception 'disabled read granted';exception when insufficient_privilege then null;end;
 update case_app.profiles set disabled_at=null where id=u;
 delete from case_app.workspace_members where workspace_id=w and user_id=u;
 begin perform case_api.read_session_portfolio(u,s,0,null,false,null);raise exception 'former member read granted';exception when insufficient_privilege then null;end;
 insert into case_app.workspace_members(workspace_id,user_id,role) values(w,u,'facilitator');
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at) values(s,2,case_app.uuid_v7(),0,'room_ended','{}',now()-interval '120 days'+interval '1 hour');
 begin perform case_api.finalize_session_portfolio(s,v,2,0,2,0,1);raise exception 'gapped journal marked complete';exception when check_violation then null;end;
 begin perform case_api.finalize_session_portfolio(s,case_app.uuid_v7(),2,0,2,0,1);raise exception 'wrong source marked complete';exception when check_violation then null;end;
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at) values(s,1,case_app.uuid_v7(),0,'participant_joined',jsonb_build_object('participantId',pid,'displayName','DO NOT EXPORT'),now()-interval '120 days');
 if not case_api.finalize_session_portfolio(s,v,2,0,2,0,1) or not case_api.finalize_session_portfolio(s,v,2,0,2,0,1) then raise exception 'valid/idempotent finalization refused';end if;
 r:=case_api.read_session_portfolio(u,s,0,null,false,null);b:=r->>'boundary';
 if r->>'interpretationLimited'<>'false' then raise exception 'known finalized archive reported unsupported interpretation';end if;
 if r::text like '%'||pid::text||'%' or r::text like '%DO NOT EXPORT%' or r::text like '%portfolio-owner@example.org%' then raise exception 'personal journal data reached P-34 RPC';end if;
 if r->'session'->'manifest'->>'interpretation'<>'1' or r->'session'->'manifest'->>'joined'<>'1' then raise exception 'final provenance absent';end if;
 begin perform case_api.read_session_portfolio(u,s,0,repeat('0',64),false,null);raise exception 'changed boundary accepted';exception when serialization_failure then null;end;
 insert into case_app.admin_version_state(case_version_id,status) values(v,'withdrawn');
 if case_api.read_session_portfolio(u,s,0,b,false,null)->'session'->>'sourceStatus'<>'withdrawn' then raise exception 'withdrawn pinned history unavailable';end if;
 r:=case_api.personal_portfolio_stats(u,w,false,null);
 if r->>'sessions'<>'1' or r->>'completeRecords'<>'1' or r->>'active'<>'0' then raise exception 'personal totals are not server-derived';end if;
 if case_api.personal_portfolio_stats(a,w,true,'portfolio-admin@example.org')->>'sessions'<>'0' then raise exception 'admin dashboard includes others';end if;
 perform case_api.archive_session_batch(s,jsonb_build_object('events',jsonb_build_array(jsonb_build_object('seq',3,'event_id',case_app.uuid_v7(),'epoch',0,'kind','room_ended','payload','{}'::jsonb,'occurred_at',now()))));
 if (select count(*) from case_app.session_events where session_id=s)<>2 then raise exception 'late archive changed finalized journal';end if;
 begin update case_app.sessions set final_revision=3 where id=s;raise exception 'final provenance mutable';exception when check_violation then null;end;
 insert into case_app.session_participants(id,session_id,display_name,token_sha256,joined_at) values(pid,s,'DO NOT RETAIN',decode(repeat('a',64),'hex'),now()-interval '120 days');
 perform case_api.purge_expired_participant_data(interval '24 hours');
 if exists(select 1 from case_app.session_participants where session_id=s and (display_name is not null or token_sha256 is not null)) then raise exception 'portfolio extended personal retention';end if;
 if case_api.read_session_portfolio(u,s,0,b,false,null)->'session'->'manifest' is null then raise exception 'personal purge removed aggregate portfolio';end if;
 -- Global interpretation status must include unseen continuation pages, not just the first100 rows.
 declare later uuid:=case_app.uuid_v7();begin
  insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,expires_at)
  values(later,v,w,u,'PF0002','live',now()+interval '1 hour');
  insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at)
  select later,n,case_app.uuid_v7(),0,'names_shown','{}',now() from generate_series(1,100) n;
  if case_api.read_session_portfolio(u,later,0,null,false,null)->>'interpretationLimited'<>'false' then raise exception 'known page marked unsupported';end if;
  insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at)
  values(later,101,case_app.uuid_v7(),0,'future_uninterpreted_event','{}',now());
  r:=case_api.read_session_portfolio(u,later,0,null,false,null);
  if jsonb_array_length(r->'items')<>100 or r->>'nextPosition'<>'100' or r->>'interpretationLimited'<>'true' then raise exception 'unseen unsupported continuation falsely complete';end if;
 end;
 if has_function_privilege('anon','case_api.read_session_portfolio(uuid,uuid,bigint,text,boolean,text)','EXECUTE') or has_function_privilege('authenticated','case_api.query_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text)','EXECUTE') or has_function_privilege('service_role','case_api.archive_session_batch_v4(uuid,jsonb)','EXECUTE') then raise exception 'portfolio/internal RPC privileges';end if;
end;$$;
rollback;
