// Public, bounded device metadata for number-matched shared-PC approval.
import { cleanText } from '../shared/room-machine.mjs';
import { authApiUrl } from '../shared/urls.mjs';
import { isUuidV7, normalizeCode, PAIR_CODE_LENGTH } from '../shared/ids.mjs';
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { actorFor, starterActor } from './authorize.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { supabaseConfig } from './supabase-keys.mjs';
import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';

export function devicePreview(request, nowMs = Date.now()) {
  const agent = request.headers.get('user-agent') || '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Other';
  const country = /^[A-Z]{2}$/.test(request.cf?.country ?? '') ? request.cf.country : 'Unknown';
  const rawCity = request.cf?.city;
  const city = typeof rawCity === 'string' && /^[A-Za-z .'-]{1,80}$/.test(rawCity)
    ? cleanText(rawCity, 80) : 'Unknown';
  return { browser, country, city: city || 'Unknown', requestedAt: new Date(nowMs).toISOString() };
}

/** The exact selected Auth origin can be known before its public key is configured. */
export function selectedAuthOrigin(env) {
  try {
    const config = supabaseConfig(env);
    if (!config.url) return null;
    const authOrigin = new URL(config.url);
    authApiUrl(config.url, 'otp'); // validates HTTPS origin and rejects URL credentials or suffixes
    if (config.issuer !== `${authOrigin.origin}/auth/v1` ||
        config.jwksUrl !== `${authOrigin.origin}/auth/v1/.well-known/jwks.json`) return null;
    return authOrigin.origin;
  } catch { return null; }
}

/** Return null when a selected deployment has no complete public Auth configuration. */
export function publicAuthConfig(env) {
  try {
    const origin = selectedAuthOrigin(env);
    if (!origin) return null;
    const config = supabaseConfig(env);
    if (!config.publishableKey) return null;
    const turnstileSiteKey = typeof env.TURNSTILE_SITE_KEY === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(env.TURNSTILE_SITE_KEY) ? env.TURNSTILE_SITE_KEY : null;
    return { supabaseUrl: origin, publishableKey: config.publishableKey, turnstileSiteKey };
  } catch { return null; }
}

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const fail = (error, status) => reply({ error }, status);
const BODY_BYTES = 1024;
const BODY_MS = BODY_READ_DEADLINE_MS;
function cancelReader(reader) {
  try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* never wait on cancellation */ }
}
async function readSmallJson(request) {
  if (Number(request.headers.get('content-length') || 0) > BODY_BYTES) return { error: 'too_large' };
  if (!request.body) return { error: 'not_json' };
  const reader = request.body.getReader(), chunks = [];
  let bytes = 0, timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), BODY_MS); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === null) { cancelReader(reader); return { error: 'request_timeout' }; }
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > BODY_BYTES) { cancelReader(reader); return { error: 'too_large' }; }
      chunks.push(next.value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return { body: JSON.parse(new TextDecoder().decode(merged)) };
  } catch { cancelReader(reader); return { error: 'not_json' }; }
  finally { clearTimeout(timer); }
}

/** Return null for routes owned elsewhere. A pair secret is never placed in a URL. */
export async function handleConsolePairApi(request, {
  env, pairs, roomFor, verifyUser = verifyFacilitatorJwt, rateLimited = async () => false, mayMint = null,
}) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const method = request.method;
  const pickup = /^\/api\/v1\/console-pairs\/([0-9a-f-]{36})$/.exec(path);
  if (!(path === '/api/v1/console-pairs' && method === 'POST') &&
      !(path === '/api/v1/console-pairs/preview' && method === 'POST') &&
      !(path === '/api/v1/console-pairs/approve' && method === 'POST') &&
      !(pickup && method === 'GET')) return null;

  if (path === '/api/v1/console-pairs') {
    if (await rateLimited(request)) return fail('rate_limited', 429);
    const created = await pairs.createConsolePair(devicePreview(request));
    return reply(created, 201);
  }

  if (pickup) {
    if (!isUuidV7(pickup[1])) return fail('not_found', 404);
    const result = await pairs.pollConsolePair(pickup[1], bearer(request));
    if (result.error) return fail(result.error, result.error === 'expired' ? 410 : 404);
    if (result.pending) return reply({ pending: true, expiresAt: result.expiresAt });
    if (!result.approved || !isUuidV7(result.sessionId)) return fail('unavailable', 503);
    // Pickup has no JWT: recheck the approving starter (active, still a member or a current admin)
    // before the room mints (card 35, invariant 10). The approval itself was consumed above.
    const stub = roomFor(env, result.sessionId);
    const room = await stub.canIssueFacilitatorToken(result.userId);
    if (room?.error) return fail(room.error, room.status ?? 503);
    if (typeof mayMint !== 'function') return fail('unavailable', 503);
    const may = await mayMint(await starterActor(result.userId, room?.ownerAdminDigest ?? null, env), room, ACTIONS.mintConsole, result.sessionId);
    if (!may?.ok) return fail(may?.error ?? 'unavailable', may?.status ?? 503);
    // Marked shared, so the starter can list and revoke this one computer (P-27, E27).
    const issued = await stub.issueSharedConsoleToken(result.userId);
    if (issued?.error) return fail(issued.error, issued.status ?? 503);
    return typeof issued?.facilitatorToken === 'string' && issued.facilitatorToken
      ? reply({ sessionId: result.sessionId, facilitatorToken: issued.facilitatorToken })
      : fail('unavailable', 503);
  }

  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user) return fail('unauthorised', 401);
  const { body, error } = await readSmallJson(request);
  if (error) return fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);
  const code = normalizeCode(body?.code, PAIR_CODE_LENGTH);
  if (!code) return fail('bad_code', 400);
  if (path === '/api/v1/console-pairs/preview') {
    const result = await pairs.previewConsolePair(code);
    if (result.error) return fail('unknown_or_expired_code', 404);
    return reply(result);
  }
  const sessionId = body?.sessionId;
  if (!isUuidV7(sessionId)) return fail('bad_request', 400);
  const eligible = await roomFor(env, sessionId).canIssueFacilitatorToken(user.userId);
  if (eligible?.error) return fail(eligible.error, eligible.status ?? 503);
  if (!eligible?.ok) return fail('unavailable', 503);
  if (typeof mayMint !== 'function') return fail('unavailable', 503);
  const may = await mayMint(actorFor(user, env), eligible, ACTIONS.approveSharedPc, sessionId);
  if (!may?.ok) return fail(may?.error ?? 'unavailable', may?.status ?? 503);
  const approved = await pairs.approveConsolePair(code, sessionId, user.userId);
  if (approved?.error) return fail(approved.error, approved.error === 'already_paired' ? 409 : 404);
  return approved?.ok ? reply({ approved: true }) : fail('unavailable', 503);
}
