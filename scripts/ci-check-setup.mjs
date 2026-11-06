#!/usr/bin/env node
// scripts/ci-check-setup.mjs: read-only check of the GitHub-side setup for the CI deploy workflows
// (AUTONOMOUS-DEPLOY §7). It reads secret and variable NAMES only (never values) and the repository
// Actions defaults, then prints which setup steps are still missing. Safe for agents to run.
//
//   node scripts/ci-check-setup.mjs --phase B|C|D [--repo owner/name]
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_WORKFLOWS } from './ci-workflow-policy.mjs';

export const REPO = 'julianjming-hash/case';
// Each phase includes the earlier ones; the value is the plan §7 step that provides the name.
const STEPS = [
  ['B', 'secret', 'CLOUDFLARE_API_TOKEN', 'B1'],
  ['B', 'variable', 'CLOUDFLARE_ACCOUNT_ID', 'B2'],
  ['B', 'secret', 'CASE_STAGING_DEPLOY_GUARD_TOKEN', 'B3'],
  ['C', 'secret', 'CASE_PRODUCTION_DEPLOY_GUARD_TOKEN', 'C1'],
  ['D', 'secret', 'CASE_LOAD_EMAIL', 'D2'],
  ['D', 'secret', 'CASE_LOAD_PASSWORD', 'D2'],
  ['D', 'secret', 'CF_USAGE_TOKEN', 'D4'],
];
const KNOWN_SECRETS = new Set(Object.values(SECRET_WORKFLOWS).flat());

export function parseArgs(argv) {
  const o = { phase: null, repo: REPO };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phase') o.phase = argv[++i];
    else if (argv[i] === '--repo') o.repo = argv[++i];
    else throw new Error('setup_usage');
  }
  if (!['B', 'C', 'D'].includes(o.phase) || !/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? '')) throw new Error('setup_usage');
  return o;
}

const names = raw => { const list = JSON.parse(raw); if (!Array.isArray(list)) throw new Error('setup_unreadable'); return new Set(list.map(x => x?.name)); };

/** Returns { ok, lines }. `gh(args)` resolves to stdout; it is injected by tests. */
export async function checkSetup({ phase, repo }, { gh }) {
  const lines = []; let ok = true;
  let secrets, variables, actions;
  try {
    secrets = names(await gh(['secret', 'list', '-R', repo, '--json', 'name']));
    variables = names(await gh(['variable', 'list', '-R', repo, '--json', 'name']));
    actions = JSON.parse(await gh(['api', `repos/${repo}/actions/permissions/workflow`]));
  } catch { return { ok: false, lines: ['cannot read repository settings with gh (signed in, with access to the repo?)'] }; }
  const order = ['B', 'C', 'D'];
  for (const [p, kind, name, step] of STEPS) {
    if (order.indexOf(p) > order.indexOf(phase)) continue;
    const present = (kind === 'secret' ? secrets : variables).has(name);
    if (!present) ok = false;
    lines.push(`${present ? 'ok     ' : 'MISSING'} ${kind} ${name} (step ${step})`);
  }
  for (const name of [...secrets].sort()) if (!KNOWN_SECRETS.has(name)) { ok = false; lines.push(`UNEXPECTED secret ${name}: only the plan §3 names may exist (repository secrets reach every branch workflow)`); }
  const safe = actions?.default_workflow_permissions === 'read' && actions?.can_approve_pull_request_reviews === false;
  if (!safe) ok = false;
  lines.push(`${safe ? 'ok     ' : 'CHANGED'} Actions defaults: read-only token, cannot approve PRs`);
  return { ok, lines };
}

function ghCommand(args) {
  return new Promise((resolveOut, reject) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let out = ''; child.stdout.on('data', c => { out += c; if (out.length > 1_000_000) child.kill(); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolveOut(out) : reject(new Error('gh_failed')));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const { ok, lines } = await checkSetup(parseArgs(process.argv.slice(2)), { gh: ghCommand });
    for (const line of lines) console.log(line);
    console.log(ok ? 'setup: complete for this phase' : 'setup: incomplete');
    process.exitCode = ok ? 0 : 1;
  }).catch(() => { console.error('usage: node scripts/ci-check-setup.mjs --phase B|C|D [--repo owner/name]'); process.exitCode = 2; });
}
