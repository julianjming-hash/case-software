/** Frozen-authority group selection; public received-page validation lives separately. */
import { validateRankedGroups } from './ranked-groups.mjs';
import { rankedLayout } from './ranked-page-view.mjs';
export { rankedLayout } from './ranked-page-view.mjs';
export { validRankedPage } from './ranked-page-view.mjs';

export function rankedPage(decision, aggregate, selection = { group: 0, position: 0 }) {
  const options = decision.interaction.options;
  const eligibleIndices = aggregate.eligibleOptionIds?.map(id => options.findIndex(option => option.id === id));
  if (!validateRankedGroups(aggregate.completeOrders, { optionCount: options.length, rankCount: aggregate.rankCount,
    total: aggregate.total, eligibleIndices })) return null;
  const groups = aggregate.completeOrders, layout = rankedLayout(options, aggregate.rankCount, decision.prompt);
  const valid = Number.isSafeInteger(selection?.group) && selection.group >= 0 && selection.group < Math.max(1, groups.length)
    && Number.isSafeInteger(selection?.position) && selection.position >= 0 && selection.position < Math.max(1, aggregate.rankCount)
    && (layout.positions === 0 ? selection.position === 0 : selection.position % layout.positions === 0);
  const groupStart = valid ? selection.group : 0, positionStart = valid ? selection.position : 0;
  const chosen = groups.slice(groupStart, groupStart + layout.columns);
  const page = { groups: chosen, groupStart, groupCount: chosen.length, totalGroups: groups.length,
    positionStart, positionSpan: Math.min(layout.positions, aggregate.rankCount - positionStart),
    orderMeaning: decision.interaction.order_meaning ?? null };
  if (groupStart === 0 && layout.columns === 2 && groups.length > 2 && groups[1][1] > groups[2][1]
    && groups[0][1] + groups[1][1] >= aggregate.total * 2 / 3) {
    page.residualTotal = aggregate.total - groups[0][1] - groups[1][1];
  }
  return page;
}
