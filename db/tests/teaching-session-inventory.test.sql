-- CASE-359: teaching evidence and unique joined totals, plus bounded cleanup without deleting taught/unknown rooms.
begin;
do $$
declare u uuid:=case_app.uuid_v7(); outsider uuid:=case_app.uuid_v7(); w uuid:=case_app.uuid_v7(); c uuid:=case_app.uuid_v7(); v uuid:=case_app.uuid_v7();
 s uuid; taught uuid; never_started uuid; unknown_room uuid; future_room uuid; p jsonb; total integer; n integer; cursor_id uuid;
 doc jsonb:='{"schema_version":1,"title":"Every Breath You Take","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}';
begin
 insert into auth.users(id,email) values(u,'teaching-inventory@example.org'),(outsider,'teaching-outsider@example.org');
 insert into case_app.profiles(id) values(u),(outsider);
 insert into case_app.workspaces(id,slug,name) values(w,'teaching-inventory-test','Teaching inventory');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(w,u,'owner');
 insert into case_app.cases(id,workspace_id,owner_id,title) values(c,w,u,'Case name');
 insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values(v,c,1,1,doc,sha256(convert_to(doc::text,'UTF8')),u);
 for i in 1..22 loop
  s:=case_app.uuid_v7();
  insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,started_at,ended_at,expires_at)
   values(s,v,w,u,'CT'||lpad(i::text,4,'0'),'ended',now()-interval '40 days',now()-interval '40 days'+interval '1 minute',now()-interval '40 days'+interval '1 hour',now()-interval '39 days');
  if i=1 then taught:=s;end if;
 end loop;
 -- Newer lobby-only rows cannot starve a page of taught sessions.
 for i in 1..25 loop
  s:=case_app.uuid_v7();
  insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,ended_at,expires_at)
   values(s,v,w,u,'CB'||lpad(i::text,4,'0'),'expired',now()-interval '31 days',now()-interval '30 days',now()-interval '30 days');
  if i=1 then never_started:=s;end if;
 end loop;
 p:=case_api.query_teaching_session_portfolio(u,w,'','all',now()-interval '40 days'+interval '30 seconds',now()-interval '39 days',null,true,false,null,null);
 if jsonb_array_length(p->'rooms')<>20 then raise exception 'date filters do not follow the displayed teaching date';end if;
 -- Legacy teaching evidence remains visible even when started_at was not archived.
 s:=case_app.uuid_v7();insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,expires_at) values(s,v,w,u,'TEACHX','expired',now()-interval '31 days',now()-interval '30 days');
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,occurred_at) values(s,1,case_app.uuid_v7(),0,'beat_entered',now()-interval '31 days');
 unknown_room:=case_app.uuid_v7();insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,expires_at) values(unknown_room,v,w,u,'NKNNWN','expired',now()-interval '31 days',now()-interval '30 days');
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,occurred_at) values(unknown_room,1,case_app.uuid_v7(),0,'future_kind',now()-interval '31 days');
 future_room:=case_app.uuid_v7();insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,expires_at) values(future_room,v,w,u,'FTRR9E','lobby',now()-interval '31 days',now()+interval '1 hour');
 p:=case_api.query_teaching_session_portfolio(u,w,'','all',null,null,null,true,false,null,null);
 if jsonb_array_length(p->'rooms')<>20 or exists(select 1 from jsonb_array_elements(p->'rooms') r where not case_app.has_teaching_evidence((r->>'id')::uuid,(r->>'started_at')::timestamptz)) then raise exception 'teaching filtering must precede limit';end if;
 cursor_id:=(p->>'nextAfter')::uuid;p:=case_api.query_teaching_session_portfolio(u,w,'','all',null,null,cursor_id,true,false,null,c);
 if jsonb_array_length(p->'rooms')<>3 then raise exception 'teaching continuation lost rows';end if;
 if (case_api.personal_teaching_portfolio_stats(u,w,false,null)->>'sessions')::int<>23 then raise exception 'totals include lobby-only attempts';end if;
 update case_app.sessions set status='lobby' where id=taught;
 if (case_api.personal_teaching_portfolio_stats(u,w,false,null)->>'active')::int<>0 then
  -- This old expired row cannot be active, but its prior teaching remains visible.
  raise exception 'expired teaching marked active';end if;
 if (case_api.personal_teaching_portfolio_stats(u,w,false,null)->>'sessions')::int<>23 then raise exception 'returning to Lobby erased teaching';end if;
 update case_app.sessions set status='ended' where id=taught;
 -- Removed participants remain in the distinct lifetime total; no connected/max-concurrent guess.
 for i in 1..3 loop insert into case_app.session_participants(id,session_id,display_name,joined_at,removed_at) values(case_app.uuid_v7(),taught,'Person',now()-interval '40 days',case when i=1 then now()-interval '40 days'+interval '5 minutes' end);end loop;
 if case_app.session_joined_total(taught,null)<>3 then raise exception 'unique joined count lost removed participant';end if;
 update case_app.sessions set final_revision=1,final_epoch=0 where id=taught;
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,occurred_at) values(taught,1,case_app.uuid_v7(),0,'room_ended',now()-interval '40 days'+interval '1 hour');
 perform case_api.finalize_session_portfolio(taught,v,1,0,1,0,3);
 update case_app.session_participants set display_name=null,token_sha256=null,purged_at=now() where session_id=taught;
 if case_app.session_joined_total(taught,(select portfolio_manifest from case_app.sessions where id=taught))<>3 then raise exception 'personal purge changed total';end if;
 if case_app.session_joined_total(never_started,null) is not null then raise exception 'missing evidence fabricated zero';end if;
 begin perform case_api.query_teaching_session_portfolio(outsider,w,'','all',null,null,null,true,false,null,null);raise exception 'teaching query granted access';exception when insufficient_privilege then null;end;
 if jsonb_array_length(case_api.query_session_portfolio(u,w,'','all',null,null,null,true,false,null)->'rooms')<>20 then raise exception 'legacy query changed';end if;
 insert into case_app.workspace_audit(workspace_id,actor_kind,actor_user_id,action,target_type,target_id) values(w,'owner',u,'room_start','room',never_started);
 insert into case_app.session_participants(id,session_id,joined_at) values(case_app.uuid_v7(),never_started,now()-interval '31 days');
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,occurred_at) values(never_started,1,case_app.uuid_v7(),0,'auto_lock_set',now()-interval '31 days');
 total:=case_api.purge_abandoned_lobbies(2);if total<>2 then raise exception 'cleanup page not bounded';end if;
 n:=case_api.purge_abandoned_lobbies(200);if n<>23 then raise exception 'cleanup omitted or included wrong rooms: %',n;end if;
 if not exists(select 1 from case_app.workspace_audit where target_id=never_started and action='room_start') or exists(select 1 from case_app.session_participants where session_id=never_started) or exists(select 1 from case_app.session_events where session_id=never_started) then raise exception 'cleanup lost audit or retained abandoned archive children';end if;
 if case_api.purge_abandoned_lobbies(200)<>0 then raise exception 'cleanup not idempotent';end if;
 if not exists(select 1 from case_app.sessions where id=taught) or not exists(select 1 from case_app.sessions where id=unknown_room) or not exists(select 1 from case_app.sessions where id=future_room) then raise exception 'cleanup deleted taught, unknown or unexpired room';end if;
 if has_function_privilege('anon','case_api.purge_abandoned_lobbies(integer)','EXECUTE') or has_function_privilege('authenticated','case_api.query_teaching_session_portfolio(uuid,uuid,text,text,timestamptz,timestamptz,uuid,boolean,boolean,text,uuid)','EXECUTE') then raise exception 'service boundary';end if;
 begin perform case_api.purge_abandoned_lobbies(201);raise exception 'unbounded cleanup accepted';exception when invalid_parameter_value then null;end;
end $$;
rollback;
