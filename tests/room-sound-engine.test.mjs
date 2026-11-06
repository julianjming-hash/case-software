// CASE-334: the projector's room music engine, ported from the approved round8 reference. Fake audio nodes, the real shipped
// library metadata (public/audio/room-music/manifest.json) and the real public timeline; nothing is fetched or decoded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRoomSound, sectionMix } from '../src/client/room-sound-engine.mjs';
import { freshAnchor, musicSegments, segmentAt, continuedAnchor, loopMs } from '../src/shared/music-timeline.mjs';

const manifest = JSON.parse(await readFile(new URL('../public/audio/room-music/manifest.json', import.meta.url), 'utf8'));
const withUrls = profile => ({ ...profile, assets: Object.fromEntries(Object.entries(profile.assets).map(([part, a]) => [part, { ...a, url: `/assets/${a.file.replace('.mp3', '')}.${a.sha256}.mp3` }])) });
const library = { tracks: manifest.tracks.map(({ boosts, ...track }) => ({ ...withUrls(track), boosts: boosts.map(b => withUrls({ ...track, ...b })) })) };
const T0 = Date.parse('2026-11-01T09:00:00Z');

/** One projector: its own AudioContext clock, started `skewS` after the room clock's T0, and a loader that can be held. */
function projector({ skewS = 0, hold = () => false } = {}) {
  const nodes = [], loads = [], held = [];
  const param = () => ({ value: 1, events: [], cancelScheduledValues(t) { this.events.push(['cancel', t]); }, setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['ramp', v, t]); } });
  const context = { currentTime: 0,
    createGain() { const node = { gain: param(), connect() {}, disconnect() {} }; nodes.push(node); return node; },
    createBufferSource() { const node = { buffer: null, loop: false, playbackRate: param(), detune: param(), connect() {}, disconnect() {},
      start(at = 0, offset = 0) { this.at = at; this.offset = offset; this.started = true; }, stop(at = 0) { this.stoppedAt = at; this.stopped = true; } }; nodes.push(node); return node; } };
  const load = async (asset, { signal }) => {
    loads.push(asset.file);
    if (hold(asset)) await new Promise(resolve => held.push(resolve));
    if (signal.aborted) throw Error('aborted');
    return { file: asset.file, duration: asset.durationS };
  };
  const sound = createRoomSound({ context, destination: { connect() {} }, assets: library, load });
  const roomNow = () => T0 + (context.currentTime + skewS) * 1000;
  const sources = () => nodes.filter(n => n.buffer);
  const playing = (at = context.currentTime) => sources().filter(n => n.started && n.at <= at + 1e-9 && !(n.stopped && n.stoppedAt <= at + 1e-9));
  return { sound, context, nodes, loads, held, roomNow, sources, playing,
    async advance(seconds, step = .25) { for (let t = 0; t < seconds - 1e-9; t += step) { context.currentTime += Math.min(step, seconds - t); sound.tick(roomNow()); await flush(); } },
    release() { for (const resolve of held.splice(0)) resolve(); } };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
/** The loop position (seconds) each playing low voice is at, by its own schedule. */
const phase = (p, file) => { const n = p.playing().filter(x => x.loop && x.buffer.file.includes(file)).at(-1); if (!n) return null; const loop = n.buffer.duration; return ((p.context.currentTime - n.at + n.offset) % loop + loop) % loop; };

function decisionScene(p, { trackId = 'atlas-current', intensity = 1.5, totalS = 60, openedAtMs = T0, transport } = {}) {
  const timer = { paused: false, deadlineMs: openedAtMs + totalS * 1000, totalS };
  transport ??= freshAnchor({ trackId, intensity, timer, atMs: openedAtMs });
  return { timer, transport, scene: { kind: 'decision', decisionId: '01900000-0000-7000-8000-000000000001', trackId, transport, nowMs: p.roomNow() }, publicTimer: { paused: false, endsAtMs: timer.deadlineMs, totalS, nowMs: p.roomNow() } };
}
async function start(p, options = {}) {
  const d = decisionScene(p, options);
  p.sound.control({ intensity: options.intensity ?? 1.5 });
  p.sound.setTimer(d.publicTimer);
  await p.sound.setScene(d.scene); await flush();
  return d;
}

test('[AS-199] the engine fetches nothing until a scene starts, loads only the playing profile and never retunes a source', async () => {
  const p = projector();
  assert.deepEqual(p.loads, []);
  await start(p, { intensity: .7 }); await p.advance(.25);
  assert.deepEqual(p.loads.sort(), ['atlas-current-low.mp3', 'atlas-current-mid.mp3', 'atlas-current-peak.mp3', 'atlas-current-zero.mp3']);
  assert.equal(p.playing().filter(n => n.loop).length, 3, 'low, mid and peak full mixes run together');
  await p.advance(70);
  for (const node of p.sources()) { assert.deepEqual(node.playbackRate.events, [], 'no playbackRate change'); assert.deepEqual(node.detune.events, [], 'no detune'); }
  assert.ok(!p.loads.some(file => file.includes('boost')), 'a Build at or under 100% never fetches a faster profile');
  p.sound.close();
});

test('[AS-199] 150% hands over to the faster profiles on the public bar lines and peaks at zero with one melodic cue', async () => {
  const p = projector(), d = await start(p);
  const segments = musicSegments({ trackId: 'atlas-current', intensity: 1.5, anchor: d.transport, timer: d.timer });
  assert.deepEqual(segments.map(s => s.tier), [0, 1, 2]);
  await p.advance(59);
  assert.equal(p.sound.clock().tempoTier, 2, 'the fastest profile is playing before zero');
  for (const segment of segments.slice(1)) {
    const started = p.sources().filter(n => n.loop && n.buffer.file.includes(`boost-${segment.tier === 1 ? 125 : 150}-low`));
    assert.ok(started.length >= 1, `tier ${segment.tier} started`);
    assert.ok(Math.abs((T0 + started[0].at * 1000) - segment.startMs) < 1, `tier ${segment.tier} starts on its public bar line`);
  }
  const zeros = p.sources().filter(n => n.buffer.file.endsWith('-zero.mp3') && !(n.stopped && n.stoppedAt < 60));
  assert.equal(zeros.length, 1, 'exactly one time-up cue survives the tempo handovers');
  assert.ok(Math.abs(zeros[0].at - 60) < 1e-6, 'the cue lands on the deadline');
  await p.advance(10);
  assert.equal(p.sound.clock().tempoTier, 2, 'nothing accelerates or decelerates after zero');
  assert.equal(p.sources().filter(n => n.buffer.file.endsWith('-zero.mp3')).length, 1, 'and the cue never repeats');
  p.sound.close();
});

test('[AS-199] two projectors, one joining late and one loading slowly, play the same profile at the same phase', async () => {
  const a = projector();
  const d = await start(a);
  await a.advance(40);
  // B joins 40 s into the room and its faster-profile assets arrive two seconds after their public handover.
  let releaseB = false;
  const b = projector({ skewS: 40, hold: asset => asset.file.includes('boost-125') && !releaseB });
  b.sound.control({ intensity: 1.5 }); b.sound.setTimer({ ...d.publicTimer, nowMs: b.roomNow() });
  await b.sound.setScene({ ...d.scene, nowMs: b.roomNow() }); await flush();
  const both = async seconds => { await a.advance(seconds); await b.advance(seconds); };
  const handover = musicSegments({ trackId: 'atlas-current', intensity: 1.5, anchor: d.transport, timer: d.timer })[1].startMs;
  while (a.roomNow() < handover + 2000) await both(.25);
  assert.equal(a.sound.clock().tempoTier, 1); assert.equal(b.sound.clock().tempoTier, 0, 'B is still waiting for its assets');
  releaseB = true; b.release(); await flush(); await both(.25);
  assert.equal(b.sound.clock().tempoTier, 1, 'B seeks into the same profile once it loads');
  const pa = phase(a, 'boost-125-low'), pb = phase(b, 'boost-125-low');
  assert.ok(Math.abs(pa - pb) < .002, `same loop position (${pa} vs ${pb})`);
  const expected = segmentAt(musicSegments({ trackId: 'atlas-current', intensity: 1.5, anchor: d.transport, timer: d.timer }), a.roomNow());
  const loop = loopMs('atlas-current', 1) / 1000, want = (((a.roomNow() - expected.originMs) / 1000) % loop + loop) % loop;
  assert.ok(Math.abs(pa - want) < .002, 'and that position is the public timeline\'s');
  a.sound.close(); b.sound.close();
});

test('[AS-199] +30 s continues the groove and moves the single cue to the new deadline', async () => {
  const p = projector(), d = await start(p, { intensity: 1.3 });
  await p.advance(50);
  const before = p.playing().filter(n => n.loop).map(n => n.buffer.file).sort();
  const editMs = p.roomNow(), timer = { paused: false, deadlineMs: editMs + 30_000, totalS: 30 };
  const transport = continuedAnchor({ trackId: 'atlas-current', intensity: 1.3, anchor: d.transport, timer: d.timer, atMs: editMs });
  p.sound.setTimer({ paused: false, endsAtMs: timer.deadlineMs, totalS: 30, nowMs: editMs });
  await p.sound.setScene({ ...d.scene, transport, nowMs: editMs }); await flush(); await p.advance(.5);
  assert.deepEqual(p.playing().filter(n => n.loop).map(n => n.buffer.file).sort(), before, 'the same loops keep running');
  const cues = p.sources().filter(n => n.buffer.file.endsWith('-zero.mp3') && !(n.stopped && n.stoppedAt <= p.context.currentTime + 1));
  assert.equal(cues.length, 1); assert.ok(Math.abs(cues[0].at - (50 + 30)) < .3, 'the cue moved to the new deadline');
  p.sound.close();
});

test('[AS-199] closing and Lock release the music and cancel the cue; a projector joining after zero never replays it', async () => {
  const p = projector(), d = await start(p, { intensity: .7 });
  await p.advance(58);
  await p.sound.setScene({ kind: 'locked' }); await flush(); await p.advance(4);
  assert.equal(p.playing().length, 0, 'locking two seconds before zero leaves nothing sounding');
  assert.ok(p.sources().filter(n => n.buffer.file.endsWith('-zero.mp3')).every(n => n.stopped && n.stoppedAt <= 60), 'the early lock suppressed the time-up cue');
  const late = projector({ skewS: 65 });
  late.sound.control({ intensity: .7 }); late.sound.setTimer({ ...d.publicTimer, nowMs: late.roomNow() });
  await late.sound.setScene({ ...d.scene, nowMs: late.roomNow() }); await flush(); await late.advance(3);
  assert.equal(late.sources().filter(n => n.buffer.file.endsWith('-zero.mp3')).length, 0, 'no replay after zero');
  assert.equal(late.playing().filter(n => n.loop).length, 3, 'the calm open window still plays');
  p.sound.close(); late.sound.close();
});

test('[AS-199] Build changes rescale the ramp without restarting the loops; clock jitter never re-seeks', async () => {
  const p = projector(), d = await start(p, { intensity: .4 });
  await p.advance(30);
  const count = p.sources().length;
  p.sound.control({ intensity: 1 }); await p.advance(1);
  assert.equal(p.sources().length, count, 'no new sources for a Build change at or under 100%');
  await p.sound.setScene({ ...d.scene, nowMs: p.roomNow() + 30 }); p.sound.tick(p.roomNow() - 40); await p.advance(1);
  assert.equal(p.sources().length, count, 'a 30–40 ms clock wobble keeps the same sources');
  assert.deepEqual(sectionMix(.5), [0, 1, 0]); assert.deepEqual(sectionMix(0), [1, 0, 0]);
  p.sound.close();
});
