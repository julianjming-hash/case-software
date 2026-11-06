// Case admin identity is a Worker allowlist of verified JWT emails, never a DB role.
import { bearer, verifyFacilitatorJwt } from '../auth.mjs';

const validAddress = address => typeof address === 'string' && address.length <= 320 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address);

export function adminEmails(env) {
  if (typeof env?.ADMIN_EMAILS !== 'string') return null;
  const entries = env.ADMIN_EMAILS.split(',').map(value => value.trim());
  if (!entries.length || entries.some(value => !validAddress(value))) return null;
  return new Set(entries);
}

export function isAdminUser(user, env) {
  const allowed = adminEmails(env);
  return Boolean(allowed && typeof user?.email === 'string' &&
    validAddress(user.email) && allowed.has(user.email));
}

/** Audit only the network prefix. Invalid or absent addresses leave no address trail. */
export function adminAuditPrefix(address) {
  if (typeof address !== 'string' || !address || address.length > 45) return null;
  if (address.includes('.')) {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255))
      return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  const lowered = address.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lowered)) return null;
  const halves = lowered.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (head.concat(tail).some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  if (halves.length === 2 && head.length + tail.length >= 8) return null;
  const groups = halves.length === 2
    ? head.concat(Array(8 - head.length - tail.length).fill('0'), tail)
    : head;
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export async function authorizeAdmin(request, { env, verifyUser = verifyFacilitatorJwt } = {}) {
  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch { return { ok: false, status: 503, error: 'auth_unavailable' }; }
  if (!user) return { ok: false, status: 401, error: 'unauthorised' };
  if (!isAdminUser(user, env)) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, user };
}

/** The caller passes the one selected Case origin from deployment config. */
export function checkAdminWrite(request, allowedOrigin) {
  let canonical = false;
  try {
    const selected = new URL(allowedOrigin);
    canonical = selected.protocol === 'https:' && selected.origin === allowedOrigin;
  } catch { /* Invalid configuration refuses every administrative write. */ }
  if (!canonical || request.headers.get('origin') !== allowedOrigin)
    return { ok: false, status: 403, error: 'forbidden' };
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
    return { ok: false, status: 415, error: 'unsupported_media_type' };
  return { ok: true };
}
