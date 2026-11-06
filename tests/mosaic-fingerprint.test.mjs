// Card 28 red-team fix 1: published art never changes silently. Each renderer version's geometry and
// colours are pinned by a golden fingerprint of buildScene output. Changing the geometry core fails
// here until RENDERER_VERSION is bumped, the old geometry is kept reachable under its old version,
// and a new golden row is added (old rows are never edited).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describeCase, withSolution, ART_RENDERERS } from '../src/shared/art-descriptor.mjs';
import { solveArt, buildScene, RENDERER_VERSION } from '../src/shared/mosaic-geometry.mjs';
import { chainCase } from './helpers/art-cases.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
// Structures only (chainCase ids are random, the descriptor is not).
const CASES = { mvc: describeCase(FIXTURE), c8x2: describeCase(chainCase(8, 2, { resetEvery: 2 })),
  c6x3: describeCase(chainCase(6, 3, { resetEvery: 1 })), c14x3: describeCase(chainCase(14, 3, { resetEvery: 2 })) };
const GOLDEN = {
  1: { mvc: '04661421b9d92dbe110d0bf78c858fb9800a5463b07a950fddb6bd6ea8ee11a6',
    c8x2: '8a88501132187cb6b7c5f1f182baba9fda488ec40f861f0462214cb97ab94dbe',
    c6x3: 'f1a306a6f6d1afe745db33d8fffb7badee5d3e9877e1615710900032df2a9528',
    c14x3: 'eeda882620631f81a5dded91e7f151311ca0549bd3f29599aae5a2eb79b19f4d' },
};
const r6 = (n) => Number(n.toFixed(6));
function fingerprint(art) {
  const out = [];
  // Every buildScene option: theme, group, content seed, tile density, aspect (wide and tall), and splash
  // focus regions that take both the tall and the wide spine branch.
  for (const opts of [{ theme: 'light', group: 'neutral', contentSeed: 'golden' }, { theme: 'dark', group: 'sky', contentSeed: 'golden', tile: 11, aspect: 1.6 },
    { theme: 'light', group: 'coral', contentSeed: 'golden', aspect: 1.6, focus: [0.55, 0.1, 0.95, 0.9] },
    { theme: 'dark', group: 'plum', contentSeed: 'golden', aspect: 1.6, focus: [0.05, 0.3, 0.95, 0.7] },
    { theme: 'light', group: 'olive', contentSeed: 'golden', aspect: 0.6, tile: 20 },
    { theme: 'light', group: 'neutral', contentSeed: 'golden', validateOnly: true }]) {
    const scene = buildScene(art, opts);
    out.push(scene.problems, scene.shapes.map((s) => [s.poly.map((p) => p.map(r6)), s.fill, s.l, s.layer]), scene.bands.map((b) => [b.kind, r6(b.width), b.pts.map((p) => p.map(r6))]));
  }
  return createHash('sha256').update(JSON.stringify(out)).digest('hex');
}

test('the current renderer is the newest supported version and has a golden row', () => {
  assert.equal(RENDERER_VERSION, ART_RENDERERS.at(-1));
  assert.deepEqual(Object.keys(GOLDEN).map(Number), [...ART_RENDERERS]);
});

test('every supported renderer version still draws exactly its golden geometry', () => {
  for (const version of ART_RENDERERS) {
    for (const [name, desc] of Object.entries(CASES)) {
      const solved = solveArt(desc);
      const art = withSolution(desc, { ...solved, renderer: version });
      assert.equal(fingerprint(art), GOLDEN[version][name], `renderer ${version} ${name}: geometry changed; bump RENDERER_VERSION and keep this version reachable`);
    }
  }
});

test('an unknown renderer version is refused explicitly, never re-solved or redrawn with the current geometry', () => {
  const art = withSolution(CASES.mvc, { ...solveArt(CASES.mvc), renderer: 99 });
  const scene = buildScene(art);
  assert.deepEqual(scene.problems, ['unknown_renderer']);
  assert.equal(scene.refused, true);
  assert.deepEqual(scene.shapes, []);
});
