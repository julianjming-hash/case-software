// Card 62 (CASE-285 R1): an admin's approval and an author's untick contend on the same image row in two real
// Postgres sessions. Whichever commits first wins; the other is refused as changed, never applied over it.
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

async function fixture() {
  const author = uuidv7(), admin = uuidv7(), workspace = uuidv7(), seed = uuidv7();
  await query(`insert into auth.users values (${literal(author)}),(${literal(admin)});
    insert into case_app.profiles(id,display_name) values (${literal(author)},'Race author');
    insert into case_app.workspaces(id,slug,name) values (${literal(workspace)},${literal(`fence-${workspace}`)},'Local fence race');
    insert into case_app.workspace_members(workspace_id,user_id,role) values (${literal(workspace)},${literal(author)},'author');`);
  const rendition = suffix => `jsonb_build_object('sha256',encode(sha256(convert_to(${literal(seed + suffix)},'UTF8')),'hex'),'bytes',4000,'width',1200,'height',800)`;
  const asset = await query(`select case_api.builder_create_asset(${literal(workspace)},${literal(author)},false,null,${rendition('d')},${rendition('p')},
    '{"alt_text":"Chest film","evidence_kind":"imaging","rights_basis":"own_work","licence":"own-work","attested":true}'::jsonb)->>'asset_id'`);
  // What the admin was shown: the image ticked, so nothing open to acknowledge.
  const shown = JSON.stringify({ attested: true, rights_basis: 'own_work', licence: 'own-work', creator: null, attribution: null, rights_note: null, source_url: null });
  return {
    asset,
    approve: `select status from jsonb_to_record(case_api.admin_review_asset(${literal(workspace)},${literal(asset)},'approve',${literal(shown)}::jsonb,'{}'::text[],${literal(admin)},true,'reviewer@example.test')) x(status text)`,
    untick: `select (case_api.builder_set_asset_attestation(${literal(workspace)},${literal(asset)},true,false,${literal(author)},false,null))->>'attested'`,
  };
}

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

test('[AS-172] an author untick committed first refuses the approval that showed the image ticked', async () => {
  const f = await fixture(), race = await contend(f.untick, f.approve);
  assert.equal(race.first, 'false');
  assert.equal(race.second.ok, false); assert.match(race.second.stderr, /asset_details_changed/);
  assert.equal(await query(`select status||':'||(deidentified_attested_at is not null) from case_app.assets where id=${literal(f.asset)}`), 'quarantined:false');
  assert.equal(await query(`select count(*) from case_app.workspace_audit where target_id=${literal(f.asset)}`), '0');
});

test('[AS-172] an approval committed first refuses the untick that came after it', async () => {
  const f = await fixture(), race = await contend(f.approve, f.untick);
  assert.equal(race.first, 'approved');
  assert.equal(race.second.ok, false); assert.match(race.second.stderr, /asset_details_changed/);
  assert.equal(await query(`select status||':'||(deidentified_attested_at is not null) from case_app.assets where id=${literal(f.asset)}`), 'approved:true');
  assert.equal(await query(`select array_to_string(acknowledged,',')||'|'||action from case_app.workspace_audit where target_id=${literal(f.asset)}`), '|asset_approve');
});
