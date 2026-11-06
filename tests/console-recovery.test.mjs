import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualRecovery } from '../src/client/console-recovery.mjs';

test('Card 12 manual recovery retries the same bounded segment after an ambiguous upload', async () => {
  let resumes = 0, sent = [];
  const body = { v: 1, segmentId: 'segment', events: [{ type: 'resume_online' }] };
  const manual = { view: () => ({ actions: ['resume_online'] }),
    command(type) { assert.equal(type, 'resume_online'); resumes++; return { receipt: 'accepted' }; },
    segmentBody: () => body, forget() {}, close() {} };
  const upload = async value => { sent.push(value); return sent.length === 1 ?
    { status: 0, body: null } : { status: 200, body: { ok: true } }; };
  const recovery = createManualRecovery(manual, upload);
  assert.equal((await recovery.resume()).kind, 'retryable');
  assert.equal(recovery.pending, true);
  assert.equal((await recovery.resume()).kind, 'applied');
  assert.equal(resumes, 1);
  assert.deepEqual(sent, [body, body]);
});

test('Card 12 refused manual recovery preserves notes and gives a follow-room outcome', async () => {
  let forgotten = false, closed = false;
  const manual = { view: () => ({ actions: ['resume_online'] }),
    command: () => ({ receipt: 'accepted' }), segmentBody: () => ({ segmentId: 'same' }),
    forget() { forgotten = true; }, close() { closed = true; } };
  const recovery = createManualRecovery(manual, async () =>
    ({ status: 409, body: { error: 'room_moved_on' } }));
  assert.equal((await recovery.resume()).kind, 'refused');
  assert.equal(recovery.pending, true);
  assert.equal(forgotten, false);
  assert.equal(closed, false);
});
