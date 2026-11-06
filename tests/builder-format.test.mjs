import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formattedTextPlainText, validateFormattedText } from '../src/shared/builder-format.mjs';

test('paragraphs preserve exact run order, whitespace and bold marks', () => {
  const value = { blocks: [{ type: 'paragraph', runs: [
    { text: ' keep ' }, { text: 'this', bold: true }, { text: '\n exactly' },
  ] }] };
  assert.deepEqual(validateFormattedText(value), []);
  assert.equal(formattedTextPlainText(value), ' keep this\n exactly');
});

test('ordered and unordered lists are accepted without nested list support', () => {
  for (const ordered of [true, false]) {
    const value = { blocks: [{ type: 'list', ordered, items: [{ runs: [{ text: 'first' }] }, { runs: [{ text: 'second' }] }] }] };
    assert.deepEqual(validateFormattedText(value), []);
    assert.equal(formattedTextPlainText(value), 'first\nsecond');
  }
});

test('empty formatted content is preservable', () => {
  assert.deepEqual(validateFormattedText({ blocks: [] }), []);
  assert.equal(formattedTextPlainText({ blocks: [] }), '');
});

test('unknown fields, block kinds and malformed run types refuse instead of flattening', () => {
  const invalid = [
    { blocks: [{ type: 'html', html: '<b>x</b>' }] },
    { blocks: [{ type: 'paragraph', runs: [{ text: 'x', italic: true }] }] },
    { blocks: [{ type: 'paragraph', runs: [{ text: 1 }] }] },
    { blocks: [{ type: 'list', ordered: false, items: [{ runs: [{ text: 'x' }], children: [] }] }] },
    { blocks: [{ type: 'paragraph', runs: [] }], extra: true },
  ];
  for (const value of invalid) assert.ok(validateFormattedText(value).length > 0);
});

test('block, list-item, run and byte caps return path-specific issues', () => {
  assert.ok(validateFormattedText({ blocks: Array.from({ length: 2 }, () => ({ type: 'paragraph', runs: [{ text: 'x' }] })) }, { maxBlocks: 1 }).some(x => x.code === 'too_many_blocks'));
  assert.ok(validateFormattedText({ blocks: [{ type: 'list', ordered: false, items: [{ runs: [{ text: 'x' }] }, { runs: [{ text: 'y' }] }] }] }, { maxItems: 1 }).some(x => x.code === 'too_many_items'));
  assert.ok(validateFormattedText({ blocks: [{ type: 'paragraph', runs: [{ text: 'a' }, { text: 'b' }] }] }, { maxRuns: 1 }).some(x => x.code === 'too_many_runs'));
  assert.ok(validateFormattedText({ blocks: [{ type: 'paragraph', runs: [{ text: 'éé' }] }] }, { maxBytes: 3 }).some(x => x.code === 'too_large'));
});
