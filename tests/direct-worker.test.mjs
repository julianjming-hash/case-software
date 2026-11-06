// The load gates' direct workerd (AS-093, AS-097): wrangler.toml's bindings reach it, a binding kind it does not
// pass fails loudly instead of vanishing, and the Worker itself answers with the harness's account fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configBindings, startDirectWorker } from './helpers/direct-worker.mjs';
import { createRoom, serverMirror } from './helpers/local-worker.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('direct worker takes its bindings from wrangler.toml', () => {
  const options = configBindings();
  assert.equal(options.compatibilityDate, readFileSync(join(ROOT, 'wrangler.toml'), 'utf8').match(/^compatibility_date = "(.+)"$/m)[1]);
  assert.deepEqual(Object.keys(options.durableObjects).sort(), ['ALERTS', 'DIRECTORY', 'ROOM']);
  assert.ok(Object.values(options.durableObjects).every(binding => binding.useSQLite === true));
  assert.deepEqual(Object.keys(options.ratelimits).sort(), ['CHECK_ATTEMPTS', 'INVITE_PEEK', 'JOIN_ATTEMPTS', 'PAIR_CREATE', 'TELEMETRY_RATE_LIMITER']);
  assert.equal(options.ratelimits.JOIN_ATTEMPTS.simple.limit, 600);
  assert.deepEqual(Object.keys(options.r2Buckets), ['MEDIA']);
  assert.equal(options.bindings.CASE_DEV_INLINE_CASES, '0', 'the deployed default; only the harness turns inline cases on');
});

test('direct worker refuses a wrangler.toml binding kind it would drop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-direct-config-'));
  try {
    const config = join(dir, 'wrangler.toml');
    writeFileSync(config, `${readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')}\n[[kv_namespaces]]\nbinding = "EXTRA"\nid = "local-only"\n`);
    assert.throws(() => configBindings(config), /does not pass wrangler\.toml options: kvNamespaces/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('direct worker answers from the Worker itself and checks accounts through the local fake', { timeout: 60_000 }, async () => {
  const worker = await startDirectWorker();
  try {
    assert.match(worker.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const missing = await fetch(`${worker.origin}/api/v1/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
    // Room creation passes only when the Worker's admin_account_active call reached the harness's fake.
    const room = await createRoom(worker.origin);
    assert.equal(Number.isInteger((await serverMirror(worker.origin, room)).revision), true);
  } finally { await worker.stop(); }
});

test('direct worker removes its Durable Object storage when stopped', { timeout: 60_000 }, async () => {
  const before = new Set(readdir());
  const worker = await startDirectWorker();
  const created = readdir().filter(name => !before.has(name));
  assert.equal(created.length, 1);
  await worker.stop();
  assert.equal(existsSync(join(tmpdir(), created[0])), false);
  function readdir() { return readdirSync(tmpdir()).filter(name => name.startsWith('case-direct-worker-')); }
});
