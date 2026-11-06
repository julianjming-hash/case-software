/* prototypes/design/mosaic.mjs — Case mosaic STUDY renderer (design artifact, not production).
 *
 * One shared source for every mosaic in prototypes/design-system.html and prototypes/surface-design.html.
 * It renders a SYNTHETIC structure descriptor (entry/exit compass points + branches with "end" or
 * "rejoin" kinds) into an opaque tessellated SVG string. It does not read authored case graphs,
 * normalise or hash case documents, or produce sanitised production renditions: those belong to the
 * future renderer specified in docs/research/2026-10-06-surface-design-spec.md §3.
 *
 * Grammar (the rules the design system documents):
 *   - Ground: a quiet tessellated field in the primary-group tint (opus tessellatum).
 *   - Paths: rows of near-square tesserae laid along the curve (opus vermiculatum). Width = more rows,
 *     never bigger tiles. Main = 4 rows petrol; branches = 2 rows coral / ochre / periwinkle.
 *   - Outline row: one row of ground-tone tiles hugs every path, as in laid mosaics.
 *   - Joins: a branch's first (or last, for a rejoin) cross-section is projected onto the main band's
 *     edge, so the two share one grout line. No overlap ribbons, no translucency.
 *   - Crossings that are not joins pass UNDER the main band and are interrupted by its outline row,
 *     so a crossing never reads as a join.
 *   - Main enters and exits beyond the frame; branch "end"s are blunt cuts inside a safe margin.
 *   - Theme changes colours only. Geometry depends on (structure, seed, canvas), never on theme or
 *     content seed. contentSeed varies shade only (gentle evolution on text edits).
 *
 * Classic script (works from file://). Browser: window.CaseMosaic. Node: module.exports.
 */
(function (root) {
  'use strict';

  // ── deterministic randomness ──────────────────────────────────────────────
  function hash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  function rng(seed) { let a = (typeof seed === 'number' ? seed : hash(String(seed))) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ── palette (art pigments, not UI or status colours) ──────────────────────
  // Hue/sat/lightness so per-tile variation is a lightness wobble around a fixed identity.
  // Base lightness is solved so every tessera (base ± its 3.5-point wobble) keeps at least 3:1 against every
  // group ground in both themes: structure stays legible at thumbnail size. Verified in design-system.html.
  const PIGMENTS = {
    petrol:     { light: [190, 72, 26], dark: [189, 58, 42] },
    coral:      { light: [9, 68, 53],   dark: [9, 70, 63] },
    ochre:      { light: [39, 70, 35],  dark: [40, 66, 52] },
    periwinkle: { light: [233, 46, 59], dark: [233, 52, 68] },
  };
  // Curated group tints (Julian, 2026-10-06: a larger curated set, never a free picker). Ground hue only;
  // lightness comes from the theme, so every tint passes the same 3:1 path check.
  const GROUPS = {
    petrol: { h: 186, s: 18, name: 'Petrol' }, sage: { h: 150, s: 16, name: 'Sage' }, olive: { h: 72, s: 20, name: 'Olive' },
    ochre: { h: 40, s: 26, name: 'Ochre' }, coral: { h: 12, s: 26, name: 'Coral' }, rose: { h: 345, s: 20, name: 'Rose' },
    plum: { h: 290, s: 14, name: 'Plum' }, periwinkle: { h: 232, s: 22, name: 'Periwinkle' }, sky: { h: 205, s: 24, name: 'Sky' },
    neutral: { h: 200, s: 6, name: 'Neutral' },
  };
  const THEME = {
    light: { groundL: 94, groundVar: 1.6, outlineDL: -4, grout: 'hsl(180 10% 98%)' },
    dark:  { groundL: 17,   groundVar: 2.0, outlineDL: 3.5,  grout: 'hsl(200 22% 8%)' },
  };
  const TONES = ['coral', 'ochre', 'periwinkle'];

  function hsl(h, s, l) { return 'hsl(' + h.toFixed(1) + ' ' + s.toFixed(1) + '% ' + Math.max(0, Math.min(100, l)).toFixed(1) + '%)'; }

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

  // ── compass anchors (8 directions) for any aspect ─────────────────────────
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function anchor(dir, W, H, push) {
    const fx = { N: .5, NE: 1, E: 1, SE: 1, S: .5, SW: 0, W: 0, NW: 0 }[dir];
    const fy = { N: 0, NE: 0, E: .5, SE: 1, S: 1, SW: 1, W: .5, NW: 0 }[dir];
    const edge = [fx * W, fy * H], c = [W / 2, H / 2];
    return add(edge, mul(norm(sub(edge, c)), push));
  }

  // ── tiling a band ─────────────────────────────────────────────────────────
  // offsets: lateral row boundaries (length rows+1). Breakpoints are shared within a row, so adjacent
  // tiles in a row share an edge exactly; each breakpoint carries an inner/outer jitter (trapezoids).
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
      const P = (sv, o, which, i) => {
        if (which === 'start' && startCap) return startCap(o);
        if (which === 'end' && endCap) return endCap(o);
        const a = curve.at(sv); return add(a.p, mul(a.n, o));
      };
      for (let i = 0; i < bps.length - 1; i++) {
        const a = bps[i], b = bps[i + 1];
        const w0 = i === 0 ? 'start' : null, w1 = i + 1 === bps.length - 1 ? 'end' : null;
        const poly = [
          P(a + jit[i][0], oA, w0, i), P(b + jit[i + 1][0], oA, w1, i + 1),
          P(b + jit[i + 1][1], oB, w1, i + 1), P(a + jit[i][1], oB, w0, i),
        ];
        poly.s = (a - s0) / ((s1 - s0) || 1);   // position along the path, for motion ordering only
        poly.row = k;
        tiles.push(poly);
      }
    }
    return tiles;
  }
  function rowOffsets(width, rows, r) {
    const o = []; for (let k = 0; k <= rows; k++) o.push(-width / 2 + (width * k) / rows + ((k > 0 && k < rows) ? (r() - .5) * width / rows * .12 : 0));
    return o;
  }

  // Project lateral offset o of a branch cross-section (origin q0, branch tangent tb) onto the line
  // (m, tm): the main band's edge. Gives the shared seam at joins.
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
  function distToPolyline(p, pts) { return nearest(p, pts).d; }

  // ── layout: structure descriptor -> curves ────────────────────────────────
  /* structure = {
   *   entry?: 'SW', exit?: 'NE',          // compass; derived from seed when absent
   *   bend?: number,                       // -1..1 S-curve strength; seeded when absent
   *   branches: [{ at: 0..1, side: 1|-1, kind: 'end'|'rejoin'|'cross', to?: 0..1, reach?: 0..1, tone?: 'coral'|'ochre'|'periwinkle' }]
   * }  "at"/"to" are positions along the VISIBLE part of the main path. */
  function layout(structure, seed, W, H, T, focus) {
    const r = rng('layout:' + seed);
    const min = Math.min(W, H);
    let ei = structure.entry ? COMPASS.indexOf(structure.entry) : Math.floor(r() * 8);
    let xi = structure.exit ? COMPASS.indexOf(structure.exit) : structure.opposite ? (ei + 4) % 8 : (ei + 3 + Math.floor(r() * 3)) % 8;
    if (xi === ei) xi = (ei + 4) % 8;
    const push = T * 6;
    let E = anchor(COMPASS[ei], W, H, push), X = anchor(COMPASS[xi], W, H, push);
    // Splash art with a braid: the spine runs along the long axis of the free (focus) region, through its centre,
    // so the decisions sit where nothing covers them. Still enters and leaves beyond the frame.
    if (focus && structure.opposite) {
      const fx = (focus[0] + focus[2]) / 2, fy = (focus[1] + focus[3]) / 2, tall = (focus[3] - focus[1]) >= (focus[2] - focus[0]);
      const flipDir = r() < 0.5;
      if (tall) { E = [fx + (r() - .5) * (focus[2] - focus[0]) * 0.3, flipDir ? -push : H + push]; X = [fx + (r() - .5) * (focus[2] - focus[0]) * 0.3, flipDir ? H + push : -push]; ei = flipDir ? 0 : 4; xi = (ei + 4) % 8; }
      else { E = [flipDir ? -push : W + push, fy + (r() - .5) * (focus[3] - focus[1]) * 0.3]; X = [flipDir ? W + push : -push, fy + (r() - .5) * (focus[3] - focus[1]) * 0.3]; ei = flipDir ? 6 : 2; xi = (ei + 4) % 8; }
    }
    const d = sub(X, E), nrm = perp(norm(d));
    const bend = (structure.bend != null ? structure.bend : (r() - .5) * (structure.opposite ? 0.6 : 1.4)) * min * 0.32;
    const sAlt = structure.sCurve != null ? structure.sCurve : r() < .5;
    const C1 = add(add(E, mul(d, .3)), mul(nrm, bend));
    const C2 = add(add(E, mul(d, .7)), mul(nrm, sAlt ? -bend * .8 : bend * .6));
    const main = arc(bezier(E, C1, C2, X));
    // visible interval of the main path (inside frame, or inside focus rect when given)
    const box = focus || [0, 0, W, H];
    const inside = (p, m) => p[0] >= box[0] + m && p[0] <= box[2] - m && p[1] >= box[1] + m && p[1] <= box[3] - m;
    let v0 = null, v1 = null;
    for (let s = 0; s <= main.L; s += T / 2) { if (inside(main.at(s).p, T * 3)) { if (v0 == null) v0 = s; v1 = s; } }
    if (v0 == null) { v0 = main.L * .3; v1 = main.L * .7; }
    return { main, E, X, entry: COMPASS[ei], exit: COMPASS[xi], vis: [v0, v1] };
  }

  // ── render ────────────────────────────────────────────────────────────────
  /* opts: { structure, seed, contentSeed, group, theme, width, height, tile, focus, label, decorative } */
  // Tries a bounded number of deterministic layouts (entry/exit/bend candidates) and keeps the first that
  // represents every authored branch legibly. If none does, the result is flagged unavailable: no branch
  // is ever silently dropped to make a cover look tidy (spec §3, complexity and failure behaviour).
  const LAYOUT_BUDGET = 16;
  function render(opts) {
    // A descriptor may carry the layout attempt solved at publish time: clients then render once, no search.
    if (opts.attempt != null) { const out = renderOnce(opts, opts.attempt); out.attempt = opts.attempt; if (out.problems.length) out.unavailable = true; return out; }
    let best = null;
    for (let c = 0; c < LAYOUT_BUDGET; c++) {
      const out = renderOnce(opts, c);
      if (!out.problems.length) { out.attempt = c; return out; }
      if (!best || out.problems.length < best.problems.length) best = out;
    }
    // Over capacity (Julian, 2026-10-06): a summarised cover, never a blank. Each decision becomes a single-row
    // arch (its routes are not separately drawn) and the result is flagged so the builder raises a readiness
    // warning and case detail shows the full braid on a wide canvas.
    if (opts.descriptor && !opts.summary) {
      const capped = { ...opts.descriptor, decisions: opts.descriptor.decisions.map((d) => ({ ...d, strands: d.strands.length ? [{ rejoin: Math.min(...d.strands.map((x) => x.rejoin)) }] : [], resets: 0, ends: 0, hidden: Math.max(0, d.strands.length - 1) + (d.resets || 0) + (d.ends || 0) })) };
      for (let c = 0; c < LAYOUT_BUDGET; c++) {
        const out = renderOnce({ ...opts, descriptor: capped, summary: true, thin: true }, c);
        if (!out.problems.length) { out.attempt = c; out.summarised = true; out.routesHidden = true; return out; }
      }
    }
    best.unavailable = true;
    return best;
  }
  function renderOnce(opts, attempt) {
    const W = opts.width || 420, H = opts.height || 420;
    const theme = THEME[opts.theme === 'dark' ? 'dark' : 'light'];
    const tmode = opts.theme === 'dark' ? 'dark' : 'light';
    // Geometry scale (Tg) is proportional to the canvas, so the composition is identical at every size.
    // Tile size (T) is rendition density only: it decides how many tesserae fill the same shapes.
    const structurePre = opts.descriptor ? fromDescriptor(opts.descriptor, opts.seed || 'case', attempt % 4, true) : null;
    // Density escalation: the first half of the layout budget lays two tiles per route, the second half one,
    // so dense cases thin out before they are declared unavailable.
    if (structurePre && (opts.thin || attempt >= LAYOUT_BUDGET / 2)) structurePre.thin = true;
    if (structurePre && opts.summary) structurePre.summary = true;   // summarised fallback: tally tesserae mark hidden routes
    if (structurePre && opts.entry) structurePre.entry = opts.entry;   // specimen: force a compass entry
    const Tg = Math.min(W, H) / ((structurePre && structurePre.across) || 26);
    const T = opts.tile || Tg;
    const seed = opts.seed || 'case';
    const cr = rng('content:' + (opts.contentSeed || '') + ':' + seed);   // colour only
    const gr = rng('geom:' + seed);                                       // geometry only
    const structure = structurePre || opts.structure || { branches: [] };
    const L = layout(structure, attempt ? seed + ':' + attempt : seed, W, H, Tg, opts.focus);
    const mainW = Tg * 4, brW = Tg * ((structure.thin) ? 1 : 2), outline = Tg * 0.95, outlineRow = Math.max(outline, T * 0.9);
    const group = GROUPS[opts.group] || GROUPS.neutral;
    const groundL = theme.groundL;

    const shapes = []; // {poly, fill, layer}
    const gs = tmode === 'dark' ? group.s * 0.55 : group.s;   // dark grounds stay charcoal, only tinted
    const ground = () => hsl(group.h + (cr() - .5) * 6, gs + (cr() - .5) * 4, groundL + (cr() - .5) * 2 * theme.groundVar);
    const outlineFill = () => hsl(group.h + (cr() - .5) * 4, gs + 4, groundL + theme.outlineDL + (cr() - .5) * 1.5);
    // 'coral:9' = the coral pigment lifted 9 lightness points: plait rows keep their decision's hue and differ in shade.
    // Shades move AWAY from the ground (darker on light, lighter on dark), so every row keeps the 3:1 floor.
    const pig = (spec) => { const [name, dl] = String(spec).split(':'); const p = PIGMENTS[name][tmode]; const d = Math.abs(Number(dl || 0)) * (tmode === 'light' ? -1 : 1); return () => hsl(p[0] + (cr() - .5) * 5, p[1] + (cr() - .5) * 6, p[2] + d + (cr() - .5) * 5); };

    // branch curves
    const bands = [{ curve: L.main, s0: 0, s1: L.main.L, width: mainW, kind: 'main' }];
    const problems = [];
    const [v0, v1] = L.vis, vlen = v1 - v0;
    (structure.branches || []).forEach((b, bi) => {
      const tone = b.tone || TONES[bi % 3];
      const sAt = v0 + vlen * b.at;
      const a = L.main.at(sAt), side = b.side || 1;
      const edgeOff = side * mainW / 2;
      const root = add(a.p, mul(a.n, edgeOff));
      const ang = side * (0.62 + gr() * 0.25);                // 35–50° off the main tangent
      const dir0 = rot(a.t, ang);
      if (b.kind === 'rejoin' || b.kind === 'loop') {
        // A single route is two tiles wide (one when dense); a plait gives each route one tile, in its own shade.
        const routeRows = structure.thin || (b.routes || 1) > 1 ? 1 : 2;
        const bw = b.routes ? Tg * b.routes * routeRows : brW;
        const rowTonesB = b.routeTones ? b.routeTones.flatMap((t) => Array(routeRows).fill(t)) : undefined;
        // A lens: the strand leaves the main edge, bows out to a lateral height h and lands back on the same
        // edge downstream (a rejoin) or just upstream (a loop: a reset that returns towards its checkpoint).
        // Nested strands on one side use increasing levels so inner lenses sit inside outer ones.
        const toS = b.kind === 'loop' ? sAt - vlen * (b.back || 0.05) : v0 + vlen * b.to;
        const bt = L.main.at(toS);
        const end = add(bt.p, mul(bt.n, edgeOff));
        const level = b.level || 0;
        let chosenC = null, why = '';
        for (const k of [1, 1.15, 1.3, 0.92, 1.5]) {
          // Flat lenses: the apex clears the main path by one outline row, plus one strand-and-outline step per
          // nesting level, and grows gently with long spans. A cubic's apex sits at 0.75 of its control offset.
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
          // Near its two seams a strand must sit beside the main path and its siblings; away from the main
          // edge it must keep a full branch width plus outline clear of every other path.
          const clearOfMain = mainW / 2 + bw / 2 + outline * 0.9;
          // A band cannot bend tighter than half its width without folding over itself.
          for (let q = Tg; q <= c.L - Tg && ok; q += Tg / 2) {
            const t0 = c.at(q - Tg / 2).t, t1 = c.at(q + Tg / 2).t;
            const turn = Math.acos(Math.max(-1, Math.min(1, t0[0] * t1[0] + t0[1] * t1[1])));
            if (turn > 1e-6 && Tg / turn < bw / 2 + Tg * 0.25) { ok = false; why = 'bend'; }
          }
          for (let q = bw * 1.6; q <= c.L - bw * 1.6 && ok; q += Tg / 2) {
            const at = c.at(q);
            for (const o of [-bw / 2, bw / 2]) { const pp = add(at.p, mul(at.n, o)); if (pp[0] < margin || pp[1] < margin || pp[0] > W - margin || pp[1] > H - margin) { ok = false; why = 'frame'; } }
            const dMain = distToPolyline(at.p, L.main.pts);
            if (q > c.L * 0.3 && q < c.L * 0.7 && dMain < clearOfMain) { ok = false; why = 'main'; }
            if (dMain < clearOfMain) continue;
            for (const other of bands) if (other.kind !== 'main' && other.mid && other.mid.length > 1 && distToPolyline(at.p, other.mid) < bw + Tg * 0.35) { ok = false; why = 'sibling'; }
          }
          if (ok || opts.force) { chosenC = c; break; }
        }
        if (!chosenC) { problems.push('strand ' + (bi + 1) + ' cannot be drawn without touching another path (' + why + ')'); return; }
        const c = chosenC;
        const mid = c.pts.filter((pt) => distToPolyline(pt, L.main.pts) > mainW / 2 + bw * 1.2);
        bands.push({ curve: c, mid, s0: 0, s1: c.L, width: bw, kind: 'rejoin', tone, tally: b.tally || 0, rowTones: rowTonesB,
          startSeam: seam(root, c.at(0).n, c.at(0).t, add(a.p, mul(a.n, edgeOff)), a.t),
          endSeam: seam(end, c.at(c.L).n, c.at(c.L).t, add(bt.p, mul(bt.n, edgeOff)), bt.t) });
        return;
      }
      if (b.kind === 'cross') {
        // passes under main: a straight-ish band crossing at sAt
        const dir = rot(a.t, side * 1.15);
        const half = Math.min(W, H) * (0.34 + (b.reach || .2) * .4);
        const p0 = sub(a.p, mul(dir, half)), p3 = add(a.p, mul(dir, half));
        const c = arc(bezier(p0, add(p0, mul(rot(dir, .25), half * .6)), sub(p3, mul(rot(dir, -.2), half * .6)), p3));
        bands.push({ curve: c, s0: 0, s1: c.L, width: brW, kind: 'cross', tone });
        return;
      }
      // terminal: search deterministic candidates for a blunt end inside the safe margin
      const margin = Tg * 2.2;
      let chosen = null;
      for (let tries = 0; tries < 48 && !chosen; tries++) {
        const reach = Math.min(W, H) * ((b.reach || .32) * Math.max(0.35, 1 - tries * .02));
        const turn = side * (0.15 + gr() * 0.5) * (tries % 2 ? -1 : 1) * 0.6 + side * 0.35;
        const dirE = rot(dir0, turn);
        const end = add(add(root, mul(dir0, reach * .55)), mul(dirE, reach * .55));
        const f = bezier(root, add(root, mul(dir0, reach * .45)), sub(end, mul(dirE, reach * .35)), end);
        const c = arc(f, 160);
        let ok = true;
        for (let s = 0; s <= c.L && ok; s += Tg / 2) {
          const q = c.at(s);
          for (const o of [-brW / 2, brW / 2]) { const p = add(q.p, mul(q.n, o)); if (p[0] < margin || p[1] < margin || p[0] > W - margin || p[1] > H - margin) ok = false; }
          if (s > mainW && distToPolyline(q.p, L.main.pts) < mainW / 2 + brW / 2 + outline * 1.2) ok = false;
          // Branch roots sit on the main edge and may neighbour another root there; beyond its own root
          // zone a branch must keep a full branch width plus outline away from every other path.
          // A crossing band is never exempt: a terminal touching it would read as a join.
          for (const other of bands) if (other.kind !== 'main' && (s > brW * 1.5 || other.kind === 'cross') && distToPolyline(q.p, other.curve.pts) < brW + outline * 1.5) ok = false;
        }
        if (opts.focus && ok) { const e = c.at(c.L).p, fb = opts.focus; if (e[0] < fb[0] || e[0] > fb[2] || e[1] < fb[1] || e[1] > fb[3]) ok = false; }
        if (ok) chosen = c;
      }
      if (!chosen) { problems.push('branch ' + (bi + 1) + ' cannot end legibly inside the frame'); return; }
      bands.push({ curve: chosen, mid: chosen.pts.filter((pt) => distToPolyline(pt, L.main.pts) > mainW / 2 + brW * 1.2), s0: 0, s1: chosen.L, width: brW, kind: 'end', tone,
        startSeam: seam(root, chosen.at(0).n, chosen.at(0).t, add(a.p, mul(a.n, edgeOff)), a.t) });
    });

    // ground field: jittered grid with shared vertices
    const g = T * 1.12, cols = Math.ceil(W / g) + 2, rws = Math.ceil(H / g) + 2;
    const gp = [];
    for (let j = 0; j < rws; j++) { gp.push([]); for (let i = 0; i < cols; i++) gp[j].push([(i - .5) * g + (gr() - .5) * g * .26, (j - .5) * g + (gr() - .5) * g * .26]); }
    for (let j = 0; j < rws - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const poly = [gp[j][i], gp[j][i + 1], gp[j + 1][i + 1], gp[j + 1][i]];
      const c = centroid(poly);
      let covered = false;
      // Only tiles beside a band (not beyond its ends) are lifted, so blunt ends never leave holes.
      for (const b of bands) { const q = nearest(c, b.curve.pts); if (!q.cap && q.d < b.width / 2 + outline * 0.45) { covered = true; break; } }
      if (!covered) shapes.push({ poly, fill: ground(), layer: 0, l: 'g' });
    }
    // paint order: ground → crossing bands → outline rows → joined branches → main
    const paintBand = (b, layer) => {
      const fill = b.kind === 'main' ? pig('petrol') : pig(b.tone);
      // A plait keeps one row per authored alternative at every size, each row in its own pigment.
      const rows = b.rowTones ? b.rowTones.length : Math.max(1, Math.round(b.width / T));
      const rowFill = b.rowTones ? b.rowTones.map((t) => pig(t)) : null;
      const tiles = tileBand(b.curve, b.s0, b.s1, rowOffsets(b.width, rows, gr), T * 1.04, gr, { startCap: b.startSeam, endCap: b.endSeam });
      for (const t of tiles) shapes.push({ poly: t, fill: rowFill ? rowFill[t.row]() : fill(), layer, l: b.kind === 'main' ? 'm' : b.kind === 'cross' ? 'x' : 'b', s: t.s });
      // Tally tesserae (summarised covers, Julian 2026-10-06): one tile per route not drawn, in the decision's
      // pigment at its darkest shade, stacked outward from the arch's apex. Counts stay truthful; no text on art.
      if (b.tally) {
        const m = b.curve.at(b.curve.L / 2);
        const away = distToPolyline(add(m.p, m.n), bands[0].curve.pts) > distToPolyline(sub(m.p, m.n), bands[0].curve.pts) ? 1 : -1;
        const size = Tg * 0.9, step = Tg * 1.15, tf = pig(b.tone + ':20');
        for (let k = 0; k < b.tally; k++) {
          const along = (k - (b.tally - 1) / 2) * step;
          const c0 = add(add(m.p, mul(m.t, along)), mul(m.n, away * (b.width / 2 + outline * 0.6 + size / 2)));
          const hx = mul(m.t, size / 2), hy = mul(m.n, size / 2);
          shapes.push({ poly: [sub(sub(c0, hx), hy), sub(add(c0, hx), hy), add(add(c0, hx), hy), add(sub(c0, hx), hy)], fill: tf(), layer: layer + 0.1, l: 'b', s: 0.5 });
        }
      }
    };
    const outlineRows = (b, layer) => {
      for (const side of [-1, 1]) {
        const o0 = side * b.width / 2, o1 = side * (b.width / 2 + outlineRow);
        const tiles = tileBand(b.curve, b.s0, b.s1, side < 0 ? [o1, o0] : [o0, o1], T * 1.1, gr);
        for (const t of tiles) shapes.push({ poly: t, fill: outlineFill(), layer, l: 'o', s: t.s });
      }
    };
    // A crossing band and its outline sit below every other outline row, so the main band's outline
    // interrupts it: an over/under gap that can never be read as a join.
    bands.filter(b => b.kind === 'cross').forEach(b => { outlineRows(b, 1); paintBand(b, 1.5); });
    bands.filter(b => b.kind !== 'cross').forEach(b => outlineRows(b, 2));
    bands.filter(b => b.kind === 'end' || b.kind === 'rejoin').forEach(b => paintBand(b, 3));
    paintBand(bands[0], 4);

    shapes.sort((a, b) => a.layer - b.layer);
    const sw = Math.max(0.6, T * 0.16);
    const f1 = (n) => (Math.round(n * 10) / 10).toString();
    let body = '';
    for (const s of shapes) body += '<polygon points="' + s.poly.map(p => f1(p[0]) + ',' + f1(p[1])).join(' ') + '" fill="' + s.fill + '" data-l="' + s.l + '"' + (s.s != null ? ' data-s="' + s.s.toFixed(2) + '"' : '') + '/>';
    const a11y = opts.decorative === false
      ? ' role="img" aria-label="' + (opts.label || 'Abstract branching mosaic artwork') + '"'
      : ' aria-hidden="true" focusable="false"';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid slice"' + a11y +
      ' data-mosaic-entry="' + L.entry + '" data-mosaic-exit="' + L.exit + '" style="display:block;width:100%;height:100%;background:' + theme.grout + '">' +
      '<g stroke="' + theme.grout + '" stroke-width="' + f1(sw) + '" stroke-linejoin="round">' + body + '</g></svg>';
    return { svg, problems, entry: L.entry, exit: L.exit, tiles: shapes.length, shapes, grout: theme.grout, groutWidth: sw, width: W, height: H, grammar: structure.grammar };
  }

  // ── authored-graph descriptor → structure (braid grammar) ─────────────────
  /* desc = { v: 1, stops: n, decisions: [{ stop: i, strands: [{ rejoin: j }], resets: k, ends: m }] }
   * (built from a case by art-descriptor.mjs). Decisions sit along the main path in authored order; each
   * decision's non-recommended paths become a lens of strands that rejoin at their authored stop, resets
   * become small loops, and true dead ends stay blunt branches. Sides alternate per decision. */
  function fromDescriptor(desc, seed, variant, plait) {
    const r = rng('braid:' + seed);
    const decs = desc.decisions || [];
    const d = Math.max(1, decs.length);
    // Lenses are spaced by DECISIONS, not by every stop: surface beats between decisions take no length.
    // A strand lands where the next decision departs, so consecutive lenses chain like a braided rope.
    const unit = 0.8 / d;                 // one decision interval along the visible spine
    const q = (i) => 0.1 + unit * i;
    const posOfStop = (j) => { const k = decs.findIndex((x) => x.stop >= j); return k < 0 ? 0.92 : q(k); };
    const branches = [];
    let flip = r() < 0.5 ? 1 : -1;
    // 1. Items with their span along the spine. Over-under rhythm: one decision's strands on one side, the
    //    next decision's on the other; resets and dead ends sit opposite their decision's strands.
    const items = [];
    decs.forEach((dd, di) => {
      const s0 = (di % 2 ? -1 : 1) * flip, at = q(di), tone = TONES[di % 3];
      // Strands alternate sides (longest first, starting on this decision's side), so both sides of the
      // interval are used; the rhythm still flips decision by decision.
      // Two grammars, tried in turn by the layout search: 'split' alternates a decision's strands across both
      // sides (best for wide decisions); 'over-under' nests them on one side and leaves the other side to
      // resets and dead ends (best when resets are present).
      let strands = (dd.strands || []).slice().sort((x, y) => y.rejoin - x.rejoin).map((st) => ({ rejoin: st.rejoin, n: 1 }));
      if (plait) {   // Always (Julian, 2026-10-06): alternatives that rejoin at the same stop share one multi-row lens, one row per route
        const byStop = new Map(); for (const st of strands) byStop.set(st.rejoin, (byStop.get(st.rejoin) || 0) + 1);
        strands = [...byStop].map(([rejoin, n]) => ({ rejoin, n }));
      }
      strands.forEach((st, k) => items.push({ kind: 'rejoin', tone, side: variant % 2 === 1 ? s0 : (k % 2 ? -s0 : s0), a: at, b: posOfStop(st.rejoin), routes: st.n, tally: k === 0 ? (dd.hidden || 0) : 0 }));
      const lighter = () => { if (variant % 2 === 1) return -s0; const n1 = items.filter((x) => x.a === at && x.side === 1).length, n2 = items.filter((x) => x.a === at && x.side === -1).length; return n1 <= n2 ? 1 : -1; };
      for (let k = 0; k < (dd.resets || 0); k++) items.push({ kind: variant >= 2 ? 'notch' : 'loop', tone, side: lighter(), a: at, b: at + unit * 0.45 });
      for (let k = 0; k < (dd.ends || 0); k++) items.push({ kind: 'end', tone, side: lighter(), a: at, b: at + unit * 0.5 });
    });
    // 2. Global layering per side: a strand's height is one more than the tallest strand inside its span, so
    //    a strand that is "away" while later decisions happen arches over them.
    const overlaps = (x, y) => x.a < y.b - 1e-6 && y.a < x.b - 1e-6;
    const bySpan = items.slice().sort((x, y) => (x.b - x.a) - (y.b - y.a));
    for (const it of bySpan) {
      it.height = 0;
      for (const o of bySpan) { if (o === it || o.side !== it.side || o.height == null || (o.b - o.a) > (it.b - it.a)) continue; if (overlaps(o, it)) it.height = Math.max(it.height, o.height + 1); }
    }
    // 3. Items sharing a departure or a landing are inset by a strand width, the taller one outermost.
    for (const it of items) {
      const sameStart = items.filter((o) => o !== it && o.side === it.side && Math.abs(o.a - it.a) < 1e-6 && o.height > it.height).length;
      const sameEnd = items.filter((o) => o !== it && o.side === it.side && Math.abs(o.b - it.b) < 1e-6 && o.height > it.height).length;
      const touchA = items.some((o) => o !== it && o.side === it.side && Math.abs(o.b - it.a) < 1e-6);
      const touchB = items.some((o) => o !== it && o.side === it.side && Math.abs(o.a - it.b) < 1e-6);
      // Gaps and nesting insets scale with the decision interval, so dense cases never invert a lens.
      const a = it.a + unit * (touchA ? 0.17 : 0.06) + unit * 0.22 * sameStart, b = it.b - unit * (touchB ? 0.17 : 0.06) - unit * 0.22 * sameEnd;
      if (it.kind === 'rejoin') branches.push({ kind: 'rejoin', tone: it.tone, tally: it.tally || 0, at: a, to: b, side: it.side, level: it.height, routes: it.routes || 1, routeTones: Array.from({ length: it.routes || 1 }, (_, r) => it.tone + ':' + [0, 11, 20, 6][r % 4]) });
      else if (it.kind === 'loop') branches.push({ kind: 'loop', tone: it.tone, at: a + unit * 0.2, side: it.side, level: it.height, back: unit * 0.22 });
      else if (it.kind === 'notch') branches.push({ kind: 'end', tone: it.tone, at: a + unit * 0.15, side: it.side, reach: 0.11 });   // compact reset: a short blunt notch
      else branches.push({ kind: 'end', tone: it.tone, at: a + 0.005, side: it.side, reach: 0.2 });
    }
    // Draw lowest first, so taller arches are validated against the strands they pass over.
    branches.sort((x, y) => (x.level || 0) - (y.level || 0));
    // Complex cases are laid with finer tesserae: density follows the number of strands, resets and ends
    // (26 tiles across minimum), capped at 56 so a 280 px cover keeps tesserae of about 5 px. Rendition density
    // still keeps displayed tiles at 5.5 CSS px or more; a plait always keeps one row per route.
    const lanes = decs.reduce((n, x) => n + (x.strands || []).length + (x.resets || 0) + (x.ends || 0), 0);
    const across = Math.min(56, Math.max(26, 22 + 2.4 * lanes));
    return { branches, across, opposite: true, grammar: (variant % 2 ? 'over-under' : 'split') + (variant >= 2 ? '+notch' : '+loop') + (plait ? '+plait' : '') };
  }

  // ── browser glue: <div data-mosaic='{"structure":...,"seed":"..."}'> ──────
  const PRESETS = {
    // Synthetic study structures. Names describe topology only.
    spine:     { branches: [] },
    diverge:   { branches: [{ at: .3, side: 1, kind: 'end', reach: .34 }, { at: .55, side: -1, kind: 'end', reach: .3 }, { at: .78, side: 1, kind: 'end', reach: .24 }] },
    rejoin:    { branches: [{ at: .22, side: -1, kind: 'rejoin', to: .62, reach: .35 }, { at: .7, side: 1, kind: 'end', reach: .28 }] },
    endings:   { branches: [{ at: .25, side: 1, kind: 'end', reach: .3 }, { at: .45, side: -1, kind: 'end', reach: .34 }, { at: .65, side: 1, kind: 'end', reach: .3 }, { at: .82, side: -1, kind: 'end', reach: .22 }] },
    nested:    { branches: [{ at: .15, side: 1, kind: 'rejoin', to: .55, reach: .45 }, { at: .58, side: -1, kind: 'end', reach: .34 }, { at: .8, side: 1, kind: 'end', reach: .22 }] },
    crossing:  { branches: [{ at: .6, side: 1, kind: 'cross', reach: .1 }, { at: .22, side: -1, kind: 'end', reach: .24 }] },
    dense:     { branches: [{ at: .12, side: 1, kind: 'end', reach: .2 }, { at: .25, side: -1, kind: 'rejoin', to: .5, reach: .22 }, { at: .42, side: 1, kind: 'end', reach: .26 }, { at: .6, side: -1, kind: 'end', reach: .24 }, { at: .74, side: 1, kind: 'end', reach: .22 }, { at: .88, side: -1, kind: 'end', reach: .2 }] },
  };

  function currentTheme() {
    if (typeof document === 'undefined') return 'light';
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function paint(el) {
    let cfg = {}; try { cfg = JSON.parse(el.getAttribute('data-mosaic') || '{}'); } catch (e) { cfg = {}; }
    const box = el.getBoundingClientRect();
    const aspect = cfg.aspect || (box.width && box.height ? box.width / box.height : 1);
    const base = cfg.base || 420;
    const W = aspect >= 1 ? Math.round(base * aspect) : base, H = aspect >= 1 ? base : Math.round(base / aspect);
    const structure = typeof cfg.structure === 'string' ? PRESETS[cfg.structure] : (cfg.structure || PRESETS.diverge);
    const descriptor = cfg.descriptor || null;
    const focus = cfg.focus ? [cfg.focus[0] * W, cfg.focus[1] * H, cfg.focus[2] * W, cfg.focus[3] * H] : null;
    const theme = currentTheme();
    const key = [theme, W, H, el.getAttribute('data-mosaic')].join('|');
    if (el.__mosaicKey === key) return;
    el.__mosaicKey = key;
    const px = box.width ? W / box.width : 1;                     // canvas units per CSS px
    const tile = Math.max(Math.min(W, H) / 26, 5.5 * px);          // ≥ 5.5 CSS px per tessera
    const out = render({ structure, descriptor, entry: cfg.entry, attempt: cfg.attempt, seed: cfg.seed, contentSeed: cfg.content, group: cfg.group, theme, width: W, height: H, tile, focus, label: cfg.label, decorative: cfg.label ? false : true });
    if (cfg.format === 'canvas') { paintCanvas(el, out, box, cfg.label); el.dataset.mosaicProblems = out.problems.length; if (out.unavailable) el.dataset.mosaicUnavailable = 'true'; return; }
    // Parsed, not innerHTML: geometry and colours are generated numbers; no user text enters the SVG.
    const doc = new DOMParser().parseFromString(out.svg, 'image/svg+xml');
    el.replaceChildren(document.importNode(doc.documentElement, true));
    el.dataset.mosaicProblems = out.problems.length;
    const svgEl = el.querySelector('svg'); if (svgEl) svgEl.__c = null;
    const motion = cfg.motion || [];
    if (motion.includes('assemble') && !el.__assembled) { el.__assembled = true; assemble(el); }
    if (motion.includes('shimmer')) shimmer(el);
    if (out.unavailable) el.dataset.mosaicUnavailable = 'true'; else delete el.dataset.mosaicUnavailable;
  }
  // Covers: one bitmap per cover (Julian, 2026-10-06: canvas covers, SVG only where tiles animate). Drawn at
  // device-pixel resolution from the same geometry, so a canvas cover and an SVG splash are the same artwork.
  function paintCanvas(el, out, box, label) {
    const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const cw = Math.max(1, Math.round((box.width || 300) * dpr)), ch = Math.max(1, Math.round((box.height || 300) * dpr));
    let cv = el.querySelector('canvas');
    if (!cv) { cv = document.createElement('canvas'); cv.style.cssText = 'display:block;width:100%;height:100%'; el.replaceChildren(cv); }
    if (label) { cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', label); } else cv.setAttribute('aria-hidden', 'true');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    const k = Math.max(cw / out.width, ch / out.height);          // slice: cover the box
    const ox = (cw - out.width * k) / 2, oy = (ch - out.height * k) / 2;
    g.fillStyle = out.grout; g.fillRect(0, 0, cw, ch);
    g.lineJoin = 'round'; g.lineWidth = out.groutWidth * k; g.strokeStyle = out.grout;
    for (const sh of out.shapes) {
      g.beginPath(); sh.poly.forEach((p, i) => { const x = ox + p[0] * k, y = oy + p[1] * k; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath();
      g.fillStyle = sh.fill; g.fill(); g.stroke();
    }
  }

  function paintAll(scope) { (scope || document).querySelectorAll('[data-mosaic]').forEach(paint); }

  // ── living mosaic ─────────────────────────────────────────────────────────
  // Motion is decoration: opt-in through prefers-reduced-motion: no-preference, paused while the page is
  // hidden or the art is off-screen, and only used where the design system allows art (arrival, lobby,
  // covers). Geometry, colours and tile identity never change; tiles only lift, settle and catch the light.
  const EASE = 'cubic-bezier(.2,.7,.2,1)';
  const motionOK = () => typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  function centres(svg) {
    if (svg.__c) return svg.__c;
    svg.__c = [...svg.querySelectorAll('polygon')].map((p) => { const b = p.getBBox(); return { p, x: b.x + b.width / 2, y: b.y + b.height / 2, l: p.dataset.l, s: Number(p.dataset.s || 0) }; });
    return svg.__c;
  }
  function assemble(el) {
    const svg = el.querySelector('svg'); if (!svg || !motionOK()) return;
    const r = rng('assemble');
    for (const t of centres(svg)) {
      const delay = t.l === 'm' ? 120 + t.s * 900 : t.l === 'o' ? 80 + t.s * 900 : (t.l === 'b' || t.l === 'x') ? 520 + t.s * 600 : r() * 520;
      const from = t.l === 'g' ? { opacity: 0 } : { opacity: 0, transform: 'scale(.35)' };
      t.p.animate([from, { opacity: 1, transform: 'scale(1)' }], { duration: t.l === 'g' ? 700 : 520, delay, easing: EASE, fill: 'backwards' });
    }
  }
  function ripple(el, x, y) {
    const svg = el.querySelector('svg'); if (!svg || !motionOK()) return;
    const vb = svg.viewBox.baseVal, box = svg.getBoundingClientRect();
    // map client point into viewBox units (slice = cover)
    const k = Math.max(box.width / vb.width, box.height / vb.height);
    const ox = (box.width - vb.width * k) / 2, oy = (box.height - vb.height * k) / 2;
    const px = x == null ? vb.width / 2 : (x - box.left - ox) / k, py = y == null ? vb.height / 2 : (y - box.top - oy) / k;
    const reach = Math.hypot(vb.width, vb.height) * 0.55, speed = reach / 820;
    for (const t of centres(svg)) {
      const d = Math.hypot(t.x - px, t.y - py); if (d > reach) continue;
      const fall = 1 - d / reach;
      t.p.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(' + (1 - 0.22 * fall).toFixed(3) + ')', opacity: (1 - 0.3 * fall).toFixed(2) }, { transform: 'scale(1)', opacity: 1 }], { duration: 620, delay: d / speed, easing: EASE });
    }
  }
  function shimmer(el) {
    if (el.__shimmer || !motionOK()) return;
    let visible = true, timer = null;
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((e) => { visible = e[0].isIntersecting; }) : null;
    if (io) io.observe(el);
    const r = rng('shimmer:' + Math.random());
    const tick = () => {
      if (!el.isConnected) { clearInterval(timer); if (io) io.disconnect(); el.__shimmer = null; return; }
      if (document.hidden || !visible) return;
      const svg = el.querySelector('svg'); if (!svg) return;
      const pool = centres(svg).filter((t) => t.l === 'g' || t.l === 'o' || t.l === 'm');
      for (let i = 0; i < 6; i++) { const t = pool[Math.floor(r() * pool.length)]; if (!t) continue;
        t.p.animate([{ opacity: 1 }, { opacity: t.l === 'm' ? 0.72 : 0.5 }, { opacity: 1 }], { duration: 2400, easing: 'ease-in-out', delay: r() * 900 }); }
    };
    timer = setInterval(tick, 1300); el.__shimmer = timer;
  }
  function stop(el) { if (el.__shimmer) { clearInterval(el.__shimmer); el.__shimmer = null; } }

  const api = { render, layout, fromDescriptor, PRESETS, PIGMENTS, GROUPS, THEME, COMPASS, paint, paintAll, rng, hash, hsl, assemble, ripple, shimmer, stop, motionOK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CaseMosaic = api;
  if (typeof document !== 'undefined') {
    const go = () => paintAll();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    if (root.matchMedia) root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => paintAll());
    new MutationObserver(() => paintAll()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let rt; root.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => paintAll(), 150); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
