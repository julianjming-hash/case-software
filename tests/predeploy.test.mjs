import test from 'node:test';
import assert from 'node:assert/strict';
import { predeploy, parseDeployOptions, validateNpmEntrypoints } from '../scripts/predeploy.mjs';

const SHA = 'a'.repeat(40); const OLD = 'b'.repeat(40);
function fake({ dirty = false, main = SHA, pushed = true, ci = 'success', ciStatus = 'completed', missingCi = false, browser = null, ancestor = true, live = 0, status = 200, after = SHA, network = false, admins = { [SHA]: 'admin@example.org', [OLD]: 'admin@example.org' } } = {}) {
  const calls = []; let deployed = false;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git') {
      if (args[0] === 'status') return { code: 0, stdout: dirty ? '?? stray.txt\n' : '' };
      if (args[0] === 'fetch') return { code: 0, stdout: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${args[1] === 'HEAD' ? SHA : main}\n` };
      if (args[0] === 'for-each-ref') return { code: 0, stdout: `${pushed ? SHA : OLD}\n` };
      if (args[0] === 'merge-base') return { code: ancestor ? 0 : 1, stdout: '' };
      if (args[0] === 'show') { const value = admins[args[1].split(':')[0]];
        const admin = value === undefined ? '' : `ADMIN_EMAILS = "${value}"\n`;
        return { code: 0, stdout: `[vars]\nCASE_ENV = "dev"\n\n[env.production.vars]\n${admin}\n[env.staging.vars]\nCASE_ENV = "staging"\n${admin}\n[env.staging.triggers]\n` }; }
    }
    if (command === 'gh') return { code: 0, stdout: JSON.stringify([{ check_runs: [
      ...(!missingCi ? [{ id: 2, name: 'verify', status: ciStatus, conclusion: ci, app: { slug: 'github-actions' } }] : []),
      ...(browser ? [{ id: 3, name: 'browser-harness', status: 'completed', conclusion: browser, app: { slug: 'github-actions' } }] : []),
    ] }]) };
    if (command === 'npx') { deployed = true; return { code: 0, stdout: '' }; }
    throw new Error('unexpected fake command');
  };
  const fetchImpl = async (url, init) => {
    calls.push(['fetch', url, init]);
    if (network) throw new TypeError('test network failure');
    if (url.endsWith('/ops/live-rooms')) return new Response(JSON.stringify({ live }), { status });
    const build = deployed ? after : OLD;
    return new Response(JSON.stringify({ build, env: url.startsWith('https://case.iatrogenic.app/') ? 'production' : 'staging', wire: 1 }), { status, headers: { 'x-case-build': build } });
  };
  const logs = [];
  return { calls, run, fetchImpl, token: 'test-only-guard', log: line => logs.push(line), logs };
}
const options = { env: 'staging' };
for (const [name, config, code] of [
  ['dirty tree and untracked files', { dirty: true }, 'dirty_tree'],
  ['unpushed staging head', { pushed: false }, 'head_not_pushed'],
  ['red verify CI', { ci: 'failure' }, 'ci_not_green'],
  ['missing verify CI', { missingCi: true }, 'ci_not_green'],
  ['red browser CI', { browser: 'failure' }, 'ci_not_green'],
  ['non-ancestor deployed build', { ancestor: false }, 'deployed_build_not_ancestor'],
  ['live rooms', { live: 2 }, 'live_rooms'],
  ['version endpoint refusal', { status: 503 }, 'version_unavailable'],
  ['network failure', { network: true }, 'version_unavailable'],
  ['post-deploy build mismatch', { after: OLD }, 'deployed_build_mismatch'],
]) test(`predeploy refuses ${name}`, async () => {
  const f = fake(config); await assert.rejects(predeploy(options, f), { message: code });
  if (code !== 'deployed_build_mismatch') assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
});
test('production requires current origin/main and explicit --prod consent', async () => {
  await assert.rejects(predeploy({ env: 'production' }, fake()), { message: 'production_requires_prod' });
  const f = fake({ main: OLD });
  await assert.rejects(predeploy({ env: 'production', prod: true }, f), { message: 'head_not_main' });
  assert.ok(!f.calls.some(([cmd]) => cmd === 'fetch'));
});
test('unknown environment and unknown CLI flags fail before commands or requests', async () => {
  const f = fake(); await assert.rejects(predeploy({ env: 'preview' }, f), { message: 'unknown_environment' }); assert.equal(f.calls.length, 0);
  assert.throws(() => parseDeployOptions(['--env', 'preview']), /unknown_environment/);
  assert.throws(() => parseDeployOptions(['--env', 'staging', '--typo']), /unknown_option/);
});
test('happy staging path fetches fresh refs, checks CI and ancestry, guards rooms, deploys once and verifies', async () => {
  const f = fake(); const result = await predeploy(options, f);
  assert.deepEqual(result, { build: SHA, env: 'staging', adminEmails: { added: [], removed: [] } });
  assert.deepEqual(f.logs, ['predeploy: ADMIN_EMAILS for staging unchanged']);
  assert.deepEqual(f.calls.filter(([cmd]) => cmd === 'npx'), [['npx', ['--no-install', 'wrangler', 'deploy', '--env', 'staging', '--var', `BUILD_SHA:${SHA}`]]]);
  assert.deepEqual(f.calls.find(([cmd, args]) => cmd === 'git' && args[0] === 'fetch'), ['git', ['fetch', '--prune', 'origin']]);
  assert.ok(f.calls.some(([cmd, url, init]) => cmd === 'fetch' && url.endsWith('/ops/live-rooms') && init.headers.authorization === 'Bearer test-only-guard'));
});
test('explicit bootstrap skips only pre-existing version and live-room checks, never post-deploy verification', async () => {
  const f = fake({ live: 2, ancestor: false }); await predeploy({ env: 'staging', firstDeploy: true }, f);
  assert.equal(f.calls.filter(([cmd]) => cmd === 'fetch').length, 1);
  assert.ok(!f.calls.some(([cmd, args]) => cmd === 'git' && args[0] === 'merge-base'));
  await assert.rejects(predeploy({ env: 'staging', firstDeploy: true }, fake({ dirty: true })), /dirty_tree/);
  await assert.rejects(predeploy({ env: 'staging', firstDeploy: true }, fake({ pushed: false })), /head_not_pushed/);
  await assert.rejects(predeploy({ env: 'staging', firstDeploy: true }, fake({ ci: 'failure' })), /ci_not_green/);
  await assert.rejects(predeploy({ env: 'staging', firstDeploy: true }, fake({ after: OLD })), /deployed_build_mismatch/);
});
test('allow-live overrides positive room counts only, never a failed guard', async () => {
  await predeploy({ env: 'staging', allowLive: true }, fake({ live: 3 }));
  const f = fake(); f.fetchImpl = async url => url.endsWith('/ops/live-rooms') ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ build: OLD, env: 'staging', wire: 1 }), { headers: { 'x-case-build': OLD } });
  await assert.rejects(predeploy({ env: 'staging', allowLive: true }, f), /live_rooms_unavailable/);
});
test('npm deploy entrypoint hook rejects raw Wrangler bypass variants', () => {
  assert.equal(validateNpmEntrypoints({ deploy: 'node scripts/predeploy.mjs --env production --prod', 'deploy:staging': 'node scripts/predeploy.mjs --env staging' }), true);
  assert.throws(() => validateNpmEntrypoints({ deploy: 'wrangler deploy', 'deploy:staging': 'node scripts/predeploy.mjs --env staging' }), /unguarded_npm_entrypoint/);
});

test('production happy path preserves the exact production environment and argv', async () => {
  const f = fake(); assert.deepEqual(await predeploy({ env: 'production', prod: true }, f), { build: SHA, env: 'production', adminEmails: { added: [], removed: [] } });
  assert.deepEqual(f.calls.filter(([cmd]) => cmd === 'npx'), [['npx', ['--no-install', 'wrangler', 'deploy', '--env', 'production', '--var', `BUILD_SHA:${SHA}`]]]);
  assert.ok(f.calls.filter(([cmd]) => cmd === 'fetch').every(([, url]) => url.startsWith('https://case.iatrogenic.app/')));
});
test('pending CI is not green and newer failure cannot be hidden by an older successful run', async () => {
  await assert.rejects(predeploy(options, fake({ ciStatus: 'in_progress' })), /ci_not_green/);
  const f = fake(); const run = f.run;
  f.run = async (cmd, args) => cmd === 'gh' ? { code: 0, stdout: JSON.stringify([{ check_runs: [
    { id: 1, name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    { id: 2, name: 'verify', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
  ] }]) } : run(cmd, args);
  await assert.rejects(predeploy(options, f), /ci_not_green/);
});
test('version responses reject wrong env/wire/header, extra fields and an oversized body before deploy', async () => {
  for (const [body, header] of [
    [{ build: OLD, env: 'production', wire: 1 }, OLD],
    [{ build: OLD, env: 'staging', wire: 2 }, OLD],
    [{ build: OLD, env: 'staging', wire: 1 }, SHA],
    [{ build: OLD, env: 'staging', wire: 1, secret: 'not-real' }, OLD],
    ['x'.repeat(5000), OLD],
  ]) {
    const f = fake(); f.fetchImpl = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'x-case-build': header } });
    await assert.rejects(predeploy(options, f), /version_unavailable/);
    assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
  }
 });
test('post-deploy environment, wire and header mismatches each refuse success', async () => {
  for (const [body, header] of [
    [{ build: SHA, env: 'production', wire: 1 }, SHA],
    [{ build: SHA, env: 'staging', wire: 2 }, SHA],
    [{ build: SHA, env: 'staging', wire: 1 }, OLD],
  ]) {
    const f = fake(); const fetch = f.fetchImpl; let requests = 0;
    f.fetchImpl = async (url, init) => {
      if (++requests === 3) return new Response(JSON.stringify(body), { headers: { 'x-case-build': header } });
      return fetch(url, init);
    };
    await assert.rejects(predeploy(options, f), /version_unavailable/);
    assert.equal(f.calls.filter(([cmd]) => cmd === 'npx').length, 1);
  }
});
test('guard timeouts fail closed even with allow-live', async () => {
  const f = fake(); const fetch = f.fetchImpl;
  f.fetchImpl = async (url, init) => { if (url.endsWith('/ops/live-rooms')) throw new DOMException('fake timeout', 'TimeoutError'); return fetch(url, init); };
  await assert.rejects(predeploy({ ...options, allowLive: true }, f), /live_rooms_unavailable/);
  assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
});

test('real deadlines abort stalled provenance fetches and bodies without deployment', { timeout: 1000 }, async () => {
  for (const mode of ['fetch', 'body', 'ignored-fetch']) {
    const f = fake(); let aborted = false; const start = performance.now();
    f.timeoutMs = 30;
    f.fetchImpl = async (_url, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      if (mode === 'body') return new Response(new ReadableStream({ start() {} }));
      if (mode === 'ignored-fetch') return new Promise(() => {});
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    await assert.rejects(predeploy(options, f), /version_unavailable/);
    assert.equal(aborted, true); assert.ok(performance.now() - start >= 20);
    assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
  }
});

test('source changes while checks run stop deployment before bundling', async () => {
  for (const dirty of [true, false]) {
    const f = fake(); const run = f.run; let statusCalls = 0; let headCalls = 0;
    f.run = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'status' && ++statusCalls > 1 && dirty) return { code: 0, stdout: ' M src/worker/index.mjs\n' };
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD' && ++headCalls > 1 && !dirty) return { code: 0, stdout: OLD };
      return run(cmd, args);
    };
    await assert.rejects(predeploy(options, f), new RegExp(dirty ? 'dirty_tree' : 'head_changed'));
    assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
  }
});

// AUTONOMOUS-DEPLOY slice 1, seam 1: verify.yml runs browser-harness as a 3-shard matrix, so its
// check runs are named `browser-harness (1)`..`(3)`. Every shard must be green or skipped.
function shardRuns(conclusions, { status = 'completed' } = {}) {
  return conclusions.map((conclusion, i) => ({ id: 10 + i, name: `browser-harness (${i + 1})`, status, conclusion, app: { slug: 'github-actions' } }));
}
function withChecks(extra) {
  const f = fake(); const run = f.run;
  f.run = async (cmd, args, opts) => cmd === 'gh' ? { code: 0, stdout: JSON.stringify([{ check_runs: [
    { id: 2, name: 'verify', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }, ...extra,
  ] }]) } : run(cmd, args, opts);
  return f;
}
test('matrix browser shards: any red or pending shard refuses; all green or skipped deploys', async () => {
  for (const runs of [shardRuns(['success', 'failure', 'success']), shardRuns(['success', 'success', null], { status: 'in_progress' }), shardRuns(['cancelled', 'success', 'success'])]) {
    const f = withChecks(runs); await assert.rejects(predeploy(options, f), /ci_not_green/);
    assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
  }
  await predeploy(options, withChecks(shardRuns(['success', 'success', 'success'])));
  await predeploy(options, withChecks(shardRuns(['skipped', 'skipped', 'skipped'])));
});
test('a newer red rerun of one shard is not hidden by its older green run', async () => {
  const runs = shardRuns(['success', 'success', 'success']);
  runs.push({ id: 99, name: 'browser-harness (2)', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } });
  await assert.rejects(predeploy(options, withChecks(runs)), /ci_not_green/);
});
test('lookalike names are not counted as the browser group', async () => {
  // `browser-harness-extra` must not satisfy or fail the group; only exact and `(n)` names count.
  await predeploy(options, withChecks([{ id: 5, name: 'browser-harness-extra', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } }]));
});

// Seam 2: wrangler stderr is kept (bounded, redacted) so a failed deploy is diagnosable.
test('a failed deploy carries redacted, bounded stderr detail; the message stays the fixed code', async () => {
  const f = fake(); const run = f.run;
  const secret = 'cfTokenValue_' + 'x'.repeat(30);
  const jwtShaped = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXRlc3QtdmFsdWU'].join('.'); // built at runtime: the repo secret scan rejects JWT literals
  f.run = async (cmd, args, opts) => cmd === 'npx'
    ? { code: 1, stdout: '', stderr: `${'noise '.repeat(1000)}Authentication error [code: 10000] token=${secret} Authorization: Bearer abc.def.ghi ${jwtShaped}` }
    : run(cmd, args, opts);
  const error = await predeploy(options, { ...f, secrets: [secret] }).then(() => null, e => e);
  assert.equal(error?.message, 'deploy_failed');
  assert.match(error.detail, /Authentication error \[code: 10000\]/);
  assert.ok(!error.detail.includes(secret)); assert.ok(!error.detail.includes('eyJhbGci')); assert.ok(!/Bearer abc/.test(error.detail));
  assert.ok(error.detail.length <= 2048);
});

// Seam 3: spawned commands get an explicit environment without the guard token.
test('spawned commands never inherit the guard token; an injected env is passed as given', async () => {
  const f = fake(); const run = f.run; const envs = [];
  f.run = async (cmd, args, opts) => { envs.push([cmd, opts?.env]); return run(cmd, args, opts); };
  await predeploy(options, { ...f, env: { PATH: '/usr/bin', CLOUDFLARE_API_TOKEN: 'cf-test', DEPLOY_GUARD_TOKEN: 'leak', HOME: '/tmp' } });
  assert.ok(envs.length > 0);
  for (const [, env] of envs) { assert.ok(env, 'every command receives an explicit env'); assert.equal(env.DEPLOY_GUARD_TOKEN, undefined); }
  assert.deepEqual(envs.find(([cmd]) => cmd === 'npx')[1], { PATH: '/usr/bin', CLOUDFLARE_API_TOKEN: 'cf-test', HOME: '/tmp' });
});

// [PM-01] E01: a malformed or upper-case ADMIN_EMAILS entry would make the Worker reject the whole list and
// lock every admin out silently; predeploy refuses it, and shows any list change before the deploy runs.
for (const [name, value] of [['an upper-case entry', 'Admin@example.org'], ['a malformed entry', 'admin@example.org,not-an-email'],
  ['an empty entry', 'admin@example.org,'], ['a padded but otherwise valid list with an upper-case second entry', 'a@example.org, B@example.org']])
  test(`[PM-01] predeploy refuses ${name} in ADMIN_EMAILS before deploying`, async () => {
    const f = fake({ admins: { [SHA]: value, [OLD]: 'admin@example.org' } });
    await assert.rejects(predeploy(options, f), { message: 'invalid_admin_emails' });
    assert.ok(!f.calls.some(([cmd]) => cmd === 'npx'));
  });
test('[PM-01] a changed admin list is shown before the deploy; an unset list is valid', async () => {
  const f = fake({ admins: { [SHA]: 'new@example.org,admin@example.org', [OLD]: 'admin@example.org,gone@example.org' } });
  const result = await predeploy(options, f);
  assert.deepEqual(result.adminEmails, { added: ['new@example.org'], removed: ['gone@example.org'] });
  assert.deepEqual(f.logs, ['predeploy: ADMIN_EMAILS for staging changes: added [new@example.org], removed [gone@example.org]']);
  const npx = f.calls.findIndex(([cmd]) => cmd === 'npx'), shown = f.calls.findIndex(([cmd, args]) => cmd === 'git' && args[0] === 'show' && args[1].startsWith(OLD));
  assert.ok(shown >= 0 && shown < npx, 'the deployed list is read before the deploy');
  const unset = fake({ admins: {} });
  assert.deepEqual((await predeploy(options, unset)).adminEmails, { added: [], removed: [] });
  // An invalid list on the deployed build never blocks its own fix.
  assert.deepEqual((await predeploy(options, fake({ admins: { [SHA]: 'admin@example.org', [OLD]: 'BAD' } }))).adminEmails,
    { added: ['admin@example.org'], removed: [] });
});
test('[PM-01] the committed wrangler.toml admin lists are valid for every environment', async () => {
  const { adminEmailsFrom, checkAdminEmails } = await import('../scripts/predeploy.mjs');
  const toml = (await import('node:fs')).readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  for (const env of ['production', 'staging']) assert.doesNotThrow(() => checkAdminEmails(adminEmailsFrom(toml, env)), env);
  assert.ok(checkAdminEmails(adminEmailsFrom(toml, 'production')).length >= 1, 'production keeps at least one admin (accepted risk A1)');
});
