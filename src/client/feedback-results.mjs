// Participant feedback results (card 40 + feedback integration slice 9; docs/plans/PARTICIPANT-FEEDBACK.md §8): one lazy chunk
// for the three viewers. The facilitator's Feedback section in the History debrief (screen and PDF rows, P-37), the
// authors' Feedback disclosure on case detail (P-38) and Administration → Feedback (P-39). Text-only DOM. Distributions
// are counts per value 1–5 with n, never an average alone, and every bar has the same neutral fill (no score colour).
// Wherever comments are shown, the names warning is shown with them.
import { node, clearPrivate } from './auth-ui.mjs';
import { QUESTIONS, ABOUT, COMMENT_WARNING, validSessionFeedback, validCaseFeedback, validAdminFeedback } from '../shared/feedback-results.mjs';
import { ratingDistribution as distribution, feedbackComments as commentBlock, feedbackEvidence, emptyFeedback, monthlyRatings } from './feedback-presentation.mjs';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const split = r => `${plural(r.total, 'response')} · ${plural(r.joined, 'joined phone')} · ${r.qr} by QR code`;
const TAKEAWAY = 'Take home', COMMENTS = 'Comments';
const button = (label, onclick, cls = 'btn quiet') => { const b = node('button', label, cls); b.type = 'button'; b.addEventListener('click', onclick); return b; };

/** The facilitator's Feedback section (History debrief, P-37). */
export function feedbackSection(r) {
  const root = node('section', null, 'feedback-results');
  root.append(node('h3', 'Feedback'));
  if (!r.responses.total) { root.append(emptyFeedback(r.closed ? 'No feedback was given.' : 'No feedback yet.')); return root; }
  root.append(feedbackEvidence(r.responses, { closed: r.closed }));
  const ratings = node('div', null, 'feedback-rating-grid'); for (const q of QUESTIONS) ratings.append(distribution(q, r.ratings[q.key])); root.append(ratings);
  if (r.comments.length) root.append(commentBlock(r.comments));
  return root;
}

/** The authors' view of one version, pooled across its rooms (P-38): the case rating, take-aways and case improvements. */
export function caseFeedbackSection(r) {
  const root = node('section', null, 'feedback-results');
  if (!r.responses.total) { root.append(emptyFeedback('No feedback on this version yet.')); return root; }
  root.append(feedbackEvidence(r.responses, { rooms: r.rooms }), distribution(QUESTIONS[1], r.ratings.case, { level: 'h3' }));
  if (r.comments.length) root.append(commentBlock(r.comments, { level: 'h3' }));
  if (r.commentsTotal > r.comments.length) root.append(node('p', `Showing the latest ${r.comments.length} of ${r.commentsTotal} comments.`, 'feedback-note'));
  return root;
}

// The PDF font draws Latin-1 and common punctuation; any other character in a comment prints as "?" (the screen keeps it).
const printable = t => t.replace(/[^ -~ -ÿ–—‘’“”…]/gu, '?');
/** Rows for sessionPdf(): the debrief's Feedback section, in its own Sect, comments under the names warning (I5). */
export function feedbackPdfRows(r) {
  const rows = [['SECT', { title: 'Feedback' }]];
  if (!r.responses.total) return [...rows, ['P', r.closed ? 'No feedback was given.' : 'No feedback yet.'], ['/SECT']];
  rows.push(['P', { runs: split(r.responses), colour: 'muted', size: 9 }]);
  // Each rating as counts per value with n, one neutral fill, in a quiet card (room PDFs v2).
  for (const q of QUESTIONS) {
    const d = r.ratings[q.key];
    rows.push(['BOX', { fill: 'quiet', rows: [['H3', q.question], ['TABLE', { cols: [0.4, 6, 0.6], rules: false, pad: 3, size: 9, rows: d.counts.map((c, i) => [{ runs: [{ text: String(i + 1), mono: true, colour: 'muted' }] },
      { bar: { value: c, total: Math.max(1, d.n), colour: 'petrol' } }, { runs: [{ text: String(c), mono: true }], align: 'end' }]) }],
      ['P', { runs: [{ text: `n = ${d.n}`, mono: true }, ` · 1 = ${q.low} · 5 = ${q.high}`], colour: 'muted', size: 8 }]] }]);
  }
  const take = r.comments.filter(c => c.kind === 'takeaway'), notes = r.comments.filter(c => c.kind !== 'takeaway');
  if (take.length) rows.push(['H3', TAKEAWAY], ['L', { size: 9.5, items: take.map(c => printable(c.body)) }]);
  if (notes.length) rows.push(['H3', COMMENTS], ['L', { size: 9.5, items: notes.map(c => [{ text: `${ABOUT[c.about]}  `, bold: true, colour: 'petrol' }, printable(c.body)]) }]);
  if (r.comments.length) rows.push(['P', { runs: COMMENT_WARNING, colour: 'muted', size: 8.5 }]);
  rows.push(['/SECT']);
  return rows;
}

/** A room's feedback for the History debrief, or null when it is unavailable (the section is then absent). */
export async function loadSessionFeedback(request, sessionId, signal) {
  try { const value = await request(['portfolio', 'sessions', sessionId, 'feedback'], { signal }); return validSessionFeedback(value) && value.session.id === sessionId ? value : null; }
  catch { return null; }
}

/** Case detail's Feedback disclosure body for one version (P-38). */
export function mountCaseFeedback(host, { request, caseId, versionNo }) {
  let closed = false, generation = 0, controller = null;
  const root = node('div', null, 'case-feedback-body'), status = node('p', 'Loading feedback…', 'feedback-status');
  status.setAttribute('role', 'status'); root.append(status); host.append(root);
  async function load() {
    if (closed) return; const g = ++generation; controller?.abort(); controller = new AbortController();
    status.hidden = false; status.textContent = 'Loading feedback…';
    for (const n of [...root.children]) if (n !== status) n.remove();
    try {
      const value = await request(['cases', caseId, 'versions', String(versionNo), 'feedback'], { signal: controller.signal });
      if (closed || g !== generation) return;
      if (!validCaseFeedback(value) || value.case.id !== caseId || value.case.versionNo !== versionNo) throw new Error('invalid_feedback');
      status.textContent = ''; status.hidden = true; root.append(caseFeedbackSection(value));
    } catch (error) {
      if (closed || g !== generation) return;
      status.hidden = false; status.textContent = error?.status === 403 ? 'Feedback on this version is for its authors.' : 'Feedback is unavailable.';
      if (error?.status !== 403) root.append(button('Retry', () => void load()));
    }
  }
  void load();
  return { close() { closed = true; generation++; controller?.abort(); clearPrivate(root); root.remove(); } };
}

/** Administration → Feedback (P-39): app feedback by month, the rooms with feedback, and any room or version pooled. */
export function mountAdminFeedback(host, { request, onContext = () => {} }) {
  let closed = false, generation = 0, controller = null, filter = { scope: 'app' }, after = null, previous = [], back = null;
  const root = node('section', null, 'admin-work feedback-admin'), nav = node('nav', null, 'feedback-admin-nav'), status = node('p', '', 'feedback-status'), body = node('div', null, 'feedback-admin-body'), pager = node('div', null, 'admin-pagination');
  status.setAttribute('role', 'status');
  nav.setAttribute('aria-label', 'Feedback views');
  nav.append(button('App feedback', () => open({ scope: 'app' })), button('Sessions', () => open({ scope: 'rooms' })));
  root.append(node('h2', 'Feedback','sr-only'), node('p', 'Participant feedback, pooled. Ratings are counts per value from 1 to 5.', 'supporting-note'), nav, status, body, pager);
  host.replaceChildren(root);
  function open(next, from = null) { back = from; filter = next; after = null; previous = []; void load(); }
  async function load() {
    if (closed) return; const g = ++generation; controller?.abort(); controller = new AbortController(); status.hidden = false; status.textContent = 'Loading feedback…'; clearPrivate(body); clearPrivate(pager);
    for (const [i, control] of [...nav.children].entries()) control.setAttribute('aria-pressed', String(filter.scope === (i ? 'rooms' : 'app')));
    try {
      const value = await request(['admin', 'feedback'], { method: 'POST', body: { filter, after }, signal: controller.signal, maxResponseBytes: 262144 });
      if (closed || g !== generation) return;
      if (!validAdminFeedback(value) || value.scope !== filter.scope || filter.scope === 'session' && value.result.session.id !== filter.sessionId || filter.scope === 'case' && (value.result.case.id !== filter.caseId || value.result.case.versionNo !== filter.versionNo)) throw new Error('invalid_feedback');
      status.textContent = ''; status.hidden = true; render(value);
    } catch (error) {
      if (closed || g !== generation) return;
      status.hidden = false; status.textContent = error?.status === 403 ? 'Feedback is for the deployment administrator.' : 'Feedback is unavailable.';
      pager.append(button('Retry', () => void load()));
    }
  }
  function render(v) {
    const r = v.result;
    onContext(v.scope === 'app' ? 'App feedback' : v.scope === 'rooms' ? 'Sessions with feedback' : v.scope === 'session' ? 'Session feedback' : 'Case feedback');
    if (back) body.append(button(back.label, () => open(back.filter)));
    if (v.scope === 'app') {
      body.append(node('h3', 'The Case app'), feedbackEvidence(r.responses), distribution(QUESTIONS[2], r.ratings.app));
      if (r.months.length) body.append(monthlyRatings(r.months));
      if (r.comments.length) body.append(commentBlock(r.comments, { dated: true, level: 'h3' }));
    } else if (v.scope === 'rooms') {
      if (!r.rooms.length) body.append(emptyFeedback('No session has feedback yet.'));
      const ul = node('ul', null, 'feedback-rooms');
      for (const room of r.rooms) {
        const li = node('li');
        li.append(node('span', `${room.title} · version ${room.versionNo} · ${room.date} · ${plural(room.responses, 'response')}`),
          button('Session feedback', () => open({ scope: 'session', sessionId: room.sessionId }, { label: 'Back to sessions', filter: { scope: 'rooms' } })),
          button(`Version ${room.versionNo} feedback`, () => open({ scope: 'case', caseId: room.caseId, versionNo: room.versionNo }, { label: 'Back to sessions', filter: { scope: 'rooms' } })));
        ul.append(li);
      }
      body.append(ul);
    } else if (v.scope === 'session') {
      body.append(node('h3', `${r.session.title} · version ${r.session.versionNo} · ${r.session.date}`), feedbackSection(r));
    } else {
      body.append(node('h3', `${r.case.title} · version ${r.case.versionNo}`), caseFeedbackSection(r));
    }
    if (previous.length) pager.append(button('Previous page', () => { after = previous.pop(); void load(); }));
    if (v.nextAfter) pager.append(button('Next page', () => { previous.push(after); after = v.nextAfter; void load(); }));
  }
  void load();
  return { close() { closed = true; generation++; controller?.abort(); clearPrivate(root); root.remove(); } };
}
