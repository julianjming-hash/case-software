-- Archive a never-published draft case (P-42; Julian, 2026-10-30, CASE-316). A workspace owner, or a configured admin
-- (no step-up, as for draft saves, P-14), archives a Builder case that has no published version and no open review
-- submission: archived_at is stamped and every list already filtered on it (drafts, catalogue, library) stops showing
-- it. Nothing is deleted: the case row, its draft, checkpoints and saved revisions stay, so the archive is reversible.
-- The caller confirms the draft's title as the drafts list normalises it (trimmed, at most 200 characters); an untitled
-- draft confirms with an empty title. A trigger refuses any review submission on an archived case, so a submit racing
-- the archive cannot leave an archived case in review. Refusals that are not authorisation (published, in review, wrong title) are
-- returned as an outcome rather than raised, so the Worker can name them. Additive: a new RPC, the audit action, and
-- the permission role block regenerated for P-42 (scripts/gen-permissions.mjs). Apply before the Worker that calls it.
begin;

alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check check(action in (
 'workspace_create','case_create','draft_save','version_publish','version_withdraw','version_republish','room_start','workspace_ownerless',
 'member_invite','owner_assign','group_create','group_edit','group_archive','case_group',
 'draft_checkpoint_create','draft_checkpoint_delete','draft_checkpoint_restore','builder_candidate_submit','builder_candidate_cancel','builder_candidate_approve','builder_candidate_delete',
 'member_role','member_remove','owner_transfer','asset_approve','asset_reject','asset_withdraw','case_archive'));

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
    when 'P-42' then array['owner']
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
    when 'P-42' then true
  end;
$$;
-- END GENERATED permission roles

create function case_api.builder_archive_case(
  p_case_id uuid, p_user_id uuid, p_confirm_title text, p_admin boolean, p_admin_email text
) returns table (case_id uuid, outcome text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_ws uuid := case_app.workspace_of_case(p_case_id); v_title text; v_role text;
begin
  -- Authorise first: an unentitled caller learns nothing about whether the case exists (a missing case has no workspace).
  v_role := case_app.authorize(p_user_id, v_ws, 'P-42', p_admin, p_admin_email);
  perform 1 from case_app.cases c where c.id = p_case_id and c.archived_at is null for update;
  if not found then raise exception 'no_such_case' using errcode = 'P0002'; end if;
  select coalesce(case_app.catalogue_text(d.document, 'title', 200), '') into v_title
    from (select 1) one left join case_app.case_drafts d on d.case_id = p_case_id;
  if exists (select 1 from case_app.case_versions v where v.case_id = p_case_id) then
    return query select p_case_id, 'published'::text; return; end if;
  if exists (select 1 from case_app.builder_candidates b where b.case_id = p_case_id and b.status in ('pending', 'approved')) then
    return query select p_case_id, 'in_review'::text; return; end if;
  if p_confirm_title is distinct from v_title then
    return query select p_case_id, 'title_mismatch'::text; return; end if;
  update case_app.cases c set archived_at = now(), updated_at = now() where c.id = p_case_id;
  insert into case_app.workspace_audit (workspace_id, actor_kind, actor_user_id, actor_email, action, target_type, target_id)
  values (v_ws, case when v_role = 'admin' then 'admin' else 'owner' end, p_user_id,
          case when v_role = 'admin' then p_admin_email end, 'case_archive', 'case', p_case_id);
  return query select p_case_id, 'archived'::text;
end;
$$;

-- A review submission never lands on an archived case (submit locks the case row first, so it sees a committed archive).
create function case_app.refuse_archived_case_candidate() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from case_app.cases c where c.id = new.case_id and c.archived_at is not null) then
    raise exception 'no_such_case' using errcode = 'P0002'; end if;
  return new;
end;
$$;
create trigger builder_candidates_refuse_archived before insert on case_app.builder_candidates
  for each row execute function case_app.refuse_archived_case_candidate();

revoke all on function case_api.builder_archive_case(uuid, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function case_api.builder_archive_case(uuid, uuid, text, boolean, text) to service_role;
commit;
