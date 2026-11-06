-- CASE-280: publishing stays immutable; an explicit edition marker appears only in History.
begin;
create table case_app.publication_history (
  version_id uuid primary key references case_app.case_versions(id) on delete restrict,
  new_edition boolean not null
);
alter table case_app.publication_history enable row level security;
revoke all on case_app.publication_history from public,anon,authenticated,service_role;

create function case_api.builder_release_update(p_case_id uuid,p_candidate_id uuid,p_expected_revision bigint,p_intent_digest bytea,p_content_sha256 bytea,
  p_asset_ids uuid[],p_art jsonb,p_new_edition boolean,p_user_id uuid,p_admin boolean,p_admin_email text)
returns table(candidate_id uuid,version_id uuid,version_no integer,content_sha256 bytea,intent_digest bytea,status text)
language plpgsql security definer set search_path='' as $$
declare released record; recorded boolean;
begin
  if p_new_edition is null then raise exception 'invalid_publication_kind' using errcode='22023'; end if;
  -- The existing RPC owns authorization, approval, exact-draft fencing, media and atomic release.
  select * into strict released from case_api.builder_release_candidate(p_case_id,p_candidate_id,p_expected_revision,p_intent_digest,p_content_sha256,
    p_asset_ids,p_art,p_user_id,p_admin,p_admin_email);
  insert into case_app.publication_history(version_id,new_edition) values(released.version_id,p_new_edition) on conflict do nothing;
  select h.new_edition into strict recorded from case_app.publication_history h where h.version_id=released.version_id;
  if recorded is distinct from p_new_edition then raise exception 'release_replay_changed' using errcode='23514'; end if;
  return query select released.candidate_id,released.version_id,released.version_no,released.content_sha256,released.intent_digest,released.status;
end;
$$;
revoke all on function case_api.builder_release_update(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,boolean,uuid,boolean,text) from public,anon,authenticated;
grant execute on function case_api.builder_release_update(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,boolean,uuid,boolean,text) to service_role;

-- Expand with a new detail RPC. Staging shares this database: current production keeps its exact old output.
create or replace function case_api.get_catalogue_case_history(
  p_user_id uuid, p_case_id uuid, p_version_no integer,
  p_admin boolean default false, p_admin_email text default null
) returns table (
  workspace_id uuid, role text, version_id uuid, case_id uuid, title text, summary text,
  audience text, setting text, duration_min integer, learning_objectives jsonb, version_no integer,
  published_at timestamptz, content_sha256 bytea, art jsonb, versions jsonb
) language plpgsql stable security definer set search_path = '' as $$
declare v_ws uuid; v_role text;
begin
  if p_user_id is null or p_case_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_catalogue_case' using errcode = '22023'; end if;
  if not case_api.admin_account_active(p_user_id) then
    raise exception 'account_not_active' using errcode = '42501'; end if;
  v_ws := case_app.workspace_of_case(p_case_id);
  if v_ws is null then return; end if;
  begin
    v_role := case_app.authorize(p_user_id, v_ws, 'P-11', p_admin, p_admin_email);
  exception when insufficient_privilege then return;
  end;
  return query
    select c.workspace_id, v_role, v.id, v.case_id, coalesce(case_app.catalogue_text(v.document,'title',200),c.title),
           case_app.catalogue_text(v.document, 'summary', 1200),
           case_app.catalogue_text(v.document, 'audience', 200),
           case_app.catalogue_text(v.document, 'setting', 200),
           case_app.catalogue_duration_current(v.document),
           case when jsonb_typeof(v.document -> 'learning_objectives') = 'array' then coalesce((
             select jsonb_agg(left(btrim(o.value #>> '{}'), 300) order by o.n)
               from jsonb_array_elements(v.document -> 'learning_objectives') with ordinality as o(value, n)
              where jsonb_typeof(o.value) = 'string' and btrim(o.value #>> '{}') <> '' and o.n <= 8), '[]'::jsonb)
             else '[]'::jsonb end,
           v.version_no, v.published_at, v.content_sha256::bytea, a.descriptor,
           (select coalesce(jsonb_agg(jsonb_build_object('version_id', o.id, 'version_no', o.version_no,
                     'edition', exists(select 1 from case_app.publication_history h where h.version_id=o.id and h.new_edition),
                     'published_at', o.published_at, 'content_sha256', '\x' || encode(o.content_sha256, 'hex'))
                     order by o.version_no desc), '[]'::jsonb)
              from (select ov.id, ov.version_no, ov.published_at, ov.content_sha256
                      from case_app.case_versions ov
                     where ov.case_id = v.case_id and
                           not exists (select 1 from case_app.admin_version_state av
                                        where av.case_version_id = ov.id and av.status = 'withdrawn')
                     order by ov.version_no desc limit 50) o)
      from case_app.case_versions v
      join case_app.cases c on c.id = v.case_id
      left join case_app.case_version_art a on a.case_version_id = v.id
     where v.case_id = p_case_id and v.version_no = p_version_no and c.archived_at is null and
           not exists (select 1 from case_app.admin_version_state av
                        where av.case_version_id = v.id and av.status = 'withdrawn');
end;
$$;
revoke all on function case_api.get_catalogue_case_history(uuid,uuid,integer,boolean,text) from public,anon,authenticated;
grant execute on function case_api.get_catalogue_case_history(uuid,uuid,integer,boolean,text) to service_role;
commit;
