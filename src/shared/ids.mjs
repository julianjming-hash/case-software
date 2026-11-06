// src/shared/ids.mjs — identifiers for Case.
//
// Two kinds of identifier, never mixed (docs/ARCHITECTURE.md §Identifiers):
//   1. UUIDv7 (RFC 9562) — every database row and every case-document item. Machine
//      identity: time-ordered (btree-friendly), generated offline on any client.
//   2. Short codes — Crockford base32, upper case. Human/QR identity: join codes (6)
//      and pairing codes (8). Resolved server-side to a UUID; never a primary key.
//
// Web Crypto only (works in Workers without nodejs_compat, browsers, and Node ≥ 19).

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Crockford base32 alphabet: no I, L, O, U. Every character is QR-alphanumeric. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const JOIN_CODE_LENGTH = 6;
export const PAIR_CODE_LENGTH = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastMs = -1;
let lastSeq = 0;

/**
 * RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version 7, 12-bit rand_a, variant 10, 62-bit rand_b.
 * rand_a doubles as a per-millisecond counter (RFC 9562 §6.2 method 1), so ids generated in
 * the same millisecond by this process stay strictly increasing.
 * @param {number} [nowMs] override for tests
 */
export function uuidv7(nowMs = Date.now()) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ms = nowMs;
  let seq;
  if (ms <= lastMs) {
    ms = lastMs;
    seq = lastSeq + 1;
    if (seq > 0xfff) { ms = lastMs + 1; seq = b[6] & 0x07; }
  } else {
    seq = ((b[6] & 0x0f) << 8 | b[7]) & 0x7ff; // start in the lower half to leave room to count
  }
  lastMs = ms;
  lastSeq = seq;
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = Array.from(b, (x) => HEX[x]).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Lower-case canonical UUID of any version. */
export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Lower-case canonical UUIDv7. New Case ids must pass this. */
export function isUuidV7(s) {
  return typeof s === 'string' && UUID_V7_RE.test(s);
}

/** Creation time embedded in a UUIDv7, in unix ms. */
export function uuidv7Time(id) {
  if (!isUuidV7(id)) throw new TypeError(`not a UUIDv7: ${id}`);
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** Uniform random Crockford code (rejection-free: 256 is a multiple of 32). */
export function randomCode(length) {
  const b = new Uint8Array(length);
  crypto.getRandomValues(b);
  let out = '';
  for (const x of b) out += CROCKFORD[x & 31];
  return out;
}

export const newJoinCode = () => randomCode(JOIN_CODE_LENGTH);
export const newPairCode = () => randomCode(PAIR_CODE_LENGTH);

/**
 * Normalise human input to a canonical code: upper case, drop spaces/hyphens,
 * read O as 0 and I/L as 1 (Crockford). Returns null if anything else remains invalid.
 * @param {string} input
 * @param {number} length expected length
 */
export function normalizeCode(input, length) {
  if (typeof input !== 'string') return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== length) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

/** Display form for reading aloud / typing: "7K3QX9" → "7K3 QX9". */
export function formatCode(code) {
  const h = Math.ceil(code.length / 2);
  return `${code.slice(0, h)} ${code.slice(h)}`;
}

/** 256-bit capability token (base64url). Only its SHA-256 is ever stored. */
export function newCapabilityToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Canonical base64url encoding of a 256-bit opaque capability, never a public identity. */
export const isCapabilityToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

/** SHA-256 of a capability token as lower-case hex (matches Postgres `bytea` via decode(..., 'hex')). */
export async function hashToken(token) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), (x) => HEX[x]).join('');
}
