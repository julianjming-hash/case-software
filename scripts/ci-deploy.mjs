#!/usr/bin/env node
// scripts/ci-deploy.mjs: the CI deploy driver (docs/plans/AUTONOMOUS-DEPLOY.md §2, §5).
//
//   node scripts/ci-deploy.mjs admit  --env staging|production   (no secrets; prints GITHUB_OUTPUT lines)
//   node scripts/ci-deploy.mjs deploy --env staging|production   (holds the deploy secrets)
//
// Runs only inside the deploy-staging / deploy-production workflows. Agents never run it locally:
// `deploy` needs the Cloudflare token and the guard token, which exist only as repository secrets.
// Every check is a pure function of injected `git`, `gh`, `wrangler`, `fetchImpl` and `sleep`, so the
// tests use fakes and never reach a deployed origin, GitHub or Cloudflare (hard rule 12).
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOY_ORIGINS, predeploy, readVersion, redactDetail, runCommand } from './predeploy.mjs';

const SHA = /^[0-9a-f]{40}$/;
const GUARD_SECRET = Object.freeze({ staging: 'CASE_STAGING_DEPLOY_GUARD_TOKEN', production: 'CASE_PRODUCTION_DEPLOY_GUARD_TOKEN' });
const WORKFLOW = Object.freeze({ staging: 'deploy-staging.yml', production: 'deploy-production.yml' });
export const READBACK_WINDOW_MS = 180_000;
const READBACK_STEP_MS = 15_000;

const refuse = (code, detail) => { const e = new Error(code); if (detail) e.detail = detail; throw e; };

export function parseArgs(argv) {
  const [mode, flag, env, ...rest] = argv;
  if (!['admit', 'deploy'].includes(mode) || flag !== '--env' || !Object.hasOwn(DEPLOY_ORIGINS, env ?? '') || rest.length) refuse('usage');
  return { mode, env };
}

/** Latest run of `workflow` for `sha` that matches path/branch/event; null if none. */
async function latestRun(gh, repo, workflow, sha, { event } = {}) {
  const query = `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&branch=main&per_page=100${event ? `&event=${event}` : ''}`;
  let runs; try { runs = JSON.parse(await gh(['api', query])).workflow_runs; } catch { refuse('github_unavailable'); }
  if (!Array.isArray(runs)) refuse('github_unavailable');
  const matching = runs.filter(r => r?.path === `.github/workflows/${workflow}` && r.head_branch === 'main' && r.head_sha === sha && (!event || r.event === event));
  return matching.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0] ?? null;
}

/** Exact-CI rule: the latest push run of verify.yml on main for this SHA completed successfully. */
export async function exactCiGreen(gh, repo, sha) {
  const run = await latestRun(gh, repo, 'verify.yml', sha, { event: 'push' });
  return run?.status === 'completed' && run.conclusion === 'success';
}

/** A rolled-back SHA leaves a `rolled-back-<env>-<sha>` artifact from a main run of the deploy workflow. */
export async function wasRolledBack(gh, repo, env, sha) {
  let list; try { list = JSON.parse(await gh(['api', `repos/${repo}/actions/artifacts?name=rolled-back-${env}-${sha}&per_page=100`])).artifacts; } catch { refuse('github_unavailable'); }
  if (!Array.isArray(list)) refuse('github_unavailable');
  return list.some(a => a?.workflow_run?.head_branch === 'main');
}

/** Admission: returns { decision: 'deploy'|'skip', reason } or throws a refusal code. Holds no secrets. */
export async function admit({ env, sha, repo }, { git, gh, fetchImpl, timeoutMs = 15_000 }) {
  if (!SHA.test(sha ?? '')) refuse('invalid_sha');
  const main = (await git(['rev-parse', 'origin/main'])).trim();
  if (sha !== main) refuse('sha_not_main_tip');
  if (!await exactCiGreen(gh, repo, sha)) refuse('ci_not_green');
  if (await wasRolledBack(gh, repo, env, sha)) refuse('sha_rolled_back');
  if (env === 'production') {
    const staged = await readVersion(DEPLOY_ORIGINS.staging, 'staging', fetchImpl, timeoutMs).catch(() => refuse('not_soaked_on_staging'));
    const run = await latestRun(gh, repo, WORKFLOW.staging, sha);
    if (staged !== sha || !(run?.status === 'completed' && run.conclusion === 'success')) refuse('not_soaked_on_staging');
  }
  const deployed = await readVersion(DEPLOY_ORIGINS[env], env, fetchImpl, timeoutMs);
  if (deployed === sha) return { decision: 'skip', reason: 'already_deployed' };
  try { await git(['merge-base', '--is-ancestor', deployed, sha]); } catch { refuse('deployed_build_not_ancestor'); }
  return { decision: 'deploy', reason: 'admitted' };
}

/** Migration tags, DO class names and the entry module's exported classes at a revision. */
export async function doSignature(git, rev) {
  const toml = await git(['show', `${rev}:wrangler.toml`]);
  const entry = await git(['show', `${rev}:src/worker/index.mjs`]);
  const tags = [...toml.matchAll(/^\s*tag\s*=\s*"([^"]+)"/gm)].map(m => m[1]);
  const classes = [...toml.matchAll(/^\s*(?:class_name|new_sqlite_classes|new_classes|deleted_classes|renamed_classes)\s*=\s*(.+)$/gm)].map(m => m[1].trim());
  const exported = [...entry.matchAll(/^export\s+(?:class\s+(\w+)|\{\s*([\w\s,]+?)\s*\})/gm)].flatMap(m => (m[1] ?? m[2]).split(',').map(x => x.trim()));
  return JSON.stringify({ tags: [...new Set(tags)].sort(), classes: [...new Set(classes)].sort(), exported: [...new Set(exported)].sort() });
}

async function pollVersion(origin, env, want, { fetchImpl, sleep, now, timeoutMs, windowMs = READBACK_WINDOW_MS }) {
  const until = now() + windowMs;
  for (;;) {
    const build = await readVersion(origin, env, fetchImpl, timeoutMs).catch(() => null);
    if (build === want) return true;
    if (now() + READBACK_STEP_MS > until) return false;
    await sleep(READBACK_STEP_MS);
  }
}

/**
 * Deploy. Returns { outcome, build, currentVersion, previousBuild, previousVersion } on success; throws a refusal code otherwise.
 * `outcomeDir` receives rolled-back.json when staging is rolled back (uploaded as the marker artifact).
 */
export async function deploy({ env, sha, secrets }, { git, wrangler, run, fetchImpl, sleep, now, timeoutMs = 15_000, childEnv, outcomeDir }) {
  if (!SHA.test(sha ?? '')) refuse('invalid_sha');
  const guard = secrets?.guard; const cloudflare = secrets?.cloudflare;
  if (!guard || !cloudflare) refuse('secrets_missing');
  const redact = text => redactDetail(text, [guard, cloudflare]);
  if ((await git(['rev-parse', 'HEAD'])).trim() !== sha) refuse('checkout_mismatch');
  await git(['fetch', '--prune', 'origin']);
  if ((await git(['rev-parse', 'origin/main'])).trim() !== sha) refuse('sha_not_main_tip');

  const dry = await wrangler(['deploy', '--dry-run', '--env', env]);
  if (dry.code !== 0) refuse('build_failed', redact(dry.stderr));
  const status = await wrangler(['deployments', 'status', '--env', env, '--json']);
  if (status.code !== 0) refuse('cloudflare_auth_failed', redact(status.stderr));
  let previousVersion;
  try {
    const versions = JSON.parse(status.stdout).versions;
    if (versions.length !== 1 || versions[0].percentage !== 100 || !/^[0-9a-f-]{36}$/.test(versions[0].version_id)) throw new Error();
    previousVersion = versions[0].version_id;
  } catch { refuse('deployment_state_unexpected'); }
  const origin = DEPLOY_ORIGINS[env];
  const previousBuild = await readVersion(origin, env, fetchImpl, timeoutMs);
  const migrationChanged = await doSignature(git, previousBuild) !== await doSignature(git, sha);

  // Watch whether predeploy reached `wrangler deploy`, so a later failure is classified correctly.
  let deployAttempted = false;
  const watchedRun = async (cmd, args, opts) => {
    if (cmd === 'npx' && args.includes('deploy') && !args.includes('--dry-run')) deployAttempted = true;
    return run(cmd, args, opts);
  };
  let outcome = 'deployed';
  try {
    await predeploy({ env, prod: env === 'production' }, { run: watchedRun, fetchImpl, timeoutMs, token: guard, env: childEnv, secrets: [cloudflare] });
  } catch (error) {
    if (!deployAttempted) throw error;
    const detail = error.detail;
    if (await pollVersion(origin, env, sha, { fetchImpl, sleep, now, timeoutMs })) outcome = 'deployed_after_readback_retry';
    else {
      if (await readVersion(origin, env, fetchImpl, timeoutMs).catch(() => null) === previousBuild && error.message === 'deploy_failed') refuse('deploy_failed', detail);
      if (env === 'production') refuse('deployed_unverified', `Not rolled back (production). Owner command: npx wrangler rollback ${previousVersion} --env production -m "<reason>". Rolling back across CASE-153 makes newer phones' joins fail until they reload.`);
      if (migrationChanged) refuse('rollback_blocked_migration', 'A Durable Object migration or class change lies between the two builds; Cloudflare refuses that rollback. Fix forward.');
      const back = await wrangler(['rollback', previousVersion, '--env', env, '-m', `ci-deploy: ${sha} unverified`, '-y']);
      const restored = back.code === 0 && await pollVersion(origin, env, previousBuild, { fetchImpl, sleep, now, timeoutMs });
      if (!restored) refuse('rollback_failed', redact(back.stderr));
      if (outcomeDir) { mkdirSync(outcomeDir, { recursive: true }); writeFileSync(`${outcomeDir}/rolled-back.json`, `${JSON.stringify({ env, sha, previousBuild, previousVersion })}\n`); }
      refuse('rolled_back', `Staging restored to ${previousBuild}. Rolling back across CASE-153 makes newer phones' joins fail until they reload.`);
    }
  }
  // Provenance failure must not re-enter readback recovery or roll back an already verified build.
  let currentVersion;
  try {
    const current = await wrangler(['deployments', 'status', '--env', env, '--json']);
    if (current.code !== 0 || typeof current.stdout !== 'string' || current.stdout.length > 65_536) throw new Error();
    const versions = JSON.parse(current.stdout).versions;
    if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100
      || typeof versions[0]?.version_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(versions[0]?.version_id)) throw new Error();
    currentVersion = versions[0].version_id;
  } catch {
    refuse('deployed_unverified', `Build ${sha} read back, but current Cloudflare version provenance is unavailable. Not rolled back (${env}); previous version ${previousVersion}.`);
  }
  return { outcome, build: sha, currentVersion, previousBuild, previousVersion };
}

/** A fixed public release record; never spread command output or configuration into evidence. */
export function deploymentProvenance(env, { outcome, build, currentVersion, previousBuild, previousVersion }) {
  return { env, outcome, build, currentVersion, previousBuild, previousVersion };
}

async function main(argv, environment) {
  const { mode, env } = parseArgs(argv);
  const repo = environment.GITHUB_REPOSITORY; const sha = environment.SHA;
  const base = { env: { PATH: environment.PATH, HOME: environment.HOME } };
  const text = async (cmd, args, opts = base) => { const r = await runCommand(cmd, args, opts); if (r.code !== 0) throw Object.assign(new Error(`${cmd}_failed`), { detail: r.stderr }); return r.stdout; };
  const git = args => text('git', args);
  const gh = args => text('gh', args, { env: { ...base.env, GH_TOKEN: environment.GH_TOKEN } });
  if (mode === 'admit') {
    const result = await admit({ env, sha, repo }, { git, gh, fetchImpl: globalThis.fetch });
    console.log(`decision=${result.decision}`); console.log(`reason=${result.reason}`);
    return;
  }
  const childEnv = { PATH: environment.PATH, HOME: environment.HOME, CI: 'true', CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID, GH_TOKEN: environment.GH_TOKEN };
  const wrangler = args => runCommand('npx', ['--no-install', 'wrangler', ...args], { env: childEnv });
  const result = await deploy({ env, sha, secrets: { guard: environment[GUARD_SECRET[env]], cloudflare: environment.CLOUDFLARE_API_TOKEN } },
    { git, wrangler, run: runCommand, fetchImpl: globalThis.fetch, sleep: ms => new Promise(r => setTimeout(r, ms)), now: Date.now, childEnv, outcomeDir: 'ci-outcome' });
  const summary = `### ${env} deploy: ${result.outcome}\n\n- build \`${result.build}\`\n- current version \`${result.currentVersion}\`\n- previous build \`${result.previousBuild}\`\n- previous version \`${result.previousVersion}\`\n- started by \`${environment.GITHUB_TRIGGERING_ACTOR ?? 'unknown'}\`\n`;
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  console.log(`ci-deploy: ${env} ${result.outcome} ${result.build}`);
  console.log(`ci-deploy-provenance: ${JSON.stringify(deploymentProvenance(env, result))}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch(error => {
    const code = /^[a-z_]+$/.test(error.message) ? error.message : 'failed';
    console.error(`ci-deploy: ${code}`);
    if (error.detail) console.error(redactDetail(error.detail, [process.env.CLOUDFLARE_API_TOKEN, process.env.CASE_STAGING_DEPLOY_GUARD_TOKEN, process.env.CASE_PRODUCTION_DEPLOY_GUARD_TOKEN]));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### deploy refused: \`${code}\`\n`);
    process.exitCode = 1;
  });
}
