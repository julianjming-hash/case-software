import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, OUTBOX_LIMIT } from '../src/client/outbox.mjs';
import { uuidv7, isUuidV7 } from '../src/shared/ids.mjs';

function fixture() {
  const rows = new Map();
  const store = { async update(room, change) { const next = change(structuredClone(rows.get(room) ?? [])); rows.set(room, structuredClone(next.rows)); return next.result; } };
  const roomId = uuidv7(), participantId = uuidv7(), roundId = uuidv7();
  const received = [];
  const make = (send = async frame => { received.push(frame); return { receipt: 'accepted' }; }, owner = participantId) => createOutbox({ store, roomId, participantId: owner, send });
  return { store, rows, roomId, participantId, roundId, received, make };
}

test('offline changed answers survive recreation and send only the latest once per round', async () => {
  const f = fixture(), box = f.make(), secondRound = uuidv7();
  const a = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const b = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const c = await box.enqueue({ roundId: secondRound, epoch: 1, response: { option_id: uuidv7() } });
  assert.ok(isUuidV7(a.clientEventId)); assert.notEqual(a.clientEventId, b.clientEventId);
  const restored = f.make(); assert.equal(await restored.count(), 2);
  assert.deepEqual((await restored.latest(f.roundId)).response, b.response);
  await Promise.all([restored.flush(), restored.flush()]);
  assert.deepEqual(f.received.map(r => r.clientEventId), [b.clientEventId, c.clientEventId]);
  assert.deepEqual(f.received.map(r => r.roundId), [f.roundId, secondRound]);
  assert.equal(await restored.count(), 0); await restored.flush(); assert.equal(f.received.length, 2);
});

test('outbox cap drops the oldest superseded answer and never silently discards a live round', async () => {
  const f = fixture(), box = f.make();
  const first = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'first' } });
  await box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'latest' } });
  for (let i = 2; i < OUTBOX_LIMIT; i++) await box.enqueue({ roundId: uuidv7(), epoch: 1, response: { text: `answer ${i}` } });
  await box.enqueue({ roundId: uuidv7(), epoch: 1, response: { text: 'twentieth active round' } });
  assert.equal(f.rows.get(f.roomId).length, 20); assert.ok(!f.rows.get(f.roomId).some(r => r.envelope.clientEventId === first.clientEventId));
  await assert.rejects(box.enqueue({ roundId: uuidv7(), epoch: 1, response: { text: 'overflow' } }), /full/);
  assert.equal(await box.count(), 20);
  const g = fixture(), scoped = g.make(), currentRound = uuidv7();
  const olderOther = await scoped.enqueue({ roundId: g.roundId, epoch: 1, response: { text: 'older other' } });
  await scoped.enqueue({ roundId: g.roundId, epoch: 1, response: { text: 'other latest' } });
  const current = await scoped.enqueue({ roundId: currentRound, epoch: 1, response: { text: 'current prior' } });
  for (let i = 3; i < OUTBOX_LIMIT; i++) await scoped.enqueue({ roundId: uuidv7(), epoch: 1, response: { text: `live ${i}` } });
  await scoped.enqueue({ roundId: currentRound, epoch: 1, response: { text: 'current newest' } });
  assert.ok(g.rows.get(g.roomId).some(row => row.envelope.clientEventId === olderOther.clientEventId));
  assert.ok(!g.rows.get(g.roomId).some(row => row.envelope.clientEventId === current.clientEventId));
});

test('all four authored response shapes survive durable delivery without private extra fields', async () => {
  const f = fixture(), box = f.make();
  const responses = [{ option_id: uuidv7() }, { option_ids: [uuidv7(), uuidv7()] }, { order: [uuidv7(), uuidv7()] }, { text: 'own words' }];
  for (const response of responses) await box.enqueue({ roundId: uuidv7(), epoch: 1, response });
  await box.flush(); assert.deepEqual(f.received.map(frame => frame.response), responses);
  await assert.rejects(box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'own', token: 'secret' } }), /invalid/);
});

test('uncertain delivery and paused receipts retain identity while stale epoch changes only the fence', async () => {
  const f = fixture(); let step = 0; const frames = [];
  const box = f.make(async frame => { frames.push(structuredClone(frame)); if (++step === 1) throw new Error('offline'); return { receipt: step === 2 ? 'paused_held' : 'accepted' }; });
  const queued = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'own answer' } });
  await box.flush(); await box.flush(); assert.equal(await box.count(), 1);
  await box.setEpoch(2); await box.flush();
  assert.deepEqual(frames.map(r => r.clientEventId), Array(3).fill(queued.clientEventId));
  assert.deepEqual(frames.map(r => r.response), Array(3).fill({ text: 'own answer' })); assert.equal(frames[2].epoch, 2); assert.equal(await box.count(), 0);
});

test('room and participant scope prevent another participant queue from sending or appearing', async () => {
  const f = fixture(); await f.make().enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'private' } });
  const other = f.make(undefined, uuidv7()); assert.equal(await other.count(), 0); await other.flush(); assert.equal(f.received.length, 0);
  await other.clear(); assert.equal(await f.make().count(), 1);
  assert.ok(!JSON.stringify(f.rows.get(f.roomId)).includes('token'));
  await f.make().clear(); assert.equal(f.rows.get(f.roomId).length, 0);
});

test('clear during in-flight delivery cannot resurrect votes and persisted envelopes reject smuggled fields', async () => {
  const f = fixture(); let finish; const box = f.make(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'x' }, token: 'secret' }), /invalid/);
  await box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'valid' } });
  const pending = box.flush(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  await box.clear(); finish({ receipt: 'paused_held' }); await pending;
  assert.equal(await box.count(), 0); assert.equal(f.rows.get(f.roomId).length, 0);
});

test('held A then B/C drains only latest C after A is authoritatively settled', async () => {
  const f = fixture(); let finish;
  const box = f.make(async frame => {
    f.received.push(frame);
    if (f.received.length === 1) return new Promise(resolve => { finish = resolve; });
    return { receipt: 'accepted' };
  });
  const a = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const draining = box.flush(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const c = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  assert.deepEqual(f.received.map(x => x.clientEventId), [a.clientEventId]);
  finish({ receipt: 'accepted' }); await draining;
  assert.deepEqual(f.received.map(x => x.clientEventId), [a.clientEventId, c.clientEventId]);
  assert.equal(await box.count(), 0);
});

test('[AS-116] uncertain admitted A survives recreation and cannot be overtaken by C or a late HTTP write', async () => {
  const f = fixture(); const received = [], accepted = new Set(); let latest, late;
  const a = await f.make().enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const server = frame => { if (!accepted.has(frame.clientEventId)) { accepted.add(frame.clientEventId); latest = frame.response; } return { receipt: 'accepted' }; };
  const first = f.make(async frame => { received.push(frame.clientEventId); late = () => server(frame); return { receipt: 'timeout' }; });
  await first.flush(); await first.close();
  const restored = f.make(async frame => { received.push(frame.clientEventId); return server(frame); });
  const c = await restored.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  await restored.flush(); late();
  assert.deepEqual(received, [a.clientEventId, a.clientEventId, c.clientEventId]);
  assert.deepEqual(latest, c.response, 'late admitted A must be an idempotent replay, never the final answer');
  assert.equal(await restored.count(), 0);
});

test('queue pressure never evicts an uncertain admitted vote before its terminal receipt', async () => {
  const f = fixture(), box = f.make(async () => ({ receipt: 'timeout' }));
  const a = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: 'admitted' } });
  await box.flush();
  for (let i = 0; i < OUTBOX_LIMIT + 2; i++) await box.enqueue({ roundId: f.roundId, epoch: 1, response: { text: String(i) } });
  assert.ok(f.rows.get(f.roomId).some(row => row.envelope.clientEventId === a.clientEventId));
});

test('round terminal refusal fences queued replacements without dispatching them', async () => {
  for (const receipt of ['locked', 'voided', 'removed', 'ended']) {
    const f = fixture(); let finish;
    const box = f.make(async frame => { f.received.push(frame); return new Promise(resolve => { finish = resolve; }); });
    await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
    const draining = box.flush(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
    finish({ receipt }); await draining;
    assert.equal(f.received.length, 1, receipt); assert.equal(await box.count(), 0);
  }
});

test('two restored outboxes share delivery admission and late duplicates cannot overwrite latest', async () => {
  const f = fixture(), tails = new Map(); let finish;
  const locks = { request(key, operation) {
    const next = (tails.get(key) ?? Promise.resolve()).then(operation);
    tails.set(key, next.catch(() => {})); return next;
  } };
  const seen = [], accepted = new Set(); let latest;
  const send = async frame => {
    seen.push(frame);
    if (seen.length === 1) await new Promise(resolve => { finish = resolve; });
    if (!accepted.has(frame.clientEventId)) { accepted.add(frame.clientEventId); latest = frame.response; }
    return { receipt: 'accepted' };
  };
  const one = createOutbox({ ...f, store: f.store, send, locks }), two = createOutbox({ ...f, store: f.store, send, locks });
  await one.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const first = one.flush(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  const c = await two.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const second = two.flush();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.length, 1);
  finish(); await Promise.all([first, second]);
  assert.equal(seen.length, 2); assert.deepEqual(latest, c.response);
  assert.equal(await two.count(), 0);
});

test('a settled payload rejection permits the latest valid choice; a closed round notifies only after durable removal', async () => {
  const f = fixture(); let finish;
  const box = f.make(async frame => {
    f.received.push(frame);
    return f.received.length === 1 ? new Promise(resolve => { finish = resolve; }) : { receipt: 'accepted' };
  });
  await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const first = box.flush(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  const c = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  finish({ receipt: 'rejected', reason: 'bad_response' }); await first;
  assert.equal(f.received.length, 2); assert.equal(f.received[1].clientEventId, c.clientEventId);
  const outcomes = [];
  const blocked = createOutbox({ ...f, store: f.store, send: async () => ({ receipt: 'locked' }), onRoundClosed: (roundId, receipt) => {
    outcomes.push([roundId, receipt]); assert.equal(f.rows.get(f.roomId).length, 0);
  } });
  await blocked.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  await blocked.flush(); assert.deepEqual(outcomes, [[f.roundId, 'locked']]);
});

test('legacy unknown admission settles superseded envelopes before the latest regardless of primary-key order', async () => {
  const f = fixture(), box = f.make();
  const a = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const c = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  f.rows.set(f.roomId, f.rows.get(f.roomId).map(({ admitted, ...row }) => row).reverse());
  const restored = f.make(); await restored.flush();
  assert.deepEqual(f.received.map(row => row.clientEventId), [a.clientEventId, c.clientEventId]);
});

test('a resume requested before a held flight settles drains again with the same event identity', async () => {
  const f = fixture(); let finish;
  const box = f.make(async frame => {
    f.received.push(structuredClone(frame));
    return f.received.length === 1 ? new Promise(resolve => { finish = resolve; }) : { receipt: 'accepted' };
  });
  const a = await box.enqueue({ roundId: f.roundId, epoch: 1, response: { option_id: uuidv7() } });
  const first = box.flush(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  await box.setEpoch(2);
  const resumed = box.flush();
  finish({ receipt: 'paused_held' }); await Promise.all([first, resumed]);
  assert.deepEqual(f.received.map(frame => frame.clientEventId), [a.clientEventId, a.clientEventId]);
  assert.deepEqual(f.received.map(frame => frame.epoch), [1, 2]);
  assert.equal(await box.count(), 0);
});
