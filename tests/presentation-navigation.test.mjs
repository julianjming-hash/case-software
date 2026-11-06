import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, isUuidV7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, applySegment, normalizePresentationState } from '../src/shared/room-machine.mjs';
import { parseCommandEnvelope } from '../src/shared/wire.mjs';
import { publicPresentationSurface } from '../src/shared/presentation-groups.mjs';
import { consolePublicSurface } from '../src/client/presentation-nav.mjs';
import { miniCase } from './helpers/mini-case.mjs';

function room(doc) {
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const ledger = new Map();
  let second = 0;
  return {
    get state() { return state; },
    send(type, payload = {}, clientEventId = uuidv7()) {
      const result = dispatch(state, {
        type, epoch: state.epoch, actor: { role: 'facilitator', id: 'facilitator' },
        at: new Date(Date.UTC(2026, 9, 2, 9, 0, second++)).toISOString(),
        clientEventId, ...payload,
      }, ledger);
      state = result.state;
      return result.effects.find((effect) => effect.type === 'receipt')?.receipt;
    },
  };
}

test('Card 23 first populated group is public while future scene content and media IDs stay off both public roles', () => {
  const { doc } = miniCase();
  const surface = doc.surfaces[0];
  surface.scene = 'SCENE_FIRST_PUBLIC';
  surface.asset_ids = [uuidv7()];
  surface.observations = [{ label: 'FUTURE_OBSERVATION', value: '132' }];
  surface.points = ['FUTURE_FINDING'];
  surface.investigations = ['FUTURE_INVESTIGATION'];
  const r = room(doc);
  assert.equal(r.send('start'), 'accepted');
  for (const role of ['display', 'participant']) {
    const view = project(r.state, role);
    const json = JSON.stringify(view);
    assert.match(json, /SCENE_FIRST_PUBLIC/);
    for (const hidden of [surface.asset_ids[0], 'FUTURE_OBSERVATION', 'FUTURE_FINDING', 'FUTURE_INVESTIGATION']) {
      assert.ok(!json.includes(hidden), `${role} leaked unrevealed ${hidden}`);
    }
  }
});

test('[AS-084] Card 23 a decision beat prepares all context before any direct or retried advance can open responses', () => {
  const { doc } = miniCase();
  const decisionSurface = doc.surfaces[1];
  decisionSurface.scene = 'DECISION_SCENE';
  decisionSurface.points = ['DECISION_FINDING'];
  decisionSurface.investigations = ['DECISION_INVESTIGATION'];
  const r = room(doc);
  assert.equal(r.send('start'), 'accepted');
  assert.equal(r.send('advance', { roundId: uuidv7() }), 'accepted');
  assert.equal(r.state.phase, 'surface_live', 'entering a decision prepares context without voting');
  assert.equal(r.state.round, null);
  const first = r.state.revealed.at(-1).groupsShown;
  const cid = uuidv7();
  assert.equal(r.send('advance', { roundId: uuidv7() }, cid), 'accepted');
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.round, null);
  assert.equal(r.state.revealed.at(-1).groupsShown, first + 1);
  assert.equal(r.send('advance', { roundId: uuidv7() }, cid), 'already_accepted');
  assert.equal(r.state.revealed.at(-1).groupsShown, first + 1, 'one event cannot reveal twice');
  assert.equal(r.send('advance', { roundId: uuidv7() }), 'accepted');
  assert.equal(r.state.round, null, 'last context reveal is still separate from opening responses');
  assert.equal(r.send('advance', { roundId: uuidv7() }), 'accepted');
  assert.equal(r.state.phase, 'responses_open');
});

test('[AS-085] Card 23 replay targets a public timeline entry even when a checkpoint reuses its surface', () => {
  const { doc, p } = miniCase();
  const r = room(doc);
  r.send('start');
  r.send('advance', { roundId: uuidv7() });
  r.send('advance', { roundId: uuidv7() });
  assert.equal(r.state.phase, 'responses_open');
  r.send('lock');
  r.send('select_path', { pathId: p.intubate });
  r.send('show_results', { on: false });
  r.send('reveal');
  assert.equal(r.state.phase, 'terminal_teaching');
  r.send('reset_checkpoint', { roundId: uuidv7() });
  assert.equal(r.state.revealed[1].surfaceId, r.state.revealed.at(-1).surfaceId);
  const before = { revision: r.state.revision, phase: r.state.phase, rounds: structuredClone(r.state.rounds) };
  assert.equal(r.send('replay', { entryIndex: 1 }), 'accepted');
  const old = project(r.state, 'display');
  assert.equal(old.replay, true);
  assert.equal(old.surface.at, r.state.revealed[1].at, 'the earlier row remains separately selectable');
  assert.equal(r.send('replay', { entryIndex: null }), 'accepted');
  assert.equal(project(r.state, 'display').replay, false);
  assert.equal(r.state.revision, before.revision, 'replay changes only display revision');
  assert.equal(r.state.phase, before.phase);
  assert.deepEqual(r.state.rounds, before.rounds, 'clinical history is untouched');
});

test('Card 23 facilitator room-visible replay matches the projector and withholds an unfinished old terminal group', () => {
  const { doc, p } = miniCase();
  doc.surfaces[4].scene = 'OLD_TERMINAL_SCENE';
  doc.surfaces[4].points = ['OLD_TERMINAL_FINDING'];
  const r = room(doc);
  r.send('start');
  r.send('advance', { roundId: uuidv7() });
  r.send('advance', { roundId: uuidv7() });
  r.send('lock');
  r.send('select_path', { pathId: p.intubate });
  r.send('show_results', { on: false });
  r.send('reveal');
  assert.equal(r.state.phase, 'terminal_teaching');
  const terminalIndex = r.state.revealed.length - 1;
  assert.equal(r.state.revealed[terminalIndex].groupsShown, 1);
  r.send('reset_checkpoint', { roundId: uuidv7() });
  r.send('replay', { entryIndex: terminalIndex });
  const display = project(r.state, 'display');
  const facilitator = project(r.state, 'facilitator');
  assert.equal(display.replay, true);
  assert.equal(display.surface.scene, 'OLD_TERMINAL_SCENE');
  assert.deepEqual(display.surface.points, []);
  assert.deepEqual(facilitator.publicDisplaySurface, display.surface);
  assert.deepEqual(consolePublicSurface(facilitator), display.surface);
  assert.ok(!JSON.stringify(facilitator.publicDisplaySurface).includes('OLD_TERMINAL_FINDING'));
});

test('Card 23 replay wire permits one bounded public entry index and refuses mixed or unbounded targets', () => {
  const envelope = (entryIndex, extra = {}) => ({ v: 1, type: 'replay', epoch: 0, clientEventId: uuidv7(), entryIndex, ...extra });
  assert.equal(parseCommandEnvelope(envelope(1), 'facilitator').ok, true);
  assert.equal(parseCommandEnvelope(envelope(null), 'facilitator').ok, true, 'explicit Live is allowed');
  for (const index of [-1, 1.5, 4096, '1']) {
    assert.equal(parseCommandEnvelope(envelope(index), 'facilitator').ok, false, `refuse index ${index}`);
  }
  assert.equal(parseCommandEnvelope(envelope(1, { surfaceId: uuidv7() }), 'facilitator').ok, false);
  assert.equal(parseCommandEnvelope(envelope(1), 'participant').error, 'forbidden');
});

test('Card 23 facilitator receives only the live presentation progress needed for a precise next action', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'Opening scene.';
  doc.surfaces[0].points = ['Finding follows.'];
  const r = room(doc);
  r.send('start');
  let view = project(r.state, 'facilitator');
  assert.deepEqual(view.presentation, { entryIndex: 0, shown: 1, total: 2, nextGroup: 'findings', mediaUnavailable: false });
  assert.ok(view.actions.includes('advance'));
  r.send('advance');
  view = project(r.state, 'facilitator');
  assert.deepEqual(view.presentation, { entryIndex: 0, shown: 2, total: 2, nextGroup: null, mediaUnavailable: false });
  assert.equal(view.nextBeat.kind, 'decision', 'the next advance will enter the next authored beat');
});

test('Card 23 a new live group leaves an intentional projector replay in place while phones receive only the new live group', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'EARLIER_PUBLIC_SCENE';
  doc.surfaces[0].points = [];
  doc.surfaces[1].scene = 'NEW_PUBLIC_SCENE';
  doc.surfaces[1].points = ['LATER_PUBLIC_FINDING'];
  const r = room(doc);
  assert.equal(r.send('start'), 'accepted');
  assert.equal(r.send('advance'), 'accepted');
  assert.equal(r.send('replay', { entryIndex: 0 }), 'accepted');
  assert.equal(r.send('advance'), 'accepted');
  const display = project(r.state, 'display');
  const phone = project(r.state, 'participant');
  assert.equal(display.replay, true);
  assert.equal(display.surface.scene, 'EARLIER_PUBLIC_SCENE');
  assert.ok(!JSON.stringify(display).includes('LATER_PUBLIC_FINDING'));
  assert.deepEqual(phone.liveSurface.points, ['LATER_PUBLIC_FINDING']);
  assert.equal(phone.liveSurface.scene, 'NEW_PUBLIC_SCENE');
  assert.equal(r.send('replay', { entryIndex: null }), 'accepted');
  assert.deepEqual(project(r.state, 'display').surface.points, ['LATER_PUBLIC_FINDING']);
});

test('Card 23 each visible text group arrives in order while deferred media identifiers stay off both public timelines', () => {
  const { doc } = miniCase();
  const surface = doc.surfaces[0];
  const assetId = uuidv7();
  surface.scene = 'GROUP_SCENE';
  surface.asset_ids = [assetId];
  surface.observations = [{ label: 'GROUP_OBSERVATION', value: '132' }];
  surface.points = ['GROUP_FINDING'];
  surface.investigations = ['GROUP_INVESTIGATION'];
  const markers = ['GROUP_SCENE', 'GROUP_OBSERVATION', 'GROUP_FINDING', 'GROUP_INVESTIGATION'];
  const r = room(doc);
  assert.equal(r.send('start'), 'accepted');
  assert.equal(project(r.state, 'facilitator').presentation.mediaUnavailable, true);
  for (let shown = 1; shown <= markers.length; shown++) {
    for (const role of ['display', 'participant']) {
      const json = JSON.stringify(project(r.state, role));
      assert.ok(!json.includes(assetId), `${role} disclosed deferred media ID`);
      for (let i = 0; i < markers.length; i++) {
        assert.equal(json.includes(markers[i]), i < shown, `${role} marker ${i} at group ${shown}`);
      }
    }
    if (shown < markers.length) assert.equal(r.send('advance'), 'accepted');
  }
  assert.equal(r.state.revealed[0].groupsShown, markers.length);
});

test('Card 23 manual route selection cannot skip unrevealed decision context', () => {
  const { doc, p } = miniCase();
  doc.surfaces[1].scene = 'MANUAL_DECISION_SCENE';
  doc.surfaces[1].points = ['MANUAL_DECISION_FINDING'];
  const r = room(doc);
  assert.equal(r.send('start'), 'accepted');
  assert.equal(r.send('enter_manual', { segmentId: uuidv7() }), 'accepted');
  assert.equal(r.send('advance'), 'accepted');
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.round, null);
  assert.equal(project(r.state, 'display').decision, null, 'manual options stay private until all authored context is shared');
  assert.equal(r.send('select_path', { pathId: p.intubate }), 'rejected');
  assert.equal(r.state.selectedPathId, null);
  assert.equal(r.send('advance'), 'accepted');
  assert.ok(project(r.state, 'display').decision, 'manual options become public with completed context');
  assert.equal(r.send('select_path', { pathId: p.intubate }), 'accepted');
});

test('Card 23 public surface filtering drops unknown private fields instead of spreading them to room clients', () => {
  const filtered = publicPresentationSurface({
    surfaceId: uuidv7(), kind: 'live', title: 'Visible title', scene: 'Visible scene',
    points: ['Later finding'], investigations: [], observations: [], assetIds: [uuidv7()],
    timelineKind: 'live', manual: false, at: '2026-10-02T09:00:00.000Z',
    notes: 'PRIVATE_FACILITATOR_NOTES', pathRationale: 'PRIVATE_ROUTE_REASON',
  }, 1);
  assert.equal(filtered.scene, 'Visible scene');
  assert.deepEqual(filtered.points, []);
  assert.deepEqual(filtered.assetIds, []);
  assert.ok(!JSON.stringify(filtered).includes('PRIVATE_'));
});

test('Card 23 manual segment replays one group reveal with only metadata in its journal', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'MANUAL_PUBLIC_SCENE';
  doc.surfaces[0].points = ['MANUAL_FUTURE_FINDING'];
  const r = room(doc);
  r.send('start');
  const segmentId = uuidv7();
  const at = '2026-10-02T09:05:00.000Z';
  const event = (type, epoch, extra = {}) => ({ type, epoch, actor: { role: 'facilitator', id: 'facilitator' }, at, clientEventId: uuidv7(), ...extra });
  const result = applySegment(r.state, [event('enter_manual', 0, { segmentId }), event('advance', 1)], new Map());
  assert.equal(result.ok, true);
  assert.equal(result.state.revealed[0].groupsShown, 2);
  assert.deepEqual(project(result.state, 'participant').liveSurface.points, ['MANUAL_FUTURE_FINDING']);
  const groupJournal = result.effects.filter((effect) => effect.kind === 'presentation_group_revealed');
  assert.equal(groupJournal.length, 1);
  assert.deepEqual(Object.keys(groupJournal[0].payload).sort(), ['groupIndex', 'occurrenceId', 'surfaceId']);
  assert.ok(isUuidV7(groupJournal[0].payload.occurrenceId));
  assert.equal(groupJournal[0].payload.occurrenceId, result.state.revealed[0].occurrenceId);
  assert.ok(!JSON.stringify(groupJournal).includes('MANUAL_FUTURE_FINDING'));
});

test('Card 23 legacy persisted entries retain their already-public text after presentation-version normalization', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'LEGACY_SCENE';
  doc.surfaces[0].points = ['LEGACY_ALREADY_PUBLIC_FINDING'];
  doc.surfaces[0].asset_ids = [uuidv7()];
  const r = room(doc);
  r.send('start');
  const legacy = structuredClone(r.state);
  delete legacy.presentationVersion;
  delete legacy.revealed[0].groupsShown;
  const recovered = normalizePresentationState(legacy);
  assert.equal(recovered.presentationVersion, 1);
  assert.equal(recovered.revealed[0].groupsShown, 2);
  for (const role of ['display', 'participant']) {
    const json = JSON.stringify(project(recovered, role));
    assert.ok(json.includes('LEGACY_ALREADY_PUBLIC_FINDING'));
    assert.ok(!json.includes(doc.surfaces[0].asset_ids[0]));
  }
});

test('Card 23 new-version missing progress fails closed and invalid counts cannot be loaded', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'NEW_SCENE';
  doc.surfaces[0].points = ['NEW_HIDDEN_FINDING'];
  const r = room(doc);
  r.send('start');
  assert.equal(r.state.presentationVersion, 1);
  const damaged = structuredClone(r.state);
  delete damaged.revealed[0].groupsShown;
  const recovered = normalizePresentationState(damaged);
  assert.equal(recovered.revealed[0].groupsShown, 0);
  assert.ok(!JSON.stringify(project(recovered, 'display')).includes('NEW_HIDDEN_FINDING'));
  const step = dispatch(recovered, { type: 'advance', epoch: recovered.epoch, actor: { role: 'facilitator', id: 'facilitator' }, at: '2026-10-02T09:30:00.000Z', clientEventId: uuidv7() }, new Map());
  assert.equal(step.state.revealed[0].groupsShown, 1);
  assert.equal(step.state.round, null);
  for (const value of [-1, 3, 1.5, '2']) {
    assert.throws(() => normalizePresentationState({ ...damaged, revealed: [{ ...damaged.revealed[0], groupsShown: value }] }), /invalid_presentation_progress/);
  }
});

test('Card 23 damaged prior progress cannot leak unrevealed observations through a later public trend', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'Earlier scene';
  doc.surfaces[0].observations = [{ label: 'Heart rate', value: '923456789012345678901234567890' }];
  doc.surfaces[0].points = [];
  doc.surfaces[1].scene = 'Current scene';
  doc.surfaces[1].observations = [{ label: 'Heart rate', value: '123' }];
  doc.surfaces[1].points = [];
  const r = room(doc);
  r.state.sessionId = uuidv7(0x029999999999);
  assert.equal(r.send('start'), 'accepted');
  assert.equal(r.send('advance'), 'accepted');
  assert.equal(r.send('advance'), 'accepted');
  assert.equal(r.send('advance'), 'accepted');
  assert.equal(r.state.revealed[0].groupsShown, 2);
  assert.equal(r.state.revealed[1].groupsShown, 2);

  const seen = project(r.state, 'display').surface.observations[0];
  assert.equal(seen.previous, '923456789012345678901234567890', 'valid earlier disclosure remains the trend baseline');

  const legacy = structuredClone(r.state);
  delete legacy.presentationVersion;
  delete legacy.revealed[0].groupsShown;
  const upgraded = normalizePresentationState(legacy);
  assert.equal(upgraded.revealed[0].groupsShown, 2);
  assert.equal(project(upgraded, 'display').surface.observations[0].previous, '923456789012345678901234567890',
    'the old unversioned room had already published this observation');

  const damaged = structuredClone(r.state);
  delete damaged.revealed[0].groupsShown;
  const recovered = normalizePresentationState(damaged);
  assert.equal(recovered.revealed[0].groupsShown, 0);
  for (const role of ['display', 'participant']) {
    const view = project(recovered, role);
    const publicSurface = role === 'display' ? view.surface : view.liveSurface;
    assert.deepEqual(publicSurface.observations[0], {
      label: 'Heart rate', value: '123', trend: null, previous: null,
    });
    assert.ok(!JSON.stringify(view).includes('923456789012345678901234567890'), `${role} disclosed a withheld previous value`);
  }
  const facilitator = project(recovered, 'facilitator');
  assert.deepEqual(facilitator.publicDisplaySurface.observations[0], {
    label: 'Heart rate', value: '123', trend: null, previous: null,
  });
});
