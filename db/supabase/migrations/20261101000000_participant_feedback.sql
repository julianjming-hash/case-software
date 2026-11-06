-- Participant feedback (CASE-284 working number; docs/plans/PARTICIPANT-FEEDBACK.md, Julian's rulings D1–D9, 2026-10-17).
-- Additive and backward-compatible: create_session keeps its signature, because an insert trigger mints the room's
-- feedback code. Linked responses live only until the room's personal cutoff; the scheduled purge then folds them
-- into rating tallies and unlinked comments. Service-role RPCs only.
begin;

-- ─── the room's feedback code and the optional external form link ───────────────────────────────────────────────

-- An https URL of at most 300 characters, with no userinfo and not on a Case origin (D3).
create function case_app.feedback_form_url_ok(p text) returns boolean language sql immutable set search_path = '' as $$
  select p is null or (
    char_length(p) <= 300
    and p ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[!-~]*)?$'
    and lower(substring(p from '^https://([A-Za-z0-9.-]+)')) !~ '(^|\.)case\.iatrogenic\.app$'
  )
$$;

alter table case_app.sessions
  add column feedback_code case_app.join_code,
  add column feedback_form_url text check (case_app.feedback_form_url_ok(feedback_form_url)),
  add column feedback_closed_at timestamptz;
-- Unique across every room ever, so an old link can only ever reach its own session (D8).
create unique index sessions_feedback_code_uq on case_app.sessions (feedback_code) where feedback_code is not null;

alter table case_app.case_groups
  add column feedback_form_url text check (case_app.feedback_form_url_ok(feedback_form_url));

-- Six Crockford characters from 48 random bits of gen_random_uuid() (bytes 0–5 carry no version or variant bits;
-- 256 is a multiple of 32, so each character is uniform).
create function case_app.new_feedback_code() returns text language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea; v_code text;
begin
  for attempt in 1..20 loop
    v_bytes := uuid_send(gen_random_uuid()); v_code := '';
    for i in 0..5 loop v_code := v_code || substr(v_alphabet, get_byte(v_bytes, i) % 32 + 1, 1); end loop;
    if not exists (select 1 from case_app.sessions where feedback_code = v_code) then return v_code; end if;
  end loop;
  raise exception 'feedback_code_exhausted' using errcode = '23505';
end;
$$;

create function case_app.sessions_mint_feedback_code() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.feedback_code is null then new.feedback_code := case_app.new_feedback_code(); end if;
  return new;
end;
$$;
create trigger sessions_mint_feedback_code before insert on case_app.sessions
  for each row execute function case_app.sessions_mint_feedback_code();

-- The room's personal cutoff, as purge_expired_participant_data computes it at the default 24 hours.
create function case_app.feedback_cutoff(p_delete_at timestamptz, p_ended_at timestamptz, p_expires_at timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
  select least(p_delete_at, p_ended_at + interval '24 hours', p_expires_at + interval '24 hours')
$$;

-- ─── linked responses (until the cutoff) and the long-term, unlinked record ─────────────────────────────────────

create table case_app.session_feedback (
  id                 uuid primary key default case_app.uuid_v7(),
  session_id         uuid not null references case_app.sessions (id) on delete cascade,
  form_version       smallint not null check (form_version = 1),
  source             text not null check (source in ('joined', 'qr')),
  respondent_sha256  case_app.sha256 not null,  -- the phone link; deleted by the fold at the cutoff
  rating_session     smallint check (rating_session between 1 and 5),
  rating_case        smallint check (rating_case between 1 and 5),
  rating_app         smallint check (rating_app between 1 and 5),
  takeaway           text check (char_length(takeaway) between 1 and 280),
  improve            text check (char_length(improve) between 1 and 280),
  improve_about      text check (improve_about in ('session', 'case', 'app')),
  revision           smallint not null default 1 check (revision between 1 and 21),  -- one send plus 20 edits
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (session_id, respondent_sha256),
  check ((improve is null) = (improve_about is null)),
  check (num_nonnulls(rating_session, rating_case, rating_app, takeaway, improve) > 0)
);

create table case_app.session_feedback_tallies (
  session_id  uuid not null references case_app.sessions (id) on delete cascade,
  question    text not null check (question in ('session', 'case', 'app')),
  value       smallint not null check (value between 1 and 5),
  n           integer not null check (n > 0),
  primary key (session_id, question, value)
);

create table case_app.session_feedback_totals (
  session_id  uuid primary key references case_app.sessions (id) on delete cascade,
  joined      integer not null check (joined >= 0),
  qr          integer not null check (qr >= 0)
);

-- Written by participants; may contain names. No link to a phone, a rating or another comment.
create table case_app.session_feedback_comments (
  id          uuid primary key default case_app.uuid_v7(),
  session_id  uuid not null references case_app.sessions (id) on delete cascade,
  kind        text not null check (kind in ('takeaway', 'improve')),
  about       text not null check (about in ('session', 'case', 'app')),
  body        text not null check (char_length(body) between 1 and 280),
  check (kind = 'improve' or about = 'session')
);
create index session_feedback_comments_session_idx on case_app.session_feedback_comments (session_id);

alter table case_app.session_feedback enable row level security;
alter table case_app.session_feedback_tallies enable row level security;
alter table case_app.session_feedback_totals enable row level security;
alter table case_app.session_feedback_comments enable row level security;
revoke all on case_app.session_feedback, case_app.session_feedback_tallies, case_app.session_feedback_totals,
  case_app.session_feedback_comments from public, anon, authenticated, service_role;

-- ─── service RPCs ───────────────────────────────────────────────────────────────────────────────────────────────

-- Public facts for the feedback page. The code is not a credential: it reveals only what the room was shown.
create function case_api.feedback_resolve(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_code text := upper(btrim(coalesce(p_code, ''))); r record; v_cutoff timestamptz; v_objectives jsonb;
begin
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{6}$' then return null; end if;
  select s.id, s.status, s.started_at, s.ended_at, s.expires_at, s.personal_data_delete_at, s.retention_purged_at,
         s.feedback_closed_at, coalesce(s.feedback_form_url, g.feedback_form_url) form_url, v.version_no, v.document
    into r
    from case_app.sessions s
    join case_app.case_versions v on v.id = s.case_version_id
    join case_app.cases c on c.id = v.case_id
    left join case_app.case_groups g on g.id = c.group_id and g.archived_at is null
   where s.feedback_code = v_code::case_app.join_code;
  if not found then return null; end if;
  v_cutoff := case_app.feedback_cutoff(r.personal_data_delete_at, r.ended_at, r.expires_at);
  select coalesce(jsonb_agg(o.value order by o.ordinality), '[]'::jsonb) into v_objectives
    from jsonb_array_elements(case when jsonb_typeof(r.document->'learning_objectives') = 'array'
                                   then r.document->'learning_objectives' else '[]'::jsonb end) with ordinality o
   where jsonb_typeof(o.value) = 'string' and o.ordinality <= 12;
  -- Before End the code reveals nothing but its state: no title, objectives or session id (red-team R7, 2026-10-17).
  if r.feedback_closed_at is null and r.retention_purged_at is null and v_cutoff > clock_timestamp()
     and r.ended_at is null and r.status in ('lobby', 'live') then return jsonb_build_object('state', 'not_ended'); end if;
  return jsonb_build_object(
    'session_id', r.id,
    'state', case when r.feedback_closed_at is not null or r.retention_purged_at is not null or v_cutoff <= clock_timestamp() then 'closed'
                  else 'open' end,
    'title', left(coalesce(r.document->>'title', ''), 200),
    'version_no', r.version_no,
    'audience', left(r.document->>'audience', 200),
    'started_at', r.started_at, 'ended_at', r.ended_at, 'closes_at', v_cutoff,
    'objectives', v_objectives,
    'form_url', r.form_url);
end;
$$;

-- The room's feedback code, read by the Worker right after create_session so the room Durable Object can carry it
-- into its ended projections with no database round trip at End (red-team R1, 2026-10-17). Null once closed.
create function case_api.session_feedback_code(p_session_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code', s.feedback_code::text) from case_app.sessions s
   where s.id = p_session_id and s.feedback_closed_at is null and s.feedback_code is not null
$$;

-- Validate and normalise one answer set; raises invalid_feedback. Omitted keys are cleared, never kept.
create function case_app.feedback_answers(p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_key text; v_val jsonb; v_out jsonb := '{}'; v_text text;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'invalid_feedback: not an object' using errcode = '23514'; end if;
  for v_key, v_val in select key, value from jsonb_each(p) loop
    if v_key in ('rating_session', 'rating_case', 'rating_app') then
      if jsonb_typeof(v_val) = 'null' then continue; end if;
      if jsonb_typeof(v_val) <> 'number' or v_val::text !~ '^[1-5]$' then raise exception 'invalid_feedback: %', v_key using errcode = '23514'; end if;
      v_out := v_out || jsonb_build_object(v_key, v_val::text::smallint);
    elsif v_key in ('takeaway', 'improve') then
      if jsonb_typeof(v_val) = 'null' then continue; end if;
      if jsonb_typeof(v_val) <> 'string' then raise exception 'invalid_feedback: %', v_key using errcode = '23514'; end if;
      v_text := btrim(v_val #>> '{}');
      if v_text = '' or char_length(v_text) > 280 or v_text ~ '[\x01-\x1f\x7f]' then raise exception 'invalid_feedback: %', v_key using errcode = '23514'; end if;
      v_out := v_out || jsonb_build_object(v_key, v_text);
    elsif v_key = 'improve_about' then
      if jsonb_typeof(v_val) = 'null' then continue; end if;
      if v_val #>> '{}' not in ('session', 'case', 'app') or jsonb_typeof(v_val) <> 'string' then raise exception 'invalid_feedback: improve_about' using errcode = '23514'; end if;
      v_out := v_out || jsonb_build_object(v_key, v_val #>> '{}');
    else
      raise exception 'invalid_feedback: unknown field' using errcode = '23514';
    end if;
  end loop;
  if (v_out ? 'improve') <> (v_out ? 'improve_about') then raise exception 'invalid_feedback: improve_about' using errcode = '23514'; end if;
  if v_out = '{}' then raise exception 'invalid_feedback: empty' using errcode = '23514'; end if;
  return v_out;
end;
$$;

create function case_app.feedback_row_answers(f case_app.session_feedback) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('rating_session', f.rating_session, 'rating_case', f.rating_case,
    'rating_app', f.rating_app, 'takeaway', f.takeaway, 'improve', f.improve, 'improve_about', f.improve_about))
$$;

-- Create or edit one respondent's response. p_respondent_sha256 is SHA-256 of "joined:<session>:<participant>" (the room
-- verified the participant credential) or of "qr:<key>" (a random key held in that browser); the Worker computes it.
-- An identical resend is a no-op; p_expected_revision, when given, must match the stored revision.
create function case_api.feedback_upsert(p_session_id uuid, p_respondent_sha256 bytea, p_source text, p_answers jsonb,
  p_expected_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; v_hash case_app.sha256 := p_respondent_sha256; v_answers jsonb; v_cutoff timestamptz;
  f case_app.session_feedback;
begin
  if p_source is null or p_source not in ('joined', 'qr') then raise exception 'invalid_feedback: source' using errcode = '23514'; end if;
  if v_hash is null then raise exception 'invalid_feedback: respondent' using errcode = '23514'; end if;
  v_answers := case_app.feedback_answers(p_answers);
  -- Serialise writes per room (the QR cap) and against the fold, which skips a locked room until its next run.
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
      rating_session = (v_answers->>'rating_session')::smallint, rating_case = (v_answers->>'rating_case')::smallint,
      rating_app = (v_answers->>'rating_app')::smallint, takeaway = v_answers->>'takeaway', improve = v_answers->>'improve',
      improve_about = v_answers->>'improve_about', revision = f.revision + 1, updated_at = clock_timestamp()
     where id = f.id returning * into f;
  else
    if p_source = 'qr' and (select count(*) from case_app.session_feedback where session_id = p_session_id and source = 'qr') >= 200 then
      raise exception 'feedback_qr_cap' using errcode = '23514'; end if;
    insert into case_app.session_feedback (session_id, form_version, source, respondent_sha256, rating_session, rating_case,
      rating_app, takeaway, improve, improve_about, created_at, updated_at)
    values (p_session_id, 1, p_source, v_hash, (v_answers->>'rating_session')::smallint, (v_answers->>'rating_case')::smallint,
      (v_answers->>'rating_app')::smallint, v_answers->>'takeaway', v_answers->>'improve', v_answers->>'improve_about',
      clock_timestamp(), clock_timestamp())
    returning * into f;
  end if;
  return jsonb_build_object('revision', f.revision, 'updated_at', f.updated_at, 'closes_at', v_cutoff);
end;
$$;

-- The respondent's own saved answers, while the window is open; null otherwise.
create function case_api.feedback_mine(p_session_id uuid, p_respondent_sha256 bytea) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s record; f case_app.session_feedback; v_cutoff timestamptz;
begin
  select ended_at, expires_at, personal_data_delete_at, retention_purged_at, feedback_closed_at into s
    from case_app.sessions where id = p_session_id;
  if not found then return null; end if;
  v_cutoff := case_app.feedback_cutoff(s.personal_data_delete_at, s.ended_at, s.expires_at);
  if s.feedback_closed_at is not null or s.retention_purged_at is not null or v_cutoff <= clock_timestamp() then return null; end if;
  select * into f from case_app.session_feedback where session_id = p_session_id and respondent_sha256 = p_respondent_sha256;
  if not found then return null; end if;
  return jsonb_build_object('answers', case_app.feedback_row_answers(f), 'revision', f.revision, 'closes_at', v_cutoff);
end;
$$;

-- ─── the purge: fold each room's feedback at its cutoff ─────────────────────────────────────────────────────────

-- Unchanged from 20261002030000 except the third loop. The fold keys on feedback_closed_at, not retention_purged_at,
-- because an archive batch can purge personal rows immediately without this job.
create or replace function case_api.purge_expired_participant_data(p_retention interval default interval '24 hours')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_total integer:=0; v_batch integer;
begin
 if p_retention is null or p_retention<interval '0 seconds' then raise exception 'invalid_retention' using errcode='23514'; end if;
 -- Bound expiry maintenance independently of the ordered personal-data purge.
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
 -- Feedback fold (CASE-284): ratings become tallies, comments are copied in random order with no link, linked rows go.
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
    union all select session_id,'improve',improve_about,improve from fb where improve is not null) u order by random()),
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
-- CREATE OR REPLACE preserves the original service-role-only execute ACLs.

-- ─── existing rooms ─────────────────────────────────────────────────────────────────────────────────────────────

-- Rooms already past their cutoff are closed without feedback; rooms still inside it get a code.
update case_app.sessions set feedback_closed_at = clock_timestamp()
 where feedback_closed_at is null and case_app.feedback_cutoff(personal_data_delete_at, ended_at, expires_at) <= clock_timestamp();
-- One row at a time: a single UPDATE cannot see codes it minted earlier in the same statement (red-team R12).
do $$ declare v_id uuid;
begin
  for v_id in select id from case_app.sessions where feedback_code is null and feedback_closed_at is null order by id loop
    update case_app.sessions set feedback_code = case_app.new_feedback_code() where id = v_id;
  end loop;
end $$;

revoke all on function case_app.feedback_form_url_ok(text), case_app.new_feedback_code(), case_app.sessions_mint_feedback_code(),
  case_app.feedback_cutoff(timestamptz, timestamptz, timestamptz), case_app.feedback_answers(jsonb),
  case_app.feedback_row_answers(case_app.session_feedback) from public, anon, authenticated;
revoke all on function case_api.feedback_resolve(text), case_api.feedback_upsert(uuid, bytea, text, jsonb, integer),
  case_api.feedback_mine(uuid, bytea), case_api.session_feedback_code(uuid) from public, anon, authenticated;
grant execute on function case_api.feedback_resolve(text), case_api.feedback_upsert(uuid, bytea, text, jsonb, integer),
  case_api.feedback_mine(uuid, bytea), case_api.session_feedback_code(uuid) to service_role;
commit;
