// Balanced browser-harness sharding. Playwright's own --shard cuts the test list into contiguous
// equal-COUNT slices, which cannot balance an uneven suite (one slice got 28 slow geometry tests and
// ran past the job timeout). This assigns every discovered test to exactly one of N shards by
// longest-processing-time-first over measured seconds (scripts/e2e-shard-weights.mjs), then runs Playwright
// restricted to that shard's tests. The assignment is a pure function of the discovered list, so
// shards are disjoint and complete whatever the weights say; stale weights cost balance, never coverage.
//
// Timing gates (tests tagged @perf: the key-to-paint p95 gates) measure the machine, so they run apart
// in their own shard, `--perf`, which verify.yml always keeps on a hosted runner (CASE-266). `--shard=N/M`
// partitions every other test; together the M shards and the perf shard run each test exactly once.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
import WEIGHTS from './e2e-shard-weights.mjs';
export { WEIGHTS };
const pw = (args, opts = {}) => spawnSync(process.execPath, [join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--config', join(ROOT, 'playwright.config.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
export const keyOf = (file, title) => `${basename(file)} ${title}`;

export function discover() {
  const r = pw(['--list', '--reporter=json', '--workers=1'], { env: { ...process.env, CI: 'true' } });
  if (r.status !== 0) throw new Error(`discovery failed: ${r.stderr || r.stdout}`);
  const rows = [];
  // Playwright greps "<project> <file> <describe...> <title>", so a describe's title is part of the key.
  (function walk(suites, path, top) { for (const s of suites) { const p = top ? [] : [...path, s.title]; for (const sp of s.specs ?? []) for (const t of sp.tests) rows.push({ id: t.testId ?? sp.id, key: keyOf(sp.file, [...p, sp.title].filter(Boolean).join(' ')), perf: (sp.tags ?? []).some(tag => tag.replace(/^@/, '') === 'perf') }); walk(s.suites ?? [], p, false); } })(JSON.parse(r.stdout).suites, [], true);
  return rows;
}

// Returns shards[0..total-1] = arrays of rows. Deterministic: heaviest first, ties by key.
export function assign(rows, total, weights = WEIGHTS) {
  const w = row => weights.weights[row.key] ?? weights.defaultSeconds;
  const shards = Array.from({ length: total }, (_, i) => ({ rows: [], load: i === 0 ? weights.shard1ExtraSeconds : 0 }));
  // This serial spec finishes by checking the ledger its earlier tests populated in the same process.
  // Keep only this dependent suite atomic; independent specs still balance by individual test.
  const units = new Map();
  for (const row of rows) {
    const key = row.key.startsWith('builder-reach.spec.mjs ') ? 'builder-reach.spec.mjs' : row.key;
    if (!units.has(key)) units.set(key, { key, rows: [], load: 0 });
    const unit = units.get(key); unit.rows.push(row); unit.load += w(row);
  }
  for (const unit of [...units.values()].sort((a, b) => b.load - a.load || (a.key < b.key ? -1 : 1))) {
    const lightest = shards.reduce((m, s) => (s.load < m.load ? s : m));
    lightest.rows.push(...unit.rows.sort((a, b) => a.key < b.key ? -1 : 1)); lightest.load += unit.load;
  }
  return shards;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Playwright matches --grep against "<project> <file> <titles>" with the test's tags appended (" @perf").
export const grepFor = rows => `^chromium (?:${rows.map(r => esc(r.key)).join('|')})(?: @[\\w-]+)*$`;

/** The rows one invocation runs: the @perf tests for `perf`, else shard n of m over every other test. */
export function select(rows, { perf = false, n, m } = {}) {
  if (perf) return { rows: rows.filter(row => row.perf), load: 0 };
  return assign(rows.filter(row => !row.perf), m)[n - 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const p = args.indexOf('--perf');
  const i = args.findIndex(a => /^--shard=\d+\/\d+$/.test(a));
  if ((p < 0) === (i < 0)) { console.error('usage: e2e-shard.mjs --shard=N/M | --perf [playwright args]'); process.exit(2); }
  let mine, label;
  if (p >= 0) { args.splice(p, 1); mine = select(discover(), { perf: true }); label = 'perf shard'; }
  else { const [n, m] = args.splice(i, 1)[0].slice(8).split('/').map(Number); mine = select(discover(), { n, m }); label = `shard ${n}/${m}`; }
  // A selection that matched nothing would make Playwright run every test; refuse instead.
  if (!mine.rows.length) { console.error(`${label}: no tests selected`); process.exit(1); }
  console.error(`${label}: ${mine.rows.length} tests, ~${Math.round(mine.load)}s estimated`);
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--config', join(ROOT, 'playwright.config.mjs'), '--grep', grepFor(mine.rows), ...args], { cwd: ROOT, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
