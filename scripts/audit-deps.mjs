import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const day = 24 * 60 * 60 * 1000;
const dateValue = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
};

function resolvePackage(packages, parent, name) {
  let scope = parent;
  for (;;) {
    const candidate = `${scope ? `${scope}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const cut = scope.lastIndexOf('/node_modules/');
    if (cut < 0) {
      if (scope) { scope = ''; continue; }
      return null;
    }
    scope = scope.slice(0, cut);
  }
}

function dependencyPaths(packageLock, manifest, violations) {
  const packages = packageLock?.packages;
  if (!packages || typeof packages !== 'object') {
    violations.push('package-lock.json has no packages graph');
    return new Map();
  }
  const found = new Map();
  const visit = (name, parent, names, runtime, ancestors, optional = false) => {
    const node = resolvePackage(packages, parent, name);
    if (!node) {
      if (!optional) violations.push(`unresolved dependency: ${[...names, name].join(' > ')}`);
      return;
    }
    const route = [...names, name];
    const paths = found.get(node) || [];
    if (!paths.some((item) => item.path === route.join(' > ') && item.runtime === runtime)) {
      paths.push({ path: route.join(' > '), runtime });
      found.set(node, paths);
    }
    if (ancestors.has(node)) return;
    const next = new Set([...ancestors, node]);
    const details = packages[node];
    for (const child of Object.keys(details.dependencies || {})) visit(child, node, route, runtime, next);
    for (const child of Object.keys(details.optionalDependencies || {})) visit(child, node, route, runtime, next, true);
    for (const child of Object.keys(details.peerDependencies || {})) {
      if (resolvePackage(packages, node, child)) visit(child, node, route, runtime, next);
    }
  };
  for (const name of Object.keys(manifest?.dependencies || {})) visit(name, '', [], true, new Set());
  for (const name of Object.keys(manifest?.optionalDependencies || {})) visit(name, '', [], true, new Set(), true);
  for (const name of Object.keys(manifest?.peerDependencies || {})) {
    visit(name, '', [], true, new Set(), manifest?.peerDependenciesMeta?.[name]?.optional === true);
  }
  for (const name of Object.keys(manifest?.devDependencies || {})) visit(name, '', [], false, new Set());
  return found;
}

export function evaluateAudit({ audit, packageLock, manifest, allowlist, today }) {
  const violations = [];
  const allowed = [];
  const now = dateValue(today);
  if (!Number.isFinite(now)) violations.push('invalid UTC audit date');
  if (!Array.isArray(allowlist)) violations.push('allowlist must be an array');
  if (audit?.error || !audit?.vulnerabilities || typeof audit.vulnerabilities !== 'object') {
    violations.push(`npm audit did not return vulnerabilities: ${audit?.error?.message || 'invalid report'}`);
  }
  const entries = new Map();
  for (const entry of Array.isArray(allowlist) ? allowlist : []) {
    const fields = ['advisory', 'package', 'path', 'reason', 'added', 'review_by'];
    if (!entry || Object.keys(entry).sort().join(',') !== fields.sort().join(',') || fields.some((field) => typeof entry[field] !== 'string' || !entry[field].trim())) {
      violations.push('allowlist entry must have exactly six nonempty string fields');
      continue;
    }
    const added = dateValue(entry.added);
    const review = dateValue(entry.review_by);
    if (!Number.isFinite(added) || !Number.isFinite(review) || added > now || review < now || review < added || review - added > 30 * day) {
      violations.push(`invalid or expired review window: ${entry.advisory} ${entry.path}`);
    }
    const key = `${entry.advisory}\0${entry.package}\0${entry.path}`;
    if (entries.has(key)) violations.push(`duplicate allowlist entry: ${entry.advisory} ${entry.path}`);
    entries.set(key, entry);
  }
  const paths = dependencyPaths(packageLock, manifest, violations);
  for (const [name, vulnerability] of Object.entries(audit?.vulnerabilities || {})) {
    if (['high', 'critical'].includes(vulnerability.severity)) {
      for (const inherited of (vulnerability.via || []).filter((via) => typeof via === 'string')) {
        if (!audit.vulnerabilities[inherited]) violations.push(`high/critical ${name} has unresolved advisory source ${inherited}`);
      }
    }
    const direct = (vulnerability.via || []).filter((via) => typeof via === 'object' && ['high', 'critical'].includes(via.severity));
    if (!direct.length && ['high', 'critical'].includes(vulnerability.severity) && !(vulnerability.via || []).some((via) => typeof via === 'string')) {
      violations.push(`high/critical ${name} lacks advisory details`);
    }
    for (const advisory of direct) {
      const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(advisory.url || '')?.[1];
      if (!id) { violations.push(`high/critical ${name} has no GHSA id`); continue; }
      if (!vulnerability.nodes?.length) violations.push(`${id} ${name} has no vulnerable lockfile nodes`);
      for (const node of vulnerability.nodes || []) {
        const routes = paths.get(node);
        if (!routes?.length) { violations.push(`${id} ${name} has no resolved dependency path at ${node}`); continue; }
        for (const route of routes) {
          if (route.runtime) violations.push(`${id} ${name} reaches runtime via ${route.path}`);
          else if (!entries.has(`${id}\0${name}\0${route.path}`)) violations.push(`unlisted ${id} ${name} at ${route.path}`);
          else allowed.push(`${id} ${name} at ${route.path}`);
        }
      }
    }
  }
  return { ok: violations.length === 0, violations, allowed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // npm's offline audit can return an empty success without consulting advisories.
  // Offline qualification is unknown, never evidence of a clean dependency graph.
  if (['NPM_CONFIG_OFFLINE', 'npm_config_offline'].some(key => /^(true|1)$/i.test(process.env[key] ?? ''))) {
    console.error('audit: offline mode cannot provide current advisory evidence');
    process.exit(1);
  }
  const run = spawnSync('npm', ['audit', '--json', '--offline=false', '--audit=true', '--prefer-offline=false', '--prefer-online', '--fetch-retries=0'], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  let audit;
  try { audit = JSON.parse(run.stdout); } catch { audit = { error: { message: run.stderr || 'invalid npm audit JSON' } }; }
  if (run.error) audit = { error: { message: run.error.message } };
  if (run.status !== 0 && run.status !== 1) audit = { error: { message: run.stderr || `npm audit exited ${run.status}` } };
  const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  const result = evaluateAudit({ audit, packageLock: read('package-lock.json'), manifest: read('package.json'), allowlist: read('audit-allowlist.json'), today: new Date().toISOString().slice(0, 10) });
  for (const item of result.allowed) console.log(`allowed: ${item}`);
  for (const item of result.violations) console.error(`audit: ${item}`);
  if (result.ok) console.log('Dependency audit passed');
  else process.exitCode = 1;
}
