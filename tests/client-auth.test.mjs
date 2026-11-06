import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../src/client/auth.mjs';

function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key), entries: () => [...map] };
}
const CONFIG = { supabaseUrl: 'https://auth.example.invalid', publishableKey: 'sb_publishable_test', turnstileSiteKey: null };
const session = (sub = '550e8400-e29b-41d4-a716-446655440000', suffix = 'one') => ({
  access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_in: 100,
  user: { id: sub }, token_type: 'bearer',
});
function harness(onAuth = () => new Response(JSON.stringify(session()), { status: 200 })) {
  const requests = [], sessionStorage = storage(), localStorage = storage(), teardownReasons = [], timers = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/config')) return new Response(JSON.stringify(CONFIG), { status: 200 });
    return onAuth(String(url), init, requests.length);
  };
  const auth = createAuth({ fetchImpl, origin: 'https://case.test', sessionStorage, localStorage,
    onTeardown: reason => teardownReasons.push(reason),
    schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearSchedule: () => {} });
  return { auth, requests, sessionStorage, localStorage, teardownReasons, timers };
}

test('[AS-079] invited email OTP uses create_user false and keeps the access token in memory', async () => {
  const run = harness();
  await run.auth.requestOtp('owner@example.invalid');
  assert.equal(run.requests[1].url, 'https://auth.example.invalid/auth/v1/otp');
  assert.deepEqual(JSON.parse(run.requests[1].init.body), { email: 'owner@example.invalid', create_user: false });
  assert.equal(run.requests[1].init.headers.apikey, CONFIG.publishableKey);
  await run.auth.verifyOtp('owner@example.invalid', '123456');
  assert.equal(run.requests[2].url, 'https://auth.example.invalid/auth/v1/verify');
  assert.deepEqual(JSON.parse(run.requests[2].init.body), { email: 'owner@example.invalid', token: '123456', type: 'email' });
  assert.equal(run.auth.accessToken(), 'access-one');
  // Card 38 (CASE-175): the refresh token persists in localStorage on every device; the access token never does.
  assert.equal(run.localStorage.getItem('case:auth:refresh'), 'refresh-one');
  assert.equal(run.sessionStorage.getItem('case:auth:refresh'), null);
  assert.equal([...run.sessionStorage.entries(), ...run.localStorage.entries()].some(([, value]) => value === 'access-one'), false);
  assert.equal(run.timers[0].ms, 80_000);
});

test('[AS-079] ten concurrent callers share one refresh and rotate the stored token', async () => {
  let refreshCalls = 0;
  const run = harness((url) => {
    if (url.includes('grant_type=refresh_token')) { refreshCalls++; return new Response(JSON.stringify(session(undefined, 'two')), { status: 200 }); }
    return new Response(JSON.stringify(session()), { status: 200 });
  });
  await run.auth.verifyOtp('owner@example.invalid', '123456');
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => run.auth.refresh())), Array(10).fill('access-two'));
  assert.equal(refreshCalls, 1);
  assert.equal(run.localStorage.getItem('case:auth:refresh'), 'refresh-two');
  assert.equal(run.auth.accessToken(), 'access-two');
});

test('[AS-079] refresh failure and a 401 both use teardown; the 401 never starts refresh', async () => {
  let refreshCalls = 0;
  const run = harness(url => {
    if (url.includes('grant_type=refresh_token')) { refreshCalls++; return new Response('{}', { status: 401 }); }
    return new Response(JSON.stringify(session()), { status: 200 });
  });
  await run.auth.verifyOtp('owner@example.invalid', '123456');
  await run.auth.refresh();
  assert.deepEqual(run.teardownReasons, ['refresh_failed']);
  assert.equal(run.auth.accessToken(), null);
  await run.auth.verifyOtp('owner@example.invalid', '123456');
  await run.auth.handle401();
  assert.deepEqual(run.teardownReasons, ['refresh_failed', 'unauthorised']);
  assert.equal(refreshCalls, 1);
  assert.equal(run.localStorage.getItem('case:auth:refresh'), null);
});

test('[AS-079] every device stores the refresh token with no opt-in, and an account change tears down', async () => {
  // Card 38 (CASE-175) supersedes the phone-only opt-in: no checkbox, no device gate.
  const device = harness((url, init, count) => new Response(JSON.stringify(session(count === 3 ? undefined : '550e8400-e29b-41d4-a716-446655440001')), { status: 200 }));
  await device.auth.verifyOtp('owner@example.invalid', '123456');
  assert.equal(device.localStorage.getItem('case:auth:refresh'), 'refresh-one');
  await device.auth.verifyOtp('other@example.invalid', '123456');
  assert.deepEqual(device.teardownReasons, ['account_changed']);
  assert.equal(device.localStorage.getItem('case:auth:refresh'), 'refresh-one');
  assert.equal(device.sessionStorage.getItem('case:auth:refresh'), null);
});

test('[AS-079] magic-link fallback starts PKCE only on this origin and strips the callback code before exchange', async () => {
  const run = harness();
  await run.auth.beginMagicLink('owner@example.invalid');
  const otp = run.requests[1];
  assert.equal(new URL(otp.url).searchParams.get('redirect_to'), 'https://case.test/');
  const body = JSON.parse(otp.init.body);
  assert.equal(body.create_user, false);
  assert.equal(body.email, 'owner@example.invalid');
  assert.equal(body.code_challenge_method, 's256');
  assert.match(body.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  const pending = JSON.parse(run.sessionStorage.getItem('case:auth:pkce'));
  const verifier = pending.verifier;
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.ok(pending.createdAt <= Date.now() && pending.expiresAt - pending.createdAt === 600_000);
  assert.notEqual(verifier, body.code_challenge);
  await run.auth.teardown('pagehide');
  assert.equal(JSON.parse(run.sessionStorage.getItem('case:auth:pkce')).verifier, verifier);
  const history = { replaced: [], replaceState(_state, _title, url) { this.replaced.push(url); } };
  const current = 'https://case.test/?code=one-time-auth-code';
  await run.auth.completeMagicLink(current, { history });
  assert.deepEqual(history.replaced, ['https://case.test/']);
  assert.equal(run.requests[2].url, 'https://auth.example.invalid/auth/v1/token?grant_type=pkce');
  assert.deepEqual(JSON.parse(run.requests[2].init.body), {
    auth_code: 'one-time-auth-code', code_verifier: verifier,
  });
  assert.equal(run.sessionStorage.getItem('case:auth:pkce'), null);
  assert.equal(run.auth.accessToken(), 'access-one');
});

test('[AS-079] malformed, expired, future and legacy raw PKCE values fail closed without an Auth exchange', async () => {
  for (const record of ['raw-legacy-verifier', '{invalid', JSON.stringify({ verifier: 'a'.repeat(43),
    createdAt: Date.now() - 601_000, expiresAt: Date.now() - 1 }), JSON.stringify({ verifier: 'a'.repeat(43),
    createdAt: Date.now() + 60_000, expiresAt: Date.now() + 660_000 })]) {
    const run = harness(); run.sessionStorage.setItem('case:auth:pkce', record);
    await assert.rejects(run.auth.completeMagicLink('https://case.test/?code=one-use', {
      history: { replaceState() {} },
    }), /auth_unavailable/);
    assert.equal(run.sessionStorage.getItem('case:auth:pkce'), null);
    assert.deepEqual(run.requests, []);
  }
});

test('[AS-079] magic-link start refuses missing session storage before any Auth request', async () => {
  const requests = [];
  const auth = createAuth({ origin: 'https://case.test', sessionStorage: null, localStorage: storage(),
    fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify(CONFIG), { status: 200 }); } });
  await assert.rejects(auth.beginMagicLink('owner@example.invalid'), /auth_unavailable/);
  assert.deepEqual(requests, []);
});

test('[AS-079] a delayed magic-link digest cannot write a verifier after sign-out', async () => {
  const run = harness();
  const original = crypto.subtle.digest;
  let release, entered;
  const digestEntered = new Promise(resolve => { entered = resolve; });
  crypto.subtle.digest = (...args) => {
    entered(); return new Promise(resolve => { release = () => resolve(original.apply(crypto.subtle, args)); });
  };
  try {
    const pending = run.auth.beginMagicLink('owner@example.invalid');
    await digestEntered;
    await run.auth.teardown('sign_out');
    release();
    await assert.rejects(pending, /auth_unavailable/);
    assert.equal(run.sessionStorage.getItem('case:auth:pkce'), null);
    assert.deepEqual(run.requests, []);
  } finally { crypto.subtle.digest = original; }
});

test('[AS-079] an older failed magic-link request cannot remove a newer verifier', async () => {
  let oldReject;
  const oldEntered = new Promise(resolve => { oldReject = resolve; });
  let releaseOld;
  const run = harness((url, init, count) => count === 2
    ? new Promise((_, reject) => { releaseOld = () => reject(new Error('old unavailable')); oldReject(); })
    : new Response('{}', { status: 200 }));
  const old = run.auth.beginMagicLink('old@example.invalid');
  await oldEntered;
  await run.auth.beginMagicLink('new@example.invalid');
  const newer = run.sessionStorage.getItem('case:auth:pkce');
  releaseOld();
  await assert.rejects(old, /auth_unavailable/);
  assert.equal(run.sessionStorage.getItem('case:auth:pkce'), newer);
});

test('[AS-079] an account switch refuses the new credential when old private cleanup is incomplete', async () => {
  const sessionStorage = storage(), localStorage = storage();
  const auth = createAuth({ origin: 'https://case.test', sessionStorage, localStorage,
    caches: { keys: async () => ['case-private'], delete: async () => false }, indexedDB: null,
    schedule: () => 1, clearSchedule: () => {},
    fetchImpl: async (url, init) => String(url).endsWith('/config')
      ? new Response(JSON.stringify(CONFIG), { status: 200 })
      : new Response(JSON.stringify(session(JSON.parse(init.body).email === 'new@example.invalid'
        ? '550e8400-e29b-41d4-a716-446655440001' : undefined)), { status: 200 }) });
  assert.equal(await auth.verifyOtp('old@example.invalid', '123456'), 'access-one');
  assert.equal(await auth.verifyOtp('new@example.invalid', '123456'), null);
  assert.equal(auth.accessToken(), null);
  assert.equal(localStorage.getItem('case:auth:refresh'), null);
});

test('[AS-079] a quick pagehide during restore keeps the stored refresh and admits no late credential', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const localStorage = storage(), sessionStorage = storage();
  localStorage.setItem('case:auth:refresh', 'local-refresh-only');
  const auth = createAuth({ origin: 'https://case.test', localStorage, sessionStorage,
    caches: null, indexedDB: null,
    schedule: () => 1, clearSchedule: () => {},
    fetchImpl: async url => String(url).endsWith('/config')
      ? new Response(JSON.stringify(CONFIG), { status: 200 })
      : new Promise(resolve => { release = resolve; entered(); }) });
  const restoring = auth.restore();
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('refresh did not start')), 100))]);
  await auth.teardown('pagehide');
  release(new Response(JSON.stringify(session()), { status: 200 }));
  assert.equal(await restoring, null);
  assert.equal(auth.accessToken(), null);
  assert.equal(localStorage.getItem('case:auth:refresh'), 'local-refresh-only');
  assert.deepEqual(sessionStorage.entries(), []);
});

test('[AS-079] pagehide keeps the stored refresh on every device; a 401 and explicit sign-out clear it', async () => {
  for (const end of ['unauthorised', 'sign_out']) {
    const tab = harness();
    await tab.auth.verifyOtp('owner@example.invalid', '123456');
    await tab.auth.teardown('pagehide');
    assert.equal(tab.auth.accessToken(), null);
    assert.equal(tab.localStorage.getItem('case:auth:refresh'), 'refresh-one');
    if (end === 'unauthorised') await tab.auth.handle401(); else await tab.auth.teardown(end);
    assert.equal(tab.localStorage.getItem('case:auth:refresh'), null, end);
  }
});

test('[AS-079] a throwing PKCE read on pagehide still clears access memory and fails closed', async () => {
  const run = harness();
  await run.auth.verifyOtp('owner@example.invalid', '123456');
  run.sessionStorage.getItem = () => { throw new Error('storage denied'); };
  const result = await run.auth.teardown('pagehide');
  assert.equal(run.auth.accessToken(), null);
  assert.deepEqual(result, { complete: false });
});

test('[AS-079] Auth config fails closed when public values are missing and never calls an Auth origin', async () => {
  const run = harness();
  run.requests.length = 0;
  const bad = createAuth({ origin: 'https://case.test', sessionStorage: storage(), localStorage: storage(),
    fetchImpl: async (url) => { run.requests.push({ url: String(url) });
      return new Response(JSON.stringify({ supabaseUrl: 'https://auth.example.invalid', publishableKey: null }), { status: 200 }); } });
  await assert.rejects(bad.requestOtp('owner@example.invalid'), /auth_unavailable/);
  assert.deepEqual(run.requests.map(call => call.url), ['https://case.test/api/v1/config']);
});

test('[AS-079] a refresh response arriving after sign-out or 401 cannot restore credentials', async () => {
  for (const reason of ['sign_out', 'unauthorised']) {
    let release;
    const run = harness(url => url.includes('grant_type=refresh_token')
      ? new Promise(resolve => { release = resolve; })
      : new Response(JSON.stringify(session()), { status: 200 }));
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    const pending = run.auth.refresh();
    await Promise.resolve();
    while (!release) await Promise.resolve();
    if (reason === 'sign_out') await run.auth.teardown('sign_out');
    else await run.auth.handle401();
    release(new Response(JSON.stringify(session(undefined, 'late')), { status: 200 }));
    await pending;
    assert.equal(run.auth.accessToken(), null);
    assert.equal(run.localStorage.getItem('case:auth:refresh'), null);
    assert.deepEqual(run.teardownReasons, [reason]);
  }
});

test('[AS-079] an OTP verification response arriving after sign-out cannot start a new account session', async () => {
  let release;
  const run = harness(() => new Promise(resolve => { release = resolve; }));
  const pending = run.auth.verifyOtp('owner@example.invalid', '123456');
  while (!release) await Promise.resolve();
  await run.auth.teardown('sign_out');
  release(new Response(JSON.stringify(session()), { status: 200 }));
  assert.equal(await pending, null);
  assert.equal(run.auth.accessToken(), null);
  assert.equal(run.localStorage.getItem('case:auth:refresh'), null);
  assert.deepEqual(run.teardownReasons, ['sign_out']);
});

test('[AS-079] an older account refresh cannot replace a newer signed-in account or tear it down', async () => {
  let release;
  const secondUser = '550e8400-e29b-41d4-a716-446655440001';
  const run = harness((url, init) => url.includes('grant_type=refresh_token')
    ? new Promise(resolve => { release = resolve; })
    : new Response(JSON.stringify(session(JSON.parse(init.body).email === 'new@example.invalid' ? secondUser : undefined,
      JSON.parse(init.body).email === 'new@example.invalid' ? 'new' : 'old')), { status: 200 }));
  await run.auth.verifyOtp('old@example.invalid', '123456');
  const oldRefresh = run.auth.refresh();
  while (!release) await Promise.resolve();
  await run.auth.verifyOtp('new@example.invalid', '123456');
  release(new Response(JSON.stringify(session(undefined, 'late-old')), { status: 200 }));
  await oldRefresh;
  assert.equal(run.auth.accessToken(), 'access-new');
  assert.equal(run.localStorage.getItem('case:auth:refresh'), 'refresh-new');
  assert.deepEqual(run.teardownReasons, ['account_changed']);

  // The old request's rejection and finally must leave the new account's active flight intact.
  let oldReply, oldEntered, newEntered;
  const newReplies = [];
  const oldStarted = new Promise(resolve => { oldEntered = resolve; });
  const newStarted = new Promise(resolve => { newEntered = resolve; });
  let newRefreshCalls = 0;
  const overlap = harness((url, init) => {
    if (url.includes('grant_type=refresh_token')) {
      const token = JSON.parse(init.body).refresh_token;
      if (token === 'refresh-old') return new Promise(resolve => { oldReply = resolve; oldEntered(); });
      newRefreshCalls++;
      return new Promise(resolve => { newReplies.push(resolve); newEntered(); });
    }
    const isNew = JSON.parse(init.body).email === 'new@example.invalid';
    return new Response(JSON.stringify(session(isNew ? secondUser : undefined, isNew ? 'new' : 'old')), { status: 200 });
  });
  await overlap.auth.verifyOtp('old@example.invalid', '123456');
  const stale = overlap.auth.refresh();
  await oldStarted;
  await overlap.auth.verifyOtp('new@example.invalid', '123456');
  const current = overlap.auth.refresh();
  await newStarted;
  oldReply(new Response('{}', { status: 401 }));
  assert.equal(await stale, null);
  const shared = overlap.auth.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  const observedCalls = newRefreshCalls;
  for (const reply of newReplies) reply(new Response(JSON.stringify(session(secondUser, 'newer')), { status: 200 }));
  const results = await Promise.all([current, shared]);
  assert.equal(observedCalls, 1);
  assert.deepEqual(results, ['access-newer', 'access-newer']);
  assert.equal(overlap.auth.accessToken(), 'access-newer');
  assert.equal(overlap.localStorage.getItem('case:auth:refresh'), 'refresh-newer');
  assert.deepEqual(overlap.teardownReasons, ['account_changed']);
});

test('[AS-079] throwing refresh storage fails closed and a scheduled refresh cannot reject unhandled', async () => {
  const broken = storage();
  const originalGet = broken.getItem;
  const reasons = [], timers = [];
  const auth = createAuth({ origin: 'https://case.test', sessionStorage: storage(), localStorage: broken,
    onTeardown: reason => reasons.push(reason), schedule: callback => { timers.push(callback); return 1; },
    clearSchedule: () => {}, fetchImpl: async url => String(url).endsWith('/config')
      ? new Response(JSON.stringify(CONFIG), { status: 200 })
      : new Response(JSON.stringify(session()), { status: 200 }) });
  await auth.verifyOtp('owner@example.invalid', '123456');
  broken.getItem = () => { throw new Error('private storage denied'); };
  assert.equal(await auth.refresh(), null);
  assert.equal(auth.accessToken(), null);
  assert.deepEqual(reasons, ['refresh_failed']);
  assert.equal(await auth.restore(), null);
  timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  broken.getItem = originalGet;
});

test('[AS-079] unavailable refresh storage cannot create a stranded access-token session', async () => {
  const auth = createAuth({ origin: 'https://case.test', sessionStorage: null, localStorage: null,
    schedule: () => 1, clearSchedule: () => {},
    fetchImpl: async url => String(url).endsWith('/config')
      ? new Response(JSON.stringify(CONFIG), { status: 200 })
      : new Response(JSON.stringify(session()), { status: 200 }) });
  assert.equal(await auth.verifyOtp('owner@example.invalid', '123456'), null);
  assert.equal(auth.accessToken(), null);
});
