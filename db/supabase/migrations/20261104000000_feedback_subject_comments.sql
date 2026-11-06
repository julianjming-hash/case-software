-- Participant feedback form 2 (room PDFs v2, Julian's ruling 2026-10-18): three 1–5 ratings (the session, the case, the app),
-- each with an optional comment, replace the single "One thing to improve" comment and its "about" toggle. Take home stays
-- the `takeaway` column. Expand-only and backward-compatible: form 1 answers (improve + improve_about) are still accepted,
-- so the shipped page keeps working until the new Worker and page deploy; apply this migration first. Comments fold at the
-- room's personal cutoff exactly as before: copied in random order with no link to a phone, a rating or each other
-- (hard rule 8). Service-role RPCs only.
begin;

-- ─── columns and constraints ────────────────────────────────────────────────────────────────────────────────────

alter table case_app.session_feedback
  add column comment_session text check (char_length(comment_session) between 1 and 280),
  add column comment_case    text check (char_length(comment_case) between 1 and 280),
  add column comment_app     text check (char_length(comment_app) between 1 and 280);

-- The M1 table checks were unnamed: drop each by its definition, then add named replacements that count the new columns.
do $$ declare c record;
begin
  for c in select conname, pg_get_constraintdef(oid) def from pg_constraint
            where conrelid = 'case_app.session_feedback'::regclass and contype = 'c' loop
    if c.def like '%form_version = 1%' or c.def like '%num_nonnulls%' then
      execute format('alter table case_app.session_feedback drop constraint %I', c.conname);
    end if;
  end loop;
  for c in select conname, pg_get_constraintdef(oid) def from pg_constraint
            where conrelid = 'case_app.session_feedback_comments'::regclass and contype = 'c' loop
    if c.def like '%takeaway%' or c.def like '%improve%' then execute format('alter table case_app.session_feedback_comments drop constraint %I', c.conname); end if;
  end loop;
end $$;
alter table case_app.session_feedback
  add constraint session_feedback_form_version_ok check (form_version in (1, 2)),
  add constraint session_feedback_not_empty check (num_nonnulls(rating_session, rating_case, rating_app, takeaway, improve,
    comment_session, comment_case, comment_app) > 0);
-- `comment` is a form 2 comment about its rating's subject; `improve` keeps form 1's comments; a take-away is about the session.
alter table case_app.session_feedback_comments
  add constraint session_feedback_comments_kind_ok check (kind in ('takeaway', 'improve', 'comment')),
  add constraint session_feedback_comments_about_ok check (kind <> 'takeaway' or about = 'session');

-- ─── answers ────────────────────────────────────────────────────────────────────────────────────────────────────

-- Validate and normalise one answer set; raises invalid_feedback. Omitted keys are cleared, never kept. Form 1's
-- improve/improve_about pair is still accepted; a set may not mix it with form 2's subject comments.
create or replace function case_app.feedback_answers(p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_key text; v_val jsonb; v_out jsonb := '{}'; v_text text;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'invalid_feedback: not an object' using errcode = '23514'; end if;
  for v_key, v_val in select key, value from jsonb_each(p) loop
    if v_key in ('rating_session', 'rating_case', 'rating_app') then
      if jsonb_typeof(v_val) = 'null' then continue; end if;
      if jsonb_typeof(v_val) <> 'number' or v_val::text !~ '^[1-5]$' then raise exception 'invalid_feedback: %', v_key using errcode = '23514'; end if;
      v_out := v_out || jsonb_build_object(v_key, v_val::text::smallint);
    elsif v_key in ('takeaway', 'improve', 'comment_session', 'comment_case', 'comment_app') then
      if jsonb_typeof(v_val) = 'null' then continue; end if;
      if jsonb_typeof(v_val) <> 'string' then raise exception 'invalid_feedback: %', v_key using errcode = '23514'; end if;
      v_text := btrim(v_val #>> '{}');
      if v_text = '' or char_length(v_text) > 280 or v_text ~ '[\x01-\x1f\x7f]' then raise exception 'invalid_feedback: %', v_key using errcode = '23514'; end if;
      v_out := v_out || jsonb_build_object(v_key, v_text);
    elsif v_key = 'improve_about' then
      if jsonb_typeof(v_val) = 'null' then continue; end if;
      if jsonb_typeof(v_val) <> 'string' or v_val #>> '{}' not in ('session', 'case', 'app') then raise exception 'invalid_feedback: improve_about' using errcode = '23514'; end if;
      v_out := v_out || jsonb_build_object(v_key, v_val #>> '{}');
    else
      raise exception 'invalid_feedback: unknown field' using errcode = '23514';
    end if;
  end loop;
  if (v_out ? 'improve') <> (v_out ? 'improve_about') then raise exception 'invalid_feedback: improve_about' using errcode = '23514'; end if;
  if v_out ? 'improve' and v_out ?| array['comment_session', 'comment_case', 'comment_app'] then
    raise exception 'invalid_feedback: mixed forms' using errcode = '23514'; end if;
  if v_out = '{}' then raise exception 'invalid_feedback: empty' using errcode = '23514'; end if;
  return v_out;
end;
$$;

create or replace function case_app.feedback_row_answers(f case_app.session_feedback) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('rating_session', f.rating_session, 'rating_case', f.rating_case,
    'rating_app', f.rating_app, 'takeaway', f.takeaway, 'improve', f.improve, 'improve_about', f.improve_about,
    'comment_session', f.comment_session, 'comment_case', f.comment_case, 'comment_app', f.comment_app))
$$;

-- Unchanged from 20261101000000 except the subject comments and the form version (2 unless form 1's pair is given).
create or replace function case_api.feedback_upsert(p_session_id uuid, p_respondent_sha256 bytea, p_source text, p_answers jsonb,
  p_expected_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; v_hash case_app.sha256 := p_respondent_sha256; v_answers jsonb; v_cutoff timestamptz;
  f case_app.session_feedback;
begin
  if p_source is null or p_source not in ('joined', 'qr') then raise exception 'invalid_feedback: source' using errcode = '23514'; end if;
  if v_hash is null then raise exception 'invalid_feedback: respondent' using errcode = '23514'; end if;
  v_answers := case_app.feedback_answers(p_answers);
  select id, status, ended_at, expires_at, personal_data_delete_at, retention_purged_at, feedback_closed_at into s
    from case_app.sessions where id = p_session_id for no key update;
  if not found then raise exception 'invalid_feedback: session' using errcode = '23514'; end if;
  v_cutoff := case_app.feedback_cutoff(s.personal_data_delete_at, s.ended_at, s.expires_at);
  if s.feedback_closed_at is not null or s.retention_purged_at is not null or v_cutoff <= clock_timestamp() then
    raise exception 'feedback_closed' using errcode = '23514'; end if;
  if s.ended_at is null and s.status in ('lobby', 'live') then raise exception 'feedback_not_open' using errcode = '23514'; end if;

  select * into f from case_app.session_feedback where session_id = p_session_id and respondent_sha256 = v_hash;
  if found then
    if case_app.feedback_row_answers(f) = v_answers then
      return jsonb_build_object('revision', f.revision, 'updated_at', f.updated_at, 'closes_at', v_cutoff);
    end if;
    if p_expected_revision is not null and p_expected_revision <> f.revision then raise exception 'feedback_conflict' using errcode = '23514'; end if;
    if f.revision >= 21 then raise exception 'feedback_edit_cap' using errcode = '23514'; end if;
    update case_app.session_feedback set
      form_version = case when v_answers ? 'improve' then 1 else 2 end,
      rating_session = (v_answers->>'rating_session')::smallint, rating_case = (v_answers->>'rating_case')::smallint,
      rating_app = (v_answers->>'rating_app')::smallint, takeaway = v_answers->>'takeaway', improve = v_answers->>'improve',
      improve_about = v_answers->>'improve_about', comment_session = v_answers->>'comment_session',
      comment_case = v_answers->>'comment_case', comment_app = v_answers->>'comment_app',
      revision = f.revision + 1, updated_at = clock_timestamp()
     where id = f.id returning * into f;
  else
    if p_source = 'qr' and (select count(*) from case_app.session_feedback where session_id = p_session_id and source = 'qr') >= 200 then
      raise exception 'feedback_qr_cap' using errcode = '23514'; end if;
    insert into case_app.session_feedback (session_id, form_version, source, respondent_sha256, rating_session, rating_case,
      rating_app, takeaway, improve, improve_about, comment_session, comment_case, comment_app, created_at, updated_at)
    values (p_session_id, case when v_answers ? 'improve' then 1 else 2 end, p_source, v_hash, (v_answers->>'rating_session')::smallint,
      (v_answers->>'rating_case')::smallint, (v_answers->>'rating_app')::smallint, v_answers->>'takeaway', v_answers->>'improve',
      v_answers->>'improve_about', v_answers->>'comment_session', v_answers->>'comment_case', v_answers->>'comment_app',
      clock_timestamp(), clock_timestamp())
    returning * into f;
  end if;
  return jsonb_build_object('revision', f.revision, 'updated_at', f.updated_at, 'closes_at', v_cutoff);
end;
$$;

-- ─── results: subject comments read as kind `comment` ───────────────────────────────────────────────────────────

create or replace function case_app.feedback_comment_rows(p_ids uuid[]) returns table(session_id uuid, kind text, about text, body text)
language sql stable set search_path = '' as $$
  select c.session_id, c.kind, c.about, c.body from case_app.session_feedback_comments c
    join case_app.sessions s on s.id = c.session_id
   where c.session_id = any (p_ids) and s.feedback_closed_at is not null
  union all
  select f.session_id, u.kind, u.about, u.body from case_app.session_feedback f
    join case_app.sessions s on s.id = f.session_id
    cross join lateral (values ('takeaway', 'session', f.takeaway), ('improve', f.improve_about, f.improve),
      ('comment', 'session', f.comment_session), ('comment', 'case', f.comment_case), ('comment', 'app', f.comment_app)) u(kind, about, body)
   where f.session_id = any (p_ids) and s.feedback_closed_at is null and u.body is not null
$$;

-- Unchanged from 20261102000000 except that the app scope reads app comments of both forms.
create or replace function case_api.admin_feedback_page(p_user_id uuid, p_filter jsonb, p_after integer, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_scope text; v_keys text[]; v_id uuid; v_version uuid; v_ids uuid[]; v_rows jsonb; v_more boolean;
begin
  perform case_app.authorize_admin(p_user_id, 'P-39', p_admin, p_admin_email);
  if jsonb_typeof(p_filter) is distinct from 'object' or p_after is null or p_after < 0 or p_after > 10000 or p_after % 20 <> 0 then
    raise exception 'invalid_feedback_filter' using errcode = '22023'; end if;
  v_scope := p_filter->>'scope';
  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_filter) k;
  if v_scope in ('session', 'case') and p_after <> 0 then raise exception 'invalid_feedback_filter' using errcode = '22023'; end if;
  if v_scope = 'session' and v_keys = array['scope', 'sessionId'] then
    begin v_id := (p_filter->>'sessionId')::uuid; exception when others then raise exception 'invalid_feedback_filter' using errcode = '22023'; end;
    if not exists (select 1 from case_app.sessions where id = v_id) then raise exception 'session_not_found' using errcode = 'P0002'; end if;
    return jsonb_build_object('scope', 'session', 'next', null, 'result', case_app.feedback_session_body(v_id));
  elsif v_scope = 'case' and v_keys = array['caseId', 'scope', 'versionNo'] then
    begin
      select v.id into v_version from case_app.case_versions v
       where v.case_id = (p_filter->>'caseId')::uuid and v.version_no = (p_filter->>'versionNo')::integer;
    exception when others then raise exception 'invalid_feedback_filter' using errcode = '22023'; end;
    if v_version is null then raise exception 'version_not_found' using errcode = 'P0002'; end if;
    return jsonb_build_object('scope', 'case', 'next', null, 'result', case_app.feedback_case_body(v_version));
  elsif v_scope = 'rooms' and v_keys = array['scope'] then
    select coalesce(jsonb_agg(x.row order by x.created_at desc, x.id desc), '[]'::jsonb), count(*) > 20 into v_rows, v_more from (
      select s.id, s.created_at, jsonb_build_object('sessionId', s.id, 'caseId', v.case_id, 'versionNo', v.version_no,
        'title', left(coalesce(nullif(v.document->>'title', ''), c.title), 200), 'date', case_app.feedback_session_date(s),
        'responses', (case_app.feedback_responses(array[s.id])->>'total')::bigint) as row
        from case_app.sessions s join case_app.case_versions v on v.id = s.case_version_id join case_app.cases c on c.id = v.case_id
       where case_app.feedback_room_has_responses(s.id)
       order by s.created_at desc, s.id desc offset p_after limit 21) x;
    if v_more then v_rows := v_rows - 20; end if;
    return jsonb_build_object('scope', 'rooms', 'next', case when v_more then p_after + 20 end, 'result', jsonb_build_object('rooms', v_rows));
  elsif v_scope = 'app' and v_keys = array['scope'] then
    select coalesce(array_agg(s.id), '{}') into v_ids from case_app.sessions s where case_app.feedback_room_has_responses(s.id);
    select coalesce(jsonb_agg(x.c order by x.d desc, x.session_id desc, x.body collate "C"), '[]'::jsonb), count(*) > 20 into v_rows, v_more from (
      select r.session_id, r.body, case_app.feedback_session_date(s) as d,
             case_app.feedback_comment_json(r.kind, r.about, r.body) || jsonb_build_object('date', case_app.feedback_session_date(s)) as c
        from case_app.feedback_comment_rows(v_ids) r join case_app.sessions s on s.id = r.session_id
       where r.kind in ('improve', 'comment') and r.about = 'app'
       order by d desc, r.session_id desc, r.body collate "C" offset p_after limit 21) x;
    if v_more then v_rows := v_rows - 20; end if;
    return jsonb_build_object('scope', 'app', 'next', case when v_more then p_after + 20 end, 'result', jsonb_build_object(
      'responses', case_app.feedback_responses(v_ids),
      'ratings', jsonb_build_object('app', case_app.feedback_distribution(v_ids, 'app')),
      'months', coalesce((select jsonb_agg(case_app.feedback_distribution(m.ids, 'app') || jsonb_build_object('month', m.month) order by m.month desc)
        from (select to_char(coalesce(s.ended_at, s.started_at, s.created_at) at time zone 'UTC', 'YYYY-MM') as month, array_agg(s.id) as ids
                from case_app.sessions s where s.id = any (v_ids) group by 1 order by 1 desc limit 12) m), '[]'::jsonb),
      'comments', v_rows));
  end if;
  raise exception 'invalid_feedback_filter' using errcode = '22023';
end;
$$;

-- ─── the purge: the fold copies subject comments too ────────────────────────────────────────────────────────────

-- Unchanged from 20261101000000 except the fold's comment copy, which adds form 2's three subject comments.
create or replace function case_api.purge_expired_participant_data(p_retention interval default interval '24 hours')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_total integer:=0; v_batch integer;
begin
 if p_retention is null or p_retention<interval '0 seconds' then raise exception 'invalid_retention' using errcode='23514'; end if;
 loop
   with due as (select id from case_app.sessions where status in ('lobby','live') and expires_at<=clock_timestamp()
     order by expires_at,id limit 200 for update skip locked), done as (
    update case_app.sessions s set status='expired',ended_at=coalesce(ended_at,expires_at),
      personal_data_delete_at=least(personal_data_delete_at,ended_at+interval '24 hours',expires_at+interval '24 hours')
      from due where s.id=due.id returning 1)
   select count(*) into v_batch from done;
   exit when v_batch<200;
 end loop;
 loop
  with due as (
   select id from case_app.sessions where retention_purged_at is null
    and least(personal_data_delete_at,ended_at+least(p_retention,interval '24 hours'),expires_at+interval '24 hours')<=clock_timestamp()
    order by least(personal_data_delete_at,ended_at+least(p_retention,interval '24 hours'),expires_at+interval '24 hours'),id
    limit 200 for update skip locked
  ), del as (delete from case_app.session_responses r using due where r.session_id=due.id),
  anon as (update case_app.session_participants p set display_name=null,token_sha256=null,purged_at=coalesce(purged_at,clock_timestamp()) from due where p.session_id=due.id),
  done as (update case_app.sessions s set retention_purged_at=clock_timestamp() from due where s.id=due.id returning 1)
  select count(*) into v_batch from done;
  v_total:=v_total+v_batch;
  exit when v_batch<200;
 end loop;
 loop
  with due as (
   select id from case_app.sessions where feedback_closed_at is null
    and least(personal_data_delete_at,ended_at+least(p_retention,interval '24 hours'),expires_at+interval '24 hours')<=clock_timestamp()
    order by id limit 200 for update skip locked
  ), fb as (select f.* from case_app.session_feedback f join due on due.id=f.session_id),
  tal as (insert into case_app.session_feedback_tallies(session_id,question,value,n)
   select fb.session_id,x.q,x.v,count(*) from fb cross join lateral (values ('session',fb.rating_session),('case',fb.rating_case),('app',fb.rating_app)) x(q,v)
    where x.v is not null group by fb.session_id,x.q,x.v),
  tot as (insert into case_app.session_feedback_totals(session_id,joined,qr)
   select session_id,count(*) filter (where source='joined'),count(*) filter (where source='qr') from fb group by session_id),
  com as (insert into case_app.session_feedback_comments(session_id,kind,about,body)
   select u.session_id,u.kind,u.about,u.body from (
    select session_id,'takeaway' kind,'session' about,takeaway body from fb where takeaway is not null
    union all select session_id,'improve',improve_about,improve from fb where improve is not null
    union all select session_id,'comment','session',comment_session from fb where comment_session is not null
    union all select session_id,'comment','case',comment_case from fb where comment_case is not null
    union all select session_id,'comment','app',comment_app from fb where comment_app is not null) u order by random()),
  del as (delete from case_app.session_feedback f using due where f.session_id=due.id),
  done as (update case_app.sessions s set feedback_closed_at=clock_timestamp() from due where s.id=due.id returning 1)
  select count(*) into v_batch from done;
  exit when v_batch<200;
 end loop;
 insert into case_app.job_heartbeats(job,ran_at,rows) values('purge_participant_data',clock_timestamp(),v_total)
 on conflict(job) do update set ran_at=excluded.ran_at,rows=excluded.rows;
 return v_total;
end;
$$;
-- CREATE OR REPLACE preserves each function's existing execute ACLs (service role only).
commit;
