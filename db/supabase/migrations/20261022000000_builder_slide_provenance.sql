-- Card 57 slide rooms (red-team, 2026-10-11): in schema 3 every composition carries owner {kind, id} with the id of its
-- stage, consequence or clarification. The provenance resolver indexed every object with an id, so the owner replaced
-- the stage and stage or clarification traces failed review and release. Owners are now skipped; nothing else changes.
create or replace function case_app.builder_provenance_paths_ok(p_document jsonb,p_metadata jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_entry jsonb; v_entities jsonb; v_entity_id text; v_entity jsonb; v_target jsonb; v_field text; v_rest text;
  v_match text[]; v_collection text; v_segments text[]; v_segment text; v_index integer;
begin
  if not case_app.builder_metadata_ok(p_metadata) then return false; end if;
  with recursive walk(value) as (
    select p_document
    union all
    select child.value from walk
    cross join lateral (
      -- A composition's owner reuses its stage's id; it is a reference, never the stage the trace points at (card 57).
      select e.value from jsonb_each(case when jsonb_typeof(walk.value)='object' then walk.value else '{}'::jsonb end) e
      where not (e.key='owner' and walk.value ? 'reading_order')
      union all
      select a.value from jsonb_array_elements(case when jsonb_typeof(walk.value)='array' then walk.value else '[]'::jsonb end) a
    ) child
  )
  select coalesce(jsonb_object_agg(w.value->>'id',w.value) filter (where jsonb_typeof(w.value)='object' and w.value->>'id' is not null),'{}'::jsonb)
    into v_entities from walk w;
  for v_entry in select value from jsonb_array_elements(case when jsonb_typeof(p_metadata->'provenance')='array' then p_metadata->'provenance' else '[]'::jsonb end) loop
    v_entity_id:=v_entry->>'entity_id'; v_entity:=v_entities->v_entity_id;
    if v_entity is null then return false; end if;
    v_target:=v_entity; v_field:=v_entry->>'field'; v_rest:=v_field;
    if v_field !~ '^[a-z][a-z0-9_]*(\[[0-9]+\])*(\.[a-z][a-z0-9_]*(\[[0-9]+\])*)*$' and
       v_field !~ '^[a-z][a-z0-9_]*\[[0-9a-f-]{36}\]\.[a-z][a-z0-9_]*(\[[0-9]+\])*(\.[a-z][a-z0-9_]*(\[[0-9]+\])*)*$' then return false; end if;
    if (v_entry ? 'start_line' or v_entry ? 'end_line') and v_entry->>'source_id' is null then return false; end if;
    v_match:=regexp_match(v_field,'^([a-z][a-z0-9_]*)\[([0-9a-f-]{36})\](?:\.(.*))?$');
    if v_match is not null then
      if v_match[2]<>v_entity_id or jsonb_typeof(p_document->v_match[1])<>'array' or not exists(
        select 1 from jsonb_array_elements(p_document->v_match[1]) item where item->>'id'=v_entity_id) then return false; end if;
      v_rest:=coalesce(v_match[3],'');
    else
      v_collection:=split_part(v_field,'.',1);
      if position('.' in v_field)>0 and jsonb_typeof(p_document->v_collection)='array' and exists(
        select 1 from jsonb_array_elements(p_document->v_collection) item where item->>'id'=v_entity_id) then
        v_rest:=substring(v_field from length(v_collection)+2);
      end if;
    end if;
    if v_rest='' then return false; end if;
    v_segments:=string_to_array(regexp_replace(v_rest,'\[([0-9]+)\]','.'||'\1','g'),'.');
    foreach v_segment in array v_segments loop
      if jsonb_typeof(v_target)='object' then
        if not (v_target ? v_segment) then return false; end if;
        v_target:=v_target->v_segment;
      elsif jsonb_typeof(v_target)='array' then
        if v_segment !~ '^[0-9]+$' or v_segment::numeric>=jsonb_array_length(v_target) then return false; end if;
        v_index:=v_segment::integer; v_target:=v_target->v_index;
      else return false; end if;
    end loop;
  end loop;
  return true;
end; $$;
