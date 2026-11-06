import test from 'node:test';
import assert from 'node:assert/strict';
import { builderCaseContext } from '../src/client/builder-api.mjs';
import { isCurrentBuilderMount, mountBuilderForCurrentRoute } from '../src/client/builder-lifecycle.mjs';

const caseId = '019a0000-0000-7000-8000-000000000001';
const workspaceId = '019a0000-0000-7000-8000-000000000002';
const otherWorkspaceId = '019a0000-0000-7000-8000-000000000003';

test('direct draft reload trusts only entitled case context returned by the server', () => {
  assert.deepEqual(builderCaseContext({ case: { caseId, workspaceId, role: 'author' }, draft: null }, caseId),
    { caseId, workspaceId, role: 'author' });
  assert.throws(() => builderCaseContext({ draft: null, workspaceId }, caseId), /unavailable/);
  assert.throws(() => builderCaseContext({ case: { caseId, workspaceId, role: 'facilitator' } }, caseId), /unavailable/);
  assert.throws(() => builderCaseContext({ case: { caseId, workspaceId, role: 'owner' } }, caseId, otherWorkspaceId), /unavailable/);
});

test('a stale async edit import cannot mount into a replacement host or route generation', () => {
  const hostA = {}, hostB = {};
  assert.equal(isCurrentBuilderMount(4, 4, hostA, hostA), true);
  assert.equal(isCurrentBuilderMount(4, 5, hostA, hostB), false);
  assert.equal(isCurrentBuilderMount(4, 4, hostA, hostB), false);
});

test('an edit route invalidated during import never mounts, and one invalidated during setup is closed', async () => {
  let generation = 7, host = {};
  let releaseImport;
  const importPending = new Promise(resolve => { releaseImport = resolve; });
  let mounted = 0;
  const loading = mountBuilderForCurrentRoute({ expectedGeneration: 7, currentGeneration: () => generation, expectedHost: host,
    currentHost: () => host, load: () => importPending, mount: async () => { mounted++; return {}; } });
  generation++;
  releaseImport({});
  assert.equal(await loading, null);
  assert.equal(mounted, 0);

  let releaseMount;
  const mountPending = new Promise(resolve => { releaseMount = resolve; });
  let closed = false;
  const settingUp = mountBuilderForCurrentRoute({ expectedGeneration: generation, currentGeneration: () => generation, expectedHost: host,
    currentHost: () => host, load: async () => ({}), mount: async () => mountPending });
  await Promise.resolve();
  generation++;
  releaseMount({ close() { closed = true; } });
  assert.equal(await settingUp, null);
  assert.equal(closed, true);
});
