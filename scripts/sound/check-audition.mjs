// Local-only audition regression checks. Run while serving the repository root.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile } from 'node:fs/promises';
const root = 'http://127.0.0.1:4179/prototypes/sound-stage/';
const base = root + 'directions.html';
const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await context.addInitScript(() => {
  const Native = window.AudioContext;
  window.__qaFilters = []; window.__qaGains = [];
  window.AudioContext = class extends Native {
    createBiquadFilter() { const node = super.createBiquadFilter(); window.__qaFilters.push(node); return node; }
    createGain() { const node = super.createGain(); window.__qaGains.push(node); return node; }
  };
});
const page = await context.newPage(), checks = {}, errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { assert(r.url().startsWith('http://127.0.0.1:4179/'), 'No external requests'); requests.push(r.url()); });
const ready = async () => { await page.goto(base); await page.locator('.track').last().waitFor(); };
const playing = () => page.waitForFunction(() => document.querySelector('#play').textContent === 'Pause');
const seek = async value => { await page.locator('#seek').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, value); await playing(); };
async function check(name, run) { if (only && only !== name) return; await run(); checks[name] = true; console.log(`PASS ${name}`); }
try {
  await ready();
  const manifest = await page.evaluate(() => fetch('./manifest.json').then(r => r.json()));
  assert.equal(manifest.tracks.length, 8);
  await check('lazy-start', async () => { assert(!requests.some(url => new URL(url).pathname.endsWith('.wav'))); await page.locator('#play').click(); await playing(); });
  await check('scrub', async () => {
    await page.locator('.track').first().getByRole('button', { name: 'Listen', exact: true }).click(); await playing();
    const box = await page.locator('#seek').boundingBox();
    await page.mouse.move(box.x + box.width * .1, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(400); await page.mouse.up(); await playing();
    assert(Number(await page.locator('#seek').inputValue()) > manifest.tracks[0].durationS * .7, 'Held pointer scrub must retain its requested position');
  });
  await check('unchanged-thumb-click', async () => {
    await page.locator('.track').first().getByRole('button', { name: 'Listen', exact: true }).click(); await playing();
    await page.locator('#stop').click();
    const box = await page.locator('#seek').boundingBox();
    await page.mouse.click(box.x + 8, box.y + box.height / 2);
    await page.locator('#play').click(); await playing(); await page.waitForTimeout(800);
    assert(Number(await page.locator('#seek').inputValue()) > .3, 'Unchanged thumb click must not freeze seek progress');
  });
  await check('tail-comparison', async () => {
    await page.locator('.track').first().getByRole('button', { name: 'Listen', exact: true }).click(); await playing();
    await seek(manifest.tracks[0].zeroS + 1.1); await page.locator('#listen-b').click(); await playing();
    const position = Number(await page.locator('#seek').inputValue());
    assert(position > manifest.tracks[1].zeroS + .9 && position < manifest.tracks[1].zeroS + 1.8, 'A/B must preserve seconds after zero');
  });
  await check('recording-bound-verdicts', async () => {
    await page.evaluate(() => localStorage.setItem('case-sound-stage-directions-v1', JSON.stringify({ schema: 2, byTrack: { 'paper-lantern': { sha256: 'old-recording', verdict: 'keep', notes: 'Earlier mix opinion' } } })));
    await ready();
    assert.equal(await page.getByRole('button', { name: 'keep Paper Lantern', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('textbox', { name: 'Notes for Paper Lantern' }).inputValue(), '');
    assert((await page.locator('.earlier-opinion').textContent()).includes('Earlier mix opinion'));
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
    const download = await downloadPromise, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.tracks[0].sha256, manifest.tracks[0].sha256); assert.equal(exported.tracks[0].verdict, 'undecided');
    assert.equal(exported.previousRecordings[0].sha256, 'old-recording');
  });
  await check('blind-preference', async () => {
    await page.locator('#blind').click(); assert.equal(await page.locator('#tracks').isVisible(), false);
    await page.locator('#listen-a').click(); await playing(); assert.equal(await page.locator('#now-playing').textContent(), 'Playing A');
    assert.equal(await page.locator('#countdown').textContent(), 'A');
    await page.locator('#listen-b').click(); await playing(); assert.equal(await page.locator('#now-playing').textContent(), 'Playing B');
    await page.locator('#prefer-b').click(); await page.locator('#blind-notes').fill('Clearer groove in B');
    await page.locator('#reveal').click();
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
    const download = await downloadPromise, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    const trial = exported.blindTrials.at(-1);
    assert.equal(trial.preference, 'B'); assert.deepEqual(trial.started, [true, true]);
    assert.equal(trial.notes, 'Clearer groove in B'); assert.equal(trial.recordings.length, 2);
    for (const recording of trial.recordings) assert.equal(recording.sha256, manifest.tracks.find(t => t.id === recording.id).sha256);
  });
  await check('failed-blind-playback', async () => {
    await ready(); await page.route('**/assets/*.wav*', route => route.abort());
    await page.locator('#blind').click();
    for (const id of ['listen-a', 'listen-b']) {
      await page.locator('#' + id).click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Could not play'));
    }
    const last = await page.evaluate(() => JSON.parse(localStorage.getItem('case-sound-stage-directions-v1')).trials.at(-1));
    assert.deepEqual(last?.started ?? [false, false], [false, false]);
    assert(await page.locator('#prefer-a').isDisabled(), 'A failed blind audition must not permit a preference');
    await page.unroute('**/assets/*.wav*');
  });
  await check('recording-integrity', async () => {
    await ready();
    const response = await page.request.get(root + manifest.tracks[0].file);
    const corrupt = Buffer.from(await response.body()); corrupt[100] ^= 1;
    await page.route('**/assets/paper-lantern.wav*', route => route.fulfill({ body: corrupt, contentType: 'audio/wav' }));
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Recording changed'), null, { timeout: 3000 });
    assert.equal(await page.locator('#play').textContent(), 'Play');
    await page.unroute('**/assets/paper-lantern.wav*');
  });
  await check('pending-stop', async () => {
    await ready(); let intercepted = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/assets/paper-lantern.wav*', async route => { intercepted = true; await gate; try { await route.continue(); } catch {} });
    await page.locator('#play').click(); await page.waitForFunction(() => document.querySelector('#play').textContent === 'Loading…');
    for (let n = 0; n < 30 && !intercepted; n++) await page.waitForTimeout(20);
    assert(intercepted); await page.locator('#stop').click(); release(); await page.waitForTimeout(250);
    assert.equal(await page.locator('#play').textContent(), 'Play');
    assert.equal(await page.locator('#position').textContent(), '0:00');
    await page.unroute('**/assets/paper-lantern.wav*');
  });
  await check('small-speaker-preview', async () => {
    await page.locator('#speaker').selectOption('small'); await page.locator('#play').click(); await playing();
    assert.equal(await page.locator('#speaker').inputValue(), 'small');
    assert(await page.evaluate(() => window.__qaFilters.some(node => node.type === 'highpass' && node.frequency.value === 120) && window.__qaGains.some(node => node.channelCountMode === 'explicit' && node.channelCount === 1)), 'Small-speaker selection must configure the real audio graph');
    await page.locator('#speaker').selectOption('full');
  });
  await check('waltz-meter', async () => {
    await page.locator('.track').last().getByRole('button', { name: 'Listen', exact: true }).click(); await playing();
    assert.equal(await page.locator('.beats i').count(), 3);
  });
  const decoded = [];
  await check('audio-levels-and-decode', async () => {
    for (const track of manifest.tracks) {
      assert(Math.abs(track.integratedLufs + 23) <= .25, `${track.id} integrated LUFS`);
      assert(track.truePeakDbtp <= -1.9, `${track.id} true peak`);
    }
    decoded.push(...await page.evaluate(async tracks => {
      const context = new OfflineAudioContext(2, 1, 44100), result = [];
      for (const track of tracks) {
        const bytes = await fetch(track.file).then(r => r.arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (hash !== track.sha256) throw Error(`WAV hash mismatch: ${track.id}`);
        const buffer = await context.decodeAudioData(bytes);
        const l = buffer.getChannelData(0), r = buffer.getChannelData(1); let peak = 0, sum = 0, mono = 0;
        for (let i = 0; i < l.length; i++) { peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i])); sum += (l[i] ** 2 + r[i] ** 2) / 2; mono += ((l[i] + r[i]) / 2) ** 2; }
        result.push({ id: track.id, sha256: track.sha256, durationS: buffer.duration, channels: buffer.numberOfChannels, samplePeakDbfs: 20 * Math.log10(peak), rmsDbfs: 10 * Math.log10(sum / l.length), monoVsStereoDb: 10 * Math.log10(mono / sum) });
      }
      return result;
    }, manifest.tracks));
    for (const track of decoded) { assert.equal(track.channels, 2); assert(track.samplePeakDbfs < -.9); assert(track.monoVsStereoDb > -.5); }
  });
  await check('accessibility-and-layout', async () => {
    await page.evaluate(() => localStorage.clear()); await ready();
    for (const colorScheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme }); const result = await new AxeBuilder({ page }).analyze(); assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []); }
    await page.emulateMedia({ colorScheme: 'light' }); await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: '/tmp/case-sound-reviewed-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/tmp/case-sound-reviewed-mobile.png', fullPage: true });
  });
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), browser: await browser.version(), manifestVersion: manifest.version, checks, decoded, limits: ['Chromium only', 'No physical room or subjective musical approval', 'Small-speaker preview is a mono 120 Hz high-pass approximation'] };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); }
