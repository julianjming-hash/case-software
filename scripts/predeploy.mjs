#!/usr/bin/env node
// Owner-run only. Tests inject every command and fetch; agents never invoke a deployed target.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveRooms, fetchBoundedJson } from './deploy-guard.mjs';
import { SECRET_PATTERNS } from './check-case.mjs';

export const DEPLOY_ORIGINS = Object.freeze({ production: 'https://case.iatrogenic.app', staging: 'https://case-staging.iatrogenic.app' });
import { WIRE_VERSION } from '../src/shared/wire.mjs';
import { adminEmails } from '../src/worker/admin/gate.mjs';

const validSha = value => typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
const stop = (reason) => { throw new Error(reason); };

export function parseDeployOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') options.env = argv[++i];
    else if (argv[i] === '--prod') options.prod = true;
    else if (argv[i] === '--first-deploy') options.firstDeploy = true;
    else if (argv[i] === '--allow-live') options.allowLive = true;
    else stop('unknown_option');
  }
  if (!Object.hasOwn(DEPLOY_ORIGINS, options.env ?? '')) stop('unknown_environment');
  if (options.env === 'production' && !options.prod) stop('production_requires_prod');
  return options;
}

/** The ADMIN_EMAILS value of one environment's [env.<env>.vars] table in wrangler.toml, or null if unset. */
export function adminEmailsFrom(toml, env) {
  const lines = String(toml ?? '').split('\n');
  const start = lines.findIndex(line => line.trim() === `[env.${env}.vars]`);
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length && !lines[i].trim().startsWith('['); i++) {
    const match = /^ADMIN_EMAILS\s*=\s*"([^"]*)"\s*$/.exec(lines[i].trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * Card 35, E01: a malformed or upper-case entry makes the Worker reject the whole list (fail closed), which
 * would silently lock every admin out. Unset is valid (no admins); set must parse exactly as the gate does.
 */
export function checkAdminEmails(value) {
  if (value === null) return [];
  const parsed = adminEmails({ ADMIN_EMAILS: value });
  if (!parsed) stop('invalid_admin_emails');
  return [...parsed].sort();
}

/** What changes in the admin list between the deployed build and this one, for the owner's approval. */
export function adminEmailsDiff(before, after) {
  return { added: after.filter(email => !before.includes(email)), removed: before.filter(email => !after.includes(email)) };
}

/** npm lifecycle hooks inspect the scripts; the guarded deploy entrypoint performs all live checks. */
export function validateNpmEntrypoints(scripts) {
  if (scripts?.deploy !== 'node scripts/predeploy.mjs --env production --prod' ||
      scripts?.['deploy:staging'] !== 'node scripts/predeploy.mjs --env staging') stop('unguarded_npm_entrypoint');
  return true;
}

const STDERR_TAIL = 2048;
const BROWSER_CHECK = /^browser-harness(?: \(\d+\))?$/;

/** Bounded, redacted text for a failure report: known secret values, credential shapes, bearer values. */
export function redactDetail(text, secrets = []) {
  let out = String(text ?? '');
  for (const value of secrets) if (typeof value === 'string' && value.length >= 8) out = out.split(value).join('[redacted]');
  for (const [re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), '[redacted]');
  out = out.replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]').replace(/\b(?=[A-Za-z0-9_-]*[g-zG-Z_-])[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  return out.length > STDERR_TAIL ? out.slice(-STDERR_TAIL) : out;
}

/** Spawned commands get an explicit environment; the guard token is a function argument, never inherited. */
export function childEnvironment(env = process.env) {
  const copy = { ...env }; delete copy.DEPLOY_GUARD_TOKEN; return copy;
}

export async function runCommand(command, args, { env } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env });
    const chunks = []; let bytes = 0; let settled = false; let stderr = '';
    const finish = (code) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult({ code, stdout: chunks.join(''), stderr }); } };
    const timer = setTimeout(() => { child.kill(); finish(1); }, command === 'npx' ? 300_000 : 30_000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4 * STDERR_TAIL); });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { child.kill(); finish(1); } else chunks.push(chunk.toString()); });
    child.on('error', () => finish(1)); child.on('close', code => finish(code ?? 1));
  });
}

export async function readVersion(origin, expectedEnv, fetchImpl, timeoutMs) {
  try {
    const { body, headers } = await fetchBoundedJson(`${origin}/api/v1/version`, { fetchImpl, timeoutMs });
    if (Object.keys(body ?? {}).sort().join(',') !== 'build,env,wire' || !validSha(body.build) || body.env !== expectedEnv || body.wire !== WIRE_VERSION || headers.get('x-case-build') !== body.build) stop('version_unavailable');
    return body.build;
  } catch { stop('version_unavailable'); }
}

/** Returns public provenance only. `run`, `fetchImpl` and throwaway `token` are injected by tests. */
export async function predeploy(options, { run = runCommand, fetchImpl = globalThis.fetch, timeoutMs = 15_000, token = process.env.DEPLOY_GUARD_TOKEN, env = process.env, secrets = [], log = console.log } = {}) {
  if (!Object.hasOwn(DEPLOY_ORIGINS, options?.env ?? '')) stop('unknown_environment');
  if (options.env === 'production' && !options.prod) stop('production_requires_prod');
  const origin = DEPLOY_ORIGINS[options.env];
  const spawnEnv = childEnvironment(env);
  const redactWith = [token, env?.CLOUDFLARE_API_TOKEN, env?.DEPLOY_GUARD_TOKEN, ...secrets];
  const command = async (cmd, args, failure) => {
    let result; try { result = await run(cmd, args, { env: spawnEnv }); } catch { stop(failure); }
    if (result.code !== 0) {
      const error = new Error(failure);
      if (result.stderr) error.detail = redactDetail(result.stderr, redactWith);
      throw error;
    }
    return result.stdout.trim();
  };
  if (await command('git', ['status', '--porcelain'], 'git_unavailable')) stop('dirty_tree');
  await command('git', ['fetch', '--prune', 'origin'], 'git_fetch_failed');
  const build = await command('git', ['rev-parse', 'HEAD'], 'git_unavailable'); if (!validSha(build)) stop('invalid_build');
  const admins = checkAdminEmails(adminEmailsFrom(await command('git', ['show', `${build}:wrangler.toml`], 'git_unavailable'), options.env));
  if (options.env === 'production') {
    if (build !== await command('git', ['rev-parse', 'origin/main'], 'git_unavailable')) stop('head_not_main');
  } else {
    const pushed = await command('git', ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin'], 'git_unavailable');
    if (!pushed.split('\n').includes(build)) stop('head_not_pushed');
  }
  const raw = await command('gh', ['api', '--paginate', '--slurp', `repos/:owner/:repo/commits/${build}/check-runs?per_page=100`], 'ci_unavailable');
  let checks; try { checks = JSON.parse(raw).flatMap(page => page.check_runs); } catch { stop('ci_unavailable'); }
  // Latest run per exact check name. verify.yml runs browser-harness as a matrix, so its check runs are
  // `browser-harness (1)`..`(n)`; every shard that ran must be green or skipped.
  const latest = new Map();
  for (const check of checks) if (check?.app?.slug === 'github-actions' && (check.name === 'verify' || BROWSER_CHECK.test(check.name ?? ''))) {
    if (!latest.has(check.name) || check.id > latest.get(check.name).id) latest.set(check.name, check);
  }
  const green = check => check?.status === 'completed' && check.conclusion === 'success';
  if (!green(latest.get('verify'))) stop('ci_not_green');
  for (const [name, browser] of latest) if (name !== 'verify' && !green(browser) && !(browser.status === 'completed' && browser.conclusion === 'skipped')) stop('ci_not_green');
  // Julian approved this explicit assertion: the target has never served rooms. It is not an outage fallback.
  let adminChange = { added: admins, removed: [] };
  if (!options.firstDeploy) {
    const deployed = await readVersion(origin, options.env, fetchImpl, timeoutMs);
    await command('git', ['merge-base', '--is-ancestor', deployed, build], 'deployed_build_not_ancestor');
    // The deployed build's list is shown, not judged: an older invalid list must not block its own fix.
    const before = adminEmails({ ADMIN_EMAILS: adminEmailsFrom(await command('git', ['show', `${deployed}:wrangler.toml`], 'git_unavailable'), options.env) ?? '' });
    adminChange = adminEmailsDiff(before ? [...before].sort() : [], admins);
    const rooms = await liveRooms({ api: origin, prod: options.prod, token, fetchImpl, timeoutMs });
    if (!rooms.ok) stop('live_rooms_unavailable');
    if (rooms.live !== 0 && !options.allowLive) stop('live_rooms');
  }
  // Shown before the deploy runs, so a production approval sees any admin-list change (card 35).
  log(adminChange.added.length || adminChange.removed.length
    ? `predeploy: ADMIN_EMAILS for ${options.env} changes: added [${adminChange.added.join(', ')}], removed [${adminChange.removed.join(', ')}]`
    : `predeploy: ADMIN_EMAILS for ${options.env} unchanged`);
  if (await command('git', ['status', '--porcelain'], 'git_unavailable')) stop('dirty_tree');
  if (await command('git', ['rev-parse', 'HEAD'], 'git_unavailable') !== build) stop('head_changed');
  await command('npx', ['--no-install', 'wrangler', 'deploy', '--env', options.env, '--var', `BUILD_SHA:${build}`], 'deploy_failed');
  const deployed = await readVersion(origin, options.env, fetchImpl, timeoutMs);
  if (deployed !== build) stop('deployed_build_mismatch');
  return { build, env: options.env, adminEmails: adminChange };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === '--help') {
      console.log('Usage: predeploy --env staging|production [--prod] [--allow-live] [--first-deploy]\n--first-deploy asserts that the owner confirms this target has NEVER served rooms. It skips only pre-existing version/live-room checks; clean tree, pushed HEAD, green CI and post-deploy verification remain mandatory.'); return;
    }
    if (argv.length === 1 && argv[0] === '--npm-hook') {
      validateNpmEntrypoints(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts);
      console.log('predeploy: npm entrypoints are guarded'); return;
    }
    const result = await predeploy(parseDeployOptions(argv));
    console.log(`predeploy: verified ${result.env} build ${result.build}`);

  }).catch(error => {
    console.error(`predeploy: ${error.message}`);
    if (error.detail) console.error(`predeploy detail (redacted, last ${STDERR_TAIL} bytes):\n${error.detail}`);
    process.exitCode = 1;
  });
}
