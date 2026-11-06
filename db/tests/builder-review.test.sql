-- C46: immutable Pending identity, admin-only approval/release, supersession and exact replay.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000c601'),('0199a000-0000-7000-8000-00000000c602');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000c601','Author'),('0199a000-0000-7000-8000-00000000c602','Reviewer');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000c610','c46-test','C46 test');
insert into case_app.workspace_members(workspace_id,user_id,role) values ('0199a000-0000-7000-8000-00000000c610','0199a000-0000-7000-8000-00000000c601','author');
insert into case_app.cases(id,workspace_id,owner_id,title) values ('0199a000-0000-7000-8000-00000000c620','0199a000-0000-7000-8000-00000000c610','0199a000-0000-7000-8000-00000000c601','C46 synthetic');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
create temp table c46_values as
select case_app.uuid_v7() request_id, case_app.uuid_v7() restore_id, case_app.uuid_v7() next_request_id;
create temp table c46_doc as select '{"schema_version":1,"case_title":"Synthetic C46","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb document;
create temp table c46_meta as select '{"metadata_version":1,"sources":[],"provenance":[]}'::jsonb metadata;
do $$ declare source_id uuid:='0199a000-0000-7000-8000-00000000c640'; entity_id uuid:='0199a000-0000-7000-8000-00000000c641'; source jsonb;
  doc jsonb; missing jsonb; outside_range jsonb; unconfirmed jsonb; absent_path jsonb; absent_entity jsonb; begin
  doc:=jsonb_build_object('surfaces',jsonb_build_array(jsonb_build_object('id',entity_id,'scene','Synthetic scene')));
  source:=jsonb_build_object('id',source_id,'title','Synthetic source','text','one line','sha256',encode(sha256(convert_to('one line','UTF8')),'hex'),'rights_status','permitted');
  missing:=jsonb_build_object('metadata_version',1,'sources','[]'::jsonb,'provenance',jsonb_build_array(jsonb_build_object(
    'entity_id',entity_id,'field','surfaces.scene','source_id',source_id,'start_line',1,'end_line',1,'transformation','adapted','visibility','public','review_status','confirmed')));
  outside_range:=jsonb_build_object('metadata_version',1,'sources',jsonb_build_array(source),'provenance',jsonb_build_array(jsonb_build_object(
    'entity_id',entity_id,'field','surfaces.scene','source_id',source_id,'start_line',1,'end_line',2,'transformation','adapted','visibility','public','review_status','confirmed')));
  unconfirmed:=jsonb_set(outside_range,'{provenance,0,end_line}','1'::jsonb);
  unconfirmed:=jsonb_set(unconfirmed,'{provenance,0,review_status}','"unreviewed"'::jsonb);
  absent_path:=jsonb_set(outside_range,'{provenance,0,field}','"surfaces.absent"'::jsonb);
  absent_entity:=jsonb_set(outside_range,'{provenance,0,entity_id}','"0199a000-0000-7000-8000-00000000c642"'::jsonb);
  if case_app.builder_sources_release_ready(doc,missing) then raise exception 'C46 accepted unresolved provenance source reference'; end if;
  if case_app.builder_sources_release_ready(doc,outside_range) then raise exception 'C46 accepted provenance range beyond exact source text'; end if;
  if case_app.builder_sources_release_ready(doc,unconfirmed) then raise exception 'C46 accepted unconfirmed provenance'; end if;
  if case_app.builder_sources_release_ready(doc,absent_path) then raise exception 'C46 accepted a field path absent from the exact snapshot'; end if;
  if case_app.builder_sources_release_ready(doc,absent_entity) then raise exception 'C46 accepted an entity absent from the exact snapshot'; end if;
  if not case_app.builder_sources_release_ready(doc,jsonb_set(outside_range,'{provenance,0,end_line}','1'::jsonb)) then raise exception 'C46 rejected a confirmed exact provenance path'; end if;
  if case_app.builder_sources_release_ready(doc,jsonb_set(jsonb_set(outside_range,'{provenance,0,end_line}','1'::jsonb),'{provenance,0,source_id}','null'::jsonb)) then raise exception 'C46 accepted source line numbers without a source identity'; end if;
  if case_app.builder_provenance_paths_ok(doc,jsonb_set(jsonb_set(jsonb_set(outside_range,'{provenance,0,end_line}','1'::jsonb),'{provenance,0,field}','"surfaces..scene"'::jsonb),'{provenance,0,source_id}','null'::jsonb)) then raise exception 'C46 accepted a noncanonical field path'; end if;
end $$;
create temp table c46_window as select * from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000c620',0,'0199a000-0000-7000-8000-00000000c601',false,null);
select * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',(select operation_id from c46_window),(select document from c46_doc),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
create temp table c46_candidate as
select * from case_api.builder_submit_candidate('0199a000-0000-7000-8000-00000000c620',(select request_id from c46_values),1,(select document from c46_doc),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
do $$ declare v_err text; begin
  if (select status from c46_candidate)<>'pending' or (select revision from c46_candidate)<>1 then raise exception 'C46 did not snapshot exact current revision'; end if;
  v_err:=pg_temp.refused(format($q$select * from case_api.builder_approve_candidate('0199a000-0000-7000-8000-00000000c620',%L,1,%L::bytea,%L::bytea,'0199a000-0000-7000-8000-00000000c601',false,null)$q$,
    (select candidate_id from c46_candidate),(select intent_digest from c46_candidate),(select content_sha256 from c46_candidate)));
  if v_err is null or v_err not like '42501%' then raise exception 'C46 allowed non-admin to approve: %',v_err; end if;
  if has_function_privilege('service_role','case_api.publish_draft_with_art(uuid,bigint,uuid,uuid[],jsonb,boolean,text)','execute') then raise exception 'C46 retained direct first-publication RPC grant'; end if;
end $$;
create temp table c46_approved as
select * from case_api.builder_approve_candidate('0199a000-0000-7000-8000-00000000c620',(select candidate_id from c46_candidate),1,
  (select intent_digest from c46_candidate),(select content_sha256 from c46_candidate),'0199a000-0000-7000-8000-00000000c602',true,'reviewer@example.test');
create temp table c46_art as select case_app.art_structure((select document from c46_doc)) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb descriptor;
do $$ declare v_err text; begin
  v_err:=pg_temp.refused(format($q$select * from case_api.builder_release_candidate('0199a000-0000-7000-8000-00000000c620',%L,1,%L::bytea,%L::bytea,'{}','{}'::jsonb,'0199a000-0000-7000-8000-00000000c602',true,'reviewer@example.test')$q$,
    (select candidate_id from c46_candidate),(select intent_digest from c46_candidate),(select content_sha256 from c46_candidate)));
  if v_err is null or v_err not like '22023%art_mismatch%' then raise exception 'C46 released with invalid publication art: %',v_err; end if;
end $$;
create temp table c46_release as
select * from case_api.builder_release_candidate('0199a000-0000-7000-8000-00000000c620',(select candidate_id from c46_candidate),1,
  (select intent_digest from c46_candidate),(select content_sha256 from c46_candidate),'{}',(select descriptor from c46_art),
  '0199a000-0000-7000-8000-00000000c602',true,'reviewer@example.test');
do $$ declare v_replay record; v_err text; begin
  if (select status from c46_approved)<>'approved' or (select status from c46_release)<>'released' then raise exception 'C46 admin approval/release failed'; end if;
  if (select approved_by from case_app.builder_candidates where candidate_id=(select candidate_id from c46_candidate))<>'0199a000-0000-7000-8000-00000000c602' then raise exception 'C46 approval did not record the authenticated account'; end if;
  if (select document from case_app.builder_candidates where candidate_id=(select candidate_id from c46_candidate)) is not null then raise exception 'C46 released candidate duplicated published body'; end if;
  select * into v_replay from case_api.builder_release_candidate('0199a000-0000-7000-8000-00000000c620',(select candidate_id from c46_candidate),1,
    (select intent_digest from c46_candidate),(select content_sha256 from c46_candidate),'{}',(select descriptor from c46_art),
    '0199a000-0000-7000-8000-00000000c602',true,'reviewer@example.test');
  if v_replay.version_id<>(select version_id from c46_release) or (select count(*) from case_app.case_versions where case_id='0199a000-0000-7000-8000-00000000c620')<>1 then raise exception 'C46 release replay created another version'; end if;
  select * into v_replay from case_api.builder_submit_candidate('0199a000-0000-7000-8000-00000000c620',(select request_id from c46_values),1,(select document from c46_doc),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
  if v_replay.candidate_id<>(select candidate_id from c46_candidate) or v_replay.status<>'released' then raise exception 'C46 submission receipt replay lost released candidate history'; end if;
  v_err:=pg_temp.refused(format($q$select * from case_api.builder_release_candidate('0199a000-0000-7000-8000-00000000c620',%L,1,%L::bytea,%L::bytea,'{}',%L::jsonb,'0199a000-0000-7000-8000-00000000c602',true,'reviewer@example.test')$q$,
    (select candidate_id from c46_candidate),(select intent_digest from c46_candidate),(select content_sha256 from c46_candidate),'{}'));
  if v_err is null or v_err not like '23514%' then raise exception 'C46 accepted changed release replay: %',v_err; end if;
end $$;
-- A non-noop mutation supersedes eligibility in the same transaction; a no-op preserves it.
-- Start a genuinely new revision: submitting the released snapshot now returns its existing release.
update c46_doc set document=jsonb_set(document,'{case_title}','"Synthetic second edition"');
create temp table c46_second as select * from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000c620',1,'0199a000-0000-7000-8000-00000000c601',false,null);
select * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',(select operation_id from c46_second),(select document from c46_doc),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
create temp table c46_second_candidate as
select * from case_api.builder_submit_candidate('0199a000-0000-7000-8000-00000000c620',(select next_request_id from c46_values),2,(select document from c46_doc),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
create temp table c46_noop_window as select * from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000c620',2,'0199a000-0000-7000-8000-00000000c601',false,null);
select * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',(select operation_id from c46_noop_window),(select document from c46_doc),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
do $$ begin
  if (select status from case_app.builder_candidates where candidate_id=(select candidate_id from c46_second_candidate))<>'pending' then
    raise exception 'C46 exact no-op save invalidated the active Pending candidate';
  end if;
  if (select revision from case_app.case_drafts where case_id='0199a000-0000-7000-8000-00000000c620')<>2 then
    raise exception 'C46 exact no-op save advanced the draft revision';
  end if;
end $$;
create temp table c46_changed_window as select * from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000c620',2,'0199a000-0000-7000-8000-00000000c601',false,null);
select * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',(select operation_id from c46_changed_window),
  jsonb_set((select document from c46_doc),'{case_title}','"Synthetic changed"'),(select metadata from c46_meta),'0199a000-0000-7000-8000-00000000c601',false,null);
do $$ begin
  if (select status from case_app.builder_candidates where candidate_id=(select candidate_id from c46_second_candidate))<>'superseded' then raise exception 'C46 draft mutation left old Pending eligible'; end if;
  if (select count(*) from case_app.builder_candidates where case_id='0199a000-0000-7000-8000-00000000c620' and status='released')<>1 then raise exception 'C46 changed draft affected immutable prior release'; end if;
  raise notice 'ok C46 Pending, self-contained admin approval, exact immutable release replay, legacy publisher fence, and draft supersession';
end $$;
-- Three retained superseded bodies cause an explicit mutation refusal until the user deletes one.
do $$
declare i integer; d case_app.case_drafts%rowtype; op uuid; request_id uuid; candidate uuid; changed jsonb; refused boolean:=false;
begin
  for i in 1..2 loop
    select * into d from case_app.case_drafts where case_id='0199a000-0000-7000-8000-00000000c620';
    request_id:=case_app.uuid_v7();
    select candidate_id into candidate from case_api.builder_submit_candidate('0199a000-0000-7000-8000-00000000c620',request_id,d.revision,d.document,d.authoring_metadata,
      '0199a000-0000-7000-8000-00000000c601',false,null);
    select operation_id into op from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000c620',d.revision,'0199a000-0000-7000-8000-00000000c601',false,null);
    changed:=jsonb_set(d.document,'{case_title}',to_jsonb('Synthetic cycle '||i));
    perform * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',op,changed,d.authoring_metadata,'0199a000-0000-7000-8000-00000000c601',false,null);
  end loop;
  select * into d from case_app.case_drafts where case_id='0199a000-0000-7000-8000-00000000c620';
  select operation_id into op from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000c620',d.revision,'0199a000-0000-7000-8000-00000000c601',false,null);
  begin
    perform * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',op,
      jsonb_set(d.document,'{case_title}','"Refused while three bodies remain"'),d.authoring_metadata,'0199a000-0000-7000-8000-00000000c601',false,null);
  exception when check_violation then refused:=sqlerrm like '%builder_retained_candidate_limit%'; end;
  if not refused then raise exception 'C46 silently exceeded retained candidate body cap'; end if;
  perform * from case_api.builder_delete_candidate_body('0199a000-0000-7000-8000-00000000c620',(select candidate_id from c46_second_candidate),'0199a000-0000-7000-8000-00000000c601',false,null);
  perform * from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c620',op,
    jsonb_set(d.document,'{case_title}','"Refused while three bodies remain"'),d.authoring_metadata,'0199a000-0000-7000-8000-00000000c601',false,null);
  if (select revision from case_app.case_drafts where case_id='0199a000-0000-7000-8000-00000000c620')<>6 then raise exception 'C46 did not resume mutation after explicit body deletion'; end if;
end $$;
do $$ declare v_usage bigint; v_expected bigint; begin
  select case_app.builder_usage_bytes('0199a000-0000-7000-8000-00000000c610') into v_usage;
  select coalesce(sum(pg_column_size(d.document)+coalesce(pg_column_size(d.authoring_metadata),0)),0)+
         coalesce(sum(pg_column_size(v.document)),0)+
         (select coalesce(sum(pg_column_size(a.descriptor)),0) from case_app.case_version_art a join case_app.case_versions av on av.id=a.case_version_id where av.case_id='0199a000-0000-7000-8000-00000000c620')+
         (select coalesce(sum(coalesce(pg_column_size(b.document),0)+coalesce(pg_column_size(b.authoring_metadata),0))+count(*)*512,0)
            from case_app.builder_candidates b where b.case_id='0199a000-0000-7000-8000-00000000c620')+
         (select count(*)*256 from case_app.builder_save_receipts r where r.case_id='0199a000-0000-7000-8000-00000000c620' and r.expires_at>clock_timestamp())+
         (select count(*)*128 from case_app.builder_save_windows w where w.case_id='0199a000-0000-7000-8000-00000000c620' and w.expires_at>clock_timestamp())
    into v_expected from case_app.case_drafts d full join case_app.case_versions v on v.case_id=d.case_id
    where d.case_id='0199a000-0000-7000-8000-00000000c620' or v.case_id='0199a000-0000-7000-8000-00000000c620';
  if v_usage<>v_expected then raise exception 'C46 aggregate usage omitted immutable versions or candidate bodies: got %, expected %',v_usage,v_expected; end if;
end $$;
rollback;
