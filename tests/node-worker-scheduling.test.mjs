// Scheduling evidence uses two filesystem fake Worker lifetimes, not native capacity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = new URL('../', import.meta.url);
const WINDOW_MS = 1000; // Controlled startup observation only; no product timeout changes.

function testOptions(script) {
  const parts = script.trim().split(/\s+/);
  assert.equal(parts.shift(), 'node', 'npm test must use the Node test runner');
  assert.equal(parts.pop(), 'tests/*.test.mjs', 'npm test must select the complete existing Node suite');
  assert.equal(parts.filter((part) => part === '--test').length, 1);
  assert.equal(parts.filter((part) => part === '--disable-warning=ExperimentalWarning').length, 1);
  assert.ok(parts.every((part) => part === '--test' || part === '--disable-warning=ExperimentalWarning' || /^--test-concurrency=[1-9]\d*$/.test(part)), 'unsupported npm test option: do not silently omit selection or policy flags');
  assert.ok(parts.filter((part) => part.startsWith('--test-concurrency=')).length <= 1);
  return parts;
}

const FIXTURE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const label = basename(fileURLToPath(import.meta.url), '.test.mjs');
const root = process.env.CASE_FAKE_WORKER_ROOT;
const marker = (kind) => join(root, label + '.' + kind + '.json');
const witness = (kind) => writeFile(marker(kind), JSON.stringify({ label, pid: process.pid, kind }), { flag: 'wx' });
test('fake-worker-' + label, async () => {
  await witness('attempted');
  try { await mkdir(join(root, 'lease')); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await witness('conflict');
    assert.fail('fake Worker lifetimes overlapped');
  }
  try {
    await witness('acquired');
    const started = performance.now();
    while (true) {
      assert.ok(performance.now() - started < 10000, 'fixture coordinator did not release the lease; infrastructure setup failure');
      try { await access(join(root, label + '.release')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(10);
    }
  } finally {
    await rm(join(root, 'lease'), { recursive: true });
    await witness('released');
  }
});
`;

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function exercise(options) {
  const directory = await mkdtemp(join(tmpdir(), 'case-node-scheduling-'));
  let child; let terminal = false; let closed; let stdout = ''; let stderr = '';
  const heldSince = new Map(); const released = new Set();
  try {
    const files = ['alpha', 'beta'].map((label) => join(directory, `${label}.test.mjs`));
    await Promise.all(files.map((path) => writeFile(path, FIXTURE, { flag: 'wx' })));
    const env = { ...process.env, CASE_FAKE_WORKER_ROOT: directory };
    delete env.NODE_TEST_CONTEXT; // These are independent runner files, not this parent's test context.
    child = spawn(process.execPath, [...options, '--test-reporter=tap', ...files], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    closed = new Promise((resolve, reject) => {
      child.once('error', (error) => { terminal = true; reject(error); });
      child.once('close', (code, signal) => { terminal = true; resolve({ code, signal }); });
    });
    const started = performance.now();
    while (!terminal) {
      const conflict = (await readdir(directory)).some((name) => name.endsWith('.conflict.json'));
      for (const label of ['alpha', 'beta']) {
        if (released.has(label) || !await exists(join(directory, `${label}.acquired.json`))) continue;
        if (!heldSince.has(label)) heldSince.set(label, performance.now());
        if (conflict || performance.now() - heldSince.get(label) >= WINDOW_MS) {
          await writeFile(join(directory, `${label}.release`), '', { flag: 'wx' });
          released.add(label);
        }
      }
      assert.ok(performance.now() - started < 15000, 'fixture startup/terminal observation failed; this is not scheduling business evidence');
      await delay(10);
    }
    const outcome = await closed;
    const witnesses = [];
    for (const name of await readdir(directory)) {
      if (name.endsWith('.json')) witnesses.push(JSON.parse(await readFile(join(directory, name), 'utf8')));
    }
    assert.equal(await exists(join(directory, 'lease')), false, 'fake lease must be released before temporary cleanup');
    return { ...outcome, stdout, stderr, witnesses };
  } finally {
    if (child && !terminal) {
      // Release controlled holders and await the runner; never delete live fixture storage.
      for (const label of ['alpha', 'beta']) {
        try { await writeFile(join(directory, `${label}.release`), '', { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      await closed;
    }
    // The child remains in the outer observer's owned process group; no detached workers.
    await rm(directory, { recursive: true, force: true });
  }
}

function attempts(result) {
  const rows = result.witnesses.filter((row) => row.kind === 'attempted');
  assert.deepEqual(rows.map((row) => row.label).sort(), ['alpha', 'beta'], 'both distinct fixture files must execute exactly once');
  assert.equal(new Set(rows.map((row) => row.pid)).size, 2, 'two independent test-file processes must own the lifetimes');
  assert.match(result.stdout, /# tests 2\n/);
  assert.equal(result.signal, null);
}

test('npm test gives two independent fake Worker test files exclusive lifetimes', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));
  const options = testOptions(scripts.test);
  const parallel = [...options.filter((part) => !part.startsWith('--test-concurrency=')), '--test-concurrency=2'];
  const control = await exercise(parallel);
  attempts(control);
  assert.equal(control.code, 1, `parallel positive control must expose overlapping lifetimes: ${control.stdout}${control.stderr}`);
  assert.match(control.stdout, /fake Worker lifetimes overlapped/);
  assert.equal(control.witnesses.filter((row) => row.kind === 'conflict').length, 1);
  assert.equal(control.witnesses.filter((row) => row.kind === 'released').length, 1);

  const actual = await exercise(options);
  attempts(actual);
  assert.equal(actual.code, 0, `npm test allowed overlapping fake Worker lifetimes: ${actual.stdout}${actual.stderr}`);
  assert.equal(actual.witnesses.filter((row) => row.kind === 'conflict').length, 0);
  assert.deepEqual(actual.witnesses.filter((row) => row.kind === 'released').map((row) => row.label).sort(), ['alpha', 'beta']);
  assert.match(actual.stdout, /# pass 2\n/);
  assert.match(actual.stdout, /# fail 0\n/);
});
