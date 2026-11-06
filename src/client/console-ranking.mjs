import { markFor } from './projector-marks.mjs';

/** Private console rows keep position wording; route suggestions stay separate. */
export function consoleRankingRows(decision, aggregate) {
  const interaction = decision?.interaction;
  if (interaction?.type !== 'ranking' || !Number.isInteger(aggregate?.rankCount) || !aggregate.positionCounts) return null;
  const positions = interaction.options.map(option => aggregate.positionCounts[option.id]);
  if (positions.some(row => !Array.isArray(row) || row.length !== aggregate.rankCount)) return null;
  return interaction.options.map((option, index) => `${option.label} · ${positions[index]
    .map((count, rank) => `Rank ${rank + 1}: ${count}`).join(' · ')}`);
}

/** Model only; UI sends the observed revision with every deliberate selection. */
export function rankedControlsModel(view) {
  const page = view.rankedPresentation;
  if (!view.actions?.includes('ranked_page') || !page || !page.totalGroups) return null;
  const round = view.round?.aggregate?.completeOrders ? view.round
    : [...view.rounds ?? []].reverse().find(item => item.status === 'resolved' && item.aggregate?.completeOrders);
  const groups = round?.aggregate.completeOrders;
  if (!groups || groups.length !== page.totalGroups) return null;
  const { group = 0, position = 0 } = view.rankedSelection ?? {};
  const rankCount = round.aggregate.rankCount;
  const positions = view.rankedPositionSpan ?? (page.positionStart === 0 ? page.positionSpan : 3);
  const payload = (nextGroup, nextPosition) => ({ group: nextGroup, position: nextPosition, closedRoundId: view.rankedRoundId, expectRevision: view.revision });
  const common = groups.length > 2 && (view.rankedColumns ?? page.groupCount) === 2 && groups[1][1] > groups[2][1]
    && groups[0][1] + groups[1][1] >= round.aggregate.total * 2 / 3;
  const showCommon = page.residualTotal !== undefined || common;
  return {
    switch: showCommon ? { label: group === 0 ? 'Other responses' : 'Back to common responses', payload: payload(group === 0 ? 2 : 0, 0) } : null,
    previousOrders: group > 0 ? payload(Math.max(0, group - page.groupCount), 0) : null,
    nextOrders: group + page.groupCount < groups.length ? payload(group + page.groupCount, 0) : null,
    previousPositions: position > 0 ? payload(group, Math.max(0, position - positions)) : null,
    nextPositions: position + page.positionSpan < rankCount ? payload(group, position + page.positionSpan) : null,
    selected: group,
    orders: groups.map(([tuple, count], value) => ({ value, marks: [...tuple].map(index => markFor(Number(index)).name).join(', '), label: `Response order ${value + 1} · ${count} ${count === 1 ? 'response' : 'responses'}`, payload: payload(value, 0) })),
  };
}

/** Shared production/prototype controls; the caller owns pending state and authenticated send. */
export function renderRankedControls(view, { el, button, send, disabled = false }) {
  const model = rankedControlsModel(view);
  if (!model) return null;
  const controls = el('section', null, 'ranked-controls');
  controls.setAttribute('aria-label', 'Ranked response presentation');
  const add = (label, payload, key = label) => {
    const control = button(label, () => send('ranked_page', payload));
    control.disabled = disabled || payload === null;
    control.dataset.focusKey = key;
    control.dataset.k = key;
    controls.append(control);
  };
  if (model.switch) add(model.switch.label, model.switch.payload, 'ranked-common-switch');
  add('Previous positions', model.previousPositions);
  add('Next positions', model.nextPositions);
  add('Previous response orders', model.previousOrders);
  add('Next response orders', model.nextOrders);
  const label = el('label', 'Select response order');
  const select = el('select');
  select.setAttribute('aria-label', 'Select response order');
  select.dataset.focusKey = 'ranked-direct-selection';
  select.dataset.k = 'ranked-direct-selection';
  select.disabled = disabled;
  for (const order of model.orders) {
    const option = el('option', `${order.label} · ${order.marks}`);
    option.value = String(order.value);
    if (order.value === model.selected) option.setAttribute('selected', ''); // an attribute: a changed selection is a changed node
    select.append(option);
  }
  // A property handler reading the live select at the change (a patched console keeps the node, card 37).
  select.onchange = event => {
    const order = model.orders.find(item => String(item.value) === event.currentTarget.value);
    if (order) send('ranked_page', order.payload);
  };
  const slot = el('span'); slot.dataset.keep = 'console-select-ranked';
  slot.dataset.consoleSelect = 'ranked-direct-selection'; slot.dataset.selectionMode = 'observed';
  slot.append(select); label.append(slot); controls.append(label);
  const page = view.rankedPresentation;
  const status = el('p', `Response orders ${page.groupStart + 1}–${page.groupStart + page.groupCount} of ${page.totalGroups} · Positions ${page.positionStart + 1}–${page.positionStart + page.positionSpan} of ${view.round?.aggregate?.rankCount ?? view.rounds?.findLast(round => round.status === 'resolved')?.aggregate?.rankCount}`);
  status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');controls.append(status);
  return controls;
}
