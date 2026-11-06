-- Debrief opens feedback before End (console layout v2; Julian, 2026-10-18). A room in Debrief tells Postgres so (its
-- Durable Object calls set_session_debrief on entry and on Back to the case), and the feedback page treats a session in
-- Debrief like an ended one: public facts on resolve, responses accepted until the usual cutoff. Additive: a new nullable
-- column, a new service RPC, and the two gates recreated with one more condition each (feedback_resolve from 20261106, feedback_upsert from 20261104).
begin;

alter table case_app.sessions add column debrief_at timestamptz;

-- Set while the room is in Debrief, cleared on Back to the case; never for an ended or expired room.
create function case_api.set_session_debrief(p_session_id uuid, p_on boolean) returns boolean
language sql volatile security definer set search_path = '' as $$
  with marked as (
    update case_app.sessions set debrief_at = case when p_on then coalesce(debrief_at, now()) else null end
     where id = p_session_id and ended_at is null and status in ('lobby', 'live')
    returning 1)
  select exists (select 1 from marked)
$$;

create or replace function case_api.feedback_resolve(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_code text := upper(btrim(coalesce(p_code, ''))); r record; v_cutoff timestamptz; v_objectives jsonb;
begin
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{6}$' then return null; end if;
  select s.id, s.status, s.started_at, s.ended_at, s.debrief_at, s.expires_at, s.personal_data_delete_at, s.retention_purged_at,
         s.feedback_closed_at, coalesce(s.feedback_form_url, g.feedback_form_url) form_url, v.version_no, v.document,
         s.facilitator_label
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
  -- Before End (or Debrief) the code reveals nothing but its state: no title, objectives, facilitator or session id (red-team R7).
  if r.feedback_closed_at is null and r.retention_purged_at is null and v_cutoff > clock_timestamp()
     and r.ended_at is null and r.debrief_at is null and r.status in ('lobby', 'live') then return jsonb_build_object('state', 'not_ended'); end if;
  return jsonb_build_object(
    'session_id', r.id,
    'state', case when r.feedback_closed_at is not null or r.retention_purged_at is not null or v_cutoff <= clock_timestamp() then 'closed'
                  else 'open' end,
    'title', left(coalesce(r.document->>'title', ''), 200),
    'version_no', r.version_no,
    'audience', left(r.document->>'audience', 200),
    'started_at', r.started_at, 'ended_at', r.ended_at, 'closes_at', v_cutoff,
    'objectives', v_objectives,
    'form_url', r.form_url,
    'facilitator', case when r.retention_purged_at is null then r.facilitator_label end);
end;
$$;

-- The room's feedback code, read by the Worker right after create_session so the room Durable Object can carry it

create or replace function case_api.feedback_upsert(p_session_id uuid, p_respondent_sha256 bytea, p_source text, p_answers jsonb,
  p_expected_revision integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; v_hash case_app.sha256 := p_respondent_sha256; v_answers jsonb; v_cutoff timestamptz;
  f case_app.session_feedback;
begin
  if p_source is null or p_source not in ('joined', 'qr') then raise exception 'invalid_feedback: source' using errcode = '23514'; end if;
  if v_hash is null then raise exception 'invalid_feedback: respondent' using errcode = '23514'; end if;
  v_answers := case_app.feedback_answers(p_answers);
  select id, status, ended_at, debrief_at, expires_at, personal_data_delete_at, retention_purged_at, feedback_closed_at into s
    from case_app.sessions where id = p_session_id for no key update;
  if not found then raise exception 'invalid_feedback: session' using errcode = '23514'; end if;
  v_cutoff := case_app.feedback_cutoff(s.personal_data_delete_at, s.ended_at, s.expires_at);
  if s.feedback_closed_at is not null or s.retention_purged_at is not null or v_cutoff <= clock_timestamp() then
    raise exception 'feedback_closed' using errcode = '23514'; end if;
  if s.ended_at is null and s.debrief_at is null and s.status in ('lobby', 'live') then raise exception 'feedback_not_open' using errcode = '23514'; end if;

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

revoke all on function case_api.set_session_debrief(uuid, boolean) from public, anon, authenticated;
grant execute on function case_api.set_session_debrief(uuid, boolean) to service_role;
commit;
