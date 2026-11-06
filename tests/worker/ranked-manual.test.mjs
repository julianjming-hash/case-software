import { SELF, env, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { apiUrl } from '../../src/shared/urls.mjs';
import { ConsoleManualRoom } from '../../src/client/console-manual.mjs';
import { acceptDisplayView } from '../../src/client/projector-view.mjs';
import { miniCase } from '../helpers/mini-case.mjs';

it('Card25 authenticated native manual selection recovers after participant arrival and remains cold and replay safe', async () => {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  const sessionId = uuidv7(), stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  const display = await stub.issueDisplayToken();
  const command = async (type, payload = {}, token = created.facilitatorToken) => {
    const current = (await stub.snapshot(token)).snapshot.view;
    const result = await stub.command(token, { v: 1, type, epoch: current.epoch, clientEventId: uuidv7(),
      ...(type === 'advance' ? { expectRevision: current.revision } : {}), ...payload });
    expect(result.receipt.receipt).toBe('accepted');
  };
  const learners = [];
  for (let i = 0; i < 4; i++) learners.push(await stub.join(`Learner ${i + 1}`, 'shadows-01'));
  await command('start'); await command('advance'); await command('advance');
  const ids = decision.interaction.options.map(option => option.id);
  for (const [index, tuple] of ['012', '021', '102', '210'].entries()) {
    const current = (await stub.snapshot(learners[index].token)).snapshot.view;
    await command('vote', { roundId: current.decision.roundId, response: { order: [...tuple].map(digit => ids[Number(digit)]) } }, learners[index].token);
  }
  await command('lock'); await command('show_results', { on: false });
  await command('select_path', { pathId: fixture.p.decompress }); await command('reveal'); await command('show_results', { on: true });
  const before = (await stub.snapshot(created.facilitatorToken)).snapshot;
  const entries = new Map(), storage = { setItem(k, v) { entries.set(k, v); }, getItem(k) { return entries.get(k) ?? null; }, removeItem(k) { entries.delete(k); } };
  const manual = new ConsoleManualRoom(before.mirror, fixture.doc, { storage, channel: { postMessage() {} } });
  expect(manual.enter().receipt).toBe('accepted');
  expect(manual.command('ranked_page', { group: 2, position: 0, closedRoundId: manual.view().rankedRoundId, expectRevision: manual.state.revision }).receipt).toBe('accepted');
  expect(manual.command('resume_online').receipt).toBe('accepted');
  const body = manual.segmentBody();
  expect(body.events[1].expectRevision).toBeUndefined();
  expect(body.events[1].closedRoundId).toBe(before.view.rankedRoundId);
  await stub.join('Later arrival', 'shadows-01');
  const request = (token, segment = body) => SELF.fetch(apiUrl('https://case.test', 'sessions', sessionId, 'manual-segment'), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(segment),
  });
  const stable = (await stub.snapshot(created.facilitatorToken)).snapshot;
  const online = { v: 1, type: 'ranked_page', epoch: stable.epoch, clientEventId: uuidv7(), group: 2, position: 0,
    closedRoundId: stable.view.rankedRoundId };
  expect((await stub.command(created.facilitatorToken, online)).receipt.reason).toBe('bad_ranked_page');
  expect((await stub.command(created.facilitatorToken, { ...online, expectRevision: stable.revision - 1 })).receipt.reason).toBe('stale_revision');
  expect((await stub.command(created.facilitatorToken, { ...online, expectRevision: stable.revision, closedRoundId: uuidv7() })).receipt.reason).toBe('stale_closed_round');
  const invalid = structuredClone(body);
  invalid.events.splice(invalid.events.length - 1, 0, { ...invalid.events[1], clientEventId: uuidv7(), closedRoundId: uuidv7() });
  const refused = await request(created.facilitatorToken, invalid);
  expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: 'stale_closed_round', failedAt: 2 });
  expect((await stub.snapshot(created.facilitatorToken)).snapshot.mirror).toEqual(stable.mirror);
  const firstUpload = await request(created.facilitatorToken);
  const firstBody = await firstUpload.json();
  expect(firstUpload.status, JSON.stringify({ error: firstBody.error, failedAt: firstBody.failedAt })).toBe(200);
  expect(firstBody.applied).toBe(3);
  const after = (await stub.snapshot(created.facilitatorToken)).snapshot;
  const repeated = await request(created.facilitatorToken);
  expect(repeated.status).toBe(200); expect((await repeated.json()).applied).toBe(0);
  expect((await stub.snapshot(created.facilitatorToken)).snapshot.mirror).toEqual(after.mirror);
  const changedTarget = structuredClone(body); changedTarget.events[1].closedRoundId = uuidv7();
  const reused = await request(created.facilitatorToken, changedTarget);
  expect(reused.status).toBe(409); expect(await reused.json()).toMatchObject({ error: 'client_event_id_reused', failedAt: 1 });
  expect((await stub.snapshot(created.facilitatorToken)).snapshot.mirror).toEqual(after.mirror);
  expect((await request(learners[0].token)).status).toBe(403);
  await evictDurableObject(stub);
  const cold = (await stub.snapshot(display.token)).snapshot.view;
  expect(acceptDisplayView(cold)).toEqual(cold);
  expect(cold.responseResult.ranked.groups).toEqual([['102', 1], ['210', 1]]);
  expect(cold.manual).toBe(false);
  expect(JSON.stringify(cold)).not.toContain('closedRoundId');
  expect(JSON.stringify(cold)).not.toContain('Learner');
  manual.close();
});
