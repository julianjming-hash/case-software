// Splash motion and composition (Julian's motion lab, 2026-10-10): the approved settings and token timings, the free
// region and solve order that keep the braid from sitting mainly behind a card, room-code typing that reads only the
// count, and the motion engine's guards (reduced motion or Motion off ⇒ zero animations; stop() cancels everything).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOTION, ART_TIMINGS, startMotion } from '../src/client/splash-motion.mjs';
import { freeRegion, composeArt, buildSplash } from '../src/client/mosaic.mjs';
import { BRAND_ART, BRAND_COMPACT } from '../src/client/brand-art.mjs';
import { typedLength, watchCodeLength } from '../src/client/phone-join-code.mjs';
import { reducedMotion } from '../src/client/appearance-watch.mjs';
import { readDevicePreferences, DEVICE_PREFERENCE_KEYS } from '../src/client/device-preference-values.mjs';
import { TEARDOWN_KEYS } from '../src/client/teardown.mjs';
import { buildScene } from '../src/shared/mosaic-geometry.mjs';
import { validArtDescriptor } from '../src/shared/art-descriptor.mjs';

const TEN_STOP = { v: 1, stops: 10, decisions: [{ stop: 1, strands: [{ rejoin: 3 }, { rejoin: 2 }], resets: 0, ends: 1 }, { stop: 3, strands: [{ rejoin: 5 }], resets: 1, ends: 0 },
  { stop: 5, strands: [{ rejoin: 7 }, { rejoin: 6 }], resets: 0, ends: 0 }, { stop: 7, strands: [{ rejoin: 9 }], resets: 1, ends: 1 }], attempt: 11, summarised: false, renderer: 1 };

test('[splash-motion] the engine runs Julian\'s approved settings, and its timings are the tokens in tokens.css', () => {
  assert.deepEqual({ ...MOTION }, { intensity: 0.7, phoneIntensity: 0.3, flip: 0.2, flipCluster: 0.2, wiggle: 0.3, lift: 0.3, twinkle: 0.5, current: 0.5, branch: 0.29, join: 0.1 });
  const css = readFileSync(new URL('../src/client/tokens.css', import.meta.url), 'utf8');
  const token = name => Number(new RegExp(`--art-${name}:\\s*(\\d+)ms`).exec(css)?.[1]);
  assert.deepEqual({ ...ART_TIMINGS }, { arrivalTile: token('arrival-tile'), arrivalSpan: token('arrival-span'), current: token('current'), lay: token('lay'),
    joinHold: token('join-hold'), joinFlight: token('join-flight'), joinQueue: token('join-queue') });
  assert.equal(ART_TIMINGS.joinQueue, 400); assert.equal(ART_TIMINGS.joinHold, 1500);
  assert.doesNotMatch(css, /--art-(assemble|ripple|shimmer)/, 'the whole-art breath and its timings are gone');
});

test('[splash-motion] the free region is the largest area the cards and bars leave', () => {
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const stage = rect(0, 0, 1920, 1080);
  // the projector lobby: top bar, footer, slim card on the left ⇒ the art takes the right, between the bars
  const lobby = freeRegion(stage, [rect(0, 0, 1920, 60), rect(0, 980, 1920, 100), rect(58, 80, 634, 880)]);
  assert.ok(lobby[0] > 692 / 1920 && lobby[1] > 60 / 1080 && lobby[3] < 980 / 1080, JSON.stringify(lobby));
  // a phone card across the top ⇒ the art takes the band below it
  const phone = freeRegion(rect(0, 0, 390, 800), [rect(20, 20, 350, 330)]);
  assert.ok(phone[1] > 350 / 800 && phone[3] <= 0.98, JSON.stringify(phone));
  // A band below a card, taller than wide, is trimmed about its centre to 4:5 so the route runs across it.
  const tall = freeRegion(rect(0, 0, 343, 748), [rect(0, 0, 343, 424)]);
  assert.ok(Math.abs((tall[3] - tall[1]) * 748 - 0.8 * (tall[2] - tall[0]) * 343) < 1, JSON.stringify(tall));
  assert.ok(tall[1] > 424 / 748, 'the trimmed band stays below the card');
  assert.equal(freeRegion(stage, []), null, 'nothing over the art: no region');
  assert.equal(freeRegion(stage, [rect(3000, 0, 100, 100)]), null, 'a cover outside the stage is ignored');
  // A card filling the stage leaves only slivers: no region (the art is not squeezed into thousands of tiny tiles).
  assert.equal(freeRegion(rect(0, 0, 320, 568), [rect(0, 10, 320, 550)]), null);
  assert.equal(freeRegion(rect(0, 0, 568, 320), [rect(60, 0, 450, 320)]), null);
  assert.equal(freeRegion(stage, [rect(0, 0, 1920, 1080)]), null, 'a full-stage bar never yields an inverted region');
});

test('[splash-motion] composition tries the stored attempt, the others, the compact brand braid, then the summarised braid', () => {
  // A wide open region: one of the brand braid's own attempts fits (the compact braid is only for narrow bands).
  const open = composeArt(BRAND_ART, { aspect: 1.6, focus: [0.3, 0.04, 0.98, 0.96], compact: BRAND_COMPACT });
  assert.ok(['stored', 'attempt'].includes(open.how), open.how);
  assert.equal(open.art.stops, BRAND_ART.stops);
  assert.equal(validArtDescriptor(open.art), true);
  // A summarised case that fits as stored keeps its stored attempt.
  const stored = { ...TEN_STOP, stops: 5, decisions: [{ stop: 1, strands: [{ rejoin: 2 }, { rejoin: 2 }], resets: 1, ends: 0 }, { stop: 2, strands: [{ rejoin: 3 }, { rejoin: 3 }], resets: 0, ends: 0 }, { stop: 3, strands: [{ rejoin: 4 }, { rejoin: 4 }], resets: 0, ends: 0 }], attempt: 2, summarised: true };
  assert.equal(composeArt(stored, { aspect: 1.6, focus: [0.49, 0.49, 0.51, 0.51] }).how, 'stored');
  // A phone-width band: the brand braid's plaits cannot bend there, so the compact brand braid is drawn.
  const band = composeArt(BRAND_ART, { aspect: 0.46, focus: [0.05, 0.62, 0.95, 0.98], compact: BRAND_COMPACT });
  assert.equal(band.how, 'compact');
  assert.equal(band.art.stops, BRAND_COMPACT.stops);
  assert.deepEqual(buildScene(band.art, { aspect: 0.46, focus: [0.05, 0.62, 0.95, 0.98] }).problems, []);
  // A case never gets the brand's compact braid; the ten-stop case in the slim-card lobby is summarised or inset.
  const lobby = composeArt(TEN_STOP, { aspect: 1.78, focus: [0.39, 0.08, 0.98, 0.86] });
  assert.ok(['stored', 'attempt', 'summarised', 'inset'].includes(lobby.how), lobby.how);
  assert.notEqual(lobby.art.stops, BRAND_COMPACT.stops);
  // Every try is the published structure and renderer: the descriptor itself is never changed.
  for (const plan of [open, band, lobby]) assert.equal(plan.art.renderer, 1);
  assert.equal(BRAND_ART.attempt, 0); assert.equal(TEN_STOP.attempt, 11); assert.equal(TEN_STOP.summarised, false);
});

test('[splash-motion] the last resort draws the art whole inside the region', () => {
  const made = [];
  const doc = { createElementNS: (ns, tag) => { const n = { tag, attrs: {}, dataset: {}, style: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); }, get firstChild() { return this.children[0]; } }; made.push(n); return n; } };
  const svg = buildSplash(doc, TEN_STOP, { aspect: 1.6, focus: [0.1, 0.1, 0.12, 0.9] });
  assert.equal(svg.dataset.how, 'inset');
  assert.equal(svg.attrs.preserveAspectRatio, 'none');
  const [x, y, w, h] = svg.attrs.viewBox.split(' ').map(Number);
  assert.ok(x < 0 && w > 0 && h > 0 && Math.abs(w / h - 1.6) < 0.02, svg.attrs.viewBox);
  assert.ok(made.filter(n => n.tag === 'polygon').length < 8000, 'the region shape is clamped, so a sliver never builds a giant scene');
});

test('[splash-motion] a stage longer than a phone grows its tesserae instead of multiplying them (the braid is unchanged)', () => {
  const tiles = aspect => { let n = 0; const doc = { createElementNS: (ns, tag) => { if (tag === 'polygon') n++; return { attrs: {}, dataset: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; }, append() {} }; } };
    const svg = buildSplash(doc, BRAND_ART, { aspect, compact: BRAND_COMPACT }); return { n, how: svg.dataset.how }; };
  const phone = tiles(0.46), tall = tiles(0.2);
  assert.ok(tall.n < phone.n * 1.5, `0.2:1 stage draws ${tall.n} tiles vs ${phone.n} at phone shape`);
});

test('[splash-motion] room-code typing reads the input length only, never a character', () => {
  const poisoned = { length: 4 };
  for (let i = 0; i < 12; i++) Object.defineProperty(poisoned, i, { get() { throw new Error('a character was read'); } });
  for (const name of ['toString', 'valueOf', Symbol.toPrimitive, Symbol.iterator]) poisoned[name] = () => { throw new Error('a character was read'); };
  const listeners = {};
  const code = { value: poisoned, addEventListener(type, fn) { listeners[type] = fn; } };
  assert.equal(typedLength(code), 4);
  const seen = [];
  watchCodeLength(code, n => seen.push(n));
  listeners.input();
  code.value = { length: 9 }; listeners.input();
  code.value = { length: 0 }; listeners.input();
  assert.deepEqual(seen, [4, 6, 0], 'clamped to the six code characters');
});

test('[splash-motion] Motion off is a device preference that reads as reduced motion everywhere', () => {
  assert.equal(DEVICE_PREFERENCE_KEYS.motion, 'case:preferences:motion');
  assert.ok(TEARDOWN_KEYS.preferences.includes('case:preferences:motion'), 'kept across sign-out and room teardown');
  const store = values => ({ getItem: key => values[key] ?? null });
  assert.equal(readDevicePreferences(store({})).motion, true, 'motion is on by default');
  assert.equal(readDevicePreferences(store({ 'case:preferences:motion': 'false' })).motion, false);
  const attrs = {}, listeners = new Map();
  const win = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    document: { documentElement: { getAttribute: k => attrs[k] ?? null, dataset: {} } },
    addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: t => listeners.delete(t) };
  const reduced = reducedMotion(win);
  assert.equal(reduced.matches, false);
  attrs['data-motion'] = 'false';
  assert.equal(reduced.matches, true, 'data-motion="false" (Motion off) reads exactly as prefers-reduced-motion');
  const fn = () => {}; reduced.addEventListener('change', fn); assert.ok(listeners.has('storage'));
  reduced.removeEventListener('change', fn); assert.equal(listeners.size, 0, 'no listener outlives its subscriber');
  const boot = readFileSync(new URL('../src/client/appearance-boot.mjs', import.meta.url), 'utf8');
  assert.match(boot, /getItem\('case:preferences:motion'\) === 'false'\) root\.setAttribute\('data-motion', 'false'\)/, 'applied before first paint');
});

// ── the engine against a recording fake SVG ──
function rig({ reduced = false, hidden = false } = {}) {
  const animations = [], docListeners = new Map(), mediaListeners = new Set();
  const animate = function (frames, options) {
    const a = { frames, options, playState: 'running', listeners: {}, target: this,
      addEventListener(t, fn) { this.listeners[t] = fn; }, pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; },
      cancel() { this.playState = 'idle'; this.listeners.cancel?.(); }, reverse() {}, finished: new Promise(() => {}) };
    animations.push(a); return a;
  };
  const polygons = Array.from({ length: 240 }, (_, i) => {
    const l = i % 4 === 0 ? 'm' : i % 4 === 1 ? 'b' : i % 4 === 2 ? 'o' : 'g', x = (i % 20) * 10, y = Math.floor(i / 20) * 10;
    return { dataset: { l, s: ((i % 20) / 20).toFixed(2) }, style: {}, animate,
      getAttribute: k => (k === 'points' ? `${x},${y} ${x + 8},${y} ${x + 8},${y + 8} ${x},${y + 8}` : 'hsl(190 40% 50%)'), setAttribute() {} };
  });
  const doc = { hidden, body: { append() {} }, defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    addEventListener: (t, fn) => docListeners.set(t, fn), removeEventListener: t => docListeners.delete(t) };
  const media = { matches: reduced, addEventListener: (t, fn) => mediaListeners.add(fn), removeEventListener: (t, fn) => mediaListeners.delete(fn) };
  const svg = { ownerDocument: doc, querySelectorAll: () => polygons, querySelector: () => null, getAttribute: () => '1',
    getAnimations: () => animations.filter(a => a.playState !== 'idle'), getScreenCTM: () => null, getBoundingClientRect: () => ({ width: 0 }) };
  return { svg, doc, media, animations, docListeners, mediaListeners, running: () => animations.filter(a => a.playState !== 'idle').length };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('[splash-motion] reduced motion or Motion off ⇒ zero animations: no arrival, no ambient life, no lay, no join', async () => {
  const r = rig({ reduced: true });
  const motion = startMotion(r.svg, { intensity: 1, arrive: true, doc: r.doc, media: r.media, Observer: null });
  motion.laid(6); motion.current(); motion.branch();
  let landed = 0; assert.equal(motion.join({ image: {}, ink: '#000', background: '#fff', landed: () => landed++ }), null);
  await wait(450);
  assert.equal(r.animations.length, 0);
  assert.equal(landed, 1, 'a join under reduced motion lands at once, so the count still updates');
  motion.stop();
});

test('[splash-motion] arrival lays the art once, ambient life follows, and stop() cancels every animation and listener', async () => {
  const r = rig();
  const motion = startMotion(r.svg, { intensity: 1, arrive: true, doc: r.doc, media: r.media, Observer: null });
  assert.equal(r.running(), 180, 'every route, outline and branch tile is laid on arrival (the ground fades as one layer)');
  assert.ok(r.animations.every(a => a.target.dataset.l !== 'g'), 'no ground tile animates on its own during arrival');
  motion.laid(3);
  assert.ok(r.animations.some(a => a.options.fill === 'forwards'), 'typing holds its laid sixths');
  await wait(350);
  motion.stop();
  assert.equal(r.running(), 0, 'stop() cancels every animation');
  assert.equal(r.docListeners.size, 0); assert.equal(r.mediaListeners.size, 0);
  const after = r.animations.length; await wait(250);
  assert.equal(r.animations.length, after, 'no tick runs after stop()');
});

test('[splash-motion] turning reduced motion on mid-way cancels everything; hidden pauses instead', async () => {
  const r = rig();
  const motion = startMotion(r.svg, { arrive: true, doc: r.doc, media: r.media, Observer: null });
  r.doc.hidden = true; r.docListeners.get('visibilitychange')();
  assert.ok(r.animations.every(a => a.playState === 'paused'), 'hidden pauses');
  r.doc.hidden = false; r.docListeners.get('visibilitychange')();
  assert.ok(r.animations.every(a => a.playState === 'running'), 'visible resumes the same animations');
  r.media.matches = true; for (const fn of r.mediaListeners) fn();
  assert.equal(r.running(), 0, 'reduced motion cancels');
  motion.stop();
});

test('[splash-motion] the motion sources contain no HTML parsing sink and never read a code character', () => {
  for (const file of ['../src/client/splash-motion.mjs', '../src/client/splash.mjs', '../src/client/appearance-watch.mjs']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write|srcdoc/, file);
  }
  assert.doesNotMatch(readFileSync(new URL('../src/client/splash-motion.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''), /seed|hash\(|rng\(/, 'motion is random, never seeded per case');
});
