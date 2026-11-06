-- Participant feedback results (card 40 + feedback integration slice 9; docs/plans/PARTICIPANT-FEEDBACK.md §6–§8).
-- Additive: three service-role reads and their permission rows. P-37 a room's feedback (P-34's starter rule), P-38 a
-- version's pooled case-content feedback (the case's workspace owners and authors), P-39 the admin's app feedback and
-- everything pooled. Before a room's fold the reads aggregate session_feedback; after it they read the tallies, totals
-- and unlinked comments, in the same shape and order. No read returns a respondent hash, a participant id, a name, a
-- response-level row of ratings or a timestamp finer than the session's date.
begin;
-- Generated permission block follows (P-37, P-38, P-39 join the R rows). No applied migration is modified.
-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)
create or replace function case_app.action_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then array[]::text[]
    when 'P-02' then array[]::text[]
    when 'P-03' then array[]::text[]
    when 'P-04' then array[]::text[]
    when 'P-05' then array[]::text[]
    when 'P-07' then array[]::text[]
    when 'P-10' then array['owner', 'author', 'facilitator']
    when 'P-11' then array['owner', 'author', 'facilitator']
    when 'P-12' then array['owner', 'author', 'facilitator']
    when 'P-13' then array['owner', 'author']
    when 'P-14' then array['owner', 'author']
    when 'P-15' then array[]::text[]
    when 'P-16' then array['owner']
    when 'P-17' then array['owner']
    when 'P-18' then array['owner']
    when 'P-19' then array['owner']
    when 'P-20' then array['owner']
    when 'P-21' then array['owner', 'author', 'facilitator']
    when 'P-22' then array[]::text[]
    when 'P-32' then array['owner', 'author', 'facilitator']
    when 'P-33' then array[]::text[]
    when 'P-34' then array['owner', 'author', 'facilitator']
    when 'P-37' then array['owner', 'author', 'facilitator']
    when 'P-38' then array['owner', 'author']
    when 'P-39' then array[]::text[]
  end;
$$;
create or replace function case_app.action_admin(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_action
    when 'P-01' then true
    when 'P-02' then true
    when 'P-03' then true
    when 'P-04' then true
    when 'P-05' then true
    when 'P-07' then true
    when 'P-10' then true
    when 'P-11' then true
    when 'P-12' then true
    when 'P-13' then true
    when 'P-14' then true
    when 'P-15' then true
    when 'P-16' then true
    when 'P-17' then true
    when 'P-18' then true
    when 'P-19' then true
    when 'P-20' then true
    when 'P-21' then true
    when 'P-22' then true
    when 'P-32' then true
    when 'P-33' then true
    when 'P-34' then true
    when 'P-37' then true
    when 'P-38' then true
    when 'P-39' then true
  end;
$$;
-- END GENERATED permission roles
revoke all on function case_app.action_roles(text),case_app.action_admin(text) from public,anon,authenticated;

-- ─── one reader for both sides of the fold ──────────────────────────────────────────────────────────────────────

-- Whether the room's feedback is folded (closed rooms read the long-term rows, open rooms the linked ones; never both).
create function case_app.feedback_folded(p_session_id uuid) returns boolean language sql stable set search_path = '' as $$
  select coalesce((select feedback_closed_at is not null from case_app.sessions where id = p_session_id), false)
$$;

-- Rating counts per question and value over a set of rooms.
create function case_app.feedback_counts(p_ids uuid[]) returns table(question text, value smallint, n bigint)
language sql stable set search_path = '' as $$
  select x.question, x.value, sum(x.n)::bigint from (
    select t.question, t.value, t.n::bigint as n from case_app.session_feedback_tallies t
      join case_app.sessions s on s.id = t.session_id
     where t.session_id = any (p_ids) and s.feedback_closed_at is not null
    union all
    select r.q, r.v, count(*) from case_app.session_feedback f
      join case_app.sessions s on s.id = f.session_id
      cross join lateral (values ('session', f.rating_session), ('case', f.rating_case), ('app', f.rating_app)) r(q, v)
     where f.session_id = any (p_ids) and s.feedback_closed_at is null and r.v is not null
     group by r.q, r.v
  ) x group by x.question, x.value
$$;

-- {"counts":[n1..n5],"n":total}: counts per value 1–5 with n, never an average.
create function case_app.feedback_distribution(p_ids uuid[], p_question text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('counts', jsonb_agg(coalesce(c.n, 0) order by g.v), 'n', coalesce(sum(c.n), 0)::bigint)
    from generate_series(1, 5) g(v)
    left join (select value, n from case_app.feedback_counts(p_ids) where question = p_question) c on c.value = g.v
$$;

-- {"total","joined","qr"} responses over a set of rooms.
create function case_app.feedback_responses(p_ids uuid[]) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('total', coalesce(sum(x.j + x.q), 0)::bigint, 'joined', coalesce(sum(x.j), 0)::bigint, 'qr', coalesce(sum(x.q), 0)::bigint)
    from (
    select t.joined::bigint as j, t.qr::bigint as q from case_app.session_feedback_totals t
      join case_app.sessions s on s.id = t.session_id
     where t.session_id = any (p_ids) and s.feedback_closed_at is not null
    union all
    select count(*) filter (where f.source = 'joined'), count(*) filter (where f.source = 'qr') from case_app.session_feedback f
      join case_app.sessions s on s.id = f.session_id
     where f.session_id = any (p_ids) and s.feedback_closed_at is null
  ) x
$$;

-- Written comments over a set of rooms, each with only its room: no phone, rating, timestamp or other comment.
create function case_app.feedback_comment_rows(p_ids uuid[]) returns table(session_id uuid, kind text, about text, body text)
language sql stable set search_path = '' as $$
  select c.session_id, c.kind, c.about, c.body from case_app.session_feedback_comments c
    join case_app.sessions s on s.id = c.session_id
   where c.session_id = any (p_ids) and s.feedback_closed_at is not null
  union all
  select f.session_id, 'takeaway', 'session', f.takeaway from case_app.session_feedback f
    join case_app.sessions s on s.id = f.session_id
   where f.session_id = any (p_ids) and s.feedback_closed_at is null and f.takeaway is not null
  union all
  select f.session_id, 'improve', f.improve_about, f.improve from case_app.session_feedback f
    join case_app.sessions s on s.id = f.session_id
   where f.session_id = any (p_ids) and s.feedback_closed_at is null and f.improve is not null
$$;

-- Rooms with any feedback (linked responses while open, a totals row once folded).
create function case_app.feedback_room_has_responses(p_session_id uuid) returns boolean language sql stable set search_path = '' as $$
  select case when case_app.feedback_folded(p_session_id)
    then exists (select 1 from case_app.session_feedback_totals t where t.session_id = p_session_id and t.joined + t.qr > 0)
    else exists (select 1 from case_app.session_feedback f where f.session_id = p_session_id) end
$$;

-- A comment as the reader sees it. Take-aways first, then improvements about the session, the case, the app; ties by text.
create function case_app.feedback_comment_json(p_kind text, p_about text, p_body text) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('kind', p_kind, 'about', p_about, 'body', p_body)
$$;

-- The session's date, the finest time any result carries.
create function case_app.feedback_session_date(s case_app.sessions) returns text language sql stable set search_path = '' as $$
  select to_char(coalesce(s.ended_at, s.started_at, s.created_at) at time zone 'UTC', 'YYYY-MM-DD')
$$;

-- One room's results (P-37, and the admin's room scope). The caller has authorized the read.
create function case_app.feedback_session_body(p_session_id uuid) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'session', jsonb_build_object('id', s.id, 'caseId', v.case_id, 'versionNo', v.version_no,
      'title', left(coalesce(nullif(v.document->>'title', ''), c.title), 200), 'date', case_app.feedback_session_date(s)),
    'closed', s.feedback_closed_at is not null or s.retention_purged_at is not null
      or coalesce(case_app.feedback_cutoff(s.personal_data_delete_at, s.ended_at, s.expires_at) <= clock_timestamp(), false),
    'responses', case_app.feedback_responses(array[s.id]),
    'ratings', jsonb_build_object('session', case_app.feedback_distribution(array[s.id], 'session'),
      'case', case_app.feedback_distribution(array[s.id], 'case'), 'app', case_app.feedback_distribution(array[s.id], 'app')),
    'comments', coalesce((select jsonb_agg(case_app.feedback_comment_json(r.kind, r.about, r.body)
        order by r.kind desc, array_position(array['session', 'case', 'app'], r.about), r.body collate "C")
      from case_app.feedback_comment_rows(array[s.id]) r), '[]'::jsonb))
  from case_app.sessions s
  join case_app.case_versions v on v.id = s.case_version_id
  join case_app.cases c on c.id = v.case_id
  where s.id = p_session_id
$$;

-- One version's pooled case-content results (P-38, and the admin's case scope): the case rating, room and response
-- counts, take-aways and improvements about the case (D4), newest rooms first, at most 300 comments.
create function case_app.feedback_case_body(p_version_id uuid) returns jsonb language plpgsql stable set search_path = '' as $$
declare v case_app.case_versions; v_title text; v_ids uuid[];
begin
  select * into v from case_app.case_versions where id = p_version_id;
  select left(coalesce(nullif(v.document->>'title', ''), c.title), 200) into v_title from case_app.cases c where c.id = v.case_id;
  select coalesce(array_agg(s.id), '{}') into v_ids from case_app.sessions s
   where s.case_version_id = v.id and case_app.feedback_room_has_responses(s.id);
  return jsonb_build_object(
    'case', jsonb_build_object('id', v.case_id, 'versionNo', v.version_no, 'title', v_title),
    'rooms', cardinality(v_ids),
    'responses', case_app.feedback_responses(v_ids),
    'ratings', jsonb_build_object('case', case_app.feedback_distribution(v_ids, 'case')),
    'comments', coalesce((select jsonb_agg(case_app.feedback_comment_json(x.kind, x.about, x.body) order by x.created_at desc, x.session_id desc, x.kind desc, x.body collate "C")
      from (select r.*, s.created_at from case_app.feedback_comment_rows(v_ids) r join case_app.sessions s on s.id = r.session_id
             where r.kind = 'takeaway' or r.about = 'case'
             order by s.created_at desc, r.session_id desc, r.kind desc, r.body collate "C" limit 300) x), '[]'::jsonb),
    'commentsTotal', (select count(*) from case_app.feedback_comment_rows(v_ids) r where r.kind = 'takeaway' or r.about = 'case'));
end;
$$;

-- ─── the three reads (service role only) ────────────────────────────────────────────────────────────────────────

-- P-37: the room's starter with current membership and an active account, or a deployment admin (P-34's rule).
create function case_api.session_feedback_summary(p_user_id uuid, p_session_id uuid, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare s case_app.sessions; v_role text; v_body jsonb;
begin
  select * into s from case_app.sessions where id = p_session_id;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  v_role := case_app.authorize(p_user_id, s.workspace_id, 'P-37', p_admin, p_admin_email);
  if v_role <> 'admin' and s.facilitator_id is distinct from p_user_id then raise exception 'not_starter' using errcode = '42501'; end if;
  v_body := case_app.feedback_session_body(s.id);
  -- The Worker rechecks the workspace role and the starter flag (W), then drops both before the client sees the result.
  return jsonb_set(jsonb_set(v_body, '{session,workspaceId}', to_jsonb(s.workspace_id)), '{session,own}', to_jsonb(s.facilitator_id = p_user_id));
end;
$$;

-- P-38: the case's workspace owners and authors, or a deployment admin; pooled across every room of that version.
create function case_api.case_feedback_summary(p_user_id uuid, p_case_id uuid, p_version_no integer, p_admin boolean, p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare v_version uuid; v_workspace uuid;
begin
  select v.id, c.workspace_id into v_version, v_workspace from case_app.case_versions v join case_app.cases c on c.id = v.case_id
   where c.id = p_case_id and v.version_no = p_version_no;
  if not found then raise exception 'version_not_found' using errcode = 'P0002'; end if;
  perform case_app.authorize(p_user_id, v_workspace, 'P-38', p_admin, p_admin_email);
  return jsonb_set(case_app.feedback_case_body(v_version), '{case,workspaceId}', to_jsonb(v_workspace));
end;
$$;

-- P-39: the configured admin only. Filters (exact keys): {"scope":"app"} app ratings by month and app comments, 20 a
-- page; {"scope":"rooms"} rooms with any feedback, newest first, 20 a page; {"scope":"session","sessionId"} one room;
-- {"scope":"case","caseId","versionNo"} one version pooled. p_after is the page offset (0, 20, 40 …; 0 for one result).
create function case_api.admin_feedback_page(p_user_id uuid, p_filter jsonb, p_after integer, p_admin boolean, p_admin_email text)
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
       where r.kind = 'improve' and r.about = 'app'
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

revoke all on function case_app.feedback_folded(uuid), case_app.feedback_counts(uuid[]), case_app.feedback_distribution(uuid[], text),
  case_app.feedback_responses(uuid[]), case_app.feedback_comment_rows(uuid[]), case_app.feedback_room_has_responses(uuid),
  case_app.feedback_comment_json(text, text, text), case_app.feedback_session_date(case_app.sessions),
  case_app.feedback_session_body(uuid), case_app.feedback_case_body(uuid) from public, anon, authenticated;
revoke all on function case_api.session_feedback_summary(uuid, uuid, boolean, text), case_api.case_feedback_summary(uuid, uuid, integer, boolean, text),
  case_api.admin_feedback_page(uuid, jsonb, integer, boolean, text) from public, anon, authenticated;
grant execute on function case_api.session_feedback_summary(uuid, uuid, boolean, text), case_api.case_feedback_summary(uuid, uuid, integer, boolean, text),
  case_api.admin_feedback_page(uuid, jsonb, integer, boolean, text) to service_role;
commit;
