import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validatedConsoleHandoff } from '../src/client/console-pc-handoff.mjs';

test('Card 12 approved PC takeover mounts only its exact room with a memory capability', () => {
  const sessionId = uuidv7();
  const value = validatedConsoleHandoff({ sessionId, facilitatorToken: 'room-only-capability' },
    { epoch: 2, view: { role: 'facilitator', sessionId, joinCode: '7K3QX9' } },
    { receipt: { receipt: 'accepted' } });
  assert.deepEqual(value, { sessionId, joinCode: '7K3QX9', facilitatorToken: 'room-only-capability' });
  assert.equal('accountJwt' in value, false);
});

test('Card 12 PC handoff refuses wrong room, wrong role and unaccepted takeover', () => {
  const sessionId = uuidv7(), other = uuidv7();
  const pair = { sessionId, facilitatorToken: 'room-only-capability' };
  const snapshot = { epoch: 2, view: { role: 'facilitator', sessionId, joinCode: '7K3QX9' } };
  for (const changed of [
    { ...snapshot, view: { ...snapshot.view, sessionId: other } },
    { ...snapshot, view: { ...snapshot.view, role: 'display' } },
    { ...snapshot, view: { ...snapshot.view, joinCode: 'bad' } },
  ]) assert.equal(validatedConsoleHandoff(pair, changed, { receipt: { receipt: 'accepted' } }), null);
  assert.equal(validatedConsoleHandoff(pair, snapshot, { receipt: { receipt: 'stale_revision' } }), null);
});
