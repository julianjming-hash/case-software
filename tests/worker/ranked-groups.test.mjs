import { SELF, env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { miniCase } from '../helpers/mini-case.mjs';
import { apiUrl } from '../../src/shared/urls.mjs';
import { acceptDisplayView } from '../../src/client/projector-view.mjs';
import { validateCaseDocument } from '../../src/shared/case-document.mjs';
import { archiveBatch, acknowledgeBatch, writeArchiveState } from '../../src/worker/room-archive.mjs';
import { projectorFrame } from '../../src/client/console-projection.mjs';
import { ConsoleManualRoom } from '../../src/client/console-manual.mjs';

it('Card25 native complete orders persist at lock and fenced selection survives cold HTTP and receipts', async () => {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  expect(validateCaseDocument(fixture.doc).ok).toBe(true);
  const sessionId = uuidv7(), stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  expect(created.error).toBeUndefined();
  const display = await stub.issueDisplayToken(), learners = [];
  for (let i = 0; i < 18; i++) learners.push(await stub.join(`Learner ${i + 1}`, 'shadows-01'));
  const snapshot = async token => (await stub.snapshot(token)).snapshot.view;
  const command = async (type, payload = {}, token = created.facilitatorToken) => {
    const current = await snapshot(token);
    const body = { v: 1, type, epoch: current.epoch, clientEventId: uuidv7(),
      ...(['advance', 'ranked_page'].includes(type) ? { expectRevision: current.revision } : {}),
      ...(type === 'ranked_page' ? { closedRoundId: current.rankedRoundId } : {}), ...payload };
    const result = await stub.command(token, body);
    expect(result.receipt.receipt).toBe('accepted');
    return body;
  };
  await command('start'); await command('advance'); await command('advance');
  const ids = decision.interaction.options.map(option => option.id);
  const choices = ['012', '021', '102', '210'], counts = [10, 5, 2, 1];
  let learner = 0;
  for (let group = 0; group < choices.length; group++) for (let n = 0; n < counts[group]; n++) {
    const p = learners[learner++], current = await snapshot(p.token);
    await command('vote', { roundId: current.decision.roundId, response: { order: [...choices[group]].map(index => ids[Number(index)]) } }, p.token);
  }
  await command('lock');
  const expected = choices.map((tuple, index) => [tuple, counts[index]]);
  await runInDurableObject(stub, instance => {
    const saved = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
    expect(saved.round.aggregate.completeOrders).toEqual(expected);
    expect(JSON.parse(instance.sql.exec('SELECT aggregate FROM rounds WHERE id=?', saved.round.id).one().aggregate).completeOrders).toEqual(expected);
  });
  const closed = await snapshot(display.token);
  expect(closed.responseResult.ranked.groups).toEqual(expected.slice(0, 2));
  expect(closed.responseResult.total).toBe(18);
  const other = await command('ranked_page', { group: 2, position: 0 });
  expect((await snapshot(display.token)).responseResult.ranked.groups).toEqual(expected.slice(2));
  await command('show_results', { on: false }); await evictDurableObject(stub);
  expect((await snapshot(display.token)).responseResult).toBeNull();
  expect((await stub.command(created.facilitatorToken, other)).receipt.receipt).toBe('already_accepted');
  expect((await snapshot(created.facilitatorToken)).rankedSelection).toEqual({ group: 2, position: 0 });
  await command('show_results', { on: true }); await evictDurableObject(stub);
  const http = await SELF.fetch(apiUrl('https://case.test', 'sessions', sessionId, 'snapshot'), { headers: { authorization: `Bearer ${display.token}` } });
  expect(http.status).toBe(200);
  const cold = (await http.json()).view;
  expect(acceptDisplayView(cold)).toEqual(cold);
  expect(cold.responseResult.ranked.groups).toEqual(expected.slice(2));
  expect(cold.responseResult.total).toBe(18);
  for (const p of learners) {
    expect(JSON.stringify(cold)).not.toContain(p.participantId);
    expect(JSON.stringify(cold)).not.toContain(p.token);
  }
  expect(JSON.stringify(cold)).not.toContain('Learner');
  await command('ranked_page', { group: 0, position: 0 });
  expect((await snapshot(display.token)).responseResult.ranked.groups).toEqual(expected.slice(0, 2));
  const held = await runInDurableObject(stub, instance => {
    const first = archiveBatch(instance.sql, instance.state, null, null, false);
    expect(first.batch.rounds[0].aggregate.completeOrders).toEqual(expected);
    expect(first.rows).toBeLessThanOrEqual(200); expect(first.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(archiveBatch(instance.sql, instance.state, null, null, false)).toEqual(first);
    return first;
  });
  await command('reopen');
  await runInDurableObject(stub, instance => {
    acknowledgeBatch(instance.sql, held.marks); acknowledgeBatch(instance.sql, held.marks);
    const old = instance.sql.exec('SELECT archived,aggregate FROM rounds WHERE id=?', held.batch.rounds[0].id).one();
    expect(old.archived).toBe(0); expect(JSON.parse(old.aggregate).completeOrders).toEqual(expected);
    expect(archiveBatch(instance.sql, instance.state, null, null, false).batch.rounds.some(round => round.id === held.batch.rounds[0].id)).toBe(true);
  });
  expect((await snapshot(created.facilitatorToken)).rankedSelection).toEqual({ group: 0, position: 0 });

  // Maximum fixture: real admitted credentials and valid restored latest normalized answers.
  const maximum = miniCase(), d = maximum.doc.decisions[0];
  d.interaction.type = 'ranking'; d.interaction.rank_count = 8; d.prompt = '界'.repeat(200);
  while (d.interaction.options.length < 8) d.interaction.options.push({ id: uuidv7(), label: 'Maximum option' });
  d.interaction.options.forEach(option => { option.label = '界'.repeat(120); });
  d.paths.forEach(path => { delete path.option_ids; });
  d.rules = [{ when: { top: [maximum.o.decompress] }, path_id: maximum.p.decompress }];
  expect(validateCaseDocument(maximum.doc).ok).toBe(true);
  const maxId = uuidv7(), maxStub = env.ROOM.get(env.ROOM.idFromName(maxId));
  const maxRoom = await maxStub.create({ sessionId: maxId, joinCode: newJoinCode(), caseDoc: maximum.doc, ownerUserId: uuidv7() });
  expect(maxRoom.error).toBeUndefined();
  const maxDisplay = await maxStub.issueDisplayToken(), maxPeople = [];
  for (let i = 0; i < 300; i++) maxPeople.push(await maxStub.join('Bounded learner', 'shadows-01'));
  const maxSend = async (type, payload = {}) => {
    const current = (await maxStub.snapshot(maxRoom.facilitatorToken)).snapshot.view;
    const body = { v: 1, type, epoch: current.epoch, clientEventId: uuidv7(),
      ...(['advance', 'ranked_page'].includes(type) ? { expectRevision: current.revision } : {}),
      ...(type === 'ranked_page' ? { closedRoundId: current.rankedRoundId } : {}), ...payload };
    expect((await maxStub.command(maxRoom.facilitatorToken, body)).receipt.receipt).toBe('accepted');
  };
  await maxSend('start'); await maxSend('advance'); await maxSend('advance');
  const tuples = [];
  const permutations = (prefix, remaining) => {
    if (tuples.length === 300) return;
    if (!remaining.length) { tuples.push(prefix); return; }
    for (const digit of remaining) permutations(prefix + digit, remaining.filter(value => value !== digit));
  };
  permutations('', [...'01234567']);
  await runInDurableObject(maxStub, instance => {
    const saved = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
    maxPeople.forEach((person, index) => {
      saved.round.responses[person.participantId] = { id: uuidv7(), clientEventId: uuidv7(), firstAt: saved.lastAt, lastAt: saved.lastAt,
        response: { order: [...tuples[index]].map(digit => d.interaction.options[Number(digit)].id) } };
    });
    instance.ctx.storage.transactionSync(() => {
      writeArchiveState(instance.sql, { ...saved, caseDoc: instance.state.caseDoc }, Date.now());
      instance.sql.exec("UPDATE meta SET value=? WHERE key='state'", JSON.stringify(saved));
    });
  });
  await evictDurableObject(maxStub); await maxSend('lock'); await maxSend('ranked_page', { group: 299, position: 6 });
  const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const measures = { qualifier: 'Clean typed native-restored legal fixture:300 admitted credentials and coherent restored control/SQLite response evidence, not300 accepted native vote commands. HTTP snapshot envelopes use the same full WebSocket serializer; no universal bound for unknown observation baggage or expanded history.' };
  let facilitatorSnapshot;
  for (const [role, token] of [['facilitator', maxRoom.facilitatorToken], ['display', maxDisplay.token], ['participant', maxPeople[0].token]]) {
    const response = await SELF.fetch(apiUrl('https://case.test', 'sessions', maxId, 'snapshot'), { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200); const envelope = await response.json(); measures[`${role}HttpWs`] = byteSize(envelope);
    if (role === 'display') { expect(acceptDisplayView(envelope.view)).toEqual(envelope.view); expect(envelope.view.responseResult.ranked.groups).toEqual([[tuples[299], 1]]); }
    if (role === 'facilitator') { expect(envelope.view.round.aggregate.completeOrders).toHaveLength(300); facilitatorSnapshot=envelope; }
  }
  const pack=await maxStub.casePack(maxRoom.facilitatorToken);measures.casePack=byteSize(pack);
  const samePc=projectorFrame(facilitatorSnapshot,pack.document);expect(samePc).not.toBeNull();
  expect(samePc.view.responseResult.ranked.groups).toEqual([[tuples[299],1]]);measures.samePc=byteSize(samePc);
  await runInDurableObject(maxStub, instance => {
    const saved = JSON.parse(instance.sql.exec("SELECT value FROM meta WHERE key='state'").one().value);
    measures.stateUtf8 = byteSize(saved); measures.stateCodeUnits = JSON.stringify(saved).length;
    expect(saved.round.aggregate.completeOrders).toHaveLength(300); expect(measures.stateUtf8).toBeLessThan(1_000_000);
    const deferred = archiveBatch(instance.sql, saved, null, null, false), personal = archiveBatch(instance.sql, saved, null, null, true);
    expect(deferred.batch.rounds[0].aggregate.completeOrders).toHaveLength(300);
    for (const batch of [deferred, personal]) { expect(batch.rows).toBeLessThanOrEqual(200); expect(batch.bytes).toBeLessThanOrEqual(256 * 1024); }
    measures.archiveDeferred = deferred.bytes; measures.archivePersonal = personal.bytes;
  });
  // Actual native resolved chart is a stable manual-entry boundary; entering the
  // locked round itself would correctly abandon its responses.
  await maxSend('show_results',{on:false});await maxSend('select_path',{pathId:maximum.p.decompress});await maxSend('reveal');await maxSend('show_results',{on:true});
  const resolved=(await maxStub.snapshot(maxRoom.facilitatorToken)).snapshot;
  expect(resolved.view.rankedPresentation.groups).toEqual([[tuples[299],1]]);
  const entries=new Map(),storage={setItem(k,v){entries.set(k,v);},getItem(k){return entries.get(k)??null;},removeItem(k){entries.delete(k);}};
  const manual=new ConsoleManualRoom(resolved.mirror,pack.document,{storage,channel:{postMessage(frame){if(frame.t==='local_snapshot'){measures.manualFrame=byteSize(frame);expect(frame.view.responseResult.ranked.groups).toEqual([[tuples[299],1]]);}}}});
  try {
    expect(manual.enter().receipt).toBe('accepted');
    expect(manual.command('ranked_page',{group:299,position:6,closedRoundId:manual.view().rankedRoundId,expectRevision:manual.state.revision}).receipt).toBe('accepted');
    measures.manualSaved=byteSize(ConsoleManualRoom.saved(maxId,storage));measures.manualUpload=byteSize(manual.segmentBody());
    expect(measures.manualSaved).toBeLessThan(256000);expect(measures.manualUpload).toBeLessThan(256000);
  } finally {manual.close();}
  console.log('Card25 native restored legal fixture UTF8 measurements', JSON.stringify(measures));

});
