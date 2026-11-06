// THE shared art-renderer chunk for the whole app (card 36a, CASE-164, CASE-173): braid splash behind an opaque panel and
// the small canvas cover. The phone (join, waiting, recap cover) and the projector (lobby, ended; card 36b) both import it
// lazily and dynamically, so the renderer never enters any surface's first load, and it is one budgeted `splash` entry.
// It holds nothing private: only the numbers-only descriptor a surface already receives, the fixed brand braid, and
// local layout presets. Anything that does not validate falls back to the brand braid, never to an error.
import { validArtDescriptor,validStructure,withSolution } from '../shared/art-descriptor.mjs';
import { prepareArt,solveArt } from '../shared/mosaic-geometry.mjs';
import { BRAND_ART, BRAND_COMPACT } from './brand-art.mjs';

export { BRAND_ART };
import { mountSplash, paintCover, paintCovers, clearCoverCache, currentTheme, freeRegion, pdfBand, buildSplash } from './mosaic.mjs';
export { paintCovers, clearCoverCache, currentTheme };
/** Room PDFs v2: a document's band from its descriptor, or the brand braid when it has none. */
export const pdfBandFor = (art, opts) => pdfBand(artOrBrand(art), opts);
/** The Finish card's band: the same braid as decorative SVG (light or dark with the page), for a wide strip. */
export const bandArt = (art, { aspect = 8, group = 'neutral' } = {}) => buildSplash(document, artOrBrand(art), { aspect, theme: currentTheme(), group });
/** A published document's own braid descriptor (the builder's publish step, run here for a facilitator PDF). */
export const artForStructure = structure => {try{if(!validStructure(structure))return null;const solution=solveArt(structure);return solution.unavailable?null:withSolution(structure,solution);}catch{return null;}};
export const artForDocument = doc => { try { return prepareArt(doc).art; } catch { return null; } };
import { watchTheme } from './appearance-watch.mjs';
import { MOTION, artTimings } from './splash-motion.mjs';

/** The descriptor to draw: the room's when it validates, else the brand braid. */
export const artOrBrand = art => (validArtDescriptor(art) ? art : BRAND_ART);

const shown = el => el?.isConnected && el.getClientRects().length > 0;
/** The default covers: the host's visible sibling elements (each splash surface lays its opaque panel beside the art). */
const siblingCovers = host => () => [...(host.parentElement?.children ?? [])].filter(el => el !== host && shown(el));
// Arrival is laid once per page or room (surface + drawing), never replayed on a theme repaint or a resize re-solve.
const arrived = new Set();
const q = (v, step) => Math.round(v / step) * step;

/**
 * Mount splash art into `host` (replacing its children), composed into the largest region the opaque covers leave free
 * ("the braid must never be mainly behind a card"), and re-solved when the stage or a cover resizes. `brand: true`
 * ignores `art` (the join pages hold only a code). `covers()` returns the opaque cards and bars over the art (default:
 * the host's visible siblings). Intensity follows the stage: phone-shaped stages 0.3, wider ones 0.7. `host.dataset.art`
 * says which art was drawn and `host.dataset.how` how it fitted. Returns { kind, laid(n), join(spec), relayout(), stop() }.
 */
export function mountCaseSplash(host, art, { brand = false, group = 'neutral', surface = 'page', covers = null, aspect: fallbackAspect = 0.5 } = {}) {
  const chosen = brand ? BRAND_ART : artOrBrand(art);
  const kind = chosen === BRAND_ART ? 'brand' : 'case';
  const coverEls = covers ?? siblingCovers(host);
  const arrivalKey = [surface, kind, JSON.stringify(chosen)].join('|');
  const kept = [];
  let handle = null, layoutKey = null, focus = null, closed = false, timer = 0, typed = 0;
  const measure = () => {
    const stage = host.getBoundingClientRect(), list = coverEls().filter(shown);
    const aspect = stage.width && stage.height ? stage.width / stage.height : fallbackAspect;
    const region = freeRegion(stage, list.map(el => el.getBoundingClientRect()));
    return { aspect: q(aspect, 0.04), focus: region && region.map(v => q(v, 0.01)), list, theme: currentTheme(host.ownerDocument) };
  };
  const paint = (m, arrive) => {
    handle?.stop();
    const go = arrive && !arrived.has(arrivalKey); arrived.add(arrivalKey);
    focus = m.focus; layoutKey = [m.aspect.toFixed(2), m.focus?.join(',') ?? '-', m.theme].join('|');
    handle = mountSplash(host, chosen, { motion: { intensity: m.aspect < 1 ? MOTION.phoneIntensity : MOTION.intensity, arrive: go },
      covers: () => coverEls().filter(shown), contentSeed: kind === 'brand' ? 'case-brand' : 'case-room', group: kind === 'brand' ? 'neutral' : group,
      aspect: m.aspect, focus: m.focus, compact: kind === 'brand' ? BRAND_COMPACT : null, theme: m.theme });
    host.dataset.art = kind; host.dataset.how = handle.svg.dataset.how ?? '';
    handle.motion?.keep(kept);
    if (typed) handle.motion?.laid(typed);
    observe(m.list);
  };
  // Re-solve only when the composition would change; otherwise re-mark which tiles the covers hide.
  const check = () => {
    timer = 0; if (closed) return;
    if (!host.getClientRects().length || !host.getBoundingClientRect().width) return; // hidden: nothing to compose until it shows
    const m = measure(), key = [m.aspect.toFixed(2), m.focus?.join(',') ?? '-', m.theme].join('|');
    if (key !== layoutKey) paint(m, false); else { handle?.motion?.refresh(); observe(m.list); }
  };
  const relayout = () => { if (!closed && !timer) timer = setTimeout(check, 200); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(relayout) : null;
  let observed = [];
  function observe(list) {
    if (!ro) return;
    const next = [host, ...list];
    if (next.length === observed.length && next.every((el, i) => el === observed[i])) return;
    ro.disconnect(); observed = next; for (const el of next) ro.observe(el);
  }
  paint(measure(), true);
  const unwatch = watchTheme(() => { if (!closed) paint(measure(), false); });
  return {
    kind, relayout,
    get region() { return focus; },
    /** Room-code typing: lay one sixth of the route per character. Only the count is ever passed in. */
    laid(n) { typed = Math.max(0, Math.min(6, Math.floor(Number(n) || 0))); handle?.motion?.laid(typed); },
    /** One projector arrival (splash-motion join); its kept route colour survives repaints. */
    join(spec) { const record = handle?.motion ? handle.motion.join({ ...spec, region: focus }) : (spec.landed?.(), null); if (record) kept.push(record); return record; },
    stop() { closed = true; clearTimeout(timer); ro?.disconnect(); unwatch(); handle?.stop(); handle = null; },
  };
}

/** Paint a small canvas cover from the room's descriptor (brand braid when it does not validate). `group` is the room's frozen tint (an enum name; unknown reads as neutral). */
export function paintCaseCover(canvas, art, { size = 72, group = 'neutral' } = {}) {
  return paintCover(canvas, artOrBrand(art), { cssSize: size, theme: currentTheme(), group, contentSeed: 'case-room' });
}

let authArt = null;
/** The facilitator sign-in page (signed out): the brand braid behind one panel. Idempotent; `on = false` removes it. */
export function setAuthSplash(main, on) {
  const wanted = on && main.isConnected;
  main.classList.toggle('auth-splash', wanted);
  let host = main.querySelector(':scope > .auth-art');
  if (!wanted) { authArt?.stop(); authArt = null; host?.replaceChildren(); return; }
  if (!host) { host = document.createElement('div'); host.className = 'auth-art'; host.setAttribute('aria-hidden', 'true'); main.prepend(host); }
  if (!authArt) authArt = mountCaseSplash(host, null, { brand: true, surface: 'sign-in', aspect: 1.6,
    covers: () => [...main.children].filter(el => el !== host && el.childElementCount) });
  else authArt.relayout();
}

// ── projector (card 36b, CASE-174; slim lobby card and joins, 2026-10-10) ──
/**
 * The slim lobby card's title steps down by measurement, never by count: past two lines to --projector-title
 * (`.long`), and to --projector-body (`.longer`) if the card would still overflow its column.
 */
function stepTitle(root) {
  const h = root.querySelector('.joinpanel h1');
  if (!h) return;
  const panel = h.closest('.joinpanel'), column = panel.parentElement;
  h.classList.remove('long', 'longer');
  const style = getComputedStyle(h), line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.15;
  if (h.getBoundingClientRect().height > line * 2 + 1) h.classList.add('long');
  const over = () => panel.scrollHeight > panel.clientHeight + 1 || panel.getBoundingClientRect().bottom > column.getBoundingClientRect().bottom + 1;
  if (over()) h.classList.add('longer');
}
const projectorLayers = new WeakMap();
const QUEUE_LIMIT = 8;

/**
 * The projector's art layer, run after every render (`view` null on teardown): splash only behind the lobby and the
 * ended state, composed beside the slim card and between the bars, the room's frozen tint when the view carries it,
 * and the lobby title step-down. The projector loads this chunk after its first paint; the panels render without it.
 */
export function projectorArt(root, view) {
  const doc = root.ownerDocument;
  let host = root.querySelector(':scope > .projector-splash');
  if (!host) {
    host = doc.createElement('div'); host.className = 'projector-splash'; host.setAttribute('aria-hidden', 'true');
    root.prepend(host);
    doc.fonts?.ready.then(() => { if (root.isConnected) { stepTitle(root); projectorLayers.get(host)?.layer.relayout(); } });
  }
  const was = projectorLayers.get(host);
  if (view?.phase !== 'waiting' && view?.phase !== 'ended') {
    if (was) { flushJoins(was); was.layer.stop(); }
    projectorLayers.delete(host); host.hidden = true;
    if (host.firstChild) host.replaceChildren();
    return;
  }
  const group = typeof view.tint === 'string' ? view.tint : 'neutral';
  const key = [JSON.stringify(view.art ?? null), group].join('|');
  host.hidden = false;
  stepTitle(root);
  if (was?.key !== key) {
    if (was) { flushJoins(was); was.layer.stop(); }
    const covers = () => [root.querySelector(':scope > .top'), root.querySelector(':scope > footer'), ...root.querySelectorAll('.joinpanel, .endcard, .fbcard, .debrief-panel')].filter(Boolean);
    const layer = mountCaseSplash(host, view.art, { surface: `projector:${key}`, aspect: 1.6, group, covers });
    projectorLayers.set(host, { key, layer, queue: [], timer: 0 });
  } else was.layer.relayout();
}

function flushJoins(state) { clearTimeout(state.timer); state.timer = 0; for (const spec of state.queue.splice(0)) spec.landed?.(); }
/**
 * Someone joined the lobby (a quiz-game moment): each arrival's avatar bounces in on the route inside the free region,
 * a ring of tiles turns over in its colours, then it flies into its chip and `landed()` lets the count update. Joins
 * run 0.4 s apart (--art-join-queue); past eight waiting, the extras land at once. With no lobby art, or under reduced
 * motion, every arrival lands at once. Anonymous: only the avatar image and colour, which the projector already shows.
 */
export function projectorJoin(root, arrivals) {
  const state = projectorLayers.get(root.querySelector(':scope > .projector-splash'));
  if (!state) { for (const spec of arrivals) spec.landed?.(); return; }
  state.queue.push(...arrivals);
  if (!state.timer) pump(state, artTimings(root.ownerDocument).joinQueue);
}
function pump(state, gap) {
  state.timer = 0;
  if (!state.queue.length) return;
  while (state.queue.length > QUEUE_LIMIT) state.queue.shift().landed?.();
  state.layer.join(state.queue.shift());
  state.timer = setTimeout(() => pump(state, gap), gap);
}
