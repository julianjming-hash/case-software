import test from 'node:test';
import assert from 'node:assert/strict';
import { reopenOnce } from '../src/client/idb.mjs';
test('a closed IndexedDB handle reopens exactly once and a second failure surfaces', async () => {
  let opens = 0; const db = reopenOnce(async () => ({ id: ++opens, close() {} }));
  assert.equal(await db.run(handle => { if (handle.id === 1) throw new DOMException('closed', 'InvalidStateError'); return handle.id; }), 2);
  assert.equal(opens, 2); await db.close();
  const broken = reopenOnce(async () => ({ close() {} })); let calls = 0;
  await assert.rejects(broken.run(() => { calls++; throw new DOMException('closed', 'InvalidStateError'); }), /closed/); assert.equal(calls, 2);
});
test('unrelated IndexedDB failures never reopen and concurrent invalidation shares one reopen', async () => {
  let opens = 0; const db = reopenOnce(async () => ({ id: ++opens, close() {} }));
  await assert.rejects(db.run(() => { throw new Error('quota'); }), /quota/); assert.equal(opens, 1);
  const results = await Promise.all(Array.from({ length: 10 }, () => db.run(handle => { if (handle.id === 1) throw new DOMException('closed', 'InvalidStateError'); return handle.id; })));
  assert.deepEqual(results, Array(10).fill(2)); assert.equal(opens, 2); await db.close();
});
