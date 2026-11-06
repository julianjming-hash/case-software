// Two real Postgres sessions contend on the actual save/release transaction boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { miniCase } from '../../tests/helpers/mini-case.mjs';
import { acknowledgedBuilderPair } from '../../src/client/builder-workflows.mjs';
import publishFixture from '../../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
const exec = promisify(execFile);
const binary = process.env.CASE_TEST_PSQL_BIN, socket = process.env.CASE_TEST_PG_SOCKET;
if (!binary?.endsWith('/psql') || !socket?.startsWith('/') || !socket.includes('/')) throw Error('local_postgres_test_boundary_required');
const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const query = async sql => (await exec(binary, [...args, '-c', sql], { timeout: 5000 })).stdout.trim();
const metadata = '{"metadata_version":1}';

test('a real JSONB round trip preserves a publishable acknowledged pair without reloading the editor', async () => {
  const document = structuredClone(publishFixture), authoringMetadata = { metadata_version: 1 };
  const latest = JSON.parse(await query(`select jsonb_build_object('revision',7,'document',${literal(JSON.stringify(document))}::jsonb,'authoringMetadata',${literal(JSON.stringify(authoringMetadata))}::jsonb,'intentDigest',${literal('\\x'+'a'.repeat(64))})::text`));
  assert.notEqual(JSON.stringify(document), JSON.stringify(latest.document));
  const snapshot = { document, authoringMetadata, baseRevision: 7, localGeneration: 4, dirty: false, status: 'saved' };
  const result = await acknowledgedBuilderPair({ readLatest: async () => latest, getSnapshot: () => snapshot });
  assert.deepEqual(result.document, document);
  assert.deepEqual(result.authoringMetadata, authoringMetadata);
});
async function fixture() {
  const author=uuidv7(),admin=uuidv7(),workspace=uuidv7(),caseId=uuidv7(),request=uuidv7();
  const document=miniCase().doc;
  await query(`insert into auth.users values (${literal(author)}),(${literal(admin)});
    insert into case_app.profiles(id,display_name) values (${literal(author)},'Race author');
    insert into case_app.workspaces(id,slug,name) values (${literal(workspace)},${literal(`race-${workspace}`)},'Local race');
    insert into case_app.workspace_members(workspace_id,user_id,role) values (${literal(workspace)},${literal(author)},'author');
    insert into case_app.cases(id,workspace_id,owner_id,title) values (${literal(caseId)},${literal(workspace)},${literal(author)},'Local race');`);
  const operation = await query(`select operation_id from case_api.builder_open_save_window(${literal(caseId)},0,${literal(author)},false,null)`);
  await query(`select revision from case_api.builder_save_draft(${literal(caseId)},${literal(operation)},${literal(JSON.stringify(document))}::jsonb,${literal(metadata)}::jsonb,${literal(author)},false,null)`);
  const candidate = await query(`select candidate_id from case_api.builder_submit_candidate(${literal(caseId)},${literal(request)},1,${literal(JSON.stringify(document))}::jsonb,${literal(metadata)}::jsonb,${literal(author)},false,null)`);
  const binding = `${literal(caseId)},${literal(candidate)},1,(select intent_digest from case_app.builder_candidates where candidate_id=${literal(candidate)}),(select content_sha256 from case_app.builder_candidates where candidate_id=${literal(candidate)})`;
  await query(`select status from case_api.builder_approve_candidate(${binding},${literal(admin)},true,'reviewer@example.test')`);
  const art = `(select case_app.art_structure(document)||'{"attempt":0,"summarised":false,"renderer":1}'::jsonb from case_app.case_drafts where case_id=${literal(caseId)})`;
  const release = `select version_id from case_api.builder_release_candidate(${binding},'{}',${art},${literal(admin)},true,'reviewer@example.test')`;
  const next = await query(`select operation_id from case_api.builder_open_save_window(${literal(caseId)},1,${literal(author)},false,null)`);
  const changed = {...document,title:'Changed after reviewed snapshot'};
  const save = `select revision from case_api.builder_save_draft(${literal(caseId)},${literal(next)},${literal(JSON.stringify(changed))}::jsonb,${literal(metadata)}::jsonb,${literal(author)},false,null)`;
  const submit = id => `select candidate_id from case_api.builder_submit_candidate(${literal(caseId)},${literal(id)},1,${literal(JSON.stringify(document))}::jsonb,${literal(metadata)}::jsonb,${literal(author)},false,null)`;
  return {caseId,candidate,release,save,submit};
}
async function contend(firstSql, secondSql) {
  const first=spawn(binary,args,{stdio:['pipe','pipe','pipe']}), secondName=`builder-race-${uuidv7()}`;
  let output='',errors=''; first.stdout.on('data',chunk=>{output+=chunk;});first.stderr.on('data',chunk=>{errors+=chunk;});
  const ended=new Promise(resolve=>first.on('exit',code=>resolve(code)));
  first.stdin.write(`begin; set local statement_timeout='4s'; ${firstSql}; select 'RACE_HELD';\n`);
  try {
    const until=Date.now()+3000;
    while(!output.includes('RACE_HELD')) {if(Date.now()>until)throw Error(`first_session_not_ready: ${errors}`);await new Promise(resolve=>setTimeout(resolve,10));}
    const second=exec(binary,[...args,'-c',`set application_name=${literal(secondName)}; set statement_timeout='4s'; ${secondSql}`],{timeout:6000})
      .then(value=>({ok:true,stdout:value.stdout.trim()}),error=>({ok:false,stderr:error.stderr}));
    const blockedUntil=Date.now()+3000;let blocked=false;
    while(!blocked) {blocked=await query(`select exists(select 1 from pg_stat_activity where application_name=${literal(secondName)} and wait_event_type='Lock')`)==='t';if(Date.now()>blockedUntil)throw Error('second_session_never_contended');if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));}
    first.stdin.end('commit;\n');assert.equal(await ended,0,errors);
    return {first:output.split('\n').filter(line=>line&&line!=='RACE_HELD').at(-1),second:await second};
  } finally {if(first.exitCode===null){first.stdin.end('rollback;\n');first.kill();}}
}

test('concurrent exact release requests produce one immutable version and the same durable result',async()=>{
 const f=await fixture(),r=await contend(f.release,f.release);
 assert.equal(r.second.ok,true,r.second.stderr);assert.equal(r.second.stdout,r.first);
 assert.equal(await query(`select count(*) from case_app.case_versions where case_id=${literal(f.caseId)}`),'1');
});
test('draft mutation committed ahead of a contending release invalidates its old approval',async()=>{
 const f=await fixture(),r=await contend(f.save,f.release);
 assert.equal(r.second.ok,false);assert.match(r.second.stderr,/candidate_not_releasable|candidate_stale/);
 assert.equal(await query(`select count(*) from case_app.case_versions where case_id=${literal(f.caseId)}`),'0');
 assert.equal(await query(`select status from case_app.builder_candidates where candidate_id=${literal(f.candidate)}`),'superseded');
});
test('release committed ahead of a contending edit keeps the exact immutable version and a newer private draft',async()=>{
 const f=await fixture(),r=await contend(f.release,f.save);
 assert.equal(r.second.ok,true,r.second.stderr);assert.equal(r.second.stdout,'2');
 assert.equal(await query(`select count(*) from case_app.case_versions v join case_app.case_drafts d on d.case_id=v.case_id where v.case_id=${literal(f.caseId)} and v.document is distinct from d.document`),'1');
 assert.equal(await query(`select status from case_app.builder_candidates where candidate_id=${literal(f.candidate)}`),'released');
});

test('concurrent new submission identities reuse the approved candidate without supersession',async()=>{
 const f=await fixture(),r=await contend(f.submit(uuidv7()),f.submit(uuidv7()));
 assert.equal(r.second.ok,true,r.second.stderr);assert.equal(r.first,f.candidate);assert.equal(r.second.stdout,f.candidate);
 assert.equal(await query(`select count(*) from case_app.builder_candidates where case_id=${literal(f.caseId)}`),'1');
 assert.equal(await query(`select status from case_app.builder_candidates where candidate_id=${literal(f.candidate)}`),'approved');
});
