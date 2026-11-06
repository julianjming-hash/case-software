-- db/durable-object/room-schema.sql
--
-- SQLite schema inside ONE live-room Durable Object (one DO per session, CASE-048).
-- This is the hot, authoritative store for a running room: every vote, lock and reveal
-- is a local SQLite write in the DO, and nothing waits on Postgres.
--
-- Recovery model (red team P0-2, CASE-072):
--   `meta.state` holds reducer control state (minus the case document), with historical private
--   answers and aggregates referenced in the relational evidence below. It is written
--   in the SAME transaction as each journal row, so an evicted or redeployed DO rebuilds exactly
--   by reading it back. The case document is cached once in `case_doc`, keyed by content hash.
--   The relational evidence also carries the ARCHIVE OUTBOX: the rows still owed to Postgres
--   (case_api.archive_session_batch), in batches, idempotent and replay-safe.
--
-- Lifetime (CASE-073): the DO keeps its storage until endedAt + 24 h. It serves the private recap
-- for that window, then an alarm deletes everything. A room nobody ends is force-ended by an alarm
-- at sessions.expires_at, so personal data can never outlive the purge.
--
-- Timestamps are ISO-8601 UTC text; ids are UUIDv7 text (src/shared/ids.mjs). STRICT tables.
-- Apply with ctx.storage.sql.exec() in the DO constructor, guarded by `meta.schema_version`.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- Private evidence inventory detects missing own-response rows after compact-state conversion.
-- It shares this DO's endedAt + 24 h delete-all lifetime and never enters archive batches.
CREATE TABLE IF NOT EXISTS response_evidence_keys (
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  PRIMARY KEY(round_id,participant_id)
) STRICT;
-- Keys: schema_version, session_id, content_sha256, state (JSON reducer state without caseDoc),
--       archive_lag_seq, recap_delete_at, expires_at, owner_user_id.

-- Room images (card 59 M3, CASE-269): one opaque handle per image the published version pins, minted here at room start.
-- The handle is the only name a public client ever sees, and only after a step that shows the image is released; the
-- storage keys stay in this table. Deleted with the rest of the room's storage.
CREATE TABLE IF NOT EXISTS media (
  handle       TEXT PRIMARY KEY,                 -- UUIDv7
  asset_id     TEXT NOT NULL UNIQUE,
  display_key  TEXT NOT NULL,
  phone_key    TEXT NOT NULL,
  poster_key   TEXT,                             -- a GIF's or video's JPEG still; NULL for a still image
  type         TEXT NOT NULL DEFAULT 'image/jpeg' CHECK (type IN ('image/jpeg', 'image/gif', 'video/mp4'))
) STRICT;

CREATE TABLE IF NOT EXISTS case_doc (
  content_sha256  TEXT PRIMARY KEY,              -- hex; matches case_versions.content_sha256
  document_text   TEXT NOT NULL                  -- exactly case_api.get_case_version().document_text
) STRICT;

-- Idempotency ledger for dispatch() (room-machine.mjs). Keyed per sender, holds a payload
-- fingerprint, pruned by age (never by count), and kept OUT of reducer state.
CREATE TABLE IF NOT EXISTS receipts (
  ledger_key   TEXT PRIMARY KEY,                 -- `${role}:${actorId}:${clientEventId}`
  fingerprint  TEXT NOT NULL,
  at           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS receipts_at ON receipts (at);

-- Room capability tokens (Phase 1). Only the SHA-256 of a token is stored; the token itself goes to
-- its holder once and never again. Facilitator rows carry the signed-in user; participant rows carry
-- the pseudonymous participant id. Deleted with everything else at endedAt + 24 h (CASE-073).
CREATE TABLE IF NOT EXISTS credentials (
  token_sha256    TEXT PRIMARY KEY,               -- hex
  role            TEXT NOT NULL CHECK (role IN ('facilitator', 'display', 'participant')),
  participant_id  TEXT,
  user_id         TEXT,
  issued_at       TEXT NOT NULL,
  revoked_at      TEXT,
  CHECK ((role = 'participant') = (participant_id IS NOT NULL))
) STRICT;

-- The facilitator credentials a shared computer picked up (card 35b, P-27): the starter lists the room's
-- consoles by kind and may revoke one of these. A room started before this table existed creates it on
-- first use (room-do.mjs SHARED_CONSOLES). A credential without a row is the starter's own device if it was
-- issued at or after meta `console_tracking_since`, otherwise `unknown` (minted before this room tracked them).
CREATE TABLE IF NOT EXISTS shared_consoles (
  token_sha256    TEXT PRIMARY KEY REFERENCES credentials (token_sha256)
) STRICT;

-- ── archive outbox (mirrors the Postgres archive columns) ──
-- JSON columns hold JSON TEXT; the batch builder JSON.parse()s them so Postgres receives objects.

CREATE TABLE IF NOT EXISTS participants (
  id            TEXT PRIMARY KEY,               -- pseudonymous participant UUIDv7
  display_name  TEXT CHECK (length(display_name) <= 40),
  token_sha256  TEXT NOT NULL UNIQUE,           -- hex; the token itself is never stored
  joined_at     TEXT NOT NULL,
  removed_at    TEXT,
  row_version   INTEGER NOT NULL DEFAULT 0,
  pending_at    INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS rounds (
  id                TEXT PRIMARY KEY,
  decision_id       TEXT NOT NULL,
  round_no          INTEGER NOT NULL CHECK (round_no >= 1),
  status            TEXT NOT NULL CHECK (status IN ('open', 'locked', 'resolved', 'abandoned', 'superseded')),
  opened_at         TEXT NOT NULL,
  locked_at         TEXT,
  closed_at         TEXT,
  aggregate         TEXT,                        -- JSON counts, computed at lock
  selected_path_id  TEXT,
  resolution_kind   TEXT CHECK (resolution_kind IN ('majority', 'minority', 'override')),
  row_version       INTEGER NOT NULL DEFAULT 0,
  pending_at        INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  UNIQUE (decision_id, round_no)
) STRICT;
-- At most one open round at a time.
CREATE UNIQUE INDEX IF NOT EXISTS rounds_one_open ON rounds (status) WHERE status = 'open';

-- Current answer per participant per round. A resubmission overwrites it until lock.
CREATE TABLE IF NOT EXISTS responses (
  id                    TEXT PRIMARY KEY,         -- minted by the server (wire.buildEvent)
  round_id              TEXT NOT NULL REFERENCES rounds (id),
  participant_id        TEXT NOT NULL REFERENCES participants (id),
  response              TEXT NOT NULL,            -- JSON
  last_client_event_id  TEXT NOT NULL,
  first_submitted_at    TEXT NOT NULL,
  last_submitted_at     TEXT NOT NULL,
  source_response_id    TEXT,
  source_round_id       TEXT,
  source_client_event_id TEXT,
  correction_event_id   TEXT,
  seeded_at            TEXT,
  row_version           INTEGER NOT NULL DEFAULT 0,
  pending_at            INTEGER NOT NULL DEFAULT 0,
  archived              INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  UNIQUE (round_id, participant_id)
) STRICT;

-- Any content change re-arms a row for archiving. The batch builder marks rows sent only for the
-- VERSION it sent (e.g. `WHERE id = ? AND last_submitted_at = ?`), so an edit made while a batch
-- was in flight is never lost (red team P1: lost late edits).
CREATE TRIGGER IF NOT EXISTS participants_rearm AFTER UPDATE OF display_name, removed_at ON participants
BEGIN UPDATE participants SET archived = 0 WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS rounds_rearm AFTER UPDATE OF status, locked_at, closed_at, aggregate, selected_path_id, resolution_kind ON rounds
BEGIN UPDATE rounds SET archived = 0 WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS responses_rearm AFTER UPDATE OF response, last_client_event_id, last_submitted_at ON responses
BEGIN UPDATE responses SET archived = 0 WHERE id = NEW.id; END;

-- Append-only journal. seq is session_revision. Payloads carry ids and counts, never names or
-- free text (manual-marker text stays in `meta.state` and dies with the DO).
CREATE TABLE IF NOT EXISTS journal (
  seq          INTEGER PRIMARY KEY,               -- = session_revision, strictly increasing
  event_id     TEXT NOT NULL UNIQUE,
  epoch        INTEGER NOT NULL CHECK (epoch >= 0),
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',        -- JSON
  occurred_at  TEXT NOT NULL,
  pending_at   INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;
CREATE INDEX IF NOT EXISTS journal_unarchived ON journal (seq) WHERE archived = 0;

CREATE TRIGGER IF NOT EXISTS journal_no_update
BEFORE UPDATE OF seq, event_id, epoch, kind, payload, occurred_at ON journal
BEGIN
  SELECT RAISE(ABORT, 'journal is append-only');
END;

CREATE TRIGGER IF NOT EXISTS journal_no_delete
BEFORE DELETE ON journal
BEGIN
  SELECT RAISE(ABORT, 'journal is append-only');
END;
