import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAction } from '../src/client/console-actions.mjs';

test('Card 23 served console names each pending shared group before entering context or opening responses', () => {
  const base = { phase: 'surface_live', actions: ['advance'], nextBeat: { kind: 'decision' } };
  assert.deepEqual(primaryAction({ ...base, presentation: { shown: 1, total: 2, nextGroup: 'findings' } }),
    { command: 'advance', label: 'Reveal findings' });
  assert.deepEqual(primaryAction({ ...base, presentation: { shown: 2, total: 2, nextGroup: null } }),
    { command: 'advance', label: 'Show decision context' });
  assert.deepEqual(primaryAction({ ...base, decision: { paths: [] }, presentation: { shown: 2, total: 2, nextGroup: null } }),
    { command: 'advance', label: 'Open responses' });
  assert.deepEqual(primaryAction({ phase: 'terminal_teaching', actions: ['reset_checkpoint', 'advance'],
    presentation: { shown: 1, total: 2, nextGroup: 'findings' } }),
    { command: 'advance', label: 'Reveal findings' });
});
