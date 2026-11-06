// Facilitator Supabase JWTs and room capability tokens use Authorization, never URLs.
// Worker runtime: Web APIs only.
import { isUuid } from '../shared/ids.mjs';
import { supabaseConfig } from './supabase-keys.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const TTL_MS = 10 * 60_000;
const REFRESH_MS = 60_000;
const FETCH_MS = 3_000;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_KEYS = 20;
const cache = new Map(); // JWKS URL → { keys, expiresAt, retryAfter, lastUnknownRefresh, pending }

export class AuthUnavailableError extends Error {
  constructor() { super('auth_unavailable'); this.name = 'AuthUnavailableError'; this.code = 'auth_unavailable'; }
}

/** The bearer token of a request, or null. */
export function bearer(request) {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(h);
  return m ? m[1] : null;
}

function b64urlDecode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw Error('malformed');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function validKid(kid) { return typeof kid === 'string' && kid.length > 0 && kid.length <= 128 && /^[A-Za-z0-9_-]+$/.test(kid); }
function specFor(jwk) {
  if (!validKid(jwk?.kid) || (jwk.use && jwk.use !== 'sig') || (jwk.key_ops && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))) return null;
  if (jwk.alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string') return { importAlgorithm: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } };
  if (jwk.alg === 'RS256' && jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string') return { importAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyAlgorithm: 'RSASSA-PKCS1-v1_5' };
  return null;
}

async function readLimited(response) {
  if (!response?.ok || Number(response.headers.get('content-length') || 0) > MAX_JWKS_BYTES || !response.body) throw Error('JWKS failed');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JWKS_BYTES) { await reader.cancel(); throw Error('JWKS too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(dec.decode(bytes));
}

async function fetchKeys(url, fetchJwks) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchJwks(url, { signal: controller.signal, redirect: 'manual' });
        const jwks = await readLimited(response);
        if (!Array.isArray(jwks?.keys) || jwks.keys.length > MAX_KEYS) throw Error('Invalid JWKS');
        const keys = new Map();
        for (const jwk of jwks.keys) {
          const spec = specFor(jwk);
          if (!spec || keys.has(jwk.kid)) throw Error('Invalid JWKS key');
          const key = await crypto.subtle.importKey('jwk', jwk, spec.importAlgorithm, false, ['verify']);
          keys.set(jwk.kid, { key, alg: jwk.alg, verifyAlgorithm: spec.verifyAlgorithm });
        }
        return keys;
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(Error('JWKS timeout')); }, FETCH_MS); }),
    ]);
  } finally { clearTimeout(timeout); }
}

// A shared fetch is the I/O of the request that started it. Workers cancel that request's I/O and timers when it
// finishes or its client disconnects, so the shared promise may never settle (2026-10-17 incident). Waiters keep
// their own deadline, and a fetch older than its own deadline is replaced rather than trusted.
const ABANDONED_MS = FETCH_MS + 1_000;
function ownDeadline(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('JWKS wait timeout')), FETCH_MS); })])
    .finally(() => clearTimeout(timer));
}

async function getKeys(url, kid, nowMs, fetchJwks) {
  let entry = cache.get(url);
  if (!entry) { entry = { keys: null, expiresAt: 0, retryAfter: 0, lastUnknownRefresh: -Infinity, pending: null, pendingSince: 0 }; cache.set(url, entry); }
  if (entry.pending && nowMs - entry.pendingSince >= ABANDONED_MS) entry.pending = null;
  const stale = nowMs >= entry.expiresAt;
  const unknown = kid !== null && entry.keys && !entry.keys.has(kid);
  if ((stale || (unknown && nowMs - entry.lastUnknownRefresh >= REFRESH_MS)) && nowMs >= entry.retryAfter && !entry.pending) {
    if (unknown && !stale) entry.lastUnknownRefresh = nowMs;
    entry.pendingSince = nowMs;
    const pending = entry.pending = fetchKeys(url, fetchJwks).then((keys) => {
      entry.keys = keys;
      entry.expiresAt = nowMs + TTL_MS;
      entry.retryAfter = 0;
      if (kid !== null && !keys.has(kid)) entry.lastUnknownRefresh = nowMs;
      return keys;
    }).catch((error) => {
      entry.retryAfter = nowMs + REFRESH_MS;
      throw error;
    }).finally(() => { if (entry.pending === pending) entry.pending = null; });
  }
  if (entry.pending) {
    try { await ownDeadline(entry.pending); } catch { if (!entry.keys) throw new AuthUnavailableError(); }
  }
  if (!entry.keys) throw new AuthUnavailableError();
  return entry.keys;
}

const hmacKeys = new Map();
async function hmacKey(secret) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    hmacKeys.set(secret, key);
  }
  return key;
}

/** Returns {userId,email,sessionId}, null for invalid tokens, or AuthUnavailableError for cold JWKS failure. */
export async function verifyFacilitatorJwt(token, env, { nowMs = Date.now(), fetchJwks = fetch } = {}) {
  const config = supabaseConfig(env);
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims, signature;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    claims = JSON.parse(dec.decode(b64urlDecode(parts[1])));
    signature = b64urlDecode(parts[2]);
  } catch { return null; }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return null;
  if (header.alg !== 'ES256' && header.alg !== 'RS256' && header.alg !== 'HS256') return null;
  let valid = false;
  const signed = enc.encode(`${parts[0]}.${parts[1]}`);
  if (header.alg === 'HS256') {
    if (!config.allowHs256 || !config.jwtSecret) return null;
    valid = await crypto.subtle.verify('HMAC', await hmacKey(config.jwtSecret), signature, signed);
  } else {
    if (!config.jwksUrl || !validKid(header.kid)) return null;
    const keys = await getKeys(config.jwksUrl, header.kid, nowMs, fetchJwks);
    const candidate = keys?.get(header.kid);
    if (!candidate || candidate.alg !== header.alg) return null;
    try { valid = await crypto.subtle.verify(candidate.verifyAlgorithm, candidate.key, signature, signed); }
    catch { return null; }
  }
  if (!valid) return null;
  const now = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp + 30 < now) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf - 30 > now)) return null;
  if (config.issuer && claims.iss !== config.issuer) return null;
  if (claims.aud !== 'authenticated' || claims.role !== 'authenticated' || claims.is_anonymous === true || !isUuid(claims.sub)) return null;
  // sessionId (Supabase's session_id claim) binds an admin step-up to one sign-in session (card 35, R-a).
  return { userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : null,
    sessionId: isUuid(claims.session_id) ? claims.session_id : null };
}

/** Whether sign-in can verify tokens now: cached JWKS keys, or one bounded fetch through the same cache. */
export async function signInKeysReady(env, { nowMs = Date.now(), fetchJwks = fetch } = {}) {
  try {
    const config = supabaseConfig(env);
    if (!config.jwksUrl) return config.allowHs256 && Boolean(config.jwtSecret);
    return (await getKeys(config.jwksUrl, null, nowMs, fetchJwks)).size > 0;
  } catch { return false; }
}

/** Dev/test-only HS256 signer; never used on a Worker request path. */
export async function signTestJwt(claims, secret) {
  const b64 = (o) => btoa(String.fromCharCode(...enc.encode(JSON.stringify(o)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(head)));
  return `${head}.${btoa(String.fromCharCode(...sig)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
}
