// CASE-169: the incremental archive outbox write leaves exactly the rows the full rescan left, after
// any sequence of room changes, acknowledgements, rolled-back transactions and cold restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { migrateArchive, writeArchiveState, ArchiveWriteCache, archiveBatch, acknowledgeBatch } from '../src/worker/room-archive.mjs';

const schema = readFileSync(new URL('../db/durable-object/room-schema.sql', import.meta.url), 'utf8');
const TABLES = ['participants', 'rounds', 'responses', 'journal', 'credentials'];

function room() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const sql = { statements: 0, exec(query, ...args) {
    this.statements++;
    const statement = db.prepare(query);
    return { toArray: () => statement.all(...args) };
  } };
  migrateArchive(sql);
  return { db, sql };
}
const dump = db => Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));

// The pre-CASE-169 write, kept verbatim as the oracle: every participant's credential is re-read and
// every participant, round and live response is re-upserted on every write.
function upsert(sql, table, value, at) {
  const fields = Object.keys(value), mutable = fields.filter(field => field !== 'id');
  const updates = mutable.map(field => `${field}=excluded.${field}`).join(',');
  const changed = mutable.map(field => `${table}.${field} IS NOT excluded.${field}`).join(' OR ');
  sql.exec(`INSERT INTO ${table} (${fields.join(',')},pending_at,row_version) VALUES (${fields.map(() => '?').join(',')},?,1)
    ON CONFLICT(id) DO UPDATE SET ${updates},archived=0,row_version=${table}.row_version+1,
    pending_at=CASE WHEN ${table}.archived=1 OR ${table}.pending_at=0 THEN excluded.pending_at ELSE ${table}.pending_at END
    WHERE ${changed}`, ...Object.values(value), at).toArray();
}
function fullRescan(sql, state, at) {
  for (const [id, participant] of Object.entries(state.participants)) {
    const credential = sql.exec("SELECT token_sha256 FROM credentials WHERE participant_id=? AND role='participant' ORDER BY issued_at,token_sha256 LIMIT 1", id).toArray()[0];
    if (!credential) continue;
    upsert(sql, 'participants', { id, display_name: participant.name, token_sha256: credential.token_sha256,
      joined_at: participant.joinedAt, removed_at: participant.removedAt ?? null }, at);
  }
  for (const round of [...state.rounds, ...(state.round ? [state.round] : [])]) {
    upsert(sql, 'rounds', { id: round.id, decision_id: round.decisionId, round_no: round.no,
      status: round.status, opened_at: round.openedAt, locked_at: round.lockedAt ?? null,
      closed_at: round.closedAt ?? null, aggregate: round.aggregate ? JSON.stringify(round.aggregate) : null,
      selected_path_id: round.selectedPathId ?? null, resolution_kind: round.resolutionKind ?? null }, at);
    for (const [participantId, response] of Object.entries(round.responses ?? {})) {
      upsert(sql, 'responses', { id: response.id, round_id: round.id, participant_id: participantId,
        response: JSON.stringify(response.response), last_client_event_id: response.clientEventId,
        first_submitted_at: response.firstAt, last_submitted_at: response.lastAt }, at);
    }
  }
}

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

/** One random room history. Each step mutates a structuredClone of the state, as the reducer does. */
function* history(seed, steps) {
  const random = rng(seed), pick = list => list[Math.floor(random() * list.length)];
  let clock = Date.UTC(2026, 9, 6), state = { participants: {}, rounds: [], round: null, phase: 'lobby' };
  const iso = () => new Date(clock += 1 + Math.floor(random() * 3)).toISOString();
  const credentials = [], credentialed = new Set();
  let pending = null;
  const option = () => ({ option_id: pick(['a', 'b', 'c']) });
  for (let step = 0; step < steps; step++) {
    const s = structuredClone(state), live = () => Object.keys(s.participants).filter(id => !s.participants[id].removedAt);
    const kind = pick(['join', 'join', 'join_pending', 'vote', 'vote', 'vote', 'revote', 'lock', 'void', 'reveal',
      'open', 'reconnect', 'reconnect_tie', 'evict', 'rename', 'aggregate', 'ack', 'rollback', 'cold', 'noop']);
    let event = { kind };
    // A participant that joined without a credential gets it one step later.
    if (pending) { event.pendingCredential = { ...pending, at: iso() }; credentialed.add(pending.pid); pending = null; }
    if (kind === 'join' || kind === 'join_pending') {
      const id = uuidv7();
      s.participants[id] = { name: `P${step}`, joinedAt: iso(), removedAt: null };
      // join_pending: the participant reaches state before its credential (the write skips it, then
      // must pick it up once the credential exists).
      if (kind === 'join') { credentials.push({ sha: random().toString(16).slice(2).padEnd(64, '0'), pid: id, at: s.participants[id].joinedAt }); credentialed.add(id); }
      else pending = { sha: random().toString(16).slice(2).padEnd(64, '1'), pid: id };
    } else if (kind === 'open' || (!s.round && ['vote', 'revote', 'lock', 'void', 'reveal', 'aggregate'].includes(kind))) {
      if (s.round) s.rounds.push({ ...s.round, status: 'superseded', closedAt: iso() });
      s.round = { id: uuidv7(), decisionId: uuidv7(), no: s.rounds.length + 1, status: 'open', openedAt: iso(), lockedAt: null, responses: {}, aggregate: null };
      s.phase = 'responses_open';
    } else if (kind === 'vote' || kind === 'revote') {
      const voters = kind === 'vote' ? live().filter(id => credentialed.has(id) && !s.round.responses[id]) : Object.keys(s.round.responses);
      const id = voters.length ? pick(voters) : null;
      if (id && s.round.status === 'open') {
        const at = iso(), prior = s.round.responses[id];
        s.round.responses[id] = { id: prior?.id ?? uuidv7(), response: option(), clientEventId: uuidv7(), firstAt: prior?.firstAt ?? at, lastAt: at };
      }
    } else if (kind === 'lock') {
      if (s.round.status === 'open') { s.round.status = 'locked'; s.round.lockedAt = iso(); }
    } else if (kind === 'aggregate') {
      s.round.aggregate = { counts: { a: random(), b: random() } };
    } else if (kind === 'void' || kind === 'reveal') {
      // A closed round keeps only its summary, as the reducer's resolved/superseded rounds do.
      const { responses, ...closed } = s.round;
      s.rounds.push({ ...closed, status: kind === 'void' ? 'superseded' : 'resolved', closedAt: iso(),
        selectedPathId: kind === 'reveal' ? uuidv7() : null, resolutionKind: kind === 'reveal' ? pick(['majority', 'minority', 'override']) : null,
        answers: Object.fromEntries(Object.entries(responses).map(([pid, value]) => [pid, value.response])) });
      s.round = null; s.phase = 'surface_live';
    } else if (kind === 'reconnect' || kind === 'reconnect_tie') {
      const id = live().length ? pick(live()) : null;
      const first = credentials.find(c => c.pid === id);
      // reconnect_tie: a second credential issued in the same millisecond that sorts first, so the
      // archived token changes; a plain reconnect's later credential leaves it alone.
      if (id && first) event.credential = kind === 'reconnect' ? { sha: random().toString(16).slice(2).padEnd(64, '2'), pid: id, at: iso() }
        : { sha: '0'.repeat(64 - String(step).length) + step, pid: id, at: first.at };
    } else if (kind === 'evict') {
      const id = live().length ? pick(live()) : null;
      if (id) s.participants[id].removedAt = iso();
    } else if (kind === 'rename') {
      const id = live().length ? pick(live()) : null;
      if (id) s.participants[id].name = `R${step}`;
    }
    state = s;
    yield { state, event, credentials, at: clock + step };
  }
}

function insertCredential(sql, { sha, pid, at }) {
  sql.exec('INSERT INTO credentials(token_sha256,role,participant_id,issued_at) VALUES(?,?,?,?)', sha, 'participant', pid, at).toArray();
}

function replay(seed, steps, { checkEachStep = true } = {}) {
  const oracle = room(), subject = room();
  let cache = new ArchiveWriteCache();
  const seen = new Set();
  for (const { state, event, credentials, at } of history(seed, steps)) {
    for (const credential of credentials) if (!seen.has(credential.sha)) {
      seen.add(credential.sha);
      for (const db of [oracle, subject]) insertCredential(db.sql, credential);
      cache.credentialIssued(credential.pid);
    }
    if (event.credential) {
      seen.add(event.credential.sha);
      for (const db of [oracle, subject]) insertCredential(db.sql, event.credential);
      cache.credentialIssued(event.credential.pid);
    }
    if (event.pendingCredential) {
      for (const db of [oracle, subject]) insertCredential(db.sql, event.pendingCredential);
      cache.credentialIssued(event.pendingCredential.pid);
    }
    if (event.kind === 'rollback') {
      // A transaction that writes and then aborts: the subject's cache must not keep what rolled back.
      // cache.transact is what RoomDO#mutate wraps around its storage transaction.
      for (const db of [oracle, subject]) db.db.exec('BEGIN');
      fullRescan(oracle.sql, state, at);
      assert.throws(() => cache.transact(() => {
        writeArchiveState(subject.sql, state, at, cache);
        throw new Error('injected_statement_failure');
      }), /injected_statement_failure/);
      for (const db of [oracle, subject]) db.db.exec('ROLLBACK');
      continue;
    }
    if (event.kind === 'cold') cache = new ArchiveWriteCache();
    fullRescan(oracle.sql, state, at);
    cache.transact(() => writeArchiveState(subject.sql, state, at, cache));
    if (event.kind === 'ack') {
      const sentOracle = archiveBatch(oracle.sql, state), sentSubject = archiveBatch(subject.sql, state);
      assert.deepEqual(sentSubject, sentOracle);
      acknowledgeBatch(oracle.sql, sentOracle.marks);
      acknowledgeBatch(subject.sql, sentSubject.marks);
    }
    if (checkEachStep) assert.deepEqual(dump(subject.db), dump(oracle.db), `seed ${seed}: diverged after ${event.kind}`);
  }
  assert.deepEqual(dump(subject.db), dump(oracle.db), `seed ${seed}: final state diverged`);
  assert.deepEqual(archiveBatch(subject.sql, { phase: 'live' }), archiveBatch(oracle.sql, { phase: 'live' }));
}

test('CASE-169 incremental archive write equals the full rescan over random room histories', () => {
  for (let seed = 1; seed <= 60; seed++) replay(seed, 100);
});

test('CASE-169 a long history stays equal to the full rescan', () => {
  replay(9001, 500, { checkEachStep: false });
});

test('CASE-169 a write without a cache is the full rescan (cold path)', () => {
  const oracle = room(), subject = room();
  for (const { state, event, credentials, at } of history(77, 200)) {
    const issued = [...credentials, ...[event.credential, event.pendingCredential].filter(Boolean)];
    for (const db of [oracle, subject]) for (const c of issued)
      db.sql.exec('INSERT OR IGNORE INTO credentials(token_sha256,role,participant_id,issued_at) VALUES(?,?,?,?)', c.sha, 'participant', c.pid, c.at).toArray();
    fullRescan(oracle.sql, state, at);
    writeArchiveState(subject.sql, state, at);
  }
  assert.deepEqual(dump(subject.db), dump(oracle.db));
});
