// Server-only GoTrue adapter. Only the shared fixed builder constructs Auth URLs.
import { supabaseConfig } from '../supabase-keys.mjs';
import { isUuid } from '../../shared/ids.mjs';
import { adminAuthUrl } from '../../shared/urls.mjs';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const failure = kind => ({ ok: false, kind });

function cancel(reader) {
  try { void Promise.resolve(reader.cancel()).catch(() => {}); }
  catch { /* A hostile stream must not hold a response open. */ }
}

async function boundedJson(response, maxBytes, deadline) {
  if (!response.body || Number(response.headers.get('content-length') || 0) > maxBytes)
    throw new Error('invalid_body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === null) throw new Error('request_timeout');
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('too_large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) { cancel(reader); throw error; }
}

const boundedPositive = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const adminEmail = value => typeof value === 'string' && value.length <= 320 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value);
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
function publicUser(row) {
  if (!row || !isUuid(row.id) || typeof row.email !== 'string' || row.email.length > 320)
    throw new Error('invalid_user');
  return Object.freeze({
    id: row.id, email: row.email,
    invitedAt: iso(row.invited_at), confirmedAt: iso(row.confirmed_at),
    bannedUntil: iso(row.banned_until), createdAt: iso(row.created_at),
  });
}

export function gotrueAdminClient(env, {
  endpointUrl, caseOrigin, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const { url, secretKey } = supabaseConfig(env);
  let origin;
  try {
    const selected = new URL(url);
    if (selected.protocol !== 'https:' || selected.pathname !== '/' || selected.search || selected.hash ||
        selected.username || selected.password) throw new Error();
    origin = selected.origin;
  } catch { throw new TypeError('Invalid GoTrue configuration'); }
  if (endpointUrl === undefined)
    endpointUrl = ({ operation, page, perPage }) => adminAuthUrl(origin, operation,
      operation === 'users' ? { page, perPage } : {});
  if (!secretKey || typeof endpointUrl !== 'function' || typeof fetchImpl !== 'function' ||
      !boundedPositive(timeoutMs, 60_000) || !boundedPositive(maxBytes, 4 * 1024 * 1024))
    throw new TypeError('Invalid GoTrue configuration');

  async function listUsers({ page = 1, perPage = 100 } = {}, requestTimeoutMs = timeoutMs) {
    if (!boundedPositive(page, 100_000) || !boundedPositive(perPage, 1000)) return failure('bad_request');
    let endpoint;
    try {
      endpoint = new URL(endpointUrl({ operation: 'users', page, perPage }));
      if (endpoint.origin !== origin || endpoint.pathname !== '/auth/v1/admin/users' ||
          endpoint.searchParams.size !== 2 || endpoint.searchParams.get('page') !== String(page) ||
          endpoint.searchParams.get('per_page') !== String(perPage) || endpoint.hash ||
          endpoint.username || endpoint.password) return failure('invalid_endpoint');
    } catch { return failure('invalid_endpoint'); }

    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, requestTimeoutMs);
    });
    try {
      const response = await Promise.race([fetchImpl(endpoint.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { apikey: secretKey, accept: 'application/json' },
      }), deadline]);
      if (!response || response.type === 'opaqueredirect' || !response.ok || response.status >= 300) {
        if (response?.body) cancel(response.body);
        return failure(response?.status === 429 ? 'rate_limited' : 'unavailable');
      }
      const data = await boundedJson(response, maxBytes, deadline);
      if (!Array.isArray(data?.users) || data.users.length > perPage) return failure('unavailable');
      const users = data.users.map(publicUser);
      return { ok: true, users, nextPage: users.length === perPage ? page + 1 : null };
    } catch { return failure('unavailable'); }
    finally { clearTimeout(timer); }
  }

  async function findUserByEmail(email) {
    if (!adminEmail(email)) return failure('bad_request');
    const end = performance.now() + timeoutMs;
    for (let page = 1; page <= 100; page++) {
      const remaining = Math.ceil(end - performance.now());
      if (remaining < 1) return failure('unavailable');
      const result = await listUsers({page,perPage:1000},remaining);
      if (!result.ok) return result;
      const user = result.users.find(row => row.email.toLowerCase() === email);
      if (user) return {ok:true,user};
      if (result.nextPage === null) return {ok:true,user:null};
    }
    // A capped or unavailable inventory never authorizes a supposedly new invitation.
    return failure('inventory_incomplete');
  }

  async function stepUpRequest(operation, email, token = null) {
    if (!adminEmail(email) || (operation === 'verify' &&
        (typeof token !== 'string' || token.length !== 6 || !/^[0-9]{6}$/.test(token)))) return failure('bad_request');
    let endpoint;
    try {
      endpoint = endpointUrl({ operation });
      if (endpoint !== adminAuthUrl(origin, operation)) return failure('invalid_endpoint');
    } catch { return failure('invalid_endpoint'); }
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    try {
      const response = await Promise.race([fetchImpl(endpoint, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'manual',
        signal: controller.signal,
        headers: { apikey: secretKey, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(operation === 'otp' ? { email, create_user: false } :
          { email, token, type: 'email' }),
      }), deadline]);
      if (!response || response.type === 'opaqueredirect' || !response.ok || response.status >= 300) {
        if (response?.body) cancel(response.body);
        if (response?.status === 429) return failure('rate_limited');
        // A5: GoTrue refuses a wrong or expired code with a 4xx of its own; that is the person's code, not an outage.
        if (operation === 'verify' && [400, 403, 404, 410, 422].includes(response?.status)) return failure('code_rejected');
        return failure('unavailable');
      }
      if (operation === 'otp') {
        if (response.body) cancel(response.body);
        return { ok: true };
      }
      const body = await boundedJson(response, maxBytes, deadline);
      if (!isUuid(body?.user?.id) || body.user.email !== email) return failure('forbidden');
      return { ok: true }; // GoTrue's access and refresh tokens must not escape this adapter.
    } catch { return failure('unavailable'); }
    finally { clearTimeout(timer); }
  }

  async function inviteUser(email, expectedUserId = null) {
    if (!adminEmail(email)) return failure('bad_request');
    let endpoint;
    try { endpoint = adminAuthUrl(origin, expectedUserId ? 'invite_resend' : 'invite', { redirectOrigin: caseOrigin }); }
    catch { return failure('invalid_endpoint'); }
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    try {
      // An ambiguous external write is never retried by this adapter.
      const response = await Promise.race([fetchImpl(endpoint, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'manual',
        signal: controller.signal,
        headers: { apikey: secretKey, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }), deadline]);
      if (!response) return failure('unknown_outcome');
      if (response.type === 'opaqueredirect' || response.status >= 300) {
        if (response.body) cancel(response.body);
        if (response.status === 429) return failure('rate_limited');
        return failure(response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown_outcome');
      }
      if (!response.ok) {
        if (response.body) cancel(response.body);
        return failure('unknown_outcome');
      }
      const user = await boundedJson(response, Math.min(maxBytes, 65_536), deadline);
      if (!isUuid(user?.id) || user.email !== email ||
          (expectedUserId !== null && user.id !== expectedUserId)) return failure('unknown_outcome');
      return { ok: true, userId: user.id };
    } catch { return failure('unknown_outcome'); }
    finally { clearTimeout(timer); }
  }

  /**
   * CASE-340: create an invited account with its email already confirmed, so the invitee signs in with a code and GoTrue
   * sends no email (Case sends its own). Never retried here. Outcomes: { ok, userId } | exists (another request made it
   * first: look it up again) | rate_limited | rejected (a 4xx GoTrue refused) | unknown_outcome.
   */
  async function createUser(email) {
    if (!adminEmail(email)) return failure('bad_request');
    let endpoint;
    try { endpoint = adminAuthUrl(origin, 'user_create'); } catch { return failure('invalid_endpoint'); }
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
    try {
      const response = await Promise.race([fetchImpl(endpoint, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: controller.signal,
        headers: { apikey: secretKey, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ email, email_confirm: true }),
      }), deadline]);
      if (!response) return failure('unknown_outcome');
      if (response.type === 'opaqueredirect' || response.status >= 300 || !response.ok) {
        if (response.body) cancel(response.body);
        if (response.status === 429) return failure('rate_limited');
        // GoTrue answers 422 email_exists (older builds: 400) for an address that already has an account.
        if (response.status === 422 || response.status === 409) return failure('exists');
        return failure(response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown_outcome');
      }
      const user = await boundedJson(response, Math.min(maxBytes, 65_536), deadline);
      if (!isUuid(user?.id) || typeof user.email !== 'string' || user.email.toLowerCase() !== email) return failure('unknown_outcome');
      return { ok: true, userId: user.id };
    } catch { return failure('unknown_outcome'); }
    finally { clearTimeout(timer); }
  }

  async function targetUserRequest(operation, userId, attributes = null) {
    if (!isUuid(userId)) return failure('bad_request');
    const destructive = operation === 'user_delete';
    const updating = operation === 'user_update';
    const mutating = destructive || updating;
    if (updating && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) ||
        Object.keys(attributes).length !== 1 || !Object.hasOwn(attributes, 'banDuration') ||
        !(attributes.banDuration === 'none' || (typeof attributes.banDuration === 'string' &&
          ((/^[1-9][0-9]{0,5}h$/.test(attributes.banDuration) &&
            Number(attributes.banDuration.slice(0, -1)) <= 876000) ||
           (/^[1-9][0-9]{0,12}ms$/.test(attributes.banDuration) &&
            Number(attributes.banDuration.slice(0, -2)) <= 3153600000000)))))) return failure('bad_request');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    try {
      const endpoint = adminAuthUrl(origin, operation, { userId });
      const response = await Promise.race([fetchImpl(endpoint, {
        method: destructive ? 'DELETE' : updating ? 'PUT' : 'GET', credentials: 'omit', cache: 'no-store',
        redirect: 'manual', signal: controller.signal,
        headers: { apikey: secretKey, accept: 'application/json',
          ...(updating ? { 'content-type': 'application/json' } : {}) },
        ...(updating ? { body: JSON.stringify({ ban_duration: attributes.banDuration }) } : {}),
      }), deadline]);
      if (destructive && response?.status === 404) {
        if (response.body) cancel(response.body);
        return { ok: true };
      }
      if (!response || response.type === 'opaqueredirect' || !response.ok || response.status >= 300) {
        if (response?.body) cancel(response.body);
        return failure(response?.status === 429 ? 'rate_limited' :
          mutating ? 'unknown_outcome' : response?.status === 404 ? 'not_found' : 'unavailable');
      }
      if (destructive) {
        if (response.body) cancel(response.body);
        return { ok: true };
      }
      const row = await boundedJson(response, Math.min(maxBytes, 65_536), deadline);
      if (row?.id !== userId) return failure(mutating ? 'unknown_outcome' : 'unavailable');
      return { ok: true, user: publicUser(row) };
    } catch { return failure(mutating ? 'unknown_outcome' : 'unavailable'); }
    finally { clearTimeout(timer); }
  }

  function resendInvite(target) {
    if (!target || !isUuid(target.id) || !adminEmail(target.email) ||
        !iso(target.invitedAt) || target.confirmedAt !== null)
      return Promise.resolve(failure('bad_request'));
    // The audited handler pre-reads this target; reuse is permitted only while unconfirmed.
    return inviteUser(target.email, target.id);
  }

  return Object.freeze({ listUsers, findUserByEmail,
    startStepUp: email => stepUpRequest('otp', email),
    verifyStepUp: (email, code) => stepUpRequest('verify', email, code),
    inviteUser, resendInvite, createUser,
    updateUser: (userId, attributes) => targetUserRequest('user_update', userId, attributes),
    getUser: userId => targetUserRequest('user_read', userId),
    deleteUser: userId => targetUserRequest('user_delete', userId),
  });
}
