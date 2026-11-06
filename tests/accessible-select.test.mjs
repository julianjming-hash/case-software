import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveChoice, searchChoice, selectPresentation } from '../src/client/accessible-select.mjs';
const choices = [{ label: 'All groups', disabled: false }, { label: 'Archived', disabled: true },
  { label: 'Cardiology', disabled: false }, { label: 'Critical care', disabled: false }];
test('rich option decoration is bounded, uses known icons/tones, and never interprets markup', () => {
  assert.deepEqual(selectPresentation({ dataset: { tone: 'ok', icon: 'check', description: '  <strong>Ready</strong>  ' } }),
    { tone: 'ok', icon: 'check', description: '<strong>Ready</strong>' });
  assert.deepEqual(selectPresentation({ dataset: { tone: 'unknown', icon: '<svg>', description: 123 } }),
    { tone: null, icon: null, description: '' });
  assert.equal([...selectPresentation({ dataset: { description: '🙂'.repeat(300) } }).description].length, 240);
});
test('[AS-117] select navigation skips disabled choices in both directions and wraps', () => {
  assert.equal(moveChoice(choices, 0, 1), 2); assert.equal(moveChoice(choices, 2, -1), 0);
  assert.equal(moveChoice(choices, 3, 1), 0); assert.equal(moveChoice(choices, 0, -1), 3);
  assert.equal(moveChoice(choices, -1, 1), 0);
  assert.equal(moveChoice(choices, -1, -1), 3);
  assert.equal(moveChoice([{ disabled: true }], 0, 1), -1); assert.equal(moveChoice([], 0, 1), -1);
});
test('typeahead searches after the current choice, wraps and ignores disabled matches', () => {
  assert.equal(searchChoice(choices, 0, 'c'), 2); assert.equal(searchChoice(choices, 2, 'C'), 3);
  assert.equal(searchChoice(choices, 3, 'card'), 2); assert.equal(searchChoice(choices, 0, 'arch'), 0);
  assert.equal(searchChoice(choices, 2, 'missing'), 2);
});
