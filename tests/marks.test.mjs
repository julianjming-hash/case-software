// The option marks (CASE-088): one mark per position, each a distinct shape AND colour with a name, so
// colour is never the only signal. Their contrast, in both themes, is checked in tests/contrast.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKS, markFor } from '../prototypes/room/lib/marks.mjs';

test('[RT2] eight marks, each a distinct shape, colour and name, every glyph white', () => {
  assert.equal(MARKS.length, 8);
  for (const k of ['shape', 'colour', 'name', 'fill']) assert.equal(new Set(MARKS.map((m) => m[k])).size, 8, k);
  assert.deepEqual(MARKS.slice(0, 4).map((m) => m.name), ['Red triangle', 'Blue diamond', 'Yellow circle', 'Green square']);
  for (const m of MARKS) assert.equal(m.ink, '#ffffff', `${m.name}: white glyph`);
  assert.equal(markFor(9).name, MARKS[1].name, 'positions past eight wrap around');
});
