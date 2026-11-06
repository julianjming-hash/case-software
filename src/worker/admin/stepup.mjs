// An elevation for the rest of one sign-in session (Julian, 2026-10-07, R-a; PERMISSIONS invariant 11).
// Code verification and attempt limits live upstream.
//
// Payload: {v:3, email, scope, sid, jti}. One email code opens a window that covers every destructive action
// in its scope, for the session it was verified in (`sid`, the Supabase JWT session_id). It is refused for any
// other email, scope or session, so it is never replayable across sessions; it ends when the session ends,
// because no valid JWT carries that session id any more. `scope` is 'admin' or 'owner:<workspaceId>' (card
// 32). The Worker records every issued elevation (record_admin_elevation); a SQL write that needs a step-up
// checks the id it is given against that record. Hardening under accepted risk A1, not a second factor.
import { uuidv7, isUuid, isUuidV7 } from '../../shared/ids.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const emailOk = value => typeof value === 'string' && value.length <= 320 &&
  value === value.toLowerCase() && /^[^\s|@]+@[^\s|@]+\.[^\s|@]+$/.test(value);
const secretOk = value => typeof value === 'string' && value.length >= 32;
const scopeOk = value => value === 'admin' ||
  (typeof value === 'string' && value.startsWith('owner:') && isUuidV7(value.slice(6)));
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function fromB64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad_token');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function key(secret, usage) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Mint an elevation for exactly (email, scope, session). Resolves `{ token, jti }`. */
export async function mintElevation(email, sessionId, secret, { scope = 'admin' } = {}) {
  if (!emailOk(email) || !isUuid(sessionId) || !secretOk(secret) || !scopeOk(scope)) throw new TypeError('Invalid elevation input');
  const jti = uuidv7();
  const payload = enc.encode(JSON.stringify({ v: 3, email, scope, sid: sessionId, jti }));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, 'sign'), payload));
  return { token: `${b64(payload)}.${b64(signature)}`, jti };
}

/** Verify a token for exactly (email, scope, session). Resolves `{ jti }`, or false. */
export async function verifyElevation(token, email, sessionId, secret, { scope = 'admin' } = {}) {
  if (!emailOk(email) || !isUuid(sessionId) || !secretOk(secret) || !scopeOk(scope) ||
      typeof token !== 'string' || token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const payload = fromB64(parts[0]), signature = fromB64(parts[1]);
    if (signature.byteLength !== 32 || payload.byteLength > 600) return false;
    if (!await crypto.subtle.verify('HMAC', await key(secret, 'verify'), signature, payload)) return false;
    const claims = JSON.parse(dec.decode(payload));
    if (!claims || typeof claims !== 'object' || Object.keys(claims).sort().join() !== 'email,jti,scope,sid,v' ||
        claims.v !== 3 || claims.email !== email || claims.scope !== scope || claims.sid !== sessionId ||
        !isUuidV7(claims.jti)) return false;
    return { jti: claims.jti };
  } catch { return false; }
}

/** Record an issued elevation before handing it out. Resolves true only when the record was written. */
export async function recordElevation(rpc, { jti, email, sessionId, scope = 'admin' }) {
  if (!isUuidV7(jti) || typeof rpc?.call !== 'function') return false;
  try {
    const recorded = await rpc.call('record_admin_elevation', { p_jti: jti, p_actor_email: email, p_scope: scope, p_session_id: sessionId });
    return recorded?.ok === true && recorded.data === true;
  } catch { return false; }
}
