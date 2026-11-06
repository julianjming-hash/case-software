-- CASE-364: authorised content-free summaries bind review/publication evidence to current intent.
\set QUIET on
begin;
insert into auth.users values
 ('0199a000-0000-7000-8000-00000000c801'),('0199a000-0000-7000-8000-00000000c802'),('0199a000-0000-7000-8000-00000000c803');
insert into case_app.profiles(id,display_name) values
 ('0199a000-0000-7000-8000-00000000c801','Owner'),('0199a000-0000-7000-8000-00000000c802','Author'),('0199a000-0000-7000-8000-00000000c803','Facilitator');
insert into case_app.workspaces(id,slug,name) values
 ('0199a000-0000-7000-8000-00000000c810','c48-list-a','C48 list A'),('0199a000-0000-7000-8000-00000000c811','c48-list-b','C48 list B');
insert into case_app.workspace_members(workspace_id,user_id,role) values
 ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','owner'),
 ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c802','author'),
 ('0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c803','facilitator');
insert into case_app.cases(id,workspace_id,owner_id,title,archived_at) values
 ('0199a000-0000-7000-8000-00000000c820','0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c801','Fallback title',null),
 ('0199a000-0000-7000-8000-00000000c821','0199a000-0000-7000-8000-00000000c810','0199a000-0000-7000-8000-00000000c802','Archived title',now()),
 ('0199a000-0000-7000-8000-00000000c822','0199a000-0000-7000-8000-00000000c811','0199a000-0000-7000-8000-00000000c801','Other workspace',null);
insert into case_app.case_drafts(case_id,revision,schema_version,document,updated_by,updated_at) values
 ('0199a000-0000-7000-8000-00000000c820',3,1,'{"schema_version":1,"title":"Private title","scene":"PRIVATE BODY SENTINEL"}','0199a000-0000-7000-8000-00000000c802','2026-10-09T12:00:00Z'),
 ('0199a000-0000-7000-8000-00000000c821',4,1,'{"schema_version":1,"title":"Archived"}','0199a000-0000-7000-8000-00000000c802','2026-10-09T13:00:00Z'),
 ('0199a000-0000-7000-8000-00000000c822',5,1,'{"schema_version":1,"title":"Other"}','0199a000-0000-7000-8000-00000000c802','2026-10-09T14:00:00Z');
create function pg_temp.refused(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return null; exception when others then return sqlstate||' '||sqlerrm; end $$;
do $$
declare r record; old_result jsonb; new_result jsonb; err text;
begin
 select jsonb_agg(to_jsonb(x)) into old_result from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c802',false,null)x;
 select * into strict r from case_api.builder_list_draft_summaries('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c802',false,null);
 if r.case_id<>'0199a000-0000-7000-8000-00000000c820' or r.revision<>3 or r.publication_state<>'none' or r.review_status is not null then raise exception 'summary facts fabricated';end if;
 if position('PRIVATE BODY SENTINEL' in to_jsonb(r)::text)>0 or to_jsonb(r)?'document' or to_jsonb(r)?'authoring_metadata' then raise exception 'summary leaks body';end if;
 select jsonb_agg(to_jsonb(x)) into new_result from case_api.builder_list_drafts('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c802',false,null)x;
 if old_result is distinct from new_result then raise exception 'legacy inventory changed';end if;
 err:=pg_temp.refused($q$select * from case_api.builder_list_draft_summaries('0199a000-0000-7000-8000-00000000c810',50,0,'0199a000-0000-7000-8000-00000000c803',false,null)$q$);
 if err is null or err not like '42501%' then raise exception 'facilitator summary access';end if;
 err:=pg_temp.refused($q$select * from case_api.builder_list_draft_summaries('0199a000-0000-7000-8000-00000000c810',51,0,'0199a000-0000-7000-8000-00000000c802',false,null)$q$);
 if err is null or err not like '22023%' then raise exception 'unbounded summary';end if;
 if has_function_privilege('anon','case_api.builder_list_draft_summaries(uuid,integer,integer,uuid,boolean,text)','execute') or has_function_privilege('authenticated','case_api.builder_list_draft_summaries(uuid,integer,integer,uuid,boolean,text)','execute') or not has_function_privilege('service_role','case_api.builder_list_draft_summaries(uuid,integer,integer,uuid,boolean,text)','execute') then raise exception 'summary execute grants';end if;
 raise notice 'ok CASE-364 bounded service-only content-free draft summary preserves legacy reads';
end $$;
do $$
declare
 c uuid:='0199a000-0000-7000-8000-00000000c820'; w uuid:='0199a000-0000-7000-8000-00000000c810';
 u uuid:='0199a000-0000-7000-8000-00000000c802'; v uuid:=case_app.uuid_v7(); candidate uuid;
 d jsonb:='{"schema_version":1,"title":"PRIVATE TITLE","audience":"Residents","duration_min":30,"start_beat_id":"PRIVATE-BEAT-1","beats":[{"id":"PRIVATE-BEAT-1","kind":"decision","decision_id":"PRIVATE-DECISION"},{"id":"PRIVATE-BEAT-2","kind":"surface","text":"PRIVATE BODY SENTINEL"}],"decisions":[{"id":"PRIVATE-DECISION","paths":[{"recommended":true,"next_beat_id":"PRIVATE-BEAT-2"},{"terminal":true,"label":"PRIVATE PATH"}]}]}';
 intent bytea; r record; large_doc jsonb;
begin
 update case_app.case_drafts set document=d,authoring_metadata='{}' where case_id=c;
 intent:=case_app.builder_intent_digest(d,'{}');
 insert into case_app.case_versions(id,case_id,version_no,schema_version,document,content_sha256,published_by)
 values(v,c,1,1,d,sha256(convert_to(d::text,'UTF8')),u);
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.publication_state<>'unknown' or r.publication_version<>1 then raise exception 'legacy publication invented comparison';end if;
 if r.audience<>'Residents' or r.duration_min<>30 or r.art_structure<> '{"v":1,"stops":2,"decisions":[{"stop":0,"strands":[],"resets":1,"ends":0}]}'::jsonb then raise exception 'current graph summary lost: %',to_jsonb(r);end if;
 if r.art_structure::text like '%PRIVATE%' or to_jsonb(r)?'intent_digest' then raise exception 'private graph labels/digest leaked';end if;
 insert into case_app.builder_candidates(case_id,workspace_id,submitted_by,request_id,revision,schema_version,intent_digest,content_sha256,status,released_version_id,release_digest,released_at)
 values(c,w,u,case_app.uuid_v7(),3,1,intent,sha256(convert_to(d::text,'UTF8')),'released',v,intent,now());
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.publication_state<>'unchanged' then raise exception 'matching released intent lost';end if;
 update case_app.case_drafts set authoring_metadata='{"notes":"PRIVATE METADATA SENTINEL"}' where case_id=c;
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.publication_state<>'changed' or to_jsonb(r)::text like '%METADATA SENTINEL%' then raise exception 'paired metadata comparison/leak';end if;
 intent:=case_app.builder_intent_digest(d,'{"notes":"PRIVATE METADATA SENTINEL"}');
 insert into case_app.builder_candidates(case_id,workspace_id,submitted_by,request_id,revision,schema_version,document,authoring_metadata,intent_digest,content_sha256,status)
 values(c,w,u,case_app.uuid_v7(),3,1,d,'{"notes":"PRIVATE METADATA SENTINEL"}',intent,sha256(convert_to(d::text,'UTF8')),'pending') returning candidate_id into candidate;
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.review_status<>'pending' then raise exception 'current pending review lost';end if;
 update case_app.builder_candidates set status='approved',approved_by=u,approved_at=now(),approved_intent_digest=intent,approved_content_sha256=content_sha256 where candidate_id=candidate;
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.review_status<>'approved' then raise exception 'current approval lost';end if;
 update case_app.case_drafts set revision=4 where case_id=c;
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.review_status is not null then raise exception 'stale revision reused approval';end if;
 update case_app.case_drafts set revision=3,authoring_metadata='{}' where case_id=c;
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.review_status is not null then raise exception 'stale paired intent reused approval';end if;
 insert into case_app.case_versions(case_id,version_no,schema_version,document,content_sha256,published_by)
 values(c,2,1,d,sha256(convert_to(d::text,'UTF8')),u) returning id into v;
 insert into case_app.admin_version_state(case_version_id,status) values(v,'withdrawn');
 select * into strict r from case_api.builder_list_draft_summaries(w,50,0,u,false,null);
 if r.publication_version<>2 or r.publication_state<>'unknown' then raise exception 'latest withdrawn publication history concealed or comparison fabricated';end if;
 if exists(select 1 from case_api.builder_list_draft_summaries(w,1,1,u,false,null)) then raise exception 'page offset ignored';end if;
 if case_app.draft_art_summary('{"beats":{},"decisions":[]}') is not null or case_app.draft_art_summary('{"beats":[{}]}') is not null then raise exception 'malformed art not degraded';end if;
 select jsonb_build_object('start_beat_id','b1','beats',jsonb_agg(jsonb_build_object('id','b'||i,'kind','decision','decision_id','d'||i)), 'decisions',jsonb_agg(jsonb_build_object('id','d'||i,'paths',jsonb_build_array(jsonb_build_object('recommended',true,'next_beat_id','b'||(i+1)))))) into large_doc from generate_series(1,150)i;
 if case_app.draft_art_summary(large_doc) is not null then raise exception 'oversize art not bounded';end if;
 raise notice 'ok CASE-364 current numbers-only art, paired intent, stale approval, withdrawn history and page/size bounds';
end $$;
rollback;
