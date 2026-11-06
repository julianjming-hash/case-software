-- Archive retention assertions; independent fixtures rollback before other SQL tests.
\set QUIET on
begin;
insert into auth.users values ('0199b000-0000-7000-8000-000000000001');
insert into case_app.profiles(id,display_name) values ('0199b000-0000-7000-8000-000000000001','Archive fixture');
insert into case_app.workspaces(id,slug,name) values ('0199b000-0000-7000-8000-000000000002','archive-retention','Archive fixture');
insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199b000-0000-7000-8000-000000000003','0199b000-0000-7000-8000-000000000002','0199b000-0000-7000-8000-000000000001','Fixture');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
values ('0199b000-0000-7000-8000-000000000004','0199b000-0000-7000-8000-000000000003',1,1,'{}',sha256('fixture'),'0199b000-0000-7000-8000-000000000001');
create temporary sequence archive_fixture_code;
create function pg_temp.room() returns uuid language plpgsql as $$
declare s uuid := case_app.uuid_v7();
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,expires_at)
 values(s,'0199b000-0000-7000-8000-000000000004','0199b000-0000-7000-8000-000000000002','0199b000-0000-7000-8000-000000000001',lpad(nextval('pg_temp.archive_fixture_code')::text,6,'0'),clock_timestamp()-interval '2 days',clock_timestamp()+interval '1 day');
 return s;
end $$;
create function pg_temp.personal(p uuid, r uuid, e uuid, t timestamptz) returns jsonb language sql as $$
 select jsonb_build_object('participants',jsonb_build_array(jsonb_build_object('id',p,'display_name','Fixture name','token_sha256',encode(sha256('fixture token'),'hex'),'joined_at',t)),
 'rounds',jsonb_build_array(jsonb_build_object('id',r,'decision_id',e,'round_no',1,'status','resolved','opened_at',t,'aggregate',jsonb_build_object('total',1))),
 'responses',jsonb_build_array(jsonb_build_object('id',case_app.uuid_v7(),'round_id',r,'participant_id',p,'response',jsonb_build_object('text','Fixture answer'),'last_client_event_id',case_app.uuid_v7(),'first_submitted_at',t,'last_submitted_at',t)),
 'events',jsonb_build_array(jsonb_build_object('seq',1,'event_id',e,'epoch',0,'kind','room_ended','occurred_at',t)));
$$;

-- Source end is independent of delayed receipt; finalization stays callable after metadata.
do $$ declare s uuid := pg_temp.room(); t timestamptz := clock_timestamp()-interval '23 hours'; b jsonb; bad boolean:=false;
begin
 b:=jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours');
 perform case_api.archive_session_batch(s,b);
 if (select ended_at from case_app.sessions where id=s) is distinct from t or
    (select personal_data_delete_at from case_app.sessions where id=s) is distinct from t+interval '24 hours' then raise exception 'source deadline changed by receipt'; end if;
 begin perform case_api.archive_session_batch(s,jsonb_build_object('participants',jsonb_build_array(jsonb_build_object('id','not-a-uuid')))); exception when invalid_text_representation then bad:=true; end;
 if not bad or (select ended_at from case_app.sessions where id=s) is distinct from t then raise exception 'metadata boundary lost on data failure'; end if;
 perform case_api.end_session(s,50,2); perform case_api.end_session(s,1,0);
 if (select final_revision from case_app.sessions where id=s)<>50 or (select final_epoch from case_app.sessions where id=s)<>2 or (select ended_at from case_app.sessions where id=s) is distinct from t then raise exception 'finalizer changed source end or regressed'; end if;
 perform case_api.archive_session_batch(s,jsonb_build_object('status','live','ended_at',t+interval '1 hour','personal_data_delete_at',t+interval '25 hours'));
 if (select personal_data_delete_at from case_app.sessions where id=s) is distinct from t+interval '24 hours' or (select status from case_app.sessions where id=s)<>'ended' then raise exception 'replay extended cutoff or reopened'; end if;
 raise notice 'ok archive source deadline and monotonic finalization';
end $$;

-- Actual delayed alarm end remains distinct from the earlier expiry backstop.
do $$ declare s uuid:=pg_temp.room(); t timestamptz:=clock_timestamp()-interval '1 hour';
begin
 update case_app.sessions set expires_at=t-interval '1 hour' where id=s;
 perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours'));
 perform case_api.end_session(s,2,0);
 if (select ended_at from case_app.sessions where id=s) is distinct from t or (select personal_data_delete_at from case_app.sessions where id=s) is distinct from t+interval '23 hours' then raise exception 'finalizer clamped actual end to expiry'; end if;
 s:=pg_temp.room(); update case_app.sessions set expires_at=t-interval '1 hour' where id=s;
 perform case_api.purge_expired_participant_data();
 perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours'));
 if (select ended_at from case_app.sessions where id=s) is distinct from t then raise exception 'expiry fallback displaced actual source end'; end if;
 raise notice 'ok archive delayed source end differs from expiry';
end $$;

-- SQL must refuse/clean personal data immediately at a source cutoff, without cron.
do $$ declare s uuid:=pg_temp.room(); p uuid:=case_app.uuid_v7(); r uuid:=case_app.uuid_v7(); e uuid:=case_app.uuid_v7(); t timestamptz:=clock_timestamp()-interval '25 hours'; b jsonb; tomb timestamptz;
begin
 b:=pg_temp.personal(p,r,e,t); perform case_api.archive_session_batch(s,b);
 perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours'));
 if exists(select 1 from case_app.session_responses where session_id=s) or exists(select 1 from case_app.session_participants where session_id=s and (display_name is not null or token_sha256 is not null)) then raise exception 'late source cutoff retained personal data before cron'; end if;
 select retention_purged_at into tomb from case_app.sessions where id=s;
 if tomb is null then raise exception 'late source cutoff lacks tombstone'; end if;
 perform case_api.archive_session_batch(s,b||jsonb_build_object('ended_at',clock_timestamp(),'personal_data_delete_at',clock_timestamp()+interval '24 hours'));
 if exists(select 1 from case_app.session_responses where session_id=s) or exists(select 1 from case_app.session_participants where session_id=s and display_name is not null) or (select retention_purged_at from case_app.sessions where id=s) is distinct from tomb then raise exception 'late replay restored personal data or tombstone'; end if;
 if not exists(select 1 from case_app.session_rounds where session_id=s and aggregate is not null) or not exists(select 1 from case_app.session_events where session_id=s) then raise exception 'privacy guard lost aggregate or journal'; end if;
 raise notice 'ok archive late personal guard and replay tombstone';
end $$;

-- Expiry cannot overwrite an earlier authoritative end; shorter custom retention still works.
do $$ declare s uuid:=pg_temp.room(); t timestamptz:=clock_timestamp()-interval '3 hours';
begin
 perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours'));
 update case_app.sessions set status='live',expires_at=clock_timestamp()-interval '1 hour' where id=s;
 perform case_api.purge_expired_participant_data(interval '2 hours');
 if (select ended_at from case_app.sessions where id=s) is distinct from t or (select retention_purged_at from case_app.sessions where id=s) is null then raise exception 'expiry overwrote source end or shorter purge failed'; end if;
 raise notice 'ok archive expiry preserves end and shorter purge';
end $$;

-- An expired room is guarded before cron, and longer custom intervals cannot extend cutoff.
do $$ declare s uuid:=pg_temp.room(); p uuid:=case_app.uuid_v7(); t timestamptz:=clock_timestamp()-interval '25 hours';
begin
 update case_app.sessions set created_at=t-interval '1 hour',expires_at=t where id=s;
 perform case_api.archive_session_batch(s,pg_temp.personal(p,case_app.uuid_v7(),case_app.uuid_v7(),t));
 if exists(select 1 from case_app.session_participants where session_id=s and display_name is not null) or exists(select 1 from case_app.session_responses where session_id=s) then raise exception 'expiry backstop accepted late personal data'; end if;
 s:=pg_temp.room(); perform case_api.end_session(s,0,0); update case_app.sessions set ended_at=t where id=s;
 perform case_api.purge_expired_participant_data(interval '100 days');
 if (select retention_purged_at from case_app.sessions where id=s) is null then raise exception 'long interval extended fixed cutoff'; end if;
 raise notice 'ok archive expiry backstop and interval cap';
end $$;

-- Metadata must be finite paired timestamps and never later than source end+24h.
do $$ declare s uuid:=pg_temp.room(); t timestamptz:=clock_timestamp()-interval '1 hour'; bad boolean:=false;
begin
 begin perform case_api.archive_session_batch(s,jsonb_build_object('personal_data_delete_at',t)); exception when check_violation then bad:=true; end;
 if not bad then raise exception 'unpaired cutoff accepted'; end if;
 bad:=false; begin perform case_api.archive_session_batch(s,'{"ended_at":"infinity","personal_data_delete_at":"infinity"}'); exception when check_violation then bad:=true; end;
 if not bad then raise exception 'infinite cutoff accepted'; end if;
 perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '100 days'));
 if (select personal_data_delete_at from case_app.sessions where id=s)>t+interval '24 hours' then raise exception 'source cutoff not clamped'; end if;
 raise notice 'ok archive timestamp validation and clamp';
end $$;

-- Relative/non-string metadata cannot masquerade as immutable server timestamps.
do $$ declare s uuid:=pg_temp.room(); bad boolean:=false;
begin
 begin perform case_api.archive_session_batch(s,'{"ended_at":"now","personal_data_delete_at":"tomorrow"}'); exception when check_violation then bad:=true; end;
 if not bad then raise exception 'relative end timestamp accepted'; end if;
 bad:=false; begin perform case_api.archive_session_batch(s,'{"ended_at":42,"personal_data_delete_at":43}'); exception when check_violation then bad:=true; end;
 if not bad then raise exception 'non-string end timestamp accepted'; end if;
 raise notice 'ok archive absolute timestamp grammar';
end $$;
do $$ declare s uuid:=pg_temp.room(); t timestamptz:=clock_timestamp()+interval '1 hour'; bad boolean:=false;
begin
 begin perform case_api.archive_session_batch(s,jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours')); exception when check_violation then bad:=true; end;
 if not bad then raise exception 'future source end accepted'; end if;
 raise notice 'ok archive future source end refused';
end $$;

-- Clock crossing during writes is checked again before the RPC returns.
create temporary table archive_trigger_seen(session_id uuid);
create function pg_temp.slow_participant() returns trigger language plpgsql as $$
declare delay double precision;
begin
 insert into archive_trigger_seen values(new.session_id);
 select greatest(0,extract(epoch from personal_data_delete_at-clock_timestamp()))+0.05 into delay from case_app.sessions where id=new.session_id;
 if delay>3 then raise exception 'fixture delay exceeded bound'; end if;
 perform pg_sleep(delay); return new;
end $$;
create trigger archive_retention_slow before insert on case_app.session_participants for each row execute function pg_temp.slow_participant();
do $$ declare s uuid:=pg_temp.room(); t timestamptz:=clock_timestamp()-interval '24 hours'+interval '2 seconds';
begin
 perform case_api.archive_session_batch(s,pg_temp.personal(case_app.uuid_v7(),case_app.uuid_v7(),case_app.uuid_v7(),t)||jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours'));
 if not exists(select 1 from archive_trigger_seen where session_id=s) then raise exception 'clock crossing fixture never admitted a write'; end if;
 if exists(select 1 from case_app.session_responses where session_id=s) or exists(select 1 from case_app.session_participants where session_id=s and display_name is not null) then raise exception 'clock crossing retained personal writes'; end if;
 raise notice 'ok archive post-write deadline check';
end $$;
drop trigger archive_retention_slow on case_app.session_participants;

-- Original signatures and service-role-only execution survive replacement.
do $$ declare f regprocedure; begin
 foreach f in array array['case_api.archive_session_batch(uuid,jsonb)'::regprocedure,'case_api.end_session(uuid,bigint,integer)'::regprocedure,'case_api.purge_expired_participant_data(interval)'::regprocedure] loop
 if not has_function_privilege('service_role',f,'execute') or has_function_privilege('anon',f,'execute') or has_function_privilege('authenticated',f,'execute') then raise exception 'archive privilege contract changed'; end if;
 if not (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid=f) then raise exception 'archive definer search path changed'; end if;
 end loop;
 raise notice 'ok archive original signatures and privileges';
end $$;
rollback;
