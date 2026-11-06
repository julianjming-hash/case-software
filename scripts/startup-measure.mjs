// Local exact-build startup distributions. Run explicitly; never reaches a deployed origin.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homeUrl, casesUrl, joinUrl, sessionUrl } from '../src/shared/urls.mjs';

const samples = Number(process.env.CASE_STARTUP_SAMPLES || 20);
const output = process.env.CASE_STARTUP_OUTPUT;
const root = process.env.CASE_STARTUP_ROOT || process.cwd();
const { startLocalWorker, createRoom } = await import(pathToFileURL(join(root, 'tests/helpers/local-worker.mjs')));
const requestedSurfaces = process.env.CASE_STARTUP_SURFACES?.split(',');
const requestedModes = process.env.CASE_STARTUP_MODES?.split(',') || ['cold-uncontrolled', 'warm-uncontrolled', 'warm-controlled', 'offline-controlled'];
if (!Number.isInteger(samples) || samples < 5 || samples > 50 || !output) throw new Error('startup_measure_options');
const conditions = { latencyMs: 75, downloadBytesPerSecond: 1_000_000, uploadBytesPerSecond: 500_000,
  cpuSlowdown: 4, viewport: { width: 390, height: 844 }, motion: 'reduce', observationAfterControlsMs: 500 };
const worker = await startLocalWorker();
let browser;
const result = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  date: new Date().toISOString(), samples, conditions, browser: null, buildFingerprint: null,
  definitions: { publicPaint: 'browser first-contentful-paint', controls: 'first visible enabled target DOM control; Cases is signed-out form only',
    art: 'first visible SVG under reduced motion; not animation completion', observation: 'through 500ms after controls or unavailable UI',
    uncontrolled: 'SW registration blocked, HTTP cache cold or warm as named; not first-install competition',
    controlled: 'shell cache warmed, controller confirmed before measurement',
    offline: 'HTTP offline plus new local API WebSocket blocked; zero successful API responses required' },
  snapshotDefinition: 'validated participant Waiting to start UI; network receipt alone does not prove acceptance',
  states: [] };
try {
  const fingerprint = createHash('sha256');
  for (const file of ['index.html', 'sw.mjs', ...(await readdir(join(worker.assetDir, 'assets'))).sort().map(file => `assets/${file}`)]) {
    fingerprint.update(file); fingerprint.update(await readFile(join(worker.assetDir, file)));
  }
  result.buildFingerprint = fingerprint.digest('hex');
  browser = await chromium.launch(); result.browser = browser.version();
  const room = await createRoom(worker.origin);
  const joined = await fetch(`${worker.origin}/api/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName: 'Local measurement', avatarId: 'shadows-01' }) });
  if (!joined.ok) throw new Error('local_join_failed');
  const participant = await joined.json();
  const surfaces = [
    { name: 'root', url: homeUrl(worker.origin), controls: '#roomCode', art: '.home-art svg' },
    { name: 'cases-signed-out', url: casesUrl(worker.origin), controls: 'form.auth-form input[type=email]', art: '.auth-art svg' },
    { name: 'join', url: joinUrl(room.joinCode, worker.origin), controls: '.join-name input', art: '.phone-splash svg' },
    { name: 'participant-snapshot', url: sessionUrl(room.sessionId, 'play', worker.origin), controls: '#lobbyH',
      art: '.phone-splash svg', credential: { sessionId: room.sessionId, token: participant.token,
        expiresAt: Date.now() + 3_600_000 } },
  ];
  if (requestedSurfaces?.some(name => !surfaces.some(surface => surface.name === name)) || requestedModes.some(mode => !['cold-uncontrolled', 'warm-uncontrolled', 'warm-controlled', 'offline-controlled'].includes(mode))) throw new Error('startup_measure_scope');
  for (const surface of surfaces.filter(surface => !requestedSurfaces || requestedSurfaces.includes(surface.name))) for (const mode of requestedModes) {
    const rows = [];
    for (let i = 0; i < samples; i++) {
      const controlled = mode.endsWith('controlled') && !mode.endsWith('uncontrolled');
      const context = await browser.newContext({ serviceWorkers: controlled ? 'allow' : 'block',
        viewport: conditions.viewport, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const successfulApi = [];
      page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/') && response.ok()) successfulApi.push(true); });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: conditions.latencyMs,
        downloadThroughput: conditions.downloadBytesPerSecond, uploadThroughput: conditions.uploadBytesPerSecond });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpuSlowdown });
      await context.addInitScript(({ surface }) => {
        if (surface.credential) localStorage.setItem('case:participant:main:token', JSON.stringify(surface.credential));
        const data = globalThis.__startupMeasure = { controls: null, art: null, longTasks: [], shifts: [] };
        new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
        new PerformanceObserver(list => data.shifts.push(...list.getEntries().filter(e => !e.hadRecentInput).map(e => ({ start: e.startTime, value: e.value })))).observe({ type: 'layout-shift', buffered: true });
        const observe = () => {
          const visible = selector => { const node = document.querySelector(selector); return node && node.getClientRects().length && !node.disabled; };
          if (data.controls === null && visible(surface.controls)) data.controls = performance.now();
          if (data.art === null && visible(surface.art)) data.art = performance.now();
        };
        new MutationObserver(observe).observe(document, { childList: true, subtree: true, attributes: true });
        addEventListener('DOMContentLoaded', observe);
      }, { surface });
      if (mode !== 'cold-uncontrolled') {
        await page.goto(surface.url); await page.locator(surface.controls).waitFor({ state: 'visible' });
        if (controlled) {
          await page.evaluate(() => navigator.serviceWorker.ready);
          await page.reload();
          if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) throw new Error('uncontrolled_warmup');
        }
      }
      if (mode === 'offline-controlled') {
        // Existing/new WebSockets are outside Chromium's HTTP throughput emulation. Keep both
        // transports unavailable rather than mislabelling an online room snapshot as offline.
        await context.routeWebSocket('**/api/**', socket => socket.close());
        await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: conditions.latencyMs,
          downloadThroughput: 0, uploadThroughput: 0 });
        await context.setOffline(true);
        successfulApi.length = 0;
      }
      let failure = null;
      try { await page.goto(surface.url); await page.waitForFunction(offlineSnapshot => __startupMeasure.controls !== null || /Recovery unavailable|Answer storage unavailable/.test(document.querySelector('main')?.textContent ?? '') || offlineSnapshot && document.querySelector('#mh')?.textContent === 'Checking the room…', mode === 'offline-controlled' && surface.name === 'participant-snapshot', { timeout: 15_000 });
        if (!await page.evaluate(() => __startupMeasure.controls !== null)) failure = 'controls_unavailable'; }
      catch { failure = 'controls_unavailable'; }
      await page.waitForTimeout(conditions.observationAfterControlsMs);
      rows.push(await page.evaluate(({ failure, snapshot }) => {
        const data = __startupMeasure, entries = performance.getEntriesByType('resource');
        return { failure, browserOnline: navigator.onLine, controlled: Boolean(navigator.serviceWorker.controller),
          publicPaintMs: performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime ?? null,
          controlsMs: data.controls, acceptedSnapshotMs: snapshot ? data.controls : null, artMs: data.art,
          criticalRequests: entries.filter(e => e.startTime <= (data.controls ?? Infinity)).map(e => ({
            // IDs, room codes, credentials and response bodies never enter the output.
            asset: e.name.includes('/assets/') ? new URL(e.name).pathname : 'public-document-or-local-api',
            start: e.startTime, end: e.responseEnd, transferBytes: e.transferSize, initiator: e.initiatorType })),
          longTasks: data.longTasks, layoutShift: data.shifts.reduce((sum, e) => sum + e.value, 0) };
      }, { failure, snapshot: surface.name === 'participant-snapshot' }));
      if (mode === 'offline-controlled' && successfulApi.length) throw new Error('offline_api_succeeded');
      await context.close();
    }
    const stats = field => {
      const values = rows.map(row => row[field]).filter(Number.isFinite).sort((a, b) => a - b);
      return { n: values.length, median: values.length ? values[Math.floor(values.length / 2)] : null,
        p95: values.length ? values[Math.ceil(values.length * .95) - 1] : null };
    };
    result.states.push({ surface: surface.name, mode, failures: rows.filter(row => row.failure).length,
      summary: Object.fromEntries(['publicPaintMs', 'controlsMs', 'acceptedSnapshotMs', 'artMs', 'layoutShift'].map(field => [field, stats(field)])), rows });
    await writeFile(output, JSON.stringify(result, null, 2));
    console.log(`${surface.name} ${mode}: ${rows.length} samples; ${rows.filter(row => row.failure).length} unavailable`);
  }
} finally { await browser?.close(); await worker.stop(); }
