// Card 38 (CASE-175): the facilitator's account session persists on the device and is shared by its tabs.
// Local fakes only: a fake origin (shared localStorage, per-tab sessionStorage, storage events, a
// BroadcastChannel bus, one lock manager) and a fake GoTrue that revokes on refresh-token reuse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../src/client/auth.mjs';
import { linkTabs } from '../src/client/account-session.mjs';
import { accountRequest } from '../src/client/auth-ui.mjs';
import { createTeardown, recoverOnLoad, assertKnownStorageKeys } from '../src/client/teardown.mjs';
import { createPhoneCleanup } from '../src/client/phone-cleanup.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const KEY = 'case:auth:refresh', ACTIVE_ROOM_KEY = 'case:console:active-room';
const USER = '550e8400-e29b-41d4-a716-446655440000';
const CONFIG = { supabaseUrl: 'https://auth.example.invalid', publishableKey: 'sb_publishable_test' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await tick(); assert.ok(check()); }

function storage(values = new Map(), onChange = () => {}) {
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { const old = values.get(key) ?? null; values.set(key, String(value));
      if (old !== String(value)) onChange(key, old, String(value)); },
    removeItem(key) { if (!values.has(key)) return; const old = values.get(key); values.delete(key); onChange(key, old, null); },
    entries: () => [...values] };
}

/** One browser profile: localStorage, the lock manager and BroadcastChannel are shared; sessionStorage is per tab. */
function origin({ sessionScopedLogout = false } = {}) {
  const shared = new Map(), listeners = [], channels = new Set();
  let held = Promise.resolve();
  const locks = { request(_name, callback) { const run = held.then(() => callback()); held = run.catch(() => {}); return run; } };
  // GoTrue: each refresh token is single use; reusing a rotated one revokes the session.
  const gotrue = { live: null, issued: 0, refreshCalls: 0, reuse: 0, offline: false, status: 0, hold: null, logouts: [], lenient: false, logoutOffline: false };
  // Opt-in provider model: OTP creates a session; rotation preserves it; local logout revokes
  // only the bearer token's session, even when a newer OTP session has already been issued.
  const sessions = new Map(), accessSessions = new Map(), refreshSessions = new Map();
  Object.assign(gotrue, { sessions, accessSessions, logoutHold: null, logoutScopes: [], revoked: [] });
  const issue = (sessionId = null) => { gotrue.live = `refresh-${++gotrue.issued}`;
    if (sessionScopedLogout) {
      sessionId ??= uuidv7();
      const previous = sessions.get(sessionId);
      if (previous) refreshSessions.delete(previous.refresh);
      sessions.set(sessionId, { active: true, refresh: gotrue.live });
      accessSessions.set(`access-${gotrue.issued}`, sessionId);
      refreshSessions.set(gotrue.live, sessionId);
    }
    return { access_token: `access-${gotrue.issued}`, refresh_token: gotrue.live, expires_in: 3600, user: { id: USER } }; };
  function tab({ now = Date.now, noLocks = false } = {}) {
    const self = {}, reasons = [], requests = [], online = new Set(), visible = new Set();
    const localStorage = storage(shared, (key, oldValue, newValue) => {
      for (const listener of listeners) if (listener.tab !== self) setTimeout(() => listener.fn({ key, oldValue, newValue }), 0);
    });
    const channel = { fn: null, addEventListener(type, fn) { if (type === 'message') this.fn = fn; },
      postMessage(data) { for (const other of channels) if (other !== channel) setTimeout(() => other.fn?.({ data: structuredClone(data) }), 0); },
      close() { channels.delete(channel); } };
    channels.add(channel);
    const events = { addEventListener(type, fn) { if (type === 'storage') listeners.push({ tab: self, fn }); if (type === 'online') online.add(fn);
      if (type === 'visibilitychange') visible.add(fn); },
      removeEventListener(type, fn) { if (type === 'online') online.delete(fn); } };
    const fetchImpl = async (url, init = {}) => {
      url = String(url); requests.push(url);
      if (url.endsWith('/api/v1/config')) return Response.json(CONFIG);
      if (sessionScopedLogout && new URL(url).pathname === '/auth/v1/logout') {
        const scope = new URL(url).searchParams.get('scope') ?? 'global';
        const bearer = init.headers?.authorization;
        const sessionId = accessSessions.get(bearer?.replace(/^Bearer /, ''));
        gotrue.logouts.push(bearer); gotrue.logoutScopes.push(scope);
        if (!sessionId) return Response.json({ error: 'invalid_token' }, { status: 401 });
        if (gotrue.logoutHold) await gotrue.logoutHold;
        for (const [id, session] of sessions) if (scope !== 'local' || id === sessionId) {
          session.active = false; refreshSessions.delete(session.refresh); gotrue.revoked.push(id);
        }
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/auth/v1/logout?scope=local') || url.endsWith('/auth/v1/logout')) {
        if (gotrue.offline || gotrue.logoutOffline) throw new TypeError('Failed to fetch');
        gotrue.logouts.push(init.headers?.authorization); gotrue.live = null; return new Response(null, { status: 204 }); }
      if (url.includes('grant_type=refresh_token')) {
        gotrue.refreshCalls++;
        await tick();
        if (gotrue.hold) await gotrue.hold;
        if (gotrue.offline) throw new TypeError('Failed to fetch');
        if (gotrue.status) return Response.json({ error: 'server_error' }, { status: gotrue.status });
        if (sessionScopedLogout) {
          const sessionId = refreshSessions.get(JSON.parse(init.body).refresh_token);
          if (!sessionId || !sessions.get(sessionId)?.active) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json(issue(sessionId));
        }
        if (!gotrue.lenient && JSON.parse(init.body).refresh_token !== gotrue.live) { gotrue.reuse++; gotrue.live = null; return Response.json({ error: 'invalid_grant' }, { status: 400 }); }
        return Response.json(issue());
      }
      return Response.json(issue());
    };
    const sessionStorage = storage();
    const recovered = [];
    const auth = createAuth({ fetchImpl, origin: 'https://case.test', sessionStorage, localStorage,
      caches: null, indexedDB: null, onTeardown: reason => reasons.push(reason), onRecovered: () => recovered.push(true),
      schedule: () => 1, clearSchedule: () => {}, now });
    const tabs = auth.link(linkTabs, { events, channel, locks: noLocks ? null : locks });
    const goOnline = () => { for (const fn of [...online]) fn({ type: 'online' }); };
    const show = () => { for (const fn of [...visible]) fn({ type: 'visibilitychange' }); };
    return { auth, tabs, reasons, requests, sessionStorage, localStorage, recovered, goOnline, online, show,
      storageEvent: event => { for (const listener of listeners) if (listener.tab === self) listener.fn(event); } };
  }
  return { tab, gotrue, shared, serial: run => locks.request(KEY, run) };
}

test('[card 38] the refresh token survives reload and a new context with the same storage; Sign out clears it', async () => {
  const browser = origin();
  const first = browser.tab();
  // No checkbox and no device gate: an ordinary PC tab stores it in localStorage.
  assert.equal(await first.auth.verifyOtp('owner@example.invalid', '123456'), 'access-1');
  assert.equal(first.localStorage.getItem(KEY), 'refresh-1');
  assert.equal(first.sessionStorage.getItem(KEY), null);
  assert.equal(first.localStorage.entries().some(([, value]) => value.includes('access-')), false);
  // Back, reload or tab close: pagehide then the next load's cleanup.
  await first.auth.teardown('pagehide');
  assert.equal(first.localStorage.getItem(KEY), 'refresh-1');
  assert.deepEqual(await recoverOnLoad({ sessionStorage: first.sessionStorage, localStorage: first.localStorage,
    caches: null, indexedDB: null }), { complete: true });
  assert.equal(first.localStorage.getItem(KEY), 'refresh-1');
  // A new context (browser restart) with the same storage restores the session.
  const next = browser.tab();
  assert.equal(await next.auth.restore(), 'access-2');
  assert.equal(next.localStorage.getItem(KEY), 'refresh-2');
  // A room's end keeps the account and its memory: it is not a sign-out.
  await next.auth.teardown('room_end');
  assert.equal(next.auth.accessToken(), 'access-2');
  assert.equal(next.localStorage.getItem(KEY), 'refresh-2');
  assert.deepEqual(next.reasons, []);
  await next.auth.teardown('sign_out');
  assert.equal(next.localStorage.getItem(KEY), null);
  assert.equal(next.auth.accessToken(), null);
  assert.equal(await browser.tab().auth.restore(), null);
});

test('[card 38] Sign out in tab A signs out tab B', async () => {
  const browser = origin();
  const a = browser.tab(), b = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  assert.ok(await b.auth.restore());
  await until(() => a.auth.accessToken() === b.auth.accessToken());
  await a.auth.teardown('sign_out');
  await until(() => b.auth.accessToken() === null);
  assert.deepEqual(b.reasons, ['signed_out_elsewhere']);
  assert.equal(b.localStorage.getItem(KEY), null);
});

test('[card 38] a concurrent refresh in two tabs makes exactly one refresh call and both adopt the rotated token', async () => {
  const browser = origin();
  const a = browser.tab(), b = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  await b.auth.restore();
  await until(() => a.auth.accessToken() === b.auth.accessToken());
  browser.gotrue.refreshCalls = 0;
  const [fromA, fromB] = await Promise.all([a.auth.refresh(), b.auth.refresh()]);
  assert.equal(browser.gotrue.refreshCalls, 1);
  assert.equal(browser.gotrue.reuse, 0);
  assert.ok(fromA);
  assert.equal(fromA, fromB);
  assert.equal(a.localStorage.getItem(KEY), browser.gotrue.live);
  assert.deepEqual([a.reasons, b.reasons], [[], []]);
});

test('[card 38] a 401 clears the stored session and nothing refreshes it again', async () => {
  const browser = origin();
  const a = browser.tab(), b = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  await b.auth.restore();
  assert.equal(a.localStorage.getItem(KEY), browser.gotrue.live);
  await a.auth.handle401();
  assert.equal(a.localStorage.getItem(KEY), null);
  await until(() => b.auth.accessToken() === null);
  const calls = browser.gotrue.refreshCalls;
  const reloaded = browser.tab();
  assert.equal(await reloaded.auth.restore(), null);
  assert.equal(await a.auth.restore(), null);
  assert.equal(browser.gotrue.refreshCalls, calls);
  assert.deepEqual(reloaded.requests, []);
});

test('[card 38] the room marker is a known key kept across navigation and cleared at room end and Sign out', async () => {
  const sessionId = uuidv7();
  assert.doesNotThrow(() => assertKnownStorageKeys([ACTIVE_ROOM_KEY]));
  for (const reason of ['pagehide', 'room_end', 'sign_out']) {
    const browser = origin(), tab = browser.tab();
    await tab.auth.verifyOtp('owner@example.invalid', '123456');
    tab.sessionStorage.setItem(ACTIVE_ROOM_KEY, sessionId);
    await tab.auth.teardown(reason);
    assert.equal(tab.sessionStorage.getItem(ACTIVE_ROOM_KEY), reason === 'pagehide' ? sessionId : null, reason);
    assert.equal(tab.localStorage.getItem(KEY), reason === 'sign_out' ? null : 'refresh-1', reason);
  }
  const sessionStorage = storage(new Map([[ACTIVE_ROOM_KEY, sessionId]])), localStorage = storage(new Map([[KEY, 'refresh-9']]));
  assert.deepEqual(await recoverOnLoad({ sessionStorage, localStorage, caches: null, indexedDB: null }), { complete: true });
  assert.equal(sessionStorage.getItem(ACTIVE_ROOM_KEY), sessionId);
  assert.equal(localStorage.getItem(KEY), 'refresh-9');
  // A malformed marker is not kept.
  sessionStorage.setItem(ACTIVE_ROOM_KEY, 'not-a-room');
  await recoverOnLoad({ sessionStorage, localStorage, caches: null, indexedDB: null });
  assert.equal(sessionStorage.getItem(ACTIVE_ROOM_KEY), null);
});

test('[card 38] only Sign out, a 401, an account change or a failed refresh remove the account token', async () => {
  for (const [reason, kept] of [['pagehide', true], ['next_load', true], ['room_end', true], ['signed_out_elsewhere', true],
    ['sign_out', false], ['unauthorised', false], ['account_changed', false], ['refresh_failed', false]]) {
    const localStorage = storage(new Map([[KEY, 'refresh-opaque'], ['case:participant:main:token', '{}']]));
    // Successful known-empty enumeration proves the malformed capability invalid; unavailable inventory is a separate storage gate.
    const indexedDB = { databases: async () => [], deleteDatabase() { const request = {}; queueMicrotask(() => request.onsuccess?.()); return request; } };
    await createTeardown({ sessionStorage: storage(), localStorage, caches: null, indexedDB })(reason);
    assert.equal(localStorage.getItem(KEY), kept ? 'refresh-opaque' : null, reason);
    assert.equal(localStorage.getItem('case:participant:main:token'), null, reason);
  }
  // A participant page's cleanup on the same device never signs the facilitator out.
  for (const reason of ['sign_out', 'unauthorised', 'recap_expiry', 'pagehide']) {
    const localStorage = storage(new Map([[KEY, 'refresh-opaque']]));
    await createPhoneCleanup({ sessionStorage: storage(), localStorage, caches: null, indexedDB: null })(reason);
    assert.equal(localStorage.getItem(KEY), 'refresh-opaque', reason);
  }
});

test('[card 38] a network error, timeout or 5xx during refresh keeps the session and recovers once back online', async () => {
  for (const failure of ['offline', 503]) {
    const browser = origin(), tab = browser.tab();
    await tab.auth.verifyOtp('owner@example.invalid', '123456');
    if (failure === 'offline') browser.gotrue.offline = true; else browser.gotrue.status = failure;
    assert.equal(await tab.auth.refresh(), null);
    assert.equal(tab.localStorage.getItem(KEY), 'refresh-1', String(failure));
    assert.deepEqual(tab.reasons, [], String(failure));
    // No tight loop: nothing retries until the browser is back online or a backoff timer fires.
    const calls = browser.gotrue.refreshCalls;
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(browser.gotrue.refreshCalls, calls);
    assert.equal(tab.online.size, 1);
    browser.gotrue.offline = false; browser.gotrue.status = 0;
    tab.goOnline();
    await until(() => tab.auth.accessToken() === 'access-2');
    assert.equal(browser.gotrue.refreshCalls, calls + 1);
    assert.deepEqual(tab.recovered, [true]);
    assert.equal(tab.localStorage.getItem(KEY), 'refresh-2');
    assert.equal(tab.online.size, 0);
  }
});

test('[card 38] GoTrue refusing the refresh token (invalid_grant) ends the session', async () => {
  const browser = origin(), tab = browser.tab();
  await tab.auth.verifyOtp('owner@example.invalid', '123456');
  browser.gotrue.live = 'rotated-elsewhere'; // the stored token is now unknown to GoTrue: 400 invalid_grant
  assert.equal(await tab.auth.refresh(), null);
  assert.deepEqual(tab.reasons, ['refresh_failed']);
  assert.equal(tab.localStorage.getItem(KEY), null);
  assert.equal(tab.online.size, 0);
});

function held() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
const signOut = tab => tab.tabs?.signOut ? tab.tabs.signOut() : tab.auth.teardown('sign_out');

test('[card 38, RT6] Sign out in one tab cannot be undone by another tab\'s in-flight restore', async () => {
  const browser = origin();
  const a = browser.tab(), b = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  const gate = held(); browser.gotrue.hold = gate.promise;
  const restoring = b.auth.restore();           // B is signed out in memory and its refresh is in flight
  await until(() => browser.gotrue.refreshCalls === 1);
  const out = signOut(a);                        // A signs out meanwhile
  await tick(); await tick();
  gate.release(); browser.gotrue.hold = null;
  await Promise.all([restoring, out]);
  await until(() => b.auth.accessToken() === null && a.localStorage.getItem(KEY) === null);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(a.localStorage.getItem(KEY), null);
  assert.equal(b.auth.accessToken(), null);
  assert.equal(await browser.tab().auth.restore(), null); // a reload stays signed out
  // GoTrue was asked to revoke the session (best effort, after the local sign-out).
  await until(() => browser.gotrue.logouts.length === 1);
});

test('[card 38, RT6] a refresh never writes over a stored token it did not send (compare-and-set)', async () => {
  const browser = origin();
  const a = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  browser.gotrue.lenient = true;
  const gate = held(); browser.gotrue.hold = gate.promise;
  const refreshing = a.auth.refresh();
  await until(() => browser.gotrue.refreshCalls === 1);
  a.localStorage.setItem(KEY, 'written-elsewhere'); // same-tab write: no storage event reaches this tab
  gate.release(); browser.gotrue.hold = null;
  assert.ok(await refreshing);
  // The response to the token this tab sent (refresh-2) is discarded; the stored token is refreshed instead.
  assert.equal(browser.gotrue.refreshCalls, 2);
  assert.equal(a.localStorage.getItem(KEY), 'refresh-3');
  assert.deepEqual(a.reasons, []);
});

test('[card 38, RT5] waking from sleep (+25 h) refreshes once before the request; nothing signs out', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  let clock = Date.now();
  const browser = origin();
  const a = browser.tab({ now: () => clock }), b = browser.tab({ now: () => clock });
  const worker = [];
  try {
    globalThis.location = { origin: 'https://case.test' };
    globalThis.fetch = async (url, init) => {
      const token = init.headers.authorization.slice(7); worker.push(token);
      return token === `access-${browser.gotrue.issued}` ? Response.json({ ok: true }) : new Response('{}', { status: 401 });
    };
    await a.auth.verifyOtp('owner@example.invalid', '123456');
    await b.auth.restore();
    await until(() => a.auth.accessToken() === b.auth.accessToken());
    const before = browser.gotrue.refreshCalls;
    clock += 25 * 3600_000; // the 0.8 x TTL timer never fired during sleep
    assert.deepEqual(await accountRequest(a.auth, ['me']), { ok: true });
    assert.equal(browser.gotrue.refreshCalls, before + 1);
    assert.deepEqual([a.reasons, b.reasons], [[], []]);
    assert.ok(a.localStorage.getItem(KEY));
    // A Worker 401 on a token the client still thinks is fresh: one refresh under the lock, one retry.
    const fresh = browser.gotrue.refreshCalls;
    globalThis.fetch = async (url, init) => { const token = init.headers.authorization.slice(7); worker.push(token);
      return token === `access-${browser.gotrue.issued}` && browser.gotrue.refreshCalls > fresh ? Response.json({ ok: true }) : new Response('{}', { status: 401 }); };
    assert.deepEqual(await accountRequest(a.auth, ['me']), { ok: true });
    assert.equal(browser.gotrue.refreshCalls, fresh + 1);
    assert.deepEqual(a.reasons, []);
    // A tab that becomes visible with a stale token refreshes then.
    clock += 25 * 3600_000;
    const visible = browser.gotrue.refreshCalls;
    b.show();
    await until(() => browser.gotrue.refreshCalls === visible + 1);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation; }
});

test('[card 38, re-check] without Web Locks, a token another tab rotated mid-refresh is taken up, not signed out', async () => {
  const browser = origin();
  const a = browser.tab({ noLocks: true });
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  browser.gotrue.lenient = true; // GoTrue answered this tab's request before the other tab's rotation landed
  const gate = held(); browser.gotrue.hold = gate.promise;
  const refreshing = a.auth.refresh();
  await until(() => browser.gotrue.refreshCalls === 1);
  a.localStorage.setItem(KEY, 'refresh-from-another-tab'); // T0 -> T1 elsewhere; this tab sent T0
  gate.release(); browser.gotrue.hold = null;
  assert.ok(await refreshing);
  assert.deepEqual(a.reasons, []);
  assert.ok(a.auth.accessToken());
  assert.notEqual(a.localStorage.getItem(KEY), null);
});

test('[card 38, re-check] Sign out clears locally at once; /logout runs afterwards with a fresh access token', async () => {
  let clock = Date.now();
  const browser = origin();
  const a = browser.tab({ now: () => clock }), b = browser.tab({ now: () => clock });
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  await b.auth.restore();
  const gate = held(); browser.gotrue.hold = gate.promise;
  const busy = b.auth.refresh();                   // the other tab holds the refresh lock on a slow connection
  await until(() => browser.gotrue.refreshCalls >= 1);
  clock += 25 * 3600_000;                          // A's access token expired during sleep
  const out = signOut(a);
  assert.equal(a.localStorage.getItem(KEY), null);  // synchronous with the click
  assert.equal(a.auth.accessToken(), null);
  await out;                                       // never waits on the other tab's lock or on /logout
  gate.release(); browser.gotrue.hold = null;
  await busy;
  await until(() => browser.gotrue.logouts.length === 1);
  assert.notEqual(browser.gotrue.logouts[0], 'Bearer access-1'); // not the expired token
});

test('[card 38, re-check] a request in flight as the access token enters its last minute still succeeds', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  let clock = Date.now();
  const browser = origin();
  const a = browser.tab({ now: () => clock });
  try {
    globalThis.location = { origin: 'https://case.test' };
    await a.auth.verifyOtp('owner@example.invalid', '123456');
    globalThis.fetch = async () => { clock += 3_570_000; return Response.json({ ok: true }); }; // 30 s left on return
    assert.deepEqual(await accountRequest(a.auth, ['me']), { ok: true });
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation; }
});


// Two browser agents can interleave between the storage read and write even though each agent's
// JavaScript runs to completion. Re-enter at the final refresh storage read to model that boundary.
test('[AS-111] a refresh already past its storage check cannot resurrect an offline signed-out session', async () => {
  const browser = origin(), a = browser.tab(), b = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  const get = b.localStorage.getItem.bind(b.localStorage);
  let out = null;
  b.localStorage.getItem = key => {
    const snapshot = get(key);
    if (key === KEY && snapshot && browser.gotrue.issued === 2 && !out) {
      browser.gotrue.offline = true; // B already received its rotation; A cannot revoke online now.
      out = signOut(a);
      assert.equal(a.localStorage.getItem(KEY), null, 'the press clears storage synchronously');
    }
    return snapshot; // B's check saw the pre-sign-out token, just before A removed it.
  };
  await b.auth.restore();
  assert.ok(out, 'exercise the final storage-read/write boundary');
  await out;
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(a.localStorage.getItem(KEY), null, 'late rotation must not leave a refresh token on the device');
  assert.equal(a.auth.accessToken(), null);
  assert.equal(b.auth.accessToken(), null);
  browser.gotrue.offline = false;
  assert.equal(await browser.tab().auth.restore(), null, 'reload stays signed out after reconnect');
});


test('[AS-111] a deliberate sign-in in this or another tab survives the queued sign-out fence', async () => {
  for (const elsewhere of [false, true]) {
    const browser = origin(), a = browser.tab();
    await a.auth.verifyOtp('owner@example.invalid', '123456');
    browser.gotrue.logoutOffline = true; // Old-session best-effort revocation cannot reach GoTrue.
    const gate = held();
    const rotation = browser.serial(() => gate.promise);
    await tick();
    const out = signOut(a);
    assert.equal(a.localStorage.getItem(KEY), null, 'sign-out is synchronous even with a held lock');
    await out; // Local teardown completes independently of the held refresh lock.
    a.localStorage.setItem(KEY, 'late-rotation'); // Last write from the already-running rotation.
    const next = elsewhere ? browser.tab() : a;
    const signedIn = next.auth.verifyOtp('owner@example.invalid', '123456');
    await tick(); await tick();
    assert.equal(a.localStorage.getItem(KEY), 'late-rotation', 'new sign-in commit waits behind the fence');
    gate.release();
    await rotation;
    assert.equal(await signedIn, 'access-2');
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(a.localStorage.getItem(KEY), 'refresh-2', 'cleanup keeps the newly signed-in session');
    assert.equal(next.auth.accessToken(), 'access-2');
    assert.ok(await browser.tab().auth.restore(), 'new sign-in persists through reload');
  }
});

test('[AS-111] a delayed removal event from the old session cannot sign out a deliberate new sign-in', async () => {
  const browser = origin(), a = browser.tab();
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  browser.gotrue.logoutOffline = true;
  await signOut(a);
  assert.equal(await a.auth.verifyOtp('owner@example.invalid', '123456'), 'access-2');
  a.storageEvent({ key: KEY, newValue: null, oldValue: 'refresh-1' });
  await tick();
  assert.equal(a.auth.accessToken(), 'access-2');
  assert.equal(a.localStorage.getItem(KEY), 'refresh-2');
});

for (const stale of [false, true]) test(`[AS-111] delayed online revoke of an old ${stale ? 'stale' : 'fresh'} session preserves a deliberate new provider session`, async () => {
  let clock = Date.now();
  const browser = origin({ sessionScopedLogout: true });
  const old = browser.tab({ now: () => clock });
  await old.auth.verifyOtp('owner@example.invalid', '123456');
  const oldId = browser.gotrue.accessSessions.get('access-1');
  const revoke = held(), rotation = held();
  browser.gotrue.logoutHold = revoke.promise;
  if (stale) { clock += 3_600_000; browser.gotrue.hold = rotation.promise; }
  try {
    await signOut(old);
    assert.equal(old.auth.accessToken(), null);
    assert.equal(old.localStorage.getItem(KEY), null);
    if (stale) await until(() => browser.gotrue.refreshCalls === 1);
    else await until(() => browser.gotrue.logouts.length === 1);
    const next = browser.tab({ now: () => clock });
    assert.equal(await next.auth.verifyOtp('owner@example.invalid', '123456'), 'access-2');
    const newId = browser.gotrue.accessSessions.get('access-2');
    assert.notEqual(newId, oldId, 'OTP creates a distinct session despite the same account');
    rotation.release();
    await until(() => browser.gotrue.logouts.length === 1);
    const revokedBearer = browser.gotrue.logouts[0].replace(/^Bearer /, '');
    assert.equal(browser.gotrue.accessSessions.get(revokedBearer), oldId, 'revoke targets captured old credentials, including a refreshed stale token');
    assert.equal(browser.gotrue.sessions.get(oldId).active, true, 'old provider response is still held');
    assert.equal(browser.gotrue.sessions.get(newId).active, true);
    assert.equal(next.localStorage.getItem(KEY), 'refresh-2');
    revoke.release();
    await until(() => browser.gotrue.revoked.length > 0);
    assert.deepEqual(browser.gotrue.revoked, [oldId]);
    assert.deepEqual(browser.gotrue.logoutScopes, ['local']);
    assert.equal(browser.gotrue.sessions.get(oldId).active, false);
    assert.equal(browser.gotrue.sessions.get(newId).active, true);
    // Force provider validation after the delayed revoke, then model a browser reload.
    const refreshed = await next.auth.refresh();
    assert.ok(refreshed, 'new session can still refresh after old-session revocation');
    assert.equal(browser.gotrue.accessSessions.get(refreshed), newId);
    const reloaded = await browser.tab({ now: () => clock }).auth.restore();
    assert.ok(reloaded, 'new session survives reload after old-session revocation');
    assert.equal(browser.gotrue.accessSessions.get(reloaded), newId);
  } finally { rotation.release(); revoke.release(); }
});

test('[AS-111] without Web Locks sign-out still clears synchronously and never throws', async () => {
  const browser = origin(), a = browser.tab({ noLocks: true });
  await a.auth.verifyOtp('owner@example.invalid', '123456');
  let out;
  assert.doesNotThrow(() => { out = signOut(a); });
  assert.equal(a.localStorage.getItem(KEY), null);
  await out;
  await tick();
  assert.equal(a.auth.accessToken(), null);
});


test('[AS-111] delayed removal clears an old tab memory while preserving another tab new session', async () => {
  const browser = origin(), old = browser.tab();
  await old.auth.verifyOtp('owner@example.invalid', '123456');
  // A different tab has completed a deliberate sign-in before this old tab handles removal.
  old.localStorage.setItem(KEY, 'new-account-refresh');
  old.storageEvent({ key: KEY, newValue: null, oldValue: 'refresh-1' });
  await tick();
  assert.equal(old.auth.accessToken(), null, 'the old tab must lose its previous account memory');
  assert.equal(old.localStorage.getItem(KEY), 'new-account-refresh', 'old memory cleanup keeps the new stored session');
});
