-- Genuine source submission/event/time and separate immutable seed provenance survive archive replay.
\set QUIET on
begin;
insert into auth.users values ('0199c000-0000-7000-8000-000000000001');
insert into case_app.profiles(id,display_name) values ('0199c000-0000-7000-8000-000000000001','Correction fixture');
insert into case_app.workspaces(id,slug,name) values ('0199c000-0000-7000-8000-000000000002','correction-seed','Correction fixture');
insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199c000-0000-7000-8000-000000000003','0199c000-0000-7000-8000-000000000002','0199c000-0000-7000-8000-000000000001','Fixture');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
values ('0199c000-0000-7000-8000-000000000004','0199c000-0000-7000-8000-000000000003',1,1,'{}',sha256('correction fixture'),'0199c000-0000-7000-8000-000000000001');

do $$ declare
 s uuid:=case_app.uuid_v7(); p uuid:=case_app.uuid_v7(); r uuid:=case_app.uuid_v7();
 d uuid:=case_app.uuid_v7(); original uuid:=case_app.uuid_v7(); event uuid:=case_app.uuid_v7();
 fresh_round uuid:=case_app.uuid_v7(); fresh_response uuid:=case_app.uuid_v7(); correction uuid:=case_app.uuid_v7();
 submitted timestamptz:=clock_timestamp()-interval '2 minutes'; seeded timestamptz:=clock_timestamp()-interval '1 minute';
 batch jsonb; original_before jsonb; after_row case_app.session_responses%rowtype; refused boolean:=false;
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,expires_at)
 values(s,'0199c000-0000-7000-8000-000000000004','0199c000-0000-7000-8000-000000000002','0199c000-0000-7000-8000-000000000001','8C3K9P',clock_timestamp()-interval '30 hours',clock_timestamp()+interval '1 day');
 batch:=jsonb_build_object('participants',jsonb_build_array(jsonb_build_object('id',p,'display_name','Fixture','token_sha256',encode(sha256('correction token'),'hex'),'joined_at',submitted)),
  'rounds',jsonb_build_array(jsonb_build_object('id',r,'decision_id',d,'round_no',1,'status','resolved','opened_at',submitted,'locked_at',submitted,'closed_at',seeded,'aggregate',jsonb_build_object('total',1))),
  'responses',jsonb_build_array(jsonb_build_object('id',original,'round_id',r,'participant_id',p,'response',jsonb_build_object('text','Original genuine answer'),'last_client_event_id',event,'first_submitted_at',submitted,'last_submitted_at',submitted)));
 perform case_api.archive_session_batch(s,batch);
 select to_jsonb(x) into original_before from case_app.session_responses x where id=original;
 -- A stale open-round retry cannot erase resolved lock/aggregate evidence.
 perform case_api.archive_session_batch(s,jsonb_build_object('rounds',jsonb_build_array(jsonb_build_object('id',r,'decision_id',d,'round_no',1,'status','open','opened_at',submitted))));
 if (select status from case_app.session_rounds where id=r)<>'resolved' or (select aggregate from case_app.session_rounds where id=r) is distinct from jsonb_build_object('total',1) then raise exception 'stale replay erased resolved evidence'; end if;
 batch:=jsonb_build_object('rounds',jsonb_build_array(jsonb_build_object('id',fresh_round,'decision_id',d,'round_no',2,'status','open','opened_at',seeded)),
  'responses',jsonb_build_array(jsonb_build_object('id',fresh_response,'round_id',fresh_round,'participant_id',p,'response',jsonb_build_object('text','Original genuine answer'),'last_client_event_id',event,'first_submitted_at',submitted,'last_submitted_at',submitted,
    'source_response_id',original,'source_round_id',r,'source_client_event_id',event,'correction_event_id',correction,'seeded_at',seeded)));
 perform case_api.archive_session_batch(s,batch); perform case_api.archive_session_batch(s,batch);
 select * into after_row from case_app.session_responses where id=fresh_response;
 if after_row.id=original or after_row.last_client_event_id<>event or after_row.first_submitted_at<>submitted or after_row.last_submitted_at<>submitted or after_row.seeded_at<>seeded or after_row.correction_event_id<>correction then raise exception 'seed replaced genuine participant evidence'; end if;
 if (select to_jsonb(x) from case_app.session_responses x where id=original) is distinct from original_before then raise exception 'correction reassigned original evidence'; end if;
 if (select count(*) from case_app.session_responses where session_id=s)<>2 then raise exception 'seed replay duplicated responses'; end if;
 if exists(select 1 from case_app.session_events where session_id=s and kind='response_recorded') then raise exception 'seed fabricated participant journal'; end if;
 -- A deliberate choice edit changes only its genuine last submission event/time.
 batch:=jsonb_set(batch,'{responses,0,last_client_event_id}',to_jsonb(case_app.uuid_v7()));
 batch:=jsonb_set(batch,'{responses,0,last_submitted_at}',to_jsonb(clock_timestamp()));
 perform case_api.archive_session_batch(s,batch);
 if (select source_client_event_id from case_app.session_responses where id=fresh_response)<>event or (select seeded_at from case_app.session_responses where id=fresh_response)<>seeded then raise exception 'actual edit changed seed origin'; end if;
 begin update case_app.session_responses set source_round_id=fresh_round where id=fresh_response; exception when check_violation then refused:=true; end;
 if not refused then raise exception 'seed provenance was mutable'; end if;
 -- Entire personal linkage disappears under the existing actual cutoff; replay cannot resurrect it.
 perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',clock_timestamp()-interval '25 hours','personal_data_delete_at',clock_timestamp()-interval '1 hour'));
 if exists(select 1 from case_app.session_responses where session_id=s) then raise exception 'seed linkage survived personal purge'; end if;
 perform case_api.archive_session_batch(s,batch);
 if exists(select 1 from case_app.session_responses where session_id=s) then raise exception 'late retry recreated seed linkage'; end if;
 raise notice 'ok genuine seed provenance, immutable origin, replay and personal cutoff';
end $$;
rollback;
