-- Debrief opens feedback before End (console layout v2, migration 20261107000000): a live room in Debrief resolves as
-- open and accepts a response; Back to the case closes the window again with the response kept; an ended or expired
-- room is never marked; only the service role may mark. Independent fixtures; rolled back.
\set QUIET on
begin;
insert into auth.users values ('0199f100-0000-7000-8000-000000000001');
insert into case_app.profiles(id,display_name) values ('0199f100-0000-7000-8000-000000000001','Debrief fixture');
insert into case_app.workspaces(id,slug,name) values ('0199f100-0000-7000-8000-000000000002','feedback-debrief','Debrief fixture');
insert into case_app.cases(id,workspace_id,owner_id,title)
values ('0199f100-0000-7000-8000-000000000003','0199f100-0000-7000-8000-000000000002','0199f100-0000-7000-8000-000000000001','Fixture');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
values ('0199f100-0000-7000-8000-000000000004','0199f100-0000-7000-8000-000000000003',1,1,
 '{"title":"Diving Deeper","learning_objectives":["First objective."]}',sha256('debrief fixture'),'0199f100-0000-7000-8000-000000000001');
create temporary sequence debrief_fixture_join;
create function pg_temp.room(p_ended boolean) returns uuid language plpgsql as $$
declare s uuid := case_app.uuid_v7();
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,started_at,ended_at,status,expires_at)
 values(s,'0199f100-0000-7000-8000-000000000004','0199f100-0000-7000-8000-000000000002','0199f100-0000-7000-8000-000000000001',
  lpad((900000+nextval('pg_temp.debrief_fixture_join'))::text,6,'0'),clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour',
  case when p_ended then clock_timestamp()-interval '5 minutes' end, case when p_ended then 'ended' else 'live' end,clock_timestamp()+interval '2 hours');
 return s;
end $$;
create function pg_temp.code(s uuid) returns text language sql as $$ select feedback_code::text from case_app.sessions where id=s $$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlerrm; end $$;

do $$ declare live uuid := pg_temp.room(false); r jsonb;
begin
 if case_api.feedback_resolve(pg_temp.code(live)) <> '{"state":"not_ended"}'::jsonb then raise exception 'a live room opened feedback before Debrief'; end if;
 if pg_temp.err(format('select case_api.feedback_upsert(%L, sha256(%L::bytea), %L, %L)', live, 'a', 'joined', '{"rating_session":5}')) not like '%feedback_not_open%' then
  raise exception 'a live room took a response before Debrief'; end if;
 if case_api.set_session_debrief(live, true) is not true then raise exception 'Debrief not marked'; end if;
 r := case_api.feedback_resolve(pg_temp.code(live));
 if r->>'state' <> 'open' or (r->>'session_id')::uuid <> live or r->>'title' <> 'Diving Deeper' then raise exception 'Debrief resolve wrong: %', r; end if;
 if pg_temp.err(format('select case_api.feedback_upsert(%L, sha256(%L::bytea), %L, %L)', live, 'a', 'joined', '{"rating_session":5}')) <> '' then
  raise exception 'a room in Debrief refused a response'; end if;
 -- Back to the case: the page says not yet open again, and the response already sent is kept.
 if case_api.set_session_debrief(live, false) is not true then raise exception 'Debrief not cleared'; end if;
 if case_api.feedback_resolve(pg_temp.code(live)) <> '{"state":"not_ended"}'::jsonb then raise exception 'Back to the case left feedback open'; end if;
 if (select count(*) from case_app.session_feedback where session_id = live) <> 1 then raise exception 'the Debrief response was not kept'; end if;
 raise notice 'ok Debrief opens feedback before End; Back to the case closes it and keeps responses';
end $$;

do $$ declare ended uuid := pg_temp.room(true);
begin
 if case_api.set_session_debrief(ended, true) is not false then raise exception 'an ended room was marked as in Debrief'; end if;
 if (select debrief_at from case_app.sessions where id = ended) is not null then raise exception 'debrief_at set on an ended room'; end if;
 if case_api.set_session_debrief(case_app.uuid_v7(), true) is not false then raise exception 'an unknown session was marked'; end if;
 raise notice 'ok ended and unknown rooms are never marked';
end $$;

do $$
begin
 if has_function_privilege('anon', 'case_api.set_session_debrief(uuid, boolean)', 'execute')
    or has_function_privilege('authenticated', 'case_api.set_session_debrief(uuid, boolean)', 'execute') then
  raise exception 'set_session_debrief is reachable by a client role'; end if;
 if not has_function_privilege('service_role', 'case_api.set_session_debrief(uuid, boolean)', 'execute') then
  raise exception 'service_role cannot mark Debrief'; end if;
 raise notice 'ok set_session_debrief is service-only';
end $$;
rollback;
