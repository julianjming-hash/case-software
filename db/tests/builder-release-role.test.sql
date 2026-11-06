-- Release must commit under the PostgREST service_role after the definer RPC returns.
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

-- Deferred triggers execute as the transaction caller, after SECURITY DEFINER returns.
set local role service_role;
set constraints all immediate;
reset role;
rollback;
