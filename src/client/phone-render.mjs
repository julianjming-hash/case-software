// The participant phone's room screens, drawn from a participant view (preview overhaul slice 2, CASE-226). The live
// phone and the Builder's Run preview both use it: everything is drawn into the given document and parts, so the preview
// can draw the real phone into a blank frame (HTML pages refuse framing). This module only draws. The live phone keeps
// its transport, outbox, durable answers, receipts, recovery and storage around it: a Send hands the response to
// `onAnswer(response)`, and the caller reports how that answer is doing through `delivery` (see createPhoneRenderer).
import { domBuilder } from './phone-dom.mjs';
import { cleanText } from '../shared/text.mjs';
import { FREE_TEXT_MAX } from '../shared/content-limits.mjs';
import { markSvg, markFor } from './projector-marks.mjs';
import { timerRemainingS, timerWords, timerLine, TIMER_ANNOUNCE_AT } from '../shared/timer.mjs';
import { identifierWarning } from '../shared/identifiers.mjs';
import { avatarEl } from './avatar.mjs';
import { rankingMoveControl, rankingRemoveControl } from './phone-ranking.mjs';
import { responseSummary } from './response-summary.mjs';
import { publicTimelineEntry } from './presentation-nav.mjs';
import { newlyPublicGroup } from './presentation-emphasis.mjs';
import { applySlideTheme } from '../shared/slide-themes.mjs';
import { recapJourney, CLASS_WORD, SHAPE_WORD, shortTitle } from './recap-journey.mjs';
import { BRANCH_ICON_PATH, BRANCH_LABEL } from '../shared/decision-branches.mjs';

// ───────────────────────── icons ─────────────────────────
const SVGNS = 'http://www.w3.org/2000/svg';
const S_ = (d, extra = {}) => ['path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra }];
const ICONS = {
  spinner: [['circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-opacity': .25 }], S_('M8 2a6 6 0 0 1 6 6', { 'stroke-width': 2 })],
  hourglass: [S_('M4 2h8M4 14h8M5 2c0 4 3 4 3 6s-3 2-3 6M11 2c0 4-3 4-3 6s3 2 3 6')],
  eye: [S_('M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z'), ['circle', { cx: 8, cy: 8, r: 2, fill: 'currentColor' }]],
  people: [['circle', { cx: 8, cy: 5, r: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }], S_('M3 14c0-3 2-5 5-5s5 2 5 5')],
  lock: [['rect', { x: 3, y: 7, width: 10, height: 7, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }], S_('M5 7V5a3 3 0 0 1 6 0v2')],
  book: [S_('M2 3h5a1 1 0 0 1 1 1v9a1 1 0 0 0-1-1H2zM14 3H9a1 1 0 0 0-1 1v9a1 1 0 0 1 1-1h5z')],
  pause: [['rect', { x: 4, y: 3, width: 3, height: 10, fill: 'currentColor' }], ['rect', { x: 9, y: 3, width: 3, height: 10, fill: 'currentColor' }]],
  flag: [S_('M3 14V2M3 3h9l-2 3 2 3H3')],
  wifioff: [S_('M1 6a10 10 0 0 1 14 0M4 9a6 6 0 0 1 8 0M7 12a2 2 0 0 1 2 0M2 2l12 12')],
  check: [S_('M3 8.5l3 3 7-7', { 'stroke-width': 2 })],
  info: [['circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }], S_('M8 7v4M8 4.8v.2')],
  alert: [S_('M8 2l7 12H1z'), S_('M8 6.5v3.2M8 11.8v.2')],
  // classification set (SCREENS.md Accessibility)
  sound: [['circle', { cx: 8, cy: 8, r: 7, fill: 'currentColor' }], S_('M4.5 8.2l2.4 2.4 4.6-4.8', { stroke: '#fff', 'stroke-width': 2 })],
  defensible: [['circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }], S_('M4.8 8.2l2.2 2.2 4.2-4.4')],
  'context-dependent': [S_('M8 14V8M8 8L3.5 3M8 8l4.5-5')],
  unsafe: [S_('M8 2l7 12H1z'), S_('M8 6.5v3.2M8 11.8v.2')],
  'terminal-unsafe': [S_('M5 1h6l4 4v6l-4 4H5l-4-4V5z'), S_('M5 8h6', { 'stroke-width': 2 })],
  'discussion-prompt': [S_('M2 3h12v8H7l-3 3v-3H2z')],
  // Lucide "split" (ISC), drawn on its 24-unit grid scaled into this 16-unit box (CASE-313).
  split: [S_(BRANCH_ICON_PATH, { transform: 'scale(.6667)', 'stroke-width': 2.55 })],
};
/** A 16-unit phone icon in `doc`, hidden from assistive technology. */
export function phoneIcon(doc, name, size = 16, cls = '') {
  const svg = doc.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  for (const [tag, attrs] of ICONS[name] || []) {
    const n = doc.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  }
  return svg;
}

/** A soft, never blocking, warning under a text field when it looks like a patient identifier (RT2 P2). */
export function idWarn(input, id) {
  const h = domBuilder(input.ownerDocument);
  const p = h('p', { class: 'idwarn', id, role: 'status', 'aria-live': 'polite' });
  const upd = () => { const w = identifierWarning(input.value); if (p.textContent !== w) p.textContent = w; };
  input.addEventListener('input', upd);
  const prior = input.getAttribute('aria-describedby');
  input.setAttribute('aria-describedby', `${prior ? `${prior} ` : ''}${id}`);
  return { p, upd };
}

// ───────────────────────── exact copy (docs/SCREENS.md) ─────────────────────────
/** The decision card's receipt copy; the live phone's delivery reports these as `message` text. */
export const PHONE_COPY = Object.freeze({
  sending: 'Sending…',
  saved: 'Answer saved · you can change it until responses lock',
  savedDup: 'Answer saved · already received',
  lockedSaved: 'Voting locked · your last saved answer stands',
  lockedNone: 'Voting locked · no answer was recorded from this phone',
  held: 'Paused · your answer is held',
  updating: 'Updating · checking the session…',
  rejected: 'Answer not saved · check your choice and try again',
  voided: 'Round cancelled · the facilitator will open a new round',
  manualRoom: 'Facilitator-led discussion · answers are off for now',
  ended: 'This session has ended',
  waiting: 'Waiting for connection · your answer will send automatically',
});
const C = PHONE_COPY;
// The phase pill (CASE-114): open green, locked amber, reveal petrol, consequence coral, paused slate.
const PHASE_CHIP = {
  waiting: ['Waiting to start', 'hourglass', 'reveal'], live: ['Live surface', 'eye', 'reveal'], decision_open: ['Team decision', 'people', 'open'],
  reviewing: ['Voting locked', 'lock', 'locked'], teaching: ['Teaching point', 'book', 'consequence'], paused: ['Discussion pause', 'pause', 'paused'], ended: ['Your private recap', 'flag', 'reveal'],
  debrief: ['Debrief', 'flag', 'reveal'], // console layout v2: the recap and feedback arrive at Debrief, before End
};
// Card 40b: the interaction shape before a recap question (its word is the accessible name).
const SHAPE_GLYPH = { single_choice: '◉', multi_select: '☑', ranking: '⇅', free_text: '✎' };

/** Two responses are the same answer (a multi-select ignores order). */
export function sameResponse(a, b) {
  if (!a || !b) return false;
  const norm = (r) => (r.option_ids ? { option_ids: [...r.option_ids].sort() } : r);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
/** The answer this phone has saved for `d`: the latest accepted receipt for its round, else the room's record. */
export function savedResponse(d, accepted) { return accepted?.roundId === d.roundId ? accepted.response : d.yourResponse; }

/** The phone page's regions (header, connection, notes, main, announcer, live bar) in a fresh `.phone-app` root. */
export function buildPhoneScreen(doc) {
  const h = domBuilder(doc), parts = {};
  const keep = (name, node) => { parts[name] = node; return node; };
  const root = h('div', { class: 'phone-app' },
    h('header', { class: 'top' }, h('div', { class: 'who' }, keep('whoAv', h('span', { id: 'whoAv' })), h('div', { class: 'who-text' }, h('p', { class: 'brand', text: 'Case' }), keep('who', h('p', { class: 'name', id: 'who', text: 'Join a session' })))),
      keep('phaseChip', h('span', { id: 'phaseChip', class: 'pill', hidden: true })), keep('menuBtn', h('button', { type: 'button', class: 'iconbtn', id: 'menuBtn', 'aria-expanded': 'false', 'aria-label': 'Menu' }, phoneIcon(doc, 'people', 20)))),
    keep('conn', h('div', { class: 'conn', id: 'conn', role: 'status', 'aria-live': 'polite' })),
    keep('note', h('p', { class: 'note', id: 'note', role: 'status', 'aria-live': 'polite' })), keep('unsent', h('p', { id: 'unsent', class: 'unsent', role: 'status', 'aria-live': 'polite' })),
    keep('main', h('main', { id: 'main' })), keep('announce', h('p', { class: 'sr-only-live', id: 'announce', role: 'status', 'aria-live': 'polite' })),
    keep('liveBar', h('div', { class: 'bar', id: 'liveBar', hidden: true }, h('div', { class: 'inner' }, keep('liveBtn', h('button', { type: 'button', class: 'btn primary block', id: 'liveBtn', text: 'Live surface' }))))));
  return { root, parts };
}

const IDLE = Object.freeze({ online: true, enqueuing: 0, pending: null, accepted: null, message: null, queueFailed: false, locked: false });

/**
 * A phone renderer over `parts` (from buildPhoneScreen) in `doc`. `update(view)` draws a joined participant's view
 * (`project(state, 'participant', id)`); `header(mode, view)` draws the top bar for any phone mode.
 *
 * Answers: the decision card's Send calls `onAnswer(response)`. The caller reports delivery through `delivery`:
 * - `state()` → `{ online, enqueuing, pending, accepted, message, queueFailed, locked }`, read on every card draw:
 *   `pending` `{ response, state: 'sending'|'waiting'|'held'|'refetch' }` is an answer not yet confirmed (`not sent`),
 *   `accepted` `{ roundId, response }` the latest saved answer, `message` `{ kind: 'ok'|'alert', text }` the last
 *   receipt line (PHONE_COPY), `queueFailed` an answer that could not be kept (shows Retry), `enqueuing` an answer being
 *   kept on the phone, `locked` a locked receipt (draws the locked card), `online` the link.
 * - `round(decision)`: a round started (`decision`) or the card was cleared (`null`); forget per-round delivery state.
 * - `reconcile(view)`: called before each card draw while a decision is shown.
 * After changing what `state()` reports, call `refreshDecision()`. Omitting `delivery` draws an idle, online phone.
 * `rename(prefix)` → `{ root, sync() }` adds the lobby's name and avatar control (omitted when absent).
 * `recap` `{ feedbackHref(code), download(view) }` (card 40b): the ended recap's Give feedback link and its built-in PDF; each is
 * omitted when absent (the Builder's Run preview passes neither). `download` resolves to a message when no file was made.
 */
export function createPhoneRenderer({ doc, parts, onAnswer = () => {}, delivery = {}, rename = null, manageFocus = true, media = null, recap: recapActions = {} }) {
  const win = doc.defaultView;
  const h = domBuilder(doc);
  const icon = (name, size, cls) => phoneIcon(doc, name, size, cls);
  const { main } = parts;
  const deliveryState = () => delivery.state?.() ?? IDLE;
  let disposed = false, view = null;
  const timeouts = new Set(), splashes = new Set(), listeners = [];
  const later = (fn, delay) => { const id = globalThis.setTimeout(() => { timeouts.delete(id); if (!disposed) fn(); }, delay); timeouts.add(id); };
  const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };

  const S = { browseIndex: null, liveKey: undefined, liveSurface: null, phaseKey: undefined, note: '' };
  const el = {}; // persistent room containers
  const wideQuery = win.matchMedia?.('(min-width: 64rem)');
  let wide = wideQuery?.matches ?? false, situationOpen = false;
  // Card 57: slide surfaces render with card 56's text-only renderer, loaded on the first slide (reading order, no grid).
  let slideRender = null;
  if (wideQuery) listen(wideQuery, 'change', () => {
    if (disposed || wide === (wideQuery?.matches ?? false)) return;
    const focusedSurface = el.surface?.contains(doc.activeElement);
    wide = wideQuery.matches;
    if (!el.title || !view) return;
    updateRoom();
    // Only restore the removed information control; answer inputs never rebuild here.
    if (focusedSurface) (el.surface.querySelector('summary, [data-focus-heading]'))?.focus({ preventScroll: true });
  });
  listen(parts.liveBtn, 'click', () => { if (!el.title || !view) return; S.browseIndex = null; updateRoom(); win.scrollTo({ top: 0 }); main.querySelector('[data-focus-heading]')?.focus({ preventScroll: true }); });

  const clean = value => cleanText(value);
  function typingNow() {
    const a = doc.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && a.isConnected;
  }
  function say(text) { const a = parts.announce; a.textContent = ''; later(() => { a.textContent = text; }, 30); }

  /** Draw splash art into `host` from the lazy chunk; a failed load leaves the plain ground (the art is decorative). */
  async function paintSplash(host, opts) {
    let chunk;
    try { chunk = await import('./splash.mjs'); } catch { return null; }
    if (disposed || !host.isConnected) return null;
    const splash = chunk.mountCaseSplash(host, opts.art ?? null, opts);
    splashes.add(splash);
    return splash;
  }
  function stopSplashes() { for (const splash of splashes) splash.stop(); splashes.clear(); }

  // ───────────────────────── header ─────────────────────────
  function header(mode, v) {
    const who = parts.who;
    who.textContent = mode === 'room' ? (v.you.name || "You're in") : mode === 'join' ? 'Join a session' : mode === 'removed' ? 'Case' : 'Case session';
    const av = mode === 'room' ? `${v.you.avatarId ?? ''}|${v.you.name ?? ''}` : '';
    if (parts.whoAv.dataset.k !== av) { parts.whoAv.dataset.k = av; parts.whoAv.replaceChildren(...(av ? [avatarEl(v.you.avatarId, { size: 32, name: v.you.name })] : [])); }
    const chip = parts.phaseChip;
    if (mode === 'room' && PHASE_CHIP[v.phase]) {
      const [text, ic, ph] = PHASE_CHIP[v.phase];
      chip.hidden = false;
      chip.dataset.phase = ph;
      if (chip.dataset.k !== text) { chip.dataset.k = text; chip.replaceChildren(icon(ic), doc.createTextNode(text)); }
    } else chip.hidden = true;
    if (parts.menuBtn) parts.menuBtn.hidden = false;
  }

  // ───────────────────────── room shell ─────────────────────────
  /** Clear the room screens (the caller draws another phone mode into `main`). */
  function reset() {
    stopSplashes();
    main.replaceChildren();
    for (const k of Object.keys(el)) delete el[k];
    resetDecision();
    parts.liveBar.hidden = true;
    main.classList.remove('pad-bar', 'participant-room', 'participant-decision');
  }
  function mountRoom() {
    // Every room state has a level-one heading (axe page-has-heading-one); the lobby brings its own.
    el.title = h('h1', { class: 'sr-only', text: 'Case session' });
    el.banners = h('div', { class: 'stack' });
    el.browse = h('div', { class: 'stack' });
    el.lobby = h('section', { class: 'phone-splash', hidden: '' });
    el.surface = h('section', { class: 'stack participant-information' });
    el.decision = h('section', { class: 'card', hidden: '' });
    el.result = h('div', { class: 'participant-result' });
    el.recap = h('section', { class: 'card', hidden: '' });
    el.tl = h('section', { class: 'tl', 'aria-labelledby': 'tlh' });
    main.classList.add('participant-room');
    main.append(el.title, el.banners, el.browse, el.lobby, el.surface, el.decision, el.result, el.recap, el.tl);
    S.liveKey = undefined; S.liveSurface = null; S.phaseKey = undefined; S.browseIndex = null; S.note = '';
  }
  function setSection(node, sig, build) {
    if (node._sig === sig) return false;
    node._sig = sig;
    node.replaceChildren(...[].concat(build() ?? []));
    return true;
  }

  function updateRoom() {
    const disclosure = el.surface?.querySelector('details.ctx');
    if (disclosure) situationOpen = disclosure.open;
    const v = view;
    const live = v.liveSurface;
    const groupKey = entry => JSON.stringify([entry?.scene, entry?.assetIds, entry?.observations, entry?.points, entry?.investigations, entry?.slide?.reading_order]);
    const liveKey = live ? `${live.surfaceId}@${live.at}:${groupKey(live)}` : '';
    const dKey = `${v.decision?.roundId ?? ''}|${v.decision?.status ?? ''}`;
    const phaseKey = `${v.phase}|${dKey}`;
    const liveChanged = S.liveKey !== undefined && liveKey !== S.liveKey;
    const accentGroup = liveChanged ? newlyPublicGroup(S.liveSurface, live) : null;
    const phaseChanged = S.phaseKey !== undefined && phaseKey !== S.phaseKey;
    if (liveChanged) {
      S.browseIndex = null; // the next shared reveal auto-advances every phone back to live
      S.note = v.phase === 'decision_open' ? 'Team decision open' : (v.phase === 'live' || v.phase === 'teaching') ? 'New material shared' : '';
      if (S.note) say(S.note);
    } else if (phaseChanged) S.note = '';
    S.liveKey = liveKey;
    S.liveSurface = live;
    S.phaseKey = phaseKey;

    const selected = publicTimelineEntry(v.timeline, S.browseIndex);
    const browsing = selected.browsing;
    if (!browsing) S.browseIndex = null;
    const entry = browsing ? selected.entry : live;

    const noteShown = browsing ? '' : S.note;
    if (parts.note.textContent !== noteShown) parts.note.textContent = noteShown;
    parts.liveBar.hidden = !browsing;
    main.classList.toggle('pad-bar', browsing);
    el.browse.replaceChildren();
    if (browsing) el.browse.append(h('div', { class: 'banner info', role: 'note' }, icon('info', 18), h('span', { text: 'Earlier material · read-only' })));

    const lobby = v.phase === 'waiting';
    el.lobby.hidden = !lobby;
    el.title.hidden = lobby;
    if (lobby) updateLobby(v);

    // Debrief (console layout v2) shows the phone what End shows: its recap and Give feedback.
    const ended = v.phase === 'ended' || v.phase === 'debrief';
    const decisionShown = !!v.decision && !browsing;
    main.classList.toggle('participant-decision', decisionShown && !ended);
    if (liveChanged) situationOpen = false;

    // banners: manual, pause, cancelled round
    const cancelled = v.lastRound?.status === 'abandoned' && !v.decision && !ended && !lobby;
    const held = v.decision?.status === 'held';
    const bsig = JSON.stringify([browsing, v.manual, v.phase, held, cancelled]);
    const bchanged = setSection(el.banners, bsig, () => {
      if (browsing || lobby) return [];
      const out = [];
      if (v.manual) out.push(h('div', { class: 'banner manual', role: 'note' }, icon('people', 18), h('span', { text: 'Facilitator-led discussion · phone answers are off for now' })));
      if (v.phase === 'paused') out.push(h('div', { class: 'stack' }, h('h2', { id: 'pauseH', tabindex: '-1', 'data-focus-heading': '', text: 'Discussion pause' }), held ? null : h('div', { class: 'banner pause', role: 'note' }, icon('pause', 18), h('span', { text: 'Paused · the facilitator will resume the session' }))));
      if (cancelled) out.push(h('div', { class: 'banner alert', role: 'note' }, icon('alert', 18), h('span', { text: C.voided })));
      if (v.phase === 'reviewing' && v.manual) out.push(h('p', { class: 'muted small', text: 'Facilitator-led discussion · phone answers are off for now' }));
      return out;
    });
    if (bchanged && cancelled) say(C.voided);

    // surface
    const showSurface = !!entry && !lobby && !(ended && !browsing);
    const ssig = JSON.stringify([showSurface, entry?.surfaceId, entry?.at, groupKey(entry), browsing, v.phase, decisionShown, wide, Boolean(slideRender?.slidePlan), Boolean(slideRender?.failed), media?.generation ?? 0]);
    setSection(el.surface, ssig, () => (showSurface ? buildSurface(entry, { browsing, phase: v.phase, accentGroup: browsing ? null : accentGroup, collapse: !wide && !browsing && (decisionShown || (v.phase === 'reviewing' && !!v.decision)) }) : []));

    // decision card
    if (!ended) updateDecision(v, decisionShown); else { resetDecision(); el.decision.hidden = true; }

    // room result (CASE-080)
    const rsig = JSON.stringify([browsing, v.lastResult, v.decision?.roundId, ended]);
    setSection(el.result, rsig, () => (!browsing && !ended && v.lastResult && !v.decision ? buildResult(v.lastResult) : []));

    // recap
    el.recap.hidden = !(ended && !browsing);
    setSection(el.recap, JSON.stringify([ended, browsing, v.recap, v.timeline.length, recapMedia(v).length ? media?.generation ?? 0 : 0]), () => (ended && !browsing ? buildRecap(v) : []));

    // timeline
    const tsig = JSON.stringify([v.timeline.map((e) => [e.surfaceId, e.at, e.timelineKind, e.manual]), live?.surfaceId, S.browseIndex]);
    const hadFocus = el.tl.contains(doc.activeElement) ? doc.activeElement?.dataset?.entryIndex : null;
    if (setSection(el.tl, tsig, () => buildTimeline(v)) && hadFocus) el.tl.querySelector(`button[data-entry-index="${win.CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true });

    // focus: never steal it from someone who is typing, nor from the page holding a preview phone (manageFocus false)
    if (manageFocus && (phaseChanged || liveChanged)) {
      if (!typingNow()) {
        const a = doc.activeElement;
        const lost = !a || a === doc.body || !a.isConnected;
        if (lost) {
          const t = (decisionShown && el.decision.querySelector('[data-focus-heading]')) || main.querySelector('[data-focus-heading]');
          t?.focus({ preventScroll: true });
        }
      }
    }
    header('room', v);
  }

  function zoomImage(picture) {
    const dialog = h('dialog', { class: 'phone-zoom', 'aria-label': picture.alt || 'Image' });
    const close = h('button', { type: 'button', class: 'btn phone-zoom-close', text: 'Close' });
    const big = doc.createElement('img'); big.src = picture.src; big.alt = picture.alt; big.className = 'phone-zoom-image';
    const box = h('div', { class: 'phone-zoom-scroll' }); box.append(big);
    dialog.append(close, box); doc.body.append(dialog);
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); if (picture.isConnected) picture.focus(); });
    dialog.showModal(); close.focus();
  }

  // ───────────────────────── surfaces, results, timeline, lobby ─────────────────────────
  function buildSurface(entry, { browsing, phase, collapse, accentGroup = null }) {
    const out = [];
    if (entry.manual) out.push(h('div', { class: 'banner manual', role: 'note' }, icon('people', 18), h('span', { text: 'Facilitator-led discussion' })));
    const heading = h('h2', { id: 'surfH', tabindex: '-1', 'data-focus-heading': browsing || !collapse ? '' : null, text: entry.title });
    if (entry.slide && !slideRender) slideRender = import('./slide-render.mjs').then(m => { slideRender = m; if (!disposed && view && el.title) updateRoom(); }, () => { slideRender = { failed: true }; if (!disposed && view && el.title) updateRoom(); });
    const slide = entry.slide ? (slideRender?.slidePlan ? applySlideTheme(slideRender.buildSlide(doc, slideRender.slidePlan({ blocks: entry.slide.blocks, composition: entry.slide }, { layout: 'reflow', repeats: entry.title, media: media?.resolve ?? null })).root, entry.slide.theme)
      : h('p', { class: 'small', text: slideRender?.failed ? 'This material could not load. Reload the page to see it.' : 'Loading…' })) : null;
    // A video the learner is already watching keeps playing across this rebuild: the same element moves into the new
    // slide within this task, so the browser never pauses it (card 59 M3).
    for (const fresh of slide?.querySelectorAll?.('video[data-video-block]') ?? []) {
      const old = [...el.surface.querySelectorAll('video[data-video-block]')].find(video => video.dataset.videoBlock === fresh.dataset.videoBlock && video.src === fresh.src);
      if (old) fresh.replaceWith(old);
    }
    // Card 59 M3: a released image opens full size on tap or Enter, in a dialog the phone can pinch-zoom and scroll; a
    // video's poster fetches the video instead, which then plays with its own controls.
    for (const picture of slide?.querySelectorAll?.('img.slide-picture') ?? []) {
      const video = picture.classList.contains('slide-video-poster');
      picture.tabIndex = 0; picture.title = video ? 'Play video' : 'Open full size';
      const open = () => (video ? media?.play?.(picture.dataset.videoHandle) : zoomImage(picture));
      picture.addEventListener('click', open);
      picture.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    }
    const obs = entry.observations?.length ? buildVitals(entry.observations) : null;
    const tile = (title, items) => (items?.length ? h('section', { class: 'card tile', 'aria-label': title }, h('p', { class: 'eyebrow', text: title }), h('ul', { class: 'points' }, items.map((t) => h('li', { text: t })))) : null);
    const findings = tile('Findings', entry.points);
    const inv = tile('Investigations', entry.investigations);
    const accent = (node, group) => { if (node && accentGroup === group) node.classList.add('presentation-new-group'); return node; };
    accent(obs, 'observations'); accent(findings, 'findings'); accent(inv, 'investigations');
    if (collapse) {
      // A decision is open: the situation folds away under the decision (it is one tap away).
      const disclosure = h('details', { class: 'ctx', open: situationOpen ? '' : null },
        h('summary', { 'aria-label': `${situationOpen ? 'Hide' : 'Show'} situation: ${entry.title}` },
          h('span', { text: `Situation: ${entry.title}` }), h('span', { class: 'disclosure-action', text: situationOpen ? 'Hide' : 'Show' })),
        h('div', { class: 'inner' }, entry.scene ? h('p', { class: 'small', text: entry.scene }) : null, slide, obs, findings, inv));
      disclosure.ontoggle = event => {
        const current = event.currentTarget, summary = current.querySelector('summary');
        summary.lastElementChild.textContent = current.open ? 'Hide' : 'Show';
        summary.setAttribute('aria-label', `${current.open ? 'Hide' : 'Show'} situation: ${entry.title}`);
      };
      out.push(disclosure);
    } else {
      // One scene card (CASE-116), then the bento tiles (CASE-117), stacked.
      out.push(accent(h('section', { class: 'card scene', 'data-kind': entry.timelineKind ?? 'live', 'aria-labelledby': 'surfH' }, heading, entry.scene ? h('p', { class: 'prose', text: entry.scene }) : null,
        slide, phase === 'teaching' && !browsing ? h('p', { class: 'banner info', text: 'Read this, then discuss with the group' }) : null), 'scene'), obs, findings, inv);
    }
    return out.filter(Boolean);
  }

  /** Vitals (CASE-090): label, value and unit, then the arrow and the value the room last saw. Arrow = direction only, never a good/bad colour. */
  function buildVitals(list) {
    const fmt = (o) => `${o.label} ${o.value}${o.unit ? (/^[%°]/.test(o.unit) ? '' : ' ') + o.unit : ''}`;
    return h('ul', { class: 'vitals', 'aria-label': 'Observations' }, list.map((o) => {
      const arrow = o.trend === 'up' ? '↑' : o.trend === 'down' ? '↓' : null;
      const spoken = arrow ? `${fmt(o)}, ${o.trend} from ${o.previous}` : fmt(o);
      return h('li', {},
        h('span', { class: 'vl', 'aria-hidden': 'true', text: o.label }),
        h('span', { class: 'vv', 'aria-hidden': 'true' }, String(o.value ?? ''), o.unit ? h('span', { class: 'vu', text: o.unit }) : null),
        arrow ? h('span', { class: 'arrow', 'aria-hidden': 'true', text: `${arrow} ${o.previous}` }) : null,
        h('span', { class: 'sr-only', text: spoken }));
    }));
  }

  // Option marks by position in the one authored order (CASE-088). Recap rounds carry `optionIds`;
  // the remembered lists are a fallback for older snapshots.
  const seenOptions = new Map();
  function rememberOptions(decisionId, ids) { if (decisionId && ids?.length) seenOptions.set(decisionId, ids); }

  function buildResult(r) {
    // Room-result copy (CASE-080, CASE-104): a tie reads as a split; multi-select and ranking say what
    // was counted; free-text answers are shown without names on the projector, not repeated in this summary (CASE-275).
    rememberOptions(r.decisionId, r.counts.map((c) => c.optionId));
    const mine = (r.yourOptionIds ?? []).map((id) => r.counts.findIndex((c) => c.optionId === id)).filter((i) => i >= 0);
    const first = mine.length ? r.counts[mine[0]] : null;
    let line;
    if (!r.countMeaning) line = r.youAnswered ? 'Your answer was submitted' : 'You did not answer this one';
    else if (!r.yourAnswer) line = r.total ? 'You did not answer this one' : 'No one answered this one';
    else if (r.countMeaning === 'selected') line = `You selected ${r.yourAnswer} · ${r.total} answered`;
    else if (r.countMeaning === 'ranked_first') line = first ? `You ranked ${first.label} first · ${first.count} of ${r.total} did the same` : `You ranked ${r.yourAnswer}`;
    else line = first ? `You chose ${r.yourAnswer} · ${first.count} of ${r.total} chose the same` : `You chose ${r.yourAnswer} · ${r.total} answered`;
    const how = r.split ? 'The group was split' : '';
    const marks = r.countMeaning === 'ranked_first' ? mine.slice(0, 1) : mine;
    const ranking = r.rankCount && r.counts.every(row => Array.isArray(row.positionCounts))
      ? responseSummary({ ...r, type: 'ranking' }).rows : [];
    return h('section', { class: 'result', 'aria-label': 'Group result' },
      h('p', { class: 'eyebrow', text: 'Group result' }),
      h('p', { class: 'chose' }, marks.length ? h('span', { class: 'mk-wrap' }, marks.map((i) => markSvg(i, { size: 28, decorative: false }))) : null, h('span', { text: line })),
      how ? h('p', { class: 'small muted', text: how }) : null,
      ranking.length ? h('ul', { class: 'ranking-result', 'aria-label': 'Counts by ranking position' }, ranking.map(row =>
        h('li', {}, h('strong', { text: row.label }), h('ul', {}, row.positions.map(position => h('li', { text: position.words })))))) : null);
  }

  function buildTimeline(v) {
    const tl = v.timeline;
    if (!tl.length) return [];
    const label = (e, index) => (index === tl.length - 1 ? 'Live' : e.timelineKind === 'consequence' ? 'Shared consequence' : e.timelineKind === 'terminal' ? 'Teaching point' : 'Earlier');
    return [
      h('h3', { id: 'tlh', text: 'Timeline' }),
      h('ul', { class: 'strip', 'aria-label': 'Swipe through shared material' }, tl.map((e, i) => {
        const isLive = i === tl.length - 1;
        const current = isLive ? S.browseIndex === null : S.browseIndex === i;
        return h('li', {}, h('button', {
          type: 'button', 'data-entry-index': String(i), 'aria-current': current ? 'true' : null,
          onclick: () => { S.browseIndex = isLive ? null : i; updateRoom(); win.scrollTo({ top: 0 }); },
        }, h('span', { class: 'n', text: `${i + 1} · ${label(e, i)}${e.manual ? ' · Facilitator-led discussion' : ''}` }), h('span', { class: 't', text: e.title })));
      })),
    ];
  }

  function updateLobby(v) {
    if (!el.lobby._built) {
      el.lobby._built = true;
      el.lobby._line = h('p', { id: 'lobbyLine', class: 'nm' });
      el.lobby._av = h('span');
      el.lobby._rename = rename ? rename('lobby') : null;
      // Full-splash case art around an opaque status panel (card 36a). The descriptor is the one the participant view
      // already carries (`art`, CASE-164); missing or invalid art draws the brand braid. No case title is added.
      el.lobby._art = h('div', { class: 'splash-art', 'data-splash-art': '', 'aria-hidden': 'true' });
      el.lobby.append(el.lobby._art, h('div', { class: 'card splash-panel' },
        h('h1', { id: 'lobbyH', tabindex: '-1', 'data-focus-heading': '', text: 'Waiting to start' }),
        h('p', { class: 'muted small', text: 'The case starts when the facilitator is ready. Keep this page open.' }),
        h('div', { class: 'preview' }, el.lobby._av, el.lobby._line),
        el.lobby._rename ? h('details', { class: 'ctx' }, h('summary', {}, h('span', { text: 'Change name or avatar' })), h('div', { class: 'inner' }, el.lobby._rename.root)) : null));
      void paintSplash(el.lobby._art, { art: v.art ?? null, group: v.tint ?? 'neutral', surface: 'waiting' });
    }
    const t = v.you.name ? `You're in as ${v.you.name}` : "You're in";
    if (el.lobby._line.textContent !== t) el.lobby._line.textContent = t;
    const k = `${v.you.avatarId}|${v.you.name}`;
    if (el.lobby._av.dataset.k !== k) { el.lobby._av.dataset.k = k; el.lobby._av.replaceChildren(avatarEl(v.you.avatarId, { size: 40, name: v.you.name })); }
    el.lobby._rename?.sync();
  }

  // ───────────────────────── recap ─────────────────────────
  /** Paint the recap cover from the lazy splash chunk; a failed load leaves the canvas empty (decorative). */
  async function paintCover(canvas, art, group) {
    let chunk;
    try { chunk = await import('./splash.mjs'); } catch { return; }
    if (!disposed && canvas.isConnected) chunk.paintCaseCover(canvas, art, { size: 72, group });
  }

  const recapAsked = new Set();
  // Room PDFs v2: each recap image this phone does not hold is asked for once, when its place comes within a screen of view.
  let lazyImages = null;
  function watchImage(node, block) {
    const ask = () => { if (recapAsked.has(block.id)) return; recapAsked.add(block.id); media?.resolve?.(block); };
    const IO = doc.defaultView?.IntersectionObserver;
    if (!IO) { ask(); return; }
    lazyImages ??= new IO((entries) => { for (const e of entries) if (e.isIntersecting) { lazyImages.unobserve(e.target); e.target.dispatchEvent(new Event('recap-near')); } }, { rootMargin: '600px 0px' });
    node.addEventListener('recap-near', ask, { once: true });
    lazyImages.observe(node);
  }
  /** The image blocks this phone was shown, once each, in timeline order (J10). */
  function recapMedia(v) {
    const seen = new Set(), out = [];
    for (const entry of v.timeline ?? []) for (const block of entry?.slide?.blocks ?? []) {
      if (block?.type === 'image' && block.media && !seen.has(block.id)) { seen.add(block.id); out.push(block); }
    }
    return out;
  }

  // Card 40b: the recap as a case journey (recap-journey.mjs, from this view's timeline and rounds only). The screen keeps
  // compact rows; each stop's slide content is in the paper copy only (print), and the built-in PDF holds the same journey.
  const KEY = [['dot', 'slide'], ['dia', 'question'], ['rev', 'revealed by a question'], ['ans', 'your answer']];
  const KIND = { slide: 'Slide', reveal: 'Revealed by a question', question: 'Question' };
  function linesNode(lines) {
    return h('div', { class: 'stop-body' }, lines.map((l) => h('p', { class: l.k === 'q' || l.k === 'img' ? 'muted' : null,
      text: l.k === 'li' ? `${l.n ? `${l.n}.` : '•'} ${l.t}` : l.k === 'row' ? l.cells.filter(Boolean).join(' · ') : l.k === 'img' ? `Image: ${l.t}` : l.t })));
  }
  function questionNode(q) {
    const head = h('h4', { text: q.prompt });
    if (q.shape) head.prepend(h('span', { class: 'ig', role: 'img', 'aria-label': SHAPE_WORD[q.shape], text: SHAPE_GLYPH[q.shape] }));
    return h('article', { class: 'recap-round' }, head, q.rounds.flatMap((a) => [
      q.rounds.length > 1 ? h('p', { class: 'small muted', text: `Round ${a.roundNo}` }) : null,
      h('p', { class: a.words.length ? 'ans' : 'ans none' }, a.marks.length ? h('span', { class: 'mk-wrap' }, a.marks.map((i) => markSvg(i, { size: 22, decorative: false }))) : null,
        // The spoken label keeps its space as its own text node (cleanText trims every string kid).
        h('span', {}, h('span', { class: 'sr-only', text: 'Your answer:' }), doc.createTextNode(` ${a.words.length ? clean(a.words.join(q.shape === 'ranking' ? ' → ' : '')) : 'No answer'}`))),
      a.classification ? h('p', { class: 'cls' }, icon(a.classification, 18), CLASS_WORD[a.classification]) : null,
      a.why ? h('p', { class: 'small' }, h('span', { class: 'sr-only', text: 'Why:' }), doc.createTextNode(` ${clean(a.why)}`)) : null,
      a.doDifferently ? h('p', { class: 'small', text: a.doDifferently }) : null]));
  }
  function buildRecap(v) {
    const r = v.recap;
    if (!r) return [h('h2', { id: 'recH', tabindex: '-1', 'data-focus-heading': '', text: 'Your private recap' }), h('p', { class: 'muted', text: 'No recap is available for this phone.' })];
    const j = recapJourney(v);
    const exp = r.expiresAt ? new Date(r.expiresAt) : null;
    const when = exp && !Number.isNaN(+exp) ? exp.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null;
    // A 72 px canvas cover beside the heading: the room's descriptor from this same view (brand braid if it does not validate).
    const cover = h('canvas', { class: 'recap-cover', width: 1, height: 1 });
    void paintCover(cover, v.art ?? null, v.tint ?? 'neutral');
    // Room PDFs v2 (Julian 2026-10-18): the Finish block leads (participant record, ratings, My Takehome, Download), a persistent
    // node phone.mjs builds once per room so a redraw never drops what was typed; its ratings exist only with a feedback code.
    const finish = recapActions.finish ? recapActions.finish(v, j.feedbackCode) : null;
    const status = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
    const download = async () => {
      status.textContent = '';
      let message;
      try { message = await recapActions.download(v); } catch { message = 'The PDF could not be made. Use Print recap.'; }
      if (!disposed && message) status.textContent = message;
    };
    const out = [
      // Print only: the page header for the paper copy (CASE, the title, the case title). Hidden on screen.
      h('div', { class: 'print-head' }, h('strong', { text: 'CASE' }), h('span', { text: 'Your private recap' }), h('span', { text: r.caseTitle })),
      h('div', { class: 'recap-head' }, cover, h('div', { class: 'recap-title' },
        h('h2', { id: 'recH', tabindex: '-1', 'data-focus-heading': '', text: 'Your private recap' }),
        h('p', { class: 'muted small', text: r.caseTitle }),
        // The facilitator who ran the room (Julian, 2026-10-18), only in the ended recap.
        typeof r.facilitator === 'string' && r.facilitator ? h('p', { class: 'muted small recap-facilitator', text: `Facilitator: ${r.facilitator}` }) : null)),
      h('p', { class: 'small muted noprint', text: when ? `On this phone until ${when}` : 'On this phone for 24 hours after the session' }),
      finish ? h('div', { class: 'noprint recap-finish' }, finish) : null,
      h('div', { class: 'noprint recap-actions' },
        recapActions.download ? h('button', { type: 'button', class: 'btn block', onclick: download, text: 'Download recap (PDF)' }) : null,
        h('button', { type: 'button', class: 'btn block', onclick: () => win.print(), text: 'Print recap' }), status),
    ];
    if (j.objectives.length) out.push(h('h3', { text: 'Objectives' }), h('ol', { class: 'plain' }, j.objectives.map((t) => h('li', { text: t }))));
    if (j.stops.length) out.push(h('h3', { text: 'The Case' }),
      h('p', { class: 'key' }, KEY.map(([sw, word]) => h('span', {}, h('i', { class: `sw ${sw}`, 'aria-hidden': 'true' }), word))),
      h('ol', { class: 'journey' }, j.stops.map((s) => h('li', { class: 'stop', 'data-kind': s.kind },
        h('span', { class: 'node', role: 'img', 'aria-label': KIND[s.kind] }),
        h('div', { class: 'col' }, s.chapter ? h('p', { class: 'chapter', text: s.chapter }) : null,
          s.question ? questionNode(s.question) : h('p', { class: 'stop-t', text: shortTitle(s.title) }),
          s.lines.length ? linesNode(s.lines) : null)))));
    // J10 (Julian, 2026-10-15): the images the room was shown, in the order they appeared, so they print with the recap.
    // A GIF or video appears as its poster; a withdrawn image as its text alternative. What this phone already holds is drawn
    // at once. Room PDFs v2 (Julian, 2026-10-18): anything else loads inline as it nears the screen, once, with this phone's own
    // credential, so no button stands in the way and End brings no burst (red-team S6's intent: phones fetch as people scroll).
    const shown = recapMedia(v);
    lazyImages?.disconnect();
    if (shown.length) {
      out.push(h('h3', { text: 'Images shown' }));
      for (const block of shown) {
        const found = media?.resolve?.(block, { peek: !recapAsked.has(block.id) }), moving = found?.type === 'video/mp4' || found?.type === 'image/gif';
        const still = moving ? found.poster : found?.url, kind = found?.type === 'video/mp4' ? 'Video' : found?.type === 'image/gif' ? 'Animation' : null;
        const pending = !still && found?.state !== 'withdrawn' && !recapAsked.has(block.id) ? h('p', { class: 'muted recap-pending', 'aria-busy': 'true', text: block.alt }) : null;
        if (pending) watchImage(pending, block);
        out.push(h('figure', { class: 'recap-figure' },
          still ? h('img', { class: 'recap-picture', src: still, alt: block.alt, width: found.width, height: found.height })
            : found?.state === 'withdrawn' ? h('p', { class: 'muted', text: `Image withdrawn. ${block.alt}` })
              : pending ?? h('p', { class: 'muted', text: block.alt }),
          h('figcaption', { text: [kind ? `${kind}: ${block.alt}` : block.caption || block.alt, found?.attribution].filter(Boolean).join(' · ') }),
          // Julian (2026-10-17): Print recap credits each revealed image, as the PDF does; the screen stays credit-free.
          v.recap.imageCredits?.[block.id] ? h('p', { class: 'recap-credit', text: v.recap.imageCredits[block.id] }) : null));
      }
    }
    return out;
  }

  // ───────────────────────── decision card ─────────────────────────
  // The card's own state: the round it draws, its layout, the unsent draft and whether a single choice is being changed.
  const card = { roundId: null, layout: null, draft: null, editing: true, refs: null, flushedFor: null };

  function resetDecision(next = null) {
    card.editing = true; card.roundId = null; card.layout = null; card.draft = null; card.refs = null; card.flushedFor = null;
    delivery.round?.(next);
    if (el.decision) { el.decision.replaceChildren(); }
  }

  function optionsOf(d) { return d.interaction.options; }
  function enabledOptions(d) { return optionsOf(d).filter((o) => !o.disabled && !o.explored); }
  function labelOfResponse(d, resp) {
    if (!resp) return null;
    const l = (id) => optionsOf(d).find((o) => o.id === id)?.label ?? id;
    if (resp.option_id) return l(resp.option_id);
    if (resp.option_ids) return resp.option_ids.map(l).join(', ');
    if (resp.order) return resp.order.map(l).join(' → ');
    return resp.text ?? null;
  }
  function draftFrom(d, resp) {
    const t = d.interaction.type;
    const en = new Set(enabledOptions(d).map((o) => o.id));
    if (t === 'single_choice') return { option_id: resp?.option_id && en.has(resp.option_id) ? resp.option_id : null };
    if (t === 'multi_select') return { option_ids: (resp?.option_ids ?? []).filter((x) => en.has(x)) };
    if (t === 'ranking') {
      if (resp?.order) return { order: resp.order.filter((x) => en.has(x)) };
      return { order: d.interaction.rankCount ? [] : enabledOptions(d).map((o) => o.id) };
    }
    return { text: resp?.text ?? '' };
  }
  function responseFromDraft(d) {
    const t = d.interaction.type;
    if (t === 'single_choice') return card.draft.option_id ? { option_id: card.draft.option_id } : null;
    if (t === 'multi_select') return card.draft.option_ids.length ? { option_ids: [...card.draft.option_ids] } : null;
    if (t === 'ranking') {
      const need = d.interaction.rankCount ?? enabledOptions(d).length;
      return card.draft.order.length === need && need > 0 ? { order: [...card.draft.order] } : null;
    }
    const text = clean(card.draft.text);
    return text && text.length <= (d.interaction.maxLength ?? FREE_TEXT_MAX) ? { text } : null;
  }
  /** Hand the draft to the caller (it decides whether this is a new answer worth keeping). */
  function send() {
    const d = view?.decision;
    if (!d || !card.draft) return;
    const response = responseFromDraft(d);
    if (response) void onAnswer(response);
  }

  function updateDecision(v, show) {
    const d = v.decision;
    if (!d) { if (card.roundId) resetDecision(); el.decision.hidden = true; return; }
    rememberOptions(d.decisionId, optionsOf(d).map((o) => o.id));
    if (d.roundId !== card.roundId) {
      resetDecision(d);
      card.roundId = d.roundId;
      card.draft = draftFrom(d, d.yourResponse);
      card.editing = !d.yourResponse;
    }
    el.decision.hidden = !show;
    delivery.reconcile?.(v);
    const layout = d.status === 'locked' || deliveryState().locked ? 'locked' : 'edit';
    if (layout !== card.layout || !card.refs) { card.layout = layout; buildCard(d, layout); }
    refreshCard(d);
    if (card.refs?.closing) card.refs.closing.textContent = d.status === 'open' && d.closesAt ? 'Responses are closing · your answer is being sent' : '';
    if (d.status === 'open' && d.closesAt && card.flushedFor !== d.closesAt) { card.flushedFor = d.closesAt; flushOnClose(d); }
  }
  // CASE-319: the facilitator locked (or everyone answered); whatever is in the answer box goes now, through the same
  // outbox as Send. A blank or unfinished answer sends nothing, and an unchanged one is not sent twice.
  function flushOnClose(d) {
    if (!card.draft) return;
    const response = responseFromDraft(d);
    if (response && JSON.stringify(response) !== JSON.stringify(d.yourResponse ?? null)) void onAnswer(response);
  }
  function refreshDecision() {
    if (disposed) return;
    if (view?.decision && card.refs) { delivery.reconcile?.(view); refreshCard(view.decision); }
  }

  function buildCard(d, layout) {
    const box = el.decision;
    const refs = { type: d.interaction.type };
    card.refs = refs;
    const heading = d.roundNo > 1 ? `Responses reopened · round ${d.roundNo}` : 'Team decision';
    refs.rcpt = h('div', { class: 'rcpt', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'ic' }), h('span', { class: 't' }));
    refs.rcptAlert = h('div', { class: 'rcpt alert', role: 'alert' }, h('span', { class: 'ic' }, icon('alert', 16)), h('span', { class: 't' }));
    const receipts = h('div', { class: 'receipts' }, refs.rcpt, refs.rcptAlert);
    refs.timer = h('p', { class: 'timer-line' });
    box.classList.add('decision');
    box.dataset.phase = layout === 'locked' ? 'locked' : 'open';
    const hEl = h('h2', { id: 'decH', class: 'eyebrow', tabindex: '-1', 'data-focus-heading': '', text: layout === 'locked' ? 'Team decision' : heading });
    // CASE-313: the branch badge, top right of the question card and read right after its heading, open or locked.
    const badge = d.branches === true ? [h('span', { class: 'branch-badge', title: BRANCH_LABEL }, icon('split', 18), h('span', { class: 'sr-only', text: BRANCH_LABEL }))] : [];

    if (layout === 'locked') {
      refs.saved = h('p', { class: 'saved-line' });
      box.replaceChildren(hEl, ...badge, h('p', { class: 'held-prompt', text: d.prompt }),
        h('div', { class: 'banner pause', role: 'note' }, icon('lock', 18), h('span', { text: 'Voting locked · Awaiting the next shared surface' })),
        refs.saved, receipts);
      return;
    }

    const t = d.interaction.type;
    const fs = h('fieldset', {}, h('legend', { id: 'promptL', text: d.prompt }));
    refs.fs = fs;
    const hintTxt = t === 'multi_select' ? 'Choose all that apply' : t === 'ranking' ? `Rank ${d.interaction.rankCount ?? enabledOptions(d).length} options` : null;
    if (hintTxt) fs.append(h('p', { class: 'hint', id: 'hintP', text: hintTxt }));
    if (t === 'single_choice' || t === 'multi_select') fs.append(buildChoiceList(d, t));
    else if (t === 'ranking') { refs.rankMount = h('div'); fs.append(refs.rankMount); refs.live = h('p', { class: 'sr-only-live', role: 'status', 'aria-live': 'polite' }); fs.append(refs.live); renderRanking(d); }
    else fs.append(buildFreeText(d));

    refs.saved = h('p', { class: 'saved-line' });
    refs.hint = h('p', { class: 'small muted', id: 'sendHint' });
    refs.closing = h('p', { class: 'small closing-line', role: 'status', 'aria-live': 'polite' });
    refs.send = h('button', { type: 'button', class: 'btn primary block', 'aria-describedby': 'sendHint', onclick: () => {
      if (t === 'single_choice' && deliveryState().queueFailed) send();
      else if (t === 'single_choice') { card.editing = true; refreshDecision(); (refs.fs.querySelector('input:checked') ?? refs.fs.querySelector('input:not(:disabled)'))?.focus(); }
      else send();
    } });
    box.replaceChildren(hEl, ...badge, refs.timer, fs, refs.saved, receipts, refs.closing, refs.send, refs.hint);
  }

  function optionRow(o, i, input, multi) {
    const locked = o.disabled || o.explored;
    const tag = o.explored ? h('span', { class: 'tag' }, icon('lock', 12), 'Explored') : o.disabled ? h('span', { class: 'tag' }, icon('lock', 12), 'Not available') : null;
    const row = h('label', { class: `opt opt-tile${locked ? ' locked' : ''}${multi ? ' multi' : ''}` }, input,
      h('span', { class: 'mk' }, markSvg(i, { size: 36, decorative: true })),
      h('span', { class: 'lbl' }, h('span', { class: 'sr-only', text: markFor(i).name + ': ' }), o.label),
      h('span', { class: 'ind' }, icon('check', 16)),
      tag, o.explored ? h('span', { class: 'xnote', text: 'The group has already seen where this leads' }) : null);
    row.style.setProperty('--mk', markFor(i).fill);
    return row;
  }
  function buildChoiceList(d, t) {
    const list = h('div', { class: 'opts' });
    const name = `o-${d.roundId}`;
    for (const [i, o] of optionsOf(d).entries()) {
      const locked = o.disabled || o.explored;
      const input = h('input', { type: t === 'single_choice' ? 'radio' : 'checkbox', name, value: o.id, disabled: locked ? '' : null });
      if (!locked) {
        input.checked = t === 'single_choice' ? card.draft.option_id === o.id : card.draft.option_ids.includes(o.id);
        input.addEventListener('change', () => {
          if (t === 'single_choice') card.draft.option_id = o.id;
          else card.draft.option_ids = input.checked ? [...card.draft.option_ids, o.id] : card.draft.option_ids.filter((x) => x !== o.id);
          refreshCard(view.decision);
          if (t === 'single_choice') send();
        });
      }
      list.append(optionRow(o, i, input, t === 'multi_select'));
    }
    return list;
  }
  function buildFreeText(d) {
    const max = d.interaction.maxLength ?? FREE_TEXT_MAX;
    const ta = h('textarea', { id: 'ftext', maxlength: String(max), 'aria-labelledby': 'promptL', 'aria-describedby': 'fcount fpublic', autocomplete: 'off', rows: '4' });
    ta.value = card.draft.text;
    const count = h('p', { class: 'counter', id: 'fcount', text: `${ta.value.length} of ${max}` });
    ta.addEventListener('input', () => { card.draft.text = ta.value; count.textContent = `${ta.value.length} of ${max}`; refreshCard(view.decision); });
    const warn = idWarn(ta, 'ftext-warn');
    warn.upd();
    return h('div', {}, ta, count, h('p', { id: 'fpublic', text: 'Responses are shown to the group without names after responses close. Do not include identifying details.' }), warn.p);
  }

  function renderRanking(d, focus) {
    const refs = card.refs;
    const need = d.interaction.rankCount;
    const byId = new Map(optionsOf(d).map((o) => [o.id, o]));
    const idxOf = new Map(optionsOf(d).map((o, k) => [o.id, k]));
    const mkOf = (id) => h('span', { class: 'mk' }, markSvg(idxOf.get(id), { size: 32, decorative: true }));
    const order = card.draft.order;
    const mount = refs.rankMount;
    const list = order.length ? h('ol', { class: 'rank', 'aria-label': 'Your ranking' }, order.map((id, i) => {
      const o = byId.get(id);
      const mv = (delta, verb) => rankingMoveControl({id, label:o.label, direction:verb,
        disabled:(delta < 0 && i === 0) || (delta > 0 && i === order.length - 1),
        onMove:() => { const j = i + delta; [order[i], order[j]] = [order[j], order[i]]; refs.live.textContent = `${o.label} moved to position ${j + 1} of ${order.length}`; renderRanking(d, { id, verb }); refreshCard(view.decision); },
      });
      const li = h('li', {}, h('div', { class: 'top-row' }, h('span', { class: 'pos', 'aria-hidden': 'true', text: String(i + 1) }), mkOf(id), h('span', { class: 'lbl wrap-anywhere' }, h('span', { class: 'sr-only', text: markFor(idxOf.get(id)).name + ': ' }), `${i + 1}. ${o.label}`)),
        h('div', { class: 'row-btns' }, mv(-1, 'up'), mv(1, 'down'),
          need ? rankingRemoveControl({label:o.label,onRemove:() => { card.draft.order = order.filter((x) => x !== id); refs.live.textContent = `${o.label} removed from your ranking`; renderRanking(d); refreshCard(view.decision); }}) : null));
      li.style.setProperty('--mk', markFor(idxOf.get(id)).fill);
      return li;
    })) : h('p', { class: 'empty-rank', text: `Add ${need} options below, then put them in order.` });
    const pool = optionsOf(d).filter((o) => !order.includes(o.id) && (need || o.disabled || o.explored));
    const avail = pool.length ? h('ul', { class: 'avail', 'aria-label': need ? 'Options you can add' : 'Not available' }, pool.map((o) => {
      const locked = o.disabled || o.explored;
      const li = h('li', { class: locked ? 'locked' : '' },
        mkOf(o.id),
        h('span', { class: 'lbl wrap-anywhere' }, h('span', { class: 'sr-only', text: markFor(idxOf.get(o.id)).name + ': ' }), o.label, o.explored ? h('span', { class: 'xnote block-note', text: 'The group has already seen where this leads' }) : null),
        locked ? h('span', { class: 'tag' }, icon('lock', 12), o.explored ? 'Explored' : 'Not available')
          : h('button', { type: 'button', class: 'btn small', 'aria-label': `Add to ranking: ${o.label}`, text: 'Add', disabled: order.length >= need ? '' : null,
            onclick: () => { card.draft.order = [...order, o.id]; refs.live.textContent = `${o.label} added at position ${order.length + 1} of ${need}`; renderRanking(d); refreshCard(view.decision); } }));
      li.style.setProperty('--mk', markFor(idxOf.get(o.id)).fill);
      return li;
    })) : null;
    // D26: DOM insertion turns null into the text "null"; with every option ranked there is no Add list.
    mount.replaceChildren(...[list, avail].filter(Boolean));
    if (focus) {
      const btn = mount.querySelector(`button[data-id="${win.CSS.escape(focus.id)}"][data-act="${focus.verb}"]:not(:disabled)`) || mount.querySelector(`button[data-id="${win.CSS.escape(focus.id)}"]:not(:disabled)`);
      btn?.focus({ preventScroll: true });
    }
  }

  function currentMsg(d, s) {
    if (d.status === 'held') return { kind: 'pause', text: C.held };
    if (s.enqueuing) return { kind: 'info', text: 'Saving on this phone…', spin: true };
    const p = s.pending;
    if (p) {
      if (p.state === 'held') return { kind: 'pause', text: C.held };
      if (p.state === 'refetch') return { kind: 'info', text: C.updating };
      if (p.state === 'waiting' || !s.online) return { kind: 'info', text: C.waiting, spin: true };
      return { kind: 'info', text: C.sending, spin: true };
    }
    if (card.layout === 'locked' && s.message?.kind !== 'alert') return null;
    return s.message;
  }

  function refreshCard(d) {
    const refs = card.refs;
    if (!refs) return;
    const s = deliveryState();
    const saved = savedResponse(d, s.accepted);
    const savedLabel = labelOfResponse(d, saved);
    const m = currentMsg(d, s);
    // receipt regions: status vs alert, text only
    const useAlert = m?.kind === 'alert';
    const rc = refs.rcpt, ra = refs.rcptAlert;
    const setText = (box, text, kind, spin) => {
      const t = box.querySelector('.t');
      if (t.textContent !== (text ?? '')) t.textContent = text ?? '';
      box.className = `rcpt ${kind ?? ''}`.trim();
      const ic = box.querySelector('.ic');
      const want = !text ? '' : kind === 'ok' ? 'check' : kind === 'pause' ? 'pause' : spin ? 'spinner' : 'info';
      if (box !== ra && ic.dataset.k !== want) { ic.dataset.k = want; ic.replaceChildren(...(want ? [icon(want, 16, want === 'spinner' ? 'spin' : '')] : [])); }
    };
    if (useAlert) { setText(rc, '', ''); setText(ra, m.text, 'alert'); }
    else { setText(ra, '', 'alert'); setText(rc, m?.text ?? '', m?.kind ?? '', m?.spin); }

    if (card.layout === 'locked') {
      refs.saved.textContent = savedLabel ? `Your answer (locked): ${savedLabel}` : 'No answer recorded from this phone';
    } else {
      refs.saved.textContent = savedLabel ? `Your answer: ${savedLabel}` : '';
      const held = d.status === 'held';
      const single = refs.type === 'single_choice';
      const enqueuing = s.enqueuing, pend = s.pending;
      refs.fs.disabled = held || single && !card.editing && !pend && !enqueuing;
      const online = s.online;
      const draftResp = responseFromDraft(d);
      const sending = !!pend;
      const unchanged = !!saved && sameResponse(draftResp, saved) || !!pend && sameResponse(draftResp, pend.response);
      const btn = refs.send;
      btn.replaceChildren();
      const inFlight = enqueuing || sending && pend.state === 'sending' && online;
      if (inFlight) { btn.append(icon('spinner', 18, 'spin'), doc.createTextNode(' Sending…')); btn.setAttribute('aria-busy', 'true'); }
      else { btn.append(doc.createTextNode(saved ? 'Change decision' : 'Send answer')); btn.removeAttribute('aria-busy'); }
      btn.hidden = single && (!saved || card.editing || sending || !!enqueuing) && !s.queueFailed;
      if (single) { btn.textContent = s.queueFailed ? 'Retry decision' : 'Change decision'; btn.removeAttribute('aria-busy'); }
      btn.disabled = single ? held || inFlight : inFlight || held || !draftResp || unchanged;
      let hint = '';
      if (!online) hint = 'Your answer will be kept on this phone and sent when the connection returns';
      else if (!draftResp && refs.type === 'ranking') hint = `Rank exactly ${d.interaction.rankCount ?? enabledOptions(d).length} options to send`;
      else if (!draftResp && refs.type === 'multi_select') hint = 'Choose at least one option to send';
      else if (!draftResp && refs.type === 'single_choice') hint = 'Choose an option to send';
      else if (!draftResp) hint = 'Write an answer to send';
      if (refs.hint.textContent !== hint) refs.hint.textContent = hint;
    }
    renderTimer();
  }

  // ───────────────────────── advisory timer (text only, no pulse, polite at 60 / 10 / 0) ─────────────────────────
  // ONE rounding with the console and the projector (src/shared/timer.mjs; walkthrough bug 3). The caller ticks it.
  const announced = new Set();
  function renderTimer() {
    const refs = card.refs, v = view;
    if (!refs?.timer) return;
    const t = v?.decision && v.timer;
    if (!t) { refs.timer.textContent = ''; return; }
    const r = timerRemainingS(t, Date.now());
    const text = timerWords(r), line = timerLine(r, 'phone');
    if (refs.timer.textContent !== line) refs.timer.textContent = line;
    if (!t.paused) {
      for (const th of TIMER_ANNOUNCE_AT) {
        const k = `${v.decision.roundId}:${t.endsAt}:${th}`;
        if (r <= th && !announced.has(k)) {
          // Only announce a threshold while it is current (a late joiner does not hear the ones already passed).
          announced.add(k);
          const next = th === 60 ? 10 : th === 10 ? 0 : -1;
          if (r > next) say(text);
        }
      }
    }
  }

  return {
    /** Draw a joined participant's view (`view.you` set); the first call builds the room screens. */
    update(next) { if (disposed) return; view = next; if (!el.title) mountRoom(); updateRoom(); },
    /** Build the empty room screens in `main` (the live phone does this when it enters the room). */
    mount() { if (!disposed) mountRoom(); },
    reset() { if (disposed) return; view = null; reset(); },
    header(mode, v) { if (!disposed) header(mode, v); },
    /** Redraw the decision card after the delivery state changed. */
    refreshDecision,
    /** Redraw the advisory timer (call it once a second while a room is shown). */
    tick() { if (!disposed) renderTimer(); },
    /** Show earlier material `index` (null = live) on the next draw. */
    browse(index) { S.browseIndex = index; },
    decision: {
      /** The round the card draws (null when none). */
      get roundId() { return card.roundId; },
      /** Put a kept answer back into the draft (recovery after a reload). */
      restore(d, response) { card.draft = draftFrom(d, response); },
      /** A saved receipt for `response`: a single choice stops editing when the draft still says the same. */
      accepted(d, response) { if (d && card.draft && sameResponse(responseFromDraft(d), response)) card.editing = false; },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSplashes();
      lazyImages?.disconnect(); lazyImages = null;
      for (const remove of listeners) remove();
      listeners.length = 0;
      for (const id of timeouts) globalThis.clearTimeout(id);
      timeouts.clear();
      view = null; card.draft = null; card.refs = null; card.roundId = null; card.layout = null;
      seenOptions.clear(); announced.clear();
      S.browseIndex = null; S.liveKey = undefined; S.liveSurface = null; S.phaseKey = undefined;
      for (const key of Object.keys(el)) delete el[key];
      main.replaceChildren();
    },
  };
}
