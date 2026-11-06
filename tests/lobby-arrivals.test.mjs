import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalFeedback } from '../src/client/lobby-arrivals.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const sessionId = uuidv7();
const view = (count, names) => ({ sessionId, epoch: 0, phase: 'waiting', arrivalCount: count,
  names: names.map(name => ({ name, avatarId: null })) });

test('Card24 arrivals seed silently and animate only proven appended visible rows', () => {
  const first = view(2, ['Same', 'Same']);
  assert.equal(arrivalFeedback(null, first), null);
  assert.deepEqual(arrivalFeedback(first, view(4, ['Same', 'Same', 'Same', 'New'])), { count: 2, indices: [2, 3], overflow: 0 });
  assert.equal(arrivalFeedback(first, { ...first, epoch: 1 }), null);
  assert.equal(arrivalFeedback(first, { ...first, sessionId: uuidv7() }), null);
  assert.equal(arrivalFeedback(first, { ...first, phase: 'live' }), null);
});

test('Card24 ambiguous coalesced arrivals never label an old identity as new', () => {
  const first = view(2, ['Same', 'Same']);
  assert.deepEqual(arrivalFeedback(first, view(3, ['Same', 'New'])), { count: 1, indices: [], overflow: 1 });
  assert.deepEqual(arrivalFeedback(first, view(3, ['Renamed', 'Same', 'New'])), { count: 1, indices: [], overflow: 1 });
  assert.deepEqual(arrivalFeedback(first, view(3, ['Same'])), { count: 1, indices: [], overflow: 1 });
  assert.equal(arrivalFeedback(first, view(2, ['Renamed'])), null);
});

test('Card24 arrival feedback remains bounded across overflow and reduced motion', () => {
  const first = view(11, Array(11).fill('Same'));
  const next = view(14, Array(14).fill('Same'));
  assert.deepEqual(arrivalFeedback(first, next), { count: 3, indices: [11], overflow: 2 });
  assert.deepEqual(arrivalFeedback(first, next, { reducedMotion: true }), { count: 3, indices: [], overflow: 3 });
  assert.equal(arrivalFeedback(first, { ...next, arrivalCount: 301 }), null);
});
