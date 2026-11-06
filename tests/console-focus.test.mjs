import test from 'node:test';
import assert from 'node:assert/strict';
import { focusAfterConsoleUpdate } from '../src/client/console-focus.mjs';

test('Card 12 background updates defer replacement while a room input is being edited', () => {
  assert.deepEqual(focusAfterConsoleUpdate({ activeTag: 'INPUT', phase: 'lobby', nextPhase: 'lobby',
    tab: 'room', nextTab: 'room', focusKey: 'display-code' }), { kind: 'defer' });
  assert.deepEqual(focusAfterConsoleUpdate({ activeTag: 'SELECT', phase: 'responses_open', nextPhase: 'responses_open',
    tab: 'room', nextTab: 'room', focusKey: 'round-timer' }), { kind: 'defer' });
});

test('Card 12 phase changes move focus to the heading and stable controls retain focus otherwise', () => {
  assert.deepEqual(focusAfterConsoleUpdate({ activeTag: 'BUTTON', phase: 'lobby', nextPhase: 'surface_live',
    tab: 'run', nextTab: 'run', focusKey: 'start-case' }), { kind: 'heading' });
  assert.deepEqual(focusAfterConsoleUpdate({ activeTag: 'BUTTON', phase: 'surface_live', nextPhase: 'surface_live',
    tab: 'room', nextTab: 'room', focusKey: 'approve-display' }), { kind: 'key', key: 'approve-display' });
  assert.deepEqual(focusAfterConsoleUpdate({ activeTag: 'BUTTON', phase: 'surface_live', nextPhase: 'surface_live',
    tab: 'room', nextTab: 'run', focusKey: 'tab-room' }), { kind: 'key', key: 'tab-run' });
});
