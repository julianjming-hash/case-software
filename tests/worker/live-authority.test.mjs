import { SELF, env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { apiUrl } from '../../src/shared/urls.mjs';
import { ConsoleManualRoom } from '../../src/client/console-manual.mjs';
import { acceptDisplayView } from '../../src/client/projector-view.mjs';
import { miniCase } from '../helpers/mini-case.mjs';

async function room(configure = () => {}) {
  const fixture = miniCase(); configure(fixture);
  const sessionId = uuidv7(), stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  const command = async (type, payload = {}, token = created.facilitatorToken) => {
    const current = (await stub.snapshot(created.facilitatorToken)).snapshot;
    const envelope = { v: 1, type, epoch: current.epoch, clientEventId: uuidv7(),
      ...(['advance', 'undo', 'reveal_path'].includes(type) ? { expectRevision: current.revision } : {}), ...payload };
    const result = await stub.command(token, envelope);
    expect(result.receipt.receipt, JSON.stringify(result)).toBe('accepted');
    return envelope;
  };
  await command('start'); await command('advance'); await command('advance');
  return { ...fixture, sessionId, stub, ...created, command };
}
const evidence = (stub, roundId) => runInDurableObject(stub, instance => ({
  round: instance.sql.exec('SELECT * FROM rounds WHERE id=?', roundId).toArray()[0],
  responses: instance.sql.exec('SELECT * FROM responses WHERE round_id=?', roundId).toArray(),
}));

it('atomic Reveal and Undo survive cold DO eviction with immutable original SQL and genuine seeded events', async () => {
  const a = await room(), participant = await a.stub.join('Private learner', 'shadows-01');
  const display = await a.stub.issueDisplayToken();
  const initial = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  const originalId = initial.mirror.round.id;
  await a.command('vote', { roundId: originalId, response: { option_id: a.o.decompress } }, participant.token);
  await a.command('lock');
  const reveal = await a.command('reveal_path', { pathId: a.p.decompress });
  const original = await evidence(a.stub, originalId);
  await evictDurableObject(a.stub);
  const undo = await a.command('undo', { targetEventId: reveal.clientEventId });
  const corrected = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  expect(corrected.mirror.round.id).not.toBe(originalId);
  expect(corrected.mirror.round.status).toBe('locked');
  expect(await evidence(a.stub, originalId)).toEqual(original);
  const seeded = await evidence(a.stub, corrected.mirror.round.id);
  expect(seeded.responses[0].id).not.toBe(original.responses[0].id);
  expect(seeded.responses[0].last_client_event_id).toBe(original.responses[0].last_client_event_id);
  expect(seeded.responses[0].first_submitted_at).toBe(original.responses[0].first_submitted_at);
  expect(seeded.responses[0].correction_event_id).toBe(undo.clientEventId);
  expect((await a.stub.command(a.facilitatorToken, undo)).receipt.receipt).toBe('already_accepted');
  await a.command('undo', { targetEventId: corrected.view.undo.targetEventId });
  await evictDurableObject(a.stub);
  const own = (await a.stub.snapshot(participant.token)).snapshot.view;
  expect(own.decision.yourResponse).toEqual({ option_id: a.o.decompress });
  const publicView = (await a.stub.snapshot(display.token)).snapshot.view;
  expect(acceptDisplayView(publicView)).toEqual(publicView);
  expect(publicView.publication.correctionOf).toBe(reveal.clientEventId);
  expect(JSON.stringify(publicView)).not.toContain(participant.participantId);
  expect(JSON.stringify(publicView)).not.toContain('Private learner');
});

it('actual authenticated manual upload restores local Reveal Undo after revision growth and cold hydration', async () => {
  const a = await room(), before = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  const saved = new Map(), storage = { setItem: (k,v) => saved.set(k,v), getItem: k => saved.get(k) ?? null, removeItem: k => saved.delete(k) };
  const manual = new ConsoleManualRoom(before.mirror, a.doc, { storage, channel: { postMessage() {} } });
  expect(manual.enter().receipt).toBe('accepted');
  expect(manual.command('reveal_path', { pathId: a.p.decompress }).receipt).toBe('accepted');
  expect(manual.command('undo', { targetEventId: manual.state.teachingActions.at(-1).id }).receipt).toBe('accepted');
  const restored = ConsoleManualRoom.restore(before.mirror, a.doc, ConsoleManualRoom.saved(a.sessionId, storage), { storage, channel: { postMessage() {} } });
  expect(restored.state.revealed).toEqual(manual.state.revealed);
  await a.stub.join('Later learner', 'shadows-01');
  await evictDurableObject(a.stub);
  const request = () => SELF.fetch(apiUrl('https://case.test', 'sessions', a.sessionId, 'manual-segment'), {
    method: 'POST', headers: { authorization: `Bearer ${a.facilitatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(restored.segmentBody()),
  });
  const response = await request(), result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200); expect(result.applied).toBe(3);
  const uploaded = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  expect(uploaded.mirror.round).toBe(null);
  expect(uploaded.mirror.revealed.at(-1).occurrenceId).toBe(manual.state.revealed.at(-1).occurrenceId);
  expect(uploaded.mirror.revealed.at(-1).correctionOf).toBe(manual.state.revealed.at(-1).correctionOf);
  expect((await (await request()).json()).applied).toBe(0);
  await evictDurableObject(a.stub);
  expect((await a.stub.snapshot(a.facilitatorToken)).snapshot.mirror).toEqual(uploaded.mirror);
  manual.close(); restored.close();
});

it('whole UTF8 state cap refuses Undo without committing seeds, journal or idempotency receipts', async () => {
  const a = await room(), person = await a.stub.join('Learner', 'shadows-01');
  const opened = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  await a.command('vote', { roundId: opened.mirror.round.id, response: { option_id: a.o.decompress } }, person.token);
  await a.command('lock'); const reveal = await a.command('reveal_path', { pathId: a.p.decompress });
  const before = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  const original = await evidence(a.stub, opened.mirror.round.id);
  const counts = await runInDurableObject(a.stub, instance => {
    instance.state = { ...instance.state, rounds: [...instance.state.rounds, { pad: '界'.repeat(400000) }] };
    return { journal: instance.sql.exec('SELECT count(*) n FROM journal').one().n, rounds: instance.sql.exec('SELECT count(*) n FROM rounds').one().n };
  });
  const undo = { v: 1, type: 'undo', epoch: before.epoch, clientEventId: uuidv7(), expectRevision: before.revision, targetEventId: reveal.clientEventId };
  for (let attempt = 0; attempt < 2; attempt++) expect((await a.stub.command(a.facilitatorToken, undo)).receipt.reason).toBe('room_state_too_large');
  expect(await evidence(a.stub, opened.mirror.round.id)).toEqual(original);
  await runInDurableObject(a.stub, instance => {
    expect(instance.sql.exec('SELECT count(*) n FROM journal').one().n).toBe(counts.journal);
    expect(instance.sql.exec('SELECT count(*) n FROM rounds').one().n).toBe(counts.rounds);
    expect(instance.sql.exec('SELECT count(*) n FROM responses WHERE correction_event_id=?', undo.clientEventId).one().n).toBe(0);
    expect(instance.sql.exec('SELECT count(*) n FROM receipts WHERE ledger_key LIKE ?', `%${undo.clientEventId}`).one().n).toBe(0);
    expect(new TextEncoder().encode(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value).byteLength).toBeLessThan(1000000);
  });
  await evictDurableObject(a.stub);
  expect((await a.stub.snapshot(a.facilitatorToken)).snapshot.revision).toBe(before.revision);
});

it('archive insertion fault rolls back new correction round, seed rows, state, journal and ledger together', async () => {
  const a = await room(), person = await a.stub.join('Learner', 'shadows-01');
  const opened = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  await a.command('vote', { roundId: opened.mirror.round.id, response: { option_id: a.o.decompress } }, person.token);
  await a.command('lock'); const reveal = await a.command('reveal_path', { pathId: a.p.decompress });
  const before = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
  const counts = await runInDurableObject(a.stub, instance => {
    instance.sql.exec("CREATE TRIGGER test_seed_fault BEFORE INSERT ON responses WHEN NEW.source_response_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_seed_fault'); END");
    return { journal: instance.sql.exec('SELECT count(*) n FROM journal').one().n, rounds: instance.sql.exec('SELECT count(*) n FROM rounds').one().n };
  });
  const undo = { v: 1, type: 'undo', epoch: before.epoch, clientEventId: uuidv7(), expectRevision: before.revision, targetEventId: reveal.clientEventId };
  const fault = await runInDurableObject(a.stub, async instance => {
    try { await instance.command(a.facilitatorToken, undo); return null; }
    catch (error) { return error.message; }
  });
  expect(fault).toContain('test_seed_fault');
  await runInDurableObject(a.stub, instance => {
    expect(instance.sql.exec('SELECT count(*) n FROM journal').one().n).toBe(counts.journal);
    expect(instance.sql.exec('SELECT count(*) n FROM rounds').one().n).toBe(counts.rounds);
    expect(instance.sql.exec('SELECT count(*) n FROM responses WHERE correction_event_id=?', undo.clientEventId).one().n).toBe(0);
    expect(instance.sql.exec('SELECT count(*) n FROM receipts WHERE ledger_key LIKE ?', `%${undo.clientEventId}`).one().n).toBe(0);
    instance.sql.exec('DROP TRIGGER test_seed_fault');
  });
  expect((await a.stub.snapshot(a.facilitatorToken)).snapshot.mirror).toEqual(before.mirror);
  expect((await a.stub.command(a.facilitatorToken, undo)).receipt.receipt).toBe('accepted');
});

for (const corruption of ['legacy_missing_event','legacy_wrong_decision','compact_missing_round','compact_missing_response']) {
  it(`cold ${corruption} fails truthful incomplete evidence without discarding control or inventing own answers`, async () => {
    const a = await room(), person = await a.stub.join('Learner', 'shadows-01');
    const opened = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
    await a.command('vote', { roundId: opened.mirror.round.id, response: { option_id: a.o.decompress } }, person.token);
    await a.command('lock'); await a.command('reveal_path', { pathId: a.p.decompress });
    const stored = await runInDurableObject(a.stub, instance => {
      const roundId = opened.mirror.round.id;
      if (corruption.startsWith('legacy')) {
        const saved = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
        delete saved.evidenceStateVersion;
        const round = saved.rounds[0]; delete round.evidenceRef;
        round.aggregate = JSON.parse(instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', roundId).one().aggregate);
        round.answers = { [person.participantId]: JSON.parse(instance.sql.exec('SELECT response FROM responses WHERE round_id=?', roundId).one().response) };
        instance.sql.exec("UPDATE meta SET value=? WHERE key='state'", JSON.stringify(saved));
      }
      if (corruption === 'legacy_missing_event') instance.sql.exec("UPDATE responses SET last_client_event_id='' WHERE round_id=?", roundId);
      if (corruption === 'legacy_wrong_decision') instance.sql.exec('UPDATE rounds SET decision_id=? WHERE id=?', uuidv7(), roundId);
      if (corruption === 'compact_missing_round') {
        instance.sql.exec('DELETE FROM responses WHERE round_id=?', roundId);
        instance.sql.exec('DELETE FROM rounds WHERE id=?', roundId);
      }
      if (corruption === 'compact_missing_response') instance.sql.exec('DELETE FROM responses WHERE round_id=?', roundId);
      return instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value;
    });
    await evictDurableObject(a.stub);
    expect(await a.stub.snapshot(person.token)).toMatchObject({ error: 'incomplete_room_evidence', status: 503 });
    expect(await a.stub.snapshot(a.facilitatorToken)).toMatchObject({ error: 'incomplete_room_evidence', status: 503 });
    await runInDurableObject(a.stub, instance => {
      expect(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value).toBe(stored);
      expect(instance.maintenancePending).toBe(true);
    });
  });
}

for (const corruption of ['count_string','count_object','position_string','complete_order_string']) {
  it(`cold resolved ${corruption} refuses every audience without exposing or replacing corrupt SQLite evidence`, async () => {
    const ranked = corruption.startsWith('position') || corruption.startsWith('complete');
    const a = await room(({ doc, o, p }) => {
      if (!ranked) return;
      const decision = doc.decisions[0]; decision.interaction.type = 'ranking'; decision.interaction.rank_count = 2;
      decision.paths.forEach(path => { delete path.option_ids; });
      decision.rules = [{ when: { top: [o.decompress] }, path_id: p.decompress }];
    });
    const person = await a.stub.join('Learner', 'shadows-01'), display = await a.stub.issueDisplayToken();
    const opened = (await a.stub.snapshot(a.facilitatorToken)).snapshot;
    const roundId = opened.mirror.round.id;
    await a.command('vote', { roundId, response: ranked ? { order: [a.o.decompress, a.o.image] } : { option_id: a.o.decompress } }, person.token);
    await a.command('lock'); await a.command('reveal_path', { pathId: a.p.decompress });
    await a.command('show_results', { on: true });
    expect((await a.stub.snapshot(a.facilitatorToken)).snapshot.mirror.round).toBe(null);
    const validPublic = (await a.stub.snapshot(display.token)).snapshot.view;
    expect(acceptDisplayView(validPublic)).toEqual(validPublic);
    const stored = await runInDurableObject(a.stub, instance => {
      const aggregate = JSON.parse(instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', roundId).one().aggregate);
      const marker = 'PRIVATE_CORRUPTION_SENTINEL';
      if (corruption === 'count_string') aggregate.counts[a.o.decompress] = marker;
      if (corruption === 'count_object') aggregate.counts[a.o.decompress] = { text: marker };
      if (corruption === 'position_string') aggregate.positionCounts[a.o.decompress][0] = marker;
      if (corruption === 'complete_order_string') aggregate.completeOrders[0][1] = marker;
      instance.sql.exec('UPDATE rounds SET aggregate=? WHERE id=?', JSON.stringify(aggregate), roundId);
      return { state: instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value,
        aggregate: instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', roundId).one().aggregate };
    });
    await evictDurableObject(a.stub);
    for (const token of [display.token, person.token, a.facilitatorToken]) {
      const result = await a.stub.snapshot(token);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CORRUPTION_SENTINEL');
      expect(result).toEqual({ error: 'incomplete_room_evidence', status: 503 });
    }
    await runInDurableObject(a.stub, instance => {
      expect(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value).toBe(stored.state);
      expect(instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', roundId).one().aggregate).toBe(stored.aggregate);
      expect(instance.maintenancePending).toBe(true);
    });
  });
}
