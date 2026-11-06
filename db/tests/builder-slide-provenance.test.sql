-- Card 57: a schema-3 document's composition owner (same id as its stage) never replaces the stage for source traces.
\set QUIET on
begin;
do $$ declare beat_id text:='0199a000-0000-7000-8000-00000000c701'; doc jsonb; meta jsonb; begin
  doc:=jsonb_build_object('schema_version',3,'beats',jsonb_build_array(jsonb_build_object('id',beat_id,'kind','surface','title','Arrival','cue','Let it land')),
    'compositions',jsonb_build_array(jsonb_build_object('id','0199a000-0000-7000-8000-00000000c702','owner',jsonb_build_object('kind','beat','id',beat_id),
      'reading_order','[]'::jsonb,'steps','[]'::jsonb,'placements','[]'::jsonb)));
  meta:=jsonb_build_object('metadata_version',1,'sources','[]'::jsonb,'provenance',jsonb_build_array(jsonb_build_object(
    'entity_id',beat_id,'field','title','transformation','adapted','visibility','public','review_status','confirmed')));
  if not case_app.builder_provenance_paths_ok(doc,meta) then raise exception 'C57 a stage trace failed because a composition owner shadowed its stage'; end if;
  if case_app.builder_provenance_paths_ok(doc,jsonb_set(meta,'{provenance,0,field}','"absent"'::jsonb)) then raise exception 'C57 accepted a field the stage does not have'; end if;
  if case_app.builder_provenance_paths_ok(doc,jsonb_set(meta,'{provenance,0,field}','"kind"'::jsonb) - 'unused' #- '{provenance,0,entity_id}') then raise exception 'C57 accepted a trace without an entity'; end if;
end $$;
rollback;
