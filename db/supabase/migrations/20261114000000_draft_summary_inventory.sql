-- CASE-364. CLI-generated 2026-11-04; numbered after the existing logical 20261113 chain.
-- Additive service-only summary; legacy inventory and writes are unchanged.
begin;
create function case_app.draft_art_summary(p_document jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb;
begin
 if jsonb_typeof(p_document->'beats') is distinct from 'array' then return null; end if;
 result:=case_app.art_structure(p_document);
 if octet_length(result::text)>4096 then return null; end if;
 return result;
exception when data_exception then return null;
end; $$;
revoke all on function case_app.draft_art_summary(jsonb) from public,anon,authenticated,service_role;

create function case_api.builder_list_draft_summaries(
 p_workspace_id uuid,p_limit integer,p_offset integer,p_user_id uuid,p_admin boolean,p_admin_email text
) returns table(case_id uuid,title text,revision bigint,updated_at timestamptz,
 audience text,duration_min integer,art_structure jsonb,publication_version integer,
 publication_at timestamptz,publication_state text,review_status text)
language plpgsql stable security definer set search_path='' set statement_timeout='2s' as $$
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
  where c.workspace_id=p_workspace_id and c.archived_at is null
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
end; $$;
revoke all on function case_api.builder_list_draft_summaries(uuid,integer,integer,uuid,boolean,text) from public,anon,authenticated,service_role;
grant execute on function case_api.builder_list_draft_summaries(uuid,integer,integer,uuid,boolean,text) to service_role;
commit;
