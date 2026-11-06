import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createUiTonePlayer, toneKindFor, UI_TONE_FOR } from '../src/client/console-tones.mjs';

const URLS = { 'ui-press': '/assets/ui-press.a.wav', 'ui-open': '/assets/ui-open.b.wav', 'ui-close': '/assets/ui-close.c.wav' };
function rig({ fetchImpl, on = false } = {}) {
  const log = { fetched: [], played: [], tones: 0 };
  const state = { on, reduced: false, hidden: false, ctx: { state: 'running', currentTime: 0, destination: {}, decodeAudioData: async b => b,
    createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1 } }),
    createBufferSource() { const n = { connect() {}, disconnect() {}, start() { log.played.push(n.buffer); } }; return n; },
    createOscillator() { log.tones++; throw new Error('no fallback tone for UI tones'); } } };
  const player = createUiTonePlayer({ urls: URLS, enabled: () => state.on, reduced: () => state.reduced, hidden: () => state.hidden, getContext: () => state.ctx,
    fetchImpl: fetchImpl ?? (async url => { log.fetched.push(url); return { ok: true, arrayBuffer: async () => url }; }) });
  return { player, log, state };
}
const control = tone => ({ dataset: tone === undefined ? {} : { tone } });

test('every mapped control kind plays its own tone, once the console toggle is on', async () => {
  assert.deepEqual(UI_TONE_FOR, { press: 'ui-press', open: 'ui-open', close: 'ui-close' });
  const { player, log } = rig({ on: true });
  for (const kind of ['press', 'open', 'close']) assert.equal(await player.play(kind), 'sample');
  assert.deepEqual(log.played, Object.values(URLS));
});
test('plain controls press; tab and panel controls open or close; the toggle itself is silent', () => {
  assert.equal(toneKindFor(control()), 'press');
  assert.equal(toneKindFor(control('open')), 'open');
  assert.equal(toneKindFor(control('close')), 'close');
  assert.equal(toneKindFor(control('none')), null);
  assert.equal(toneKindFor(control('bogus')), 'press');
  assert.equal(toneKindFor(null), null);
});
test('the console plays nothing until toggled on, and nothing is fetched', async () => {
  const { player, log } = rig({ on: false });
  for (const kind of ['press', 'open', 'close']) assert.equal(await player.play(kind), null);
  assert.deepEqual([log.fetched.length, log.played.length], [0, 0]);
});
test('reduced motion and a hidden page stay silent', async () => {
  for (const flag of ['reduced', 'hidden']) { const { player, log, state } = rig({ on: true }); state[flag] = true; assert.equal(await player.play('press'), null); assert.equal(log.played.length, 0); }
});
test('a failed sample is skipped: no fallback tone, no throw', async () => {
  const { player, log } = rig({ on: true, fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.equal(await player.play('open'), null);
  assert.equal(log.tones, 0);
});
test('room event names are not UI tones', async () => {
  const { player, log } = rig({ on: true });
  for (const kind of ['decision_open', 'reveal', 'ui-press']) assert.equal(await player.play(kind), null);
  assert.equal(log.played.length, 0);
});

// Structural: UI tones are console-only. Phone and projector never reach the module, the assets or the names.
const DIR = new URL('../src/client/', import.meta.url);
const imports = file => [...readFileSync(new URL(file, DIR), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([\w-]+\.mjs)['"]/g)].map(m => m[1]);
function closure(entry) { const seen = new Set(); const walk = f => { if (seen.has(f)) return; seen.add(f); imports(f).forEach(walk); }; walk(entry); return seen; }
test('phone and projector entry closures never import or name UI tones', () => {
  for (const entry of ['phone.mjs', 'projector.mjs']) {
    for (const file of closure(entry)) {
      assert.ok(!['console-tones.mjs', 'ui-tone-assets.mjs'].includes(file), `${entry} reaches ${file}`);
      assert.doesNotMatch(readFileSync(new URL(file, DIR), 'utf8'), /ui-(press|open|close)|UI_TONE/, `${file} (via ${entry}) names a UI tone`);
    }
  }
});
test('only the facilitator console room imports the UI tone module', () => {
  const users = readdirSync(DIR).filter(f => f.endsWith('.mjs') && imports(f).some(i => ['console-tones.mjs', 'ui-tone-assets.mjs'].includes(i)));
  assert.deepEqual(users.sort(), ['console-room.mjs', 'console-tones.mjs']);
});
