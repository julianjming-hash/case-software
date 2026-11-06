import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUE_FOR_EVENT, createRoomCuePlayer as createCuePlayer } from '../src/client/room-cue-events.mjs';

const URLS = { 'decision-opened': '/assets/decision-opened.aaa.wav', 'material-revealed': '/assets/material-revealed.bbb.wav' };
function rig(over = {}) {
  const log = { fetched: [], samples: [], tones: [] };
  const node = () => ({ connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, value: 1 } });
  const ctx = {
    state: 'running', currentTime: 0, destination: {},
    decodeAudioData: async bytes => ({ bytes }),
    createGain: node,
    createBufferSource() { const n = { ...node(), start() { log.samples.push(n.buffer); } }; return n; },
    createOscillator() { const n = { ...node(), frequency: {}, start() { log.tones.push(n.frequency.value); }, stop() {} }; return n; },
    ...over.ctx,
  };
  const state = { on: true, reduced: false, hidden: false, context: ctx, ...over.state };
  const player = createCuePlayer({
    urls: over.urls ?? URLS,
    fetchImpl: over.fetchImpl ?? (async url => { log.fetched.push(url); return { ok: true, arrayBuffer: async () => url }; }),
    enabled: () => state.on, reduced: () => state.reduced, hidden: () => state.hidden, getContext: () => state.context,
  });
  return { player, log, state };
}

test('only the two approved room events map to a library cue', () => {
  assert.deepEqual(CUE_FOR_EVENT, { decision_open: 'material-revealed', reveal: 'reveal-soft' });
  assert.ok(Object.isFrozen(CUE_FOR_EVENT));
});

test('an event plays its mapped library sample once enabled', async () => {
  const { player, log } = rig();
  assert.equal(await player.play('decision_open'), 'sample');
  assert.equal(await player.play('reveal'), 'sample');
  assert.deepEqual(log.fetched, [URLS['material-revealed']]);
  assert.equal(log.samples.length, 2);
  assert.equal(log.tones.length, 0);
});

test('a cue is fetched once, not per play', async () => {
  const { player, log } = rig();
  await player.play('reveal'); await player.play('reveal');
  assert.equal(log.fetched.length, 1);
  assert.equal(log.samples.length, 2);
});

test('muted plays nothing and fetches nothing', async () => {
  const { player, log, state } = rig(); state.on = false;
  assert.equal(await player.play('decision_open'), null);
  assert.equal(await player.play('reveal'), null);
  assert.deepEqual([log.fetched.length, log.samples.length, log.tones.length], [0, 0, 0]);
});

test('no sound before a gesture: no audio context or a suspended one plays nothing', async () => {
  for (const state of [{ context: null }, {}]) {
    const { player, log, state: s } = rig({ state, ctx: state.context === null ? {} : { state: 'suspended' } });
    assert.equal(await player.play('decision_open'), null);
    assert.deepEqual([log.fetched.length, log.samples.length, log.tones.length], [0, 0, 0]);
    void s;
  }
});

test('reduced motion and a hidden page stay silent', async () => {
  for (const flag of ['reduced', 'hidden']) {
    const { player, log, state } = rig(); state[flag] = true;
    assert.equal(await player.play('reveal'), null);
    assert.equal(log.samples.length + log.tones.length, 0);
  }
});

test('unknown or absent events are ignored', async () => {
  const { player, log } = rig();
  for (const kind of [null, undefined, '', 'deterioration', 'join', 'consequence']) assert.equal(await player.play(kind), null);
  assert.equal(log.samples.length + log.tones.length, 0);
});

test('a failed or missing asset falls back to the neutral tone, never throws', async () => {
  const failing = rig({ fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.equal(await failing.player.play('decision_open'), 'tone');
  assert.deepEqual(failing.log.tones, [330]);
  const missing = rig({ urls: {} });
  assert.equal(await missing.player.play('reveal'), 'tone');
  assert.deepEqual(missing.log.tones, [330]);
  const bad = rig({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(await bad.player.play('reveal'), 'tone');
});

test('volume scales the cue gain; zero volume and mute play nothing', async () => {
  const gains = [];
  for (const [v, expected] of [[1, 1], [.4, .4], [.05, .05]]) {
    gains.length = 0;
    const log = { s: 0 };
    const state = { on: true };
    const ctx = { state: 'running', currentTime: 0, destination: {}, decodeAudioData: async b => b,
      createGain: () => { const g = { connect() {}, disconnect() {}, gain: { value: 1 } }; gains.push(g); return g; },
      createBufferSource: () => ({ connect() {}, disconnect() {}, start() { log.s++; } }) };
    const player = createCuePlayer({ urls: URLS, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
      enabled: () => state.on, reduced: () => false, hidden: () => false, getContext: () => ctx, volume: () => v });
    assert.equal(await player.play('reveal'), 'sample');
    assert.equal(gains.at(-1).gain.value, expected * .5);
    state.on = false; assert.equal(await player.play('reveal'), null); assert.equal(log.s, 1);
  }
  const zero = createCuePlayer({ urls: URLS, fetchImpl: async () => { throw new Error('no fetch at zero'); }, enabled: () => true, reduced: () => false, hidden: () => false,
    getContext: () => ({ state: 'running' }), volume: () => 0 });
  assert.equal(await zero.play('reveal'), null);
});

for (const boundary of ['fetch', 'decode']) for (const failed of [false, true]) test(`cancel fences a held ${boundary} ${failed ? 'fallback' : 'sample'} and preserves cache or retry`, async () => {
  let release, entered, fetches = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = () => { entered(); return new Promise((resolve, reject) => { release = () => failed ? reject(new Error('unavailable')) : resolve(boundary === 'fetch' ? { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } : { decoded: true }); }); };
  let first = true;
  const { player, log } = rig({
    fetchImpl: async () => { fetches++; return boundary === 'fetch' && first ? (first = false, held()) : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; },
    ctx: { decodeAudioData: async () => boundary === 'decode' && first ? (first = false, held()) : { decoded: true } },
  });
  const pending = player.play('reveal'); await ready;
  // Optional call permits a before-fix run to expose stale playback, rather than just the missing API.
  player.cancel?.(); release();
  assert.equal(await pending, null);
  assert.deepEqual([log.samples.length, log.tones.length], [0, 0]);
  assert.equal(await player.play('reveal'), 'sample');
  assert.equal(fetches, failed ? 2 : 1);
  assert.equal(log.samples.length, 1);
});

test('canonical publication effects ignore count updates, replay, corrections, checkpoint restoration and join return',async()=>{
  const {roomCueForChange}=await import('../src/client/room-cue-events.mjs');const {uuidv7}=await import('../src/shared/ids.mjs');
  const before={phase:'live',surface:{surfaceId:uuidv7(),timelineKind:'live'},publication:{v:1,occurrenceId:uuidv7()}};
  const next={...before,publication:{v:1,occurrenceId:uuidv7()}};
  assert.equal(roomCueForChange(before,next),'reveal');assert.equal(roomCueForChange(before,{...before,counts:{total:5}}),null);
  assert.equal(roomCueForChange(null,next),null);assert.equal(roomCueForChange(before,{...next,replay:true}),null);
  for(const marker of [{correctionOf:before.publication.occurrenceId,restoresOccurrenceId:before.publication.occurrenceId},{checkpointOf:before.publication.occurrenceId}])assert.equal(roomCueForChange(before,{...next,publication:{...next.publication,...marker}}),null);
  assert.equal(roomCueForChange({phase:'waiting'},next,true),null);
  const open={...next,phase:'decision_open'};assert.equal(roomCueForChange(before,open),'decision_open');assert.equal(roomCueForChange(open,{...open,counts:{total:1}}),null);
  assert.equal(roomCueForChange(open,{...open,publication:{v:1,occurrenceId:uuidv7()}}),'decision_open');
});

test('cancelled sample disconnects once when the native ended callback arrives afterward', async () => {
  let ended, disconnected = 0, stopped = 0;
  const source = { connect() {}, start() { ended = this.onended; }, stop() { stopped++; }, disconnect() { disconnected++; } };
  const { player } = rig({ ctx: { createBufferSource: () => source } });
  assert.equal(await player.play('reveal'), 'sample');
  player.cancel(); ended(); player.cancel();
  assert.equal(stopped, 1);
  assert.equal(disconnected, 1);
});

test('first genuine canonical publication after an initial lobby plays once, while join-screen restoration stays silent', async () => {
  const {roomCueForChange}=await import('../src/client/room-cue-events.mjs');
  const {uuidv7}=await import('../src/shared/ids.mjs');
  const waiting={phase:'waiting',publication:null};
  const live={phase:'live',surface:{surfaceId:uuidv7(),timelineKind:'live'},publication:{v:1,occurrenceId:uuidv7()}};
  assert.equal(roomCueForChange(waiting,live),'reveal');
  assert.equal(roomCueForChange(live,{...live,revision:20}),null);
  assert.equal(roomCueForChange(waiting,live,true),null);
  assert.equal(roomCueForChange(null,live),null);
});

test('cancelled neutral fallback disconnects once when its ended callback arrives afterward', async () => {
  let ended, disconnected=0;
  const oscillator={frequency:{},connect(){},disconnect(){disconnected++;},start(){ended=this.onended;},stop(){}};
  const {player}=rig({urls:{},ctx:{createOscillator:()=>oscillator}});
  assert.equal(await player.play('reveal'),'tone');
  player.cancel();ended();player.cancel();
  assert.equal(disconnected,1);
});
