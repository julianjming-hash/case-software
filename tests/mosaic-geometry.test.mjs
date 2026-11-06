// Card 28: the braid geometry core (src/shared/mosaic-geometry.mjs). Determinism, the colour-only
// inputs, validity (no band overlap, no fold-over), capacity, the summarised fallback and the 3:1 floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { solveArt, buildScene, prepareArt, summarisedStructure, PIGMENTS, GROUPS, THEME, ROW_SHADES, TALLY_SHADE, WOBBLE, CANONICAL } from '../src/shared/mosaic-geometry.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const MVC = describeCase(FIXTURE);
/** n decisions × a alternatives (strands rejoining the next stop), a reset every `every` decisions. */
const shape = (n, a, every = 2) => ({ v: 1, stops: n + 2, decisions: Array.from({ length: n }, (_, i) => ({
  stop: i + 1, strands: Array.from({ length: a }, () => ({ rejoin: i + 2 })), resets: every && i % every === 0 ? 1 : 0, ends: 0 })) });
const solved = (desc) => withSolution(desc, solveArt(desc));
const polys = (scene) => scene.shapes.map((s) => s.poly);

test('determinism: identical descriptor and attempt give identical geometry and colours', () => {
  const art = solved(MVC);
  assert.deepEqual(buildScene(art, { theme: 'light', group: 'sky', contentSeed: 'a' }), buildScene(art, { theme: 'light', group: 'sky', contentSeed: 'a' }));
  assert.deepEqual(solveArt(MVC), solveArt(structuredClone(MVC)));
});

test('content seed, theme and group change colour only, never geometry', () => {
  const art = solved(MVC);
  const base = buildScene(art, { theme: 'light', group: 'neutral', contentSeed: 'title one' });
  for (const opts of [{ theme: 'light', group: 'neutral', contentSeed: 'title two' }, { theme: 'dark', group: 'neutral', contentSeed: 'title one' }, { theme: 'light', group: 'coral', contentSeed: 'title one' }]) {
    const other = buildScene(art, opts);
    assert.deepEqual(polys(other), polys(base), JSON.stringify(opts));
    assert.deepEqual(other.bands, base.bands);
    assert.notDeepEqual(other.shapes.map((s) => s.fill), base.shapes.map((s) => s.fill), JSON.stringify(opts));
  }
});

test('tile density changes the tesserae, never the band geometry', () => {
  const art = solved(MVC);
  assert.deepEqual(buildScene(art, { tile: 12 }).bands, buildScene(art).bands);
  assert.notEqual(buildScene(art, { tile: 12 }).shapes.length, buildScene(art).shapes.length);
});

/** Independent validity check: bands keep clear of each other and never bend tighter than half their width. */
function assertValid(scene, label) {
  assert.deepEqual(scene.problems, [], label);
  const spine = scene.bands[0];
  const others = scene.bands.slice(1);
  const dist = (p, pts) => { let best = Infinity; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], ab = [b[0] - a[0], b[1] - a[1]]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / ((ab[0] ** 2 + ab[1] ** 2) || 1))); best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t)); } return best; };
  for (const [i, b] of others.entries()) {
    // Clear of the spine through its middle third.
    const n = b.pts.length;
    for (const p of b.pts.slice(Math.floor(n * 0.35), Math.ceil(n * 0.65))) assert.ok(dist(p, spine.pts) >= (spine.width + b.width) / 2, `${label}: band ${i} crosses the spine`);
    // No tile overlap with any other band away from the shared spine edge.
    for (const [j, o] of others.entries()) {
      if (j <= i || !b.mid?.length || !o.mid?.length) continue;
      for (const p of b.mid) assert.ok(dist(p, o.mid) >= (b.width + o.width) / 2, `${label}: bands ${i} and ${j} overlap`);
    }
    // No fold-over: the radius of curvature along the band stays at least half its width.
    for (let k = 2; k < n - 2; k += 2) {
      const [a, m, c] = [b.pts[k - 2], b.pts[k], b.pts[k + 2]];
      const area2 = Math.abs((m[0] - a[0]) * (c[1] - a[1]) - (m[1] - a[1]) * (c[0] - a[0]));
      if (area2 < 1e-9) continue;
      const radius = (Math.hypot(m[0] - a[0], m[1] - a[1]) * Math.hypot(c[0] - m[0], c[1] - m[1]) * Math.hypot(c[0] - a[0], c[1] - a[1])) / (2 * area2);
      assert.ok(radius >= b.width / 2, `${label}: band ${i} folds over (radius ${radius.toFixed(2)} < ${b.width / 2})`);
    }
  }
}

test('the MVC fixture solves without summarising, and its layout is valid', () => {
  const r = solveArt(MVC);
  assert.equal(r.summarised, false);
  assert.equal(r.unavailable, false);
  assertValid(buildScene(withSolution(MVC, r)), 'MVC');
});

test('capacity: up to 8 × 2 and 6 × 3 with resets always solve unsummarised and valid', () => {
  for (const [n, a, every] of [[8, 2, 2], [8, 2, 1], [6, 3, 2], [6, 3, 1], [5, 2, 1], [4, 3, 1]]) {
    const desc = shape(n, a, every);
    const r = solveArt(desc);
    assert.equal(r.summarised, false, `${n}×${a} (reset every ${every}) summarised`);
    assert.equal(r.unavailable, false);
    assertValid(buildScene(withSolution(desc, r)), `${n}×${a}`);
  }
});

test('fallback: 14 × 3 is summarised, valid, and draws one tally tessera per hidden route per decision', () => {
  for (const every of [2, 1]) {
    const desc = shape(14, 3, every);
    const r = solveArt(desc);
    assert.equal(r.summarised, true);
    assert.equal(r.unavailable, false);
    const scene = buildScene(withSolution(desc, r));
    assertValid(scene, `14×3 every ${every}`);
    const hidden = summarisedStructure(desc).decisions.map((d) => d.hidden);
    assert.deepEqual(hidden, desc.decisions.map((d) => d.strands.length + d.resets + d.ends - 1));
    const tallies = desc.decisions.map((_, i) => scene.shapes.filter((s) => s.tally === i).length);
    assert.deepEqual(tallies, hidden);
    // One single-row arch per decision on a summarised cover.
    assert.equal(scene.bands.length - 1, desc.decisions.length);
  }
});

test('a summarised decision without strands still counts its hidden routes', () => {
  const desc = { v: 1, stops: 4, decisions: [{ stop: 1, strands: [], resets: 2, ends: 1 }, { stop: 2, strands: [{ rejoin: 3 }], resets: 0, ends: 0 }] };
  const scene = Array.from({ length: 16 }, (_, attempt) => buildScene(withSolution(desc, { attempt, summarised: true }))).find((s) => !s.problems.length);
  assert.ok(scene, 'some summarised attempt draws');
  assert.equal(scene.shapes.filter((s) => s.tally === 0).length, 2);
  assert.equal(scene.shapes.filter((s) => s.tally === 1).length, 0);
});

// ── 3:1 on every tint, both themes ────────────────────────────────────────
const hslToRgb = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return [0, 8, 4].map((n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))); };
const lum = (rgb) => { const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every path tessera (every shade and wobble) keeps 3:1 against every group ground in both themes', () => {
  let worst = Infinity;
  for (const mode of ['light', 'dark']) {
    const theme = THEME[mode];
    for (const g of Object.values(GROUPS)) {
      const gs = mode === 'dark' ? g.s * 0.55 : g.s;
      const grounds = [];
      for (const dh of [-1, 1]) for (const ds of [-1, 1]) for (const dl of [-1, 1]) grounds.push(hslToRgb(g.h + dh * WOBBLE.ground[0], gs + ds * WOBBLE.ground[1], theme.groundL + dl * theme.groundVar));
      for (const [name, p] of Object.entries(PIGMENTS)) {
        const shades = name === 'petrol' ? [0] : [...ROW_SHADES, TALLY_SHADE];
        for (const shade of shades) for (const dh of [-1, 1]) for (const ds of [-1, 1]) for (const dl of [-1, 1]) {
          const [h, s, l] = p[mode];
          const tile = hslToRgb(h + dh * WOBBLE.path[0], s + ds * WOBBLE.path[1], Math.max(0, Math.min(100, l + shade * (mode === 'light' ? -1 : 1) + dl * WOBBLE.path[2])));
          for (const ground of grounds) {
            const r = ratio(tile, ground);
            worst = Math.min(worst, r);
            assert.ok(r >= 3, `${mode} ${name}:${shade} on group h${g.h} is ${r.toFixed(2)}:1`);
          }
        }
      }
    }
  }
  assert.ok(worst >= 3 && Number.isFinite(worst));
});

test('geometry is in canonical units: a square scene is CANONICAL wide', () => {
  const s = buildScene(solved(MVC));
  assert.equal(s.width, CANONICAL);
  assert.equal(s.height, CANONICAL);
});

test('beyond capacity the builder raises the unavailable readiness signal too, still without blocking', async () => {
  const { chainCase } = await import('./helpers/art-cases.mjs');
  const big = prepareArt(chainCase(20, 3, { resetEvery: 1 }));
  assert.deepEqual(big.readiness.map((r) => [r.code, r.blocking]), [['art_summarised', false], ['art_unavailable', false]]);
  assert.deepEqual(prepareArt(FIXTURE).readiness, []);
});
