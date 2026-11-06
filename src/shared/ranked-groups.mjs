// Anonymous complete-order inventories use published authored indices, never labels
// or participant identifiers. Callers provide each latest normalized response once.
import { isUuid } from './ids.mjs';

const ordered = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const boundedInteger = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function eligibleIndicesValid(indices, optionCount) {
  return Array.isArray(indices) && indices.length <= optionCount
    && new Set(indices).size === indices.length
    && [...indices].every(index => boundedInteger(index, optionCount - 1));
}

/** Returns null for an invalid closure; never drops an invalid accepted response. */
export function buildRankedGroups(options, responses, closure = {}) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 8
    || ![...options].every(option => object(option) && isUuid(option.id))
    || !Array.isArray(responses) || responses.length > 300 || !object(closure)) return null;
  const ids = options.map(option => option.id);
  if (new Set(ids).size !== ids.length) return null;
  const { rankCount, eligibleOptionIds } = closure;
  if (!boundedInteger(rankCount, 8) || !Array.isArray(eligibleOptionIds)
    || eligibleOptionIds.length > ids.length || new Set(eligibleOptionIds).size !== eligibleOptionIds.length
    || ![...eligibleOptionIds].every(id => ids.includes(id)) || rankCount > eligibleOptionIds.length) return null;
  if (rankCount === 0) return responses.length === 0 && eligibleOptionIds.length === 0 ? [] : null;
  const eligible = new Set(eligibleOptionIds), counts = new Map();
  for (const response of responses) {
    if (!object(response) || Object.keys(response).length !== 1 || !Object.hasOwn(response, 'order')
      || !Array.isArray(response.order) || response.order.length !== rankCount
      || new Set(response.order).size !== rankCount || ![...response.order].every(id => eligible.has(id))) return null;
    const tuple = response.order.map(id => ids.indexOf(id)).join('');
    counts.set(tuple, (counts.get(tuple) ?? 0) + 1);
  }
  return [...counts].sort(ordered);
}

/** Validate a complete frozen inventory, including its deterministic published order. */
export function validateRankedGroups(groups, closure = {}) {
  if (!object(closure)) return false;
  const { optionCount, rankCount, total } = closure;
  if (!boundedInteger(optionCount, 8) || optionCount === 0 || !boundedInteger(rankCount, 8)
    || !boundedInteger(total, 300)) return false;
  const eligibleIndices = closure.eligibleIndices === undefined ? Array.from({ length: optionCount }, (_, index) => index) : closure.eligibleIndices;
  if (!eligibleIndicesValid(eligibleIndices, optionCount)
    || rankCount > eligibleIndices.length || !Array.isArray(groups) || groups.length > 300) return false;
  if (rankCount === 0) return groups.length === 0 && total === 0 && eligibleIndices.length === 0;
  const eligible = new Set(eligibleIndices), seen = new Set();
  let sum = 0, previous = null;
  for (const row of groups) {
    if (!Array.isArray(row) || row.length !== 2) return false;
    const [tuple, count] = row;
    if (typeof tuple !== 'string' || tuple.length !== rankCount || !/^[0-7]+$/.test(tuple)
      || new Set(tuple).size !== rankCount || ![...tuple].every(index => eligible.has(Number(index)))
      || !Number.isInteger(count) || count < 1 || count > 300 || seen.has(tuple)
      || previous !== null && ordered(previous, row) > 0) return false;
    seen.add(tuple); sum += count; previous = row;
    if (sum > total) return false;
  }
  return sum === total;
}
