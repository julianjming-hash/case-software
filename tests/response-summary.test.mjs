import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseSummary } from '../src/client/response-summary.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

test('Card24 closed result copy contains anonymous counts and no route or answer text', () => {
  const summary = responseSummary({ type: 'free_text', total: 2, counts: [], text: 'Private answer',
    suggestion: 'Hidden route', howChosen: 'majority', whatHappened: 'Unrevealed consequence' });
  assert.deepEqual(summary, { heading: 'Responses closed', caption: '2 answered', rows: [] });
  assert.equal(JSON.stringify(summary).includes('Private'), false);
  assert.equal(JSON.stringify(summary).includes('Unrevealed'), false);
});

test('Card24 ranking copy labels every allowed position including zeros', () => {
  const optionId = uuidv7();
  const summary = responseSummary({ type: 'ranking', total: 3, rankCount: 3,
    counts: [{ optionId, label: 'Choice', count: 2, positionCounts: [2, 0, 1] }] });
  assert.equal(summary.caption, '3 answered · counts by ranking position');
  assert.deepEqual(summary.rows[0], { optionId, label: 'Choice', count: 2,
    positions: [{ rank: 1, count: 2, words: 'Rank 1: 2' }, { rank: 2, count: 0, words: 'Rank 2: 0' }, { rank: 3, count: 1, words: 'Rank 3: 1' }] });
});

test('Card24 single and multi-select copy preserve count meanings without clinical scoring', () => {
  for (const [type, caption, words] of [['single_choice', '1 answered', '1'], ['multi_select', '1 answered · each person could select more than one', 'selected by 1']]) {
    const summary = responseSummary({ type, total: 1, counts: [{ optionId: uuidv7(), label: 'Choice', count: 1, positionCounts: null }] });
    assert.equal(summary.caption, caption); assert.equal(summary.rows[0].words, words);
  }
  assert.equal(responseSummary({ type: 'single_choice', total: 0, counts: [] }).caption, 'No one answered');
});

test('empty results say only No one answered',()=>{
 for(const type of ['free_text','ranking','multi_select','single_choice'])assert.equal(responseSummary({type,total:0,counts:[]}).caption,'No one answered');
});
