// CASE-169: the per-vote archive outbox write is O(1) in the number of participants. Before it, every
// vote re-read every participant's credential and re-upserted every participant and response (about
// 2n SQL statements per vote), which made a 50-phone burst drain in O(n^2) and tripped the CI load gates.
import { env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { miniCase } from '../helpers/mini-case.mjs';
import { writeArchiveState } from '../../src/worker/room-archive.mjs';

async function openRoom(phones) {
  const fixture = miniCase();
  const sessionId = uuidv7(), stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  expect(created.error).toBeUndefined();
  const learners = [];
  for (let i = 0; i < phones; i++) learners.push(await stub.join(`Learner ${i + 1}`, 'shadows-01'));
  const view = async token => (await stub.snapshot(token)).snapshot.view;
  const command = async (type, payload = {}, token = created.facilitatorToken) => {
    const current = await view(token);
    const result = await stub.command(token, { v: 1, type, epoch: current.epoch, clientEventId: uuidv7(),
      ...(type === 'advance' ? { expectRevision: current.revision } : {}), ...payload });
    expect(result.receipt.receipt, `${type}: ${result.receipt.reason ?? ''}`).toBe('accepted');
  };
  await command('start'); await command('advance'); await command('advance');
  const vote = async (learner, option = 0) => {
    const current = await view(learner.token);
    await command('vote', { roundId: current.decision.roundId,
      response: { option_id: current.decision.interaction.options[option].id } }, learner.token);
  };
  return { stub, learners, vote };
}

/** SQL statements one call makes inside the Durable Object, counted on the instance's own handle. */
async function countStatements(stub, run) {
  await runInDurableObject(stub, instance => {
    const real = instance.sql;
    instance.countedStatements = 0;
    instance.sql = new Proxy(real, { get(target, key) {
      if (key === 'exec') return (...args) => { instance.countedStatements++; return target.exec(...args); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    instance.realSql = real;
  });
  await run();
  return runInDurableObject(stub, instance => {
    instance.sql = instance.realSql;
    return instance.countedStatements;
  });
}

async function voteCost(phones) {
  const room = await openRoom(phones);
  // Everyone but the last two has voted, so the round holds n-2 responses when the counted votes land.
  for (const learner of room.learners.slice(0, -2)) await room.vote(learner);
  const first = await countStatements(room.stub, () => room.vote(room.learners.at(-2)));
  const revote = await countStatements(room.stub, () => room.vote(room.learners[0], 1));
  // A cold instance has an empty write cache: its first write may rescan once, later votes do not.
  await evictDurableObject(room.stub);
  await room.vote(room.learners[1], 1);
  const afterCold = await countStatements(room.stub, () => room.vote(room.learners.at(-1)));
  return { first, revote, afterCold };
}

it('[AS-029] CASE-169 a vote costs the same SQL statements with 10 or 150 phones in the room', { timeout: 120_000 }, async () => {
  const small = await voteCost(10), large = await voteCost(150);
  // Only the vote's own response and the room's fixed rows are written; nothing scales with n.
  // Measured 2026-10-06: 9 statements at both sizes (the full rescan was 38 at 10 phones, 458 at 150).
  expect(large).toEqual(small);
  for (const cost of Object.values(large)) expect(cost).toBeLessThanOrEqual(12);
});

// A rolled-back command must leave nothing in the write cache: otherwise the identical retry looks
// unchanged, is skipped, and the outbox silently keeps the pre-command row (CASE-169).
it('[AS-029] CASE-169 a command rolled back after its outbox write is archived in full when retried', { timeout: 60_000 }, async () => {
  const fixture = miniCase();
  const sessionId = uuidv7(), stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  const learners = [await stub.join('Learner 1', 'shadows-01'), await stub.join('Learner 2', 'shadows-01')];
  const view = async token => (await stub.snapshot(token)).snapshot.view;
  const send = async (type, payload = {}, token = created.facilitatorToken) => {
    const current = await view(token);
    return stub.command(token, { v: 1, type, epoch: current.epoch, clientEventId: uuidv7(),
      ...(type === 'advance' ? { expectRevision: current.revision } : {}), ...payload });
  };
  for (const type of ['start', 'advance', 'advance']) expect((await send(type)).receipt.receipt).toBe('accepted');
  for (const learner of learners) {
    const current = await view(learner.token);
    expect((await send('vote', { roundId: current.decision.roundId,
      response: { option_id: current.decision.interaction.options[0].id } }, learner.token)).receipt.receipt).toBe('accepted');
  }
  // Freeze the clock so the retried lock writes exactly the values of the rolled-back one, and make
  // the next storage transaction fail after its body (and so the round's outbox upsert) has run.
  await runInDurableObject(stub, instance => {
    const RealDate = Date, frozen = RealDate.now() + 1000;
    instance.realDate = RealDate;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [frozen])); }
      static now() { return frozen; }
    };
    const storage = instance.ctx.storage, real = storage.transactionSync.bind(storage);
    instance.realTransactionSync = real;
    storage.transactionSync = fn => { storage.transactionSync = real; return real(() => { fn(); throw new Error('injected_after_outbox_write'); }); };
  });
  await expect(send('lock')).rejects.toThrow();
  expect((await send('lock')).receipt.receipt).toBe('accepted');
  const drift = await runInDurableObject(stub, instance => {
    globalThis.Date = instance.realDate;
    const dump = () => Object.fromEntries(['participants', 'rounds', 'responses'].map(table =>
      [table, instance.sql.exec(`SELECT * FROM ${table} ORDER BY id`).toArray()]));
    const before = dump();
    // The full rescan is the oracle: if the outbox already holds the room's state, it changes nothing.
    instance.ctx.storage.transactionSync(() => writeArchiveState(instance.sql, instance.state, Date.now()));
    return { before, after: dump(), status: instance.state.round.status };
  });
  expect(drift.status).toBe('locked');
  expect(drift.before).toEqual(drift.after);
});
