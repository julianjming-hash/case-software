import { SELF, env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { miniCase } from '../helpers/mini-case.mjs';
import { acceptDisplayView } from '../../src/client/projector-view.mjs';
import { apiUrl } from '../../src/shared/urls.mjs';
import { validateCaseDocument } from '../../src/shared/case-document.mjs';

const command = (type, epoch = 0, payload = {}) => ({ v: 1, type, epoch, clientEventId: uuidv7(), ...payload });
async function room(fixture = miniCase()) {
  const sessionId = uuidv7(); const stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  expect(created.error).toBeUndefined();
  const display = await stub.issueDisplayToken();
  return { sessionId, stub, fixture, facilitatorToken: created.facilitatorToken, displayToken: display.token };
}
const view = async (r, token = r.displayToken) => (await r.stub.snapshot(token)).snapshot.view;
async function send(r, type, payload = {}, token = r.facilitatorToken) {
  const snapshot = await view(r, token); const body = command(type, snapshot.epoch, { ...(type === 'advance' ? { expectRevision: snapshot.revision } : {}), ...payload });
  const result = await r.stub.command(token, body);
  expect(result.receipt.receipt).toBe('accepted');
  return body;
}

it('[AS-088] Card24 native lobby counter and hidden closed chart survive eviction without duplicate arrivals', async () => {
  const r = await room(); const a = await r.stub.join('Same', 'shadows-01'); await r.stub.join('Same', 'shadows-01');
  const lobby = await view(r);
  expect(lobby.arrivalCount).toBe(2); expect(lobby.names.map(row => row.name)).toEqual(['Same', 'Same']);
  expect(JSON.stringify(lobby)).not.toContain(a.participantId); expect(JSON.stringify(lobby)).not.toContain(a.token);
  await send(r, 'start'); await send(r, 'advance');
  expect((await view(r, r.facilitatorToken)).round).toBeNull();
  await send(r, 'advance');
  const snapshot = await view(r, a.token);
  await send(r, 'vote', { roundId: snapshot.decision.roundId, response: { option_id: r.fixture.o.decompress } }, a.token);
  await send(r, 'show_names', { on: true });
  expect((await view(r)).names.map(row => row.name)).toEqual(['Same', 'Same']);
  await send(r, 'lock'); const closed = await view(r);
  expect((await view(r, r.facilitatorToken)).namesShown).toBe(false);
  expect(closed.avatars).toBeNull();
  expect((await r.stub.command(r.facilitatorToken, command('show_names', closed.epoch, { on: true }))).receipt.reason).toBe('hide_responses_first');
  expect(closed.responseResult.total).toBe(1); expect(closed.names).toBeNull();
  await send(r, 'select_path', { pathId: r.fixture.p.decompress });
  expect((await view(r)).responseResult).toEqual(closed.responseResult);
  await send(r, 'show_results', { on: false }); await evictDurableObject(r.stub);
  const restored = await view(r);
  expect(restored.arrivalCount).toBe(2); expect(restored.resultsShown).toBe(false); expect(restored.responseResult).toBeNull();
  await send(r, 'show_names', { on: true }); expect((await view(r)).names.map(row => row.name)).toEqual(['Same', 'Same']);
  await send(r, 'show_results', { on: true }); expect((await view(r)).names).toBeNull();
  expect((await view(r)).responseResult.total).toBe(1);
  await send(r, 'show_results', { on: false });
  await send(r, 'reveal'); expect((await view(r)).responseResult).toBeNull();
  expect((await view(r, a.token)).lastResult.total).toBe(1);
  await runInDurableObject(r.stub, instance => {
    const persisted = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
    expect(persisted.resultsShown).toBe(false); expect(persisted.arrivalCount).toBe(2);
  });
});

it('[AS-089] Card24 native ranking archives the latest full distribution exactly once', async () => {
  const fixture = miniCase(); const decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
  while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: `Option ${decision.interaction.options.length + 1}` });
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const r = await room(fixture); const a = await r.stub.join('Private A', 'shadows-01'); const b = await r.stub.join('Private B', 'shadows-02');
  await send(r, 'start'); await send(r, 'advance');
  expect((await view(r, r.facilitatorToken)).round).toBeNull();
  await send(r, 'advance'); const snapshot = await view(r, a.token);
  const options = [fixture.o.decompress, fixture.o.image, fixture.o.intubate];
  await send(r, 'vote', { roundId: snapshot.decision.roundId, response: { order: [options[1], options[0], options[2]] } }, a.token);
  const latest = await send(r, 'vote', { roundId: snapshot.decision.roundId, response: { order: options } }, a.token);
  expect((await r.stub.command(a.token, latest)).receipt.receipt).toBe('already_accepted');
  await send(r, 'vote', { roundId: snapshot.decision.roundId, response: { order: [options[0], options[2], options[1]] } }, b.token);
  await send(r, 'lock'); const result = (await view(r)).responseResult;
  expect(result.total).toBe(2); expect(result.rankCount).toBe(3);
  expect(result.counts.map(row => row.positionCounts)).toEqual([[2, 0, 0], [0, 1, 1], [0, 1, 1], ...Array.from({ length: 5 }, () => [0, 0, 0])]);
  expect(JSON.stringify(result)).not.toContain('Private');
  await runInDurableObject(r.stub, instance => {
    const row = instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', snapshot.decision.roundId).one();
    const aggregate = JSON.parse(row.aggregate);
    expect(aggregate.total).toBe(2); expect(aggregate.positionCounts[options[0]]).toEqual([2, 0, 0]);
    expect(aggregate.positionCounts[options[1]]).toEqual([0, 1, 1]);
  });
  const pageCommand = await send(r, 'results_page', { page: 3 });
  await send(r, 'show_results', { on: false });
  await evictDurableObject(r.stub);
  expect((await view(r)).resultsPage).toBe(3); expect((await view(r)).responseResult).toBeNull();
  expect((await r.stub.command(r.facilitatorToken, pageCommand)).receipt.receipt).toBe('already_accepted');
  await send(r, 'show_results', { on: true }); expect((await view(r)).responseResult).toEqual(result);
  await runInDurableObject(r.stub, instance => {
    const persisted = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
    expect(persisted.resultsPage).toBe(3);
  });
  await send(r, 'select_path', { pathId: fixture.p.decompress });
  await send(r, 'show_results', { on: false }); await send(r, 'reveal');
  await send(r, 'show_results', { on: true });
  await send(r, 'enter_manual', { segmentId: uuidv7() });
  expect((await view(r)).manual).toBe(true);
  await send(r, 'results_page', { page: 0 }); expect((await view(r)).resultsPage).toBe(0);
  expect((await view(r)).responseResult).toEqual(result);

});


it('Card24 native restored eligible ranking retains exact closure metadata and strict cold HTTP display', async () => {
  for (const disabledCount of [1, 2, 3]) {
    const fixture = miniCase(), decision = fixture.doc.decisions[0];
    decision.interaction.type = 'ranking'; delete decision.interaction.rank_count;
    decision.paths.forEach(path => { delete path.option_ids; });
    decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
    expect(validateCaseDocument(fixture.doc).ok).toBe(true);
    const r = await room(fixture), participant = await r.stub.join('Ranking learner', 'shadows-01');
    const eligible = decision.interaction.options.slice(0, 3 - disabledCount).map(option => option.id);
    // Fresh DSL ranking paths cannot disable options. Restore a supported legacy state explicitly.
    await runInDurableObject(r.stub, instance => {
      const stored = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
      stored.disabledOptions[decision.id] = decision.interaction.options.slice(-disabledCount).map(option => option.id);
      instance.sql.exec("UPDATE meta SET value=? WHERE key='state'", JSON.stringify(stored));
    });
    await evictDurableObject(r.stub);
    await send(r, 'start'); await send(r, 'advance'); await send(r, 'advance');
    const open = await view(r);
    expect(open.decision.interaction.rankCount).toBe(eligible.length || null);
    expect(acceptDisplayView(open)).toEqual(open);
    const snapshot = await view(r, participant.token);
    if (eligible.length) await send(r, 'vote', { roundId: snapshot.decision.roundId, response: { order: eligible } }, participant.token);
    else {
      const blank = await r.stub.command(participant.token, command('vote', snapshot.epoch, { roundId: snapshot.decision.roundId, response: { order: [] } }));
      expect(blank.receipt.receipt).toBe('rejected');
    }
    await send(r, 'lock');
    await runInDurableObject(r.stub, instance => {
      const stored = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
      expect(stored.round.aggregate.rankCount).toBe(eligible.length);
      expect(stored.round.aggregate.eligibleOptionIds).toEqual(eligible);
      const aggregate = JSON.parse(instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', stored.round.id).one().aggregate);
      expect(aggregate.rankCount).toBe(eligible.length); expect(aggregate.eligibleOptionIds).toEqual(eligible);
    });
    await evictDurableObject(r.stub);
    const response = await SELF.fetch(apiUrl('https://case.test', 'sessions', r.sessionId, 'snapshot'), { headers: { authorization: `Bearer ${r.displayToken}` } });
    expect(response.status).toBe(200);
    const cold = (await response.json()).view;
    expect(acceptDisplayView(cold)).toEqual(cold);
    expect(cold.responseResult.rankCount).toBe(eligible.length || null);
    expect(cold.responseResult.total).toBe(eligible.length ? 1 : 0);
    if (!eligible.length) expect(cold.responseResult.counts).toEqual([]);
    else expect(cold.responseResult.counts.map(row => row.positionCounts)).toEqual(
      decision.interaction.options.map(option => eligible.map(id => id === option.id ? 1 : 0)));

  }
});
