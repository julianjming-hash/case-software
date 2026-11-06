// The projector's screen, drawn from a display view (preview overhaul slice 1, CASE-226). The live projector and the
// Builder's Run preview both use it: everything is drawn into the given document and parts, so the preview can draw the
// real projector into a blank frame (HTML pages refuse framing). The live page keeps its transport, sound, timers,
// arrivals and announcements; this module only draws.
import { setAuthoredText, isAuthoredFormat } from './authored-text.mjs';
import { qrSvg } from './projector-qr.mjs';
import { markSvg, markFor } from './projector-marks.mjs';
import { avatarEl } from './avatar.mjs';
import { feedbackUrl, joinUrl, qrPayload } from '../shared/urls.mjs';
import { summaryPages } from '../shared/debrief-pages.mjs';
import { formatCode } from '../shared/ids.mjs';
import { timerRemainingS, timerLine, timerClock } from '../shared/timer.mjs';
/** CASE-335 (Julian, 2026-11-01): the room's countdown is digits only, top right, from the authoritative deadline with the shared
 *  rounding: a ring of the time left, a brief pulse at the 60 s and 30 s milestones, a pop on each of the final ten seconds,
 *  and a `Time up` chip at zero while answers stay open. Motion is decoration only: reduced motion keeps the same states still.
 *  The live page refreshes it in place (projector.mjs `tickTimer`), as does the console's Room sees copy. */
export function countdownState(view, nowMs = Date.now()) {
  const remaining = timerRemainingS(view.timer, nowMs), total = Number(view.timerTotalS) > 0 ? Number(view.timerTotalS) : null;
  return { remaining, words: timerLine(remaining), state: remaining <= 0 ? 'up' : remaining <= 10 ? 'final' : 'run',
    text: remaining <= 0 ? 'Time up' : timerClock(remaining), fraction: total ? Math.min(1, remaining / total) : null };
}
export const COUNTDOWN_MILESTONES = Object.freeze([60, 30]);
/** Refresh a drawn countdown in place; a crossed milestone or a new final second restarts its one-shot animation. */
export function refreshCountdown(doc, view, nowMs = Date.now()) {
  const line = doc?.getElementById('timerLine');
  if (!line || !view?.timer) return null;
  const now = countdownState(view, nowMs), box = line.closest('.timer'), ring = doc.getElementById('timerRing');
  if (line.textContent !== now.text) line.textContent = now.text;
  if (box) {
    const before = Number(box.dataset.remaining);
    if (box.dataset.state !== now.state) box.dataset.state = now.state;
    if (Number.isFinite(before) && before !== now.remaining) {
      if (now.state === 'final') box.dataset.tick = box.dataset.tick === 'a' ? 'b' : 'a';
      if (COUNTDOWN_MILESTONES.some(mark => before > mark && now.remaining <= mark)) box.dataset.pulse = box.dataset.pulse === 'a' ? 'b' : 'a';
    }
    box.dataset.remaining = String(now.remaining);
  }
  if (ring && now.fraction !== null) ring.style.setProperty('--fill', String(Math.round(now.fraction * 1000) / 10));
  return now;
}
import { visiblePeople } from './projector-view.mjs';
import { renderResponseResult, fitTextAnswers } from './projector-result.mjs';
import { applySlideTheme } from '../shared/slide-themes.mjs';
import { BRANCH_ICON_PATH, BRANCH_LABEL } from '../shared/decision-branches.mjs';

/** The projector's three regions (header#top, main#main, footer#foot) in a fresh root. */
export function buildScreen(doc) {
  const root = doc.createElement('div'); root.className = 'screen';
  const parts = {};
  for (const [tag, id] of [['header', 'top'], ['main', 'main'], ['footer', 'foot']]) {
    const node = doc.createElement(tag); node.id = id;
    if (tag === 'main') node.setAttribute('aria-label', 'Projector');
    if (tag === 'header') node.className = 'top';
    root.append(node); parts[id] = node;
  }
  return { root, parts };
}

/**
 * A projector renderer over `parts` in `doc`. `status` and `lost` report the live link (a preview has none);
 * `waitingFor(index, avatarId)` holds a lobby chip back while its arrival plays; `sound` adds the sound control to the
 * footer; `preview` (the Builder's Run preview, which has no room) keeps the join panel's place without a QR or code;
 * `onReady` runs when the lazily loaded slide renderer arrives, so the caller can draw again.
 */
export function createProjectorRenderer({ doc, parts, origin, topology = 'separate', status = () => 'live', lost = () => false, waitingFor = () => false, sound = null, preview = false, onReady = () => {}, media = null }) {
  const win = doc.defaultView;
  let slides = null; // projector-slides.mjs, lazy: loaded on the first slide surface (card 57)
  function el(tag, cls, text) { const e = doc.createElement(/^(p|h[1-6])$/.test(tag) && isAuthoredFormat(text) ? 'div' : tag); if (cls) e.className = cls; if (text !== undefined) setAuthoredText(e, text, 2000); return e; }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM11 18h2',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    pause: 'M8 5v14M16 5v14',
    speech: 'M4 5h16v11H10l-5 4v-4H4z',
    rewind: 'M11 6l-7 6 7 6zM20 6l-7 6 7 6z',
    offline: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
    arc: 'M12 3a9 9 0 1 0 9 9',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    people: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5.3a3 3 0 0 1 0 5.4M18 14.5c1.8.8 3 2.6 3 5.5',
    sound: 'M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 0 1 0 6',
    mute: 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6',
    split: BRANCH_ICON_PATH,
  };
  function icon(name) {
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true');
    const p = doc.createElementNS(SVGNS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
    return s;
  }

  // ── phase state (CASE-114): one accent on the pill; the label is short, the call to action sits in the
  // decision column. A consequence is a revealed route's surface. ──
  function phaseOf(view) {
    if (!view) return null;
    switch (view.phase) {
      case 'waiting': return null;
      case 'decision_open': return view.manual ? ['locked', 'Facilitator-led'] : ['open', 'Decision open'];
      case 'reviewing': return ['locked', view.manual ? 'Facilitator-led' : 'Responses locked'];
      case 'paused': return ['paused', 'Discussion pause'];
      case 'teaching': return ['consequence', 'Teaching point'];
      case 'ended': return ['reveal', 'Session ended'];
      case 'debrief': return ['reveal', 'Debrief'];
      default: return ['consequence', 'terminal'].includes(view.surface?.timelineKind) ? ['consequence', 'Consequence'] : ['reveal', 'Revealed'];
    }
  }

  // ── top row ──
  function layer(cls, ic, text) { const b = el('span', `layer ${cls}`); b.append(icon(ic), el('span', null, text)); return b; }
  function renderTop(view, from) {
    const title = el('div', 'title');
    title.append(el('p', 'eyebrow', 'Case'));
    if (view?.caseTitle && view.phase !== 'waiting') title.append(el('p', 'case', view.caseTitle));
    // Room status: the phase pill and the layers (manual, replay, lost), icon plus text, never colour alone.
    const box = el('section'); box.id = 'banners'; box.setAttribute('aria-label', 'Session status');
    const ph = phaseOf(view);
    if (ph) { const p = el('span', 'pill', ph[1]); p.dataset.phase = ph[0]; box.append(p); }
    if (topology === 'separate' && lost()) box.append(layer('lost', 'offline', 'Connection lost · follow the facilitator'));
    if (view?.replay) box.append(layer('replay', 'rewind', 'Presentation replay · phones remain on live surface'));
    if (view?.manual) box.append(layer('manual', 'speech', 'Manual session mode · facilitator-led discussion'));
    const countdown = v => {
      const now = countdownState(v), t = el('span', 'timer'); t.dataset.state = now.state; t.dataset.remaining = String(now.remaining);
      t.setAttribute('role', 'timer'); t.setAttribute('aria-label', 'Response timer');
      if (now.fraction !== null) {
        const ring = doc.createElementNS(SVGNS, 'svg'); ring.setAttribute('viewBox', '0 0 36 36'); ring.setAttribute('class', 'timer-ring'); ring.setAttribute('aria-hidden', 'true');
        ring.id = 'timerRing'; ring.style.setProperty('--fill', String(Math.round(now.fraction * 1000) / 10));
        for (const cls of ['ring-track', 'ring-fill']) { const c = doc.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', '18'); c.setAttribute('cy', '18'); c.setAttribute('r', '15.9155'); c.setAttribute('pathLength', '100'); c.setAttribute('class', cls); ring.append(c); }
        t.append(ring);
      }
      const digits = el('span', 'timer-digits', now.text); digits.id = 'timerLine';
      t.append(digits);
      return t;
    };
    const meta = el('div', 'meta');
    if (view?.phase === 'decision_open' && !view.manual && view.names === null) {
      const n = view.counts.responded;
      if (n !== null) { const c = el('span', 'count'); c.append(icon('people'), el('span', 'num', `${n} of ${view.counts.present}`), ' answered'); meta.append(c); }
      if (view.timer) meta.append(countdown(view));
    }
    // Connection state (SCREENS.md Connection states): nothing while live; a same-PC window following the
    // console locally has the console as its authority, so no indicator either.
    if (from !== 'local' && (status() === 'connecting' || status() === 'lost')) { const c = el('span', 'conn'); c.append(icon('arc'), status() === 'lost' ? 'Reconnecting…' : 'Connecting…'); meta.append(c); }
    parts.top.replaceChildren(title, box, meta);
  }

  // ── information column ──
  /** The vitals strip: label, value, unit, trend arrow and the earlier value (CASE-090). */
  function renderVitals(obs) {
    if (!obs?.length) return null;
    const ul = el('ul', 'vitals');
    ul.setAttribute('aria-label', 'Vitals');
    for (const o of obs) {
      const li = el('li');
      const value = o.value;
      const say = `${o.label} ${value}${o.unit ? ' ' + o.unit : ''}${o.trend ? `, ${o.trend} from ${o.previous}` : ''}`;
      li.append(el('span', 'sr-only', say));
      const row = el('span', 'vrow'); row.setAttribute('aria-hidden', 'true');
      row.append(el('span', 'vv', value));
      if (o.unit) row.append(el('span', 'vu', o.unit));
      const lbl = el('span', 'vl', o.label); lbl.setAttribute('aria-hidden', 'true');
      li.append(lbl, row);
      if (o.trend) { const a = el('span', 'va', `${o.trend === 'up' ? '↑' : '↓'} ${o.previous}`); a.setAttribute('aria-hidden', 'true'); li.append(a); } // earlier value (CASE-090)
      ul.append(li);
    }
    return ul;
  }
  function listTile(cls, title, items) {
    if (!items?.length) return null;
    const box = el('section', `card find ${cls}`);
    box.setAttribute('aria-label', title);
    box.append(el('p', 'eyebrow', title));
    const ul = el('ul');
    for (const t of items) ul.append(el('li', null, t));
    box.append(ul);
    return box;
  }
  function sceneCard(s) {
    const card = el('section', 'card scene');
    card.setAttribute('aria-label', 'Live surface');
    card.dataset.kind = s.timelineKind;
    card.append(el('h1', null, s.title));
    if (s.scene) card.append(el('p', 'prose', s.scene));
    return card;
  }
  function findingsTiles(s, { investigations = true } = {}) {
    const f = listTile('findings', 'Findings', s.points);
    const i = investigations ? listTile('investigations', 'Investigations', s.investigations) : null;
    if (!f && !i) return null;
    const wrap = el('div', 'tiles2');
    if (f) wrap.append(f);
    if (i) wrap.append(i);
    return wrap;
  }

  /** The options as stacked tiles in the one authored order, each with its shape + colour mark and full text. */
  function renderTiles(decision) {
    const opts = decision.interaction.options;
    if (!opts.length) return null; // free text: the prompt only
    const ol = el('ol', 'tiles');
    ol.setAttribute('aria-label', 'Options');
    opts.forEach((o, i) => {
      const m = markFor(i);
      const li = el('li', 'tile opt-tile' + (o.explored || o.disabled ? ' dim' : ''));
      li.style.setProperty('--mk', m.fill);
      li.append(markSvg(i, { size: 72, decorative: false }), el('span', 'lbl', o.label));
      if (o.explored) li.append(el('span', 'tag', 'Explored'));
      ol.append(li);
    });
    return ol;
  }
  function decisionColumn(view) {
    const d = view.decision;
    const box = el('section', 'card decision');
    box.setAttribute('aria-label', 'Team decision');
    box.dataset.phase = phaseOf(view)[0];
    const call = el('p', 'call');
    if (view.manual) call.append(icon('speech'), 'Facilitator-led discussion');
    else if (view.phase === 'decision_open') call.append(icon('phone'), 'Prompt');
    else if (view.phase === 'reviewing') call.append(icon('lock'), 'Responses locked · Facilitator reviewing');
    else if (view.phase === 'paused') call.append(icon('pause'), 'Paused · answers are held');
    box.append(call, el('h2', null, d.prompt));
    // CASE-313: a question whose answers lead to different next slides carries the branch badge, top right.
    if (view.decisionBranches === true) { const badge = el('span', 'branch-badge'); badge.title = BRANCH_LABEL; badge.append(icon('split'), el('span', 'sr-only', BRANCH_LABEL)); box.append(badge); }
    const t = renderTiles(d);
    if (t) box.append(t);
    return box;
  }


  function renderLobby(view) {
    const panel = el('section', 'card joinpanel');
    panel.setAttribute('aria-label', 'Join');
    if (topology === 'same-pc') panel.append(el('p', 'check', 'Projector'));
    panel.append(el('h1', null, view.caseTitle));
    if (view.joiningClosed) { panel.append(el('h2', null, 'Joining is closed')); return panel; }
    if (preview) { const q = el('div', 'qrcard'); q.append(el('p', 'preview-code', 'No session code in a preview'));
      panel.append(q, el('h2', null, 'Join the case'), el('div', 'url', `${new URL(origin).host}/join`), el('div', 'code', 'Preview')); return panel; }
    const url = joinUrl(view.joinCode, origin);
    const q = el('div', 'qrcard'); q.append(qrSvg(qrPayload(url), { margin: 4 }));
    q.firstChild.setAttribute('aria-label', `QR code for ${url.replace('https://', '')}`);
    const code = el('div', 'code', formatCode(view.joinCode)); code.setAttribute('aria-label', `Session code ${formatCode(view.joinCode)}`);
    panel.append(q, el('h2', null, 'Join the case'), el('div', 'url', url.replace(/^https:\/\//, '')), code);
    return panel;
  }
  /** The lobby join panel's pattern: the code on white in both themes, its caption below. */
  function feedbackCard(code) {
    const url = feedbackUrl(code, origin), card = el('section', 'card fbcard');
    card.setAttribute('aria-label', 'Feedback');
    const q = el('div', 'qrcard'); q.append(qrSvg(qrPayload(url), { margin: 4 }));
    q.firstChild.setAttribute('aria-label', `QR code for ${url.replace('https://', '')}`);
    card.append(q, el('h2', null, 'Feedback'));
    return card;
  }
  /**
   * The summary, then one shown result per page, counts only. A long summary takes two pages (debrief-pages.mjs): the route,
   * then the objectives. With no page (no paging grant) the summary shows whole, stepped down to fit.
   */
  function debriefPanel(view) {
    const { route, objectives, results, page } = view.debrief, panel = el('section', 'card debrief-panel');
    const sp = summaryPages(view.debrief), result = page >= sp ? results[page - sp] : null;
    const showRoute = !result && (page === undefined || sp === 1 || page === 0), showObjectives = !result && (page === undefined || sp === 1 || page === 1);
    panel.setAttribute('aria-label', result ? 'Result' : 'Debrief');
    // A dense page steps its text down (never below the projector's 18 px label floor) before anything clips.
    if (result ? result.counts.length > 5 : (sp === 2 && page !== 0) || route.length + objectives.length > 6) panel.classList.add('dense');
    if (!result) {
      panel.append(el('h2', null, view.caseTitle));
      if (showRoute && route.length) { const ol = el('ol', 'route'); route.forEach((title, i) => { const li = el('li'); li.append(el('span', 'k', String(i + 1).padStart(2, '0')), el('span', null, title)); ol.append(li); });
        panel.append(el('p', 'eyebrow', 'Where our choices took us'), ol); }
      if (showObjectives && objectives.length) { const ol = el('ol', 'objectives'); for (const text of objectives) ol.append(el('li', null, text)); panel.append(el('p', 'eyebrow', 'Objectives'), ol); }
    } else {
      panel.append(el('p', 'eyebrow', result.type === 'ranking' ? 'Ranked first' : 'Responses'), el('p', 'q', result.prompt));
      const ul = el('ul', 'pres'), max = Math.max(1, ...result.counts.map(c => c.count));
      result.counts.forEach((c, i) => {
        const li = el('li'), bar = el('span', 'bar'), fill = el('i');
        li.style.setProperty('--mk', markFor(i).fill);
        bar.setAttribute('aria-hidden', 'true'); fill.style.width = `${Math.round((c.count / max) * 100)}%`; bar.append(fill);
        li.append(markSvg(i, { size: 32, decorative: false }), el('span', 'l', c.label), bar, el('span', 'n', String(c.count)));
        ul.append(li);
      });
      panel.append(ul, el('p', 'eyebrow', `${result.total} ${result.total === 1 ? 'response' : 'responses'}`));
    }
    if (page !== undefined) panel.append(el('p', 'pos', `${page + 1} of ${results.length + sp}`));
    return panel;
  }
  /**
   * Lay the main grid out (CASE-113). `place` says where the findings and investigations tiles go:
   * 'right' (no decision open: the right column carries them), 'left' (under the vitals) or 'none'
   * (only for a surface without an open decision). An open decision keeps Findings (CASE-134).
   */
  function renderMain(view, layout) {
    const { vitals: vPlace = 'left', tiles: place = 'right', investigations = true } = layout;
    const main = parts.main;
    main.className = '';
    if (!view) { main.className = 'single'; main.replaceChildren(el('h1', 'waiting-note', 'Waiting for the session…')); return; } // every state has a level-one heading (axe)
    if (view.phase === 'waiting') { main.className = 'single splash-main'; main.replaceChildren(renderLobby(view)); return; }
    // Debrief (console layout v2): the ended page's pattern under its own heading, until the facilitator replays a slide.
    const debriefPage = view.phase === 'debrief' && !view.surface;
    if (view.phase === 'ended' || debriefPage) {
      const end = el('section', 'card endcard');
      if (debriefPage) end.append(el('h2', null, 'Debrief'), el('p', null, 'Your recap and the feedback form are on your phone'));
      else end.append(el('h2', null, 'Session ended'), el('p', null, 'Thank you · your private recap is on your phone for 24 hours'));
      // Card 40d: the feedback QR card above Session ended, and the debrief panel the console pages (a view without
      // one, from an older Worker, keeps the ended card alone).
      const column = el('div', 'endcol');
      if (view.feedbackCode && !preview) column.append(feedbackCard(view.feedbackCode));
      column.append(end);
      main.className = `single splash-main${view.debrief ? ' ended-debrief' : ''}`;
      main.replaceChildren(el('h1', 'sr-only', view.caseTitle), column, ...(view.debrief ? [debriefPanel(view)] : [])); return;
    }
    if (['ranking', 'free_text'].includes(view.responseResult?.type) && !view.replay) {
      const column = el('div', 'col'); column.append(el('h1', 'sr-only', view.caseTitle), renderResponseResult(view, { el, markSvg }));
      main.className = 'single'; main.replaceChildren(column); return;
    }
    if (view.surface?.slide) {
      if (slides?.renderSlideMain) {
        const drawn = slides.renderSlideMain(main, view, { el, decisionColumn, responseResult: v => renderResponseResult(v, { el, markSvg }), media });
        applySlideTheme(main.querySelector('.slide-canvas'), view.surface.slide.theme); // the case's theme (CASE-227)
        return drawn;
      }
      slides ||= import('./projector-slides.mjs').then(m => { slides = m; onReady(); }, () => { slides = { failed: true }; onReady(); });
      main.className = 'single'; main.replaceChildren(el('h1', slides?.failed ? 'waiting-note' : 'sr-only', slides?.failed ? 'This slide could not load. Reload the display.' : view.caseTitle)); return;
    }
    const s = view.surface;
    const left = el('div', 'col');
    const right = el('div', 'col');
    if (s) left.append(sceneCard(s));
    else left.append(el('h1', 'sr-only', view.caseTitle));
    const vit = s ? renderVitals(s.observations) : null;
    if (vit && vPlace === 'left') left.append(vit);
    const tiles = s ? findingsTiles(s, { investigations }) : null;
    if (view.responseResult) right.append(renderResponseResult(view, { el, markSvg }));
    else if (view.decision) right.append(decisionColumn(view));
    if (vit && vPlace === 'right') right.append(vit);
    if (tiles && place === 'right') right.append(tiles);
    if (tiles && place === 'left') left.append(tiles);
    if (!right.childElementCount) { main.className = 'single'; main.replaceChildren(left); return; }
    main.replaceChildren(left, right);
  }
  /** Where the vitals and the tiles go, in order of preference, for this view. */
  function placements(view) {
    if (!view || view.phase === 'waiting') return [{}];
    if (view.decision && view.phase !== 'ended') return win.innerWidth >= 1920 ? [{ tiles: 'left' }] : [{ tiles: 'left' }, { tiles: 'left', investigations: false }];
    return [{ tiles: 'right' }, { tiles: 'left' }, { vitals: 'right', tiles: 'right' }, { vitals: 'right', tiles: 'left' }, ...(win.innerWidth >= 1920 ? [] : [{ vitals: 'right', tiles: 'none' }, { tiles: 'none' }])];
  }

  // ── bottom row ──
  function renderFooter(view) {
    const kids = [];
    const joinable = view && !view.joiningClosed && view.phase !== 'ended' && view.phase !== 'waiting';
    if (joinable && preview) {
      const route = el('div', 'route'), code = el('div', 'code'); code.append(el('span', 'k', 'Code'), el('b', null, 'Preview'));
      route.append(el('div', 'url', `${new URL(origin).host}/join`), code);
      kids.push(el('div', 'qrcell'), route);
    } else if (joinable) {
      const url = joinUrl(view.joinCode, origin);
      const q = el('div', 'qrcell'); q.append(qrSvg(qrPayload(url), { margin: 4 }));
      q.firstChild.setAttribute('aria-label', `QR code for ${url.replace('https://', '')}`);
      const route = el('div', 'route');
      const code = el('div', 'code'); code.append(el('span', 'k', 'Code'), el('b', null, formatCode(view.joinCode)));
      route.append(el('div', 'url', url.replace(/^https:\/\//, '')), code);
      kids.push(q, route);
    } else if (view?.phase === 'debrief' && view.feedbackCode && !preview) {
      // While a slide is replayed in Debrief, the feedback QR keeps the join route's place.
      const url = feedbackUrl(view.feedbackCode, origin);
      const q = el('div', 'qrcell'); q.append(qrSvg(qrPayload(url), { margin: 4 }));
      q.firstChild.setAttribute('aria-label', `QR code for ${url.replace('https://', '')}`);
      const route = el('div', 'route'); route.append(el('div', 'url', url.replace(/^https:\/\//, '')), el('div', 'code', 'Feedback'));
      kids.push(q, route);
    } else if (view && view.joiningClosed && view.phase !== 'ended') kids.push(el('span', 'closed', 'Joining is closed'));
    else kids.push(el('span'));
    parts.foot.className = joinable || (view?.phase === 'debrief' && view.feedbackCode && !preview) ? '' : 'noroute';
    kids.push(renderNames(view));
    if (sound) kids.push(sound.element);
    parts.foot.replaceChildren(...kids);
  }

  /** `In the room`: avatar-only chips until Show names, then avatar + name (CASE-133). */
  function renderNames(view) {
    const box = el('section', 'names');
    if (!view) return box;
    box.setAttribute('aria-labelledby', 'namesH');
    const hd = el('h2', null, 'Participants'); hd.id = 'namesH';
    box.append(hd);
    const ul = el('ul');
    const showingNames = view.names !== null;
    const { people: avatars, more } = visiblePeople(view);
    for (const [index, n] of avatars.entries()) {
      const li = el('li', `chip${showingNames ? '' : ' anonymous'}`);
      li.dataset.index = index;
      if (view.phase === 'waiting' && waitingFor(index, n.avatarId)) li.classList.add('arrival-pending');
      if (!showingNames) li.setAttribute('aria-label', 'Participant');
      li.append(avatarEl(n.avatarId, { size: 32, name: showingNames ? n.name : '' }));
      if (showingNames) li.append(el('span', 'nm', n.name));
      ul.append(li);
    }
    ul.dataset.unnamed = more;
    box.append(ul);
    if (view.phase === 'waiting') {
      const waiting = avatars.filter((n, index) => waitingFor(index, n.avatarId)).length;
      box.append(el('span', 'arrival-note', `${Math.max(0, view.counts.participants - waiting)} joined`));
    }
    return box;
  }
  /** Chips that do not fit on the one line become `+N`; the hidden names stay out of the page (no title). */
  function fitNames() {
    const ul = parts.foot.querySelector('.names ul');
    if (!ul) return;
    const chips = [...ul.children];
    const extra = +ul.dataset.unnamed;
    const more = el('li', 'chip more');
    const place = (n) => { more.textContent = `+ ${n} more`; more.setAttribute('aria-label', `and ${n} more`); if (!more.isConnected) ul.append(more); };
    if (extra) place(extra);
    let hiddenN = 0;
    for (let i = chips.length - 1; i >= 0 && ul.scrollWidth > ul.clientWidth + 1; i--) {
      chips[i].remove(); hiddenN += 1; place(hiddenN + extra);
    }
  }

  // Fit at any size without scrolling. During a decision, Findings shrink first to an 18px floor;
  // spacing and other type follow, then Investigations yield and Findings truncate with a count.
  function fit(view) {
    if (parts.main.querySelector('.text-chips')) return fitTextAnswers(parts.main, win);
    if (view?.surface?.slide) return slides?.fitSlide?.(parts.main);
    const m = parts.main;
    const ok = () => [...m.querySelectorAll('.col')].every((c) => c.scrollHeight <= c.clientHeight + 1) && m.scrollWidth <= m.clientWidth + 1;
    const set = (s, sp, findSize) => { doc.documentElement.style.setProperty('--s', s); m.style.setProperty('--s', s); m.style.setProperty('--sp', sp); m.style.setProperty('--p-find', `${findSize}px`); };
    const decision = Boolean(view?.decision && view.phase !== 'ended');
    const stages = [];
    const findingsFloor = win.innerWidth >= 1920 ? 24 : 18;
    if (decision) for (const f of (win.innerWidth >= 1920 ? [24] : [24, 22, 20, 18])) stages.push([1, 1, f]);
    for (const sp of [1, .8, .6, .45]) stages.push([1, sp, decision ? findingsFloor : 24]);
    for (const s of [.94, .88, .82, .76, .7]) stages.push([s, .45, decision ? findingsFloor : 24]);
    for (const sp of [.3, .15, 0]) stages.push([.7, sp, decision ? findingsFloor : 24]);
    const run = () => { for (const st of stages) { set(...st); if (ok()) return true; } return false; };
    const order = placements(view);
    const spill = () => Math.max(0, ...[...m.querySelectorAll('.col')].map((c) => c.scrollHeight - c.clientHeight));
    let fitted = false, best = null;
    for (const [i, layout] of order.entries()) {
      if (i) renderMain(view, layout);
      if ((fitted = run())) break;
      if (!best || spill() < best.spill) best = { layout, spill: spill() };
    }
    if (!fitted && best && best.layout !== order.at(-1)) { renderMain(view, best.layout); run(); }
    if (!fitted && decision && win.innerWidth < 1920) {
      const list = m.querySelector('.findings ul');
      if (list) {
        const items = [...list.children];
        const more = el('li', 'more');
        list.append(more);
        for (let n = 1; n <= items.length; n++) {
          items[items.length - n].hidden = true;
          more.textContent = `+${n} more on your phone`;
          if (ok()) { fitted = true; break; }
        }
      }
    }
    m.dataset.overflow = !fitted; // lab check: text never scrolls
  }

  return { el, icon, phaseOf, renderTop, renderMain, renderFooter, renderNames, fitNames, fit, placements, decisionColumn };
}
