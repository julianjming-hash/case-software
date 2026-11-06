import test from 'node:test';
import assert from 'node:assert/strict';
import { approveDisplayCode } from '../src/client/console-room-tab.mjs';

test('Card 12 facilitator approves only a canonical display code through the room', async () => {
  const sent = [];
  const link = { approveDisplay: async code => { sent.push(code); return { ok: true }; } };
  assert.deepEqual(await approveDisplayCode(link, '7K3Q X9A2'), { ok: true });
  assert.deepEqual(sent, ['7K3QX9A2']);
  assert.deepEqual(await approveDisplayCode(link, '!bad!'), { ok: false, error: 'bad_code' });
  assert.deepEqual(sent, ['7K3QX9A2']);
});
