// src/worker/directory-do.mjs: the directory (Phase 1, CASE-074), one class, three kinds of instance:
//
//   • `directory-codes-<c>`: join code → session id, sharded by the code's first character (32
//     shards), so no single object carries every room's joins (runtime red team P1-1);
//   • `directory-pairs`: display-pair requests, number-matched, single use, 5 minutes. Only the
//     approval is stored; the room mints the display token at pickup, so no usable token is ever
//     held here (red team P2-1);
//   • `directory-limits-<n>`: failed join lookups per client prefix (an IPv6 /64 or an IPv4 address),
//     sharded by a hash of the prefix. Successful joins are never counted here, so 50 phones behind
//     one hospital NAT still join; floods are cut earlier by the Worker's rate-limit bindings.
// Called only by the Worker and the room DOs, over Durable Object RPC.
import { withSecurityHeaders } from './headers.mjs';
import { challengeRequired as requiresChallenge, recordChallengeFailure, resetChallenge as resetChallengeState } from './challenge-counter.mjs';
import { DurableObject } from 'cloudflare:workers';
import { newPairCode, newCapabilityToken, hashToken, uuidv7 } from '../shared/ids.mjs';

const PAIR_TTL_MS = 5 * 60 * 1000;
export const FAIL_WINDOW_MS = 60 * 1000;
export const FAIL_LIMIT = 20; // failed lookups per prefix per minute
const LIMIT_SHARDS = 16;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS codes (
  code        TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS pairs (
  pair_id        TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  secret_sha256  TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  session_id     TEXT             -- set on approval; the row is deleted on pickup (single use) or expiry
) STRICT;
CREATE TABLE IF NOT EXISTS console_pairs (
  pair_id        TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  secret_sha256  TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  browser        TEXT NOT NULL,
  country        TEXT NOT NULL,
  city           TEXT NOT NULL,
  requested_at   TEXT NOT NULL,
  session_id     TEXT,
  user_id        TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS challenges (
  prefix        TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  n             INTEGER NOT NULL CHECK(n BETWEEN 1 AND 3),
  expires_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS challenges_expiry_idx ON challenges(expires_at);
CREATE TABLE IF NOT EXISTS failures (
  prefix        TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  n             INTEGER NOT NULL
) STRICT;
`;

/**
 * Every Durable Object Case creates is placed in Oceania (spec red team 2, P1-5; CASE-107). A hint
 * only applies when the object is first created, and Cloudflare offers no Australian jurisdiction
 * guarantee, so the privacy notice still says Cloudflare may process data outside Australia.
 */
export const LOCATION_HINT = Object.freeze({ locationHint: 'oc' });
const named = (ns, name) => ns.get(ns.idFromName(name), LOCATION_HINT);
/** The number of join-code shards (first Crockford character), for the deploy guard's live count. */
export const CODE_SHARDS = Object.freeze([...'0123456789ABCDEFGHJKMNPQRSTVWXYZ']);

/** The codes shard that owns a join code. */
export const directoryFor = (env, code) => named(env.DIRECTORY, `directory-codes-${String(code)[0] ?? '0'}`);
export const pairsDirectory = (env) => named(env.DIRECTORY, 'directory-pairs');
export function limitsFor(env, prefix) {
  let h = 0x811c9dc5;
  for (let i = 0; i < prefix.length; i++) { h ^= prefix.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return named(env.DIRECTORY, `directory-limits-${h % LIMIT_SHARDS}`);
}
/** The room Durable Object for a session id, placed like the rest. */
export const roomFor = (env, sessionId) => named(env.ROOM, sessionId);

/** Rate-limit key: an IPv6 address's /64, or the IPv4 address (red team P1-2). */
export function clientPrefix(addr) {
  const a = String(addr ?? '').trim().toLowerCase();
  if (!a.includes(':')) return a || 'unknown';
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class DirectoryDO extends DurableObject {
  fetch() {
    return withSecurityHeaders(new Response('not found', { status: 404 }), 'json', this.env);
  }

  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    if (!this.sql.exec('PRAGMA table_info(codes)').toArray().some(column => column.name === 'registered_at'))
      this.sql.exec('ALTER TABLE codes ADD COLUMN registered_at INTEGER');
  }

  // ── join codes (codes shards) ──

  /** Claim a join code for a session. Returns false on a collision (the caller draws another). */
  async register(code, sessionId, expiresAtMs) {
    this.#sweep();
    if (this.sql.exec('SELECT 1 FROM codes WHERE code = ?', code).toArray().length) return false;
    this.sql.exec('INSERT INTO codes (code, session_id, expires_at, registered_at) VALUES (?, ?, ?, ?)', code, sessionId, expiresAtMs, Date.now());
    await this.#arm(expiresAtMs);
    return true;
  }

  /** Release a code when its room ends. Only that session's mapping is removed. */
  release(code, sessionId) {
    this.sql.exec('DELETE FROM codes WHERE code = ? AND session_id = ?', code, sessionId);
  }

  /** Join codes still live in this shard (a room's code is released when it ends): the deploy guard's count. */
  countLive(nowMs = Date.now()) {
    return this.sql.exec('SELECT count(*) AS n FROM codes WHERE expires_at > ?', nowMs).toArray()[0]?.n ?? 0;
  }

  /** Server-only bounded admin inventory. Historical registration age remains explicitly unknown. */
  adminInventory(input, nowMs = Date.now()) {
    const validCode = value => typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(value);
    if (!input || Object.keys(input).some(key => !['limit','afterCode'].includes(key)) ||
        !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
        !(input.afterCode === null || validCode(input.afterCode))) return { error: 'bad_request', status: 400 };
    const found = this.sql.exec('SELECT code,session_id,expires_at,registered_at FROM codes WHERE expires_at > ? AND (? IS NULL OR code > ?) ORDER BY code ASC LIMIT ?',
      nowMs, input.afterCode, input.afterCode, input.limit + 1).toArray();
    const rows = found.slice(0,input.limit).map(row => ({code:row.code,sessionId:row.session_id,
      expiresAt:new Date(row.expires_at).toISOString(),registeredAt:row.registered_at === null ? null : new Date(row.registered_at).toISOString()}));
    return {rows,nextCode:found.length > input.limit ? rows.at(-1).code : null};
  }

  /** Resolve a code: `{ sessionId }` or `{ error: 'unknown_code' }`. */
  lookup(code, nowMs = Date.now()) {
    const row = code ? this.sql.exec('SELECT session_id, expires_at FROM codes WHERE code = ?', code).toArray()[0] : null;
    return row && row.expires_at > nowMs ? { sessionId: row.session_id } : { error: 'unknown_code' };
  }

  // ── failed lookups (limits shards) ──

  blocked(prefix, nowMs = Date.now()) {
    const f = this.sql.exec('SELECT window_start, n FROM failures WHERE prefix = ?', prefix).toArray()[0];
    return Boolean(f && nowMs - f.window_start < FAIL_WINDOW_MS && f.n >= FAIL_LIMIT);
  }

  async fail(prefix, nowMs = Date.now()) {
    const f = this.sql.exec('SELECT window_start FROM failures WHERE prefix = ?', prefix).toArray()[0];
    if (f && nowMs - f.window_start < FAIL_WINDOW_MS) this.sql.exec('UPDATE failures SET n = n + 1 WHERE prefix = ?', prefix);
    else this.sql.exec('INSERT OR REPLACE INTO failures (prefix, window_start, n) VALUES (?, ?, 1)', prefix, nowMs);
    await this.#arm(nowMs + FAIL_WINDOW_MS);
  }

  /** Wrong-code challenge state; a correct-code join never calls these methods. */
  challengeRequired(prefix, nowMs = Date.now()) {
    const row = this.sql.exec('SELECT window_start,n,expires_at FROM challenges WHERE prefix = ?', prefix).toArray()[0];
    return requiresChallenge(row ? { windowStart: row.window_start, n: row.n, expiresAt: row.expires_at } : null, nowMs);
  }

  async failChallenge(prefix, nowMs = Date.now()) {
    this.sql.exec('DELETE FROM challenges WHERE expires_at <= ?', nowMs);
    const row = this.sql.exec('SELECT window_start,n,expires_at FROM challenges WHERE prefix = ?', prefix).toArray()[0];
    const next = recordChallengeFailure(row ? { windowStart: row.window_start, n: row.n, expiresAt: row.expires_at } : null, nowMs);
    this.sql.exec('INSERT OR REPLACE INTO challenges(prefix,window_start,n,expires_at) VALUES(?,?,?,?)',
      prefix, next.windowStart, next.n, next.expiresAt);
    await this.#arm(next.expiresAt);
  }

  resetChallenge(prefix) {
    this.sql.exec('DELETE FROM challenges WHERE prefix = ?', prefix);
    return resetChallengeState();
  }

  // ── display pairing (the pairs instance) ──

  /** A display window asks to be paired. It shows `code`; it polls with `secret`. */
  async createPair(nowMs = Date.now()) {
    this.#sweep(nowMs);
    for (let i = 0; i < 8; i++) {
      const code = newPairCode();
      if (this.sql.exec('SELECT 1 FROM pairs WHERE code = ?', code).toArray().length) continue;
      const pairId = uuidv7();
      const secret = newCapabilityToken();
      const expiresAt = nowMs + PAIR_TTL_MS;
      this.sql.exec('INSERT INTO pairs (pair_id, code, secret_sha256, expires_at) VALUES (?, ?, ?, ?)', pairId, code, await hashToken(secret), expiresAt);
      await this.#arm(expiresAt);
      return { pairId, code, secret, expiresAt: new Date(expiresAt).toISOString() };
    }
    throw new Error('pair code space exhausted');
  }

  /** The facilitator typed the display's code: bind the request to the room. */
  approvePair(code, sessionId, nowMs = Date.now()) {
    const row = this.sql.exec('SELECT pair_id, expires_at, session_id FROM pairs WHERE code = ?', code).toArray()[0];
    if (!row || row.expires_at <= nowMs) return { error: 'unknown_or_expired_code' };
    if (row.session_id) return { error: 'already_paired' };
    this.sql.exec('UPDATE pairs SET session_id = ? WHERE pair_id = ?', sessionId, row.pair_id);
    return { ok: true };
  }

  /**
   * The display polls with its secret. Once approved, the request is consumed (single use) and the
   * caller, the Worker, asks the room for a display token.
   */
  async pollPair(pairId, secret, nowMs = Date.now()) {
    const row = this.sql.exec('SELECT secret_sha256, expires_at, session_id FROM pairs WHERE pair_id = ?', pairId).toArray()[0];
    if (!row || row.secret_sha256 !== (await hashToken(secret ?? ''))) return { error: 'unknown_pair' };
    if (row.expires_at <= nowMs) return { error: 'expired' };
    if (!row.session_id) return { pending: true, expiresAt: new Date(row.expires_at).toISOString() };
    this.sql.exec('DELETE FROM pairs WHERE pair_id = ?', pairId);
    return { approved: true, sessionId: row.session_id };
  }

  // ── shared-PC console pairing (separate from display pairs) ──

  async createConsolePair(details, nowMs = Date.now()) {
    this.#sweep(nowMs);
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = newPairCode();
      if (this.sql.exec('SELECT 1 FROM console_pairs WHERE code = ?', code).toArray().length) continue;
      const pairId = uuidv7(), secret = newCapabilityToken(), expiresAt = nowMs + PAIR_TTL_MS;
      this.sql.exec(`INSERT INTO console_pairs
        (pair_id, code, secret_sha256, expires_at, browser, country, city, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, pairId, code, await hashToken(secret), expiresAt,
      details.browser, details.country, details.city, details.requestedAt);
      await this.#arm(expiresAt);
      return { pairId, code, secret, expiresAt: new Date(expiresAt).toISOString() };
    }
    throw new Error('pair code space exhausted');
  }

  previewConsolePair(code, nowMs = Date.now()) {
    const row = this.sql.exec(`SELECT browser, country, city, requested_at, expires_at, session_id
      FROM console_pairs WHERE code = ?`, code).toArray()[0];
    if (!row || row.expires_at <= nowMs || row.session_id) return { error: 'unknown_or_expired_code' };
    return { browser: row.browser, country: row.country, city: row.city,
      requestedAt: row.requested_at, expiresAt: new Date(row.expires_at).toISOString() };
  }

  approveConsolePair(code, sessionId, userId, nowMs = Date.now()) {
    const row = this.sql.exec('SELECT expires_at, session_id FROM console_pairs WHERE code = ?', code).toArray()[0];
    if (!row || row.expires_at <= nowMs) return { error: 'unknown_or_expired_code' };
    if (row.session_id) return { error: 'already_paired' };
    this.sql.exec('UPDATE console_pairs SET session_id = ?, user_id = ? WHERE code = ?', sessionId, userId, code);
    return { ok: true };
  }

  async pollConsolePair(pairId, secret, nowMs = Date.now()) {
    const given = await hashToken(secret ?? '');
    // Hashing yields: two pickups can overlap here. Read and consume in one
    // synchronous turn after the await so only one can observe the approved row.
    const row = this.sql.exec('SELECT secret_sha256, expires_at, session_id, user_id FROM console_pairs WHERE pair_id = ?', pairId).toArray()[0];
    if (!row) return { error: 'unknown_pair' };
    let difference = 0;
    for (let i = 0; i < row.secret_sha256.length; i++) difference |= row.secret_sha256.charCodeAt(i) ^ given.charCodeAt(i);
    if (difference) return { error: 'unknown_pair' };
    if (row.expires_at <= Math.max(nowMs, Date.now())) return { error: 'expired' };
    if (!row.session_id) return { pending: true, expiresAt: new Date(row.expires_at).toISOString() };
    this.sql.exec('DELETE FROM console_pairs WHERE pair_id = ?', pairId);
    return { approved: true, sessionId: row.session_id, userId: row.user_id };
  }

  // ── housekeeping ──

  async alarm() {
    const now = Date.now();
    this.#sweep(now);
    const next = this.sql.exec(`SELECT min(t) AS t FROM (
      SELECT min(expires_at) AS t FROM codes UNION ALL SELECT min(expires_at) FROM pairs
      UNION ALL SELECT min(expires_at) FROM console_pairs
      UNION ALL SELECT min(window_start) + ${FAIL_WINDOW_MS} FROM failures
      UNION ALL SELECT min(expires_at) FROM challenges)`).toArray()[0]?.t;
    if (next) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  #sweep(nowMs = Date.now()) {
    this.sql.exec('DELETE FROM codes WHERE expires_at <= ?', nowMs);
    this.sql.exec('DELETE FROM pairs WHERE expires_at <= ?', nowMs);
    this.sql.exec('DELETE FROM console_pairs WHERE expires_at <= ?', nowMs);
    this.sql.exec('DELETE FROM failures WHERE window_start <= ?', nowMs - FAIL_WINDOW_MS);
    this.sql.exec('DELETE FROM challenges WHERE expires_at <= ?', nowMs);
  }

  async #arm(atMs) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || atMs < cur) await this.ctx.storage.setAlarm(atMs);
  }
}
