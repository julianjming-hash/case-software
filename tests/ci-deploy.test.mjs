import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, deploy, parseArgs, doSignature, deploymentProvenance } from '../scripts/ci-deploy.mjs';

// AUTONOMOUS-DEPLOY §2 and §5: the CI deploy driver against fakes only (hard rule 12).
const SHA = 'a'.repeat(40); const OLD = 'b'.repeat(40); const PREV_ID = '11111111-2222-3333-4444-555555555555';
const CURRENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REPO = 'o/r';
const TOML = 'name = "case"\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["RoomDO", "DirectoryDO"]\n[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["AlertDO"]\n';
const ENTRY = "export { RoomDO } from './room-do.mjs';\nexport { DirectoryDO } from './directory-do.mjs';\nexport { AlertDO } from './alert-do.mjs';\nexport default {};\n";

function world(o = {}) {
  const s = {
    main: SHA, head: SHA, ancestor: true, deployed: { staging: OLD, production: OLD }, verify: { status: 'completed', conclusion: 'success' },
    verifyMeta: {}, rolledBack: false, stagingRun: { status: 'completed', conclusion: 'success' }, live: 0,
    dry: 0, status: { code: 0, stdout: JSON.stringify({ versions: [{ version_id: PREV_ID, percentage: 100 }] }) },
    postStatus: { code: 0, stdout: JSON.stringify({ versions: [{ version_id: CURRENT_ID, percentage: 100 }] }) },
    deployCode: 0, afterDeploy: SHA, rollbackCode: 0, afterRollback: OLD, newToml: TOML, newEntry: ENTRY, readbackLag: 0, ...o,
  };
  const calls = []; let deployedNow = false; let rolledBack = false; let reads = 0; let clock = 0;
  const git = async (args) => {
    calls.push(['git', args]);
    if (args[0] === 'rev-parse') return `${args[1] === 'HEAD' ? s.head : s.main}\n`;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'merge-base') { if (!s.ancestor) throw new Error('git_failed'); return ''; }
    if (args[0] === 'show') { const [rev, path] = args[1].split(':'); if (path === 'wrangler.toml') return rev === SHA ? s.newToml : TOML; return rev === SHA ? s.newEntry : ENTRY; }
    throw new Error(`unexpected git ${args}`);
  };
  const gh = async (args) => {
    calls.push(['gh', args]); const q = args[1];
    if (q.includes('/workflows/verify.yml/runs')) return JSON.stringify({ workflow_runs: [{ path: '.github/workflows/verify.yml', head_branch: 'main', head_sha: SHA, event: 'push', run_number: 7, run_attempt: 1, ...s.verify, ...s.verifyMeta }] });
    if (q.includes('/workflows/deploy-staging.yml/runs')) return JSON.stringify({ workflow_runs: s.stagingRun ? [{ path: '.github/workflows/deploy-staging.yml', head_branch: 'main', head_sha: SHA, event: 'workflow_dispatch', run_number: 3, run_attempt: 1, ...s.stagingRun }] : [] });
    if (q.includes('/actions/artifacts')) return JSON.stringify({ artifacts: s.rolledBack ? [{ name: `rolled-back-staging-${SHA}`, workflow_run: { head_branch: s.rolledBack === 'branch' ? 'feature' : 'main' } }] : [] });
    throw new Error(`unexpected gh ${q}`);
  };
  const fetchImpl = async (url, init) => {
    calls.push(['fetch', url, init]);
    const env = url.startsWith('https://case.iatrogenic.app/') ? 'production' : 'staging';
    if (url.endsWith('/ops/live-rooms')) return new Response(JSON.stringify({ live: s.live }));
    let build = s.deployed[env];
    if (rolledBack) build = s.afterRollback;
    else if (deployedNow) build = ++reads > s.readbackLag ? s.afterDeploy : OLD;
    return new Response(JSON.stringify({ build, env, wire: 1 }), { headers: { 'x-case-build': build } });
  };
  const wrangler = async (args) => {
    calls.push(['wrangler', args]);
    if (args.includes('--dry-run')) return { code: s.dry, stdout: '', stderr: s.dry ? 'build error' : '' };
    if (args[0] === 'deployments') {
      if (deployedNow && !rolledBack) { if (s.postStatusThrows) throw new Error('PRIVATE_PROVIDER_ERROR'); return s.postStatus; }
      return { ...s.status, stderr: s.status.code ? `Authentication error token=${'t'.repeat(40)}` : '' };
    }
    if (args[0] === 'rollback') { if (!s.rollbackCode || s.rollbackFlips) rolledBack = true; return { code: s.rollbackCode, stdout: '', stderr: s.rollbackCode ? 'rollback refused' : '' }; }
    throw new Error('unexpected wrangler');
  };
  // predeploy's own commands.
  const run = async (cmd, args, opts) => {
    calls.push(['run', cmd, args, opts]);
    if (cmd === 'git') {
      if (args[0] === 'status') return { code: 0, stdout: '' };
      if (args[0] === 'fetch') return { code: 0, stdout: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${args[1] === 'HEAD' ? s.head : s.main}\n` };
      if (args[0] === 'for-each-ref') return { code: 0, stdout: `${SHA}\n` };
      if (args[0] === 'merge-base') return { code: 0, stdout: '' };
      // Card 35: predeploy reads each build's ADMIN_EMAILS (unset in this fixture, which is valid).
      if (args[0] === 'show') return { code: 0, stdout: TOML };
    }
    if (cmd === 'gh') return { code: 0, stdout: JSON.stringify([{ check_runs: [{ id: 2, name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }] }]) };
    if (cmd === 'npx') { deployedNow = true; return { code: s.deployCode, stdout: '', stderr: s.deployCode ? 'wrangler deploy failed' : '' }; }
    throw new Error(`unexpected run ${cmd}`);
  };
  const sleep = async ms => { clock += ms; };
  const now = () => clock;
  return { s, calls, git, gh, fetchImpl, wrangler, run, sleep, now };
}
const secrets = { guard: 'guard-test-value-xyz', cloudflare: 'cf-test-value-0123456789abcdefghij' };
const deployDeps = (w, extra = {}) => ({ ...w, childEnv: { PATH: '/usr/bin', CLOUDFLARE_API_TOKEN: secrets.cloudflare }, ...extra });

test('usage is strict', () => {
  assert.deepEqual(parseArgs(['admit', '--env', 'staging']), { mode: 'admit', env: 'staging' });
  for (const argv of [['admit'], ['ship', '--env', 'staging'], ['deploy', '--env', 'preview'], ['deploy', '--env', 'staging', '--allow-live']]) assert.throws(() => parseArgs(argv), /usage/);
});

test('admit: the current main tip with exact green CI deploys; already-deployed skips', async () => {
  assert.deepEqual(await admit({ env: 'staging', sha: SHA, repo: REPO }, world()), { decision: 'deploy', reason: 'admitted' });
  assert.deepEqual(await admit({ env: 'staging', sha: SHA, repo: REPO }, world({ deployed: { staging: SHA } })), { decision: 'skip', reason: 'already_deployed' });
});
for (const [name, sha, o, code] of [
  ['a malformed sha', 'abc', {}, 'invalid_sha'],
  ['a sha that is not the main tip', OLD, {}, 'sha_not_main_tip'],
  ['red verify', SHA, { verify: { status: 'completed', conclusion: 'failure' } }, 'ci_not_green'],
  ['pending verify', SHA, { verify: { status: 'in_progress', conclusion: null } }, 'ci_not_green'],
  ['a scheduled verify run', SHA, { verifyMeta: { event: 'schedule' } }, 'ci_not_green'],
  ['a verify run from another workflow file', SHA, { verifyMeta: { path: '.github/workflows/other.yml' } }, 'ci_not_green'],
  ['a verify run on a branch', SHA, { verifyMeta: { head_branch: 'feature' } }, 'ci_not_green'],
  ['an earlier rollback of this sha', SHA, { rolledBack: true }, 'sha_rolled_back'],
  ['a non-ancestor deployed build (break-glass branch)', SHA, { ancestor: false }, 'deployed_build_not_ancestor'],
]) test(`admit refuses ${name}`, async () => {
  await assert.rejects(admit({ env: 'staging', sha, repo: REPO }, world(o)), { message: code });
});
test('admit ignores a rollback marker uploaded from a branch run', async () => {
  assert.equal((await admit({ env: 'staging', sha: SHA, repo: REPO }, world({ rolledBack: 'branch' }))).decision, 'deploy');
});
test('production admission requires the same sha soaked on staging by a successful main run', async () => {
  const soaked = { deployed: { staging: SHA, production: OLD } };
  assert.equal((await admit({ env: 'production', sha: SHA, repo: REPO }, world(soaked))).decision, 'deploy');
  await assert.rejects(admit({ env: 'production', sha: SHA, repo: REPO }, world()), { message: 'not_soaked_on_staging' });
  await assert.rejects(admit({ env: 'production', sha: SHA, repo: REPO }, world({ ...soaked, stagingRun: { status: 'completed', conclusion: 'failure' } })), { message: 'not_soaked_on_staging' });
  await assert.rejects(admit({ env: 'production', sha: SHA, repo: REPO }, world({ ...soaked, stagingRun: null })), { message: 'not_soaked_on_staging' });
});

test('deploy: happy path runs predeploy with the guard token as an argument, never in child env', async () => {
  const w = world(); const r = await deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w));
  assert.deepEqual(r, { outcome: 'deployed', build: SHA, currentVersion: CURRENT_ID, previousBuild: OLD, previousVersion: PREV_ID });
  const live = w.calls.find(([k, url]) => k === 'fetch' && url.endsWith('/ops/live-rooms'));
  assert.equal(live[2].headers.authorization, `Bearer ${secrets.guard}`);
  for (const [, , , opts] of w.calls.filter(c => c[0] === 'run')) assert.ok(!JSON.stringify(opts?.env ?? {}).includes(secrets.guard));
  assert.ok(!w.calls.some(([k, a]) => k === 'wrangler' && a[0] === 'rollback'));
});
for (const [name, o, code] of [
  ['a checkout that is not the sha', { head: OLD }, 'checkout_mismatch'],
  ['main moving before the deploy', { main: OLD }, 'sha_not_main_tip'],
  ['a failed dry-run build', { dry: 1 }, 'build_failed'],
  ['a gradual or unreadable deployment state', { status: { code: 0, stdout: JSON.stringify({ versions: [{ version_id: PREV_ID, percentage: 50 }, { version_id: PREV_ID, percentage: 50 }] }) } }, 'deployment_state_unexpected'],
  ['live rooms (predeploy, nothing deployed)', { live: 1 }, 'live_rooms'],
]) test(`deploy refuses ${name} without deploying`, async () => {
  const w = world(o); await assert.rejects(deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w)), { message: code });
  assert.ok(!w.calls.some(([k, cmd]) => k === 'run' && cmd === 'npx'));
});
test('deploy: missing secrets refuse before any command', async () => {
  const w = world(); await assert.rejects(deploy({ env: 'staging', sha: SHA, secrets: { guard: '' } }, deployDeps(w)), { message: 'secrets_missing' });
  assert.equal(w.calls.length, 0);
});
test('deploy: a Cloudflare auth failure is named, with the token redacted', async () => {
  const w = world({ status: { code: 1, stdout: '' } });
  const e = await deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w)).then(() => null, x => x);
  assert.equal(e.message, 'cloudflare_auth_failed'); assert.match(e.detail, /Authentication error/); assert.ok(!e.detail.includes('t'.repeat(40)));
});
test('deploy: a slow read-back is retried for up to 3 minutes before anything is rolled back', async () => {
  const w = world({ readbackLag: 3 }); const r = await deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w));
  assert.equal(r.outcome, 'deployed_after_readback_retry');
  assert.ok(!w.calls.some(([k, a]) => k === 'wrangler' && a[0] === 'rollback'));
});
test('deploy: staging rolls back an unverified deploy, verifies it and leaves the marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-deploy-')); const w = world({ afterDeploy: 'c'.repeat(40) });
  const e = await deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w, { outcomeDir: dir })).then(() => null, x => x);
  assert.equal(e.message, 'rolled_back'); assert.match(e.detail, /CASE-153/);
  assert.deepEqual(w.calls.find(([k, a]) => k === 'wrangler' && a[0] === 'rollback')[1].slice(0, 4), ['rollback', PREV_ID, '--env', 'staging']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'rolled-back.json'), 'utf8')), { env: 'staging', sha: SHA, previousBuild: OLD, previousVersion: PREV_ID });
});
test('deploy: a failed rollback is rollback_failed and leaves no marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-deploy-'));
  await assert.rejects(deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(world({ afterDeploy: 'c'.repeat(40), rollbackCode: 1 }), { outcomeDir: dir })), { message: 'rollback_failed' });
  assert.equal(existsSync(join(dir, 'rolled-back.json')), false);
});
test('deploy: a non-zero rollback exit is rollback_failed even if the old build answers', async () => {
  await assert.rejects(deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(world({ afterDeploy: 'c'.repeat(40), rollbackCode: 1, rollbackFlips: true }))), { message: 'rollback_failed' });
});
test('deploy: no rollback across a Durable Object migration or class change', async () => {
  for (const o of [{ newToml: `${TOML}[[migrations]]\ntag = "v3"\nnew_sqlite_classes = ["NewDO"]\n` }, { newEntry: `${ENTRY}export { NewDO } from './new-do.mjs';\n` }]) {
    const w = world({ afterDeploy: 'c'.repeat(40), ...o });
    await assert.rejects(deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w)), { message: 'rollback_blocked_migration' });
    assert.ok(!w.calls.some(([k, a]) => k === 'wrangler' && a[0] === 'rollback'));
  }
});
test('deploy: production never rolls back automatically', async () => {
  const w = world({ afterDeploy: 'c'.repeat(40) });
  const e = await deploy({ env: 'production', sha: SHA, secrets }, deployDeps(w)).then(() => null, x => x);
  assert.equal(e.message, 'deployed_unverified'); assert.match(e.detail, new RegExp(PREV_ID));
  assert.ok(!w.calls.some(([k, a]) => k === 'wrangler' && a[0] === 'rollback'));
});
test('deploy: a wrangler failure that left the previous build serving is deploy_failed, not a rollback', async () => {
  const w = world({ deployCode: 1, afterDeploy: OLD });
  await assert.rejects(deploy({ env: 'staging', sha: SHA, secrets }, deployDeps(w)), { message: 'deploy_failed' });
  assert.ok(!w.calls.some(([k, a]) => k === 'wrangler' && a[0] === 'rollback'));
});
test('DO signature reads migration tags, DO classes and the entry exports', async () => {
  const w = world(); const sig = JSON.parse(await doSignature(w.git, OLD));
  assert.deepEqual(sig.tags, ['v1', 'v2']); assert.deepEqual(sig.exported, ['AlertDO', 'DirectoryDO', 'RoomDO']);
});


test('deploy provenance queries the actual environment after successful deployment and exact build readback', async () => {
  for (const env of ['staging', 'production']) {
    const w = world(); const result = await deploy({ env, sha: SHA, secrets }, deployDeps(w));
    assert.deepEqual(result, { outcome: 'deployed', build: SHA, currentVersion: CURRENT_ID, previousBuild: OLD, previousVersion: PREV_ID });
    const statusCalls = w.calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === 'wrangler' && call[1][0] === 'deployments');
    assert.equal(statusCalls.length, 2);
    for (const { call } of statusCalls) assert.deepEqual(call[1], ['deployments', 'status', '--env', env, '--json']);
    const deployment = w.calls.findIndex(call => call[0] === 'run' && call[1] === 'npx');
    assert.ok(statusCalls[0].index < deployment);
    const lastStatus = statusCalls[1].index;
    assert.ok(w.calls.slice(deployment + 1, lastStatus).some(call => call[0] === 'fetch' && call[1].endsWith('/version')));
    assert.ok(lastStatus > deployment);
  }
});
test('recovered readback still obtains current version provenance', async () => {
  const w = world({ readbackLag: 3 }); const result = await deploy({ env: 'production', sha: SHA, secrets }, deployDeps(w));
  assert.equal(result.outcome, 'deployed_after_readback_retry'); assert.equal(result.currentVersion, CURRENT_ID);
  assert.equal(result.previousBuild, OLD); assert.equal(result.previousVersion, PREV_ID);
  assert.equal(w.calls.filter(call => call[0] === 'wrangler' && call[1][0] === 'deployments').length, 2);
});
for (const [name, postStatus, postStatusThrows] of [
  ['command failure', { code: 1, stdout: '', stderr: 'PRIVATE_PROVIDER_ERROR' }],
  ['invalid JSON', { code: 0, stdout: 'PRIVATE_PROVIDER_ERROR' }],
  ['missing versions', { code: 0, stdout: '{}' }],
  ['not an array', { code: 0, stdout: JSON.stringify({ versions: {} }) }],
  ['gradual rollout', { code: 0, stdout: JSON.stringify({ versions: [{ version_id: CURRENT_ID, percentage: 50 }, { version_id: PREV_ID, percentage: 50 }] }) }],
  ['not 100 percent', { code: 0, stdout: JSON.stringify({ versions: [{ version_id: CURRENT_ID, percentage: 99 }] }) }],
  ['array UUID', { code: 0, stdout: JSON.stringify({ versions: [{ version_id: [CURRENT_ID], percentage: 100 }] }) }],
  ['object UUID', { code: 0, stdout: JSON.stringify({ versions: [{ version_id: {}, percentage: 100 }] }) }],
  ['malformed UUID', { code: 0, stdout: JSON.stringify({ versions: [{ version_id: '-'.repeat(36), percentage: 100 }] }) }],
  ['oversized result', { code: 0, stdout: 'x'.repeat(65_537) }],
  ['thrown command', undefined, true],
]) for (const env of ['production', 'staging']) test(`postdeploy provenance ${name} in ${env} fails without rollback or private output`, async () => {
  const w = world({ postStatus, postStatusThrows });
  const error = await deploy({ env, sha: SHA, secrets }, deployDeps(w)).then(() => null, error => error);
  assert.equal(error.message, 'deployed_unverified'); assert.match(error.detail, new RegExp(PREV_ID));
  assert.ok(!error.detail.includes('PRIVATE_PROVIDER_ERROR'));
  assert.ok(!w.calls.some(call => call[0] === 'wrangler' && call[1][0] === 'rollback'));
  assert.equal(w.calls.filter(call => call[0] === 'run' && call[1] === 'npx').length, 1);
  assert.equal(w.calls.filter(call => call[0] === 'wrangler' && call[1][0] === 'deployments').length, 2);
});
test('structured deployment provenance contains only six exact release fields', () => {
  const record = deploymentProvenance('production', { outcome: 'deployed', build: SHA, currentVersion: CURRENT_ID,
    previousBuild: OLD, previousVersion: PREV_ID, privateOutput: 'PRIVATE_PROVIDER_ERROR' });
  assert.deepEqual(record, { env: 'production', outcome: 'deployed', build: SHA, currentVersion: CURRENT_ID, previousBuild: OLD, previousVersion: PREV_ID });
  assert.ok(!JSON.stringify(record).includes('PRIVATE_PROVIDER_ERROR'));
});
