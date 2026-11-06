-- The facilitator's "Name & role" on the participant record (Julian's rulings, 2026-10-18). A facilitator states a Name
-- (profiles.display_name) and a Role (profiles.facilitator_role) at first sign-in (label_confirmed_at), may change them in
-- Account, and an admin may correct them (step-up and admin_audit_log in the Worker, CAS on admin_revision here). At room
-- start the Worker writes the room's one label, "Name, Role" (or the console's this-session override), to
-- sessions.facilitator_label; feedback_resolve shows it only after End. It is personal data and is deleted with the room's
-- (hard rule 8): the purge's retention stamp nulls it (trigger), and a check makes a purged row with a label impossible,
-- so it holds whichever order this and 20261104000000_feedback_subject_comments.sql apply in.
-- Expand-only and backward-compatible: ensure_profile keeps its signature (now insert-only, so it never overwrites an edited
-- name), get_me keeps its arguments and gains two columns the deployed Worker ignores, create_session is untouched, and every
-- new RPC is unused until the new Worker deploys. Apply this before that Worker.
begin;

-- ─── columns ────────────────────────────────────────────────────────────────────────────────────────────────────

alter table case_app.profiles
  add column facilitator_role text check (facilitator_role is null or
    (char_length(facilitator_role) between 1 and 80 and facilitator_role = btrim(facilitator_role) and facilitator_role !~ '[[:cntrl:]]')),
  add column label_confirmed_at timestamptz;
alter table case_app.sessions
  add column facilitator_label text check (facilitator_label is null or
    (char_length(facilitator_label) between 1 and 162 and facilitator_label = btrim(facilitator_label) and facilitator_label !~ '[[:cntrl:]]')),
  add constraint sessions_facilitator_label_purged check (retention_purged_at is null or facilitator_label is null);

-- One name or role field as the Worker sends it (src/shared/facilitator-label.mjs): trimmed, no controls, 1–80 characters.
create function case_app.label_field_ok(p text) returns boolean language sql immutable set search_path = '' as $$
  select p is not null and char_length(p) between 1 and 80 and p = btrim(p) and p !~ '[[:cntrl:]]' and p !~ '\s{2}'
$$;

-- ─── the purge (hard rule 8) ─────────────────────────────────────────────────────────────────────────────────────

-- purge_expired_participant_data stamps retention_purged_at when a room's personal data goes; the label goes with it.
create function case_app.sessions_purge_facilitator_label() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.retention_purged_at is not null then new.facilitator_label := null; end if;
  return new;
end;
$$;
create trigger sessions_purge_facilitator_label before update of retention_purged_at, facilitator_label on case_app.sessions
  for each row execute function case_app.sessions_purge_facilitator_label();

-- ─── profiles ───────────────────────────────────────────────────────────────────────────────────────────────────

-- Insert-only: the Worker calls this on every workspace create, case create and room start with the stored name or the
-- neutral 'Facilitator'; it may fill a missing name but never replaces one the facilitator chose.
create or replace function case_api.ensure_profile(p_user_id uuid, p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_display_name is null or
     length(btrim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_profile' using errcode = '23514';
  end if;
  insert into case_app.profiles (id, display_name) values (p_user_id, btrim(p_display_name))
  on conflict (id) do update set display_name = excluded.display_name where case_app.profiles.display_name is null;
end;
$$;

-- get_me gains the role and whether the facilitator confirmed both (the first-sign-in step). Same arguments, same rows.
drop function case_api.get_me(uuid, integer, uuid, uuid, boolean, text);
create function case_api.get_me(
  p_user_id uuid, p_limit integer default 100, p_after uuid default null,
  p_workspace_id uuid default null, p_admin boolean default false, p_admin_email text default null
) returns table (
  user_id uuid, display_name text, memberships jsonb, next_after uuid, admin boolean,
  facilitator_role text, label_confirmed_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_admin boolean := case_app.check_admin_flag(p_admin, p_admin_email);
  v_display_name text;
  v_role text;
  v_confirmed timestamptz;
  v_memberships jsonb;
  v_next_after uuid;
begin
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  -- P-10: an inactive account sees no workspace (the Worker refuses it first; this is the backstop).
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  if p_after is not null and not exists (
    select 1 from case_app.workspaces w
      left join case_app.workspace_members m on m.workspace_id = w.id and m.user_id = p_user_id
     where w.id = p_after and (v_admin or m.user_id is not null)
       and (p_workspace_id is null or w.id = p_workspace_id)
  ) then raise exception 'invalid_page_cursor' using errcode = '22023'; end if;
  select p.display_name, p.facilitator_role, p.label_confirmed_at into v_display_name, v_role, v_confirmed
    from case_app.profiles p where p.id = p_user_id;
  with page as (
    select w.id as workspace_id, w.slug, w.name, case when v_admin then 'admin' else m.role end as role,
           row_number() over (order by w.id) as rn
      from case_app.workspaces w
      left join case_app.workspace_members m on m.workspace_id = w.id and m.user_id = p_user_id
     where (v_admin or m.user_id is not null)
       and (p_workspace_id is null or w.id = p_workspace_id)
       and (p_after is null or w.id > p_after)
     order by w.id
     limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'workspace_id', workspace_id, 'slug', slug, 'name', name, 'role', role
         ) order by workspace_id) filter (where rn <= v_limit), '[]'::jsonb),
         case when count(*) > v_limit then (array_agg(workspace_id) filter (where rn = v_limit))[1] else null end
    into v_memberships, v_next_after from page;
  return query select p_user_id, v_display_name, v_memberships, v_next_after, v_admin, v_role, v_confirmed;
end;
$$;

-- P-40: the verified caller sets their own Name & role. This is also the first-sign-in step, so it confirms them.
create function case_api.set_own_facilitator_label(p_user_id uuid, p_name text, p_role text)
returns table (display_name text, facilitator_role text, label_confirmed_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not case_app.label_field_ok(p_name) or not case_app.label_field_ok(p_role) then
    raise exception 'invalid_facilitator_label' using errcode = '23514'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  insert into case_app.profiles as t (id, display_name, facilitator_role, label_confirmed_at)
  values (p_user_id, p_name, p_role, clock_timestamp())
  on conflict (id) do update set display_name = excluded.display_name, facilitator_role = excluded.facilitator_role,
    label_confirmed_at = excluded.label_confirmed_at;
  return query select p.display_name, p.facilitator_role, p.label_confirmed_at from case_app.profiles p where p.id = p_user_id;
end;
$$;

-- P-41: an admin corrects another account's Name & role. The Worker checks the step-up and writes the admin_audit_log
-- intent and outcome (admin_revision before and after; never the words, CASE-075). It leaves label_confirmed_at alone:
-- an unconfirmed facilitator still sees the first-sign-in step, prefilled with these values.
create function case_api.admin_set_facilitator_label(
  p_user_id uuid, p_expected_revision bigint, p_name text, p_role text, p_admin boolean, p_admin_email text
) returns table (user_id uuid, admin_revision bigint, display_name text, facilitator_role text, label_confirmed_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare p case_app.profiles%rowtype;
begin
  if not coalesce(case_app.check_admin_flag(p_admin, p_admin_email), false) then
    raise exception 'not_authorised: facilitator labels are admin only' using errcode = '42501'; end if;
  if p_user_id is null or p_expected_revision is null or p_expected_revision < 0 or
     not case_app.label_field_ok(p_name) or not case_app.label_field_ok(p_role) then
    raise exception 'invalid_facilitator_label' using errcode = '23514'; end if;
  select * into p from case_app.profiles t where t.id = p_user_id for update;
  if not found then raise exception 'missing_profile' using errcode = '22023'; end if;
  if p.soft_deleted_at is not null or p.admin_delete_claim_id is not null then
    raise exception 'invalid_admin_state' using errcode = '23514'; end if;
  if p.admin_revision <> p_expected_revision then raise exception 'stale_admin_revision' using errcode = '40001'; end if;
  update case_app.profiles t set display_name = p_name, facilitator_role = p_role, admin_revision = t.admin_revision + 1
   where t.id = p_user_id;
  return query select t.id, t.admin_revision, t.display_name, t.facilitator_role, t.label_confirmed_at
    from case_app.profiles t where t.id = p_user_id;
end;
$$;

-- The admin facilitator list's Name & role, behind the Worker admin gate (as admin_read_profiles).
create function case_api.admin_read_facilitator_labels(p_user_ids uuid[])
returns table (user_id uuid, display_name text, facilitator_role text, label_confirmed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.facilitator_role, p.label_confirmed_at
    from case_app.profiles p where p.id = any(coalesce(p_user_ids, '{}')) and cardinality(p_user_ids) <= 1000 order by p.id;
$$;

-- The deployment audit learns the label edit. The table's inline action check was unnamed.
do $$ declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'case_app.admin_audit_log'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%facilitator_hard_delete%' loop
    execute format('alter table case_app.admin_audit_log drop constraint %I', c.conname);
  end loop;
end $$;
alter table case_app.admin_audit_log add constraint admin_audit_log_action_ok check (action in (
  'stepup_start','stepup_verify','facilitator_invite','facilitator_resend',
  'facilitator_disable','facilitator_enable','facilitator_soft_delete',
  'facilitator_restore','facilitator_hard_delete','facilitator_label_edit','case_publish',
  'version_withdraw','room_end'));

-- ─── the room ───────────────────────────────────────────────────────────────────────────────────────────────────

-- Written once by the Worker right after create_session, for the room it just created: the label fixed at start.
create function case_api.set_session_facilitator_label(p_session_id uuid, p_label text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_done boolean;
begin
  if p_session_id is null or p_label is null or char_length(p_label) not between 1 and 162 or p_label <> btrim(p_label) or
     p_label ~ '[[:cntrl:]]' or p_label ~ '\s{2}' then raise exception 'invalid_facilitator_label' using errcode = '23514'; end if;
  update case_app.sessions s set facilitator_label = p_label
   where s.id = p_session_id and s.facilitator_label is null and s.status in ('lobby', 'live') and s.retention_purged_at is null;
  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

-- feedback_resolve (20261101000000_participant_feedback.sql) gains the room's label, only past the not_ended gate.
create or replace function case_api.feedback_resolve(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_code text := upper(btrim(coalesce(p_code, ''))); r record; v_cutoff timestamptz; v_objectives jsonb;
begin
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{6}$' then return null; end if;
  select s.id, s.status, s.started_at, s.ended_at, s.expires_at, s.personal_data_delete_at, s.retention_purged_at,
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
  -- Before End the code reveals nothing but its state: no title, objectives, facilitator or session id (red-team R7, 2026-10-17).
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
    'form_url', r.form_url,
    'facilitator', case when r.retention_purged_at is null then r.facilitator_label end);
end;
$$;

-- ─── privileges ─────────────────────────────────────────────────────────────────────────────────────────────────

revoke all on function case_app.label_field_ok(text), case_app.sessions_purge_facilitator_label()
  from public, anon, authenticated, service_role;
revoke all on function case_api.get_me(uuid, integer, uuid, uuid, boolean, text),
  case_api.set_own_facilitator_label(uuid, text, text),
  case_api.admin_set_facilitator_label(uuid, bigint, text, text, boolean, text),
  case_api.admin_read_facilitator_labels(uuid[]),
  case_api.set_session_facilitator_label(uuid, text)
  from public, anon, authenticated;
grant execute on function case_api.get_me(uuid, integer, uuid, uuid, boolean, text),
  case_api.set_own_facilitator_label(uuid, text, text),
  case_api.admin_set_facilitator_label(uuid, bigint, text, text, boolean, text),
  case_api.admin_read_facilitator_labels(uuid[]),
  case_api.set_session_facilitator_label(uuid, text)
  to service_role;
commit;
