-- Participant feedback (CASE-284, docs/plans/PARTICIPANT-FEEDBACK.md): code minting, the window, one linked
-- response per respondent, caps, the purge fold and service-only access. Independent fixtures; rolled back.
\set QUIET on
begin;
insert into auth.users values ('0199f000-0000-7000-8000-000000000001');
insert into case_app.profiles(id,display_name) values ('0199f000-0000-7000-8000-000000000001','Feedback fixture');
insert into case_app.workspaces(id,slug,name) values ('0199f000-0000-7000-8000-000000000002','participant-feedback','Feedback fixture');
insert into case_app.case_groups(id,workspace_id,name,feedback_form_url)
values ('0199f000-0000-7000-8000-000000000005','0199f000-0000-7000-8000-000000000002','Fixture group','https://forms.example.org/group');
insert into case_app.cases(id,workspace_id,owner_id,title,group_id)
values ('0199f000-0000-7000-8000-000000000003','0199f000-0000-7000-8000-000000000002','0199f000-0000-7000-8000-000000000001','Fixture','0199f000-0000-7000-8000-000000000005');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
values ('0199f000-0000-7000-8000-000000000004','0199f000-0000-7000-8000-000000000003',2,1,
 '{"title":"Diving Deeper","audience":"Registrars","learning_objectives":["First objective.","Second objective."]}',sha256('feedback fixture'),'0199f000-0000-7000-8000-000000000001');
create temporary sequence feedback_fixture_join;
-- A room; p_ended_ago null leaves it live.
create function pg_temp.room(p_ended_ago interval) returns uuid language plpgsql as $$
declare s uuid := case_app.uuid_v7();
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,started_at,ended_at,status,expires_at)
 values(s,'0199f000-0000-7000-8000-000000000004','0199f000-0000-7000-8000-000000000002','0199f000-0000-7000-8000-000000000001',
  lpad(nextval('pg_temp.feedback_fixture_join')::text,6,'0'),clock_timestamp()-interval '3 hours',clock_timestamp()-interval '3 hours',
  case when p_ended_ago is null then null else clock_timestamp()-p_ended_ago end,
  case when p_ended_ago is null then 'live' else 'ended' end,clock_timestamp()+interval '9 hours');
 return s;
end $$;
create function pg_temp.who(p text) returns bytea language sql as $$ select sha256(convert_to(p,'UTF8')) $$;
create function pg_temp.code(s uuid) returns text language sql as $$ select feedback_code::text from case_app.sessions where id=s $$;
-- Run a call and return the error message ('' when it succeeds).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlerrm; end $$;

-- Every room gets a Crockford code at insert; codes are unique forever, including after the room closes.
do $$ declare s uuid; codes text[] := '{}'; c text;
begin
 for i in 1..50 loop s := pg_temp.room(null); c := pg_temp.code(s);
  if c is null or c !~ '^[0-9A-HJKMNP-TV-Z]{6}$' then raise exception 'feedback code not minted: %', c; end if;
  codes := codes || c; end loop;
 if (select count(distinct x) from unnest(codes) x) <> 50 then raise exception 'feedback codes repeated'; end if;
 if pg_temp.err(format($q$insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,feedback_code,expires_at)
   values(case_app.uuid_v7(),'0199f000-0000-7000-8000-000000000004','0199f000-0000-7000-8000-000000000002','0199f000-0000-7000-8000-000000000001','ZZZZZZ',%L,clock_timestamp()+interval '1 hour')$q$, codes[1])) = '' then
  raise exception 'a feedback code was reused'; end if;
 raise notice 'ok feedback code minted, valid and never reused';
end $$;

-- Resolve: unknown is null; a live room is not open; an ended room is open with public facts and the form link.
do $$ declare live uuid := pg_temp.room(null); ended uuid := pg_temp.room(interval '1 hour'); r jsonb;
begin
 if case_api.feedback_resolve('000000') is not null or case_api.feedback_resolve('not a code') is not null then raise exception 'unknown code resolved'; end if;
 r := case_api.feedback_resolve(pg_temp.code(live));
 if r <> '{"state":"not_ended"}'::jsonb then raise exception 'a live room''s code revealed more than its state: %', r; end if;
 if case_api.session_feedback_code(live)->>'code' is distinct from pg_temp.code(live) then raise exception 'session_feedback_code wrong'; end if;
 r := case_api.feedback_resolve(lower(pg_temp.code(ended)));
 if r->>'state' <> 'open' or (r->>'session_id')::uuid <> ended or r->>'title' <> 'Diving Deeper' or (r->>'version_no')::int <> 2
    or r->'objectives' <> '["First objective.","Second objective."]'::jsonb or r->>'audience' <> 'Registrars'
    or (r->>'closes_at')::timestamptz > clock_timestamp()+interval '23 hours 1 minute' or r->>'form_url' <> 'https://forms.example.org/group' then
  raise exception 'ended room resolve wrong: %', r; end if;
 if r ?| array['join_code','facilitator_id','workspace_id','feedback_code'] then raise exception 'resolve leaked a private field: %', r; end if;
 update case_app.sessions set feedback_form_url='https://forms.example.org/room' where id=ended;
 if case_api.feedback_resolve(pg_temp.code(ended))->>'form_url' <> 'https://forms.example.org/room' then raise exception 'room override ignored'; end if;
 raise notice 'ok feedback resolve states, facts and form link';
end $$;

-- The form link accepts only a bounded https URL with no userinfo, never a Case origin.
do $$ declare s uuid := pg_temp.room(interval '1 hour'); bad text;
begin
 foreach bad in array array['http://forms.example.org/x','https://user:pw@forms.example.org/x','https://case.iatrogenic.app/F/AAAAAA',
   'https://CASE.iatrogenic.app/x','https://x.case.iatrogenic.app/','javascript:alert(1)','https://forms.example.org/'||repeat('a',300),'https://forms.example.org/a b'] loop
  if pg_temp.err(format('update case_app.sessions set feedback_form_url=%L where id=%L', bad, s)) = '' then raise exception 'form link accepted: %', bad; end if;
 end loop;
 raise notice 'ok feedback form link validation';
end $$;

-- Upsert: one linked response per respondent, idempotent resend, revision check, strict shape.
do $$ declare s uuid := pg_temp.room(null); r jsonb; a jsonb := '{"rating_session":4,"rating_case":5,"takeaway":"  Re-examine early.  "}';
begin
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('a'), 'joined', a)) not like '%feedback_not_open%' then raise exception 'live room accepted feedback'; end if;
 update case_app.sessions set status='ended', ended_at=clock_timestamp()-interval '5 minutes' where id=s;
 r := case_api.feedback_upsert(s, pg_temp.who('a'), 'joined', a);
 if (r->>'revision')::int <> 1 then raise exception 'first send revision %', r; end if;
 if (select takeaway from case_app.session_feedback where session_id=s) <> 'Re-examine early.' then raise exception 'text not trimmed'; end if;
 r := case_api.feedback_upsert(s, pg_temp.who('a'), 'joined', a);
 if (r->>'revision')::int <> 1 then raise exception 'identical resend changed revision %', r; end if;
 r := case_api.feedback_upsert(s, pg_temp.who('a'), 'joined', '{"rating_session":3,"improve":"More imaging.","improve_about":"case"}', 1);
 if (r->>'revision')::int <> 2 or (select count(*) from case_app.session_feedback where session_id=s) <> 1 then raise exception 'edit did not replace %', r; end if;
 if (select rating_case from case_app.session_feedback where session_id=s) is not null then raise exception 'edit kept an omitted answer'; end if;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L,1)', s, pg_temp.who('a'), 'joined', '{"rating_app":2}')) not like '%feedback_conflict%' then raise exception 'stale revision accepted'; end if;
 r := case_api.feedback_mine(s, pg_temp.who('a'));
 if r->'answers' <> '{"rating_session":3,"improve":"More imaging.","improve_about":"case"}'::jsonb or (r->>'revision')::int <> 2 then raise exception 'mine wrong %', r; end if;
 if case_api.feedback_mine(s, pg_temp.who('b')) is not null then raise exception 'another respondent read a response'; end if;
 declare bad jsonb; begin
  foreach bad in array array['{}','{"rating_session":null}','{"rating_session":6}','{"rating_session":"4"}','{"rating_session":2.5}',
    '{"improve":"x"}','{"improve_about":"case"}','{"improve":"x","improve_about":"room"}','{"takeaway":"   "}','{"takeaway":7}',
    '{"name":"Robin","rating_app":3}']::jsonb[]||jsonb_build_object('takeaway',repeat('x',281)) loop
   if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('c'), 'joined', bad)) not like '%invalid_feedback%' then raise exception 'shape accepted: %', bad; end if;
  end loop; end;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('c'), 'phone', '{"rating_app":3}')) not like '%invalid_feedback%' then raise exception 'unknown source accepted'; end if;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, '\x00'::bytea, 'qr', '{"rating_app":3}')) = '' then raise exception 'short respondent hash accepted'; end if;
 raise notice 'ok feedback upsert, resend, revision and shape';
end $$;

-- Caps: 20 edits per response; 200 QR-path responses per room, joined phones unaffected.
do $$ declare s uuid := pg_temp.room(interval '10 minutes');
begin
 for i in 1..21 loop perform case_api.feedback_upsert(s, pg_temp.who('edit'), 'joined', jsonb_build_object('rating_session', 1 + i % 5)); end loop;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('edit'), 'joined', '{"rating_app":1}')) not like '%feedback_edit_cap%' then raise exception 'edit cap missing'; end if;
 for i in 1..200 loop perform case_api.feedback_upsert(s, pg_temp.who('qr'||i), 'qr', '{"rating_app":4}'); end loop;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('qr201'), 'qr', '{"rating_app":4}')) not like '%feedback_qr_cap%' then raise exception 'qr cap missing'; end if;
 perform case_api.feedback_upsert(s, pg_temp.who('qr7'), 'qr', '{"rating_app":5}');
 perform case_api.feedback_upsert(s, pg_temp.who('joined-late'), 'joined', '{"rating_app":5}');
 raise notice 'ok feedback edit and QR caps';
end $$;

-- The window closes at the personal cutoff even before the purge runs.
do $$ declare s uuid := pg_temp.room(interval '25 hours');
begin
 if case_api.feedback_resolve(pg_temp.code(s))->>'state' <> 'closed' then raise exception 'past cutoff not closed'; end if;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('late'), 'joined', '{"rating_app":3}')) not like '%feedback_closed%' then raise exception 'late feedback accepted'; end if;
 if case_api.feedback_mine(s, pg_temp.who('late')) is not null then raise exception 'mine open after cutoff'; end if;
 raise notice 'ok feedback window closes at the cutoff';
end $$;

-- The fold: ratings become tallies, comments lose every link, linked rows go, the code stays reserved; replay-safe.
do $$ declare s uuid := pg_temp.room(interval '23 hours 50 minutes'); keep uuid := pg_temp.room(interval '1 hour'); c text;
begin
 perform case_api.feedback_upsert(s, pg_temp.who('1'), 'joined', '{"rating_session":5,"rating_case":4,"takeaway":"Take one."}');
 perform case_api.feedback_upsert(s, pg_temp.who('2'), 'joined', '{"rating_session":5,"improve":"Fix the app.","improve_about":"app"}');
 perform case_api.feedback_upsert(s, pg_temp.who('3'), 'qr', '{"rating_case":2,"takeaway":"Take two.","improve":"Longer.","improve_about":"session"}');
 perform case_api.feedback_upsert(keep, pg_temp.who('1'), 'joined', '{"rating_session":1}');
 update case_app.sessions set ended_at=clock_timestamp()-interval '25 hours' where id=s;
 perform case_api.purge_expired_participant_data();
 if exists(select 1 from case_app.session_feedback where session_id=s) then raise exception 'linked feedback survived the fold'; end if;
 if (select feedback_closed_at from case_app.sessions where id=s) is null then raise exception 'fold not stamped'; end if;
 if (select jsonb_object_agg(question||value, n) from case_app.session_feedback_tallies where session_id=s) <> '{"session5":2,"case4":1,"case2":1}'::jsonb then
  raise exception 'tallies wrong'; end if;
 if (select (joined,qr) from case_app.session_feedback_totals where session_id=s) <> (2,1) then raise exception 'totals wrong'; end if;
 if (select count(*) from case_app.session_feedback_comments where session_id=s) <> 4
    or not exists(select 1 from case_app.session_feedback_comments where session_id=s and kind='improve' and about='app' and body='Fix the app.')
    or not exists(select 1 from case_app.session_feedback_comments where session_id=s and kind='takeaway' and about='session' and body='Take two.') then
  raise exception 'comments wrong'; end if;
 if exists(select 1 from information_schema.columns where table_schema='case_app' and table_name in ('session_feedback_comments','session_feedback_tallies','session_feedback_totals')
    and column_name ~ '(respondent|participant|token|rating|created|updated|source)') then raise exception 'long-term feedback keeps a link column'; end if;
 if (select count(*) from case_app.session_feedback where session_id=keep) <> 1 or (select feedback_closed_at from case_app.sessions where id=keep) is not null then
  raise exception 'fold touched an open room'; end if;
 perform case_api.purge_expired_participant_data();
 if (select sum(n) from case_app.session_feedback_tallies where session_id=s) <> 4 or (select count(*) from case_app.session_feedback_comments where session_id=s) <> 4 then
  raise exception 'replayed fold changed counts'; end if;
 if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('1'), 'joined', '{"rating_app":3}')) not like '%feedback_closed%' then raise exception 'write after fold'; end if;
 c := pg_temp.code(s);
 if c is null or case_api.feedback_resolve(c)->>'state' <> 'closed' then raise exception 'closed code no longer resolves'; end if;
 if case_api.session_feedback_code(s) is not null then raise exception 'a closed room still hands out its code'; end if;
 raise notice 'ok feedback fold, unlinking and replay';
end $$;

-- A room purged straight from an archive batch still folds on the next scheduled run.
do $$ declare s uuid := pg_temp.room(null); t timestamptz := clock_timestamp()-interval '23 hours';
begin
 update case_app.sessions set created_at=clock_timestamp()-interval '2 days', started_at=clock_timestamp()-interval '2 days' where id=s;
 perform case_api.archive_session_batch(s, jsonb_build_object('ended_at',t,'personal_data_delete_at',t+interval '24 hours'));
 perform case_api.feedback_upsert(s, pg_temp.who('x'), 'joined', '{"rating_app":4}');
 -- A later batch lowers the deadline into the past: SQL purges personal rows at once, without the scheduled job.
 perform case_api.archive_session_batch(s, jsonb_build_object('ended_at',t,'personal_data_delete_at',clock_timestamp()-interval '1 minute'));
 if (select retention_purged_at from case_app.sessions where id=s) is null then raise exception 'fixture: archive path did not purge'; end if;
 perform case_api.purge_expired_participant_data();
 if exists(select 1 from case_app.session_feedback where session_id=s) or (select sum(n) from case_app.session_feedback_tallies where session_id=s) <> 1 then
  raise exception 'archive-path purge skipped the fold'; end if;
 raise notice 'ok feedback fold after an archive-path purge';
end $$;

-- Service role only; tables have no direct grants; definer functions pin search_path.
do $$ declare f regprocedure; t text;
begin
 foreach f in array array['case_api.feedback_resolve(text)'::regprocedure,'case_api.feedback_upsert(uuid,bytea,text,jsonb,integer)'::regprocedure,
   'case_api.feedback_mine(uuid,bytea)'::regprocedure] loop
  if has_function_privilege('anon',f,'execute') or has_function_privilege('authenticated',f,'execute') or not has_function_privilege('service_role',f,'execute') then
   raise exception 'wrong execute grants on %', f; end if;
  if not (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid=f) then raise exception '% not a pinned definer', f; end if;
 end loop;
 foreach t in array array['session_feedback','session_feedback_tallies','session_feedback_totals','session_feedback_comments'] loop
  if has_table_privilege('service_role','case_app.'||t,'select') or has_table_privilege('anon','case_app.'||t,'select') or has_table_privilege('authenticated','case_app.'||t,'select') then
   raise exception 'direct table access to %', t; end if;
  if not (select relrowsecurity from pg_class where oid=('case_app.'||t)::regclass) then raise exception 'RLS off on %', t; end if;
 end loop;
 raise notice 'ok feedback service-only access';
end $$;
rollback;
