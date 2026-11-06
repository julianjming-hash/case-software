// Read-only Actions job-time estimate with replayable run/job metadata exports.
// Never calls Case/Cloudflare/Supabase, changes a budget, or claims to reproduce an invoice.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// GitHub standard hosted pricing, checked 2026-10-09. Override when prices change.
export const STANDARD_RATES = Object.freeze({ linux: 0.006, macos: 0.062, windows: 0.010 });
function list(raw, key) {
  const pages = Array.isArray(raw) ? raw : [raw];
  if (!pages.every(page => Array.isArray(page?.[key]))) throw new Error(`invalid_${key}`);
  return pages.flatMap(page => page[key]);
}
function missingCount(raw, rows) {
  const pages = Array.isArray(raw) ? raw : [raw];
  const expected = Math.max(0, ...pages.map(page => Number.isSafeInteger(page.total_count) ? page.total_count : 0));
  return Math.max(0, expected - new Set(rows.map(row => row.id)).size);
}
function runner(job) {
  const labels = (job.labels ?? []).map(label => String(label).toLowerCase());
  if (labels.includes('self-hosted')) return 'unknown';
  // Case uses these standard labels. Custom/larger/ARM runners must not be priced as 2-core x64.
  if (labels.includes('macos-latest')) return 'macos';
  if (labels.includes('ubuntu-latest') || labels.includes('ubuntu-24.04')) return 'linux';
  if (labels.includes('windows-latest')) return 'windows';
  return 'unknown';
}
export function estimate({ runs, jobPages, rates = STANDARD_RATES, since = null }) {
  for (const key of Object.keys(STANDARD_RATES)) if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new Error('invalid_rates');
  const sinceMs = since === null ? -Infinity : Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new Error('invalid_since');
  const selected = new Map();
  const allRuns = list(runs, 'workflow_runs');
  const missingRunCount = missingCount(runs, allRuns);
  for (const run of allRuns) {
    if (!Number.isSafeInteger(run.id) || !Number.isFinite(Date.parse(run.created_at))) throw new Error('invalid_run');
    if (Date.parse(run.created_at) >= sinceMs) selected.set(run.id, run);
  }
  const seen = new Set(); const executions = new Map(); const rows = new Map(); const byEvent = new Map();
  const pendingRunIds = [...selected.values()].filter(run => run.status !== 'completed').map(run => run.id);
  let unpricedJobs = 0; let incompleteJobs = 0; let unallocatedJobs = 0; let reusedJobRecords = 0; let cancelledEstimateUsd = 0; let missingJobCount = 0;
  const missingRunIds = []; const rerunIds = new Set();
  for (const run of selected.values()) {
    const pages = jobPages instanceof Map ? jobPages.get(run.id) : jobPages[run.id];
    if (!pages) { missingRunIds.push(run.id); continue; }
    const jobs = list(pages, 'jobs'); missingJobCount += missingCount(pages, jobs);
    for (const job of jobs) {
      if (!Number.isSafeInteger(job.id) || job.run_id !== run.id) throw new Error('invalid_job');
      if (seen.has(job.id)) continue; seen.add(job.id);
      if (!job.runner_name) { unallocatedJobs++; continue; }
      if (!job.completed_at) { incompleteJobs++; continue; }
      const seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('invalid_duration');
      // A partial rerun copies retained results under new job IDs/attempts. Same runner and
      // execution interval across attempts is one allocation, not another billable run.
      // Preserve the maximum multiplicity within any attempt, so parallel jobs still count.
      if (Number.isSafeInteger(job.runner_id) && job.runner_id > 0 && Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0) {
        const key = JSON.stringify([run.id, job.name, job.runner_id, job.started_at, job.completed_at, job.conclusion]);
        const execution = executions.get(key) ?? { runId: run.id, attempts: new Map(), maximum: 0 };
        const count = (execution.attempts.get(job.run_attempt) ?? 0) + 1;
        execution.attempts.set(job.run_attempt, count); executions.set(key, execution);
        if (count <= execution.maximum) { reusedJobRecords++; continue; }
        execution.maximum = count;
      }
      const os = runner(job); const minutes = Math.ceil(seconds / 60);
      const cost = os === 'unknown' ? null : minutes * rates[os];
      if (os === 'unknown') unpricedJobs++;
      if ((!Number.isSafeInteger(job.runner_id) || job.runner_id <= 0) && (job.run_attempt ?? 1) > 1) rerunIds.add(run.id);
      const name = job.name.replace(/ \(\d+\)$/, '');
      const key = `${run.name || run.path}/${name}/${os}`;
      const row = rows.get(key) ?? { workflow: run.name || run.path, job: name, os, jobs: 0, roundedMinutes: 0, grossEstimateUsd: 0 };
      row.jobs++; row.roundedMinutes += minutes; row.grossEstimateUsd += cost ?? 0; rows.set(key, row);
      const event = byEvent.get(run.event) ?? { event: run.event, roundedMinutes: 0, grossEstimateUsd: 0 };
      event.roundedMinutes += minutes; event.grossEstimateUsd += cost ?? 0; byEvent.set(run.event, event);
      if (run.conclusion === 'cancelled' || job.conclusion === 'cancelled') cancelledEstimateUsd += cost ?? 0;
    }
  }
  for (const execution of executions.values()) if (Math.min(...execution.attempts.keys()) > 1) rerunIds.add(execution.runId);
  const money = value => Number(value.toFixed(6));
  const ordered = [...rows.values()].map(row => ({ ...row, grossEstimateUsd: money(row.grossEstimateUsd) })).sort((a, b) => b.grossEstimateUsd - a.grossEstimateUsd);
  return {
    estimateOnly: true, rates, since, runs: selected.size, jobs: seen.size,
    missingRunIds, missingRunCount, missingJobCount, pendingRunIds, unpricedJobs, incompleteJobs, unallocatedJobs, reusedJobRecords, rerunRuns: rerunIds.size,
    complete: !missingRunIds.length && !missingRunCount && !missingJobCount && !pendingRunIds.length && !incompleteJobs && !unpricedJobs,
    roundedMinutes: ordered.reduce((sum, row) => sum + row.roundedMinutes, 0),
    allocatedExecutions: ordered.reduce((sum, row) => sum + row.jobs, 0),
    grossEstimateUsd: money(ordered.reduce((sum, row) => sum + row.grossEstimateUsd, 0)),
    cancelledEstimateUsd: money(cancelledEstimateUsd), rows: ordered,
    events: [...byEvent.values()].map(row => ({ ...row, grossEstimateUsd: money(row.grossEstimateUsd) })),
    limits: 'Run creation cohort, not a billing-period total: older runs rerun during the period are excluded, and exported attempts after the period are included. Job start/end rounded separately; actual exported executions counted, copied partial-rerun results deduplicated by runner and interval across attempts. Excludes included allowance, discounts, tax, storage and unknown runner pricing. Compare with the account billing usage export.',
  };
}

/** Read-only GitHub metadata export. Tests inject gh; no deployed Case or billing API is called. */
export async function collect({ repo, since, outDir }, { gh }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isFinite(Date.parse(since)) || !outDir) throw new Error('invalid_collection');
  mkdirSync(join(outDir, 'jobs'), { recursive: true });
  const query = `repos/${repo}/actions/runs?per_page=100&created=${encodeURIComponent(`>=${since}`)}`;
  const runs = JSON.parse(await gh(['api', query, '--paginate', '--slurp']));
  const all = list(runs, 'workflow_runs');
  for (const run of all) if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isFinite(Date.parse(run.created_at))) throw new Error('invalid_run');
  const selected = all.filter(run => Date.parse(run.created_at) >= Date.parse(since));
  // Invalidate the entire selected cohort before publishing the new run list.
  // Interruption during a read must leave missing evidence, never stale complete pricing.
  for (const run of selected) rmSync(join(outDir, 'jobs', `${run.id}.json`), { force: true });
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify(runs));
  const jobPages = new Map();
  // Three reads at a time bounds API traffic. Failures remain missing evidence, never zero usage.
  for (let i = 0; i < selected.length; i += 3) {
    const batch = selected.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map(run => gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`, '--paginate', '--slurp'])));
    for (const [index, result] of results.entries()) {
      // A failed new read must not leave an older successful snapshot masquerading as current.
      rmSync(join(outDir, 'jobs', `${batch[index].id}.json`), { force: true });
      if (result.status !== 'fulfilled') continue;
      let pages; try { pages = JSON.parse(result.value); list(pages, 'jobs'); } catch { continue; }
      const id = batch[index].id; jobPages.set(id, pages);
      writeFileSync(join(outDir, 'jobs', `${id}.json`), JSON.stringify(pages));
    }
  }
  return estimate({ runs, jobPages, since });
}

function github(args) {
  return new Promise((resolveOut, reject) => {
    execFile('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('metadata_unavailable')) : resolveOut(stdout));
  });
}

export async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--runs', '--jobs-dir', '--since', '--repo', '--export'].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) throw new Error('usage');
    options[argv[i]] = argv[i + 1];
  }
  if (options['--repo'] || options['--export']) {
    if (!options['--repo'] || !options['--export'] || !options['--since'] || options['--runs'] || options['--jobs-dir']) throw new Error('usage');
    const result = await collect({ repo: options['--repo'], since: options['--since'], outDir: options['--export'] }, { gh: github });
    console.log(JSON.stringify(result, null, 2)); return result.complete ? 0 : 1;
  }
  if (!options['--runs'] || !options['--jobs-dir']) throw new Error('usage');
  const jobPages = new Map();
  for (const file of readdirSync(options['--jobs-dir'])) if (/^\d+\.json$/.test(file)) jobPages.set(Number(file.slice(0, -5)), JSON.parse(readFileSync(join(options['--jobs-dir'], file), 'utf8')));
  const result = estimate({ runs: JSON.parse(readFileSync(options['--runs'], 'utf8')), jobPages, since: options['--since'] ?? null });
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`ci-cost-report: ${error.message}`); process.exitCode = 2; }
}
