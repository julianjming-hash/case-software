import test from 'node:test';
import assert from 'node:assert/strict';
import { coverFor } from '../src/client/library-parts.mjs';
import { BRAND_ART } from '../src/client/brand-art.mjs';
import { createCoverPainter } from '../src/client/cover-art.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('missing and invalid case artwork has a quiet decorative brand cover, while valid artwork retains its seed', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement(tag) { return { tag, classList: { add() {} }, dataset: {}, attrs: {}, children: [],
    setAttribute(name, value) { this.attrs[name] = value; }, append(...children) { this.children.push(...children); } }; } };
  try {
    for (const art of [null, undefined, { ...BRAND_ART, title: 'PRIVATE_SENTINEL' }, { ...BRAND_ART, renderer: 99 }]) {
      const items = [], cover = coverFor({ art, case_id: 'case-1', tint: 'sky' }, items);
      assert.equal(cover.dataset.art, 'brand'); assert.equal(cover.attrs['aria-hidden'], 'true');
      assert.equal(cover.children.length, 1); assert.equal(cover.children[0].tag, 'canvas');
      assert.equal(items[0].art, BRAND_ART); assert.equal(items[0].contentSeed, 'case-brand'); assert.equal(items[0].group, 'sky');
    }
    const art = { ...BRAND_ART }, items = [], cover = coverFor({ art, case_id: 'case-2', tint: 'sky' }, items);
    assert.equal(cover.dataset.art, 'case'); assert.equal(cover.attrs['aria-hidden'], undefined);
    assert.equal(items[0].art, art); assert.equal(items[0].contentSeed, 'case-2');
  } finally { globalThis.document = previous; }
});

test('a lazy cover batch uses the current theme after loading and preserves explicit preview themes', async () => {
  const pending = deferred(), calls = []; let theme = 'light', loads = 0, clears = 0;
  const painter = createCoverPainter(() => { loads++; return pending.promise; });
  const one = painter.paintCovers([{ canvas: {} }]); const two = painter.paintCovers([{ canvas: {} }], { theme: 'light', cssSize: 200 });
  theme = 'dark'; pending.resolve({ currentTheme: () => theme, paintCovers: (items, opts) => calls.push(opts), clearCoverCache: () => clears++ });
  await Promise.all([one, two]); assert.equal(loads, 1); assert.deepEqual(calls.map(call => call.theme), ['dark', 'light']);
  painter.clearCoverCache(); assert.equal(clears, 1);
});

test('a newer cover paint supersedes the previous batch and detached canvases never paint', async () => {
  const calls = [], canvas = { isConnected: true };
  const painter = createCoverPainter(async () => ({ currentTheme: () => 'light', paintCovers: (items, opts) => { calls.push(opts); } }));
  await painter.paintCovers([{ canvas }]); assert.equal(calls[0].isCurrent(canvas), true);
  await painter.paintCovers([{ canvas }], { theme: 'dark' });
  assert.equal(calls[0].isCurrent(canvas), false); assert.equal(calls[1].isCurrent(canvas), true);
  canvas.isConnected = false; assert.equal(calls[1].isCurrent(canvas), false);
});

test('a failed lazy renderer leaves a quiet reserved cover and a later paint can load again', async () => {
  let loads = 0, painted = 0;
  const painter = createCoverPainter(async () => { if (++loads === 1) throw new Error('offline'); return { currentTheme: () => 'light', paintCovers: () => ++painted }; });
  const canvas = {}; assert.deepEqual(await painter.paintCovers([{ canvas }]), []);
  assert.deepEqual(canvas, {}); await painter.paintCovers([{ canvas }]); assert.equal(loads, 2); assert.equal(painted, 1);
});
