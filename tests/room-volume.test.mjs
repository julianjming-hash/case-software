import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVolume, writeVolume, DEFAULT_VOLUME } from '../src/client/room-volume.mjs';
const store = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; };

test('volume defaults to the shipped cue level and persists per device', () => {
  const s = store();
  assert.equal(readVolume(s), DEFAULT_VOLUME); assert.equal(DEFAULT_VOLUME, 1);
  writeVolume(s, .35); assert.equal(readVolume(s), .35);
});
test('a bad stored value falls back; values clamp to 0..1', () => {
  const s = store();
  for (const bad of ['', 'abc', '-1', '2', 'NaN', 'Infinity']) { s.setItem('case-room-volume', bad); assert.equal(readVolume(s), DEFAULT_VOLUME, bad); }
  writeVolume(s, 7); assert.equal(readVolume(s), 1); writeVolume(s, -3); assert.equal(readVolume(s), 0);
});
test('unavailable or throwing storage never throws', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.equal(readVolume(broken), DEFAULT_VOLUME); assert.doesNotThrow(() => writeVolume(broken, .5));
  assert.equal(readVolume(null), DEFAULT_VOLUME); assert.doesNotThrow(() => writeVolume(undefined, .5));
});
