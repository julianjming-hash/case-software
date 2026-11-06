// CASE-319: Lock opens a short closing window in which phones send what is in their answer box, then freezes the round
// once; when everyone connected has answered, the room opens the same window itself. Reducer level: the Worker's own
// timing (graceMs stamping, the finalise timer and alarm, the presence count) is covered in lock-closing-worker.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, facilitatorActions, everyoneAnswered, SYSTEM_LOCK_ACTOR, SYSTEM_AUTO_LOCK_ACTOR } from '../src/shared/room-machine.mjs';
import { undoDescriptor } from '../src/shared/room-corrections.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { earliestAlarm } from '../src/worker/room-archive.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const FAC = { role: 'facilitator', id: 'fac' };
const LOCKER = { role: 'facilitator', id: SYSTEM_LOCK_ACTOR };
const AUTO = { role: 'facilitator', id: SYSTEM_AUTO_LOCK_ACTOR };

function room() {
  const { doc, o } = miniCase();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const ledger = new Map();
  let t = Date.parse('2026-10-30T09:00:00Z');
  const api = {
    o, get state() { return state; }, get t() { return t; },
    /** Each command is one second after the last unless `dt` (ms) says otherwise. */
    send(type, payload = {}, actor = FAC, dt = 1000) {
      t += dt;
      const r = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(t).toISOString(), clientEventId: uuidv7(), ...payload }, ledger);
      state = r.state;
      return { receipt: r.effects.find(e => e.type === 'receipt'), effects: r.effects };
    },
    join() { const id = uuidv7(); api.send('join', { displayName: 'Learner' }, { role: 'participant', id }); return id; },
    vote(pid, response, dt) { return api.send('vote', { roundId: state.round.id, response, responseId: uuidv7() }, { role: 'participant', id: pid }, dt); },
    open() {
      api.send('start', { roundId: uuidv7() });
      for (let n = 0; n < 15 && state.phase !== 'responses_open'; n++) api.send('advance', { roundId: uuidv7(), expectRevision: state.revision });
      assert.equal(state.phase, 'responses_open');
    },
  };
  return api;
}

test('[AS-188] Lock opens a closing window: the round stays open, phones see the deadline, and late answers count', () => {
  const r = room(), a = r.join(), b = r.join();
  r.open();
  assert.equal(r.vote(a, { option_id: r.o.image }).receipt.receipt, 'accepted');
  const lock = r.send('lock', { graceMs: 2000 });
  assert.equal(lock.receipt.receipt, 'accepted');
  assert.equal(r.state.phase, 'responses_open', 'the phase does not change, so screens from before the change keep working');
  assert.equal(r.state.round.status, 'open');
  const closesAt = r.state.round.closing.closesAt;
  assert.equal(Date.parse(closesAt), r.t + 2000);
  assert.ok(lock.effects.some(e => e.type === 'journal' && e.kind === 'responses_closing'));
  assert.deepEqual(lock.effects.find(e => e.type === 'broadcast').roles.sort(), ['display', 'facilitator', 'participant'], 'phones hear about the window');
  // Each screen sees only what it needs: the phone its deadline, the projector an unchanged, valid view.
  assert.equal(project(r.state, 'participant', b).decision.closesAt, closesAt);
  assert.equal(project(r.state, 'participant', b).decision.status, 'open');
  assert.ok(acceptDisplayView(project(r.state, 'display')), 'the display view stays valid for every projector');
  assert.deepEqual(project(r.state, 'facilitator').round.closing, { openedAt: new Date(r.t).toISOString(), closesAt, auto: false });
  // Nothing to undo until the lock lands; the console offers Lock now and Keep open instead of Lock and the timer.
  assert.deepEqual(undoDescriptor(r.state), { available: false, reason: 'closing' });
  const actions = facilitatorActions(r.state);
  assert.ok(actions.includes('finalise_lock') && actions.includes('cancel_lock'));
  assert.ok(!actions.includes('lock') && !actions.includes('set_timer'));
  assert.equal(r.send('set_timer', { seconds: 60 }, FAC, 100).receipt.reason, 'closing');
  assert.equal(r.send('lock', {}, FAC, 100).receipt.reason, 'already_closing');
  // Inside the window an edit replaces the sent answer, and someone who had not answered gets in (owner ruling).
  assert.equal(r.vote(a, { option_id: r.o.decompress }, 300).receipt.receipt, 'accepted');
  assert.equal(r.vote(b, { option_id: r.o.decompress }, 300).receipt.receipt, 'accepted');
  // The system finaliser waits for the deadline by the room's clock.
  assert.equal(r.send('finalise_lock', {}, LOCKER, 100).receipt.reason, 'not_due');
  assert.equal(r.send('finalise_lock', {}, LOCKER, 2000).receipt.receipt, 'accepted');
  assert.equal(r.state.phase, 'responses_locked');
  assert.equal(r.state.round.closing, undefined);
  assert.equal(r.state.round.aggregate.total, 2, 'answers sent in the window are in the frozen result');
  assert.equal(r.state.round.aggregate.counts[r.o.decompress], 2, 'the edit replaced the earlier answer');
  // The lock is one teaching action, under the id of the Lock press that opened the window.
  const lockCid = r.state.teachingActions.at(-1).id;
  assert.equal(r.state.teachingActions.filter(x => x.kind === 'lock').length, 1);
  assert.deepEqual(undoDescriptor(r.state), { available: true, targetEventId: lockCid, kind: 'lock' });
});

test('[AS-188] an answer at or after the deadline is refused as locked, even before the finaliser runs', () => {
  const r = room(), a = r.join();
  r.open();
  r.send('lock', { graceMs: 2000 });
  const late = r.vote(a, { option_id: r.o.image }, 2000);
  assert.equal(late.receipt.receipt, 'locked');
  assert.equal(late.receipt.reason, 'round_locked');
  assert.equal(r.state.round.responses[a], undefined);
});

test('[AS-188] Lock now finalises at once without a revision fence; Keep open ends the window; no grace means today', () => {
  const r = room(), a = r.join();
  r.open();
  r.send('lock', { graceMs: 2000 });
  r.vote(a, { option_id: r.o.image }, 100); // every vote moves the revision, so Lock now cannot carry a fence
  assert.equal(r.send('finalise_lock', {}, FAC, 100).receipt.receipt, 'accepted');
  assert.equal(r.state.phase, 'responses_locked');
  assert.equal(r.send('finalise_lock', {}, FAC, 100).receipt.reason, 'not_closing');

  const k = room(); k.join(); k.open();
  k.send('lock', { graceMs: 2000 });
  assert.equal(k.send('cancel_lock', {}, FAC, 100).receipt.receipt, 'accepted');
  assert.equal(k.state.round.closing, undefined);
  assert.equal(k.state.round.keptOpen, undefined, 'only an automatic countdown is remembered as kept open');
  assert.equal(k.send('finalise_lock', {}, LOCKER, 3000).receipt.reason, 'not_closing', 'a cancelled window never locks');
  assert.equal(k.state.phase, 'responses_open');

  const now = room(); now.join(); now.open();
  assert.equal(now.send('lock').receipt.receipt, 'accepted');
  assert.equal(now.state.phase, 'responses_locked', 'a lock without graceMs (tests, preview, the lab, manual) is immediate');
});

test('[AS-189] the automatic countdown: Keep open sticks for the round, a late joiner stops it, and the setting turns it off', () => {
  const r = room(), a = r.join();
  r.open();
  r.vote(a, { option_id: r.o.image });
  assert.equal(everyoneAnswered(r.state, [a]), true);
  assert.equal(r.send('lock', { graceMs: 3000 }, AUTO).receipt.receipt, 'accepted');
  assert.deepEqual(project(r.state, 'facilitator').round.closing.auto, true);
  // A late joiner gets to answer: the countdown stops, and every phone hears it.
  const joined = r.send('join', { displayName: 'Late' }, { role: 'participant', id: uuidv7() }, 500);
  assert.equal(r.state.round.closing, undefined);
  assert.ok(joined.effects.find(e => e.type === 'broadcast').roles.includes('participant'));
  // Keep open after an automatic countdown keeps the round open until the facilitator locks.
  r.send('lock', { graceMs: 3000 }, AUTO);
  assert.equal(r.send('cancel_lock').receipt.receipt, 'accepted');
  assert.equal(r.state.round.keptOpen, true);
  assert.equal(r.send('lock', { graceMs: 3000 }, AUTO).receipt.reason, 'auto_lock_off');
  assert.equal(r.send('lock', { graceMs: 2000 }).receipt.receipt, 'accepted', 'the facilitator can still lock');

  const off = room(), p = off.join();
  off.open(); off.vote(p, { option_id: off.o.image });
  assert.equal(off.send('set_auto_lock', { on: false }).receipt.receipt, 'accepted');
  assert.equal(project(off.state, 'facilitator').autoLock, false);
  assert.equal(off.send('lock', { graceMs: 3000 }, AUTO).receipt.reason, 'auto_lock_off');
  assert.equal(off.send('lock', {}, AUTO).receipt.reason, 'auto_lock_off', 'the system never locks at once');
});

test('[AS-189] everyone answered uses the console count: connected people plus anyone who answered, never an empty room', () => {
  const r = room(), a = r.join(), b = r.join();
  r.open();
  assert.equal(everyoneAnswered(r.state, []), false, 'nobody connected');
  r.vote(a, { option_id: r.o.image });
  assert.equal(everyoneAnswered(r.state, [a, b]), false, 'b is connected and has not answered');
  assert.equal(everyoneAnswered(r.state, [a]), true, 'b is not connected: a is everyone');
  assert.equal(everyoneAnswered(r.state, []), true, 'a answered and so counts, even after their phone sleeps');
  r.send('remove_participant', { participantId: a });
  assert.equal(everyoneAnswered(r.state, [b]), false, 'a removed answer no longer counts');
});

test('the closing deadline shares the room alarm slot', () => {
  assert.equal(earliestAlarm(1000, 0, 0), 1000);
  assert.equal(earliestAlarm(1000, 500, 0), 500);
  assert.equal(earliestAlarm(1000, 0, 300), 300);
  assert.equal(earliestAlarm(1000, 500, 700), 500);
  assert.equal(earliestAlarm(1000, 0), 1000, 'callers without a lock deadline are unchanged');
});
