// src/shared/mosaic-geometry.mjs: the braid geometry core (card 28, spec §6). Numbers in, polygons out.
//
// Ported from the approved study `prototypes/design/mosaic.mjs` (design system §Mosaic grammar). This
// module has no DOM and no output format: `src/client/mosaic.mjs` paints its shapes to a canvas (covers)
// or to SVG nodes (splash). The bounded layout search (`solveArt`) runs in the builder at publish and
// in tests; the Worker never imports this module (CASE-164: the search would put Worker CPU at risk).
//
// Contract (spec §6.5):
//   • Structure (the descriptor + its solved attempt) drives every polygon. The geometry seed is
//     structureKey(descriptor); geometry is computed in canonical units (420 on the short side), so a
//     layout is identical at every display size.
//   • Content seed, theme and group change fill colours only: colours draw from their own random
//     stream, so geometry never consumes a colour draw.
//   • Tile density (`tile`) changes how many tesserae fill the same shapes, never the shapes.
import { structureKey, structureOf, describeCase, withSolution, artReadiness, ART_ATTEMPTS, ART_RENDERERS } from './art-descriptor.mjs';

export const CANONICAL = 420;
// The geometry version the builder solves with. Any change to the scene this module produces (shape,
// tiling, palette) is a NEW version: bump this, add it to ART_RENDERERS, keep the old code path in
// GEOMETRY under its old number, and add a golden row (tests/mosaic-fingerprint.test.mjs).
export const RENDERER_VERSION = 1;

// ── deterministic randomness ──────────────────────────────────────────────
export function hash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
export function rng(seed) { let a = (typeof seed === 'number' ? seed : hash(String(seed))) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── palette (art pigments, not UI or status colours) ──────────────────────
// Base lightness is solved so every tessera (base ± its wobble, every plait shade) keeps at least 3:1
// against every group ground in both themes (tests/mosaic-geometry.test.mjs proves it).
export const PIGMENTS = Object.freeze({
  petrol:     { light: [190, 72, 26], dark: [189, 58, 43] },   // dark L 42 → 43: 42 fell to 2.93:1 on olive once hue and saturation wobble are counted
  coral:      { light: [9, 68, 53],   dark: [9, 70, 63] },
  ochre:      { light: [39, 70, 35],  dark: [40, 66, 52] },
  periwinkle: { light: [233, 46, 59], dark: [233, 52, 68] },
});
// Curated group tints (Julian, 2026-10-06: never a free picker). Ground hue only; neutral is the default.
export const GROUPS = Object.freeze({
  petrol: { h: 186, s: 18 }, sage: { h: 150, s: 16 }, olive: { h: 72, s: 20 },
  ochre: { h: 40, s: 26 }, coral: { h: 12, s: 26 }, rose: { h: 345, s: 20 },
  plum: { h: 290, s: 14 }, periwinkle: { h: 232, s: 22 }, sky: { h: 205, s: 24 },
  neutral: { h: 200, s: 6 },
});
export const THEME = Object.freeze({
  light: { groundL: 94, groundVar: 1.6, outlineDL: -4, grout: 'hsl(180 10% 98%)' },
  dark:  { groundL: 17, groundVar: 2.0, outlineDL: 3.5, grout: 'hsl(200 22% 8%)' },
});
const TONES = ['coral', 'ochre', 'periwinkle'];
export const ROW_SHADES = Object.freeze([0, 11, 20, 6]);
export const TALLY_SHADE = 20;
// Per-tile wobble half-ranges (hue, saturation, lightness) for paths and grounds.
export const WOBBLE = Object.freeze({ path: [2.5, 3, 2.5], ground: [3, 2] });

export function hsl(h, s, l) { return 'hsl(' + h.toFixed(1) + ' ' + s.toFixed(1) + '% ' + Math.max(0, Math.min(100, l)).toFixed(1) + '%)'; }

// ── geometry helpers ──────────────────────────────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const perp = (a) => [-a[1], a[0]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const rot = (v, ang) => [v[0] * Math.cos(ang) - v[1] * Math.sin(ang), v[0] * Math.sin(ang) + v[1] * Math.cos(ang)];

function bezier(p0, p1, p2, p3) {
  return function (t) { const u = 1 - t; return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]; };
}
// Arc-length parameterised curve: at(s) -> {p, t (tangent), n (normal)}
function arc(f, samples) {
  const n = samples || 400, pts = [], cum = [0];
  for (let i = 0; i <= n; i++) pts.push(f(i / n));
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  const L = cum[n];
  function at(s) {
    s = Math.max(0, Math.min(L, s));
    let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1, k = (s - cum[lo]) / seg;
    const p = add(pts[lo], mul(sub(pts[hi], pts[lo]), k));
    const i0 = Math.max(0, lo - 1), i1 = Math.min(n, hi + 1);
    const t = norm(sub(pts[i1], pts[i0]));
    return { p, t, n: perp(t) };
  }
  return { at, L, pts };
}

export const COMPASS = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
function anchor(dir, W, H, push) {
  const fx = { N: .5, NE: 1, E: 1, SE: 1, S: .5, SW: 0, W: 0, NW: 0 }[dir];
  const fy = { N: 0, NE: 0, E: .5, SE: 1, S: 1, SW: 1, W: .5, NW: 0 }[dir];
  const edge = [fx * W, fy * H], c = [W / 2, H / 2];
  return add(edge, mul(norm(sub(edge, c)), push));
}

// ── tiling a band ─────────────────────────────────────────────────────────
function tileBand(curve, s0, s1, offsets, tileLen, r, opts) {
  const tiles = [];
  const rows = offsets.length - 1;
  const startCap = opts && opts.startCap, endCap = opts && opts.endCap;
  for (let k = 0; k < rows; k++) {
    const oA = offsets[k], oB = offsets[k + 1];
    const phase = (k % 2 ? 0.5 : 0) + (r() - 0.5) * 0.25;
    const bps = [s0];
    let s = s0 + tileLen * (phase > 0.05 ? phase : 1);
    while (s < s1 - tileLen * 0.4) { bps.push(s); s += tileLen * (0.86 + r() * 0.28); }
    bps.push(s1);
    const jit = bps.map((b, i) => (i === 0 || i === bps.length - 1) ? [0, 0] : [(r() - .5) * tileLen * .22, (r() - .5) * tileLen * .22]);
    const P = (sv, o, which) => {
      if (which === 'start' && startCap) return startCap(o);
      if (which === 'end' && endCap) return endCap(o);
      const a = curve.at(sv); return add(a.p, mul(a.n, o));
    };
    for (let i = 0; i < bps.length - 1; i++) {
      const a = bps[i], b = bps[i + 1];
      const w0 = i === 0 ? 'start' : null, w1 = i + 1 === bps.length - 1 ? 'end' : null;
      const poly = [P(a + jit[i][0], oA, w0), P(b + jit[i + 1][0], oA, w1), P(b + jit[i + 1][1], oB, w1), P(a + jit[i][1], oB, w0)];
      tiles.push({ poly, s: (a - s0) / ((s1 - s0) || 1), row: k });
    }
  }
  return tiles;
}
function rowOffsets(width, rows, r) {
  const o = []; for (let k = 0; k <= rows; k++) o.push(-width / 2 + (width * k) / rows + ((k > 0 && k < rows) ? (r() - .5) * width / rows * .12 : 0));
  return o;
}
// Project lateral offset o of a branch cross-section onto the spine's edge line: the shared seam at joins.
function seam(q0, nb, tb, m, tm) {
  return function (o) {
    const q = add(q0, mul(nb, o));
    const den = cross(tb, tm); if (Math.abs(den) < 1e-6) return q;
    const lam = -cross(sub(q, m), tm) / den;
    return add(q, mul(tb, lam));
  };
}
function centroid(poly) { let x = 0, y = 0; for (const p of poly) { x += p[0]; y += p[1]; } return [x / poly.length, y / poly.length]; }
function nearest(p, pts) {
  let best = Infinity, cap = false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], ab = sub(b, a), raw = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / ((ab[0] * ab[0] + ab[1] * ab[1]) || 1), t = Math.max(0, Math.min(1, raw));
    const d = len(sub(p, add(a, mul(ab, t))));
    if (d < best) { best = d; cap = (i === 1 && raw < 0) || (i === pts.length - 1 && raw > 1); }
  }
  return { d: best, cap };
}
export function distToPolyline(p, pts) { return nearest(p, pts).d; }

// Threshold queries through a uniform grid of segment bounding boxes. `within(p, pts, maxD)` returns
// exactly what `nearest(p, pts)` returns whenever the true distance is at most maxD (the grid cell is
// maxD, so every segment that close is in the 3 × 3 cells around p, and candidates are scanned in
// segment order so ties and the end-cap flag resolve as in the full scan). Beyond maxD it reports
// Infinity. Every caller compares against that same threshold, so results are identical to the full
// scan; only the cost changes (the ground field and band clearance dominated a cover's render time).
const GRIDS = new WeakMap();
function gridFor(pts, cell) {
  let byCell = GRIDS.get(pts);
  if (!byCell) GRIDS.set(pts, byCell = new Map());
  let grid = byCell.get(cell);
  if (grid) return grid;
  grid = new Map();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = (x + 4096) * 8192 + (y + 4096);
      const list = grid.get(key);
      if (list) { if (list[list.length - 1] !== i) list.push(i); } else grid.set(key, [i]);
    }
  }
  byCell.set(cell, grid);
  return grid;
}
function within(p, pts, maxD) {
  if (!(maxD > 0) || pts.length < 2) return nearest(p, pts);
  const grid = gridFor(pts, maxD);
  const cx = Math.floor(p[0] / maxD), cy = Math.floor(p[1] / maxD);
  const found = [];
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
    const list = grid.get((x + 4096) * 8192 + (y + 4096));
    if (list) for (const i of list) found.push(i);
  }
  if (!found.length) return { d: Infinity, cap: false };
  found.sort((a, b) => a - b);
  let best = Infinity, cap = false, last = -1;
  for (const i of found) {
    if (i === last) continue;
    last = i;
    const a = pts[i - 1], b = pts[i], ab = sub(b, a), raw = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / ((ab[0] * ab[0] + ab[1] * ab[1]) || 1), t = Math.max(0, Math.min(1, raw));
    const d = len(sub(p, add(a, mul(ab, t))));
    if (d < best) { best = d; cap = (i === 1 && raw < 0) || (i === pts.length - 1 && raw > 1); }
  }
  return best <= maxD ? { d: best, cap } : { d: Infinity, cap: false };
}

// ── layout: the spine ─────────────────────────────────────────────────────
function layout(structure, seed, W, H, T, focus, bendK = 1) {
  const r = rng('layout:' + seed);
  const min = Math.min(W, H);
  let ei = structure.entry ? COMPASS.indexOf(structure.entry) : Math.floor(r() * 8);
  let xi = (ei + 4) % 8;
  const push = T * 6;
  let E = anchor(COMPASS[ei], W, H, push), X = anchor(COMPASS[xi], W, H, push);
  // Splash art: the spine runs along the long axis of the free (focus) region, through its centre.
  if (focus) {
    const fx = (focus[0] + focus[2]) / 2, fy = (focus[1] + focus[3]) / 2, tall = (focus[3] - focus[1]) >= (focus[2] - focus[0]);
    const flipDir = r() < 0.5;
    if (tall) { E = [fx + (r() - .5) * (focus[2] - focus[0]) * 0.3, flipDir ? -push : H + push]; X = [fx + (r() - .5) * (focus[2] - focus[0]) * 0.3, flipDir ? H + push : -push]; ei = flipDir ? 0 : 4; xi = (ei + 4) % 8; }
    else { E = [flipDir ? -push : W + push, fy + (r() - .5) * (focus[3] - focus[1]) * 0.3]; X = [flipDir ? W + push : -push, fy + (r() - .5) * (focus[3] - focus[1]) * 0.3]; ei = flipDir ? 6 : 2; xi = (ei + 4) % 8; }
  }
  const d = sub(X, E), nrm = perp(norm(d));
  // `bendK` (opts.bend, default 1) lets a wide PDF masthead's spine wind more (CASE-289); every other caller is unchanged.
  const bend = (r() - .5) * 0.6 * min * 0.32 * bendK;
  const sAlt = r() < .5;
  const C1 = add(add(E, mul(d, .3)), mul(nrm, bend));
  const C2 = add(add(E, mul(d, .7)), mul(nrm, sAlt ? -bend * .8 : bend * .6));
  const main = arc(bezier(E, C1, C2, X));
  const box = focus || [0, 0, W, H];
  const inside = (p, m) => p[0] >= box[0] + m && p[0] <= box[2] - m && p[1] >= box[1] + m && p[1] <= box[3] - m;
  let v0 = null, v1 = null;
  for (let s = 0; s <= main.L; s += T / 2) { if (inside(main.at(s).p, T * 3)) { if (v0 == null) v0 = s; v1 = s; } }
  if (v0 == null) { v0 = main.L * .3; v1 = main.L * .7; }
  return { main, entry: COMPASS[ei], exit: COMPASS[xi], vis: [v0, v1] };
}

// ── descriptor → braid structure ──────────────────────────────────────────
// Decisions sit along the spine in authored order; each decision's strands form one plaited lens per
// rejoin stop (a row per route), resets become small loops (or blunt notches), dead ends stay blunt
// branches. Sides alternate decision by decision; routes that skip decisions arch over them.
function fromDescriptor(desc, seed, variant) {
  const r = rng('braid:' + seed);
  const decs = desc.decisions || [];
  const d = Math.max(1, decs.length);
  const unit = 0.8 / d;
  const q = (i) => 0.1 + unit * i;
  const posOfStop = (j) => { const k = decs.findIndex((x) => x.stop >= j); return k < 0 ? 0.92 : q(k); };
  const branches = [];
  const flip = r() < 0.5 ? 1 : -1;
  const items = [];
  decs.forEach((dd, di) => {
    const s0 = (di % 2 ? -1 : 1) * flip, at = q(di), tone = TONES[di % 3];
    const byStop = new Map(); for (const st of dd.strands || []) byStop.set(st.rejoin, (byStop.get(st.rejoin) || 0) + 1);
    const strands = [...byStop].sort((x, y) => y[0] - x[0]).map(([rejoin, n]) => ({ rejoin, n }));
    let tally = dd.hidden || 0;
    const take = () => { const t = tally; tally = 0; return t; };
    strands.forEach((st, k) => items.push({ kind: 'rejoin', tone, di, side: variant % 2 === 1 ? s0 : (k % 2 ? -s0 : s0), a: at, b: posOfStop(st.rejoin), routes: st.n, tally: take() }));
    const lighter = () => { if (variant % 2 === 1) return -s0; const n1 = items.filter((x) => x.a === at && x.side === 1).length, n2 = items.filter((x) => x.a === at && x.side === -1).length; return n1 <= n2 ? 1 : -1; };
    for (let k = 0; k < (dd.resets || 0); k++) items.push({ kind: variant >= 2 ? 'notch' : 'loop', tone, di, side: lighter(), a: at, b: at + unit * 0.45, tally: take() });
    for (let k = 0; k < (dd.ends || 0); k++) items.push({ kind: 'end', tone, di, side: lighter(), a: at, b: at + unit * 0.5, tally: take() });
  });
  // Global layering per side: a strand's height is one more than the tallest strand inside its span.
  const overlaps = (x, y) => x.a < y.b - 1e-6 && y.a < x.b - 1e-6;
  const bySpan = items.slice().sort((x, y) => (x.b - x.a) - (y.b - y.a));
  for (const it of bySpan) {
    it.height = 0;
    for (const o of bySpan) { if (o === it || o.side !== it.side || o.height == null || (o.b - o.a) > (it.b - it.a)) continue; if (overlaps(o, it)) it.height = Math.max(it.height, o.height + 1); }
  }
  // Items sharing a departure or a landing are inset by a strand width, the taller one outermost.
  for (const it of items) {
    const sameStart = items.filter((o) => o !== it && o.side === it.side && Math.abs(o.a - it.a) < 1e-6 && o.height > it.height).length;
    const sameEnd = items.filter((o) => o !== it && o.side === it.side && Math.abs(o.b - it.b) < 1e-6 && o.height > it.height).length;
    const touchA = items.some((o) => o !== it && o.side === it.side && Math.abs(o.b - it.a) < 1e-6);
    const touchB = items.some((o) => o !== it && o.side === it.side && Math.abs(o.a - it.b) < 1e-6);
    const a = it.a + unit * (touchA ? 0.17 : 0.06) + unit * 0.22 * sameStart, b = it.b - unit * (touchB ? 0.17 : 0.06) - unit * 0.22 * sameEnd;
    const base = { tone: it.tone, di: it.di, tally: it.tally || 0, side: it.side };
    if (it.kind === 'rejoin') branches.push({ ...base, kind: 'rejoin', at: a, to: b, level: it.height, routes: it.routes || 1, routeTones: Array.from({ length: it.routes || 1 }, (_, k) => it.tone + ':' + ROW_SHADES[k % 4]) });
    else if (it.kind === 'loop') branches.push({ ...base, kind: 'loop', at: a + unit * 0.2, level: it.height, back: unit * 0.22 });
    else if (it.kind === 'notch') branches.push({ ...base, kind: 'end', at: a + unit * 0.15, reach: 0.11 });
    else branches.push({ ...base, kind: 'end', at: a + 0.005, reach: 0.2 });
  }
  branches.sort((x, y) => (x.level || 0) - (y.level || 0));
  const lanes = decs.reduce((n, x) => n + (x.strands || []).length + (x.resets || 0) + (x.ends || 0), 0);
  const across = Math.min(56, Math.max(26, 22 + 2.4 * lanes));
  return { branches, across, grammar: (variant % 2 ? 'over-under' : 'split') + (variant >= 2 ? '+notch' : '+loop') + '+plait' };
}

/** Over capacity: one representative route per decision, the rest counted as tally tesserae. */
export function summarisedStructure(desc) {
  return { ...structureOf(desc), decisions: desc.decisions.map((d) => {
    const routes = d.strands.length + d.resets + d.ends;
    const keep = d.strands.length ? { strands: [{ rejoin: Math.min(...d.strands.map((x) => x.rejoin)) }], resets: 0, ends: 0 }
      : d.resets ? { strands: [], resets: 1, ends: 0 } : d.ends ? { strands: [], resets: 0, ends: 1 } : { strands: [], resets: 0, ends: 0 };
    return { stop: d.stop, ...keep, hidden: Math.max(0, routes - 1) };
  }) };
}

// ── one deterministic layout attempt ──────────────────────────────────────
/*
 * opts: { aspect (W/H, default 1), tile (canonical units, default the geometry scale), theme, group,
 *         contentSeed, focus ([x0,y0,x1,y1] fractions), validateOnly }
 * Returns { shapes, bands, problems, grout, groutWidth, width, height, entry, exit, grammar }.
 */
function attemptScene(desc, attempt, opts, summary) {
  const aspect = opts.aspect > 0 ? opts.aspect : 1;
  const W = aspect >= 1 ? CANONICAL * aspect : CANONICAL, H = aspect >= 1 ? CANONICAL : CANONICAL / aspect;
  const tmode = opts.theme === 'dark' ? 'dark' : 'light';
  const theme = THEME[tmode];
  const seed = structureKey(desc);
  const structure = fromDescriptor(desc, seed, attempt % 4);
  const thin = summary || attempt >= ART_ATTEMPTS / 2;   // the second half of the budget lays one tile per route
  const Tg = Math.min(W, H) / structure.across;
  const T = opts.tile > 0 ? opts.tile : Tg;
  const cr = rng('content:' + (opts.contentSeed || '') + ':' + seed);   // colour only
  const gr = rng('geom:' + seed);                                       // geometry only
  const focus = opts.focus ? [opts.focus[0] * W, opts.focus[1] * H, opts.focus[2] * W, opts.focus[3] * H] : null;
  const L = layout(structure, attempt ? seed + ':' + attempt : seed, W, H, Tg, focus, opts.bend > 0 ? opts.bend : 1);
  const mainW = Tg * 4, brW = Tg * (thin ? 1 : 2), outline = Tg * 0.95, outlineRow = Math.max(outline, T * 0.9);
  const group = GROUPS[opts.group] || GROUPS.neutral;
  const groundL = theme.groundL;
  const gs = tmode === 'dark' ? group.s * 0.55 : group.s;
  const ground = () => hsl(group.h + (cr() - .5) * 2 * WOBBLE.ground[0], gs + (cr() - .5) * 2 * WOBBLE.ground[1], groundL + (cr() - .5) * 2 * theme.groundVar);
  const outlineFill = () => hsl(group.h + (cr() - .5) * 4, gs + 4, groundL + theme.outlineDL + (cr() - .5) * 1.5);
  // 'coral:11' = the coral pigment moved 11 lightness points AWAY from the ground (3:1 kept on every tint).
  const pig = (spec) => { const [name, dl] = String(spec).split(':'); const p = PIGMENTS[name][tmode]; const dd = Math.abs(Number(dl || 0)) * (tmode === 'light' ? -1 : 1); return () => hsl(p[0] + (cr() - .5) * 2 * WOBBLE.path[0], p[1] + (cr() - .5) * 2 * WOBBLE.path[1], p[2] + dd + (cr() - .5) * 2 * WOBBLE.path[2]); };

  const bands = [{ curve: L.main, s0: 0, s1: L.main.L, width: mainW, kind: 'main' }];
  const problems = [];
  const [v0, v1] = L.vis, vlen = v1 - v0;
  structure.branches.forEach((b, bi) => {
    const tone = b.tone;
    const sAt = v0 + vlen * b.at;
    const a = L.main.at(sAt), side = b.side || 1;
    const edgeOff = side * mainW / 2;
    const root = add(a.p, mul(a.n, edgeOff));
    const ang = side * (0.62 + gr() * 0.25);
    const dir0 = rot(a.t, ang);
    if (b.kind === 'rejoin' || b.kind === 'loop') {
      // A single route is two tiles wide (one when dense); a plait gives each route one tile, in its own shade.
      const routeRows = thin || (b.routes || 1) > 1 ? 1 : 2;
      const bw = b.routes ? Tg * b.routes * routeRows : brW;
      const rowTonesB = b.routeTones ? b.routeTones.flatMap((t) => Array(routeRows).fill(t)) : undefined;
      const toS = b.kind === 'loop' ? sAt - vlen * (b.back || 0.05) : v0 + vlen * b.to;
      const bt = L.main.at(toS);
      const end = add(bt.p, mul(bt.n, edgeOff));
      const level = b.level || 0;
      let chosenC = null, why = '';
      for (const k of [1, 1.15, 1.3, 0.92, 1.5]) {
        const nside = mul(a.n, side);
        const fwd = b.kind === 'loop' ? a.t : norm(sub(bt.p, a.p));
        const span = len(sub(end, root));
        const apex = (mainW / 2 + bw / 2 + outline + Tg * 0.2 + level * (bw + outline * 1.3)) * k;
        const h = apex / 0.75;
        const kk = b.kind === 'loop' ? apex * 0.18 : span * 0.24;
        const p1 = add(add(root, mul(fwd, kk)), mul(nside, h));
        const p2 = add(sub(end, mul(fwd, kk)), mul(nside, h));
        const c = arc(bezier(root, p1, p2, end), 200);
        let ok = true; const margin = Tg * 0.8;
        const clearOfMain = mainW / 2 + bw / 2 + outline * 0.9;
        // A band cannot bend tighter than half its width without folding over itself.
        for (let qq = Tg; qq <= c.L - Tg && ok; qq += Tg / 2) {
          const t0 = c.at(qq - Tg / 2).t, t1 = c.at(qq + Tg / 2).t;
          const turn = Math.acos(Math.max(-1, Math.min(1, t0[0] * t1[0] + t0[1] * t1[1])));
          if (turn > 1e-6 && Tg / turn < bw / 2 + Tg * 0.25) { ok = false; why = 'bend'; }
        }
        for (let qq = bw * 1.6; qq <= c.L - bw * 1.6 && ok; qq += Tg / 2) {
          const at = c.at(qq);
          for (const o of [-bw / 2, bw / 2]) { const pp = add(at.p, mul(at.n, o)); if (pp[0] < margin || pp[1] < margin || pp[0] > W - margin || pp[1] > H - margin) { ok = false; why = 'frame'; } }
          const dMain = within(at.p, L.main.pts, clearOfMain).d;
          if (qq > c.L * 0.3 && qq < c.L * 0.7 && dMain < clearOfMain) { ok = false; why = 'main'; }
          if (dMain < clearOfMain) continue;
          for (const other of bands) if (other.kind !== 'main' && other.mid && other.mid.length > 1 && within(at.p, other.mid, bw + Tg * 0.35).d < bw + Tg * 0.35) { ok = false; why = 'sibling'; }
        }
        if (ok) { chosenC = c; break; }
      }
      if (!chosenC) { problems.push('strand ' + (bi + 1) + ' (' + why + ')'); return; }
      const c = chosenC;
      const mid = c.pts.filter((pt) => within(pt, L.main.pts, mainW / 2 + bw * 1.2).d > mainW / 2 + bw * 1.2);
      bands.push({ curve: c, mid, s0: 0, s1: c.L, width: bw, kind: b.kind, tone, di: b.di, tally: b.tally || 0, rowTones: rowTonesB,
        startSeam: seam(root, c.at(0).n, c.at(0).t, add(a.p, mul(a.n, edgeOff)), a.t),
        endSeam: seam(end, c.at(c.L).n, c.at(c.L).t, add(bt.p, mul(bt.n, edgeOff)), bt.t) });
      return;
    }
    // A blunt end: search deterministic candidates inside the safe margin.
    const margin = Tg * 2.2;
    let chosen = null;
    for (let tries = 0; tries < 48 && !chosen; tries++) {
      const reach = Math.min(W, H) * ((b.reach || .32) * Math.max(0.35, 1 - tries * .02));
      const turn = side * (0.15 + gr() * 0.5) * (tries % 2 ? -1 : 1) * 0.6 + side * 0.35;
      const dirE = rot(dir0, turn);
      const end = add(add(root, mul(dir0, reach * .55)), mul(dirE, reach * .55));
      const c = arc(bezier(root, add(root, mul(dir0, reach * .45)), sub(end, mul(dirE, reach * .35)), end), 160);
      let ok = true;
      for (let s = 0; s <= c.L && ok; s += Tg / 2) {
        const qp = c.at(s);
        for (const o of [-brW / 2, brW / 2]) { const p = add(qp.p, mul(qp.n, o)); if (p[0] < margin || p[1] < margin || p[0] > W - margin || p[1] > H - margin) ok = false; }
        if (s > mainW && within(qp.p, L.main.pts, mainW / 2 + brW / 2 + outline * 1.2).d < mainW / 2 + brW / 2 + outline * 1.2) ok = false;
        for (const other of bands) if (other.kind !== 'main' && s > brW * 1.5 && within(qp.p, other.curve.pts, brW + outline * 1.5).d < brW + outline * 1.5) ok = false;
      }
      if (focus && ok) { const e = c.at(c.L).p; if (e[0] < focus[0] || e[0] > focus[2] || e[1] < focus[1] || e[1] > focus[3]) ok = false; }
      if (ok) chosen = c;
    }
    if (!chosen) { problems.push('end ' + (bi + 1)); return; }
    bands.push({ curve: chosen, mid: chosen.pts.filter((pt) => within(pt, L.main.pts, mainW / 2 + brW * 1.2).d > mainW / 2 + brW * 1.2), s0: 0, s1: chosen.L, width: brW, kind: 'end', tone, di: b.di, tally: b.tally || 0,
      startSeam: seam(root, chosen.at(0).n, chosen.at(0).t, add(a.p, mul(a.n, edgeOff)), a.t) });
  });
  const base = { problems, grout: theme.grout, width: W, height: H, entry: L.entry, exit: L.exit, grammar: structure.grammar, tileScale: Tg };
  const bandInfo = bands.map((b) => ({ kind: b.kind, width: b.width, di: b.di ?? null, pts: b.curve.pts, mid: b.mid || null }));
  if (opts.validateOnly) return { ...base, bands: bandInfo, shapes: [], groutWidth: 0 };

  const shapes = [];
  // Ground field: jittered grid with shared vertices; tiles beside a band (not beyond its ends) are lifted.
  const g = T * 1.12, cols = Math.ceil(W / g) + 2, rws = Math.ceil(H / g) + 2;
  const gp = [];
  for (let j = 0; j < rws; j++) { gp.push([]); for (let i = 0; i < cols; i++) gp[j].push([(i - .5) * g + (gr() - .5) * g * .26, (j - .5) * g + (gr() - .5) * g * .26]); }
  for (let j = 0; j < rws - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const poly = [gp[j][i], gp[j][i + 1], gp[j + 1][i + 1], gp[j + 1][i]];
    const c = centroid(poly);
    let covered = false;
    for (const b of bands) { const qn = within(c, b.curve.pts, b.width / 2 + outline * 0.45); if (!qn.cap && qn.d < b.width / 2 + outline * 0.45) { covered = true; break; } }
    if (!covered) shapes.push({ poly, fill: ground(), layer: 0, l: 'g', s: 0 });
  }
  const paintBand = (b, layer) => {
    const fill = b.kind === 'main' ? pig('petrol') : pig(b.tone);
    const rows = b.rowTones ? b.rowTones.length : Math.max(1, Math.round(b.width / T));
    const rowFill = b.rowTones ? b.rowTones.map((t) => pig(t)) : null;
    const tiles = tileBand(b.curve, b.s0, b.s1, rowOffsets(b.width, rows, gr), T * 1.04, gr, { startCap: b.startSeam, endCap: b.endSeam });
    for (const t of tiles) shapes.push({ poly: t.poly, fill: rowFill ? rowFill[t.row]() : fill(), layer, l: b.kind === 'main' ? 'm' : 'b', s: t.s });
    // Tally tesserae (summarised covers, Julian 2026-10-06): one tile per route not drawn, in the
    // decision's darkest shade, stacked outward from the arch's apex. Counts stay truthful; no text.
    if (b.tally) {
      const m = b.curve.at(b.curve.L / 2);
      const away = distToPolyline(add(m.p, m.n), bands[0].curve.pts) > distToPolyline(sub(m.p, m.n), bands[0].curve.pts) ? 1 : -1;
      const size = Tg * 0.9, step = Tg * 1.15, tf = pig(b.tone + ':' + TALLY_SHADE);
      for (let k = 0; k < b.tally; k++) {
        const along = (k - (b.tally - 1) / 2) * step;
        const c0 = add(add(m.p, mul(m.t, along)), mul(m.n, away * (b.width / 2 + outline * 0.6 + size / 2)));
        const hx = mul(m.t, size / 2), hy = mul(m.n, size / 2);
        shapes.push({ poly: [sub(sub(c0, hx), hy), sub(add(c0, hx), hy), add(add(c0, hx), hy), add(sub(c0, hx), hy)], fill: tf(), layer: layer + 0.1, l: 'b', s: 0.5, tally: b.di });
      }
    }
  };
  const outlineRows = (b, layer) => {
    for (const side of [-1, 1]) {
      const o0 = side * b.width / 2, o1 = side * (b.width / 2 + outlineRow);
      const tiles = tileBand(b.curve, b.s0, b.s1, side < 0 ? [o1, o0] : [o0, o1], T * 1.1, gr);
      for (const t of tiles) shapes.push({ poly: t.poly, fill: outlineFill(), layer, l: 'o', s: t.s });
    }
  };
  bands.forEach((b) => outlineRows(b, 2));
  bands.filter((b) => b.kind !== 'main').forEach((b) => paintBand(b, 3));
  paintBand(bands[0], 4);
  shapes.sort((a, b) => a.layer - b.layer);
  return { ...base, bands: bandInfo, shapes, groutWidth: Math.max(0.6, T * 0.16) };
}

/**
 * The bounded layout search (builder only, once per publish). Tries ART_ATTEMPTS deterministic layouts
 * of the full braid; over capacity, the same budget on the summarised structure. Never run in the Worker.
 * @returns {{ attempt: number, summarised: boolean, unavailable: boolean }}
 */
export function solveArt(desc) {
  const s = structureOf(desc);
  for (let c = 0; c < ART_ATTEMPTS; c++) if (!attemptScene(s, c, { validateOnly: true }, false).problems.length) return { attempt: c, summarised: false, unavailable: false, renderer: RENDERER_VERSION };
  const capped = summarisedStructure(s);
  let best = 0, fewest = Infinity;
  for (let c = 0; c < ART_ATTEMPTS; c++) {
    const n = attemptScene(capped, c, { validateOnly: true }, true).problems.length;
    if (!n) return { attempt: c, summarised: true, unavailable: false, renderer: RENDERER_VERSION };
    if (n < fewest) { fewest = n; best = c; }
  }
  // Beyond the measured capacity (more than 14 × 3): the closest summarised layout, flagged for readiness.
  return { attempt: best, summarised: true, unavailable: true, renderer: RENDERER_VERSION };
}

/**
 * Geometry for a stored descriptor (with its attempt and summarised flag): one attempt, no search.
 * Coordinates are canonical units (CANONICAL on the short side); painters scale them.
 */
const GEOMETRY = Object.freeze({ 1: attemptScene });

export function buildScene(art, opts = {}) {
  const geometry = ART_RENDERERS.includes(art.renderer) ? GEOMETRY[art.renderer] : null;
  // An unknown renderer is refused explicitly: never re-solved, never redrawn with the current geometry.
  if (!geometry) return { refused: true, problems: ['unknown_renderer'], shapes: [], bands: [], width: CANONICAL, height: CANONICAL, grout: THEME[opts.theme === 'dark' ? 'dark' : 'light'].grout, groutWidth: 0 };
  const summary = Boolean(art.summarised);
  const structure = summary ? summarisedStructure(art) : structureOf(art);
  return geometry(structure, art.attempt, opts, summary);
}

/**
 * Builder publish step: derive the descriptor, solve its layout once, and report readiness. A
 * summarised cover warns and never blocks publishing (card 28).
 * @returns {{ art: object, readiness: {code:string, at:string, message:string, blocking:false}[] }}
 */
export function prepareArt(document) {
  const desc = describeCase(document);
  const { attempt, summarised, unavailable, renderer } = solveArt(desc);
  const art = withSolution(desc, { attempt, summarised, renderer });
  return { art, readiness: artReadiness(art, { unavailable }) };
}
