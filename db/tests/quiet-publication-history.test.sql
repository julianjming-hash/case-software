-- CASE-280: quiet updates and explicit editions preserve approval, immutable rooms and exact replay.
begin;
do $$
declare
  author_id uuid:=case_app.uuid_v7(); reviewer_id uuid:=case_app.uuid_v7(); ws uuid:=case_app.uuid_v7(); cid uuid:=case_app.uuid_v7();
  document jsonb:='{"schema_version":1,"case_title":"Synthetic history","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb;
  metadata jsonb:='{"metadata_version":1}'::jsonb;
  first_document jsonb:=document;
  operation record; candidate record; released record; replay record; detail record; art jsonb; first_id uuid;
begin
  insert into auth.users values(author_id),(reviewer_id);
  insert into case_app.profiles(id,display_name) values(author_id,'Author'),(reviewer_id,'Reviewer');
  insert into case_app.workspaces(id,slug,name) values(ws,'quiet-history-test','Quiet history');
  insert into case_app.workspace_members(workspace_id,user_id,role) values(ws,author_id,'author');
  insert into case_app.cases(id,workspace_id,owner_id,title) values(cid,ws,author_id,'Synthetic history');
  art:=case_app.art_structure(document)||'{"attempt":0,"summarised":false,"renderer":1}'::jsonb;
  for revision in 1..2 loop
    if revision=2 then document:=jsonb_set(document,'{case_title}','"Synthetic history updated"'); end if;
    select * into operation from case_api.builder_open_save_window(cid,revision-1,author_id,false,null);
    perform case_api.builder_save_draft(cid,operation.operation_id,document,metadata,author_id,false,null);
    select * into candidate from case_api.builder_submit_candidate(cid,case_app.uuid_v7(),revision,document,metadata,author_id,false,null);
    begin
      perform case_api.builder_release_update(cid,candidate.candidate_id,revision,candidate.intent_digest,candidate.content_sha256,'{}',art,revision=2,author_id,false,null);
      raise exception 'quiet history allowed author release';
    exception when insufficient_privilege then null; end;
    perform case_api.builder_approve_candidate(cid,candidate.candidate_id,revision,candidate.intent_digest,candidate.content_sha256,reviewer_id,true,'reviewer@example.test');
    select * into released from case_api.builder_release_update(cid,candidate.candidate_id,revision,candidate.intent_digest,candidate.content_sha256,'{}',art,revision=2,reviewer_id,true,'reviewer@example.test');
    if revision=1 then first_id:=released.version_id; end if;
    if (select h.new_edition from case_app.publication_history h where h.version_id=released.version_id) is distinct from (revision=2) then raise exception 'publication kind not recorded'; end if;
    select * into replay from case_api.builder_release_update(cid,candidate.candidate_id,revision,candidate.intent_digest,candidate.content_sha256,'{}',art,revision=2,reviewer_id,true,'reviewer@example.test');
    if replay.version_id<>released.version_id then raise exception 'history replay published another snapshot'; end if;
    begin
      perform case_api.builder_release_update(cid,candidate.candidate_id,revision,candidate.intent_digest,candidate.content_sha256,'{}',art,revision<>2,reviewer_id,true,'reviewer@example.test');
      raise exception 'history replay changed edition';
    exception when check_violation then null; end;
  end loop;
  if (select count(*) from case_app.case_versions v where v.case_id=cid)<>2 then raise exception 'quiet updates lost immutable snapshots'; end if;
  if (select v.document from case_app.case_versions v where v.id=first_id) is distinct from first_document then raise exception 'quiet update rewrote old snapshot'; end if;
  select * into detail from case_api.get_catalogue_case_current(reviewer_id,cid,2,true,'reviewer@example.test');
  if detail.versions->0 ? 'edition' then raise exception 'migration changed current production response'; end if;
  select * into detail from case_api.get_catalogue_case_history(reviewer_id,cid,2,true,'reviewer@example.test');
  if detail.versions->0->>'edition'<>'true' or detail.versions->1->>'edition'<>'false' then raise exception 'history edition projection differs from exact publication'; end if;
  if has_table_privilege('service_role','case_app.publication_history','insert') or has_table_privilege('anon','case_app.publication_history','select') or has_table_privilege('authenticated','case_app.publication_history','select') then raise exception 'history private table exposed'; end if;
  if has_function_privilege('anon','case_api.builder_release_update(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,boolean,uuid,boolean,text)','execute') or not has_function_privilege('service_role','case_api.builder_release_update(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,boolean,uuid,boolean,text)','execute') then raise exception 'history RPC grants differ'; end if;
end;
$$;
rollback;
