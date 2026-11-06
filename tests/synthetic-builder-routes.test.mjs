import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { validateCaseDocument, indexCaseDocument } from '../src/shared/case-document.mjs';
import { inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { populatedPresentationGroups } from '../src/shared/presentation-order.mjs';
const source = await readFile(new URL('../tests/fixtures/synthetic/routes-source.txt', import.meta.url), 'utf8');
const identity = { file: 'Synthetic route input', revision: 3, sha256: '64746ef648d8c461191bfbb442fc97287c865f47a5bf258f7e96c447c35c0b19' };
import { uuidv7 } from '../src/shared/ids.mjs';

globalThis.crypto ??= webcrypto;
const transferPath = new URL('../tests/fixtures/synthetic/builder-diving-transfer.json', import.meta.url);
const auditPath = new URL('../tests/fixtures/synthetic/routes-input-manifest.json', import.meta.url);
const evidencePath = process.env.CASE_BUILDER_ROUTE_EVIDENCE_PATH;
const expectedTransferSha = '73c9c716e8a08e8fd576e49002b46112f07eccac57306ad979d47c8c014e3b0a';
const transferBytes = await readFile(transferPath);
const transferSha = createHash('sha256').update(transferBytes).digest('hex');
assert.equal(transferSha, expectedTransferSha, 'frozen transfer artifact identity changed');
const envelope = JSON.parse(transferBytes.toString('utf8'));
const auditBytes = await readFile(auditPath);
const auditSha = createHash('sha256').update(auditBytes).digest('hex');
assert.equal(auditSha, 'f6ad2b1a0eeae166c44960a48e7e6e664100347af83eba2cbf9e511de77fecc7', 'frozen source audit identity changed');
const audit = JSON.parse(auditBytes.toString('utf8'));
const inspected = await inspectBuilderTransfer(envelope, {
  intent: 'copy', mode: 'ready', acknowledgeRedactions: true, acknowledgeRightsWarnings: true,
});
assert.equal(inspected.ok, true, 'frozen transfer failed inspection');
const doc = inspected.candidate.document;
const validation = validateCaseDocument(doc, { profile: 'schema2' });
assert.equal(validation.ok, true, `schema-2 room document invalid: ${JSON.stringify(validation.errors)}`);
indexCaseDocument(doc);
assert.ok(doc.decisions.every((decision) => decision.interpretation === 'facilitator'), 'all routes must remain facilitator interpreted');
const sourceHash = createHash('sha256').update(source, 'utf8').digest('hex');
assert.equal(sourceHash, identity.sha256);
assert.equal(inspected.candidate.authoring_metadata.sources[0].sha256, identity.sha256);
assert.equal(inspected.candidate.authoring_metadata.sources[0].text, source);

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

// Probe the frozen clarification mapping at both the pre-round surface and the first live response round.
const frozenClarificationRoom = makeRoom();
requireAccepted(frozenClarificationRoom, 'start', {}, 'frozen clarification probe start');
const clarification = doc.clarifications[0];
const unavailableAtSurface = frozenClarificationRoom.send('show_clarification', { clarificationId: clarification.id });
advanceUntilOpen(frozenClarificationRoom);
const firstRoundId = frozenClarificationRoom.state.round.id;
const unavailableInFirstRound = frozenClarificationRoom.send('show_clarification', { clarificationId: clarification.id });
let frozenClarificationReturn = null;
if (unavailableInFirstRound.receipt === 'accepted') {
  const shownProjection = project(frozenClarificationRoom.state, 'display');
  assert.equal(shownProjection.surface.surfaceId, clarification.surface_id);
  frozenClarificationReturn = frozenClarificationRoom.send('return_clarification', { occurrenceId: unavailableInFirstRound.event.clientEventId });
  assert.equal(frozenClarificationReturn.receipt, 'accepted');
  assert.equal(frozenClarificationRoom.state.phase, 'responses_open');
  assert.equal(frozenClarificationRoom.state.round.id, firstRoundId);
}
const frozenClarificationProbe = {
  clarificationBeatIds: clarification.beat_ids,
  firstBeatId: doc.start_beat_id,
  firstDecisionBeatId: doc.beats.find((beat) => beat.decision_id === doc.decisions[0].id).id,
  attemptedBeforeRound: { receipt: unavailableAtSurface.receipt, reason: unavailableAtSurface.reason },
  attemptedDuringFirstResponseRound: { receipt: unavailableInFirstRound.receipt, reason: unavailableInFirstRound.reason },
  returnedAfterOpenRound: frozenClarificationReturn?.receipt ?? null,
  exactRoundPreserved: frozenClarificationReturn ? frozenClarificationRoom.state.round.id === firstRoundId : false,
  roundId: firstRoundId,
  supportedOnFrozenCandidate: unavailableInFirstRound.receipt === 'accepted' && frozenClarificationReturn?.receipt === 'accepted',
};

// Positive control on an in-memory clone: correct only the beat binding, then prove clarification
// reveal/return preserves the exact open round and response context in the shared reducer.
const correctedClarificationDoc = structuredClone(doc);
const correctedCard = correctedClarificationDoc.clarifications[0];
correctedCard.beat_ids = [correctedClarificationDoc.beats.find((beat) => beat.decision_id === correctedClarificationDoc.decisions[0].id).id];
assert.equal(validateCaseDocument(correctedClarificationDoc, { profile: 'schema2' }).ok, true, 'positive-control beat binding invalid');
const correctionRoom = makeRoom(correctedClarificationDoc);
requireAccepted(correctionRoom, 'start', {}, 'corrected clarification control start');
advanceUntilOpen(correctionRoom);
const correctionRoundId = correctionRoom.state.round.id;
const correctionBeatId = correctionRoom.state.beatId;
const shown = requireAccepted(correctionRoom, 'show_clarification', { clarificationId: correctedCard.id }, 'corrected clarification control show');
assert.equal(correctionRoom.state.phase, 'responses_open');
assert.equal(correctionRoom.state.round.id, correctionRoundId);
assert.equal(correctionRoom.state.beatId, correctionBeatId);
try { assert.equal(project(correctionRoom.state, 'display').surface.surfaceId, correctedCard.surface_id); } catch (error) { if (!projectionFaults.some((fault) => fault.role === 'display' && fault.message === error.message)) projectionFaults.push({ role: 'display', scenario: 'clarification-positive-control', name: error.name, message: error.message }); }
const returned = requireAccepted(correctionRoom, 'return_clarification', { occurrenceId: shown.event.clientEventId }, 'corrected clarification control return');
assert.equal(returned.receipt, 'accepted');
assert.equal(correctionRoom.state.phase, 'responses_open');
assert.equal(correctionRoom.state.round.id, correctionRoundId);
assert.equal(correctionRoom.state.beatId, correctionBeatId);
const clarificationPositiveControl = {
  inMemoryBeatBindingOnly: correctedCard.beat_ids,
  showAccepted: shown.receipt,
  returnAccepted: returned.receipt,
  roundPreserved: correctionRoom.state.round.id === correctionRoundId,
  phasePreserved: correctionRoom.state.phase === 'responses_open',
  beatPreserved: correctionRoom.state.beatId === correctionBeatId,
};

// Causal source-integrity fault: mutate one source byte in memory but keep the declared digest.
const tamperedEnvelope = structuredClone(envelope);
const metadataOperation = tamperedEnvelope.operations.find((operation) => operation.path === '/authoring_metadata');
assert.ok(metadataOperation?.value?.sources?.[0]?.text);
metadataOperation.value.sources[0].text = `!${metadataOperation.value.sources[0].text.slice(1)}`;
const tamperedSourceResult = await inspectBuilderTransfer(tamperedEnvelope, {
  intent: 'copy', mode: 'ready', acknowledgeRedactions: true, acknowledgeRightsWarnings: true,
});
const sourceFault = {
  unchangedClaimedDigest: metadataOperation.value.sources[0].sha256 === identity.sha256,
  rejected: tamperedSourceResult.ok === false,
  errorCodes: [...new Set((tamperedSourceResult.errors ?? []).map((item) => item.code))],
  originalStillAccepted: (await inspectBuilderTransfer(envelope, {
    intent: 'copy', mode: 'ready', acknowledgeRedactions: true, acknowledgeRightsWarnings: true,
  })).ok,
};
assert.equal(sourceFault.unchangedClaimedDigest, true, 'fault must retain the original declared digest');
assert.ok(sourceFault.errorCodes.includes('source_hash'), 'source mutation must fail the source-hash boundary');
assert.equal(sourceFault.rejected, true, 'one-byte source mutation was accepted with an unchanged digest');
assert.equal(sourceFault.originalStillAccepted, true, 'source fault probe altered the frozen artifact');

const evidence = {
  generatedAt: new Date().toISOString(),
  mode: 'local structural/shared-reducer proof only; no SQL, browser, network, clinical approval or rehearsal signoff',
  frozenTransferSha256: transferSha,
  auditSha256: createHash('sha256').update(await readFile(auditPath)).digest('hex'),
  source: { file: identity.file, revision: identity.revision, sha256: sourceHash, byteLength: Buffer.byteLength(source, 'utf8'), exactTransferText: true },
  validation: { schema2CaseDocument: validation.ok, errors: validation.errors, warnings: validation.warnings, structuralReady: inspected.readyForRehearsal, rightsStatus: audit.source_rights_status, clinicalReviewStatus: audit.clinical_review_status, unreviewedProvenanceCount: inspected.candidate.authoring_metadata.provenance.filter((item) => item.review_status !== 'confirmed').length },
  authoredGraph: { decisionCount: doc.decisions.length, pathsPerDecision: doc.decisions.map((decision) => decision.paths.length), fullRoutesEnumeratedFromBeatGraph: routes.length, allAuthoredPathsReachable: routePathIds.size === doc.decisions.reduce((sum, decision) => sum + decision.paths.length, 0) },
  projectionFaults,
  routeRuns: { completed: routeResults.length, failed: 0, recoveriesChecked: routeResults.reduce((sum, route) => sum + route.recoveryChecks.length, 0), everyRouteReachedDebriefAndEnded: routeResults.every((route) => route.reachedDebrief && route.ended), results: routeResults },
  frozenClarificationProbe,
  clarificationPositiveControl,
  causalSourceHashFault: sourceFault,
};
assert.equal(evidence.routeRuns.recoveriesChecked, 54, 'all54 authored recovery occurrences must be checked');
if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
assert.deepEqual(projectionFaults, [], 'public projection or private-content exclusion failed');
assert.equal(frozenClarificationProbe.supportedOnFrozenCandidate, true, 'frozen clarification must work without a repair');
assert.equal(unavailableAtSurface.receipt, 'rejected', 'clarification must remain unavailable before an open round');
if (routeResults.length !== routes.length) throw new Error('not all routes ran');
console.log(JSON.stringify({ evidencePath, transferSha, auditSha256: evidence.auditSha256, routesEnumerated: routes.length, routesCompleted: routeResults.length, recoveriesChecked: evidence.routeRuns.recoveriesChecked, frozenClarificationProbe, clarificationPositiveControl, sourceFault }, null, 2));
