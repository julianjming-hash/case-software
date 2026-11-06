// Card 40b participant recap PDF (card 40 + feedback integration, slice 7). A lazy chunk the live phone imports only when
// Download recap (PDF) is pressed; it loads the built-in tagged writer (session-pdf.mjs) only then. The rows come from the
// journey model (recap-journey.mjs), so the file holds only what this phone was shown and its own answers: no name,
// token, id, feedback code or URL, in the text or the title. Order (prototypes/debrief-pdfs.html `recap()`): the case
// title, Objectives, then The Case, one stop per slide, question and revealed slide. Nothing is kept or sent.
// Julian's ruling 1 (2026-10-17): each image the phone was shown is embedded in its stop, the phone's own JPEG copy (or a GIF's
// or video's poster) unchanged, with its credit printed under it so CC BY / BY-SA licences are honoured. Only image blocks of
// the view's timeline (revealed), and only credits the ended recap carries for them; slides keep credits facilitator-only.
import { CLASS_WORD, SHAPE_WORD, shortTitle, recapJourney } from './recap-journey.mjs';
import { MARKS } from './projector-marks.mjs';
import { formattedTextPlainText } from '../shared/builder-format.mjs';
import { sessionRecordObjectUrl } from '../shared/urls.mjs';
import { openingRows, kicker, pdfFileName, fileDate } from './pdf-chrome.mjs';

/** Every fixed word the recap PDF prints. */
export const RECAP_CHROME = Object.freeze({ kicker: 'Your recap', room: 'The room', roomFirst: 'The room · ranked first', objectives: 'Objectives', theCase: 'The Case', round: 'Round', image: 'Image', noAnswer: 'No answer',
  key: Object.freeze(['slide', 'question', 'revealed by a question', 'your answer']) });
const PIGMENT = ['d34b36', '5e74cc', 'e9a51d', '378862', '9c61b5', '21858c', 'ba611c', '6b7b82'];
const SYM = { single_choice: 'single', multi_select: 'multi', ranking: 'ranking', free_text: 'free' };
const CLS = { sound: 'sound', defensible: 'defensible', 'context-dependent': 'context', unsafe: 'unsafe', 'terminal-unsafe': 'terminal', 'discussion-prompt': 'discussion' };
const T = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? formattedTextPlainText(v) : '');
const sym = (s, label = '', colour) => ({ sym: s, label, ...(colour ? { colour } : {}) });
const mark = i => ({ mark: i, label: MARKS[i % MARKS.length].name });
const P = (runs, extra) => ['P', { runs, ...extra }];
// Vital-sign trends and orders carry an arrow the embedded font lacks: it is drawn as a shape whose /ActualText is the arrow,
// so the extracted text stays exact (the writer's own rule for symbols); nothing is substituted.
const R = (t, colour) => String(t ?? '').split('→').flatMap((part, i) => [...(i ? [{ ...sym('arrow', '→'), ...(colour ? { colour } : {}) }] : []), ...(part ? [colour ? { text: part, colour } : part] : [])]);

/** Images past this many bytes in all, in timeline order, stay their text line, so the PDF keeps a sensible size. */
export const RECAP_IMAGE_BYTES = 4 * 1048576;

/**
 * The images to embed: Map(block id → { bytes, alt, caption }) for each released image block of the view's timeline, read
 * once through `still(block)`. A withdrawn, unreadable, non-JPEG (`jpegShape`) or over-budget image is left out.
 */
export async function recapFigures(view, still, jpegShape) {
  const blocks = new Map(), figs = new Map();
  for (const e of view?.timeline ?? []) for (const b of e?.slide?.blocks ?? []) if (b?.type === 'image' && b.media?.handle && !blocks.has(b.id)) blocks.set(b.id, b);
  const read = await Promise.all([...blocks.values()].map(async b => { try { return await still(b); } catch { return null; } }));
  let total = 0;
  [...blocks.values()].forEach((b, i) => {
    const bytes = read[i];
    if (bytes instanceof Uint8Array && jpegShape(bytes) && total + bytes.length <= RECAP_IMAGE_BYTES) { total += bytes.length; figs.set(b.id, { bytes, alt: T(b.alt).slice(0, 300), caption: T(b.caption).slice(0, 400) }); }
  });
  return figs;
}

/** A stop's lines as writer rows; consecutive list items and table rows group into one list or table; an image with its credit under it. */
function lineRows(lines, figs, credits) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.k === 'li') { const items = [], ordered = l.n != null; while (lines[i]?.k === 'li' && (lines[i].n != null) === ordered) items.push(R(lines[i++].t)); rows.push(['L', { ordered, items, size: 9.5 }]); continue; }
    if (l.k === 'row') {
      const group = []; while (lines[i]?.k === 'row') group.push(lines[i++]);
      const width = Math.max(...group.map(r => r.cells.length)), pad = r => [...r.cells, ...Array(width - r.cells.length).fill('')].map(c => ({ runs: R(c) }));
      // Two columns read as label and value (bold label, no rules); wider tables keep their rules and header.
      const pairs = width === 2 && !group[0].head;
      rows.push(['TABLE', { cols: pairs ? [1, 3] : Array(width).fill(1), size: 9.5, rules: !pairs, pad: pairs ? 3 : 6, boldFirst: pairs, ...(group[0].head ? { head: pad(group[0]) } : {}), rows: group.filter(r => !r.head).map(pad) }]);
      continue;
    }
    if (l.c) {
      // A callout: an inner card; a bold first paragraph heads the rest as a list.
      const group = []; while (lines[i]?.c === l.c) group.push(lines[i++]);
      const [first, ...rest] = group, headed = first.h && rest.length;
      rows.push(['BOX', { fill: 'quiet', ...(first.i ? { icon: first.i, iconSize: 14 } : {}), rows: headed ? [P(R(first.t), { bold: true, size: 9.5 }), ['L', { size: 9.5, items: rest.map(x => R(x.t)) }]] : group.map(x => P(R(x.t), { size: 9.5 })) }]);
      continue;
    }
    if (l.k === 'img') {
      const fig = figs.get(l.id), credit = credits?.[l.id];
      rows.push(fig ? ['FIG', { ...fig, maxHeight: 280 }] : P([sym('square', RECAP_CHROME.image, 'line'), ' ', ...R(l.t)], { colour: 'muted' }));
      if (typeof credit === 'string' && credit) rows.push(P(R(credit), { colour: 'muted', size: 7.5 }));
    } else rows.push(P(R(l.t), l.k === 'q' ? { colour: 'muted', indent: 12 } : { size: 9.5 }));
    i++;
  }
  return rows;
}

function answerRows(q) {
  const many = q.rounds.length > 1;
  return q.rounds.flatMap(a => {
    const head = many ? [P(`${RECAP_CHROME.round} ${a.roundNo}`, { colour: 'muted', size: 8 })] : [];
    // Your own answer sits in a tinted chip under the prompt, with its option marks (prototypes/debrief-pdfs.html).
    const said = !a.words.length ? [P(RECAP_CHROME.noAnswer, { colour: 'muted', size: 9 })]
      : q.shape === 'ranking' ? [['BOX', { fill: 'tint', pad: 8, rows: [['L', { ordered: true, size: 9.5, items: a.words.map((w, k) => [...(a.marks[k] != null ? [mark(a.marks[k]), ' '] : []), ...R(w)]) }]] }]]
        : [P([...a.marks.flatMap(m => [mark(m), ' ']), ...R(a.words.join(''))], { chip: 'tint', size: 9.5 })];
    const cls = a.classification ? [P([sym(CLS[a.classification], '', 'ink'), ` ${CLASS_WORD[a.classification]}`], { size: 9 })] : [];
    const teach = [a.why, a.doDifferently].map(T).filter(Boolean).map(t => P(R(t), { colour: 'muted', size: 9 }));
    // Room PDFs v2: the room's split for a result the projector drew, your own option in bold.
    const room = a.room ? [P(q.shape === 'ranking' ? RECAP_CHROME.roomFirst : RECAP_CHROME.room, { colour: 'muted', size: 8, bold: true }), ['TABLE', { cols: [0.45, 5, 3.2, 0.7], rules: false, pad: 3, size: 8.5, rows: a.room.options.map((o, k) => [
      { runs: [mark(k)] }, { runs: [{ text: o.label, bold: q.shape === 'ranking' ? a.marks[0] === k : a.marks.includes(k) }] }, { bar: { value: o.count, total: Math.max(1, a.room.total, o.count), colour: PIGMENT[k % PIGMENT.length] } },
      { runs: [{ text: String(o.count), mono: true }], align: 'end' }]) }]] : [];
    return [...head, ...said, ...cls, ...room, ...teach];
  });
}

/** The recap as the writer's rows; `figs` (recapFigures) and `credits` (the recap's imageCredits) place its images. */
export function recapRows(journey, { figs = new Map(), credits = {}, band = null } = {}) {
  const rows = [...openingRows({ title: journey.title, label: RECAP_CHROME.kicker, band }), kicker(RECAP_CHROME.kicker), ['H1', { runs: R(journey.title) }]];
  if (journey.objectives.length) rows.push(['SECT', { title: RECAP_CHROME.objectives }], ['L', { columns: 2, labels: 'nn', size: 9.5, items: journey.objectives.map(t => R(t)) }], ['/SECT']);
  if (!journey.stops.length) return rows;
  // One key, once: each shape and colour with its word, so the cards carry no repeated labels.
  const KEY = [['ring', 'petrol'], ['node', 'ink'], ['rev', 'consequence'], ['square', 'tint']];
  rows.push(['SECT', { title: RECAP_CHROME.theCase }], P(RECAP_CHROME.key.flatMap((w, i) => [sym(KEY[i][0], '', KEY[i][1]), ` ${w}     `]), { colour: 'muted', size: 8 }), ['RAIL']);
  for (const s of journey.stops) {
    if (s.chapter) rows.push(['GAP', 4], kicker(s.chapter));
    const body = lineRows(s.lines, figs, credits);
    if (s.kind === 'question') {
      const q = s.question, head = ['H3', { runs: [...(q.shape ? [sym(SYM[q.shape], SHAPE_WORD[q.shape], 'ink'), ' '] : []), ...R(T(q.prompt))] }];
      rows.push(['BOX', { fill: 'quiet', node: { sym: 'node', colour: 'ink' }, rows: [head, ...body, ...answerRows(q)] }]);
    } else {
      const reveal = s.kind === 'reveal', head = ['H3', { runs: R(shortTitle(s.title)) }];
      rows.push(['BOX', { fill: 'white', stroke: reveal ? 'consequenceLine' : 'line', node: reveal ? { sym: 'rev', colour: 'consequence' } : { sym: 'ring', colour: 'petrol' }, rows: [head, ...body] }]);
    }
  }
  rows.push(['/RAIL'], ['/SECT']);
  return rows;
}

/**
 * Download: the built-in tagged PDF as a blob link, clicked once and revoked. `still(block)` reads a revealed image's JPEG bytes
 * (the live phone's recapStill). Returns a message when the PDF cannot faithfully hold the recap.
 */
export async function downloadRecap(view, still = async () => null, band = null) {
  const journey = recapJourney(view);
  let bytes;
  try {
    const { sessionPdfDeflated, jpegShape } = await import('./session-pdf.mjs'), figs = await recapFigures(view, still, jpegShape);
    bytes = await sessionPdfDeflated(recapRows(journey, { figs, credits: view?.recap?.imageCredits, band }), { title: journey.title || RECAP_CHROME.kicker, maxBytes: RECAP_IMAGE_BYTES + 2 * 1048576 });
  }
  catch (error) {
    if (error?.message === 'pdf_font_unsupported') return 'The PDF font cannot show a character in this recap, and no text is substituted. Use Print recap.';
    if (/budget/.test(error?.message ?? '')) return 'This recap is longer than the PDF limit. Use Print recap.';
    return 'The PDF could not be made. Use Print recap.';
  }
  const url = sessionRecordObjectUrl(new Blob([bytes], { type: 'application/pdf' })), a = document.createElement('a');
  a.href = url; a.download = pdfFileName(journey.title, 'Recap', { date: fileDate(view?.endedAt) }); a.hidden = true; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return null;
}
