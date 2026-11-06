/** Shared density for the same deliberate page on every display. CASE-327 (Julian, 2026-11-01): ordinary labels show up to five
 *  positions (three under a long prompt), since rows take their own height; typographic punctuation, arrows and maths signs
 *  (an en dash, ≥) read as Latin. A long or non-Latin label keeps the conservative density. */
export function rankedLayout(options, rankCount, prompt = '') {
  const wide = options.some(option => [...option.label].length > 54 || /[^\u0020-\u024f\u2000-\u206f\u2070-\u20cf\u2190-\u22ff]/u.test(option.label));
  const longPrompt = [...prompt].length > 100;
  return { columns: wide ? 1 : 2, positions: Math.min(wide ? (longPrompt ? 1 : 2) : (longPrompt ? 3 : 5), rankCount) };
}

/** Validate selected tuples against the public marginal counts without inventing hidden groups. */
export function validRankedPage(page, result) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
  const keys = ['groups','groupStart','groupCount','totalGroups','positionStart','positionSpan','orderMeaning','residualTotal'];
  if (Object.keys(page).some(key => !keys.includes(key))) return false;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (!result || result.type !== 'ranking' || !integer(result.total) || result.total > 300
    || !integer(result.rankCount) || result.rankCount < 1 || result.rankCount > 8
    || !Array.isArray(result.counts) || result.counts.length < result.rankCount || result.counts.length > 8
    || typeof result.prompt !== 'string' || result.prompt.length > 2000
    || result.counts.some(row => !row || typeof row.label !== 'string' || row.label.length > 2000
      || !integer(row.count) || row.count > result.total || !Array.isArray(row.positionCounts)
      || row.positionCounts.length !== result.rankCount || row.positionCounts.some(count => !integer(count) || count > result.total))) return false;
  for (const key of ['groupStart','groupCount','totalGroups','positionStart','positionSpan']) if (!integer(page[key])) return false;
  if ((Object.hasOwn(page, 'orderMeaning') && !['priority','action',null].includes(page.orderMeaning)) || !Array.isArray(page.groups) || page.groups.length > 2
    || page.groupCount !== page.groups.length || page.totalGroups > Math.min(300, result.total)) return false;
  const layout = rankedLayout(result.counts, result.rankCount, result.prompt);
  if (page.positionStart >= result.rankCount || page.positionStart % layout.positions !== 0
    || page.positionSpan !== Math.min(layout.positions, result.rankCount - page.positionStart)
    || page.groupCount !== Math.min(layout.columns, page.totalGroups - page.groupStart)
    || page.groupStart >= Math.max(1, page.totalGroups)) return false;
  if (result.total === 0 && (page.totalGroups !== 0 || page.groupStart !== 0)) return false;
  if (result.total > 0 && page.totalGroups === 0) return false;
  let sum = 0, previous = null;
  const selectedMargins = result.counts.map(() => Array(result.rankCount).fill(0));
  for (const group of page.groups) {
    if (!Array.isArray(group) || group.length !== 2 || typeof group[0] !== 'string' || !/^[0-7]+$/.test(group[0])
      || group[0].length !== result.rankCount || new Set(group[0]).size !== result.rankCount
      || !integer(group[1]) || group[1] < 1 || group[1] > result.total) return false;
    const [tuple, count] = group;
    if (previous && (previous[1] < count || (previous[1] === count && previous[0] >= tuple))) return false;
    for (let position = 0; position < tuple.length; position++) {
      const row = result.counts[Number(tuple[position])];
      if (!row || (selectedMargins[Number(tuple[position])][position] += count) > row.positionCounts[position]) return false;
    }
    previous = group; sum += count;
  }
  let possibleOrders = 1;
  for (let position = 0; position < result.rankCount; position++) possibleOrders *= result.counts.length - position;
  const hiddenAfter = page.totalGroups - page.groupStart - page.groupCount;
  const minimumBefore = page.groupStart * (page.groups[0]?.[1] ?? 0);
  if (page.totalGroups > possibleOrders || sum + (page.totalGroups - page.groupCount) > result.total
    || minimumBefore + sum + hiddenAfter > result.total
    || (page.totalGroups === page.groupCount && sum !== result.total)) return false;
  if (page.residualTotal !== undefined && (!integer(page.residualTotal) || page.residualTotal < 1 || page.groupStart !== 0
    || page.groupCount !== 2 || page.totalGroups <= 2 || sum < result.total * 2 / 3 || page.residualTotal !== result.total - sum
    || page.residualTotal > hiddenAfter * (page.groups[1][1] - 1))) return false;
  return true;
}
