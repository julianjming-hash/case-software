// Two real Postgres sessions contend on the actual save/release transaction boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from '../../src/shared/ids.mjs';
const exec = promisify(execFile);
const binary = process.env.CASE_TEST_PSQL_BIN, socket = process.env.CASE_TEST_PG_SOCKET;
if (!binary?.endsWith('/psql') || !socket?.startsWith('/') || !socket.includes('/')) throw Error('local_postgres_test_boundary_required');
const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const query = async sql => (await exec(binary, [...args, '-c', sql], { timeout: 5000 })).stdout.trim();
async function contend(firstSql, secondSql) {
  const first=spawn(binary,args,{stdio:['pipe','pipe','pipe']}), secondName=`membership-race-${uuidv7()}`;
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


async function issueFixture(){const user=uuidv7();await query(`insert into auth.users(id) values(${literal(user)});insert into case_app.profiles(id) values(${literal(user)});`);return{user,actor:{userId:user,principal:`user:${user}`}};}
const reserve=(f,id,reference,digest='a'.repeat(64))=>`select case_api.beta_issue_dispatch(${literal(JSON.stringify(f.actor))}::jsonb,'reserve',${literal(JSON.stringify({reference,digest,draft:{operationId:id,description:'Concurrent operation',context:'',incident:false,attachments:[]}}))}::jsonb)`;
test('concurrent replay reserves one issue and concurrent acceptance creates one initial event',async()=>{const f=await issueFixture(),id=uuidv7(),r=await contend(reserve(f,id,'RACE01'),reserve(f,id,'RACE02'));assert.equal(r.second.ok,true);assert.equal(JSON.parse(r.second.stdout.split('\n').at(-1)).state,'pending');assert.equal(await query(`select count(*) from case_app.beta_issues where operation_id=${literal(id)}`),'1');const reportId=await query(`select id from case_app.beta_issues where operation_id=${literal(id)}`);const accept=`select case_api.beta_issue_dispatch(${literal(JSON.stringify(f.actor))}::jsonb,'accept',${literal(JSON.stringify({id:reportId,digest:'a'.repeat(64)}))}::jsonb)`;await contend(accept,accept);assert.equal(await query(`select count(*) from case_app.beta_issue_events where issue_id=${literal(reportId)}`),'1');});
test('two contenders for the last hourly quota slot cannot both reserve',async()=>{const f=await issueFixture();for(let n=0;n<9;n++)await query(reserve(f,uuidv7(),`QXTA0${n}`));const r=await contend(reserve(f,uuidv7(),'QXTA10'),reserve(f,uuidv7(),'QXTA11'));assert.equal(r.second.ok,true);assert.equal(JSON.parse(r.second.stdout.split('\n').at(-1)).error,'rate_limited');assert.equal(await query(`select count(*) from case_app.beta_issues where principal=${literal(f.actor.principal)}`),'10');});
