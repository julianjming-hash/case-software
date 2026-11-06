import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_AGE_MS, hostedLinux, main, nightlyNeeded } from '../scripts/ci-nightly-fresh.mjs';

const NOW = Date.parse('2026-10-16T03:00:00Z');
const at = hoursAgo => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const shard = (n, { id = 100 + n, conclusion = 'success', status = 'completed', completed = at(14), slug = 'github-actions' } = {}) =>
  ({ id, name: `browser-harness (${n})`, status, conclusion, completed_at: status === 'completed' ? completed : null, app: { slug } });
const green = (count = 8, options) => Array.from({ length: count }, (_, i) => shard(i + 1, options));
const needed = (runs, shards = 8) => nightlyNeeded([{ check_runs: runs }], { shards, now: NOW });

test('skips only when every shard passed on this exact SHA within 7 days', () => {
  assert.equal(needed(green()), false);
  assert.equal(needed([...green(), { id: 999, name: 'verify', status: 'completed', conclusion: 'success', completed_at: at(1), app: { slug: 'github-actions' } }]), false);
  // Split across paginated pages still counts every shard.
  assert.equal(nightlyNeeded([{ check_runs: green(8).slice(0, 4) }, { check_runs: green(8).slice(4) }], { shards: 8, now: NOW }), false);
  assert.equal(needed(green(8, { completed: at(23.9) })), false);
  assert.equal(needed(green(8, { completed: at(6.9 * 24) })), false, 'an idle main skips for a week (CASE-309)');
});

test('runs when any shard is missing, red, pending, stale, foreign or superseded by a failure', () => {
  assert.equal(needed([]), true);
  assert.equal(needed(green(7)), true, 'a missing eighth shard');
  assert.equal(needed(green(8), 9), true, 'the matrix grew');
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', null]) assert.equal(needed([...green(7), shard(8, { conclusion })]), true, String(conclusion));
  assert.equal(needed([...green(7), shard(8, { status: 'in_progress' })]), true);
  assert.equal(needed([...green(7), shard(8, { completed: new Date(NOW - MAX_AGE_MS - 1).toISOString() })]), true, 'older than a week');
  assert.equal(needed([...green(7), shard(8, { completed: 'not a date' })]), true);
  assert.equal(needed([...green(7), shard(8, { slug: 'some-other-app' })]), true, 'only GitHub Actions checks count');
  // The latest check per shard decides: a later failure masks an earlier success, and vice versa.
  assert.equal(needed([...green(8), shard(3, { id: 500, conclusion: 'failure' })]), true);
  assert.equal(needed([...green(8, { conclusion: 'failure' }).map((c, i) => ({ ...c, id: i + 1 })), ...green(8)]), false);
  // An unnumbered skipped `browser-harness` check (a cron that never ran shards) proves nothing.
  assert.equal(needed([{ id: 900, name: 'browser-harness', status: 'completed', conclusion: 'skipped', completed_at: at(1), app: { slug: 'github-actions' } }]), true);
});

test('malformed input or arguments run the nightly', () => {
  for (const pages of [null, {}, [{}], [{ check_runs: null }], 'x']) assert.equal(nightlyNeeded(pages, { shards: 8, now: NOW }), true);
  for (const shards of [0, -1, 1.5, NaN, undefined]) assert.equal(nightlyNeeded([{ check_runs: green() }], { shards, now: NOW }), true, String(shards));
  assert.equal(nightlyNeeded([{ check_runs: green() }], { shards: 8, now: NaN }), true);
});

test('main reads exactly the commit check runs, writes the output and fails open', async () => {
  const environment = { REPO: 'owner/repo', SHA: 'a'.repeat(40), CASE_BROWSER_SHARDS: '8', CASE_NIGHTLY_HOSTED_ONLY: 'false', GITHUB_OUTPUT: '/out' };
  const writes = []; const write = (file, text) => writes.push([file, text]);
  const calls = [];
  const read = async args => { calls.push(args); return JSON.stringify([{ check_runs: green() }]); };
  const log = console.log; console.log = () => {};
  try {
    assert.equal(await main(environment, { read, now: NOW, write }), false);
    assert.deepEqual(calls, [['api', '--paginate', '--slurp', `repos/owner/repo/commits/${'a'.repeat(40)}/check-runs?per_page=100`]]);
    assert.deepEqual(writes, [['/out', 'nightly=false\n']]);
    for (const failing of [async () => { throw new Error('offline'); }, async () => 'not json']) {
      writes.length = 0;
      assert.equal(await main(environment, { read: failing, now: NOW, write }), true);
      assert.deepEqual(writes, [['/out', 'nightly=true\n']]);
    }
    for (const bad of [{ REPO: 'bad repo' }, { SHA: 'main' }, { CASE_BROWSER_SHARDS: '' }]) {
      writes.length = 0; calls.length = 0;
      assert.equal(await main({ ...environment, ...bad }, { read, now: NOW, write }), true, JSON.stringify(bad));
      assert.deepEqual(writes, [['/out', 'nightly=true\n']]);
    }
  } finally { console.log = log; }
});

// CASE-256: with PR/main shards on the self-hosted Mac, the nightly is the hosted Linux reference.
test('hosted-only counts only shard jobs that ran on ubuntu-latest, and is the default', async () => {
  const environment = { REPO: 'owner/repo', SHA: 'a'.repeat(40), CASE_BROWSER_SHARDS: '8', GITHUB_OUTPUT: '/out' };
  const write = () => {};
  const job = (id, labels) => JSON.stringify({ id, labels });
  const run = async (checks, labelsFor, env = environment) => {
    const calls = [];
    const read = async args => {
      calls.push(args);
      if (args.at(-1).includes('/check-runs')) return JSON.stringify([{ check_runs: checks }]);
      const id = Number(args.at(-1).split('/').pop());
      const labels = labelsFor(id);
      if (labels instanceof Error) throw labels;
      return job(labels === 'wrong-id' ? id + 1 : id, labels === 'wrong-id' ? ['ubuntu-latest'] : labels);
    };
    const log = console.log; console.log = () => {};
    try { return { needed: await main(env, { read, now: NOW, write }), calls }; } finally { console.log = log; }
  };
  // Every latest shard hosted: skip; one job read per shard check.
  let result = await run(green(), () => ['ubuntu-latest']);
  assert.equal(result.needed, false);
  assert.equal(result.calls.length, 9);
  assert.ok(result.calls.slice(1).every(args => args.length === 2 && /^repos\/owner\/repo\/actions\/jobs\/\d+$/.test(args[1])));
  // Green shards from the self-hosted Mac do not excuse the Linux reference.
  for (const labels of [['case-linux'], ['self-hosted', 'case-linux'], ['ubuntu-latest', 'case-linux'], [], null]) assert.equal((await run(green(), () => labels)).needed, true, JSON.stringify(labels));
  // A later Mac run on the same SHA does not hide an earlier hosted pass of every shard.
  const mac = green(8).map(c => ({ ...c, id: c.id + 1000 }));
  assert.equal((await run([...green(), ...mac], id => id > 1000 ? ['case-linux'] : ['ubuntu-latest'])).needed, false);
  // A failed hosted shard is still the latest hosted result even when the Mac run is green.
  assert.equal((await run([...green(7), shard(8, { conclusion: 'failure' }), ...mac], id => id > 1000 ? ['case-linux'] : ['ubuntu-latest'])).needed, true);
  // A job read that fails, or answers for a different id, runs the nightly.
  assert.equal((await run(green(), id => id === 103 ? new Error('offline') : ['ubuntu-latest'])).needed, true);
  assert.equal((await run(green(), id => id === 103 ? 'wrong-id' : ['ubuntu-latest'])).needed, true);
  // Only an explicit 'false' counts every shard without reading jobs.
  for (const value of [undefined, '', 'true', 'TRUE', 'no']) {
    const env = { ...environment }; if (value === undefined) delete env.CASE_NIGHTLY_HOSTED_ONLY; else env.CASE_NIGHTLY_HOSTED_ONLY = value;
    assert.equal((await run(green(), () => ['case-linux'], env)).needed, true, String(value));
  }
  result = await run(green(), () => ['case-linux'], { ...environment, CASE_NIGHTLY_HOSTED_ONLY: 'false' });
  assert.equal(result.needed, false);
  assert.equal(result.calls.length, 1);
  assert.equal(hostedLinux({ id: 1, labels: ['ubuntu-latest'] }, 1), true);
  // Pinned since 2026-10-15; runs from before the pin still count as hosted.
  assert.equal(hostedLinux({ id: 1, labels: ['ubuntu-24.04'] }, 1), true);
  assert.equal(hostedLinux({ id: 1, labels: ['ubuntu-26.04'] }, 1), false, 'a release the VMs do not run is not the reference');
  assert.equal(hostedLinux({ id: 1, labels: ['ubuntu-latest'] }, 2), false);
});

// CASE-309. Known answer from main f208667f, idle 10-22..28: the 10-22 hosted nightly passed all 11
// shards, finishing by 08:31:29Z, yet every later nightly ran, because each job read was a 403.
test('the idle-main week that ran every night now skips until the weekly drift run', async () => {
  const done = Date.parse('2026-10-22T08:31:29Z');
  const hosted = Array.from({ length: 11 }, (_, i) => ({ ...shard(i + 1, { completed: new Date(done - i * 60_000).toISOString() }), id: 119716548000 + i }));
  const night = day => Date.parse(`2026-10-${String(22 + day).padStart(2, '0')}T08:13:54Z`);
  for (let day = 1; day <= 6; day++) assert.equal(nightlyNeeded([{ check_runs: hosted }], { shards: 11, now: night(day) }), false, `night ${day} skips`);
  assert.equal(nightlyNeeded([{ check_runs: hosted }], { shards: 11, now: night(7) + 3_600_000 }), true, 'a week on, the drift run');
  assert.equal(MAX_AGE_MS, 7 * 24 * 3_600_000);
});

test('a job read the token may not make is a visible warning, not a silent nightly', async () => {
  const environment = { REPO: 'owner/repo', SHA: 'a'.repeat(40), CASE_BROWSER_SHARDS: '8', GITHUB_OUTPUT: '/out' };
  const read = async args => { if (args.at(-1).includes('/check-runs')) return JSON.stringify([{ check_runs: green() }]); throw new Error('gh: Resource not accessible by integration (HTTP 403)\n{"message":"x"}'); };
  const lines = []; const log = console.log; console.log = line => lines.push(line);
  try { assert.equal(await main(environment, { read, now: NOW, write: () => {} }), true); } finally { console.log = log; }
  assert.equal(lines[0], '::warning::nightly freshness check could not read GitHub (gh: Resource not accessible by integration (HTTP 403)); the nightly runs');
});

test('the job that runs the freshness check may read Actions jobs and checks', () => {
  const workflow = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8');
  const changes = workflow.split('\n  changes:\n')[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.match(changes, /run: node scripts\/ci-nightly-fresh\.mjs/);
  const permissions = changes.split('    permissions:\n')[1].split('\n    outputs:')[0];
  assert.match(permissions, /^      actions: read$/m, 'without it every job read is a 403 and the nightly never skips');
  assert.match(permissions, /^      checks: read$/m);
  assert.doesNotMatch(permissions, /: write/);
});
