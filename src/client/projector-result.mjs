/** Shared text-only closed anonymous result rendering; callers supply their existing DOM and marks. */
import { responseSummary } from './response-summary.mjs';
import { markFor } from './projector-marks.mjs';

export function renderResponseResult(view, { el, markSvg }) {
  const r = view.responseResult;
  if (!r || view.replay) return null;
  const summary = responseSummary(r);
  const box = el('section', 'card result');
  box.setAttribute('aria-label', summary.heading);
  box.append(el('p', 'eyebrow', summary.heading), el('h2', null, r.prompt));
  if (r.type === 'free_text' && r.textPage) {
    box.classList.add('text-result');
    const chips = el('div', 'text-chips');
    // CASE-318: answers flow down 3 columns (2 when they run long, fewer when there are fewer); fit() sizes the type.
    const n = r.textPage.answers.length, long = r.textPage.answers.join('').length / Math.max(1, n) > 180;
    chips.style.setProperty('--response-columns', String(Math.max(1, Math.min(n, long ? 2 : 3))));
    for (const answer of r.textPage.answers) chips.append(el('blockquote', 'text-answer', answer));
    box.append(chips);
    box.append(el('p', 'results-page', summary.caption + (r.textPage.pages > 1 ? ` · Page ${r.textPage.page + 1} of ${r.textPage.pages}` : '')));
    return box;
  }
  if (r.type === 'ranking' && r.ranked) {
    renderRankedColumns(box, r, { el, markSvg });
    return box;
  }
  if (r.type === 'ranking' && summary.rows.length) {
    box.classList.add('rank-table-card');
    const table = el('table', 'rank-table');
    const head = el('tr');
    const option = el('th', null, 'Option'); option.scope = 'col'; head.append(option);
    for (const position of summary.rows[0].positions) {
      const th = el('th', null, `Rank ${position.rank}`); th.scope = 'col'; head.append(th);
    }
    const thead = el('thead'); thead.append(head); table.append(thead);
    const tbody = el('tbody');
    const first = (view.resultsPage ?? 0) * 2;
    const rows = summary.rows.slice(first, first + 2);
    for (const row of rows) {
      const tr = el('tr'); const label = el('th', null, row.label); label.scope = 'row'; tr.append(label);
      for (const position of row.positions) {
        const td = el('td', null, String(position.count)); td.setAttribute('aria-label', position.words); tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody); box.append(table);
    if (summary.rows.length > 2) box.append(el('p', 'results-page', `Options ${first + 1}–${first + rows.length} of ${summary.rows.length}`));
  } else if (summary.rows.length) {
    const ul = el('ul');
    const max = Math.max(1, ...summary.rows.map(row => row.count));
    summary.rows.forEach((row, i) => {
      const li = el('li');
      li.append(markSvg(i, { size: 32, decorative: false }), el('span', null, row.label));
      const bar = el('span', 'bar'); bar.setAttribute('aria-hidden', 'true');
      const fill = el('i'); fill.style.width = `${Math.round((row.count / max) * 100)}%`; bar.append(fill);
      li.append(bar, el('span', 'n', row.words));
      ul.append(li);
    });
    box.append(ul);
  }
  if (r.type === 'ranking' && r.total === 0 && !summary.rows.length) box.append(el('p', 'ranked-empty', 'No responses submitted.'));
  box.append(el('p', null, summary.caption));
  return box;
}

/** A selected page contains full immutable tuples; continuation only changes visible positions. */
function renderRankedColumns(box, result, { el, markSvg }) {
  const page = result.ranked;
  box.classList.add('ranked-result');
  box.append(el('p', 'ranked-meaning', { priority: 'Priority order', action: 'Action order' }[page.orderMeaning] ?? 'Ranked order'));
  if (!page.groups.length) {
    box.append(el('p', 'ranked-empty', 'No responses submitted.'));
    return;
  }
  const columns = el('div', 'ranked-columns'), several = page.totalGroups > 1;
  columns.style.setProperty('--ranked-columns', String(page.groupCount));
  for (const [tuple, count] of page.groups) {
    const column = el('article', 'ranked-column');
    column.setAttribute('aria-label', `Response order ${page.groupStart + columns.children.length + 1}`);
    // CASE-327: a column's count heads it only when the room gave more than one order; one order has the footer alone.
    if (several) column.append(el('p', 'ranked-total', `${count} ${count === 1 ? 'response' : 'responses'}`));
    const order = el('ol', 'ranked-order');
    order.setAttribute('start', String(page.positionStart + 1));
    for (let position = page.positionStart; position < page.positionStart + page.positionSpan; position++) {
      const authoredIndex = Number(tuple[position]), row = result.counts[authoredIndex];
      const tile = el('li', 'opt-tile ranked-tile');
      tile.style.setProperty('--mk', markFor(authoredIndex).fill);
      tile.append(el('span', 'ranked-rank', String(position + 1)), markSvg(authoredIndex, { size: 40, decorative: false }), el('span', 'ranked-label', row.label));
      order.append(tile);
    }
    column.append(order);
    columns.append(column);
  }
  box.append(columns);
  // One footer: the room's total (and its orders), the paging only when there is more, and any residual.
  const foot = el('div', 'ranked-foot'), facts = el('p', 'ranked-overall',
    `${result.total} ${result.total === 1 ? 'response' : 'responses'}${several ? ` · ${page.totalGroups} orders` : ''}`);
  foot.append(facts);
  const start = page.positionStart + 1, end = page.positionStart + page.positionSpan;
  if (page.positionSpan < result.rankCount) foot.append(el('p', 'ranked-continuation', start === end
    ? `Position ${start} of ${result.rankCount}${page.positionStart ? ' · continued' : ''}`
    : `Positions ${start}–${end} of ${result.rankCount}${page.positionStart ? ' · continued' : ''}`));
  if (page.groupCount < page.totalGroups) foot.append(el('p', 'ranked-group-page', `Orders ${page.groupStart + 1}–${page.groupStart + page.groupCount} of ${page.totalGroups}`));
  if (page.residualTotal !== undefined) foot.append(el('p', 'ranked-residual', `${page.residualTotal} other responses`));
  box.append(foot);
}

// CASE-318: the free-text reveal fills the band. The chips get the height left under the prompt, then the type steps
// down from 56px to the 24px projector floor (CASE-211) until every answer sits inside its columns. The room's page
// rule is sized so a page fits at the floor on a 1280×720 projector; anything else is reported, never shrunk further.
// Shared with the Builder fit check (builder-fit.mjs), which must measure the results page exactly as the projector draws it.
export function fitTextAnswers(m, win) {
  const chips = m.querySelector('.text-chips'), box = chips.closest('.text-result');
  // Measure with the chips collapsed: the room left is main's content bottom less the chips' top and what follows them.
  chips.style.setProperty('--text-size', '24px'); chips.style.height = '0px';
  const bottom = m.getBoundingClientRect().bottom - (parseFloat(win.getComputedStyle(m).paddingBottom) || 0);
  const after = box.getBoundingClientRect().bottom - chips.getBoundingClientRect().bottom;
  chips.style.height = `${Math.max(120, Math.floor(bottom - chips.getBoundingClientRect().top - after - 8))}px`;
  const fits = () => chips.scrollHeight <= chips.clientHeight + 1 && chips.scrollWidth <= chips.clientWidth + 1;
  for (let size = 56; size >= 24; size -= 2) { chips.style.setProperty('--text-size', `${size}px`); if (fits()) break; }
  m.dataset.overflow = !fits();
}
