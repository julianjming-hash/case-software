import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderSourceDigest } from '../src/client/builder-source-digest.mjs';
import { restoreCheckpointWithoutLosingEdits } from '../src/client/builder-checkpoint-restore.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('late source digest cannot unblock a newer edit before its matching hash settles', async () => {
  const first = deferred(), second = deferred();
  let text = 'old source'; const applied = [];
  const digest = createBuilderSourceDigest({
    hash: value => value === 'old source' ? first.promise : second.promise,
    readCurrentText: () => text,
    applyDigest: (id, hash) => { applied.push([id, hash, text]); return true; },
  });
  const oldEdit = digest.update('source-id', 'old source');
  text = 'new source';
  const newEdit = digest.update('source-id', 'new source');
  assert.equal(digest.blocksSave(), true);
  second.resolve('b'.repeat(64));
  await newEdit;
  assert.equal(digest.blocksSave(), false);
  first.resolve('a'.repeat(64));
  await oldEdit;
  assert.deepEqual(applied, [['source-id', 'b'.repeat(64), 'new source']]);
  assert.equal(text, 'new source');
});

test('failed source hash blocks save until a later edit hashes successfully', async () => {
  let fail = true, text = 'source';
  const digest = createBuilderSourceDigest({ hash: async () => { if (fail) throw new Error('offline'); return 'c'.repeat(64); },
    readCurrentText: () => text, applyDigest: () => true });
  await digest.update('source-id', text);
  assert.equal(digest.hasFailed(), true);
  assert.equal(digest.blocksSave(), true);
  fail = false; text = 'source corrected';
  await digest.update('source-id', text);
  assert.equal(digest.hasFailed(), false);
  assert.equal(digest.blocksSave(), false);
});

test('checkpoint result is refused if local writing changed while its request was pending', async () => {
  const gate = deferred();
  let generation = 8;
  const local = { title: 'Typing continues' };
  let applied = false;
  const restoring = restoreCheckpointWithoutLosingEdits({ expectedGeneration: generation,
    currentGeneration: () => generation, restore: () => gate.promise, validate: () => true, apply: () => { applied = true; } });
  local.title = 'More typing'; generation++;
  gate.resolve({ revision: 12, document: { title: 'Checkpoint' }, authoringMetadata: {} });
  await assert.rejects(restoring, error => error.code === 'checkpoint_local_changed');
  assert.equal(applied, false);
  assert.deepEqual(local, { title: 'More typing' });
});
