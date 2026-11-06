-- Execute the deferred media assertion inside the existing authorized release RPC.
-- PostgREST commits as service_role, which deliberately cannot read case_app tables.
-- Keep the trigger invoker-only and all private-table grants closed. Restore its
-- deferred mode so another release in the same transaction can assemble its pins.
-- Patch the installed definition to preserve existing digest serialization exactly.
begin;
do $migration$
declare definition text; anchor text := '  insert into case_app.case_version_art(case_version_id,descriptor,renderer_version)';
begin
  definition := pg_get_functiondef('case_api.builder_release_candidate(uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,uuid,boolean,text)'::regprocedure);
  if position(anchor in definition) = 0 then
    raise exception 'builder_release_commit: installed release definition does not match';
  end if;
  execute replace(definition, anchor,
    E'  set constraints case_app.case_versions_asset_set immediate;\n  set constraints case_app.case_versions_asset_set deferred;\n' || anchor);
end;
$migration$;
commit;
