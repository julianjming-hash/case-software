// src/worker/room-do.mjs: one live room (Phase 1). The single writer for a session.
//
// It does what prototypes/room/lib/sim-do.mjs did in the lab, on real Durable Object storage:
//   • every frame is parsed by wire.mjs; buildEvent stamps actor, time and ids; room-machine
//     dispatch() is the only transition; project() is the only thing a client ever receives;
//   • a command's receipt (the idempotency ledger), meta.state and its journal rows commit in ONE
//     transaction, or none of them do (CASE-072; runtime red team P0-1): a retry can never be told
//     `already_accepted` for a vote that was not stored;
//   • a state-size budget refuses a command with a receipt instead of failing every later write;
//   • room capability tokens are stored only as SHA-256 hashes (`credentials`), and are revoked on
//     removal, on facilitator takeover and on display re-pair (red team P1-6);
//   • WebSockets hibernate: the fixed ping frame is answered by setWebSocketAutoResponse;
//   • long-poll waiters and sockets wake from the same scoped, coalesced flush (red team P1-4);
//   • deletion is armed synchronously from the SERVER clock when the room ends, and as a backstop at
//     expires_at + 24 h whatever happened (CASE-073; red team P0-2, P1-3);
//   • nothing is written for a session that was never created (red team P1-5).
// Called by the Worker over Durable Object RPC, except the WebSocket upgrade (fetch).
import { log } from './log.mjs';
import { metric } from './metrics.mjs';
import { createObserver } from './observability.mjs';
import { withSecurityHeaders } from './headers.mjs';
import { DurableObject } from 'cloudflare:workers';
import roomSchema from '../../db/durable-object/room-schema.sql';
import { uuidv7, isUuid, isUuidV7, newCapabilityToken, hashToken, normalizeCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
import { validateRuntimeDocument } from '../shared/runtime-document.mjs';
import { validateSlideParts } from '../shared/slide-document.mjs';
import { validLabel } from '../shared/facilitator-label.mjs';
import { initialState, dispatch, applySegment, project, participantTimeline, normalizePresentationState, ledgerKey, RECAP_TTL_MS, releasedMediaHandles, sanitizeRoomMedia, everyoneAnswered, SYSTEM_LOCK_ACTOR, SYSTEM_AUTO_LOCK_ACTOR } from '../shared/room-machine.mjs';
const MEDIA_KEY = /^media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(jpg|gif|mp4)$/, POSTER_KEY = /^media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.jpg$/;
import {
  WIRE_VERSION, PING_FRAME, PONG_FRAME, LONG_POLL_MAX_S, MAX_FRAME_BYTES, clientSchemaTooOld,
  parseClientFrame, parseCommandEnvelope, buildEvent, receiptBody, snapshotBody, syncBody, parseManualSegment, parseJoinRequest,
} from '../shared/wire.mjs';
import { directoryFor, pairsDirectory } from './directory-do.mjs';
import { snapshotText } from './snapshot-text.mjs';
import { rpcClient } from './rpc.mjs';
import { ARCHIVE_SCHEMA_VERSION, migrateArchive, writeArchiveState, ArchiveWriteCache, archiveBatch,
  acknowledgeBatch, archiveCounts, archiveLag, retryDelay, earliestAlarm } from './room-archive.mjs';
import { summaryPages } from '../shared/debrief-pages.mjs';
import { compactRoomState, readRoundEvidence, hydrateRoomPresentation, verifyLegacyEvidence, verifyCompactEvidence, EvidenceIncomplete } from './room-evidence.mjs';
// Card 40d: a debrief paging grant lives at most this long from minting (red-team R3), whatever the console does.
const DEBRIEF_GRANT_TTL_MS = 20 * 60 * 1000;

const SCHEMA_VERSION = ARCHIVE_SCHEMA_VERSION;
export const MAX_ROOM_TTL_MS = 24 * 60 * 60 * 1000; // matches the Postgres TTL clamp
export const MIN_ROOM_TTL_MS = 60 * 1000;
/** One clamp for the Worker and the room, so a room's code and its life agree (red team P2-5). */
export const clampTtl = (ms) => Math.min(Math.max(Number.isFinite(ms) && ms > 0 ? ms : MAX_ROOM_TTL_MS, MIN_ROOM_TTL_MS), MAX_ROOM_TTL_MS);
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_BUDGET_BYTES = 1_000_000;   // well under SQLite's 2 MB value limit
// Rooms refuse clients older than their case schema before sending content (wire.mjs clientSchemaTooOld).
const clientTooOld = (state, supportedSchema) => clientSchemaTooOld(state?.caseDoc.schema_version, supportedSchema);
// The budget is UTF-8 bytes as stored, not UTF-16 code units (CASE-155).
const utf8Bytes = (text) => new TextEncoder().encode(text).byteLength;
const MAX_SOCKETS = 400;                 // 300 participants + consoles, displays and reconnect overlap
const HELLO_DEADLINE_MS = 10_000;
const MAX_WAITERS_PER_CREDENTIAL = 2;
const SEGMENT_FUTURE_SLACK_MS = 2 * 60 * 1000;
const ARCHIVE_WATCHDOG_MS = 10_000; // Durable recovery slot beyond the RPC client's 5 s deadline.
const BUCKET = { burst: 20, perSecond: 2 }; // per-credential command rate (red team P2-6)
// Card 59 M3: image reads have their own bucket, so a console holding its room's images never delays its commands.
const MEDIA_BUCKET = { burst: 64, perSecond: 1 };
// Red-team S6: a phone or display credential reads one image rendition at most this often per window (reloads, paging
// back over more than a screen's 32 held media, retries after a 429). Counted in the room's own storage, so an evicted object
// does not forget it. The facilitator (its console prefetches every image on each load) is bounded by MEDIA_BUCKET only.
const MEDIA_READS = { perWindow: 24, windowMs: 10 * 60 * 1000 };
const MEDIA_READS_TABLE = 'CREATE TABLE IF NOT EXISTS media_reads (read_key TEXT PRIMARY KEY, slot INTEGER NOT NULL, reads INTEGER NOT NULL) STRICT';
const FACILITATOR_ACTOR_ID = 'facilitator';
// Card 35b (P-27): which facilitator credentials a shared computer picked up. Created lazily for older rooms.
const SHARED_CONSOLES = 'CREATE TABLE IF NOT EXISTS shared_consoles (token_sha256 TEXT PRIMARY KEY REFERENCES credentials (token_sha256)) STRICT';
/** A participant counts as present with an open socket, or HTTP activity this recent (spec red team 2, P1-7). */
export const PRESENCE_MS = 60_000;

class StateTooLarge extends Error {}
// An internal replay/refusal rolls back the empty join transaction before any mutation effects.
class JoinResult extends Error {
  constructor(reply) { super('join_result'); this.reply = reply; }
}

export class RoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.observer=createObserver(env,ctx);
    this.onArchiveAlert=event=>this.observer.alert(event);
    this.coalesceMs = Number(env.BROADCAST_COALESCE_MS ?? 250);
    // CASE-319: Lock opens a closing window this long (0 = lock at once, as before); when everyone connected has
    // answered, an automatic countdown of AUTO_LOCK_MS opens the same window (0 = auto-lock off for this deployment).
    this.lockGraceMs = Number(env.LOCK_GRACE_MS ?? 2000);
    this.autoLockMs = Number(env.AUTO_LOCK_MS ?? 3000);
    this.lockTimer = null;
    this.waiters = new Set();
    this.pendingRoles = new Set();
    this.flushTimer = null;
    // CASE-169: what this instance last committed to the archive outbox, so a vote writes O(1) rows.
    this.archiveWrites = new ArchiveWriteCache();
    this.buckets = new Map();
    this.mediaBuckets = new Map();
    this.seen = new Map(); // participantId → last HTTP request (ms); in memory only, like the buckets
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
    ctx.blockConcurrencyWhile(async () => this.#load());
  }

  // ─── storage ────────────────────────────────────────────────────────────────

  #meta(key) {
    return this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }
  #setMeta(key, value) {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
  }
  /** Reads only: an unknown session id never creates tables or storage (red team P1-5). */
  async #load() {
    this.maintenancePending = false;
    this.normalizedStatePending = false;
    this.loadInvalid = false;
    const exists = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    const json = exists ? this.#meta('state') : null;
    if (!json) {
      this.state = null;
      const tables = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").toArray();
      this.loadInvalid = exists || tables.length > 0 || (await this.ctx.storage.getAlarm()) !== null;
      return;
    }
    try {
      const doc = this.sql.exec('SELECT document_text FROM case_doc WHERE content_sha256 = ?', this.#meta('content_sha256')).toArray()[0];
      if (!doc || typeof doc.document_text !== 'string') throw new Error('missing document');
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state');
      const loaded = { ...parsed, caseDoc: JSON.parse(doc.document_text) };
      this.state = normalizePresentationState(loaded);
      this.normalizedStatePending = this.state !== loaded;
      this.maintenancePending = true; // A cold instance verifies its compact evidence once.
    } catch {
      // A malformed cold store is unavailable, not an empty store to repair or reuse.
      this.state = null;
      this.loadInvalid = true;
    }
  }

  /** Ordinary room access catches up a cold schema once; the retention probe never calls this. */
  #ensureMaintenance() {
    if (!this.maintenancePending || !this.state) return;
    let maintained = this.state;
    this.ctx.storage.transactionSync(() => {
      if (this.#meta('schema_version') !== SCHEMA_VERSION) {
        migrateArchive(this.sql);
        this.#setMeta('schema_version', SCHEMA_VERSION);
      }
      if (this.state.evidenceStateVersion !== 1) {
        if (!verifyLegacyEvidence(this.sql, this.state)) throw new EvidenceIncomplete();
        maintained = compactRoomState(this.state);
      }
      if (!verifyCompactEvidence(this.sql, maintained)) throw new EvidenceIncomplete();
      if (this.normalizedStatePending || maintained !== this.state) {
        const { caseDoc: _caseDoc, ...persisted } = maintained;
        const normalizedJson = JSON.stringify(persisted);
        if (utf8Bytes(normalizedJson) > STATE_BUDGET_BYTES) throw new StateTooLarge();
        this.#setMeta('state', normalizedJson);
      }
    });
    this.state = maintained;
    this.maintenancePending = false;
    this.normalizedStatePending = false;
  }

  /** Read-only, fixed evidence for a Worker-gated operator query. Never initializes storage. */
  async retentionEvidence(expectedSessionId) {
    if (!isUuidV7(expectedSessionId) || this.ctx.id.name !== expectedSessionId ||
        this.loadInvalid || (this.state && this.state.sessionId !== expectedSessionId))
      return { error: 'unavailable' };
    const tables = this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray();
    const kvTable = tables.some(row => row.name === '__cf_kv');
    const kvPresent = kvTable && this.sql.exec('SELECT 1 FROM "__cf_kv" LIMIT 1').toArray().length > 0;
    const alarmPresent = (await this.ctx.storage.getAlarm()) !== null;
    const statePresent = Boolean(this.state);
    const tableCount = tables.length;
    return { sessionId: expectedSessionId, storeEmpty: tableCount === 0 && !kvPresent &&
      !alarmPresent && !statePresent, tableCount, kvPresent, alarmPresent,
      statePresent, observedAt: new Date().toISOString() };
  }
  #ledger() {
    return {
      get: (k) => {
        const r = this.sql.exec('SELECT fingerprint, at FROM receipts WHERE ledger_key = ?', k).toArray()[0];
        return r ? { fingerprint: r.fingerprint, at: r.at } : undefined;
      },
      // Written inside #mutate's transaction, so a receipt never outlives a rolled-back command.
      set: (k, v) => this.sql.exec('INSERT OR REPLACE INTO receipts (ledger_key, fingerprint, at) VALUES (?, ?, ?)', k, v.fingerprint, new Date().toISOString()),
    };
  }

  // ─── credentials ────────────────────────────────────────────────────────────

  #insertCredential(sha, role, { participantId = null, userId = null } = {}) {
    this.sql.exec('INSERT INTO credentials (token_sha256, role, participant_id, user_id, issued_at) VALUES (?, ?, ?, ?, ?)',
      sha, role, participantId, userId, new Date().toISOString());
    // Defence in depth: today a credential is only issued with a fresh id, so this never changes a token.
    if (participantId) this.archiveWrites.credentialIssued(participantId);
  }

  /** The holder of a room token: `{ role, participantId, cred }` or `{ error, status }`. */
  async #who(token) {
    if (!this.state) return this.loadInvalid ? { error: 'unavailable', status: 503 } : { error: 'unknown_room', status: 404 };
    if (typeof token !== 'string' || token.length < 20) return { error: 'unauthorised', status: 401 };
    const sha = await hashToken(token);
    if (!this.state) return { error: 'unknown_room', status: 404 }; // deleted while hashing
    try { this.#ensureMaintenance(); }
    catch (error) {
      if (error instanceof EvidenceIncomplete) return { error: 'incomplete_room_evidence', status: 503 };
      throw error;
    }
    const row = this.sql.exec('SELECT role, participant_id, revoked_at FROM credentials WHERE token_sha256 = ?', sha).toArray()[0];
    if (!row || row.revoked_at) return { error: 'unauthorised', status: 401 };
    if (row.role === 'participant' && this.state.participants[row.participant_id]?.removedAt) return { error: 'removed', status: 403 };
    if (row.role === 'participant') this.seen.set(row.participant_id, Date.now()); // presence: snapshot, long-poll and command traffic
    return { role: row.role, participantId: row.participant_id ?? null, cred: sha };
  }

  /** Token bucket per credential; in memory only (an eviction simply refills it). */
  #allow(cred, limit = BUCKET, buckets = this.buckets) {
    const now = Date.now();
    const b = buckets.get(cred) ?? { tokens: limit.burst, at: now };
    b.tokens = Math.min(limit.burst, b.tokens + ((now - b.at) / 1000) * limit.perSecond);
    b.at = now;
    if (b.tokens < 1) { buckets.set(cred, b); return false; }
    b.tokens -= 1;
    buckets.set(cred, b);
    return true;
  }

  // ─── RPC: lifecycle ─────────────────────────────────────────────────────────

  /** Create the room. Returns `{ facilitatorToken, expiresAt }` or `{ error }`. */
  async create({ sessionId, joinCode, caseDoc, caseVersionNo = null, caseVersionId = null, art = null, tint = null, ownerUserId, workspaceId = null, caseId = null, ownerAdminDigest = null, inlineDev = false, ttlMs, archiveSessionId = null, media = null, feedbackCode = null, facilitatorLabel = null }) {
    if (this.loadInvalid) return { error: 'unavailable', status: 503 };
    if (this.state) return { error: 'exists', status: 409 };
    if (caseVersionId !== null && !isUuidV7(caseVersionId)) return { error: 'bad_request', status: 400 };
    // The room's feedback code (CASE-284, card 40 red-team R1): Crockford, six characters, or none for a room created
    // before the migration was applied.
    if (feedbackCode !== null && (typeof feedbackCode !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{6}$/.test(feedbackCode))) return { error: 'bad_request', status: 400 };
    // The facilitator's "Name, Role" fixed at start (Julian, 2026-10-18), exactly as composeLabel makes it, or none.
    if (facilitatorLabel !== null && !validLabel(facilitatorLabel)) return { error: 'bad_request', status: 400 };
    if (archiveSessionId !== null && archiveSessionId !== sessionId) return { error: 'bad_archive_session', status: 400 };
    // The room's workspace (card 35) and the case it was started from (CASE-336): every later console mint rechecks
    // the starter's membership there, or their live grant on that case, or admin.
    if ((workspaceId !== null && !isUuidV7(workspaceId)) || (caseId !== null && (!isUuidV7(caseId) || workspaceId === null)) ||
        (ownerAdminDigest !== null && (typeof ownerAdminDigest !== 'string' || !/^[0-9a-f]{64}$/.test(ownerAdminDigest))))
      return { error: 'bad_request', status: 400 };
    const v = validateRuntimeDocument(caseDoc, { validateSlides: validateSlideParts });
    if (!v.ok) return { error: 'invalid_case', status: 422, details: v.errors.slice(0, 20) };
    // Card 59 M3: a fresh opaque handle per image (hard rule 3); the storage keys are kept apart from room state.
    const roomMedia = media === null ? null : {}, mediaRows = [];
    if (media !== null) {
      if (!media || typeof media !== 'object' || Array.isArray(media) || Object.keys(media).length > 64) return { error: 'bad_request', status: 400 };
      for (const [assetId, item] of Object.entries(media)) {
        if (item?.state === 'withdrawn') { roomMedia[assetId] = { state: 'withdrawn' }; continue; }
        const type = item?.type ?? 'image/jpeg';
        if (!MEDIA_KEY.test(item?.displayKey ?? '') || !MEDIA_KEY.test(item?.phoneKey ?? '') || (type !== 'image/jpeg' && !POSTER_KEY.test(item?.posterKey ?? ''))) return { error: 'bad_request', status: 400 };
        const handle = uuidv7();
        roomMedia[assetId] = { handle, width: item.width, height: item.height, credit: item.credit ?? null, type, durationMs: item.durationMs ?? null };
        mediaRows.push([handle, assetId, item.displayKey, item.phoneKey, type === 'image/jpeg' ? null : item.posterKey, type]);
      }
      try { sanitizeRoomMedia(roomMedia); } catch { return { error: 'bad_request', status: 400 }; }
    }
    const documentText = JSON.stringify(caseDoc);
    const sha = await hashToken(documentText); // SHA-256 hex of the exact document text
    const facilitatorToken = newCapabilityToken();
    const tokenSha = await hashToken(facilitatorToken);
    if (this.state) return { error: 'exists', status: 409 };
    // From here on, everything is synchronous: one turn, one atomic write, alarm included.
    const expiresAt = Date.now() + clampTtl(ttlMs);
    // The group tint the room started with (card 30, CASE-168 (4)): kept with the case for the room's life.
    const s = compactRoomState(initialState({ sessionId, joinCode, caseDoc, caseVersionNo, art, tint, media: roomMedia, feedbackCode, facilitatorLabel }));
    const { caseDoc: _omit, ...rest } = s;
    this.sql.exec(roomSchema);
    this.ctx.storage.transactionSync(() => {
      this.#setMeta('schema_version', SCHEMA_VERSION);
      this.#setMeta('session_id', sessionId);
      if (archiveSessionId !== null) this.#setMeta('archive_session_id', archiveSessionId);
      if (caseVersionId !== null) this.#setMeta('portfolio_version_id', caseVersionId);
      this.#setMeta('content_sha256', sha);
      this.#setMeta('expires_at', expiresAt);
      this.#setMeta('owner_user_id', ownerUserId);
      this.#trackConsoles(); // card 35b: every console of this room is identifiable from its start
      if (workspaceId !== null) this.#setMeta('workspace_id', workspaceId);
      if (caseId !== null) this.#setMeta('case_id', caseId);
      if (ownerAdminDigest !== null) this.#setMeta('owner_admin_digest', ownerAdminDigest);
      if (inlineDev === true) this.#setMeta('inline_dev', '1');
      this.#setMeta('state', JSON.stringify(rest));
      this.sql.exec('INSERT INTO case_doc (content_sha256, document_text) VALUES (?, ?)', sha, documentText);
      for (const row of mediaRows) this.sql.exec('INSERT INTO media (handle, asset_id, display_key, phone_key, poster_key, type) VALUES (?, ?, ?, ?, ?, ?)', ...row);
      // Red-team B1: an image stored after this moment is not the one this room was started with.
      if (mediaRows.length) this.#setMeta('media_since', Date.now());
      this.#insertCredential(tokenSha, 'facilitator', { userId: ownerUserId });
    });
    this.ctx.storage.setAlarm(expiresAt);
    this.state = s;
    metric(this.env,{event:'room_created'});
    return { facilitatorToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Compensate a failed published start, including an ambiguous create response. */
  async abortCreate(sessionId) {
    if (this.loadInvalid) return { error: 'unavailable', status: 503 };
    const exists = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    if (!exists) return { aborted: false };
    this.#ensureMaintenance();
    if (this.#meta('session_id') !== sessionId) return { aborted: false };
    this.#closeSockets(() => true, 4010, 'room_deleted');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = null;
    // Defence in depth: a recreated room has fresh ids, so stale entries could never match.
    this.archiveWrites = new ArchiveWriteCache();
    return { aborted: true };
  }

  /** A token for a second facilitator device. Only the room's owner may get one. */
  canIssueFacilitatorToken(userId) {
    if (!this.state) return this.loadInvalid ? { error: 'unavailable', status: 503 } : { error: 'unknown_room', status: 404 };
    this.#ensureMaintenance();
    if (this.#meta('owner_user_id') !== userId) return { error: 'forbidden', status: 403 };
    if (this.state.endedAt || Number(this.#meta('expires_at')) <= Date.now()) return { error: 'room_ended', status: 410 };
    // What the Worker needs to recheck the starter before it mints (invariant 10). No credential here.
    return { ok: true, workspaceId: this.#meta('workspace_id') ?? null, caseId: this.#meta('case_id') ?? null, ownerAdminDigest: this.#meta('owner_admin_digest') ?? null,
      inlineDev: this.#meta('inline_dev') === '1' };
  }

  /** Minting rechecks ownership and room state after any earlier read-only approval preflight. */
  async issueFacilitatorToken(userId, hash = hashToken, shared = false) {
    const eligibility = this.canIssueFacilitatorToken(userId);
    if (!eligibility.ok) return eligibility;
    const token = newCapabilityToken();
    const sha = await hash(token);
    const stillEligible = this.canIssueFacilitatorToken(userId);
    if (!stillEligible.ok) return stillEligible;
    this.ctx.storage.transactionSync(() => {
      this.#trackConsoles();
      this.#insertCredential(sha, 'facilitator', { userId });
      if (shared) this.sql.exec('INSERT INTO shared_consoles (token_sha256) VALUES (?)', sha);
    });
    return { facilitatorToken: token };
  }

  /** A shared computer's pickup (console-pairs.mjs): the same mint, marked so the starter can revoke it (P-27). */
  issueSharedConsoleToken(userId) { return this.issueFacilitatorToken(userId, hashToken, true); }

  /**
   * Shared-console tracking (card 35b): from `console_tracking_since` on, every console this build mints is
   * identifiable (a `shared_consoles` row, or none for the starter's own device). A room started by an earlier
   * build gets the marker on first use, so consoles minted before it read as `unknown`, never as the starter's.
   */
  #trackConsoles() {
    this.sql.exec(SHARED_CONSOLES);
    if (!this.#meta('console_tracking_since')) this.#setMeta('console_tracking_since', new Date().toISOString());
    return this.#meta('console_tracking_since');
  }

  /** The starter's view of this room's live console credentials (P-27): device kind and issue time only. */
  #starterConsoles(userId) {
    if (!this.state) return { error: this.loadInvalid ? 'unavailable' : 'unknown_room', status: this.loadInvalid ? 503 : 404 };
    this.#ensureMaintenance();
    if (this.#meta('owner_user_id') !== userId) return { error: 'forbidden', status: 403 };
    if (this.state.endedAt || Number(this.#meta('expires_at')) <= Date.now()) return { error: 'room_ended', status: 410 };
    const since = this.#trackConsoles();
    return { rows: this.sql.exec(`SELECT c.rowid AS id, c.token_sha256 AS sha, c.issued_at AS issuedAt,
      CASE WHEN s.token_sha256 IS NOT NULL THEN 'shared' WHEN c.issued_at >= ? THEN 'starter' ELSE 'unknown' END AS kind
      FROM credentials c LEFT JOIN shared_consoles s USING (token_sha256)
      WHERE c.role = 'facilitator' AND c.revoked_at IS NULL ORDER BY c.rowid`, since).toArray() };
  }

  listConsoles(userId) {
    const found = this.#starterConsoles(userId);
    return found.error ? found : { consoles: found.rows.map(r => ({ id: r.id, kind: r.kind, issuedAt: r.issuedAt })) };
  }

  /** The starter stops one shared computer now (E27): its credential is revoked and its socket and reads end. */
  revokeConsole(userId, id) {
    if (!Number.isSafeInteger(id) || id < 1) return { error: 'bad_request', status: 400 };
    const found = this.#starterConsoles(userId);
    if (found.error) return found;
    const row = found.rows.find(r => r.id === id);
    if (!row) return { error: 'unknown_console', status: 404 };
    // A console minted before this room tracked shared computers cannot be told apart: Take over or End removes it.
    if (row.kind === 'unknown') return { error: 'console_paired_before_update', status: 409 };
    if (row.kind !== 'shared') return { error: 'not_shared_computer', status: 409 };
    this.sql.exec('UPDATE credentials SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL', new Date().toISOString(), row.sha);
    this.#closeSockets(a => a.cred === row.sha, 4006, 'unauthorised');
    metric(this.env, { event: 'console_revoked' });
    return { ok: true };
  }

  /** A participant joins (the Directory already resolved the code). */
  async join(displayName, avatarId, joinToken = undefined) {
    if (joinToken !== undefined) return this.#joinOnce(displayName, avatarId, joinToken);
    if (!this.state) {metric(this.env,{event:'join_fail',reason:'unknown_code'});return this.loadInvalid ? {error:'unavailable',status:503} : { error: 'unknown_room', status: 404 };}
    const participantId = uuidv7();
    const token = newCapabilityToken();
    const sha = await hashToken(token);
    if (!this.state) return { error: 'unknown_room', status: 404 };
    const event = {
      type: 'join', epoch: this.state.epoch, actor: { role: 'participant', id: participantId },
      at: new Date().toISOString(), clientEventId: uuidv7(), displayName, avatarId,
    };
    const r = this.#mutate(() => dispatch(this.state, event, this.#ledger()), (res) => {
      if (res.effects.find((e) => e.type === 'receipt')?.receipt === 'accepted') this.#insertCredential(sha, 'participant', { participantId });
    });
    const receipt = r.effects.find((e) => e.type === 'receipt');
    if (receipt?.receipt !== 'accepted') {metric(this.env,{event:'join_fail',reason:'rejected'});return { error: receipt?.reason ?? 'rejected', status: 409 };}
    metric(this.env,{event:'join_ok'});
    return { sessionId: this.state.sessionId, participantId, token };
  }

  /** Recover only the caller's same accepted live join; the clear capability is never stored. */
  async #joinOnce(displayName, avatarId, joinToken) {
    if (!this.state) return this.loadInvalid ? { error: 'unavailable', status: 503 } : { error: 'unknown_room', status: 404 };
    const parsed = parseJoinRequest({ v: WIRE_VERSION, code: this.state.joinCode, displayName, avatarId, joinToken });
    if (!parsed.ok) return { error: parsed.error, status: 400 };
    const [sha, fingerprint] = await Promise.all([hashToken(joinToken),
      // Keyed by the private capability: never a standalone, guessable hash of a display name.
      hashToken(joinToken + '\n' + JSON.stringify({ v: 1, displayName: parsed.displayName, avatarId: parsed.avatarId }))]);
    // A deletion while hashing never initializes an empty room or restores a credential.
    if (!this.state) return this.loadInvalid ? { error: 'unavailable', status: 503 } : { error: 'unknown_room', status: 404 };
    if (this.loadInvalid) return { error: 'unavailable', status: 503 };
    const key = `join:${sha}`;
    let participantId;
    let result;
    try {
      result = this.#mutate(() => {
        // Every authority/input/lifetime check is synchronous inside the durable transaction.
        if (!this.state || this.loadInvalid) throw new JoinResult({ error: 'unavailable', status: 503 });
        const now = Date.now();
        const expiresAt = Number(this.#meta('expires_at'));
        if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new JoinResult({ error: 'unavailable', status: 503 });
        if (this.state.endedAt || this.state.phase === 'ended' || now >= expiresAt)
          throw new JoinResult({ error: 'room_ended', status: 410 });
        const credential = this.sql.exec('SELECT role, participant_id, revoked_at FROM credentials WHERE token_sha256 = ?', sha).toArray()[0];
        const receipt = this.#ledger().get(key);
        if (credential || receipt) {
          // Neither a missing nor an aged counterpart can convert a known secret into a new join.
          const acceptedAt = receipt ? Date.parse(receipt.at) : NaN;
          if (!credential || !receipt || credential.role !== 'participant' || !Number.isFinite(acceptedAt) ||
              acceptedAt > now || now - acceptedAt >= RECEIPT_TTL_MS)
            throw new JoinResult({ error: 'join_retry_unavailable', status: 409 });
          if (credential.revoked_at) throw new JoinResult({ error: 'removed', status: 403 });
          const participant = this.state.participants[credential.participant_id];
          if (!participant) throw new JoinResult({ error: 'join_retry_unavailable', status: 409 });
          if (participant.removedAt) throw new JoinResult({ error: 'removed', status: 403 });
          if (receipt.fingerprint !== fingerprint) throw new JoinResult({ error: 'join_payload_changed', status: 409 });
          // Accepted live recovery is capacity-neutral even after joining closes. No write/refresh.
          throw new JoinResult({ sessionId: this.state.sessionId, participantId: credential.participant_id, token: joinToken });
        }
        participantId = uuidv7();
        return dispatch(this.state, { type: 'join', epoch: this.state.epoch, actor: { role: 'participant', id: participantId },
          at: new Date(now).toISOString(), clientEventId: uuidv7(), displayName: parsed.displayName, avatarId: parsed.avatarId }, this.#ledger());
      }, (res) => {
        if (res.effects.find(effect => effect.type === 'receipt')?.receipt !== 'accepted') return;
        this.#insertCredential(sha, 'participant', { participantId });
        this.#ledger().set(key, { fingerprint });
      });
    } catch (error) {
      if (error instanceof JoinResult) return error.reply;
      throw error;
    }
    const receipt = result.effects.find(effect => effect.type === 'receipt');
    if (receipt?.receipt !== 'accepted') { metric(this.env, { event: 'join_fail', reason: 'rejected' }); return { error: receipt?.reason ?? 'rejected', status: 409 }; }
    metric(this.env, { event: 'join_ok' });
    return { sessionId: this.state.sessionId, participantId, token: joinToken };
  }

  /** A display whose pair code the facilitator approved picks up its token (minted now, never stored in clear). */
  async issueDisplayToken() {
    if (!this.state) return this.loadInvalid ? { error: 'unavailable', status: 503 } : { error: 'unknown_room', status: 404 };
    this.#ensureMaintenance();
    if (this.state.endedAt) return { error: 'room_ended', status: 410 };
    const token = newCapabilityToken();
    const sha = await hashToken(token);
    if (!this.state) return { error: 'unknown_room', status: 404 };
    this.#insertCredential(sha, 'display');
    return { token };
  }

  // ─── RPC: reads ─────────────────────────────────────────────────────────────

  async snapshot(token, supportedSchema = 1) {
    if (clientTooOld(this.state, supportedSchema)) return { error: 'client_upgrade_required', status: 409 };
    const who = await this.#who(token);
    return who.error ? who : { snapshot: this.#snapshotFor(who) };
  }

  /** An existing participant may bind its saved capability to this code, including an unexpired recap. */
  async recoverParticipant(token, sessionId, code) {
    const who = await this.#who(token);
    if (who.error) return who;
    // #who rechecks deletion/revocation after hashing; all remaining checks are synchronous.
    if (who.role !== 'participant') return { error: 'forbidden', status: 403 };
    if (!this.state.participants[who.participantId] || this.state.sessionId !== sessionId ||
        normalizeCode(code, JOIN_CODE_LENGTH) !== this.state.joinCode) return { error: 'code_mismatch', status: 403 };
    const expires = Number(this.#meta('expires_at'));
    const recapDelete = Number(this.#meta('recap_delete_at') || 0);
    const now = Date.now();
    if (!Number.isFinite(expires) || expires <= 0 || now >= expires + RECAP_TTL_MS ||
        (recapDelete && now >= recapDelete)) return { error: 'recap_expired', status: 410 };
    return { sessionId: this.state.sessionId };
  }

  /**
   * Participant feedback (CASE-284, R8): the respondent for one participant credential, as HMAC-SHA-256 of its
   * participant id under a random salt that exists only in this room's storage and is deleted with it. Only the
   * HMAC leaves: never the participant id. Facilitator, display and unknown credentials are refused.
   */
  async issueRespondent(token, sessionId) {
    const who=await this.#who(token);
    if(who.error)return who;
    if(who.role!=='participant'||this.state.sessionId!==sessionId)return{error:'forbidden',status:403};
    let salt=this.#meta('issue_salt');
    if(!salt){salt=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');this.#setMeta('issue_salt',salt);}
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(salt),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`issue:${who.participantId}`));
    return{respondent:[...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,'0')).join('')};
  }

  async feedbackRespondent(token, sessionId) {
    const who = await this.#who(token);
    if (who.error) return who;
    if (who.role !== 'participant' || this.state.sessionId !== sessionId) return { error: 'forbidden', status: 403 };
    let salt = this.#meta('feedback_salt');
    if (!salt) {
      salt = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
      this.#setMeta('feedback_salt', salt);
    }
    const key = await crypto.subtle.importKey('raw', new Uint8Array(salt.match(/../g).map(h => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`joined:${who.participantId}`));
    return { respondent: [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('') };
  }

  /** Worker-gated admin metadata, never a private projection or a credential mint. */
  adminSummary(expectedSessionId) {
    if (!isUuidV7(expectedSessionId) || !this.state || this.state.sessionId !== expectedSessionId)
      return {error:'not_found',status:404};
    this.#ensureMaintenance();
    return {sessionId:this.state.sessionId,ownerUserId:this.#meta('owner_user_id'),
      status:this.state.endedAt ? 'ended' : 'live',expiresAt:new Date(Number(this.#meta('expires_at'))).toISOString(),
      phase:this.state.phase,participantCount:Object.values(this.state.participants).filter(participant => !participant.removedAt).length};
  }

  /** A durable audited Worker intent precedes this irreversible same-owner end. */
  adminEnd(input) {
    if (!input || Object.keys(input).some(key => !['sessionId','expectedOwnerUserId','eventId'].includes(key)) ||
        !isUuidV7(input.sessionId) || !isUuidV7(input.eventId) || !isUuid(input.expectedOwnerUserId))
      return {error:'bad_request',status:400};
    if (!this.state || this.state.sessionId !== input.sessionId) return {error:'not_found',status:404};
    this.#ensureMaintenance();
    if (this.#meta('owner_user_id') !== input.expectedOwnerUserId) return {error:'forbidden',status:403};
    const at = new Date().toISOString();
    const revoke = () => {
      this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE role = 'facilitator' AND revoked_at IS NULL",at);
      this.#setMeta('admin_end_reason','admin');
    };
    if (this.state.endedAt) { this.ctx.storage.transactionSync(() => { revoke(); if (this.#meta('debrief_grant')) { this.sql.exec("DELETE FROM meta WHERE key = 'debrief_grant'"); this.#bumpDisplay(); } }); this.#schedule(['display']); }
    else {
      const event = buildEvent({v:WIRE_VERSION,type:'end',epoch:this.state.epoch,clientEventId:input.eventId},
        {actor:{role:'facilitator',id:FACILITATOR_ACTOR_ID},at,newId:uuidv7});
      const result = this.#mutate(() => dispatch(this.state,event,this.#ledger()),revoke);
      if (result.effects.find(effect => effect.type === 'receipt')?.receipt !== 'accepted')
        return {error:'conflict',status:409};
    }
    // Existing auth error semantics trigger client private-memory teardown; recap/display survive.
    this.#closeSockets(who => who.role === 'facilitator',4001,'unauthorised');
    return {ok:true,status:'ended',reason:'admin'};
  }

  /**
   * Long-poll: returns at once if either revision is past the caller's; otherwise waits for a flush
   * that targets the caller's role (so phones do not wake for other people's votes), or `wait` s.
   */
  async updates(token, after, afterDisplay, waitS, supportedSchema = 1) {
    if (clientTooOld(this.state, supportedSchema)) return { error: 'client_upgrade_required', status: 409 };
    const who = await this.#who(token);
    if (who.error) return who;
    const behind = () => this.state && (this.state.revision > after || this.state.display.revision > afterDisplay);
    if (behind()) return { snapshot: this.#snapshotFor(who) };
    {
      const mine = [...this.waiters].filter((w) => w.cred === who.cred).length;
      if (mine >= MAX_WAITERS_PER_CREDENTIAL) return { error: 'too_many_waiters', status: 429 };
      const woke = await new Promise((resolve) => {
        const w = { who, cred: who.cred, resolve };
        this.waiters.add(w);
        w.timer = setTimeout(() => { this.waiters.delete(w); resolve(null); }, Math.min(waitS, LONG_POLL_MAX_S) * 1000);
      });
      if (woke) return { snapshotText: woke };
    }
    const again = await this.#who(token); // the holder may have been removed or the room deleted
    if (again.error) return again;
    // Waited the full time: every change that alters this role's view would have woken us in #flush,
    // so anything that moved the revisions meanwhile (other people's votes and joins) is invisible to
    // this caller. Hand back the current revisions so its next poll waits instead of returning at once.
    return { unchanged: true, revision: this.state.revision, displayRevision: this.state.display.revision };
  }

  /** Red-team S6: count one public read of one rendition in its ten-minute window; false once the window is spent. */
  #mediaReadAllowed(readKey) {
    const slot = Math.floor(Date.now() / MEDIA_READS.windowMs);
    try {
      this.sql.exec(MEDIA_READS_TABLE);
      const row = this.sql.exec(`INSERT INTO media_reads (read_key, slot, reads) VALUES (?, ?, 1)
        ON CONFLICT (read_key) DO UPDATE SET reads = CASE WHEN slot = excluded.slot THEN reads + 1 ELSE 1 END, slot = excluded.slot
        RETURNING reads`, readKey, slot).toArray()[0];
      return Number(row?.reads) <= MEDIA_READS.perWindow;
    } catch { return false; }
  }

  /**
   * Card 59 M3: the storage key of one image rendition, only for a credential whose role has had that image released
   * (the facilitator: any image of its room). Unknown, unreleased, foreign and malformed handles all answer the same 404.
   */
  async mediaObject(token, handle, rendition) {
    const who = await this.#who(token);
    if (who.error) return who;
    const missing = { error: 'not_found', status: 404 };
    if (!isUuidV7(handle) || !['display', 'phone', 'poster'].includes(rendition)) return missing;
    if (!this.#allow(who.cred, MEDIA_BUCKET, this.mediaBuckets)) return { error: 'rate_limited', status: 429 };
    if (!releasedMediaHandles(this.state, who.role).has(handle)) return missing;
    // Red-team S7: each role reads only its own copies (a phone its phone copy and poster, the projector its display copy
    // and poster); the facilitator, who holds the whole case, any. Anything else answers like an unknown handle.
    if (!({ participant: ['phone', 'poster'], display: ['display', 'poster'] }[who.role] ?? ['display', 'phone', 'poster']).includes(rendition)) return missing;
    let row = null;
    try { row = this.sql.exec('SELECT display_key, phone_key, poster_key, type FROM media WHERE handle = ?', handle).toArray()[0] ?? null; } catch { /* a room created before media has no table */ }
    // A GIF's or video's poster is its JPEG still; a still image has none (its phone copy serves).
    const key = !row ? null : rendition === 'display' ? row.display_key : rendition === 'phone' ? row.phone_key : row.poster_key;
    if (!key) return missing;
    // Counted per stored object, so a GIF's or video's one file read as display and as phone counts once (red-team S7).
    if (who.role !== 'facilitator' && !this.#mediaReadAllowed(`${who.cred}:${key}`)) return { error: 'rate_limited', status: 429 };
    return { key, type: rendition === 'poster' ? 'image/jpeg' : row.type, since: Number(this.#meta('media_since')) || 0 };
  }

  /** The case pack, for offline manual mode (CASE-092). Facilitator only. */
  async casePack(token, supportedSchema = 1) {
    if (clientTooOld(this.state, supportedSchema)) return { error: 'client_upgrade_required', status: 409 };
    const who = await this.#who(token);
    if (who.error) return who;
    if (who.role !== 'facilitator') return { error: 'forbidden', status: 403 };
    // Card 40 (red-team R3): no credential reads the private pack once the room has ended.
    if (this.state.endedAt) return { error: 'room_ended', status: 410 };
    return { document: this.state.caseDoc };
  }

  // ─── Card 40d: paging the projector's debrief after End (I3; red-team R2–R4) ─────────────────────────────────
  // The reducer stays closed at End. A facilitator credential that is still valid mints one bounded grant; the grant
  // only moves a page index kept in meta, and each move advances the display revision outside the reducer (the room
  // being ended), so WebSocket, long-poll and the same-PC relay deliver it through the comparisons they already make.
  // Results are projected only while a grant is live; the grant dies with its parent credential (Stop, admin end,
  // revoke), on revoke, or at its absolute TTL. It never reads the pack, the mirror or a command.
  #grant() {
    let g = null;
    try { g = JSON.parse(this.#meta('debrief_grant') || 'null'); } catch { g = null; }
    if (!g || typeof g.sha !== 'string' || !(g.exp > Date.now())) return null;
    const parent = this.sql.exec('SELECT revoked_at FROM credentials WHERE token_sha256 = ?', g.parent).toArray()[0];
    return parent && !parent.revoked_at && !this.#meta('admin_end_reason') ? g : null;
  }
  #debriefPages() {
    const view = project(this.#withShownAggregates(hydrateRoomPresentation(this.sql, this.state), true), 'display', null, { debriefResults: true, debriefPage: 0 });
    return summaryPages(view.debrief) + (view.debrief?.results?.length ?? 0);
  }
  /** Old rounds keep their counts in SQL (compact state); paging needs every shown round's counts. */
  /** Compaction keeps only the latest aggregate; re-read the closed ones the ended view needs (shown ones, or `all`). */
  #withShownAggregates(state, all = false) {
    return { ...state, rounds: state.rounds.map((r) => (all ? ['resolved', 'superseded', 'abandoned'].includes(r.status) : r.shown && r.status === 'resolved') && !r.aggregate
      ? { ...r, aggregate: readRoundEvidence(this.sql, r.id, state.caseDoc.decisions.find((d) => d.id === r.decisionId))?.aggregate ?? null } : r) };
  }
  #bumpDisplay() {
    this.state = { ...this.state, display: { ...this.state.display, revision: this.state.display.revision + 1 } };
    const { caseDoc, ...rest } = compactRoomState(this.state);
    this.#setMeta('state', JSON.stringify(rest));
  }
  async #grantFor(token) {
    if (!this.state) return { error: 'unknown_room', status: 404 };
    if (typeof token !== 'string' || token.length < 20) return { error: 'unauthorised', status: 401 };
    const sha = await hashToken(token);
    const g = this.state && this.#grant();
    return g && g.sha === sha ? g : { error: 'unauthorised', status: 401 };
  }

  async debriefGrant(token) {
    const who = await this.#who(token);
    if (who.error) return who;
    if (who.role !== 'facilitator') return { error: 'forbidden', status: 403 };
    if (!this.state.endedAt) return { error: 'not_ended', status: 409 };
    if (this.#meta('admin_end_reason')) return { error: 'forbidden', status: 403 };
    const grant = newCapabilityToken(), sha = await hashToken(grant), exp = Date.now() + DEBRIEF_GRANT_TTL_MS;
    if (!this.state?.endedAt) return { error: 'unknown_room', status: 404 };
    this.ctx.storage.transactionSync(() => { this.#setMeta('debrief_grant', JSON.stringify({ sha, parent: who.cred, exp, page: 0 })); this.#bumpDisplay(); });
    this.#schedule(['display']);
    return { token: grant, page: 0, pages: this.#debriefPages(), expiresAt: new Date(exp).toISOString() };
  }

  async debriefPage(token, page) {
    const g = await this.#grantFor(token);
    if (g.error) return g;
    if (!Number.isSafeInteger(page) || page < 0) return { error: 'bad_request', status: 400 };
    const pages = this.#debriefPages(), next = Math.min(page, pages - 1);
    this.ctx.storage.transactionSync(() => { this.#setMeta('debrief_grant', JSON.stringify({ ...g, page: next })); this.#bumpDisplay(); });
    this.#schedule(['display']);
    return { page: next, pages };
  }

  async debriefRevoke(token) {
    const g = await this.#grantFor(token);
    if (g.error) return { ok: true }; // already gone: idempotent
    this.ctx.storage.transactionSync(() => { this.sql.exec("DELETE FROM meta WHERE key = 'debrief_grant'"); this.#bumpDisplay(); });
    this.#schedule(['display']);
    return { ok: true };
  }

  /** The public ended display view for the same-PC relay: exactly what a network display receives, nothing private. */
  async debriefView(token) {
    const g = await this.#grantFor(token);
    if (g.error) return g;
    return { snapshot: this.#snapshotFor({ role: 'display', participantId: null, cred: null }) };
  }

  // ─── RPC: writes ────────────────────────────────────────────────────────────

  /** One command envelope (HTTP). Returns `{ receipt, snapshot? }`. */
  async command(token, body, supportedSchema = 1) {
    if (clientTooOld(this.state, supportedSchema)) return { error: 'client_upgrade_required', status: 409 };
    const who = await this.#who(token);
    if (who.error) return who;
    return this.#command(who, body);
  }

  #command(who, body) {
    const refuse = (reason) => {
      metric(this.env,{event:'receipt',reason:'rejected'});
      return {
      receipt: { v: WIRE_VERSION, t: 'receipt', clientEventId: body?.clientEventId ?? null, receipt: 'rejected', reason, revision: this.state.revision, epoch: this.state.epoch },
      snapshot: this.#snapshotFor(who),
      };
    };
    if (!this.#allow(who.cred)) return { ...refuse('rate_limited'), status: 429 };
    const p = parseCommandEnvelope(body, who.role);
    if (!p.ok) return refuse(p.error);
    const actor = who.role === 'participant' ? { role: 'participant', id: who.participantId } : { role: 'facilitator', id: FACILITATOR_ACTOR_ID };
    this.#finaliseLockIfDue(); // a closing window past its deadline locks before anything else is applied
    const event = buildEvent(p.envelope, { actor, at: new Date().toISOString(), newId: uuidv7 });
    if (event.type === 'lock') event.graceMs = this.lockGraceMs;
    if (event.type === 'undo' && !this.state.manual) {
      const action = this.state.teachingActions?.at(-1);
      if (action?.roundId) {
        event.sourceRound = readRoundEvidence(this.sql, action.roundId);
        event.seedResponseIds = Object.fromEntries(Object.keys(event.sourceRound?.responses ?? {}).map(id => [id, uuidv7()]));
        event.expiresAtMs = Number(this.#meta('expires_at'));
      }
    }
    // Live advances need the console's observed revision. Preserve a pre-progress accepted
    // receipt with an omitted field: dispatch still owns its same-ID fingerprint check.
    if (event.type === 'advance' && event.expectRevision === undefined && !this.#ledger().get(ledgerKey(event))) {
      return refuse('missing_expect_revision');
    }
    let r;
    try {
      r = this.#mutate(() => dispatch(hydrateRoomPresentation(this.sql, this.state), event, this.#ledger()), (res) => {
        // Takeover fences every other facilitator device for good, not just by epoch (red team P1-6).
        if (event.type === 'takeover' && res.effects[0]?.receipt === 'accepted') {
          this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE role = 'facilitator' AND token_sha256 != ? AND revoked_at IS NULL", new Date().toISOString(), who.cred);
        }
      });
    } catch (e) {
      if (e instanceof StateTooLarge) return refuse('room_state_too_large');
      throw e;
    }
    if (event.type === 'takeover' && r.effects[0]?.receipt === 'accepted') this.#closeSockets((a) => a.role === 'facilitator' && a.cred !== who.cred, 4004, 'taken_over');
    const receipt = receiptBody(r.effects.find((e) => e.type === 'receipt'), this.state);
    metric(this.env,{event:'receipt',reason:receipt.receipt});
    if (receipt.receipt === 'accepted' && ['vote', 'remove_participant'].includes(event.type)) this.#maybeAutoLock();
    // A refused command is answered with a fresh snapshot so the sender can recover (HANDOFF §epoch).
    return ['accepted', 'already_accepted'].includes(receipt.receipt) ? { receipt } : { receipt, snapshot: this.#snapshotFor(who) };
  }

  /** A manual segment, all-or-nothing (CASE-093/094/095). Facilitator only. */
  async manualSegment(token, body, supportedSchema = 1) {
    if (clientTooOld(this.state, supportedSchema)) return { error: 'client_upgrade_required', status: 409 };
    const who = await this.#who(token);
    if (who.error) return who;
    if (who.role !== 'facilitator') return { error: 'forbidden', status: 403 };
    const p = parseManualSegment(body);
    if (!p.ok) return { error: p.error, status: 400 };
    // Device time is trusted only within reason: never ahead of the server, or it would move the
    // room's clock, its end time and its deletion (red team P1-3).
    const limit = Date.now() + SEGMENT_FUTURE_SLACK_MS;
    if (p.events.some((e) => Date.parse(e.at) > limit)) return { error: 'event_time_in_future', status: 400 };
    const events = p.events.map(({ envelope, at }) => buildEvent(
      envelope.type === 'manual_marker' ? { ...envelope, text: '' } : envelope, // CASE-086: marker text never reaches the server
      { actor: { role: 'facilitator', id: FACILITATOR_ACTOR_ID }, at, newId: uuidv7 },
    ));
    let r;
    try {
      r = this.#mutate(() => {
        const res = applySegment(hydrateRoomPresentation(this.sql, this.state), events, this.#ledger());
        if (!res.ok) throw Object.assign(new Error('segment refused'), { refused: res });
        return { state: res.state, effects: [...res.effects, { type: 'broadcast', roles: ['facilitator', 'display', 'participant'] }] };
      });
    } catch (e) {
      if (e.refused) return { error: e.refused.reason, failedAt: e.refused.failedAt, status: 409 };
      if (e instanceof StateTooLarge) return { error: 'room_state_too_large', status: 409 };
      throw e;
    }
    const applied = r.effects.filter((e) => e.type === 'journal').length > 0 ? events.length : 0;
    return { ok: true, revision: this.state.revision, epoch: this.state.epoch, applied };
  }

  /** The facilitator typed a display's pair code: approve it in the Directory. The token is minted at pickup. */
  async approveDisplayPair(token, code) {
    const who = await this.#who(token);
    if (who.error) return who;
    if (who.role !== 'facilitator') return { error: 'forbidden', status: 403 };
    if (this.state.endedAt) return { error: 'room_ended', status: 410 };
    const res = await pairsDirectory(this.env).approvePair(code, this.state.sessionId);
    return res.error ? { error: res.error, status: 404 } : { ok: true };
  }

  /** Revoke every display token (an old projector on an unattended PC stops watching). */
  async revokeDisplays(token) {
    const who = await this.#who(token);
    if (who.error) return who;
    if (who.role !== 'facilitator') return { error: 'forbidden', status: 403 };
    this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE role = 'display' AND revoked_at IS NULL", new Date().toISOString());
    this.#closeSockets((a) => a.role === 'display', 4005, 'display_revoked');
    return { ok: true };
  }

  // ─── commit and fan-out ─────────────────────────────────────────────────────

  /**
   * Runs `step` (a dispatch that may write ledger rows) and persists its result in ONE transaction;
   * `also` adds writes that must commit with it. Then updates memory and fans out.
   */
  #mutate(step, also = () => {}) {
    this.#ensureMaintenance();
    let r;
    const wasEnded = Boolean(this.state.endedAt);
    const previousPhase = this.state.phase;
    // The cache keeps this transaction's outbox writes only if it commits (CASE-169).
    this.archiveWrites.transact(() => this.ctx.storage.transactionSync(() => {
      r = step();
      this.#persist(r, wasEnded);
      also(r);
      // Joins need their newly inserted credential hash in the same atomic outbox write.
      writeArchiveState(this.sql, r.state, Date.now(), this.archiveWrites);
      r.state = compactRoomState(r.state);
    }));
    this.#after(r, wasEnded, previousPhase);
    return r;
  }

  #persist({ state, effects }, wasEnded) {
    const journal = effects.filter((e) => e.type === 'journal');
    if (state === this.state && !journal.length && !effects.some((e) => e.type === 'display')) return;
    const { caseDoc, ...rest } = compactRoomState(state);
    const json = JSON.stringify(rest);
    if (utf8Bytes(json) > STATE_BUDGET_BYTES) throw new StateTooLarge();
    this.#setMeta('state', json);
    for (const e of journal) {
      this.sql.exec('INSERT INTO journal (seq, event_id, epoch, kind, payload, occurred_at, pending_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        e.seq, uuidv7(), e.epoch, e.kind, JSON.stringify(e.payload ?? {}), e.at, Date.now());
      if (e.kind === 'beat_entered' && !this.#meta('archive_started_at')) this.#setMeta('archive_started_at', e.at);
      // A removed participant's tokens die with them; their sockets are closed in #after.
      if (e.kind === 'participant_removed') this.sql.exec('UPDATE credentials SET revoked_at = ? WHERE participant_id = ?', new Date().toISOString(), e.payload.participantId);
    }
    // Deletion is timed by the SERVER clock, never the reducer's (red team P1-3).
    if (state.endedAt && !wasEnded) {
      const ended = Date.now();
      const recapDelete = ended + RECAP_TTL_MS;
      this.#setMeta('recap_delete_at', recapDelete);
      this.#setMeta('archive_end_pending_at', ended);
      if (this.#meta('portfolio_version_id')) this.#setMeta('portfolio_joined_count', Object.keys(state.participants).length);
      this.#setMeta('archive_ended_at', ended);
      this.#setMeta('archive_personal_delete_at', Math.min(recapDelete, Number(this.#meta('expires_at')) + RECAP_TTL_MS));
    }
  }

  #after({ state, effects }, wasEnded, previousPhase) {
    this.state = state;
    for (const e of effects) if (e.type === 'journal' && e.kind === 'participant_removed') this.#closeSockets((a) => a.participantId === e.payload.participantId, 4003, 'removed');
    if (state.endedAt && !wasEnded) {
      metric(this.env,{event:'room_ended'});
      // Armed in this same turn, before any await (red team P0-2). The code release is best effort:
      // an ended room refuses joins anyway, and the Directory sweeps expired codes.
      this.ctx.storage.setAlarm(Number(this.#meta('recap_delete_at')));
      directoryFor(this.env, state.joinCode).release(state.joinCode, state.sessionId).catch(() => {});
    }
    const roles = new Set(effects.filter((e) => e.type === 'broadcast').flatMap((e) => e.roles ?? ['facilitator', 'display', 'participant']));
    if (effects.some((e) => e.type === 'display')) { roles.add('display'); roles.add('facilitator'); }
    if (roles.size) this.#schedule(roles);
    this.#queueArchive(state.phase !== previousPhase);
    this.#armLockFinalise();
  }

  // ─── closing window (CASE-319) ──────────────────────────────────────────────

  /** A timer finalises the window on time; the alarm (#armAlarm folds the deadline in) survives eviction or a deploy. */
  #armLockFinalise() {
    const due = this.state?.round?.closing ? Date.parse(this.state.round.closing.closesAt) : 0;
    clearTimeout(this.lockTimer); this.lockTimer = null;
    if (!due) return;
    this.lockTimer = setTimeout(() => { this.lockTimer = null; this.#finaliseLockIfDue(); }, Math.max(0, due - Date.now()) + 25);
    this.#armAlarm();
  }

  #finaliseLockIfDue(now = Date.now()) {
    const closing = this.state?.round?.closing;
    if (!closing || this.state.phase !== 'responses_open' || Date.parse(closing.closesAt) > now) return;
    this.#systemCommand({ type: 'finalise_lock', actor: { role: 'facilitator', id: SYSTEM_LOCK_ACTOR } }, now);
  }

  /** Everyone connected has answered (the console's own k of m): open the automatic countdown. */
  #maybeAutoLock() {
    const s = this.state;
    if (!this.autoLockMs || s.phase !== 'responses_open' || !s.round || s.round.closing || s.round.keptOpen || s.autoLock === false || s.manual || s.clarification) return;
    if (!everyoneAnswered(s, this.#present())) return;
    this.#systemCommand({ type: 'lock', actor: { role: 'facilitator', id: SYSTEM_AUTO_LOCK_ACTOR }, graceMs: this.autoLockMs });
  }

  #systemCommand(fields, now = Date.now()) {
    try {
      this.#mutate(() => dispatch(hydrateRoomPresentation(this.sql, this.state),
        { ...fields, epoch: this.state.epoch, at: new Date(now).toISOString(), clientEventId: uuidv7() }, this.#ledger()));
    } catch (e) {
      if (!(e instanceof StateTooLarge)) throw e;
      log('room_system_command_refused', { type: fields.type, reason: 'room_state_too_large' });
    }
  }

  // ─── archive: never part of a command's response or transaction ─────────────

  #archiveEnabled() { if (this.state) this.#ensureMaintenance(); return Boolean(this.state && this.#meta('archive_session_id') === this.state.sessionId); }

  #armAlarm() {
    if (!this.state) return;
    const expires = Number(this.#meta('expires_at'));
    const hardDelete = expires + RECAP_TTL_MS;
    const lifecycle = this.state.endedAt ? Math.min(Number(this.#meta('recap_delete_at')) || hardDelete, hardDelete) : expires;
    let archiveDue = Number(this.#meta('archive_next_at') || 0);
    if (this.archiveTask && archiveDue && archiveDue <= Date.now()) {
      archiveDue = Date.now() + ARCHIVE_WATCHDOG_MS;
      this.#setMeta('archive_next_at', archiveDue);
    }
    const lockDue = this.state.round?.closing ? Date.parse(this.state.round.closing.closesAt) : 0;
    this.ctx.storage.setAlarm(earliestAlarm(lifecycle, archiveDue, lockDue));
  }

  #queueArchive(immediate) {
    if (!this.#archiveEnabled()) return; // A configured inline room still has no SQL session.
    if (this.archiveTask) { this.#armAlarm(); return; }
    if (!Number(this.#meta('archive_next_at') || 0) || immediate)
      this.#setMeta('archive_next_at', Date.now() + (immediate ? 0 : 1000));
    this.#armAlarm();
    if (immediate) this.ctx.waitUntil(this.flushArchive());
  }

  #archiveRetry() {
    if (!this.state) return;
    metric(this.env,{event:'archive_fail'});
    void this.observer.alert({kind:'archive_fail'});
    const attempt = Number(this.#meta('archive_attempt') || 0);
    this.#setMeta('archive_attempt', Math.min(attempt + 1, 30));
    this.#setMeta('archive_next_at', Date.now() + retryDelay(attempt));
    this.#armAlarm();
  }

  /** Trusted DO hook only; no HTTP route. One bounded RPC batch per attempt. */
  flushArchive() {
    if (!this.state || !this.#archiveEnabled()) return Promise.resolve();
    if (this.archiveTask) return this.archiveTask;
    void this.observer.archiveLag(this.archiveLag());
    this.#setMeta('archive_next_at', Date.now() + ARCHIVE_WATCHDOG_MS);
    this.#armAlarm();
    this.archiveTask = this.#sendArchive().catch(() => this.#archiveRetry()).finally(() => {
      this.archiveTask = null;
      this.#armAlarm();
    });
    return this.archiveTask;
  }

  async #sendArchive() {
    const sessionId = this.state.sessionId;
    const client = this.archiveClient ?? rpcClient(this.env,{onAlert:event=>this.observer.alert(event)});
    // Console layout v2: Debrief opens feedback before End. The session row follows the room's Debrief (set on entry,
    // cleared on Back to the case) before any batch, so the feedback page opens as soon as the room says so.
    const debrief = this.state.phase === 'debrief' && !this.state.endedAt ? '1' : '0';
    if (!this.state.endedAt && (this.#meta('archive_debrief_sent') ?? '0') !== debrief) {
      const marked = await client.call('set_session_debrief', { p_session_id: sessionId, p_on: debrief === '1' });
      if (!this.state || this.state.sessionId !== sessionId) return;
      if (!marked?.ok) { this.#archiveRetry(); return; }
      this.#setMeta('archive_debrief_sent', debrief);
    }
    let boundary = null;
    if (this.state.endedAt) {
      const ended = Number(this.#meta('archive_ended_at'));
      const cutoff = Number(this.#meta('archive_personal_delete_at'));
      if (!ended || !cutoff) throw new Error('Missing archive end boundary');
      boundary = { ended_at: new Date(ended).toISOString(), personal_data_delete_at: new Date(cutoff).toISOString() };
      if (this.#meta('archive_boundary_sent') !== '1') {
        const metadata = { status: 'live', ...boundary, participants: [], rounds: [], responses: [], events: [] };
        const result = await client.call('archive_session_batch', { p_session_id: sessionId, p_batch: metadata });
        if (!this.state || this.state.sessionId !== sessionId) return;
        if (!result?.ok || !Number.isSafeInteger(result.data) || result.data < 0) { this.#archiveRetry(); return; }
        this.#setMeta('archive_boundary_sent', '1');
        this.#setMeta('archive_attempt', 0);
        this.#setMeta('archive_next_at', Date.now() + 1000);
        this.#armAlarm();
        return; // The independently committed privacy boundary precedes every personal batch.
      }
    }
    const sent = archiveBatch(this.sql, this.state, this.#meta('archive_started_at'), boundary, Boolean(boundary));
    if (sent.rows) {
      const result = await client.call('archive_session_batch', { p_session_id: sessionId, p_batch: sent.batch });
      if (!this.state || this.state.sessionId !== sessionId) return;
      if (!result?.ok || !Number.isSafeInteger(result.data) || result.data < 0) { this.#archiveRetry(); return; }
      this.ctx.storage.transactionSync(() => acknowledgeBatch(this.sql, sent.marks));
    }
    if (!this.state) return;
    const remaining = Object.values(archiveCounts(this.sql, Boolean(boundary))).reduce((n, count) => n + count, 0);
    if (!remaining && this.state.endedAt && this.#meta('archive_end_sent') !== '1') {
      const ended = await client.call('end_session', { p_session_id: sessionId,
        p_final_revision: this.state.revision, p_final_epoch: this.state.epoch });
      if (!this.state || this.state.sessionId !== sessionId) return;
      if (!ended?.ok) { this.#archiveRetry(); return; }
      this.#setMeta('archive_end_sent', '1');
    }
    // Only newly pinned rooms attest the exact final source. Legacy rooms remain explicitly limited.
    const versionId = this.#meta('portfolio_version_id');
    if (!remaining && this.state.endedAt && versionId && this.#meta('portfolio_manifest_sent') !== '1') {
      const proof = await client.call('finalize_session_portfolio', { p_session_id: sessionId,
        p_version_id: versionId, p_revision: this.state.revision, p_epoch: this.state.epoch,
        p_seq: this.state.revision, p_round_count: this.sql.exec('SELECT count(*) AS n FROM rounds').toArray()[0].n,
        p_joined: Number(this.#meta('portfolio_joined_count') ?? Object.keys(this.state.participants).length) });
      if (!this.state || this.state.sessionId !== sessionId) return;
      if (!proof?.ok || proof.data !== true) { this.#archiveRetry(); return; }
      this.#setMeta('portfolio_manifest_sent', '1');
    }
    this.#setMeta('archive_attempt', 0);
    this.#setMeta('archive_next_at', remaining ? Date.now() + 1000 : 0);
    this.#armAlarm();
  }

  /** Metrics hook for card 16; seconds, no identity or content. */
  archiveLag() {
    if (!this.state || !this.#archiveEnabled()) return 0;
    const now = Date.now(), lag = archiveLag(this.sql, now, Boolean(this.state.endedAt), Number(this.#meta('archive_ended_at') || 0));
    const end = Number(this.#meta('archive_end_pending_at') || 0);
    return this.state.endedAt && this.#meta('archive_end_sent') !== '1' && end ? Math.max(lag, (now - end) / 1000) : lag;
  }

  #archiveDeleteAlert() {
    if (!this.#archiveEnabled()) return;
    const counts = { ...archiveCounts(this.sql), endSession: this.state.endedAt && this.#meta('archive_end_sent') !== '1' ? 1 : 0 };
    if (!Object.values(counts).some(count => count > 0) || !this.onArchiveAlert) return;
    try { Promise.resolve(this.onArchiveAlert({ kind: 'archive_deleted_unsent', counts })).catch(() => {}); }
    catch { /* Delivery cannot prevent personal-data deletion. */ }
  }

  /** Participant ids connected now: an open socket, or HTTP activity within PRESENCE_MS. Never stored. */
  #present() {
    const now = Date.now();
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a?.role === 'participant' && a.participantId) ids.add(a.participantId); }
    for (const [pid, at] of this.seen) { if (now - at <= PRESENCE_MS) ids.add(pid); else this.seen.delete(pid); }
    return ids;
  }

  /** `shared` is one broadcast's phone timeline (#flush), reused by every phone's projection (CASE-281). */
  #snapshotFor(who, shared = null) {
    // Presence is an input to the projection, never reducer state, so the reducer stays pure (P1-7).
    const inputs = who.role === 'participant' ? (shared ? { timeline: shared.timeline } : {}) : { present: this.#present() };
    if (who.role === 'facilitator' && this.state.phase === 'debrief') { const exp = Number(this.#meta('expires_at')); if (exp > 0) inputs.roomExpiresAt = new Date(exp).toISOString(); }
    // Card 40d: a live paging grant puts the shown results and its page on the ended projector (red-team R4).
    const grant = who.role === 'display' && this.state.endedAt ? this.#grant() : null;
    if (grant) Object.assign(inputs, { debriefResults: true, debriefPage: grant.page });
    // Card 40 slice 6: at End the console derives its counts-only debrief from its mirror before the pack purge (I1), so
    // the facilitator's ended snapshot carries every closed round's aggregate. The mirror never reaches another role.
    const ended = who.role === 'facilitator' && this.state.endedAt;
    // Console layout v2: in Debrief the projector pages the shown results and the console reviews every decided round,
    // so both read the closed aggregates too (phones keep their own recap, built from their answers).
    const debrief = this.state.phase === 'debrief' && who.role !== 'participant';
    // Hydration nulls every compacted round but the latest, so the ended aggregates are read after it.
    const hydrated = hydrateRoomPresentation(this.sql, this.state, who.participantId);
    // Room PDFs v2 (AS-176): an ended phone's recap carries the split of every round the room was shown, so its rounds get the
    // shown aggregates back too (resolved and shown only, the ended debrief's rule; never `all`). Debrief gives phones the
    // same recap before End.
    const shownToPhone = who.role === 'participant' && (this.state.endedAt || this.state.phase === 'debrief');
    // CASE-327: the debrief pages every decided round's result, so the projector and console read every closed aggregate.
    const presented = grant || ended || debrief ? this.#withShownAggregates(hydrated, true)
      : shownToPhone ? this.#withShownAggregates(hydrated) : hydrated;
    const body = snapshotBody(this.state, project(presented, who.role, who.participantId, inputs));
    if (who.role === 'facilitator') { // CASE-092: the console's mirror; never to display or phones
      const { caseDoc, ...mirror } = presented;
      body.mirror = mirror;
    }
    return body;
  }

  #schedule(roles) {
    for (const r of roles) this.pendingRoles.add(r);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.#flush(), this.coalesceMs);
  }

  /** One projection per audience per flush, shared by sockets and long-poll waiters. */
  #flush() {
    this.flushTimer = null;
    const roles = this.pendingRoles;
    this.pendingRoles = new Set();
    if (!this.state) return;
    const cache = new Map();
    // Every phone's timeline is the same (CASE-281): build and serialise it once for this flush, which is synchronous,
    // so the state cannot move under it.
    let shared = null;
    const phoneTimeline = () => {
      if (!shared) { const timeline = participantTimeline(this.state); shared = { timeline, text: JSON.stringify(timeline) }; }
      return shared;
    };
    const textFor = (who) => {
      const key = who.role === 'participant' ? `p:${who.participantId}` : who.role;
      if (!cache.has(key)) {
        const phone = who.role === 'participant' ? phoneTimeline() : null;
        cache.set(key, snapshotText(this.#snapshotFor(who, phone), phone));
      }
      return cache.get(key);
    };
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment();
      if (!who?.role || !roles.has(who.role)) continue;
      try { ws.send(textFor(who)); } catch { /* closing */ }
    }
    for (const w of [...this.waiters]) {
      if (!roles.has(w.who.role)) continue;
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.resolve(textFor(w.who));
    }
  }

  #closeSockets(match, code, reason) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.role && match(a)) {
        try { ws.send(JSON.stringify({ v: WIRE_VERSION, t: 'error', error: reason })); ws.close(code, reason); } catch { /* gone */ }
      }
    }
    for (const w of [...this.waiters]) if (match(w.who)) { clearTimeout(w.timer); this.waiters.delete(w); w.resolve(null); }
  }

  // ─── alarms (CASE-073) ──────────────────────────────────────────────────────

  async alarm() {
    if (!this.state) return;
    // An over-budget cold state cannot be re-persisted (CASE-155), but its personal data must
    // still be deleted on time: deletion never depends on maintenance succeeding.
    let maintained = true;
    try { this.#ensureMaintenance(); }
    catch (error) {
      if (!(error instanceof StateTooLarge) && !(error instanceof EvidenceIncomplete)) throw error;
      maintained = false;
      log('room_maintenance_refused', { reason: error instanceof EvidenceIncomplete ? 'incomplete_room_evidence' : 'room_state_too_large' });
    }
    const now = Date.now();
    const expires = Number(this.#meta('expires_at'));
    const hardDelete = expires + RECAP_TTL_MS; // personal data never outlives expiry + 24 h, whatever happened
    let del = Number(this.#meta('recap_delete_at') || 0);
    if ((del && now >= del) || now >= hardDelete) {
      if (maintained) this.#archiveDeleteAlert();
      this.#closeSockets(() => true, 4010, 'room_deleted');
      this.state = null; // Fence in-flight acknowledgements before any deletion await.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      // Defence in depth: a recreated room has fresh ids, so stale entries could never match.
      this.archiveWrites = new ArchiveWriteCache();
      return;
    }
    if (!maintained) {
      // No expiry end or archive can commit; wake only for the deletion deadline (no hot loop).
      await this.ctx.storage.setAlarm(Math.min(del || hardDelete, hardDelete));
      return;
    }
    this.#finaliseLockIfDue(now);
    this.sql.exec('DELETE FROM receipts WHERE at < ?', new Date(now - RECEIPT_TTL_MS).toISOString());
    if (this.state.endedAt && !del) { del = now + RECAP_TTL_MS; this.#setMeta('recap_delete_at', del); } // repair
    if (!this.state.endedAt && now >= expires) {
      try {
        this.#mutate(() => dispatch(this.state, { type: 'end', epoch: this.state.epoch, actor: { role: 'facilitator', id: 'system:expiry' }, at: new Date(now).toISOString() }, this.#ledger()));
        del = Number(this.#meta('recap_delete_at'));
      } catch {
        log('room_expiry_end_failed',{reason:'internal'});
      }
    }
    const archiveDue = Number(this.#meta('archive_next_at') || 0);
    if (archiveDue && archiveDue <= now) this.ctx.waitUntil(this.flushArchive());
    this.#armAlarm();
  }

  // ─── WebSocket (hibernatable) ───────────────────────────────────────────────

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return withSecurityHeaders(new Response('expected a websocket upgrade', { status: 426 }), 'ws-refusal', this.env);
    if (!this.state) return withSecurityHeaders(new Response('unknown room', { status: 404 }), 'ws-refusal', this.env);
    this.#ensureMaintenance();
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return withSecurityHeaders(new Response('room is full', { status: 503, headers: { 'retry-after': '5' } }), 'ws-refusal', this.env);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({}); // unauthenticated until `hello`; the token is never stored here
    const ws = pair[1];
    setTimeout(() => { if (!ws.deserializeAttachment()?.role) { try { ws.close(4008, 'hello_timeout'); } catch { /* gone */ } } }, HELLO_DEADLINE_MS);
    return withSecurityHeaders(new Response(null, { status: 101, webSocket: pair[0] }), 'json', this.env);
  }

  async webSocketMessage(ws, message) {
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* closing */ } };
    if (typeof message !== 'string') { ws.close(1003, 'binary_not_supported'); return; }
    if (message.length > MAX_FRAME_BYTES) { ws.close(1009, 'frame_too_large'); return; }
    if (!this.state) { ws.close(4010, 'room_deleted'); return; }
    this.#ensureMaintenance();
    const p = parseClientFrame(message);
    if (!p.ok) return send({ v: WIRE_VERSION, t: 'error', error: p.error });
    const f = p.frame;
    if (f.t === 'ping') return ws.send(PONG_FRAME); // only reached if auto-response is bypassed
    if (f.t === 'hello') {
      if (clientTooOld(this.state, f.supportedSchema ?? 1)) { send({ v: WIRE_VERSION, t: 'error', error: 'client_upgrade_required' }); ws.close(4002, 'client_upgrade_required'); return; }
      const who = await this.#who(f.token);
      if (who.error) { send({ v: WIRE_VERSION, t: 'error', error: who.error }); ws.close(4001, who.error); return; }
      ws.serializeAttachment({ role: who.role, participantId: who.participantId, cred: who.cred });
      send({ v: WIRE_VERSION, t: 'welcome', role: who.role, participantId: who.participantId });
      if (who.role === 'participant') this.#schedule(['facilitator', 'display']); // `{k} of {m}`: m just grew
      return send(this.#snapshotFor(who));
    }
    const who = ws.deserializeAttachment();
    if (!who?.role) return send({ v: WIRE_VERSION, t: 'error', error: 'say_hello_first' });
    // The credential may have been revoked since hello (removal, takeover, display revoke).
    const live = this.sql.exec('SELECT revoked_at FROM credentials WHERE token_sha256 = ?', who.cred).toArray()[0];
    if (!live || live.revoked_at) { ws.close(4001, 'unauthorised'); return; }
    // The app-level sync (P1-1): answered by the room itself, unlike the auto-answered ping, so a reply
    // proves the whole path. The client compares the revisions and refetches if it missed a broadcast.
    if (f.t === 'sync') return send(syncBody(this.state));
    if (f.t === 'command') {
      const r = this.#command(who, { v: WIRE_VERSION, ...f.body });
      send(r.receipt);
      if (r.snapshot) send(r.snapshot);
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'closed'); } catch { /* already closed */ }
    if (ws.deserializeAttachment()?.role === 'participant' && this.state) this.#schedule(['facilitator', 'display']); // m may shrink
  }
}
