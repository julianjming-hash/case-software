-- The facilitator's Name & role (20261106000000_facilitator_label.sql): ensure_profile is insert-only, the self and admin
-- writes, get_me's new columns, the room's label written once at start, feedback_resolve only after End, the 24 h purge,
-- the audit action and service-only access. Independent fixtures; rolled back.
\set QUIET on
begin;
insert into auth.users values ('0199f100-0000-7000-8000-000000000001'), ('0199f100-0000-7000-8000-000000000002'),
  ('0199f100-0000-7000-8000-000000000003');
insert into case_app.profiles(id,display_name) values ('0199f100-0000-7000-8000-000000000001','Facilitator'),
  ('0199f100-0000-7000-8000-000000000002',null);
insert into case_app.workspaces(id,slug,name) values ('0199f100-0000-7000-8000-00000000000a','facilitator-label','Label fixture');
insert into case_app.cases(id,workspace_id,owner_id,title)
values ('0199f100-0000-7000-8000-00000000000c','0199f100-0000-7000-8000-00000000000a','0199f100-0000-7000-8000-000000000001','Fixture');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
values ('0199f100-0000-7000-8000-00000000000e','0199f100-0000-7000-8000-00000000000c',1,1,
 '{"title":"Diving Deeper","learning_objectives":["First objective."]}',sha256('label fixture'),'0199f100-0000-7000-8000-000000000001');
create temporary sequence label_fixture_join;
-- A room; p_ended_ago null leaves it live.
create function pg_temp.room(p_ended_ago interval) returns uuid language plpgsql as $$
declare s uuid := case_app.uuid_v7();
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,created_at,started_at,ended_at,status,expires_at)
 values(s,'0199f100-0000-7000-8000-00000000000e','0199f100-0000-7000-8000-00000000000a','0199f100-0000-7000-8000-000000000001',
  lpad(nextval('pg_temp.label_fixture_join')::text,6,'0'),clock_timestamp()-interval '3 days',clock_timestamp()-interval '3 days',
  case when p_ended_ago is null then null else clock_timestamp()-p_ended_ago end,
  case when p_ended_ago is null then 'live' else 'ended' end,
  case when p_ended_ago is null then clock_timestamp()+interval '9 hours' else clock_timestamp()-p_ended_ago+interval '1 hour' end);
 return s;
end $$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;

-- ensure_profile never replaces a stored name; it fills a missing one and still creates a missing profile.
do $$ begin
 update case_app.profiles set display_name='Julian Ming' where id='0199f100-0000-7000-8000-000000000001';
 perform case_api.ensure_profile('0199f100-0000-7000-8000-000000000001','Facilitator');
 perform case_api.ensure_profile('0199f100-0000-7000-8000-000000000002','Facilitator');
 perform case_api.ensure_profile('0199f100-0000-7000-8000-000000000003','Facilitator');
 if (select display_name from case_app.profiles where id='0199f100-0000-7000-8000-000000000001') <> 'Julian Ming' then
  raise exception 'ensure_profile overwrote a chosen name'; end if;
 if (select count(*) from case_app.profiles where id in ('0199f100-0000-7000-8000-000000000002','0199f100-0000-7000-8000-000000000003')
     and display_name='Facilitator') <> 2 then raise exception 'ensure_profile did not fill or create'; end if;
 update case_app.profiles set display_name='Facilitator' where id='0199f100-0000-7000-8000-000000000001';
 raise notice 'ok ensure_profile is insert-only';
end $$;

-- The self write: validated, confirms, and get_me reads it back. Unconfirmed until then.
do $$ declare r record;
begin
 select * into r from case_api.get_me('0199f100-0000-7000-8000-000000000001');
 if r.facilitator_role is not null or r.label_confirmed_at is not null or r.display_name <> 'Facilitator' then
  raise exception 'a placeholder profile read as confirmed: %', row_to_json(r); end if;
 if pg_temp.err($q$select case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000001','','Registrar')$q$) <> '23514'
  or pg_temp.err($q$select case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000001','Julian Ming',null)$q$) <> '23514'
  or pg_temp.err($q$select case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000001',' Julian','Registrar')$q$) <> '23514'
  or pg_temp.err($q$select case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000001','Julian  Ming','Registrar')$q$) <> '23514'
  or pg_temp.err($q$select case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000001',E'Julian\nMing','Registrar')$q$) <> '23514'
  or pg_temp.err(format('select case_api.set_own_facilitator_label(%L,%L,%L)','0199f100-0000-7000-8000-000000000001',repeat('é',81),'Registrar')) <> '23514'
 then raise exception 'set_own_facilitator_label accepted a bad field'; end if;
 if pg_temp.err(format('select case_api.set_own_facilitator_label(%L,%L,%L)','0199f100-0000-7000-8000-000000000001',repeat('é',80),'Registrar')) <> ''
  then raise exception 'an 80-character name was refused'; end if;
 select * into r from case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000001','Julian Ming','Emergency registrar');
 if r.display_name <> 'Julian Ming' or r.facilitator_role <> 'Emergency registrar' or r.label_confirmed_at is null then
  raise exception 'self write: %', row_to_json(r); end if;
 select * into r from case_api.get_me('0199f100-0000-7000-8000-000000000001');
 if r.display_name <> 'Julian Ming' or r.facilitator_role <> 'Emergency registrar' or r.label_confirmed_at is null then
  raise exception 'get_me did not read the label back: %', row_to_json(r); end if;
 -- An inactive account cannot write.
 update case_app.profiles set disabled_at=now() where id='0199f100-0000-7000-8000-000000000003';
 if pg_temp.err($q$select case_api.set_own_facilitator_label('0199f100-0000-7000-8000-000000000003','Sam Lee','Intern')$q$) <> '42501'
  then raise exception 'a disabled account set its label'; end if;
 raise notice 'ok self write and get_me';
end $$;

-- The admin write: admin flag only, CAS on admin_revision, refuses a soft-deleted account, leaves confirmation alone.
do $$ declare r record; v_rev bigint;
begin
 select admin_revision into v_rev from case_app.profiles where id='0199f100-0000-7000-8000-000000000002';
 if pg_temp.err(format('select case_api.admin_set_facilitator_label(%L,%s,%L,%L,false,null)','0199f100-0000-7000-8000-000000000002',v_rev,'Sam Lee','Intern')) <> '42501'
  then raise exception 'a non-admin used the admin write'; end if;
 if pg_temp.err(format('select case_api.admin_set_facilitator_label(%L,%s,%L,%L,true,%L)','0199f100-0000-7000-8000-000000000002',v_rev+1,'Sam Lee','Intern','admin@example.org')) <> '40001'
  then raise exception 'a stale revision was accepted'; end if;
 select * into r from case_api.admin_set_facilitator_label('0199f100-0000-7000-8000-000000000002',v_rev,'Sam Lee','Intern',true,'admin@example.org');
 if r.admin_revision <> v_rev+1 or r.display_name <> 'Sam Lee' or r.facilitator_role <> 'Intern' or r.label_confirmed_at is not null then
  raise exception 'admin write: %', row_to_json(r); end if;
 if (select count(*) from case_api.admin_read_facilitator_labels(array['0199f100-0000-7000-8000-000000000002'::uuid,'0199f100-0000-7000-8000-000000000001'::uuid])) <> 2
  then raise exception 'admin_read_facilitator_labels'; end if;
 update case_app.profiles set disabled_at=now(),soft_deleted_at=now(),delete_due_at=now()+interval '30 days' where id='0199f100-0000-7000-8000-000000000002';
 if pg_temp.err(format('select case_api.admin_set_facilitator_label(%L,%s,%L,%L,true,%L)','0199f100-0000-7000-8000-000000000002',v_rev+1,'Sam Lee','Intern','admin@example.org')) <> '23514'
  then raise exception 'a soft-deleted account was edited'; end if;
 raise notice 'ok admin write';
end $$;

-- The deployment audit takes the new action, and only for a facilitator target.
do $$ declare i uuid := case_app.uuid_v7();
begin
 perform case_api.write_admin_audit(i,i,'intent','facilitator_label_edit','facilitator','0199f100-0000-7000-8000-000000000002',
  'admin@example.org','{"admin_revision":1}','{}',null);
 if pg_temp.err(format($q$select case_api.write_admin_audit(%L,%L,'intent','facilitator_label_edit','room',%L,'admin@example.org','{}','{}',null)$q$,
   case_app.uuid_v7(),case_app.uuid_v7(),'0199f100-0000-7000-8000-000000000002')) = '' then raise exception 'label edit audited against a room'; end if;
 raise notice 'ok audit action';
end $$;

-- The room's label: once, for a room before End; /F shows it only after End; the purge deletes it.
do $$ declare s uuid := pg_temp.room(null); code text; f jsonb;
begin
 if not case_api.set_session_facilitator_label(s,'Julian Ming, Emergency registrar') then raise exception 'label not written'; end if;
 if case_api.set_session_facilitator_label(s,'Someone Else, Consultant') then raise exception 'label rewritten'; end if;
 if pg_temp.err(format('select case_api.set_session_facilitator_label(%L,%L)',s,' padded')) <> '23514' then raise exception 'padded label accepted'; end if;
 if pg_temp.err(format('select case_api.set_session_facilitator_label(%L,%L)',s,repeat('a',163))) <> '23514' then raise exception 'long label accepted'; end if;
 select feedback_code::text into code from case_app.sessions where id=s;
 f := case_api.feedback_resolve(code);
 if f <> jsonb_build_object('state','not_ended') then raise exception 'the label leaked before End: %', f; end if;
 update case_app.sessions set status='ended',ended_at=clock_timestamp() where id=s;
 f := case_api.feedback_resolve(code);
 if f->>'facilitator' is distinct from 'Julian Ming, Emergency registrar' then raise exception '/F after End: %', f; end if;
 if case_api.set_session_facilitator_label(pg_temp.room(interval '1 hour'),'Julian Ming, Registrar') then raise exception 'label set on an ended room'; end if;
 raise notice 'ok room label and feedback_resolve';
end $$;

-- [AS-178] Hard rule 8: the retention purge nulls the label, and a purged row can never carry one.
do $$ declare s uuid := pg_temp.room(interval '30 hours'); code text;
begin
 update case_app.sessions set facilitator_label='Julian Ming, Emergency registrar',personal_data_delete_at=ended_at+interval '24 hours' where id=s;
 perform case_api.purge_expired_participant_data();
 if (select retention_purged_at is null or facilitator_label is not null from case_app.sessions where id=s) then
  raise exception 'purge left the facilitator label'; end if;
 update case_app.sessions set facilitator_label='Julian Ming, Registrar' where id=s;
 if (select facilitator_label from case_app.sessions where id=s) is not null then raise exception 'a purged room took a label'; end if;
 select feedback_code::text into code from case_app.sessions where id=s;
 if case_api.feedback_resolve(code) ? 'facilitator' and case_api.feedback_resolve(code)->>'facilitator' is not null then
  raise exception '/F showed a purged label'; end if;
 raise notice 'ok purge deletes the label';
end $$;

-- Service role only; definer functions pin search_path.
do $$ declare f regprocedure;
begin
 foreach f in array array['case_api.set_own_facilitator_label(uuid,text,text)'::regprocedure,
   'case_api.admin_set_facilitator_label(uuid,bigint,text,text,boolean,text)'::regprocedure,
   'case_api.admin_read_facilitator_labels(uuid[])'::regprocedure, 'case_api.set_session_facilitator_label(uuid,text)'::regprocedure,
   'case_api.get_me(uuid,integer,uuid,uuid,boolean,text)'::regprocedure, 'case_api.feedback_resolve(text)'::regprocedure,
   'case_api.ensure_profile(uuid,text)'::regprocedure] loop
  if has_function_privilege('anon',f,'execute') or has_function_privilege('authenticated',f,'execute') or not has_function_privilege('service_role',f,'execute') then
   raise exception 'wrong execute grants on %', f; end if;
  if not (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid=f) then raise exception '% not a pinned definer', f; end if;
 end loop;
 raise notice 'ok label service-only access';
end $$;
rollback;
