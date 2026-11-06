// Actual original 83158 client build, not a validator mock or current UI labelled as old.
// Legacy authoring validation rejects new kinds; its online/manual runtime has no such pack gate.
import { test, expect } from '@playwright/test';
import { startLegacyHarness, openLegacyRoom, packText, LEGACY_SHA } from '../tests/helpers/legacy-facilitator.mjs';
import { captureLocalPublicFrames, assertPublicPrivacy, mirror, PRIVATE_MARKER } from '../tests/helpers/live-console-controls.mjs';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);
for (const kind of ['reflection','wrap_up']) test.describe(`original ${LEGACY_SHA.slice(0,7)} facilitator with ${kind}`, () => {
  let harness;
  test.beforeAll(async () => { harness = await startLegacyHarness(kind); });
  test.afterAll(async () => { await harness?.stop(); });
  test('online public text stays safe; legacy manual accepts the kind without new correction semantics or publishing a mutated pack', async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    await captureLocalPublicFrames(context);
    try {
      const { page, projector, room, commands } = await openLegacyRoom(context, harness);
      const original = await packText(harness, room);
      // Import the exact hashed module emitted by the original client build. Calling its authoring
      // validator here is evidence of its schema limitation, not an invented runtime pack gate.
      const checked = await page.evaluate(async ({ asset, document }) => {
        const { validateCaseDocument } = await import(asset);
        const before = JSON.stringify(document), rejected = validateCaseDocument(document);
        const compatible = structuredClone(document);
        for (const surface of compatible.surfaces) if (['reflection','wrap_up'].includes(surface.kind)) surface.kind = 'text';
        return { rejected, compatible: validateCaseDocument(compatible), unchanged: before === JSON.stringify(document) };
      }, { asset: harness.shell.validatorAsset, document: JSON.parse(original) });
      expect(checked.compatible.ok).toBe(true);
      expect(checked.rejected.ok).toBe(false);
      expect(checked.rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'enum', at: `/surfaces/${harness.fixture.doc.surfaces.findIndex(surface => surface.id === harness.fixture.s.open)}/kind` })]));
      expect(checked.unchanged).toBe(true);
      await expect(page.locator('.console-room-sees')).toContainText(`Public ${kind} <b>TEXT_ONLY_SENTINEL</b>.`);
      await expect(projector.locator('body')).toContainText(`Public ${kind} <b>TEXT_ONLY_SENTINEL</b>.`);
      await expect(page.locator('.console-room-sees b')).toHaveCount(0);
      await expect(projector.locator('.scene')).toContainText(`<b>TEXT_ONLY_SENTINEL</b>`);
      await expect(projector.locator('.scene b')).toHaveCount(0);
      await expect(projector.locator('b').filter({ hasText: 'TEXT_ONLY_SENTINEL' })).toHaveCount(0);
      await expect(page.locator('.console-only-you')).toContainText(PRIVATE_MARKER);
      const frames = await assertPublicPrivacy(projector);
      expect(frames.some(frame => frame.view.surface?.kind === kind)).toBe(true);
      const serverBefore = await mirror(harness, room), count = commands.length;
      await page.getByRole('tab', { name: /^Room/ }).click();
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Enter manual room mode', exact: true }).click();
      await expect(page.locator('body')).toContainText('Manual room mode. Keep this tab open during an outage.');
      await page.getByRole('tab', { name: 'Run', exact: true }).click();
      await expect.poll(async () => projector.evaluate(() => window.__consoleControlsPublicFrames.at(-1)?.view.manual)).toBe(true);
      await expect(projector.locator('body')).toContainText(`Public ${kind} <b>TEXT_ONLY_SENTINEL</b>.`);
      // The old manual path is permissive, not an unsupported-kind refusal. The immutable published
      // document is never sent back, and the server stays unchanged before a deliberate segment upload.
      expect(commands.length).toBe(count);
      expect((await mirror(harness, room)).revision).toBe(serverBefore.revision);
      expect(await packText(harness, room)).toBe(original);
      const saved = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`case-lab:segment:${id}`)), room.sessionId);
      expect(saved.events[0].type).toBe('enter_manual');
      expect(JSON.stringify(saved)).not.toContain(PRIVATE_MARKER);
      expect(JSON.stringify(saved)).not.toContain('caseDoc');
      await expect(page.getByRole('button', { name: /^Undo(?:\s|$)/ })).toHaveCount(0);
      const cached = await page.evaluate(async () => {
        const urls = [], bodies = [];
        for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
          urls.push(request.url); bodies.push(await (await (await caches.open(name)).match(request)).text());
        }
        return { urls, bodies: bodies.join('\n') };
      });
      expect(cached.urls.filter(url => /\/api\/|case-pack/.test(url))).toEqual([]);
      for (const privateValue of [PRIVATE_MARKER, room.facilitatorToken, harness.fixture.s.open]) expect(cached.bodies).not.toContain(privateValue);
      await assertPublicPrivacy(projector);
    } finally { await context.close(); }
  });

  if (kind === 'reflection') test('genuine waiting service worker uses shipped Later/Reload consent while the live room remains unchanged', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    await captureLocalPublicFrames(context); let update, updatePage, cdp;
    const versions = [], observations = [], errors = [];
    const bounded = (list, value) => { if (list.length < 250) list.push(value); };
    context.on('page', page => page.on('pageerror', error => bounded(errors, { name: error.name })));
    await context.addInitScript(() => {
      const events = [], identities = new WeakMap(); let next = 0, registration;
      const worker = value => {
        if (!value) return null;
        if (!identities.has(value)) identities.set(value, ++next);
        return { identity: identities.get(value), scriptURL: value.scriptURL, state: value.state };
      };
      const record = kind => {
        if (events.length >= 250) return;
        events.push({ kind, controller: worker(navigator.serviceWorker.controller),
          active: worker(registration?.active), waiting: worker(registration?.waiting),
          installing: worker(registration?.installing) });
      };
      const watched = new WeakSet();
      const watch = value => {
        if (!value || watched.has(value)) return;
        watched.add(value); value.addEventListener('statechange', () => record('worker-statechange'));
      };
      navigator.serviceWorker.addEventListener('controllerchange', () => record('controllerchange'));
      navigator.serviceWorker.ready.then(value => {
        registration = value; record('registration-ready');
        watch(value.active); watch(value.waiting); watch(value.installing);
        value.addEventListener('updatefound', () => { record('updatefound'); watch(value.installing); });
      });
      addEventListener('DOMContentLoaded', () => {
        const dialog = document.getElementById('updateDialog');
        if (!dialog) return;
        // This identifies registration.waiting when the real shipped offer opens the dialog.
        // It does not intercept or prove the eventual native postMessage target.
        new MutationObserver(() => record(dialog.open ? 'offer-dialog-open' : 'offer-dialog-closed'))
          .observe(dialog, { attributes: true, attributeFilter: ['open'] });
      });
      addEventListener('error', event => { if (events.length < 250) events.push({ kind: 'javascript-error', name: event.error?.name ?? 'Error' }); });
      window.__legacyWorkerObservation = { events, capture: record };
    });
    // Main 38554188464 (shard 4) failed here: the Reload Case click was handled (the dialog closed) but the waiting
    // worker never left `installed`, so nothing activated and no navigation followed; it passes locally (16 of 16 under
    // load). Every record is timed against the test's start, and worker errors are kept, so a recurrence shows whether
    // the consent message reached the waiting worker and when each worker started or stopped around it.
    const started = Date.now(), at = () => Date.now() - started, workerErrors = [];
    const observe = async stage => {
      let state;
      try { state = await updatePage.evaluate(stage => {
        const value = window.__legacyWorkerObservation;
        value?.capture(stage); return value?.events ?? null;
      }, stage); } catch { state = null; }
      bounded(observations, { stage, at: at(), state });
    };
    try {
      const { page, projector, room } = await openLegacyRoom(context, harness);
      updatePage = page; cdp = await context.newCDPSession(page);
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: values }) => values.forEach(
        ({ versionId, registrationId, scriptURL, status, runningStatus, controlledClients }) =>
          bounded(versions, { at: at(), versionId, registrationId, scriptURL, status, runningStatus, controlledClients })));
      cdp.on('ServiceWorker.workerErrorReported', ({ errorMessage }) => bounded(workerErrors, { at: at(), versionId: errorMessage?.versionId, message: String(errorMessage?.errorMessage ?? '').slice(0, 200) }));
      await cdp.send('ServiceWorker.enable'); await observe('before-install');
      const before = await mirror(harness, room), original = await packText(harness, room);
      let navigations = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
      update = harness.shell.installWaitingBuild();
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => registration.update()));
      const dialog = page.locator('#updateDialog'); await expect(dialog).toBeVisible();
      await page.getByRole('button', { name: 'Later', exact: true }).click();
      expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))).toBe(true);
      expect(navigations).toBe(0);
      expect((await mirror(harness, room)).revision).toBe(before.revision);
      expect(await packText(harness, room)).toBe(original);
      await expect(projector.locator('body')).toContainText('TEXT_ONLY_SENTINEL');
      // watchUpdate offers each waiting worker once. A fresh page load is the existing AS077
      // re-presentation path; it must be deliberate and must not change the case publication.
      page.on('dialog', prompt => prompt.type() === 'beforeunload' ? prompt.accept() : prompt.dismiss());
      await page.reload(); await expect(dialog).toBeVisible(); navigations = 0;
      await observe('before-reload-consent');
      await page.getByRole('button', { name: 'Reload Case', exact: true }).click();
      await observe('after-reload-consent');
      await expect.poll(() => navigations).toBe(1);
      await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('case-shell-')))).toEqual([update.next]);
      const after = await mirror(harness, room);
      expect(after.revealed).toEqual(before.revealed);
      expect(await packText(harness, room)).toBe(original);
    } finally {
      try {
        if (updatePage) await observe('final');
        await testInfo.attach('legacy-native-worker-lifecycle', { body: Buffer.from(JSON.stringify({
          observations, versions, errors, workerErrors })), contentType: 'application/json' });
      } finally {
        try { await cdp?.detach(); }
        finally { update?.restore(); await context.close(); }
      }
    }
  });
});
