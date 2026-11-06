import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentationNav, publicTimelineEntry, consolePublicSurface } from '../src/client/presentation-nav.mjs';

test('Card 23 presentation navigation names every public row including repeated surfaces and returns from terminal replay explicitly', () => {
  const timeline = [
    { surfaceId: 'a', title: 'Opening' },
    { surfaceId: 'b', title: 'Terminal teaching' },
    { surfaceId: 'b', title: 'Checkpoint return' },
  ];
  const terminal = presentationNav({ timeline, display: { cursor: null }, actions: ['replay'] });
  assert.deepEqual(terminal.rows.map(({ entryIndex, selected }) => [entryIndex, selected]), [[0, false], [1, false], [2, true]]);
  assert.equal(terminal.backTarget, 1);
  const old = presentationNav({ timeline, display: { cursor: 1 }, actions: ['replay'] });
  assert.equal(old.replaying, true);
  assert.equal(old.rows[1].selected, true);
  assert.equal(old.forwardTarget, null, 'the next step from the earlier duplicate returns Live');
  assert.equal(old.liveTarget, null);
  assert.equal(old.backTarget, 0);
});

test('Card 23 next presentation action labels the pending group and never turns a key press into a clinical decision', () => {
  const base = { timeline: [{ title: 'Scene' }], display: { cursor: null }, actions: ['advance'], phase: 'surface_live', nextBeat: { kind: 'decision' } };
  assert.equal(presentationNav({ ...base, presentation: { shown: 1, total: 2, nextGroup: 'findings' } }).nextActionLabel, 'Reveal findings');
  assert.equal(presentationNav({ ...base, presentation: { shown: 2, total: 2, nextGroup: null } }).nextActionLabel, 'Show decision context');
  assert.equal(presentationNav({ ...base, decision: { decisionId: 'd' }, presentation: { shown: 2, total: 2, nextGroup: null } }).nextActionLabel, 'Open responses');
  assert.equal(presentationNav({ ...base, actions: [], presentation: { shown: 2, total: 2, nextGroup: null } }).nextActionLabel, null);
});

test('Card 23 phone timeline picks the exact earlier entry when a checkpoint republishes the same surface', () => {
  const timeline = [
    { surfaceId: 'same', at: 'old', title: 'Earlier state' },
    { surfaceId: 'same', at: 'new', title: 'Returned state' },
  ];
  assert.deepEqual(publicTimelineEntry(timeline, 0), { entry: timeline[0], browsing: true });
  assert.deepEqual(publicTimelineEntry(timeline, 1), { entry: timeline[1], browsing: false });
  assert.deepEqual(publicTimelineEntry(timeline, -1), { entry: timeline[1], browsing: false });
  assert.deepEqual(publicTimelineEntry(timeline, 2), { entry: timeline[1], browsing: false });
});

test('Card 23 served console labels only the public timeline row as room-visible while retaining private notes separately', () => {
  const full = { surfaceId: 'a', at: 'same-entry', scene: 'Shared scene', points: ['WITHHELD_FINDING'],
    observations: [], investigations: [], assetIds: [], notes: 'PRIVATE_NOTE' };
  const publicDisplaySurface = { ...full, points: [], notes: undefined };
  const view = { presentation: { entryIndex: 0, shown: 1, total: 2 },
    timeline: [full], liveSurface: full, publicDisplaySurface };
  const visible = consolePublicSurface(view);
  assert.equal(visible.scene, 'Shared scene');
  assert.deepEqual(visible.points, []);
  assert.equal(Object.hasOwn(visible, 'notes'), false);
  assert.equal(consolePublicSurface({ ...view, timeline: [] }), null, 'missing public projection never falls back to full case text');
  assert.equal(consolePublicSurface({ ...view, publicDisplaySurface: null }), null, 'full private row is never a fallback');
});
