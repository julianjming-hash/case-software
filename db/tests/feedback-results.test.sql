-- Participant feedback results (card 40 + feedback integration slice 9; docs/plans/PARTICIPANT-FEEDBACK.md §6–§8):
-- P-37 a room's feedback (starter rule), P-38 pooled case-content feedback per version (owners and authors), P-39 the
-- admin's app feedback and everything pooled. Each read returns the same shape before and after the purge fold, and
-- no read returns a respondent hash, a participant id, a name or a timestamp finer than the session's date.
\set QUIET on
begin;
insert into auth.users values ('0199f900-0000-7000-8000-000000000001'),('0199f900-0000-7000-8000-000000000002'),
 ('0199f900-0000-7000-8000-000000000003'),('0199f900-0000-7000-8000-000000000004'),('0199f900-0000-7000-8000-000000000005'),
 ('0199f900-0000-7000-8000-000000000006'),('0199f900-0000-7000-8000-000000000007'),('0199f900-0000-7000-8000-000000000008');
insert into case_app.profiles(id,display_name) values
 ('0199f900-0000-7000-8000-000000000001','FR owner'),('0199f900-0000-7000-8000-000000000002','FR author'),
 ('0199f900-0000-7000-8000-000000000003','FR starter'),('0199f900-0000-7000-8000-000000000004','FR other facilitator'),
 ('0199f900-0000-7000-8000-000000000005','FR outsider'),('0199f900-0000-7000-8000-000000000006','FR admin'),
 ('0199f900-0000-7000-8000-000000000007','FR disabled starter'),('0199f900-0000-7000-8000-000000000008','FR removed starter');
insert into case_app.workspaces(id,slug,name) values ('0199f900-0000-7000-8000-0000000000a1','feedback-results','FR home'),
 ('0199f900-0000-7000-8000-0000000000a2','feedback-results-other','FR other');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000001','owner'),
 ('0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000002','author'),
 ('0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000003','facilitator'),
 ('0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000004','facilitator'),
 ('0199f900-0000-7000-8000-0000000000a2','0199f900-0000-7000-8000-000000000005','owner'),
 ('0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000007','facilitator'),
 ('0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000008','facilitator');
insert into case_app.cases(id,workspace_id,owner_id,title) values
 ('0199f900-0000-7000-8000-0000000000c1','0199f900-0000-7000-8000-0000000000a1','0199f900-0000-7000-8000-000000000002','FR case');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values
 ('0199f900-0000-7000-8000-0000000000e1','0199f900-0000-7000-8000-0000000000c1',1,1,'{"title":"Diving Deeper"}',sha256('fr v1'),'0199f900-0000-7000-8000-000000000002'),
 ('0199f900-0000-7000-8000-0000000000e2','0199f900-0000-7000-8000-0000000000c1',2,1,'{"title":"Diving Deeper"}',sha256('fr v2'),'0199f900-0000-7000-8000-000000000002');
create temporary sequence feedback_results_join;
-- An ended room of a version, started by p_by, ended an hour ago (feedback open).
create function pg_temp.room(p_version uuid, p_by uuid) returns uuid language plpgsql as $$
declare s uuid := case_app.uuid_v7();
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,started_at,ended_at,status,expires_at)
 values(s,p_version,'0199f900-0000-7000-8000-0000000000a1',p_by,'R'||lpad(nextval('pg_temp.feedback_results_join')::text,5,'0'),
  clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour','ended',clock_timestamp()+interval '9 hours');
 return s;
end $$;
create function pg_temp.who(p text) returns bytea language sql as $$ select sha256(convert_to('fr:'||p,'UTF8')) $$;
-- The SQLSTATE and message a call raises, or '' when it succeeds.
create function pg_temp.state(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
-- Fail unless the call raises exactly this SQLSTATE (an unexpected success returns '' and fails too).
create function pg_temp.refuses(p_label text, p_sql text, p_state text default '42501') returns void language plpgsql as $$
declare v text := pg_temp.state(p_sql);
begin if split_part(v, ' ', 1) is distinct from p_state then raise exception '% expected % got %', p_label, p_state, coalesce(nullif(v,''),'success'); end if; end $$;
create function pg_temp.passes(p_label text, p_sql text) returns void language plpgsql as $$
declare v text := pg_temp.state(p_sql);
begin if v is distinct from '' then raise exception '% expected success got %', p_label, v; end if; end $$;
-- Every key at every depth, to prove no private field leaves a read.
create function pg_temp.keys(j jsonb) returns setof text language sql as $$
 with recursive walk(v) as (select j union all
  select x.value from walk, lateral (select value from jsonb_each(case when jsonb_typeof(walk.v)='object' then walk.v else '{}' end)
   union all select value from jsonb_array_elements(case when jsonb_typeof(walk.v)='array' then walk.v else '[]' end)) x)
 select key from walk, lateral jsonb_object_keys(case when jsonb_typeof(walk.v)='object' then walk.v else '{}' end) key $$;
create function pg_temp.private(p_label text, j jsonb) returns void language plpgsql as $$
declare leak text;
begin
 select string_agg(k, ',') into leak from pg_temp.keys(j) k where k ~* 'respondent|participant|hash|sha|token|name|created|updated|revision|source';
 if leak is not null then raise exception '% returned a private key: %', p_label, leak; end if;
 -- No respondent hash, as hex or bytea text, and no timestamp finer than a date.
 if exists(select 1 from case_app.session_feedback f where position(encode(f.respondent_sha256,'hex') in j::text) > 0)
    or j::text ~ '\\x[0-9a-f]{64}' or j::text ~ '[0-9a-f]{64}' then raise exception '% returned a respondent hash', p_label; end if;
 if j::text ~ '\d{4}-\d\d-\d\d[T ]\d\d:\d\d' then raise exception '% returned a timestamp finer than the date: %', p_label, j; end if;
end $$;
create temp table fr(k text primary key, id uuid);
insert into fr values ('room', pg_temp.room('0199f900-0000-7000-8000-0000000000e1','0199f900-0000-7000-8000-000000000003')),
 ('second', pg_temp.room('0199f900-0000-7000-8000-0000000000e1','0199f900-0000-7000-8000-000000000001')),
 ('other_version', pg_temp.room('0199f900-0000-7000-8000-0000000000e2','0199f900-0000-7000-8000-000000000003')),
 ('silent', pg_temp.room('0199f900-0000-7000-8000-0000000000e1','0199f900-0000-7000-8000-000000000003')),
 ('disabled', pg_temp.room('0199f900-0000-7000-8000-0000000000e1','0199f900-0000-7000-8000-000000000007')),
 ('removed', pg_temp.room('0199f900-0000-7000-8000-0000000000e1','0199f900-0000-7000-8000-000000000008'));
create function pg_temp.id(p text) returns uuid language sql as $$ select id from fr where k=p $$;
update case_app.profiles set disabled_at=now() where id='0199f900-0000-7000-8000-000000000007';
delete from case_app.workspace_members where user_id='0199f900-0000-7000-8000-000000000008';
-- Four responses in the room: two joined phones, two QR browsers; one comment names a person (it stays: see the warning).
do $$ begin
 perform case_api.feedback_upsert(pg_temp.id('room'), pg_temp.who('a'), 'joined', '{"rating_session":5,"rating_case":4,"rating_app":3,"takeaway":"Call for help sooner.","improve":"More time on the ECG.","improve_about":"case"}');
 perform case_api.feedback_upsert(pg_temp.id('room'), pg_temp.who('b'), 'joined', '{"rating_session":4,"improve":"Phones were slow to load.","improve_about":"app"}');
 perform case_api.feedback_upsert(pg_temp.id('room'), pg_temp.who('c'), 'qr', '{"rating_case":2,"takeaway":"Dr Rivers explained it well."}');
 perform case_api.feedback_upsert(pg_temp.id('room'), pg_temp.who('d'), 'qr', '{"rating_app":5,"improve":"Shorter intro.","improve_about":"session"}');
 perform case_api.feedback_upsert(pg_temp.id('second'), pg_temp.who('e'), 'joined', '{"rating_case":5,"rating_session":1,"improve":"The ECG was hard to read.","improve_about":"case"}');
 perform case_api.feedback_upsert(pg_temp.id('other_version'), pg_temp.who('f'), 'joined', '{"rating_case":1,"takeaway":"Other version take-away."}');
end $$;

-- [P-37] a room's feedback: the starter (any workspace role), a deployment admin, or an owner under managers_see_records. Owners (policy off) and authors who did not start
-- the room, other facilitators, other workspaces, a disabled starter and a removed starter are refused.
do $$
declare q text := 'select case_api.session_feedback_summary(%L,%L,%L,%L)'; s uuid := pg_temp.id('room');
begin
 perform pg_temp.passes('P-37 starter', format(q,'0199f900-0000-7000-8000-000000000003',s,false,null));
 perform pg_temp.passes('P-37 owner who started a room', format(q,'0199f900-0000-7000-8000-000000000001',pg_temp.id('second'),false,null));
 perform pg_temp.passes('P-37 admin', format(q,'0199f900-0000-7000-8000-000000000006',s,true,'fr-admin@example.org'));
 -- CASE-337: an owner reads every room's feedback while managers_see_records is on (the default); off, only their own.
 perform pg_temp.passes('P-37 owner, not the starter, managers_see_records on', format(q,'0199f900-0000-7000-8000-000000000001',s,false,null));
 update case_app.workspace_policies set managers_see_records = false where workspace_id = (select workspace_id from case_app.sessions where id = s);
 perform pg_temp.refuses('P-37 owner, not the starter', format(q,'0199f900-0000-7000-8000-000000000001',s,false,null));
 update case_app.workspace_policies set managers_see_records = true where workspace_id = (select workspace_id from case_app.sessions where id = s);
 perform pg_temp.refuses('P-37 author, not the starter', format(q,'0199f900-0000-7000-8000-000000000002',s,false,null));
 perform pg_temp.refuses('P-37 another facilitator', format(q,'0199f900-0000-7000-8000-000000000004',s,false,null));
 perform pg_temp.refuses('P-37 another workspace', format(q,'0199f900-0000-7000-8000-000000000005',s,false,null));
 perform pg_temp.refuses('P-37 admin flag without email', format(q,'0199f900-0000-7000-8000-000000000006',s,true,null));
 perform pg_temp.refuses('P-37 the admin without the flag', format(q,'0199f900-0000-7000-8000-000000000006',s,false,null));
 perform pg_temp.refuses('P-37 disabled starter', format(q,'0199f900-0000-7000-8000-000000000007',pg_temp.id('disabled'),false,null));
 perform pg_temp.refuses('P-37 removed starter', format(q,'0199f900-0000-7000-8000-000000000008',pg_temp.id('removed'),false,null));
 perform pg_temp.refuses('P-37 signed out', format(q,null,s,false,null));
 perform pg_temp.refuses('P-37 unknown room', format(q,'0199f900-0000-7000-8000-000000000003',case_app.uuid_v7(),false,null), 'P0002');
 raise notice 'ok P-37 room feedback follows the starter rule';
end $$;

-- [P-38] pooled case-content feedback per version: the case's workspace owners and authors, and the admin. Facilitators
-- (even one who ran the room) and other workspaces are refused.
do $$
declare q text := 'select case_api.case_feedback_summary(%L,%L,%s,%L,%L)'; c uuid := '0199f900-0000-7000-8000-0000000000c1';
begin
 perform pg_temp.passes('P-38 owner', format(q,'0199f900-0000-7000-8000-000000000001',c,1,false,null));
 perform pg_temp.passes('P-38 author', format(q,'0199f900-0000-7000-8000-000000000002',c,1,false,null));
 perform pg_temp.passes('P-38 admin', format(q,'0199f900-0000-7000-8000-000000000006',c,1,true,'fr-admin@example.org'));
 perform pg_temp.refuses('P-38 starter facilitator', format(q,'0199f900-0000-7000-8000-000000000003',c,1,false,null));
 perform pg_temp.refuses('P-38 another workspace', format(q,'0199f900-0000-7000-8000-000000000005',c,1,false,null));
 perform pg_temp.refuses('P-38 admin flag without email', format(q,'0199f900-0000-7000-8000-000000000006',c,1,true,null));
 perform pg_temp.refuses('P-38 removed author', format(q,'0199f900-0000-7000-8000-000000000008',c,1,false,null));
 perform pg_temp.refuses('P-38 unknown version', format(q,'0199f900-0000-7000-8000-000000000001',c,9,false,null), 'P0002');
 raise notice 'ok P-38 pooled case feedback for owners and authors';
end $$;

-- [P-39] app feedback and everything pooled: the configured admin only; the filter is exact and the pages are 20 rows.
do $$
declare q text := 'select case_api.admin_feedback_page(%L,%L,%s,%L,%L)'; a uuid := '0199f900-0000-7000-8000-000000000006';
begin
 perform pg_temp.passes('P-39 admin, app', format(q,a,'{"scope":"app"}',0,true,'fr-admin@example.org'));
 perform pg_temp.passes('P-39 admin, rooms', format(q,a,'{"scope":"rooms"}',0,true,'fr-admin@example.org'));
 perform pg_temp.passes('P-39 admin, a room', format(q,a,jsonb_build_object('scope','session','sessionId',pg_temp.id('room')),0,true,'fr-admin@example.org'));
 perform pg_temp.passes('P-39 admin, a case', format(q,a,'{"scope":"case","caseId":"0199f900-0000-7000-8000-0000000000c1","versionNo":1}',0,true,'fr-admin@example.org'));
 perform pg_temp.refuses('P-39 owner', format(q,'0199f900-0000-7000-8000-000000000001','{"scope":"app"}',0,false,null));
 perform pg_temp.refuses('P-39 starter', format(q,'0199f900-0000-7000-8000-000000000003','{"scope":"app"}',0,false,null));
 perform pg_temp.refuses('P-39 admin flag without email', format(q,a,'{"scope":"app"}',0,true,null));
 perform pg_temp.refuses('P-39 the admin without the flag', format(q,a,'{"scope":"app"}',0,false,null));
 perform pg_temp.refuses('P-39 unknown scope', format(q,a,'{"scope":"everything"}',0,true,'fr-admin@example.org'), '22023');
 perform pg_temp.refuses('P-39 extra filter key', format(q,a,'{"scope":"app","sessionId":"x"}',0,true,'fr-admin@example.org'), '22023');
 perform pg_temp.refuses('P-39 cursor off a page', format(q,a,'{"scope":"app"}',7,true,'fr-admin@example.org'), '22023');
 perform pg_temp.refuses('P-39 cursor on a single result', format(q,a,jsonb_build_object('scope','session','sessionId',pg_temp.id('room')),20,true,'fr-admin@example.org'), '22023');
 perform pg_temp.refuses('P-39 unknown room', format(q,a,jsonb_build_object('scope','session','sessionId',case_app.uuid_v7()),0,true,'fr-admin@example.org'), 'P0002');
 raise notice 'ok P-39 admin feedback is admin only with an exact filter';
end $$;

-- Results: counts per value 1–5 with n, the joined/QR split, comments ordered with no link to a phone or a rating.
do $$
declare r jsonb := case_api.session_feedback_summary('0199f900-0000-7000-8000-000000000003',pg_temp.id('room'),false,null);
begin
 if r - 'session' - 'closed' is distinct from '{
   "responses":{"total":4,"joined":2,"qr":2},
   "ratings":{"session":{"counts":[0,0,0,1,1],"n":2},"case":{"counts":[0,1,0,1,0],"n":2},"app":{"counts":[0,0,1,0,1],"n":2}},
   "comments":[{"kind":"takeaway","about":"session","body":"Call for help sooner."},{"kind":"takeaway","about":"session","body":"Dr Rivers explained it well."},
    {"kind":"improve","about":"session","body":"Shorter intro."},{"kind":"improve","about":"case","body":"More time on the ECG."},
    {"kind":"improve","about":"app","body":"Phones were slow to load."}]}'::jsonb then raise exception 'room summary wrong: %', r; end if;
 if (r->'session') - 'date' is distinct from jsonb_build_object('id',pg_temp.id('room'),'workspaceId','0199f900-0000-7000-8000-0000000000a1','caseId','0199f900-0000-7000-8000-0000000000c1',
   'versionNo',1,'title','Diving Deeper','own',true) or r->'session'->>'date' !~ '^\d{4}-\d\d-\d\d$' or r->'closed' <> 'false' then
  raise exception 'room summary header wrong: %', r->'session'; end if;
 perform pg_temp.private('room summary', r);
 -- A room nobody answered reads as zeros, never as missing.
 r := case_api.session_feedback_summary('0199f900-0000-7000-8000-000000000003',pg_temp.id('silent'),false,null);
 if r->'responses' <> '{"total":0,"joined":0,"qr":0}' or r->'ratings'->'app' <> '{"counts":[0,0,0,0,0],"n":0}' or r->'comments' <> '[]' then
  raise exception 'silent room wrong: %', r; end if;
 raise notice 'ok room feedback counts, split and comments';
end $$;

-- Pooled per version: the case rating, room and response counts, take-aways and improvements about the case only.
do $$
declare r jsonb := case_api.case_feedback_summary('0199f900-0000-7000-8000-000000000002','0199f900-0000-7000-8000-0000000000c1',1,false,null);
begin
 if r->'case' is distinct from '{"id":"0199f900-0000-7000-8000-0000000000c1","workspaceId":"0199f900-0000-7000-8000-0000000000a1","versionNo":1,"title":"Diving Deeper"}'
    or r->'rooms' <> '2' or r->'responses' <> '{"total":5,"joined":3,"qr":2}' or r->'ratings' <> '{"case":{"counts":[0,1,0,1,1],"n":3}}'
    or r->'commentsTotal' <> '4' then raise exception 'case summary wrong: %', r; end if;
 if (select array_agg(c->>'body' order by c->>'body') from jsonb_array_elements(r->'comments') c)
    is distinct from array['Call for help sooner.','Dr Rivers explained it well.','More time on the ECG.','The ECG was hard to read.'] then
  raise exception 'case comments wrong (session or app improvements, or another version, leaked in): %', r->'comments'; end if;
 perform pg_temp.private('case summary', r);
 raise notice 'ok pooled case feedback per version';
end $$;

-- The admin's app view: app ratings over time and app comments only; the rooms list holds rooms with any feedback.
do $$
declare r jsonb := case_api.admin_feedback_page('0199f900-0000-7000-8000-000000000006','{"scope":"app"}',0,true,'fr-admin@example.org');
begin
 if r->>'scope' <> 'app' or r->'next' <> 'null' or r->'result'->'ratings' <> '{"app":{"counts":[0,0,1,0,1],"n":2}}'
    or (r->'result'->'responses'->>'total')::int < 6 or jsonb_array_length(r->'result'->'months') < 1
    or r->'result'->'months'->0->'n' <> '2' then raise exception 'admin app view wrong: %', r; end if;
 if exists(select 1 from jsonb_array_elements(r->'result'->'comments') c where c->>'about' <> 'app' or c->>'kind' <> 'improve')
    or not exists(select 1 from jsonb_array_elements(r->'result'->'comments') c where c->>'body' = 'Phones were slow to load.') then
  raise exception 'admin app comments wrong: %', r->'result'->'comments'; end if;
 perform pg_temp.private('admin app view', r);
 r := case_api.admin_feedback_page('0199f900-0000-7000-8000-000000000006','{"scope":"rooms"}',0,true,'fr-admin@example.org');
 if not exists(select 1 from jsonb_array_elements(r->'result'->'rooms') x where (x->>'sessionId')::uuid = pg_temp.id('room') and x->'responses' = '4')
    or exists(select 1 from jsonb_array_elements(r->'result'->'rooms') x where (x->>'sessionId')::uuid = pg_temp.id('silent')) then
  raise exception 'admin rooms list wrong: %', r; end if;
 perform pg_temp.private('admin rooms list', r);
 raise notice 'ok admin app feedback and rooms list';
end $$;

-- The fold changes nothing a reader sees but `closed`: the same shape and the same values, from tallies and unlinked comments.
-- Comments keep their text, names included (the fold cannot detect a name); every results view carries the warning
-- `Written by participants. Comments may contain names.` (src/shared/feedback-results.mjs, tests/feedback-results.test.mjs).
do $$
declare s uuid := pg_temp.id('room'); starter uuid := '0199f900-0000-7000-8000-000000000003';
 pre jsonb; post jsonb; pre_case jsonb; post_case jsonb; pre_app jsonb; post_app jsonb; pre_admin jsonb; post_admin jsonb;
begin
 pre := case_api.session_feedback_summary(starter,s,false,null);
 pre_case := case_api.case_feedback_summary('0199f900-0000-7000-8000-000000000001','0199f900-0000-7000-8000-0000000000c1',1,false,null);
 pre_app := case_api.admin_feedback_page('0199f900-0000-7000-8000-000000000006','{"scope":"app"}',0,true,'fr-admin@example.org');
 pre_admin := case_api.admin_feedback_page('0199f900-0000-7000-8000-000000000006',jsonb_build_object('scope','session','sessionId',s),0,true,'fr-admin@example.org');
 -- Reach both version-1 rooms' cutoffs without moving their end (the result carries the session's date).
 update case_app.sessions set personal_data_delete_at=clock_timestamp()-interval '1 second' where id in (s, pg_temp.id('second'));
 perform case_api.purge_expired_participant_data();
 if exists(select 1 from case_app.session_feedback where session_id in (s, pg_temp.id('second'))) then raise exception 'fold did not run'; end if;
 post := case_api.session_feedback_summary(starter,s,false,null);
 post_case := case_api.case_feedback_summary('0199f900-0000-7000-8000-000000000001','0199f900-0000-7000-8000-0000000000c1',1,false,null);
 post_app := case_api.admin_feedback_page('0199f900-0000-7000-8000-000000000006','{"scope":"app"}',0,true,'fr-admin@example.org');
 post_admin := case_api.admin_feedback_page('0199f900-0000-7000-8000-000000000006',jsonb_build_object('scope','session','sessionId',s),0,true,'fr-admin@example.org');
 if pre->'closed' <> 'false' or post->'closed' <> 'true' then raise exception 'closed state wrong: % then %', pre->'closed', post->'closed'; end if;
 if pre - 'closed' is distinct from post - 'closed' then raise exception 'room summary changed at the fold: % vs %', pre, post; end if;
 if pre_case is distinct from post_case then raise exception 'case summary changed at the fold: % vs %', pre_case, post_case; end if;
 if pre_app is distinct from post_app then raise exception 'admin app view changed at the fold: % vs %', pre_app, post_app; end if;
 if pre_admin #- '{result,closed}' is distinct from post_admin #- '{result,closed}' then raise exception 'admin room view changed at the fold'; end if;
 if not exists(select 1 from jsonb_array_elements(post->'comments') c where c->>'body' = 'Dr Rivers explained it well.') then
  raise exception 'a comment naming a person was dropped instead of shown with the warning'; end if;
 perform pg_temp.private('folded room summary', post);
 perform pg_temp.private('folded case summary', post_case);
 -- Replay-safe: a second purge changes nothing a reader sees.
 perform case_api.purge_expired_participant_data();
 if case_api.session_feedback_summary(starter,s,false,null) is distinct from post then raise exception 'replayed fold changed the summary'; end if;
 raise notice 'ok results keep their shape and values across the fold';
end $$;

-- Service role only (hard rule 5): no anon or authenticated execute on any results read.
do $$
declare f text;
begin
 foreach f in array array['case_api.session_feedback_summary(uuid,uuid,boolean,text)','case_api.case_feedback_summary(uuid,uuid,integer,boolean,text)',
   'case_api.admin_feedback_page(uuid,jsonb,integer,boolean,text)'] loop
  if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') or not has_function_privilege('service_role', f, 'execute') then
   raise exception 'results read grants wrong: %', f; end if;
 end loop;
 if has_table_privilege('service_role','case_app.session_feedback_comments','select') then raise exception 'comments table readable directly'; end if;
 raise notice 'ok results reads are service-role only';
end $$;
rollback;
