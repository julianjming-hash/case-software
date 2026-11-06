import { casesUrl } from '../src/shared/urls.mjs';
// Card 10 built shell coverage; full served-room AS-061 UI coverage belongs to cards 12–14.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalWorker, createRoom, facilitatorCommand } from '../tests/helpers/local-worker.mjs';
import { withSecurityHeaders } from '../src/worker/headers.mjs';
import { joinDocumentCsp } from '../src/worker/join-policy.mjs';
import { execFileSync } from 'node:child_process';
let worker;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
const cached = page => page.evaluate(async () => {
  const keys = []; for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) keys.push(request.url);
  return keys;
});
async function controlled(page) {
  await page.goto(`${worker.origin}/`); await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}
test('built static routes use the shared effective security policy and /check is functional', async ({ page, request }) => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const response = await request.get(`${worker.origin}/check`); expect(response.status()).toBe(200);
  const expected = withSecurityHeaders(new Response(), 'html', { BUILD_SHA: sha }).headers;
  for (const [key, value] of expected) expect(response.headers()[key], key).toBe(value);
  await page.goto(`${worker.origin}/check?hold=5000&wait=1`);
  await expect(page.getByRole('heading', { name: 'Network check', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run the check', exact: true }).click();
  await expect(page.locator('#summary')).toHaveText('Ready: this network supports live updates.', { timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); expect((await cached(page)).length).toBeGreaterThan(10);
  expect(await page.evaluate(() => {
    let unapprovedPolicyBlocked = false;
    try { trustedTypes.createPolicy('unapproved', {}); } catch { unapprovedPolicyBlocked = true; }
    return { noDefaultHTMLPolicy: trustedTypes.defaultPolicy === null, unapprovedPolicyBlocked };
  })).toEqual({ noDefaultHTMLPolicy: true, unapprovedPolicyBlocked: true });
  const html = await request.get(`${worker.origin}/J/7K3QX9`); expect(html.status()).toBe(200); expect(html.headers()['content-security-policy']).toBe(joinDocumentCsp(expected.get('content-security-policy'), '/J/7K3QX9'));
  const assetUrl = (await html.text()).match(/src="(\/assets\/[^" ]+\.mjs)"/)[1];
  const asset = await request.get(`${worker.origin}${assetUrl}`); const assetPolicy = withSecurityHeaders(new Response(), 'immutable-asset', { BUILD_SHA: sha }).headers;
  for (const [key, value] of assetPolicy) expect(asset.headers()[key], key).toBe(value);
  const api = await request.get(`${worker.origin}/api/v1/not-a-route`); expect(api.status()).toBe(404); expect(api.headers()['content-type']).toContain('application/json');
  expect((await request.get(`${worker.origin}/unknown-client-route`)).status()).toBe(404);
});
test('[AS-076] shell caches never contain API responses or case packs across a real room lifetime', async ({ page }) => {
  await controlled(page); const room = await createRoom(worker.origin);
  await page.evaluate(async ({ room }) => {
    const token = { authorization: `Bearer ${room.facilitatorToken}` };
    for (const path of ['snapshot', 'case-pack']) { const result = await fetch(`/api/v1/sessions/${room.sessionId}/${path}`, { headers: token }); if (!result.ok) throw new Error('room read failed'); await result.json(); }
    const joined = await fetch('/api/v1/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, code: room.joinCode, displayName: 'Sam', avatarId: 'shadows-01' }) }); if (!joined.ok) throw new Error('room join failed');
  }, { room });
  expect((await facilitatorCommand(worker.origin, room, 'start')).receipt).toBe('accepted');
  expect((await facilitatorCommand(worker.origin, room, 'end')).receipt).toBe('accepted');
  const urls = await cached(page); expect(urls.filter(url => /\/api\/|\/cases\/|fixtures|case-pack/.test(url))).toEqual([]);
  const bodies = await page.evaluate(async () => { let text = ''; for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) if (/\.html$/.test(request.url)) text += await (await (await caches.open(name)).match(request)).text(); return text; });
  expect(bodies).not.toContain('high-speed MVC'); expect(bodies).not.toContain(room.facilitatorToken);
  await page.context().setOffline(true); await page.reload(); await expect(page.getByRole('heading', { name: 'Join the Case', exact: true })).toBeVisible();
  // Card 29: the facilitator document is served from the same shell offline, not only the root.
  await page.goto(casesUrl(worker.origin)); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});
test('[AS-077] a new built shell waits, offers an update, declines without reload and accepts before controllerchange reload', async ({ page }) => {
  await controlled(page);
  const before = await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('case-shell-')));
  const swPath = join(worker.assetDir, 'sw.mjs'); const old = readFileSync(swPath, 'utf8');
  // Mutate only this Worker's throwaway test output: a new wire/build name makes an actual new service worker.
  const oldName = old.match(/case-shell-wire1-[a-f0-9]{64}/)[0];
  const nextName = oldName.replace('wire1-', 'wire2-'); const next = old.replace(oldName, nextName);
  writeFileSync(swPath, next);
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await expect(page.getByRole('dialog')).toBeVisible(); let navigations = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))).toBe(true); expect(navigations).toBe(0);
    await page.reload(); await expect(page.getByRole('dialog')).toBeVisible(); navigations = 0;
    await page.getByRole('button', { name: 'Reload Case', exact: true }).click();
    await expect.poll(() => navigations).toBe(1);
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('case-shell-')))).toEqual([nextName]);
    expect(before).not.toEqual([nextName]);
  } finally { writeFileSync(swPath, old); }
});
