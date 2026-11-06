// Card 40b participant recap (card 40 + feedback integration, slice 7): the case journey, derived only from this phone's
// ended view. Every stop is an entry of `view.timeline` (what this room was shown, in order, resets included) or a recap
// round; each round joins its own question slide and its revealed slide follows (ruling I4: the round's `revealIndex`).
// No authoring, setting or extra field (Julian, 2026-10-17). Pure data: the phone screen and the lazy PDF both read it.
import { gasLines } from '../shared/slide-gas-view.mjs';

/** Classification words; the glyph always comes with the word (design system). */
export const CLASS_WORD = Object.freeze({ sound: 'Sound', defensible: 'Defensible', 'context-dependent': 'Context-dependent', unsafe: 'Unsafe · recoverable',
  'terminal-unsafe': 'Terminal · needs a checkpoint reset', 'discussion-prompt': 'Discussion prompt' });
export const SHAPE_WORD = Object.freeze({ single_choice: 'Single choice', multi_select: 'Select all that apply', ranking: 'Ranking', free_text: 'Free text' });
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const runs = p => (p?.runs ?? []).map(r => { const t = typeof r?.text === 'string' ? r.text : ''; return r?.script === 'sup' && /^\d+$/.test(t) ? [...t].map(c => SUP[c]).join('') : t; }).join('');
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const chapterOf = t => (str(t).includes(' · ') ? str(t).split(' · ')[0] : '');
export const shortTitle = t => (str(t).includes(' · ') ? str(t).split(' · ').slice(1).join(' · ') : str(t));

/**
 * One revealed entry as plain lines: { k: 'p'|'q'|'li'|'row'|'img', t, n?, cells?, id? } (an image line carries its block id). Released blocks only (the public
 * projection holds nothing else); a text block that only repeats the title is skipped, as the phone's slide does.
 */
export function entryLines(e) {
  const out = [], p = t => { t = str(t).trim(); if (t) out.push({ k: 'p', t }); };
  if (!e?.slide) {
    p(e?.scene);
    for (const o of e?.observations ?? []) out.push({ k: 'row', cells: [str(o.label), [o.value, o.unit].filter(x => x != null && x !== '').join(' ')] });
    for (const t of [...(e?.points ?? []), ...(e?.investigations ?? [])]) out.push({ k: 'li', t: str(t) });
    return out;
  }
  for (const b of e.slide.blocks ?? []) {
    const paras = b.paragraphs ?? [];
    if (b.type === 'text') { if (!(paras.length === 1 && runs(paras[0]) === e.title)) paras.forEach(x => p(runs(x))); }
    else if (b.type === 'quote') paras.forEach(x => out.push({ k: 'q', t: runs(x) }));
    else if (b.type === 'callout') {
      // A callout's paragraphs stay plain lines (the phone draws them as before); `c` groups them for the PDF's inner card, and `h`
      // marks an all-bold first paragraph that heads a list.
      const headed = paras.length > 1 && (paras[0].runs ?? []).length > 0 && paras[0].runs.every(r => r.bold);
      // `i` is its icon (CASE-344), drawn by the PDF beside the card as decoration.
      paras.forEach((x, i) => { const t = runs(x).trim(); if (t) out.push({ k: 'p', t, c: str(b.id), ...(headed && i === 0 ? { h: true } : {}), ...(typeof b.icon === 'string' ? { i: b.icon } : {}) }); });
    }
    else if (b.type === 'list') (b.items ?? []).forEach((x, i) => out.push({ k: 'li', t: runs(x), n: b.ordered ? i + 1 : null }));
    else if (b.type === 'values') for (const r of b.rows ?? []) out.push({ k: 'row', cells: [str(r.label), [r.value, r.unit].filter(Boolean).join(' ')] });
    else if (b.type === 'table') {
      if (b.header_row && (b.columns ?? []).some(c => c.label)) out.push({ k: 'row', head: true, cells: b.columns.map(c => str(c.label)) });
      for (const r of b.rows ?? []) out.push({ k: 'row', cells: (r.cells ?? []).map(str) });
      p(b.caption);
    } else if (b.type === 'timeline') for (const x of b.entries ?? []) out.push({ k: 'row', cells: [str(x.label), str(x.text)] });
    else if (b.type === 'trend') {
      for (const s of b.series ?? []) p(`${str(s.label)}${b.y_unit ? ` (${b.y_unit})` : ''}: ${(b.points ?? []).map((x, i) => `${str(x.label)} ${str(s.values?.[i])}`.trim()).join(', ')}`);
      p(b.caption);
    } else if (b.type === 'image') out.push({ k: 'img', id: b.id, t: [b.alt, b.caption].map(str).filter(Boolean).join(' ') });
    // A blood gas (CASE-311): its heading, then the rows the room saw, with their flags and ranges.
    else if (b.type === 'gas') { const [title, ...lines] = gasLines(b); p(title); for (const line of lines) out.push({ k: 'row', cells: [str(line)] }); }
  }
  return out;
}

const roomOf = x => (x && Number.isSafeInteger(x.total) && Array.isArray(x.options) && x.options.every(o => typeof o?.label === 'string' && Number.isSafeInteger(o.count))
  ? { total: x.total, options: x.options.map(o => ({ label: o.label, count: o.count })) } : null);
/** What a round's own answer was: its shape, the option marks in the shared order, and its words. */
function answer(r) {
  const y = r.yourResponse, ids = r.optionIds ?? [];
  const shape = y?.option_id ? 'single_choice' : y?.option_ids ? 'multi_select' : y?.order ? 'ranking' : y?.text != null ? 'free_text' : ids.length ? null : 'free_text';
  const mine = y?.option_id ? [y.option_id] : y?.option_ids ?? y?.order ?? [];
  return { shape, roundNo: r.roundNo, status: r.status, marks: mine.map(id => ids.indexOf(id)).filter(i => i >= 0),
    // A ranking reads as an ordered list; its words come joined by the room machine's arrow.
    words: r.yourAnswer == null ? [] : shape === 'ranking' ? str(r.yourAnswer).split(' → ') : [str(r.yourAnswer)],
    classification: CLASS_WORD[r.yourClassification] ? r.yourClassification : null, why: r.why ?? null, doDifferently: r.doDifferently ?? null,
    // Room PDFs v2: the room's split for a result the projector drew (the room machine's recap `room`), else null.
    room: roomOf(r.room) };
}

/** The journey: { title, objectives, feedbackCode, stops }. A stop is { kind: 'slide'|'reveal'|'question', index, title, chapter, lines, question? }. */
export function recapJourney(view) {
  const r = view?.recap ?? {}, tl = view?.timeline ?? [];
  // A question asked again straight away (a reopened round) is one ask; a round that revealed a slide closes its ask.
  const asks = [];
  for (const round of r.rounds ?? []) {
    const last = asks.at(-1);
    if (last && last.decisionId === round.decisionId && last.rounds.at(-1).revealIndex == null) last.rounds.push(round);
    else asks.push({ decisionId: round.decisionId, rounds: [round] });
  }
  const anchor = a => { const i = a.rounds.at(-1).revealIndex; return Number.isInteger(i) && i >= 0 && i < tl.length && ['consequence', 'terminal'].includes(tl[i].timelineKind) ? i : null; };
  const live = e => e?.timelineKind === 'live', asked = e => live(e) && (!e.slide || e.slide.blocks?.some(b => b.type === 'question'));
  const joined = new Map(), before = new Map(), put = (i, a) => before.set(i, [...(before.get(i) ?? []), a]);
  let cursor = -1;
  asks.forEach((a, k) => {
    const at = anchor(a); let j = -1;
    if (at !== null && at > cursor) {
      // Its own slide is the nearest live entry before the slide it revealed (clarifications may sit between).
      for (let i = at - 1; i > cursor; i--) if (live(tl[i])) { if (asked(tl[i]) && !joined.has(i)) j = i; break; }
      if (j < 0) put(at, a); cursor = at;
    } else {
      // An ask that revealed nothing joins the next released question slide before the next ask that did.
      const next = asks.slice(k + 1).map(anchor).find(x => x !== null && x > cursor) ?? tl.length;
      for (let i = cursor + 1; i < next; i++) if (asked(tl[i]) && tl[i].slide && !joined.has(i)) { j = i; break; }
      if (j < 0) put(cursor + 1, a); else cursor = j;
    }
    if (j >= 0) joined.set(j, a);
  });
  const question = a => { const rounds = a.rounds.map(answer); return { prompt: a.rounds[0].prompt, shape: rounds.find(x => x.shape)?.shape ?? null, rounds }; };
  const stops = [];
  for (let i = 0; i <= tl.length; i++) {
    for (const a of before.get(i) ?? []) stops.push({ kind: 'question', index: null, title: null, lines: [], question: question(a) });
    const e = tl[i]; if (!e) continue;
    const a = joined.get(i);
    stops.push({ kind: a ? 'question' : ['consequence', 'terminal'].includes(e.timelineKind) ? 'reveal' : 'slide', index: i, title: str(e.title), lines: entryLines(e), ...(a ? { question: question(a) } : {}) });
  }
  let chapter = '';
  for (const s of stops) { const c = chapterOf(s.title); s.chapter = c && c !== chapter ? c : null; if (c) chapter = c; }
  const code = typeof r.feedbackCode === 'string' && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(r.feedbackCode) ? r.feedbackCode : null;
  return { title: str(r.caseTitle ?? view?.caseTitle), objectives: [...(r.learningPoints ?? [])].map(str), feedbackCode: code, stops };
}
