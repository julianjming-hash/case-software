import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { migrateArchive, writeArchiveState, archiveBatch, acknowledgeBatch, archiveCounts,
  archiveLag, retryDelay, earliestAlarm } from '../src/worker/room-archive.mjs';

const schema = readFileSync(new URL('../db/durable-object/room-schema.sql', import.meta.url), 'utf8');
const now = 1_790_000_000_000;
const iso = new Date(now).toISOString();
function room(upgrade = true) {
  const db = new DatabaseSync(':memory:');
  db.exec(upgrade ? schema : schema.replace(/^\s+(?:row_version|pending_at)\s+INTEGER[^\n]*\n/gm, ''));
  const sql = { exec(query, ...args) {
    const statement = db.prepare(query);
    return { toArray: () => statement.all(...args) };
  } };
  if (upgrade) migrateArchive(sql);
  return { db, sql };
}
function sample() {
  const pid = uuidv7(), rid = uuidv7(), sessionId = uuidv7();
  return { sessionId, revision: 1, phase: 'responses_open', startedAt: iso,
    participants: { [pid]: { name: 'Sam', joinedAt: iso, removedAt: null } }, rounds: [],
    round: { id: rid, decisionId: uuidv7(), no: 1, status: 'open', openedAt: iso, lockedAt: null,
      responses: { [pid]: { id: uuidv7(), response: { text: 'A private answer' },
        clientEventId: uuidv7(), firstAt: iso, lastAt: iso } } } };
}
function write(sql, state, at = now) {
  for (const pid of Object.keys(state.participants)) sql.exec(
    'INSERT OR IGNORE INTO credentials(token_sha256,role,participant_id,issued_at) VALUES(?,?,?,?)',
    pid.replaceAll('-', '').padEnd(64, '0'), 'participant', pid, iso).toArray();
  writeArchiveState(sql, state, at);
}

test('archive schema upgrade is idempotent and preserves existing v1 rows', () => {
  const { db, sql } = room(false);
  const pid = uuidv7();
  db.prepare('INSERT INTO participants(id,display_name,token_sha256,joined_at) VALUES(?,?,?,?)').run(pid, 'Sam', 'a'.repeat(64), iso);
  migrateArchive(sql);
  migrateArchive(sql);
  const row = db.prepare('SELECT * FROM participants WHERE id=?').get(pid);
  assert.equal(row.display_name, 'Sam');
  assert.equal(row.row_version, 0);
  assert.equal(row.pending_at, 0);
});

test('outbox mirrors parsed private responses and keeps original response metadata after round closes', () => {
  const { sql } = room(), state = sample();
  write(sql, state);
  const response = archiveBatch(sql, state).batch.responses[0];
  assert.deepEqual(response.response, { text: 'A private answer' });
  const live = state.round;
  state.rounds.push({ ...live, responses: undefined, status: 'resolved', closedAt: iso,
    answers: Object.fromEntries(Object.entries(live.responses).map(([pid, value]) => [pid, value.response])) });
  state.round = null;
  write(sql, state);
  assert.deepEqual(archiveBatch(sql, state).batch.responses[0], response);
});

test('an in-flight acknowledgement cannot clear an edited row, and rename after send re-arms it', () => {
  const { sql } = room(), state = sample(), pid = Object.keys(state.participants)[0];
  write(sql, state);
  const first = archiveBatch(sql, state);
  state.participants[pid].name = 'Alex';
  write(sql, state, now + 1000);
  acknowledgeBatch(sql, first.marks);
  assert.equal(archiveCounts(sql).participants, 1);
  const second = archiveBatch(sql, state);
  assert.equal(second.batch.participants[0].display_name, 'Alex');
  acknowledgeBatch(sql, second.marks);
  assert.equal(archiveCounts(sql).participants, 0);
  state.participants[pid].name = 'Jordan';
  write(sql, state, now + 2000);
  assert.equal(archiveCounts(sql).participants, 1);
  assert.equal(archiveLag(sql, now + 3000), 1);
});

test('batches count all tables together, cap final UTF8 RPC bytes, and drain dependencies first', () => {
  const { sql } = room(), state = sample();
  state.round = null;
  state.participants = {};
  for (let i = 0; i < 250; i++) state.participants[uuidv7()] = { name: 'Sam', joinedAt: iso, removedAt: null };
  write(sql, state);
  let batch = archiveBatch(sql, state);
  assert.equal(batch.rows, 200);
  assert.ok(batch.bytes <= 256 * 1024);
  assert.equal(batch.bytes, new TextEncoder().encode(JSON.stringify({ p_session_id: state.sessionId, p_batch: batch.batch })).length);
  acknowledgeBatch(sql, batch.marks);
  batch = archiveBatch(sql, state);
  assert.equal(batch.rows, 50);
  acknowledgeBatch(sql, batch.marks);
  assert.equal(archiveLag(sql, now + 10_000), 0);
});

test('large multibyte answers split at the byte budget without dropping a row', () => {
  const { sql } = room(), state = sample(), pid = Object.keys(state.participants)[0];
  const first = state.round;
  first.responses[pid].response = { text: '😀'.repeat(25_000) };
  write(sql, state);
  acknowledgeBatch(sql, archiveBatch(sql, state).marks);
  state.rounds.push({ ...first, status: 'resolved', closedAt: iso, responses: undefined });
  state.round = { ...first, id: uuidv7(), no: 2,
    responses: { [pid]: { ...first.responses[pid], id: uuidv7() } } };
  write(sql, state);
  acknowledgeBatch(sql, archiveBatch(sql, state).marks);
  // Re-arm three ~100 KB response rows; the RPC envelope itself counts toward 256 KB.
  for (let i = 0; i < 3; i++) {
    const participantId = uuidv7();
    sql.exec('INSERT INTO participants(id,display_name,token_sha256,joined_at,archived) VALUES(?,?,?,?,1)',
      participantId, 'Sam', participantId.replaceAll('-', '').padEnd(64, '0'), iso).toArray();
    sql.exec('INSERT INTO responses(id,round_id,participant_id,response,last_client_event_id,first_submitted_at,last_submitted_at) VALUES(?,?,?,?,?,?,?)',
      uuidv7(), first.id, participantId, JSON.stringify({ text: '😀'.repeat(25_000) }), uuidv7(), iso, iso).toArray();
  }
  const batch = archiveBatch(sql, state);
  assert.equal(batch.rows, 2);
  assert.ok(batch.bytes <= 256 * 1024);
  acknowledgeBatch(sql, batch.marks);
  assert.equal(archiveCounts(sql).responses, 1);
});

test('archive lag is the oldest pending server timestamp and retry alarm never displaces lifecycle', () => {
  const { sql } = room(), state = sample();
  write(sql, state);
  assert.equal(archiveLag(sql, now + 3500), 3.5);
  assert.equal(earliestAlarm(now + 1000, now + 300_000), now + 1000);
  assert.equal(earliestAlarm(now + 300_000, now + 1000), now + 1000);
  assert.equal(retryDelay(0, () => 0), 1000);
  assert.ok(retryDelay(30, () => 1) <= 300_000);
  assert.ok(retryDelay(2, () => 0.5) > retryDelay(2, () => 0));
});

test('ended archive metadata is repeated unchanged and counts toward the complete UTF8 envelope', () => {
  const { sql } = room(), state = sample();
  write(sql, state);
  const boundary = { ended_at: iso, personal_data_delete_at: new Date(now + 86_400_000).toISOString() };
  const batch = archiveBatch(sql, state, iso, boundary);
  assert.equal(batch.batch.ended_at, boundary.ended_at);
  assert.equal(batch.batch.personal_data_delete_at, boundary.personal_data_delete_at);
  assert.equal(batch.bytes, new TextEncoder().encode(JSON.stringify({ p_session_id: state.sessionId, p_batch: batch.batch })).length);
  assert.ok(batch.bytes <= 256 * 1024);
});

test('live batch eligibility excludes personal rows without losing aggregates and journal', () => {
  const { sql } = room(), state = sample();
  write(sql, state);
  sql.exec('INSERT INTO journal(seq,event_id,epoch,kind,payload,occurred_at,pending_at) VALUES(?,?,?,?,?,?,?)',
    1, uuidv7(), 0, 'response_recorded', JSON.stringify({ roundId: state.round.id }), iso, now).toArray();
  const live = archiveBatch(sql, state, iso, null, false);
  assert.equal(live.batch.participants.length, 0);
  assert.equal(live.batch.responses.length, 0);
  assert.equal(live.batch.rounds.length, 1);
  assert.equal(live.batch.events.length, 1);
  acknowledgeBatch(sql, live.marks);
  assert.equal(archiveCounts(sql).participants, 1);
  assert.equal(archiveCounts(sql).responses, 1);
});

test('eligible archive lag ignores deferred personal rows and begins their clock at end', () => {
  const { sql } = room(), state = sample();
  write(sql, state);
  sql.exec('UPDATE rounds SET archived=1').toArray();
  assert.equal(archiveLag(sql, now + 3_600_000, false), 0);
  assert.equal(archiveLag(sql, now + 3_600_000, true, now + 3_599_000), 1);
});

test('Undo of a Lock closes the source round, so the ended room archives as finalisable', () => {
  // Before the fix the source round stayed in history as locked with no closedAt; finalize_session_portfolio
  // (20261019000000_session_portfolio.sql) refuses any archived round that is open, locked or unclosed.
  const { sql } = room(), { doc } = miniCase(), FAC = { role: 'facilitator', id: 'facilitator' }, pid = uuidv7();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc }), t = now;
  const ledger = new Map();
  const go = (type, payload = {}, actor = FAC) => {
    const at = new Date(t += 1000).toISOString();
    const r = dispatch(state, { type, epoch: state.epoch, actor, at, clientEventId: uuidv7(), roundId: uuidv7(), ...payload }, ledger);
    assert.equal(r.effects.find((e) => e.type === 'receipt').receipt, 'accepted', type);
    state = r.state;
    write(sql, state, Date.parse(at));
  };
  go('join', { displayName: 'Sam' }, { role: 'participant', id: pid });
  go('start'); go('advance'); go('advance');
  const decision = doc.decisions.find((d) => d.id === state.round.decisionId);
  go('vote', { roundId: state.round.id, responseId: uuidv7(), response: { option_id: decision.interaction.options[0].id } }, { role: 'participant', id: pid });
  go('lock');
  const sourceId = state.round.id;
  go('undo', { targetEventId: project(state, 'facilitator').undo.targetEventId, expectRevision: state.revision,
    sourceRound: structuredClone(state.round), seedResponseIds: { [pid]: uuidv7() } });
  assert.equal(state.round.seedSourceRoundId, sourceId);
  assert.equal(state.round.status, 'open');
  assert.deepEqual(state.rounds.map((r) => [r.id, r.status, r.closedAt]), [[sourceId, 'superseded', state.round.openedAt]]);
  go('end');
  const rounds = archiveBatch(sql, state).batch.rounds;
  assert.deepEqual(rounds.map((r) => r.status).sort(), ['abandoned', 'superseded']);
  assert.ok(rounds.every((r) => !['open', 'locked'].includes(r.status) && r.closed_at !== null), 'every archived round is closed');
});
