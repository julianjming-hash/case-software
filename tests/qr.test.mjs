// QR encoder structure tests (no decoder dependency; decode round-trips were checked with jsQR in a scratch folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrEncode, formatBits } from '../prototypes/room/lib/qr.mjs';
import { joinUrl, qrPayload } from '../src/shared/urls.mjs';

const PAYLOAD = qrPayload(joinUrl('7K3QX9'));

function finderAt(m, r0, c0) {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
    if (m[r0 + r][c0 + c] !== (ring !== 2)) return false;
  }
  return true;
}

test('the join payload is version 2-M (25 x 25)', () => {
  assert.equal(PAYLOAD, 'HTTPS://CASE.IATROGENIC.APP/J/7K3QX9');
  assert.equal(PAYLOAD.length, 36);
  const e = qrEncode(PAYLOAD);
  assert.equal(e.version, 2);
  assert.equal(e.size, 25);
  assert.equal(e.matrix.length, 25);
  assert.ok(e.matrix.every((row) => row.length === 25 && row.every((v) => typeof v === 'boolean')));
});

test('size grows with the version: 21, 25, 29, 33', () => {
  const sizeOf = (s) => qrMatrix(s).length;
  assert.equal(sizeOf('A'), 21);
  assert.equal(sizeOf('A'.repeat(30)), 25);
  assert.equal(sizeOf('A'.repeat(40)), 29);
  assert.equal(sizeOf('A'.repeat(70)), 33);
  assert.throws(() => qrMatrix('A'.repeat(200)), RangeError);
});

test('three finder patterns, timing lines, light separators and the dark module', () => {
  const m = qrMatrix(PAYLOAD);
  const n = m.length;
  assert.ok(finderAt(m, 0, 0) && finderAt(m, 0, n - 7) && finderAt(m, n - 7, 0));
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7][i], false); assert.equal(m[i][7], false);
    assert.equal(m[7][n - 1 - i], false); assert.equal(m[i][n - 8], false);
    assert.equal(m[n - 8][i], false); assert.equal(m[n - 1 - i][7], false);
  }
  for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
  assert.equal(m[n - 8][8], true);
  // Version 2 alignment pattern centred at (18, 18).
  assert.equal(m[18][18], true); assert.equal(m[17][17], false); assert.equal(m[16][16], true);
});

test('format information carries level M and the chosen mask, in both copies', () => {
  // ISO/IEC 18004 Annex C: level M mask 0 is 101010000010010 and mask 5 is 100000011001110.
  assert.equal(formatBits(0).toString(2).padStart(15, '0'), '101010000010010');
  assert.equal(formatBits(5).toString(2).padStart(15, '0'), '100000011001110');
  const { matrix: m, mask } = qrEncode(PAYLOAD);
  const n = m.length;
  const bits = formatBits(mask);
  const copyA = []; const copyB = [];
  for (let i = 0; i <= 5; i++) copyA[i] = m[i][8];
  copyA[6] = m[7][8]; copyA[7] = m[8][8]; copyA[8] = m[8][7];
  for (let i = 9; i < 15; i++) copyA[i] = m[8][14 - i];
  for (let i = 0; i < 8; i++) copyB[i] = m[8][n - 1 - i];
  for (let i = 8; i < 15; i++) copyB[i] = m[n - 15 + i][8];
  const want = Array.from({ length: 15 }, (_, i) => ((bits >>> i) & 1) === 1);
  assert.deepEqual(copyA, want);
  assert.deepEqual(copyB, want);
  // The 5 data bits (top of the unmasked word) decode to EC level M (00) and the mask.
  assert.equal(((bits ^ 0x5412) >>> 13) & 0b11, 0b00);
  assert.equal(((bits ^ 0x5412) >>> 10) & 0b111, mask);
});

test('deterministic, and different payloads give different symbols', () => {
  assert.deepEqual(qrMatrix(PAYLOAD), qrMatrix(PAYLOAD));
  assert.notDeepEqual(qrMatrix(PAYLOAD), qrMatrix(qrPayload(joinUrl('7K3QX8'))));
});

test('byte-mode fallback for non-alphanumeric text still encodes', () => {
  assert.equal(qrMatrix('hello').length, 21);
});
