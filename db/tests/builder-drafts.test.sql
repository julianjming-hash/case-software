-- C42 database contracts: paired CAS saves, lost-ack replay, legacy bypass fence, checkpoints and revocation.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000c501'),('0199a000-0000-7000-8000-00000000c502');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000c501','Owner'),('0199a000-0000-7000-8000-00000000c502','Author');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000c510','c42-test','C42 test');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-00000000c510','0199a000-0000-7000-8000-00000000c501','owner'),
 ('0199a000-0000-7000-8000-00000000c510','0199a000-0000-7000-8000-00000000c502','author');
insert into case_app.cases(id,workspace_id,owner_id,title) values
 ('0199a000-0000-7000-8000-00000000c520','0199a000-0000-7000-8000-00000000c510','0199a000-0000-7000-8000-00000000c501','C42 case');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
create temp table c42_ids as
  select case_app.uuid_v7() as first_op, case_app.uuid_v7() as restore_op, case_app.uuid_v7() as checkpoint_id;
create temp table c42_result as select * from case_api.builder_open_save_window(
  '0199a000-0000-7000-8000-00000000c520',0,'0199a000-0000-7000-8000-00000000c502',false,null);
do $$ begin
  if not case_app.builder_metadata_ok('{"metadata_version":1}') or
     case_app.builder_metadata_ok('{"metadata_version":1,"untrusted":"x"}') then raise exception 'C42 metadata v1 shape admission drift'; end if;
  if (select count(*) from case_api.builder_get_draft('0199a000-0000-7000-8000-00000000c520','0199a000-0000-7000-8000-00000000c502',false,null))<>1 or
     exists(select 1 from case_api.builder_get_draft('0199a000-0000-7000-8000-00000000c520','0199a000-0000-7000-8000-00000000c502',false,null) where revision<>0 or document is not null or intent_digest is not null) then
    raise exception 'C42 empty case did not return the revision-zero shape'; end if;
end $$;
do $$
declare v_op uuid := (select operation_id from c42_result); v_rev bigint; v_replay bigint; v_err text;
  v_doc jsonb := '{"schema_version":1,"case_title":"C42 synthetic","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb;
  v_meta jsonb := '{"metadata_version":1,"sources":[],"provenance":[]}'::jsonb;
begin
  if (select status from case_api.builder_get_save_receipt('0199a000-0000-7000-8000-00000000c520',v_op,'0199a000-0000-7000-8000-00000000c502',false,null))<>'issued' then raise exception 'C42 open operation status is missing'; end if;
  select revision into v_rev from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c520',v_op,v_doc,v_meta,'0199a000-0000-7000-8000-00000000c502',false,null);
  if v_rev<>1 then raise exception 'C42 paired save did not create revision 1'; end if;
  if not exists(select 1 from case_api.builder_get_draft('0199a000-0000-7000-8000-00000000c520','0199a000-0000-7000-8000-00000000c502',false,null) where intent_digest=case_app.builder_intent_digest(v_doc,v_meta)) then raise exception 'C42 draft read omitted authoritative intent digest'; end if;
  select revision into v_replay from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c520',v_op,v_doc,v_meta,'0199a000-0000-7000-8000-00000000c502',false,null);
  if v_replay<>1 then raise exception 'C42 identical replay changed revision'; end if;
  v_err:=pg_temp.refused($q$select case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c520','0199a000-0000-7000-8000-00000000c599','{"schema_version":1}'::jsonb,'{"metadata_version":1}'::jsonb,'0199a000-0000-7000-8000-00000000c502',false,null)$q$);
  if v_err is null or v_err not like 'P0002%' then raise exception 'C42 absent save-window ID was not refused: %',v_err; end if;
  v_err:=pg_temp.refused($q$select case_api.save_draft('0199a000-0000-7000-8000-00000000c520',1,1,'{"schema_version":1}'::jsonb,'0199a000-0000-7000-8000-00000000c502',false,null)$q$);
  if v_err is null or v_err not like '42501%' then raise exception 'C42 legacy route overwrote paired metadata: %',v_err; end if;
  raise notice 'ok C42 paired snapshot save, exact retry, missing operation refusal, and legacy bypass fence';
end $$;
create temp table c42_noop as select * from case_api.builder_open_save_window(
  '0199a000-0000-7000-8000-00000000c520',1,'0199a000-0000-7000-8000-00000000c502',false,null);
do $$
declare v_doc jsonb := '{"schema_version":1,"case_title":"C42 synthetic","start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb;
  v_meta jsonb := '{"metadata_version":1,"sources":[],"provenance":[]}'::jsonb; v_rev bigint; v_status text; v_before timestamptz;
begin
  select updated_at into v_before from case_app.cases where id='0199a000-0000-7000-8000-00000000c520';
  select revision,status into v_rev,v_status from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000c520',(select operation_id from c42_noop),v_doc,v_meta,'0199a000-0000-7000-8000-00000000c502',false,null);
  if v_rev<>1 or v_status<>'noop' or (select updated_at from case_app.cases where id='0199a000-0000-7000-8000-00000000c520') is distinct from v_before then
    raise exception 'C42 identical save was not a no-op'; end if;
  raise notice 'ok C42 no-op preserves revision and case update timestamp';
end $$;
-- Checkpoint snapshots are fixed data and restore is always a fresh revision.
select * from case_api.builder_create_checkpoint('0199a000-0000-7000-8000-00000000c520','Before restore','0199a000-0000-7000-8000-00000000c502',false,null);
select * from case_api.builder_create_checkpoint('0199a000-0000-7000-8000-00000000c520','Second','0199a000-0000-7000-8000-00000000c502',false,null);
select * from case_api.builder_create_checkpoint('0199a000-0000-7000-8000-00000000c520','Third','0199a000-0000-7000-8000-00000000c502',false,null);
do $$ declare v_err text; begin
  v_err:=pg_temp.refused($q$select * from case_api.builder_create_checkpoint('0199a000-0000-7000-8000-00000000c520','Fourth','0199a000-0000-7000-8000-00000000c502',false,null)$q$);
  if v_err is null or v_err not like '23514%' then raise exception 'C42 checkpoint cap did not refuse fourth checkpoint: %',v_err; end if;
end $$;
create temp table c42_restore_window as select * from case_api.builder_open_save_window(
  '0199a000-0000-7000-8000-00000000c520',1,'0199a000-0000-7000-8000-00000000c502',false,null);
do $$
declare v_checkpoint uuid; v_op uuid := (select operation_id from c42_restore_window); v_rev bigint; v_err text;
begin
  select id into v_checkpoint from case_app.builder_checkpoints where case_id='0199a000-0000-7000-8000-00000000c520' and deleted_at is null;
  select revision into v_rev from case_api.builder_restore_checkpoint('0199a000-0000-7000-8000-00000000c520',v_checkpoint,v_op,'0199a000-0000-7000-8000-00000000c502',false,null);
  if v_rev<>2 then raise exception 'C42 restore did not create fresh revision 2'; end if;
  select revision into v_rev from case_api.builder_restore_checkpoint('0199a000-0000-7000-8000-00000000c520',v_checkpoint,v_op,'0199a000-0000-7000-8000-00000000c502',false,null);
  if v_rev<>2 then raise exception 'C42 restore receipt retry changed revision'; end if;
  delete from case_app.workspace_members where workspace_id='0199a000-0000-7000-8000-00000000c510' and user_id='0199a000-0000-7000-8000-00000000c502';
  v_err:=pg_temp.refused(format($q$select * from case_api.builder_get_save_receipt('0199a000-0000-7000-8000-00000000c520',%L,'0199a000-0000-7000-8000-00000000c502',false,null)$q$,v_op));
  if v_err is null or v_err not like '42501%' then raise exception 'C42 revoked actor read historical receipt: %',v_err; end if;
  raise notice 'ok C42 restore creates a fresh revision and revocation fences receipt reads';
end $$;
rollback;
