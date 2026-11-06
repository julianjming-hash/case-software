-- Card 20: fixed, service-only evidence for one archived room's current SQL state.
-- This reports current rows and immutable same-session end provenance. The Worker
-- separately reads the named Durable Object; neither source attests provider PITR.
begin;

create function case_api.retention_status(p_session_id uuid)
returns table (
  session_id uuid,
  status text,
  created_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz,
  personal_data_delete_at timestamptz,
  retention_purged_at timestamptz,
  server_time timestamptz,
  response_count bigint,
  participant_count bigint,
  named_participant_count bigint,
  token_participant_count bigint,
  archived_event_count bigint,
  archived_room_ended_count bigint,
  archived_room_ended_at timestamptz
)
language sql security definer set search_path = '' as $$
  select s.id, s.status, s.created_at, s.started_at, s.ended_at,
    s.expires_at, s.personal_data_delete_at, s.retention_purged_at,
    clock_timestamp(), responses.n, people.total, people.named,
    people.tokened, events.total, events.ended, events.ended_at
  from case_app.sessions s
  cross join lateral (
    select count(*) as n from case_app.session_responses r
      where r.session_id = s.id
  ) responses
  cross join lateral (
    select count(*) as total,
      count(*) filter (where p.display_name is not null) as named,
      count(*) filter (where p.token_sha256 is not null) as tokened
    from case_app.session_participants p where p.session_id = s.id
  ) people
  cross join lateral (
    select count(*) as total,
      count(*) filter (where e.kind = 'room_ended') as ended,
      max(e.occurred_at) filter (where e.kind = 'room_ended') as ended_at
    from case_app.session_events e where e.session_id = s.id
  ) events
  where s.id = p_session_id;
$$;

revoke all on function case_api.retention_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function case_api.retention_status(uuid) to service_role;

commit;
