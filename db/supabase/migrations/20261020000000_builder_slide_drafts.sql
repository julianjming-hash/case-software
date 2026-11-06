-- CASE-214 (Julian, 2026-10-11): activate slide drafts. Builder drafts and checkpoints admit schema 3
-- (CASE-210 blocks and compositions). Additive: two checks widen; schema 1 and 2 behave exactly as before.
-- Review candidates and published versions keep refusing schema 3 until slide rooms ship.
alter table case_app.builder_checkpoints drop constraint builder_checkpoints_schema_version_check;
alter table case_app.builder_checkpoints add constraint builder_checkpoints_schema_version_check check (schema_version in (1,2,3));

create or replace function case_app.builder_snapshot_ok(p_document jsonb, p_metadata jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_version integer;
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' or pg_column_size(p_document) > 1048576 then return false; end if;
  begin v_version := (p_document->>'schema_version')::integer; exception when others then return false; end;
  if v_version not in (1,2,3) then return false; end if;
  if not case_app.builder_metadata_ok(p_metadata) then return false; end if;
  return true;
end;
$$;
