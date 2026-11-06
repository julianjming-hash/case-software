// scripts/ci-nightly-fresh.mjs: should tonight's scheduled browser suite run on this main SHA?
//
// verify.yml's `changes` job runs this on the 03:00 cron only. The nightly exists to put a full
// browser run on main when no push run did (a non-browser change, a cancelled run) and to catch
// drift on unchanged code. When every browser shard already passed on this exact SHA within the
// last 7 days, a nightly re-runs identical code for about 96 billed minutes, so it is skipped; an idle
// main is still re-run weekly, the drift check (CASE-309). Fails open: any read or parse problem, a
// missing, failed, pending or older shard means the nightly runs, and a failed read is printed as a
// workflow warning so it can't hide again. Read-only (checks: read, actions: read); prints
// `nightly=true|false` to GITHUB_OUTPUT. Never calls a deployed origin or a metered backend.
//
// When PR/main shards run on the self-hosted Mac (CASE-256), the nightly is the hosted Linux
// reference, so only shard jobs that ran on GitHub-hosted Ubuntu count. That is the default: only an
// explicit CASE_NIGHTLY_HOSTED_ONLY=false counts every shard, and an unreadable job counts as not hosted.
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARD = /^browser-harness \((\d+)\)$/;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A job ran on a GitHub-hosted Linux runner: its one requested label is `ubuntu-24.04` (pinned since
 * 2026-10-15) or `ubuntu-latest` (before the pin). */
export const HOSTED_LINUX = Object.freeze(['ubuntu-24.04', 'ubuntu-latest']);
export const hostedLinux = (job, id) => job?.id === id && Array.isArray(job.labels) && job.labels.length === 1 && HOSTED_LINUX.includes(job.labels[0]);

/** The browser-harness check runs from GitHub Actions, across every page. */
export function shardChecks(pages) {
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.check_runs))) return [];
  return pages.flatMap(page => page.check_runs).filter(check => check?.app?.slug === 'github-actions' && Number.isSafeInteger(check.id) && SHARD.test(String(check.name ?? '')));
}

/** True when the nightly must run: some shard 1..shards lacks a green, recent latest check run. */
export function nightlyNeeded(pages, { shards, now, maxAgeMs = MAX_AGE_MS, include = () => true }) {
  if (!Number.isSafeInteger(shards) || shards < 1 || !Number.isFinite(now)) return true;
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.check_runs))) return true;
  const latest = new Map();
  for (const check of pages.flatMap(page => page.check_runs)) {
    if (check?.app?.slug !== 'github-actions' || !Number.isSafeInteger(check.id) || !include(check)) continue;
    const shard = String(check.name ?? '').match(SHARD)?.[1];
    if (shard && (!latest.has(shard) || check.id > latest.get(shard).id)) latest.set(shard, check);
  }
  for (let shard = 1; shard <= shards; shard++) {
    const check = latest.get(String(shard));
    const completed = Date.parse(check?.completed_at ?? '');
    if (check?.status !== 'completed' || check.conclusion !== 'success' || !Number.isFinite(completed) || now - completed > maxAgeMs) return true;
  }
  return false;
}

function gh(args) {
  return new Promise((resolveOut, reject) => {
    execFile('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolveOut(stdout));
  });
}

export async function main(environment = process.env, { read = gh, now = Date.now(), write = appendFileSync } = {}) {
  const shards = Number(environment.CASE_BROWSER_SHARDS);
  let needed = true;
  if (/^[\w.-]+\/[\w.-]+$/.test(environment.REPO ?? '') && /^[0-9a-f]{40}$/.test(environment.SHA ?? '')) {
    try {
      const pages = JSON.parse(await read(['api', '--paginate', '--slurp', `repos/${environment.REPO}/commits/${environment.SHA}/check-runs?per_page=100`]));
      let include = () => true;
      if (environment.CASE_NIGHTLY_HOSTED_ONLY !== 'false') {
        const hosted = new Set();
        // An Actions check run's id is its job's id; the job records the runner labels it asked for.
        for (const check of shardChecks(pages)) if (hostedLinux(JSON.parse(await read(['api', `repos/${environment.REPO}/actions/jobs/${check.id}`])), check.id)) hosted.add(check.id);
        include = check => hosted.has(check.id);
      }
      needed = nightlyNeeded(pages, { shards, now, include });
    } catch (error) {
      // Until CASE-309 every job read was a silent 403 (the job lacked actions: read), so the nightly never skipped.
      needed = true;
      console.log(`::warning::nightly freshness check could not read GitHub (${String(error?.message ?? error).split('\n')[0].replace(/[^\w .:/()-]/g, '').slice(0, 160)}); the nightly runs`);
    }
  }
  const line = `nightly=${needed}\n`;
  if (environment.GITHUB_OUTPUT) write(environment.GITHUB_OUTPUT, line);
  console.log(needed ? 'nightly browser suite runs' : `all ${shards} browser shards already passed on this exact SHA within 7 days; nightly skipped`);
  return needed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
