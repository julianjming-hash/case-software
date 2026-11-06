import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSetup, parseArgs } from '../scripts/ci-check-setup.mjs';

// AUTONOMOUS-DEPLOY §7: the read-only setup checker. A fake gh returns names and settings only.
function fakeGh({ secrets = [], variables = [], actions = { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }, fail = false } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args); if (fail) throw new Error('gh_failed');
    if (args[0] === 'secret') return JSON.stringify(secrets.map(name => ({ name })));
    if (args[0] === 'variable') return JSON.stringify(variables.map(name => ({ name })));
    if (args[0] === 'api') return JSON.stringify(actions);
    throw new Error('unexpected');
  };
  return { gh, calls };
}
const B = { secrets: ['CLOUDFLARE_API_TOKEN', 'CASE_STAGING_DEPLOY_GUARD_TOKEN'], variables: ['CLOUDFLARE_ACCOUNT_ID'] };

test('phase B complete; reads names only, never values', async () => {
  const f = fakeGh(B); const r = await checkSetup({ phase: 'B', repo: 'o/r' }, f);
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(f.calls.every(args => !args.includes('--body') && !args.includes('set')));
  assert.deepEqual(f.calls.slice(0, 2).map(a => a.slice(-2)), [['--json', 'name'], ['--json', 'name']]);
});
test('each missing name is reported with its setup step', async () => {
  for (const [drop, step] of [['CLOUDFLARE_API_TOKEN', 'B1'], ['CASE_STAGING_DEPLOY_GUARD_TOKEN', 'B3']]) {
    const r = await checkSetup({ phase: 'B', repo: 'o/r' }, fakeGh({ ...B, secrets: B.secrets.filter(s => s !== drop) }));
    assert.equal(r.ok, false); assert.ok(r.lines.some(l => l.startsWith('MISSING') && l.includes(drop) && l.includes(step)));
  }
  const r = await checkSetup({ phase: 'B', repo: 'o/r' }, fakeGh({ ...B, variables: [] }));
  assert.equal(r.ok, false); assert.ok(r.lines.some(l => l.includes('CLOUDFLARE_ACCOUNT_ID') && l.includes('B2')));
});
test('later phases require their names; earlier phases ignore them', async () => {
  assert.equal((await checkSetup({ phase: 'C', repo: 'o/r' }, fakeGh(B))).ok, false);
  assert.equal((await checkSetup({ phase: 'C', repo: 'o/r' }, fakeGh({ ...B, secrets: [...B.secrets, 'CASE_PRODUCTION_DEPLOY_GUARD_TOKEN'] }))).ok, true);
  const all = [...B.secrets, 'CASE_PRODUCTION_DEPLOY_GUARD_TOKEN', 'CASE_LOAD_EMAIL', 'CASE_LOAD_PASSWORD', 'CF_USAGE_TOKEN'];
  assert.equal((await checkSetup({ phase: 'D', repo: 'o/r' }, fakeGh({ ...B, secrets: all }))).ok, true);
  assert.equal((await checkSetup({ phase: 'D', repo: 'o/r' }, fakeGh({ ...B, secrets: all.slice(0, -1) }))).ok, false);
});
test('an unexpected repository secret fails the check', async () => {
  const r = await checkSetup({ phase: 'B', repo: 'o/r' }, fakeGh({ ...B, secrets: [...B.secrets, 'SUPABASE_SERVICE_ROLE_KEY'] }));
  assert.equal(r.ok, false); assert.ok(r.lines.some(l => l.startsWith('UNEXPECTED') && l.includes('SUPABASE_SERVICE_ROLE_KEY')));
});
test('changed Actions defaults fail the check', async () => {
  for (const actions of [{ default_workflow_permissions: 'write', can_approve_pull_request_reviews: false }, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }]) {
    const r = await checkSetup({ phase: 'B', repo: 'o/r' }, fakeGh({ ...B, actions }));
    assert.equal(r.ok, false); assert.ok(r.lines.some(l => l.startsWith('CHANGED')));
  }
});
test('unreadable settings fail closed; bad arguments refuse', async () => {
  assert.equal((await checkSetup({ phase: 'B', repo: 'o/r' }, fakeGh({ fail: true }))).ok, false);
  assert.throws(() => parseArgs(['--phase', 'A']), /setup_usage/);
  assert.throws(() => parseArgs(['--phase', 'B', '--repo', 'not a repo']), /setup_usage/);
  assert.deepEqual(parseArgs(['--phase', 'D']), { phase: 'D', repo: 'julianjming-hash/case' });
});
