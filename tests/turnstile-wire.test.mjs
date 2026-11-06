import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJoinRequest, WIRE_VERSION } from '../src/shared/wire.mjs';
import { newCapabilityToken } from '../src/shared/ids.mjs';
const body = () => ({ v: WIRE_VERSION, code: 'ABC123', displayName: 'Sam', avatarId: 'shadows-01' });

test('join wire keeps the legacy shape and carries an optional bounded Turnstile token only in JSON', () => {
  assert.deepEqual(parseJoinRequest(body()), { ok: true, code: 'ABC123', displayName: 'Sam', avatarId: 'shadows-01' });
  const token = newCapabilityToken();
  assert.deepEqual(parseJoinRequest({ ...body(), turnstileToken: token }), { ok: true, code: 'ABC123', displayName: 'Sam', avatarId: 'shadows-01', turnstileToken: token });
  assert.equal(parseJoinRequest({ ...body(), turnstileToken: 'x'.repeat(2048) }).ok, true);
});

test('join wire rejects empty, nonstring, oversized and control-bearing Turnstile tokens', () => {
  for (const turnstileToken of ['', null, 42, {}, 'x'.repeat(2049), 'a\nb']) {
    assert.deepEqual(parseJoinRequest({ ...body(), turnstileToken }), { ok: false, error: 'bad_turnstile_token' });
  }
});
