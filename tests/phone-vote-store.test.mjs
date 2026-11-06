import test from 'node:test';
import assert from 'node:assert/strict';
import { openVoteStore, VOTE_DATABASE } from '../src/client/vote-store.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

// A minimal asynchronous IDB transaction surface. Real-browser persistence is exercised in e2e.
function database(data, invalid = false) {
  return { close() {}, transaction(name, mode) {
    if (invalid) throw new DOMException('closed', 'InvalidStateError');
    assert.equal(name, 'votes'); assert.ok(['readwrite', 'readonly'].includes(mode));
    let pending = 0; const tx = {};
    const request = operation => {
      const req = {}; pending++;
      queueMicrotask(() => {
        req.result = operation(); req.onsuccess?.(); pending--;
        queueMicrotask(() => { if (!pending) tx.oncomplete?.(); });
      });
      return req;
    };
    tx.objectStore = () => ({
      index: name => { assert.equal(name, 'roomId'); return { getAll: room => request(() => [...data.values()].filter(row => row.roomId === room).map(row => structuredClone(row))) }; },
      delete: id => request(() => data.delete(id)),
      put: row => request(() => data.set(row.envelope.clientEventId, structuredClone(row))),
    });
    return tx;
  } };
}

test('durable vote transactions reopen a closed handle once and serialize competing room updates', async () => {
  const data = new Map(); let opens = 0;
  const store = openVoteStore({ openDatabase: async () => database(data, ++opens === 1) });
  const roomId = uuidv7(), otherRoom = uuidv7();
  assert.deepEqual(await store.read(roomId), []);
  const append = room => store.update(room, rows => ({ rows: [...rows, { roomId: room, envelope: { clientEventId: uuidv7() } }], result: rows.length + 1 }));
  assert.deepEqual(await Promise.all([append(roomId), append(roomId)]), [1, 2]);
  assert.equal(opens, 2); await append(otherRoom);
  const count = await store.update(roomId, rows => ({ rows, result: rows.length })); assert.equal(count, 2);
  assert.equal((await store.read(roomId)).length, 2); assert.equal(data.size, 3); assert.equal(VOTE_DATABASE, 'case:phone-outbox'); await store.close();
});

test('failed vote transaction exposes failure without changing the durable rows', async () => {
  const data = new Map(), store = openVoteStore({ openDatabase: async () => database(data) });
  await assert.rejects(store.update(uuidv7(), () => { throw new Error('Outbox full'); }), /Outbox full/);
  assert.equal(data.size, 0); await store.close();
});
