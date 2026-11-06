// Per-tessera splash motion (Julian's motion lab, approved 2026-10-10; prototypes/motion-lab/). Replaces the whole-art
// breath. It moves only the decorative splash SVG that buildSplash (mosaic.mjs) drew: each tile turns, rocks, lifts or
// catches the light, light runs down the route, and a branch turns over. Geometry never changes: motion only shifts a
// tile's transform and its fill lightness for a moment. Random, never seeded per case. Nothing runs under reduced
// motion or Motion off (appearance-watch.mjs); everything pauses while the page is hidden or the art is offscreen;
// tiles under the opaque cards are never animated; stop() cancels every animation, timer and listener.
import { reducedMotion } from './appearance-watch.mjs';

/** Julian's approved settings (2026-10-10). Pointer, tap and exit are off and not implemented. */
export const MOTION = Object.freeze({
  intensity: 0.7, phoneIntensity: 0.3,
  flip: 0.2, flipCluster: 0.2, wiggle: 0.3, lift: 0.3, twinkle: 0.5,
  current: 0.5, branch: 0.29, join: 0.1,
});
/** Timings in ms; tokens.css (--art-*) is the source, these are the fallbacks (tests/splash-motion.test.mjs keeps them equal). */
export const ART_TIMINGS = Object.freeze({
  arrivalTile: 420, arrivalSpan: 1300, current: 800, lay: 420, joinHold: 1500, joinFlight: 600, joinQueue: 400,
});
/** The timings this document's tokens set (fallbacks where a token is missing). */
export function artTimings(doc = globalThis.document) {
  const out = { ...ART_TIMINGS };
  try {
    const style = doc.defaultView.getComputedStyle(doc.documentElement);
    for (const key in out) { const ms = parseFloat(style.getPropertyValue('--art-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))); if (ms > 0) out[key] = ms; }
  } catch { /* No styles yet: the fallbacks hold. */ }
  return out;
}

const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a, b) => Math.max(a, Math.min(b, v)), rnd = Math.random;
const EASE = 'cubic-bezier(.2,.7,.2,1)', BOUNCE = 'cubic-bezier(.3,1.6,.5,1)';
const HSL = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/;

function readTiles(svg) {
  const tiles = [];
  for (const p of svg.querySelectorAll('polygon')) {
    const nums = p.getAttribute('points').split(/[ ,]/).map(Number);
    let x = 0, y = 0; for (let i = 0; i < nums.length; i += 2) { x += nums[i]; y += nums[i + 1]; }
    const fill = p.getAttribute('fill'), m = HSL.exec(fill) || [0, 0, 0, 50];
    p.style.transformBox = 'fill-box'; p.style.transformOrigin = 'center';
    tiles.push({ p, x: x / (nums.length / 2), y: y / (nums.length / 2), l: p.dataset.l, s: Number(p.dataset.s || 0), fill, h: +m[1], sa: +m[2], li: +m[3], busy: 0, under: false });
  }
  return tiles;
}

/**
 * Start motion on a mounted splash SVG. `intensity` 0..1 (projector 0.7, phone 0.3); `arrive` lays the art along the
 * route once (the caller decides once per page or room); `covers()` returns the opaque elements over the art.
 * Returns { stop(), laid(n), current(), branch(), join(spec), keep(records), refresh() }.
 */
export function startMotion(svg, { intensity = MOTION.intensity, arrive = false, covers = () => [], dark = false,
  doc = svg.ownerDocument, media = reducedMotion(doc.defaultView ?? globalThis), Observer = globalThis.IntersectionObserver,
  timings = artTimings(doc) } = {}) {
  const I = clamp(intensity, 0, 1), amp = lerp(0.6, 1.5, I), T0 = performance.now();
  const tiles = readTiles(svg);
  const grout = Number(svg.getAttribute('stroke-width')) || 1;
  const T = Math.max(4, grout / 0.16), cell = T * 3;
  let closed = false, visible = true, live = 0, busyUntil = 0, paths = [], ground = [], spine = [], strands = [], grid = null;
  const timers = new Set(), held = new Map(), flying = new Set(), claimed = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!closed) fn(); }, ms); timers.add(id); return id; };
  const running = () => !closed && !media.matches && !doc.hidden && visible;
  const attempt = fn => { try { return fn(); } catch { return null; } };

  // ── covers: tiles under an opaque card are never animated, and the route's uncovered share is reported ──
  const toSvg = (cx, cy) => { const m = svg.getScreenCTM(); return m ? new DOMPoint(cx, cy).matrixTransform(m.inverse()) : null; };
  function refresh() {
    for (const t of tiles) t.under = false;
    for (const el of covers()) {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const a = toSvg(r.left, r.top), b = toSvg(r.right, r.bottom); if (!a || !b) continue;
      for (const t of tiles) if (t.x > a.x && t.x < b.x && t.y > a.y && t.y < b.y) t.under = true;
    }
    paths = tiles.filter(t => t.l !== 'g' && !t.under && !claimed.has(t)); ground = tiles.filter(t => t.l === 'g' && !t.under);
    spine = tiles.filter(t => t.l === 'm' && !t.under).sort((a, b) => a.s - b.s);
    // branch strands: consecutive runs of branch tiles in paint order (s rises along each strand)
    const runs = []; let cur = null, prev = null;
    for (const t of tiles) {
      if (t.l !== 'b') { prev = cur = null; continue; }
      if (!cur || (prev && (t.s < prev.s - 0.3 || Math.hypot(t.x - prev.x, t.y - prev.y) > T * 4))) { cur = []; runs.push(cur); }
      cur.push(t); prev = t;
    }
    strands = runs.filter(s => s.filter(t => !t.under).length >= 6).map(s => s.slice().sort((a, b) => a.s - b.s));
    grid = null;
  }
  function near(x, y, r) {
    if (!grid) { grid = new Map(); for (const t of tiles) { const k = Math.floor(t.x / cell) + ',' + Math.floor(t.y / cell); (grid.get(k) || grid.set(k, []).get(k)).push(t); } }
    const out = [], x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell), y0 = Math.floor((y - r) / cell), y1 = Math.floor((y + r) / cell);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) for (const t of grid.get(i + ',' + j) || []) {
      if (t.under) continue; const d = Math.hypot(t.x - x, t.y - y); if (d <= r) out.push([t, d]);
    }
    return out.sort((a, b) => a[1] - b[1]);
  }

  // ── colour (lightness only) and bookkeeping ──
  const col = (t, dl, ds = 0) => `hsl(${t.h} ${clamp(t.sa + ds, 0, 100)}% ${clamp(t.li + dl, 0, 99)}%)`;
  const glint = t => t.l === 'g' ? col(t, dark ? 9 : 4.5) : col(t, dark ? 16 : 24, -6);
  const backOf = t => t.l === 'g' ? col(t, dark ? 10 : -9) : col(t, dark ? 24 : 36, -34); // the pale unglazed underside
  function anim(t, kf, opt, claim = true) {
    if (t.under || !running()) return null;
    const now = performance.now();
    if (claim) { if (t.busy > now) return null; t.busy = now + (opt.delay || 0) + opt.duration; }
    const a = attempt(() => t.p.animate(kf, opt)); if (!a) return null;
    let done = false; live++;
    const end = () => { if (!done) { done = true; live--; } };
    a.addEventListener('finish', end); a.addEventListener('cancel', end);
    return a;
  }
  const flipZ = () => (rnd() < 0.5 ? 'scaleX(0.04)' : 'scaleY(0.04)');
  /** Turn over to `c` (edge-on at `zIn`, face up at `land`), hold to `leave`, edge-on again at `zOut`, then home. */
  const turnKF = (t, z, c, [zIn, land, leave, zOut], easeIn = 'ease-out') => [
    { transform: 'none', fill: t.fill, easing: 'ease-in' }, { transform: z, fill: t.fill, offset: zIn },
    { transform: z, fill: c, offset: zIn + 0.0001, easing: easeIn }, { transform: 'none', fill: c, offset: land },
    { transform: 'none', fill: c, offset: leave, easing: 'ease-in' }, { transform: z, fill: c, offset: zOut },
    { transform: z, fill: t.fill, offset: zOut + 0.0001, easing: 'ease-out' }, { transform: 'none', fill: t.fill }];

  // ── ambient tile life ──
  function pick(pathShare) {
    const pool = rnd() < pathShare ? paths : ground;
    for (let i = 0; i < 6; i++) { const t = pool[(rnd() * pool.length) | 0]; if (t && t.busy < performance.now()) return t; }
    return null;
  }
  function flip(t, str, delay = 0) {
    const hold = 0.45 + 0.35 * str, dur = (1600 + 1800 * str) * (0.8 + 0.4 * rnd()), o = 0.18 * (1 - hold);
    return anim(t, turnKF(t, flipZ(), backOf(t), [o / 2, o, 1 - o, 1 - o / 2]), { duration: dur, delay });
  }
  function fxFlip() {
    const t = pick(0.7); if (!t) return;
    const str = MOTION.flip * amp, n = Math.round(MOTION.flipCluster * 8 * amp);
    if (!n) { flip(t, str); return; }
    near(t.x, t.y, T * (1.5 + n * 0.6)).slice(0, n + 1).forEach(([u, d], i) => flip(u, str, i * 90 + d * 6));
  }
  function fxWiggle() {
    const t = pick(0.75); if (!t) return;
    const a = (3 + 9 * MOTION.wiggle) * amp, sg = rnd() < 0.5 ? 1 : -1;
    anim(t, [0, a, -0.8 * a, 0.5 * a, -0.25 * a, 0].map(d => ({ transform: `rotate(${sg * d}deg)` })), { duration: 700 + 500 * MOTION.wiggle, easing: 'ease-out' });
  }
  function fxLift() {
    const t = pick(0.75); if (!t) return;
    const k = MOTION.lift * amp;
    anim(t, [{ transform: 'none', fill: t.fill }, { transform: `translate(0px,${-0.35 * T * k}px) scale(${1 + 0.22 * k})`, fill: glint(t), offset: 0.3 }, { transform: 'none', fill: t.fill }],
      { duration: 1300 + 600 * k, easing: EASE });
  }
  function fxTwinkle() {
    const n = 1 + Math.round(MOTION.twinkle * 4 * amp);
    for (let i = 0; i < n; i++) {
      const t = ground[(rnd() * ground.length) | 0]; if (!t) return;
      anim(t, [{ fill: t.fill }, { fill: glint(t), offset: 0.4 }, { fill: t.fill }], { duration: 1400 + 1400 * rnd(), easing: 'ease-in-out', delay: rnd() * 300 });
    }
  }
  const AMBIENT = [[fxFlip, MOTION.flip], [fxWiggle, MOTION.wiggle], [fxLift, MOTION.lift], [fxTwinkle, MOTION.twinkle]];

  // ── structural currents: a glint wave down the default route, and one branch turning over ──
  function current() {
    if (!running()) return;
    const str = MOTION.current, travel = lerp(4200, 2000, str);
    for (const t of spine) {
      if (claimed.has(t)) continue;
      const delay = t.s * travel + rnd() * 90;
      anim(t, [{ fill: t.fill, transform: 'none' }, { fill: glint(t), transform: `scale(${1 + 0.08 * str})`, offset: 0.35 }, { fill: t.fill, transform: 'none' }],
        { duration: timings.current, delay, easing: 'ease-in-out' }, false);
      t.busy = Math.max(t.busy, performance.now() + delay + 1600);
    }
  }
  function branch() {
    if (!running() || !strands.length) return;
    const s = strands[(rnd() * strands.length) | 0], str = MOTION.branch, travel = lerp(2400, 1100, str) * (0.6 + s.length / 120);
    for (const t of s) {
      const delay = t.s * travel;
      anim(t, turnKF(t, flipZ(), backOf(t), [0.12, 0.24, 0.62, 0.74]), { duration: 1800 + 1600 * str, delay }, false);
      t.busy = Math.max(t.busy, performance.now() + delay + 3400);
    }
  }

  // ── arrival: laid along the route (the ground fades in as one layer; route, outline, then branches drop into place) ──
  function arrival() {
    let max = 0;
    attempt(() => svg.querySelector('g[data-l="g"]')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'ease-out', fill: 'backwards' }));
    for (const t of tiles) {
      if (t.l === 'g') continue;
      const o = { duration: timings.arrivalTile, delay: (t.l === 'b' ? 1100 : t.l === 'o' ? 650 : 450) + t.s * timings.arrivalSpan + rnd() * 70, easing: 'cubic-bezier(.3,1.35,.5,1)', fill: 'backwards' };
      if (anim(t, [{ opacity: 0, transform: `translate(0px,${-T * 0.8}px) scale(1.35) rotate(${(rnd() - 0.5) * 30}deg)` }, { opacity: 1, transform: 'none' }], o, false)) max = Math.max(max, o.delay + o.duration);
    }
    return max;
  }

  // ── room-code typing: each character lays one sixth of the route; deleting reverses it; six send a current ──
  let laidCount = 0;
  function laySegment(i) {
    if (held.has(i)) return;
    const lo = i / 6, hi = (i + 1) / 6 + (i === 5 ? 0.01 : 0), list = [];
    for (const t of spine) {
      if (t.s < lo || t.s >= hi || claimed.has(t)) continue;
      const g = glint(t), z = 'scaleY(0.04)';
      const a = anim(t, [{ transform: 'none', fill: t.fill, easing: 'ease-in' }, { transform: z, fill: t.fill, offset: 0.5 }, { transform: z, fill: g, offset: 0.5001, easing: 'ease-out' }, { transform: 'none', fill: g }],
        { duration: timings.lay, delay: (t.s - lo) * 6 * 520, fill: 'forwards' }, false);
      if (a) { t.busy = Infinity; list.push([t, a]); }
    }
    held.set(i, list);
  }
  function unlaySegment(i) {
    const list = held.get(i); if (!list) return;
    held.delete(i);
    for (const [t, a] of list) { attempt(() => { a.reverse(); a.finished.then(() => { a.cancel(); t.busy = 0; }, () => { t.busy = 0; }); }); }
  }
  /** Set how many code characters are typed (0..6). Only the count is ever given, never a character. */
  function laid(n) {
    const count = clamp(Math.floor(Number(n) || 0), 0, 6), before = laidCount; laidCount = count;
    if (!running()) return;
    for (let i = 0; i < 6; i++) { if (i < count) laySegment(i); else unlaySegment(i); }
    if (count === 6 && before < 6) later(current, 450);
  }

  // ── projector: someone joins (quiz-lobby style; anonymous, avatar and count only) ──
  const GOLDEN = 0.6180339;
  let joined = 0;
  function spotFor(index, pool) { return pool[Math.floor(((index * GOLDEN) % 1) * pool.length)]; }
  function keepAt(spot, colour, animate, delay = 0) {
    const keep = near(spot.x, spot.y, T * 2.5).map(([t]) => t).filter(t => t.l === 'm' && !claimed.has(t)).slice(0, 3);
    keep.forEach((t, k) => {
      claimed.add(t); t.busy = Infinity;
      const commit = () => { t.fill = colour; t.p.setAttribute('fill', colour); };
      const a = animate ? anim(t, [{ fill: t.fill, transform: 'none' }, { fill: colour, transform: 'scale(1.2)', offset: 0.5 }, { fill: colour, transform: 'none' }], { duration: 420, delay: delay + k * 90 }, false) : null;
      if (a) a.finished.then(() => { commit(); a.cancel(); }, commit); else commit();
    });
    paths = paths.filter(t => !claimed.has(t));
  }
  /** Re-apply earlier arrivals' kept route colours after a repaint (static, no motion). */
  function keep(records) { for (const r of records) { const pool = spine.filter(t => !claimed.has(t)); if (!pool.length) return; keepAt(spotFor(joined++, pool), r.colour, false); } }
  /**
   * One arrival: `spec` = { image (an <img>), ink, background, region ([x0,y0,x1,y1] of the art's free region),
   * target() (the chip to fly into), landed() }. Returns the kept colour record, or null when nothing moved
   * (landed() is still called, at once).
   */
  function join(spec) {
    const done = () => { try { spec.landed?.(); } catch { /* The room view owns its own errors. */ } };
    if (!running()) { done(); return null; }
    const ctm = svg.getScreenCTM(), S = svg.getBoundingClientRect();
    if (!ctm || !S.width) { done(); return null; }
    const size = Math.min(S.height * 0.2, 170) * (0.8 + 0.4 * MOTION.join), F = spec.region || [0, 0, 1, 1], pad = size / 2 + 6;
    const scr = t => { const q = new DOMPoint(t.x, t.y).matrixTransform(ctm); return [q.x, q.y]; };
    const fits = t => { const [x, y] = scr(t); return x > S.left + F[0] * S.width + pad && x < S.left + F[2] * S.width - pad && y > S.top + F[1] * S.height + pad && y < S.top + F[3] * S.height - pad; };
    let route = spine.filter(t => !claimed.has(t) && fits(t));
    if (!route.length) route = spine.filter(t => !claimed.has(t));
    if (!route.length) { done(); return null; }
    const spot = spotFor(joined++, route), [px, py] = scr(spot);
    const ink = spec.ink, bg = spec.background, kept = dark ? bg : ink;
    const av = doc.createElement('div'); av.className = 'splash-join-avatar'; av.setAttribute('aria-hidden', 'true');
    Object.assign(av.style, { width: size + 'px', height: size + 'px', left: px - size / 2 + 'px', top: py - size / 2 + 'px', background: bg });
    spec.image.alt = ''; av.append(spec.image); doc.body.append(av);
    const entry = { av, done, settled: false };
    const settle = () => { if (entry.settled) return; entry.settled = true; flying.delete(entry); av.remove(); done(); };
    flying.add(entry);
    attempt(() => av.animate([{ transform: 'scale(0) rotate(-12deg)' }, { transform: 'scale(1.12) rotate(3deg)', offset: 0.65 }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.3,1)' }));
    // the halo: a ring of tiles turns over in the avatar's colours, inner ring ink, outer ring tint (swapped in dark)
    const hold = timings.joinHold, unit = 1 / ctm.a, r0 = (size / 2) * unit, r1 = r0 + T * (2.2 + 2.5 * MOTION.join);
    for (const [t, d] of near(spot.x, spot.y, r1)) {
      if (d < r0 * 0.9 || claimed.has(t)) continue;
      const c = (d - r0) / (r1 - r0) < 0.5 ? (dark ? bg : ink) : (dark ? ink : bg);
      anim(t, turnKF(t, flipZ(), c, [0.1, 0.22, 0.8, 0.9], BOUNCE), { duration: hold + 500, delay: 120 + Math.max(0, d - r0) * 9 }, false);
    }
    keepAt(spot, kept, true, hold);
    later(() => {
      const target = spec.target?.(), c = target?.getBoundingClientRect();
      if (!c?.width || !running()) { settle(); return; }
      const dx = c.left + c.width / 2 - px, dy = c.top + c.height / 2 - py, k = c.width / size;
      const a = attempt(() => av.animate([{ transform: 'none' }, { transform: `translate(${dx}px,${dy}px) scale(${k})` }], { duration: timings.joinFlight, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' }));
      if (a) a.finished.then(settle, settle); else settle();
    }, hold);
    return { colour: kept };
  }

  // ── scheduler: one 100 ms tick, armed only while motion can run (never under reduced motion, hidden or offscreen) ──
  const period = lerp(20000, 4500, I), rate = lerp(0.25, 7, I ** 1.3), cap = Math.round(lerp(6, 90, I));
  let nextCurrent = T0 + 2500, nextBranch = T0 + 6000;
  let tick = 0;
  const step = () => {
    if (!running()) return;
    const now = performance.now(); if (now < busyUntil) return;
    let n = Math.floor(rate * 0.1) + (rnd() < (rate * 0.1) % 1 ? 1 : 0);
    while (n-- > 0 && live < cap) {
      const total = AMBIENT.reduce((a, f) => a + 0.2 + f[1], 0); let r = rnd() * total;
      for (const [fx, w] of AMBIENT) { r -= 0.2 + w; if (r <= 0) { fx(); break; } }
    }
    if (now >= nextCurrent) { current(); nextCurrent = now + period / (0.5 + MOTION.current) * (0.8 + 0.4 * rnd()); }
    if (now >= nextBranch) { branch(); nextBranch = now + period * 1.4 / (0.5 + MOTION.branch) * (0.8 + 0.4 * rnd()); }
  };
  const arm = () => { const want = running(); if (want && !tick) tick = setInterval(step, 100); else if (!want && tick) { clearInterval(tick); tick = 0; } };

  // ── reduced motion, hidden and offscreen ──
  const animations = () => [...svg.getAnimations({ subtree: true }), ...[...flying].flatMap(f => f.av.getAnimations())];
  function cancelAll() {
    for (const a of animations()) attempt(() => a.cancel());
    held.clear(); for (const t of tiles) if (!claimed.has(t)) t.busy = 0;
    for (const f of [...flying]) { f.settled = true; flying.delete(f); f.av.remove(); f.done(); }
  }
  const sync = () => {
    if (closed) return;
    arm();
    if (media.matches) { cancelAll(); return; }
    const pause = doc.hidden || !visible;
    for (const a of animations()) attempt(() => (pause ? a.pause() : a.playState === 'paused' && a.play()));
  };
  const io = Observer ? new Observer(entries => { visible = entries.some(e => e.isIntersecting); sync(); }) : null;
  io?.observe(svg);
  doc.addEventListener('visibilitychange', sync); media.addEventListener('change', sync);

  refresh(); arm();
  if (arrive && running()) busyUntil = performance.now() + arrival();

  return {
    refresh, laid, current, branch, join, keep,
    stop() {
      if (closed) return;
      cancelAll(); closed = true; clearInterval(tick); tick = 0; for (const id of timers) clearTimeout(id); timers.clear();
      io?.disconnect(); doc.removeEventListener('visibilitychange', sync); media.removeEventListener('change', sync);
    },
  };
}
