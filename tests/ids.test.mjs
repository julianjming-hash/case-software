import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROCKFORD, uuidv7, isUuidV7, uuidv7Time, newJoinCode, newPairCode, normalizeCode,
  formatCode, newCapabilityToken, hashToken, JOIN_CODE_LENGTH, PAIR_CODE_LENGTH,
} from '../src/shared/ids.mjs';

test('uuidv7 is RFC 9562 v7 with variant 10', () => {
  for (let i = 0; i < 1000; i++) assert.ok(isUuidV7(uuidv7()));
});

test('uuidv7 is strictly increasing within one millisecond and across a clock step back', () => {
  const t = Date.now() + 10_000;
  let prev = uuidv7(t);
  for (let i = 0; i < 5000; i++) {
    const next = uuidv7(i % 7 === 0 ? t - 50 : t);
    assert.ok(next > prev, `${next} <= ${prev}`);
    prev = next;
  }
});

test('codes use only Crockford characters and the right lengths', () => {
  for (let i = 0; i < 500; i++) {
    const j = newJoinCode();
    const p = newPairCode();
    assert.equal(j.length, JOIN_CODE_LENGTH);
    assert.equal(p.length, PAIR_CODE_LENGTH);
    for (const c of j + p) assert.ok(CROCKFORD.includes(c));
  }
});

test('normalizeCode tolerates case, separators and O/I/L confusion', () => {
  assert.equal(normalizeCode('7k3-qx9', 6), '7K3QX9');
  assert.equal(normalizeCode(' 7K3 QX9 ', 6), '7K3QX9');
  assert.equal(normalizeCode('O1LI23', 6), '011123');
  assert.equal(normalizeCode('7K3QX', 6), null);
  assert.equal(normalizeCode('7K3QXU', 6), null); // U is not Crockford
  assert.equal(normalizeCode(42, 6), null);
});

test('formatCode groups for reading aloud', () => {
  assert.equal(formatCode('7K3QX9'), '7K3 QX9');
  assert.equal(formatCode('ABCD2345'), 'ABCD 2345');
});

test('capability tokens are 256-bit base64url and hash to 64 hex chars', async () => {
  const t = newCapabilityToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.match(await hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(newCapabilityToken(), t);
});

// Runs last: a far-future timestamp moves this process's monotonic clamp forward.
test('uuidv7 embeds its timestamp', () => {
  // Far future so the per-process monotonic clamp cannot interfere.
  const t = Date.UTC(2099, 0, 1);
  assert.equal(uuidv7Time(uuidv7(t)), t);
});
