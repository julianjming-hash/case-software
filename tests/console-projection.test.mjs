import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, project } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { acceptLocalFrame } from '../src/client/projector-view.mjs';
import { projectorFrame, publishProjectorFrame } from '../src/client/console-projection.mjs';

test('Card 12 same-PC console sends only a room-bound public display projection', () => {
  const { doc, s } = miniCase();
  doc.surfaces[0].notes = 'PRIVATE-PRESENTER-NOTE';
  doc.beats[0].cue = 'PRIVATE-PRESENTER-CUE';
  const state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  state.phase = 'surface_live'; state.liveSurfaceId = s.open;
  state.revealed = [{ surfaceId: s.open, variant: -1, kind: 'live', manual: false,
    at: '2026-10-02T00:00:00Z' }];
  const { caseDoc, ...mirror } = state;
  const snapshot = { t: 'snapshot', epoch: state.epoch, revision: state.revision,
    displayRevision: state.display.revision, view: project(state, 'facilitator'), mirror };
  const frame = projectorFrame(snapshot, caseDoc);
  assert.ok(frame, 'a valid public projector frame is required');
  assert.deepEqual(acceptLocalFrame(frame, state.sessionId), frame);
  assert.equal(frame.view.phase, 'live');
  const sent = JSON.stringify(frame);
  for (const privateValue of ['PRIVATE-PRESENTER-NOTE', 'PRIVATE-PRESENTER-CUE',
    'caseDoc', 'mirror', 'rationale', 'facilitatorToken']) assert.equal(sent.includes(privateValue), false);
  assert.equal(projectorFrame({ ...snapshot, view: { ...snapshot.view, sessionId: uuidv7() } }, caseDoc), null);
  assert.equal(projectorFrame({ ...snapshot, epoch: state.epoch + 1 }, caseDoc), null);
});

test('terminal public publication is validated and channel failure does not escape', () => {
  const { doc } = miniCase();
  const state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  state.phase = 'ended';
  const { caseDoc, ...mirror } = state;
  const snapshot = { t: 'snapshot', epoch: state.epoch, revision: state.revision,
    displayRevision: state.display.revision, view: project(state, 'facilitator'), mirror };
  const frame = projectorFrame(snapshot, caseDoc);
  assert.equal(frame.view.phase, 'ended');
  const sent = [];
  const channel = { postMessage: value => sent.push(value) };
  assert.equal(publishProjectorFrame(channel, frame, state.sessionId), true);
  assert.deepEqual(sent, [frame]);
  assert.equal(publishProjectorFrame(channel, { ...frame, mirror }, state.sessionId), false);
  assert.equal(publishProjectorFrame(channel, frame, uuidv7()), false);
  assert.equal(sent.length, 1);
  assert.equal(publishProjectorFrame({ postMessage() { throw new Error('closed'); } },
    frame, state.sessionId), false);
});
