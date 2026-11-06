-- Bounded, content-free inventory for resuming durable Builder drafts.
begin;

create function case_api.builder_list_drafts(
  p_workspace_id uuid,p_limit integer,p_offset integer,p_user_id uuid,p_admin boolean,p_admin_email text
) returns table(case_id uuid,title text,revision bigint,updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform case_app.authorize(p_user_id,p_workspace_id,'P-14',p_admin,p_admin_email);
  if p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset not between 0 and 10000 or p_offset+p_limit>10000 then
    raise exception 'invalid_builder_draft_page' using errcode='22023';
  end if;
  return query
    select c.id,coalesce(case_app.catalogue_text(d.document,'title',200),c.title),coalesce(d.revision,0::bigint),coalesce(d.updated_at,c.updated_at)
      from case_app.cases c
      left join case_app.case_drafts d on c.id=d.case_id
     where c.workspace_id=p_workspace_id and c.archived_at is null
       and (d.case_id is not null or not exists(select 1 from case_app.case_versions v where v.case_id=c.id))
     order by coalesce(d.updated_at,c.updated_at) desc,c.id desc
     offset p_offset limit p_limit+1;
end; $$;

revoke all on function case_api.builder_list_drafts(uuid,integer,integer,uuid,boolean,text) from public,anon,authenticated,service_role;
grant execute on function case_api.builder_list_drafts(uuid,integer,integer,uuid,boolean,text) to service_role;

commit;
