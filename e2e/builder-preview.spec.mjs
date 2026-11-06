import { test, expect } from '@playwright/test';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import sourceFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { ROUTES } from '../scripts/size-budget.mjs';

test.use({ ignoreHTTPSErrors: true });
let auth, worker, shell, draft;

function readyPreviewPair() {
  const converted = convertSchema1ToBuilderDocument(sourceFixture, { metadata_version: 1 });
  if (!converted.ok) throw new Error('Local source fixture did not convert to a preservable Builder document.');
  const document = converted.candidate;
  document.title = 'Private preview fixture';
  const start = document.beats.find(beat => beat.id === document.start_beat_id);
  const opening = document.surfaces.find(surface => surface.id === start.surface_id);
  opening.scene = { blocks: [
    { type: 'paragraph', runs: [{ text: 'Formatted preview sentinel ', bold: true }, { text: 'stays in the captured snapshot.' }] },
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'Authored list block.' }] }] },
  ] };
  const decisionBeat = document.beats.find(beat => beat.decision_id);
  const decision = document.decisions.find(item => item.id === decisionBeat.decision_id);
  for (const path of decision.paths) path.recovery = { prompt: 'Pause and ask the facilitator before continuing.' };
  document.clarifications = [{ id: uuidv7(), label: 'Preview clarification', surface_id: decisionBeat.surface_id, beat_ids: [decisionBeat.id] }];
  document.required_capabilities = ['formatted_text', 'required_recovery', 'early_clarification'];
  const metadata = { metadata_version: 1, preparation_requirements: 'PREVIEW_PRIVATE_METADATA_SENTINEL' };
  const readiness = validateBuilderDocument(document, metadata, { mode: 'ready' });
  if (!readiness.ok) throw new Error(`Local Builder preview fixture is not ready: ${JSON.stringify(readiness.errors.slice(0, 5))}`);
  return { document, authoringMetadata: metadata };
}

test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin,
    SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
    SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } });
  auth.setAppOrigin(shell.origin);
  draft = readyPreviewPair();
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

async function signIn(page, path = '/cases') {
  await page.goto(`${shell.origin}${path}`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('direct /edit/preview runs the exact saved paired draft inline after authentication; private metadata never reaches it', async ({ page }) => {
  await page.route(`**/api/v1/builder/cases/${worker.caseId}/draft`, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner' }, draft: {
      revision: 7, schemaVersion: 2, document: draft.document, authoringMetadata: draft.authoringMetadata,
      updatedAt: '2026-10-09T00:00:00.000Z', intentDigest: `\\x${'a'.repeat(64)}`,
    } }),
  }));
  await signIn(page, `/cases/${worker.caseId}/edit/preview`);
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.getByRole('heading', { name: 'Preview · shown here · Private preview fixture', exact: true })).toBeVisible();
  // From here on, running the case makes no write and no session (room) request.
  const calls = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (request.method() !== 'GET' || path.startsWith('/api/v1/sessions')) calls.push(`${request.method()} ${path}`); });
  await preview.getByRole('button', { name: 'Restart preview', exact: true }).click();
  await preview.locator('.run-preview-rail .console-primary').click();
  // Authored formatting reaches the real projector and phone as formatting.
  await expect(preview.frameLocator('iframe[title="Projector"]').locator('strong').filter({ hasText: 'Formatted preview sentinel' })).toBeVisible();
  await expect(preview.frameLocator('iframe[title="Phone"]').locator('.phone-app')).toContainText('Formatted preview sentinel');
  // Private authoring metadata is never part of the run.
  for (const frame of [preview, preview.frameLocator('iframe[title="Projector"]'), preview.frameLocator('iframe[title="Phone"]')])
    await expect(frame.locator('body')).not.toContainText('PREVIEW_PRIVATE_METADATA_SENTINEL');
  expect(new URL(page.url()).pathname).toBe(`/cases/${worker.caseId}/edit/preview`);
  expect(calls).toEqual([]);
});

// CASE-208: a Builder route's budget lists exactly the chunks a direct load of that route can request.
async function staticClosure(entry) {
  await init;
  const seen = new Set(), pending = [shell.entries[entry]];
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    if (file.endsWith('.mjs')) for (const item of parse(readFileSync(join(shell.outDir, file), 'utf8'))[0]) if (item.d === -1 && item.n?.startsWith('/assets/')) pending.push(item.n.slice(1));
  }
  return seen;
}

test('[AS-133] each Builder route requests only modules inside its budgeted members, never another view\'s deferred chunks (CASE-208)', async ({ browser }) => {
  const checks = { editor: 'route:/cases/:id/edit', workflows: 'route:/cases/:id/edit/workflows', preview: 'route:/cases/:id/edit/preview' };
  const loaded = {};
  // Card 51: each view runs again with slide_composition granted; the canvas chunk is the editor view's alone.
  for (const capabilities of [undefined, ['slide_composition']]) for (const [view, route] of Object.entries(checks)) {
    // A fresh context per view: no shared memory cache or service worker can hide or invent a request.
    const context = await browser.newContext({ ignoreHTTPSErrors: true }), page = await context.newPage();
    await page.route(`**/api/v1/builder/cases/${worker.caseId}/draft`, route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', ...(capabilities ? { capabilities } : {}) }, draft: {
        revision: 7, schemaVersion: 2, document: draft.document, authoringMetadata: draft.authoringMetadata, updatedAt: '2026-10-09T00:00:00.000Z', intentDigest: `\\x${'a'.repeat(64)}` } }) }));
    await signIn(page, view === 'editor' ? `/cases/${worker.caseId}/edit` : `/cases/${worker.caseId}/edit/${view}`);
    if (view === 'preview') {
      // Exercise the inline Run preview so its lazily loaded runtime (renderers, room art) is requested too.
      const preview = page.frameLocator('.builder-inline-preview-frame');
      await preview.getByRole('button', { name: 'Restart preview', exact: true }).click();
      await preview.locator('.run-preview-rail .console-primary').click();
      await expect(preview.frameLocator('iframe[title="Projector"]').locator('main')).toContainText('Formatted preview sentinel');
    } else if (view === 'workflows') {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Import and export', exact: true }).click();
      const transfer = page.getByRole('dialog', { name: 'Import and export' }).getByRole('region', { name: 'Transfer Builder draft', exact: true }); await expect(transfer).toBeVisible();
      await expect(transfer.getByRole('button', { name: 'Download this case', exact: true })).toBeVisible();
    } else await expect(page.locator('.builder-studio')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const requested = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
      .filter(path => path.startsWith('/assets/') && path.endsWith('.mjs')).map(path => path.slice(1)));
    // Scripts the HTML document references directly (the pre-paint appearance boot) are the document shell, which
    // no route module budget counts today; they are listed from the served page, not assumed.
    const allowed = new Set([...readFileSync(join(shell.outDir, 'index.html'), 'utf8').matchAll(/<script[^>]*\bsrc="\/(assets\/[^"]+\.mjs)"/g)].map(match => match[1]));
    expect([...allowed].map(file => file.replace(/\.[0-9a-f]{64}/, '')).sort()).toEqual(['assets/app.mjs', 'assets/appearance-boot.mjs']);
    for (const member of ROUTES[route]) for (const file of await staticClosure(member)) allowed.add(file);
    expect(requested.filter(file => !allowed.has(file)), `${view} requested modules outside ${route}`).toEqual([]);
    expect(requested, `${view} must budget the authenticated header trigger`).toContain(shell.entries['issue-entry']);
    expect(requested, `${view} must keep the reporting form click-deferred`).not.toContain(shell.entries['issue-reporter']);
    loaded[capabilities ? `${view}+slides` : view] = new Set(requested);
    await context.close();
  }
  for (const view of Object.keys(checks)) {
    expect(loaded[view].has(shell.entries['builder-slide-check']), `${view} loaded slide code without the capability`).toBe(false);
    expect(loaded[`${view}+slides`].has(shell.entries['builder-slide-check']), `${view}+slides`).toBe(true);
    expect(loaded[`${view}+slides`].has(shell.entries['builder-slides']), `${view}+slides canvas`).toBe(view === 'editor');
  }
  // The deferred chunks each view never needs are never requested by it.
  expect(loaded.workflows.has(shell.entries['builder-workflows'])).toBe(true);
  for (const name of ['builder-inspection', 'builder-preview-snapshot']) expect(loaded.workflows.has(shell.entries[name]), `workflows requested ${name}`).toBe(false);
  expect(loaded.preview.has(shell.entries['builder-inspection'])).toBe(true);
  expect(loaded.preview.has(shell.entries['builder-workflows']), 'preview requested builder-workflows').toBe(false);
});
