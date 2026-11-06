import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCuePlayer } from '../src/client/room-cues.mjs';

function rig(over = {}) {
  const sources = [], gains = [], fallback = [];
  const ctx = { state: 'running', destination: {}, decodeAudioData: async bytes => bytes,
    createGain() { const gain = { gain: { value: 1 }, connect() {}, disconnect() { gain.disconnected = true; } }; gains.push(gain); return gain; },
    createBufferSource() { const source = { connect() {}, start() {}, stop() { source.stopped = true; }, disconnect() { source.disconnected = true; } }; sources.push(source); return source; }, ...over.ctx };
  const player = createCuePlayer({ urls: { source: '/source.wav' }, map: { loud: 'source', soft: 'source' },
    eventGain: { loud: 1, soft: .5 }, volume: () => .4, enabled: () => true, reduced: () => false,
    hidden: () => false, getContext: () => ctx, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    fallback: (_ctx, _kind, gain) => fallback.push(gain), ...over });
  return { player, sources, gains, fallback };
}

test('cancel stops and disconnects an active source even when Web Audio stop throws', async () => {
  for (const broken of [false, true]) {
    const r = rig(); await r.player.play('loud');
    if (broken) r.sources[0].stop = () => { throw Error('interrupted'); };
    r.player.cancel();
    assert.equal(r.sources[0].disconnected, true); assert.equal(r.gains[0].disconnected, true);
    if (!broken) assert.equal(r.sources[0].stopped, true);
  }
});
test('shared selected sample and fallback multiply user and semantic event gain identically', async () => {
  const sample = rig(); await sample.player.play('soft'); assert.equal(sample.gains[0].gain.value, .2);
  const fallback = rig({ fetchImpl: async () => { throw Error('offline'); } });
  assert.equal(await fallback.player.play('soft'), 'tone'); assert.deepEqual(fallback.fallback, [.2]);
});
test('audio node/context failures are contained and never reject an event handler', async () => {
  const r = rig({ ctx: { createBufferSource() { throw Error('unavailable'); } } });
  assert.equal(await r.player.play('loud'), null);
});
