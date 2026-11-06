import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderAutosave } from '../src/client/builder-autosave.mjs';

function clock() {
  let time = 0, id = 0; const tasks = new Map();
  return { now: () => time, setTimeout(fn, wait) { tasks.set(++id, { fn, at: time + wait }); return id; }, clearTimeout(key) { tasks.delete(key); },
    async tick(ms) { time += ms; for (const [key, task] of tasks) if (task.at <= time) { tasks.delete(key); await task.fn(); } }, get pending() { return tasks.size; } };
}
test('autosave waits for idle writing and throttles edits made during an acknowledged save', async () => {
  const scheduler = clock(); let state = { dirty: true, status: 'dirty', localGeneration: 1 }, calls = 0;
  const auto = createBuilderAutosave({ scheduler, getSnapshot: () => state, save: async () => {
    calls++; if (calls === 1) { state = { ...state, status: 'saving', localGeneration: 3 }; auto.changed(); state.status = 'dirty'; }
    else state = { ...state, status: 'saved', dirty: false };
  } });
  auto.changed(); await scheduler.tick(1000); state.localGeneration++; auto.changed(); await scheduler.tick(1499); assert.equal(calls, 0);
  await scheduler.tick(1); assert.equal(calls, 1);
  await scheduler.tick(9999); assert.equal(calls, 1); await scheduler.tick(1); assert.equal(calls, 2); assert.equal(scheduler.pending, 0);
});
test('autosave does not repeat refused writing, uncertain operations or conflicts, and retires timers', async () => {
  const scheduler = clock(); let state = { dirty: true, status: 'dirty', localGeneration: 1 }, calls = 0;
  const auto = createBuilderAutosave({ scheduler, getSnapshot: () => state, save: async () => { calls++; } });
  auto.changed(); await scheduler.tick(1500); auto.changed(); await scheduler.tick(30000); assert.equal(calls, 1);
  for (const status of ['uncertain', 'conflict', 'conflict_read_failed', 'saving']) {
    state = { ...state, status, localGeneration: state.localGeneration + 1 }; auto.changed(); await scheduler.tick(30000);
  }
  assert.equal(calls, 1); state.status = 'dirty'; auto.changed(); assert.equal(scheduler.pending, 1);
  auto.close(); await scheduler.tick(30000); assert.equal(calls, 1);
});
