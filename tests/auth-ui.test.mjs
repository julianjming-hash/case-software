import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../src/client/auth.mjs';
import { accountRequest, mountAccount } from '../src/client/auth-ui.mjs';

function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key) };
}

function authFixture({ refuseRefresh = false } = {}) {
  let account = 1;
  const reasons = [], authRequests = [];
  const auth = createAuth({ origin: 'https://case.test', sessionStorage: storage(), localStorage: storage(),
    caches: null, indexedDB: null, schedule: () => 1, clearSchedule: () => {},
    onTeardown: reason => reasons.push(reason), fetchImpl: async url => {
      const path = new URL(url).pathname; authRequests.push(path);
      return path.endsWith('/config')
        ? Response.json({ supabaseUrl: 'https://auth.test', publishableKey: 'sb_publishable_fake' })
        : refuseRefresh && path.endsWith('/token') ? Response.json({ error: 'invalid_refresh' }, { status: 401 })
        : Response.json({ access_token: `access-${account}`, refresh_token: `refresh-${account}`,
          expires_in: 3600, user: { id: account === 1
            ? '00000000-0000-7000-8000-000000000001' : '00000000-0000-7000-8000-000000000002' } });
    } });
  return { auth, reasons, authRequests, nextAccount: () => { account = 2; } };
}

test('[AS-079] a late 401 from the prior account cannot sign out the newer account', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture();
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    let reply;
    globalThis.fetch = () => new Promise(resolve => { reply = resolve; });
    const oldRequest = accountRequest(run.auth, ['me']).catch(error => error);
    run.nextAccount();
    await run.auth.verifyOtp('new@example.invalid', '123456');
    assert.equal(run.auth.accessToken(), 'access-2');
    reply(new Response(null, { status: 401 }));
    assert.ok(await oldRequest instanceof Error);
    assert.equal(run.auth.accessToken(), 'access-2');
    assert.deepEqual(run.reasons, ['account_changed']);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation;
    await run.auth.teardown('sign_out'); }
});

test('[AS-079] a late success from the prior account cannot return stale profile data', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture();
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    let reply;
    globalThis.fetch = () => new Promise(resolve => { reply = resolve; });
    const oldRequest = accountRequest(run.auth, ['me']).catch(error => error);
    run.nextAccount();
    await run.auth.verifyOtp('new@example.invalid', '123456');
    reply(Response.json({ profile: 'old-account-private-data' }));
    assert.ok(await oldRequest instanceof Error);
    assert.equal(run.auth.accessToken(), 'access-2');
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation;
    await run.auth.teardown('sign_out'); }
});

for (const [transition, cancellation] of [['sign_out', 'pending'], ['account_changed', 'pending'],
  ['account_changed', 'throws'], ['account_changed', 'rejects']]) {
  test(`[AS-079] stale fetched headers after ${transition} cancel the unread body without waiting (${cancellation})`, async () => {
    const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
    const run = authFixture();
    let reply, watchdog, signal, cancels = 0, reads = 0;
    try {
      globalThis.location = { origin: 'https://case.test' };
      await run.auth.verifyOtp('owner@example.invalid', '123456');
      globalThis.fetch = (_url, init) => { signal = init.signal; return new Promise(resolve => { reply = resolve; }); };
      const request = accountRequest(run.auth, ['me'], { timeoutMs: 1_000 }).catch(error => error);
      assert.equal(typeof reply, 'function', 'fetch is in flight before ownership changes');
      if (transition === 'sign_out') await run.auth.teardown('sign_out');
      else { run.nextAccount(); await run.auth.verifyOtp('new@example.invalid', '123456'); }
      const body = new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('{"profile":"PRIVATE_OLD_ACCOUNT"}')); },
        cancel() { cancels++; return new Promise(() => {}); },
      }, { highWaterMark: 0 });
      const response = new Response(body);
      // Native cancellation may reject (locked/blocked streams); an adapter may also throw.
      // Exercise both failure shapes with private diagnostics that must never escape to the UI.
      if (cancellation !== 'pending') response.body.cancel = () => {
        cancels++;
        const privateError = Object.assign(new Error('PRIVATE_CANCEL_DIAGNOSTIC'), { status: 401, code: 'private_code' });
        if (cancellation === 'throws') throw privateError;
        return Promise.reject(privateError);
      };
      reply(response);
      const result = await Promise.race([request,
        new Promise(resolve => { watchdog = setTimeout(() => resolve('watchdog'), 180); })]);
      assert.ok(result instanceof Error, `stale request waited for cancellation: ${result}`);
      assert.equal(result.message, 'request_unavailable');
      assert.deepEqual(Object.keys(result), [], 'private cancellation status/code is not a request refusal');
      assert.equal(cancels, 1, 'the early stale branch must release its unread response body');
      assert.equal(signal.aborted, true, 'the abandoned native fetch must terminate even after headers');
      assert.equal(reads, 0, 'no stale private body reaches the reader');
      assert.equal(response.body.locked, false);
      assert.equal(run.auth.accessToken(), transition === 'sign_out' ? null : 'access-2');
      await new Promise(resolve => setImmediate(resolve)); // rejected cancel must be contained this turn
    } finally {
      clearTimeout(watchdog); globalThis.fetch = originalFetch; globalThis.location = originalLocation;
      await run.auth.teardown('sign_out');
    }
  });
}

test('[AS-079] current fetched headers read the account body without premature cancellation', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture(); let signal, cancels = 0, emitted = false;
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    globalThis.fetch = async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({
      pull(controller) {
        if (emitted) { controller.close(); return; }
        emitted = true; controller.enqueue(new TextEncoder().encode('{"profile":"CURRENT_ACCOUNT"}'));
      },
      cancel() { cancels++; },
    }, { highWaterMark: 0 })); };
    assert.deepEqual(await accountRequest(run.auth, ['me']), { profile: 'CURRENT_ACCOUNT' });
    assert.equal(emitted, true); assert.equal(cancels, 0);
    assert.equal(signal.aborted, false, 'a current successful account read is not an abandoned request');
    assert.equal(run.auth.accessToken(), 'access-1');
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation;
    await run.auth.teardown('sign_out'); }
});

for (const outcome of ['refresh_success', 'refresh_refused', 'second_401']) {
  test(`[AS-079] current 401 releases each unread native response while preserving Auth delegation (${outcome})`, async () => {
    const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
    const run = authFixture({ refuseRefresh: outcome === 'refresh_refused' });
    let calls = 0, cancels = 0, watchdog; const signals = [];
    try {
      globalThis.location = { origin: 'https://case.test' };
      await run.auth.verifyOtp('owner@example.invalid', '123456');
      globalThis.fetch = async (_url, init) => {
        calls++; signals.push(init.signal);
        if (calls > 1 && outcome === 'refresh_success') return Response.json({ profile: 'CURRENT_ACCOUNT' });
        return new Response(new ReadableStream({
          pull() { assert.fail('a refused unread 401 body must not be consumed'); },
          cancel() { cancels++; return new Promise(() => {}); },
        }, { highWaterMark: 0 }), { status: 401 });
      };
      const request = accountRequest(run.auth, ['me'], { timeoutMs: 1_000 }).catch(error => error);
      const result = await Promise.race([request,
        new Promise(resolve => { watchdog = setTimeout(() => resolve('watchdog'), 180); })]);
      const abandoned = outcome === 'second_401' ? 2 : 1;
      assert.equal(cancels, abandoned, 'each current401 response is released without awaiting native cancel');
      assert.ok(signals.slice(0, abandoned).every(signal => signal.aborted), 'abandoned401 native fetches terminate');
      assert.equal(run.authRequests.filter(path => path.endsWith('/token')).length, 1, 'one genuine refresh; retry does not recurse again');
      assert.equal(calls, outcome === 'refresh_refused' ? 1 : 2);
      if (outcome === 'refresh_success') {
        assert.deepEqual(result, { profile: 'CURRENT_ACCOUNT' }); assert.equal(signals[1].aborted, false);
        assert.equal(run.auth.accessToken(), 'access-1'); assert.deepEqual(run.reasons, []);
      } else {
        assert.ok(result instanceof Error, `Auth refusal waited for cancellation: ${result}`);
        assert.equal(result.message, 'request_unavailable'); assert.deepEqual(Object.keys(result), []);
        assert.equal(run.auth.accessToken(), null);
        assert.deepEqual(run.reasons, outcome === 'refresh_refused' ? ['refresh_failed', 'unauthorised'] : ['unauthorised']);
      }
    } finally {
      clearTimeout(watchdog); globalThis.fetch = originalFetch; globalThis.location = originalLocation;
      await run.auth.teardown('sign_out');
    }
  });
}

for (const transition of ['sign_out', 'account_changed']) {
  test(`[AS-079] ownership changes during a pending body read abort the abandoned native request (${transition})`, async () => {
    const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
    const run = authFixture();
    let signal, controller, markReading, watchdog, cancels = 0;
    const reading = new Promise(resolve => { markReading = resolve; });
    try {
      globalThis.location = { origin: 'https://case.test' };
      await run.auth.verifyOtp('owner@example.invalid', '123456');
      globalThis.fetch = async (_url, init) => {
        signal = init.signal;
        return new Response(new ReadableStream({
          pull(value) { controller = value; markReading(); return new Promise(() => {}); },
          cancel() { cancels++; return new Promise(() => {}); },
        }, { highWaterMark: 0 }));
      };
      const pending = accountRequest(run.auth, ['me'], { timeoutMs: 1_000 }).catch(error => error);
      await reading;
      assert.equal(signal.aborted, false, 'the current request remains active while awaiting its first body chunk');
      if (transition === 'sign_out') await run.auth.teardown('sign_out');
      else { run.nextAccount(); await run.auth.verifyOtp('new@example.invalid', '123456'); }
      controller.enqueue(new TextEncoder().encode('{"profile":"PRIVATE_OLD_ACCOUNT"}'));
      const result = await Promise.race([pending,
        new Promise(resolve => { watchdog = setTimeout(() => resolve('watchdog'), 180); })]);
      assert.ok(result instanceof Error, `stale reader waited for cancellation: ${result}`);
      assert.equal(result.message, 'request_unavailable'); assert.deepEqual(Object.keys(result), []);
      assert.equal(cancels, 1, 'the stale private chunk causes unfinished reader cancellation');
      assert.equal(signal.aborted, true, 'unfinished streamed ownership refusal terminates the native fetch');
      assert.equal(run.auth.accessToken(), transition === 'sign_out' ? null : 'access-2');
    } finally {
      clearTimeout(watchdog); globalThis.fetch = originalFetch; globalThis.location = originalLocation;
      await run.auth.teardown('sign_out');
    }
  });
}

test('[AS-079] account response body stalled past its deadline fails without awaiting cancellation', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture();
  let signal, cancelled = false;
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    globalThis.fetch = (_url, init) => {
      signal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { cancelled = true; return new Promise(() => {}); },
      })));
    };
    const result = await Promise.race([
      accountRequest(run.auth, ['me'], { timeoutMs: 25 }).catch(error => error),
      new Promise(resolve => setTimeout(() => resolve('watchdog'), 180)),
    ]);
    assert.ok(result instanceof Error, `unexpected body outcome: ${result}`);
    assert.equal(signal?.aborted, true);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation;
    await run.auth.teardown('sign_out'); }
});

test('[AS-079] oversized streamed account response stops before buffering its full body', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture();
  let emitted = 0, cancelled = false;
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    globalThis.fetch = () => Promise.resolve(new Response(new ReadableStream({
      pull(controller) {
        if (emitted >= 20) { controller.close(); return; }
        emitted++; controller.enqueue(new Uint8Array(8192).fill(65));
      },
      cancel() { cancelled = true; },
    })));
    await assert.rejects(accountRequest(run.auth, ['me'], { timeoutMs: 100 }), /request_unavailable/);
    assert.ok(emitted <= 10, `buffered ${emitted} chunks`);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation;
    await run.auth.teardown('sign_out'); }
});

test('[AS-079] pagehide during next-load cleanup cannot start Auth restore or show a closed account', async () => {
  class Element {
    constructor() { this.classList = { add() {}, remove() {} }; this.handlers = {}; this.children = []; this.hidden = false; }
    append(...items) { this.children.push(...items); }
    prepend(...items) { this.children.unshift(...items); }
    addEventListener(kind, handler) { this.handlers[kind] = handler; }
    setAttribute() {}
  }
  const globals = ['document', 'window', 'location', 'navigator', 'screen', 'sessionStorage',
    'localStorage', 'caches', 'indexedDB', 'fetch'];
  const prior = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let releaseCleanup, cacheCalls = 0, authCalls = 0, signedIn = 0, mounted;
  try {
    const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const events = {};
    set('document', { createElement: () => new Element() });
    set('window', { addEventListener: (kind, handler) => { events[kind] = handler; } });
    set('location', { origin: 'https://case.test' });
    set('navigator', { userAgent: 'iPhone Mobile' });
    set('screen', { isExtended: false });
    set('sessionStorage', storage());
    set('localStorage', storage({ 'case:auth:refresh': 'opted-in-refresh' }));
    set('caches', { keys: () => cacheCalls++ === 0
      ? new Promise(resolve => { releaseCleanup = resolve; }) : Promise.resolve([]), delete: async () => true });
    set('indexedDB', null);
    set('fetch', async url => { authCalls++;
      return new URL(url).pathname.endsWith('/config')
        ? Response.json({ supabaseUrl: 'https://auth.test', publishableKey: 'sb_publishable_fake' })
        : Response.json({ access_token: 'late-access', refresh_token: 'new-refresh',
          expires_in: 3600, user: { id: '00000000-0000-7000-8000-000000000001' } }); });
    mounted = mountAccount(new Element(), { onSignedIn: () => { signedIn++; } });
    assert.equal(typeof releaseCleanup, 'function');
    events.pagehide();
    assert.equal(mounted.auth.accessToken(), null);
    releaseCleanup([]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(authCalls, 0);
    assert.equal(mounted.auth.accessToken(), null);
    assert.equal(signedIn, 0);
  } finally {
    if (mounted) await mounted.auth.teardown('sign_out');
    for (const key of globals) {
      if (prior[key]) Object.defineProperty(globalThis, key, prior[key]);
      else delete globalThis[key];
    }
  }
});

test('[C30-routes] a refused account request names its status and fixed error; extra headers are sent, never the body', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture();
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    const seen = [];
    globalThis.fetch = async (url, init) => { seen.push(init.headers); return Response.json({ error: 'name_taken' }, { status: 409 }); };
    const refused = await accountRequest(run.auth, ['workspaces', 'w', 'groups'], { method: 'POST', body: { name: 'x' },
      headers: { 'X-Admin-Elevation': 'token' } }).catch(error => error);
    assert.equal(refused.message, 'request_unavailable');
    assert.equal(refused.status, 409); assert.equal(refused.code, 'name_taken');
    assert.equal(seen[0]['X-Admin-Elevation'], 'token'); assert.match(seen[0].authorization, /^Bearer /);
    // An unknown or oversized error body is not passed on as a code.
    globalThis.fetch = async () => Response.json({ error: 'x'.repeat(100) }, { status: 400 });
    const odd = await accountRequest(run.auth, ['me']).catch(error => error);
    assert.equal(odd.status, 400); assert.equal(odd.code, null);
    // Only Authorization and Content-Type are fixed: a caller cannot replace the bearer.
    globalThis.fetch = async (url, init) => { seen.push(init.headers); return Response.json({ ok: true }); };
    await accountRequest(run.auth, ['me'], { headers: { authorization: 'Bearer forged', Authorization: 'Bearer forged' } });
    assert.notEqual(seen.at(-1).authorization, 'Bearer forged');
    assert.equal(Object.hasOwn(seen.at(-1), 'Authorization'), false);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation;
    await run.auth.teardown('sign_out'); }
});

test('[C45] large Builder draft reads opt into a bounded response size while ordinary account reads remain small', async () => {
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const run = authFixture();
  try {
    globalThis.location = { origin: 'https://case.test' };
    await run.auth.verifyOtp('owner@example.invalid', '123456');
    const payload = { document: 'x'.repeat(70_000) };
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(accountRequest(run.auth, ['builder', 'cases', '00000000-0000-7000-8000-000000000001', 'draft']), /request_unavailable/);
    assert.deepEqual(await accountRequest(run.auth, ['builder', 'cases', '00000000-0000-7000-8000-000000000001', 'draft'], { maxResponseBytes: 100_000 }), payload);
    // Caller limits cannot raise the authenticated response ceiling above 2 MiB.
    assert.deepEqual(await accountRequest(run.auth, ['builder', 'cases', '00000000-0000-7000-8000-000000000001', 'draft'], { maxResponseBytes: 9_000_000 }), payload);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation; await run.auth.teardown('sign_out'); }
});
