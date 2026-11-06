#!/usr/bin/env node
// scripts/ci-load.mjs: the staging-load workflow driver (docs/plans/AUTONOMOUS-DEPLOY.md §2.3, CASE-160).
//
//   admit    --rooms 1|5|10 --mode run|reread  no secrets; sequencing, daily budget, staging build
//   baseline --rooms 1 --out DIR              no secrets; an idle staging window before the first size
//   load    --rooms N --out DIR                CASE_LOAD_EMAIL/PASSWORD only; signs in, pipes the access
//                                              token to load-room.mjs stdin, signs out (global)
//   usage   --rooms N --out DIR                CF_USAGE_TOKEN only; reads the settled usage window(s)
//   verdict --rooms N --out DIR                no secrets; METERING abort table, leak scan, verdict.json
//
// Runs only inside .github/workflows/staging-load.yml on main. Staging only: load-room.mjs and
// usage-window.mjs keep their own staging admission (pilot-target.mjs refuses production). Every
// external call is injected, so tests use fakes (hard rule 12).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS } from './check-case.mjs';
import { readVersion } from './predeploy.mjs';
import { LOAD_WORKSPACE, LOAD_VERSION } from './simulated-rooms.mjs';

import { STAGING_ORIGIN as STAGING } from './pilot-target.mjs';
export { STAGING };
export const SIZES = Object.freeze([1, 5, 10]);
export const DAILY_RUNS = 3;
export const STAGGER_SECONDS = 1;
export const BASELINE_MINUTES = 3;
export const SETTLE_MS = 5 * 60_000;
// docs/pilot/METERING.md "Before each staging run": per-run ceilings (client HTTP, SQLite rows written).
export const CEILINGS = Object.freeze({ 1: { http: 10_000, rowsWritten: 200_000 }, 5: { http: 50_000, rowsWritten: 1_000_000 }, 10: { http: 100_000, rowsWritten: 2_000_000 } });
const WORKFLOW_PATH = '.github/workflows/staging-load.yml';
const refuse = code => { throw new Error(code); };

export function parseArgs(argv) {
  const [mode, ...rest] = argv; const o = { cmd: mode };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!['--rooms', '--mode', '--out', '--over-budget'].includes(flag) || value === undefined) refuse('usage');
    o[flag.slice(2)] = flag === '--rooms' ? Number(value) : value;
  }
  if (!['admit', 'baseline', 'load', 'usage', 'verdict'].includes(o.cmd) || !SIZES.includes(o.rooms)) refuse('usage');
  if (o.cmd === 'admit' && !['run', 'reread'].includes(o.mode)) refuse('usage');
  if (o.cmd !== 'admit' && !o.out) refuse('usage');
  // Owner-authorised only (workflow input over_budget): skips the daily run budget, never the sequencing or build checks.
  if ('over-budget' in o && (o.cmd !== 'admit' || !['no', 'owner-authorised'].includes(o['over-budget']))) refuse('usage');
  return o;
}

export const minuteFloor = ms => new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
export const minuteCeil = ms => new Date(Math.ceil(ms / 60_000) * 60_000).toISOString();
export const validWindow = (from, to) => [from, to].every(t => /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/.test(t ?? '') && new Date(t).toISOString() === t) && Date.parse(to) > Date.parse(from) && Date.parse(to) - Date.parse(from) <= 7_200_000;

/** A run counts only if it is a successful main dispatch of this exact workflow file. */
function genuine(run) {
  return run?.path === WORKFLOW_PATH && run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.status === 'completed';
}

/** Latest genuine verdict for `staging-load-<rooms>-<build>`, or null. `download(runId, name)` returns verdict JSON text. */
export async function latestVerdict({ gh, download, repo, rooms, build }) {
  const name = `staging-load-${rooms}-${build}`;
  let artifacts; try { artifacts = JSON.parse(await gh(['api', `repos/${repo}/actions/artifacts?name=${name}&per_page=100`])).artifacts; } catch { refuse('github_unavailable'); }
  if (!Array.isArray(artifacts)) refuse('github_unavailable');
  const candidates = artifacts.filter(a => a?.name === name && !a.expired && a.workflow_run?.head_branch === 'main').sort((a, b) => b.workflow_run.id - a.workflow_run.id);
  for (const artifact of candidates) {
    let run; try { run = JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${artifact.workflow_run.id}`])); } catch { refuse('github_unavailable'); }
    if (!genuine(run)) continue;
    let verdict; try { verdict = JSON.parse(await download(run.id, name)); } catch { continue; }
    if (verdict?.build !== build || verdict.rooms !== rooms) continue;
    return { ...verdict, runId: run.id, runConclusion: run.conclusion };
  }
  return null;
}

/** Admission without secrets. Returns { build, sourceRunId? } or throws a refusal code. */
export async function admit({ rooms, mode, repo, runId, overBudget = false }, { git, gh, download, fetchImpl, nowMs = Date.now(), timeoutMs = 15_000 }) {
  const build = await readVersion(STAGING, 'staging', fetchImpl, timeoutMs).catch(() => refuse('staging_version_unavailable'));
  try { await git(['merge-base', '--is-ancestor', build, 'origin/main']); } catch { refuse('staging_build_not_on_main'); }
  const own = await latestVerdict({ gh, download, repo, rooms, build });
  if (mode === 'reread') {
    if (!own || own.verdict !== 'pending') refuse('reread_needs_pending_run');
    return { build, sourceRunId: own.runId };
  }
  if (own?.verdict === 'pass') refuse('already_measured');
  const previous = SIZES[SIZES.indexOf(rooms) - 1];
  if (previous && (await latestVerdict({ gh, download, repo, rooms: previous, build }))?.verdict !== 'pass') refuse('previous_size_not_passed');
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let runs; try { runs = JSON.parse(await gh(['api', `repos/${repo}/actions/workflows/staging-load.yml/runs?branch=main&event=workflow_dispatch&created=>=${day}&per_page=100`])).workflow_runs; } catch { refuse('github_unavailable'); }
  if (!Array.isArray(runs)) refuse('github_unavailable');
  const today = runs.filter(r => r?.path === WORKFLOW_PATH && r.head_branch === 'main' && String(r.run_started_at ?? r.created_at).slice(0, 10) === day && r.id !== runId && / mode=run\b/.test(r.display_title ?? ''));
  if (today.length >= DAILY_RUNS && overBudget !== true) refuse('daily_budget_spent');
  return { build };
}

/** Thresholds from docs/pilot/METERING.md. Returns { verdict: 'pass'|'fail'|'pending', reasons }. */
export function decide({ rooms, loadOk, loadError, report, usage, usageError, window }) {
  const reasons = []; const ceiling = CEILINGS[rooms];
  if (!loadOk) reasons.push(`load_failed:${/^[a-z0-9_:, ]+$/.test(loadError ?? '') ? loadError : 'unknown'}`);
  if (loadOk) {
    const total = report?.total;
    if (!total || report.rooms?.length !== rooms || total.rooms !== rooms || total.clients !== rooms * 25) reasons.push('report_incomplete');
    else {
      if (total.lost_votes !== 0) reasons.push('lost_votes');
      if (total.duplicate_votes !== 0) reasons.push('duplicate_votes');
      if (total.receipted_votes !== total.expected_votes) reasons.push('votes_unreceipted');
      const http = Object.values(total.http_by_route ?? {}).reduce((n, v) => n + v, 0);
      if (!(http > 0) || http > ceiling.http) reasons.push('http_ceiling');
      const seconds = (Date.parse(report.ended_at) - Date.parse(report.started_at)) / 1000;
      if (!(seconds >= 0) || seconds > 120 + STAGGER_SECONDS * (rooms - 1)) reasons.push('run_too_long');
    }
  }
  if (reasons.length) return { verdict: 'fail', reasons };
  if (!usage) return { verdict: 'pending', reasons: [`usage_unavailable${usageError ? `:${usageError}` : ''}`] };
  const written = usage.total?.sqlite_rows_written;
  if (!Number.isFinite(written)) return { verdict: 'pending', reasons: ['usage_unavailable:incomplete'] };
  if (written > ceiling.rowsWritten) return { verdict: 'fail', reasons: ['rows_written_ceiling'] };
  if (!validWindow(window?.from, window?.to)) return { verdict: 'fail', reasons: ['window_invalid'] };
  return { verdict: 'pass', reasons: [] };
}

/** True when any file under dir contains a credential shape or a listed literal. */
export function leaks(dir, literals = []) {
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (SECRET_PATTERNS.some(([re]) => re.test(text))) return name;
    if (/\b(Bearer|refresh_token|access_token)\b/i.test(text)) return name;
    if (literals.some(l => typeof l === 'string' && l.length >= 6 && text.includes(l))) return name;
  }
  return null;
}

/** An idle window of BASELINE_MINUTES whole minutes, starting at the next minute boundary. */
export async function baseline({ out }, { sleep, now }) {
  mkdirSync(out, { recursive: true });
  const from = Math.ceil(now() / 60_000) * 60_000; const to = from + BASELINE_MINUTES * 60_000;
  await sleep(to - now());
  const w = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), rooms: 1 };
  writeFileSync(join(out, 'baseline-window.json'), `${JSON.stringify(w)}\n`);
  return w;
}

/** Signs in, pipes the token to the load harness, signs out. The token never enters env, argv or a file. */
export async function load({ rooms, out, email, password, supabase }, { fetchImpl, runHarness, now = Date.now }) {
  if (!email || !password) refuse('load_credentials_missing');
  mkdirSync(out, { recursive: true });
  const auth = async (path, init) => fetchImpl(`${supabase.url}/auth/v1/${path}`, { redirect: 'error', ...init, headers: { apikey: supabase.publishableKey, 'content-type': 'application/json', ...init.headers } });
  let token;
  try {
    const signed = await auth('token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (signed.status !== 200) throw new Error();
    token = (await signed.json())?.access_token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
  } catch { refuse('load_signin_failed'); }
  const started = now();
  let result;
  try { result = await runHarness({ rooms, token }); }
  finally { await auth('logout?scope=global', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {}); token = null; }
  const ended = now();
  writeFileSync(join(out, 'window.json'), `${JSON.stringify({ from: minuteFloor(started), to: minuteCeil(ended), rooms })}\n`);
  writeFileSync(join(out, 'load.json'), `${JSON.stringify({ ok: result.code === 0, error: result.code === 0 ? null : result.errorCode })}\n`);
  if (result.code === 0) writeFileSync(join(out, 'report.json'), result.stdout);
  return result.code === 0;
}

export function spawnText(command, args, { env, input }) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr = (stderr + c).slice(-4096); });
    child.on('error', () => resolveResult({ code: 1, stdout, stderr }));
    child.on('close', code => resolveResult({ code: code ?? 1, stdout, stderr }));
    // A child that exits before reading its input (gh, git) makes this write fail with EPIPE; unhandled, that
    // crashed admission (staging-load run 37552825438). The exit code still decides the result.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function main(argv, env) {
  const o = parseArgs(argv); const repo = env.GITHUB_REPOSITORY;
  const base = { PATH: env.PATH, HOME: env.HOME };
  const text = async (cmd, args, extra = {}) => { const r = await spawnText(cmd, args, { env: { ...base, ...extra } }); if (r.code !== 0) throw new Error(`${cmd}_failed`); return r.stdout; };
  if (o.cmd === 'admit') {
    const gh = args => text('gh', args, { GH_TOKEN: env.GH_TOKEN });
    const download = async (runId, name) => {
      const dir = join(env.RUNNER_TEMP ?? '/tmp', `verdict-${runId}`);
      await text('gh', ['run', 'download', String(runId), '-R', repo, '-n', name, '-D', dir], { GH_TOKEN: env.GH_TOKEN });
      return readFileSync(join(dir, 'verdict.json'), 'utf8');
    };
    const r = await admit({ rooms: o.rooms, mode: o.mode, repo, runId: Number(env.GITHUB_RUN_ID), overBudget: o['over-budget'] === 'owner-authorised' }, { git: args => text('git', args), gh, download, fetchImpl: globalThis.fetch });
    console.log(`build=${r.build}`); if (r.sourceRunId) console.log(`source_run=${r.sourceRunId}`);
    return;
  }
  if (o.cmd === 'baseline') {
    const w = await baseline({ out: o.out }, { sleep: ms => new Promise(r => setTimeout(r, ms)), now: Date.now });
    console.log(`ci-load: baseline window ${w.from}..${w.to}`);
    return;
  }
  if (o.cmd === 'load') {
    const toml = readFileSync('wrangler.toml', 'utf8'); const staging = toml.slice(toml.indexOf('[env.staging.vars]'));
    const pick = key => staging.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
    const supabase = { url: pick('SUPABASE_URL'), publishableKey: pick('SUPABASE_PUBLISHABLE_KEY') };
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabase.url ?? '') || !supabase.publishableKey?.startsWith('sb_publishable_')) refuse('staging_supabase_config_invalid');
    const runHarness = async ({ rooms, token }) => {
      const r = await spawnText(process.execPath, ['scripts/load-room.mjs', '--target', `${STAGING}/`, '--i-own-this-origin', '--rooms', String(rooms), '--clients', '25', '--stagger', String(STAGGER_SECONDS)],
        { env: { ...base, CASE_LOAD_WORKSPACE_ID: LOAD_WORKSPACE, CASE_LOAD_CASE_VERSION_ID: LOAD_VERSION }, input: `${token}\n` });
      return { ...r, errorCode: r.stderr.match(/load:room — ([a-z0-9_:, ]+)/)?.[1]?.trim() ?? 'load_failed' };
    };
    const ok = await load({ rooms: o.rooms, out: o.out, email: env.CASE_LOAD_EMAIL, password: env.CASE_LOAD_PASSWORD, supabase }, { fetchImpl: globalThis.fetch, runHarness });
    console.log(`ci-load: load ${ok ? 'completed' : 'failed'}`);
    return;
  }
  if (o.cmd === 'usage') {
    const windows = [['usage.json', JSON.parse(readFileSync(join(o.out, 'window.json'), 'utf8'))]];
    if (existsSync(join(o.out, 'baseline-window.json'))) windows.push(['baseline-usage.json', JSON.parse(readFileSync(join(o.out, 'baseline-window.json'), 'utf8'))]);
    const wait = Date.parse(windows[0][1].to) + SETTLE_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    for (const [file, w] of windows) {
      const r = await spawnText(process.execPath, ['scripts/usage-window.mjs', '--target', `${STAGING}/`, '--i-own-this-origin', '--account', env.CLOUDFLARE_ACCOUNT_ID ?? '', '--from', w.from, '--to', w.to, '--rooms', String(o.rooms)],
        { env: base, input: env.CF_USAGE_TOKEN ?? '' });
      writeFileSync(join(o.out, file), r.code === 0 ? r.stdout : `${JSON.stringify({ unavailable: true })}\n`);
      if (r.code !== 0) for (const line of r.stderr.split('\n')) if (/^usage-window: (?:units unverified for [A-Za-z]+: "[\x20-\x7e\u00b5\u03bc]{0,200}"|refusal [a-z_]+(?: \((?:meter: [A-Za-z]+|reason: [a-z_]+)\))?)$/.test(line)) console.error(line);
    }
    console.log('ci-load: usage read');
    return;
  }
  const read = name => existsSync(join(o.out, name)) ? JSON.parse(readFileSync(join(o.out, name), 'utf8')) : null;
  const loadState = read('load.json'); const usage = read('usage.json'); const window = read('window.json');
  const result = decide({ rooms: o.rooms, loadOk: loadState?.ok === true, loadError: loadState?.error, report: read('report.json'), usage: usage?.unavailable ? null : usage, window });
  const leaked = leaks(o.out, [env.CASE_LOAD_EMAIL]);
  if (leaked) { console.error(`ci-load: leak scan refused ${leaked}; nothing uploaded`); for (const f of readdirSync(o.out)) writeFileSync(join(o.out, f), ''); process.exitCode = 1; return; }
  writeFileSync(join(o.out, 'verdict.json'), `${JSON.stringify({ build: env.BUILD, rooms: o.rooms, verdict: result.verdict, reasons: result.reasons, window, usage: usage?.unavailable || !usage ? 'pending' : 'present' })}\n`);
  console.log(`ci-load: ${o.rooms} room(s) ${result.verdict}${result.reasons.length ? ` (${result.reasons.join(', ')})` : ''}`);
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `### staging-load ${o.rooms}x25: ${result.verdict}\n\n${result.reasons.map(r => `- ${r}`).join('\n')}\n`, { flag: 'a' });
  if (result.verdict === 'fail') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch(error => {
    console.error(`ci-load: ${/^[a-z_]+$/.test(error.message) ? error.message : 'failed'}`);
    process.exitCode = 1;
  });
}
