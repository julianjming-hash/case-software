import test from 'node:test';
import assert from 'node:assert/strict';
import { holdRoom, releaseRoom } from '../src/client/console-ownership.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

// A Web Locks callback owns its name until the promise it returns settles. Dispatch can be delayed.
function locksFor(t, { delayed = false, unavailable = false } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const held = new Set(), pending = [];
  let requests = 0;
  const locks = { request(name, options, callback) {
    requests++;
    assert.deepEqual(options, { ifAvailable: true });
    return new Promise((resolve, reject) => {
      const dispatch = async () => {
        const granted = !unavailable && !held.has(name);
        if (granted) held.add(name);
        try { await callback(granted ? { name } : null); resolve(); }
        catch (error) { reject(error); }
        finally { if (granted) held.delete(name); }
      };
      if (delayed) pending.push(dispatch); else void dispatch();
    });
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(async () => {
    releaseRoom();
    for (const dispatch of pending.splice(0)) void dispatch();
    await new Promise(resolve => setImmediate(resolve));
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  return { held, pending, requests: () => requests, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('room ownership is shared within the page and released while the page stays alive', async t => {
  const locks = locksFor(t), id = uuidv7();
  assert.equal(await holdRoom(id), true);
  assert.equal(await holdRoom(id), true);
  assert.equal(locks.requests(), 1);
  assert.equal(locks.held.has(`room-owner:${id}`), true);
  releaseRoom();
  await locks.flush();
  assert.equal(locks.held.size, 0);
  assert.equal(await holdRoom(id), true);
  assert.equal(locks.requests(), 2);
  const other = uuidv7();
  assert.equal(await holdRoom(other), true);
  await locks.flush();
  assert.equal(locks.held.has(`room-owner:${id}`), false);
  assert.equal(locks.held.has(`room-owner:${other}`), true);
});

test('release cancels a pending claim; its late callback cannot replace or release a newer claim', async t => {
  const locks = locksFor(t, { delayed: true }), id = uuidv7();
  const old = holdRoom(id);
  releaseRoom();
  const newer = holdRoom(id);
  void locks.pending.shift()();
  assert.equal(await old, false);
  await locks.flush();
  assert.equal(locks.held.size, 0);
  void locks.pending.shift()();
  assert.equal(await newer, true);
  assert.equal(await holdRoom(id), true);
  assert.equal(locks.requests(), 2);
  assert.equal(locks.held.has(`room-owner:${id}`), true);
  releaseRoom();
  await locks.flush();
  assert.equal(locks.held.size, 0);
});

test('another tab holding the lock or missing Web Locks never proves ownership', async t => {
  const locks = locksFor(t, { unavailable: true }), id = uuidv7();
  assert.equal(await holdRoom(id), false);
  assert.equal(locks.held.size, 0);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  assert.equal(await holdRoom(id), false);
});
