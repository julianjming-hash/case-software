-- Save-window caps count open windows only: consumed windows never block later saves, open ones stay capped.
\set QUIET on
begin;
insert into auth.users values ('0199a000-0000-7000-8000-00000000d601'),('0199a000-0000-7000-8000-00000000d602'),
  ('0199a000-0000-7000-8000-00000000d603'),('0199a000-0000-7000-8000-00000000d604'),('0199a000-0000-7000-8000-00000000d605');
insert into case_app.profiles(id,display_name) values ('0199a000-0000-7000-8000-00000000d601','Owner'),('0199a000-0000-7000-8000-00000000d602','Author'),
  ('0199a000-0000-7000-8000-00000000d603','Author 3'),('0199a000-0000-7000-8000-00000000d604','Author 4'),('0199a000-0000-7000-8000-00000000d605','Author 5');
insert into case_app.workspaces(id,slug,name) values ('0199a000-0000-7000-8000-00000000d610','save-window-quota','Save window quota');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-00000000d610','0199a000-0000-7000-8000-00000000d601','owner'),
 ('0199a000-0000-7000-8000-00000000d610','0199a000-0000-7000-8000-00000000d602','author'),
 ('0199a000-0000-7000-8000-00000000d610','0199a000-0000-7000-8000-00000000d603','author'),
 ('0199a000-0000-7000-8000-00000000d610','0199a000-0000-7000-8000-00000000d604','author'),
 ('0199a000-0000-7000-8000-00000000d610','0199a000-0000-7000-8000-00000000d605','author');
insert into case_app.cases(id,workspace_id,owner_id,title) values
 ('0199a000-0000-7000-8000-00000000d620','0199a000-0000-7000-8000-00000000d610','0199a000-0000-7000-8000-00000000d601','Quota case');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
create temp table quota_ops(n integer primary key, operation_id uuid not null);

-- Twelve consecutive open-then-save cycles by one author: more than the eight-window per-actor cap.
do $$
declare v_op uuid; v_rev bigint; v_status text;
  v_meta jsonb := '{"metadata_version":1,"sources":[],"provenance":[]}'::jsonb;
begin
  for i in 1..12 loop
    select operation_id into v_op from case_api.builder_open_save_window(
      '0199a000-0000-7000-8000-00000000d620',i-1,'0199a000-0000-7000-8000-00000000d602',false,null);
    select revision,status into v_rev,v_status from case_api.builder_save_draft('0199a000-0000-7000-8000-00000000d620',v_op,
      jsonb_build_object('schema_version',1,'case_title','Quota save '||i,'start_beat_id','a','beats',jsonb_build_array(jsonb_build_object('id','a','kind','debrief')),'decisions','[]'::jsonb),
      v_meta,'0199a000-0000-7000-8000-00000000d602',false,null);
    if v_rev<>i or v_status<>'saved' then raise exception 'save % returned revision % status %',i,v_rev,v_status; end if;
    insert into quota_ops values(i,v_op);
  end loop;
  -- A consumed window still answers from its receipt, so lost-acknowledgement recovery is unchanged.
  if (select status from case_api.builder_get_save_receipt('0199a000-0000-7000-8000-00000000d620',(select operation_id from quota_ops where n=1),
      '0199a000-0000-7000-8000-00000000d602',false,null))<>'saved' then raise exception 'first save receipt no longer reads as saved'; end if;
  raise notice 'ok twelve consecutive saves by one author pass the per-actor window cap';
end $$;

-- Open, unused windows stay capped at eight per actor on a case.
do $$
declare v_op uuid; v_err text;
begin
  for i in 1..8 loop
    select operation_id into v_op from case_api.builder_open_save_window(
      '0199a000-0000-7000-8000-00000000d620',12,'0199a000-0000-7000-8000-00000000d602',false,null);
  end loop;
  if (select status from case_api.builder_get_save_receipt('0199a000-0000-7000-8000-00000000d620',v_op,'0199a000-0000-7000-8000-00000000d602',false,null))<>'issued' then
    raise exception 'open window does not read as issued'; end if;
  v_err:=pg_temp.refused($q$select * from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000d620',12,'0199a000-0000-7000-8000-00000000d602',false,null)$q$);
  if v_err is null or v_err not like '23514 builder_quota%' then raise exception 'ninth open window was not refused by the per-actor cap: %',v_err; end if;
  raise notice 'ok eight open unused windows per actor remain the cap';
end $$;

-- Open windows stay capped at 32 per case across actors.
do $$
declare v_err text;
begin
  for a in 3..5 loop
    for i in 1..8 loop
      perform case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000d620',12,
        ('0199a000-0000-7000-8000-00000000d60'||a)::uuid,false,null);
    end loop;
  end loop;
  v_err:=pg_temp.refused($q$select * from case_api.builder_open_save_window('0199a000-0000-7000-8000-00000000d620',12,'0199a000-0000-7000-8000-00000000d601',false,null)$q$);
  if v_err is null or v_err not like '23514 builder_quota%' then raise exception 'thirty-third open window was not refused by the per-case cap: %',v_err; end if;
  raise notice 'ok thirty-two open windows per case remain the cap';
end $$;
rollback;
