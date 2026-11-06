import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, testLifecycle } from '../src/client/transport.mjs';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';

class IdleSocket { addEventListener() {} close() {} }
const frame = (epoch, revision, displayRevision) => ({ v: 1, t: 'snapshot', epoch, revision, displayRevision, view: {} });

for (const old of [frame(0, 99, 99), frame(2, 30, 99), frame(2, 31, 1)]) {
  test(`forced refetch cannot roll back a newer snapshot: ${old.epoch}/${old.revision}/${old.displayRevision}`, async () => {
    let release, calls = 0, emitted = 0;
    const held = new Promise(resolve => { release = resolve; });
    const current = frame(2, 31, 2);
    const link = connect({ role: 'participant', api: 'https://case.test', sessionId: uuidv7(), token: newCapabilityToken(),
      storage: null, persistentStorage: null, lifecycle: testLifecycle(), WebSocketImpl: IdleSocket, telemetryImpl: () => {},
      fetchImpl: async () => ++calls === 1 ? held : Response.json(current) });
    link.on('snapshot', () => { emitted++; });
    try {
      const pending = link.refetch();
      assert.equal(await link.refetch(), true);
      assert.deepEqual(link.snapshot, current);
      release(Response.json(old));
      assert.equal(await pending, true, 'the HTTP response arrived, but its stale state must not replace current state');
      assert.deepEqual(link.snapshot, current);
      assert.equal(emitted, 1, 'no stale snapshot is rendered or used to fence subsequent commands');
    } finally { release(Response.json(old)); link.close(); }
  });
}

test('forced refetch still re-emits equal state and accepts a newer epoch', async () => {
  let value = frame(0, 9, 2), emitted = 0;
  const link = connect({ role: 'participant', api: 'https://case.test', sessionId: uuidv7(), token: newCapabilityToken(),
    storage: null, persistentStorage: null, lifecycle: testLifecycle(), WebSocketImpl: IdleSocket, telemetryImpl: () => {},
    fetchImpl: async () => Response.json(value) });
  link.on('snapshot', () => { emitted++; });
  try {
    await link.refetch(); await link.refetch();
    assert.equal(emitted, 2, 'forced refresh preserves its equal-state notification contract');
    value = frame(1, 1, 0); await link.refetch();
    assert.deepEqual(link.snapshot, value); assert.equal(emitted, 3);
  } finally { link.close(); }
});
