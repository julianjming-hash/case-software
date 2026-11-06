import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { formattedTextPlainText } from '../src/shared/builder-format.mjs';
import { populatedPresentationGroups } from '../src/shared/presentation-order.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
const artifact = name => new URL(`../tests/fixtures/synthetic/${name}`, import.meta.url);
const envelope = JSON.parse(await readFile(artifact('builder-diving-polished-transfer.json')));
const audit = JSON.parse(await readFile(artifact('polished-input-manifest.json')));
const bytes = await readFile(artifact('builder-diving-polished-transfer.json'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), audit.transfer_sha256);
const inspected = await inspectBuilderTransfer(envelope, { mode: 'ready', acknowledgeRedactions: true, acknowledgeRightsWarnings: true });
assert.equal(inspected.ok, true, JSON.stringify(inspected.errors));
const doc = inspected.candidate.document;
const validation = validateCaseDocument(doc, { profile: 'schema2' });
assert.equal(validation.ok, true, JSON.stringify(validation.errors));
assert.equal(inspected.candidate.authoring_metadata.sources[0].text, await readFile(artifact('polished-source.txt'), 'utf8'));
assert.ok(inspected.candidate.authoring_metadata.provenance.every(row => row.review_status === 'unreviewed'));
assert.equal(doc.decisions[2].interaction.max_length, 500);
assert.equal(doc.decisions[0].interaction.max_length, 240);
assert.equal(doc.beats.length, 21);
assert.ok(doc.beats.every(beat => !/part [12]/.test(beat.title)));
const text = value => typeof value === 'string' ? value : formattedTextPlainText(value);
for (const change of audit.changes) {
  const surface = doc.surfaces.find(item => item.id === change.retained_surface);
  assert.equal([text(surface.scene), ...(surface.points ?? []).map(text)].join(' ').replace(/\s+/g, ' ').trim(), change.original_text.replace(/\s+/g, ' ').trim(), 'recombination omitted source-adapted wording');
  assert.ok(text(surface.scene).length <= 500);
  assert.ok(surface.scene.blocks.length > 1);
}
function enumerate(beatId, chosen = [], visited = []) {
  const beat = doc.beats.find((item) => item.id === beatId);
  assert.ok(beat, `route graph points to missing beat ${beatId}`);
  const nextVisited = [...visited, beat.id];
  if (beat.kind === 'debrief') return [{ paths: chosen, beats: nextVisited }];
  if (beat.kind === 'decision') {
    const decision = doc.decisions.find((item) => item.id === beat.decision_id);
    assert.ok(decision, `decision beat has no authored decision ${beat.id}`);
    return decision.paths.flatMap((path) => {
      assert.ok(path.next_beat_id, `non-terminal path has no next beat: ${path.label}`);
      return enumerate(path.next_beat_id, [...chosen, { decisionId: decision.id, pathId: path.id, label: path.label }], nextVisited);
    });
  }
  assert.ok(beat.next_beat_id, `non-debrief surface has no next beat: ${beat.title}`);
  return enumerate(beat.next_beat_id, chosen, nextVisited);
}
const routes = enumerate(doc.start_beat_id);
assert.equal(routes.length, 24, 'frozen diving graph must retain all24 complete routes');
assert.ok(routes.every((route) => route.paths.length === doc.decisions.length), 'a route omitted a decision');
const routePathIds = new Set(routes.flatMap((route) => route.paths.map((item) => item.pathId)));
assert.equal(routePathIds.size, doc.decisions.reduce((count, decision) => count + decision.paths.length, 0), 'not every authored path is reachable');

const secretStrings = [
  ...doc.surfaces.flatMap((surface) => [surface.notes, ...(surface.variants ?? []).map((variant) => variant.notes)]),
  ...doc.decisions.flatMap((decision) => decision.paths.flatMap((path) => [path.cue, path.rationale])),
].filter((value) => typeof value === 'string' && value.length >= 24);
const projectionFaults = [];
function assertPublicProjection(state, scenario) {
  for (const role of ['display', 'participant']) {
    try {
      const view = project(state, role, null);
      const serialized = JSON.stringify(view);
      for (const secret of secretStrings) {
        assert.ok(!serialized.includes(secret), `${role} projection leaked private authoring text during ${scenario}`);
      }
    } catch (error) {
      const record = { role, scenario, name: error.name, message: error.message };
      if (!projectionFaults.some((fault) => fault.role === role && fault.message === error.message)) projectionFaults.push(record);
    }
  }
}

function makeRoom(caseDoc = doc) {
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc });
  const ledger = new Map();
  let time = Date.parse('2026-10-09T12:00:00.000Z');
  function send(type, payload = {}) {
    time += 1000;
    const event = {
      type, epoch: state.epoch, actor: { role: 'facilitator', id: 'route-audit' },
      at: new Date(time).toISOString(), clientEventId: uuidv7(), ...payload,
    };
    if (['start', 'advance', 'reset_checkpoint'].includes(type)) event.roundId ??= uuidv7();
    if (['show_clarification', 'return_clarification', 'confirm_recovery', 'reveal_path', 'undo'].includes(type)) event.expectRevision ??= state.revision;
    const result = dispatch(state, event, ledger);
    state = result.state;
    const receipt = result.effects.find((effect) => effect.type === 'receipt');
    return { ...result, event, receipt: receipt?.receipt ?? null, reason: receipt?.reason ?? null };
  }
  return { get state() { return state; }, send };
}
function requireAccepted(room, type, payload, where) {
  const result = room.send(type, payload);
  assert.equal(result.receipt, 'accepted', `${where}: ${type} rejected (${result.reason})`);
  assertPublicProjection(room.state, where);
  return result;
}
function advanceUntilOpen(room) {
  for (let count = 0; count < 200; count++) {
    if (room.state.phase === 'responses_open') return;
    assert.ok(['surface_live', 'consequence_revealed'].includes(room.state.phase), `unexpected phase while opening round: ${room.state.phase}`);
    requireAccepted(room, 'advance', {}, `advance to response round ${room.state.decisionId ?? 'context'}`);
  }
  throw new Error('round did not open within 200 authored surfaces');
}
function shownGroupsForLast(room) {
  const entry = room.state.revealed.at(-1);
  const surface = doc.surfaces.find((item) => item.id === entry.surfaceId);
  assert.ok(surface, `revealed surface missing from candidate ${entry.surfaceId}`);
  return { entry, total: populatedPresentationGroups(surface).length };
}
function drainConsequenceGroups(room) {
  for (let i = 0; i < 12; i++) {
    const { entry, total } = shownGroupsForLast(room);
    if (entry.groupsShown >= total) return;
    requireAccepted(room, 'advance', {}, 'reveal all authored consequence groups');
  }
  throw new Error('consequence groups did not drain');
}

const routeResults = [];
for (let routeNo = 0; routeNo < routes.length; routeNo++) {
  const route = routes[routeNo];
  const room = makeRoom();
  const visitedDecisionPaths = [];
  const recoveries = [];
  requireAccepted(room, 'start', {}, `route ${routeNo + 1} start`);
  for (const chosen of route.paths) {
    advanceUntilOpen(room);
    assert.equal(room.state.decisionId, chosen.decisionId, `route ${routeNo + 1}: unexpected decision order`);
    const decision = doc.decisions.find((item) => item.id === chosen.decisionId);
    const path = decision.paths.find((item) => item.id === chosen.pathId);
    assert.ok(path, `route ${routeNo + 1}: path is not authored on current decision`);
    requireAccepted(room, 'lock', {}, `route ${routeNo + 1} lock ${decision.id}`);
    requireAccepted(room, 'select_path', { pathId: path.id }, `route ${routeNo + 1} select ${path.label}`);
    requireAccepted(room, 'show_results', { on: false }, `route ${routeNo + 1} hide responses ${path.label}`);
    requireAccepted(room, 'reveal', {}, `route ${routeNo + 1} reveal ${path.label}`);
    assert.equal(room.state.phase, 'consequence_revealed');
    assert.equal(room.state.revealed.at(-1).surfaceId, path.reveal_surface_id, `route ${routeNo + 1}: wrong public consequence surface`);
    visitedDecisionPaths.push(path.id);
    assertPublicProjection(room.state, `route ${routeNo + 1} consequence ${path.label}`);
    drainConsequenceGroups(room);
    if (path.recovery) {
      const consequence = room.state.revealed.at(-1);
      const occurrenceId = consequence.occurrenceId;
      assert.ok(occurrenceId, 'recovery consequence lacks an occurrence ID');
      const beforeWrong = room.state;
      const wrong = room.send('confirm_recovery', { occurrenceId: uuidv7(), confirmed: true });
      assert.equal(wrong.receipt, 'rejected', 'wrong occurrence must not confirm recovery');
      assert.equal(wrong.reason, 'stale_recovery_occurrence');
      assert.strictEqual(room.state, beforeWrong, 'rejected wrong-occurrence confirmation changed state');
      const blocked = room.send('advance', {});
      assert.equal(blocked.receipt, 'rejected', 'recovery path advanced before confirmation');
      assert.equal(blocked.reason, 'recovery_required');
      assert.strictEqual(room.state, beforeWrong, 'blocked advance changed state');
      requireAccepted(room, 'confirm_recovery', { occurrenceId, confirmed: true }, `route ${routeNo + 1} confirm ${path.label}`);
      assert.equal(room.state.recoveryConfirmation?.occurrenceId, occurrenceId);
      recoveries.push({ pathId: path.id, occurrenceBound: true, refusalBeforeConfirm: true });
    }
    // The next decision may be separated by authored rescue/stage surfaces; the normal loop advances them.
    if (chosen !== route.paths.at(-1)) {
      // No-op: next iteration's advanceUntilOpen follows the live graph.
    }
  }
  assert.deepEqual(visitedDecisionPaths, route.paths.map((item) => item.pathId), `route ${routeNo + 1}: not all expected paths were resolved`);
  for (let count = 0; room.state.beatId !== doc.beats.find((beat) => beat.kind === 'debrief').id && count < 50; count++) {
    requireAccepted(room, 'advance', {}, `route ${routeNo + 1} finish authored timeline`);
  }
  assert.equal(room.state.beatId, doc.beats.find((beat) => beat.kind === 'debrief').id, `route ${routeNo + 1}: route did not reach the authored debrief`);
  assert.equal(room.state.nextBeatId, null, `route ${routeNo + 1}: debrief unexpectedly has a next beat`);
  requireAccepted(room, 'end', {}, `route ${routeNo + 1} end`);
  assert.equal(room.state.phase, 'ended', `route ${routeNo + 1}: full timeline did not end`);
  routeResults.push({
    routeNo: routeNo + 1,
    decisionPathIds: visitedDecisionPaths,
    pathLabels: route.paths.map((item) => item.label),
    recoveryChecks: recoveries,
    reachedDebrief: true,
    ended: true,
  });
}


assert.deepEqual(projectionFaults, []);
assert.equal(routeResults.length, 24);
assert.equal(routeResults.reduce((sum, row) => sum + row.recoveryChecks.length, 0), 54);
// Recombined opening remains a decision with an early clarification, preserving the same round.
const opening = makeRoom();
requireAccepted(opening, 'start', {}, 'recombined opening');
advanceUntilOpen(opening);
const roundId = opening.state.round.id;
const shown = requireAccepted(opening, 'show_clarification', { clarificationId: doc.clarifications[0].id }, 'early clarification');
requireAccepted(opening, 'return_clarification', { occurrenceId: shown.event.clientEventId }, 'return to opening');
assert.equal(opening.state.round.id, roundId);
