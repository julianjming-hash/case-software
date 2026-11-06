import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { ConsoleManualRoom, savedManualKey } from '../src/client/console-manual.mjs';
import { authNavigationPreservation, recoverOnLoad } from '../src/client/teardown.mjs';

function storage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key), values: () => [...data] };
}
function segment() {
  const { doc } = miniCase();
  const room = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const { caseDoc, ...mirror } = room;
  const store = storage();
  const manual = new ConsoleManualRoom(mirror, caseDoc,
    { storage: store, channel: { postMessage() {}, close() {} } });
  assert.equal(manual.enter().receipt, 'accepted');
  return { key: `case-lab:segment:${mirror.sessionId}`, store, manual };
}

test('Card 12 only one strictly validated manual segment is eligible for navigation preservation', () => {
  const { key, store, manual } = segment();
  assert.equal(savedManualKey(store), key);
  store.setItem(`case-lab:segment:${uuidv7()}`, '{}');
  assert.equal(savedManualKey(store), null);
  store.removeItem([...store.values()].find(([item]) => item !== key)[0]);
  store.setItem(key, '{bad');
  assert.equal(savedManualKey(store), null);
  manual.close();
});

test('Card 12 validated tab segment survives only pagehide and next load, never account teardown', async () => {
  const { key, store, manual } = segment();
  const local = storage({ 'case:auth:refresh': 'stale' });
  const preserve = () => savedManualKey(store) ? [key] : [];
  const policy = authNavigationPreservation({ sessionStorage: store,
    localStorage: local, preserveSessionKeys: preserve });
  assert.deepEqual(policy.preserveSession('pagehide'), [key]);
  assert.deepEqual(policy.preserveSession('sign_out'), []);
  assert.deepEqual(await recoverOnLoad({ sessionStorage: store, localStorage: local,
    preserveSessionKeys: preserve, caches: null, indexedDB: null }), { complete: true });
  assert.notEqual(store.getItem(key), null);
  // Card 38 (CASE-175): the account refresh token persists across navigation; only account teardown removes it.
  assert.equal(local.getItem('case:auth:refresh'), 'stale');
  const { createTeardown } = await import('../src/client/teardown.mjs');
  await createTeardown({ sessionStorage: store, localStorage: local,
    caches: null, indexedDB: null, preserveSession: policy.preserveSession })('sign_out');
  assert.equal(store.getItem(key), null);
  manual.close();
});

test('Card 12 failed pagehide cleanup purges a preserved manual segment', async () => {
  const { key, store, manual } = segment();
  const { createTeardown } = await import('../src/client/teardown.mjs');
  const result = await createTeardown({ sessionStorage: store, localStorage: storage(),
    caches: { async keys() { throw new Error('cache_unavailable'); }, async delete() {} },
    indexedDB: null, preserveSession: () => [key] })('pagehide');
  assert.equal(result.complete, false);
  assert.equal(store.getItem(key), null);
  manual.close();
});

test('Card 12 saved manual notes are explicit, clean and contain no case pack or credential', () => {
  const { key, store, manual } = segment();
  assert.equal(manual.command('manual_marker', { text: 'Local reminder' }).receipt, 'accepted');
  const saved = ConsoleManualRoom.saved(key.slice('case-lab:segment:'.length), store);
  const notes = ConsoleManualRoom.notesFromSaved(saved);
  assert.match(notes, /Local reminder/);
  assert.doesNotMatch(notes, /caseDoc|token|Published case/);
  manual.close(); manual.forget();
});
