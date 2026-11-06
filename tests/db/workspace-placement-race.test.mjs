// CASE-373: real two-session contention verifies post-lock placement and revocation checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {uuidv7} from '../../src/shared/ids.mjs';
const exec=promisify(execFile),binary=process.env.CASE_TEST_PSQL_BIN,socket=process.env.CASE_TEST_PG_SOCKET;
if(!binary?.endsWith('/psql')||!socket?.startsWith('/'))throw Error('local_postgres_test_boundary_required');
const args=['-h',socket,'-U','postgres','-d','postgres','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'];
const literal=v=>`'${String(v).replaceAll("'","''")}'`;
const query=async sql=>(await exec(binary,[...args,'-c',sql],{timeout:5000})).stdout.trim();
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

async function fixture({shared=false}={}){
 const owner=uuidv7(),editor=uuidv7(),home=uuidv7(),destination=uuidv7(),caseId=uuidv7();
 await query(`insert into auth.users(id) values(${literal(owner)}),(${literal(editor)});
 insert into case_app.profiles(id) values(${literal(owner)}),(${literal(editor)});
 insert into case_app.workspaces(id,slug,name) values(${literal(home)},${literal('wpr-'+home)},'Home'),(${literal(destination)},${literal('wpr-'+destination)},'Destination');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(${literal(home)},${literal(owner)},'owner'),(${literal(destination)},${literal(owner)},'owner'),(${literal(shared?destination:home)},${literal(editor)},'author');
 insert into case_app.cases(id,workspace_id,owner_id,title) values(${literal(caseId)},${literal(home)},${literal(owner)},'Placement race');
 ${shared?`insert into case_app.case_workspace_access(case_id,workspace_id,level) values(${literal(caseId)},${literal(destination)},'edit');`:''}`);
 return{owner,editor,home,destination,caseId,move:`select case_api.move_case_workspace(${literal(owner)},${literal(caseId)},${literal(destination)},0,false,null)`,open:`select operation_id from case_api.builder_open_save_window(${literal(caseId)},0,${literal(editor)},false,null)`};
}
test('a writer queued behind a home move refuses its stale home before opening a save window',async()=>{
 const f=await fixture(),r=await contend(f.move,f.open);assert.equal(r.second.ok,false);assert.match(r.second.stderr,/case_workspace_changed/);
 assert.equal(await query(`select workspace_id from case_app.cases where id=${literal(f.caseId)}`),f.destination);
 assert.equal(await query(`select count(*) from case_app.builder_save_windows where case_id=${literal(f.caseId)}`),'0');
});
test('a writer queued behind workspace-share revocation rechecks case access after the lock',async()=>{
 const f=await fixture({shared:true}),revoke=`select case_api.set_case_workspace_access(${literal(f.owner)},${literal(f.caseId)},${literal(f.destination)},null,0,false,null)`;
 const r=await contend(revoke,f.open);assert.equal(r.second.ok,false);assert.match(r.second.stderr,/not_authorised/);
 assert.equal(await query(`select count(*) from case_app.builder_save_windows where case_id=${literal(f.caseId)}`),'0');
});
test('concurrent placement writes have one CAS winner and no silent home move',async()=>{
 const f=await fixture(),share=`select case_api.set_case_workspace_access(${literal(f.owner)},${literal(f.caseId)},${literal(f.destination)},'run',0,false,null)`;
 const r=await contend(share,f.move);assert.equal(r.second.ok,false);assert.match(r.second.stderr,/placement_conflict/);
 assert.equal(await query(`select workspace_id from case_app.cases where id=${literal(f.caseId)}`),f.home);
 assert.equal(await query(`select count(*) from case_app.workspace_audit where target_id=${literal(f.caseId)} and action='case_workspace_move'`),'0');
});
