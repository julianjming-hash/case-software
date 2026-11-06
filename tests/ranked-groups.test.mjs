import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { buildRankedGroups, validateRankedGroups } from '../src/shared/ranked-groups.mjs';

const options = count => Array.from({ length: count }, () => ({ id: uuidv7(), label: 'Repeated label' }));
const payload = (authored, tuple) => ({ order: [...tuple].map(index => authored[Number(index)].id) });
const config = (authored, rankCount = authored.length) => ({ rankCount, eligibleOptionIds: authored.map(option => option.id) });

test('[AS-090] Card25 grouping counts identical complete orders and every fixed length from two through eight', () => {
  const authored = options(3), rows = [];
  for (const [tuple, count] of [['012', 10], ['021', 5], ['102', 2], ['210', 1]]) {
    for (let i = 0; i < count; i++) rows.push(payload(authored, tuple));
  }
  assert.deepEqual(buildRankedGroups(authored, rows, config(authored)), [['012', 10], ['021', 5], ['102', 2], ['210', 1]]);
  for (let rankCount = 2; rankCount <= 8; rankCount++) {
    const full = options(8), tuple = '01234567'.slice(0, rankCount);
    assert.deepEqual(buildRankedGroups(full, [payload(full, tuple), payload(full, tuple)], config(full, rankCount)), [[tuple, 2]]);
  }
});

test('Card25 grouping uses authored-index ties independent of labels and arrival without mutating inputs', () => {
  const authored = options(3), rows = ['210', '102', '021', '012', '012'].map(tuple => payload(authored, tuple));
  const before = JSON.stringify({ authored, rows });
  const expected = [['012', 2], ['021', 1], ['102', 1], ['210', 1]];
  assert.deepEqual(buildRankedGroups(authored, rows, config(authored)), expected);
  assert.deepEqual(buildRankedGroups(authored, [...rows].reverse(), config(authored)), expected);
  authored.forEach((option, index) => { option.label = ['Zulu', 'Alpha', 'Zulu'][index]; });
  assert.deepEqual(buildRankedGroups(authored, rows, config(authored)), expected);
  authored.forEach(option => { option.label = 'Repeated label'; });
  assert.equal(JSON.stringify({ authored, rows }), before);
  assert.ok(!JSON.stringify(expected).includes(authored[0].id), 'inventory stores no option UUID or participant discriminator');
});

test('Card25 grouping rejects invalid closure payloads rather than shortening or silently excluding an accepted order', () => {
  const authored = options(3), good = payload(authored, '012'), closure = config(authored);
  for (const bad of [null, {}, { order: [] }, payload(authored, '01'), { order: [...good.order, authored[0].id] },
    payload(authored, '001'), { order: [authored[0].id, authored[1].id, uuidv7()] }, { order: '012' },
    { order: good.order, participantId: uuidv7() }]) {
    assert.equal(buildRankedGroups(authored, [good, bad], closure), null);
  }
  assert.equal(buildRankedGroups(authored, [good], { ...closure, eligibleOptionIds: closure.eligibleOptionIds.slice(0, 2) }), null);
  assert.equal(buildRankedGroups(authored, [], { rankCount: 2, eligibleOptionIds: [authored[0].id] }), null, 'explicit count is never shrunk');
  for (const bad of [{ ...closure, rankCount: 9 }, { ...closure, rankCount: 1.5 }, { ...closure, eligibleOptionIds: [uuidv7()] },
    { ...closure, eligibleOptionIds: [authored[0].id, authored[0].id] }, null]) assert.equal(buildRankedGroups(authored, [good], bad), null);
  assert.equal(buildRankedGroups([authored[0], authored[0]], [], config([authored[0], authored[0]])), null);
  assert.equal(buildRankedGroups(authored, Array(301).fill(good), closure), null);
});

test('Card25 grouping and validation preserve a one-item legacy order and proven empty zero-eligible closure', () => {
  const authored = options(3), eligible = [authored[2].id];
  assert.deepEqual(buildRankedGroups(authored, [payload(authored, '2')], { rankCount: 1, eligibleOptionIds: eligible }), [['2', 1]]);
  assert.equal(validateRankedGroups([['2', 1]], { optionCount: 3, rankCount: 1, total: 1, eligibleIndices: [2] }), true);
  assert.deepEqual(buildRankedGroups(authored, [], { rankCount: 0, eligibleOptionIds: [] }), []);
  assert.equal(validateRankedGroups([], { optionCount: 3, rankCount: 0, total: 0, eligibleIndices: [] }), true);
  assert.equal(buildRankedGroups(authored, [{ order: [] }], { rankCount: 0, eligibleOptionIds: [] }), null);
  assert.equal(buildRankedGroups(authored, [], { rankCount: 0, eligibleOptionIds: eligible }), null);
  assert.equal(validateRankedGroups([], { optionCount: 3, rankCount: 0, total: 0 }), false);
  assert.equal(validateRankedGroups([], { optionCount: 3, rankCount: 0, total: 1, eligibleIndices: [] }), false);
  assert.deepEqual(buildRankedGroups(authored, [], config(authored)), []);
});

function permutations(prefix = '', remaining = '01234567', result = []) {
  if (!remaining.length) result.push(prefix);
  else for (const index of remaining) {
    if (result.length >= 300) break;
    permutations(prefix + index, remaining.replace(index, ''), result);
  }
  return result;
}

test('Card25 compact inventory retains all three hundred distinct legal eight-position orders', () => {
  const authored = options(8), tuples = permutations(), rows = tuples.map(tuple => payload(authored, tuple));
  assert.equal(new Set(tuples).size, 300);
  const actual = buildRankedGroups(authored, rows, config(authored));
  assert.deepEqual(actual, tuples.map(tuple => [tuple, 1]));
  assert.equal(validateRankedGroups(actual, { optionCount: 8, rankCount: 8, total: 300 }), true);
  assert.equal(new TextEncoder().encode(JSON.stringify(actual)).length, 4501, 'pure histogram bytes only; full state/frame/archive measured separately');
});

test('Card25 inventory validation refuses corrupt tuple dimensions, eligibility, totals, sorting and duplicate groups', () => {
  const args = { optionCount: 3, rankCount: 3, total: 3 }, good = [['012', 2], ['021', 1]];
  assert.equal(validateRankedGroups(good, args), true);
  for (const bad of [null, {}, [['012', 2]], [['012', 3], ['021', 1]], [['012', 1], ['021', 2]], [['021', 2], ['012', 2]],
    [['012', 2], ['012', 1]], [['001', 2], ['021', 1]], [['013', 2], ['021', 1]], [['01', 2], ['021', 1]],
    [['0123', 2], ['021', 1]], [[['0', '1', '2'], 2], ['021', 1]], [['01x', 2], ['021', 1]],
    [['012', 0], ['021', 3]], [['012', -1], ['021', 4]], [['012', 1.5], ['021', 1.5]], [['012', 2, 'private'], ['021', 1]]]) {
    assert.equal(validateRankedGroups(bad, args), false);
  }
  assert.equal(validateRankedGroups([['012', 301]], { ...args, total: 301 }), false);
  for (const bad of [{ ...args, optionCount: 9 }, { ...args, optionCount: 0 }, { ...args, optionCount: Infinity }, { ...args, rankCount: 9 },
    { ...args, total: 3.5 }, { ...args, eligibleIndices: [0, 1] }, { ...args, eligibleIndices: [0, 0, 2] },
    { ...args, eligibleIndices: [0, 1, 8] }, { ...args, eligibleIndices: null }, null]) assert.equal(validateRankedGroups(good, bad), false);
});
