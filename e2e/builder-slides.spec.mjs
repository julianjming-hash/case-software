// Card 51 phase 1: schema-3 slide authoring in the served Builder against a local mocked draft API that grants
// `slide_composition`. The live Worker grants nothing yet, so production behaviour is the negative test below.
import { test, expect } from '@playwright/test';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts, paragraphsText } from '../src/shared/slide-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import sourceFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';

test.use({ ignoreHTTPSErrors: true });
let auth, worker, shell;

test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

function schema2Pair() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(sourceFixture), { metadata_version: 1 });
  for (const surface of converted.candidate.surfaces) delete surface.variants;
  converted.candidate.title = 'Slide authoring fixture';
  return { document: converted.candidate, authoringMetadata: { metadata_version: 1 } };
}

/** A draft API with one case. Writes are validated exactly as the slide-activated server will validate them. */
async function mockDraft(page, pair, { capabilities }) {
  const state = { revision: 1, pair: structuredClone(pair), puts: [], gate: null }, windows = new Map(), receipts = new Map();
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const request = route.request(), method = request.method(), suffix = new URL(request.url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    const body = method === 'GET' ? null : request.postDataJSON();
    const context = { case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', title: state.pair.document.title, sourceVersion: null, ...(capabilities ? { capabilities } : {}) } };
    if (suffix === 'draft' && method === 'GET') return reply(route, { ...context, revision: state.revision, draft: { revision: state.revision, ...structuredClone(state.pair), intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'save-windows' && method === 'POST') {
      if (body.baseRevision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const operationId = uuidv7(); windows.set(operationId, state.revision); return reply(route, { operationId, baseRevision: state.revision });
    }
    if (suffix === 'draft' && method === 'PUT') {
      if (state.gate) await state.gate;
      if (windows.get(body.operationId) !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const checked = validateBuilderDocument(body.document, body.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
      if (!checked.ok) return reply(route, { error: 'invalid_draft', issues: checked.errors }, 422);
      state.pair = { document: structuredClone(body.document), authoringMetadata: structuredClone(body.authoringMetadata) }; state.revision++; state.puts.push(state.revision);
      const receipt = { operationId: body.operationId, revision: state.revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' };
      receipts.set(body.operationId, receipt); return reply(route, receipt);
    }
    if (suffix === 'checkpoints' && method === 'GET') return reply(route, { checkpoints: [] });
    const receipt = /^save-windows\/([0-9a-f-]{36})$/.exec(suffix);
    if (receipt && method === 'GET') return receipts.has(receipt[1]) ? reply(route, receipts.get(receipt[1])) : reply(route, { error: 'not_found' }, 404);
    return reply(route, { error: 'not_found' }, 404);
  });
  return state;
}

async function signIn(page, path) {
  await page.goto(`${shell.origin}${path}`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const inspector = page => page.getByRole('complementary', { name: 'Inspector', exact: true });
// New blocks come from the app bar's Add block menu (Round 4 study); each is added as its own reveal step and selected.
// CASE-225: the Builder's dropdowns are Case's own; each keeps its native select (hidden) as the value and change
// contract, so tests drive that select directly. One test below also operates the visible dropdown.
const choose = (scope, label, value) => scope.locator(`select[aria-label="${label}"]`).first().selectOption(value, { force: true });
// CASE-344: the add-block palette is the Inspector with nothing selected (one contextual inspector, no tabs).
const openPalette = async page => {
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  // At phone width one region shows at a time: the palette is in the Inspector.
  if (await page.locator('.builder-workspace').getAttribute('data-layout') === 'single') await page.locator('.builder-regions').getByRole('button', { name: 'Inspector', exact: true }).click();
  return tools.getByRole('group', { name: 'Add block', exact: true });
};
const addBlock = async (page, name) => { await (await openPalette(page)).getByRole('button', { name, exact: true }).click(); };
const startSlide = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);

test('[AS-148] a populated observations table and a toned callout are authored on the slide, saved, reloaded and stored exactly', async ({ page }, testInfo) => {
  const source = schema2Pair(), state = await mockDraft(page, source, { capabilities: ['slide_composition'] });
  const start = source.document.beats.find(beat => beat.id === source.document.start_beat_id);
  const sceneText = source.document.surfaces.find(surface => surface.id === start.surface_id).scene;
  expect(typeof sceneText).toBe('string');
  await signIn(page, `/cases/${worker.caseId}/edit`);
  await expect(page.locator('.builder-studio')).toBeVisible();

  // The upgrade is explicit and reviewed; nothing changes until it is confirmed, and Undo restores schema 2.
  await inspector(page).getByRole('button', { name: 'Review turning this draft into slides', exact: true }).click();
  const review = inspector(page).getByRole('group', { name: 'Review upgrade', exact: true });
  await expect(review).toContainText('Nothing is saved until you choose Save draft.');
  await review.getByRole('button', { name: 'Turn into slides', exact: true }).click();
  const slide = page.getByRole('region', { name: 'Slide editor', exact: true });
  await expect(slide.locator('.slide-canvas')).toBeVisible();
  await expect(slide).toContainText(sceneText.slice(0, 40));
  await expect(page.getByLabel('Learner scene', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(slide).toHaveCount(0);
  await expect(page.getByLabel('Learner scene', { exact: true })).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Review turning this draft into slides', exact: true }).click();
  await inspector(page).getByRole('group', { name: 'Review upgrade', exact: true }).getByRole('button', { name: 'Turn into slides', exact: true }).click();
  await expect(slide.locator('.slide-canvas')).toBeVisible();

  // Blank keeps every block (visibly unplaced); the new table then takes the free top band.
  await inspector(page).getByText('Layout and fill', { exact: false }).click();
  await inspector(page).getByRole('button', { name: 'Blank', exact: true }).click();
  await expect(slide.locator('.builder-slide-unplaced')).toContainText('unplaced');
  await addBlock(page, 'Table');
  const time1 = slide.getByLabel('Time, row 1', { exact: true });
  await expect(time1).toBeVisible();
  await expect(slide.locator('.slide-block[data-selected] table')).toBeVisible();
  // A two-row tab-separated range pastes atomically, grows the table and keeps the blank cell blank.
  await time1.focus();
  await time1.evaluate(input => {
    const data = new DataTransfer(); data.setData('text/plain', '00:00\tHR\t0110\tbpm\n00:05\tSpO₂\t\t%\n');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(slide.getByLabel('Value, row 2', { exact: true })).toHaveValue('');
  await expect(slide.getByLabel('Observation, row 2', { exact: true })).toHaveValue('SpO₂');
  // A caption is written in the Inspector; the slide draws no empty caption field (CASE-249). Once written it is edited in place.
  await expect(slide.getByLabel('Table caption', { exact: true })).toHaveCount(0);
  await time1.focus();
  await inspector(page).getByLabel('Caption', { exact: true }).fill('Observations on arrival');
  await inspector(page).getByLabel('Caption', { exact: true }).press('Tab');
  await expect(slide.getByLabel('Table caption', { exact: true })).toHaveValue('Observations on arrival');
  await slide.getByLabel('Value, row 1', { exact: true }).fill('<5');
  await slide.getByLabel('Value, row 1', { exact: true }).focus();
  await choose(inspector(page), 'Column alignment', 'end');
  // Pasting over content needs a reviewed confirmation; Cancel changes nothing.
  await slide.getByLabel('Value, row 1', { exact: true }).evaluate(input => {
    const data = new DataTransfer(); data.setData('text/plain', 'X\tY\n');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.builder-slide-review')).toContainText('Confirm to replace them.');
  await page.locator('.builder-slide-review').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(slide.getByLabel('Value, row 1', { exact: true })).toHaveValue('<5');
  await expect(slide.getByLabel('Unit, row 1', { exact: true })).toHaveValue('bpm');
  // A cell keeps a line break exactly (every text control is a textarea).
  await slide.getByLabel('Unit, row 2', { exact: true }).fill('%\nfinger probe');
  // A populated row is deleted only through Confirm, and Confirm applies it.
  await slide.getByLabel('Time, row 2', { exact: true }).focus();
  await inspector(page).getByRole('button', { name: 'Add row below', exact: true }).click();
  await slide.getByLabel('Time, row 3', { exact: true }).fill('00:10');
  await slide.getByLabel('Time, row 3', { exact: true }).focus();
  // D9: focusing a cell shows its row and column controls in the Inspector.
  await expect(inspector(page)).toContainText('Row 3 · Column 1 (Time)');
  await inspector(page).getByRole('button', { name: 'Delete row', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Review change', exact: true });
  await expect(confirm).toBeFocused();
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(slide.getByLabel('Time, row 3', { exact: true })).toHaveCount(0);
  await slide.getByLabel('Time, row 1', { exact: true }).press('Escape');
  // Escape ends block editing; focus returns to the block's own Edit button and the block keeps its table semantics.
  await expect(page.locator(':focus')).toHaveAccessibleName(/^Edit Table · Observations on arrival/);
  await expect(slide.locator('.slide-table .slide-table-grid')).toHaveCount(1);

  // A callout is added as its own reveal step, written in place and given a labelled colour.
  await addBlock(page, 'Callout');
  await slide.getByLabel('Callout text', { exact: true }).fill('Escalate if MAP stays below 65 mmHg.');
  await inspector(page).getByRole('group', { name: 'Tone', exact: true }).getByRole('button', { name: 'Danger', exact: true }).click();
  await expect(inspector(page).getByRole('group', { name: 'Tone', exact: true }).getByRole('button', { name: 'Danger', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await inspector(page).getByRole('button', { name: '← This slide', exact: true }).click();
  await expect(inspector(page)).toContainText('On entry');
  await page.screenshot({ path: testInfo.outputPath('builder-slide-table.png'), fullPage: true });

  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved'); await expect(page.locator('.builder-save-state')).toHaveAttribute('title', 'Saved as revision 2');
  const saved = state.pair.document, composition = startSlide(saved);
  const table = saved.blocks.find(block => block.type === 'table');
  expect(table.caption).toBe('Observations on arrival');
  expect(table.columns.map(column => [column.label, column.align])).toEqual([['Time', 'start'], ['Observation', 'start'], ['Value', 'end'], ['Unit', 'start']]);
  expect(table.rows.map(row => row.cells)).toEqual([['00:00', 'HR', '<5', 'bpm'], ['00:05', 'SpO₂', '', '%\nfinger probe']]);
  const callout = saved.blocks.find(block => block.type === 'callout');
  expect(paragraphsText(callout.paragraphs)).toBe('Escalate if MAP stays below 65 mmHg.');
  expect(composition.styles).toEqual([{ block_id: callout.id, tone: 'coral' }]);
  expect(composition.steps.at(-1).block_ids).toEqual([callout.id]);
  expect(composition.placements.map(item => item.block_id)).toContain(table.id);
  expect(saved.surfaces.find(surface => surface.id === start.surface_id).scene).toBeUndefined();
  expect(saved.blocks.some(block => block.paragraphs && paragraphsText(block.paragraphs) === sceneText)).toBe(true);

  // Reload reads the same pair back: the slide shows the saved table and the draft is clean.
  const before = structuredClone(state.pair);
  await page.reload();
  await expect(slide.locator('.slide-canvas')).toBeVisible();
  await expect(slide.locator('table')).toContainText('SpO₂');
  await expect(slide.locator('table')).toContainText('<5');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(state.pair).toEqual(before);
  expect(state.puts).toEqual([2]);
});

test('[AS-148] a save finishing during an IME composition neither interrupts it nor stores the unconfirmed text', async ({ page }) => {
  const state = await mockDraft(page, schema2Pair(), { capabilities: ['slide_composition'] });
  await signIn(page, `/cases/${worker.caseId}/edit`);
  await inspector(page).getByRole('button', { name: 'Review turning this draft into slides', exact: true }).click();
  await inspector(page).getByRole('group', { name: 'Review upgrade', exact: true }).getByRole('button', { name: 'Turn into slides', exact: true }).click();
  // The upgrade measures each slide before it applies; the canvas appears when it has.
  await expect(page.getByRole('region', { name: 'Slide editor', exact: true }).locator('.slide-canvas')).toBeVisible();
  await addBlock(page, 'Callout');
  const slide = page.getByRole('region', { name: 'Slide editor', exact: true }), paragraph = slide.getByLabel('Callout text', { exact: true });
  await paragraph.fill('Check ');
  let release; state.gate = new Promise(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await paragraph.focus(); await paragraph.press('End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  release();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved'); await expect(page.locator('.builder-save-state')).toHaveAttribute('title', 'Saved as revision 2');
  // The save re-rendered the studio; the composing field kept focus and its composition.
  await expect(paragraph).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true }), 'unconfirmed composition text is not committed').toBeDisabled();
  expect(paragraphsText(state.pair.document.blocks.find(block => block.type === 'callout').paragraphs)).toBe('Check ');
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(paragraph).toHaveText('Check 日本');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('.builder-save-state')).toHaveText('Saved'); await expect(page.locator('.builder-save-state')).toHaveAttribute('title', 'Saved as revision 3');
  expect(paragraphsText(state.pair.document.blocks.find(block => block.type === 'callout').paragraphs)).toBe('Check 日本');
});

test('[AS-152] a converted slide draft keeps the schema-2 decision controls (interpretation)', async ({ page }) => {
  const source = schema2Pair();
  const upgraded = (await import('../src/shared/slide-legacy.mjs')).convertToSlideDocument(source.document, source.authoringMetadata, { createId: uuidv7 });
  expect(upgraded.ok).toBe(true);
  await mockDraft(page, upgraded.candidate, { capabilities: ['slide_composition'] });
  await signIn(page, `/cases/${worker.caseId}/edit`);
  await expect(page.getByRole('region', { name: 'Slide editor', exact: true }).locator('.slide-canvas')).toBeVisible();
  await page.locator('.builder-outline-target', { hasText: 'S00165 workshop title' }).first().click();
  // The decision's settings sit in their own context under the slide.
  await page.getByText('Response and consequences', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Interpretation', exact: true })).toBeVisible();
  await expect(page.locator('.builder-studio-status')).not.toContainText('Convert this draft');
});

test('[AS-148] without slide_composition a schema-3 draft is refused unchanged and no slide code is requested', async ({ page }) => {
  const source = schema2Pair();
  const upgraded = (await import('../src/shared/slide-legacy.mjs')).convertToSlideDocument(source.document, source.authoringMetadata, { createId: uuidv7 });
  expect(upgraded.ok).toBe(true);
  const state = await mockDraft(page, upgraded.candidate, { capabilities: undefined });
  await signIn(page, `/cases/${worker.caseId}/edit`);
  await expect(page.locator('.builder-route')).toContainText('This saved draft contains unsupported data and cannot be edited without losing it.');
  const requested = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname));
  expect(requested.filter(path => /\/assets\/(builder-slides|builder-slide-check)\./.test(path))).toEqual([]);
  expect(state.puts).toEqual([]);
});
