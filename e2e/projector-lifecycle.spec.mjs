// Actual served console/projector lifecycle, with local Worker and throwaway Auth only.
import { test, expect } from '@playwright/test';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { closeRoomSetup, endCase, enterManualRoom, openRoomSetup, projectorPage } from '../tests/helpers/console-v2.mjs';
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

async function signedIn(page) {
  await page.goto(casesUrl(shell.origin));
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
}


for (const outcome of ['online end', 'manual end', 'sign out']) {
  test(`same-PC projector terminal lifecycle: ${outcome}`, async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const fac = await context.newPage();
      await signedIn(fac);
      const created = shell.waitForCreatedRoom();
      await (await openCase(fac)).click();
      const room = await created;
      // Start room opened the same-PC projector in its own click (console layout v2).
      const projector = await projectorPage(fac);
      await expect(projector.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
      await expect(fac.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
      await fac.getByRole('button', { name: 'Start case', exact: true }).click();
      await expect(projector.locator('.scene h1')).toBeVisible();
      const liveTitle = await projector.locator('.scene h1').textContent();
      if (outcome === 'manual end') {
        await enterManualRoom(fac);
        await expect(projector.getByText('Manual session mode · facilitator-led discussion')).toBeVisible();
      }
      if (outcome === 'sign out') {
        await fac.getByRole('button', { name: 'Open menu', exact: true }).click();
        const menu = fac.getByRole('dialog', { name: 'Menu', exact: true });
        await expect(menu).toBeVisible();
        await expect(menu.getByText('owner@example.invalid', { exact: true })).toBeVisible();
        await menu.getByRole('button', { name: 'Sign out', exact: true }).click();
  await fac.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
        await expect(fac.getByLabel('Email')).toBeVisible();
        await expect(projector.getByRole('heading', { name: 'Waiting for the session…', exact: true })).toBeVisible();
        await expect(projector.locator('#main')).not.toContainText(liveTitle);
        await expect(projector.getByRole('heading', { name: 'Session ended', exact: true })).toHaveCount(0);
      } else {
        // Console layout v2: End case confirms in place (press again), never a pop-up.
        await endCase(fac);
        // Card 40 slice 6: an online End shows the ended summary first; a manual (local-only) End returns straight to the case.
        if (outcome === 'online end') await fac.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click();
        await expect(fac.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
        await expect(projector.getByRole('heading', { name: 'Session ended', exact: true })).toBeVisible();
        await expect(projector.locator('#main')).not.toContainText(liveTitle);
      }
      expect(await fac.evaluate(sessionId => ({ active: sessionStorage.getItem('case:console:active-room'),
        segment: sessionStorage.getItem(`case-lab:segment:${sessionId}`) }), room.sessionId)).toEqual({ active: null, segment: null });
    } finally { await context.close(); }
  });
}
