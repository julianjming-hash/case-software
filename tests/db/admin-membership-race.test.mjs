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

async function fixture(){
 const admin=uuidv7(),one=uuidv7(),two=uuidv7(),workspace=uuidv7(),elevation=uuidv7();
 const adminEmail=`admin-${admin}@example.test`,emailOne=`one-${one}@example.test`,emailTwo=`two-${two}@example.test`;
 await query(`insert into auth.users(id,email) values (${literal(admin)},${literal(adminEmail)}),(${literal(one)},${literal(emailOne)}),(${literal(two)},${literal(emailTwo)});
 insert into case_app.profiles(id) values(${literal(admin)}),(${literal(one)}),(${literal(two)});
 insert into case_app.workspaces(id,slug,name) values(${literal(workspace)},${literal(`member-race-${workspace}`)},'Membership race');
 insert into case_app.workspace_members(workspace_id,user_id,role) values(${literal(workspace)},${literal(one)},'owner'),(${literal(workspace)},${literal(two)},'owner');
 insert into case_app.admin_elevations(jti,actor_email,scope,session_id) values(${literal(elevation)},${literal(adminEmail)},'admin',${literal(admin)});`);
 const remove=(email,revision)=>`select case_api.admin_change_membership(${literal(admin)},${literal(workspace)},${literal(email)},null,null,${revision},${literal(email)},${literal(elevation)},true,${literal(adminEmail)})`;
 return {workspace,one,two,remove,emailOne,emailTwo};
}
test('contending removals serialize CAS, preserve the last owner and commit only one audit',async()=>{
 const f=await fixture(),r=await contend(f.remove(f.emailOne,2),f.remove(f.emailTwo,2));
 assert.equal(r.second.ok,false);assert.match(r.second.stderr,/revision|conflict|stale/);
 assert.equal(await query(`select count(*) from case_app.workspace_members where workspace_id=${literal(f.workspace)} and role='owner'`),'1');
 assert.equal(await query(`select count(*) from case_app.workspace_audit where workspace_id=${literal(f.workspace)} and action='member_remove'`),'1');
 await assert.rejects(query(f.remove(f.emailTwo,3)),error=>/last_owner|last owner/.test(error.stderr));
 assert.equal(await query(`select membership_revision from case_app.workspaces where id=${literal(f.workspace)}`),'3');
});
