// CASE-334: the room music's public timeline and protocol. Every projector must agree on the track, tempo profile and bar
// from public room state alone; the facilitator's choices are validated, journalled and projected without private data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { MUSIC_DECISION_TRACKS, MUSIC_TRACK_NAMES, MUSIC_TEMPO, energyCurve, scaledEnergy, shuffledTracks, musicTrackFor,
  musicSegments, segmentAt, freshAnchor, continuedAnchor, barMs, loopMs } from '../src/shared/music-timeline.mjs';
import * as reference from '../prototypes/sound-stage/engine.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const library = JSON.parse(await readFile(new URL('../prototypes/sound-stage/assets/library.json', import.meta.url), 'utf8'));
const offset = (segment, trackId, atMs) => { const loop = loopMs(trackId, segment.tier); return (((atMs - segment.originMs) % loop) + loop) % loop; };

test('[AS-197] the shared catalogue matches the approved round8 library exactly', () => {
  const decisions = library.tracks.filter(track => track.kind === 'decision');
  assert.deepEqual(decisions.map(track => track.id), [...MUSIC_DECISION_TRACKS]);
  for (const track of decisions) {
    assert.equal(MUSIC_TRACK_NAMES[track.id], track.name);
    const tempo = MUSIC_TEMPO[track.id];
    assert.equal(tempo.meter, track.meter); assert.equal(tempo.bars, track.bars);
    assert.deepEqual(tempo.bpm, [track.bpm, ...track.boosts.map(boost => boost.bpm)]);
    for (const [tier, profile] of [track, ...track.boosts].entries()) assert.equal(MUSIC_TEMPO[track.id].loopS[tier], profile.loopS, `${profile.id} loop`);
    for (const [tier, profile] of [track, ...track.boosts].entries()) assert.ok(Math.abs(barMs(track.id, tier) - 60_000 / profile.bpm * profile.meter) < .01, `${profile.id} bar within 10 µs of its tempo`);
  }
});

test('[AS-197] shuffle, energy and intensity are the approved reference behaviour', () => {
  for (const seed of [1, 'room-a', uuidv7()]) assert.deepEqual(shuffledTracks(seed, [...MUSIC_DECISION_TRACKS], 41), reference.shuffledTracks(seed, [...MUSIC_DECISION_TRACKS], 41));
  const order = shuffledTracks('seed', [...MUSIC_DECISION_TRACKS], 400);
  for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1], `no repeat at draw ${i}, cycle boundaries included`);
  for (let i = 0; i < 400; i += 4) assert.equal(new Set(order.slice(i, i + 4)).size, 4, 'each cycle plays every theme once');
  for (const [r, total] of [[60, 100], [20, 100], [0, 100], [45, 600], [null, 60], [5, 10]]) assert.equal(energyCurve(r, total), reference.energyCurve(r, total));
  assert.equal(scaledEnergy(1, 0), .15, '0% stays calm'); assert.equal(scaledEnergy(1, 1), 1, '100% is the approved peak'); assert.equal(scaledEnergy(1, 1.5), 1.5);
  assert.equal(musicTrackFor('side-street-developed', 'x', 7), 'side-street-developed');
  assert.equal(musicTrackFor('auto', 'x', 2), shuffledTracks('x', [...MUSIC_DECISION_TRACKS], 3)[2]);
});

test('[AS-197] tempo handovers land on bar lines before zero and keep the harmonic bar', () => {
  const trackId = 'atlas-current', atMs = 1_000_000, deadlineMs = atMs + 60_000, timer = { paused: false, deadlineMs, totalS: 60 };
  for (const intensity of [0, .7, 1]) assert.equal(musicSegments({ trackId, intensity, anchor: freshAnchor({ trackId, intensity, timer, atMs }), timer }).length, 1, 'no faster profile at or below 100%');
  const anchor = freshAnchor({ trackId, intensity: 1.5, timer, atMs });
  assert.equal(anchor.tier, 0);
  assert.equal((deadlineMs - anchor.originMs) % loopMs(trackId, 0) < 1e-6 || loopMs(trackId, 0) - (deadlineMs - anchor.originMs) % loopMs(trackId, 0) < 1e-6, true, 'a whole loop ends at the deadline');
  const segments = musicSegments({ trackId, intensity: 1.5, anchor, timer });
  assert.deepEqual(segments.map(s => s.tier), [0, 1, 2], '150% climbs through both faster profiles');
  for (let i = 1; i < segments.length; i++) {
    const before = segments[i - 1], next = segments[i];
    assert.ok(next.startMs < deadlineMs, 'nothing is queued after zero');
    const bars = (next.startMs - before.originMs) / barMs(trackId, before.tier);
    assert.ok(Math.abs(bars - Math.round(bars)) < 1e-6, 'the handover is on a bar line of the outgoing profile');
    const outgoingBar = Math.round(offset(before, trackId, next.startMs) / barMs(trackId, before.tier)) % MUSIC_TEMPO[trackId].bars;
    const incomingBar = Math.round(offset(next, trackId, next.startMs) / barMs(trackId, next.tier)) % MUSIC_TEMPO[trackId].bars;
    assert.equal(incomingBar, outgoingBar, 'the same bar of the loop continues at the faster tempo');
  }
  // Hand-computed: 150% reaches tier 1 when scaled energy passes 1 two base bars ahead: energy > 0.85/1.35 + 0.15.
  const twoBarsS = 2 * barMs(trackId, 0) / 1000, windowS = 24, crossS = windowS * (1 - (.85 / 1.35) / .85) + twoBarsS;
  assert.ok(Math.abs((deadlineMs - segments[1].startMs) / 1000 - crossS) <= barMs(trackId, 0) / 1000, 'tier 1 starts within one bar of the forecast crossing');
});

test('[AS-197] two projectors joining at different times compute the same track, profile and bar', () => {
  const trackId = 'night-platform-developed', atMs = 5_000_000, timer = { paused: false, deadlineMs: atMs + 90_000, totalS: 90 };
  const anchor = freshAnchor({ trackId, intensity: 1.4, timer, atMs });
  const early = musicSegments({ trackId, intensity: 1.4, anchor, timer }), late = musicSegments({ trackId, intensity: 1.4, anchor: structuredClone(anchor), timer: { ...timer } });
  assert.deepEqual(late, early, 'the timeline is a pure function of public state');
  for (const t of [atMs + 1, atMs + 70_000, atMs + 85_000, atMs + 89_999]) {
    const a = segmentAt(early, t), b = segmentAt(late, t);
    assert.equal(b.tier, a.tier); assert.equal(offset(b, trackId, t), offset(a, trackId, t));
  }
});

test('[AS-197] a timer or Build change continues the music without a restart', () => {
  const trackId = 'side-street-developed', atMs = 9_000_000, oldTimer = { paused: false, deadlineMs: atMs + 60_000, totalS: 60 };
  const anchor = freshAnchor({ trackId, intensity: 1.5, timer: oldTimer, atMs });
  const editAt = atMs + 55_000, old = segmentAt(musicSegments({ trackId, intensity: 1.5, anchor, timer: oldTimer }), editAt);
  assert.equal(old.tier, 2, 'in the faster profile five seconds before zero');
  const next = continuedAnchor({ trackId, intensity: 1.5, anchor, timer: oldTimer, atMs: editAt });
  const newTimer = { paused: false, deadlineMs: editAt + 30_000, totalS: 30 };
  const playing = segmentAt(musicSegments({ trackId, intensity: 1.5, anchor: next, timer: newTimer }), editAt);
  assert.equal(playing.tier, old.tier); assert.equal(offset(playing, trackId, editAt), offset(old, trackId, editAt), '+30 s keeps the same bar and beat');
});

// ── the room protocol ──
function room() {
  const { doc, o, p } = miniCase();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), t = Date.parse('2026-11-01T09:00:00Z');
  const ledger = new Map(), fac = { role: 'facilitator', id: 'fac' }, pid = uuidv7();
  const send = (type, payload = {}, actor = fac, stepMs = 1000) => {
    t += stepMs; const r = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(t).toISOString(), clientEventId: uuidv7(), ...payload }, ledger);
    state = r.state; return { receipt: r.effects.find(e => e.type === 'receipt'), effects: r.effects };
  };
  send('join', { displayName: 'Learner' }, { role: 'participant', id: pid });
  send('start', { roundId: uuidv7() });
  const openNext = () => { for (let n = 0; n < 15 && state.phase !== 'responses_open'; n++) send('advance', { roundId: uuidv7(), expectRevision: state.revision }); };
  openNext();
  return { get state() { return state; }, get t() { return t; }, send, openNext, o, p, pid, advanceClock: ms => { t += ms; } };
}

test('[AS-198] set_music is facilitator-only, validated, journalled and kept off phones', () => {
  const r = room();
  assert.equal(r.send('set_music', { intensity: 120 }, { role: 'participant', id: r.pid }).receipt.reason, 'forbidden');
  for (const bad of [{}, { intensity: 151 }, { intensity: 70.5 }, { intensity: -5 }, { choice: 'lobby' }, { choice: 'atlas-arrival' }, { playing: 'yes' }, { volume: 101 }, { volume: 12.5 }, { effects: 1 }])
    assert.equal(r.send('set_music', bad).receipt.reason, 'bad_payload', JSON.stringify(bad));
  const before = r.state.revision;
  assert.equal(r.send('set_music', { intensity: 70 }).receipt.receipt, 'accepted', 'the default again is accepted');
  assert.equal(r.state.revision, before, 'an unchanged choice journals nothing');
  const set = r.send('set_music', { choice: 'night-platform-developed', intensity: 130 });
  assert.deepEqual(set.effects.find(e => e.type === 'journal').payload, { choice: 'night-platform-developed', intensity: 130, playing: true, volume: 60, effects: true });
  // CASE-335: the console's player sets the room's music on/off, volume and Effects for every projector.
  assert.equal(r.send('set_music', { playing: false, volume: 35, effects: false }).receipt.receipt, 'accepted');
  assert.deepEqual([project(r.state, 'display').music.playing, project(r.state, 'display').music.volume, project(r.state, 'display').music.effects], [false, 35, false]);
  r.send('set_music', { playing: true, volume: 60, effects: true });
  assert.deepEqual(set.effects.find(e => e.type === 'broadcast').roles, ['facilitator', 'display'], 'phones are not woken for music');
  const display = project(r.state, 'display');
  assert.equal(display.music.choice, 'night-platform-developed'); assert.equal(display.music.intensity, 130);
  assert.ok(acceptDisplayView(display), 'the projector boundary accepts the music');
  assert.deepEqual(Object.keys(display.music.transport).sort(), ['atMs', 'draw', 'originMs', 'tier', 'trackId'], 'no seed, round or decision id');
  const lockId = uuidv7(); r.advanceClock(1000);
  const closing = dispatch(r.state, { type: 'lock', epoch: r.state.epoch, actor: { role: 'facilitator', id: 'fac' }, at: new Date(r.t).toISOString(), clientEventId: lockId, graceMs: 2000 }, new Map()).state;
  assert.equal(project(closing, 'display').music.transport.closing, true, 'the closing window releases the music');
  assert.deepEqual(closing.music.transport, r.state.music.transport, 'and keeps the transport, so Keep open resumes it');
  assert.ok(acceptDisplayView(project(closing, 'display')));
  assert.equal('music' in project(r.state, 'participant', r.pid), false, 'phones stay silent and never see the music');
  assert.equal(project(r.state, 'facilitator').music.choice, 'night-platform-developed');
});

test('[AS-198] a round opens a fresh transport, a theme change lands on a bar line, Lock silences, Undo restarts', () => {
  const r = room();
  const opened = r.state.music.transport;
  assert.equal(opened.trackId, musicTrackFor('auto', r.state.sessionId, 0), 'the first decision plays the first shuffle pick');
  assert.equal(opened.originMs, opened.atMs, 'an untimed round starts its loop when it opens');
  assert.equal(r.send('set_timer', { seconds: 90 }).receipt.receipt, 'accepted');
  const first = r.state.music.transport;
  assert.equal(first.originMs, opened.originMs, 'starting a timer continues the groove rather than restarting it');
  const other = MUSIC_DECISION_TRACKS.find(id => id !== first.trackId);
  r.send('set_music', { choice: other });
  const changed = r.state.music.transport;
  assert.equal(changed.trackId, other);
  assert.ok(changed.atMs >= r.t + 1500, 'the new theme starts at least 1.5 s ahead, so every projector hears it start together');
  const bars = (changed.atMs - first.originMs) / barMs(first.trackId, first.tier);
  assert.ok(Math.abs(bars - Math.round(bars)) < 1e-6, 'on a bar line of the outgoing theme');
  r.send('set_music', { choice: 'auto' });
  r.send('vote', { roundId: r.state.round.id, response: { option_id: r.o.decompress }, responseId: uuidv7() }, { role: 'participant', id: r.pid });
  const lockId = uuidv7(); r.advanceClock(1000);
  let res = dispatch(r.state, { type: 'lock', epoch: r.state.epoch, actor: { role: 'facilitator', id: 'fac' }, at: new Date(r.t).toISOString(), clientEventId: lockId }, new Map());
  assert.equal(res.state.music.transport, null, 'Lock silences the decision music');
  assert.equal(project(res.state, 'display').music.transport, null);
  const sourceRound = structuredClone(res.state.round);
  res = dispatch(res.state, { type: 'undo', epoch: res.state.epoch, actor: { role: 'facilitator', id: 'fac' }, at: new Date(r.t + 2000).toISOString(), clientEventId: uuidv7(),
    expectRevision: res.state.revision, targetEventId: lockId, roundId: uuidv7(), sourceRound, seedResponseIds: { [r.pid]: uuidv7() } }, new Map());
  assert.equal(res.state.phase, 'responses_open');
  assert.equal(res.state.music.transport.draw, 0, 'Undo reopens the same decision with the same draw');
  assert.equal(res.state.music.transport.trackId, first.trackId);
});

test('[AS-198] each new decision draws the next shuffle pick; a timer edit continues the transport', () => {
  const r = room();
  r.send('set_timer', { seconds: 60 });
  r.send('set_music', { intensity: 150 });
  const before = r.state.music.transport;
  r.advanceClock(50_000);
  r.send('set_timer', { seconds: 30 });
  const after = r.state.music.transport;
  assert.equal(after.trackId, before.trackId);
  const segBefore = segmentAt(musicSegments({ trackId: before.trackId, intensity: 1.5, anchor: before, timer: { paused: false, deadlineMs: before.atMs + 60_000, totalS: 60 } }), after.atMs);
  assert.ok(Math.abs(offset(after, after.trackId, after.atMs) - offset(segBefore, before.trackId, after.atMs)) < 1e-6, 'same bar and beat across the edit');
  r.send('vote', { roundId: r.state.round.id, response: { option_id: r.o.decompress }, responseId: uuidv7() }, { role: 'participant', id: r.pid });
  r.send('lock');
  r.send('select_path', { pathId: r.p.decompress });
  r.send('show_results', { on: false });
  assert.equal(r.send('reveal').receipt.receipt, 'accepted');
  r.openNext();
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.state.music.transport.draw, 1);
  assert.equal(r.state.music.transport.trackId, musicTrackFor('auto', r.state.sessionId, 1));
  assert.notEqual(r.state.music.transport.trackId, before.trackId, 'the shuffle never repeats a theme back to back');
});

test('[AS-198] a room stored before CASE-334 reads as the default music and still accepts it', () => {
  const r = room();
  const legacy = structuredClone(r.state); delete legacy.music;
  assert.deepEqual(project(legacy, 'display').music, { choice: 'auto', intensity: 70, playing: true, volume: 60, effects: true, transport: null });
  const before335 = structuredClone(r.state); before335.music = { seed: 's', choice: 'side-street-developed', intensity: 90, order: [], transport: null };
  assert.deepEqual(project(before335, 'display').music, { choice: 'side-street-developed', intensity: 90, playing: true, volume: 60, effects: true, transport: null }, 'a CASE-334 room gains the default levels');
  const res = dispatch(legacy, { type: 'set_music', epoch: legacy.epoch, actor: { role: 'facilitator', id: 'fac' }, at: new Date(r.t + 1000).toISOString(), clientEventId: uuidv7(), intensity: 90 }, new Map());
  assert.equal(res.state.music.intensity, 90);
  assert.equal(typeof res.state.music.seed, 'string');
});
