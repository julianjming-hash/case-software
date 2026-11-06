import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeardown } from '../src/client/teardown.mjs';
import { participantStorageFence, storageBarrier } from '../src/client/storage-barrier.mjs';
import { STORAGE_FENCE_KEY, storageGeneration } from '../src/client/storage-generation.mjs';
import { connect, testLifecycle, credentialKey } from '../src/client/transport.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const memory = () => { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }; };
function originLocks() {
  let tail = Promise.resolve();
  return { request(name, operation) { assert.equal(name, 'case-private-storage'); const task = tail.then(operation); tail = task.catch(() => {}); return task; } };
}
class IdleSocket { addEventListener() {} close() {} }
function heldJoin({ localStorage, indexedDB, locks }) {
  const request = deferred(), response = deferred(), room = uuidv7(), participantId = uuidv7();
  const fence = participantStorageFence({ localStorage, indexedDB, locks, requireLocks: true, timeoutMs: 15 });
  const link = connect({ role: 'participant', api: 'https://case.test', persistentStorage: localStorage,
    storage: null, restoreCredential: false, credentialFence: fence, WebSocketImpl: IdleSocket,
    lifecycle: testLifecycle(), telemetryImpl: () => {}, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); request.resolve(body); return response.promise;
    } });
  const pending = link.join('ABCDEF', 'Local fixture', 'shadows-01');
  return { link, pending, request, room, finish: body => response.resolve(Response.json({ sessionId: room, participantId, token: body.joinToken }, { status: 201 })) };
}
test('[AS-114] uncertain sign-out behind external origin lock still commits generation and native deletion before fresh writes', async () => {
  const locks = originLocks(), external = deferred(), entered = deferred(), localStorage = memory();
  const held = locks.request('case-private-storage', () => { entered.resolve(); return external.promise; }); await entered.promise;
  let deletion, deletions = 0;
  const securityIDB = { databases: async () => [{ name: 'case:phone-outbox' }], deleteDatabase() { deletions++; deletion = {}; return deletion; } };
  const old = heldJoin({ localStorage, indexedDB: {}, locks }); const body = await old.request.promise;
  try {
    const result = await createTeardown({ localStorage, sessionStorage: memory(), indexedDB: securityIDB,
      locks, requireLocks: true, cleanupTimeoutMs: 15, caches: null })('sign_out');
    assert.equal(result.complete, false, 'deadline cannot claim erasure');
    external.resolve(); await held; await tick();
    assert.equal(storageGeneration(localStorage), 1, 'durable security work must survive the expired caller');
    assert.equal(deletions, 1, 'actual deletion is scheduled under the same origin fence');
    old.finish(body); assert.equal((await old.pending).ok, false); assert.equal(old.link.hasToken, false);
    assert.equal(localStorage.getItem(credentialKey('participant', old.room)), null);
    const fresh = participantStorageFence({ localStorage, indexedDB: {}, locks, requireLocks: true, timeoutMs: 15 });
    let writes = 0;
    await assert.rejects(fresh.commit(() => { writes++; }), { code: 'storage_unavailable' }); assert.equal(writes, 0);
    deletion.onsuccess(); await tick();
    assert.equal(writes, 0, 'abandoned write cannot run late after native deletion');
    assert.equal(await fresh.commit(() => { localStorage.setItem('fresh', 'survives'); return true; }), true);
    assert.equal(localStorage.getItem('fresh'), 'survives'); assert.equal(deletions, 1);
  } finally { external.resolve(); deletion?.onsuccess?.(); old.finish(body); old.link.close(); await old.pending; }
});
test('security scheduling immediately cancels a same-document unbound join before the held lock can settle', async () => {
  const locks = originLocks(), external = deferred(), entered = deferred(), localStorage = memory();
  const indexedDB = { databases: async () => [], deleteDatabase() { throw Error('nothing to delete'); } };
  const held = locks.request('case-private-storage', () => { entered.resolve(); return external.promise; }); await entered.promise;
  const old = heldJoin({ localStorage, indexedDB, locks }); const body = await old.request.promise;
  try {
    const cleanup = createTeardown({ localStorage, sessionStorage: memory(), indexedDB, locks, requireLocks: true, cleanupTimeoutMs: 15, caches: null })('sign_out');
    await tick(); old.finish(body);
    assert.equal((await old.pending).ok, false, 'local scheduling must stop the network result before acquiring the origin lock');
    assert.equal(old.link.hasToken, false); assert.equal((await cleanup).complete, false);
    external.resolve(); await held; await tick(); assert.equal(storageGeneration(localStorage), 1);
  } finally { external.resolve(); old.finish(body); old.link.close(); await old.pending; }
});
test('committed security generation storage event cancels a separate-context transport and late join memory', async () => {
  const add = globalThis.addEventListener, remove = globalThis.removeEventListener, listeners = new Set();
  globalThis.addEventListener = (type, listener) => { if (type === 'storage') listeners.add(listener); };
  globalThis.removeEventListener = (type, listener) => { if (type === 'storage') listeners.delete(listener); };
  const localStorage = memory(), locks = originLocks(), indexedDB = { databases: async () => [], deleteDatabase() { throw Error('nothing to delete'); } };
  const old = heldJoin({ localStorage, indexedDB: {}, locks }); const body = await old.request.promise;
  try {
    assert.equal((await createTeardown({ localStorage, sessionStorage: memory(), indexedDB, locks, requireLocks: true, caches: null })('sign_out')).complete, true);
    for (const listener of listeners) listener({ key: STORAGE_FENCE_KEY, newValue: localStorage.getItem(STORAGE_FENCE_KEY) });
    old.finish(body); assert.equal((await old.pending).ok, false); assert.equal(old.link.hasToken, false);
    assert.equal(localStorage.getItem(credentialKey('participant', old.room)), null);
  } finally { old.finish(body); old.link.close(); await old.pending; globalThis.addEventListener = add; globalThis.removeEventListener = remove; }
});
