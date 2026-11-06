// Round 29 (P1-2): one set of words for a draft's case-wide problems, shared by Readiness and the Run preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseWords, fieldWords } from '../src/client/builder-issue-words.mjs';

test('a case-wide field is named with what it needs; anything else is left to its own wording', () => {
  const document = { summary: '', audience: 'Registrars', learning_objectives: ['', 'Recognise anchoring'] };
  assert.equal(caseWords({ at: '/summary', message: 'length must be 1–1200' }, document), 'Write the case summary');
  assert.equal(caseWords({ at: '/learning_objectives/0', message: 'length must be 1–300' }, document), 'Write learning objective 1');
  assert.equal(caseWords({ at: '/learning_objectives', message: 'must have 1–8 items' }, { learning_objectives: [] }), 'Add a learning objective');
  assert.equal(caseWords({ at: '/audience', message: 'length must be 1–200' }, { audience: 'x'.repeat(201) }), 'Audience: Over the 200-character limit');
  assert.equal(caseWords({ at: '/sources/0/rights_status', message: 'source rights remain unresolved' }, {}, { sources: [{ title: 'Record' }] }), 'Source 1 “Record”: source rights remain unresolved');
  for (const at of ['/beats/0/title', '/blocks/3/y_label', '/summary/extra', '']) assert.equal(caseWords({ at, message: 'needs text' }, document), null, at);
});

test('a field\'s own problem reads as words: Required when empty, the limit when over it', () => {
  assert.equal(fieldWords('length must be 1–1200', ''), 'Required.');
  assert.equal(fieldWords('needs text', '  '), 'Required.');
  assert.equal(fieldWords('must be at most 120 characters', 'x'.repeat(121)), 'Over the 120-character limit.');
  assert.equal(fieldWords('contains unsafe control or bidirectional characters', 'a\tb'), 'Contains unsafe control or bidirectional characters.');
  assert.equal(fieldWords('', 'x'), 'This field needs attention.');
});
