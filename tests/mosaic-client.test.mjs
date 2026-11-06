// Card 28: the client renderer (src/client/mosaic.mjs) stays text-free. Its DOM output is built node by
// node (no HTML parsing sinks), its cache key carries no text, and splash art is decorative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSplash, coverKey, ART_LABEL, paintCovers, clearCoverCache } from '../src/client/mosaic.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { solveArt, buildScene } from '../src/shared/mosaic-geometry.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const desc = describeCase(FIXTURE);
const ART = withSolution(desc, solveArt(desc));

test('yielded cover painting checks cancellation and disconnection before geometry and before drawing', async () => {
  const previous = globalThis.scheduler, previousCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    getContext() { return { fillRect() {}, beginPath() {}, lineTo() {}, moveTo() {}, closePath() {}, fill() {}, stroke() {} }; }
    transferToImageBitmap() { return { close() {} }; }
  };
  try {
    for (const afterGeometry of [false, true]) for (const disconnected of [false, true]) {
      const tasks = []; let current = true, writes = 0;
      clearCoverCache();
      globalThis.scheduler = { postTask(resolve) { tasks.push(resolve); } };
      const canvas = { isConnected: true, getBoundingClientRect: () => ({ width: 216 }), setAttribute() { writes++; },
        getContext: () => ({ drawImage() { writes++; } }) };
      const painting = paintCovers([{ canvas, art: ART }], { isCurrent: () => current });
      if (afterGeometry) { tasks.shift()(); await new Promise(resolve => setImmediate(resolve)); }
      if (disconnected) canvas.isConnected = false; else current = false;
      tasks.shift()();
      await new Promise(resolve => setImmediate(resolve));
      while (tasks.length) { tasks.shift()(); await new Promise(resolve => setImmediate(resolve)); }
      assert.deepEqual(await painting, [null]); assert.equal(writes, 0);
    }
  } finally { clearCoverCache(); globalThis.scheduler = previous; globalThis.OffscreenCanvas = previousCanvas; }
});

/** A minimal SVG document: enough to record what the renderer creates. */
function fakeDoc() {
  const made = [];
  const node = (ns, tag) => {
    const n = { ns, tag, attrs: {}, children: [], dataset: {}, style: {},
      setAttribute(k, v) { assert.equal(typeof v, 'string'); this.attrs[k] = v; },
      append(...c) { this.children.push(...c); } };
    made.push(n);
    return n;
  };
  return { made, createElementNS: node, createElement() { throw new Error('HTML element created'); }, createTextNode() { throw new Error('text node created'); } };
}

test('the renderer sources contain no HTML parsing sink', () => {
  for (const file of ['../src/client/mosaic.mjs', '../src/shared/mosaic-geometry.mjs', '../src/shared/art-descriptor.mjs']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write|srcdoc/, file);
  }
});

test('splash art is decorative SVG built with createElementNS, one polygon per tessera and no text', () => {
  const doc = fakeDoc();
  const svg = buildSplash(doc, ART, { aspect: 1.6, theme: 'dark', group: 'sky', contentSeed: FIXTURE.title });
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.equal(svg.attrs.role, undefined);
  assert.ok(doc.made.every((n) => n.ns === 'http://www.w3.org/2000/svg'));
  const polygons = doc.made.filter((n) => n.tag === 'polygon');
  const scene = buildScene(ART, { aspect: 1.6, theme: 'dark', group: 'sky', contentSeed: FIXTURE.title });
  assert.equal(scene.problems.length ? buildScene(ART).shapes.length : scene.shapes.length, polygons.length);
  for (const p of polygons) {
    assert.deepEqual(Object.keys(p.attrs).sort(), ['fill', 'points']);
    assert.match(p.attrs.points, /^[-0-9., ]+$/);
    assert.match(p.attrs.fill, /^hsl\([0-9. %]+\)$/);
  }
  assert.ok(!JSON.stringify(doc.made.map((n) => [n.attrs, n.dataset])).includes(FIXTURE.title));
});

test('an invalid descriptor paints nothing', () => {
  const doc = fakeDoc();
  const svg = buildSplash(doc, { ...ART, label: 'x' });
  assert.equal(doc.made.filter((n) => n.tag === 'polygon').length, 0);
  assert.equal(svg.attrs['aria-hidden'], 'true');
});

test('the cover cache key is numbers and fixed keywords only, and separates every rendition input', () => {
  const key = coverKey(ART, { theme: 'dark', size: 432, group: 'coral', contentSeed: FIXTURE.title });
  assert.ok(!key.includes(FIXTURE.title));
  assert.match(key, /^[0-9a-z|:.,]+$/);
  const variants = [{ theme: 'light' }, { size: 216 }, { group: 'sky' }, { contentSeed: 'Other title' }];
  for (const v of variants) assert.notEqual(coverKey(ART, { theme: 'dark', size: 432, group: 'coral', contentSeed: FIXTURE.title, ...v }), key, JSON.stringify(v));
  assert.notEqual(coverKey({ ...ART, attempt: (ART.attempt + 1) % 16 }, { theme: 'dark', size: 432, group: 'coral', contentSeed: FIXTURE.title }), key);
  assert.equal(coverKey(ART, { group: 'not-a-group' }), coverKey(ART, { group: 'neutral' }), 'an unknown tint falls back to neutral');
  assert.equal(ART_LABEL, 'Abstract branching mosaic artwork');
});
