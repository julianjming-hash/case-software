-- Additive correction seed provenance. Original participant submission fields remain genuine.
-- All five fields are personal linkage on session_responses; the existing 24-hour deletion
-- removes them in the same row, and late archive retries retain the existing cutoff guard.
begin;
alter table case_app.session_responses
  add column source_response_id uuid,
  add column source_round_id uuid,
  add column source_client_event_id uuid,
  add column correction_event_id uuid,
  add column seeded_at timestamptz,
  add constraint session_responses_seed_complete check (
    (source_response_id is null and source_round_id is null and source_client_event_id is null and correction_event_id is null and seeded_at is null) or
    (source_response_id is not null and source_round_id is not null and source_client_event_id is not null and correction_event_id is not null and seeded_at is not null)
  );

create function case_app.check_response_seed_provenance()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and
    row(new.source_response_id,new.source_round_id,new.source_client_event_id,new.correction_event_id,new.seeded_at)
      is distinct from row(old.source_response_id,old.source_round_id,old.source_client_event_id,old.correction_event_id,old.seeded_at) then
    raise exception 'seed_provenance_immutable' using errcode='23514';
  end if;
  if new.source_response_id is not null and not exists (
    select 1 from case_app.session_responses source
    where source.id=new.source_response_id and source.id<>new.id and source.session_id=new.session_id
      and source.round_id=new.source_round_id and source.round_id<>new.round_id
      and source.participant_id=new.participant_id and source.last_client_event_id=new.source_client_event_id
      and source.first_submitted_at=new.first_submitted_at and source.last_submitted_at<=new.seeded_at
  ) then raise exception 'invalid_seed_provenance' using errcode='23514'; end if;
  return new;
end $$;
create trigger session_responses_seed_provenance
before insert or update on case_app.session_responses
for each row execute function case_app.check_response_seed_provenance();

create or replace function case_api.archive_session_batch(p_session_id uuid, p_batch jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
 v_max bigint; v_session case_app.sessions%rowtype; v_end timestamptz; v_delete timestamptz; v_cutoff timestamptz; v_personal boolean;

begin
  select * into v_session from case_app.sessions where id = p_session_id for update;
  if not found then
    raise exception 'unknown_session' using errcode = '23503';
  end if;

  if jsonb_typeof(p_batch) is distinct from 'object' then raise exception 'invalid_archive_metadata' using errcode='23514'; end if;
  if (p_batch ? 'ended_at') <> (p_batch ? 'personal_data_delete_at') then raise exception 'invalid_archive_metadata' using errcode='23514'; end if;
  if p_batch ? 'ended_at' then
    if jsonb_typeof(p_batch->'ended_at') is distinct from 'string' or jsonb_typeof(p_batch->'personal_data_delete_at') is distinct from 'string'
       or (p_batch->>'ended_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       or (p_batch->>'personal_data_delete_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      raise exception 'invalid_archive_metadata' using errcode='23514';
    end if;
    begin
      v_end := (p_batch->>'ended_at')::timestamptz;
      v_delete := (p_batch->>'personal_data_delete_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'invalid_archive_metadata' using errcode='23514';
    end;
    if v_end is null or v_delete is null or not isfinite(v_end) or not isfinite(v_delete)
       or v_end < v_session.created_at or v_end > clock_timestamp() or v_delete <= v_end then
      raise exception 'invalid_archive_metadata' using errcode='23514';
    end if;
    v_end := case when v_session.status='expired' and v_session.ended_at=v_session.expires_at then v_end else least(v_session.ended_at,v_end) end;
    v_delete := least(v_delete,v_end+interval '24 hours');
    update case_app.sessions set ended_at=v_end,status='ended' where id=p_session_id;
  else v_end:=v_session.ended_at;
  end if;
  v_cutoff:=least(v_session.personal_data_delete_at,v_delete,v_end+interval '24 hours',v_session.expires_at+interval '24 hours');
  update case_app.sessions set personal_data_delete_at=v_cutoff where id=p_session_id;
  v_personal:=v_session.retention_purged_at is null and clock_timestamp()<v_cutoff;
  if not v_personal then
    delete from case_app.session_responses where session_id=p_session_id;
    update case_app.session_participants set display_name=null,token_sha256=null,purged_at=coalesce(purged_at,clock_timestamp()) where session_id=p_session_id;
    update case_app.sessions set retention_purged_at=coalesce(retention_purged_at,clock_timestamp()) where id=p_session_id;
  end if;

  if v_personal then
  insert into case_app.session_participants (id, session_id, display_name, token_sha256, joined_at, removed_at)
  select x.id, p_session_id, x.display_name, decode(x.token_sha256, 'hex'), x.joined_at, x.removed_at
    from jsonb_to_recordset(coalesce(p_batch -> 'participants', '[]'))
         as x(id uuid, display_name text, token_sha256 text, joined_at timestamptz, removed_at timestamptz)
    join case_app.sessions s on s.id = p_session_id and s.retention_purged_at is null
   order by x.id
  on conflict (id) do update
     set display_name = excluded.display_name, removed_at = excluded.removed_at
   where case_app.session_participants.purged_at is null;

  end if;

  insert into case_app.session_rounds
         (id, session_id, decision_id, round_no, status, opened_at, locked_at, closed_at,
          aggregate, selected_path_id, resolution_kind)
  select x.id, p_session_id, x.decision_id, x.round_no, x.status, x.opened_at, x.locked_at, x.closed_at,
         x.aggregate, x.selected_path_id, x.resolution_kind
    from jsonb_to_recordset(coalesce(p_batch -> 'rounds', '[]'))
         as x(id uuid, decision_id uuid, round_no integer, status text, opened_at timestamptz,
              locked_at timestamptz, closed_at timestamptz, aggregate jsonb, selected_path_id uuid,
              resolution_kind text)
  on conflict (id) do update
     set status = excluded.status, locked_at = excluded.locked_at, closed_at = excluded.closed_at,
         aggregate = excluded.aggregate, selected_path_id = excluded.selected_path_id,
         resolution_kind = excluded.resolution_kind
   where case_app.session_rounds.status='open' or
     (case_app.session_rounds.status='locked' and excluded.status<>'open');

  if v_personal then
  insert into case_app.session_responses
         (id, session_id, round_id, participant_id, response, last_client_event_id,
          first_submitted_at, last_submitted_at,
          source_response_id, source_round_id, source_client_event_id, correction_event_id, seeded_at)
  select x.id, p_session_id, x.round_id, x.participant_id, x.response, x.last_client_event_id,
         x.first_submitted_at, x.last_submitted_at,
         x.source_response_id, x.source_round_id, x.source_client_event_id, x.correction_event_id, x.seeded_at
    from jsonb_to_recordset(coalesce(p_batch -> 'responses', '[]'))
         as x(id uuid, round_id uuid, participant_id uuid, response jsonb, last_client_event_id uuid,
              first_submitted_at timestamptz, last_submitted_at timestamptz,
              source_response_id uuid, source_round_id uuid, source_client_event_id uuid, correction_event_id uuid, seeded_at timestamptz)
    join case_app.sessions s on s.id = p_session_id and s.retention_purged_at is null
  on conflict (round_id, participant_id) do update
     set response = excluded.response, last_client_event_id = excluded.last_client_event_id,
         last_submitted_at = excluded.last_submitted_at
   where excluded.last_submitted_at >= case_app.session_responses.last_submitted_at;

  end if;

  insert into case_app.session_events (session_id, seq, event_id, epoch, kind, payload, occurred_at)
  select p_session_id, x.seq, x.event_id, x.epoch, x.kind, coalesce(x.payload, '{}'), x.occurred_at
    from jsonb_to_recordset(coalesce(p_batch -> 'events', '[]'))
         as x(seq bigint, event_id uuid, epoch integer, kind text, payload jsonb, occurred_at timestamptz)
  on conflict do nothing;

  select coalesce(max(seq), 0) into v_max from case_app.session_events where session_id = p_session_id;

  update case_app.sessions
     set archived_through_seq = greatest(archived_through_seq, v_max),
         status     = case when status in ('lobby', 'live')
                           then coalesce(p_batch ->> 'status', status) else status end,
         started_at = coalesce(started_at, (p_batch ->> 'started_at')::timestamptz)
   where id = p_session_id;

  -- A slow batch may cross its immutable cutoff while inserting. Do not return personal rows past it.
  if v_personal and clock_timestamp()>=v_cutoff then
    delete from case_app.session_responses where session_id=p_session_id;
    update case_app.session_participants set display_name=null,token_sha256=null,purged_at=coalesce(purged_at,clock_timestamp()) where session_id=p_session_id;
    update case_app.sessions set retention_purged_at=coalesce(retention_purged_at,clock_timestamp()) where id=p_session_id;
  end if;
  return v_max;
end;
$$;

commit;
