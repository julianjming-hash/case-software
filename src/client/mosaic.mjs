// src/client/mosaic.mjs: paints a case's braid art from its numbers-only descriptor (card 28, CASE-164).
//
// Two outputs over one geometry core (src/shared/mosaic-geometry.mjs):
//   • covers: a canvas bitmap, cached per (renderer, structure, attempt, theme, size, group, shade seed),
//     drawn on an OffscreenCanvas where available and painted one cover per task so a library of covers
//     never holds the main thread for long;
//   • splash: SVG built node by node with createElementNS and composed into the free region beside the opaque
//     cards, so tiles can move (splash-motion.mjs) under reduced-motion, Motion off and visibility guards.
// Text never enters the art: no innerHTML, no DOMParser, no labels. Covers carry only the generic
// accessible name; splash art is decorative. The descriptor arrives already validated; anything that is
// not the exact numbers-only shape paints nothing.
import { buildScene, CANONICAL, GROUPS, hash } from '../shared/mosaic-geometry.mjs';
import { validArtDescriptor, structureKey, ART_LABEL, ART_ATTEMPTS } from '../shared/art-descriptor.mjs';
import { presentationArt } from '../shared/art-presentation.mjs';
import { startMotion } from './splash-motion.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const MIN_TILE_CSS_PX = 5.5;
const CACHE_LIMIT = 64;
const cache = new Map();

export { ART_LABEL };

/** 'light' or 'dark' for a document: an explicit data-theme wins, else the OS preference. */
export function currentTheme(doc = globalThis.document) {
  const t = doc?.documentElement?.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}


const groupOf = (group) => (typeof group === 'string' && Object.hasOwn(GROUPS, group) ? group : 'neutral');

/** The cover cache key: numbers and fixed keywords only (no title, no id). */
export function coverKey(art, { theme = 'light', size = 0, group = 'neutral', contentSeed = '', full = false } = {}) {
  return [full ? 1 : 0, art.renderer, structureKey(art), art.attempt, art.summarised ? 1 : 0, theme === 'dark' ? 'dark' : 'light',
    Math.round(size), groupOf(group), hash(String(contentSeed))].join('|');
}

function drawScene(g, scene, px) {
  const k = px / Math.min(scene.width, scene.height);
  const ox = (px - scene.width * k) / 2, oy = (px - scene.height * k) / 2;
  g.fillStyle = scene.grout; g.fillRect(0, 0, px, px);
  g.lineJoin = 'round'; g.lineWidth = scene.groutWidth * k; g.strokeStyle = scene.grout;
  for (const sh of scene.shapes) {
    g.beginPath();
    for (let i = 0; i < sh.poly.length; i++) { const x = ox + sh.poly[i][0] * k, y = oy + sh.poly[i][1] * k; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.closePath(); g.fillStyle = sh.fill; g.fill(); g.stroke();
  }
}

function coverInputs(art, { cssSize = 216, dpr = globalThis.devicePixelRatio || 1, theme = 'light', group = 'neutral', contentSeed = '', full = false } = {}) {
  const px = Math.max(1, Math.round(cssSize * dpr));
  return { px, cssSize, theme, full, group: groupOf(group), contentSeed: String(contentSeed), key: coverKey(art, { theme, size: px, group, contentSeed, full }) };
}
function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key); cache.set(key, hit);
  return { ...hit, ms: 0, cached: true };
}
function coverScene(art, c) {
  return buildScene(presentationArt(art, { full: c.full }), { theme: c.theme, group: c.group, contentSeed: c.contentSeed, tile: MIN_TILE_CSS_PX * CANONICAL / Math.max(1, c.cssSize) });
}
function drawCover(scene, c) {
  let image;
  if (typeof OffscreenCanvas === 'function') {
    const off = new OffscreenCanvas(c.px, c.px);
    drawScene(off.getContext('2d'), scene, c.px);
    image = off.transferToImageBitmap();
  } else {
    image = globalThis.document.createElement('canvas');
    image.width = c.px; image.height = c.px;
    drawScene(image.getContext('2d'), scene, c.px);
  }
  const entry = { image, px: c.px };
  cache.set(c.key, entry);
  while (cache.size > CACHE_LIMIT) { const [oldest, old] = cache.entries().next().value; cache.delete(oldest); old.image.close?.(); }
  return entry;
}

/**
 * Render one cover bitmap (device pixels, square). Cached; returns { image, px, ms, cached }.
 * `cssSize` is the displayed edge in CSS px; tiles never fall below 5.5 CSS px.
 */
export function renderCover(art, opts = {}) {
  if (!validArtDescriptor(art)) return null;
  const c = coverInputs(art, opts);
  const hit = cached(c.key);
  if (hit) return hit;
  const t0 = performance.now();
  const scene = coverScene(art, c);
  if (scene.refused) return null;
  const entry = drawCover(scene, c);
  return { ...entry, ms: performance.now() - t0, cached: false };
}

function show(canvas, out) {
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', ART_LABEL);
  if (!out) { canvas.width = 1; canvas.height = 1; return null; }
  canvas.width = out.px; canvas.height = out.px;
  canvas.getContext('2d').drawImage(out.image, 0, 0);
  return out;
}

/** Paint a cover into a canvas element: generic accessible name, no visible text, never a label. */
export function paintCover(canvas, art, opts = {}) {
  const cssSize = opts.cssSize || canvas.getBoundingClientRect().width || 216;
  return show(canvas, renderCover(art, { ...opts, cssSize }));
}

const nextTask = () => new Promise((resolve) => {
  if (globalThis.scheduler?.postTask) globalThis.scheduler.postTask(resolve, { priority: 'background' });
  else setTimeout(resolve, 0);
});

/**
 * Paint many covers so input stays responsive while a library renders: each uncached cover takes two
 * short tasks (geometry, then drawing), with a yield before each.
 * @param {{canvas: HTMLCanvasElement, art: object, group?: string, contentSeed?: string}[]} items
 */
export async function paintCovers(items, opts = {}) {
  const results = [];
  const current = canvas => canvas.isConnected !== false && (!opts.isCurrent || opts.isCurrent(canvas));
  for (const item of items) {
    await nextTask();
    if (!current(item.canvas)) { results.push(null); continue; }
    if (!validArtDescriptor(item.art)) { results.push(show(item.canvas, null)); continue; }
    const cssSize = opts.cssSize || item.canvas.getBoundingClientRect().width || 216;
    const c = coverInputs(item.art, { ...opts, cssSize, full: item.full ?? opts.full, group: item.group ?? opts.group, contentSeed: item.contentSeed ?? opts.contentSeed });
    const hit = cached(c.key);
    if (hit) { results.push(show(item.canvas, hit)); continue; }
    const t0 = performance.now();
    const scene = coverScene(item.art, c);
    if (scene.refused) { results.push(show(item.canvas, null)); continue; }
    const built = performance.now() - t0;
    await nextTask();
    if (!current(item.canvas)) { results.push(null); continue; }
    const t1 = performance.now();
    const entry = drawCover(scene, c);
    results.push(show(item.canvas, { ...entry, ms: built + performance.now() - t1, cached: false }));
  }
  return results;
}

/** Drop every cached bitmap (for example after a theme change). */
export function clearCoverCache() { for (const { image } of cache.values()) image.close?.(); cache.clear(); }

// ── splash ────────────────────────────────────────────────────────────────
/**
 * The largest region of a stage that no opaque card or bar covers, as fractions [x0, y0, x1, y1] of the stage (the
 * motion lab's freeRegion). Full-width bars trim the top and bottom; the cards are unioned and the art takes the
 * biggest side left over. `stage` and `covers` are client rects; covers outside the stage are ignored. Null when
 * nothing covers the stage, and null when the best region is too thin to hold the art (its short side under 12% of the
 * stage's short side, or under 8% of its area): composing into a sliver would draw thousands of invisible tiles.
 * A full-width band is trimmed to at most 4:5 about its centre (see below).
 */
export function freeRegion(stage, covers, gap = 0.02) {
  const region = largestRegion(stage, covers, gap);
  if (!region) return null;
  const w = (region[2] - region[0]) * stage.width, h = (region[3] - region[1]) * stage.height;
  if (Math.min(w, h) < 0.12 * Math.min(stage.width, stage.height) || w * h < 0.08 * stage.width * stage.height) return null;
  // A full-width band above or below the cards stays a band: taller than 4:5, the geometry would run the route the
  // stage's full height, behind the cards, so the band is trimmed about its centre and the route runs across it.
  const d = 0.4 * w / stage.height, c = (region[1] + region[3]) / 2;
  return region[0] < 0.05 && region[2] > 0.95 && h > 0.8 * w ? [region[0], c - d, region[2], c + d] : region;
}
function largestRegion(stage, covers, gap) {
  if (!stage?.width || !stage?.height) return null;
  let top = 0, bot = 1; const cards = [];
  for (const r of covers) {
    if (!r?.width || !r?.height) continue;
    const b = [(r.left - stage.left) / stage.width, (r.top - stage.top) / stage.height, (r.right - stage.left) / stage.width, (r.bottom - stage.top) / stage.height].map(v => Math.max(0, Math.min(1, v)));
    if (b[2] <= b[0] || b[3] <= b[1]) continue;
    if (b[2] - b[0] > 0.97) { if (b[1] < 0.05) top = Math.max(top, b[3]); else bot = Math.min(bot, b[1]); } else cards.push(b);
  }
  if (!cards.length && top === 0 && bot === 1) return null;
  if (!cards.length) return [gap, top + gap, 1 - gap, bot - gap];
  const u = cards.reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
  const area = f => Math.max(0, (f[2] - f[0]) * stage.width) * Math.max(0, (f[3] - f[1]) * stage.height);
  return [[u[2] + gap, top + gap, 1 - gap, bot - gap], [gap, top + gap, u[0] - gap, bot - gap], [gap, u[3] + gap, 1 - gap, bot - gap], [gap, top + gap, 1 - gap, u[1] - gap]]
    .sort((a, b) => area(b) - area(a))[0];
}

const composed = new Map();
/**
 * Which drawing fits the free region. In order: the stored attempt, the other 15 attempts, then (brand only, given as
 * `compact`) the compact brand braid, then the summarised braid. Every try is the same geometry and renderer, so a
 * published descriptor is never changed. Returns { art, how } for the first try with no problems; failing all, the art
 * is drawn whole inside the region ({ art, how: 'inset', inset: true }), or square when there is no region.
 */
export function composeArt(art, { aspect = 1.6, focus = null, compact = null } = {}) {
  art = presentationArt(art);
  const key = JSON.stringify([structureKey(art), art.attempt, art.summarised, art.renderer, aspect, focus, compact && structureKey(compact)]);
  if (composed.has(key)) return composed.get(key);
  const tries = [];
  for (let c = 0; c < ART_ATTEMPTS; c++) tries.push([{ ...art, attempt: (art.attempt + c) % ART_ATTEMPTS }, c ? 'attempt' : 'stored']);
  if (compact) for (let c = 0; c < ART_ATTEMPTS; c++) tries.push([{ ...compact, attempt: (compact.attempt + c) % ART_ATTEMPTS }, 'compact']);
  if (!art.summarised) for (let c = 0; c < ART_ATTEMPTS; c++) tries.push([{ ...art, summarised: true, attempt: c }, 'summarised']);
  let out = null;
  for (const [candidate, how] of tries) {
    const scene = buildScene(candidate, { aspect, focus, validateOnly: true });
    if (scene.refused) { out = { art, how: 'refused', refused: true }; break; }
    if (!scene.problems.length) { out = { art: candidate, how, tile: scene.tileScale }; break; }
  }
  out ??= focus ? { art, how: 'inset', inset: true } : { art, how: 'square' };
  if (composed.size > 32) composed.delete(composed.keys().next().value);
  composed.set(key, out);
  return out;
}

const f1 = (n) => (Math.round(n * 10) / 10).toString();
// 'hsl(h s% l%)' (the geometry's fills) as six-digit hex, for the PDF writer.
function hslHex(c) {
  const m = /^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/.exec(String(c));
  if (!m) return 'ffffff';
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return f(0) + f(8) + f(4);
}
/**
 * Room PDFs v2 (CASE-289): a masthead's braid structure (Julian, 2026-10-18: more braids, of varied shape and scale, colours
 * may repeat). From the case's own decision count, the seed varies how many decisions the masthead draws (3–5), each one's
 * plait (one or two routes), how far it reaches before rejoining (a two-decision span arches over the next), and the odd
 * loop. A valid descriptor for the same geometry; it carries no answers and no text.
 */
export function mastheadArt(art, seed = '') {
  const r = (() => { let a = hash('masthead:' + seed + ':' + (art?.decisions?.length ?? 0)) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const n = Math.max(3, Math.min(5, (art?.decisions?.length ?? 3) + (r() < .45 ? 1 : 0))), stops = 48, gap = Math.floor(40 / n);
  const at = Array.from({ length: n }, (_, i) => 3 + i * gap + Math.floor(r() * Math.max(1, gap - 3)));
  const decisions = at.map((stop, i) => {
    const span = r() < .35 ? 2 : 1, rejoin = Math.min(stops - 1, (at[i + span] ?? stops - 2) + 1);
    return { stop, strands: Array.from({ length: 1 + (r() < .4 ? 1 : 0) }, () => ({ rejoin })), resets: r() < .12 ? 1 : 0, ends: 0 };
  });
  return { v: 1, stops, decisions, attempt: 0, summarised: false, renderer: 1 };
}

/**
 * Room PDFs v2 (CASE-289): the masthead as vector tesserae, width × height points. Julian (2026-10-18): a dark masthead on every
 * PDF, braids two to three tiles thick, varied in number, shape and scale, the petrol spine winding. The same geometry as the
 * app (buildScene) on a seeded masthead structure (mastheadArt), composed wide and cropped to the band; only layouts whose
 * spine really curves are kept, and the seed picks one. Tiles are 1.3 × the braid's grid, so a route is two tiles and the
 * spine three. `contentSeed` is the participant's name on the participant record (typed on the phone, never sent), else the
 * case title. Returns { grout, groutWidth, shapes: [{ poly, fill }] } in page units (y down), or null.
 */
const bands = new Map();
export function pdfBand(art, { width = 595, height = 150, theme = 'dark', group = 'neutral', contentSeed = '' } = {}) {
  if (!validArtDescriptor(art)) return null;
  const seed = String(contentSeed), bend = 2.6, key = [structureKey(art), art.attempt, seed, width, height, theme, groupOf(group)].join('|');
  // Once per tab for the same case, seed and size: a second Download reuses it (room PDFs v2 performance ruling).
  if (bands.has(key)) return bands.get(key);
  const opts = { theme: theme === 'light' ? 'light' : 'dark', group: groupOf(group), contentSeed: seed };
  // Bounded search: at most four masthead structures, each tried in a seed-chosen attempt order; the first layout that fits and
  // winds is drawn (a few probes on most seeds, never more than 64).
  let plan = null;
  const start = hash(seed);
  for (let v = 0; v < 4 && !plan; v++) for (const aspect of [5.3]) {
    const masthead = mastheadArt(art, `${seed}#${v}`), H = CANONICAL, W = CANONICAL * aspect;
    for (let k = 0; k < ART_ATTEMPTS && !plan; k++) {
      const c = (start + k) % ART_ATTEMPTS, candidate = { ...masthead, attempt: c }, probe = buildScene(candidate, { aspect, bend, validateOnly: true });
      if (probe.refused || probe.problems.length) continue;
      // Keep layouts whose spine runs across the band (end to end) and winds through its middle, the part the crop keeps.
      const pts = probe.bands?.[0]?.pts ?? [], xs = pts.map(([x]) => x), ys = pts.filter(([x]) => x > W * .12 && x < W * .88).map(([, y]) => y);
      const across = xs.length && Math.min(...xs) < W * .08 && Math.max(...xs) > W * .92;
      if (across && ys.length && Math.max(...ys) - Math.min(...ys) > H * .16) plan = { art: candidate, aspect, tile: probe.tileScale };
    }
  }
  if (!plan) { const p = composeArt(art, { aspect: width / height }); if (p.refused) return null; plan = { art: p.art, aspect: width / height, tile: p.tile }; }
  const scene = buildScene(plan.art, { ...opts, aspect: plan.aspect, bend, ...(plan.tile ? { tile: plan.tile * 1.3 } : {}) });
  const sc = Math.max(width / scene.width, height / scene.height), ox = (width - scene.width * sc) / 2, oy = (height - scene.height * sc) / 2;
  const r1 = (n) => Math.round(n * 10) / 10;
  const band = { grout: hslHex(scene.grout), groutWidth: r1(scene.groutWidth * sc),
    shapes: scene.shapes.map((sh) => ({ poly: sh.poly.map(([x, y]) => [r1(ox + x * sc), r1(oy + y * sc)]), fill: hslHex(sh.fill) }))
      .filter((sh) => sh.poly.some(([x, y]) => x > -2 && x < width + 2 && y > -2 && y < height + 2)) };
  if (bands.size > 8) bands.delete(bands.keys().next().value);
  bands.set(key, band);
  return band;
}
/**
 * Build decorative SVG splash art composed into the stage's free region (composeArt). The SVG covers its host
 * (`slice`); the last resort draws the art whole inside the region. Returns the <svg> element (aria-hidden, no text),
 * with data-how naming the composition.
 */
export function buildSplash(doc, art, { aspect = 1.6, focus = null, compact = null, theme = 'light', group = 'neutral', contentSeed = '' } = {}) {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  if (!validArtDescriptor(art)) { svg.setAttribute('viewBox', '0 0 1 1'); return svg; }
  const opts = { theme, group: groupOf(group), contentSeed: String(contentSeed) };
  const plan = composeArt(art, { aspect, focus, compact });
  if (plan.refused) { svg.setAttribute('viewBox', '0 0 1 1'); return svg; }
  let scene;
  if (plan.inset) {
    // The region's shape, clamped so a sliver can never ask for a scene of tens of thousands of tiles; the art is
    // contained and centred in the region (stage units: width 1, height 1 / aspect).
    const rw = focus[2] - focus[0], rh = (focus[3] - focus[1]) / aspect;
    scene = buildScene(art, { ...opts, aspect: Math.min(4, Math.max(0.25, rw / rh)) });
    const k = Math.min(rw / scene.width, rh / scene.height), vw = 1 / k, vh = 1 / aspect / k;
    const cx = (focus[0] + focus[2]) / 2, cy = (focus[1] + focus[3]) / 2 / aspect;
    svg.setAttribute('viewBox', `${f1(scene.width / 2 - cx / k)} ${f1(scene.height / 2 - cy / k)} ${f1(vw)} ${f1(vh)}`);
    svg.setAttribute('preserveAspectRatio', 'none');
  } else {
    // Tesserae grow on a stage longer than a phone's (beyond 2.4:1), so a tall or wide stage never multiplies the tile
    // count; the braid's bands and validation are unchanged (they use the geometry's own scale).
    const k = Math.sqrt(Math.max(aspect, 1 / aspect) / 2.4);
    scene = plan.how === 'square' ? buildScene(plan.art, opts) : buildScene(plan.art, { ...opts, aspect, focus, tile: k > 1 && plan.tile * k });
    svg.setAttribute('viewBox', `0 0 ${f1(scene.width)} ${f1(scene.height)}`);
  }
  svg.dataset.how = plan.how;
  svg.style.display = 'block'; svg.style.width = '100%'; svg.style.height = '100%'; svg.style.background = scene.grout;
  // The grout stroke is inherited; two groups in paint order: the ground (painted first), then the paths.
  svg.setAttribute('stroke', scene.grout); svg.setAttribute('stroke-width', f1(Math.max(0.6, scene.groutWidth))); svg.setAttribute('stroke-linejoin', 'round');
  const groups = ['g', 'p'].map(l => { const g = doc.createElementNS(SVG, 'g'); g.dataset.l = l; return g; });
  for (const sh of scene.shapes) {
    const p = doc.createElementNS(SVG, 'polygon');
    p.setAttribute('points', sh.poly.map((q) => f1(q[0]) + ',' + f1(q[1])).join(' '));
    p.setAttribute('fill', sh.fill);
    p.dataset.l = sh.l;
    p.dataset.s = sh.s.toFixed(2);
    groups[sh.l === 'g' ? 0 : 1].append(p);
  }
  svg.append(...groups);
  return svg;
}

/**
 * Mount splash art into a host element (replacing its children) with per-tessera motion (splash-motion.mjs).
 * `motion` is { intensity, arrive } or null for none; `covers()` returns the opaque elements over the art.
 * Returns { svg, motion, stop() }.
 */
export function mountSplash(host, art, { motion = null, covers = () => [], ...opts } = {}) {
  const doc = host.ownerDocument, theme = opts.theme ?? currentTheme(doc);
  const svg = buildSplash(doc, art, { ...opts, theme });
  host.replaceChildren(svg);
  const moving = motion && svg.firstChild ? startMotion(svg, { ...motion, covers, dark: theme === 'dark', doc }) : null;
  return { svg, motion: moving, stop() { moving?.stop(); } };
}
