// Card 28: the braid renderer in a real browser. Splash motion obeys prefers-reduced-motion and page
// visibility; covers paint as labelled canvases without text; 24 covers render one per task.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { divingArt } from '../tests/helpers/diving-art.mjs';
import { solveArt } from '../src/shared/mosaic-geometry.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const desc = describeCase(FIXTURE);
const ART = withSolution(desc, solveArt(desc));
// A served page that only imports the renderer; the static server provides /src/client/mosaic.mjs.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mosaic</title>
<style>body{margin:0;background:#fff}#splash{width:800px;height:500px}#covers{display:grid;grid-template-columns:repeat(6,216px);gap:8px}canvas{width:216px;height:216px}</style></head>
<body><main><h1>Mosaic</h1><div id="splash"></div><div id="covers"></div></main>
<script type="module">import * as mosaic from '/src/client/mosaic.mjs'; window.mosaic = mosaic; window.mosaicReady = true;</script></body></html>`;

async function open(page) {
  await page.route('**/__mosaic.html', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('/__mosaic.html');
  await expect.poll(() => page.evaluate(() => window.mosaicReady === true)).toBe(true);
}

test('[CASE-164] splash motion runs only when allowed: zero animations under prefers-reduced-motion or Motion off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const reduced = await page.evaluate(async (art) => {
    const m = window.mosaic.mountSplash(document.getElementById('splash'), art, { motion: { intensity: 1, arrive: true }, aspect: 1.6 });
    const polygons = m.svg.querySelectorAll('polygon').length;
    m.motion.laid(6); m.motion.current(); m.motion.branch();
    await new Promise(resolve => setTimeout(resolve, 1500));        // past many ambient ticks
    const count = document.getAnimations().length;
    m.stop();
    return { polygons, count, hidden: m.svg.getAttribute('aria-hidden'), text: document.getElementById('splash').textContent };
  }, ART);
  expect(reduced.polygons).toBeGreaterThan(100);
  expect(reduced.count).toBe(0);
  expect(reduced.hidden).toBe('true');
  expect(reduced.text).toBe('');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const off = await page.evaluate(async (art) => {
    document.documentElement.dataset.motion = 'false'; // Motion off in Appearance
    const m = window.mosaic.mountSplash(document.getElementById('splash'), art, { motion: { intensity: 1, arrive: true }, aspect: 1.6 });
    m.motion.laid(6); await new Promise(resolve => setTimeout(resolve, 1500));
    const count = document.getAnimations().length; m.stop(); delete document.documentElement.dataset.motion;
    return count;
  }, ART);
  expect(off, 'Motion off behaves exactly like reduced motion').toBe(0);

  const moving = await page.evaluate(async (art) => {
    const m = window.mosaic.mountSplash(document.getElementById('splash'), art, { motion: { intensity: 1, arrive: true }, aspect: 1.6 });
    const arrived = document.getAnimations().length;
    await new Promise(resolve => setTimeout(resolve, 600));
    m.motion.laid(6); m.motion.current();
    const busy = document.getAnimations().length;
    m.stop();
    return { arrived, busy, after: document.getAnimations().length };
  }, ART);
  expect(moving.arrived).toBeGreaterThan(100);
  expect(moving.busy).toBeGreaterThan(0);
  expect(moving.after, 'stop() cancels every animation').toBe(0);
});

test('[CASE-164] splash motion pauses while the page is hidden and resumes the same animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  const counts = await page.evaluate(async (art) => {
    const m = window.mosaic.mountSplash(document.getElementById('splash'), art, { motion: { intensity: 1, arrive: true }, aspect: 1.6 });
    const original = document.getAnimations()[0];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const before = document.getAnimations().length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const hidden = document.getAnimations().filter(a => a.playState === 'running').length;
    const added = document.getAnimations().length - before;
    const paused = original?.playState === 'paused';
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    const shown = document.getAnimations().filter(a => a.playState === 'running').length;
    const resumed = original?.playState === 'running';
    m.stop();
    return { hidden, added, shown, paused, resumed, disposed: document.getAnimations().length };
  }, ART);
  expect(counts.hidden).toBe(0);
  expect(counts.added, 'no new motion starts while hidden').toBe(0);
  expect(counts.shown).toBeGreaterThan(0);
  expect(counts.paused).toBe(true);
  expect(counts.resumed).toBe(true);
  expect(counts.disposed).toBe(0);
});

test('[CASE-164] 24 covers paint as labelled canvases, one per task, cached per rendition, with no text', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async (art) => {
    const host = document.getElementById('covers');
    const items = Array.from({ length: 24 }, (_, i) => { const canvas = document.createElement('canvas'); host.append(canvas); return { canvas, art, contentSeed: `case ${i % 6}` }; });
    const done = await window.mosaic.paintCovers(items, { theme: 'light' });
    const first = items[0].canvas;
    const data = first.getContext('2d').getImageData(0, 0, first.width, first.height).data;
    const colours = new Set(); for (let i = 0; i < data.length; i += 4 * 97) colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { painted: done.filter(Boolean).length, cached: done.filter(r => r?.cached).length,
      labels: [...new Set(items.map(i => i.canvas.getAttribute('aria-label')))], roles: [...new Set(items.map(i => i.canvas.getAttribute('role')))],
      colours: colours.size, width: first.width, text: host.textContent };
  }, ART);
  expect(result.painted).toBe(24);
  expect(result.cached).toBe(18);                 // six distinct shade seeds, the rest from the cache
  expect(result.labels).toEqual(['Abstract branching mosaic artwork']);
  expect(result.roles).toEqual(['img']);
  expect(result.colours).toBeGreaterThan(10);
  expect(result.width).toBeGreaterThanOrEqual(216);
  expect(result.text).toBe('');
});


test('[CASE-274] Diving Deeper cover and full detail paint visible branches in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await open(page);
  await page.evaluate(() => { document.getElementById('splash').remove(); document.getElementById('covers').style.gridTemplateColumns = 'repeat(2, 400px)'; });
  for (const theme of ['light','dark']) {
    const result = await page.evaluate(async ({ art, theme }) => {
      const host = document.getElementById('covers'); host.replaceChildren();
      document.body.style.background = theme === 'dark' ? '#11191c' : '#ffffff';
      const items = [false,true].map(full => {
        const canvas = document.createElement('canvas'); canvas.style.width = '400px'; canvas.style.height = '400px'; host.append(canvas);
        return { canvas, art, full };
      });
      await window.mosaic.paintCovers(items, { theme, cssSize: 400, dpr: 1 });
      return items.map(({ canvas }) => {
        const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let coral = 0;
        for(let i=0;i<pixels.length;i+=4) if(pixels[i]>pixels[i+1]*1.4 && pixels[i]>pixels[i+2]*1.4) coral++;
        return { width: canvas.width, coral };
      });
    }, { art: divingArt, theme });
    for (const painted of result) { expect(painted.width).toBe(400); expect(painted.coral).toBeGreaterThan(100); }
    await page.screenshot({ path: `/tmp/case-diving-braid-${theme}.png`, fullPage: true });
  }
});
