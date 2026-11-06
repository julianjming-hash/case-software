import test from 'node:test';
import assert from 'node:assert/strict';
import { activateBuilderSave, assertBuilderSaveAcknowledgement, assertBuilderSaveEvidence, builderSaveCheckpoint } from './helpers/builder-save.mjs';
import { createBuilderSaveState } from '../src/client/builder-save-state.mjs';
import { createBuilderAutosave } from '../src/client/builder-autosave.mjs';

const pair = title => ({ document: { schema_version: 2, title }, authoringMetadata: { metadata_version: 1, sources: [{ text: 'Private expected source' }] } });
function harness({ hold = null, holdReadback = null, onReadback = () => {} } = {}) {
  const model = { revision: 1, pair: pair('Before'), writes: [], readbacks: [] };
  const services = {
    async issueWindow(baseRevision) { assert.equal(baseRevision, model.revision); return { operationId: 'operation-after-edit' }; },
    async saveDraft(request) {
      if (hold) await hold;
      model.revision++;
      model.pair = { document: structuredClone(request.document), authoringMetadata: structuredClone(request.authoringMetadata) };
      const receipt = { operationId: request.operationId, revision: model.revision, intentDigest: 'paired-intent', status: 'saved' };
      model.writes.push({ operationId: request.operationId, pair: structuredClone(model.pair), receipt });
      return structuredClone(receipt);
    },
    async readLatest() {
      model.readbacks.push({ revision: model.revision, pair: structuredClone(model.pair), intentDigest: 'paired-intent' });
      onReadback(); if (holdReadback) await holdReadback;
      return { revision: model.revision, ...structuredClone(model.pair), intentDigest: 'paired-intent' };
    },
    async readReceipt() { return structuredClone(model.writes.at(-1)?.receipt); },
  };
  const state = createBuilderSaveState({ initial: { revision: 1, ...model.pair }, services });
  const pending = [], timers = new Map(); let next = 0, clicks = 0;
  const scheduler = { now: () => 0, setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); } };
  const autosave = createBuilderAutosave({ getSnapshot: () => state.snapshot(), save: () => state.save(), scheduler });
  const button = { get disabled() { return state.snapshot().status === 'saving' || !state.snapshot().dirty; }, click() { clicks++; pending.push(state.save()); } };
  return { model, state, button, autosave, pending, clicks: () => clicks,
    async fireAutosave() { autosave.changed(); const task = [...timers.values()][0]; assert.ok(task); timers.clear(); await task(); } };
}

for (const mode of ['manual dirty', 'already autosaved', 'autosave in flight']) test(`save evidence accepts ${mode} only after real save-state receipt and paired readback`, async () => {
  let release;
  const hold = mode === 'autosave in flight' ? new Promise(resolve => { release = resolve; }) : null;
  const h = harness({ hold }), baseline = builderSaveCheckpoint(h.model), expected = pair('After');
  h.state.setDraft(expected.document, expected.authoringMetadata);
  if (mode === 'manual dirty') {
    assert.equal(activateBuilderSave(h.button), 'clicked');
    await Promise.all(h.pending);
  } else if (mode === 'already autosaved') {
    await h.fireAutosave();
    assert.equal(activateBuilderSave(h.button), 'disabled');
  } else {
    const saving = h.fireAutosave();
    assert.equal(h.state.snapshot().status, 'saving');
    assert.equal(activateBuilderSave(h.button), 'disabled');
    assert.throws(() => assertBuilderSaveEvidence(h.model, baseline, expected), /no write/);
    release(); await saving;
  }
  assert.equal(h.state.snapshot().status, 'saved');
  assert.equal(h.state.snapshot().dirty, false);
  assert.equal(h.clicks(), mode === 'manual dirty' ? 1 : 0);
  assert.equal(h.model.writes.length, 1);
  assertBuilderSaveEvidence(h.model, baseline, expected);
  h.autosave.close();
});

test('a post-baseline write and served readback cannot substitute for the client Saved acknowledgement', async () => {
  let release, readStarted;
  const holdReadback = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { readStarted = resolve; });
  const h = harness({ holdReadback, onReadback: readStarted }), baseline = builderSaveCheckpoint(h.model), expected = pair('After');
  h.state.setDraft(expected.document, expected.authoringMetadata);
  const saving = h.state.save();
  try {
    await ready;
    const receipt = assertBuilderSaveEvidence(h.model, baseline, expected);
    assert.equal(h.state.snapshot().status, 'saving');
    assert.throws(() => assertBuilderSaveAcknowledgement({ text: 'Saving…', title: '' }, receipt), /has not acknowledged/);
    assert.throws(() => assertBuilderSaveAcknowledgement({ text: 'Saved', title: 'Saved as revision 1' }, receipt), /stale or mismatched/);
    release(); await saving;
    assert.equal(h.state.snapshot().status, 'saved');
    assertBuilderSaveAcknowledgement({ text: 'Saved', title: `Saved as revision ${h.state.snapshot().baseRevision}` }, receipt);
  } finally { release(); await saving; }
});

test('atomic activation observes the current disabled state without an earlier enabled probe', () => {
  let clicks = 0;
  // Models an autosave winning immediately before the browser task executes.
  const button = { disabled: true, click() { clicks++; } };
  assert.equal(activateBuilderSave(button), 'disabled');
  assert.equal(clicks, 0);
  button.disabled = false;
  assert.equal(activateBuilderSave(button), 'clicked');
  assert.equal(clicks, 1);
});

for (const [label, corrupt, reason] of [
  ['no post-mutation write', (e, baseline) => { baseline.writes = e.writes.length; }, /no write/],
  ['stale saved revision', (e, baseline) => { baseline.revision = e.revision; }, /did not advance/],
  ['missing receipt', e => { e.writes[0].receipt = null; }, /missing successful/],
  ['unsuccessful receipt', e => { e.writes[0].receipt.status = 'issued'; }, /missing successful/],
  ['missing write operation', e => { delete e.writes[0].operationId; delete e.writes[0].receipt.operationId; }, /write operation identity/],
  ['wrong operation receipt', e => { e.writes[0].receipt.operationId = 'old-operation'; }, /operation/],
  ['stale receipt', e => { e.writes[0].receipt.revision--; }, /receipt revision/],
  ['missing readback', e => { e.readbacks = []; }, /missing paired/],
  ['stale readback', e => { e.readbacks[0].revision--; }, /readback revision/],
  ['wrong paired digest', e => { e.readbacks[0].intentDigest = 'different'; }, /readback digest/],
  ['wrong readback document', e => { e.readbacks[0].pair.document.title = 'Before'; }, /readback differs/],
  ['wrong readback metadata', e => { e.readbacks[0].pair.authoringMetadata.sources[0].text = 'Other source'; }, /readback differs/],
  ['later stored content', e => { e.pair.document.title = 'Other writer'; }, /current stored pair/],
  ['wrong expected edit', (e, baseline, expected) => { expected.document.title = 'Never saved'; }, /expected edit/],
]) test(`save evidence rejects ${label} despite a nominal Saved UI`, async () => {
  const h = harness(), baseline = { ...builderSaveCheckpoint(h.model) }, expected = pair('After');
  h.state.setDraft(expected.document, expected.authoringMetadata); await h.state.save();
  assert.equal(h.state.snapshot().status, 'saved');
  const evidence = structuredClone(h.model);
  corrupt(evidence, baseline, expected);
  assert.throws(() => assertBuilderSaveEvidence(evidence, baseline, expected), reason);
});
