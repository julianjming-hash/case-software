import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgedBuilderPair, builderReleaseMaterial } from '../src/client/builder-workflows.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { describeCase, sameStructure, validArtDescriptor } from '../src/shared/art-descriptor.mjs';
const draft = () => ({ revision: 7, document: structuredClone(fixture), authoringMetadata: { metadata_version: 1 }, intentDigest: '\\x'+'a'.repeat(64) });
const snapshot = d => ({ ...d, baseRevision: d.revision, localGeneration: 4, status: 'saved', dirty: false });

const reorderedKeys = value => Array.isArray(value) ? value.map(reorderedKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorderedKeys(child)])) : value;

test('publishing accepts acknowledged JSON with reordered object keys but still rejects content and array changes', async () => {
  const local = draft();
  local.authoringMetadata.preparation_requirements = 'Private preparation stays exact.';
  const latest = reorderedKeys(local);
  assert.deepEqual(latest, local);
  assert.notEqual(JSON.stringify(latest.document), JSON.stringify(local.document));
  const result = await acknowledgedBuilderPair({ readLatest: async () => latest, getSnapshot: () => snapshot(local) });
  assert.deepEqual(result, local);
  const changed = structuredClone(latest);
  changed.document.beats.reverse();
  await assert.rejects(acknowledgedBuilderPair({ readLatest: async () => changed, getSnapshot: () => snapshot(local) }), /changed/);
  const privateChange = structuredClone(latest);
  privateChange.authoringMetadata.preparation_requirements = 'Different private preparation.';
  await assert.rejects(acknowledgedBuilderPair({ readLatest: async () => privateChange, getSnapshot: () => snapshot(local) }), /changed/);
});

test('[AS-124] Pending preparation checks an unchanged exact acknowledged pair, never an unsaved or older copy', async () => {
  const d = draft(); let current = snapshot(d);
  const result = await acknowledgedBuilderPair({ readLatest: async () => d, getSnapshot: () => current });
  assert.deepEqual(result, d); assert.notEqual(result.document, d.document);
  current.dirty = true;
  await assert.rejects(acknowledgedBuilderPair({ readLatest: async () => d, getSnapshot: () => current }), /Save and reconcile/);
  current = snapshot(d);
  await assert.rejects(acknowledgedBuilderPair({ readLatest: async () => ({...d, revision:8}), getSnapshot: () => current }), /changed/);
  await assert.rejects(acknowledgedBuilderPair({ readLatest: async () => ({...d, authoringMetadata:{metadata_version:1, preparation_requirements:'Other private writing'}}), getSnapshot: () => current }), /changed/);
});

test('late latest-draft acknowledgement cannot submit after typing or account retirement', async () => {
  const d = draft(); let state = snapshot(d), active = true, release;
  const pending = acknowledgedBuilderPair({ readLatest: () => new Promise(resolve => { release=resolve; }), getSnapshot: () => state, current: () => active });
  state = { ...state, localGeneration:5, dirty:true }; release(d);
  await assert.rejects(pending, /changed/);
  state=snapshot(d);
  const retired = acknowledgedBuilderPair({ readLatest: () => new Promise(resolve => { release=resolve; }), getSnapshot: () => state, current: () => active });
  active=false; release(d); await assert.rejects(retired, /changed/);
});

test('release material uses the shared art solver and exact referenced assets; incomplete pairs refuse', () => {
  const d=draft(), material=builderReleaseMaterial(d);
  assert.ok(validArtDescriptor(material.art)); assert.ok(sameStructure(material.art,describeCase(d.document)));
  assert.deepEqual(material.assetIds,[...new Set(d.document.surfaces.flatMap(s=>s.asset_ids??[]))]);
  d.document.start_beat_id='019a0000-0000-7000-8000-000000000001';
  assert.throws(()=>builderReleaseMaterial(d),/not ready/);
});
