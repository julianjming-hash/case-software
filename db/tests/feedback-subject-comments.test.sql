-- Participant feedback form 2 (room PDFs v2, 20261104000000_feedback_subject_comments.sql): three ratings each with an
-- optional comment; form 1 answers still accepted; subject comments read as kind `comment` while open and fold with no
-- link at the cutoff (hard rule 8). Independent fixtures; rolled back.
\set QUIET on
begin;
insert into auth.users values ('0199f100-0000-7000-8000-000000000001');
insert into case_app.profiles(id,display_name) values ('0199f100-0000-7000-8000-000000000001','Form 2 fixture');
insert into case_app.workspaces(id,slug,name) values ('0199f100-0000-7000-8000-000000000002','feedback-form-two','Form 2 fixture');
insert into case_app.cases(id,workspace_id,owner_id,title)
values ('0199f100-0000-7000-8000-000000000003','0199f100-0000-7000-8000-000000000002','0199f100-0000-7000-8000-000000000001','Fixture');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
values ('0199f100-0000-7000-8000-000000000004','0199f100-0000-7000-8000-000000000003',1,1,'{"title":"Diving Deeper"}',sha256('form two'),'0199f100-0000-7000-8000-000000000001');
create temporary sequence form_two_join;
create function pg_temp.room() returns uuid language plpgsql as $$
declare s uuid := case_app.uuid_v7();
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,started_at,ended_at,status,expires_at)
 values(s,'0199f100-0000-7000-8000-000000000004','0199f100-0000-7000-8000-000000000002','0199f100-0000-7000-8000-000000000001',
  'T'||lpad(nextval('pg_temp.form_two_join')::text,5,'0'),clock_timestamp()-interval '3 hours',clock_timestamp()-interval '3 hours',
  clock_timestamp()-interval '1 hour','ended',clock_timestamp()+interval '9 hours');
 return s;
end $$;
create function pg_temp.who(p text) returns bytea language sql as $$ select sha256(convert_to('f2:'||p,'UTF8')) $$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlerrm; end $$;

-- Form 2: ratings with subject comments round-trip; a comment alone is a response; form version is 2.
do $$ declare s uuid := pg_temp.room(); r jsonb;
begin
 perform case_api.feedback_upsert(s, pg_temp.who('a'), 'joined', '{"rating_session":5,"comment_session":"  Great pacing. ","rating_case":4,"comment_case":"More imaging.","takeaway":"Re-examine the calf."}');
 r := case_api.feedback_mine(s, pg_temp.who('a'));
 if r->'answers' <> '{"rating_session":5,"comment_session":"Great pacing.","rating_case":4,"comment_case":"More imaging.","takeaway":"Re-examine the calf."}'::jsonb then
  raise exception 'form 2 answers did not round-trip: %', r; end if;
 if (select form_version from case_app.session_feedback where session_id=s) <> 2 then raise exception 'form version not 2'; end if;
 perform case_api.feedback_upsert(s, pg_temp.who('b'), 'qr', '{"comment_app":"Bigger buttons."}');
 raise notice 'ok form 2 answers, a comment alone counts';
end $$;

-- Strict shape: bounded text, no control characters, no mixing forms, form 1 still accepted as version 1.
do $$ declare s uuid := pg_temp.room(); bad text;
begin
 foreach bad in array array['{"comment_case":""}','{"comment_case":"   "}','{"comment_app":7}','{"comment_session":"'||repeat('x',281)||'"}',
   '{"comment_case":"a\u0007b"}','{"improve":"x","improve_about":"app","comment_app":"y"}','{"comment_other":"x"}'] loop
  if pg_temp.err(format('select case_api.feedback_upsert(%L,%L,%L,%L)', s, pg_temp.who('x'), 'joined', bad)) not like '%invalid_feedback%' then raise exception 'accepted: %', bad; end if;
 end loop;
 perform case_api.feedback_upsert(s, pg_temp.who('old'), 'joined', '{"rating_app":3,"improve":"Load faster.","improve_about":"app"}');
 if (select form_version from case_app.session_feedback where session_id=s and respondent_sha256=pg_temp.who('old')) <> 1 then raise exception 'form 1 not kept as version 1'; end if;
 raise notice 'ok form 2 shape refusals; form 1 still accepted';
end $$;

-- Results while open read subject comments as kind comment with their subject; the app scope reads both forms.
do $$ declare s uuid := pg_temp.room(); rows jsonb;
begin
 perform case_api.feedback_upsert(s, pg_temp.who('1'), 'joined', '{"comment_session":"S","comment_case":"C","comment_app":"A","takeaway":"T"}');
 perform case_api.feedback_upsert(s, pg_temp.who('2'), 'joined', '{"improve":"Old app","improve_about":"app"}');
 select jsonb_agg(jsonb_build_array(kind,about,body) order by kind,about,body) into rows from case_app.feedback_comment_rows(array[s]);
 if rows <> '[["comment","app","A"],["comment","case","C"],["comment","session","S"],["improve","app","Old app"],["takeaway","session","T"]]'::jsonb then
  raise exception 'open comment rows wrong: %', rows; end if;
 raise notice 'ok open comment rows';
end $$;

-- The fold copies subject comments with no link, deletes the linked rows, and replays without change.
do $$ declare s uuid := pg_temp.room(); k int;
begin
 perform case_api.feedback_upsert(s, pg_temp.who('p'), 'joined', '{"rating_case":2,"comment_case":"Too long.","comment_app":"Fine."}');
 update case_app.sessions set ended_at=clock_timestamp()-interval '25 hours', personal_data_delete_at=clock_timestamp()-interval '1 hour' where id=s;
 perform case_api.purge_expired_participant_data();
 if exists(select 1 from case_app.session_feedback where session_id=s) then raise exception 'linked row survived the fold'; end if;
 select count(*) into k from case_app.session_feedback_comments where session_id=s and kind='comment';
 if k <> 2 or not exists(select 1 from case_app.session_feedback_comments where session_id=s and kind='comment' and about='case' and body='Too long.') then
  raise exception 'subject comments not folded: %', k; end if;
 if (select t.n from case_app.session_feedback_tallies t where t.session_id=s and t.question='case' and t.value=2) <> 1 then raise exception 'rating not tallied'; end if;
 perform case_api.purge_expired_participant_data();
 if (select count(*) from case_app.session_feedback_comments where session_id=s) <> 2 then raise exception 'replayed fold changed comments'; end if;
 select count(*) into k from case_app.feedback_comment_rows(array[s]) where kind='comment';
 if k <> 2 then raise exception 'folded comments not readable: %', k; end if;
 raise notice 'ok form 2 fold, unlinking and replay';
end $$;

-- The comments table refuses a take-away about anything but the session, and an unknown kind.
do $$ declare s uuid := pg_temp.room();
begin
 if pg_temp.err(format($q$insert into case_app.session_feedback_comments(session_id,kind,about,body) values(%L,'takeaway','app','x')$q$, s)) = '' then raise exception 'take-away about app accepted'; end if;
 if pg_temp.err(format($q$insert into case_app.session_feedback_comments(session_id,kind,about,body) values(%L,'praise','app','x')$q$, s)) = '' then raise exception 'unknown kind accepted'; end if;
 raise notice 'ok comment kinds';
end $$;

-- Service role only, unchanged.
do $$ begin
 if has_function_privilege('anon','case_api.feedback_upsert(uuid,bytea,text,jsonb,integer)','execute') or has_function_privilege('authenticated','case_api.feedback_upsert(uuid,bytea,text,jsonb,integer)','execute')
    or has_function_privilege('anon','case_api.admin_feedback_page(uuid,jsonb,integer,boolean,text)','execute') or not has_function_privilege('service_role','case_api.feedback_upsert(uuid,bytea,text,jsonb,integer)','execute') then
  raise exception 'feedback grants changed'; end if;
 raise notice 'ok form 2 grants';
end $$;
rollback;
