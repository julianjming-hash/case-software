// Text-first feedback graphics. Counts and sample sizes stay primary; no average or score colour.
import { node } from './auth-ui.mjs';
import { ABOUT, COMMENT_WARNING } from '../shared/feedback-results.mjs';
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

export function feedbackEvidence(responses, { rooms = null, closed = true } = {}) {
  const wrap = node('div', null, 'feedback-evidence'), total = node('div', null, 'feedback-evidence-total');
  total.append(node('strong', plural(responses.total, 'response')), node('p', `${plural(responses.joined, 'joined phone')} · ${responses.qr} by QR code${closed ? '' : ' · still open'}`));
  wrap.append(total);
  if (rooms !== null) wrap.append(node('p', `${plural(rooms, 'session')} with feedback`, 'feedback-evidence-scope'));
  return wrap;
}

export function emptyFeedback(text) {
  const wrap = node('div', null, 'feedback-empty'); wrap.append(node('p', text)); return wrap;
}

export function ratingDistribution(q, d, { level = 'h4' } = {}) {
  const wrap = node('section', null, 'feedback-question'), head = node('div', null, 'feedback-question-head');
  head.append(node(level, q.question), node('span', plural(d.n, 'rating'), 'feedback-sample'));
  const table = node('table', null, 'feedback-dist'), body = node('tbody'), header = node('tr'), thead = node('thead');
  table.append(node('caption', `${q.question}: responses per rating, 1 to 5`, 'sr-only'));
  const columns=node('colgroup'),valueColumn=node('col',null,'feedback-rating-column'),barColumn=node('col'),countColumn=node('col',null,'feedback-count-column');columns.append(valueColumn,barColumn,countColumn);table.append(columns);
  for (const label of ['Rating', 'Share of ratings', 'Responses']) { const th = node('th', label); th.setAttribute('scope', 'col'); header.append(th); }
  thead.className = 'sr-only'; thead.append(header); table.append(thead);
  d.counts.forEach((count, i) => {
    const tr = node('tr'), value = node('th', String(i + 1)), bar = node('td', null, 'feedback-bar'), track = node('span', null, 'feedback-bar-track'), fill = node('span', null, 'feedback-bar-fill'), result = node('td', null, 'feedback-count');
    value.setAttribute('scope', 'row'); track.setAttribute('aria-hidden', 'true');
    const percent = d.n ? Math.round(count / d.n * 100) : 0;
    fill.style.width = `${percent}%`; track.append(fill); bar.append(track);
    result.append(node('strong', String(count)), node('span', `${percent}%`, 'feedback-percentage'));
    tr.append(value, bar, result); body.append(tr);
  });
  table.append(body); wrap.append(head, table, node('p', `n = ${d.n} · 1 = ${q.low} · 5 = ${q.high}`, 'feedback-scale'));
  if (!d.n) wrap.append(node('p', 'No ratings for this question yet.', 'feedback-note'));
  return wrap;
}

export function feedbackComments(list, { dated = false, level = 'h4' } = {}) {
  const wrap = node('section', null, 'feedback-comments');
  wrap.append(node(level, 'Comments'), node('p', COMMENT_WARNING, 'feedback-warning'));
  const grouped = node('div', null, 'feedback-comment-groups'), subLevel = level === 'h3' ? 'h4' : 'h5';
  const groups = [['Take home', list.filter(c => c.kind === 'takeaway')], ...Object.entries(ABOUT).map(([about, title]) => [title, list.filter(c => c.kind !== 'takeaway' && c.about === about)])];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    const section = node('section', null, 'feedback-comment-group'), ul = node('ul', null, 'feedback-comment-list');
    section.append(node(subLevel, title));
    for (const c of items) {
      const li = node('li');
      if (dated && c.date) { const date = node('time', c.date, 'feedback-date'); date.setAttribute('datetime', c.date); li.append(date); }
      li.append(node('p', c.body)); ul.append(li);
    }
    section.append(ul); grouped.append(section);
  }
  wrap.append(grouped); return wrap;
}

/** One accessible count table, enhanced by neutral in-cell bars on a shared scale. */
export function monthlyRatings(months) {
  const wrap = node('section', null, 'feedback-month-card'), scroll = node('div', null, 'feedback-month-scroll'), table = node('table', null, 'feedback-months'), header = node('tr'), thead = node('thead'), body = node('tbody');
  wrap.append(node('h3', 'App ratings by month'), node('p', 'Response counts for each rating. Bars use the same count scale across these months.', 'feedback-note'));
  table.append(node('caption', 'App rating by month: responses per rating, 1 to 5', 'sr-only'));
  for (const label of ['Month', '1', '2', '3', '4', '5', 'n']) { const th = node('th', label); th.setAttribute('scope', 'col'); header.append(th); }
  thead.append(header); table.append(thead);
  const maximum = Math.max(1, ...months.flatMap(m => m.counts));
  const digits = Math.max(3, String(maximum).length, ...months.map(m => String(m.n).length));
  table.style.minWidth = `${Math.max(48, 12 + 6 * (digits + 2))}ch`;
  for (const m of months) {
    const tr = node('tr'), month = node('th'), date = node('time', m.month); month.setAttribute('scope', 'row'); date.setAttribute('datetime', m.month); month.append(date); tr.append(month);
    for (const count of m.counts) {
      const cell = node('td', null, 'feedback-month-value'), track = node('span', null, 'feedback-month-track'), fill = node('span', null, 'feedback-month-fill');
      track.setAttribute('aria-hidden', 'true'); fill.style.height = `${count / maximum * 100}%`; track.append(fill); cell.append(node('span', String(count)), track); tr.append(cell);
    }
    tr.append(node('td', String(m.n), 'feedback-month-total')); body.append(tr);
  }
  table.append(body); scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Monthly app rating counts'); scroll.setAttribute('tabindex', '0'); scroll.append(table); wrap.append(scroll); return wrap;
}
