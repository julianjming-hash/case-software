-- Real SQL witnesses: own/admin/incident scopes, operation replay, CAS, quotas and evidence purge.
\set QUIET on
begin;
insert into auth.users(id) values('0199f100-0000-7000-8000-000000000001'),('0199f100-0000-7000-8000-000000000002'),('0199f100-0000-7000-8000-000000000003'),('0199f100-0000-7000-8000-000000000004');
insert into case_app.profiles(id) select id from auth.users where id::text like '0199f100-%';
create function pg_temp.bi_assert(value boolean,message text) returns void language plpgsql as $$begin if value is distinct from true then raise exception 'beta issues: %',message;end if;end$$;
create function pg_temp.bi_actor(n integer,a boolean default false,r boolean default false) returns jsonb language sql as $$select jsonb_build_object('userId','0199f100-0000-7000-8000-'||lpad(n::text,12,'0'),'principal','user:0199f100-0000-7000-8000-'||lpad(n::text,12,'0'),'email','admin@example.test','admin',a,'incident',r)$$;
create function pg_temp.bi_reserve(n integer,ref text,incident boolean default false) returns jsonb language sql as $$
select case_api.beta_issue_dispatch(pg_temp.bi_actor(n),'reserve',jsonb_build_object('reference',ref,'digest',repeat('a',64),'draft',jsonb_build_object('operationId',case_app.uuid_v7(),'description','Original private prose','context','','expected','','steps','','frequency','unknown','impact','unknown','occurrence','','contactConsent',false,'incident',incident,'attachments','[]'::jsonb)))$$;
create temporary table bi_fixture as select pg_temp.bi_reserve(1,'BETA01') receipt;
select pg_temp.bi_assert(receipt->>'state'='pending','reservation not acceptance') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'accept',jsonb_build_object('id',receipt->>'id','digest',repeat('a',64)))->>'state'='accepted','accept exact reservation') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'accept',jsonb_build_object('id',receipt->>'id','digest',repeat('a',64)))->>'state'='accepted','lost-receipt replay') from bi_fixture;
select pg_temp.bi_assert((select count(*)=1 from case_app.beta_issue_events where issue_id=(receipt->>'id')::uuid),'single initial event') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'receipt',jsonb_build_object('id',receipt->>'operationId','digest',repeat('b',64)))->>'error'='conflict','digest mismatch') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2),'read',jsonb_build_object('id',receipt->>'id'))->>'error'='not_found','other account denied') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2),'list','{}')->'rows'='[]'::jsonb,'other account list denied');
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2),'list','{"adminView":true}')->>'error'='forbidden','workspace owner no admin queue');
select pg_temp.bi_assert(jsonb_array_length(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'list','{"adminView":true}')->'rows')=1,'ordinary admin sees ordinary issue');
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'list','{"adminView":true,"incidentView":true}')->>'error'='forbidden','unconfigured incident access denied');
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',receipt->>'id','expectedRevision',1,'change',jsonb_build_object('priority','high','publicReply','Please retry')))->>'revision'='2','revisioned triage') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',receipt->>'id','expectedRevision',1,'change',jsonb_build_object('priority','low')))->>'error'='conflict','CAS refuses stale writer') from bi_fixture;
select pg_temp.bi_assert(jsonb_array_length(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'read',jsonb_build_object('id',receipt->>'id'))->'followups')=2,'reporter sees submitted and public reply only') from bi_fixture;
select pg_temp.bi_assert(not(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'read',jsonb_build_object('id',receipt->>'id')) ? 'priority'),'internal triage hidden from reporter') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',receipt->>'id','expectedRevision',2,'change',jsonb_build_object('summary','Nonpersonal control failure')))->>'error'='review_required','nonpersonal review explicit') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',receipt->>'id','expectedRevision',2,'change',jsonb_build_object('restrict',true)))->>'restricted'='true','security reclassification') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'read',jsonb_build_object('adminView',true,'id',receipt->>'id'))->>'error'='not_found','ordinary known ID cannot reveal incident') from bi_fixture;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'list','{"adminView":true}')->'rows'='[]'::jsonb,'ordinary count/search excludes incidents');
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true,true),'read',jsonb_build_object('adminView',true,'incidentView',true,'id',receipt->>'id'))->>'incident'='true','designated incident admin reads') from bi_fixture;
-- Original evidence never survives the resolved deadline; reviewed summary does.
update case_app.beta_issues set resolved_at=clock_timestamp()-interval '31 days',summary='Reviewed engineering summary' where id=(select(receipt->>'id')::uuid from bi_fixture);
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'read',jsonb_build_object('id',receipt->>'id'))->'original'='null'::jsonb,'read-time deadline before sweep') from bi_fixture;
select case_api.beta_issue_sweep('purge','{}');
select pg_temp.bi_assert(original is null and principal is null and user_id is null and session_id is null and operation_digest is null and summary is null and title='Evidence deleted' and evidence_purged_at is not null,'all original identity/title/operation evidence purged') from case_app.beta_issues where id=(select(receipt->>'id')::uuid from bi_fixture);

-- Participant originals, titles, replies, attachment pointers and identity associations share the strict room cutoff.
insert into case_app.workspaces(id,slug,name) values('0199f100-0000-7000-8000-000000000010','beta-retention','Beta retention');
insert into case_app.cases(id,workspace_id,owner_id,title) values('0199f100-0000-7000-8000-000000000011','0199f100-0000-7000-8000-000000000010','0199f100-0000-7000-8000-000000000001','Fixture');
insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
 values('0199f100-0000-7000-8000-000000000012','0199f100-0000-7000-8000-000000000011',1,1,'{}',sha256('beta retention'),'0199f100-0000-7000-8000-000000000001');
insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,expires_at)
 values(case_app.uuid_v7(),'0199f100-0000-7000-8000-000000000012','0199f100-0000-7000-8000-000000000010','0199f100-0000-7000-8000-000000000001','BETAP1',clock_timestamp()+interval '1 hour');
create temporary table bi_participant as select jsonb_build_object('sessionId',id,'principal','room:'||repeat('a',64)) actor,case_app.uuid_v7() issue from case_app.sessions where join_code='BETAP1';
select case_api.beta_issue_dispatch(actor,'reserve',jsonb_build_object('reference','PART01','digest',repeat('a',64),'draft',jsonb_build_object('operationId',issue,'description','Participant original prose','context','Participant title','incident',false,'attachments','[]'::jsonb))) from bi_participant;
update bi_participant set issue=(select id from case_app.beta_issues where operation_id=bi_participant.issue);
select case_api.beta_issue_dispatch(actor,'accept',jsonb_build_object('id',issue,'digest',repeat('a',64))) from bi_participant;
update case_app.beta_issues set summary='Reviewed nonpersonal room defect' where id=(select issue from bi_participant);
insert into case_app.beta_issue_files(id,issue_id,r2_key,sha256,bytes,type,stored) select case_app.uuid_v7(),issue,'issues/'||issue||'/'||issue,repeat('a',64),1,'image/png',true from bi_participant;
update case_app.sessions set ended_at=clock_timestamp()-interval '25 hours',status='ended',personal_data_delete_at=clock_timestamp()-interval '1 hour' where join_code='BETAP1';
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'read',jsonb_build_object('adminView',true,'id',issue))->'original'='null'::jsonb,'participant read deadline before sweep') from bi_participant;
select case_api.purge_expired_participant_data();
select pg_temp.bi_assert(original is null and principal is null and user_id is null and session_id is null and operation_digest is null and title='Reviewed nonpersonal room defect' and summary='Reviewed nonpersonal room defect','participant originals purged; reviewed summary retained') from case_app.beta_issues where id=(select issue from bi_participant);
select pg_temp.bi_assert(not exists(select 1 from case_app.beta_issue_files where issue_id=(select issue from bi_participant)) and exists(select 1 from case_app.beta_issue_deletes where r2_key like 'issues/'||(select issue::text from bi_participant)||'/%'),'private attachment deletion durably queued');


-- Deleting a session cannot turn linked personal evidence into an unlinked indefinite report.
insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,expires_at)
 values(case_app.uuid_v7(),'0199f100-0000-7000-8000-000000000012','0199f100-0000-7000-8000-000000000010','0199f100-0000-7000-8000-000000000001','BETAP2',clock_timestamp()+interval '1 hour');
update bi_participant set actor=jsonb_build_object('sessionId',(select id from case_app.sessions where join_code='BETAP2'),'principal','room:'||repeat('b',64)),issue=case_app.uuid_v7();
select case_api.beta_issue_dispatch(actor,'reserve',jsonb_build_object('reference','PART02','digest',repeat('b',64),'draft',jsonb_build_object('operationId',issue,'description','Original before parent deletion','context','','incident',false,'attachments','[]'::jsonb))) from bi_participant;
update bi_participant set issue=(select id from case_app.beta_issues where operation_id=bi_participant.issue);
delete from case_app.sessions where join_code='BETAP2';
select pg_temp.bi_assert(original is null and principal is null and session_id is null and evidence_purged_at is not null,'session deletion purges originals before unlink') from case_app.beta_issues where id=(select issue from bi_participant);

-- Reopen after deadline cannot resurrect original evidence, contact/principal binding or summary prose.
create temporary table bi_reopen as select pg_temp.bi_reserve(1,'REPN01') receipt;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'accept',jsonb_build_object('id',receipt->>'id','digest',repeat('a',64))) from bi_reopen;
update case_app.beta_issues set resolved_at=clock_timestamp()-interval '31 days',status='Fixed',summary='Old reviewed prose' where id=(select(receipt->>'id')::uuid from bi_reopen);
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',receipt->>'id','expectedRevision',1,'change',jsonb_build_object('status','Investigating')))->'original'='null'::jsonb,'reopen after expiry retires original before resetting deadline') from bi_reopen;
select pg_temp.bi_assert(original is null and summary is null and principal is null and evidence_purged_at is not null,'reopen cannot resurrect expired summary or identity') from case_app.beta_issues where id=(select(receipt->>'id')::uuid from bi_reopen);

-- Optional screenshot failure cannot block a valid text report; the exact receipt names missing evidence.
create temporary table bi_missing as select case_app.uuid_v7() issue,case_app.uuid_v7() file;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'reserve',jsonb_build_object('reference','M1SS01','digest',repeat('a',64),'draft',jsonb_build_object('operationId',issue,'description','Text survives screenshot failure','context','','incident',false,'attachments',jsonb_build_array(jsonb_build_object('id',file,'sha256',repeat('a',64),'bytes',1,'type','image/png'))))) from bi_missing;
update bi_missing set issue=(select id from case_app.beta_issues where operation_id=bi_missing.issue);
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'accept',jsonb_build_object('id',issue,'digest',repeat('a',64)))->'attachmentOutcome'->0->>'state'='missing','accepted receipt explicitly records missing upload') from bi_missing;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'read',jsonb_build_object('id',issue))->'attachments'='[]'::jsonb,'missing screenshot is never readable') from bi_missing;


-- Duplicate graph changes are same-class, cycle-free and detached atomically on incident reclassification.
create temporary table bi_duplicates as select pg_temp.bi_reserve(1,'SAME01') a,pg_temp.bi_reserve(1,'SAME02') b;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'accept',jsonb_build_object('id',a->>'id','digest',repeat('a',64))) from bi_duplicates;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(1),'accept',jsonb_build_object('id',b->>'id','digest',repeat('a',64))) from bi_duplicates;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',b->>'id','expectedRevision',1,'change',jsonb_build_object('status','Duplicate','duplicate_of',a->>'id')))->>'status'='Duplicate','same-class duplicate admitted') from bi_duplicates;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',a->>'id','expectedRevision',1,'change',jsonb_build_object('status','Duplicate','duplicate_of',b->>'id')))->>'error'='bad_duplicate','duplicate cycle rejected') from bi_duplicates;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',a->>'id','expectedRevision',1,'change',jsonb_build_object('restrict',true))) from bi_duplicates;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'read',jsonb_build_object('adminView',true,'id',b->>'id'))->'duplicate_of'='null'::jsonb,'incident reclassification removes ordinary references') from bi_duplicates;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',b->>'id','expectedRevision',3,'change',jsonb_build_object('status','Duplicate','duplicate_of',a->>'id')))->>'error'='bad_duplicate','foreign-class target rejected uniformly') from bi_duplicates;


-- Client operation and screenshot UUIDs are scoped by principal and deployment; issue UUIDs are server-generated.
create temporary table bi_scope(op uuid,file uuid,local_receipt jsonb,stage_receipt jsonb,other_receipt jsonb);
insert into bi_scope(op,file) values(case_app.uuid_v7(),case_app.uuid_v7());
create function pg_temp.bi_scope_reserve(actor jsonb,ref text,op uuid,file uuid) returns jsonb language sql as $$select case_api.beta_issue_dispatch(actor,'reserve',jsonb_build_object('reference',ref,'digest',repeat('c',64),'draft',jsonb_build_object('operationId',op,'description','Namespace fixture','context','','incident',false,'attachments',jsonb_build_array(jsonb_build_object('id',file,'sha256',repeat('c',64),'bytes',1,'type','image/png')))))$$;
update bi_scope set local_receipt=pg_temp.bi_scope_reserve(pg_temp.bi_actor(1),'SC0PE1',op,file),stage_receipt=pg_temp.bi_scope_reserve(pg_temp.bi_actor(1)||'{"deployment":"staging"}','SC0PE2',op,file),other_receipt=pg_temp.bi_scope_reserve(pg_temp.bi_actor(4),'SC0PE3',op,file);
select pg_temp.bi_assert(local_receipt->>'state'='pending' and stage_receipt->>'state'='pending' and other_receipt->>'state'='pending' and local_receipt->>'id'<>stage_receipt->>'id' and local_receipt->>'id'<>other_receipt->>'id' and local_receipt->>'id'<>op::text,'independent server IDs and scoped operations/files') from bi_scope;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(1)||'{"deployment":"staging"}','receipt',jsonb_build_object('id',op,'digest',repeat('c',64)))->>'id'=stage_receipt->>'id','receipt namespace cannot select another deployment') from bi_scope;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true)||'{"deployment":"staging"}','read',jsonb_build_object('adminView',true,'id',local_receipt->>'id'))->>'error'='not_found','cross-deployment known ID hidden from administrators') from bi_scope;
update case_app.beta_issues set created_at=clock_timestamp()-interval '26 hours' where id=(select(stage_receipt->>'id')::uuid from bi_scope);
select case_api.beta_issue_sweep('purge','{}');
select pg_temp.bi_assert(case_api.beta_issue_sweep('deletes','{"deployment":"staging"}') ? ('issues/'||(stage_receipt->>'id')||'/'||file) and not(case_api.beta_issue_sweep('deletes','{"deployment":"local"}') ? ('issues/'||(stage_receipt->>'id')||'/'||file)),'R2 deletion queue bound to deployment') from bi_scope;


-- An overdue canonical reopen cannot revive duplicate evidence that the periodic sweep has not processed yet.
create temporary table bi_family as select pg_temp.bi_reserve(4,'TT10P1') a,pg_temp.bi_reserve(4,'TT10C1') b;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(4),'accept',jsonb_build_object('id',a->>'id','digest',repeat('a',64))) from bi_family;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(4),'accept',jsonb_build_object('id',b->>'id','digest',repeat('a',64))) from bi_family;
select case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',b->>'id','expectedRevision',1,'change',jsonb_build_object('status','Duplicate','duplicate_of',a->>'id'))) from bi_family;
update case_app.beta_issues set status='Closed',resolved_at=clock_timestamp()-interval '31 days' where id=(select(a->>'id')::uuid from bi_family);
select case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',a->>'id','expectedRevision',1,'change',jsonb_build_object('status','Investigating'))) from bi_family;
select pg_temp.bi_assert(original is null and principal is null and evidence_purged_at is not null,'canonical reopen cannot resurrect expired duplicate originals') from case_app.beta_issues where id=(select(b->>'id')::uuid from bi_family);


-- Expiry hides hashes and file correlation IDs immediately, before physical sweep/receipt cleanup.
create temporary table bi_expiry as select case_app.uuid_v7() op,case_app.uuid_v7() file;
select pg_temp.bi_scope_reserve(pg_temp.bi_actor(4),'EXPR01',op,file) from bi_expiry;
update case_app.beta_issue_files set stored=true where issue_id=(select id from case_app.beta_issues where operation_id=(select op from bi_expiry));
select case_api.beta_issue_dispatch(pg_temp.bi_actor(4),'accept',jsonb_build_object('id',(select id from case_app.beta_issues where operation_id=op),'digest',repeat('c',64))) from bi_expiry;
update case_app.beta_issues set status='Closed',resolved_at=clock_timestamp()-interval '31 days' where operation_id=(select op from bi_expiry);
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'read',jsonb_build_object('adminView',true,'id',(select id from case_app.beta_issues where operation_id=op)))->'attachmentOutcome'='[]'::jsonb,'expired detail hides screenshot hashes and slot IDs before sweep') from bi_expiry;
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(4),'receipt',jsonb_build_object('id',op,'digest',repeat('c',64)))->>'error'='evidence_expired','expired receipt hides evidence digests') from bi_expiry;


-- Keep reviewed summary prose in its single TTL-governed field, never duplicate it into a durable change record.
select case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',a->>'id','expectedRevision',2,'change',jsonb_build_object('summary','Reviewed summary after original expiry','reviewedNonpersonal',true))) from bi_family;
select pg_temp.bi_assert(not exists(select 1 from case_app.beta_issue_events where issue_id=(select(a->>'id')::uuid from bi_family) and changes ? 'summary'),'triage history never duplicates reviewed-summary prose');


-- Reviewed engineering issues can still be verified/fixed after participant originals have expired.
select pg_temp.bi_assert(case_api.beta_issue_dispatch(pg_temp.bi_actor(2,true),'triage',jsonb_build_object('adminView',true,'id',a->>'id','expectedRevision',3,'change',jsonb_build_object('status','Fixed','verified_build',repeat('a',40),'summary','Verified the nonpersonal control behavior on the recorded build','reviewedNonpersonal',true)))->>'status'='Fixed','post-expiry fix accepts reviewed nonpersonal verification without expired notes') from bi_family;
select pg_temp.bi_assert(not exists(select 1 from case_app.beta_issue_events where issue_id=(select(a->>'id')::uuid from bi_family) and (body is not null or changes ? 'summary')),'post-expiry verification stores prose only in the TTL-governed summary');

-- Hourly quota counts reservations; repeated exact operation is not charged again.
do $$declare n integer;v jsonb;begin for n in 1..10 loop v:=pg_temp.bi_reserve(2,'H000'||lpad(n::text,2,'0'));perform pg_temp.bi_assert(v->>'state'='pending','hour quota initial slots');end loop;perform pg_temp.bi_assert(pg_temp.bi_reserve(2,'H00011')->>'error'='rate_limited','eleventh report refused');end$$;
-- Daily bound is independent of hourly bound.
do $$declare n integer;v jsonb;begin for n in 1..30 loop v:=pg_temp.bi_reserve(3,'D000'||lpad(n::text,2,'0'));perform pg_temp.bi_assert(v->>'state'='pending','daily quota initial slots');update case_app.beta_issues set created_at=clock_timestamp()-interval '2 hours' where id=(v->>'id')::uuid;end loop;perform pg_temp.bi_assert(pg_temp.bi_reserve(3,'D00031')->>'error'='rate_limited','daily report bound');end$$;
-- Service-only RPCs and private tables: no browser grants.
select pg_temp.bi_assert(not has_table_privilege('anon','case_app.beta_issues','SELECT') and not has_table_privilege('authenticated','case_app.beta_issue_files','SELECT'),'private table ACLs');
select pg_temp.bi_assert(not has_function_privilege('authenticated','case_api.beta_issue_dispatch(jsonb,text,jsonb)','EXECUTE') and has_function_privilege('service_role','case_api.beta_issue_dispatch(jsonb,text,jsonb)','EXECUTE'),'RPC ACLs');
rollback;
