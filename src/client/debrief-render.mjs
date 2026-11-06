// Draws the debrief model (debrief-model.mjs) twice from the same data: rows for the tagged PDF writer, and a text-only
// DOM for the screen and the accessible print. Shape and colour carry meaning, with a word beside each (design system).
import { node } from './auth-ui.mjs';
import { markSvg } from './projector-marks.mjs';
import { KIND, INTERACTION_SYMBOL, CLASS } from './debrief-model.mjs';
import { openingRows, kicker, pdfFileName, fileDate, fileTime } from './pdf-chrome.mjs';
import { glanceDraw } from './pdf-glance.mjs';
const PIGMENT = ['d34b36', '5e74cc', 'e9a51d', '378862', '9c61b5', '21858c', 'ba611c', '6b7b82'];
const GLYPH = { sound: '●', defensible: '◯', 'context-dependent': '⑂', unsafe: '▲', 'terminal-unsafe': '⬣', 'discussion-prompt': '▤', single_choice: '◉', multi_select: '☑', ranking: '⇅', free_text: '✎' };
const hm = (x) => (x ? new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
const meta = (m) => [m.versionNo ? `Version ${m.versionNo}${m.digest ? ` · ${m.digest}` : ''}` : null, m.startedAt && m.endedAt ? `${hm(m.startedAt)}–${hm(m.endedAt)}` : null, m.minutes !== null ? `${m.minutes} min` : null,
  m.joined !== null && m.joined !== undefined ? `${m.joined} joined` : null, m.part > 1 || m.more ? `Part ${m.part}` : null].filter(Boolean).join(' · ');
const answered = (q, m) => (q.total === null ? 'Not recorded' : m.joined ? `${q.total}/${m.joined}` : String(q.total));
// The writer's shape names for each classification (session-pdf.mjs SHAPE).
const CLASS_SYMBOL = { sound: 'sound', defensible: 'defensible', 'context-dependent': 'context', unsafe: 'unsafe', 'terminal-unsafe': 'terminal', 'discussion-prompt': 'discussion' };
const evidence = { complete: 'Complete record', pending: 'Archive pending: the room may still be catching up', limited: 'Limited archive evidence: older sessions may lack some activity' };

/** The debrief's file name: the case title, "Facilitator debrief", and the session's date and start time (a case can run twice a day). */
export const debriefFileName = (m) => pdfFileName(m.title, 'Facilitator debrief', { date: fileDate(m.startedAt ?? m.endedAt), time: fileTime(m.startedAt) });

/** Rows for sessionPdf(): cover, At a glance (the route and each choice), Objectives, Responses, then The Case as cards on the route rail. */
export function debriefPdfRows(m) {
  // m.band: the case braid (splash.mjs pdfBandFor), when the caller has the art chunk loaded; else a plain band.
  const rows = [...openingRows({ title: m.title, label: 'Facilitator', labelColour: 'privateInk', band: m.band ?? null }),
    kicker('Facilitator debrief'), ['H1', m.title], ['P', { runs: meta(m), colour: 'muted', size: 9 }]];
  if (evidence[m.completeness]) rows.push(['P', { runs: evidence[m.completeness], colour: 'muted', size: 9 }]);
  if (m.withdrawn) rows.push(['P', { runs: 'Pinned version withdrawn. History grants no new-room eligibility.', colour: 'muted', size: 9 }]);
  const branches = (m.route ?? []).filter((s) => s.branch).length;
  if (m.routeChoices.length || branches) {
    rows.push(['SECT', { title: 'At a glance' }]);
    if (m.route?.length) rows.push(['DIAGRAM', { height: 66, alt: `The main route: ${m.route.length} slides and questions; ${branches} questions change the route.`, draw: glanceDraw(m.route) }]);
    if (m.routeChoices.length) rows.push(['TABLE', { cols: [0.4, 5.2, 4.6, 4.4], size: 9, pad: 7, rows: m.routeChoices.map((q, i) => [{ runs: [{ text: String(i + 1), mono: true }] }, { runs: q.prompt, colour: 'muted' },
      { runs: [{ text: q.route.label, bold: true }] },
      { runs: [...(q.route.classification ? [{ sym: CLASS_SYMBOL[q.route.classification], label: CLASS[q.route.classification], colour: 'ink' }, ` ${CLASS[q.route.classification]}`] : []), ...(q.route.recommended ? [{ text: '  Recommended', bold: true, colour: 'petrol', size: 8 }] : [])] }]) }]);
    rows.push(['P', { runs: [{ sym: 'dot', label: '', colour: 'petrol' }, ' slide   ', { sym: 'dia', label: '', colour: 'ink' }, ' question   ', { sym: 'arrow', label: '', colour: 'muted' }, ' alternative route   ',
      ...Object.entries(INTERACTION_SYMBOL).flatMap(([k, v]) => [{ sym: v, label: '', colour: 'muted' }, ` ${KIND[k].toLowerCase()}   `])], colour: 'muted', size: 7.5 }], ['/SECT']);
  }
  if (m.objectives.length) rows.push(['SECT', { title: 'Objectives' }], ['L', { columns: 2, labels: 'nn', size: 9.5, items: m.objectives }], ['/SECT']);
  if (m.questions.length) {
    // One bar per question against the room size, with the room size marked; each bar's question type under it.
    const W = 499, bw = W / m.questions.length, max = Math.max(1, m.joined ?? 0, ...m.questions.map((q) => q.total ?? 0)), H = 64;
    rows.push(['SECT', { title: 'Responses' }], ['DIAGRAM', { height: 92, alt: `Responses per question: ${m.questions.map((q) => `${q.n}: ${q.total ?? 'not recorded'}`).join(', ')}${m.joined ? `, of ${m.joined} joined` : ''}`,
      draw: [{ line: [[0, 12], [W, 12]], stroke: 'line', width: .6, dash: true }, { text: String(max), x: 0, y: 9, size: 7, colour: 'muted', mono: true },
        ...m.questions.flatMap((q, i) => { const h = ((q.total ?? 0) / max) * H; return [...(h ? [{ rect: [i * bw + bw * .14, 12 + H - h, bw * .72, h], fill: 'petrol', r: Math.min(3, bw * .2) }] : []),
          ...(q.type ? [{ sym: INTERACTION_SYMBOL[q.type], x: i * bw + bw / 2 - 4, y: 12 + H + 6, size: 8, colour: 'muted' }] : [])]; })] }], ['/SECT']);
    rows.push(['SECT', { title: 'The Case' }], ['RAIL']);
    let chapter = null;
    for (const q of m.questions) {
      if (q.chapter && q.chapter !== chapter) { chapter = q.chapter; rows.push(['GAP', 4], kicker(q.chapter)); }
      const card = [['H3', { runs: [{ text: `${String(q.n).padStart(2, '0')}  `, mono: true, bold: false, colour: 'muted', size: 9 }, ...(q.type ? [{ sym: INTERACTION_SYMBOL[q.type], label: KIND[q.type], colour: 'ink' }, ' '] : []), q.prompt] }]];
      if (q.freeText) card.push(['P', { runs: [{ text: String(q.total ?? 0), mono: true, bold: true, size: 13 }, ' ', { sym: 'free', label: 'written answers', colour: 'muted' }], size: 10 }]);
      else if (q.rows.length) card.push(['TABLE', { cols: [0.45, 5, 3.4, 0.8], rules: false, pad: 4, size: 9, rows: q.rows.map((r) => [{ runs: [{ mark: r.mark, label: `Option ${r.mark + 1}` }] }, r.label,
        { bar: { value: r.count, total: Math.max(1, q.total ?? 0, r.count), colour: PIGMENT[r.mark % PIGMENT.length] } }, { runs: [{ text: String(r.count), mono: true }], align: 'end' }]) }]);
      if (q.route) card.push(['P', { runs: [{ sym: 'arrow', label: 'Route', colour: 'muted' }, ' ', { text: q.route.label, bold: true }, ...(q.route.classification ? ['  ', { sym: CLASS_SYMBOL[q.route.classification], label: CLASS[q.route.classification], colour: 'ink' }, ` ${CLASS[q.route.classification]}`] : []), ...(q.route.recommended ? [{ text: '  Recommended', bold: true, colour: 'petrol', size: 8 }] : [])], size: 9 }]);
      card.push(['P', { runs: [{ text: `${q.ranking ? 'Ranked first · ' : ''}${answered(q, m)} · ${hm(q.openedAt)}–${hm(q.closedAt)}${q.status === 'superseded' ? ' · superseded' : q.status === 'abandoned' ? ' · abandoned' : ''}`, mono: true }], colour: 'muted', size: 7.5 }]);
      rows.push(['BOX', { fill: 'quiet', node: { sym: 'node', colour: 'ink' }, rows: card }]);
    }
    rows.push(['/RAIL'], ['/SECT']);
  }
  return rows;
}

/** The same debrief as a text-only DOM, for the screen and the accessible print. */
export function renderDebrief(m, doc = document) {
  const root = node('div', null, 'debrief');
  root.append(node('p', meta(m), 'debrief-meta'));
  if (m.withdrawn) root.append(node('p', 'Pinned version withdrawn. History grants no new-room eligibility.', 'debrief-meta'));
  const section = (title) => { const s = node('section'); s.append(node('h3', title)); root.append(s); return s; };
  if (m.routeChoices.length) { const s = section('Route choices'), ol = node('ol', null, 'debrief-routes');
    for (const q of m.routeChoices) { const li = node('li'); li.append(node('span', q.prompt, 'debrief-q'), node('strong', q.route.label));
      if (q.route.classification) li.append(node('span', `${GLYPH[q.route.classification]} ${CLASS[q.route.classification]}`, 'debrief-class'));
      if (q.route.recommended) li.append(node('span', 'Recommended', 'debrief-tag')); ol.append(li); }
    s.append(ol); }
  if (m.objectives.length) { const s = section('Objectives'), ol = node('ol'); for (const o of m.objectives) ol.append(node('li', o)); s.append(ol); }
  if (m.questions.length) { const s = section('The Case'), ol = node('ol', null, 'debrief-questions');
    for (const q of m.questions) {
      const li = node('li'), h = node('h4');
      h.append(node('span', String(q.n).padStart(2, '0'), 'debrief-n'));
      if (q.type) { const g = node('span', GLYPH[q.type], 'debrief-glyph'); g.setAttribute('role', 'img'); g.setAttribute('aria-label', KIND[q.type]); h.append(g); }
      h.append(doc.createTextNode(q.prompt)); li.append(h);
      if (q.freeText) li.append(node('p', `${q.total ?? 0} written answers`));
      else if (q.rows.length) { const t = node('table', null, 'debrief-results'), body = node('tbody');
        t.append(Object.assign(node('caption', q.ranking ? 'Ranked first' : 'Responses', 'sr-only')));
        for (const r of q.rows) { const tr = node('tr'), mk = node('td'), bar = node('td'), fill = node('span'), label = node('th', r.label);
          label.setAttribute('scope', 'row'); mk.append(markSvg(r.mark, { size: 16, decorative: true }));
          bar.className = 'debrief-bar'; fill.style.width = `${Math.round((r.count / Math.max(1, q.total ?? 0, r.count)) * 100)}%`; fill.style.background = `#${PIGMENT[r.mark % PIGMENT.length]}`; bar.append(fill);
          tr.append(mk, label, bar, node('td', String(r.count), 'debrief-count')); body.append(tr); }
        t.append(body); li.append(t); }
      if (q.route) { const p = node('p', null, 'debrief-route'); p.append(node('span', '→ ', 'debrief-glyph'), node('strong', q.route.label));
        if (q.route.classification) p.append(node('span', ` ${GLYPH[q.route.classification]} ${CLASS[q.route.classification]}`, 'debrief-class'));
        if (q.route.recommended) p.append(node('span', 'Recommended', 'debrief-tag')); li.append(p); }
      li.append(node('p', `${q.ranking ? 'Ranked first · ' : ''}${answered(q, m)} · ${hm(q.openedAt)}–${hm(q.closedAt)}${q.status === 'superseded' ? ' · superseded' : q.status === 'abandoned' ? ' · abandoned' : ''}`, 'debrief-meta'));
      ol.append(li);
    }
    s.append(ol); }
  return root;
}
