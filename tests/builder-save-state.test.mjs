import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderSaveState } from '../src/client/builder-save-state.mjs';

const initial = () => ({ revision: 4, document: { schema_version: 2, title: 'Draft A' }, authoringMetadata: { source: 'private A' } });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = value => structuredClone(value);

function harness(overrides = {}) {
  const calls = [];
  let latest = initial();
  let receipt = null;
  let windowIndex = 0;
  const windows = new Map();
  const services = {
    async issueWindow(baseRevision) { calls.push(['window', baseRevision]); if (overrides.issueWindow) return overrides.issueWindow(baseRevision); const operationId = `window-${++windowIndex}`; windows.set(operationId, baseRevision); return { operationId }; },
    async saveDraft(request) {
      calls.push(['save', clone(request)]);
      if (overrides.saveDraft) return overrides.saveDraft(request);
      if (windows.get(request.operationId) !== latest.revision) throw Object.assign(new Error('stale base'), { code: 'revision_conflict' });
      latest = { revision: latest.revision + 1, document: clone(request.document), authoringMetadata: clone(request.authoringMetadata) };
      receipt = { operationId: request.operationId, baseRevision: windows.get(request.operationId), revision: latest.revision, intentDigest: 'opaque-server-digest', status: 'saved' };
      return clone(receipt);
    },
    async readReceipt(operationId) { calls.push(['receipt', operationId]); if (overrides.readReceipt) return overrides.readReceipt(operationId); return receipt?.operationId === operationId ? clone(receipt) : { status: 'issued', operationId, baseRevision: windows.get(operationId) }; },
    async readLatest() { calls.push(['latest']); return overrides.readLatest ? overrides.readLatest() : clone(latest); },
    validate: overrides.validate,
  };
  const state = createBuilderSaveState({ initial: initial(), services });
  return { state, calls, services, setLatest: value => { latest = clone(value); }, setReceipt: value => { receipt = clone(value); }, getLatest: () => clone(latest) };
}

test('save freezes exact document and metadata while later typing remains dirty', async () => {
  const windowGate = deferred();
  const gate = deferred();
  const hCalls = [];
  const h = harness({ issueWindow: () => windowGate.promise, saveDraft: async request => { hCalls.push(clone(request)); return gate.promise; } });
  h.state.setDraft({ schema_version: 2, title: 'Submitted' }, { source: 'submitted' });
  const saving = h.state.save();
  h.state.setDraft({ schema_version: 2, title: 'Typed during acknowledgement' }, { source: 'changed' });
  windowGate.resolve({ operationId: 'window-1' });
  await Promise.resolve();
  h.setLatest({ revision: 5, document: { schema_version: 2, title: 'Submitted' }, authoringMetadata: { source: 'submitted' } });
  gate.resolve({ operationId: 'window-1', baseRevision: 4, revision: 5, intentDigest: 'server', status: 'saved' });
  const result = await saving;
  assert.deepEqual(hCalls[0], { operationId: 'window-1', document: { schema_version: 2, title: 'Submitted' }, authoringMetadata: { source: 'submitted' } });
  assert.equal(result.status, 'dirty');
  assert.deepEqual(h.state.snapshot().document, { schema_version: 2, title: 'Typed during acknowledgement' });
  assert.equal(h.state.snapshot().baseRevision, 5);
});

test('two saves cannot race and only the active save intent is submitted', async () => {
  const gate = deferred();
  const h = harness({ saveDraft: async () => gate.promise });
  h.state.setDraft({ schema_version: 2, title: 'Changed' }, {});
  const first = h.state.save();
  await Promise.resolve();
  await assert.rejects(h.state.save(), error => error.code === 'save_in_progress');
  h.setLatest({ revision: 5, document: { schema_version: 2, title: 'Changed' }, authoringMetadata: {} });
  gate.resolve({ operationId: 'window-1', baseRevision: 4, revision: 5, intentDigest: 'opaque', status: 'saved' });
  await first;
});

test('conflict keeps both copies until the author explicitly chooses', async () => {
  const h = harness();
  h.state.setDraft({ schema_version: 2, title: 'Local edit' }, { source: 'local' });
  h.setLatest({ revision: 5, document: { schema_version: 2, title: 'Another writer' }, authoringMetadata: { source: 'remote' } });
  await assert.rejects(h.state.save(), error => error.code === 'revision_conflict');
  const conflict = h.state.snapshot();
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.document, { schema_version: 2, title: 'Local edit' });
  assert.deepEqual(conflict.conflict.document, { schema_version: 2, title: 'Another writer' });
  assert.deepEqual(conflict.conflict.authoringMetadata, { source: 'remote' });
  h.state.resolveConflict('local');
  assert.equal(h.state.snapshot().baseRevision, 5);
  assert.equal(h.state.snapshot().dirty, true);
  assert.equal(h.state.snapshot().status, 'dirty');
});

test('revision conflict with a failed latest read has an explicit recoverable state and retains local content', async () => {
  let latestReads = 0;
  const h = harness({
    async saveDraft() { throw Object.assign(new Error('stale base'), { code: 'revision_conflict' }); },
    async readLatest() {
      latestReads++;
      if (latestReads === 1) throw new Error('temporary read failure');
      return { revision: 5, document: { schema_version: 2, title: 'Remote copy' }, authoringMetadata: { source: 'remote' } };
    },
  });
  h.state.setDraft({ schema_version: 2, title: 'Local copy' }, { source: 'local' });
  await assert.rejects(h.state.save(), error => error.code === 'conflict_read_failed');
  assert.equal(h.state.snapshot().status, 'conflict_read_failed');
  assert.equal(h.state.snapshot().dirty, true);
  assert.deepEqual(h.state.snapshot().document, { schema_version: 2, title: 'Local copy' });
  const refreshed = await h.state.reconcile();
  assert.equal(refreshed.status, 'conflict');
  assert.deepEqual(refreshed.document, { schema_version: 2, title: 'Local copy' });
  assert.deepEqual(refreshed.conflict.document, { schema_version: 2, title: 'Remote copy' });
});

test('choosing the saved copy adopts the whole paired revision and clears conflict', async () => {
  const h = harness();
  h.state.setDraft({ schema_version: 2, title: 'Local edit' }, { source: 'local' });
  h.setLatest({ revision: 5, document: { schema_version: 2, title: 'Saved copy' }, authoringMetadata: { source: 'saved' } });
  await assert.rejects(h.state.save());
  h.state.resolveConflict('saved');
  assert.deepEqual(h.state.snapshot(), {
    status: 'saved', baseRevision: 5, intentDigest: null, document: { schema_version: 2, title: 'Saved copy' },
    authoringMetadata: { source: 'saved' }, dirty: false, conflict: null, uncertainOperation: null,
    localGeneration: 2, savedGeneration: 2, lastReceipt: null,
  });
});

test('receipt proves a historical commit, then latest read detects the later writer', async () => {
  const h = harness({ saveDraft: async () => { throw new Error('acknowledgement lost'); } });
  h.state.setDraft({ schema_version: 2, title: 'Submitted' }, { source: 'submitted' });
  h.setLatest({ revision: 6, document: { schema_version: 2, title: 'Newer remote' }, authoringMetadata: { source: 'newer' } });
  await assert.rejects(h.state.save(), error => error.code === 'save_uncertain');
  // Model a receipt for rev5 while the current draft has already advanced to rev6.
  h.setReceipt({ operationId: 'window-1', baseRevision: 4, revision: 5, intentDigest: 'historical', status: 'saved' });
  const result = await h.state.reconcile();
  assert.equal(result.status, 'conflict');
  assert.equal(h.state.snapshot().lastReceipt.revision, 5);
  assert.equal(h.state.snapshot().conflict.revision, 6);
  assert.equal(h.calls.some(([name]) => name === 'latest'), true);
});

test('lost acknowledgement stays uncertain until exact receipt and current draft are read', async () => {
  let saved = false;
  const h = harness({
    async saveDraft(request) { saved = true; throw new Error('connection lost after commit'); },
    async readReceipt(operationId) { return saved ? { operationId, baseRevision: 4, revision: 5, intentDigest: 'opaque', status: 'saved' } : { status: 'issued', operationId, baseRevision: 4 }; },
    async readLatest() { return saved ? { revision: 5, document: { schema_version: 2, title: 'Submitted' }, authoringMetadata: { source: 'submitted' } } : initial(); },
  });
  h.state.setDraft({ schema_version: 2, title: 'Submitted' }, { source: 'submitted' });
  await assert.rejects(h.state.save(), error => error.code === 'save_uncertain');
  assert.equal(h.state.snapshot().status, 'uncertain');
  assert.equal(h.state.snapshot().dirty, true);
  const result = await h.state.reconcile();
  assert.equal(result.status, 'saved');
  assert.equal(h.state.snapshot().dirty, false);
  assert.equal(h.state.snapshot().lastReceipt.revision, 5);
  assert.ok(h.calls.findIndex(([name]) => name === 'receipt') < h.calls.findIndex(([name]) => name === 'latest'));
});

test('an issued window retries the same frozen operation instead of treating an early absent receipt as completion', async () => {
  let attempts = 0;
  let h;
  h = harness({
    async saveDraft(request) {
      attempts++;
      if (attempts === 1) throw new Error('first request acknowledgement lost');
      h.setLatest({ revision: 5, document: clone(request.document), authoringMetadata: clone(request.authoringMetadata) });
      return { operationId: request.operationId, baseRevision: 4, revision: 5, intentDigest: 'exact-operation', status: 'saved' };
    },
  });
  const frozen = { schema_version: 2, title: 'Retry exact payload' };
  h.state.setDraft(frozen, { source: 'same operation' });
  await assert.rejects(h.state.save(), error => error.code === 'save_uncertain');
  const result = await h.state.reconcile();
  assert.equal(result.status, 'saved');
  assert.equal(attempts, 2);
  assert.equal(h.state.snapshot().lastReceipt.intentDigest, 'exact-operation');
  assert.equal(h.state.snapshot().dirty, false);
});

test('same-revision acknowledgement never replaces a non-matching authoritative draft', async () => {
  const h = harness({
    async saveDraft(request) { return { operationId: request.operationId, baseRevision: 4, revision: 5, intentDigest: 'reported', status: 'saved' }; },
    async readLatest() { return { revision: 5, document: { schema_version: 2, title: 'Different content' }, authoringMetadata: { source: 'different' } }; },
  });
  h.state.setDraft({ schema_version: 2, title: 'Submitted content' }, { source: 'submitted' });
  await assert.rejects(h.state.save(), error => error.code === 'save_protocol');
  assert.equal(h.state.snapshot().status, 'uncertain');
  assert.deepEqual(h.state.snapshot().document, { schema_version: 2, title: 'Submitted content' });
});

test('malformed receipt status cannot be treated as proof that the exact write was absent', async () => {
  const h = harness({
    async saveDraft() { throw new Error('connection lost'); },
    async readReceipt() { return { status: 'unknown', operationId: 'window-1', baseRevision: 4 }; },
  });
  h.state.setDraft({ schema_version: 2, title: 'Submitted' }, { source: 'submitted' });
  await assert.rejects(h.state.save(), error => error.code === 'save_uncertain');
  await assert.rejects(h.state.reconcile(), error => error.code === 'save_protocol');
  assert.equal(h.state.snapshot().status, 'uncertain');
  assert.equal(h.state.snapshot().uncertainOperation.operationId, 'window-1');
});

test('stale save callback cannot replace a newly loaded draft', async () => {
  const gate = deferred();
  const h = harness({ saveDraft: async () => gate.promise });
  h.state.setDraft({ schema_version: 2, title: 'Old save' }, { source: 'old' });
  const saving = h.state.save();
  await Promise.resolve();
  h.state.load({ revision: 9, document: { schema_version: 2, title: 'Replacement' }, authoringMetadata: { source: 'replacement' } });
  gate.resolve({ operationId: 'window-1', baseRevision: 4, revision: 5, intentDigest: 'stale', status: 'saved' });
  await saving;
  assert.equal(h.state.snapshot().baseRevision, 9);
  assert.deepEqual(h.state.snapshot().document, { schema_version: 2, title: 'Replacement' });
  assert.equal(h.state.snapshot().status, 'saved');
});

test('save validator refusal is atomic and sends no request', async () => {
  const h = harness({ validate: () => [{ code: 'unknown_key', at: '/blocks/0/extra' }] });
  h.state.setDraft({ schema_version: 2, title: 'Changed' }, {});
  await assert.rejects(h.state.save(), error => error.code === 'invalid_candidate');
  assert.equal(h.calls.some(([name]) => name === 'window' || name === 'save'), false);
  assert.equal(h.state.snapshot().dirty, true);
});


test('base digest follows a restored or conflict-selected revision instead of the original loaded draft', async () => {
  const h = harness();
  h.state.load({ ...initial(), revision: 9, intentDigest: 'restored' });
  assert.equal(h.state.snapshot().intentDigest, 'restored');
  h.state.setDraft({title:'local'}, {});
  h.setLatest({ ...initial(), revision: 10, intentDigest: 'remote' });
  await assert.rejects(h.state.save(), { code: 'revision_conflict' });
  h.state.resolveConflict('saved');
  assert.equal(h.state.snapshot().intentDigest, 'remote');
  h.state.load(initial());
  assert.equal(h.state.snapshot().intentDigest, null);
});

test('a save-window quota refusal reads plainly and leaves the local draft dirty and savable (CASE-240)', async () => {
  let refuse = true;
  const h = harness({ issueWindow: () => {
    if (refuse) throw Object.assign(new Error('request_unavailable'), { status: 429, code: 'save_quota' });
    return { operationId: 'window-after-quota' };
  }, saveDraft: async request => ({ operationId: request.operationId, baseRevision: 4, revision: 5, intentDigest: 'opaque', status: 'saved' }),
  readLatest: async () => ({ revision: 5, document: { schema_version: 2, title: 'Draft B' }, authoringMetadata: { source: 'private B' } }) });
  h.state.setDraft({ schema_version: 2, title: 'Draft B' }, { source: 'private B' });
  await assert.rejects(h.state.save(), error => error.code === 'save_quota' && /^Save limit reached for this case\./.test(error.message));
  assert.equal(h.state.snapshot().status, 'dirty');
  assert.equal(h.calls.some(([name]) => name === 'save'), false, 'no draft write follows a refused window');
  refuse = false;
  await h.state.save();
  assert.equal(h.state.snapshot().status, 'saved');
});

test('card 60 REVIEW-01: an acknowledged save of the unchanged draft keeps the held draft object, so a review taken on it stays valid', async () => {
  const published = [];
  const services = harness().services;
  const state = createBuilderSaveState({ initial: initial(), services, onChange: value => published.push(value) });
  state.setDraft({ schema_version: 2, title: 'Reviewed' }, { source: 'reviewed' });
  const reviewed = published.at(-1);
  await state.save();
  const after = published.at(-1);
  assert.equal(after.status, 'saved');
  assert.equal(after.baseRevision, 5);
  // The listener (the studio) compares a review's base by identity: the content-equal server copy must not replace it.
  assert.equal(after.document, reviewed.document);
  assert.equal(after.authoringMetadata, reviewed.authoringMetadata);
  // Every snapshot handed to a caller is still its own copy.
  assert.notEqual(state.snapshot().document, reviewed.document);
  assert.deepEqual(state.snapshot().document, { schema_version: 2, title: 'Reviewed' });
});
