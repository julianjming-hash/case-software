import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, baseline, decide, leaks, load, latestVerdict, parseArgs, minuteFloor, minuteCeil, CEILINGS, spawnText } from '../scripts/ci-load.mjs';

// AUTONOMOUS-DEPLOY §2.3: the staging-load driver against fakes only (hard rule 12).
const BUILD = 'a'.repeat(40); const REPO = 'o/r'; const DAY = Date.parse('2026-10-06T10:00:00Z');
const run = (id, o = {}) => ({ id, path: '.github/workflows/staging-load.yml', head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', display_title: 'staging-load rooms=1 mode=run', run_started_at: '2026-10-06T09:00:00Z', ...o });

function world({ build = BUILD, ancestor = true, verdicts = {}, runs = [], todays = [] } = {}) {
  // verdicts: { rooms: [{ runId, verdict, build?, runOverrides? }] }
  const calls = [];
  const runsById = new Map(runs.map(r => [r.id, r]));
  const git = async args => { calls.push(['git', args]); if (args[0] === 'merge-base' && !ancestor) throw new Error('git_failed'); return ''; };
  const gh = async args => {
    calls.push(['gh', args]); const q = args[1];
    const art = q.match(/artifacts\?name=staging-load-(\d+)-([0-9a-f]+)/);
    if (art) return JSON.stringify({ artifacts: (verdicts[art[1]] ?? []).filter(v => (v.build ?? BUILD) === art[2]).map(v => ({ name: `staging-load-${art[1]}-${art[2]}`, expired: false, workflow_run: { id: v.runId, head_branch: v.branch ?? 'main' } })) });
    const one = q.match(/actions\/runs\/(\d+)$/);
    if (one) return JSON.stringify(runsById.get(Number(one[1])) ?? run(Number(one[1])));
    if (q.includes('/workflows/staging-load.yml/runs')) return JSON.stringify({ workflow_runs: todays });
    throw new Error(`unexpected ${q}`);
  };
  const download = async (runId, name) => {
    const rooms = Number(name.split('-')[2]); const v = (verdicts[rooms] ?? []).find(x => x.runId === runId);
    return JSON.stringify({ build: v.build ?? BUILD, rooms: v.claimRooms ?? rooms, verdict: v.verdict });
  };
  const fetchImpl = async () => new Response(JSON.stringify({ build, env: 'staging', wire: 1 }), { headers: { 'x-case-build': build } });
  return { calls, git, gh, download, fetchImpl, nowMs: DAY };
}
const a = (rooms, mode, w) => admit({ rooms, mode, repo: REPO, runId: 999 }, w);

test('usage is strict', () => {
  assert.deepEqual(parseArgs(['admit', '--rooms', '5', '--mode', 'run']), { cmd: 'admit', rooms: 5, mode: 'run' });
  for (const argv of [['admit', '--rooms', '2', '--mode', 'run'], ['admit', '--rooms', '1'], ['load', '--rooms', '1'], ['ship', '--rooms', '1', '--out', 'x'], ['load', '--rooms', '1', '--out', 'x', '--target', 'prod']]) assert.throws(() => parseArgs(argv), /usage/);
});

test('admit: the first size runs on a main-ancestor staging build', async () => {
  assert.deepEqual(await a(1, 'run', world()), { build: BUILD });
});
for (const [name, rooms, mode, opts, code] of [
  ['a staging build not on main', 1, 'run', { ancestor: false }, 'staging_build_not_on_main'],
  ['5 rooms before 1 room passed', 5, 'run', {}, 'previous_size_not_passed'],
  ['5 rooms after a failed 1-room run', 5, 'run', { verdicts: { 1: [{ runId: 10, verdict: 'fail' }] } }, 'previous_size_not_passed'],
  ['5 rooms when 1 room is still pending usage', 5, 'run', { verdicts: { 1: [{ runId: 10, verdict: 'pending' }] } }, 'previous_size_not_passed'],
  ['10 rooms with only 1 room passed', 10, 'run', { verdicts: { 1: [{ runId: 10, verdict: 'pass' }] } }, 'previous_size_not_passed'],
  ['a size already passed on this build', 1, 'run', { verdicts: { 1: [{ runId: 10, verdict: 'pass' }] } }, 'already_measured'],
  ['a fourth run in a UTC day', 1, 'run', { todays: [run(1), run(2), run(3)] }, 'daily_budget_spent'],
  ['reread without a pending run', 1, 'reread', {}, 'reread_needs_pending_run'],
  ['reread of a passed run', 1, 'reread', { verdicts: { 1: [{ runId: 10, verdict: 'pass' }] } }, 'reread_needs_pending_run'],
]) test(`admit refuses ${name}`, async () => { await assert.rejects(a(rooms, mode, world(opts)), { message: code }); });

test('admit: only an owner-authorised over-budget run passes the daily budget, never sequencing', async () => {
  assert.deepEqual(await admit({ rooms: 1, mode: 'run', repo: REPO, runId: 999, overBudget: true }, world({ todays: [run(1), run(2), run(3)] })), { build: BUILD });
  await assert.rejects(admit({ rooms: 5, mode: 'run', repo: REPO, runId: 999, overBudget: true }, world({ todays: [run(1), run(2), run(3)] })), { message: 'previous_size_not_passed' });
  await assert.rejects(admit({ rooms: 1, mode: 'run', repo: REPO, runId: 999, overBudget: 'yes' }, world({ todays: [run(1), run(2), run(3)] })), { message: 'daily_budget_spent' });
  assert.deepEqual(parseArgs(['admit', '--rooms', '1', '--mode', 'run', '--over-budget', 'owner-authorised']), { cmd: 'admit', rooms: 1, mode: 'run', 'over-budget': 'owner-authorised' });
  for (const argv of [['admit', '--rooms', '1', '--mode', 'run', '--over-budget', 'yes'], ['load', '--rooms', '1', '--out', 'x', '--over-budget', 'no']]) assert.throws(() => parseArgs(argv), { message: 'usage' });
});

test('admit: sequencing follows passing verdicts on the same build', async () => {
  assert.deepEqual(await a(5, 'run', world({ verdicts: { 1: [{ runId: 10, verdict: 'pass' }] } })), { build: BUILD });
  assert.deepEqual(await a(10, 'run', world({ verdicts: { 1: [{ runId: 10, verdict: 'pass' }], 5: [{ runId: 11, verdict: 'pass' }] } })), { build: BUILD });
  await assert.rejects(a(5, 'run', world({ verdicts: { 1: [{ runId: 10, verdict: 'pass', build: 'b'.repeat(40) }] } })), { message: 'previous_size_not_passed' });
});
test('admit: forged or foreign verdicts do not count', async () => {
  for (const runOverrides of [{ path: '.github/workflows/evil.yml' }, { head_branch: 'feature' }, { event: 'push' }]) {
    const w = world({ verdicts: { 1: [{ runId: 10, verdict: 'pass' }] }, runs: [run(10, runOverrides)] });
    await assert.rejects(a(5, 'run', w), { message: 'previous_size_not_passed' });
  }
  await assert.rejects(a(5, 'run', world({ verdicts: { 1: [{ runId: 10, verdict: 'pass', branch: 'feature' }] } })), { message: 'previous_size_not_passed' });
  await assert.rejects(a(5, 'run', world({ verdicts: { 1: [{ runId: 10, verdict: 'pass', claimRooms: 5 }] } })), { message: 'previous_size_not_passed' });
});
test('admit: the daily budget ignores rereads, other days, branches and this run', async () => {
  const todays = [run(1), run(2), run(3, { display_title: 'staging-load rooms=1 mode=reread' }), run(4, { run_started_at: '2026-10-05T23:00:00Z' }), run(5, { head_branch: 'feature' }), run(999)];
  assert.deepEqual(await a(1, 'run', world({ todays })), { build: BUILD });
});
test('admit: reread names the pending source run', async () => {
  assert.deepEqual(await a(1, 'reread', world({ verdicts: { 1: [{ runId: 10, verdict: 'pending' }] } })), { build: BUILD, sourceRunId: 10 });
});
test('latestVerdict picks the newest genuine run', async () => {
  const w = world({ verdicts: { 1: [{ runId: 10, verdict: 'fail' }, { runId: 12, verdict: 'pass' }] } });
  assert.equal((await latestVerdict({ ...w, repo: REPO, rooms: 1, build: BUILD })).verdict, 'pass');
});

const report = (rooms, o = {}) => ({ started_at: '2026-10-06T10:00:05.000Z', ended_at: '2026-10-06T10:01:05.000Z', rooms: Array(rooms).fill({}),
  total: { rooms, clients: rooms * 25, expected_votes: rooms * 75, receipted_votes: rooms * 75, lost_votes: 0, duplicate_votes: 0, http_by_route: { join: rooms * 25, vote: rooms * 300 }, ...o } });
const usage = (written = 1000) => ({ total: { sqlite_rows_written: written } });
const window = { from: '2026-10-06T10:00:00.000Z', to: '2026-10-06T10:02:00.000Z' };
test('decide: a clean run with usage passes; without usage it is pending, never zero', () => {
  assert.deepEqual(decide({ rooms: 1, loadOk: true, report: report(1), usage: usage(), window }), { verdict: 'pass', reasons: [] });
  assert.equal(decide({ rooms: 1, loadOk: true, report: report(1), usage: null, window }).verdict, 'pending');
  assert.equal(decide({ rooms: 1, loadOk: true, report: report(1), usage: { total: {} }, window }).verdict, 'pending');
});
for (const [name, args, reason] of [
  ['a failed harness', { loadOk: false, loadError: 'load_room_failed: load_p95_exceeded' }, 'load_failed:load_room_failed: load_p95_exceeded'],
  ['an unsafe harness error string', { loadOk: false, loadError: 'token=abc.def' }, 'load_failed:unknown'],
  ['lost votes', { report: report(1, { lost_votes: 1 }) }, 'lost_votes'],
  ['duplicate votes', { report: report(1, { duplicate_votes: 1 }) }, 'duplicate_votes'],
  ['unreceipted votes', { report: report(1, { receipted_votes: 74 }) }, 'votes_unreceipted'],
  ['HTTP over the ceiling', { report: report(1, { http_by_route: { vote: CEILINGS[1].http + 1 } }) }, 'http_ceiling'],
  ['no HTTP at all', { report: report(1, { http_by_route: {} }) }, 'http_ceiling'],
  ['a run over 2 minutes plus stagger', { report: { ...report(1), ended_at: '2026-10-06T10:02:06.000Z' } }, 'run_too_long'],
  ['the wrong room count', { report: report(5) }, 'report_incomplete'],
  ['rows written over the ceiling', { usage: usage(CEILINGS[1].rowsWritten + 1) }, 'rows_written_ceiling'],
]) test(`decide fails ${name}`, () => {
  const r = decide({ rooms: 1, loadOk: true, report: report(1), usage: usage(), window, ...args });
  assert.equal(r.verdict, 'fail'); assert.ok(r.reasons.includes(reason), JSON.stringify(r.reasons));
});
test('decide scales ceilings and stagger span by size', () => {
  assert.equal(decide({ rooms: 10, loadOk: true, report: { ...report(10), ended_at: '2026-10-06T10:02:14.000Z' }, usage: usage(), window }).verdict, 'pass');
  assert.equal(decide({ rooms: 10, loadOk: true, report: { ...report(10), ended_at: '2026-10-06T10:02:15.000Z' }, usage: usage(), window }).verdict, 'fail');
});

test('leak scan catches credential shapes, token words and the load email', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-load-'));
  writeFileSync(join(dir, 'report.json'), '{"ok":true}');
  assert.equal(leaks(dir, ['load@example.test']), null);
  for (const text of ['{"x":"load@example.test"}', '{"refresh_token":"x"}', '{"h":"Bearer x"}', `{"k":"sb_secret_${'z'.repeat(20)}"}`]) {
    writeFileSync(join(dir, 'bad.json'), text); assert.equal(leaks(dir, ['load@example.test']), 'bad.json', text);
  }
});

test('load: signs in, pipes only the token to the harness, always signs out, writes the window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-load-')); const requests = []; const token = 'aaa.bbb.ccc'; let given; let clock = Date.parse('2026-10-06T10:00:30Z');
  const fetchImpl = async (url, init) => { requests.push([url, init]); return url.includes('grant_type=password') ? new Response(JSON.stringify({ access_token: token, refresh_token: 'r' })) : new Response('', { status: 204 }); };
  const runHarness = async ({ rooms, token: t }) => { given = { rooms, t }; clock += 70_000; return { code: 0, stdout: '{"total":{}}\n', stderr: '' }; };
  assert.equal(await load({ rooms: 1, out: dir, email: 'e@x.test', password: 'p', supabase: { url: 'https://x.supabase.co', publishableKey: 'sb_publishable_x' } }, { fetchImpl, runHarness, now: () => clock }), true);
  assert.deepEqual(given, { rooms: 1, t: token });
  assert.equal(requests[1][0], 'https://x.supabase.co/auth/v1/logout?scope=global'); assert.equal(requests[1][1].headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'window.json'), 'utf8')), { from: '2026-10-06T10:00:00.000Z', to: '2026-10-06T10:02:00.000Z', rooms: 1 });
  for (const f of ['window.json', 'load.json', 'report.json']) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(token));
});
test('load: a failed harness still signs out and records the fixed error; sign-in failure refuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-load-')); const urls = [];
  const fetchImpl = async url => { urls.push(url); return url.includes('grant_type') ? new Response(JSON.stringify({ access_token: 'a.b.c' })) : new Response('', { status: 204 }); };
  assert.equal(await load({ rooms: 1, out: dir, email: 'e', password: 'p', supabase: { url: 'https://x.supabase.co', publishableKey: 'k' } }, { fetchImpl, runHarness: async () => ({ code: 1, stdout: '', errorCode: 'load_room_failed' }) }), false);
  assert.ok(urls.some(u => u.includes('logout'))); assert.equal(existsSync(join(dir, 'report.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'load.json'), 'utf8')), { ok: false, error: 'load_room_failed' });
  await assert.rejects(load({ rooms: 1, out: dir, email: 'e', password: 'p', supabase: { url: 'https://x.supabase.co', publishableKey: 'k' } }, { fetchImpl: async () => new Response('{}', { status: 400 }), runHarness: async () => assert.fail('must not run') }), { message: 'load_signin_failed' });
  await assert.rejects(load({ rooms: 1, out: dir, email: '', password: 'p', supabase: {} }, { fetchImpl, runHarness: async () => assert.fail('must not run') }), { message: 'load_credentials_missing' });
});
test('baseline waits for a whole-minute window of fixed length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-load-')); let clock = Date.parse('2026-10-06T10:00:20Z'); let slept = 0;
  const w = await baseline({ out: dir }, { sleep: async ms => { slept = ms; clock += ms; }, now: () => clock });
  assert.deepEqual(w, { from: '2026-10-06T10:01:00.000Z', to: '2026-10-06T10:04:00.000Z', rooms: 1 });
  assert.equal(slept, 220_000);
  assert.equal(minuteFloor(Date.parse('2026-10-06T10:00:59Z')), '2026-10-06T10:00:00.000Z');
  assert.equal(minuteCeil(Date.parse('2026-10-06T10:00:01Z')), '2026-10-06T10:01:00.000Z');
});
test('load: a non-200 sign-in is refused even when its body carries a token shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-load-'));
  await assert.rejects(load({ rooms: 1, out: dir, email: 'e', password: 'p', supabase: { url: 'https://x.supabase.co', publishableKey: 'k' } },
    { fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a.b.c' }), { status: 401 }), runHarness: async () => assert.fail('must not run') }), { message: 'load_signin_failed' });
});

test('spawnText resolves, never crashes, when the child exits before reading its stdin (EPIPE, staging-load run 37552825438)', async () => {
  // `true` exits at once without reading stdin; a large input makes the write fail with EPIPE.
  const result = await spawnText('true', [], { env: { PATH: process.env.PATH }, input: 'x'.repeat(8 * 1024 * 1024) });
  assert.equal(result.code, 0);
});
