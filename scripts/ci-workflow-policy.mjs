// scripts/ci-workflow-policy.mjs: line-based policy for .github/workflows/*.yml (AUTONOMOUS-DEPLOY §8).
//
// On GitHub Free every Actions secret is a repository secret that any branch workflow can read
// (plan §1.1, R46), so this cannot stop a deliberate leak. It stops the accidental ones: a secret in
// a new workflow, a job-wide secret env, an unpinned action, an input interpolated into a shell, a
// secret-holding job that installs with scripts or runs off main. Zero dependencies; no YAML parser,
// because the rules only need indentation and keys. Run by tests/workflow-policy.test.mjs.

/** Workflows allowed to read secrets, and the only secret names each may read (plan §3). */
export const SECRET_WORKFLOWS = Object.freeze({
  'deploy-staging.yml': ['CLOUDFLARE_API_TOKEN', 'CASE_STAGING_DEPLOY_GUARD_TOKEN'],
  'deploy-production.yml': ['CLOUDFLARE_API_TOKEN', 'CASE_PRODUCTION_DEPLOY_GUARD_TOKEN'],
  'staging-load.yml': ['CASE_LOAD_EMAIL', 'CASE_LOAD_PASSWORD', 'CF_USAGE_TOKEN'],
});
export const CONCURRENCY = Object.freeze({
  'deploy-staging.yml': 'case-staging', 'staging-load.yml': 'case-staging', 'deploy-production.yml': 'case-production',
});

const indentOf = line => line.length - line.trimStart().length;
const meaningful = line => line.trim() !== '' && !line.trimStart().startsWith('#');

/** Parse lines into {n, indent, text, parent} with an indentation tree; list items count as their own level. */
function tree(text) {
  const nodes = []; const stack = [];
  text.split('\n').forEach((raw, i) => {
    if (!meaningful(raw)) return;
    const indent = indentOf(raw);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const node = { n: i + 1, indent, text: raw.trim(), parent: stack.at(-1) ?? null };
    nodes.push(node); stack.push(node);
    // `- name: x` opens a list item whose keys sit two columns deeper.
    if (node.text.startsWith('- ')) stack.push({ n: node.n, indent: indent + 1, text: node.text.slice(2), parent: node, item: true });
  });
  return nodes;
}
const ancestors = node => { const out = []; for (let p = node.parent; p; p = p.parent) out.push(p); return out; };
const key = node => (node.text.startsWith('- ') ? node.text.slice(2) : node.text).split(':')[0].trim();

/** Top-level jobs as { name, nodes, text }. */
function jobs(nodes) {
  const root = nodes.find(n => n.indent === 0 && key(n) === 'jobs'); if (!root) return [];
  const heads = nodes.filter(n => n.parent === root);
  return heads.map(head => {
    const body = nodes.filter(n => n === head || ancestors(n).includes(head));
    return { name: key(head), head, nodes: body, text: body.map(n => n.text).join('\n') };
  });
}

/** Lines that belong to a `run:` script (inline or block scalar). */
function runLines(text) {
  const lines = text.split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/); if (!m) continue;
    if (!/^[|>]/.test(m[2])) { out.push({ n: i + 1, text: m[2] }); continue; }
    const base = m[1].length + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > base); j++) out.push({ n: j + 1, text: lines[j] });
  }
  return out;
}

/** Returns a list of `{ line, rule, message }`; empty means compliant. */
export function checkWorkflow(file, text) {
  const v = []; const add = (line, rule, message) => v.push({ line, rule, message: `${file}:${line} ${rule}: ${message}` });
  const nodes = tree(text);
  const top = nodes.filter(n => n.indent === 0);
  if (!top.some(n => n.text === 'permissions: {}')) add(1, 'top-permissions', 'top-level `permissions: {}` is required');

  for (const n of nodes) {
    const uses = n.text.match(/^(?:- )?uses:\s*(\S+)/);
    if (uses && !uses[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(uses[1])) add(n.n, 'pinned-actions', `${uses[1]} must be pinned to a full commit SHA`);
  }
  if (/\bpull_request_target\b/.test(text)) add(1, 'no-pull-request-target', 'pull_request_target is never allowed');
  for (const n of nodes) if (key(n) === 'secrets') add(n.n, 'no-secrets-key', '`secrets:` (including inherit) is never granted to a job or reusable workflow');
  if (/--allow-live|--first-deploy/.test(text)) add(1, 'no-guard-overrides', '--allow-live and --first-deploy are owner shell flags, never CI');
  if (/deploy-production/.test(text) && file !== 'deploy-production.yml' && /gh\s+(workflow|api)/.test(text)) add(1, 'no-production-dispatch', 'no workflow may dispatch deploy-production');
  for (const r of runLines(text)) if (/\$\{\{\s*(inputs\.|github\.event\.)/.test(r.text)) add(r.n, 'no-input-interpolation', 'pass inputs and event fields through env:, never ${{ }} inside run:');

  const secretLines = nodes.filter(n => /\bsecrets\./.test(n.text));
  const allowed = SECRET_WORKFLOWS[file];
  for (const n of secretLines) {
    if (!allowed) { add(n.n, 'secret-workflows', `secrets are allowed only in ${Object.keys(SECRET_WORKFLOWS).join(', ')}`); continue; }
    for (const [, name] of n.text.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)) if (!allowed.includes(name)) add(n.n, 'secret-names', `${file} may not read secrets.${name}`);
    const envNode = ancestors(n).find(a => key(a) === 'env');
    const inStep = envNode && ancestors(envNode).some(a => a.item && ancestors(a).some(s => key(s) === 'steps'));
    if (!inStep) add(n.n, 'step-level-secrets', 'secrets may appear only in a step-level env:');
  }
  if (!secretLines.length) return v;

  // Workflows that hold secrets: dispatch only, fixed concurrency group, guarded jobs.
  const on = top.find(n => key(n) === 'on');
  const triggers = on ? nodes.filter(n => n.parent === on).map(key) : [];
  if (on && /^on:\s*\S/.test(on.text)) triggers.push(on.text.replace(/^on:\s*/, '').replace(/[[\]]/g, ''));
  if (triggers.join(',') !== 'workflow_dispatch') add(on?.n ?? 1, 'dispatch-only', `secret-holding workflows trigger on workflow_dispatch only (found ${triggers.join(', ') || 'none'})`);
  const group = text.match(/^concurrency:\s*\n\s+group:\s*(\S+)\s*\n\s+cancel-in-progress:\s*false\s*$/m);
  if (group?.[1] !== CONCURRENCY[file]) add(1, 'concurrency', `workflow-level concurrency group ${CONCURRENCY[file]} with cancel-in-progress: false is required`);
  if (file === 'deploy-staging.yml' && /--prod\b|--env production|CASE_PRODUCTION|deploy-production/.test(text)) add(1, 'staging-not-production', 'the staging workflow may not name production');
  const defaultsBash = /^defaults:\s*\n\s+run:\s*\n\s+shell:\s*bash\s*$/m.test(text);

  for (const job of jobs(nodes)) {
    const holds = /\bsecrets\./.test(job.text);
    if (/persist-credentials:\s*true/.test(job.text) && (!/contents:\s*read/.test(job.text) || /contents:\s*write/.test(job.text))) add(job.head.n, 'persist-credentials', `${job.name}: persist-credentials: true only with a read-only contents token`);
    if (!holds) continue;
    const at = job.head.n;
    if (!/runs-on:\s*ubuntu-24\.04\s*$/m.test(job.text)) add(at, 'hosted-runner', `${job.name}: secret-holding jobs run on GitHub-hosted ubuntu-24.04`);
    if (!/github\.ref\s*==\s*'refs\/heads\/main'/.test(job.text)) add(at, 'main-only', `${job.name}: needs if: github.ref == 'refs/heads/main'`);
    if (!defaultsBash && !/shell:\s*bash/.test(job.text)) add(at, 'bash-shell', `${job.name}: set shell: bash (pipefail)`);
    if (/cache:\s*['"]?npm/.test(job.text)) add(at, 'no-npm-cache', `${job.name}: no npm cache in a secret-holding job`);
    for (const m of job.text.matchAll(/npm ci\b[^\n]*/g)) if (!/--ignore-scripts/.test(m[0])) add(at, 'ignore-scripts', `${job.name}: npm ci --ignore-scripts in a secret-holding job`);
  }
  return v;
}
