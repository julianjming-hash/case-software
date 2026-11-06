// Case's zero-dependency GoTrue client. Access tokens never enter web storage; refresh: CASE-175.
import { apiUrl, authApiUrl } from '../shared/urls.mjs';
import { isUuid } from '../shared/ids.mjs';
import { createTeardown, authNavigationPreservation } from './teardown.mjs';

const REFRESH_KEY = 'case:auth:refresh';
const REQUEST_MS = 10_000;
const safeStorage = name => { try { return globalThis[name] ?? null; } catch { return null; } };
const cleanEmail = email => typeof email === 'string' && email.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.trim() : null;

function validConfig(config) {
  try {
    authApiUrl(config?.supabaseUrl, 'otp');
    return typeof config.publishableKey === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey);
  } catch { return false; }
}

function sessionFields(value) {
  if (!value || typeof value.access_token !== 'string' || !value.access_token ||
      typeof value.refresh_token !== 'string' || !value.refresh_token ||
      !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86_400 ||
      !isUuid(value.user?.id)) throw new Error('auth_unavailable');
  return { access: value.access_token, refresh: value.refresh_token, seconds: value.expires_in, userId: value.user.id };
}

export function createAuth({
  fetchImpl = fetch, origin = globalThis.location?.origin,
  sessionStorage = safeStorage('sessionStorage'), localStorage = safeStorage('localStorage'),
  caches = globalThis.caches, indexedDB = globalThis.indexedDB,
  onTeardown = () => {}, onRecovered = () => {}, preserveSessionKeys = () => [],
  now = Date.now,
  schedule = setTimeout, clearSchedule = clearTimeout,
} = {}) {
  let config = null, access = null, userId = null, flight = null, refreshTimer = null;
  let generation = 0, magicAttempt = 0, known = null, tabs = null, until = 0;
  const teardown = createTeardown({ sessionStorage, localStorage, caches, indexedDB,
    ...authNavigationPreservation({ sessionStorage, now, preserveSessionKeys }),
    clearMemory(reason) {
      if (reason === 'room_end') return; // room state only: the facilitator stays signed in
      generation++;
      globalThis.window?.dispatchEvent?.(new Event('case-auth-retired'));
      if (refreshTimer !== null) clearSchedule(refreshTimer);
      refreshTimer = null; access = null; userId = null; known = null;
      onTeardown(reason);
    } });

  async function request(url, body, key = null, token = null) {
    const controller = new AbortController();
    let timer, reader, refused = false;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('auth_unavailable')); }, REQUEST_MS); });
    try {
      const response = await Promise.race([fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'manual',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { apikey: key } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      }), deadline]);
      if (!response.ok || response.status >= 300) { refused = response.status === 400 || response.status === 401; throw 0; }
      const chunks = []; let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const part = await Promise.race([reader.read(), deadline]);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 32_768) throw new Error('auth_unavailable');
          chunks.push(part.value);
        }
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes);
      return text ? JSON.parse(text) : {};
    } catch {
      // A stalled cancel promise cannot hold refusal or the whole-request deadline open.
      try { if (reader) void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      throw Object.assign(new Error('auth_unavailable'), { refused });
    }
    finally { clearTimeout(timer); }
  }

  async function publicConfig() {
    if (config) return config;
    if (!origin) throw new Error('auth_unavailable');
    const value = await request(apiUrl(origin, 'config'));
    if (!validConfig(value)) throw new Error('auth_unavailable');
    config = { supabaseUrl: value.supabaseUrl, publishableKey: value.publishableKey };
    return config;
  }

  async function adopt(value, expectedGeneration, announce = true) {
    const next = sessionFields(value);
    if (generation !== expectedGeneration) return null;
    if (userId && userId !== next.userId) {
      const prior = generation;
      const cleanup = teardown('account_changed');
      expectedGeneration = prior + 1;
      const cleaned = await cleanup;
      if (!cleaned.complete) return null;
      if (generation !== expectedGeneration) return null;
    }
    try {
      localStorage.setItem(REFRESH_KEY, next.refresh);
      if (generation !== expectedGeneration) return null;
      if (refreshTimer !== null) clearSchedule(refreshTimer);
      const timer = schedule(() => { void refresh().catch(() => {}); }, Math.floor(next.seconds * 800));
      access = next.access; userId = next.userId; known = next.refresh; refreshTimer = timer; until = now() + next.seconds * 1000;
      generation++;
      if (announce) tabs?.announce({ access, refresh: known, userId, expiresAt: until });
    } catch {
      if (generation === expectedGeneration) await teardown('refresh_failed');
      return null;
    }
    return access;
  }

  async function requestOtp(email) {
    const clean = cleanEmail(email);
    if (!clean) throw new TypeError('invalid_email');
    const { supabaseUrl, publishableKey } = await publicConfig();
    await request(authApiUrl(supabaseUrl, 'otp'), { email: clean, create_user: false }, publishableKey);
  }

  async function verifyOtp(email, token) {
    const clean = cleanEmail(email);
    if (!clean || typeof token !== 'string' || !/^\d{6}$/.test(token)) throw new TypeError('invalid_otp');
    const expectedGeneration = generation;
    const { supabaseUrl, publishableKey } = await publicConfig();
    const value = await request(authApiUrl(supabaseUrl, 'verify'), { email: clean, token, type: 'email' }, publishableKey);
    return (tabs?.commit ?? adopt)(value, expectedGeneration);
  }

  async function beginMagicLink(email) {
    const clean = cleanEmail(email);
    if (!clean) throw new TypeError('invalid_email');
    const expectedGeneration = generation, attempt = ++magicAttempt;
    // The PKCE start is loaded on its button press (card 38 trim; same checks, account-session.mjs).
    return (await import('./account-session.mjs')).beginMagicLink({ origin, sessionStorage, now, publicConfig, request, authApiUrl,
      current: () => generation === expectedGeneration && magicAttempt === attempt }, clean);
  }

  async function completeMagicLink(callbackUrl = globalThis.location?.href, { history = globalThis.history } = {}) {
    const expectedGeneration = generation;
    const callback = new URL(callbackUrl);
    if (callback.origin !== origin || callback.pathname !== '/' || callback.hash) throw new TypeError('invalid_callback');
    // Strip the one-use code before any fetch, script callback or await can observe the URL again.
    history.replaceState(null, '', `${callback.origin}${callback.pathname}`);
    return (await import('./account-session.mjs')).completeMagicLink({ sessionStorage, now, publicConfig, request, authApiUrl,
      adopt: value => (tabs?.commit ?? adopt)(value, expectedGeneration) }, callback.searchParams.get('code'));
  }

  async function refresh() {
    const expectedGeneration = generation;
    if (flight?.generation === expectedGeneration) return flight.promise;
    const current = { generation: expectedGeneration, promise: null };
    current.promise = (async () => {
      try {
        const seen = localStorage.getItem(REFRESH_KEY);
        const run = async () => {
          if (generation !== expectedGeneration) return null;
          const token = localStorage.getItem(REFRESH_KEY);
          if (!token) throw { refused: 1 };
          const taken = await tabs?.adopted(token, seen, expectedGeneration);
          if (taken) return taken;
          const { supabaseUrl, publishableKey } = await publicConfig();
          const value = await request(authApiUrl(supabaseUrl, 'refresh'), { refresh_token: token }, publishableKey);
          const stored = localStorage.getItem(REFRESH_KEY);
          if (generation === expectedGeneration && stored !== token) {
            if (stored) return run();
            await teardown('signed_out_elsewhere'); return null;
          }
          return await adopt(value, expectedGeneration);
        };
        return await (tabs ? tabs.serial(run) : run());
      } catch (error) {
        if (generation !== expectedGeneration) return null;
        if (error?.refused || !tabs) await teardown('refresh_failed');
        else { access = null; tabs.retry(refresh); }
        return null;
      }
    })();
    flight = current;
    try { return await current.promise; } finally { if (flight === current) flight = null; }
  }

  return {
    publicConfig, requestOtp, verifyOtp, beginMagicLink, completeMagicLink, refresh, teardown,
    accessToken: () => now() < until - 60_000 ? access : null,
    sessionGeneration: () => generation,
    hasSavedSession() { try { return Boolean(localStorage?.getItem(REFRESH_KEY)); } catch { return false; } },
    async restore() {
      try { return localStorage.getItem(REFRESH_KEY) ? refresh() : null; }
      catch { await teardown('refresh_failed'); return null; }
    },
    async handle401() { await teardown('unauthorised'); },
    link(linkTabs, options) {
      return tabs = linkTabs({ now, adopt, authApiUrl, forget: () => localStorage.removeItem(REFRESH_KEY), teardown, onRecovered, refresh,
        request, publicConfig, state: () => ({ generation, userId, known, flight, access, until, stored: localStorage.getItem(REFRESH_KEY) }) }, options);
    },
  };
}
