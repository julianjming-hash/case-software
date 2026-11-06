-- CASE-334: a finalized record whose journal holds the room music kind is complete evidence; the list stays an allowlist.
begin;
do $$
declare u uuid:=case_app.uuid_v7();w uuid:=case_app.uuid_v7();c uuid:=case_app.uuid_v7();v uuid:=case_app.uuid_v7();s uuid:=case_app.uuid_v7();s2 uuid:=case_app.uuid_v7();pid uuid:=case_app.uuid_v7();
 doc jsonb:='{"schema_version":1,"title":"Kinds case","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}';r jsonb;k text;n int:=1;
begin
 insert into auth.users(id,email) values(u,'music-kind-owner@example.org');insert into case_app.profiles(id) values(u);
 insert into case_app.workspaces(id,slug,name) values(w,'music-kind-test','Kinds');insert into case_app.workspace_members(workspace_id,user_id,role) values(w,u,'owner');
 insert into case_app.cases(id,workspace_id,owner_id,title) values(c,w,u,'Kinds case');
 insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values(v,c,1,1,doc,sha256(convert_to(doc::text,'UTF8')),u);
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,started_at,ended_at,expires_at,final_revision,final_epoch,personal_data_delete_at)
 values(s,v,w,u,'MK0001','ended',now()-interval '3 days',now()-interval '3 days',now()-interval '3 days'+interval '1 hour',now()-interval '3 days'+interval '2 hours',9,0,now()-interval '2 days'),
       (s2,v,w,u,'MK0002','ended',now()-interval '3 days',now()-interval '3 days',now()-interval '3 days'+interval '1 hour',now()-interval '3 days'+interval '2 hours',2,0,now()-interval '2 days');
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at) values(s,1,case_app.uuid_v7(),0,'participant_joined',jsonb_build_object('participantId',pid),now()-interval '3 days');
 foreach k in array array['debrief_started','debrief_left','media_control','responses_closing','lock_cancelled','auto_lock_set','music_set','room_ended'] loop
  n:=n+1;insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at) values(s,n,case_app.uuid_v7(),0,k,'{}',now()-interval '3 days'+n*interval '1 minute');
 end loop;
 if not case_api.finalize_session_portfolio(s,v,9,0,9,0,1) then raise exception 'finalization refused';end if;
 r:=case_api.read_session_portfolio(u,s,0,null,false,null);
 if r->>'interpretationLimited'<>'false' then raise exception 'the music kind marked the record limited';end if;
 insert into case_app.session_events(session_id,seq,event_id,epoch,kind,payload,occurred_at) values(s2,1,case_app.uuid_v7(),0,'kind_nobody_writes','{}',now()-interval '3 days'),
  (s2,2,case_app.uuid_v7(),0,'room_ended','{}',now()-interval '3 days'+interval '1 minute');
 if not case_api.finalize_session_portfolio(s2,v,2,0,2,0,1) then raise exception 'second finalization refused';end if;
 if case_api.read_session_portfolio(u,s2,0,null,false,null)->>'interpretationLimited'<>'true' then raise exception 'an unknown kind no longer marks the record limited';end if;
end;$$;
rollback;
