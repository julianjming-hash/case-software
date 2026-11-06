// Real workerd release route -> local PostgreSQL transaction committed as service_role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startPublishedWorker } from '../helpers/published-worker.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { RPC_ARGUMENTS } from '../../src/worker/rpc.mjs';
const binary = process.env.CASE_TEST_PSQL_BIN, socket = process.env.CASE_TEST_PG_SOCKET;
if (!binary?.endsWith('/psql') || !socket?.startsWith('/')) throw Error('local_postgres_test_boundary_required');
const literal = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const query = sql => execFileSync(binary, ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
const json = value => `${literal(JSON.stringify(value))}::jsonb`;

test('[AS-123] schema-3 revision 243 commits via workerd as service_role, with exact media and replay', async () => {
  const worker = await startPublishedWorker({admin:{email:'reviewer@example.test',stepupSecret:'local-test-only',origin:'https://case.test'}});
  try {
    const {userId,workspaceId,caseId} = worker;
    query(`insert into auth.users values (${literal(userId)});
      insert into case_app.profiles(id,display_name) values (${literal(userId)},'Local reviewer');
      insert into case_app.workspaces(id,slug,name) values (${literal(workspaceId)},${literal(`release-${workspaceId}`)},'Local release');
      insert into case_app.cases(id,workspace_id,owner_id,title) values (${literal(caseId)},${literal(workspaceId)},${literal(userId)},'Synthetic release');`);
    const assets = [];
    for (const digit of ['a','b','c']) {
      const rendition = {sha256:digit.repeat(64),bytes:4000,width:1200,height:800,type:'image/jpeg'};
      const details = {alt_text:'Synthetic image',evidence_kind:'other',rights_basis:'own_work',licence:'own-work'};
      const asset = JSON.parse(query(`select case_api.builder_create_asset(${literal(workspaceId)},${literal(userId)},true,'reviewer@example.test',${json(rendition)},${json({...rendition,width:640,height:427})},${json(details)})`));
      assets.push(asset.asset_id);
      // Approved as shown (card 62): the stored state and its open warnings, as the Builder sends them.
      query(`select case_api.admin_review_asset(${literal(workspaceId)},${literal(asset.asset_id)},'approve',(select case_app.asset_review_state(r) from case_app.assets r where r.id=${literal(asset.asset_id)}),(select case_app.asset_open_warnings(r) from case_app.assets r where r.id=${literal(asset.asset_id)}),${literal(userId)},true,'reviewer@example.test')`);
    }
    const beat = uuidv7();
    const document = {schema_version:3,title:'Synthetic release',start_beat_id:beat,beats:[{id:beat,kind:'debrief',title:'End'}],decisions:[],blocks:[...assets,assets[0]].map(asset_id=>({id:uuidv7(),type:'image',asset_id}))};
    const source = uuidv7(), metadata = {metadata_version:1,sources:[{id:source,title:'Synthetic source',text:'Local fixture',sha256:query("select encode(sha256(convert_to('Local fixture','UTF8')),'hex')"),rights_status:'permitted'}],provenance:[{entity_id:beat,field:'title',source_id:source,start_line:1,end_line:1,transformation:'adapted',visibility:'public',review_status:'confirmed'}]};
    const operation = query(`select operation_id from case_api.builder_open_save_window(${literal(caseId)},0,${literal(userId)},true,'reviewer@example.test')`);
    query(`select revision from case_api.builder_save_draft(${literal(caseId)},${literal(operation)},${json(document)},${json(metadata)},${literal(userId)},true,'reviewer@example.test'); update case_app.case_drafts set revision=243 where case_id=${literal(caseId)}`);
    const candidate = JSON.parse(query(`select row_to_json(r) from case_api.builder_submit_candidate(${literal(caseId)},${literal(uuidv7())},243,${json(document)},${json(metadata)},${literal(userId)},true,'reviewer@example.test') r`));
    query(`select status from case_api.builder_approve_candidate(${literal(caseId)},${literal(candidate.candidate_id)},243,${literal(candidate.intent_digest)}::bytea,${literal(candidate.content_sha256)}::bytea,${literal(userId)},true,'reviewer@example.test')`);
    worker.fake.replies.set('get_case_authoring_access', [{case_id:caseId,workspace_id:workspaceId,role:'admin'}]);
    // Step A3: candidate routes read the caller's access to the case once (case_api.get_access), with the policies.
    worker.fake.replies.set('get_access', [{case_id:caseId,workspace_id:workspaceId,member_role:null,grant_level:null,role:'admin',scope:'workspace',
      policies:{managers_invite:true,editors_publish:false,runners_share:false,managers_see_records:true}}]);
    // The HTTP transport remains a local PostgREST stand-in; SQL and commit permissions are real.
    const sqlErrors = [];
    worker.fake.replies.set('builder_release_candidate', args => {
      const types = ['uuid','uuid','bigint','bytea','bytea','uuid[]','jsonb','uuid','boolean','text'];
      const values = RPC_ARGUMENTS.builder_release_candidate.map((name,i) => {
        const value = args[name];
        const encoded = types[i] === 'jsonb' ? JSON.stringify(value) : types[i] === 'uuid[]' ? `{${value.join(',')}}` : value;
        return `${literal(encoded)}::${types[i]}`;
      });
      try { return JSON.parse(query(`begin; set local role service_role; select coalesce(json_agg(r),'[]') from case_api.builder_release_candidate(${values.join(',')}) r; commit;`)); }
      catch (error) { sqlErrors.push(error.stderr); throw error; }
    });
    const art = JSON.parse(query(`select case_app.art_structure(${json(document)})||'{"attempt":0,"summarised":false,"renderer":1}'::jsonb`));
    const body = {revision:243,intentDigest:candidate.intent_digest,contentSha256:candidate.content_sha256,assetIds:assets,art};
    const release = async value => {
      const response = await fetch(`${worker.origin}/api/v1/builder/cases/${caseId}/candidates/${candidate.candidate_id}/release`,{method:'POST',headers:{authorization:`Bearer ${worker.jwt}`,'content-type':'application/json'},body:JSON.stringify(value)});
      return {status:response.status,body:await response.json()};
    };
    // A missing image must still roll back the entire release.
    const incomplete = await release({...body,assetIds:assets.slice(1)});
    assert.notEqual(incomplete.status,200);
    assert.match(sqlErrors.at(-1), /version_assets_mismatch/);
    assert.equal(query(`select count(*) from case_app.case_versions where case_id=${literal(caseId)}`),'0');
    assert.equal(query(`select status from case_app.builder_candidates where candidate_id=${literal(candidate.candidate_id)}`),'approved');
    const first = await release(body);
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.equal(first.body.status,'released');
    const replay = await release(body);
    assert.deepEqual(replay,first);
    assert.equal(query(`select count(*) from case_app.case_versions where case_id=${literal(caseId)}`),'1');
    assert.equal(query(`select count(*) from case_app.case_version_assets where case_version_id=${literal(first.body.versionId)}`),'3');
    assert.equal(query("select has_table_privilege('service_role','case_app.case_versions','select')"),'f');
  } finally { await worker.stop(); }
});
