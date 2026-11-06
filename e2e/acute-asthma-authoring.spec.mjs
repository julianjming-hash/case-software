// Local-only authoring evidence. All clinical edits are throwaway copies; authored inputs stay byte-identical.
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { builderSaveCheckpoint, saveBuilderDraft } from '../tests/helpers/builder-save.mjs';

test.use({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
const paths = ['document', 'metadata', 'transfer'].map(kind => new URL(`../tests/fixtures/synthetic/sensor-authoring-${kind}.json`, import.meta.url));
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = pair => `\\x${hash(JSON.stringify(pair))}`;
const checked = pair => validateBuilderDocument(pair.document, pair.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
const currentCaseId = page => new URL(page.url()).pathname.match(/\/cases\/([0-9a-f-]{36})\/edit/)[1];
const slide = page => page.getByRole('region', { name: 'Slide editor', exact: true });

// Compare complete pairs while allowing the supported copy operation to remap UUID identities/references.
// These labels are comparison tokens only; authored/generated IDs always come from the shared UUIDv7 module.
function withoutCopyIds(pair) {
  const ids = new Map();
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(pair)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, id => {
    if (!ids.has(id)) ids.set(id, `COPY_ID_${ids.size + 1}`);
    return ids.get(id);
  });
}

let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin }); auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

async function localDraftApi(page, pair) {
  const cases = new Map([[worker.caseId, { title: pair.document.title, revision: 1, pair: clone(pair) }]]);
  const windows = new Map(), receipts = new Map(), writes = [], readbacks = [], created = [];
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route(url => url.pathname === '/api/v1/cases' && !url.search, async route => {
    if (route.request().method() !== 'POST') return reply(route, { error: 'not_found' }, 404);
    const body = route.request().postDataJSON();
    if (body.workspaceId !== worker.workspaceId || !body.title) return reply(route, { error: 'bad_request' }, 400);
    const caseId = uuidv7(); cases.set(caseId, { title: body.title, revision: 0, pair: null }); created.push(caseId);
    return reply(route, { caseId }, 201);
  });
  await page.route(url => url.pathname.startsWith('/api/v1/builder/'), async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const match = /^\/api\/v1\/builder\/cases\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return reply(route, { error: 'not_found' }, 404);
    const [, id, suffix = ''] = match, state = cases.get(id);
    if (!state) return reply(route, { error: 'not_found' }, 404);
    const body = method === 'GET' ? null : req.postDataJSON();
    if (suffix === 'draft' && method === 'GET') {
      const context = { case: { caseId: id, workspaceId: worker.workspaceId, title: state.title, role: 'owner', sourceVersion: null, capabilities: ['slide_composition'] }, revision: state.revision };
      if (!state.pair) return reply(route, { ...context, draft: null });
      const row = { caseId: id, revision: state.revision, pair: clone(state.pair), intentDigest: digest(state.pair) }; readbacks.push(row);
      return reply(route, { ...context, draft: { revision: row.revision, ...row.pair, intentDigest: row.intentDigest } });
    }
    if (suffix === 'save-windows' && method === 'POST') {
      if (body.baseRevision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const operationId = uuidv7(); windows.set(operationId, { caseId: id, revision: state.revision });
      return reply(route, { operationId, baseRevision: state.revision });
    }
    if (suffix === 'draft' && method === 'PUT') {
      const issued = windows.get(body.operationId);
      if (issued?.caseId !== id || issued.revision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const next = { document: body.document, authoringMetadata: body.authoringMetadata }, validation = checked(next);
      if (!validation.ok) return reply(route, { error: 'invalid_draft', issues: validation.errors }, 422);
      state.pair = clone(next); state.title = next.document.title; state.revision++;
      const receipt = { operationId: body.operationId, revision: state.revision, intentDigest: digest(next), status: 'saved' };
      receipts.set(body.operationId, receipt); writes.push({ caseId: id, operationId: body.operationId, pair: clone(next), receipt });
      return reply(route, receipt);
    }
    const receipt = /^save-windows\/([0-9a-f-]{36})$/.exec(suffix);
    if (receipt && method === 'GET') return receipts.has(receipt[1]) ? reply(route, receipts.get(receipt[1])) : reply(route, { status: 'not_found' }, 404);
    if (suffix === 'checkpoints' && method === 'GET') return reply(route, { checkpoints: [] });
    return reply(route, { error: 'not_found' }, 404);
  });
  return {
    created, writes,
    pair: id => clone(cases.get(id).pair),
    evidence: id => ({ revision: cases.get(id).revision, pair: clone(cases.get(id).pair), writes: clone(writes.filter(row => row.caseId === id)), readbacks: clone(readbacks.filter(row => row.caseId === id)) }),
  };
}

async function transferUi(page) {
  // The owner opens Import and export from the ⋯ menu, without running a publication action (CASE-344).
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Import and export', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: 'Import and export' }).getByRole('region', { name: 'Transfer Builder draft', exact: true });
  await expect(transfer).toBeVisible(); return transfer;
}
async function importCopy(page, model, filePath) {
  const transfer = await transferUi(page), before = model.created.length;
  await transfer.getByLabel('Choose a transfer JSON file', { exact: true }).setInputFiles(filePath);
  // Choosing the file previews it; the source-rights warning, when the file has one, is reviewed before either action.
  await expect(transfer.getByRole('group', { name: 'Import preview', exact: true })).toBeVisible();
  const rights = transfer.getByLabel('I reviewed unresolved source-rights warnings', { exact: true });
  if (await rights.isVisible()) await rights.check();
  await expect(transfer.getByRole('button', { name: 'Import as a new case', exact: true })).toBeEnabled();
  const baseline = builderSaveCheckpoint({ revision: 0, writes: [] });
  await transfer.getByRole('button', { name: 'Import as a new case', exact: true }).click();
  await expect.poll(() => model.created.length).toBe(before + 1);
  const id = model.created.at(-1);
  await expect(page.locator('.builder-studio')).toBeVisible();
  await saveBuilderDraft(page, { expect, baseline, evidence: () => model.evidence(id) });
  expect(currentCaseId(page)).toBe(id); return id;
}
async function saveEdit(page, model, id, action) {
  const baseline = builderSaveCheckpoint(model.evidence(id));
  await action(); await saveBuilderDraft(page, { expect, baseline, evidence: () => model.evidence(id) });
}
async function selectBeat(page, title) {
  await page.locator('.builder-outline-target').filter({ hasText: title }).first().click();
  await expect(slide(page).locator('.slide-canvas')).toBeVisible();
}

test('acute asthma: supported UI import, five human edits, saved readback, export and copy re-import', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const inputBytes = await Promise.all(paths.map(path => readFile(path))), inputHashes = inputBytes.map(hash);
  const pair = { document: JSON.parse(inputBytes[0]), authoringMetadata: JSON.parse(inputBytes[1]) };
  expect(checked(pair).ok).toBe(true);
  const external = [], errors = [], evidence = { inputHashes, mutations: [], screenshots: [] };
  const allowed = new Set([shell.origin, worker.origin, auth.origin]);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (allowed.has(url.origin) || ['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue();
    external.push(url.origin + url.pathname); return route.abort('blockedbyclient');
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.open = () => null; }); // Exercise the supported inline fallback.
  const model = await localDraftApi(page, pair);
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const id = await importCopy(page, model, paths[2].pathname);
  expect(withoutCopyIds(model.pair(id))).toBe(withoutCopyIds(pair));
  const imported = model.pair(id), doc = imported.document;
  const start = doc.beats.find(beat => beat.id === doc.start_beat_id);
  const composition = doc.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === start.id);
  const values = doc.blocks.find(block => block.type === 'values' && composition.reading_order.includes(block.id) && block.rows.some(row => row.label === 'MI'));
  expect(values, 'opening has native editable values with HR').toBeTruthy();
  const hrIndex = values.rows.findIndex(row => row.label === 'MI'); expect(values.rows[hrIndex].value).toBe('400');
  await selectBeat(page, start.title);
  await slide(page).locator(`[data-block-id="${values.id}"]`).click();
  await saveEdit(page, model, id, () => slide(page).locator(`[data-block-id="${values.id}"]`).getByRole('textbox', { name: `Value, row ${hrIndex + 1}`, exact: true }).fill('129'));
  expect(model.pair(id).document.blocks.find(b => b.id === values.id).rows[hrIndex].value).toBe('129');
  evidence.mutations.push({ kind: 'clinical value', blockId: values.id, before: '400', after: '129' });

  const decision = doc.decisions.find(d => d.prompt === 'Flhw on set set on set?');
  expect(decision).toBeTruthy(); const beat = doc.beats.find(b => b.decision_id === decision.id);
  await selectBeat(page, beat.title);
  await slide(page).locator('[data-block-type="question"], .slide-question').first().click();
  await saveEdit(page, model, id, () => slide(page).getByLabel('Question text', { exact: true }).fill(`${decision.prompt} Explain your priorities.`));
  expect(model.pair(id).document.decisions.find(d => d.id === decision.id).prompt).toBe(`${decision.prompt} Explain your priorities.`);
  evidence.mutations.push({ kind: 'question', decisionId: decision.id });

  const path = decision.paths.find(p => p.next_beat_id && !p.terminal);
  const destination = doc.beats.find(b => {
    if (b.id === path.next_beat_id || b.id === beat.id || b.id === start.id || b.kind === 'decision') return false;
    const probe = model.pair(id);
    probe.document.decisions.find(d => d.id === decision.id).paths.find(p => p.id === path.id).next_beat_id = b.id;
    return checked(probe).ok;
  });
  expect(destination).toBeTruthy();
  await page.locator('.builder-outline-target').filter({ hasText: path.label }).first().click();
  const response = page.locator('.builder-zone-response');
  if (await response.getAttribute('open') === null) await response.locator('> summary').click();
  await saveEdit(page, model, id, () => page.locator('select[aria-label="Continue to stage"]').selectOption(destination.id, { force: true }));
  expect(model.pair(id).document.decisions.find(d => d.id === decision.id).paths.find(p => p.id === path.id).next_beat_id).toBe(destination.id);
  evidence.mutations.push({ kind: 'branch destination', pathId: path.id, temporary: destination.id, restored: path.next_beat_id });
  // Restore the clinical route after proving a real saved destination edit; do not rehearse the arbitrary detour.
  await saveEdit(page, model, id, () => page.locator('select[aria-label="Continue to stage"]').selectOption(path.next_beat_id, { force: true }));

  await selectBeat(page, start.title);
  const privateZone = page.locator('.builder-zone-private');
  if (await privateZone.getAttribute('open') === null) await privateZone.locator('> summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true });
  const marker = 'LOCAL_AUTHORING_REVIEW_PRIVATE_MARKER';
  await saveEdit(page, model, id, async () => notes.fill(`${await notes.inputValue()}\n${marker}`));
  expect(model.pair(id).document.surfaces.find(s => s.id === start.surface_id).notes).toContain(marker);
  evidence.mutations.push({ kind: 'private note', surfaceId: start.surface_id, marker });

  const move = doc.blocks.find(b => b.type === 'callout' && composition.reading_order.includes(b.id));
  expect(move, 'opening has an editable examination callout').toBeTruthy();
  await slide(page).locator(`[data-block-id="${move.id}"]`).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await saveEdit(page, model, id, () => inspector.locator('select[aria-label="Reveal"]').selectOption('new', { force: true }));
  const edited = model.pair(id), nextComposition = edited.document.compositions.find(c => c.id === composition.id);
  expect(nextComposition.steps.at(-1).block_ids).toEqual([move.id]);
  expect(nextComposition.placements).toEqual(composition.placements);
  evidence.mutations.push({ kind: 'reveal step', blockId: move.id, lastStepId: nextComposition.steps.at(-1).id });
  await page.reload(); await expect(page.locator('.builder-studio')).toBeVisible();
  expect(model.evidence(id).readbacks.at(-1).pair).toEqual(edited);
  await selectBeat(page, start.title);
  await slide(page).locator(`[data-block-id="${values.id}"]`).click();
  await expect(slide(page).getByRole('textbox', { name: `Value, row ${hrIndex + 1}`, exact: true })).toHaveText('129');

  // Fit and reveal evidence from the actual served editor. No content shrink/overflow finding is suppressed.
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const size of ['projector-720', 'projector-1080']) {
      await page.locator('select[aria-label="Projector size"]').selectOption(size, { force: true });
      await expect(page.locator('.builder-fit-status')).toContainText(size === 'projector-720' ? '1280 × 720' : '1920 × 1080');
      await expect(slide(page).locator('[data-overflow]')).toHaveCount(0);
      const filename = `asthma-editor-${size}-${theme}.png`; await page.screenshot({ path: testInfo.outputPath(filename), fullPage: true });
      evidence.screenshots.push(filename);
    }
  }
  await page.getByRole('button', { name: 'Preview reveals', exact: true }).click();
  const stepper = slide(page).getByRole('group', { name: 'Reveal preview', exact: true });
  await expect(stepper).toBeVisible();
  await stepper.getByRole('button', { name: 'Reveal next step', exact: true }).click();
  evidence.revealPreview = await stepper.textContent();

  // The actual Run preview draws the published projector/phone renderers in local, standards-mode frames.
  await page.setViewportSize({width:2000,height:1600});
  await page.getByRole('button', { name: 'Preview this case', exact: true }).click();
  const previewRoom = page.frameLocator('.builder-inline-preview-frame');
  await expect(previewRoom.getByRole('button', { name: 'Restart preview', exact: true })).toBeVisible();
  await previewRoom.getByRole('button', { name: 'Restart preview', exact: true }).click();
  await previewRoom.locator('.run-preview-rail .console-primary').click();
  const phone = previewRoom.frameLocator('iframe[title="Phone"]'), projector = previewRoom.frameLocator('iframe[title="Projector"]');
  // Round 8: the arrival slide discloses progressively; the edited vitals arrive with its second step.
  await expect(projector.locator('body')).toContainText('27:44 · Circuet');
  await expect(projector.locator('body')).not.toContainText('129');
  await previewRoom.locator('.run-preview-rail .console-primary').click();
  await expect(phone.locator('body')).toContainText('129');
  await expect(projector.locator('body')).toContainText('129');
  for (const frame of [phone, projector]) {
    await expect(frame.locator('body')).not.toContainText(marker);
    expect(await frame.locator('html').evaluate(node => node.ownerDocument.compatMode)).toBe('CSS1Compat');
  }
  await previewRoom.getByRole('group', { name: 'Phone of', exact: true }).getByRole('button').first().click();
  for (const theme of ['light', 'dark']) {
    for (const frame of [phone, projector]) await frame.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
    const filename = `asthma-inline-phone-${theme}.png`;
    await previewRoom.locator('iframe[title="Phone"]').screenshot({ path: testInfo.outputPath(filename) }); evidence.screenshots.push(filename);
    expect(await phone.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
  evidence.phoneViewport = await phone.locator('html').evaluate(node => ({ width: node.ownerDocument.defaultView.innerWidth, height: node.ownerDocument.defaultView.innerHeight }));
  await page.getByRole('button', { name: 'Leave preview', exact: true }).click();

  const transfer = await transferUi(page);
  // One download; what else the file includes is chosen first, in the fold (private fields are in by default).
  await transfer.locator('summary', { hasText: 'Choose what the file includes' }).click();
  for (const label of ['Include private preparation requirements', 'Include source lineage'])
    await transfer.getByLabel(label, { exact: true }).check();
  if (edited.authoringMetadata.sources?.length) {
    await transfer.getByLabel('Include selected source text', { exact: true }).check();
    await transfer.getByLabel('Include provenance for selected sources', { exact: true }).check();
    await transfer.getByLabel('I acknowledge source records marked unknown have unresolved rights', { exact: true }).check();
    for (const choice of await transfer.locator('[aria-label="Source records to include"] input[type="checkbox"]').all()) await choice.check();
  }
  const [download] = await Promise.all([page.waitForEvent('download'), transfer.getByRole('button', { name: 'Download this case', exact: true }).click()]);
  const exportPath = testInfo.outputPath('asthma-human-edited.transfer.json'); await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  const inspected = await inspectBuilderTransfer(exported, { acknowledgeRedactions: true, acknowledgeRightsWarnings: true });
  expect(inspected.ok).toBe(true);
  expect(inspected.candidate.document).toEqual(edited.document);
  expect(inspected.candidate.authoring_metadata).toEqual(edited.authoringMetadata);
  await page.getByRole('dialog', { name: 'Import and export' }).getByRole('button', { name: 'Close', exact: true }).click();
  const secondId = await importCopy(page, model, exportPath);
  expect(secondId).not.toBe(id);
  expect(withoutCopyIds(model.pair(secondId))).toBe(withoutCopyIds(edited));
  evidence.copyIds = [id, secondId]; evidence.finalRevision = model.evidence(secondId).revision;
  expect(external).toEqual([]); expect(errors).toEqual([]);
  expect((await Promise.all(paths.map(path => readFile(path)))).map(hash)).toEqual(inputHashes);
  await writeFile(testInfo.outputPath('asthma-authoring-evidence.json'), JSON.stringify({ ...evidence, externalRequests: external, pageErrors: errors }, null, 2));
});

test('acute asthma: every native composition and reveal prefix fits the shipped projector renderer', async ({page}, testInfo) => {
  test.setTimeout(120_000);
  const pair = {document:JSON.parse(await readFile(paths[0],'utf8')),authoringMetadata:JSON.parse(await readFile(paths[1],'utf8'))};
  await localDraftApi(page,pair);
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email',{exact:true}).fill('owner@example.invalid');
  await page.getByRole('button',{name:'Email me a sign-in code',exact:true}).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  await expect(page.locator('.builder-fit-status')).toContainText('1280');
  const moduleUrl = await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name).find(name=>/\/builder-fit\.[^/]+\.mjs$/.test(new URL(name).pathname)));
  expect(moduleUrl,'native fit module is loaded by the actual Builder').toBeTruthy();
  await page.setViewportSize({width:2000,height:1400});
  const report = await page.evaluate(async ({moduleUrl,caseDocument})=>{
    const native = await import(moduleUrl);
    const rows=[];
    for(const theme of ['light','dark']) {
      document.documentElement.dataset.theme=theme;
      // The probe appends its frame synchronously; the Builder may append its own hidden probes later, so never take the last one.
      const before=new Set(document.querySelectorAll('iframe[title="Projector fit check"]'));
      const probe=native.createFitProbe(document);
      const frame=[...document.querySelectorAll('iframe[title="Projector fit check"]')].find(f=>!before.has(f));
      await probe.measure(caseDocument,{beatId:caseDocument.start_beat_id});
      await frame.contentDocument.fonts.ready;
      for(const view of ['projector-720','projector-1080']) {
        for(const composition of caseDocument.compositions) {
          const path=composition.owner.kind==='path'?caseDocument.decisions.flatMap(d=>d.paths).find(p=>p.id===composition.owner.id):null;
          const ownerDecision=path?caseDocument.decisions.find(d=>d.paths.includes(path)):null;
          const clarification=composition.owner.kind==='clarification'?caseDocument.clarifications.find(c=>c.id===composition.owner.id):null;
          // A path is drawn in its decision beat's frame. Never match on decision_id alone: a teaching beat has none, so
          // undefined===undefined matched the first beat and every decision slide was measured without its options.
          const beatId=clarification?clarification.beat_ids[0]:composition.owner.kind==='beat'?composition.owner.id:null;
          const beat=beatId?caseDocument.beats.find(b=>b.id===beatId):caseDocument.beats.find(b=>b.decision_id&&b.decision_id===ownerDecision?.id);
          const selection={beatId:beat.id,compositionId:composition.id,...(path?{pathId:path.id}:{})};
          await probe.measure(caseDocument,selection,view);
          const blocks=composition.reading_order.map(id=>caseDocument.blocks.find(b=>b.id===id));
          for(let step=0;step<composition.steps.length;step++) {
            for(const phase of beat.kind==='decision'&&!path?['open','results']:['open']) {
              const result=native.drawStage(frame.contentDocument,{document:caseDocument,beat,path,slide:{composition,blocks,authored:true},step,view,search:false,phase});
              rows.push({theme,view,compositionId:composition.id,title:clarification?.label??path?.label??beat.title,step,phase,...result});
            }
          }
        }
      }
      probe.destroy();
    }
    return rows;
  },{moduleUrl,caseDocument:pair.document});
  await writeFile(testInfo.outputPath('asthma-all-slide-fit.json'),JSON.stringify(report,null,2));
  // Every decision slide is measured with its options and its results, in both themes and both views.
  // A clarification's slide is drawn in its first beat's frame, so one in a decision beat shows results too.
  const frameBeat=c=>pair.document.beats.find(b=>b.id===(c.owner.kind==='clarification'?pair.document.clarifications.find(x=>x.id===c.owner.id).beat_ids[0]:c.owner.id));
  const decisionSteps=pair.document.compositions.filter(c=>c.owner.kind!=='path'&&frameBeat(c)?.kind==='decision').reduce((n,c)=>n+c.steps.length,0);
  expect(decisionSteps).toBeGreaterThan(0);
  expect(report.filter(row=>row.phase==='results').length).toBe(decisionSteps*4);
  const failures=report.filter(row=>!row.fits||row.marked||row.blocks?.some(b=>b.over));
  // Responses that cannot fit beside the context take its room, and only then (prototypes/question-slot-fit.html).
  const room=(title,view='projector-720')=>report.find(row=>row.theme==='light'&&row.view===view&&row.title===title&&row.phase==='results')?.room;
  expect([room('Valhb indicathc'),room('Controllhq'),room('Feedbaf1')]).toEqual(['slide','context',null]);
  expect(report.filter(row=>row.phase==='open'&&row.room)).toEqual([]);
  expect(failures,JSON.stringify(failures)).toEqual([]);
  // Capture representative pristine slides at actual projector pixels using the same measured renderer.
  for(const [title,filename] of [['27:44 · Circuet','asthma-arrival'],['Senshj feedbahk','asthma-gas'],['Flfp flfq, indicatfr flfs on sensfu','asthma-timing'],['Indicatfw','asthma-pressures'],['Flgr circugs 5/2','asthma-debrief']]) {
    const capture = await page.evaluate(async ({moduleUrl,caseDocument,title})=>{
      document.documentElement.dataset.theme='dark';
      const native=await import(moduleUrl);const before=new Set(document.querySelectorAll('iframe[title="Projector fit check"]'));
      window.asthmaProofProbe=native.createFitProbe(document);
      const frame=[...document.querySelectorAll('iframe[title="Projector fit check"]')].find(f=>!before.has(f));frame.dataset.asthmaProof='';
      const beat=caseDocument.beats.find(b=>b.title===title);
      if(!beat)throw new Error(`no slide titled ${title}`);
      await window.asthmaProofProbe.measure(caseDocument,{beatId:beat.id},'projector-720');
      Object.assign(frame.style,{left:'0',top:'0',visibility:'visible',zIndex:'999999'});
      frame.removeAttribute('aria-hidden');
      await frame.contentDocument.fonts.ready;
      frame.contentWindow.scrollTo(0,0);
      for(const node of frame.contentDocument.querySelectorAll('.screen,.top,.title,.case'))node.scrollTop=0;
      await window.asthmaProofProbe.measure(caseDocument,{beatId:beat.id},'projector-720');
      await new Promise(done=>frame.contentWindow.requestAnimationFrame(()=>frame.contentWindow.requestAnimationFrame(done)));
      const node=frame.contentDocument.querySelector('.top .case'),header=frame.contentDocument.querySelector('.top');
      const range=frame.contentDocument.createRange();range.selectNodeContents(node);
      const text=range.getBoundingClientRect(),box=header.getBoundingClientRect();
      return {title,textTop:text.top,textBottom:text.bottom,headerTop:box.top,headerBottom:box.bottom,scrollY:frame.contentWindow.scrollY,fontStatus:frame.contentDocument.fonts.status};
    },{moduleUrl,caseDocument:pair.document,title});
    await writeFile(testInfo.outputPath(`${filename}-capture.json`),JSON.stringify(capture,null,2));
    expect(capture.textTop,JSON.stringify(capture)).toBeGreaterThanOrEqual(capture.headerTop);
    expect(capture.textBottom,JSON.stringify(capture)).toBeLessThanOrEqual(capture.headerBottom);
    await page.locator('iframe[data-asthma-proof]').screenshot({path:testInfo.outputPath(`${filename}.png`),animations:'disabled'});
    await page.evaluate(()=>{window.asthmaProofProbe.destroy();delete window.asthmaProofProbe;});
  }
});
