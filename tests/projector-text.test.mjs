import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/shared/text.mjs';
import { cleanText as legacyCleanText } from '../src/shared/room-machine.mjs';

test('projector small text module preserves the legacy sanitizer binding and exact behavior', () => {
  assert.equal(cleanText, legacyCleanText);
  assert.equal(cleanText(null, 20), '');
  assert.equal(cleanText(123, 20), '123');
  assert.equal(cleanText(' e\u0301  team\t name ', 20), 'é team name');
  assert.equal(cleanText('A\u0000B\u0085C\u202eD\u2066E\ufeffF\ud800G\udc00H', 100), 'A B C D E F G H');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText('😀x', 1), '\ud83d');
});
