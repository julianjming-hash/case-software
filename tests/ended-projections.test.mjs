// Card 40 + feedback integration slice 3: the ended projections. Revealed material only, results only if the room was
// shown them, the feedback code only at End, and the recap pairing each round with its revealed slide (red-team R5, R6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkRoom } from './helpers/room-walk.mjs';
import { initialState, project, reduce } from '../src/shared/room-machine.mjs';
import { WALK_AT } from './helpers/room-walk.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const { pid, states } = walkRoom();
// The walk keys states without the shown flag, so it keeps the first ended state of each shape. End every walked room
// that has already seen a result too, so ended rooms with and without shown results are both covered.
const endedWithShown = states.filter((s) => s.phase !== 'ended' && s.rounds.some((r) => r.shown))
  .map((s) => reduce(s, { type: 'end', epoch: s.epoch, actor: { role: 'facilitator', id: 'fac' }, at: WALK_AT }).state).filter((s) => s.phase === 'ended');
const ended = [...states.filter((s) => s.phase === 'ended'), ...endedWithShown];

/** The same document with a unique canary in every private field, and in every surface title the room has not revealed. */
function canaryDoc(state) {
  const doc = structuredClone(state.caseDoc), revealed = new Set(state.revealed.map((e) => e.surfaceId));
  for (const s of doc.surfaces) { s.notes = `CANARY-NOTES-${s.id}`; if (!revealed.has(s.id)) s.title = `CANARY-UNREVEALED-${s.id}`; }
  for (const b of doc.beats) b.cue = `CANARY-CUE-${b.id}`;
  for (const d of doc.decisions) for (const p of d.paths) { p.rationale = `CANARY-RATIONALE-${p.id}`; p.cue = `CANARY-CUE-${p.id}`; }
  return doc;
}

test('[card 40 ended] the walk reaches End with results to page, shown live or not (CASE-327)', () => {
  assert.ok(ended.length > 0);
  assert.ok(ended.some((s) => s.rounds.some((r) => r.shown === true)), 'some ended room saw a result');
  const seen = ended.find((s) => project(s, 'display', null, { debriefResults: true }).debrief.results.length > 0);
  assert.ok(seen, 'some ended room pages a result');
  // Debrief always shows a question's result (Julian, 2026-11-01): the same room, had it never shown one live, pages the same.
  const unseen = { ...seen, rounds: seen.rounds.map(({ shown, ...r }) => r) };
  assert.deepEqual(project(unseen, 'display', null, { debriefResults: true }).debrief.results, project(seen, 'display', null, { debriefResults: true }).debrief.results);
});

test('[card 40 ended] no private field or unrevealed slide reaches an ended display or participant projection', () => {
  for (const state of ended) {
    const s = { ...state, caseDoc: canaryDoc(state) };
    for (const view of [project(s, 'display', null, { debriefResults: true }), project(s, 'display'), project(s, 'participant', pid)])
      assert.doesNotMatch(JSON.stringify(view), /CANARY/, `ended projection leaked a private or unrevealed field (revision ${state.revision})`);
  }
});

test('[card 40 ended] debrief results are exactly the resolved choice and ranking rounds, and only while paging', () => {
  for (const state of ended) {
    const paging = project(state, 'display', null, { debriefResults: true }).debrief, idle = project(state, 'display').debrief;
    const prompts = new Map(state.caseDoc.decisions.map((d) => [d.id, d]));
    const decided = new Set(state.rounds.filter((r) => r.status === 'resolved' && r.aggregate && prompts.get(r.decisionId).interaction.type !== 'free_text')
      .map((r) => `${prompts.get(r.decisionId).prompt}|${r.no}`));
    for (const result of paging.results) assert.ok(decided.has(`${result.prompt}|${result.roundNo}`), 'an undecided or free-text round reached the projector');
    if (decided.size) assert.ok(paging.results.length > 0);
    assert.deepEqual(idle.results, [], 'no results unless the facilitator is paging them (red-team R4)');
    assert.deepEqual(idle.objectives, state.caseDoc.learning_objectives);
  }
  for (const state of states.filter((s) => s.phase !== 'ended'))
    assert.equal(project(state, 'display').debrief, undefined, 'the debrief exists only at End');
});

test('[card 40 ended] each recap round points at the slide it revealed in the phone\'s own timeline', () => {
  let checked = 0;
  for (const state of ended) {
    const view = project(state, 'participant', pid);
    for (const round of view.recap?.rounds ?? []) {
      if (round.whatHappened === null) { assert.equal(round.revealIndex, null); continue; }
      assert.equal(view.timeline[round.revealIndex].title, round.whatHappened); checked++;
    }
  }
  assert.ok(checked > 0);
});

test('[card 40 ended] the feedback code is public only at End, and only a valid code is kept', () => {
  const doc = miniCase().doc, sid = '00000000-0000-7000-8000-000000000999';
  assert.equal(initialState({ sessionId: sid, caseDoc: doc, feedbackCode: 'not a code' }).feedbackCode, null);
  const live = initialState({ sessionId: sid, caseDoc: doc, feedbackCode: '7K3QX9' });
  assert.equal(live.feedbackCode, '7K3QX9');
  assert.equal(project(live, 'display').feedbackCode, undefined);
  const end = { ...live, phase: 'ended', endedAt: '2026-10-19T09:00:00.000Z', participants: { [pid]: { name: 'A', joinedAt: '2026-10-19T08:00:00.000Z' } } };
  assert.equal(project(end, 'display').feedbackCode, '7K3QX9');
  assert.equal(project(end, 'participant', pid).recap.feedbackCode, '7K3QX9');
  assert.equal(project({ ...end, feedbackCode: null }, 'display').feedbackCode, undefined, 'a room created before the migration has none');
});

test('[card 40 ended] the projector accepts the ended debrief and refuses any private or extra field inside it', () => {
  const state = ended.find((s) => s.rounds.some((r) => r.shown && r.status === 'resolved'));
  const view = project({ ...state, feedbackCode: '7K3QX9' }, 'display', null, { debriefResults: true });
  assert.ok(acceptDisplayView(view), 'a valid ended view passes');
  const poison = (mutate) => { const v = structuredClone(view); mutate(v); return acceptDisplayView(v); };
  assert.equal(poison((v) => { v.debrief.rationale = 'private'; }), null);
  assert.equal(poison((v) => { v.debrief.results.push({ prompt: 'x', type: 'free_text', roundNo: 1, total: 1, counts: [] }); }), null, 'free text never pages');
  assert.equal(poison((v) => { v.debrief.route.push({ title: 'x' }); }), null);
  assert.equal(poison((v) => { v.feedbackCode = 'https://evil.example'; }), null);
  if (view.debrief.results.length) assert.equal(poison((v) => { v.debrief.results[0].counts[0].names = ['A']; }), null);
});

test('[card 40 ended] a long summary pages: the route, then the objectives, and the page clamps past both (Julian, page it and shrink)', async () => {
  const { summaryPages } = await import('../src/shared/debrief-pages.mjs');
  assert.equal(summaryPages({ route: ['A', 'B'], objectives: ['Short.'] }), 1);
  const long = Array.from({ length: 4 }, (_, i) => `Objective ${i} `.repeat(9));
  assert.equal(summaryPages({ route: ['A', 'B', 'C'], objectives: long }), 2);
  assert.equal(summaryPages({ route: [], objectives: long.concat(long) }), 1, 'nothing to split from');
  const state = ended.find((s) => project(s, 'display', null, { debriefResults: true }).debrief.results.length > 0);
  const doc = { ...state.caseDoc, learning_objectives: long };
  const s = { ...state, caseDoc: doc };
  const view = project(s, 'display', null, { debriefResults: true, debriefPage: 99 }).debrief;
  assert.equal(view.page, summaryPages(view) + view.results.length - 1, 'the last page is the last result');
});

// Julian's ruling 1 (2026-10-17): the participant recap PDF prints each revealed image's credit under it. The credit reaches
// the phone only in its ended recap, only for an image its own timeline released; slides keep credits facilitator-only.
test('[card 40b recap images] an image credit reaches only the ended recap, only for a released image; an unreleased or unrevealed image\'s credit never reaches any public projection', async () => {
  const { convertSchema1ToBuilderDocument } = await import('../src/shared/builder-document.mjs');
  const { convertToSlideDocument } = await import('../src/shared/slide-legacy.mjs');
  const { addBlock } = await import('../src/shared/slide-edit.mjs');
  const { uuidv7 } = await import('../src/shared/ids.mjs');
  const { participantTimeline } = await import('../src/shared/room-machine.mjs');
  const fixture = (await import('../src/fixtures/synthetic-workshop.case.json', { with: { type: 'json' } })).default;
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  let doc = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const openingId = doc.compositions.find((c) => c.owner.kind === 'beat' && c.owner.id === doc.start_beat_id).id;
  const pathId = doc.compositions.find((c) => c.owner.kind === 'path').id;
  const add = (compositionId, assetId, alt) => {
    const added = addBlock(doc, compositionId, 'image', uuidv7, { image: { assetId, alt, ecg: false } });
    assert.ok(added.ok, added.reason); doc = added.document;
    return doc.compositions.find((c) => c.id === compositionId).steps.at(-1).block_ids[0];
  };
  const asset = { shown: uuidv7(), later: uuidv7(), unrevealed: uuidv7(), gone: uuidv7() };
  const shown = add(openingId, asset.shown, 'Chest film on arrival'), gone = add(openingId, asset.gone, 'Withdrawn film');
  add(openingId, asset.later, 'A later step image'); add(pathId, asset.unrevealed, 'A slide the room never saw');
  // The shown and withdrawn images are released On entry; the later step and the path's slide never are.
  const opening = doc.compositions.find((c) => c.id === openingId);
  opening.steps = opening.steps.filter((s) => ![shown, gone].includes(s.block_ids[0]));
  opening.steps.find((s) => s.block_ids.length).block_ids.push(shown, gone);
  const entry = (credit) => ({ handle: uuidv7(), width: 300, height: 200, credit, type: 'image/jpeg', durationMs: null });
  const roomMedia = { [asset.shown]: entry('CANARY-CREDIT-SHOWN'), [asset.later]: entry('CANARY-CREDIT-LATER'), [asset.unrevealed]: entry('CANARY-CREDIT-UNREVEALED'), [asset.gone]: { state: 'withdrawn' } };
  const me = uuidv7(), fac = { role: 'facilitator', id: 'fac' };
  let at = Date.parse('2026-10-19T09:00:00.000Z');
  const step = (state, type) => { const r = reduce(state, { type, roundId: uuidv7(), clientEventId: uuidv7(), epoch: state.epoch, at: new Date(at += 1000).toISOString(), actor: fac }); return r.state; };
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc, media: roomMedia });
  state = reduce(state, { type: 'join', epoch: 0, actor: { role: 'participant', id: me }, at: new Date(at).toISOString(), displayName: 'P' }).state;
  const live = step(state, 'start');
  assert.ok(project(live, 'participant', me).liveSurface.slide.blocks.some((b) => b.id === shown), 'the shown image is released');
  for (const s of [state, live]) for (const view of [project(s, 'display'), project(s, 'participant', me)])
    assert.doesNotMatch(JSON.stringify(view), /CANARY-CREDIT/, 'no credit before End: slides keep credits facilitator-only');
  const end = step(live, 'end');
  assert.equal(end.phase, 'ended');
  for (const view of [project(end, 'participant', me), project(end, 'participant', me, { timeline: participantTimeline(end) })]) {
    assert.deepEqual(view.recap.imageCredits, { [shown]: 'CANARY-CREDIT-SHOWN' });
    assert.doesNotMatch(JSON.stringify(view), /CANARY-CREDIT-(LATER|UNREVEALED)/);
  }
  for (const view of [project(end, 'display'), project(end, 'display', null, { debriefResults: true })]) assert.doesNotMatch(JSON.stringify(view), /CANARY-CREDIT/, 'the ended projector carries no credit');
  // A room with no credited released image adds nothing to the recap (the card 37 golden keeps its bytes).
  const plain = step(step(reduce(initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc, media: { ...roomMedia, [asset.shown]: entry(null) } }),
    { type: 'join', epoch: 0, actor: { role: 'participant', id: me }, at: new Date(at).toISOString(), displayName: 'P' }).state, 'start'), 'end');
  assert.equal('imageCredits' in project(plain, 'participant', me).recap, false);
});
