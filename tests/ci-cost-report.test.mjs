import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, estimate, main } from '../scripts/ci-cost-report.mjs';

const run = { id: 7, name: 'verify', event: 'push', created_at: '2026-10-09T00:00:00Z', status: 'completed', conclusion: 'success' };
const job = (id, seconds, extra = {}) => ({ id, run_id: 7, name: 'browser-harness (1)', labels: ['ubuntu-latest'], runner_name: 'hosted', started_at: '2026-10-09T00:00:00Z', completed_at: new Date(Date.parse('2026-10-09T00:00:00Z') + seconds * 1000).toISOString(), ...extra });
const report = (jobs, extra = {}) => estimate({ runs: [{ workflow_runs: [run] }], jobPages: { 7: [{ jobs }] }, ...extra });

test('separate jobs round separately; matrix jobs group without losing billed time', () => {
  const r = report([job(1, 1), job(2, 61, { name: 'browser-harness (2)' })]);
  assert.equal(r.roundedMinutes, 3); assert.equal(r.rows.length, 1);
  assert.equal(r.grossEstimateUsd, 0.018); assert.equal(r.complete, true);
});
test('macOS is priced separately; repeated exports deduplicate IDs but distinct rerun attempts count', () => {
  const first = job(1, 61, { labels: ['macos-latest'], name: 'macos-bash32' });
  const second = job(2, 61, { labels: ['macos-latest'], name: 'macos-bash32', run_attempt: 2 });
  const r = report([first, first, second]);
  assert.equal(r.jobs, 2); assert.equal(r.grossEstimateUsd, 0.248); assert.equal(r.rerunRuns, 1);
});
test('partial reruns count copied executions once while retaining real new attempts and parallel jobs', () => {
  const original = job(1, 61, { runner_id: 70, run_attempt: 1 });
  const copied = { ...original, id: 2, run_attempt: 2 };
  const rerun = job(3, 61, { runner_id: 71, run_attempt: 2, started_at: '2026-10-09T00:05:00Z', completed_at: '2026-10-09T00:06:01Z' });
  const parallel = { ...original, id: 4 }; // Same-attempt records remain separate even with equal timestamps.
  for (const jobs of [[original, copied, rerun, parallel], [copied, original, rerun, parallel]]) {
    const r = report(jobs);
    assert.equal(r.grossEstimateUsd, 0.036);
    assert.equal(r.reusedJobRecords, 1);
    assert.equal(r.jobs, 4); assert.equal(r.allocatedExecutions, 3); assert.equal(r.rerunRuns, 1);
    assert.equal(r.complete, true);
  }
  assert.equal(report([copied, original]).rerunRuns, 0, 'copied-first metadata is not a new execution');
});
test('cancelled jobs still cost time; unallocated skipped jobs do not invent runner charges', () => {
  const r = report([job(1, 61, { conclusion: 'cancelled' }), job(2, 10, { conclusion: 'skipped', runner_name: null })]);
  assert.equal(r.cancelledEstimateUsd, 0.012); assert.equal(r.unallocatedJobs, 1); assert.equal(r.roundedMinutes, 2);
});
test('partial exports, running jobs and custom/ARM/self-hosted runners never claim complete pricing', () => {
  assert.equal(report([], { jobPages: {} }).complete, false);
  assert.deepEqual(report([], { jobPages: {} }).missingRunIds, [7]);
  assert.equal(report([], { runs: { total_count: 2, workflow_runs: [run] } }).missingRunCount, 1);
  assert.equal(report([], { jobPages: { 7: [{ total_count: 2, jobs: [job(1, 1)] }] } }).missingJobCount, 1);
  assert.equal(report([job(1, 5, { completed_at: null })]).incompleteJobs, 1);
  const queued = report([], { runs: { workflow_runs: [{ ...run, status: 'queued', conclusion: null }] } });
  assert.equal(queued.complete, false); assert.deepEqual(queued.pendingRunIds, [7]);
  for (const labels of [['self-hosted', 'ubuntu-latest'], ['ubuntu-24.04-arm'], ['custom-large']]) {
    const r = report([job(1, 61, { labels })]);
    assert.equal(r.unpricedJobs, 1); assert.equal(r.complete, false); assert.equal(r.grossEstimateUsd, 0);
  }
});
test('run creation selection excludes older cohorts; malformed durations and schemas refuse', () => {
  assert.equal(report([job(1, 1)], { since: '2026-10-10T00:00:00Z' }).runs, 0);
  assert.throws(() => report([], { since: 'invalid' }), /invalid_since/);
  assert.throws(() => report([job(1, -1)]), /invalid_duration/);
  assert.throws(() => report([job(1, 1, { started_at: 'invalid' })]), /invalid_duration/);
  assert.throws(() => report([job(1, 1, { run_id: 8 })]), /invalid_job/);
  assert.throws(() => report([], { runs: [] , rates: { linux: -1 } }), /invalid_rates/);
  assert.throws(() => report([], { runs: {} }), /invalid_workflow_runs/);
});

test('reports explain that older runs rerun inside the period are outside the creation cohort', () => {
  const older = { ...run, created_at: '2026-09-30T00:00:00Z' };
  const r = report([job(1, 61, { run_attempt: 2 })], { runs: { workflow_runs: [older] }, since: '2026-10-01T00:00:00Z' });
  assert.equal(r.runs, 0); assert.equal(r.grossEstimateUsd, 0);
  assert.match(r.limits, /run creation cohort/i);
  assert.match(r.limits, /older runs rerun/i);
});

test('metadata collector reads only paginated runs/jobs, includes every attempt and writes replayable exports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-ci-cost-')); const calls = [];
  try {
    const r = await collect({ repo: 'owner/repo', since: '2026-10-01T00:00:00Z', outDir: dir }, { gh: async args => {
      calls.push(args);
      return JSON.stringify(args[1].includes('/runs?') ? [{ workflow_runs: [run] }] : [{ jobs: [job(1, 61)] }]);
    } });
    assert.equal(r.grossEstimateUsd, 0.012); assert.equal(r.complete, true);
    assert.ok(calls.every(args => args[0] === 'api' && args.slice(-2).join(' ') === '--paginate --slurp'));
    assert.match(calls[1][1], /\/runs\/7\/jobs\?filter=all&per_page=100$/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'jobs/7.json')))[0].jobs.length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'runs.json')))[0].workflow_runs.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collector failures retain missing evidence and invalid collection inputs make no request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-ci-cost-'));
  try {
    for (const payload of [null, 'malformed']) {
      mkdirSync(join(dir, 'jobs'), { recursive: true });
      writeFileSync(join(dir, 'jobs/7.json'), JSON.stringify([{ jobs: [job(1, 61)] }]));
      const r = await collect({ repo: 'o/r', since: run.created_at, outDir: dir }, { gh: async args => {
        if (args[1].includes('/runs?')) return JSON.stringify([{ workflow_runs: [run] }]);
        if (payload === null) throw new Error('read failed'); return payload;
      } });
      assert.equal(r.complete, false); assert.deepEqual(r.missingRunIds, [7]);
      assert.equal(existsSync(join(dir, 'jobs/7.json')), false, 'a failed refresh cannot be replayed as an older complete read');
    }
    await assert.rejects(collect({ repo: '--invalid', since: run.created_at, outDir: dir }, { gh: () => { throw new Error('should not request'); } }), /invalid_collection/);
    await assert.rejects(collect({ repo: 'o/r', since: run.created_at, outDir: dir }, { gh: async () => JSON.stringify([{ workflow_runs: [{ ...run, id: '../invalid' }] }]) }), /invalid_run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline replay refuses old job exports while a refreshed collection is interrupted mid-read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-ci-interrupted-')); const original = console.log;
  const second = { ...run, id: 8 }; let replayCode;
  try {
    mkdirSync(join(dir, 'jobs')); console.log = () => {};
    for (const id of [7, 8]) writeFileSync(join(dir, 'jobs', `${id}.json`), JSON.stringify([{ jobs: [job(id, 61, { run_id: id })] }]));
    const result = await collect({ repo: 'o/r', since: run.created_at, outDir: dir }, { gh: async args => {
      if (args[1].includes('/runs?')) return JSON.stringify([{ workflow_runs: [run, second] }]);
      if (args[1].includes('/runs/7/')) {
        // Replay at the interruption boundary, before the old per-result cleanup could run.
        replayCode = await main(['--runs', join(dir, 'runs.json'), '--jobs-dir', join(dir, 'jobs')]);
        throw Error('interrupted_read');
      }
      return JSON.stringify([{ jobs: [job(8, 61, { run_id: 8 })] }]);
    } });
    assert.equal(replayCode, 1, 'an in-progress refreshed snapshot cannot reuse old complete job exports');
    assert.equal(result.complete, false); assert.deepEqual(result.missingRunIds, [7]);
    assert.equal(existsSync(join(dir, 'jobs/7.json')), false);
    assert.equal(existsSync(join(dir, 'jobs/8.json')), true);
  } finally { console.log = original; rmSync(dir, { recursive: true, force: true }); }
});
