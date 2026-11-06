// Card 40 + feedback integration slice 6: the console derives the counts-only debrief from its last snapshot before
// the pack purge (ruling I1). Compaction keeps only the latest round's aggregate, so at End the facilitator's mirror
// must carry every closed round's aggregate; no other role ever gets them.
import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { miniCase } from '../helpers/mini-case.mjs';

const command = (type, epoch = 0, payload = {}) => ({ v: 1, type, epoch, clientEventId: uuidv7(), ...payload });
async function room(fixture = miniCase()) {
  const sessionId = uuidv7(); const stub = env.ROOM.get(env.ROOM.idFromName(sessionId));
  const created = await stub.create({ sessionId, joinCode: newJoinCode(), caseDoc: fixture.doc, ownerUserId: uuidv7() });
  expect(created.error).toBeUndefined();
  const display = await stub.issueDisplayToken();
  return { sessionId, stub, fixture, facilitatorToken: created.facilitatorToken, displayToken: display.token };
}
const snapshot = async (r, token) => (await r.stub.snapshot(token)).snapshot;
async function send(r, type, payload = {}, token = r.facilitatorToken) {
  const s = (await snapshot(r, token)).view;
  const result = await r.stub.command(token, command(type, s.epoch, { ...(type === 'advance' ? { expectRevision: s.revision } : {}), ...payload }));
  expect(result.receipt.receipt, `${type}: ${result.receipt.reason}`).toBe('accepted');
}
/** Advance until a round is open, vote, close it on `pathId` and reveal its consequence. */
async function playRound(r, voter, optionId, pathId) {
  for (let i = 0; i < 8 && !(await snapshot(r, voter.token)).view.decision?.roundId; i++) await send(r, 'advance');
  const d = (await snapshot(r, voter.token)).view.decision;
  await send(r, 'vote', { roundId: d.roundId, response: { option_id: optionId } }, voter.token);
  await send(r, 'lock'); await send(r, 'select_path', { pathId }); await send(r, 'show_results', { on: false }); await send(r, 'reveal');
}

it('[card 40 ended summary] at End the facilitator mirror carries every closed round\'s counts; the display and phones never do', async () => {
  const r = await room(), { o, p } = r.fixture;
  const a = await r.stub.join('Sam', 'shadows-01');
  await send(r, 'start');
  await playRound(r, a, o.decompress, p.decompress);
  await playRound(r, a, o.fast, p.fast);
  const live = (await snapshot(r, r.facilitatorToken)).mirror;
  expect(live.rounds.filter((x) => x.status === 'resolved')).toHaveLength(2);
  expect(live.rounds.filter((x) => x.aggregate).length, 'compaction: only the latest aggregate while live').toBe(1);
  await send(r, 'end');
  const ended = (await snapshot(r, r.facilitatorToken)).mirror;
  const closed = ended.rounds.filter((x) => x.status === 'resolved');
  expect(closed).toHaveLength(2);
  for (const round of closed) expect(round.aggregate?.total, `round ${round.no}`).toBe(1);
  // The paging grant (slice 5) pages both shown results: the compacted round's too.
  const grant = await r.stub.debriefGrant(r.facilitatorToken);
  expect(grant.pages).toBe(3);
  const paged = (await snapshot(r, r.displayToken)).view.debrief;
  expect(paged.results.map((x) => x.total)).toEqual([1, 1]);
  for (const token of [r.displayToken, a.token]) {
    const s = await snapshot(r, token);
    expect(s.mirror).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('"aggregate"');
  }
});

it('[AS-176] an ended phone\'s recap carries the room split of every shown round, the compacted ones too', async () => {
  const r = await room(), { o, p } = r.fixture;
  const a = await r.stub.join('Sam', 'shadows-01'), b = await r.stub.join('Ana', 'shadows-02');
  await send(r, 'start');
  // Both phones vote in the first round only; the second has one answer.
  for (let i = 0; i < 8 && !(await snapshot(r, a.token)).view.decision?.roundId; i++) await send(r, 'advance');
  const first = (await snapshot(r, a.token)).view.decision;
  await send(r, 'vote', { roundId: first.roundId, response: { option_id: o.decompress } }, b.token);
  await playRound(r, a, o.decompress, p.decompress);
  await playRound(r, a, o.fast, p.fast);
  expect((await snapshot(r, r.facilitatorToken)).mirror.rounds.filter((x) => x.aggregate).length, 'compaction while live').toBe(1);
  await send(r, 'end');
  const rounds = (await snapshot(r, a.token)).view.recap.rounds.filter((x) => x.status === 'resolved');
  expect(rounds).toHaveLength(2);
  // Without re-reading the shown aggregates, hydration nulls the first round's and its split is missing.
  expect(rounds.map((x) => x.room?.total)).toEqual([2, 1]);
  for (const x of rounds) expect(x.room.options.reduce((n, opt) => n + opt.count, 0)).toBe(x.room.total);
});
