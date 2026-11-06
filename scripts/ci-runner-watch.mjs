// scripts/ci-runner-watch.mjs: alarm when Case's self-hosted Linux runners stall (CASE-261, docs/CI-RUNNERS.md).
//
// Run daily by .github/workflows/runner-watch.yml, and only while a CASE_*_RUNNER variable routes to
// `case-linux`. A stopped or sleeping mini, a VM that will not boot, or a supervisor that cannot start
// shows up only as jobs waiting for a `case-linux` runner. Any such job queued longer than
// MAX_QUEUED_MINUTES opens (or comments on) one `runner-alarm` issue and fails this run, so the stall
// reaches Julian whoever pushed. Read-only on runs and jobs (`actions: read`); writes only that issue.
// It never reads runner status: that needs an administration token, which CI does not hold.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'case-linux';

/** Jobs routed to the Case runners and still queued after `maxMinutes`. */
export function staleJobs(runs, { now, maxMinutes }) {
  const stale = [];
  for (const run of runs) {
    for (const job of run.jobs ?? []) {
      if (job?.status !== 'queued' || !Array.isArray(job.labels) || !job.labels.includes(LABEL)) continue;
      const queuedFor = (now - Date.parse(job.created_at ?? '')) / 60_000;
      if (Number.isFinite(queuedFor) && queuedFor >= maxMinutes) stale.push({ name: job.name, url: job.html_url ?? run.html_url, minutes: Math.floor(queuedFor) });
    }
  }
  return stale;
}

export function alarmBody(stale, maxMinutes) {
  const lines = stale.map(job => `- ${job.name}: queued ${job.minutes} min (${job.url})`);
  return [`${stale.length} job(s) have waited more than ${maxMinutes} minutes for a \`${LABEL}\` runner. The Mac mini, a VM or the supervisor may be down.`,
    '', ...lines, '',
    'Fall back to hosted runners at once (docs/CI-RUNNERS.md §Rollback): `for v in CASE_BROWSER_RUNNER CASE_VERIFY_RUNNER CASE_LOAD_RUNNER; do gh variable delete "$v" --repo julianjming-hash/case; done`, then cancel and rerun the queued runs.',
    'Then check the mini: `sudo /bin/bash /private/var/root/case-linux-runner-setup.sh probe` and `/private/var/log/case-ci/supervisor.log`.'].join('\n');
}

function gh(args) {
  return new Promise((done, fail) => execFile('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? fail(error) : done(stdout)));
}

export async function main(environment = process.env, { run = gh, now = Date.now(), log = console.log } = {}) {
  const repo = environment.REPO ?? '';
  const maxMinutes = Number(environment.MAX_QUEUED_MINUTES);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(maxMinutes) || maxMinutes < 5) throw new Error('runner_watch_bad_input');
  const runs = [];
  for (const status of ['queued', 'in_progress']) {
    const pages = JSON.parse(await run(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs?status=${status}&per_page=100`]));
    for (const workflowRun of pages.flatMap(page => page.workflow_runs ?? [])) {
      const jobs = JSON.parse(await run(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${workflowRun.id}/jobs?filter=latest&per_page=100`]));
      runs.push({ html_url: workflowRun.html_url, jobs: jobs.flatMap(page => page.jobs ?? []) });
    }
  }
  const stale = staleJobs(runs, { now, maxMinutes });
  if (!stale.length) { log(`no ${LABEL} job queued for ${maxMinutes} minutes or more`); return 0; }
  const body = alarmBody(stale, maxMinutes);
  await run(['label', 'create', 'runner-alarm', '--repo', repo, '--color', 'B60205', '--force']);
  const open = (await run(['issue', 'list', '--repo', repo, '--label', 'runner-alarm', '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty'])).trim();
  if (/^\d+$/.test(open)) await run(['issue', 'comment', open, '--repo', repo, '--body', body]);
  else await run(['issue', 'create', '--repo', repo, '--label', 'runner-alarm', '--title', 'Runner alarm: Case jobs are waiting for the Mac mini runners', '--body', body]);
  log(body);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
