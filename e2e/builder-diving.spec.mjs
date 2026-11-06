// Local-only supported-UI proof of the frozen private teaching adaptation.
// The committed source remains unreviewed for clinical accuracy and reuse rights.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { builderSaveCheckpoint, saveBuilderDraft } from '../tests/helpers/builder-save.mjs';

test.use({ ignoreHTTPSErrors: true });
const TRANSFER_PATH = process.env.CASE_BUILDER_DIVING_TRANSFER_PATH || fileURLToPath(new URL('../tests/fixtures/synthetic/builder-diving-transfer.json', import.meta.url));
const TRANSFER_SHA256 = '73c9c716e8a08e8fd576e49002b46112f07eccac57306ad979d47c8c014e3b0a';

async function measureLocalBrowser(page, cdp) {
  const [metrics, pageTiming] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');
      return {
        navigation: navigation ? {
          durationMs: navigation.duration, domInteractiveMs: navigation.domInteractive,
          domContentLoadedMs: navigation.domContentLoadedEventEnd, loadMs: navigation.loadEventEnd,
        } : null,
        resources: {
          count: resources.length,
          transferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0),
          decodedBytes: resources.reduce((sum, item) => sum + (item.decodedBodySize || 0), 0),
          durationMs: resources.reduce((sum, item) => sum + item.duration, 0),
        },
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      };
    }),
  ]);
  await cdp.detach();
  const wanted = new Set(['Timestamp', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize', 'LayoutDuration', 'RecalcStyleDuration']);
  return {
    method: 'Chromium CDP Performance.getMetrics plus Navigation/Resource Timing, enabled before navigation and captured after authenticated creation and studio render; cumulative browser telemetry, not parse-only profiling',
    pageTiming,
    cdpMetrics: Object.fromEntries(metrics.metrics.filter(item => wanted.has(item.name)).map(item => [item.name, item.value])),
  };
}
let auth, worker, shell;
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
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

async function signIn(page) {
  await page.goto(`${shell.origin}/cases/new`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function openNewCase(page) {
  const cases = new Map(), windows = new Map(), receipts = new Map(), checkpoints = new Map(), readbacks = new Map(), created = [], writes = [];
  const workspaceId = worker.workspaceId;
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const clone = value => structuredClone(value);
  await page.route(url => url.pathname === '/api/v1/cases' && !url.search, async route => {
    if (route.request().method() !== 'POST') return reply(route, { error: 'not_found' }, 404);
    const body = route.request().postDataJSON();
    if (body.workspaceId !== workspaceId || !body.title) return reply(route, { error: 'bad_request' }, 400);
    const caseId = uuidv7(); cases.set(caseId, { title: body.title, revision: 0, pair: null });
    created.push({ caseId, ...body }); return reply(route, { caseId }, 201);
  });
  await page.route(url => url.pathname.startsWith('/api/v1/builder/'), async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    const body = method === 'GET' ? null : route.request().postDataJSON();
    const match = /^\/api\/v1\/builder\/cases\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return reply(route, { error: 'not_found' }, 404);
    const caseId = match[1], suffix = match[2] ?? '';
    let state = cases.get(caseId);
    if (!state) { state = { title: 'Untitled case', revision: 0, pair: null }; cases.set(caseId, state); }
    let owned = checkpoints.get(caseId); if (!owned) { owned = []; checkpoints.set(caseId, owned); }
    const context = { case: { caseId, workspaceId, role: 'owner', title: state.title, sourceVersion: null } };
    if (suffix === 'draft' && method === 'GET') {
      if (state.revision === 0) return reply(route, { ...context, revision: 0, draft: null });
      const readback = { revision: state.revision, pair: clone(state.pair), intentDigest: `\\x${'a'.repeat(64)}` };
      if (!readbacks.has(caseId)) readbacks.set(caseId, []);
      readbacks.get(caseId).push(readback);
      return reply(route, { ...context, revision: state.revision, draft: { revision: readback.revision, ...readback.pair, intentDigest: readback.intentDigest } });
    }
    if (suffix === 'save-windows' && method === 'POST') {
      if (body.baseRevision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const operationId = uuidv7(); windows.set(operationId, { caseId, baseRevision: state.revision });
      return reply(route, { operationId, baseRevision: state.revision });
    }
    if (suffix === 'draft' && method === 'PUT') {
      const window = windows.get(body.operationId);
      if (!window || window.caseId !== caseId || window.baseRevision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const checked = validateBuilderDocument(body.document, body.authoringMetadata, { mode: 'preserve' });
      if (!checked.ok) return reply(route, { error: 'invalid_draft', issues: checked.errors }, 422);
      writes.push({ caseId, ...clone(body) }); state.pair = { document: clone(body.document), authoringMetadata: clone(body.authoringMetadata) };
      state.title = body.document.title; state.revision++;
      const receipt = { operationId: body.operationId, revision: state.revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' };
      receipts.set(body.operationId, receipt); return reply(route, receipt);
    }
    if (suffix === 'checkpoints' && method === 'GET') return reply(route, { checkpoints: owned.map(({ pair, ...row }) => row) });
    if (suffix === 'checkpoints' && method === 'POST') {
      if (!state.pair || body.expectedRevision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const checkpoint = { id: uuidv7(), name: body.name, revision: state.revision, schemaVersion: 2, createdAt: new Date().toISOString(), pair: clone(state.pair) };
      owned.push(checkpoint); const { pair, ...record } = checkpoint; return reply(route, record);
    }
    const receiptPath = suffix.match(/^save-windows\/([0-9a-f-]{36})$/);
    if (receiptPath && method === 'GET') {
      const receipt = receipts.get(receiptPath[1]); if (receipt) return reply(route, receipt);
      const window = windows.get(receiptPath[1]);
      return window ? reply(route, { operationId: receiptPath[1], baseRevision: window.baseRevision, status: 'issued', expiresAt: new Date(Date.now() + 60_000).toISOString() }) : reply(route, { error: 'not_found' }, 404);
    }
    return reply(route, { error: 'not_found' }, 404);
  });
  await signIn(page);
  await page.getByLabel('Case title', { exact: true }).fill('Diving source candidate — technical rehearsal only');
  await page.getByRole('button', { name: 'Create case draft', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  return {
    cases, created, writes,
    getPair(id) { return clone(cases.get(id)?.pair ?? null); },
    state(id) { return clone(cases.get(id)); },
    checkpoints(id) { return clone(checkpoints.get(id) ?? []); },
    receipt(id) { return clone(receipts.get(id) ?? null); },
    saveEvidence(id) {
      const state = cases.get(id);
      return { revision: state?.revision ?? 0, pair: clone(state?.pair ?? null),
        writes: writes.filter(write => write.caseId === id).map(write => ({ operationId: write.operationId,
          pair: { document: clone(write.document), authoringMetadata: clone(write.authoringMetadata) }, receipt: clone(receipts.get(write.operationId)) })),
        readbacks: clone(readbacks.get(id) ?? []) };
    },
  };
}

for (const bundle of [
  { label: 'frozen', path: TRANSFER_PATH, sha256: TRANSFER_SHA256, limit: 280 },
  { label: 'polished', path: fileURLToPath(new URL('../tests/fixtures/synthetic/builder-diving-polished-transfer.json', import.meta.url)), sha256: '337bf1688fc1b0288ac5d9c9d05cd0c08f442423dd786abf976e44acda68c27e', limit: 500 },
]) test(`${bundle.label} diving bundle enters through supported transfer UI, saves, checkpoints and rehearses without implying approval`, async ({ page }, testInfo) => {
  // The in-page rehearsal is the Preview fallback when the window is blocked (Inspect merged into Preview); block it here.
  await page.addInitScript(() => { window.open = () => null; });
  const TRANSFER_PATH = bundle.path, TRANSFER_SHA256 = bundle.sha256;
  const raw = await readFile(TRANSFER_PATH, 'utf8');
  const actualSha = createHash('sha256').update(raw).digest('hex');
  expect(actualSha).toBe(TRANSFER_SHA256);
  const envelope = JSON.parse(raw);
  expect(envelope).toMatchObject({ format: 'case-builder-transfer', transfer_version: 1, intent: 'copy' });
  const sourceMetadata = envelope.operations.find(operation => operation.path === '/authoring_metadata')?.value;
  expect(sourceMetadata?.sources?.[0]?.rights_status).toBe('unknown');
  const expectedSource = sourceMetadata.sources[0];

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const model = await openNewCase(page);
  const browserMetrics = await measureLocalBrowser(page, cdp);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Import and export', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: 'Import and export' }).getByRole('region', { name: 'Transfer Builder draft', exact: true });
  await expect(transfer).toBeVisible();
  for(const theme of ['light','dark'])for(const width of [320,390,768,1280]){
    await page.setViewportSize({width,height:900});await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  }
  const targetViolations=await transfer.locator('button,select,textarea,input').evaluateAll(nodes=>nodes
    .filter(node=>node.type!=='hidden'&&node.type!=='checkbox'&&node.type!=='radio'&&node.type!=='file')
    .map(node=>({name:node.getAttribute('aria-label')||node.innerText||node.type||node.tagName,rect:node.getBoundingClientRect().toJSON()}))
    .filter(({rect})=>rect.width<32||rect.height<32));
  expect(targetViolations).toEqual([]);
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:testInfo.outputPath('builder-transfer-workflow-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await page.screenshot({path:testInfo.outputPath('builder-transfer-workflow-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  // Choosing the file previews it: what it holds against this draft, and the rights warnings to review before acting.
  await transfer.getByLabel('Choose a transfer JSON file', { exact: true }).setInputFiles(TRANSFER_PATH);
  await expect(transfer.getByRole('group', { name: 'Import preview', exact: true })).toBeVisible();
  await expect(transfer.getByRole('button', { name: 'Import as a new case', exact: true })).toBeDisabled();
  await transfer.getByLabel('I reviewed unresolved source-rights warnings', { exact: true }).check();
  await expect(transfer.getByLabel('Rehearsal readiness', { exact: true })).toContainText('ready structurally');
  await expect(transfer).toContainText('Source, rights and editorial review remain separate');
  await expect(transfer.getByRole('button', { name: 'Import as a new case', exact: true })).toBeEnabled();
  // The newly created copy starts at revision zero; capture before the action, not after screenshots/autosave.
  const copySaveBaseline = builderSaveCheckpoint({ revision: 0, writes: [] });
  await transfer.getByRole('button', { name: 'Import as a new case', exact: true }).click();
  await expect.poll(() => model.created.length).toBe(2);
  const copiedCaseId = model.created[1].caseId;
  await expect(page.locator('.builder-studio')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeVisible();
  // Card 50 review capture: long authored names wrap beside truthful thumbnails; chips never cover captions (BWA33).
  const outline = page.locator('.builder-studio').getByRole('navigation', { name: 'Outline', exact: true });
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1600, height: 1000 }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect(page.locator('.builder-workspace')).toHaveAttribute('data-layout', 'wide');
    const chip = outline.locator('.builder-outline-foot button').first();
    if (await chip.getAttribute('aria-expanded') !== 'true') await chip.click();
    expect(await outline.evaluate(nav => [...nav.querySelectorAll('li:not([hidden]) .builder-outline-foot button')].filter(item => {
      const a = item.getBoundingClientRect(), b = item.closest('li').querySelector('.builder-outline-name').getBoundingClientRect();
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    }).length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`builder-outline-diving-${bundle.label}-${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('.builder-studio').getByRole('navigation', { name: 'Create regions', exact: true }).getByRole('button', { name: 'Outline', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath(`builder-outline-diving-${bundle.label}-mobile.png`) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await saveBuilderDraft(page, { expect, baseline: copySaveBaseline, evidence: () => model.saveEvidence(copiedCaseId) });
  await expect.poll(() => model.writes.filter(write => write.caseId === copiedCaseId).length).toBe(1);
  // The later reload needs a clean client, not just a counted write: a beforeunload guard would cancel it.
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');

  const saved = model.getPair(copiedCaseId);
  const savedMetadata = saved.authoringMetadata;
  expect(savedMetadata.sources).toHaveLength(1);
  expect(savedMetadata.sources[0].text).toBe(expectedSource.text);
  expect(savedMetadata.sources[0].sha256).toBe(expectedSource.sha256);
  expect(savedMetadata.sources[0].rights_status).toBe('unknown');
  expect(savedMetadata.provenance.length).toBeGreaterThan(0);
  expect(savedMetadata.provenance.every(entry => entry.review_status === 'unreviewed')).toBe(true);
  const retainedSourceIds = new Set(savedMetadata.sources.map(source => source.id));
  expect(savedMetadata.provenance.filter(entry => entry.source_id).every(entry => retainedSourceIds.has(entry.source_id))).toBe(true);
  const surfaces = saved.document.surfaces;
  expect(surfaces.map(surface => surface.scene)).toEqual(envelope.operations.find(operation => operation.path === '/surfaces').value.map(surface => surface.scene));
  if (bundle.label === 'polished') {
    expect(saved.document.beats).toHaveLength(21);
    expect(saved.document.beats.every(beat => !/part [12]/.test(beat.title))).toBe(true);
    expect(surfaces.filter(surface => surface.scene?.blocks).length).toBe(6);
  }
  expect(surfaces.find(surface => surface.scene?.length === 280)?.scene).toBe(
    envelope.operations.find(operation => operation.path === '/surfaces').value.find(surface => surface.scene?.length === 280).scene,
  );
  expect(saved.document.decisions.some(decision => decision.interaction?.type === 'free_text' && decision.interaction.max_length === bundle.limit)).toBe(true);
  expect(expectedSource.text).toContain('Free-text prompt, proposed limit 500 characters:');
  expect(saved.document.clarifications).toHaveLength(1);
  const firstDecisionBeat = saved.document.beats.find(beat => beat.decision_id);
  expect(saved.document.clarifications[0].beat_ids).toContain(firstDecisionBeat.id);
  expect(saved.document.decisions.flatMap(decision => decision.paths ?? []).filter(path => path.recovery).length).toBeGreaterThan(0);
  expect(saved.document.required_capabilities).toContain('required_recovery');

  // Optional local profiling records a representative imported pair; the functional replay always runs.
  const metricsPath = bundle.label === 'frozen' ? process.env.CASE_BUILDER_BROWSER_METRICS_PATH : null;
  const reloadCdp = metricsPath ? await page.context().newCDPSession(page) : null;
  if (reloadCdp) {
    await reloadCdp.send('Performance.enable');
    await reloadCdp.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReturnAsStream' });
  }
  await page.reload();
  let studio = page.locator('.builder-studio');
  await expect(studio.getByLabel('Case title', { exact: true })).toHaveValue(saved.document.title);
  if (reloadCdp) {
    const tracingComplete = new Promise(resolve => reloadCdp.once('Tracing.tracingComplete', resolve));
    await reloadCdp.send('Tracing.end');
    const { stream } = await tracingComplete;
    let traceJson = '';
    for (;;) {
      const chunk = await reloadCdp.send('IO.read', { handle: stream });
      traceJson += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
      if (chunk.eof) break;
    }
    await reloadCdp.send('IO.close', { handle: stream });
    const events = JSON.parse(traceJson).traceEvents;
    const compilation = {};
    for (const event of events) if (event.ph === 'X' && typeof event.dur === 'number' && /parse|compile/i.test(event.name)) {
      const row = compilation[event.name] ??= { count: 0, inclusiveDurationMs: 0 };
      row.count++; row.inclusiveDurationMs += event.dur / 1000;
    }
    const importedPairReload = await measureLocalBrowser(page, reloadCdp);
    importedPairReload.method = 'Local Chromium authenticated reload of the imported diving pair; Performance enabled before reload; V8/timeline parse/compile events are inclusive and may overlap, not exclusive CPU totals or production percentiles';
    await writeFile(metricsPath, `${JSON.stringify({ classification: 'local synthetic-API browser profiling; no hosted load or physical-device claim', sourceTextSha256: expectedSource.sha256, transferEnvelopeSha256: TRANSFER_SHA256, pairedJsonBytes: Buffer.byteLength(JSON.stringify(saved)), initialTemplate: browserMetrics, importedPairReload, parseCompileEvents: compilation }, null, 2)}\n`);
  }
  await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Manage checkpoints', exact: true }).click();
  await expect(studio.getByText('No checkpoints yet.', { exact: true })).toBeVisible();
  // This first checkpoint proves the reloaded saved pair can be checkpointed without changing it.
  await studio.getByRole('textbox', { name: 'Checkpoint name', exact: true }).fill('Diving candidate checkpoint');
  await studio.getByRole('button', { name: 'Create checkpoint', exact: true }).click();
  await expect(studio.getByText(/Checkpoint “Diving candidate checkpoint” created/)).toBeVisible();
  expect(model.state(copiedCaseId).revision).toBe(1);

  // The saved draft's direct preview URL shows the Run preview inline (CASE-226); once it is open, running the case
  // makes no Builder request at all.
  await page.goto(page.url().replace(/\/edit(?:\/[a-z]+)?(\?.*)?$/, '/edit/preview$1'));
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.getByRole('heading', { name: `Preview · shown here · ${saved.document.title}`, exact: true })).toBeVisible();
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await preview.getByRole('button', { name: 'Restart preview', exact: true }).click();
  const primary = preview.locator('.run-preview-rail .console-primary');
  await expect(primary).toHaveText('Start case'); await primary.click();
  const clarification = preview.getByRole('button', { name: 'Share '+saved.document.clarifications[0].label, exact: true });
  for (let i = 0; i < 24 && !(await clarification.count()); i++) await primary.click();
  await expect(clarification).toBeVisible();
  const roundAction = await primary.innerText();
  await clarification.click();
  await expect(primary).toHaveText('Return to decision');
  await expect(preview.locator('.run-preview')).toContainText(saved.document.surfaces.find(surface=>surface.id===saved.document.clarifications[0].surface_id).notes);
  await primary.click();
  await expect(primary).toHaveText(roundAction);
  for (let i = 0; i < 24 && (await primary.innerText()) !== 'Choose a path'; i++) await primary.click();
  await expect(primary).toHaveText('Choose a path');
  await expect(preview.locator('.run-preview')).not.toContainText(expectedSource.text);
  expect(requests.some(path => path.startsWith('/api/v1/sessions'))).toBe(false);
  expect(requests.some(path => path.startsWith('/api/v1/builder/'))).toBe(false);
  expect(new URL(page.url()).pathname).toBe(`/cases/${copiedCaseId}/edit/preview`);
  await expect(page.getByRole('region', { name: 'Private preview shown here', exact: true }).getByRole('button', { name: 'Retry in a window', exact: true })).toBeVisible();
  await expect(page.locator('.builder-studio')).toHaveCount(1);
  const saveReceipt = model.receipt(model.writes.find(write => write.caseId === copiedCaseId)?.operationId);
  const checkpoint = model.checkpoints(copiedCaseId).find(item => item.name === 'Diving candidate checkpoint');
  expect(saveReceipt).toMatchObject({ revision: 1, status: 'saved' });
  expect(checkpoint).toMatchObject({ revision: 1, schemaVersion: 2 });
  const pairedContentHash = createHash('sha256').update(JSON.stringify(saved)).digest('hex');
  const evidencePath = bundle.label === 'frozen' ? process.env.CASE_BUILDER_DIVING_UI_EVIDENCE_PATH : null;
  if (evidencePath) await writeFile(evidencePath, `${JSON.stringify({
    evidence_version: 1,
    classification: 'private technical browser evidence; no clinical or rights approval',
    transferEnvelopeSha256: TRANSFER_SHA256, sourceTextSha256: expectedSource.sha256,
    transferAuditSha256: '2462bd16f6020d49acb41342f9d882f3c113560b4d21b97c5ebd89d61dcb392b',
    caseId: copiedCaseId,
    workspaceId: worker.workspaceId,
    revision: model.state(copiedCaseId).revision,
    saveReceipt: { ...saveReceipt, authority: 'synthetic local browser route fixture; not a Worker or database receipt' },
    checkpoint: { id: checkpoint.id, name: checkpoint.name, revision: checkpoint.revision, schemaVersion: checkpoint.schemaVersion, createdAt: checkpoint.createdAt },
    pairedContentSha256: pairedContentHash,
    pairedContentSha256Method: 'SHA-256 over JSON.stringify({document,authoringMetadata}) captured from the local UI-submitted paired draft',
    checkpointPairSha256: createHash('sha256').update(JSON.stringify(checkpoint.pair)).digest('hex'),
    pairedDraft: saved,
    browserMetrics,
  }, null, 2)}\n`);
});
