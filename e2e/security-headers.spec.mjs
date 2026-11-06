import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { HTML } from '../tests/helpers/security-policy-page.mjs';
import { withSecurityHeaders } from '../src/worker/headers.mjs';

let server, origin;
test.beforeAll(async () => {
  server = createServer(async (request, outgoing) => {
    const script = request.url === '/policy.mjs';
    const response = withSecurityHeaders(new Response(script ? readFileSync(new URL('../tests/fixtures/security-policy.mjs', import.meta.url)) : HTML, { headers: { 'content-type': script ? 'text/javascript' : 'text/html' } }), script ? 'asset' : 'html');
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

test('strict HTML policy blocks Trusted Types sinks and preserves projector BroadcastChannel with COOP', async ({ page }) => {
  const response = await page.goto(origin);
  expect(response.headers()['cross-origin-opener-policy']).toBe('same-origin');
  await expect.poll(() => page.evaluate(() => window.policyProbe)).toMatchObject({ scriptLoaded: true, trustedTypesBlocked: true });
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open projector' }).click();
  const projector = await opened;
  await projector.waitForLoadState();
  expect(await projector.evaluate(() => window.opener)).toBeNull();
  await expect.poll(() => projector.evaluate(() => window.policyProbe?.scriptLoaded)).toBe(true);
  await page.evaluate(() => window.policyPing());
  await expect.poll(() => projector.evaluate(() => window.policyProbe.messages)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.policyProbe.messages)).toBe(1);
  expect(await page.locator('#probe').textContent()).toBe('Text only');
  await projector.close();
});
