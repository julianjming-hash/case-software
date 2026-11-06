import test from 'node:test';
import assert from 'node:assert/strict';
import { mintElevation, verifyElevation, recordElevation } from '../src/worker/admin/stepup.mjs';
import { newCapabilityToken, isUuidV7, uuidv7 } from '../src/shared/ids.mjs';

const secret = newCapabilityToken();
const session = uuidv7(), otherSession = uuidv7();

test('[PM-38] R-a: one elevation covers the whole sign-in session for its admin, and nothing else', async () => {
  const { token, jti } = await mintElevation('admin@example.test', session, secret);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(isUuidV7(jti));
  // Every destructive admin action in this session: the same token verifies, repeatedly, with no clock.
  for (let n = 0; n < 3; n++) assert.deepEqual(await verifyElevation(token, 'admin@example.test', session, secret), { jti });
  // Never another session (no replay across sessions), another email, another scope or another secret.
  assert.equal(await verifyElevation(token, 'admin@example.test', otherSession, secret), false);
  assert.equal(await verifyElevation(token, 'other@example.test', session, secret), false);
  assert.equal(await verifyElevation(token, 'Admin@example.test', session, secret), false);
  assert.equal(await verifyElevation(token, 'admin@example.test', session, secret, { scope: `owner:${uuidv7()}` }), false);
  assert.equal(await verifyElevation(token, 'admin@example.test', session, newCapabilityToken()), false);
  assert.equal(await verifyElevation(token, 'admin@example.test', null, secret), false);
});

test('Card 21a elevation refuses forgery, missing config and a malformed payload', async () => {
  const { token } = await mintElevation('admin@example.test', session, secret);
  const [payload, signature] = token.split('.');
  const forged = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(await verifyElevation(`${payload}.${forged}`, 'admin@example.test', session, secret), false);
  assert.equal(await verifyElevation(token, 'admin@example.test', session, ''), false);
  assert.equal(await verifyElevation('bad', 'admin@example.test', session, secret), false);
  await assert.rejects(mintElevation('admin@example.test', null, secret), TypeError);
  // An owner elevation (card 32's scope) never satisfies an admin route.
  const workspace = uuidv7();
  const owner = await mintElevation('owner@example.test', session, secret, { scope: `owner:${workspace}` });
  assert.ok(await verifyElevation(owner.token, 'owner@example.test', session, secret, { scope: `owner:${workspace}` }));
  assert.equal(await verifyElevation(owner.token, 'owner@example.test', session, secret), false);
});

test('[PM-38] an issued elevation is recorded before use; any failure refuses', async () => {
  const calls = [];
  const rpc = { call: async (name, args) => { calls.push([name, args]); return { ok: true, data: true }; } };
  const jti = uuidv7();
  assert.equal(await recordElevation(rpc, { jti, email: 'admin@example.test', sessionId: session }), true);
  assert.deepEqual(calls[0], ['record_admin_elevation', { p_jti: jti, p_actor_email: 'admin@example.test', p_scope: 'admin', p_session_id: session }]);
  assert.equal(await recordElevation({ call: async () => ({ ok: true, data: false }) }, { jti, email: 'admin@example.test', sessionId: session }), false);
  assert.equal(await recordElevation({ call: async () => { throw new Error('down'); } }, { jti, email: 'admin@example.test', sessionId: session }), false);
});
