import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { displayApproval } from '../src/client/pair.mjs';
test('display pairing accepts only an exact bounded credential response', () => {
  const credential = { sessionId: uuidv7(), token: newCapabilityToken() };
  assert.deepEqual(displayApproval(credential), credential);
  for (const value of [null, { pending: true }, { ...credential, casePack: {} }, { ...credential, token: 'secret?in=url' }, { ...credential, sessionId: '../facilitate' }]) assert.equal(displayApproval(value), null);
});
