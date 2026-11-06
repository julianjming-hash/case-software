-- CASE-373: canonical cases with additional workspace run/edit access, home moves and workspace names.
-- CLI generated 20261105004829; ordered after the already applied 20261114000000 dependency before application.
begin;
alter table case_app.workspaces add column details_revision bigint not null default 0 check(details_revision>=0);
alter table case_app.cases add column placement_revision bigint not null default 0 check(placement_revision>=0);
create table case_app.case_workspace_access (
 case_id uuid not null references case_app.cases(id) on delete cascade,
 workspace_id uuid not null references case_app.workspaces(id) on delete restrict,
 level text not null check(level in ('run','edit')),
 created_at timestamptz not null default clock_timestamp(),
 primary key(case_id,workspace_id)
);
create index case_workspace_access_workspace on case_app.case_workspace_access(workspace_id,case_id);
alter table case_app.case_workspace_access enable row level security;
revoke all on case_app.case_workspace_access from public,anon,authenticated,service_role;
-- Keep every per-person grant and invitation, including its link reference and expiry, bound to the same case.
alter table case_app.case_grants drop constraint case_grants_case_id_workspace_id_fkey;
alter table case_app.case_grants add constraint case_grants_case_id_workspace_id_fkey foreign key(case_id,workspace_id)
 references case_app.cases(id,workspace_id) on update cascade on delete restrict;
alter table case_app.invitations drop constraint invitations_case_id_workspace_id_fkey;
alter table case_app.invitations add constraint invitations_case_id_workspace_id_fkey foreign key(case_id,workspace_id)
 references case_app.cases(id,workspace_id) on update cascade on delete restrict;
-- Extend the existing fixed audit vocabulary without recording names, content or personal free text.
alter table case_app.workspace_audit drop constraint workspace_audit_action_check;
alter table case_app.workspace_audit add constraint workspace_audit_action_check
  check (action in ('workspace_create', 'case_create', 'draft_save', 'version_publish', 'version_withdraw', 'version_republish',
    'room_start', 'workspace_ownerless', 'member_invite', 'owner_assign', 'group_create', 'group_edit', 'group_archive', 'case_group',
    'draft_checkpoint_create', 'draft_checkpoint_delete', 'draft_checkpoint_restore', 'builder_candidate_submit',
    'builder_candidate_cancel', 'builder_candidate_approve', 'builder_candidate_delete', 'member_role', 'member_remove',
    'owner_transfer', 'asset_approve', 'asset_reject', 'asset_withdraw', 'case_archive',
    'case_grant', 'case_grant_revoke', 'invitation_create', 'invitation_resend', 'invitation_revoke', 'invitation_accept',
    'policy_set', 'quota_set', 'asset_delete_unused', 'workspace_rename', 'case_workspace_share', 'case_workspace_revoke', 'case_workspace_move'));

-- A workspace share is capped by BOTH membership and its explicit run/edit level. It never yields owner.
create or replace function case_app.grant_role(p_user_id uuid,p_case_id uuid) returns text language sql stable set search_path='' as $$
 select case max(r) when 2 then 'author' when 1 then 'facilitator' end from (
  select case g.level when 'edit' then 2 else 1 end r from case_app.case_grants g
   join case_app.cases c on c.id=g.case_id and c.workspace_id=g.workspace_id
   where g.case_id=p_case_id and g.user_id=p_user_id and g.revoked_at is null and c.archived_at is null
  union all
  select least(case s.level when 'edit' then 2 else 1 end,case_app.role_rank(case_app.member_role(p_user_id,s.workspace_id)))
   from case_app.case_workspace_access s
   join case_app.cases c on c.id=s.case_id and c.archived_at is null
   where s.case_id=p_case_id and case_app.member_role(p_user_id,s.workspace_id) is not null
 ) held;
$$;

CREATE OR REPLACE FUNCTION case_api.get_access(p_user_id uuid, p_workspace_id uuid, p_case_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(workspace_id uuid, case_id uuid, member_role text, grant_level text, role text, scope text, policies jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid := coalesce(case_app.workspace_of_case(p_case_id), p_workspace_id); v_admin boolean;
begin
  v_admin := case_app.check_admin_flag(p_admin, p_admin_email);
  if p_user_id is null then raise exception 'invalid_user' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then raise exception 'account_not_active' using errcode = '42501'; end if;
  if v_ws is null or (p_case_id is not null and p_workspace_id is not null and p_workspace_id <> v_ws)
     or (p_case_id is not null and case_app.workspace_of_case(p_case_id) is null)
     or not exists (select 1 from case_app.workspaces w where w.id = v_ws) then return; end if;
  if v_admin then
    return query select v_ws, p_case_id, case_app.member_role(p_user_id, v_ws), null::text, 'admin'::text, 'workspace'::text, case_app.policies_of(v_ws);
    return;
  end if;
  return query select v_ws, p_case_id, case_app.member_role(p_user_id, v_ws),
      (case case_app.grant_role(p_user_id,p_case_id) when 'author' then 'edit' when 'facilitator' then 'run' end),
      e.role, e.scope, case_app.policies_of(v_ws)
    from case_app.effective_role(p_user_id, v_ws, p_case_id) e;
end;
$function$
;

CREATE OR REPLACE FUNCTION case_api.get_me(p_user_id uuid, p_limit integer DEFAULT 100, p_after uuid DEFAULT NULL::uuid, p_workspace_id uuid DEFAULT NULL::uuid, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS TABLE(user_id uuid, display_name text, memberships jsonb, next_after uuid, admin boolean, facilitator_role text, label_confirmed_at timestamp with time zone, grants jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_admin boolean := case_app.check_admin_flag(p_admin, p_admin_email);
  v_display_name text;
  v_role text;
  v_confirmed timestamptz;
  v_memberships jsonb;
  v_next_after uuid;
  v_grants jsonb;
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
  -- Each place carries its workspace's policies (CASE-337), so the Worker's authorize reads membership, grant and
  -- policies in this one call (plan §3 A3).
  select coalesce(jsonb_agg(jsonb_build_object(
           'workspace_id', workspace_id, 'slug', slug, 'name', name, 'role', role,
           'policies', case_app.policies_of(workspace_id)
         ) order by workspace_id) filter (where rn <= v_limit), '[]'::jsonb),
         case when count(*) > v_limit then (array_agg(workspace_id) filter (where rn = v_limit))[1] else null end
    into v_memberships, v_next_after from page;
  -- Live grants on live cases (at most 200), with the place's names for the picker and "Shared with you".
  select coalesce(jsonb_agg(jsonb_build_object('case_id', g.case_id, 'workspace_id', g.workspace_id, 'workspace_name', w.name,
           'title', c.title, 'level', g.level, 'policies', case_app.policies_of(g.workspace_id), 'access_source',case when origin.workspace_id is null then 'direct' else 'workspace' end,'source_workspace_name',origin.name) order by w.name, c.title, g.case_id), '[]'::jsonb)
    into v_grants
    from (select c.id case_id,c.workspace_id,case case_app.grant_role(p_user_id,c.id) when 'author' then 'edit' else 'run' end level
      from (select g.case_id from case_app.case_grants g where g.user_id=p_user_id and g.revoked_at is null
       union select a.case_id from case_app.case_workspace_access a join case_app.workspace_members m on m.workspace_id=a.workspace_id where m.user_id=p_user_id) candidate
      join case_app.cases c on c.id=candidate.case_id where c.archived_at is null and case_app.grant_role(p_user_id,c.id) is not null
       and (p_workspace_id is null or c.workspace_id=p_workspace_id) order by c.id limit 200) g
    join case_app.cases c on c.id = g.case_id and c.archived_at is null
    join case_app.workspaces w on w.id = g.workspace_id
    left join lateral (
      select source.workspace_id,sw.name from (
       select null::uuid workspace_id,case direct.level when 'edit' then 2 else 1 end rank,0 priority
        from case_app.case_grants direct where direct.case_id=c.id and direct.user_id=p_user_id and direct.revoked_at is null
       union all select a.workspace_id,least(case a.level when 'edit' then 2 else 1 end,case_app.role_rank(m.role)),1
        from case_app.case_workspace_access a join case_app.workspace_members m on m.workspace_id=a.workspace_id
        where a.case_id=c.id and m.user_id=p_user_id
      ) source left join case_app.workspaces sw on sw.id=source.workspace_id
      order by source.rank desc,source.priority,source.workspace_id limit 1
    ) origin on true;
  return query select p_user_id, v_display_name, v_memberships, v_next_after, v_admin, v_role, v_confirmed, v_grants;
end;
$function$
;

CREATE OR REPLACE FUNCTION case_app.catalogue_versions(p_workspace_id uuid)
 RETURNS TABLE(version_id uuid, case_id uuid, version_no integer, latest boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select v.id, v.case_id, v.version_no,
         row_number() over (partition by v.case_id order by v.version_no desc) = 1
    from case_app.case_versions v join case_app.cases c on c.id = v.case_id
   where (c.workspace_id = p_workspace_id or exists(select 1 from case_app.case_workspace_access s where s.case_id=c.id and s.workspace_id=p_workspace_id)) and c.archived_at is null and
         not exists (select 1 from case_app.admin_version_state av
                      where av.case_version_id = v.id and av.status = 'withdrawn');
$function$
;

CREATE OR REPLACE FUNCTION case_api.list_case_catalogue_current(p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text, p_duration integer, p_audience text, p_limit integer, p_offset integer, p_group_id uuid, p_ungrouped boolean, p_admin boolean, p_admin_email text)
 RETURNS TABLE(version_id uuid, case_id uuid, title text, summary text, audience text, setting text, duration_min integer, version_no integer, published_at timestamp with time zone, content_sha256 bytea, art jsonb, group_id uuid, group_name text, tint text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience', 'group') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) or
     p_ungrouped is null or (p_ungrouped and p_group_id is not null) or
     (p_group_id is not null and not exists (select 1 from case_app.case_groups g
        where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null)) then
    raise exception 'invalid_catalogue_query' using errcode = '22023'; end if;
  v_pattern := '%' || replace(replace(replace(lower(coalesce(v_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with listed as (
      select v.id as l_id, v.case_id as l_case, coalesce(case_app.catalogue_text(v.document,'title',200),c.title) as l_title,
             case_app.catalogue_text(v.document, 'summary', 1200) as l_summary,
             case_app.catalogue_text(v.document, 'audience', 200) as l_audience,
             case_app.catalogue_text(v.document, 'setting', 200) as l_setting,
             case_app.catalogue_duration_current(v.document) as l_duration,
             v.version_no as l_version, v.published_at as l_published,
             v.content_sha256::bytea as l_digest, a.descriptor as l_art,
             case when c.workspace_id=p_workspace_id then c.group_id end as l_group, g.name as l_group_name, coalesce(g.tint, 'neutral') as l_tint
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_groups g on g.id = c.group_id and c.workspace_id=p_workspace_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
         and (p_group_id is null or l.l_group = p_group_id)
         and (not p_ungrouped or l.l_group is null)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, f.l_group, f.l_group_name, f.l_tint, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'group' and not p_descending then lower(f.l_group_name) end asc nulls last,
       case when p_sort = 'group' and p_descending then lower(f.l_group_name) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$function$
;

CREATE OR REPLACE FUNCTION case_api.list_case_catalogue(p_user_id uuid, p_workspace_id uuid, p_sort text, p_descending boolean, p_query text, p_duration integer, p_audience text, p_limit integer, p_offset integer, p_group_id uuid, p_ungrouped boolean, p_admin boolean, p_admin_email text)
 RETURNS TABLE(version_id uuid, case_id uuid, title text, summary text, audience text, setting text, duration_min integer, version_no integer, published_at timestamp with time zone, content_sha256 bytea, art jsonb, group_id uuid, group_name text, tint text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 24), 50));
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  if p_sort is null or p_sort not in ('title', 'published', 'length', 'audience', 'group') or p_descending is null or
     p_offset is null or p_offset < 0 or p_offset > 10000 or
     (v_query is not null and char_length(v_query) > 80) or
     (p_duration is not null and p_duration not in (15, 45)) or
     (p_audience is not null and (char_length(p_audience) not between 1 and 200)) or
     p_ungrouped is null or (p_ungrouped and p_group_id is not null) or
     (p_group_id is not null and not exists (select 1 from case_app.case_groups g
        where g.id = p_group_id and g.workspace_id = p_workspace_id and g.archived_at is null)) then
    raise exception 'invalid_catalogue_query' using errcode = '22023'; end if;
  v_pattern := '%' || replace(replace(replace(lower(coalesce(v_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with listed as (
      select v.id as l_id, v.case_id as l_case, coalesce(case_app.catalogue_text(v.document,'title',200),c.title) as l_title,
             case_app.catalogue_text(v.document, 'summary', 1200) as l_summary,
             case_app.catalogue_text(v.document, 'audience', 200) as l_audience,
             case_app.catalogue_text(v.document, 'setting', 200) as l_setting,
             case_app.catalogue_duration(v.document) as l_duration,
             v.version_no as l_version, v.published_at as l_published,
             v.content_sha256::bytea as l_digest, a.descriptor as l_art,
             case when c.workspace_id=p_workspace_id then c.group_id end as l_group, g.name as l_group_name, coalesce(g.tint, 'neutral') as l_tint
        from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.case_versions v on v.id = lv.version_id
        join case_app.cases c on c.id = v.case_id
        left join case_app.case_groups g on g.id = c.group_id and c.workspace_id=p_workspace_id
        left join case_app.case_version_art a on a.case_version_id = v.id
       where lv.latest
    ), filtered as (
      select * from listed l
       where (v_query is null or lower(l.l_title) like v_pattern escape '\' or
              lower(coalesce(l.l_summary, '')) like v_pattern escape '\' or
              lower(coalesce(l.l_audience, '')) like v_pattern escape '\')
         and (p_duration is null or l.l_duration = p_duration)
         and (p_audience is null or l.l_audience = p_audience)
         and (p_group_id is null or l.l_group = p_group_id)
         and (not p_ungrouped or l.l_group is null)
    )
    select f.l_id, f.l_case, f.l_title, f.l_summary, f.l_audience, f.l_setting, f.l_duration,
           f.l_version, f.l_published, f.l_digest, f.l_art, f.l_group, f.l_group_name, f.l_tint, count(*) over ()
      from filtered f
     order by
       case when p_sort = 'title' and not p_descending then lower(f.l_title) end asc nulls last,
       case when p_sort = 'title' and p_descending then lower(f.l_title) end desc nulls last,
       case when p_sort = 'length' and not p_descending then f.l_duration end asc nulls last,
       case when p_sort = 'length' and p_descending then f.l_duration end desc nulls last,
       case when p_sort = 'audience' and not p_descending then lower(f.l_audience) end asc nulls last,
       case when p_sort = 'audience' and p_descending then lower(f.l_audience) end desc nulls last,
       case when p_sort = 'group' and not p_descending then lower(f.l_group_name) end asc nulls last,
       case when p_sort = 'group' and p_descending then lower(f.l_group_name) end desc nulls last,
       case when p_sort = 'published' and not p_descending then f.l_published end asc nulls last,
       case when p_sort = 'published' and p_descending then f.l_published end desc nulls last,
       f.l_published desc, f.l_id desc
     limit v_limit offset p_offset;
end;
$function$
;

CREATE OR REPLACE FUNCTION case_api.builder_list_draft_summaries(p_workspace_id uuid, p_limit integer, p_offset integer, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(case_id uuid, title text, revision bigint, updated_at timestamp with time zone, audience text, duration_min integer, art_structure jsonb, publication_version integer, publication_at timestamp with time zone, publication_state text, review_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
begin
 perform case_app.authorize(p_user_id,p_workspace_id,'P-14',p_admin,p_admin_email);
 if p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset not between 0 and 10000 or p_offset+p_limit>10000 then
  raise exception 'invalid_builder_draft_page' using errcode='22023';
 end if;
 return query
 with page as materialized (
  select c.id,coalesce(case_app.catalogue_text(d.document,'title',200),c.title) as label,
   coalesce(d.revision,0::bigint) as rev,coalesce(d.updated_at,c.updated_at) as saved,
   d.document,case when d.document is not null then case_app.builder_intent_digest(d.document,d.authoring_metadata) end as intent
  from case_app.cases c left join case_app.case_drafts d on d.case_id=c.id
  where (c.workspace_id=p_workspace_id or exists(select 1 from case_app.case_workspace_access s where s.case_id=c.id and s.workspace_id=p_workspace_id and s.level='edit')) and c.archived_at is null
   and (d.case_id is not null or not exists(select 1 from case_app.case_versions v where v.case_id=c.id))
  order by coalesce(d.updated_at,c.updated_at) desc,c.id desc offset p_offset limit p_limit+1
 )
 select p.id,p.label,p.rev,p.saved,case_app.catalogue_text(p.document,'audience',160),
  case_app.catalogue_duration(p.document),case_app.draft_art_summary(p.document),
  v.version_no,v.published_at,
  case when v.id is null then 'none' when released.intent_digest is null or p.intent is null then 'unknown'
   when released.intent_digest=p.intent then 'unchanged' else 'changed' end,
  reviewed.status
 from page p
 left join lateral(select cv.id,cv.version_no,cv.published_at from case_app.case_versions cv where cv.case_id=p.id order by cv.version_no desc limit 1) v on true
 left join case_app.builder_candidates released on released.released_version_id=v.id
 left join lateral(select b.status from case_app.builder_candidates b where b.case_id=p.id
   and b.revision=p.rev and b.intent_digest=p.intent and b.status in ('pending','approved')
   order by b.submitted_at desc,b.candidate_id desc limit 1) reviewed on true
 order by p.saved desc,p.id desc;
end; $function$
;

CREATE OR REPLACE FUNCTION case_api.builder_list_drafts(p_workspace_id uuid, p_limit integer, p_offset integer, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(case_id uuid, title text, revision bigint, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform case_app.authorize(p_user_id,p_workspace_id,'P-14',p_admin,p_admin_email);
  if p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset not between 0 and 10000 or p_offset+p_limit>10000 then
    raise exception 'invalid_builder_draft_page' using errcode='22023';
  end if;
  return query
    select c.id,coalesce(case_app.catalogue_text(d.document,'title',200),c.title),coalesce(d.revision,0::bigint),coalesce(d.updated_at,c.updated_at)
      from case_app.cases c
      left join case_app.case_drafts d on c.id=d.case_id
     where (c.workspace_id=p_workspace_id or exists(select 1 from case_app.case_workspace_access s where s.case_id=c.id and s.workspace_id=p_workspace_id and s.level='edit')) and c.archived_at is null
       and (d.case_id is not null or not exists(select 1 from case_app.case_versions v where v.case_id=c.id))
     order by coalesce(d.updated_at,c.updated_at) desc,c.id desc
     offset p_offset limit p_limit+1;
end; $function$
;

create or replace function case_app.case_sees_asset(p_user_id uuid,p_role text,p_case_id uuid,p_asset_id uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from case_app.assets a join case_app.cases c on c.id=p_case_id where a.id=p_asset_id and (
  exists(select 1 from case_app.case_assets ca where ca.asset_id=a.id and ca.case_id=c.id)
  or (a.workspace_id=c.workspace_id and (p_role='admin' or case_app.member_role(p_user_id,c.workspace_id) is not null))));
$$;

CREATE OR REPLACE FUNCTION case_api.builder_list_case_assets(p_case_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare v_role text; v_ws uuid := case_app.workspace_of_case(p_case_id); v_all boolean;
begin
  v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  if p_ids is not null and cardinality(p_ids) > 64 then raise exception 'invalid_asset' using errcode = '22023'; end if;
  v_all := v_role = 'admin' or case_app.member_role(p_user_id, v_ws) is not null;
  return coalesce((select jsonb_agg(case_app.asset_row(a) order by a.created_at desc, a.id desc) from case_app.assets a
    where a.id in (select b.id from case_app.assets b where (b.workspace_id = v_ws or exists(select 1 from case_app.case_assets ca where ca.asset_id=b.id and ca.case_id=p_case_id)) and b.kind in ('image', 'video')
      and (p_ids is null or b.id = any (p_ids))
      and (v_all or exists (select 1 from case_app.case_assets ca where ca.asset_id = b.id and ca.case_id = p_case_id))
      order by b.created_at desc, b.id desc limit 200)), '[]'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION case_api.builder_case_asset_rendition(p_case_id uuid, p_asset_id uuid, p_rendition text, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(status text, r2_key text, content_sha256 text, byte_size integer, content_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
declare v_role text;
begin
  v_role := case_app.authorize_case(p_user_id, p_case_id, 'P-14', p_admin, p_admin_email);
  if not case_app.case_sees_asset(p_user_id, v_role, p_case_id, p_asset_id) then return; end if;
  return query select a.status, case when a.status in ('quarantined','approved') then r.r2_key end,
      case when a.status in ('quarantined','approved') then encode(r.content_sha256, 'hex') end, r.byte_size, r.content_type
    from case_app.assets a join case_app.asset_renditions r on r.asset_id = a.id and r.rendition = p_rendition
    where a.id = p_asset_id and case_app.case_sees_asset(p_user_id,v_role,p_case_id,a.id);
end;
$function$
;

CREATE OR REPLACE FUNCTION case_api.room_media_manifest(p_version_id uuid, p_workspace_id uuid, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(asset_id uuid, status text, width integer, height integer, attribution text, display_key text, phone_key text, poster_key text, media_type text, duration_ms integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '2s'
AS $function$
begin
  -- Preserve the deployed Worker's empty/404 contract for missing and foreign versions.
  -- A matching version still requires access to that exact case, including for grant-only callers.
  perform case_app.authorize_records(p_user_id, p_workspace_id, 'P-21', p_admin, p_admin_email);
  if not exists (select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
                 where v.id = p_version_id and c.workspace_id = p_workspace_id) then return; end if;
  perform case_app.authorize_case(p_user_id, case_app.case_of_version(p_version_id), 'P-21', p_admin, p_admin_email);
  return query select a.id, a.status, a.width, a.height, a.attribution, d.r2_key, ph.r2_key, po.r2_key, a.media_type, a.duration_ms
    from case_app.case_version_assets cva
    join case_app.case_versions v on v.id = cva.case_version_id
    join case_app.cases c on c.id = v.case_id
    join case_app.assets a on a.id = cva.asset_id
    left join case_app.asset_renditions d on d.asset_id = a.id and d.rendition = 'display'
    left join case_app.asset_renditions ph on ph.asset_id = a.id and ph.rendition = 'phone'
    left join case_app.asset_renditions po on po.asset_id = a.id and po.rendition = 'poster'
    where cva.case_version_id = p_version_id and c.workspace_id = p_workspace_id and (a.workspace_id=p_workspace_id or exists(select 1 from case_app.case_assets ca where ca.asset_id=a.id and ca.case_id=c.id)) and a.kind in ('image', 'video')
    order by a.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION case_api.builder_release_candidate(p_case_id uuid, p_candidate_id uuid, p_expected_revision bigint, p_intent_digest bytea, p_content_sha256 bytea, p_asset_ids uuid[], p_art jsonb, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(candidate_id uuid, version_id uuid, version_no integer, content_sha256 bytea, intent_digest bytea, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid:=case_app.workspace_of_case(p_case_id); b case_app.builder_candidates%rowtype; d case_app.case_drafts%rowtype;
  v_no integer; v_id uuid; v_content case_app.sha256; v_release case_app.sha256; v_bad integer; v_delta bigint;
  v_assets uuid[]; v_role text; v_scope text;
begin
  v_role:=case_app.authorize_case(p_user_id,p_case_id,'P-15',p_admin,p_admin_email);
  select e.scope into v_scope from case_app.effective_role(p_user_id,v_ws,p_case_id) e;
  perform pg_advisory_xact_lock(4242,42); perform 1 from case_app.cases c where c.id=p_case_id for update;
  select * into b from case_app.builder_candidates x where x.case_id=p_case_id and x.candidate_id=p_candidate_id for update;
  if not found then raise exception 'candidate_missing' using errcode='P0002'; end if;
  select array_agg(distinct a order by a) into v_assets from unnest(coalesce(p_asset_ids,'{}')) a;
  v_release:=sha256(convert_to('builder-release-v1'||E'\n'||jsonb_build_object('candidate_id',p_candidate_id,'asset_ids',coalesce(to_jsonb(v_assets),'[]'::jsonb),'art',p_art)::text,'UTF8'));
  if b.status='released' then
    if b.released_version_id is null or b.release_digest<>v_release or b.revision<>p_expected_revision or
       b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 then raise exception 'release_replay_changed' using errcode='23514'; end if;
    return query select b.candidate_id,v.id,v.version_no,v.content_sha256::bytea,b.intent_digest::bytea,'released'::text
      from case_app.case_versions v where v.id=b.released_version_id; return;
  end if;
  if b.status<>'approved' or b.document is null or b.revision<>p_expected_revision or b.intent_digest<>p_intent_digest or b.content_sha256<>p_content_sha256 or
     b.approved_intent_digest<>b.intent_digest or b.approved_content_sha256<>b.content_sha256 then raise exception 'candidate_not_releasable' using errcode='23514'; end if;
  select * into d from case_app.case_drafts current_draft where current_draft.case_id=p_case_id for update;
  if not found or d.revision<>b.revision or d.document is distinct from b.document or d.authoring_metadata is distinct from b.authoring_metadata then raise exception 'candidate_stale' using errcode='40001'; end if;
  if not case_app.builder_sources_release_ready(b.document,b.authoring_metadata) then raise exception 'builder_review_metadata_unresolved' using errcode='23514'; end if;
  if p_art is null or not case_app.art_shape_ok(p_art) or (p_art-'attempt'-'summarised'-'renderer')<>case_app.art_structure(b.document) then raise exception 'art_mismatch' using errcode='22023'; end if;
  if cardinality(coalesce(p_asset_ids,'{}'))<>cardinality(coalesce(v_assets,'{}')) then raise exception 'duplicate_asset' using errcode='22023'; end if;
  select count(*) into v_bad from unnest(coalesce(v_assets,'{}')) a(id) join case_app.assets s on s.id=a.id where s.workspace_id<>v_ws and not exists(select 1 from case_app.case_assets ca where ca.asset_id=s.id and ca.case_id=p_case_id);
  if v_bad>0 then raise exception 'asset_not_in_workspace: % asset(s)',v_bad using errcode='23514'; end if;
  select count(*) into v_bad from unnest(coalesce(v_assets,'{}')) a(id) left join case_app.assets s on s.id=a.id where s.id is null or s.status not in ('quarantined','approved');
  if v_bad>0 then raise exception 'asset_unavailable: % asset(s)',v_bad using errcode='23514'; end if;
  -- Plan §0.5: a releaser who holds this case only by a grant may release only this case's images.
  if v_role<>'admin' and v_scope='case' and exists (select 1 from unnest(coalesce(v_assets,'{}')) a(id)
      where not exists (select 1 from case_app.case_assets ca where ca.asset_id=a.id and ca.case_id=p_case_id)) then
    raise exception 'asset_unavailable: not this case''s image' using errcode='23514'; end if;
  -- The candidate body moves into case_versions (net document bytes cancel); private metadata is
  -- removed and the immutable version's descriptor is newly retained.
  v_delta:=-coalesce(pg_column_size(b.authoring_metadata),0)+pg_column_size(p_art);
  perform case_app.builder_assert_quota(v_ws,v_delta);
  if v_role='admin' then perform case_app.ensure_admin_profile(p_user_id); end if;
  select coalesce(max(v.version_no),0)+1 into v_no from case_app.case_versions v where v.case_id=p_case_id;
  v_content:=sha256(convert_to(b.document::text,'UTF8'));
  insert into case_app.case_versions(case_id,version_no,schema_version,document,content_sha256,published_by)
    values(p_case_id,v_no,b.schema_version,b.document,v_content,p_user_id) returning id into v_id;
  insert into case_app.case_version_assets(case_version_id,asset_id) select v_id,a.id from unnest(coalesce(v_assets,'{}')) a(id) on conflict do nothing;
  set constraints case_app.case_versions_asset_set immediate;
  set constraints case_app.case_versions_asset_set deferred;
  insert into case_app.case_version_art(case_version_id,descriptor,renderer_version) values(v_id,p_art,(p_art->>'renderer')::integer);
  update case_app.builder_candidates as target set status='released',document=null,authoring_metadata=null,body_deleted_at=clock_timestamp(),
    released_version_id=v_id,release_digest=v_release,released_at=clock_timestamp() where target.candidate_id=p_candidate_id;
  update case_app.cases as target set updated_at=clock_timestamp() where target.id=p_case_id;
  insert into case_app.case_assets(asset_id,case_id,linked_by) select a.id,p_case_id,p_user_id from unnest(coalesce(v_assets,'{}')) a(id) on conflict do nothing;
  perform case_app.audit_actor(v_ws,p_user_id,p_admin_email,v_role,'version_publish','version',v_id,v_no::bigint,null);
  return query select p_candidate_id,v_id,v_no,v_content::bytea,b.intent_digest::bytea,'released'::text;
end; $function$
;

CREATE OR REPLACE FUNCTION case_app.unused_assets(p_workspace_id uuid)
 RETURNS SETOF case_app.assets
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select a.* from case_app.assets a
   where a.workspace_id = p_workspace_id and a.status in ('quarantined', 'approved') and a.kind in ('image', 'video')
     and a.created_at < clock_timestamp() - interval '1 day'
     and not exists (select 1 from case_app.case_version_assets v where v.asset_id = a.id)
     and not exists (select 1 from case_app.case_drafts d join case_app.cases c on c.id = d.case_id
       where a.id = any (case_app.document_asset_ids(d.document)))
     and not exists (select 1 from case_app.builder_candidates b where b.document is not null
       and a.id = any (case_app.document_asset_ids(b.document)))
     and not exists (select 1 from case_app.builder_checkpoints k where k.deleted_at is null
       and a.id = any (case_app.document_asset_ids(k.document)));
$function$
;

CREATE OR REPLACE FUNCTION case_api.create_session(p_session_id uuid, p_case_version_id uuid, p_workspace_id uuid, p_facilitator_id uuid, p_join_code text, p_ttl interval DEFAULT '12:00:00'::interval, p_admin boolean DEFAULT false, p_admin_email text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_role text;
begin
  if p_session_id is null or p_session_id::text !~
     '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'session_id_must_be_uuidv7' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(4242,42);
  perform 1 from case_app.cases c where c.id=case_app.case_of_version(p_case_version_id) for update;
  v_role := case_app.authorize_case(p_facilitator_id, case_app.case_of_version(p_case_version_id), 'P-21', p_admin, p_admin_email);
  if not exists (
    select 1 from case_app.case_versions v join case_app.cases c on c.id = v.case_id
     where v.id = p_case_version_id and c.workspace_id = p_workspace_id and
       not exists (select 1 from case_app.admin_version_state av
         where av.case_version_id = v.id and av.status = 'withdrawn')
  ) then
    raise exception 'not_authorised: version unavailable' using errcode = '42501';
  end if;
  if v_role = 'admin' then perform case_app.ensure_admin_profile(p_facilitator_id); end if;
  insert into case_app.sessions (id, case_version_id, workspace_id, facilitator_id, join_code, expires_at)
  values (p_session_id, p_case_version_id, p_workspace_id, p_facilitator_id, p_join_code,
          now() + greatest(interval '1 minute', least(coalesce(p_ttl, interval '12 hours'), interval '24 hours')));
  if v_role = 'admin' then
    perform case_app.audit_admin(p_workspace_id, p_facilitator_id, p_admin_email, 'room_start', 'room', p_session_id);
  end if;
  return p_session_id;
end;
$function$
;


create function case_api.workspace_details(p_user_id uuid,p_workspace_id uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
begin
 perform case_app.authorize(p_user_id,p_workspace_id,'P-12',p_admin,p_admin_email);
 return (select jsonb_build_object('id',w.id,'name',w.name,'revision',w.details_revision) from case_app.workspaces w where w.id=p_workspace_id);
end $$;
create function case_api.update_workspace_details(p_user_id uuid,p_workspace_id uuid,p_expected_revision bigint,p_name text,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='2s' as $$
declare w case_app.workspaces%rowtype; r text;
begin
 r:=case_app.authorize(p_user_id,p_workspace_id,'P-17',p_admin,p_admin_email);
 if p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_expected_revision is null or p_expected_revision<0 then
  raise exception 'invalid_workspace_details' using errcode='22023'; end if;
 select * into w from case_app.workspaces where id=p_workspace_id for update;
 if w.details_revision<>p_expected_revision then raise exception 'workspace_details_conflict' using errcode='40001';end if;
 if w.name<>btrim(p_name) then
  update case_app.workspaces set name=btrim(p_name),details_revision=details_revision+1 where id=p_workspace_id returning * into w;
  perform case_app.audit_actor(w.id,p_user_id,p_admin_email,r,'workspace_rename','workspace',w.id,w.details_revision,null);
 end if;
 return jsonb_build_object('id',w.id,'name',w.name,'revision',w.details_revision);
end $$;
create function case_api.case_workspace_access(p_user_id uuid,p_case_id uuid,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare c case_app.cases%rowtype; manager boolean:=false; entries jsonb:='[]'; destinations jsonb:='[]';
begin
 perform case_app.authorize_case(p_user_id,p_case_id,'P-11',p_admin,p_admin_email);
 select * into c from case_app.cases where id=p_case_id and archived_at is null;
 if not found then raise exception 'case_not_found' using errcode='P0002';end if;
 manager:=coalesce(p_admin or case_app.member_role(p_user_id,c.workspace_id)=any(case_app.action_roles('P-17')),false);
 if manager then
  select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'level',s.level) order by w.name,w.id),'[]') into entries
   from case_app.case_workspace_access s join case_app.workspaces w on w.id=s.workspace_id where s.case_id=c.id;
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'canMove',d.can_move) order by d.name,d.id),'[]') into destinations from (
   select w.id,w.name,coalesce(p_admin or case_app.member_role(p_user_id,w.id)=any(case_app.action_roles('P-17')),false) can_move from case_app.workspaces w
    where w.id<>c.workspace_id and (p_admin or case_app.member_role(p_user_id,w.id)=any(case_app.action_roles('P-14'))) order by w.name,w.id limit 100) d;
 end if;
 return jsonb_build_object('caseId',c.id,'homeWorkspaceId',c.workspace_id,'homeWorkspaceName',(select w.name from case_app.workspaces w where w.id=c.workspace_id),
  'revision',c.placement_revision,'canManage',manager,'access',entries,'destinations',destinations);
end $$;
create function case_api.set_case_workspace_access(p_user_id uuid,p_case_id uuid,p_workspace_id uuid,p_level text,p_expected_revision bigint,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='2s' as $$
declare c case_app.cases%rowtype; r text;
begin
 perform pg_advisory_xact_lock(4242,42);
 select * into c from case_app.cases where id=p_case_id for update;
 r:=case_app.authorize(p_user_id,c.workspace_id,'P-17',p_admin,p_admin_email);
 if c.archived_at is not null then raise exception 'case_archived' using errcode='23514';end if;
 if p_expected_revision is null or p_expected_revision<>c.placement_revision then raise exception 'placement_conflict' using errcode='40001';end if;
 if p_workspace_id is null or p_workspace_id=c.workspace_id or (p_level is not null and p_level not in ('run','edit')) then raise exception 'invalid_workspace_access' using errcode='22023';end if;
 if p_level is null then delete from case_app.case_workspace_access where case_id=c.id and workspace_id=p_workspace_id;
 else
  perform case_app.authorize(p_user_id,p_workspace_id,'P-14',p_admin,p_admin_email);
  if not exists(select 1 from case_app.case_workspace_access where case_id=c.id and workspace_id=p_workspace_id) and (select count(*) from case_app.case_workspace_access where case_id=c.id)>=100 then raise exception 'too_many_workspaces' using errcode='23514';end if;
  insert into case_app.case_workspace_access(case_id,workspace_id,level) values(c.id,p_workspace_id,p_level)
   on conflict(case_id,workspace_id) do update set level=excluded.level;
 end if;
 update case_app.cases set placement_revision=placement_revision+1 where id=c.id;
 perform case_app.audit_actor(c.workspace_id,p_user_id,p_admin_email,r,case when p_level is null then 'case_workspace_revoke' else 'case_workspace_share' end,'case',c.id,c.placement_revision+1,null);
 return case_api.case_workspace_access(p_user_id,c.id,p_admin,p_admin_email);
end $$;
create function case_api.move_case_workspace(p_user_id uuid,p_case_id uuid,p_workspace_id uuid,p_expected_revision bigint,p_admin boolean,p_admin_email text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='2s' as $$
declare c case_app.cases%rowtype; r text;
begin
 perform pg_advisory_xact_lock(4242,42);
 select * into c from case_app.cases where id=p_case_id for update;
 r:=case_app.authorize(p_user_id,c.workspace_id,'P-17',p_admin,p_admin_email);
 perform case_app.authorize(p_user_id,p_workspace_id,'P-17',p_admin,p_admin_email);
 if c.archived_at is not null then raise exception 'case_archived' using errcode='23514';end if;
 if p_expected_revision is null or p_expected_revision<>c.placement_revision then raise exception 'placement_conflict' using errcode='40001';end if;
 if p_workspace_id is null or p_workspace_id=c.workspace_id then raise exception 'invalid_workspace_move' using errcode='22023';end if;
 if exists(select 1 from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id where v.case_id=c.id and s.status in ('lobby','live') and s.expires_at>clock_timestamp())
  or exists(select 1 from case_app.builder_candidates b where b.case_id=c.id and b.status in ('pending','approved')) then
  raise exception 'case_in_use: end active sessions and resolve review before moving' using errcode='55006';end if;
 -- Current saved checkpoint ownership follows the canonical draft; immutable past sessions and released versions do not.
 update case_app.builder_checkpoints set workspace_id=p_workspace_id where case_id=c.id and deleted_at is null;
 delete from case_app.case_workspace_access where case_id=c.id and workspace_id=p_workspace_id;
 update case_app.cases set workspace_id=p_workspace_id,group_id=null,group_revision=group_revision+1,placement_revision=placement_revision+1 where id=c.id;
 perform case_app.audit_actor(c.workspace_id,p_user_id,p_admin_email,r,'case_workspace_move','case',c.id,c.placement_revision+1,null);
 perform case_app.audit_actor(p_workspace_id,p_user_id,p_admin_email,r,'case_workspace_move','case',c.id,c.placement_revision+1,null);
 return case_api.case_workspace_access(p_user_id,c.id,p_admin,p_admin_email);
end $$;
revoke all on function case_api.workspace_details(uuid,uuid,boolean,text),
 case_api.update_workspace_details(uuid,uuid,bigint,text,boolean,text),case_api.case_workspace_access(uuid,uuid,boolean,text),
 case_api.set_case_workspace_access(uuid,uuid,uuid,text,bigint,boolean,text),case_api.move_case_workspace(uuid,uuid,uuid,bigint,boolean,text)
 from public,anon,authenticated,service_role;
grant execute on function case_api.workspace_details(uuid,uuid,boolean,text),
 case_api.update_workspace_details(uuid,uuid,bigint,text,boolean,text),case_api.case_workspace_access(uuid,uuid,boolean,text),
 case_api.set_case_workspace_access(uuid,uuid,uuid,text,bigint,boolean,text),case_api.move_case_workspace(uuid,uuid,uuid,bigint,boolean,text) to service_role;
-- CASE-375: a move never transfers historical workspace records. A starter keeps their own record
-- through current canonical-case access; destination managers gain no access to anyone else's history.
create function case_app.record_case_role(p_user_id uuid,p_case_id uuid) returns text
language sql stable set search_path='' as $$
 select case when e.role='owner' then 'author' else e.role end
 from case_app.cases c cross join lateral case_app.effective_role(p_user_id,c.workspace_id,c.id) e
 where c.id=p_case_id;
$$;
revoke all on function case_app.record_case_role(uuid,uuid) from public,anon,authenticated,service_role;
create or replace function case_app.record_visible(p_user_id uuid,p_member boolean,p_all boolean,p_starter uuid,p_case_id uuid)
returns boolean language sql stable set search_path='' as $$
 select p_all or (p_starter=p_user_id and (p_member or case_app.record_case_role(p_user_id,p_case_id) is not null));
$$;
create or replace function case_app.authorize_records(p_user_id uuid,p_workspace_id uuid,p_action text,p_admin boolean,p_admin_email text)
returns text language plpgsql stable set search_path='' as $$
declare v_role text;
begin
 begin return case_app.authorize(p_user_id,p_workspace_id,p_action,p_admin,p_admin_email);
 exception when insufficient_privilege then
  if p_admin or p_user_id is null or p_workspace_id is null or not case_api.admin_account_active(p_user_id) then raise;end if;
  select held.r into v_role from (
   select case_app.grant_role(p_user_id,c.id) r from case_app.cases c
    where c.workspace_id=p_workspace_id and c.archived_at is null and (
     exists(select 1 from case_app.case_grants g where g.case_id=c.id and g.user_id=p_user_id and g.revoked_at is null)
     or exists(select 1 from case_app.case_workspace_access a where a.case_id=c.id and case_app.member_role(p_user_id,a.workspace_id) is not null))
   union all
   select case_app.record_case_role(p_user_id,v.case_id) from case_app.sessions s
    join case_app.case_versions v on v.id=s.case_version_id
    where p_action in ('P-32','P-34','P-37') and s.workspace_id=p_workspace_id and s.facilitator_id=p_user_id
  ) held where held.r=any(case_app.action_case_roles(p_action)) order by case_app.role_rank(held.r) desc limit 1;
  if v_role is null then raise;end if;return v_role;
 end;
end $$;
create function case_app.authorize_session_record(p_user_id uuid,p_session_id uuid,p_action text,p_admin boolean,p_admin_email text)
returns text language plpgsql stable set search_path='' as $$
declare s case_app.sessions; r text;
begin
 if p_action not in ('P-34','P-37') then raise exception 'invalid_record_action' using errcode='22023';end if;
 select * into s from case_app.sessions where id=p_session_id;
 if not found then raise exception 'session_not_found' using errcode='P0002';end if;
 begin
  r:=case_app.authorize(p_user_id,s.workspace_id,p_action,p_admin,p_admin_email);
  if r='admin' or s.facilitator_id=p_user_id or (r='owner' and case_app.policy_allows(p_action,r,case_app.policies_of(s.workspace_id))) then return r;end if;
 exception when insufficient_privilege then null;
 end;
 if s.facilitator_id is distinct from p_user_id then raise exception 'not_starter' using errcode='42501';end if;
 perform case_app.authorize_case(p_user_id,case_app.case_of_version(s.case_version_id),p_action,p_admin,p_admin_email);
 return case_app.record_case_role(p_user_id,case_app.case_of_version(s.case_version_id));
end $$;
revoke all on function case_app.authorize_session_record(uuid,uuid,text,boolean,text) from public,anon,authenticated,service_role;
-- Keep each existing reader's projection/cursor/media/feedback body intact; replace only the admission block.
do $historical_readers$
declare f text; d text; pattern text; replacement text;
begin
 foreach f in array array['read_session_portfolio','session_media_rendition','session_feedback_summary'] loop
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='case_api' and p.proname=f;
  pattern:='(role|v_role)\s*:=\s*case_app.authorize_case\([^;]+;\s*if [^;]+then raise exception ''not_starter'' using errcode=''42501'';\s*end if;';
  if (select count(*) from regexp_matches(d,pattern,'g'))<>1 then raise exception 'unexpected_record_admission: %',f;end if;
  replacement:=case when f='session_feedback_summary' then 'v_role' else 'role' end||':=case_app.authorize_session_record(p_user_id,p_session_id,'||quote_literal(case when f='session_feedback_summary' then 'P-37' else 'P-34' end)||',p_admin,p_admin_email);';
  d:=regexp_replace(d,pattern,replacement);
  if f='session_media_rendition' then d:=replace(d,'a.id = cva.asset_id and a.workspace_id = s.workspace_id','a.id = cva.asset_id');end if;
  execute d;
 end loop;
end $historical_readers$;
create function case_api.personal_record_workspace_access(p_user_id uuid,p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
begin
 perform case_app.authorize_records(p_user_id,p_workspace_id,'P-32',false,null);
 return jsonb_build_object('workspaceId',p_workspace_id,'ownOnly',true);
end $$;
create function case_api.personal_record_workspaces(p_user_id uuid,p_after uuid)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
declare items jsonb; more boolean;
begin
 if p_user_id is null or not case_api.admin_account_active(p_user_id) then raise exception 'account_not_active' using errcode='42501';end if;
 with reachable as (
  select distinct w.id,w.name from case_app.sessions s join case_app.case_versions v on v.id=s.case_version_id
   join case_app.workspaces w on w.id=s.workspace_id
   where s.facilitator_id=p_user_id and s.started_at is not null and (p_after is null or w.id>p_after)
    and (case_app.member_role(p_user_id,w.id) is not null or case_app.record_case_role(p_user_id,v.case_id) is not null)
   order by w.id limit 101
 ), page as (select * from reachable order by id limit 100)
 select coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by id) from page),'[]'),(select count(*)>100 from reachable) into items,more;
 return jsonb_build_object('workspaces',items,'nextAfter',case when more then items->99->>'id' end);
end $$;
revoke all on function case_api.personal_record_workspace_access(uuid,uuid),case_api.personal_record_workspaces(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function case_api.personal_record_workspace_access(uuid,uuid),case_api.personal_record_workspaces(uuid,uuid) to service_role;

-- A writer waiting for the shared Builder lock must not reuse authority or a home read before a move/revocation.
do $writers$
declare n text; d text; action text; check_sql text;
begin
 foreach n in array array['save_draft','builder_save_draft','builder_cancel_candidate','builder_open_save_window',
  'builder_submit_candidate','builder_approve_candidate','builder_create_checkpoint','builder_delete_checkpoint',
  'builder_release_candidate','builder_restore_checkpoint','builder_delete_candidate_body'] loop
  select pg_get_functiondef(p.oid) into strict d from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='case_api' and p.proname=n and p.proargnames @> array['p_admin'] and (n<>'builder_create_checkpoint' or p.pronargs=6);
  if (length(d)-length(replace(d,'perform pg_advisory_xact_lock(4242,42);','')))/length('perform pg_advisory_xact_lock(4242,42);')<>1 then raise exception 'unexpected_builder_lock: %',n;end if;
  action:=case n when 'builder_approve_candidate' then 'P-33' when 'builder_release_candidate' then 'P-15' else 'P-14' end;
  check_sql:='perform pg_advisory_xact_lock(4242,42);'||chr(10)||
   ' if case_app.workspace_of_case(p_case_id) is distinct from v_ws then raise exception ''case_workspace_changed'' using errcode=''40001'';end if;'||chr(10)||
   case when n='builder_open_save_window' then ' perform ' else ' v_role:=' end||
   format('case_app.authorize_case(p_user_id,p_case_id,%L,p_admin,p_admin_email);',action);
  if n='builder_release_candidate' then check_sql:=check_sql||' select e.scope into v_scope from case_app.effective_role(p_user_id,v_ws,p_case_id) e;';end if;
  execute replace(d,'perform pg_advisory_xact_lock(4242,42);',check_sql);
 end loop;
end $writers$;
CREATE OR REPLACE FUNCTION case_api.builder_publication_readiness(p_case_id uuid, p_expected_revision bigint, p_user_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ws uuid:=case_app.workspace_of_case(p_case_id); d case_app.case_drafts%rowtype; b case_app.builder_candidates%rowtype; delta bigint; release_delta bigint;
begin
  perform case_app.authorize_case(p_user_id,p_case_id,'P-14',p_admin,p_admin_email);
  select * into d from case_app.case_drafts where case_id=p_case_id;
  if not found or not d.builder_managed or d.revision<>p_expected_revision then return query select 'revision_conflict'::text; return; end if;
  if not case_app.builder_sources_release_ready(d.document,d.authoring_metadata) then return query select 'builder_review_metadata_unresolved'::text; end if;
  select * into b from case_app.builder_candidates c where c.case_id=p_case_id and c.revision=d.revision
    and c.intent_digest=case_app.builder_intent_digest(d.document,d.authoring_metadata) and c.status in ('pending','approved','released') order by c.submitted_at desc limit 1;
  if b.status='released' then return; end if;
  release_delta:=greatest(0,-pg_column_size(d.authoring_metadata)+pg_column_size(case_app.art_structure(d.document)||'{"attempt":0,"summarised":false,"renderer":1}'::jsonb));
  if b.candidate_id is null then
    if ((select count(*) from case_app.builder_candidates c where c.case_id=p_case_id)+(select count(*) from case_app.builder_submission_receipts r where r.case_id=p_case_id))>=1000 then return query select 'builder_candidate_history_limit'::text; end if;
    if (select count(*) from case_app.builder_candidates c where c.case_id=p_case_id and c.status in ('superseded','cancelled') and c.document is not null)>=3 then return query select 'builder_retained_candidate_limit'::text; end if;
    delta:=pg_column_size(d.document)+pg_column_size(d.authoring_metadata)+512+release_delta;
  else delta:=release_delta; end if;
  if case_app.builder_usage_bytes(ws)+delta>104857600 or case_app.builder_usage_bytes(null)+delta>262144000 then return query select 'builder_storage_quota'::text; end if;
  if exists(select 1 from (
    select jsonb_array_elements_text(s->'asset_ids')::uuid id from jsonb_array_elements(coalesce(d.document->'surfaces','[]')) s
    union select (x->>'asset_id')::uuid from jsonb_array_elements(coalesce(d.document->'blocks','[]')) x where x->>'type'='image'
  ) refs left join case_app.assets a on a.id=refs.id where a.id is null or a.status not in ('quarantined','approved') or (a.workspace_id<>ws and not exists(select 1 from case_app.case_assets ca where ca.asset_id=a.id and ca.case_id=p_case_id))) then return query select 'asset_not_approved'::text; end if;
end; $function$
;
CREATE OR REPLACE FUNCTION case_api.list_case_catalogue_groups(p_user_id uuid, p_workspace_id uuid, p_admin boolean, p_admin_email text)
 RETURNS TABLE(group_id uuid, name text, tint text, case_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  perform case_app.authorize(p_user_id, p_workspace_id, 'P-11', p_admin, p_admin_email);
  return query
    with listed as (
      select case when c.workspace_id=p_workspace_id then c.group_id end as l_group from case_app.catalogue_versions(p_workspace_id) lv
        join case_app.cases c on c.id = lv.case_id where lv.latest
    ), grp_rows as (
      select g.id as r_id, g.name as r_name, g.tint as r_tint,
             (select count(*) from listed l where l.l_group = g.id) as r_count, 0 as r_ord, lower(g.name) as r_key
        from case_app.case_groups g where g.workspace_id = p_workspace_id and g.archived_at is null
      union all
      select null, null, 'neutral', (select count(*) from listed l where l.l_group is null), 1, null
    )
    select r.r_id, r.r_name, r.r_tint, r.r_count from grp_rows r order by r.r_ord, r.r_key, r.r_id;
end;
$function$
;
commit;
