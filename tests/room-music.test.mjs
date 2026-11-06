// The projector's room music adapter (CASE-334): permission, lifecycle and load fences around the round8 engine. Ported from
// the shipped adapter's tests: nothing loads without a deliberate level, gesture and visible page; End fences held fetches and
// decodes; a stuck load reports unavailable; teardown survives interrupted nodes. Fake audio nodes; nothing is fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRoomMusic } from '../src/client/room-music.mjs';

const manifest = JSON.parse(readFileSync(new URL('../public/audio/room-music/manifest.json', import.meta.url), 'utf8'));
const withUrls = profile => ({ ...profile, assets: Object.fromEntries(Object.entries(profile.assets).map(([part, a]) => [part, { ...a, url: `/assets/${a.file.replace('.mp3', '')}.${a.sha256}.mp3` }])) });
const library = { tracks: manifest.tracks.map(({ boosts, ...track }) => ({ ...withUrls(track), boosts: boosts.map(b => withUrls({ ...track, ...b })) })) };
const sizeOf = Object.fromEntries(library.tracks.flatMap(t => [t, ...t.boosts]).flatMap(p => Object.values(p.assets)).map(a => [a.url, a]));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const lobby = { phase: 'waiting' };
const decision = (over = {}) => ({ phase: 'decision_open', decision: { decisionId: '01900000-0000-7000-8000-000000000001', status: 'open' },
  timer: { paused: false, endsAt: new Date(Date.parse('2026-11-01T09:01:00Z')).toISOString() }, timerTotalS: 60,
  music: { choice: 'auto', intensity: 70, transport: { trackId: 'atlas-current', draw: 0, tier: 0, atMs: Date.parse('2026-11-01T09:00:00Z'), originMs: Date.parse('2026-11-01T09:00:00Z') - 3000 } }, ...over });

function rig(over = {}) {
  const log = { fetched: [], sources: [], gains: [], reports: [] }, state = { on: true, hidden: false, reduced: false, volume: .2, now: Date.parse('2026-11-01T09:00:05Z') };
  const param = () => ({ value: 1, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} });
  const ctx = { state: 'running', currentTime: 0, destination: {},
    decodeAudioData: async data => ({ duration: sizeOf[data.url]?.durationS ?? 1, url: data.url }),
    createGain() { const n = { gain: param(), connect() {}, disconnect() { n.disconnected = true; } }; log.gains.push(n); return n; },
    createBufferSource() { const n = { loop: false, connect() {}, start(at, offset) { n.started = true; n.at = at; n.offset = offset; }, stop() { n.stopped = true; }, disconnect() { n.disconnected = true; } }; log.sources.push(n); return n; } };
  const ticks = [];
  const player = createRoomMusic({ library, enabled: () => state.on, reduced: () => state.reduced, hidden: () => state.hidden, volume: () => state.volume,
    getContext: () => ctx, report: value => log.reports.push(value), now: () => state.now, setTick: fn => { ticks.push(fn); return ticks.length; }, clearTick: () => {},
    fetchImpl: async url => { log.fetched.push(url); const bytes = sizeOf[url].bytes, body = new ArrayBuffer(bytes); body.url = url; return { ok: true, headers: { get: () => String(bytes) }, arrayBuffer: async () => body }; }, ...over });
  return { player, log, state, ctx, ticks };
}

test('[AS-120] no music request without a level, sound on, a visible page, motion allowed and a running context', async () => {
  for (const [key, value] of [['volume', null], ['volume', 0], ['on', false], ['hidden', true], ['reduced', true]]) {
    const r = rig(); r.state[key] = value; r.player.reconcile(lobby); r.player.reconcile(decision()); await settle();
    assert.equal(r.log.fetched.length, 0, `${key}=${value}`); r.player.close();
  }
  const r = rig(); r.ctx.state = 'suspended'; r.player.reconcile(lobby); await settle(); assert.equal(r.log.fetched.length, 0); r.player.close();
});

test('[AS-120] the lobby bed starts once, keeps playing through repeated views and level changes, then the decision theme takes over', async () => {
  const r = rig(); r.player.reconcile(lobby); await settle();
  assert.deepEqual(r.log.fetched.map(u => u.split('/').at(-1).split('.')[0]), ['atlas-arrival-low']);
  assert.equal(r.log.sources.length, 1); assert.equal(r.log.reports.at(-1), 'playing');
  r.state.volume = .35; r.player.reconcile({ ...lobby, revision: 9 }); await settle();
  assert.equal(r.log.sources.length, 1, 'the same bed continues'); assert.equal(r.log.gains[0].gain.value, .35, 'the projector level is the master gain');
  r.player.reconcile(decision()); await settle();
  assert.deepEqual(r.log.fetched.slice(1).map(u => u.split('/').at(-1).split('.')[0]).sort(), ['atlas-current-low', 'atlas-current-mid', 'atlas-current-peak', 'atlas-current-zero']);
  assert.ok(r.log.sources[0].stopped, 'the lobby bed hands over');
  r.player.reconcile(decision({ revision: 44, counts: { responded: 3 } })); await settle();
  assert.equal(r.log.fetched.length, 5, 'a vote or count change never refetches or restarts');
  r.player.close();
});

test('[AS-120] the closing window releases the decision theme and Keep open resumes it; reviewing and End stop everything', async () => {
  const r = rig(); r.player.reconcile(decision()); await settle();
  const closing = decision(); closing.music = { ...closing.music, transport: { ...closing.music.transport, closing: true } };
  r.player.reconcile(closing); await settle();
  assert.ok(r.log.sources.filter(n => n.started).every(n => n.stopped), 'nothing keeps sounding while the room locks');
  r.player.reconcile(decision()); await settle();
  assert.ok(r.log.sources.some(n => n.started && !n.stopped), 'Keep open resumes the same transport');
  r.player.reconcile({ phase: 'reviewing' }); await settle();
  assert.ok(r.log.sources.every(n => !n.started || n.stopped)); assert.equal(r.log.reports.at(-1), 'silent');
  r.player.close();
});

for (const boundary of ['fetch', 'decode']) test(`[AS-120] End during a held ${boundary} starts nothing`, async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const r = rig(boundary === 'fetch' ? { fetchImpl: async () => held } : {});
  if (boundary === 'decode') r.ctx.decodeAudioData = () => held;
  r.player.reconcile(lobby); await settle(); r.player.reconcile({ phase: 'ended' });
  const url = library.tracks[4].assets.low.url, bytes = sizeOf[url].bytes, body = new ArrayBuffer(bytes);
  release(boundary === 'fetch' ? { ok: true, headers: { get: () => String(bytes) }, arrayBuffer: async () => body } : { duration: sizeOf[url].durationS });
  await settle(); assert.equal(r.log.sources.length, 0); r.player.close();
});

test('[AS-120] a stuck load reports unavailable, wrong bytes are refused, and teardown survives interrupted nodes', async () => {
  let deadline; const stuck = rig({ fetchImpl: async () => new Promise(() => {}), setTimer: fn => { deadline = fn; return 1; }, clearTimer: () => {} });
  stuck.player.reconcile(lobby); await settle(); deadline(); assert.equal(stuck.log.reports.at(-1), 'unavailable'); stuck.player.close();
  const short = rig({ fetchImpl: async () => ({ ok: true, headers: { get: () => '10' }, arrayBuffer: async () => new ArrayBuffer(10) }) });
  short.player.reconcile(lobby); await settle(); assert.equal(short.log.sources.length, 0); assert.equal(short.log.reports.at(-1), 'unavailable'); short.player.close();
  // A truthful length header over a short body is refused too: the bytes themselves must match the manifest.
  const lying = rig({ fetchImpl: async url => ({ ok: true, headers: { get: () => String(sizeOf[url].bytes) }, arrayBuffer: async () => new ArrayBuffer(10) }) });
  lying.ctx.decodeAudioData = async () => ({ duration: library.tracks[4].assets.low.durationS }); // a decoder that would accept it
  lying.player.reconcile(lobby); await settle(); assert.equal(lying.log.sources.length, 0); assert.equal(lying.log.reports.at(-1), 'unavailable'); lying.player.close();
  const active = rig(); active.player.reconcile(lobby); await settle();
  active.log.sources[0].stop = () => { throw Error('interrupted'); };
  active.player.close(); assert.equal(active.log.gains[0].disconnected, true, 'the master gain is disconnected even though a source refused to stop');
});
