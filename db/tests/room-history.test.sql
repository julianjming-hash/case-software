-- Summary history authorization, stable anchors, truthful pending status and independent privacy cutoff.
\set QUIET on
begin;
insert into auth.users values
 ('0199d000-0000-7000-8000-000000000001'),('0199d000-0000-7000-8000-000000000002'),
 ('0199d000-0000-7000-8000-000000000003'),('0199d000-0000-7000-8000-000000000004');
insert into case_app.profiles(id,display_name) values
 ('0199d000-0000-7000-8000-000000000001','History starter'),('0199d000-0000-7000-8000-000000000002','Other author'),
 ('0199d000-0000-7000-8000-000000000003','Deployment admin'),('0199d000-0000-7000-8000-000000000004','Removed');
insert into case_app.workspaces(id,slug,name) values
 ('0199d000-0000-7000-8000-000000000010','history-home','History'),('0199d000-0000-7000-8000-000000000011','history-other','Other');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199d000-0000-7000-8000-000000000010','0199d000-0000-7000-8000-000000000001','facilitator'),
 ('0199d000-0000-7000-8000-000000000010','0199d000-0000-7000-8000-000000000002','owner');
insert into case_app.cases(id,workspace_id,owner_id,title) values
 ('0199d000-0000-7000-8000-000000000020','0199d000-0000-7000-8000-000000000010','0199d000-0000-7000-8000-000000000001','Current title');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by) values
 ('0199d000-0000-7000-8000-000000000021','0199d000-0000-7000-8000-000000000020',3,1,'{"title":"Frozen title"}',sha256('history'),'0199d000-0000-7000-8000-000000000001');
create function pg_temp.history_room(n integer,actor uuid,ended interval default null,workspace uuid default '0199d000-0000-7000-8000-000000000010') returns uuid language plpgsql as $$
declare id uuid:=('0199d000-0000-7000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
begin
 insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,status,created_at,ended_at,expires_at)
 values(id,'0199d000-0000-7000-8000-000000000021',workspace,actor,lpad(n::text,6,'0'),
  case when ended is null then 'live' else 'ended' end,now()-interval '100 days',now()-ended,
  case when ended is null then now()+interval '1 day' else now()-ended+interval '1 hour' end);
 return id;
end $$;
create function pg_temp.history_refused(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return sqlstate in ('42501','22023'); end $$;
select pg_temp.history_room(1,'0199d000-0000-7000-8000-000000000001');
select pg_temp.history_room(2,'0199d000-0000-7000-8000-000000000001');
select pg_temp.history_room(3,'0199d000-0000-7000-8000-000000000002');
select pg_temp.history_room(4,'0199d000-0000-7000-8000-000000000001',interval '89 days');
select pg_temp.history_room(5,'0199d000-0000-7000-8000-000000000001',interval '90 days');
select pg_temp.history_room(6,'0199d000-0000-7000-8000-000000000001',interval '91 days');
select pg_temp.history_room(7,'0199d000-0000-7000-8000-000000000004');
select pg_temp.history_room(8,'0199d000-0000-7000-8000-000000000001',null,'0199d000-0000-7000-8000-000000000011');
select pg_temp.history_room(9,'0199d000-0000-7000-8000-000000000001',interval '25 hours');

do $$
declare u uuid:='0199d000-0000-7000-8000-000000000001'; w uuid:='0199d000-0000-7000-8000-000000000010'; ids uuid[]; first_id uuid; at timestamptz;
begin
 select array_agg(session_id) into ids from case_api.list_room_history(u,w,'all',100,null,null);
 if cardinality(ids)<>6 or not ('0199d000-0000-7000-8000-000000000105'::uuid=any(ids)) or
    not ('0199d000-0000-7000-8000-000000000106'::uuid=any(ids)) then raise exception 'history ownership/long-term portfolio visibility failed'; end if;
 -- CASE-337: an owner reads every room's history only while managers_see_records is on (the default, existing workspaces too).
 update case_app.workspace_policies set managers_see_records=false where workspace_id=w;
 if (select count(*) from case_api.list_room_history('0199d000-0000-7000-8000-000000000002',w,'all',100,null,null))<>1 then
  raise exception 'owner role leaked another starter history'; end if;
 update case_app.workspace_policies set managers_see_records=true where workspace_id=w;
 if (select count(*) from case_api.list_room_history('0199d000-0000-7000-8000-000000000002',w,'all',100,null,null))<=1 then
  raise exception 'managers_see_records did not widen the owner''s history'; end if;
 if (select count(*) from case_api.list_room_history('0199d000-0000-7000-8000-000000000003',w,'all',100,null,null,true,'admin@example.org'))<>8 then
  raise exception 'deployment admin reach incorrect'; end if;
 if not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''all'',20,null,null)', '0199d000-0000-7000-8000-000000000004',w)) then
  raise exception 'removed starter authorized'; end if;
 select session_id,created_at into first_id,at from case_api.list_room_history(u,w,'running',1,null,null);
 if first_id<>'0199d000-0000-7000-8000-000000000102' then raise exception 'stable tie order incorrect'; end if;
 if (select session_id from case_api.list_room_history(u,w,'running',1,at,first_id))<>'0199d000-0000-7000-8000-000000000101' then
  raise exception 'stable tie pagination incorrect'; end if;
 if not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''ended'',20,%L,%L)',u,w,at,first_id)) or
    not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''all'',20,%L,%L)',u,w,at,'0199d000-0000-7000-8000-000000000103')) or
    not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''all'',20,%L,%L)',u,w,at,'0199d000-0000-7000-8000-000000000108')) or
    not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''all'',20,%L,%L)',u,w,at+interval '1 microsecond',first_id)) then
  raise exception 'foreign/filter/mismatched-time cursor accepted'; end if;
 delete from case_app.workspace_members where workspace_id=w and user_id=u;
 if not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''running'',20,%L,%L)',u,w,at,first_id)) then
  raise exception 'old page anchor bypassed membership loss'; end if;
 insert into case_app.workspace_members values(w,u,'facilitator',now());
 update case_app.profiles set disabled_at=now() where id=u;
 if not pg_temp.history_refused(format('select * from case_api.list_room_history(%L,%L,''all'',20,null,null)',u,w)) then raise exception 'disabled starter authorized'; end if;
 update case_app.profiles set disabled_at=null where id=u;
 raise notice 'ok history own/admin, stable tied anchors and current entitlement';
end $$;

-- Even a finalized session/max sequence remains pending: missing prefix/support is not reconstruction proof.
insert into case_app.session_events(session_id,seq,event_id,epoch,kind,occurred_at) values
 ('0199d000-0000-7000-8000-000000000109',99,case_app.uuid_v7(),0,'room_ended',now()-interval '25 hours');
update case_app.sessions set archived_through_seq=99,final_revision=100,final_epoch=2 where id='0199d000-0000-7000-8000-000000000109';
insert into case_app.session_participants(id,session_id,display_name,token_sha256,joined_at) values
 ('0199d000-0000-7000-8000-000000000030','0199d000-0000-7000-8000-000000000109','Private name',sha256('private token'),now()-interval '26 hours');
insert into case_app.session_rounds(id,session_id,decision_id,round_no,status,opened_at,aggregate) values
 ('0199d000-0000-7000-8000-000000000031','0199d000-0000-7000-8000-000000000109',case_app.uuid_v7(),1,'resolved',now()-interval '26 hours','{"total":1}');
insert into case_app.session_responses(id,session_id,round_id,participant_id,response,last_client_event_id,first_submitted_at,last_submitted_at) values
 (case_app.uuid_v7(),'0199d000-0000-7000-8000-000000000109','0199d000-0000-7000-8000-000000000031','0199d000-0000-7000-8000-000000000030','{"text":"Private answer"}',case_app.uuid_v7(),now()-interval '26 hours',now()-interval '26 hours');
select case_api.purge_expired_participant_data();
do $$
declare r record;
begin
 select * into r from case_api.list_room_history('0199d000-0000-7000-8000-000000000001','0199d000-0000-7000-8000-000000000010','ended',20,null,null)
  where session_id='0199d000-0000-7000-8000-000000000109';
 if r.session_id is null or r.title<>'Frozen title' or r.version_no<>3 or r.archive_state<>'pending' then raise exception 'post24h summary lost or completion fabricated'; end if;
 if exists(select 1 from case_app.session_responses where session_id=r.session_id) or
    exists(select 1 from case_app.session_participants where session_id=r.session_id and display_name is not null) then raise exception 'history extended personal retention'; end if;
 if (select count(*) from case_app.sessions) < 9 or not exists(select 1 from case_app.session_rounds where session_id=r.session_id) then
  raise exception 'summary visibility destructively purged legacy archive'; end if;
 if has_function_privilege('anon','case_api.list_room_history(uuid,uuid,text,integer,timestamptz,uuid,boolean,text)','execute') or
    has_function_privilege('authenticated','case_api.list_room_history(uuid,uuid,text,integer,timestamptz,uuid,boolean,text)','execute') then
  raise exception 'public history RPC grant'; end if;
 raise notice 'ok history summary survives24h personal purge, truthful pending source and long-term visibility';
end $$;
rollback;
