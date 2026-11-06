// tests/participant-timeline.test.mjs: CASE-281 Phase 0. A broadcast builds the phone timeline once and serialises it
// once (participantTimeline + snapshotText); every phone must still receive exactly what its own full projection says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, project, participantTimeline, facilitatorActions } from '../src/shared/room-machine.mjs';
import { snapshotBody } from '../src/shared/wire.mjs';
import { snapshotText } from '../src/worker/snapshot-text.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { walkRoom } from './helpers/room-walk.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

/** What the Durable Object sends one phone in a broadcast, against what it sent before CASE-281. */
function assertSharedMatchesFull(state, pids, label) {
  const timeline = participantTimeline(state);
  const shared = { timeline, text: JSON.stringify(timeline) };
  for (const pid of pids) {
    const full = project(state, 'participant', pid);
    assert.deepEqual(timeline, full.timeline, `${label}: the shared timeline is this phone's own timeline`);
    const fast = project(state, 'participant', pid, { timeline });
    assert.equal(fast.timeline, timeline, `${label}: the projection reuses the shared array`);
    assert.deepEqual(fast, full, `${label}: the projection is otherwise unchanged`);
    const before = JSON.stringify(snapshotBody(state, full));
    const after = snapshotText(snapshotBody(state, fast), shared);
    assert.deepEqual(JSON.parse(after), JSON.parse(before), `${label}: the phone's snapshot parses to the same body`);
    assert.equal(after.length, before.length, `${label}: the same bytes, only the key order moves`);
  }
}

test('[AS-170] every reachable mini-case state: the shared phone timeline equals each phone\'s full projection', () => {
  const { states, pid } = walkRoom();
  assert.ok(states.length > 200, `the walk explores the room (${states.length} states)`);
  let withTimeline = 0;
  for (const [i, state] of states.entries()) {
    if (state.revealed.length) withTimeline++;
    assertSharedMatchesFull(state, [pid], `state ${i} (${state.phase})`);
    // A room persisted before grouped progress (no presentationVersion) is normalised the same way on both paths.
    const { presentationVersion: _v, ...legacy } = state;
    assertSharedMatchesFull({ ...legacy, revealed: state.revealed.map(({ groupsShown: _g, ...entry }) => entry) }, [pid], `legacy state ${i}`);
  }
  assert.ok(withTimeline > 100, 'most explored states have a timeline');
});

// A real schema-3 slide case driven to its end with three phones voting, so slide steps, consequence reveals and the
// recap are all covered.
function slideCase() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  return convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}

test('[AS-170] a slide room walked to its recap: every phone gets its own full projection from the shared timeline', () => {
  const caseDoc = slideCase();
  const fac = { role: 'facilitator', id: 'fac' };
  let clock = Date.parse('2026-10-20T09:00:00.000Z');
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc });
  const pids = [uuidv7(), uuidv7(), uuidv7()];
  const send = (type, extra = {}, actor = fac) => {
    clock += 1000;
    const r = reduce(state, { type, roundId: uuidv7(), clientEventId: uuidv7(), epoch: state.epoch, at: new Date(clock).toISOString(), actor, ...extra });
    const receipt = r.effects.find(effect => effect.type === 'receipt');
    if (!receipt || ['accepted', 'already_accepted'].includes(receipt.receipt)) state = r.state;
    return receipt;
  };
  for (const pid of pids) send('join', { displayName: 'Phone' }, { role: 'participant', id: pid });
  send('start');
  let checked = 0;
  for (let step = 0; step < 400 && state.phase !== 'ended'; step++) {
    assertSharedMatchesFull(state, pids, `step ${step} (${state.phase})`); checked++;
    if (state.phase === 'responses_open') {
      const decision = caseDoc.decisions.find(d => d.id === state.round.decisionId);
      const options = decision.interaction.options ?? [];
      pids.forEach((pid, i) => {
        const it = decision.interaction;
        const response = it.type === 'multi_select' ? { option_ids: [options[i % options.length].id] }
          : it.type === 'ranking' ? { order: options.slice(0, it.rank_count ?? options.length).map(o => o.id) }
            : it.type === 'free_text' ? { text: `Answer ${i}` } : { option_id: options[i % options.length].id };
        send('vote', { roundId: state.round.id, responseId: uuidv7(), response }, { role: 'participant', id: pid });
      });
      send('lock');
      const path = decision.paths.find(p => p.recommended) ?? decision.paths[0];
      send('select_path', { pathId: path.id, expectRevision: state.revision });
      assertSharedMatchesFull(state, pids, `results shown (${state.phase})`);
      send('show_results', { on: false }); // the room hides the chart before the route is revealed
      { const r = send('reveal', { expectRevision: state.revision }); assert.equal(r?.receipt, 'accepted', `reveal: ${r?.reason} at ${state.phase}`); }
    } else {
      const receipt = send('advance', { expectRevision: state.revision });
      if (receipt?.receipt === 'accepted') continue;
      if (facilitatorActions(state).includes('end')) send('end', { expectRevision: state.revision });
      else assert.fail(`stuck at ${state.phase}: ${receipt?.reason}`);
    }
  }
  assert.equal(state.phase, 'ended', 'the walk reached the recap');
  assertSharedMatchesFull(state, pids, 'recap');
  assert.ok(state.revealed.length >= 5 && checked >= 10, `a real timeline was exercised (${state.revealed.length} entries, ${checked} states)`);
  assert.ok(project(state, 'participant', pids[0]).recap, 'the recap is in the checked projection');
});

test('[AS-170] a supplied timeline that does not cover this state is never used', () => {
  const { states, pid } = walkRoom({ limit: 400 });
  const state = states.findLast(s => s.revealed.length >= 2);
  const stale = participantTimeline({ ...state, revealed: state.revealed.slice(0, -1) });
  const view = project(state, 'participant', pid, { timeline: stale });
  assert.notEqual(view.timeline, stale);
  assert.deepEqual(view, project(state, 'participant', pid));
  assert.equal(project(state, 'display', null, { timeline: stale }).timeline, undefined, 'the projector never takes a timeline');
  assert.notEqual(project(state, 'facilitator', null, { timeline: stale }).timeline, stale, 'nor does the console');
});

test('[AS-170] snapshotText splices only the shared array and stays valid JSON for awkward text', () => {
  const timeline = [{ title: 'Quote " backslash \\ line sep \u{1F600}', points: ['</script>', ''] }, { title: null }];
  const shared = { timeline, text: JSON.stringify(timeline) };
  const body = { v: 1, t: 'snapshot', revision: 7, epoch: 2, displayRevision: 3, view: { role: 'participant', timeline, recap: null } };
  const text = snapshotText(body, shared);
  assert.deepEqual(JSON.parse(text), body);
  assert.equal(text.length, JSON.stringify(body).length);
  assert.ok(text.endsWith(`"timeline":${shared.text}}}`), 'the shared text is used as is');
  // A copy of the timeline, a missing timeline, or no shared value: plain JSON.stringify, byte for byte.
  const copy = { ...body, view: { ...body.view, timeline: structuredClone(timeline) } };
  assert.equal(snapshotText(copy, shared), JSON.stringify(copy));
  const noTimeline = { ...body, view: { role: 'display', surface: null } };
  assert.equal(snapshotText(noTimeline, shared), JSON.stringify(noTimeline));
  assert.equal(snapshotText(body, null), JSON.stringify(body));
  assert.equal(snapshotText(body, { timeline }), JSON.stringify(body), 'no serialised text: no splice');
  // The smallest bodies still splice into valid JSON.
  const bare = { view: { timeline } };
  assert.deepEqual(JSON.parse(snapshotText(bare, shared)), bare);
});
