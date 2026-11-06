import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { findOwnedRoom } from '../src/client/account-session.mjs';

test('Card 12 saved manual room is matched only through bounded verified owner pages', async () => {
  const first = uuidv7(), target = uuidv7(), calls = [];
  const room = await findOwnedRoom(target, async after => {
    calls.push(after);
    return after ? { rooms: [{ sessionId: target, joinCode: '7K3QX9', expiresAt: '2030-01-01T00:00:00Z' }],
      nextAfter: null } : { rooms: [{ sessionId: first, joinCode: '9M2PZ7', expiresAt: '2030-01-01T00:00:00Z' }],
      nextAfter: first };
  }, { nowMs: Date.parse('2026-10-03T00:00:00Z') });
  assert.deepEqual(room, { sessionId: target, joinCode: '7K3QX9', expiresAt: '2030-01-01T00:00:00Z' });
  assert.deepEqual(calls, [null, first]);
  let pageCount = 0;
  await assert.rejects(findOwnedRoom(target, async () => {
    pageCount++;
    const sessionId = uuidv7();
    return { rooms: [{ sessionId, joinCode: '9M2PZ7', expiresAt: '2030-01-01T00:00:00Z' }], nextAfter: sessionId };
  }), /owner_pages_incomplete/);
  assert.equal(pageCount, 20, 'incomplete paging must stop at the ownership-discovery bound');
});

test('Card 12 nonowner, expired and malformed owner pages cannot restore a tab segment', async () => {
  const target = uuidv7();
  assert.equal(await findOwnedRoom(target, async () => ({ rooms: [], nextAfter: null })), null);
  await assert.rejects(findOwnedRoom(target, async () => ({ rooms: [{ sessionId: target,
    joinCode: '7K3QX9', expiresAt: '2000-01-01T00:00:00Z' }], nextAfter: null })));
  await assert.rejects(findOwnedRoom(target, async () => ({ rooms: [], nextAfter: target })));
  const nowMs = Date.parse('2026-10-08T00:00:00Z');
  for (const expiresAt of ['not-a-date', '+275761-01-01T00:00:00Z', '2026-10-08T00:00:00Z', '', null, 0]) {
    await assert.rejects(findOwnedRoom(target, async () => ({ rooms: [{ sessionId: target,
      joinCode: '7K3QX9', expiresAt }], nextAfter: null }), { nowMs }), /invalid_owner_page/);
  }
});
