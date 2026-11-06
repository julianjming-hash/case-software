// Facilitator briefing (card 40a; card 40 + feedback integration, slice 8). A lazy chunk loaded by case detail (the P-21
// pack read Preview uses) and by the console Room tab (the pack already in memory). Everything is derived from the
// published document (schema 1, 2 or 3) and the version row: no authoring, setting or template (Julian, 2026-10-17).
// One derived model, the tagged-PDF writer's row list (session-pdf.mjs), feeds both the built-in PDF and the accessible
// print fallback. Nothing is kept: no module state, storage, cache or broadcast; text-only DOM; no added URL, token or name.
// Order (prototypes/debrief-pdfs.html `briefing()`): cover, Objectives, At a glance, Run sheet, The Case (main route as
// numbered cards; each alternative route forks in a dashed card through what only it reaches, then rejoins), Other slides.
// Rulings 3 and 4 (Julian, 2026-10-17): an authored https URL is a link (validated by urls.mjs; anything else stays text),
// and every PDF and printed page carries the header "Facilitator" in place of the old handling line.
import { node, clearPrivate } from './auth-ui.mjs';
import { MARKS, markSvg } from './projector-marks.mjs';
import { formattedTextPlainText } from '../shared/builder-format.mjs';
import { sessionRecordObjectUrl, httpsHref } from '../shared/urls.mjs';
import { routeSummary, glanceDraw } from './pdf-glance.mjs';
import { openingRows, kicker, pdfFileName } from './pdf-chrome.mjs';
import { gasTitle, gasVisible, gasFlag, gasRange, gasColumns, gasReading, GAS_FLAG_MARK } from '../shared/slide-gas-view.mjs';

/** Every fixed word the briefing prints (the derivation allow-list; tests/briefing.test.mjs traces each line to it or the document). */
export const CHROME = Object.freeze({
  kicker: 'Facilitator briefing', header: 'Facilitator', version: 'Version', minutes: 'min',
  objectives: 'Objectives', glance: 'At a glance', runSheet: 'Run sheet', theCase: 'The Case', otherSlides: 'Other slides',
  glanceAlt: '{n} slides on the main route; {q} questions, {b} of which change the route.',
  recommended: 'Recommended', cue: 'Cue', rejoins: 'Rejoins', reveals: 'Reveals', clarification: 'Clarification', image: 'Image', when: 'When',
  key: Object.freeze(['slide', 'question', 'revealed by a question', 'alternative route', 'rejoins', 'only you', 'cue', 'clarification you can show',
    'single choice', 'select all that apply', 'ranking', 'free text']),
  interaction: Object.freeze({ single_choice: 'Single choice', multi_select: 'Select all that apply', ranking: 'Ranking', free_text: 'Free text' }),
  classification: Object.freeze({ sound: 'Sound', defensible: 'Defensible', 'context-dependent': 'Context-dependent', unsafe: 'Unsafe · recoverable',
    'terminal-unsafe': 'Terminal · needs a checkpoint reset', 'discussion-prompt': 'Discussion prompt' }),
  marks: Object.freeze(MARKS.map(m => m.name)),
});
const IG = { single_choice: 'single', multi_select: 'multi', ranking: 'ranking', free_text: 'free' };
const CLS = { sound: 'sound', defensible: 'defensible', 'context-dependent': 'context', unsafe: 'unsafe', 'terminal-unsafe': 'terminal', 'discussion-prompt': 'discussion' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
// Authored text may be a plain string or formatted text (schema 2/3); paragraphs split at line breaks.
const T = v => typeof v === 'string' ? v : v && typeof v === 'object' ? formattedTextPlainText(v) : '';
const paras = v => T(v).split(/\n+/).map(s => s.trim()).filter(Boolean);
const runText = p => (p?.runs ?? []).map(r => { const t = typeof r?.text === 'string' ? r.text : ''; return r?.script === 'sup' && /^\d+$/.test(t) ? [...t].map(c => SUP[c]).join('') : t; }).join('');
const part = t => t.includes(' · ') ? t.split(' · ')[0] : '';
const short = t => t.includes(' · ') ? t.split(' · ').slice(1).join(' · ') : t;
const pad = i => String(i).padStart(2, '0');
const sym = (s, label = '', colour) => ({ sym: s, label, ...(colour ? { colour } : {}) });
const P = (runs, extra) => ['P', { runs, ...extra }];
const ink = text => P(text, { colour: 'privateInk' });
/** Authored text split at its URLs: one that urls.mjs validates as https is { text, href }; any other stays plain text. */
export function linkSegments(text) {
  const out = []; let at = 0;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"]+/gi)) {
    let url = m[0];
    while (/[.,;:!?'\]]$/.test(url) || (url.endsWith(')') && url.split('(').length < url.split(')').length)) url = url.slice(0, -1);
    const href = httpsHref(url);
    if (!href) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ text: url, href }); at = m.index + url.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
// A string run splits at its https URLs into linked runs; runs without one are returned unchanged.
const linkRuns = runs => { const list = typeof runs === 'string' ? [runs] : runs; if (!Array.isArray(list)) return runs; const out = list.flatMap(r => typeof r === 'string' ? linkSegments(r) : [r]); return out.some(r => r?.href) ? out : runs; };
const linked = rows => rows.map(([role, v]) => {
  if (role === 'P' || role[0] === 'H') { const s = typeof v === 'string' ? { runs: v } : v, runs = linkRuns(s.runs); return runs === s.runs ? [role, v] : [role, { ...s, runs }]; }
  if (role === 'L') return [role, { ...v, items: v.items.map(linkRuns) }];
  if (role === 'TABLE') return [role, { ...v, rows: v.rows.map(r => r.map(c => typeof c === 'string' ? (x => x === c ? c : { runs: x })(linkRuns(c)) : c?.runs ? { ...c, runs: linkRuns(c.runs) } : c)) }];
  return role === 'BOX' ? [role, { ...v, rows: linked(v.rows) }] : [role, v];
});

/** The briefing as the writer's rows: { versionNo, sha256 } come from the version row (absent fields are omitted). */
export function briefingRows(doc, { versionNo = null, sha256 = '', band = null } = {}) {
  const B = new Map(doc.beats.map(b => [b.id, b])), D = new Map(doc.decisions.map(d => [d.id, d])), S = new Map(doc.surfaces.map(s => [s.id, s]));
  const BL = new Map((doc.blocks ?? []).map(b => [b.id, b])), clars = doc.clarifications ?? [];
  const comp = (kind, id) => doc.compositions?.find(c => c.owner?.kind === kind && c.owner.id === id);
  const rec = d => d.paths.find(p => p.recommended) ?? d.paths[0];
  const after = b => { const d = b.decision_id && D.get(b.decision_id); return B.get(d ? rec(d).next_beat_id : b.next_beat_id); };
  const order = [], onMain = new Set();
  for (let b = B.get(doc.start_beat_id); b && !onMain.has(b.id); b = after(b)) { onMain.add(b.id); order.push(b); }
  const placed = new Set(onMain), clarPlaced = new Set();
  const decisionOf = b => b.decision_id && D.get(b.decision_id), branch = d => d.paths.length > 1;

  // ── slide content: schema-3 blocks in reveal order, or a legacy surface's scene, points and results ──
  function blockRows(b, title, inBox) {
    switch (b.type) {
      case 'text': return b.paragraphs.length === 1 && runText(b.paragraphs[0]) === title ? []
        : b.paragraphs.map(p => P(runText(p), p.style && p.style !== 'p' ? { size: 11 } : null));
      case 'quote': return b.paragraphs.map(p => ['P', { runs: runText(p), colour: 'muted', indent: 12 }]);
      case 'list': return [['L', { ordered: b.ordered, items: b.items.map(runText) }]];
      case 'callout': {
        const [first, ...rest] = b.paragraphs, headed = rest.length && (first.runs ?? []).every(r => r.bold);
        const rows = headed ? [P(runText(first), { colour: 'petrol' }), ['L', { items: rest.map(runText) }]] : b.paragraphs.map(p => P(runText(p)));
        // CASE-344: a callout's icon is drawn beside its rows as decoration; the words carry the meaning.
        return inBox ? rows : [['BOX', { fill: 'quiet', kind: 'callout', ...(typeof b.icon === 'string' ? { icon: b.icon } : {}), rows }]];
      }
      case 'values': return [['TABLE', { cols: [3, 2], rows: b.rows.map(r => [r.label, r.unit ? `${r.value} ${r.unit}` : r.value]) }]];
      case 'table': {
        const head = b.header_row && b.columns.some(c => c.label) ? b.columns.map(c => c.label) : null;
        return [['TABLE', { cols: b.columns.map(c => c.width || 1), ...(head ? { head } : {}), rows: b.rows.map(r => r.cells) }], ...(b.caption ? [P(b.caption, { colour: 'muted', size: 9 })] : [])];
      }
      case 'timeline': return [['TABLE', { cols: [1, 4], rows: b.entries.map(e => [e.label, e.text]) }]];
      case 'trend': return trendRows(b);
      // A blood gas (CASE-311): its heading, then each group's name over the rows the room sees, flagged, with their ranges.
      // In compare mode (CASE-317) the samples follow the heading and each row reads oldest to newest ("30 → 40 → 60 mmHg").
      case 'gas': return [P(gasTitle(b), { colour: 'petrol' }), ...(gasColumns(b) ? [P(gasColumns(b).join(' → '), { colour: 'muted', size: 9 })] : []), ...gasVisible(b).flatMap(group => [P(group.label, { colour: 'muted', size: 9 }),
        ['TABLE', { cols: [3, 2, 2], rows: group.rows.map(row => [`${GAS_FLAG_MARK[gasFlag(row)] ?? ''} ${row.label}`.trim(), gasReading(b, row), gasRange(row)]) }]])];
      case 'image': return [P([sym('square', CHROME.image, 'line'), ` ${b.alt}`], { colour: 'muted' }), ...(b.caption ? [P(b.caption, { colour: 'muted', size: 9 })] : [])];
      default: return []; // a question block is drawn from its decision
    }
  }
  // A trend is a drawn figure whose text alternative carries every authored value, so nothing is lost to a reader.
  function trendRows(b) {
    const n = b.points.length, vals = b.series.flatMap(s => s.values.map(Number)).filter(Number.isFinite);
    let lo = Number(b.y_min), hi = Number(b.y_max); if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { lo = Math.min(...vals); hi = Math.max(...vals) + 1; }
    const W = 300, x = i => 20 + (n > 1 ? i * (W - 40) / (n - 1) : (W - 40) / 2), y = v => 14 + (1 - (v - lo) / (hi - lo)) * 46, draw = [];
    b.points.forEach((p, i) => draw.push({ text: p.label ?? '', x: x(i) - 8, y: 76, size: 7 }));
    b.series.forEach((s, k) => {
      const pts = s.values.map((v, i) => [x(i), y(Number(v))]).filter(([, py]) => Number.isFinite(py));
      if (pts.length > 1) draw.push({ line: pts, stroke: k ? MARKS[k].fill.slice(1) : 'petrol', width: 1.6 });
      s.values.forEach((v, i) => { const py = y(Number(v)); if (Number.isFinite(py)) draw.push({ sym: 'rev', x: x(i) - 3, y: py - 3.3, size: 6, colour: k ? MARKS[k].fill.slice(1) : 'petrol' }, { text: v, x: x(i) - 6, y: py - 6, size: 7, colour: 'ink' }); });
    });
    const alt = b.series.map(s => `${s.label}${b.y_unit ? ` (${b.y_unit})` : ''}: ${b.points.map((p, i) => `${p.label ?? ''} ${s.values[i] ?? ''}`).join(', ')}`).join('; ');
    return [['DIAGRAM', { alt: alt.slice(0, 2000), height: 84, draw }], ...(b.caption ? [P(b.caption, { colour: 'muted', size: 9 })] : [])];
  }
  function legacyRows(s) {
    if (!s) return [];
    const one = x => [...paras(x.scene).map(t => P(t)), ...(x.points?.length ? [['L', { items: x.points }]] : []), ...(x.investigations?.length ? [['L', { items: x.investigations }]] : [])];
    const rows = [...one(s), ...(s.observations?.length ? [['TABLE', { cols: [3, 2], rows: s.observations.map(o => [o.label, o.unit ? `${o.value} ${o.unit}` : String(o.value)]) }]] : [])];
    const flags = new Map((doc.flags ?? []).map(f => [f.key, f.label]));
    for (const v of s.variants ?? []) rows.push(P(`${CHROME.when} ${(v.when_flags ?? []).map(k => flags.get(k) ?? k).join(', ')}`, { colour: 'muted', size: 9 }), ...one(v), ...paras(v.notes).map(ink));
    return rows;
  }
  const body = (kind, id, surfaceId, title, inBox) => {
    const c = comp(kind, id);
    if (!c) return legacyRows(S.get(surfaceId));
    const ids = c.steps?.length ? c.steps.flatMap(s => s.block_ids) : c.reading_order ?? [];
    return ids.map(i => BL.get(i)).filter(Boolean).flatMap(b => blockRows(b, title, inBox));
  };
  // Only-you material: notes and rationale as text, cues after ▸. Inside a fork it stays violet text in the dashed card.
  const privateRows = (texts, cues) => [...texts.flatMap(paras).map(ink), ...cues.flatMap(c => T(c).trim() ? [P([sym('cue', CHROME.cue, 'privateInk'), ` ${T(c).trim()}`], { colour: 'privateInk' })] : [])];
  const privateBox = rows => rows.length ? [['BOX', { fill: 'private', kind: 'private', rows }]] : [];
  // A card holds its own only-you block (prototypes/debrief-pdfs.html); inside a fork everything stays one card.
  const card = (kind, rows, priv, inBox, box) => inBox ? [...rows, ...priv] : [['BOX', { ...box, kind, rows: [...rows, ...privateBox(priv)] }]];
  const clarRows = (b, inBox) => clars.filter(c => !clarPlaced.has(c.id) && c.beat_ids?.includes(b.id)).flatMap(c => {
    clarPlaced.add(c.id); const s = S.get(c.surface_id);
    const rows = [P([sym('clar', CHROME.clarification, 'petrol'), ` ${c.label}`]), ...body('clarification', c.id, c.surface_id, c.label, true), ...paras(s?.notes).map(ink)];
    return inBox ? rows : [['BOX', { fill: 'quiet', kind: 'clar', node: { sym: 'clar', colour: 'petrol' }, rows }]];
  });
  const routeLine = (p, withRec) => P([{ text: p.label, bold: true }, '  ', sym(CLS[p.classification] ?? 'discussion', '', 'privateInk'), ` ${CHROME.classification[p.classification] ?? ''}`, ...(withRec && p.recommended ? [`  ·  ${CHROME.recommended}`] : [])], { colour: 'privateInk' });
  const routePrivate = (p, withRec) => [routeLine(p, withRec), ...privateRows([p.rationale, p.terminal?.debrief_prompt, p.recovery?.prompt], [p.cue])];

  function slideCard(b, n, inBox) {
    const head = ['H3', { runs: [...(n ? [{ text: `${n}  `, mono: true, bold: false, colour: 'muted', size: 9 }] : []), ...(inBox ? [sym('dot', '', 'petrol'), ' '] : []), short(b.title)] }];
    return [...card('slide', [head, ...body('beat', b.id, b.surface_id, b.title, inBox)], privateRows([S.get(b.surface_id)?.notes], [b.cue]), inBox,
      { fill: 'white', stroke: 'line', node: { sym: 'ring', colour: 'petrol' } }), ...clarRows(b, inBox)];
  }
  function questionCard(b, n, inBox) {
    const d = decisionOf(b), type = d.interaction?.type;
    const options = (d.interaction?.options ?? []).map((o, k) => [{ mark: k, label: MARKS[k % MARKS.length].name }, ` ${o.label}`]);
    const rows = [['H3', { runs: [...(n ? [{ text: `${n}  `, mono: true, bold: false, colour: 'muted', size: 9 }] : []), sym(IG[type] ?? 'single', CHROME.interaction[type] ?? '', 'ink'), ` ${T(d.prompt)}`] }],
      ...body('beat', b.id, b.surface_id, b.title, true), ...(options.length ? [['L', { columns: 2, labels: 'none', tight: true, size: 9.5, items: options }]] : [])];
    const priv = [...privateRows([S.get(b.surface_id)?.notes], []), ...d.paths.flatMap((p, k) => [...(k ? [['GAP', 5]] : []), ...routePrivate(p, branch(d))]), ...privateRows([], [b.cue])];
    return [...card('ask', rows, priv, inBox, { fill: 'quiet', node: { sym: 'node', colour: 'ink' } }), ...clarRows(b, inBox)];
  }
  function revealRows(p, inBox) {
    const s = S.get(p.reveal_surface_id); if (!s) return [];
    const rows = [['H3', { runs: [...(inBox ? [sym('rev', '', 'consequence'), ' '] : []), short(s.title)] }], ...body('path', p.id, s.id, s.title, true)];
    return card('reveal', rows, privateRows([s.notes], []), inBox, { fill: 'white', stroke: 'consequenceLine', node: { sym: 'rev', colour: 'consequence' } });
  }
  const beatRows = (b, n, inBox) => decisionOf(b) ? [...questionCard(b, n, inBox), ...revealRows(rec(decisionOf(b)), inBox)] : slideCard(b, n, inBox);
  // An alternative: its classification, its revealed slide (or one line when it reveals what the recommended route
  // reveals), the slides only it reaches, then where it rejoins (a terminal route resets to its checkpoint).
  function forkRows(d, p) {
    const main = rec(d), rows = [P([sym(CLS[p.classification] ?? 'discussion', '', 'ink'), ` ${CHROME.classification[p.classification] ?? ''}`])];
    if (p.reveal_surface_id === main.reveal_surface_id) rows.push(P([sym('arrow', CHROME.reveals, 'muted'), ` ${S.get(p.reveal_surface_id)?.title ?? ''}`]));
    else rows.push(...revealRows(p, true));
    let x = B.get(p.next_beat_id);
    for (; x && !placed.has(x.id); x = after(x)) { placed.add(x.id); rows.push(...beatRows(x, null, true)); }
    const rejoin = p.terminal ? B.get(p.terminal.checkpoint_beat_id) : x;
    if (rejoin) rows.push(P([sym('join', CHROME.rejoins, 'muted'), ` ${rejoin.title}`]));
    return [['BOX', { fill: 'white', stroke: 'field', dash: true, kind: 'fork', node: { sym: 'arrow', colour: 'muted' }, rows }]];
  }

  // ── cover ──
  const digest = /^(?:\\x)?([0-9a-f]{8})/i.exec(sha256 ?? '')?.[1];
  const meta = [versionNo != null && `${CHROME.version} ${versionNo}${digest ? ` · ${digest.slice(0, 4)} ${digest.slice(4)}` : ''}`,
    doc.duration_min && `${doc.duration_min} ${CHROME.minutes}`, doc.audience, doc.setting].filter(Boolean);
  const rows = [...openingRows({ title: doc.title, label: CHROME.header, labelColour: 'privateInk', band }), kicker(CHROME.kicker), ['H1', doc.title],
    ...(doc.summary ? [P(doc.summary, { size: 10.5 })] : []), ...(meta.length ? [P(meta.join('  ·  '), { colour: 'muted', size: 8.5 })] : [])];
  if (doc.learning_objectives?.length) rows.push(['SECT', { title: CHROME.objectives }], ['L', { columns: 2, labels: 'nn', size: 9.5, items: doc.learning_objectives }], ['/SECT']);
  // ── at a glance: the main route as one line; diamonds for questions, filled where the question changes the route (pdf-glance.mjs) ──
  const qs = order.filter(decisionOf), n = order.length, draw = glanceDraw(routeSummary(doc));
  const alt = CHROME.glanceAlt.replace('{n}', n).replace('{q}', qs.length).replace('{b}', qs.filter(b => branch(decisionOf(b))).length);
  // One line, once: each shape and colour with its word (glyphs are silent for a reader; the word follows).
  const KEYSYM = [['dot', 'petrol'], ['dia', 'ink'], ['rev', 'consequence'], ['arrow', 'muted'], ['join', 'muted'], ['square', 'privateInk'], ['cue', 'privateInk'], ['clar', 'petrol'], ['single'], ['multi'], ['ranking'], ['free']];
  const key = CHROME.key.flatMap((w, i) => [sym(KEYSYM[i][0], '', KEYSYM[i][1] ?? 'ink'), ` ${w}   `]);
  rows.push(['SECT', { title: CHROME.glance }], ['DIAGRAM', { alt, height: 66, draw }], P(key, { colour: 'muted', size: 7.5 }), ['/SECT']);
  // ── run sheet: one row per main-route beat, with its kind and cue ──
  rows.push(['SECT', { title: CHROME.runSheet }], ['TABLE', { cols: [1, 9, 10], size: 8.5, pad: 5, rows: order.map((b, i) => { const d = decisionOf(b);
    return [{ runs: [{ text: pad(i + 1), mono: true, colour: 'muted' }] }, { runs: d ? [sym('dia', '', 'ink'), sym(IG[d.interaction?.type] ?? 'single', CHROME.interaction[d.interaction?.type] ?? '', 'ink'), ` ${b.title}`] : [sym('dot', '', 'petrol'), ` ${b.title}`] }, T(b.cue)]; }) }], ['/SECT']);
  // ── The Case: a chapter opens where a title's "Label · " prefix changes ──
  rows.push(['SECT', { title: CHROME.theCase }], ['RAIL']);
  let chapter = null;
  const opens = t => { const p = part(t); if (!p || p === chapter) return []; chapter = p; return [['GAP', 4], kicker(p)]; };
  order.forEach((b, i) => {
    const d = decisionOf(b), n = pad(i + 1);
    rows.push(...opens(b.title));
    if (!d) { rows.push(...slideCard(b, n, false)); return; }
    rows.push(...questionCard(b, n, false));
    if (branch(d)) for (const p of d.paths.filter(p => p !== rec(d))) rows.push(...forkRows(d, p));
    const s = S.get(rec(d).reveal_surface_id);
    if (s) rows.push(...opens(s.title), ...revealRows(rec(d), false));
  });
  rows.push(['/RAIL'], ['/SECT']);
  // Completeness: a slide no route reaches still appears, so no authored content is dropped.
  const rest = doc.beats.filter(b => !placed.has(b.id)), restClars = () => clars.filter(c => !clarPlaced.has(c.id));
  if (rest.length || restClars().length) {
    rows.push(['SECT', { title: CHROME.otherSlides }], ['RAIL']);
    for (const b of rest) { placed.add(b.id); rows.push(...beatRows(b, null, false)); }
    for (const c of restClars()) { clarPlaced.add(c.id); rows.push(['BOX', { fill: 'quiet', kind: 'clar', rows: [P([sym('clar', CHROME.clarification, 'petrol'), ` ${c.label}`]), ...body('clarification', c.id, c.surface_id, c.label, true)] }]); }
    rows.push(['/RAIL'], ['/SECT']);
  }
  return linked(rows);
}

/** The case's braid for the cover band, from the shared art chunk (already loaded on /cases and the console); none if it fails. */
async function caseBand(doc) { try { const { pdfBandFor, artForDocument } = await import('./splash.mjs'); return pdfBandFor(artForDocument(doc), { contentSeed: doc.title }); } catch { return null; } }
/** The built-in tagged PDF; the writer is loaded only here, so Print never loads it. */
export async function briefingPdf(doc, meta, { deflate = false } = {}) {
  const [writer, band] = await Promise.all([import('./session-pdf.mjs'), caseBand(doc)]);
  // Download deflates the streams; the plain file (the default) is what the tests read back.
  return (deflate ? writer.sessionPdfDeflated : writer.sessionPdf)(briefingRows(doc, { ...meta, band }), { title: doc.title });
}
/** Download: a blob link clicked once and revoked; returns a message when the PDF cannot faithfully hold the case. */
export async function downloadBriefing(doc, meta) {
  let bytes;
  try { bytes = await briefingPdf(doc, meta, { deflate: true }); }
  catch (error) {
    if (error?.message === 'pdf_font_unsupported') return 'The PDF font cannot represent a character in this case, and no text is substituted. Use Print briefing.';
    if (/budget/.test(error?.message ?? '')) return 'This case is longer than the PDF limit. Use Print briefing.';
    throw error;
  }
  const url = sessionRecordObjectUrl(new Blob([bytes], { type: 'application/pdf' })), a = node('a');
  a.href = url; a.download = pdfFileName(doc.title, 'Facilitator briefing', { version: meta?.versionNo ?? null }); a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return null;
}

// ── accessible print fallback: the same rows as semantic, text-only DOM ──
const GLYPH = { dot: '○', dia: '◆', rev: '●', single: '◉', multi: '☑', ranking: '⇅', free: '✎', sound: '●', defensible: '◯', context: '⑂', unsafe: '▲',
  terminal: '⬣', discussion: '▤', cue: '▸', join: '↩', arrow: '↳', clar: '＋', square: '■' };
function runsNode(tag, runs, cls) {
  const item = node(tag, null, cls);
  for (const r of typeof runs === 'string' ? [runs] : runs ?? []) {
    const href = r?.href && httpsHref(r.href);
    if (href) { const a = node('a', r.text); a.href = href; a.rel = 'noopener noreferrer'; a.target = '_blank'; item.append(a); }
    else if (typeof r === 'string' || typeof r?.text === 'string') item.append(typeof r === 'string' ? r : r.text);
    else if (r?.mark !== undefined) { const m = markSvg(r.mark, { size: 14, decorative: false }); item.append(m); }
    else if (r?.sym) { const s = node('span', GLYPH[r.sym] ?? '', `brief-sym brief-${r.colour ?? 'ink'}`); if (r.label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', r.label); } else s.setAttribute('aria-hidden', 'true'); item.append(s); }
  }
  return item;
}
const spec = v => typeof v === 'string' || Array.isArray(v) ? { runs: v } : v;
function rowNodes(parent, rows) {
  let host = parent;
  for (const [role, v] of rows) {
    if (role === 'SECT') { host = node('section'); parent.append(host); host.append(node('h2', v.title)); }
    else if (role === '/SECT') host = parent;
    else if (role === 'H1' || role === 'H2' || role === 'H3' || role === 'P') { const s = spec(v); host.append(runsNode(role === 'P' ? 'p' : role.toLowerCase(), s.runs, s.colour ? `brief-${s.colour}` : null)); }
    else if (role === 'L') { const list = node(v.ordered ? 'ol' : 'ul'); for (const it of v.items) list.append(runsNode('li', it)); host.append(list); }
    else if (role === 'TABLE') {
      const t = node('table', null, 'brief-table');
      if (v.head) { const tr = node('tr'); for (const h of v.head) { const th = runsNode('th', h); th.setAttribute('scope', 'col'); tr.append(th); } const head = node('thead'); head.append(tr); t.append(head); }
      const tb = node('tbody'); for (const r of v.rows) { const tr = node('tr'); for (const c of r) tr.append(runsNode('td', c?.runs ?? c)); tb.append(tr); } t.append(tb); host.append(t);
    } else if (role === 'BOX') { const box = node('div', null, `brief-box brief-${v.kind ?? 'box'}`); rowNodes(box, v.rows); host.append(box); }
    else if (role === 'DIAGRAM') host.append(diagramNode(v));
  }
}
// The glance and trends as SVG with their text alternative; drawn words are inside the image, read by its label.
function diagramNode(v) {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 499 ${v.height}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', v.alt); svg.setAttribute('class', 'brief-diagram');
  const mk = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, String(val)); if (text != null) e.textContent = text; svg.append(e); };
  for (const d of v.draw) {
    if (d.line) mk('polyline', { points: d.line.map(p => p.join(',')).join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': d.width ?? 1, ...(d.dash ? { 'stroke-dasharray': '3 2' } : {}) });
    else if (d.sym) mk('text', { x: d.x, y: d.y + (d.size ?? 10) * .85, 'font-size': d.size ?? 10, fill: d.colour === 'white' ? 'transparent' : 'currentColor' }, GLYPH[d.sym] ?? '');
    else if (typeof d.text === 'string') mk('text', { x: d.x, y: d.y, 'font-size': d.size ?? 8, fill: 'currentColor' }, d.text);
  }
  return svg;
}
/** Print: one private print root, the case title as the document title, everything cleared and restored after. */
export function printBriefing(doc, meta) {
  const root = node('article', null, 'private-session-print briefing-print'), previous = document.title;
  rowNodes(root, briefingRows(doc, meta).filter(([role]) => role !== 'ART'));
  const clear = () => { clearPrivate(root); root.remove(); document.body.classList.remove('printing-session-record'); document.title = previous; window.removeEventListener('afterprint', clear); };
  document.title = doc.title; document.body.append(root); document.body.classList.add('printing-session-record');
  window.addEventListener('afterprint', clear, { once: true });
  try { window.print(); } finally { clear(); }
}
