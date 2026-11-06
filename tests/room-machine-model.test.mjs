// Property tests for src/shared/room-machine.mjs: random command sequences, every invariant after
// every step. Imports the real module directly: a missing or broken machine must fail loudly here
// (an earlier adapter fell back to a stub and could have kept this file green without it).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, reduce, dispatch, project, participantTimeline, facilitatorActions, PHASES, COMMANDS } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { canLegacyPause, legacyPausedState } from './helpers/legacy-pause.mjs';

const FAC = { role: 'facilitator', id: 'facilitator' };
const AT0 = Date.UTC(2026, 9, 1, 9, 0, 0);
// Facilitator commands the model drives. `end` is rare, so most runs explore the live room.
const FACILITATOR_COMMANDS = ['start', 'advance', 'lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'reveal',
  'reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification',
  'reset_checkpoint', 'pause', 'resume', 'show_names', 'replay', 'enter_manual', 'manual_marker', 'resume_online', 'takeover',
  'close_joining', 'set_timer', 'rename', 'remove_participant', 'show_results', 'results_page', 'text_page', 'ranked_page', 'show_lobby', 'media_control',
  'debrief', 'back_to_case', 'debrief_page', 'finalise_lock', 'cancel_lock', 'set_auto_lock', 'set_music'];

/** Whole-surface/review/identity checks for arbitrary commands. Incremental disclosure is
 * independently checked per timeline occurrence by disclosure-oracle.test.mjs: an already
 * revealed surface ID alone does not make its withheld groups public (RT-04). */
function assertNoLeak(doc, state, pids) {
  const revealed = new Set(state.revealed.map((x) => x.surfaceId));
  const publicText = [
    ...doc.decisions.flatMap((d) => (d.interaction.options || []).map((o) => o.label)),
    ...doc.surfaces.filter((x) => revealed.has(x.id)).flatMap((x) => [x.title, ...x.points]),
  ].join('\n');
  const secrets = [
    ...doc.surfaces.filter((x) => !revealed.has(x.id)).flatMap((x) => [x.id, ...x.points]),
    ...doc.decisions.flatMap((d) => d.paths.flatMap((p) => [p.id, p.cue, p.rationale])),
  ].filter((x) => typeof x === 'string' && x.length > 3 && !publicText.includes(x));
  for (const [role, pid] of [['display', null], ...pids.map((p) => ['participant', p])]) {
    const { recap, ...view } = project(state, role, pid); // the recap teaches with the reader's OWN rationale (CASE-082)
    const json = JSON.stringify(view);
    for (const secret of secrets) assert.ok(!json.includes(secret), `${role} leaked "${secret.slice(0, 30)}" in ${state.phase}`);
    assert.doesNotMatch(json, /aggregate|suggestion|classification|"cue"/, `${role} leaked review data in ${state.phase}`);
    if (role === 'participant' && state.round) {
      for (const other of pids.filter((p) => p !== pid)) assert.ok(!json.includes(other), 'another participant id leaked to a phone');
    }
  }
}

const step = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('fac'), type: fc.constantFrom(...FACILITATOR_COMMANDS), pick: fc.nat(10), on: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('vote'), who: fc.nat(2), pick: fc.nat(10) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stale'), type: fc.constantFrom('advance', 'lock', 'reveal', 'reveal_path', 'undo', 'resume_online') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('retry') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('end') }) },
);

// The pure reducer receives authority evidence separately. Keep real response snapshots from executed
// votes across round closure, matching that boundary instead of inventing submission IDs for Undo.
function rememberRounds(evidence, state) {
  for (const round of [...state.rounds, ...(state.round ? [state.round] : [])]) evidence.set(round.id,
    structuredClone({ ...evidence.get(round.id), ...round,
      responses: round.responses ?? evidence.get(round.id)?.responses ?? {} }));
}

function payloadFor(doc, state, s, pids, evidence = new Map()) {
  const decision = doc.decisions.find((d) => d.id === state.decisionId);
  const pickOf = (list) => list[s.pick % list.length];
  switch (s.type) {
    case 'select_path': return { pathId: decision ? pickOf(decision.paths).id : uuidv7() };
    case 'reveal_path': return { pathId: state.selectedPathId ?? (decision ? pickOf(decision.paths).id : uuidv7()), expectRevision: state.revision };
    case 'undo': {
      const action = state.teachingActions?.at(-1), source = evidence.get(action?.roundId);
      return { targetEventId: project(state, 'facilitator').undo.targetEventId ?? uuidv7(),
        expectRevision: state.revision, roundId: uuidv7(),
        ...(source ? { sourceRound: structuredClone(source),
          seedResponseIds: Object.fromEntries(Object.keys(source.responses).map(pid => [pid, uuidv7()])) } : {}) };
    }
    case 'confirm_recovery': return { occurrenceId: project(state,'facilitator').recovery?.occurrenceId ?? uuidv7(), confirmed: s.on, expectRevision: state.revision };
    case 'show_clarification': return { clarificationId: doc.clarifications?.[0]?.id ?? uuidv7(), expectRevision: state.revision };
    case 'return_clarification': return { occurrenceId: state.clarification?.occurrenceId ?? uuidv7(), expectRevision: state.revision };
    case 'show_names': return { on: s.on };
    case 'show_results': return { on: s.on };
    case 'show_lobby': return { on: s.on };
    case 'results_page': return { page: s.pick % 4 };
    case 'text_page': return { page: s.pick % 300, expectRevision: state.revision, closedRoundId: project(state, 'facilitator').textPresentation?.closedRoundId ?? uuidv7() };
    case 'ranked_page': return { group: s.pick % 300, position: 0, expectRevision: state.revision, closedRoundId: project(state, 'facilitator').rankedRoundId ?? uuidv7() };
    case 'close_joining': return { closed: s.on };
    case 'debrief_page': return { page: s.pick };
    case 'replay': return { surfaceId: state.revealed.length ? pickOf(state.revealed).surfaceId : null };
    case 'enter_manual': return { segmentId: uuidv7() };
    case 'manual_marker': return { text: `marker ${s.pick}` };
    case 'set_timer': return { seconds: s.on ? 60 : null };
    // CASE-319: half the model's locks open a closing window (the Worker stamps graceMs), so finalise/cancel are reachable.
    case 'lock': return { roundId: uuidv7(), ...(s.on ? { graceMs: 2000 } : {}) };
    case 'set_auto_lock': return { on: s.on };
    case 'set_music': return s.on ? { intensity: (s.pick * 15) % 151 } : { choice: ['auto', 'atlas-current', 'side-street-developed', 'night-platform-developed'][s.pick % 4] };
    case 'finalise_lock': case 'cancel_lock': return {};
    case 'media_control': return { blockId: uuidv7(), action: ['play', 'pause', 'restart'][s.pick % 3], position: s.on ? 3 : null };
    case 'rename': return { participantId: pickOf(pids), displayName: `Renamed\u202e ${s.pick}` };
    case 'remove_participant': return { participantId: pickOf(pids) };
    default: return { roundId: uuidv7() };
  }
}

test('[AS-005] [AS-027] [AS-043] random command sequences keep every room invariant', () => {
  fc.assert(fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
    const { doc } = miniCase();
    let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
    const ledger = new Map();
    const evidence = new Map();
    let t = AT0;
    let last = null;
    const pids = [uuidv7(), uuidv7(), uuidv7()];
    const apply = (event) => {
      const before = state;
      const r = dispatch(state, event, ledger);
      const receipt = r.effects.find((e) => e.type === 'receipt');
      if (receipt?.receipt === 'accepted') {
        const journaled = r.effects.some((e) => e.type === 'journal');
        if (journaled) assert.ok(r.state.revision > before.revision, `${event.type}: an accepted, journaled command raises revision`);
        else assert.equal(r.state.revision, before.revision, `${event.type}: a non-journaled change keeps revision`);
      } else {
        assert.equal(r.state, before, `${event.type}: a refused command changes nothing (${receipt?.reason ?? receipt?.receipt})`);
        assert.deepEqual(r.effects.map((e) => e.type), receipt ? ['receipt'] : []);
      }
      assert.ok(r.state.epoch >= before.epoch, 'epoch never goes down');
      assert.ok(r.state.revision >= before.revision, 'revision never goes down');
      state = r.state;
      rememberRounds(evidence, state);
      last = event;
      return receipt;
    };
    for (const pid of pids) apply({ type: 'join', epoch: 0, actor: { role: 'participant', id: pid }, at: new Date(t += 1000).toISOString(), clientEventId: uuidv7(), displayName: 'P' });
    for (const s of steps) {
      t += 1000;
      const at = new Date(t).toISOString();
      if (s.kind === 'fac' && s.type === 'pause') {
        // CASE-255: pause is refused as retired; a room persisted while paused still exists until M2, so the model
        // goes on exploring it from the legacy persisted state.
        // Debrief's command guard precedes the retired command handler; this new phase never existed
        // while Pause was available, so it must not be converted into a legacy persisted pause either.
        const reason = state.phase === 'ended' ? 'room_ended' : state.phase === 'debrief' ? 'in_debrief' : 'retired';
        assert.equal(apply({ type: 'pause', epoch: state.epoch, actor: FAC, at, clientEventId: uuidv7() }).reason, reason);
        if (canLegacyPause(state)) state = legacyPausedState(state, at);
      } else if (s.kind === 'fac') apply({ type: s.type, epoch: state.epoch, actor: FAC, at, clientEventId: uuidv7(), ...payloadFor(doc, state, s, pids, evidence) });
      else if (s.kind === 'end') apply({ type: 'end', epoch: state.epoch, actor: FAC, at, clientEventId: uuidv7() });
      else if (s.kind === 'stale' && state.epoch > 0) {
        const before = state;
        const receipt = apply({ type: s.type, epoch: state.epoch - 1, actor: FAC, at, clientEventId: uuidv7(), ...payloadFor(doc, state, { ...s, pick: 0 }, pids, evidence) });
        assert.equal(receipt.receipt, 'stale_epoch');
        assert.equal(state, before);
      } else if (s.kind === 'retry' && last?.clientEventId) {
        const before = state;
        const receipt = dispatch(state, last, ledger).effects.find((e) => e.type === 'receipt');
        if (ledger.has(`${last.actor.role}:${last.actor.id ?? ''}:${last.clientEventId}`)) {
          assert.equal(receipt.receipt, 'already_accepted', 'a retried accepted command is idempotent');
          assert.equal(dispatch(state, last, ledger).state, before);
        }
      } else if (s.kind === 'vote' && state.round) {
        const decision = doc.decisions.find((d) => d.id === state.round.decisionId);
        const option = decision.interaction.options[s.pick % decision.interaction.options.length];
        apply({ type: 'vote', epoch: state.epoch, actor: { role: 'participant', id: pids[s.who] }, at, clientEventId: uuidv7(), roundId: state.round.id, responseId: uuidv7(), response: { option_id: option.id } });
      }
      assert.ok(PHASES.includes(state.phase), `exactly one recognised phase (${state.phase})`);
      assert.equal(state.phase === 'discussion_paused', state.resumePhase !== null, 'resumePhase is set exactly while paused');
      assert.ok(!state.round || ['open', 'locked'].includes(state.round.status), 'the current round is open or locked');
      assert.ok(!(state.manual && state.round), 'manual mode never has a live round');
      // CASE-281: a broadcast builds one phone timeline for every phone; each phone's projection is unchanged by it.
      const sharedTimeline = participantTimeline(state);
      for (const pid of pids) {
        const own = project(state, 'participant', pid);
        assert.deepEqual(project(state, 'participant', pid, { timeline: sharedTimeline }), own, 'the shared phone timeline changes no phone projection');
        const you = own.you;
        assert.equal(you.id, pid);
        assert.doesNotMatch(String(you.name), /[\u0000-\u001f\u202a-\u202e]/, 'names are stored cleaned');
      }
      assertNoLeak(doc, state, pids);
      // DO rebuild (CASE-072): meta.state is the reducer state as JSON; every projection survives it.
      const { caseDoc, ...persisted } = state;
      const rebuilt = { ...JSON.parse(JSON.stringify(persisted)), caseDoc };
      for (const [role, pid] of [['facilitator', null], ['display', null], ['participant', pids[0]]]) {
        assert.deepEqual(project(rebuilt, role, pid), project(state, role, pid), `${role} projection after a rebuild`);
      }
      // The console offers exactly what the reducer accepts (sampled on the cheap commands).
      for (const cmd of ['start', 'lock', 'reopen', 'void_round', 'reveal', 'reveal_path', 'undo', 'back_to_review', 'reset_checkpoint', 'pause', 'resume', 'resume_online']) {
        const probe = reduce(state, { type: cmd, epoch: state.epoch, actor: FAC, at: new Date(t + 1).toISOString(), roundId: uuidv7(), clientEventId: uuidv7(), ...payloadFor(doc, state, { type: cmd, pick: 0 }, pids, evidence) });
        assert.equal(facilitatorActions(state).includes(cmd), probe.effects[0]?.receipt === 'accepted', `${state.phase}${state.manual ? ' (manual)' : ''}: ${cmd}`);
      }
      // The lobby screen layer (CASE-176): offered exactly when its toggle is accepted.
      const toggle = reduce(state, { type: 'show_lobby', on: state.display.lobby !== true, epoch: state.epoch, actor: FAC, at: new Date(t + 1).toISOString(), clientEventId: uuidv7() });
      assert.equal(facilitatorActions(state).includes('show_lobby'), toggle.effects[0]?.receipt === 'accepted', `${state.phase}: show_lobby`);
    }
  }), { numRuns: 300 });
});

test('the model drives every reducer command', () => {
  const driven = new Set([...FACILITATOR_COMMANDS, 'end', 'vote', 'join']);
  assert.deepEqual(Object.keys(COMMANDS).filter((c) => !driven.has(c)), []);
  const r = rankingModelRoom(), second = uuidv7();
  assert.equal(r.apply('join', { displayName: 'Other learner' }, { role: 'participant', id: second }).receipt.receipt, 'accepted');
  assert.equal(r.apply('vote', { roundId: r.state.round.id, responseId: uuidv7(), response: {
    order: r.doc.decisions[0].interaction.options.slice(0, 3).reverse().map(option => option.id),
  } }, { role: 'participant', id: second }).receipt.receipt, 'accepted');
  assert.equal(r.apply('lock').receipt.receipt, 'accepted');
  const frozen = structuredClone(r.state.round), beforeRevision = r.state.revision;
  assert.equal(r.generated('ranked_page', 1).receipt.receipt, 'accepted', 'model payload must carry the observed revision and actual closed target');
  assert.deepEqual(r.state.rankedSelection, { group: 1, position: 0 });
  assert.deepEqual(project(r.state, 'display').responseResult.ranked.groups, [['210', 1]]);
  assert.equal(r.state.revision, beforeRevision + 1);
  assert.deepEqual(r.state.round, frozen, 'generated presentation command does not alter frozen clinical round');

});

function rankingModelRoom(builder = false) {
  const fixture = miniCase(), doc = fixture.doc, decision = doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
  while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: `Option ${decision.interaction.options.length + 1}` });
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  if (builder) {
    doc.schema_version=2;doc.required_capabilities=['early_clarification','required_recovery'];
    for (const d of doc.decisions) d.interpretation='rules';
    decision.paths[0].recovery={prompt:'Private recovery'};
    doc.clarifications=[{id:uuidv7(),label:'Clarification',surface_id:doc.surfaces[0].id,beat_ids:[fixture.b.d1]}];
  }
  const pid = uuidv7(), ledger = new Map(), evidence = new Map();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const apply = (type, payload = {}, actor = FAC) => {
    const event = { type, actor, epoch: state.epoch, at: new Date(AT0).toISOString(), clientEventId: uuidv7(), roundId: uuidv7(), ...payload };
    const result = dispatch(state, event, ledger); state = result.state; rememberRounds(evidence, state);
    return { event, receipt: result.effects.find(effect => effect.type === 'receipt') };
  };
  for (const [type, payload, actor] of [
    ['join', { displayName: 'Learner' }, { role: 'participant', id: pid }],
    ['start'], ['advance'], ['advance'],
  ]) assert.equal(apply(type, payload, actor).receipt.receipt, 'accepted');
  assert.equal(state.phase, 'responses_open');
  assert.equal(apply('vote', { roundId: state.round.id, responseId: uuidv7(), response: { order: decision.interaction.options.slice(0, 3).map(option => option.id) } }, { role: 'participant', id: pid }).receipt.receipt, 'accepted');
  return { doc, pid, apply, ledger, get state() { return state; }, generated(type, pick = 0, on = true) {
    return apply(type, payloadFor(doc, state, { type, pick, on }, [pid], evidence));
  } };
}

test('model-generated atomic Reveal publishes its authored route and clears chart, replay and lobby together', () => {
  const r = rankingModelRoom();
  assert.equal(r.apply('lock').receipt.receipt, 'accepted');
  assert.equal(r.apply('replay', { surfaceId: r.state.revealed[0].surfaceId }).receipt.receipt, 'accepted');
  assert.equal(r.apply('show_lobby', { on: true }).receipt.receipt, 'accepted');
  assert.equal(r.state.resultsShown, true);
  assert.notEqual(r.state.display.cursor, null);
  assert.equal(r.state.display.lobby, true);
  const before = r.state, target = r.doc.decisions[0].paths[0];
  assert.equal(r.apply('reveal_path', { pathId: target.id }).receipt.reason, 'missing_correction_fence');
  assert.equal(r.state, before, 'the unfenced new command changes neither clinical state nor overlays');
  assert.equal(r.apply('reveal_path', { pathId: target.id, expectRevision: before.revision - 1 }).receipt.reason, 'stale_revision');
  assert.equal(r.state, before, 'stale local intent cannot publish or clear any overlay');
  const published = r.generated('reveal_path');
  assert.equal(published.receipt.receipt, 'accepted', 'the generated new command must execute successfully');
  assert.equal(published.event.expectRevision, before.revision);
  assert.equal(published.event.pathId, target.id);
  assert.equal(r.state.phase, 'consequence_revealed');
  assert.equal(r.state.revealed.at(-1).surfaceId, target.reveal_surface_id);
  assert.equal(r.state.revealed.at(-1).occurrenceId, published.event.clientEventId);
  assert.equal(r.state.rounds.at(-1).selectedPathId, target.id);
  assert.equal(r.state.resultsShown, false);
  assert.equal(r.state.display.cursor, null);
  assert.equal(r.state.display.lobby, false);
  assert.equal(project(r.state, 'display').surface.surfaceId, target.reveal_surface_id);
  assertNoLeak(r.doc, r.state, [r.pid]);
  const retry = dispatch(r.state, published.event, r.ledger);
  assert.equal(retry.effects[0].receipt, 'already_accepted');
  assert.equal(retry.state, r.state, 'Reveal retry cannot create a second publication');
});

test('model-generated exact-target Undo retains original submissions and restores fresh locked then editable rounds', () => {
  const r = rankingModelRoom(), sourceId = r.state.round.id;
  const submission = structuredClone(r.state.round.responses[r.pid]);
  const locked = r.apply('lock'); assert.equal(locked.receipt.receipt, 'accepted');
  const contextOccurrenceId = r.state.revealed.at(-1).occurrenceId;
  const published = r.generated('reveal_path'); assert.equal(published.receipt.receipt, 'accepted');
  const original = structuredClone(r.state.rounds.find(round => round.id === sourceId));
  const before = r.state;
  assert.equal(r.apply('undo', { expectRevision: before.revision, targetEventId: locked.event.clientEventId }).receipt.reason, 'stale_undo_target');
  assert.equal(r.state, before, 'Undo cannot skip the latest Reveal to undo its earlier Lock');
  const missingSeed = r.apply('undo', { expectRevision: before.revision, targetEventId: published.event.clientEventId,
    sourceRound: { ...original, responses: { [r.pid]: submission } }, seedResponseIds: {} });
  assert.equal(missingSeed.receipt.reason, 'missing_seed_id');
  assert.equal(r.state, before, 'missing fresh seed IDs cannot consume the inverse or partially restore presentation');
  const restored = r.generated('undo');
  assert.equal(restored.receipt.receipt, 'accepted');
  assert.equal(restored.event.targetEventId, published.event.clientEventId);
  assert.equal(restored.event.sourceRound.id, sourceId);
  assert.deepEqual(restored.event.sourceRound.responses[r.pid], submission, 'evidence comes from executed votes');
  assert.equal(r.state.phase, 'responses_locked');
  assert.notEqual(r.state.round.id, sourceId);
  assert.equal(r.state.round.seedSourceRoundId, sourceId);
  assert.equal(r.state.selectedPathId, null);
  assert.equal(r.state.revealed.at(-1).correctionOf, published.event.clientEventId);
  assert.equal(r.state.revealed.at(-1).restoresOccurrenceId, contextOccurrenceId);
  assert.ok(r.state.revealed.some(entry => entry.occurrenceId === published.event.clientEventId), 'mistaken publication remains immutable history');
  const seeded = r.state.round.responses[r.pid];
  assert.notEqual(seeded.id, submission.id);
  assert.equal(seeded.seed.sourceResponseId, submission.id);
  assert.equal(seeded.seed.sourceClientEventId, submission.clientEventId);
  assert.equal(seeded.firstAt, submission.firstAt);
  assert.equal(seeded.lastAt, submission.lastAt);
  assert.deepEqual(seeded.response, submission.response);
  assert.deepEqual(r.state.rounds.find(round => round.id === sourceId), original);
  const retry = dispatch(r.state, restored.event, r.ledger);
  assert.equal(retry.effects[0].receipt, 'already_accepted');
  assert.equal(retry.state, r.state, 'accepted Undo retry neither reseeds nor republishes');
  const lockedSeedId = r.state.round.id, editable = r.generated('undo');
  assert.equal(editable.receipt.receipt, 'accepted');
  assert.equal(editable.event.targetEventId, locked.event.clientEventId);
  assert.equal(r.state.phase, 'responses_open');
  assert.notEqual(r.state.round.id, sourceId);
  assert.notEqual(r.state.round.id, lockedSeedId);
  assert.deepEqual(project(r.state, 'participant', r.pid).decision.yourResponse, submission.response);
  const late = r.apply('vote', { roundId: sourceId, responseId: uuidv7(), response: { order: [...submission.response.order].reverse() } }, { role: 'participant', id: r.pid });
  assert.equal(late.receipt.receipt, 'locked', 'old-round delivery cannot become a vote on the editable seeded round');
  assert.equal(r.apply('vote', { roundId: r.state.round.id, responseId: uuidv7(), response: { order: [...submission.response.order].reverse() } }, { role: 'participant', id: r.pid }).receipt.receipt, 'accepted');
  assert.deepEqual(r.state.rounds.find(round => round.id === sourceId), original);
  assertNoLeak(r.doc, r.state, [r.pid]);
});

test('Card24 model-generated result visibility respects open/closed eligibility without altering clinical state', () => {
  const r = rankingModelRoom();
  let before = r.state;
  assert.equal(r.generated('show_results', 0, false).receipt.receipt, 'rejected'); assert.equal(r.state, before);
  assert.equal(r.apply('lock').receipt.receipt, 'accepted');
  const clinical = { round: structuredClone(r.state.round), flags: [...r.state.flags], timeline: structuredClone(r.state.revealed), path: r.state.selectedPathId };
  const hidden = r.generated('show_results', 0, false);
  assert.equal(hidden.receipt.receipt, 'accepted'); assert.equal(project(r.state, 'display').responseResult, null);
  assert.equal(r.generated('show_results', 0, true).receipt.receipt, 'accepted');
  assert.equal(project(r.state, 'display').responseResult.total, 1);
  assert.deepEqual({ round: r.state.round, flags: r.state.flags, timeline: r.state.revealed, path: r.state.selectedPathId }, clinical);
  before = r.state;
  assert.equal(dispatch(r.state, hidden.event, r.ledger).effects.find(effect => effect.type === 'receipt').receipt, 'already_accepted');
  assert.equal(dispatch(r.state, hidden.event, r.ledger).state, before);
  assertNoLeak(r.doc, r.state, [r.pid]);
});

test('Card24 model-generated result pages enforce visible ranking bounds and reset without choosing a route', () => {
  const r = rankingModelRoom();
  let before = r.state;
  assert.equal(r.generated('results_page', 3).receipt.receipt, 'rejected'); assert.equal(r.state, before);
  assert.equal(r.apply('lock').receipt.receipt, 'accepted');
  const round = structuredClone(r.state.round);
  assert.equal(r.generated('results_page', 3).receipt.receipt, 'accepted'); assert.equal(r.state.resultsPage, 3);
  assert.deepEqual(r.state.round, round); assert.equal(r.state.selectedPathId, null);
  before = r.state;
  assert.equal(r.apply('results_page', { page: 4 }).receipt.receipt, 'rejected'); assert.equal(r.state, before);
  assert.equal(r.generated('show_results', 0, false).receipt.receipt, 'accepted');
  before = r.state;
  assert.equal(r.generated('results_page', 0).receipt.receipt, 'rejected'); assert.equal(r.state, before); assert.equal(r.state.resultsPage, 3);
  assert.equal(r.apply('reopen').receipt.receipt, 'accepted'); assert.equal(r.state.resultsPage, 0);
  assert.equal(r.state.resultsShown, true); assert.equal(project(r.state, 'display').responseResult, null);
  assertNoLeak(r.doc, r.state, [r.pid]);
});

 test('schema2 model payloads drive real clarification and recovery transitions',()=>{
  const r=rankingModelRoom(true);
  assert.equal(r.generated('show_clarification').receipt.receipt,'accepted');
  assert.equal(r.state.phase,'responses_open');
  assert.equal(r.generated('return_clarification').receipt.receipt,'accepted');
  assert.equal(r.apply('lock').receipt.receipt,'accepted');
  assert.equal(r.generated('reveal_path',0).receipt.receipt,'accepted');
  assert.equal(r.apply('advance').receipt.reason,'recovery_required');
  assert.equal(r.generated('confirm_recovery',0,true).receipt.receipt,'accepted');
  assert.equal(project(r.state,'facilitator').recovery.confirmed,true);
  assert.equal(r.generated('confirm_recovery',0,false).receipt.receipt,'accepted');
  assert.equal(r.apply('advance').receipt.reason,'recovery_required');
 });

// Card 61 (RUNTIME-01): the facilitator view says when a decision's only route is a direct continuation (CASE-280), so
// the console offers one Continue instead of an authored-route card. The flag is facilitator-only and exact: it holds
// for a sole `continue_to_next` route in a case declaring `direct_continuation`, and for nothing else.
function ordinaryModelDoc(ordinary) {
  const doc = convertSchema1ToBuilderDocument(miniCase().doc, { metadata_version: 1 }).candidate;
  doc.decisions.forEach((decision, index) => {
    if (!ordinary[index]) return;
    const path = { ...decision.paths[0], continue_to_next: true, classification: 'discussion-prompt', label: 'Continue', option_ids: decision.interaction.options.map(option => option.id) };
    delete path.set_flags; delete path.clear_flags; delete path.terminal; delete path.recovery;
    decision.paths = [path]; decision.fallback_path_id = path.id; delete decision.rules;
  });
  if (ordinary.some(Boolean)) { for (const beat of doc.beats) delete beat.requires_flags; doc.required_capabilities.push('direct_continuation'); }
  return doc;
}
test('[AS-160] random sequences keep the direct-continuation view flag exact and facilitator-only, and its Continue lands on the next slide', () => {
  const directSteps = fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant('fac'), type: fc.constantFrom('start', 'advance', 'lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'reveal', 'reveal_path', 'undo', 'enter_manual', 'resume_online', 'replay'), pick: fc.nat(10), on: fc.boolean() }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('vote'), who: fc.nat(1), pick: fc.nat(10) }) },
  );
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 2, maxLength: 2 }), fc.array(directSteps, { minLength: 1, maxLength: 50 }), (ordinary, steps) => {
    const doc = ordinaryModelDoc(ordinary), pids = [uuidv7(), uuidv7()], ledger = new Map(), evidence = new Map();
    let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), t = AT0;
    const apply = event => { const r = dispatch(state, event, ledger); state = r.state; rememberRounds(evidence, state); return r.effects.find(e => e.type === 'receipt'); };
    for (const pid of pids) apply({ type: 'join', epoch: 0, actor: { role: 'participant', id: pid }, at: new Date(t += 1000).toISOString(), clientEventId: uuidv7(), displayName: 'P' });
    for (const s of steps) {
      const at = new Date(t += 1000).toISOString();
      if (s.kind === 'fac') apply({ type: s.type, epoch: state.epoch, actor: FAC, at, clientEventId: uuidv7(), ...payloadFor(doc, state, s, pids, evidence) });
      else if (state.round) {
        const decision = doc.decisions.find(d => d.id === state.round.decisionId), option = decision.interaction.options[s.pick % decision.interaction.options.length];
        apply({ type: 'vote', epoch: state.epoch, actor: { role: 'participant', id: pids[s.who] }, at, clientEventId: uuidv7(), roundId: state.round.id, responseId: uuidv7(), response: { option_id: option.id } });
      }
      const view = project(state, 'facilitator');
      if (view.decision) {
        const index = doc.decisions.findIndex(d => d.id === view.decision.decisionId);
        assert.equal(view.decision.directContinue, ordinary[index], `decision ${index} in ${state.phase}`);
      }
      for (const [role, pid] of [['display', null], ['participant', pids[0]]]) assert.doesNotMatch(JSON.stringify(project(state, role, pid)), /directContinue/, `${role} never sees the route model`);
      // The console's one Continue is the sole route, and it publishes the next slide, never an outcome screen.
      if (view.decision?.directContinue && view.actions.includes('reveal_path')) {
        const path = doc.decisions.find(d => d.id === view.decision.decisionId).paths[0];
        const probe = reduce(state, { type: 'reveal_path', pathId: view.decision.paths[0].id, expectRevision: state.revision, epoch: state.epoch, actor: FAC, at: new Date(t + 1).toISOString(), clientEventId: uuidv7() });
        assert.equal(probe.effects[0]?.receipt, 'accepted');
        assert.equal(probe.state.beatId, path.next_beat_id);
        assert.notEqual(probe.state.phase, 'consequence_revealed');
      }
    }
  }), { numRuns: 200 });
});

test('Undo of a locked round keeps every projection equal to its DO rebuild (seed 1168471028)', () => {
  // The property's shrunk counterexample: the history round Undo pushed carried `responses: undefined`,
  // which the facilitator projection exposed and the JSON rebuild (CASE-072) dropped.
  const { doc } = miniCase(), pids = [uuidv7(), uuidv7(), uuidv7()], ledger = new Map(), evidence = new Map();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), t = AT0;
  const apply = (event) => {
    const r = dispatch(state, { epoch: state.epoch, at: new Date(t += 1000).toISOString(), clientEventId: uuidv7(), ...event }, ledger);
    state = r.state; rememberRounds(evidence, state);
    return r.effects.find((e) => e.type === 'receipt').receipt;
  };
  for (const pid of pids) assert.equal(apply({ type: 'join', epoch: 0, actor: { role: 'participant', id: pid }, displayName: 'P' }), 'accepted');
  for (const type of ['start', 'advance', 'advance', 'lock', 'undo', 'start']) {
    apply({ type, actor: FAC, ...payloadFor(doc, state, { type, pick: 0, on: false }, pids, evidence) });
    const { caseDoc, ...persisted } = state;
    const rebuilt = { ...JSON.parse(JSON.stringify(persisted)), caseDoc };
    for (const [role, pid] of [['facilitator', null], ['display', null], ['participant', pids[0]]]) {
      assert.deepEqual(project(rebuilt, role, pid), project(state, role, pid), `${role} projection after a rebuild (${type})`);
    }
  }
  assert.equal(state.rounds.length, 1, 'Undo moved the locked source round into history');
  assert.equal(Object.hasOwn(state.rounds[0], 'responses'), false, 'a history round keeps answers only, with no responses key');
});
