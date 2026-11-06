// Card 11: built static shell, real local Worker/DOs, fake PostgREST and a throwaway HTTPS GoTrue.
// The Auth stub is loopback-only; browser and Worker never reach a metered backend.
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { test, expect } from '@playwright/test';
import { STORAGE_FENCE_KEY } from '../src/client/storage-generation.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { apiUrl } from '../src/shared/urls.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { consoleReady } from '../tests/helpers/console-v2.mjs';

let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin,
      SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

test('[AS-079] served shell CSP permits only selected HTTPS Auth paths, never the Data API or another origin', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route('https://unrelated.invalid/**', route => route.abort());
  const page = await context.newPage();
  const response = await page.goto(casesUrl(shell.origin));
  const csp = response.headers()['content-security-policy'];
  expect(csp).toContain(`connect-src 'self' ${auth.origin}/auth/v1/;`);
  expect(csp).not.toContain('*');
  const violations = await page.evaluate(async ({ authOrigin }) => {
    const seen = [];
    document.addEventListener('securitypolicyviolation', event => seen.push({
      directive: event.effectiveDirective, blocked: event.blockedURI,
    }));
    for (const url of [`${authOrigin}/rest/v1/rpc/ping`, 'https://unrelated.invalid/data']) {
      try { await fetch(url); } catch { /* A CSP refusal is expected. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    return seen;
  }, { authOrigin: auth.origin });
  expect(violations.filter(event => event.directive === 'connect-src').map(event => event.blocked))
    .toEqual(expect.arrayContaining([`${auth.origin}/rest/v1/rpc/ping`, 'https://unrelated.invalid/data']));
  expect(auth.requests.some(request => request.path.startsWith('/rest/'))).toBe(false);
  await context.close();
});

test('[AS-079] missing runtime public key and mismatched static Auth origin fail closed before GoTrue', async ({ browser }) => {
  const noKeyWorker = await startPublishedWorker({ authOrigin: auth.origin, publishableKey: false });
  const noKeyShell = await startServedAuthShell({ apiOrigin: noKeyWorker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  try {
    const before = auth.requests.length;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(casesUrl(noKeyShell.origin));
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await expect(page.getByText('Sign-in is unavailable. Try again.')).toBeVisible();
    expect(auth.requests).toHaveLength(before);
    await context.close();
  } finally { await noKeyShell.stop(); await noKeyWorker.stop(); }
  const wrongShell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: 'https://other.invalid',
      SUPABASE_JWT_ISSUER: 'https://other.invalid/auth/v1',
      SUPABASE_JWKS_URL: 'https://other.invalid/auth/v1/.well-known/jwks.json' } });
  try {
    const before = auth.requests.length;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const response = await page.goto(casesUrl(wrongShell.origin));
    expect(response.headers()['content-security-policy']).toContain("connect-src 'self' https://other.invalid/auth/v1/;");
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await expect(page.getByText('Sign-in is unavailable. Try again.')).toBeVisible();
    expect(auth.requests).toHaveLength(before);
    await context.close();
  } finally { await wrongShell.stop(); }
});

test('[AS-079] OTP sign-in starts an owned published room and sign-out removes all credentials', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    sessionStorage.setItem('case:facilitator:main:token', 'stale-room');
    sessionStorage.setItem('case-lab:segment:room', 'stale-pack');
  });
  const page = await context.newPage(), urls = [];
  context.on('request', request => urls.push(request.url()));
  await page.goto(casesUrl(shell.origin));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('case:facilitator:main:token'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('case-lab:segment:room'))).toBeNull();
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
  // Card 38 (CASE-175): no opt-in; the refresh token is kept in localStorage on every device.
  await expect(page.getByLabel('Keep me signed in on this phone')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('case:auth:refresh'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
  await (await openCase(page)).click();
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true, level: 1 })).toBeVisible();
  await consoleReady(page);
  await expect(page.getByRole('button', { name: 'Start case' })).toBeEnabled();
  expect(worker.fake.requests.map(request => request.name)).toEqual(expect.arrayContaining([
    'get_me', 'list_case_catalogue_current', 'get_catalogue_case_history', 'get_case_version_for_workspace', 'create_session',
  ]));
  // Fresh next_load cleanup creates generation1; this deliberate sign-out advances it once.
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_FENCE_KEY)).toBe('1');
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByText('owner@example.invalid', { exact: true })).toBeVisible();
  await menu.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), STORAGE_FENCE_KEY)).toBe('2');
  const stored = await page.evaluate(() => ({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
  expect(stored.session.filter(([key]) => key.startsWith('case:'))).toEqual([]);
  expect(stored.local.filter(([key]) => key.startsWith('case:') && key !== 'case:transport:pin')).toEqual([[STORAGE_FENCE_KEY, '2']]);
  expect(urls.every(url => !url.includes(worker.jwt) && !url.includes('local-refresh-only') && !url.includes('owner@example.invalid'))).toBe(true);
  expect(auth.requests.map(request => request.path)).toContain('/auth/v1/verify');
  await context.close();
});

test('[AS-079] magic-link fallback returns to Case, strips the one-use code before Auth exchange, and signs in', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const authExchanges = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/auth/v1/token') authExchanges.push({
      pageUrl: page.url(), path: new URL(request.url()).pathname,
    });
  });
  await page.goto(casesUrl(shell.origin));
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Or email me a link instead' }).click();
  await expect(page.getByText('Check your email for a sign-in link.')).toBeVisible();
  await page.goto(`${shell.origin}/?code=local-one-use-code`);
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(authExchanges).toEqual([{ pageUrl: `${shell.origin}/`, path: '/auth/v1/token' }]);
  await context.close();
});

test('[card 38] every device stays signed in across a reload, a closed tab and a new context until Sign out', async ({ browser }) => {
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  const pc = await browser.newContext({ ignoreHTTPSErrors: true });
  let restored;
  try {
    for (const context of [phone, pc]) {
      let page = await context.newPage();
      await page.goto(casesUrl(shell.origin));
      await page.getByLabel('Email').fill('owner@example.invalid');
      await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
      await page.getByLabel('One-time code').fill('123456');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
      await page.reload();
      await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
      await page.close();
      page = await context.newPage(); await page.goto(casesUrl(shell.origin));
      await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('case:auth:refresh'))).toBeNull();
    }
    // A browser restart: a new context with the same storage is still signed in.
    restored = await browser.newContext({ ignoreHTTPSErrors: true, storageState: await pc.storageState() });
    const page = await restored.newPage(); await page.goto(casesUrl(shell.origin));
    await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    // Sign out is visible on /cases, not only in the menu, and clears the stored session.
    await page.getByRole('button', {name:'Open menu',exact:true}).click();await page.getByRole('dialog', {name:'Menu',exact:true}).getByRole('button', {name:'Sign out',exact:true}).click();await page.getByRole('button', {name:'Confirm sign out',exact:true}).click();
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    // The menu's Sign out does the same on the phone.
    const phonePage = phone.pages()[0];
    await phonePage.getByRole('button', { name: 'Open menu' }).click();
    await phonePage.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Sign out' }).click();
  await phonePage.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
    await expect(phonePage.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    expect(await phonePage.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
  } finally { await restored?.close(); await phone.close(); await pc.close(); }
});

test('[card 38] Sign out in one tab signs out every other tab of the browser', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const first = await context.newPage();
    await first.goto(casesUrl(shell.origin));
    await first.getByLabel('Email').fill('owner@example.invalid');
    await first.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await first.getByLabel('One-time code').fill('123456');
    await first.getByRole('button', { name: 'Sign in' }).click();
    await expect(first.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    const second = await context.newPage(); await second.goto(casesUrl(shell.origin));
    await expect(second.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    await first.getByRole('button', {name:'Open menu',exact:true}).click();await first.getByRole('dialog', {name:'Menu',exact:true}).getByRole('button', {name:'Sign out',exact:true}).click();await first.getByRole('button', {name:'Confirm sign out',exact:true}).click();
    await expect(second.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    await expect(second.getByRole('link', { name: 'Published case', exact: true })).toHaveCount(0);
    expect(await second.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
  } finally { await context.close(); }
});

test('[card 38] a 401 clears the stored session, and the next load never refreshes it again', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(casesUrl(shell.origin));
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill('123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    const refreshes = () => auth.requests.filter(request => request.method === 'POST' && request.path === '/auth/v1/token').length;
    const me = /\/api\/v1\/me\?/;
    await page.route(me, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorised"}' }));
    const before = refreshes();
    await page.reload();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    expect(refreshes()).toBe(before + 2); // the reload's restore and the one refresh before retrying the 401, then no loop
    await page.unroute(me);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(refreshes()).toBe(before + 2);
  } finally { await context.close(); }
});

test('[AS-080] a fresh signed-in phone approves a shared PC for an owned active room without a PC account session', async ({ browser }) => {
  const created = await fetch(apiUrl(worker.origin, 'sessions'), { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(created.status).toBe(201);
  const room = await created.json();
  worker.fake.replies.set('list_owned_active_sessions', [{ session_id: room.sessionId,
    join_code: room.joinCode, expires_at: room.expiresAt }]);
  const pc = await browser.newContext({ ignoreHTTPSErrors: true });
  const pcPage = await pc.newPage();
  const takeoverResponses = [];
  pcPage.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('/commands')) {
      takeoverResponses.push(response.json().then(body => ({
        type: response.request().postDataJSON()?.type, receipt: body.receipt?.receipt,
      })));
    }
  });
  await pcPage.goto(`${shell.origin}/P`);
  await expect(pcPage.getByText('Pair this PC')).toBeVisible();
  await expect(pcPage.getByRole('button', { name: 'Use a shared computer' })).toBeHidden();
  expect(await pcPage.locator('button').filter({ hasText: 'Use a shared computer' }).count()).toBe(0);
  await expect(pcPage.getByLabel('Email')).toHaveCount(0);
  // The code arrives after the pairing request; poll for it rather than reading the "…" placeholder.
  await expect(pcPage.getByLabel('PC approval code')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
  const code = await pcPage.getByLabel('PC approval code').textContent();
  expect(code.replace(/\s/g, '')).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  const phonePage = await phone.newPage();
  await phonePage.goto(`${shell.origin}/P`);
  await expect(phonePage.getByRole('button', { name: 'Use a shared computer' })).toBeVisible();
  await phonePage.evaluate(() => Object.defineProperty(screen, 'isExtended', { configurable: true, value: true }));
  await phonePage.getByRole('button', { name: 'Use a shared computer' }).click();
  await expect(phonePage.getByLabel('Email')).toHaveCount(0);
  await phonePage.evaluate(() => Object.defineProperty(screen, 'isExtended', { configurable: true, value: false }));
  await phonePage.getByRole('button', { name: 'Use a shared computer' }).click();
  await expect(phonePage.getByLabel('Keep me signed in on this phone')).toHaveCount(0);
  await phonePage.getByLabel('Email').fill('owner@example.invalid');
  await phonePage.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await phonePage.getByLabel('One-time code').fill('123456');
  await phonePage.getByRole('button', { name: 'Sign in' }).click();
  await phonePage.getByRole('button', { name: 'Approve a PC' }).click();
  await phonePage.getByLabel('PC code').fill(code.replace(/\s/g, ''));
  await phonePage.getByRole('button', { name: 'Preview device' }).click();
  await expect(phonePage.getByText(/Browser:/)).toBeVisible();
  await phonePage.getByRole('button', { name: `Approve room ${room.joinCode}` }).click();
  await expect(pcPage.getByText('PC ready')).toBeVisible();
  expect(await Promise.all(takeoverResponses)).toContainEqual({ type: 'takeover', receipt: 'accepted' });
  const oldCredential = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'snapshot'), {
    headers: { authorization: `Bearer ${room.facilitatorToken}` },
  });
  expect(oldCredential.status).toBe(401); // takeover fenced the earlier facilitator credential
  const pcStored = await pcPage.evaluate(() => ({ session: Object.keys(sessionStorage), local: Object.keys(localStorage) }));
  expect(pcStored.session.filter(key => key.startsWith('case:auth:'))).toEqual([]);
  expect(pcStored.local.filter(key => key.startsWith('case:auth:'))).toEqual([]);
  expect(worker.fake.requests.map(request => request.name)).toContain('list_owned_active_sessions');
  await phone.close(); await pc.close();
});

test('[AS-080] pagehide during PC pickup cannot restore a room credential or send takeover', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const pairSessionId = uuidv7();
  let releasePoll, sawPoll;
  const pollStarted = new Promise(resolve => { sawPoll = resolve; });
  const pollSettled = new Promise(resolve => { releasePoll = resolve; });
  const downstream = [];
  page.on('request', request => {
    if (/\/sessions\/[^/]+\/(?:snapshot|commands)$/.test(new URL(request.url()).pathname)) downstream.push(request.url());
  });
  await page.route('**/api/v1/console-pairs/*', async route => {
    sawPoll();
    await pollSettled;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        sessionId: pairSessionId, facilitatorToken: 'late-room-credential',
      }) });
    } catch { /* The pagehide abort can close this route before fulfillment. */ }
  });
  await page.goto(`${shell.origin}/P`);
  await expect(page.getByLabel('PC approval code')).toContainText(/[0-9A-HJKMNP-TV-Z]/);
  await pollStarted;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  releasePoll();
  await page.waitForTimeout(200);
  expect(downstream).toEqual([]);
  await expect(page.getByText('PC ready')).toHaveCount(0);
  await context.close();
});

test('[AS-080] shared PC cleans stale Case storage before pairing and on pagehide', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    sessionStorage.setItem('case:auth:refresh', 'stale-pc-refresh');
    localStorage.setItem('case:participant:main:token', 'stale-private-room');
  });
  const page = await context.newPage();
  await page.goto(`${shell.origin}/P`);
  await expect(page.getByLabel('PC approval code')).toContainText(/[0-9A-HJKMNP-TV-Z]/);
  expect(await page.evaluate(() => sessionStorage.getItem('case:auth:refresh'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('case:participant:main:token'))).toBeNull();
  await page.evaluate(() => sessionStorage.setItem('case:facilitator:main:token', 'late-private-room'));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('case:facilitator:main:token'))).toBeNull();
  await context.close();
});

test('[AS-080] switching /P from PC pairing to phone Auth transfers pagehide cleanup ownership', async ({ browser }) => {
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  const page = await phone.newPage();
  await page.goto(`${shell.origin}/P`);
  await page.getByRole('button', { name: 'Use a shared computer' }).click();
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Approve a PC' })).toBeVisible();
  await page.evaluate(async () => {
    const request = indexedDB.open('case:phone-outbox', 1);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    database.close();
    const original = indexedDB.deleteDatabase.bind(indexedDB);
    window.__pairCleanupDeletes = 0;
    indexedDB.deleteDatabase = name => { window.__pairCleanupDeletes++; return original(name); };
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  await expect.poll(() => page.evaluate(() => window.__pairCleanupDeletes)).toBe(1);
  await page.close();
  const next = await phone.newPage();
  await next.goto(`${shell.origin}/P`);
  await next.getByRole('button', { name: 'Use a shared computer' }).click();
  await expect(next.getByRole('button', { name: 'Approve a PC' })).toBeVisible();
  expect(await next.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
  await phone.close();
});

test('[AS-080] pagehide during PC-to-phone handoff cannot mount Auth on a closed page', async ({ browser }) => {
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  await phone.addInitScript(() => localStorage.setItem('case:auth:refresh', 'local-refresh-only'));
  const page = await phone.newPage();
  await page.goto(`${shell.origin}/P`);
  await expect(page.getByLabel('PC approval code')).toContainText(/[0-9A-HJKMNP-TV-Z]/);
  await page.evaluate(() => {
    const original = caches.keys.bind(caches);
    let first = true;
    caches.keys = () => {
      if (!first) return original();
      first = false;
      return new Promise(resolve => { window.__releasePcHandoff = () => resolve([]); });
    };
  });
  const before = auth.requests.length;
  await page.getByRole('button', { name: 'Use a shared computer' }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__releasePcHandoff)).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.evaluate(() => window.__releasePcHandoff());
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Email')).toHaveCount(0);
  expect(auth.requests).toHaveLength(before);
  await phone.close();
});
