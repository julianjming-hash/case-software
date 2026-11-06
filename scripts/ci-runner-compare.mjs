// scripts/ci-runner-compare.mjs: the self-hosted runner qualification check (CASE-256, CASE-261, docs/CI-RUNNERS.md).
//
//   node scripts/ci-runner-compare.mjs <hosted run id[/attempt]> <self-hosted run id[/attempt]> [--routed verify,browser-harness]
//
// Reads selected-attempt jobs (latest unless /attempt is supplied) and browser/VM logs
// (read-only `gh api`; no secrets, no deployed origin), then prints one table and a verdict. The
// Qualification selects all lanes with workflow and shell comment changes. Both runs must
// pass those required lanes; every job the hosted run ran must also run and pass. Each shard passed
// the same test totals with none failed, flaky or newly skipped. Perf stays hosted;
// every other job of the lanes routed to
// the Case Linux VMs (--routed, default verify and browser-harness: load-gates stays hosted until
// qualified on its own) ran on a `case-linux` runner and printed the job-started hook's canary line;
// and nothing that must stay hosted (the small jobs, the bash 3.2 job) moved. Typing-latency lines and
// job durations are reported side by side, not judged: the VMs are arm64 on other hardware, and the
// hosted x86_64 nightly stays the calibrated reference.
//
//   node scripts/ci-runner-compare.mjs --mac-lanes <hosted dir> <vm dir> <sha> <hosted result> <vm result> <out dir>
//
// The compare job of qualify-macos-vm.yml (docs/MACOS-RUNNER-QUALIFICATION.md): reads each lane's
// downloaded artifact (inventory, gate logs), writes both lane summaries and a report to <out dir>,
// and exits 1 unless both lanes ran, passed and match.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANES = ['verify', 'load-gates', 'browser-harness'];
export const DEFAULT_ROUTED = ['verify', 'browser-harness'];
const HOSTED_ONLY = /^(?:changes|audit|actionlint|browser-shards-status|macos-bash32)$/;
const PATH_FILTERED = new Set(['actionlint', 'macos-bash32']);
const SHARD = /^browser-harness \(\d+\)$/;

/** Playwright list-reporter totals and the CASE-252 typing-latency lines in one job log. */
export function readLog(text) {
  // Every runner log record starts with a timestamp, but a multiline annotation's continuation
  // lines do not. Playwright repeats its terminal summary in a ##[notice] record. Keep record
  // boundaries until that copy is removed; global count deduplication would erase real invocations.
  const lines = [], annotations = { failed: 0, flaky: 0, skipped: 0 };
  let annotation = false;
  const adverse = line => {
    const match = /^\s*(\d+) (failed|flaky|skipped)\b/.exec(line);
    if (match) annotations[match[2]] += Number(match[1]);
  };
  for (const raw of String(text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const stamped = /^\S+Z /.test(raw), line = raw.replace(/^\S+Z /, '');
    if (stamped) annotation = false;
    const header = /^##\[(?:notice|warning|error)\](.*)$/.exec(line);
    if (header) { annotation = true; adverse(header[1]); continue; }
    if (annotation) { adverse(line); continue; }
    lines.push(line);
  }
  const clean = lines.join('\n');
  const count = word => { const all = [...clean.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'gm'))]; return all.reduce((sum, m) => sum + Number(m[1]), 0); };
  return {
    // An annotation alone cannot supply passing evidence. Retain adverse annotation totals as a
    // conservative floor, so incomplete terminal output cannot hide a failure/flake/new skip.
    passed: count('passed'), failed: Math.max(count('failed'), annotations.failed),
    flaky: Math.max(count('flaky'), annotations.flaky), skipped: Math.max(count('skipped'), annotations.skipped),
    typing: [...clean.matchAll(/^typing-latency ([^:\n]+): (median [^\n]+)$/gm)].map(m => [m[1].trim(), m[2].trim()]),
    selections: [...clean.matchAll(/^shard (\d+)\/(\d+): \d+ tests, ~\d+s estimated$/gm)].map(m => [Number(m[1]), Number(m[2])]),
    perf: [...clean.matchAll(/^perf shard: \d+ tests, ~\d+s estimated$/gm)].length,
    canary: /^case-ci: slot \d+ isolation canary ok, port \d+ free, \d+ GB free$/m.test(clean),
  };
}

const seconds = job => { const t = Date.parse(job.completed_at) - Date.parse(job.started_at); return Number.isFinite(t) ? Math.round(t / 1000) : null; };
const hostedLabel = (job, label) => Array.isArray(job?.labels) && job.labels.length === 1 && job.labels[0] === label;
const hostedUbuntu = job => hostedLabel(job, 'ubuntu-24.04');
const onRunner = job => Array.isArray(job?.labels) && job.labels.includes('case-linux');

/** Compare two runs given { jobs, logs: Map(jobId -> text) }; returns { ok, problems, rows }. */
export function compareRuns(hosted, self, { routed = DEFAULT_ROUTED } = {}) {
  const problems = []; const rows = [];
  const byName = jobs => new Map(jobs.map(job => [job.name, job]));
  const h = byName(hosted.jobs), s = byName(self.jobs);
  for (const [label, run, names] of [['hosted', hosted, h], ['self-hosted', self, s]]) {
    if (!run.jobs.length) problems.push(`${label}: no jobs`);
    if (names.size !== run.jobs.length) problems.push(`${label}: duplicate job names`);
    const other = names === h ? s : h;
    for (const required of ['changes', 'verify', 'load-gates', 'macos-bash32', 'audit', 'actionlint']) {
      const conclusion = names.get(required)?.conclusion;
      // The `changes` path filter may skip a hosted-only lane identically in both runs (a source with no workflow or
      // shell change skips actionlint): that is no runner difference. A skip on one side only still refuses.
      if (conclusion === 'success' || (PATH_FILTERED.has(required) && conclusion === 'skipped' && other.get(required)?.conclusion === 'skipped')) continue;
      problems.push(`${label}: ${required} must succeed`);
    }
    const status = names.get('browser-shards-status');
    if (!status || (run.metadata?.event === 'push' ? !['success', 'skipped'].includes(status.conclusion) : status.conclusion !== 'success')) problems.push(`${label}: browser-shards-status must succeed (or skip on push)`);
    if (!run.jobs.some(job => SHARD.test(job.name))) problems.push(`${label}: no browser shards`);
    for (const job of run.jobs.filter(job => SHARD.test(job.name))) {
      if (job.conclusion !== 'success') problems.push(`${label}: ${job.name} must succeed`);
    }
  }
  // The executed selector prints this marker, so shard renumbering cannot turn the
  // new perf shard into a VM lane. Missing or ambiguous logs refuse qualification.
  const perfNames = run => run.jobs.filter(job => SHARD.test(job.name))
    .flatMap(job => Array(readLog(run.logs.get(job.id)).perf).fill(job.name));
  const hp = perfNames(hosted), sp = perfNames(self);
  if (hp.length !== 1 || sp.length !== 1 || hp[0] !== sp[0]) problems.push('runs must have exactly one matching perf shard');
  const perfName = hp.length === 1 ? hp[0] : null;
  const totals = [];
  for (const [label, run] of [['hosted', hosted], ['self-hosted', self]]) {
    const shards = run.jobs.filter(job => SHARD.test(job.name) && job.name !== perfName);
    const selections = shards.map(job => ({ job, log: readLog(run.logs.get(job.id)) }));
    const total = selections[0]?.log.selections[0]?.[1];
    totals.push(total);
    if (!Number.isSafeInteger(total) || total < 1 || total !== shards.length || selections.some(({ job, log }) =>
      log.perf !== 0 || log.selections.length !== 1 || log.selections[0][1] !== total ||
      log.selections[0][0] < 1 || log.selections[0][0] > total || job.name !== `browser-harness (${log.selections[0][0]})`)) {
      problems.push(`${label}: incomplete or inconsistent browser shard selectors`);
    }
    const perfJob = run.jobs.find(job => job.name === perfName);
    if (perfJob && readLog(run.logs.get(perfJob.id)).selections.length) problems.push(`${label}: perf shard also ran a regular selector`);
  }
  if (totals[0] !== totals[1]) problems.push('runs must have matching browser partitions');
  for (const [name, hj] of h) {
    const sj = s.get(name);
    const row = { name, hosted: hj.conclusion, self: sj?.conclusion ?? 'missing', hostedSeconds: seconds(hj), selfSeconds: sj ? seconds(sj) : null, runner: sj?.runner_name ?? '', typing: [] };
    rows.push(row);
    if (!sj) { problems.push(`${name}: missing from the self-hosted run`); continue; }
    if (hj.conclusion === 'success' && sj.conclusion !== 'success') problems.push(`${name}: ${sj.conclusion} on the self-hosted run`);
    const lane = name.replace(/ \(\d+\)$/, '');
    const perf = name === perfName;
    if (perf && (!hostedUbuntu(hj) || !hostedUbuntu(sj))) problems.push(`${name}: perf shard must stay on hosted Ubuntu`);
    if (!perf && routed.includes(lane) && hj.conclusion === 'success' && !onRunner(sj)) problems.push(`${name}: ran on ${JSON.stringify(sj.labels)}, not case-linux`);
    if (HOSTED_ONLY.test(name)) {
      const requiredLabel = name === 'macos-bash32' ? 'macos-latest' : 'ubuntu-24.04';
      for (const job of [hj, sj]) if (job.conclusion !== 'skipped' && !hostedLabel(job, requiredLabel)) problems.push(`${name}: must stay hosted on ${requiredLabel}`);
    } else if (!routed.includes(lane) && LANES.includes(lane)) {
      for (const job of [hj, sj]) if (!hostedUbuntu(job)) problems.push(`${name}: unrouted lane must stay on hosted Ubuntu`);
    }
    if (onRunner(sj) && sj.conclusion !== 'skipped' && !readLog(self.logs.get(sj.id)).canary) problems.push(`${name}: no job-started canary line in its log`);
    if (SHARD.test(name) && hj.conclusion === 'success') {
      const a = readLog(hosted.logs.get(hj.id)), b = readLog(self.logs.get(sj.id));
      Object.assign(row, { hostedPassed: a.passed, selfPassed: b.passed });
      row.typing = b.typing.map(([label, value]) => [label, a.typing.find(([l]) => l === label)?.[1] ?? '-', value]);
      if (!hostedUbuntu(hj)) problems.push(`${name}: reference browser shard must run on hosted Ubuntu`);
      if (a.failed || a.flaky) problems.push(`${name}: reference has ${a.failed} failed, ${a.flaky} flaky`);
      if (a.passed === 0) problems.push(`${name}: no Playwright total in the hosted log`);
      if (a.passed !== b.passed) problems.push(`${name}: ${b.passed} passed on the VM, ${a.passed} hosted`);
      if (b.failed || b.flaky) problems.push(`${name}: ${b.failed} failed, ${b.flaky} flaky on the VM`);
      if (a.skipped !== b.skipped) problems.push(`${name}: ${b.skipped} skipped on the VM, ${a.skipped} hosted`);
    }
  }
  for (const name of s.keys()) if (!h.has(name)) problems.push(`${name}: only in the self-hosted run`);
  return { ok: problems.length === 0, problems, rows };
}

export function report({ ok, problems, rows }) {
  const lines = ['| job | hosted | self-hosted | runner | hosted s | self s | passed (hosted/self) |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.name} | ${r.hosted} | ${r.self} | ${r.runner} | ${r.hostedSeconds ?? '-'} | ${r.selfSeconds ?? '-'} | ${r.hostedPassed === undefined ? '' : `${r.hostedPassed}/${r.selfPassed}`} |`);
  const typing = rows.flatMap(r => r.typing.map(([label, a, b]) => `| ${label} | ${a} | ${b} |`));
  if (typing.length) lines.push('', '| typing-latency | hosted | self-hosted |', '|---|---|---|', ...typing);
  lines.push('', ok ? 'QUALIFIED: all compared gates passed on their required runners; perf stayed hosted.' : `NOT QUALIFIED:\n${problems.map(p => `- ${p}`).join('\n')}`);
  return lines.join('\n');
}

// ---- Manual Mac qualification: hosted macOS versus the isolated Mac VM, one exact SHA ----

export const MAC_GATES = { check: 'check.log', unit: 'unit.log', do: 'do.log', db: 'db.log' };
export const APPROVED_VM_BUILD = '26A434';
const strip = text => String(text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** The node:test summary (TAP `# pass 3` or spec `ℹ pass 3`); null when the run printed none. */
export function readTestTotals(text) {
  const totals = {};
  for (const m of strip(text).matchAll(/^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) totals[m[1]] = Number(m[2]);
  return ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(k => k in totals) ? totals : null;
}

/** Vitest's `Tests  1 failed | 183 passed (184)` line; null when absent. */
export function readVitestTotals(text) {
  const line = strip(text).match(/^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/m);
  if (!line) return null;
  const totals = { passed: 0, failed: 0, skipped: 0, todo: 0, total: Number(line[2]) };
  for (const m of line[1].matchAll(/(\d+) (passed|failed|skipped|todo)\b/g)) totals[m[2]] += Number(m[1]);
  return totals;
}

export function readDbLog(text) {
  const clean = strip(text);
  return {
    migrations: (clean.match(/^migrate \S+\.sql$/gm) ?? []).length,
    sqlTests: (clean.match(/^test \S+\.test\.sql$/gm) ?? []).length,
    node: readTestTotals(clean),
    passed: /^database tests passed$/m.test(clean),
  };
}

export function readInventory(text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/^([a-z_]+)=(.*)$/gm)) out[m[1]] = m[2].trim();
  return out;
}

/** One lane from its artifact files ({ inventory, result, check, unit, do, db }: text or undefined). */
export function summarizeLane(files, result) {
  const check = strip(files.check).match(/^case:check — ok \((\d+) files, (\d+) docs\)$/m);
  return {
    result, present: Boolean(files.inventory),
    inventory: readInventory(files.inventory), status: readInventory(files.result).job_status ?? null,
    check: check ? { files: Number(check[1]), docs: Number(check[2]) } : null,
    unit: readTestTotals(files.unit), do: readVitestTotals(files.do), db: files.db === undefined ? null : readDbLog(files.db),
  };
}

const postgresMajor = v => String(v ?? '').match(/\(PostgreSQL\) (\d+)\./)?.[1] ?? null;

/** Fails on any missing/failed/cancelled/skipped lane, failed or skipped test, or count mismatch. */
export function compareMacLanes(hosted, vm, { sha } = {}) {
  const problems = []; const drift = [];
  const lanes = { hosted, vm };
  for (const [name, lane] of Object.entries(lanes)) {
    if (lane.result !== 'success') problems.push(`${name}: job ${lane.result || 'missing'}`);
    if (!lane.present) { problems.push(`${name}: no lane artifact`); continue; }
    if (lane.status !== 'success') problems.push(`${name}: recorded job status ${lane.status ?? 'missing'}`);
    if (lane.inventory.platform !== name) problems.push(`${name}: inventory platform ${lane.inventory.platform ?? 'missing'}`);
    if (!/^[a-f0-9]{40}$/.test(sha ?? '') || lane.inventory.source !== sha) problems.push(`${name}: tested ${lane.inventory.source ?? 'nothing'}, not ${sha}`);
    if (!lane.check) problems.push(`${name}: no check result`);
    if (!lane.unit) problems.push(`${name}: no npm test totals`);
    else {
      if (lane.unit.fail || lane.unit.cancelled) problems.push(`${name}: npm test ${lane.unit.fail} failed, ${lane.unit.cancelled} cancelled`);
      if (lane.unit.skipped) problems.push(`${name}: npm test skipped ${lane.unit.skipped}`);
    }
    if (!lane.do) problems.push(`${name}: no test:do totals`);
    else if (lane.do.failed || lane.do.skipped || lane.do.passed + lane.do.todo !== lane.do.total) problems.push(`${name}: test:do ${lane.do.failed} failed, ${lane.do.skipped} skipped of ${lane.do.total}`);
    if (!lane.db || !lane.db.passed || !lane.db.node) problems.push(`${name}: database tests did not complete`);
    else if (lane.db.node.fail || lane.db.node.cancelled || lane.db.node.skipped) problems.push(`${name}: database node tests ${lane.db.node.fail} failed, ${lane.db.node.cancelled} cancelled, ${lane.db.node.skipped} skipped`);
  }
  if (hosted.present && vm.present) {
    const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label}: vm ${JSON.stringify(b)}, hosted ${JSON.stringify(a)}`); };
    same('tree', hosted.inventory.tree, vm.inventory.tree);
    same('check', hosted.check, vm.check);
    same('npm test', hosted.unit, vm.unit);
    same('test:do', hosted.do, vm.do);
    same('test:db', hosted.db, vm.db);
    // Version drift: Node resolves the latest 22.x in both lanes and must match; Bash must be the
    // identical 3.2; Postgres must be 16 (minor versions may differ: the counts above are the gate);
    // the VM must run the approved image. OS, clang and Postgres minor differences are recorded.
    same('node', hosted.inventory.node, vm.inventory.node);
    same('bash', hosted.inventory.bash, vm.inventory.bash);
    for (const [name, lane] of Object.entries(lanes)) {
      if (!/^3\.2\.\d+/.test(lane.inventory.bash ?? '')) problems.push(`${name}: bash ${lane.inventory.bash ?? 'missing'}, not 3.2`);
      if (postgresMajor(lane.inventory.postgres) !== '16') problems.push(`${name}: postgres ${lane.inventory.postgres ?? 'missing'}, not 16`);
    }
    if (vm.inventory.os_build !== APPROVED_VM_BUILD) problems.push(`vm: macOS build ${vm.inventory.os_build ?? 'missing'}, not the approved ${APPROVED_VM_BUILD}`);
    for (const key of ['os_version', 'os_build', 'postgres', 'cc', 'npm']) if (hosted.inventory[key] !== vm.inventory[key]) drift.push(`${key}: hosted ${hosted.inventory[key] ?? '-'}, vm ${vm.inventory[key] ?? '-'}`);
  }
  return { ok: problems.length === 0, problems, drift };
}

export function macReport({ ok, problems, drift }, hosted, vm) {
  const cell = (lane, pick) => { try { return pick(lane) ?? '-'; } catch { return '-'; } };
  const rows = [
    ['job', l => l.result], ['tree', l => l.inventory.tree], ['macOS', l => `${l.inventory.os_version}/${l.inventory.os_build}`],
    ['check files/docs', l => `${l.check.files}/${l.check.docs}`],
    ['npm test pass/fail/skip/todo', l => `${l.unit.pass}/${l.unit.fail}/${l.unit.skipped}/${l.unit.todo}`],
    ['test:do passed/total', l => `${l.do.passed}/${l.do.total}`],
    ['test:db migrations/sql/node', l => `${l.db.migrations}/${l.db.sqlTests}/${l.db.node.pass}`],
    ['node', l => l.inventory.node], ['bash', l => l.inventory.bash], ['postgres', l => l.inventory.postgres],
  ];
  const lines = ['| | hosted | vm |', '|---|---|---|', ...rows.map(([label, pick]) => `| ${label} | ${cell(hosted, pick)} | ${cell(vm, pick)} |`)];
  if (drift.length) lines.push('', 'Recorded environment differences (not failures):', ...drift.map(d => `- ${d}`));
  lines.push('', ok ? 'QUALIFIED SAMPLE: both lanes ran the exact SHA, passed and match.' : `NOT QUALIFIED:\n${problems.map(p => `- ${p}`).join('\n')}`);
  return lines.join('\n');
}

function readLane(dir) {
  const file = name => { const path = join(dir, name); return existsSync(path) ? readFileSync(path, 'utf8') : undefined; };
  return { inventory: file('inventory.txt'), result: file('result.txt'), ...Object.fromEntries(Object.entries(MAC_GATES).map(([key, name]) => [key, file(name)])) };
}

export function macMain(argv, { log = console.log } = {}) {
  const [hostedDir, vmDir, sha, hostedResult, vmResult, outDir] = argv;
  if (argv.length !== 6 || !/^[a-f0-9]{40}$/.test(sha)) {
    log('usage: node scripts/ci-runner-compare.mjs --mac-lanes <hosted dir> <vm dir> <sha> <hosted result> <vm result> <out dir>'); return 2;
  }
  const hosted = summarizeLane(readLane(hostedDir), hostedResult); const vm = summarizeLane(readLane(vmDir), vmResult);
  const result = compareMacLanes(hosted, vm, { sha });
  const text = macReport(result, hosted, vm);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'hosted.json'), `${JSON.stringify(hosted, null, 2)}\n`);
  writeFileSync(join(outDir, 'vm.json'), `${JSON.stringify(vm, null, 2)}\n`);
  writeFileSync(join(outDir, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), `${text}\n`);
  log(text);
  return result.ok ? 0 : 1;
}

function gh(args) {
  return new Promise((done, fail) => execFile('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? fail(error) : done(stdout)));
}

async function readRun(repo, selector, read) {
  const [id, attempt] = selector.split('/');
  const path = `repos/${repo}/actions/runs/${id}${attempt ? `/attempts/${attempt}` : ''}`;
  const metadata = JSON.parse(await read(['api', path]));
  const pages = JSON.parse(await read(['api', '--paginate', '--slurp', `${path}/jobs?${attempt ? '' : 'filter=latest&'}per_page=100`]));
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page.jobs))) throw new Error('invalid job pages');
  const jobs = pages.flatMap(page => page.jobs);
  const expected = Math.max(...pages.map(page => page.total_count ?? page.jobs.length));
  if (expected !== new Set(jobs.map(job => job.id)).size) throw new Error('incomplete job pages');
  const logs = new Map();
  for (const job of jobs) if ((SHARD.test(job.name) || onRunner(job)) && job.conclusion !== 'skipped') logs.set(job.id, await read(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.id}/logs`]));
  return { jobs, logs, metadata };
}

export async function main(argv = process.argv.slice(2), { read = gh, repo = 'julianjming-hash/case', log = console.log } = {}) {
  if (argv[0] === '--mac-lanes') return macMain(argv.slice(1), { log });
  const [hostedId, selfId, flag, list] = argv;
  const routed = flag === '--routed' ? String(list ?? '').split(',') : DEFAULT_ROUTED;
  if (!/^\d+(?:\/[1-9]\d*)?$/.test(hostedId ?? '') || !/^\d+(?:\/[1-9]\d*)?$/.test(selfId ?? '') || (flag !== undefined && flag !== '--routed') || !routed.every(lane => LANES.includes(lane))) {
    log(`usage: node scripts/ci-runner-compare.mjs <hosted run id[/attempt]> <self-hosted run id[/attempt]> [--routed ${LANES.join(',')}]`); return 2;
  }
  const hosted = await readRun(repo, hostedId, read), self = await readRun(repo, selfId, read);
  const result = compareRuns(hosted, self, { routed });
  for (const [label, run] of [['hosted', hosted], ['self-hosted', self]]) {
    if (run.metadata.status !== 'completed' || run.metadata.conclusion !== 'success' || run.metadata.path !== '.github/workflows/verify.yml') result.problems.push(`${label}: completed successful verify workflow required`);
  }
  if (!/^[0-9a-f]{40}$/.test(hosted.metadata.head_sha ?? '') || hosted.metadata.head_sha !== self.metadata.head_sha) result.problems.push('runs must have the same source head SHA');
  if (hosted.metadata.event !== self.metadata.event || hosted.metadata.head_branch !== self.metadata.head_branch) result.problems.push('runs must have the same event and branch');
  // PR head SHA is not the tested synthetic merge SHA. Re-running one run preserves
  // its original event checkout; a different run may incorporate a newer base.
  if (hosted.metadata.event === 'pull_request' && hostedId.split('/')[0] !== selfId.split('/')[0]) result.problems.push('PR qualification requires attempts of the same run');
  result.ok = result.problems.length === 0;
  log(report(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
