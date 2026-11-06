// The Finish block (room PDFs v2, Julian 2026-10-18; prototypes/finish-flow.html): one place to finish a session, first on
// the ended phone screen and on the /F page, in two zones. "Your participant record" (a white card: the case's braid, time,
// decisions, objectives, you and the room, I can now (pre-ticked), My Takehome, the CPD details as an editable
// summary, Download) holds what goes into the PDF; "Feedback · anonymous" (a tinted panel: three 1–5 ratings, each with a
// comment behind a speech-bubble button) holds what is sent. Nothing gates anything. Ratings save on tap and text on blur,
// through feedback-client.mjs; what is typed for the record stays in this block's memory and the PDF. Text-only DOM.
import { FEEDBACK_TEXT_MAX, normaliseFeedbackAnswers } from '../shared/feedback.mjs';
import { identifierWarning } from '../shared/identifiers.mjs';
import { markSvg, MARKS } from './projector-marks.mjs';
import { ACTIVITY, defaultHours, parseHours } from './participant-record-fields.mjs';

const RATINGS = [['session', 'The session', 'Not useful', 'Very useful'], ['case', 'The case', 'Not realistic', 'Very realistic'], ['app', 'The app', 'Hard to use', 'Easy to use']];
export const FINISH_COPY = Object.freeze({
  heading: 'Your participant record', feedback: 'Feedback · anonymous', minutes: 'min', decisions: 'decisions', topics: 'objectives',
  canNow: 'I can now', comment: label => `Comment on ${label.toLowerCase()}`, addComment: label => `Add a comment on ${label.toLowerCase()}`, commentHint: "Optional · please don't include names", takeHome: 'My Takehome',
  takeHint: "One thing you're taking to work", share: 'Share anonymously', saving: 'Saving…',
  saved: until => `Saved${until ? ` · you can change it until ${until}` : ''}`, download: 'Download participant record (PDF)', making: 'Making PDF…', made: 'PDF made on this phone · check your downloads',
  details: 'Your details', edit: 'Edit', done: 'Done', noName: 'Add your name', hours: 'Enter hours as a number up to 24, for example 1.5',
  closed: 'Feedback for this session has closed. Your record still downloads.', roomSplit: 'You and the room',
  errors: Object.freeze({ closed: 'Feedback for this session has closed.', not_open: 'Feedback opens when the session ends.', full: "This session isn't taking more responses.",
    edit_cap: "This response can't be changed again.", changed: 'Your feedback changed elsewhere · try again', challenge: "Couldn't check this browser · try again",
    offline: 'Not saved · check your connection', invalid: 'Not saved · check what you typed' }),
});
const until = iso => { const d = new Date(iso ?? NaN); return Number.isNaN(+d) ? '' : `${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${d.toLocaleDateString([], { weekday: 'long' })}`; };
const reduced = win => { try { return win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; } };

/**
 * Build the block. `summary`: record-summary.mjs. `saver`: feedback-client.mjs, or null when the room has no open feedback.
 * `saved`: answers already sent from this phone or browser. Returns { node, focus() }; the node keeps its own state, so a
 * caller that redraws re-appends the same node.
 */
export function createFinishBlock({ win = globalThis.window, summary, saver = null, saved = null, closesAt = null, feedbackClosed = false, download, bandArt = null }) {
  const doc = win.document;
  const h = (tag, props = {}, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'string' ? doc.createTextNode(c) : c);
    return e;
  };
  const answers = { ...(saved ?? {}) };
  let share = true, deadline = closesAt;
  const NS = 'http://www.w3.org/2000/svg';
  // A small line icon (decorative; its button carries the words): the comment bubble, the eye, the pencil.
  const icon = d => { const svg = doc.createElementNS(NS, 'svg'), path = doc.createElementNS(NS, 'path');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'finish-icon');
    path.setAttribute('d', d); svg.append(path); return svg; };
  const BUBBLE = 'M4 4h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 14H9l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 4z';
  const EYE = 'M1.5 10s3-5.5 8.5-5.5S18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10zM10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z';
  const PENCIL = 'M13.5 3.5l3 3L7 16H4v-3z';

  // ── zone 1: your participant record (what goes into the PDF) ──
  const card = h('section', { class: 'finish-record', 'aria-labelledby': 'finishH' });
  // The case's braid (the shared art chunk's SVG, passed in by the ended phone screen; Julian 2026-10-18), else no band.
  const band = typeof bandArt === 'function' ? (() => { try { const svg = bandArt(); const box = h('div', { class: 'finish-band', 'aria-hidden': 'true' }); box.append(svg); return box; } catch { return null; } })() : null;
  const stat = (value, of, word) => h('div', { class: 'finish-stat', role: 'listitem' }, h('b', { 'data-count': String(value) }, String(value), of != null ? h('small', { text: `/${of}` }) : null), h('span', { text: word }));
  const stats = h('div', { class: 'finish-stats', role: 'list' },
    summary.minutes != null ? stat(summary.minutes, null, FINISH_COPY.minutes) : null,
    summary.decisions?.total ? stat(summary.decisions.made, summary.decisions.total, FINISH_COPY.decisions) : null,
    summary.topics ? stat(summary.topics, null, FINISH_COPY.topics) : null);
  card.append(band, h('h2', { id: 'finishH', tabindex: '-1', text: FINISH_COPY.heading }), stats.childElementCount ? stats : null);
  if (summary.room?.length) {
    // Folded: one row per shown result could be long; the summary line says how many.
    const box = h('details', { class: 'finish-room' }, h('summary', {}, `${FINISH_COPY.roomSplit} · ${summary.room.length}`));
    for (const q of summary.room) {
      const list = h('ul', { class: 'finish-split', 'aria-label': q.prompt });
      for (const o of q.options) {
        const bar = h('span', { class: 'finish-bar' }, h('i', { class: `mark-${o.mark % MARKS.length}` }));
        bar.firstChild.style.width = `${Math.round((o.count / Math.max(1, q.total)) * 100)}%`;
        list.append(h('li', { class: o.mine ? 'mine' : null }, markSvg(o.mark, { size: 14, decorative: true }), h('span', { text: o.mine ? `${o.label} · you` : o.label }), bar, h('span', { class: 'finish-n', text: String(o.count) })));
      }
      box.append(h('p', { class: 'finish-q', text: q.prompt }), list);
    }
    card.append(box);
  }
  // I can now: the objectives start ticked (Julian, 2026-10-18); untick any you are not sure of. Compact chips.
  const canNow = new Set((summary.objectives ?? []).map((_, i) => i));
  if (summary.objectives?.length) {
    const list = h('div', { class: 'finish-cando', role: 'group', 'aria-label': FINISH_COPY.canNow });
    summary.objectives.forEach((o, i) => {
      const b = h('button', { type: 'button', 'aria-pressed': 'true' }, h('span', { class: 'finish-box', 'aria-hidden': 'true' }), h('span', { class: 'finish-chip-t', text: o }));
      b.addEventListener('click', () => { const on = !canNow.has(i); if (on) canNow.add(i); else canNow.delete(i); b.setAttribute('aria-pressed', String(on)); });
      list.append(b);
    });
    card.append(h('div', {}, h('p', { class: 'finish-sub', text: FINISH_COPY.canNow }), list));
  }

  // ── saving ──
  const status = h('p', { class: 'finish-status', role: 'status', 'aria-live': 'polite' });
  const current = () => normaliseFeedbackAnswers(Object.fromEntries(Object.entries({
    rating_session: answers.rating_session ?? null, rating_case: answers.rating_case ?? null, rating_app: answers.rating_app ?? null,
    comment_session: answers.comment_session || null, comment_case: answers.comment_case || null, comment_app: answers.comment_app || null,
    takeaway: share ? answers.takeaway || null : null })));
  let sentOnce = Boolean(saved), pending = null;
  // Ratings save 2 s after the last change, text when its field loses focus, and anything waiting when the page is hidden
  // (room PDFs v2: one or two saves a phone, so a 200-phone room stays well inside the venue's request limit).
  const later = () => { win.clearTimeout(pending); pending = win.setTimeout(() => { pending = null; void save(); }, 2000); };
  const flush = () => { if (pending) { win.clearTimeout(pending); pending = null; void save(); } };
  win.addEventListener('pagehide', flush); doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') flush(); });
  async function save() {
    if (!saver) return;
    win.clearTimeout(pending); pending = null;
    const a = current();
    if (!a.ok) { if (sentOnce) status.textContent = ''; return; } // nothing to send yet (or text too long: its field says so)
    status.className = 'finish-status'; status.textContent = FINISH_COPY.saving;
    const r = await saver.save(a.answers);
    if (r.ok) { sentOnce = true; deadline = r.closesAt ?? deadline; status.className = 'finish-status ok'; status.textContent = FINISH_COPY.saved(until(deadline)); }
    else { status.className = 'finish-status bad'; status.textContent = FINISH_COPY.errors[r.error] ?? FINISH_COPY.errors.offline; }
  }
  const area = (id, label, key, hint) => {
    const t = h('textarea', { class: 'input', id, rows: '2', maxlength: String(FEEDBACK_TEXT_MAX), placeholder: hint, 'aria-label': label, 'aria-describedby': `${id}-w` });
    t.value = answers[key] ?? '';
    const warn = h('p', { class: 'finish-warn', id: `${id}-w`, role: 'status' });
    const sync = () => { answers[key] = t.value.trim(); const m = identifierWarning(t.value); if (warn.textContent !== m) warn.textContent = m; };
    t.addEventListener('input', sync); t.addEventListener('blur', () => { sync(); void save(); });
    return { t, warn };
  };

  // My Takehome sits in the record; its switch also shares it anonymously with the facilitator (on unless switched off).
  const take = area('finish-take', FINISH_COPY.takeHome, 'takeaway', FINISH_COPY.takeHint);
  const sw = h('button', { type: 'button', role: 'switch', 'aria-checked': String(share), 'aria-labelledby': 'finish-share' });
  sw.addEventListener('click', () => { share = !share; sw.setAttribute('aria-checked', String(share)); later(); });
  card.append(h('div', { class: 'finish-take' }, h('label', { for: 'finish-take', text: FINISH_COPY.takeHome }), take.t, take.warn,
    saver ? h('div', { class: 'finish-switch' }, h('span', { id: 'finish-share' }, icon(EYE), FINISH_COPY.share), sw) : null));

  // The CPD details as one editable summary line (all optional; hours start from the session length).
  const field = (id, label, control, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'finish-hint', id: `${id}-h`, text: hint }) : null);
  const input = (id, extra = {}) => h('input', { class: 'input', id, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '200', ...extra });
  const nameI = input('finish-name'), facI = input('finish-fac'), locI = input('finish-loc'), hoursI = input('finish-hours', { inputmode: 'decimal', maxlength: '5', 'aria-describedby': 'finish-hours-h' });
  hoursI.value = defaultHours(summary.minutes);
  // The facilitator who ran the room, prefilled and still editable (Julian, 2026-10-18): they may add the organisation.
  facI.value = summary.facilitator ?? '';
  let activity = 'educational';
  const kinds = ACTIVITY.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': String(activity === value), text: label }));
  const fields = h('div', { class: 'finish-fields', id: 'finish-fields', hidden: true },
    field('finish-name', 'Your name', nameI, 'Left off the PDF if blank.'), field('finish-fac', 'Facilitator and organisation', facI),
    field('finish-loc', 'Location or group', locI),
    field('finish-hours', 'Hours', hoursI, summary.minutes ? `Session ran ${summary.minutes} min. Record the time you actually spent.` : 'Record the time you actually spent.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'finish-kind' }, 'Activity type'),
      h('div', { class: 'segmented', role: 'group', 'aria-labelledby': 'finish-kind', 'aria-describedby': 'finish-kind-h' }, kinds),
      h('p', { class: 'finish-hint', id: 'finish-kind-h', text: 'The Medical Board lists small group sessions as educational. Check your CPD home before choosing another category.' })));
  const summaryText = h('span', { class: 'finish-summary-t' });
  const paintSummary = () => { summaryText.textContent = [nameI.value.trim() || FINISH_COPY.noName, hoursI.value.trim() ? `${hoursI.value.trim()} h` : null,
    (ACTIVITY.find(([k]) => k === activity) ?? ACTIVITY[0])[1]].filter(Boolean).join(' · '); };
  const editLabel = h('span', { class: 'finish-edit', text: FINISH_COPY.edit });
  const edit = h('button', { type: 'button', class: 'finish-summary', 'aria-expanded': 'false', 'aria-controls': 'finish-fields' },
    h('span', { class: 'finish-summary-k', text: FINISH_COPY.details }), summaryText, icon(PENCIL), editLabel);
  edit.addEventListener('click', () => { const open = fields.hidden; fields.hidden = !open; edit.setAttribute('aria-expanded', String(open)); editLabel.textContent = open ? FINISH_COPY.done : FINISH_COPY.edit; if (open) nameI.focus(); paintSummary(); });
  kinds.forEach((b, i) => b.addEventListener('click', () => { activity = ACTIVITY[i][0]; kinds.forEach((x, k) => x.setAttribute('aria-pressed', String(k === i))); paintSummary(); }));
  for (const el of [nameI, hoursI]) el.addEventListener('input', paintSummary);
  paintSummary();
  const dlStatus = h('p', { class: 'finish-status', role: 'status', 'aria-live': 'polite' });
  const dl = h('button', { type: 'button', class: 'btn primary block', text: FINISH_COPY.download });
  let busy = false;
  dl.addEventListener('click', async () => {
    if (busy) return;
    const hrs = parseHours(hoursI.value);
    hoursI.setAttribute('aria-invalid', String(!hrs.ok));
    if (!hrs.ok) { fields.hidden = false; edit.setAttribute('aria-expanded', 'true'); dlStatus.className = 'finish-status bad'; dlStatus.textContent = FINISH_COPY.hours; hoursI.focus(); return; }
    busy = true; dl.setAttribute('aria-busy', 'true'); dl.textContent = FINISH_COPY.making; flush();
    // Let the busy label paint before the masthead and the PDF are made on this phone.
    await new Promise(resolve => win.setTimeout(resolve, 30));
    let message = null;
    try { message = await download(summary, { name: nameI.value, facilitator: facI.value, location: locI.value, hours: hrs.value, activity, takeHome: take.t.value, canNow: [...canNow] }); }
    catch { message = FINISH_COPY.errors.offline; }
    finally { busy = false; dl.removeAttribute('aria-busy'); dl.textContent = FINISH_COPY.download; }
    dlStatus.className = `finish-status ${message ? 'bad' : 'ok'}`; dlStatus.textContent = message ?? FINISH_COPY.made;
  });
  card.append(h('div', { class: 'finish-cpd' }, edit, fields), h('div', { class: 'finish-dl' }, dl, dlStatus));

  // ── zone 2: feedback · anonymous (what is sent) ──
  let feedback = null;
  if (saver) {
    feedback = h('section', { class: 'finish-feedback', 'aria-labelledby': 'finishF' }, h('h2', { id: 'finishF', text: FINISH_COPY.feedback }));
    for (const [key, label, low, high] of RATINGS) {
      const name = `rating_${key}`, legendId = `finish-${key}`, endsId = `finish-${key}-ends`;
      const buttons = [1, 2, 3, 4, 5].map(n => h('button', { type: 'button', 'aria-pressed': String(answers[name] === n), 'aria-label': `${n} of 5`, text: String(n) }));
      const paint = () => buttons.forEach((b, i) => { b.setAttribute('aria-pressed', String(answers[name] === i + 1)); b.classList.toggle('lit', Boolean(answers[name]) && i + 1 < answers[name]); });
      buttons.forEach((b, i) => b.addEventListener('click', () => { answers[name] = answers[name] === i + 1 ? undefined : i + 1; paint(); later(); }));
      paint();
      const c = area(`finish-c-${key}`, FINISH_COPY.comment(label), `comment_${key}`, FINISH_COPY.commentHint);
      const wrap = h('div', { class: 'finish-comment', id: `finish-cw-${key}` }, c.t, c.warn);
      const open = Boolean(answers[`comment_${key}`]);
      wrap.hidden = !open;
      const toggle = h('button', { type: 'button', class: open ? 'finish-say has' : 'finish-say', 'aria-expanded': String(open), 'aria-controls': `finish-cw-${key}`, 'aria-label': FINISH_COPY.addComment(label) }, icon(BUBBLE));
      toggle.addEventListener('click', () => { const show = wrap.hidden; wrap.hidden = !show; toggle.setAttribute('aria-expanded', String(show)); if (show) c.t.focus(); });
      c.t.addEventListener('blur', () => toggle.classList.toggle('has', Boolean(c.t.value.trim())));
      // The scale's ends are spoken, not printed (Julian, 2026-10-18): 1 and 5 carry their meaning to a reader.
      feedback.append(h('fieldset', { class: 'finish-rate', 'aria-labelledby': legendId, 'aria-describedby': endsId },
        h('legend', { id: legendId, text: label }), h('span', { class: 'sr-only', id: endsId, text: `1 ${low}, 5 ${high}` }),
        h('div', { class: 'finish-row' }, h('div', { class: 'finish-scale' }, buttons), toggle), wrap));
    }
    feedback.append(status);
  }

  const node = h('div', { class: 'finish' }, card, feedback ?? (feedbackClosed ? h('p', { class: 'finish-hint', text: FINISH_COPY.closed }) : null));

  // Stats count up once, the first time the block is shown (never under reduced motion).
  let counted = false;
  function countUp() {
    if (counted || reduced(win)) return; counted = true;
    for (const b of stats.querySelectorAll('b[data-count]')) {
      const to = Number(b.dataset.count), text = b.firstChild, t0 = win.performance.now();
      const step = t => { const k = Math.min(1, (t - t0) / 700); text.textContent = String(Math.round(to * (1 - (1 - k) ** 3))); if (k < 1) win.requestAnimationFrame(step); };
      text.textContent = '0'; win.requestAnimationFrame(step);
    }
  }
  return { node, shown: countUp, focus: () => card.querySelector('#finishH')?.focus() };
}
