import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimulatedRooms } from '../scripts/simulated-rooms.mjs';

test('local diagnostics survive a failed room without serializing the failed payload and still stop the Worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'case-load-evidence-')); let stopped = 0;
  try {
    await assert.rejects(runSimulatedRooms({ rooms: 1, clients: 25, stagger: 0, target: { kind: 'local', origin: null }, own: false }, {
      environment: { CASE_WORKER_LOG_DIR: directory, CASE_LOAD_AUTH_TOKEN: 'PRIVATE_CAPABILITY' },
      startLocal: async () => ({ origin: 'http://127.0.0.1:1', stop: async () => { stopped++; } }),
      createLocalRoom: async () => { throw Error('PRIVATE_FAILURE'); },
    }), /load_room_failed/);
    assert.equal(stopped, 1);
    const raw = readFileSync(join(directory, 'simulated-1-0.json'), 'utf8');
    const evidence = JSON.parse(raw); assert.equal(evidence.room_index, 0); assert.equal(evidence.clients, 25);
    assert.deepEqual(evidence.votes, []); assert.match(evidence.node, /^\d+\.\d+\.\d+$/);
    assert.doesNotMatch(raw, /PRIVATE|CAPABILITY|FAILURE|token|body/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a diagnostic write failure cannot prevent room cleanup or hide the original failed gate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'case-load-evidence-')); const file = join(directory, 'file'); writeFileSync(file, 'not a directory');
  let stopped = 0; const messages = []; const original = console.error;
  try {
    console.error = (...args) => messages.push(args);
    await assert.rejects(runSimulatedRooms({ rooms: 1, clients: 25, stagger: 0, target: { kind: 'local', origin: null }, own: false }, {
      environment: { CASE_WORKER_LOG_DIR: file },
      startLocal: async () => ({ origin: 'http://127.0.0.1:1', stop: async () => { stopped++; } }),
      createLocalRoom: async () => { throw Error('original_room_failure'); },
    }), /original_room_failure/);
    assert.equal(stopped, 1); assert.equal(messages.length, 1); assert.equal(messages[0][0], 'load_diagnostic_write_failed');
    assert.deepEqual(JSON.parse(messages[0][1]), { room_index: 0, votes: [] });
  } finally { console.error = original; rmSync(directory, { recursive: true, force: true }); }
});
