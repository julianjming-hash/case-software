// Durable SQLite evidence/outbox: network and lifecycle scheduling belong to RoomDO.
export const ARCHIVE_SCHEMA_VERSION = '4';
const TABLES = ['participants', 'rounds', 'responses', 'journal'];
const KEYS = { participants: 'id', rounds: 'id', responses: 'id', journal: 'seq' };
const GROUPS = { participants: 'participants', rounds: 'rounds', responses: 'responses', journal: 'events' };
const MAX_ROWS = 200;
const MAX_BYTES = 256 * 1024;
const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();

/** V1 → V4 upgrades are additive; legacy reconstruction policy is handled separately. */
export function migrateArchive(sql) {
  for (const table of TABLES) {
    const columns = new Set(rows(sql, `PRAGMA table_info(${table})`).map(row => row.name));
    if (!columns.has('pending_at')) rows(sql, `ALTER TABLE ${table} ADD COLUMN pending_at INTEGER NOT NULL DEFAULT 0`);
    if (table !== 'journal' && !columns.has('row_version')) rows(sql, `ALTER TABLE ${table} ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0`);
  }
  const responseColumns = new Set(rows(sql, 'PRAGMA table_info(responses)').map(row => row.name));
  for (const name of ['source_response_id', 'source_round_id', 'source_client_event_id', 'correction_event_id', 'seeded_at']) {
    if (!responseColumns.has(name)) rows(sql, `ALTER TABLE responses ADD COLUMN ${name} TEXT`);
  }
  rows(sql, 'CREATE TABLE IF NOT EXISTS response_evidence_keys (round_id TEXT NOT NULL, participant_id TEXT NOT NULL, response_id TEXT NOT NULL, PRIMARY KEY(round_id,participant_id)) STRICT');
  rows(sql, 'INSERT OR IGNORE INTO response_evidence_keys SELECT round_id,participant_id,id FROM responses');
}

function upsert(sql, table, value, at) {
  const fields = Object.keys(value), mutable = fields.filter(field => field !== 'id');
  const updates = mutable.map(field => `${field}=excluded.${field}`).join(',');
  const changed = mutable.map(field => `${table}.${field} IS NOT excluded.${field}`).join(' OR ');
  rows(sql, `INSERT INTO ${table} (${fields.join(',')},pending_at,row_version) VALUES (${fields.map(() => '?').join(',')},?,1)
    ON CONFLICT(id) DO UPDATE SET ${updates},archived=0,row_version=${table}.row_version+1,
    pending_at=CASE WHEN ${table}.archived=1 OR ${table}.pending_at=0 THEN excluded.pending_at ELSE ${table}.pending_at END
    WHERE ${changed}`, ...Object.values(value), at);
}

/**
 * What this Durable Object last wrote to the outbox (CASE-169). An upsert whose values equal the row's
 * current values is a no-op (its WHERE finds nothing changed), so a row whose values match the last
 * committed write can be skipped without changing any row, version or pending time. Entries come only
 * from writes this instance made and committed; a fresh instance starts empty and rescans once.
 */
export class ArchiveWriteCache {
  #rows = new Map(); #tokens = new Map(); #stagedRows = new Map(); #stagedTokens = new Map();
  /** A participant's earliest credential can change when one is issued: forget it, staged or not. */
  credentialIssued(participantId) { this.#tokens.delete(participantId); this.#stagedTokens.delete(participantId); }
  token(participantId) { return this.#stagedTokens.get(participantId) ?? this.#tokens.get(participantId); }
  stageToken(participantId, token) { this.#stagedTokens.set(participantId, token); }
  unchanged(key, values) { return (this.#stagedRows.get(key) ?? this.#rows.get(key)) === values; }
  stageRow(key, values) { this.#stagedRows.set(key, values); }
  /** The transaction committed: what it wrote is now what the rows hold. */
  commit() {
    for (const [key, values] of this.#stagedRows) this.#rows.set(key, values);
    for (const [id, token] of this.#stagedTokens) this.#tokens.set(id, token);
    this.discard();
  }
  /** The transaction rolled back: forget what it wrote. */
  discard() { this.#stagedRows.clear(); this.#stagedTokens.clear(); }
  /**
   * Run one storage transaction (`run` wraps `transactionSync`): keep its staged writes only if it
   * commits. A rolled-back write left in the cache would make an identical retry look unchanged and
   * skip it: silent archive loss.
   */
  transact(run) {
    let result;
    try { result = run(); }
    catch (error) { this.discard(); throw error; }
    this.commit();
    return result;
  }
}

/**
 * Called in the state/journal/credential transaction; only changed rows are re-armed. With a cache,
 * only rows whose values differ from the last committed write reach SQL, so a vote costs O(1)
 * statements in the number of participants; without one, every row is upserted (the full rescan).
 */
export function writeArchiveState(sql, state, at, cache = null) {
  const write = (table, value) => {
    const key = `${table}:${value.id}`, values = cache && JSON.stringify(Object.values(value));
    if (cache?.unchanged(key, values)) return;
    if (table === 'responses') rows(sql, 'INSERT OR IGNORE INTO response_evidence_keys VALUES(?,?,?)', value.round_id, value.participant_id, value.id);
    upsert(sql, table, value, at);
    cache?.stageRow(key, values);
  };
  for (const [id, participant] of Object.entries(state.participants)) {
    let token = cache?.token(id);
    if (token === undefined) {
      token = rows(sql, "SELECT token_sha256 FROM credentials WHERE participant_id=? AND role='participant' ORDER BY issued_at,token_sha256 LIMIT 1", id)[0]?.token_sha256;
      if (!token) continue;
      cache?.stageToken(id, token);
    }
    write('participants', { id, display_name: participant.name, token_sha256: token,
      joined_at: participant.joinedAt, removed_at: participant.removedAt ?? null });
  }
  // Close/supersede old rounds before inserting a new open round (unique partial index).
  for (const round of [...state.rounds, ...(state.round ? [state.round] : [])]) {
    // Compact controls refer to existing evidence. Absent historical aggregate is not SQL NULL.
    if (round.evidenceRef === 1) continue;
    write('rounds', { id: round.id, decision_id: round.decisionId, round_no: round.no,
      status: round.status, opened_at: round.openedAt, locked_at: round.lockedAt ?? null,
      closed_at: round.closedAt ?? null, aggregate: round.aggregate ? JSON.stringify(round.aggregate) : null,
      selected_path_id: round.selectedPathId ?? null, resolution_kind: round.resolutionKind ?? null });
    for (const [participantId, response] of Object.entries(round.responses ?? {})) {
      write('responses', { id: response.id, round_id: round.id, participant_id: participantId,
        response: JSON.stringify(response.response), last_client_event_id: response.clientEventId,
        first_submitted_at: response.firstAt, last_submitted_at: response.lastAt,
        source_response_id: response.seed?.sourceResponseId ?? null,
        source_round_id: response.seed?.sourceRoundId ?? null,
        source_client_event_id: response.seed?.sourceClientEventId ?? null,
        correction_event_id: response.seed?.correctionEventId ?? null,
        seeded_at: response.seed?.seededAt ?? null });
    }
  }
}

export function archiveCounts(sql, personalEligible = true) {
  return Object.fromEntries(TABLES.filter(table => personalEligible || !['participants', 'responses'].includes(table)).map(table => [table, rows(sql, `SELECT count(*) AS n FROM ${table} WHERE archived=0`)[0].n]));
}

/** Includes the entire RPC envelope in the byte cap. Ordered dependencies are sent first. */
export function archiveBatch(sql, state, startedAt = null, boundary = null, personalEligible = true) {
  const batch = { status: state.phase === 'lobby' ? 'lobby' : 'live',
    ...(startedAt ? { started_at: startedAt } : {}), ...(boundary ?? {}), participants: [], rounds: [], responses: [], events: [] };
  const marks = [];
  const size = () => new TextEncoder().encode(JSON.stringify({ p_session_id: state.sessionId, p_batch: batch })).length;
  for (const table of TABLES) {
    if (!personalEligible && ['participants', 'responses'].includes(table)) continue;
    const sourceReady = table === 'responses' ? ' AND (source_response_id IS NULL OR EXISTS (SELECT 1 FROM responses source WHERE source.id=responses.source_response_id AND source.archived=1))' : '';
    for (const row of rows(sql, `SELECT * FROM ${table} WHERE archived=0${sourceReady} ORDER BY ${KEYS[table]} LIMIT ?`, MAX_ROWS - marks.length)) {
      const { archived: _sent, row_version: version, pending_at: _pending, ...value } = row;
      if (table === 'rounds') value.aggregate = value.aggregate === null ? null : JSON.parse(value.aggregate);
      if (table === 'responses') value.response = JSON.parse(value.response);
      if (table === 'journal') value.payload = JSON.parse(value.payload);
      const group = batch[GROUPS[table]];
      group.push(value);
      if (size() > MAX_BYTES) {
        group.pop();
        if (!marks.length) throw new Error('Archive row exceeds batch budget');
        return { batch, marks, rows: marks.length, bytes: size() };
      }
      marks.push({ table, key: row[KEYS[table]], version });
      if (marks.length === MAX_ROWS) return { batch, marks, rows: marks.length, bytes: size() };
    }
  }
  return { batch, marks, rows: marks.length, bytes: size() };
}

export function acknowledgeBatch(sql, marks) {
  for (const { table, key, version } of marks) {
    if (!TABLES.includes(table)) throw new Error('Invalid archive table');
    rows(sql, `UPDATE ${table} SET archived=1 WHERE ${KEYS[table]}=?${table === 'journal' ? '' : ' AND row_version=?'}`,
      key, ...(table === 'journal' ? [] : [version]));
  }
}

export function archiveLag(sql, now, personalEligible = true, personalEligibleAt = 0) {
  let oldest = now;
  for (const table of TABLES) {
    const personal = ['participants', 'responses'].includes(table);
    if (personal && !personalEligible) continue;
    const at = rows(sql, `SELECT min(pending_at) AS at FROM ${table} WHERE archived=0 AND pending_at>0`)[0].at;
    if (at !== null) oldest = Math.min(oldest, personal ? Math.max(at, personalEligibleAt) : at);
  }
  return Math.max(0, (now - oldest) / 1000);
}

export const retryDelay = (attempt, random = Math.random) => Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9) * (1 + Math.max(0, Math.min(1, random())) * 0.2));
// CASE-319: a closing window's deadline (`lock`, 0 = none) shares the room's one alarm slot.
export const earliestAlarm = (lifecycle, archive, lock = 0) => Math.min(lifecycle, ...[archive, lock].filter(t => t > 0));
