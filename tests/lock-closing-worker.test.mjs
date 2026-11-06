// CASE-319 in real workerd: the Worker stamps the closing window, accepts an answer inside it, and finalises the lock
// at the deadline with no further command (its timer, backed by the room alarm); everyone answering opens the
// automatic window. Test Workers elsewhere run with both lengths at 0; this one turns them on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { startDirectWorker } from './helpers/direct-worker.mjs';
import { createRoom, serverMirror, facilitatorCommand, FIXTURE } from './helpers/local-worker.mjs';

const GRACE = 1200;
async function join(origin, room, name) {
  const res = await fetch(`${origin}/api/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.188' },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName: name, avatarId: 'shadows-01' }) });
  assert.equal(res.status, 201);
  return res.json();
}
async function vote(origin, room, who, optionIndex = 0) {
  const m = await serverMirror(origin, room), decision = FIXTURE.decisions.find(d => d.id === m.round.decisionId);
  const res = await fetch(`${origin}/api/v1/sessions/${room.sessionId}/commands`, { method: 'POST', headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'vote', epoch: m.epoch, clientEventId: uuidv7(), roundId: m.round.id, response: { option_id: decision.interaction.options[optionIndex].id } }) });
  return (await res.json()).receipt.receipt;
}
async function openRound(origin, room) {
  assert.equal((await facilitatorCommand(origin, room, 'start')).receipt, 'accepted');
  for (let n = 0; n < 20 && (await serverMirror(origin, room)).phase !== 'responses_open'; n++) await facilitatorCommand(origin, room, 'advance');
  assert.equal((await serverMirror(origin, room)).phase, 'responses_open');
}
const until = async (check, what, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(what); };

test('[AS-188] [AS-189] the Worker opens, fills and finalises the closing window by itself', { timeout: 90_000 }, async () => {
  const worker = await startDirectWorker({ bindings: { LOCK_GRACE_MS: String(GRACE), AUTO_LOCK_MS: String(GRACE) } });
  try {
    const { origin } = worker;
    // Lock: the window opens, an answer inside it counts, and the room locks at the deadline with nobody pressing.
    const room = await createRoom(origin), a = await join(origin, room, 'Alex'), b = await join(origin, room, 'Sam');
    // Sam joined over HTTP and has no live connection, so Alex alone would be "everyone": turn auto-lock off here.
    assert.equal((await facilitatorCommand(origin, room, 'set_auto_lock', { on: false })).receipt, 'accepted');
    await openRound(origin, room);
    assert.equal(await vote(origin, room, a), 'accepted');
    assert.equal((await serverMirror(origin, room)).round.closing, undefined, 'auto-lock off: the room does not lock itself');
    const locked = await facilitatorCommand(origin, room, 'lock');
    assert.equal(locked.receipt, 'accepted', locked.reason);
    let m = await serverMirror(origin, room);
    assert.equal(m.phase, 'responses_open');
    assert.ok(m.round.closing && Date.parse(m.round.closing.closesAt) - Date.parse(m.round.closing.openedAt) === GRACE, 'the Worker stamped its window');
    assert.equal(await vote(origin, room, b, 1), 'accepted', 'an answer sent inside the window is kept');
    await until(async () => (await serverMirror(origin, room)).phase === 'responses_locked', 'the window finalised on its own');
    m = await serverMirror(origin, room);
    assert.equal(m.round.aggregate.total, 2);
    assert.equal(m.teachingActions.filter(x => x.kind === 'lock').length, 1);
    assert.equal(await vote(origin, room, b, 0), 'locked');

    // Auto-lock: the one connected participant answers, the room opens its own window and locks.
    const solo = await createRoom(origin), c = await join(origin, solo, 'Kim');
    await openRound(origin, solo);
    assert.equal(await vote(origin, solo, c), 'accepted');
    assert.equal((await serverMirror(origin, solo)).round.closing?.auto, true);
    await until(async () => (await serverMirror(origin, solo)).phase === 'responses_locked', 'the automatic window finalised');
  } finally { await worker.stop(); }
});
