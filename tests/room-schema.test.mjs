// Exercises db/durable-object/room-schema.sql on Node's built-in SQLite, which uses the
// same engine family as SQLite-backed Durable Objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '../src/shared/ids.mjs';

const SCHEMA = readFileSync(new URL('../db/durable-object/room-schema.sql', import.meta.url), 'utf8');
const now = () => new Date().toISOString();

function room() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(SCHEMA); // idempotent: safe to re-run on every DO start
  return db;
}

test('journal is append-only and archive flag is the only mutable column', () => {
  const db = room();
  db.prepare('INSERT INTO journal (seq, event_id, epoch, kind, occurred_at) VALUES (1, ?, 0, ?, ?)')
    .run(uuidv7(), 'room_started', now());
  db.exec('UPDATE journal SET archived = 1 WHERE seq = 1');
  assert.throws(() => db.exec("UPDATE journal SET kind = 'x' WHERE seq = 1"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM journal'), /append-only/);
});

test('one open round at a time; one answer per participant per round', () => {
  const db = room();
  const d = uuidv7();
  const r1 = uuidv7();
  db.prepare("INSERT INTO rounds (id, decision_id, round_no, status, opened_at) VALUES (?, ?, 1, 'open', ?)").run(r1, d, now());
  assert.throws(() => db.prepare("INSERT INTO rounds (id, decision_id, round_no, status, opened_at) VALUES (?, ?, 2, 'open', ?)")
    .run(uuidv7(), d, now()), /UNIQUE/);

  const p = uuidv7();
  db.prepare('INSERT INTO participants (id, display_name, token_sha256, joined_at) VALUES (?, ?, ?, ?)').run(p, 'A', 'ab'.repeat(32), now());
  const upsert = db.prepare(`INSERT INTO responses (id, round_id, participant_id, response, last_client_event_id, first_submitted_at, last_submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (round_id, participant_id) DO UPDATE SET response = excluded.response,
      last_client_event_id = excluded.last_client_event_id, last_submitted_at = excluded.last_submitted_at, archived = 0`);
  const t = now();
  upsert.run(uuidv7(), r1, p, '{"option":"a"}', uuidv7(), t, t);
  upsert.run(uuidv7(), r1, p, '{"option":"b"}', uuidv7(), t, t);
  const rows = db.prepare('SELECT response FROM responses').all();
  assert.deepEqual(rows.map((r) => r.response), ['{"option":"b"}']);
});

test('STRICT tables reject wrong types and unknown enum values', () => {
  const db = room();
  assert.throws(() => db.prepare("INSERT INTO rounds (id, decision_id, round_no, status, opened_at) VALUES (?, ?, 'one', 'open', ?)")
    .run(uuidv7(), uuidv7(), now()));
  assert.throws(() => db.prepare("INSERT INTO rounds (id, decision_id, round_no, status, opened_at) VALUES (?, ?, 1, 'finished', ?)").run(uuidv7(), uuidv7(), now()), /CHECK/);
});

test('[RT] every round status and resolution kind the reducer can emit fits the DO schema', () => {
  const db = room();
  const d = uuidv7();
  let n = 1;
  for (const status of ['open', 'locked', 'resolved', 'abandoned', 'superseded']) {
    db.prepare('INSERT INTO rounds (id, decision_id, round_no, status, opened_at) VALUES (?, ?, ?, ?, ?)').run(uuidv7(), d, n++, status === 'open' ? 'open' : status, now());
    if (status === 'open') db.exec("UPDATE rounds SET status = 'locked' WHERE status = 'open'");
  }
  for (const kind of ['majority', 'minority', 'override']) {
    db.prepare("INSERT INTO rounds (id, decision_id, round_no, status, opened_at, resolution_kind) VALUES (?, ?, ?, 'resolved', ?, ?)").run(uuidv7(), d, n++, now(), kind);
  }
});

test('[RT] editing an archived row re-arms it for archiving', () => {
  const db = room();
  const p = uuidv7();
  db.prepare('INSERT INTO participants (id, display_name, token_sha256, joined_at, archived) VALUES (?, ?, ?, ?, 1)').run(p, 'A', 'cd'.repeat(32), now());
  db.prepare('UPDATE participants SET display_name = ? WHERE id = ?').run('B', p);
  assert.equal(db.prepare('SELECT archived FROM participants WHERE id = ?').get(p).archived, 0);
});
