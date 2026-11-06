// Delete unused and draft saves serialize against the real local PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from '../../src/shared/ids.mjs';
const exec = promisify(execFile);
const binary = process.env.CASE_TEST_PSQL_BIN, socket = process.env.CASE_TEST_PG_SOCKET;
if (!binary?.endsWith('/psql') || !socket?.startsWith('/')) throw Error('local_postgres_test_boundary_required');
const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const query = async sql => (await exec(binary, [...args, '-c', sql], { timeout: 5000 })).stdout.trim();

async function contend(firstSql, secondSql) {
  const first = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }), secondName = `fence-race-${uuidv7()}`;
  let output = '', errors = ''; first.stdout.on('data', chunk => { output += chunk; }); first.stderr.on('data', chunk => { errors += chunk; });
  const ended = new Promise(resolve => first.on('exit', code => resolve(code)));
  first.stdin.write(`begin; set local statement_timeout='4s'; ${firstSql}; select 'RACE_HELD';\n`);
  try {
    const until = Date.now() + 3000;
    while (!output.includes('RACE_HELD')) { if (Date.now() > until) throw Error(`first_session_not_ready: ${errors}`); await new Promise(resolve => setTimeout(resolve, 10)); }
    const second = exec(binary, [...args, '-c', `set application_name=${literal(secondName)}; set statement_timeout='4s'; ${secondSql}`], { timeout: 6000 })
      .then(value => ({ ok: true, stdout: value.stdout.trim() }), error => ({ ok: false, stderr: error.stderr }));
    // The second session must actually wait on the first one's row lock, or this is not a race.
    const blockedUntil = Date.now() + 3000; let blocked = false;
    while (!blocked) {
      blocked = await query(`select exists(select 1 from pg_stat_activity where application_name=${literal(secondName)} and wait_event_type='Lock')`) === 't';
      if (Date.now() > blockedUntil) throw Error('second_session_never_contended');
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    first.stdin.end('commit;\n'); assert.equal(await ended, 0, errors);
    return { first: output.split('\n').filter(line => line && line !== 'RACE_HELD').at(-1), second: await second };
  } finally { if (first.exitCode === null) { first.stdin.end('rollback;\n'); first.kill(); } }
}


async function fixture() {
  const user = uuidv7(), ws = uuidv7(), caseId = uuidv7(), elevation = uuidv7();
  const email = `unused-${user}@example.test`;
  await query(`insert into auth.users(id,email) values (${literal(user)},${literal(email)});
    insert into case_app.profiles(id) values (${literal(user)});
    insert into case_app.workspaces(id,slug,name) values (${literal(ws)},${literal(`unused-${ws}`)},'Unused race');
    insert into case_app.cases(id,workspace_id,owner_id,title) values (${literal(caseId)},${literal(ws)},${literal(user)},'Race');
    insert into case_app.admin_elevations(jti,actor_email,scope,session_id) values (${literal(elevation)},${literal(email)},'admin',${literal(user)});`);
  const rendition = suffix => `jsonb_build_object('sha256',encode(sha256(convert_to(${literal(ws + suffix)},'UTF8')),'hex'),'bytes',4000,'width',1200,'height',800)`;
  const asset = await query(`select case_api.builder_create_asset(${literal(ws)},${literal(user)},true,${literal(email)},${rendition('d')},${rendition('p')},
    '{"alt_text":"Local image","evidence_kind":"other","rights_basis":"own_work","licence":"own-work","attested":true}'::jsonb)->>'asset_id'`);
  await query(`update case_app.assets set created_at=now()-interval '2 days' where id=${literal(asset)}`);
  const document = {schema_version:3,title:'Race',start_beat_id:uuidv7(),beats:[],decisions:[],blocks:[{id:uuidv7(),type:'image',asset_id:asset}]};
  document.beats=[{id:document.start_beat_id,kind:'debrief',title:'End'}];
  const operation = await query(`select operation_id from case_api.builder_open_save_window(${literal(caseId)},0,${literal(user)},true,${literal(email)})`);
  return {asset, caseId, ws, user, email,
    save: `select revision from case_api.builder_save_draft(${literal(caseId)},${literal(operation)},${literal(JSON.stringify(document))}::jsonb,'{"metadata_version":1}'::jsonb,${literal(user)},true,${literal(email)})`,
    remove: `select case_api.admin_delete_unused_assets(${literal(user)},${literal(ws)},array[${literal(asset)}]::uuid[],${literal(elevation)},true,${literal(email)})`};
}

test('[AS-213] a draft save that wins keeps its image when Delete unused waits for it', async () => {
  const f = await fixture(), result = await contend(f.save, f.remove);
  assert.equal(result.second.ok, true, result.second.stderr);
  assert.deepEqual(JSON.parse(result.second.stdout).deleted, []);
  assert.equal(await query(`select count(*) from case_app.assets where id=${literal(f.asset)}`), '1');
  assert.equal(await query(`select count(*) from case_app.case_drafts where case_id=${literal(f.caseId)}`), '1');
});

test('[AS-213] deletion that wins leaves a later stale draft incomplete and unpublishable', async () => {
  const f = await fixture(), result = await contend(f.remove, f.save);
  assert.equal(result.second.ok, true, result.second.stderr);
  assert.equal(await query(`select count(*) from case_app.assets where id=${literal(f.asset)}`), '0');
  const readiness = await query(`select case_api.builder_publication_readiness(${literal(f.caseId)},1,${literal(f.user)},true,${literal(f.email)})`);
  assert.equal(readiness, 'asset_not_approved');
});
