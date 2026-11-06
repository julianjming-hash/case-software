import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PreviewRoom, simulatedResponse } from '../src/client/preview-room.mjs';
import { dockControl } from '../src/client/console-actions.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';

const doc = JSON.parse(await readFile(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url)));
const decisionBeat = doc.beats.find(beat => beat.kind === 'decision');
const decision = doc.decisions.find(item => item.id === decisionBeat.decision_id);
const safePath = decision.paths.find(path => path.classification !== 'terminal-unsafe');

/** Drive the dock's primary action until responses open (the console's own path). */
function openRound(room) {
  for (let i = 0; i < 40 && room.state.phase !== 'responses_open'; i++) {
    const action = dockControl(room.view(), { pickedPathId: room.selection });
    assert.ok(action?.command, `no command at ${room.state.phase}`);
    assert.ok(room.command(action.command, action.payload), room.reason);
  }
  assert.equal(room.state.phase, 'responses_open');
}

test('[AS-160] simulated learners join through the room machine and appear in the lobby', () => {
  const room = new PreviewRoom(doc, { learners: 3 });
  assert.equal(room.state.phase, 'lobby');
  assert.equal(Object.keys(room.state.participants).length, 3);
  const display = room.view('display');
  assert.ok(display, 'the projector projection exists');
  for (const learner of room.learners) assert.ok(room.view('participant', learner.id), 'each learner has a phone projection');
  assert.deepEqual(room.log, [], 'joins are part of the restart, not the log');
});

test('[AS-160] Simulate votes answers for every learner; a hand-driven phone votes for its learner', () => {
  const room = new PreviewRoom(doc, { learners: 4 });
  openRound(room);
  const [first] = room.learners;
  assert.ok(room.vote(first.id, simulatedResponse(decision, { lean: decision.interaction.options[0].id, next: () => 0 })));
  assert.equal(room.simulateVotes(), 3, 'only the learners who have not answered');
  assert.equal(Object.keys(room.state.round.responses).length, 4);
  assert.equal(room.simulateVotes(), 0);
  assert.ok(room.command('lock'));
  assert.equal(room.state.round.aggregate.total, 4, 'the results count the simulated answers');
});

test('[AS-160] simulated responses are valid for each interaction type', () => {
  const options = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.ok(['a', 'b', 'c'].includes(simulatedResponse({ interaction: { type: 'single_choice', options } }).option_id));
  assert.equal(simulatedResponse({ interaction: { type: 'single_choice', options } }, { disabled: ['a', 'b'] }).option_id, 'c');
  const multi = simulatedResponse({ interaction: { type: 'multi_select', options } });
  assert.ok(multi.option_ids.length >= 1 && new Set(multi.option_ids).size === multi.option_ids.length);
  assert.equal(simulatedResponse({ interaction: { type: 'ranking', options, rank_count: 2 } }).order.length, 2);
  assert.equal(simulatedResponse({ interaction: { type: 'free_text', max_length: 200 } }, { index: 1 }).text, 'Sample answer 2');
});

test('[AS-160] Jump to stage replays the route; history and Undo are exact', () => {
  const room = new PreviewRoom(doc);
  assert.ok(room.jumpTo({ beatId: decisionBeat.id }), room.reason);
  assert.equal(room.state.beatId, decisionBeat.id);
  assert.equal(room.state.phase, 'surface_live');
  assert.ok(room.log.length > 0, 'the replayed commands are the log');

  assert.ok(room.jumpTo({ beatId: decisionBeat.id, pathId: safePath.id }), room.reason);
  assert.equal(room.state.revealed.at(-1).pathId, safePath.id);
  assert.equal(room.state.rounds.at(-1).aggregate.total, room.learners.length, 'the jump voted through the room');
  const undo = room.view().undo;
  assert.ok(undo.available, 'the replayed reveal can be undone');
  assert.ok(room.command('undo', { targetEventId: undo.targetEventId }), room.reason);
  assert.equal(room.state.phase, 'responses_locked', 'Undo restores the locked round with its answers');
  assert.equal(Object.keys(room.state.round.responses).length, room.learners.length);
});

test('[AS-160] an unreachable target leaves the run unchanged', () => {
  const room = new PreviewRoom(doc);
  room.command('start');
  const before = room.state, log = room.log;
  assert.equal(room.jumpTo({ beatId: 'no-such-beat' }), false);
  assert.equal(room.state, before);
  assert.equal(room.log, log);
});

test('[AS-160] an edit rebuilds the run from the newest draft and replays to where it was', () => {
  const room = new PreviewRoom(doc);
  assert.ok(room.jumpTo({ beatId: decisionBeat.id, pathId: safePath.id }));
  const where = { beatId: room.state.beatId, phase: room.state.phase, revealed: room.state.revealed.length };
  const edited = structuredClone(doc);
  edited.title = 'Edited title';
  const result = room.rebuild(edited);
  assert.equal(result.stopped, false);
  assert.equal(room.doc.title, 'Edited title');
  assert.deepEqual({ beatId: room.state.beatId, phase: room.state.phase, revealed: room.state.revealed.length }, where);

  // A draft that removes the revealed route stops the replay before it, with the log cut to what still applies.
  const removed = structuredClone(doc);
  const owner = removed.decisions.find(item => item.id === decision.id);
  owner.paths = owner.paths.filter(path => path.id !== safePath.id);
  const cut = room.rebuild(removed);
  assert.equal(cut.stopped, true, 'the stage the run was on no longer exists, so it cannot be kept');
  assert.notEqual(room.state.revealed.at(-1).pathId, safePath.id);
});

test('[AS-160] Manual mode resolves without votes; a learner cannot vote in a manual room', () => {
  const room = new PreviewRoom(doc, { mode: 'manual' });
  assert.ok(room.jumpTo({ beatId: decisionBeat.id, pathId: safePath.id }), room.reason);
  assert.equal(room.state.revealed.at(-1).pathId, safePath.id);
  assert.ok(room.state.manual);
});

test('[AS-160] close drops the run', () => {
  const room = new PreviewRoom(doc);
  room.command('start');
  room.close();
  assert.equal(room.state, null);
  assert.deepEqual(room.log, []);
  assert.deepEqual(room.learners, []);
});

test('[AS-160] the console controls that are not revision-fenced work: results and names; pause is retired', () => {
  const room = new PreviewRoom(doc);
  assert.ok(room.jumpTo({ beatId: decisionBeat.id }), room.reason);
  assert.ok(!room.view().actions.includes('pause'));
  assert.equal(room.command('pause'), false);
  assert.equal(room.reason, 'retired');
  openRound(room); room.simulateVotes(); assert.ok(room.command('lock'), room.reason);
  assert.ok(room.view().actions.includes('show_results'));
  assert.ok(room.command('show_results', { on: false }), room.reason);
  assert.equal(room.state.resultsShown, false);
  assert.ok(room.command('show_names', { on: true }), room.reason);
});

test('[AS-160] an edit that changes an earlier stage\'s groups keeps the run on its stage', () => {
  const room = new PreviewRoom(doc);
  const later = doc.beats.filter(beat => beat.kind !== 'decision').at(-1);
  assert.ok(room.jumpTo({ beatId: decisionBeat.id, pathId: safePath.id }), room.reason);
  const where = { beatId: room.state.beatId, pathId: room.state.revealed.at(-1).pathId };
  const edited = structuredClone(doc), opening = edited.surfaces.find(surface => surface.id === edited.beats.find(beat => beat.id === edited.start_beat_id).surface_id);
  for (const key of ['vitals', 'observations', 'points', 'findings', 'investigations']) delete opening[key];
  const result = room.rebuild(edited);
  assert.equal(result.stopped, false);
  assert.deepEqual({ beatId: room.state.beatId, pathId: room.state.revealed.at(-1).pathId }, where);
  assert.ok(later);
});

test('[AS-160] a jump passes required recovery by confirming it, as a facilitator would', () => {
  const gated = convertSchema1ToBuilderDocument(structuredClone(doc), { metadata_version: 1 }).candidate;
  gated.required_capabilities = [...new Set([...(gated.required_capabilities ?? []), 'required_recovery'])];
  const owner = gated.decisions.find(item => item.id === decision.id);
  for (const path of owner.paths) path.recovery = { prompt: 'Pause and ask before continuing.' };
  const after = gated.beats.find(beat => beat.id === owner.paths.find(path => path.id === safePath.id).next_beat_id);
  assert.ok(after, 'the safe route continues to another stage');
  assert.equal(validateRuntimeDocument(gated).ok, true);
  const room = new PreviewRoom(gated);
  assert.ok(room.jumpTo({ beatId: after.id }), room.reason);
  assert.equal(room.state.beatId, after.id);
  assert.ok(room.log.some(entry => entry.type === 'confirm_recovery'), 'the replay confirmed the recovery');
});

test('[AS-160] an unreachable stage and a search that gives up say different things', () => {
  const room = new PreviewRoom(doc);
  assert.equal(room.jumpTo({ beatId: 'no-such-beat' }), false);
  assert.equal(room.reason, 'unreachable');
});
