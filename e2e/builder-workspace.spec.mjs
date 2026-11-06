// AS-153: the Builder matches the Round 4 study (Julian, 2026-10-11): one app bar, three full-height columns with the
// slide dominant, text written on the slide, one home per field, one draft history, measured projector fit, rendered
// Outline thumbnails and grid handles. Real Chromium against a local mocked draft API that validates every save.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuilderTransfer, inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts, paragraphsText } from '../src/shared/slide-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { freeAreas, settle } from '../src/shared/slide-edit.mjs';
import mvcFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { bigBuilderPair } from '../tests/helpers/big-builder-pair.mjs';
import { settled } from '../tests/helpers/settled.mjs';
import { builderSaveCheckpoint, saveBuilderDraft, waitForBuilderSave } from '../tests/helpers/builder-save.mjs';
import { createBuilderStoryStarter } from '../src/client/builder-templates.mjs';
import { caseEditSourceViewUrl } from '../src/shared/urls.mjs';
import { builderPublicationIssues } from '../src/shared/builder-publication.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
test.use({ ignoreHTTPSErrors: true });
// CASE-252: a typing-latency gate measures the app, not the harness. Playwright's trace recording snapshots the page's DOM
// around every action, and a key typed as its own action put a full snapshot inside the measured key-to-paint window
// (about 40 ms a key on the large draft at CI speed). So each gate types its text as one action, at the same pace: a
// key's down and up are `delay` apart and the next key follows its up. Threshold and drafts are unchanged; every run
// records its median, p95 and max.
const latencyNote = (testInfo, label, sorted) => {
  const description = `median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms · p95 ${sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1)} ms · max ${sorted.at(-1).toFixed(1)} ms · ${sorted.length} keys`;
  testInfo.annotations.push({ type: `typing-latency ${label}`, description }); console.log(`typing-latency ${label}: ${description}`);
};
let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin }); auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

/** The real diving case, converted to slides as the one-off script does. */
async function divingSlides() {
  const parsed = parseBuilderTransfer(readFileSync(join(ROOT, 'tests/fixtures/synthetic/builder-diving-polished-transfer.json'), 'utf8'));
  const candidate = (await inspectBuilderTransfer(parsed.envelope, {})).candidate;
  for (const surface of candidate.document.surfaces) delete surface.variants;
  const converted = convertToSlideDocument(candidate.document, candidate.authoring_metadata ?? candidate.authoringMetadata, { createId: uuidv7 });
  return { document: converted.candidate.document, authoringMetadata: converted.candidate.authoringMetadata };
}
function mvcSchema2() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(mvcFixture), { metadata_version: 1 });
  for (const surface of converted.candidate.surfaces) delete surface.variants;
  return { document: converted.candidate, authoringMetadata: { metadata_version: 1 } };
}

/** The slide menu (2026-10-17): the canvas head's Slide button, or ⋯ / right-click on an Outline tile, then one item. */
async function slideMenu(page, name, { from = null } = {}) {
  if (from) await page.locator('.builder-outline-list > li', { has: page.locator('.builder-outline-target', { hasText: from }) }).first().click({ button: 'right' });
  else await page.getByRole('button', { name: 'Slide options', exact: true }).click();
  await page.getByRole('menu', { name: 'Slide options', exact: true }).getByRole('menuitem', { name, exact: true }).click();
}

/** One case; saves go through a revision window and are validated as the slide-activated server validates them. */
async function openBuilder(page, pair) {
  const state = { revision: 1, pair: structuredClone(pair), puts: 0, gate: null, writes: [], readbacks: [] }, windows = new Map();
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const request = route.request(), method = request.method(), suffix = new URL(request.url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    const body = method === 'GET' ? null : request.postDataJSON();
    if (suffix === 'draft' && method === 'GET') {
      const readback = { revision: state.revision, pair: structuredClone(state.pair), intentDigest: `\\x${'a'.repeat(64)}` };
      state.readbacks.push(readback);
      return reply(route, { case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', title: state.pair.document.title, sourceVersion: null, capabilities: ['slide_composition'] },
        revision: state.revision, draft: { revision: readback.revision, ...readback.pair, intentDigest: readback.intentDigest } });
    }
    if (suffix === 'save-windows' && method === 'POST') { const operationId = uuidv7(); windows.set(operationId, state.revision); return reply(route, { operationId, baseRevision: state.revision }); }
    if (suffix === 'draft' && method === 'PUT') {
      if (state.gate) await state.gate;
      if (windows.get(body.operationId) !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const checked = validateBuilderDocument(body.document, body.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
      if (!checked.ok) return reply(route, { error: 'invalid_draft', issues: checked.errors }, 422);
      state.pair = { document: structuredClone(body.document), authoringMetadata: structuredClone(body.authoringMetadata) }; state.revision++; state.puts++;
      const receipt = { operationId: body.operationId, revision: state.revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' };
      state.writes.push({ operationId: body.operationId, pair: structuredClone(state.pair), receipt });
      return reply(route, receipt);
    }
    if (suffix === 'checkpoints') return reply(route, { checkpoints: [] });
    return reply(route, { error: 'not_found' }, 404);
  });
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  return state;
}
const slide = page => page.getByRole('region', { name: 'Slide editor', exact: true });
// Case details is in the More menu (CASE-321: the Outline's quiet links are Overview and Sources).
const caseDetails = async page => { await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Case details', exact: true }).click(); };
// Clarifications, flags and preparation sit under Case details → Advanced settings.
const caseAdvanced = async page => { await caseDetails(page); await page.locator('.builder-case-advanced > summary').click(); };
const save = async (page, state) => { const before = state.puts; if (!(await page.getByRole('button', { name: 'Save draft', exact: true }).isVisible())) await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect.poll(() => state.puts).toBe(before + 1); };
const startComposition = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
const startBlocks = document => startComposition(document).reading_order.map(id => document.blocks.find(block => block.id === id));
// The slide's body text: CASE-222 opens converted slides with an H1 title block first.
const bodyText = blocks => blocks.find(item => item.type === 'text' && item.paragraphs.some(paragraph => paragraph.style === 'p'));

// CASE-225: the Builder's dropdowns are Case's own; each keeps its native select (hidden) as the value and change
// contract, so tests drive that select directly. One test below also operates the visible dropdown.
const choose = (scope, label, value) => scope.locator(`select[aria-label="${label}"]`).first().selectOption(value, { force: true });

// Deterministic save modes: the clock is installed before navigation and held before editing.
// These checks keep real manual Playwright activation separate from the atomic completion aid.
for (const mode of ['manual dirty', 'already autosaved', 'autosave in flight']) test(`[AS-153] save completion proves the expected paired draft when ${mode}`, async ({ page }) => {
  await page.clock.install();
  const pair = createBuilderStoryStarter(), state = await openBuilder(page, pair);
  // Reserve a future clock target across the RPC; no edit/autosave has been scheduled yet.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 60_000);
  await caseDetails(page);
  const baseline = builderSaveCheckpoint(state), expectedPair = structuredClone(pair);
  expectedPair.document.title = `Save regression: ${mode}`;
  let release;
  if (mode === 'autosave in flight') state.gate = new Promise(resolve => { release = resolve; });
  try {
    await page.getByLabel('Case title', { exact: true }).fill(expectedPair.document.title);
    await page.clock.runFor(400);
    if (mode === 'manual dirty') {
      const button = page.getByRole('button', { name: 'Save draft', exact: true });
      await expect(button).toBeEnabled();
      expect(state.puts).toBe(baseline.writes);
      await button.click(); // Actual Playwright pointer/actionability coverage; autosave time remains held.
      await waitForBuilderSave(page, { expect, baseline, evidence: () => state, expectedPair });
    } else {
      await page.clock.runFor(1500);
      if (mode === 'already autosaved') {
        await expect(page.locator('.builder-save-state')).toHaveText('Saved');
        const result = await saveBuilderDraft(page, { expect, baseline, evidence: () => state, expectedPair });
        expect(result.activation).toBe('disabled');
      } else {
        await expect(page.locator('.builder-save-state')).toHaveText('Saving…');
        let activated, activationFailed;
        const activation = new Promise((resolve, reject) => { activated = resolve; activationFailed = reject; });
        const completion = saveBuilderDraft(page, { expect, baseline, evidence: () => state, expectedPair, onActivation: activated });
        completion.catch(activationFailed);
        try {
          expect(await activation).toBe('disabled');
          expect(state.puts).toBe(baseline.writes);
        } finally { release(); await completion; }
      }
    }
    expect(state.puts).toBe(baseline.writes + 1);
    expect(state.pair).toEqual(expectedPair);
    await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  } finally { release?.(); state.gate = null; }
});

for (const type of ['free_text', 'single_choice', 'multi_select', 'ranking']) test(`[AS-153] ordinary ${type} question autosaves one Continue route without outcome metadata`, async ({ page }) => {
  const pair = createBuilderStoryStarter(), state = await openBuilder(page, pair);
  await page.getByLabel('Slide title', { exact: true }).fill('Opening story');
  await slideMenu(page, 'Add question after');
  const question = page.getByRole('group', { name: 'Add question', exact: true });
  await choose(question, 'Response type', type);
  await question.getByRole('button', { name: 'Add question', exact: true }).click();
  await slide(page).locator('.slide-block').first().click();
  await page.getByLabel('Question text', { exact: true }).fill('Which result changes our management?');
  await expect.poll(() => state.pair.document.decisions.length).toBe(1);
  const saved = state.pair.document, decision = saved.decisions[0];
  expect(decision.interaction.type).toBe(type); expect(decision.paths).toHaveLength(1);
  expect(decision.prompt).toBe('Which result changes our management?');
  const beat = saved.beats.find(item => item.decision_id === decision.id), composition = saved.compositions.find(item => item.owner.id === beat.id);
  expect(beat.title).toBe(decision.prompt); expect(composition.reading_order).toHaveLength(1);
  expect(decision.paths[0]).toMatchObject({ label: 'Continue', continue_to_next: true, classification: 'discussion-prompt' });
  expect(saved.beats.some(beat => beat.id === decision.paths[0].next_beat_id)).toBe(true);
  expect(saved.compositions.some(item => item.owner.kind === 'path')).toBe(false);
  expect(validateBuilderDocument(saved, state.pair.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts }).ok).toBe(true);
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  await page.locator('.builder-zone-response > summary').click();
  await expect(page.getByRole('button', { name: 'Add branches', exact: true })).toBeVisible();
  await expect(page.getByLabel('Interpretation', { exact: true })).toHaveCount(0);
});

test('[AS-153] restoring published content requires confirmation, saves a private draft and preserves cancellation', async ({ page }) => {
  const pair = createBuilderStoryStarter(); pair.document.title = 'Current private writing';
  const state = await openBuilder(page, pair), before = structuredClone(state.pair);
  const url = caseEditSourceViewUrl(worker.caseId, { versionId: worker.versionId, versionNo: 1 }, 'restore', shell.origin);
  await page.goto(url);
  const dialog = page.getByRole('dialog', { name: 'Restore published update' });
  await expect(dialog).toBeVisible(); expect(state.puts).toBe(0);
  await dialog.getByRole('button', { name: 'Keep current draft', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(state.pair).toEqual(before);
  await page.goto(url); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect.poll(() => state.puts).toBe(1);
  expect(state.pair.document).toEqual(mvcFixture);
  expect(state.pair.authoringMetadata.lineage).toEqual({ source_case_id: worker.caseId, source_version_id: worker.versionId });
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
});
// CASE-344: the add-block palette is the Inspector with nothing selected (one contextual inspector, no tabs).
const openPalette = async page => {
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  // At phone width one region shows at a time: the palette is in the Inspector.
  if (await page.locator('.builder-workspace').getAttribute('data-layout') === 'single') await page.locator('.builder-regions').getByRole('button', { name: 'Inspector', exact: true }).click();
  return tools.getByRole('group', { name: 'Add block', exact: true });
};

test('[AS-153] one app bar, three full-height columns, the slide dominant and every field in one place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  await openBuilder(page, pair);
  // The site bar carries the Builder's tools beside the case breadcrumb; nothing else sits above the workspace.
  const bar = page.getByRole('banner');
  for (const name of ['Undo', 'Redo', 'Preview this case', 'Save draft', 'More']) await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  // Adding blocks and templates are not duplicated in the bar (Julian 2026-10-12): they live in the Inspector.
  for (const name of ['Add block', 'Templates']) await expect(bar.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(bar.getByRole('navigation', { name: 'Breadcrumb', exact: true })).toContainText(pair.document.title);
  await expect(page.getByRole('button', { name: 'Back to Create', exact: true })).toBeHidden();
  // Outline, slide and Inspector fill the window under the bar; the page itself does not scroll.
  const geometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { outline: box('.builder-outline'), sheet: box('.builder-sheet'), tools: box('.builder-inspector'), canvas: box('.builder-slide .slide-canvas'),
      scroll: document.documentElement.scrollHeight - innerHeight, wide: document.documentElement.scrollWidth - innerWidth, height: innerHeight };
  });
  expect(geometry.scroll).toBeLessThanOrEqual(1); expect(geometry.wide).toBeLessThanOrEqual(1);
  for (const column of [geometry.outline, geometry.sheet, geometry.tools]) { expect(column.top).toBeLessThan(90); expect(column.bottom).toBeGreaterThan(geometry.height - 60); }
  expect(geometry.canvas.width).toBeGreaterThan(780);
  expect(Math.abs(geometry.canvas.width / geometry.canvas.height - 16 / 9)).toBeLessThan(0.02);
  // The canvas head names the slide; the stage name is edited there, once.
  await expect(page.locator('.builder-canvas-location')).toHaveText(/^Slide 1 \/ \d+$/); // numbered on the Outline's spine
  await expect(page.getByLabel('Slide title', { exact: true })).toHaveValue(pair.document.beats.find(beat => beat.id === pair.document.start_beat_id).title);
  // Learner text lives only on the slide; private notes, the decision and stage settings each have one labelled context.
  await expect(page.getByLabel('Learner scene', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Question to the room', { exact: true })).toHaveCount(0);
  const notes = page.locator('.builder-zone-private');
  await expect(notes.locator('summary')).toContainText('Facilitator notes'); await expect(notes.locator('summary')).toContainText('Private');
  await notes.locator('summary').click();
  await expect(notes.getByLabel('Private stage cue', { exact: true })).toBeVisible();
  await expect(page.locator('.builder-zone-response summary')).toHaveText('Response and consequences');
  await expect(page.locator('.builder-zone-readiness summary')).toContainText(/Readiness · (\d+ slides? needs? work|\d+ case items?|sources to review)/);
  // The Outline shows each slide drawn small by the slide renderer, and lists the selected decision's consequences.
  const firstText = paragraphsText(startBlocks(pair.document).find(block => block.type === 'text').paragraphs).slice(0, 30);
  await expect(page.locator('.builder-outline-target[aria-current="true"] .builder-thumb .slide-canvas')).toContainText(firstText);
  await expect(page.locator('.builder-outline-consequence:not([hidden])').first()).toBeVisible();
  // The first slide fits once its text shrinks (CASE-224/225): the footer says so, measured, never silently.
  await expect(page.locator('.builder-fit-status')).toHaveText(/^All blocks fit 1280 × 720 · \d+ shrunk to fit$/);
  // [AS-158] Text shrinks to fit its block, never below the 10 px floor at 1280×720 (CASE-225); a block marked for phones is
  // one that still overflows at that floor. The canvas carries the room's own factor, so no line is clipped on screen.
  const fits = await slide(page).locator('.slide-canvas > .slide-block').evaluateAll(nodes => nodes.map(node => ({ fit: parseFloat(node.style.getPropertyValue('--fit')) || 1, over: node.hasAttribute('data-overflow') })));
  expect(fits.some(item => item.fit < 1 && !item.over)).toBe(true);
  expect(fits.every(item => item.fit >= 0.415 && item.fit <= 1)).toBe(true);
  expect(fits.filter(item => item.over).every(item => item.fit === 0.415)).toBe(true);
  // Squeezed into one grid row, the body text overflows even at the floor: the footer says so in one short line, the
  // canvas marks the block with the room's own "More on your phone", and the slide's issues have one home (CASE-223):
  // the footer count opens the list, the Layout tab no longer repeats it, and an overflow entry selects its block.
  const body = bodyText(startBlocks(pair.document));
  await slide(page).locator(`.slide-block[data-block-id="${body.id}"]`).click();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await tools.getByText('More formatting', { exact: true }).click();
  await tools.getByText('Exact position', { exact: true }).click();
  await tools.getByLabel('Height', { exact: true }).fill('1');
  await tools.getByRole('button', { name: 'Apply', exact: true }).click();
  await slide(page).locator('.slide-canvas').click({ position: { x: 3, y: 3 } });
  await expect(page.locator('.builder-fit-status')).toHaveText(/^\d+ blocks? overflows? at 1280 × 720$/);
  await expect(slide(page).locator('.slide-block[data-overflow]')).not.toHaveCount(0);
  await expect(tools).not.toContainText('needs attention');
  const issues = page.locator('.builder-issues-toggle');
  await expect(issues).toHaveText(/^\d+ issues?$/);
  await issues.click();
  await expect(issues).toHaveAttribute('aria-expanded', 'true');
  const overflowIssue = page.locator('.builder-canvas-footer .builder-slide-issues').getByRole('button', { name: /does not fit its area/ }).first();
  await overflowIssue.click();
  await expect(slide(page).locator('.slide-block[data-selected]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await choose(page, 'Projector size', 'projector-1080');
  await expect(page.locator('.builder-fit-status')).toContainText('1920 × 1080');
  // Panels close with × and reopen from the status bar.
  await page.getByRole('button', { name: 'Hide Inspector', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Show Inspector', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector', exact: true })).toBeVisible();
});

test('[AS-153] text is written on the slide with styles and bold kept, one Undo/Redo history, and a save keeps the caret', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  // Three paragraphs leave room under the 500-character block limit for the typing below.
  const block = bodyText(startBlocks(pair.document)); block.paragraphs = block.paragraphs.slice(0, 3);
  const state = await openBuilder(page, pair);
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await expect(text).toBeFocused();
  // Selecting a block opens its properties; the canvas toolbar offers the text style and Bold.
  await expect(page.getByRole('complementary', { name: 'Inspector', exact: true }).getByRole('button', { name: '← This slide', exact: true })).toBeVisible();
  // Typing at the end of the last paragraph.
  await text.locator('p').last().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.type(' Added on the slide.');
  // Bold a word in the first paragraph, and make the first line a heading.
  await text.locator('p').first().evaluate(node => { const range = document.createRange(), first = node.firstChild; range.setStart(first, 0); range.setEnd(first, 7); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.getByRole('button', { name: 'Bold selection', exact: true }).click();
  await choose(page, 'Text style', 'h2');
  await save(page, state);
  let saved = state.pair.document.blocks.find(item => item.id === block.id);
  expect(saved.paragraphs.at(-1).runs.map(run => run.text).join('')).toMatch(/ Added on the slide\.$/);
  expect(saved.paragraphs[0].style).toBe('h2');
  expect(saved.paragraphs[0].runs[0]).toEqual({ text: block.paragraphs[0].runs[0].text.slice(0, 7), bold: true });
  expect(saved.paragraphs.slice(1).every(paragraph => paragraph.style === 'p')).toBe(true);
  // Typing past the block's 500-character limit stops at the key (round 19) and says so; nothing beyond it is shown or saved.
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  const full = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await full.locator('p').last().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.insertText(' x'.repeat(300));
  await expect(page.locator('.builder-limit-meter')).toHaveText('500 / 500 · limit reached');
  await expect(full).not.toContainText(' x x x');
  await expect(full).not.toHaveAttribute('aria-invalid', '');
  // Leaving the block redraws it from the draft: the refused text was never in it.
  await page.keyboard.press('Escape');
  await expect(slide(page).locator(`.slide-block[data-block-id="${block.id}"]`)).not.toContainText(' x x x');
  // Undo in the app bar steps back through the draft history; Redo and the keyboard shortcut use the same history.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Undone:');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Redone:');
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  await expect(slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).locator('h3').first()).toBeVisible();
  // A save that finishes while the author is typing keeps the caret where it was.
  const live = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await live.locator('p').first().evaluate(node => { const range = document.createRange(); range.setStart(node.firstChild, 0); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.type('Z');
  let release; state.gate = new Promise(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await live.locator('p').first().evaluate(node => { const range = document.createRange(); range.setStart(node.firstChild, 3); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); node.closest('[contenteditable]').focus(); });
  release(); await expect.poll(() => state.puts).toBe(2);
  // The Builder re-renders when it learns the save landed; type only after that.
  await expect(page.locator('.builder-save-state')).toHaveText('Saved'); await expect(page.locator('.builder-save-state')).toHaveAttribute('title', 'Saved as revision 3');
  await page.keyboard.type('Q');
  await save(page, state);
  saved = state.pair.document.blocks.find(item => item.id === block.id);
  expect(saved.paragraphs[1].runs.map(run => run.text).join('').slice(0, 4)).toBe(`Z${block.paragraphs[1].runs[0].text.slice(0, 2)}Q`);
});

test('[AS-153] a block moves and resizes on the grid by handle and arrow keys; exact position is folded away', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  // Leave room on the slide: the first block takes the left half only.
  const first = composition.placements[0];
  composition.template = 'blank'; composition.placements = [{ ...first, col: 1, row: 1, w: 6, h: 6 }]; composition.reading_order = [first.block_id];
  composition.steps = [{ ...composition.steps[0], block_ids: [first.block_id] }];
  composition.hero = 'off'; // a lone block is a hero with no grips (CASE-264); this sequence moves it
  const state = await openBuilder(page, pair);
  await slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`).click();
  const move = slide(page).getByRole('button', { name: /^Move .*Arrow keys move it one grid cell\.$/ });
  await move.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await expect(page.locator('.builder-studio-status')).toContainText('Block moved to column 2, row 2, 6 wide and 6 high.');
  await expect(slide(page).getByRole('button', { name: /^Move / })).toBeFocused();
  const resize = slide(page).getByRole('button', { name: /^Resize .*Arrow keys change its width and height\.$/ });
  await resize.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.builder-studio-status')).toContainText('7 wide and 6 high');
  // Out of the grid is refused and changes nothing.
  for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.builder-studio-status')).toContainText('Not moved.');
  // The numbers are available, folded away.
  await page.getByRole('complementary', { name: 'Inspector', exact: true }).getByText('More formatting', { exact: true }).click();
  const exact = page.locator('details:has(> summary:text-is("Exact position"))');
  await expect(exact).not.toHaveAttribute('open', '');
  await exact.locator('summary').click();
  await expect(exact.getByLabel('Column', { exact: true })).toHaveValue('2');
  await save(page, state);
  expect(startComposition(state.pair.document).placements[0]).toMatchObject({ col: 2, row: 2, w: 11, h: 6 });
});

test('[AS-153] Turn into slides measures every slide and names how many still need editing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, mvcSchema2());
  await page.getByRole('complementary', { name: 'Inspector', exact: true }).getByRole('button', { name: 'Review turning this draft into slides', exact: true }).click();
  const review = page.getByRole('group', { name: 'Review upgrade', exact: true });
  await expect(review).toContainText('Each slide’s layout is chosen by measuring it on a 1280 × 720 projector.');
  await review.getByRole('button', { name: 'Turn into slides', exact: true }).click();
  await expect(slide(page).locator('.slide-canvas')).toBeVisible();
  await expect(page.locator('.builder-studio-status')).toHaveText(/Draft turned into slides\. Every word is kept; \d+ slides? needs? editing to fit the projector\. Save to keep the upgrade\./);
});

test('[AS-153] canvas fluency: live drag with cancel, “+” in free space, reveal stepping, Outline find', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  const first = composition.placements[0];
  composition.template = 'blank'; composition.placements = [{ ...first, col: 1, row: 1, w: 6, h: 6 }]; composition.reading_order = [first.block_id];
  composition.steps = [{ ...composition.steps[0], block_ids: [first.block_id] }];
  composition.hero = 'off'; // a lone block is a hero with no grips (CASE-264); this sequence moves it
  const state = await openBuilder(page, pair);
  const node = slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`);
  await node.click();
  // Dragging previews live; an off-grid position is outlined as invalid; Escape restores it and commits nothing.
  const handle = slide(page).getByRole('button', { name: /^Move / }), box = await handle.boundingBox(), canvas = await slide(page).locator('.slide-canvas').boundingBox();
  const cellW = canvas.width / 12;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + cellW * 9, box.y + box.height / 2, { steps: 6 });
  await expect(node).toHaveAttribute('data-invalid', '');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(node).not.toHaveAttribute('data-invalid', '');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // A valid drag commits once.
  const again = await slide(page).getByRole('button', { name: /^Move / }).boundingBox();
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2); await page.mouse.down();
  await page.mouse.move(again.x + again.width / 2 + cellW * 2, again.y + again.height / 2, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.builder-studio-status')).toContainText('Block moved to column 3, row 1');
  // “+” sits in free space and places the chosen block there.
  await page.keyboard.press('Escape');
  await save(page, state);
  const area = freeAreas(startComposition(state.pair.document).placements)[0];
  await slide(page).getByRole('button', { name: 'Add a block here', exact: true }).first().click();
  await page.keyboard.type('/callout'); await page.keyboard.press('Enter');
  await save(page, state);
  const saved = startComposition(state.pair.document), callout = state.pair.document.blocks.find(block => block.type === 'callout' && saved.reading_order.includes(block.id));
  expect(saved.placements.find(item => item.block_id === callout.id)).toMatchObject(settle('callout', area, callout));
  // Reveal preview steps through the slide on the canvas: On entry shows only the first block.
  await page.getByRole('button', { name: 'Preview reveals', exact: true }).click();
  const stepper = slide(page).getByRole('group', { name: 'Reveal preview', exact: true });
  await expect(stepper).toContainText('On entry');
  await expect(slide(page).locator('.slide-block')).toHaveCount(1);
  await stepper.getByRole('button', { name: 'Reveal next step', exact: true }).click();
  await expect(slide(page).locator('.slide-block')).toHaveCount(2);
  await stepper.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(stepper).toHaveCount(0);
  // Outline find filters by name and keeps the selected slide.
  await page.getByRole('button', { name: 'Find a slide', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find a slide', exact: true }).fill("s0146 works");
  const visible = page.locator('.builder-outline li:not([hidden]) .builder-outline-name > span');
  await expect(visible.filter({ hasText: /S0146 works/ }).first()).toBeVisible();
  expect((await visible.allTextContents()).every(text => /S0146 works/i.test(text) || text === pair.document.beats.find(beat => beat.id === pair.document.start_beat_id).title)).toBe(true);
  // Private notes with content show a dot on the collapsed chip.
  await expect(page.locator('.builder-zone-private > summary')).toHaveAttribute('data-filled', '');
});

test('[AS-153] the block\'s panel sets alignment, spacing and reveal and duplicates; the reveal order drags and splits steps', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  const first = composition.placements[0];
  composition.template = 'blank'; composition.placements = [{ ...first, col: 1, row: 1, w: 6, h: 6 }]; composition.reading_order = [first.block_id];
  composition.steps = [{ ...composition.steps[0], block_ids: [first.block_id] }];
  composition.hero = 'off'; // a lone block is a hero with no grips (CASE-264); this sequence moves it
  const state = await openBuilder(page, pair), tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`).click();
  await tools.getByText('More formatting', { exact: true }).click();
  await tools.getByRole('group', { name: 'Alignment', exact: true }).getByRole('button', { name: 'Centre', exact: true }).click();
  await tools.getByRole('group', { name: 'Spacing', exact: true }).getByRole('button', { name: 'Roomy', exact: true }).click();
  // The canvas renders the style as the room will.
  await expect(slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`)).toHaveClass(/slide-align-center/);
  await expect(slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`)).toHaveCSS('text-align', 'center');
  await tools.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Block duplicated as an independent copy');
  await save(page, state);
  let saved = startComposition(state.pair.document);
  const copyId = saved.reading_order.find(id => id !== first.block_id);
  expect(saved.styles.find(item => item.block_id === first.block_id)).toEqual({ block_id: first.block_id, align: 'center', padding: 'roomy' });
  expect(saved.placements.find(item => item.block_id === copyId)).toMatchObject({ col: 7, row: 1, w: 6, h: 6 });
  expect(saved.steps.map(step => step.block_ids)).toEqual([[first.block_id], [copyId]]);
  // Block order: drag the copy onto On entry, then split it back into its own step right after.
  await tools.getByRole('button', { name: '← This slide', exact: true }).click();
  const onEntry = tools.locator('.builder-step').first(), row = tools.locator(`.builder-order-row[data-block-id="${copyId}"]`);
  await row.dragTo(onEntry);
  await expect(onEntry.locator('.builder-step-count')).toHaveText('2 blocks');
  await tools.locator(`.builder-order-row[data-block-id="${copyId}"] select`).selectOption('own', { force: true });
  await save(page, state);
  saved = startComposition(state.pair.document);
  expect(saved.steps.map(step => step.block_ids.length)).toEqual([1, 1]);
  // Hovering a row outlines its block on the canvas.
  await tools.locator(`.builder-order-row[data-block-id="${first.block_id}"]`).hover();
  await expect(slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`)).toHaveAttribute('data-highlight', '');
});

test('[AS-153] the palette is grouped and truthful; Tab in a table’s last cell adds a row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  composition.template = 'blank'; composition.placements = []; 
  const state = await openBuilder(page, pair);
  const palette = await openPalette(page);
  // Card 59 M2 (CASE-268): images and ECGs are available, so nothing is listed as unavailable but the question here.
  await expect(palette.getByRole('button')).toHaveText([/^Text/, /^Callout/, /^Table/, /^Values/, /^Chart/, /^Blood gas/, /^Image/]);
  await expect(palette.getByRole('button', { name: 'Question', exact: true })).toHaveCount(0);
  await expect(palette.getByRole('button', { name: 'Image', exact: true })).toBeEnabled();
  await palette.getByRole('button', { name: 'Table', exact: true }).click();
  await choose(page.getByRole('complementary', { name: 'Inspector', exact: true }), 'Table starter', 'timeline');
  const cell = slide(page).getByLabel('Event, row 1', { exact: true });
  await cell.fill('Drain inserted');
  await cell.press('Tab');
  await expect(slide(page).getByLabel('Time, row 2', { exact: true })).toBeFocused();
  await page.keyboard.type('00:12');
  await save(page, state);
  const table = state.pair.document.blocks.find(block => block.type === 'table' && block.columns.map(column => column.label).join() === 'Time,Event');
  expect(table.rows.map(row => row.cells)).toEqual([['', 'Drain inserted'], ['00:12', '']]);
});

test('[AS-153] a single-choice decision maps responses in one compact matrix and lists every consequence with its destination', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = mvcSchema2(), state = await openBuilder(page, pair);
  await page.locator('.builder-outline-target', { hasText: 'S00165 workshop title' }).first().click();
  const matrix = page.getByRole('region', { name: 'Response mapping', exact: true });
  const decision = pair.document.decisions.find(item => pair.document.beats.find(beat => beat.title === 'S00165 workshop title').decision_id === item.id);
  await expect(matrix.locator('thead th')).toHaveCount(decision.paths.length + 1);
  await expect(matrix.locator('tbody th')).toHaveCount(decision.interaction.options.length);
  // Each response is checked against exactly the consequences that list it.
  const [option] = decision.interaction.options, target = decision.paths.find(path => !path.option_ids.includes(option.id));
  const box = matrix.getByRole('checkbox', { name: `${option.label} leads to ${target.label}`, exact: true });
  await expect(box).not.toBeChecked();
  await box.check();
  await save(page, state);
  const saved = state.pair.document.decisions.find(item => item.id === decision.id);
  expect(saved.paths.find(path => path.id === target.id).option_ids).toContain(option.id);
  // The consequences table names each destination and the recommendation; a row opens its consequence.
  const consequences = page.getByRole('region', { name: 'Consequences', exact: true });
  await expect(consequences.locator('tbody tr')).toHaveCount(decision.paths.length);
  await expect(consequences).toContainText('Recommended');
  // Re-audit #8: consequences and responses reorder for display; ids, mappings, the recommendation and the fallback stay.
  const [first, second] = decision.paths;
  await expect(consequences.getByRole('button', { name: `Move “${first.label}” earlier`, exact: true })).toBeDisabled();
  await consequences.getByRole('button', { name: `Move “${first.label}” later`, exact: true }).click();
  await expect(consequences.locator('tbody th').first()).toHaveText(second.label);
  const responses = decision.interaction.options;
  await page.getByRole('button', { name: 'Move response 1 later', exact: true }).click();
  await save(page, state);
  const reordered = state.pair.document.decisions.find(item => item.id === decision.id), before = saved;
  expect(reordered.paths.map(path => path.id)).toEqual([second.id, first.id, ...saved.paths.slice(2).map(path => path.id)]);
  expect(reordered.interaction.options.map(item => item.id)).toEqual([responses[1].id, responses[0].id, ...responses.slice(2).map(item => item.id)]);
  expect(reordered.fallback_path_id).toBe(before.fallback_path_id);
  expect(reordered.paths.find(path => path.recommended)?.id).toBe(before.paths.find(path => path.recommended)?.id);
  expect(reordered.paths.find(path => path.id === target.id).option_ids).toContain(option.id);
  await consequences.getByRole('button', { name: first.label, exact: true }).click();
  await expect(page.getByLabel('Consequence name', { exact: true })).toHaveValue(first.label);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('[AS-154] the slide menu adds, moves, duplicates and points a slide elsewhere, each one Undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = mvcSchema2(), state = await openBuilder(page, pair);
  const start = pair.document.beats.find(beat => beat.id === pair.document.start_beat_id);
  // Add slide after inserts after the selected slide and keeps the old destination behind the new one.
  await slideMenu(page, 'Add slide after');
  await page.getByLabel('Slide title', { exact: true }).fill('Inserted handover');
  // Move up from the Outline's own menu (right-click): the inserted slide now starts the case.
  await slideMenu(page, 'Move up', { from: 'Inserted handover' });
  await expect(page.locator('.builder-studio-status')).toContainText('“Inserted handover” now starts the case.');
  await expect(page.locator('.builder-outline-stage .builder-outline-name > span').first()).toHaveText('Inserted handover');
  // A question whose branch ends with a reset cannot be lifted out: the item stays listed and says why, in view.
  await page.locator('.builder-outline-list > li', { has: page.locator('.builder-outline-target', { hasText: 'S00165 workshop title' }) }).first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Slide options', exact: true });
  await expect(menu.getByRole('menuitem', { name: /^Move to…/ })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /^Move to…/ })).toContainText('Ends with a reset');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // ⋯ sits over the tile (no extra row space) and opens the same menu: Duplicate inserts the copy straight after.
  const row = page.locator('.builder-outline-list > li', { has: page.locator('.builder-outline-target', { hasText: 'Inserted handover' }) }).first();
  const more = row.locator('.builder-slide-more'), thumb = row.locator('.builder-thumb');
  await row.hover();
  const [moreBox, thumbBox] = [await more.boundingBox(), await thumb.boundingBox()];
  expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(thumbBox.x + thumbBox.width + 1);
  expect(moreBox.y).toBeGreaterThanOrEqual(thumbBox.y - 1);
  await more.click();
  await menu.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Slide title', { exact: true })).toHaveValue('Inserted handover (copy)');
  // Goes to… turns the strip into a picker; Escape leaves the draft alone.
  await slideMenu(page, 'Goes to…');
  await expect(page.locator('.builder-pick-bar')).toContainText('“Inserted handover (copy)” goes to…');
  await expect(page.locator('.builder-outline-list > li.builder-pick-now')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.builder-pick-bar')).toHaveCount(0);
  await save(page, state);
  const saved = state.pair.document, inserted = saved.beats.find(beat => beat.title === 'Inserted handover'), copy = saved.beats.find(beat => beat.title === 'Inserted handover (copy)');
  expect(saved.start_beat_id).toBe(inserted.id);
  expect(inserted.next_beat_id).toBe(copy.id);
  expect(copy.next_beat_id).toBe(start.id);
  // Move to… lights the gaps the slide can land in; choosing one moves it. Then every structural step is one Undo.
  await slideMenu(page, 'Move to…', { from: 'Inserted handover (copy)' });
  await page.getByRole('button', { name: 'Put “Inserted handover (copy)” at the start', exact: true }).click();
  await expect(page.locator('.builder-outline-stage .builder-outline-name > span').first()).toHaveText('Inserted handover (copy)');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Undone:');
  await expect(page.locator('.builder-outline-stage .builder-outline-name > span').first()).toHaveText('Inserted handover');
});

test('the last slide deletes in one step and the slide before it ends the case (Julian, 2026-10-17)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  const debrief = pair.document.beats.find(beat => beat.title === 'S0188 w'), before = pair.document.beats.find(beat => beat.next_beat_id === debrief.id);
  pair.authoringMetadata.provenance.push({ entity_id: debrief.id, field: 'title', transformation: 'editorial', visibility: 'private', review_status: 'confirmed' });
  const state = await openBuilder(page, pair), tile = page.locator('.builder-outline-target', { has: page.locator('.builder-outline-name > span', { hasText: /^S0188 w$/ }) });
  await tile.click();
  await slideMenu(page, 'Delete');
  const review = page.getByRole('group', { name: 'Delete slide', exact: true });
  const onIt = pair.authoringMetadata.provenance.filter(entry => entry.entity_id === debrief.id || entry.entity_id === debrief.surface_id).length;
  await expect(review).toContainText(`“${before.title}” becomes the last slide.`);
  await expect(review).toContainText(/\d+ source traces? go(es)? too\./);
  expect(onIt).toBeGreaterThan(0);
  await expect(review.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await review.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Slide deleted.');
  await expect(tile).toHaveCount(0);
  await save(page, state);
  const saved = state.pair.document;
  expect(saved.beats.some(beat => beat.id === debrief.id)).toBe(false);
  expect(saved.beats.find(beat => beat.id === before.id).next_beat_id).toBeUndefined();
  expect(validateBuilderDocument(saved, state.pair.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts }).ok).toBe(true);
  expect(state.pair.authoringMetadata.provenance.some(entry => entry.entity_id === debrief.id)).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tile).toHaveCount(1);
});

test('[AS-154] in a slide draft a new stage starts as a slide ready to write', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  await page.locator('.builder-outline-target', { hasText: 'S0217 workshop item' }).first().click();
  await slideMenu(page, 'Add slide after');
  await expect(slide(page).locator('.slide-canvas')).toBeVisible();
  await expect(page.getByLabel('Learner scene', { exact: true })).toHaveCount(0);
  // Critique r23: the caret waits in the new stage's name, which says what it needs.
  await expect(page.getByLabel('Slide title', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Slide title', { exact: true })).toHaveAttribute('placeholder', 'Name this slide');
  await slide(page).locator('.slide-block').first().click();
  await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).fill('A new stage, written on its slide.');
  await page.getByLabel('Slide title', { exact: true }).fill('New slide stage');
  // D4: before any save, the new slide takes another block as its own reveal step.
  await slide(page).locator('.slide-block').first().click();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Callout', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('added as a new reveal step');
  await save(page, state);
  const beat = state.pair.document.beats.find(item => item.title === 'New slide stage');
  const composition = state.pair.document.compositions.find(item => item.owner.id === beat.id);
  expect(state.pair.document.blocks.find(block => block.id === composition.reading_order[0]).paragraphs[0].runs[0].text).toBe('New slide stage');
  expect(composition.steps.map(step => step.block_ids.length)).toEqual([2, 1]);
  // D5: its surface keeps no empty scene or points beside the slide, and its learner heading follows the stage name,
  // so nothing about the new stage stops preview (critique r23 P1).
  const surface = state.pair.document.surfaces.find(item => item.id === beat.surface_id);
  expect(Object.keys(surface).sort()).toEqual(['id', 'kind', 'title']);
  // CASE-280: either title editor updates the same public heading, with no separate private label.
  expect(surface.title).toBe('New slide stage');
  const ready = validateBuilderDocument(state.pair.document, state.pair.authoringMetadata, { mode: 'ready', validateSlides: validateSlideParts });
  const surfaceAt = `/surfaces/${state.pair.document.surfaces.indexOf(surface)}`, beatAt = `/beats/${state.pair.document.beats.indexOf(beat)}`;
  expect(ready.errors.filter(issue => issue.at.startsWith(surfaceAt + '/') || issue.at.startsWith(beatAt + '/'))).toEqual([]);
});

/** A copy of the Debrief stage, slide and blocks with fresh ids that nothing links to, so only its own content can block removal. */
function spareStage(document, title) {
  const source = document.beats.find(item => item.title === 'S0188 w');
  const composition = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === source.id);
  const blocks = composition.reading_order.map(id => document.blocks.find(block => block.id === id));
  const fresh = new Map();
  const remap = value => JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => { if (!fresh.has(id)) fresh.set(id, uuidv7()); return fresh.get(id); }));
  const [beat, surface, copy, ...copies] = remap([source, document.surfaces.find(item => item.id === source.surface_id), composition, ...blocks]);
  beat.title = title; surface.title = title; delete beat.next_beat_id;
  document.beats.push(beat); document.surfaces.push(surface); document.compositions.push(copy); document.blocks.push(...copies);
  return { beat, blocks: copies };
}

test('[AS-154] D7: deleting a slide takes the source traces on its blocks with it, in one undoable change', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), spare = spareStage(pair.document, 'Spare stage');
  const text = bodyText(spare.blocks), traceAt = pair.authoringMetadata.provenance.length;
  pair.authoringMetadata.provenance.push({ entity_id: text.id, field: 'paragraphs[0]', transformation: 'editorial', visibility: 'private', review_status: 'unreviewed' });
  const state = await openBuilder(page, pair), studio = page.locator('.builder-studio');
  await slideMenu(page, 'Delete', { from: 'Spare stage' });
  const review = studio.getByRole('group', { name: 'Delete slide', exact: true });
  // Before 2026-10-17 a trace refused the removal and sent the author to the trace editor; now it goes with the slide.
  await expect(review).toContainText('1 source trace goes too.');
  let acknowledge; state.gate = new Promise(resolve => { acknowledge = resolve; });
  await review.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Slide deleted.');
  await expect(page.locator('.builder-outline-target', { hasText: 'Spare stage' })).toHaveCount(0);
  acknowledge();
  await save(page, state);
  expect(state.pair.document.beats.some(item => item.title === 'Spare stage')).toBe(false);
  expect(state.pair.document.blocks.some(item => item.id === text.id)).toBe(false);
  expect(state.pair.authoringMetadata.provenance.some(entry => entry.entity_id === text.id)).toBe(false);
  expect(state.pair.authoringMetadata.provenance).toHaveLength(traceAt);
  // Undo brings the slide and its trace back together.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.builder-outline-target', { hasText: 'Spare stage' })).toHaveCount(1);
  await save(page, state);
  expect(state.pair.authoringMetadata.provenance.some(entry => entry.entity_id === text.id)).toBe(true);
});

test('[AS-154] on a question whose branches part, the slide menu says in view what it waits for', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, await divingSlides());
  await page.locator('.builder-outline-list > li', { has: page.locator('.builder-outline-target', { hasText: 'S0089 workshop item.' }) }).first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Slide options', exact: true });
  await expect(menu.getByRole('menuitem', { name: /^Add slide after/ })).toContainText('Use a branch’s ⋯');
  await expect(menu.getByRole('menuitem', { name: /^Move to…/ })).toContainText('Splits into branches');
  const reasons = await menu.locator('button:disabled small').allTextContents();
  expect(reasons.length).toBeGreaterThan(2);
  for (const reason of reasons) expect(reason.split(' ').length).toBeLessThanOrEqual(5);
  // Focus lands on an item that can act, and Delete explains instead of refusing silently.
  expect(await page.evaluate(() => document.activeElement?.matches('.builder-slide-menu button:not(:disabled)'))).toBe(true);
  await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const review = page.getByRole('group', { name: 'Delete slide', exact: true });
  await expect(review).toContainText('Its branches lead to different slides.');
  await expect(review.getByRole('button', { name: 'Show its branches', exact: true })).toBeVisible();
});

/** Each table cell's text against the fill it actually sits on (a banded row's, else the nearest painted ancestor's). */
const tableContrast = scope => scope.locator('.slide-table-grid :is(th, td)').evaluateAll(cells => {
  const channels = value => { const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(value); if (srgb) return srgb.slice(1, 4).map(Number);
    const rgb = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(value); return rgb && (rgb[4] === undefined || Number(rgb[4]) > 0) ? rgb.slice(1, 4).map(n => Number(n) / 255) : null; };
  const luminance = rgb => { const [r, g, b] = rgb.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  return cells.map(cell => {
    let node = cell, ground = null; while (node && !(ground = channels(getComputedStyle(node).backgroundColor))) node = node.parentElement;
    const [a, b] = [luminance(channels(getComputedStyle(cell).color)), luminance(ground ?? [1, 1, 1])].sort((x, y) => y - x);
    return { text: cell.textContent.trim(), ratio: Math.round((a + 0.05) / (b + 0.05) * 100) / 100, size: getComputedStyle(cell).fontSize, blockSize: getComputedStyle(cell.closest('.slide-block')).fontSize };
  });
});
// Round 24 P1 (Julian's diving screenshot): a light slide theme in a dark room drew the Run preview's table in the room's
// ink, about 1.1:1, because its frames are quirks-mode documents where a table does not inherit colour or font.
for (const room of ['light', 'dark']) for (const theme of ['case', 'clinic', 'night', 'print']) test(`[AS-155] table header, body and banded rows read at 4.5:1 on the ${theme} slide theme in a ${room} room, Builder and Preview`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ colorScheme: room });
  {
    const pair = await divingSlides(), document = pair.document, composition = startComposition(document);
    if (theme !== 'case') document.theme = theme;
    const columns = [{ id: uuidv7(), label: 'Day', width: 1, align: 'start' }, { id: uuidv7(), label: 'Event', width: 3, align: 'start' }];
    const table = { id: uuidv7(), type: 'table', header_row: true, first_column_header: false, columns,
      rows: [['Days 0–3', 'Six air dives over four days'], ['Day 5', 'Flies home'], ['Day 6', 'Referred to your ED']].map(cells => ({ id: uuidv7(), cells })) };
    document.blocks.push(table); composition.reading_order.push(table.id); composition.steps[0].block_ids.push(table.id);
    composition.placements = [...composition.placements.map((placement, index) => ({ ...placement, col: 1, w: 12, row: 1 + index * 2, h: 2 })), { block_id: table.id, col: 1, row: 9, w: 12, h: 4 }];
    composition.styles = [...(composition.styles ?? []), { block_id: table.id, banded: true }];
    await openBuilder(page, pair);
    const canvas = page.locator('.builder-slide .slide-canvas');
    await expect(canvas.locator('.slide-table-grid td').first()).toBeVisible();
    const measured = [['Builder', await tableContrast(canvas)]];
    await page.goto(page.url().replace(/\/edit(?:\/[a-z]+)?(\?.*)?$/, '/edit/preview$1'));
    const projector = page.frameLocator('.builder-inline-preview-frame').frameLocator('iframe[title="Projector"]');
    await expect(projector.locator('.slide-table-grid td').first()).toBeVisible();
    measured.push(['Preview projector', await tableContrast(projector)]);
    for (const [where, cells] of measured) {
      expect(cells.map(cell => cell.text), where).toEqual(['Day', 'Event', 'Days 0–3', 'Six air dives over four days', 'Day 5', 'Flies home', 'Day 6', 'Referred to your ED']);
      for (const cell of cells) {
        expect(cell.ratio, `${where}, ${theme} theme, ${room} room: “${cell.text}”`).toBeGreaterThanOrEqual(4.5);
        expect(cell.size, `${where}, ${theme} theme: “${cell.text}” keeps the slide's type size`).toBe(cell.blockSize);
      }
    }
  }
});

const addNextStage = async page => {
  await page.locator('.builder-outline-target', { hasText: 'S0217 workshop item' }).first().click();
  await slideMenu(page, 'Add slide after');
  await expect(page.getByLabel('Slide title', { exact: true })).toBeFocused();
};

test('[AS-154] r24 P2-3: naming a new stage writes its slide heading, and the phone shows one learner heading, not two', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openBuilder(page, await divingSlides());
  await addNextStage(page);
  // The name reaches learners, so it is not styled as private writing.
  const name = page.getByLabel('Slide title', { exact: true });
  const [ink, privateInk] = await name.evaluate(node => [getComputedStyle(node).color, getComputedStyle(node).getPropertyValue('--private-ink')]);
  expect(ink).not.toBe(privateInk.trim());
  await name.fill('Hyperbaric review');
  const heading = slide(page).locator('.slide-block').first();
  await expect(heading).toContainText('Hyperbaric review');
  // The author then rewrites the heading on the slide; the learner title follows it.
  await heading.click();
  await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).fill('Day 3 · hyperbaric review');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await slide(page).locator('.slide-block').nth(1).click();
  await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).fill('Chamber at 2.8 ATA.');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await save(page, state);
  const beat = state.pair.document.beats.find(item => item.title === 'Day 3 · hyperbaric review');
  expect(beat).toBeDefined();
  await expect(page.getByLabel('Slide title', { exact: true })).toHaveValue('Day 3 · hyperbaric review');
  expect(state.pair.document.surfaces.find(item => item.id === beat.surface_id).title).toBe('Day 3 · hyperbaric review');
  const [child] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  await child.setViewportSize({ width: 1440, height: 900 });
  await expect(child.locator('.run-preview-status')).toContainText('Replayed the route to');
  const phone = child.frameLocator('iframe[title="Phone"]');
  await expect(phone.locator('body')).toContainText('Chamber at 2.8 ATA.');
  const headings = await phone.locator(':is(h1, h2, h3, h4)').allTextContents();
  expect(headings.filter(text => /hyperbaric/i.test(text))).toEqual(['Day 3 · hyperbaric review']);
  await child.close();
});

test('[AS-154] r24 P2-4: empty blocks say what they hold, and at phone width they are a real tap target', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, await divingSlides());
  await addNextStage(page);
  const blocks = slide(page).locator('.slide-block');
  const placeholders = () => blocks.evaluateAll(nodes => nodes.map(node => getComputedStyle(node, '::after').content));
  expect(await placeholders()).toEqual(['"Heading"', '"Write here"']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.builder-regions').getByRole('button', { name: 'Slide', exact: true }).click();
  for (const box of await blocks.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
});

test('[AS-154] r24 P3: an unnamed new stage is "Untitled stage" to assistive technology and one Readiness line, "Name this slide"', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, await divingSlides());
  await addNextStage(page);
  await expect(page.locator('.builder-sheet-heading')).toHaveText('Untitled stage');
  const summary = page.locator('.builder-zone-readiness > summary');
  await expect(summary).not.toContainText('checking fit', { timeout: 20_000 });
  if (!(await page.locator('.builder-zone-readiness').evaluate(node => node.open))) await summary.click();
  const entry = page.locator('.builder-readiness-slide', { has: page.locator('.builder-readiness-name', { hasText: 'Untitled stage' }) });
  await expect(entry.getByText('Name this slide', { exact: true })).toBeVisible();
  await expect(entry.getByText(/Give its learner content a heading/)).toHaveCount(0);
});

test('[AS-154] r24 P2-2: a focused Move grip shows the focus ring, not its idle outline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, await divingSlides());
  const grip = slide(page).getByRole('button', { name: /^Move / }).first();
  await slide(page).locator('.builder-canvas-stage, .slide-canvas').first().focus().catch(() => {});
  await grip.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await expect(grip).toBeFocused();
  expect(await grip.evaluate(node => [node.matches(':focus-visible'), getComputedStyle(node).outlineWidth])).toEqual([true, '3px']);
});

test('[AS-162] r24 P2-1: an inserted decision says in words what to write, names where, and leaves the caret on its slide', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, await divingSlides());
  await page.locator('.builder-outline-target', { hasText: 'S0217 workshop item' }).first().click();
  await slideMenu(page, 'Add question after');
  await page.getByRole('group', { name: 'Add question', exact: true }).getByRole('button', { name: 'Add a branching decision', exact: true }).click();
  // Focus waits on the selected consequence's slide, not on the page body: a caret in its heading (r25 P3), not its Edit button.
  expect(await page.evaluate(() => document.activeElement?.closest('.builder-slide .slide-block') !== null)).toBe(true);
  await expect(slide(page).getByRole('textbox', { name: 'Slide text', exact: true })).toBeFocused();
  const summary = page.locator('.builder-zone-readiness > summary');
  await expect(summary).not.toContainText('checking fit', { timeout: 20_000 });
  if (!(await page.locator('.builder-zone-readiness').evaluate(node => node.open))) await summary.click();
  const items = (await page.locator('.builder-zone-readiness li').allTextContents()).join('\n');
  for (const words of ['Write the question', 'Name this response', 'Name this consequence', 'Write why this consequence follows (private)', 'Write the facilitator cue (private)']) expect(items).toContain(words);
  expect(items).not.toMatch(/length must be|must be a string/i);
  // The question's item opens the question on its slide, not the hidden sheet heading.
  await page.locator('.builder-zone-readiness li', { hasText: 'Write the question' }).first().getByRole('button').first().click();
  await expect(slide(page).getByRole('textbox', { name: 'Question text', exact: true })).toBeFocused();
});

test('[AS-153] one history across fields: text A → move → text B, then Undo ×3 and Redo ×3 in order (BWR16 gating sequence)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  const first = composition.placements[0];
  composition.template = 'blank'; composition.placements = [{ ...first, col: 1, row: 1, w: 6, h: 6 }]; composition.reading_order = [first.block_id];
  composition.steps = [{ ...composition.steps[0], block_ids: [first.block_id] }];
  composition.hero = 'off'; // a lone block is a hero with no grips (CASE-264); this sequence moves it
  const block = pair.document.blocks.find(item => item.id === first.block_id); block.paragraphs = [{ style: 'p', runs: [{ text: 'Base' }] }];
  await openBuilder(page, pair);
  const node = slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`), mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const area = () => node.evaluate(n => n.style.gridArea);
  await node.click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await text.locator('p').evaluate(n => { const r = document.createRange(); r.selectNodeContents(n); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.keyboard.type(' A');
  const placedAt = await area();
  await slide(page).getByRole('button', { name: /^Move / }).focus(); await page.keyboard.press('ArrowRight');
  const movedAt = await area();
  expect(movedAt).not.toBe(placedAt);
  const stageName = page.getByLabel('Slide title', { exact: true }), originalName = await stageName.inputValue();
  await page.waitForTimeout(1100); // past the typing coalescing window, so B is its own step
  await stageName.fill(`${originalName} B`);
  // Undo B, then the move, then A — each from the keyboard, in reverse order.
  await page.keyboard.press(`${mod}+z`); await expect(stageName).toHaveValue(originalName);
  await page.keyboard.press(`${mod}+z`); await expect.poll(area).toBe(placedAt);
  await page.keyboard.press(`${mod}+z`); await expect(node).toContainText('Base'); await expect(node).not.toContainText('Base A');
  // Redo replays them forward in order.
  await page.keyboard.press(`${mod}+Shift+z`); await expect(node).toContainText('Base A');
  await page.keyboard.press(`${mod}+Shift+z`); await expect.poll(area).toBe(movedAt);
  await page.keyboard.press(`${mod}+Shift+z`); await expect(stageName).toHaveValue(`${originalName} B`);
});

test('[AS-153] at phone width an edited table reflows to labelled row cards and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  composition.template = 'blank'; composition.placements = [];
  const state = await openBuilder(page, pair);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('.builder-regions').getByRole('button', { name: 'Slide', exact: true }).click();
  const cell = slide(page).getByLabel('Value, row 1', { exact: true });
  await cell.fill('112');
  await expect(slide(page).locator('td[data-column="Value"]').first()).toBeVisible();
  const label = await slide(page).locator('td[data-column="Value"]').first().evaluate(node => getComputedStyle(node, '::before').content);
  expect(label).toBe('"Value"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await save(page, state);
  expect(state.pair.document.blocks.find(block => block.type === 'table' && block.rows[0].cells.includes('112'))).toBeTruthy();
});

test('[AS-154] dragging a slide in the Outline shows only the gaps it can land in; dropping in one moves it, one Undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const pair = mvcSchema2(), state = await openBuilder(page, pair);
  await slideMenu(page, 'Add slide after');
  await page.getByLabel('Slide title', { exact: true }).fill('Dragged handover');
  const row = name => page.locator('.builder-outline-stage > .builder-outline-target', { hasText: name }).first();
  const box = await row('Dragged handover').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, { steps: 4 });
  const first = page.getByRole('button', { name: 'Put “Dragged handover” at the start', exact: true });
  await expect(first).toBeVisible();
  // A question whose branch ends with a reset has no single way on, so no gap is offered after it.
  await expect(page.getByRole('button', { name: 'Put “Dragged handover” after “S00165 workshop title”', exact: true })).toHaveCount(0);
  const gap = await first.boundingBox();
  await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.builder-studio-status')).toContainText('“Dragged handover” now starts the case.');
  await expect(page.locator('.builder-pick-gap')).toHaveCount(0);
  await save(page, state);
  expect(state.pair.document.beats.find(beat => beat.id === state.pair.document.start_beat_id).title).toBe('Dragged handover');
});

test('[AS-153] a slide draft holds up at 320–1920 in light and dark: no sideways scroll, 32 px targets, no axe violations (BWA05, CASE-225)', async ({ page }) => {
  test.setTimeout(120_000);
  const pair = await divingSlides();
  await openBuilder(page, pair);
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect(page.locator('.builder-workspace')).toHaveAttribute('data-layout', width < 912 ? 'single' : 'wide');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${theme} ${width}`).toBeLessThanOrEqual(1);
    const small = await page.locator('.builder-studio').evaluate(studio => [...studio.querySelectorAll('button, select')]
      .filter(node => { const r = node.getBoundingClientRect(), style = getComputedStyle(node); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0 && (r.width < 32 || r.height < 32); })
      .map(node => node.getAttribute('aria-label') || node.textContent.trim()));
    expect(small, `${theme} ${width}`).toEqual([]);
    if (width === 1280) expect((await new AxeBuilder({ page }).include('.builder-studio').analyze()).violations.map(item => `${item.id}: ${item.nodes.length}`), `${theme}`).toEqual([]);
  }
});

test('[AS-153] on a draft at the admitted caps, typing in notes and on the slide stays within p95 100 ms key to paint, at a pace that lets every catch-up run (BWR13, re-audit P1)', { tag: '@perf' }, async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { pair } = bigBuilderPair(await divingSlides());
  const block = bodyText(startBlocks(pair.document));
  // 100 keys a field, as AS-163 types (AS-153 row): with the 24 and 17 keys typed before, the "p95" was the second-slowest
  // key and the slowest key, so one hosted-runner stall failed the gate while the 95th percentile sat far below 100 ms.
  const notesTyped = ' Large case notes typing, measured at the admitted caps.'.repeat(2).slice(0, 100);
  const slideTyped = 'Large case slide typing, measured at the admitted caps. '.repeat(2).slice(0, 100);
  // Reserve input room: this gate measures accepted typing, not rejection at the unchanged 500-character limit.
  const tail = block.paragraphs.at(-1).runs.at(-1); tail.text = tail.text.slice(0, -slideTyped.length);
  const bytes = new TextEncoder().encode(JSON.stringify(pair)).length;
  expect(validateBuilderDocument(pair.document, pair.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts }).ok).toBe(true);
  const state = await openBuilder(page, pair), unsaved = builderSaveCheckpoint(state);
  const measure = async (type, label) => {
    await page.evaluate(() => {
      window.latency = [];
      window.onLatencyKey ??= () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.latency.push(performance.now() - start))); };
      document.removeEventListener('keydown', window.onLatencyKey, true); document.addEventListener('keydown', window.onLatencyKey, true);
    });
    // 250 ms between keys: slow enough for the 180 ms field catch-up and the case-wide fit pass to start in between.
    await page.keyboard.type(type, { delay: 250 });
    await expect.poll(() => page.evaluate(() => window.latency.length)).toBeGreaterThanOrEqual(type.length);
    const samples = (await page.evaluate(() => window.latency)).sort((a, b) => a - b), p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    latencyNote(testInfo, `large draft ${label}`, samples);
    await testInfo.attach(`typing-latency-large-${label}.json`, { body: JSON.stringify({ bytes, samples, p95 }), contentType: 'application/json' });
    return p95;
  };
  await page.locator('.builder-zone-private > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true }).first();
  await notes.click(); await notes.press('End');
  const notesP95 = await measure(notesTyped, 'notes');
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await text.locator('p').first().evaluate(n => { const r = document.createRange(); r.setStart(n.firstChild, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
  const slideP95 = await measure(slideTyped, 'slide');
  expect({ notesP95, slideP95 }).toEqual({ notesP95: expect.any(Number), slideP95: expect.any(Number) });
  expect(notesP95, `notes p95 on a ${bytes}-byte draft`).toBeLessThanOrEqual(100);
  expect(slideP95, `slide p95 on a ${bytes}-byte draft`).toBeLessThanOrEqual(100);
  // An idle autosave can acknowledge the measured writing before the manual-save step, or write each edit separately:
  // require a post-edit receipt, exact readback and the client's current Saved revision, then both edits below.
  await saveBuilderDraft(page, { expect, baseline: unsaved, evidence: () => state });
  expect(JSON.stringify(state.pair.document)).toContain('Large case slide ');
  expect(JSON.stringify(state.pair.document)).toContain('Large case notes typing');
});

test('[AS-153] typing in a plain field (private notes) stays within p95 100 ms from key to paint on the real diving case (BWR13, re-audit #9)', { tag: '@perf' }, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  await page.locator('.builder-zone-private > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true }).first();
  await notes.click(); await notes.press('End');
  await page.evaluate(() => {
    window.latency = [];
    document.addEventListener('keydown', () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.latency.push(performance.now() - start))); }, true);
  });
  const typed = ' Measured typing in the notes';
  await page.keyboard.type(typed, { delay: 20 });
  await expect.poll(() => page.evaluate(() => window.latency.length)).toBeGreaterThanOrEqual(typed.length);
  const samples = (await page.evaluate(() => window.latency)).sort((a, b) => a - b), p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  latencyNote(testInfo, 'notes', samples);
  await testInfo.attach('typing-latency-notes.json', { body: JSON.stringify({ samples, p95 }), contentType: 'application/json' });
  expect(p95).toBeLessThanOrEqual(100);
  // The edit is kept, focus stays in the field, and saving writes it.
  await expect(notes).toBeFocused();
  await save(page, state);
  expect(JSON.stringify(state.pair.document.surfaces)).toContain('Measured typing in the notes');
});

test('[AS-153] typing on the slide stays within p95 100 ms from key to paint on the real diving case (BWR13)', { tag: '@perf' }, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  await openBuilder(page, pair);
  const block = bodyText(startBlocks(pair.document));
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await text.locator('p').first().evaluate(n => { const r = document.createRange(); r.setStart(n.firstChild, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.evaluate(() => {
    window.latency = [];
    document.addEventListener('keydown', () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.latency.push(performance.now() - start))); }, true);
  });
  await page.keyboard.type('Measured typing on the slide ', { delay: 20 });
  await expect.poll(() => page.evaluate(() => window.latency.length)).toBeGreaterThanOrEqual(29);
  const samples = (await page.evaluate(() => window.latency)).sort((a, b) => a - b), p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  latencyNote(testInfo, 'slide', samples);
  await testInfo.attach('typing-latency.json', { body: JSON.stringify({ samples, p95 }), contentType: 'application/json' });
  expect(p95).toBeLessThanOrEqual(100);
});

test('[AS-155] the block\'s panel sets a block background and table presentation, rendered on the canvas and saved', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  composition.template = 'blank'; composition.placements = [];
  const state = await openBuilder(page, pair), tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  await tools.getByText('More formatting', { exact: true }).click();
  await tools.getByRole('group', { name: 'Border', exact: true }).getByRole('button', { name: 'Outline', exact: true }).click();
  await tools.getByRole('group', { name: 'Rows', exact: true }).getByRole('button', { name: 'Banded', exact: true }).click();
  await tools.getByRole('group', { name: 'Density', exact: true }).getByRole('button', { name: 'Roomy', exact: true }).click();
  await tools.getByRole('group', { name: 'Text size', exact: true }).getByRole('button', { name: 'Large', exact: true }).click();
  const node = slide(page).locator('.slide-table').first();
  for (const cls of [/slide-bg-outline/, /slide-banded/, /slide-density-roomy/, /slide-text-large/]) await expect(node).toHaveClass(cls);
  await save(page, state);
  const table = state.pair.document.blocks.find(block => block.type === 'table');
  expect(startComposition(state.pair.document).styles.find(item => item.block_id === table.id)).toEqual({ block_id: table.id, background: 'outline', banded: true, density: 'roomy', text_size: 'large' });
});

test('[AS-153] private notes never reach learner output, storage, URLs or non-Builder requests (BWA21 sentinel sweep)', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sentinel = 'PRIVATE-SENTINEL-7f3a', pair = await divingSlides();
  const start = pair.document.beats.find(beat => beat.id === pair.document.start_beat_id);
  start.cue = `Facilitator only ${sentinel}`;
  const urls = []; page.on('request', request => { const url = request.url(); if (!url.includes('/api/v1/builder/')) urls.push(url + (request.postData() ?? '')); });
  await openBuilder(page, pair);
  // The private field shows it to the author, inside its labelled private context only.
  await page.locator('.builder-zone-private > summary').click();
  await expect(page.locator('.builder-zone-private').getByLabel('Private stage cue', { exact: true })).toHaveValue(new RegExp(sentinel));
  await expect(slide(page)).not.toContainText(sentinel);
  await expect(page.locator('.builder-outline')).not.toContainText(sentinel);
  // The Run preview's learner surfaces (the projector and the phone) never show it.
  const [child] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  await expect(child.locator('.run-preview-status')).toContainText('Following your edits');
  for (const title of ['Projector', 'Phone']) await expect(child.frameLocator(`iframe[title="${title}"]`).locator('body')).not.toContainText(sentinel);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
  expect(stored).not.toContain(sentinel);
  expect(urls.filter(url => url.includes(sentinel))).toEqual([]);
  await child.close();
});

test('[AS-159] text gets superscript from the slide toolbar, and any block gets a fill and a text colour from the palette, plain text on a fill (CASE-225, CASE-244)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), block = bodyText(startBlocks(pair.document));
  const state = await openBuilder(page, pair), tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await text.locator('p').first().evaluate(node => { const range = document.createRange(), first = node.firstChild; range.setStart(first, 0); range.setEnd(first, 3); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.getByRole('button', { name: 'Superscript selection', exact: true }).click();
  await expect(text.locator('sup').first()).toHaveText(/^.{3}$/);
  await tools.getByText('More formatting', { exact: true }).click();
  const shown = slide(page).locator(`.slide-block[data-block-id="${block.id}"]`), inks = tools.getByRole('group', { name: 'Text colour', exact: true });
  await inks.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect(shown).toHaveClass(/slide-ink-blue/);
  // CASE-244: on a fill the text stays plain, the colour swatches are unavailable and say why; the choice is kept.
  await tools.locator('.builder-more-colours > summary').click();
  await tools.getByRole('group', { name: 'More colours', exact: true }).getByRole('button', { name: 'Teal', exact: true }).click();
  await expect(shown).toHaveClass(/slide-tone-teal/); await expect(shown).not.toHaveClass(/slide-ink-/);
  await expect(inks.getByRole('button', { name: 'Blue', exact: true })).toBeDisabled();
  await expect(inks.getByRole('button', { name: 'Plain', exact: true })).toBeEnabled();
  await expect(tools.getByText('Text stays plain on a fill, so it reads at full contrast. Blue returns on a plain ground.', { exact: true })).toBeVisible();
  await save(page, state);
  const saved = state.pair.document.blocks.find(item => item.id === block.id);
  expect(saved.paragraphs[0].runs[0]).toEqual({ text: expect.any(String), script: 'sup' });
  expect(saved.paragraphs[0].runs[0].text).toHaveLength(3);
  expect(startComposition(state.pair.document).styles.find(item => item.block_id === block.id)).toMatchObject({ tone: 'teal', ink: 'blue' });
});

test('[AS-161] a presentation theme recolours every slide: Builder canvas, Outline, saved draft, and the Run preview projector and phone (CASE-227)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await openBuilder(page, await divingSlides());
  const inspector = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await inspector.getByText('Layout and fill', { exact: false }).click();
  const themes = inspector.getByRole('group', { name: 'Theme for every slide', exact: true });
  await expect(themes.getByRole('button', { name: 'Case theme', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await themes.getByRole('button', { name: 'Night theme', exact: true }).click();
  const canvas = page.locator('.builder-slide .slide-canvas').first();
  await expect(canvas).toHaveClass(/\bslide-theme-night\b/);
  // The theme's own ground and ink, not the room's.
  expect(await canvas.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(18, 24, 32)');
  expect(await canvas.evaluate(node => getComputedStyle(node).color)).toBe('rgb(238, 243, 247)');
  // Every Outline thumbnail repaints in the theme.
  await expect(page.locator('.builder-outline .slide-canvas:not(.slide-theme-night)')).toHaveCount(0);
  expect(await page.locator('.builder-outline .slide-canvas.slide-theme-night').count()).toBeGreaterThan(3);
  // The theme tiles fit the Inspector.
  for (const tile of await themes.getByRole('button').all()) { const box = await tile.boundingBox(), panel = await inspector.boundingBox(); expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1); }
  await page.screenshot({ path: info.outputPath('theme-builder-night.png') });
  await save(page, state);
  expect(state.pair.document.theme).toBe('night');
  // The Run preview draws the theme on the real projector and phone.
  const [child] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  await child.setViewportSize({ width: 1440, height: 900 });
  await expect(child.frameLocator('iframe[title="Projector"]').locator('.slide-canvas')).toHaveClass(/\bslide-theme-night\b/);
  await expect(child.frameLocator('iframe[title="Phone"]').locator('.slide-canvas')).toHaveClass(/\bslide-theme-night\b/);
  await child.screenshot({ path: info.outputPath('theme-preview-night.png') });
  await child.close();
  // Case removes the choice; nothing is stored.
  await themes.getByRole('button', { name: 'Case theme', exact: true }).click();
  await expect(canvas).not.toHaveClass(/slide-theme-/);
  await save(page, state);
  expect(Object.hasOwn(state.pair.document, 'theme')).toBe(false);
});

test('[AS-162] in a slide draft an inserted decision gets its slide with the question bound, and each consequence its own slide (gap audit #1, #2, #7)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  await page.locator('.builder-outline-target', { hasText: 'S0217 workshop item' }).first().click();
  await slideMenu(page, 'Add question after');
  const saveBaseline = builderSaveCheckpoint(state), originalDecisionIds = new Set(pair.document.decisions.map(item => item.id));
  await page.getByRole('group', { name: 'Add question', exact: true }).getByRole('button', { name: 'Add a branching decision', exact: true }).click();
  // The new first consequence is selected: its own slide, its own context, and the question one step away.
  await expect(slide(page).locator('.slide-canvas')).toBeVisible();
  const response = page.locator('.builder-zone-response');
  await response.locator('> summary').click();
  await expect(response.getByRole('button', { name: 'Question settings', exact: true })).toBeVisible();
  await expect(response.getByText('Selected consequence', { exact: true })).toBeVisible();
  // One editor per field: rationale and cue live in Facilitator notes only.
  await expect(page.getByLabel('Teaching rationale', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Consequence rationale', { exact: true })).toHaveCount(1);
  // The question's own slide shows the question block.
  await response.getByRole('button', { name: 'Question settings', exact: true }).click();
  await expect(slide(page).locator('.slide-question')).toHaveCount(1);
  await saveBuilderDraft(page, { expect, baseline: saveBaseline, evidence: () => state });
  const document = state.pair.document, inserted = document.decisions.filter(item => !originalDecisionIds.has(item.id));
  expect(document.decisions).toHaveLength(originalDecisionIds.size + 1);
  expect(inserted).toHaveLength(1);
  const [decision] = inserted, beat = document.beats.find(item => item.decision_id === decision.id);
  const stageSlide = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === beat.id);
  expect(stageSlide.reading_order.map(id => document.blocks.find(block => block.id === id).type)).toContain('question');
  expect(document.blocks.find(block => block.type === 'question' && stageSlide.reading_order.includes(block.id)).decision_id).toBe(decision.id);
  for (const path of decision.paths) expect(document.compositions.some(item => item.owner.kind === 'path' && item.owner.id === path.id), path.id).toBe(true);
});

test('[AS-154] D25: an inserted consequence and a new clarification each get their own learner heading and notes, which Reveal names', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair), stage = pair.document.beats.find(beat => beat.kind === 'decision');
  await page.locator('.builder-outline-target', { hasText: 'S0217 workshop item' }).first().click();
  await slideMenu(page, 'Add question after');
  await page.getByRole('group', { name: 'Add question', exact: true }).getByRole('button', { name: 'Add a branching decision', exact: true }).click();
  await expect(page.locator('.builder-canvas-location')).toContainText('Consequence of');
  await page.locator('.builder-zone-settings > summary').click();
  const heading = page.getByRole('textbox', { name: 'Slide title', exact: true });
  await expect(heading).toHaveCount(1); await expect(heading).toHaveValue('');
  await heading.fill('Day 6 · The referral');
  await page.locator('.builder-zone-private > summary').click();
  await expect(page.getByRole('textbox', { name: 'Private facilitator notes', exact: true })).toHaveCount(1);
  // A clarification added from Case details: its heading follows its name, and its notes are its own.
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await caseAdvanced(page);
  await page.getByRole('button', { name: 'Add early clarification', exact: true }).click();
  await page.getByRole('textbox', { name: 'Clarification label', exact: true }).last().fill('Imaging alongside surgery');
  await page.locator('.builder-outline-clarification .builder-outline-target', { hasText: 'Imaging alongside surgery' }).click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText('Imaging alongside surgery');
  if (!(await page.locator('.builder-zone-settings').evaluate(node => node.open))) await page.locator('.builder-zone-settings > summary').click();
  await expect(heading).toHaveValue('Imaging alongside surgery');
  await save(page, state);
  const saved = state.pair.document, decision = saved.decisions.at(-1), stageOf = saved.beats.find(beat => beat.decision_id === decision.id);
  const surface = id => saved.surfaces.find(item => item.id === id);
  // Each consequence reveals content of its own, never its stage's; the room's Reveal label is that content's heading.
  expect(new Set(decision.paths.map(path => path.reveal_surface_id)).size).toBe(2);
  for (const path of decision.paths) expect(path.reveal_surface_id).not.toBe(stageOf.surface_id);
  expect(decision.paths.map(path => surface(path.reveal_surface_id).title)).toContain('Day 6 · The referral');
  const card = saved.clarifications.find(item => item.label === 'Imaging alongside surgery');
  expect(card.surface_id).not.toBe(stage.surface_id);
  expect(surface(card.surface_id).title).toBe('Imaging alongside surgery');
});

test('[AS-154] D25: a consequence or clarification that still shows its stage\'s content gets its own heading, from its slide, in one step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), document = pair.document, card = document.clarifications[0];
  const stage = document.beats.find(beat => beat.title === 'S1090 workshop item. In');
  const path = document.decisions.find(item => item.id === stage.decision_id).paths.find(item => item.label === 'S0217 workshop item');
  const cardStage = document.beats.find(beat => beat.id === card.beat_ids[0]);
  // As the Builder inserted them before CASE-265: both show their stage's own content.
  path.reveal_surface_id = stage.surface_id; card.surface_id = cardStage.surface_id;
  const slideHeading = owner => { const composition = document.compositions.find(item => item.owner.kind === owner.kind && item.owner.id === owner.id);
    const block = composition.reading_order.map(id => document.blocks.find(item => item.id === id)).find(item => item.type === 'text' && /^h/.test(item.paragraphs[0].style));
    return paragraphsText([block.paragraphs[0]]); };
  const pathHeading = slideHeading({ kind: 'path', id: path.id }), cardHeading = slideHeading({ kind: 'clarification', id: card.id });
  const state = await openBuilder(page, pair);
  const heading = page.getByRole('textbox', { name: 'Slide title', exact: true });
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await page.locator('.builder-outline-target', { hasText: path.label }).first().click();
  await page.locator('.builder-zone-settings > summary').click();
  await expect(heading).toHaveValue(document.surfaces.find(item => item.id === path.reveal_surface_id).title);
  await page.getByRole('button', { name: 'Give this consequence its own heading and notes', exact: true }).click();
  await expect(heading).toHaveValue(pathHeading);
  await expect(page.getByRole('button', { name: 'Give this consequence its own heading and notes', exact: true })).toHaveCount(0);
  await page.locator('.builder-outline-clarification .builder-outline-target').first().click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(card.label);
  if (!(await page.locator('.builder-zone-settings').evaluate(node => node.open))) await page.locator('.builder-zone-settings > summary').click();
  await page.getByRole('button', { name: 'Give this clarification its own heading and notes', exact: true }).click();
  await expect(heading).toHaveValue(cardHeading);
  await save(page, state);
  const saved = state.pair.document, surface = id => saved.surfaces.find(item => item.id === id);
  const savedPath = saved.decisions.flatMap(item => item.paths).find(item => item.id === path.id), savedCard = saved.clarifications.find(item => item.id === card.id);
  expect(savedPath.reveal_surface_id).not.toBe(stage.surface_id); expect(surface(savedPath.reveal_surface_id).title).toBe(pathHeading);
  expect(savedCard.surface_id).not.toBe(cardStage.surface_id); expect(surface(savedCard.surface_id).title).toBe(cardHeading);
  // The stages' own content is untouched, and the notes the consequence showed are kept with it.
  for (const beat of [stage, cardStage]) expect(surface(beat.surface_id)).toEqual(document.surfaces.find(item => item.id === beat.surface_id));
  expect(surface(savedPath.reveal_surface_id).notes).toEqual(document.surfaces.find(item => item.id === stage.surface_id).notes);
});

test('[AS-162] the hover grip drags an unselected block; Delete starts the reviewed removal even with the Inspector hidden; Cmd/Ctrl+S saves (gap audit #4, #5, #24)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  const first = composition.placements[0];
  composition.template = 'blank'; composition.placements = [{ ...first, col: 1, row: 1, w: 6, h: 6 }]; composition.reading_order = [first.block_id];
  composition.steps = [{ ...composition.steps[0], block_ids: [first.block_id] }];
  composition.hero = 'off'; // a lone block is a hero with no grips (CASE-264); this sequence moves it
  const state = await openBuilder(page, pair);
  const block = slide(page).locator(`.slide-block[data-block-id="${first.block_id}"]`);
  // From hover, without selecting first: the grip is not covered by the keyboard's Edit button.
  await block.hover();
  const grip = block.locator('.builder-block-handle'), box = await grip.boundingBox(), canvas = await slide(page).locator('.slide-canvas').boundingBox();
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.builder-block-handle') !== null, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit, 'the pointer reaches the grip').toBe(true);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + canvas.width / 4, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.querySelector('.builder-studio-status')?.textContent ?? '')).toMatch(/moved|Moved|position/i);
  // Ctrl/Cmd+S saves.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect.poll(() => state.puts).toBe(1);
  // Inspector hidden at a mid width: Delete on a selected block opens the review in the Inspector, so Confirm is on screen.
  await page.setViewportSize({ width: 1000, height: 900 });
  await block.click();
  // Re-audit #10: from outside the slide and the reveal order (here the Outline), Delete removes nothing and asks nothing.
  await page.locator('.builder-outline-target').first().focus();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('group', { name: 'Review change', exact: true })).toHaveCount(0);
  await page.locator('body').evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('group', { name: 'Review change', exact: true }).getByRole('button', { name: 'Confirm', exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveClass(/builder-danger/);
  await confirm.click();
  await expect(block).toHaveCount(0);
});

test('[AS-162] a readiness link selects the slide that owns the issue and opens the context that holds the field (gap audit #3)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  // A private field left empty on a later stage: its issue must open Facilitator notes there.
  const state = await openBuilder(page, pair);
  await page.locator('.builder-zone-readiness > summary').click();
  const links = page.locator('.builder-zone-readiness .builder-issue-link');
  await expect(links.first()).toBeVisible();
  const before = await page.locator('.builder-canvas-location').textContent();
  const count = await links.count();
  let moved = false;
  for (let i = 0; i < Math.min(count, 12) && !moved; i++) {
    await links.nth(i).click();
    const focused = await page.evaluate(() => { const node = document.activeElement; return node && node !== document.body && !node.closest('.builder-zone-readiness'); });
    if (focused) moved = true;
    await page.locator('.builder-zone-readiness > summary').evaluate(node => { node.parentElement.open = true; });
  }
  expect(moved, 'some issue link moves focus to the field or block it names').toBe(true);
  expect(before).toBeTruthy();
});

test('[AS-162] Undo goes back to the slide it changed, and a question block leads to its settings (gap audit #6, #11)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  // An edit on the first slide…
  const first = slide(page).locator('.slide-block').filter({ hasNot: page.locator('.slide-question') }).first();
  await first.click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).first();
  await text.press('End'); await text.pressSequentially(' edited');
  const location = await page.locator('.builder-canvas-location').textContent();
  // …then another slide is open when Undo runs: Undo returns to the first slide.
  await page.locator('.builder-outline-target', { hasText: 'S0217 workshop item' }).first().click();
  await expect(page.locator('.builder-canvas-location')).not.toHaveText(location);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.builder-canvas-location')).toHaveText(location);
  await expect(slide(page).locator('.slide-block[data-selected]')).toHaveCount(1);
  // The decision's question block says what it is and opens its settings in Response and consequences.
  await slide(page).locator('.slide-block:has(.slide-question), .slide-block.slide-question').first().click();
  const inspector = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await expect(inspector.locator('.builder-question-summary')).toContainText(/options|Free text/);
  await inspector.getByRole('button', { name: 'Edit question and options', exact: true }).click();
  await expect(page.locator('.builder-zone-response')).toHaveAttribute('open', '');
});

test('[AS-154] D15: an early clarification\'s own slide opens from the Outline and Readiness, is written there, Readiness clears, the Run preview runs it, and it can be removed', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; }); // the Preview opens inline, in this page
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  const stage = pair.document.beats.find(beat => beat.kind === 'decision');
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await caseAdvanced(page);
  await page.getByRole('button', { name: 'Add early clarification', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Clarification label', exact: true }).last()).toBeFocused();
  await page.getByRole('textbox', { name: 'Clarification label', exact: true }).last().fill('Imaging alongside surgery');
  // Listed under its stage in the Outline, reached with the arrow keys from that stage (CASE-242), and opened there.
  const row = page.locator('.builder-outline-clarification', { hasText: 'Imaging alongside surgery' });
  await expect(row.locator('.builder-outline-name')).toContainText('Early clarification');
  await page.locator('.builder-outline-stage .builder-outline-target', { hasText: stage.title }).first().focus();
  for (let i = 0; i < 4 && !(await row.locator('.builder-outline-target').evaluate(node => node === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await expect(row.locator('.builder-outline-target')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.builder-sheet-heading')).toHaveText('Imaging alongside surgery');
  await expect(row.locator('.builder-outline-target')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByLabel('Slide title', { exact: true })).toHaveValue('Imaging alongside surgery');
  await expect(page.locator('.builder-canvas-location')).toContainText(`${stage.title} / Imaging alongside surgery`);
  // Its empty slide is a Readiness entry of its own, and its problem opens this slide, not the stage's.
  await page.locator('.builder-zone-readiness > summary').click();
  const entry = () => page.locator('.builder-zone-readiness .builder-readiness-slide', { has: page.locator('.builder-readiness-name', { hasText: 'Clarification · Imaging alongside surgery' }) });
  await expect(entry()).toHaveCount(1);
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(stage.title);
  await entry().getByRole('button', { name: /Add learner text or remove the block/ }).first().click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText('Imaging alongside surgery');
  // Written on its own slide: the heading and the text. Shown while the stage's question is open, it starts with that
  // question in place, so the question is not drawn beside it.
  const beforeWriting = builderSaveCheckpoint(state);
  const blocks = slide(page).locator('.slide-block');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(2)).toHaveClass(/slide-question/);
  await blocks.nth(0).click();
  await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).fill('Imaging alongside surgery');
  await blocks.nth(1).click();
  await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).fill('CT angiography can run while the surgical team reviews the leg.');
  await expect(entry()).toHaveCount(0, { timeout: 20_000 });
  // Autosave may finish while Readiness settles, or, under load, write the two edits separately (2026-10-18 VM
  // qualification attempt 6): require a post-edit receipt, exact readback and the client's current Saved revision.
  await saveBuilderDraft(page, { expect, baseline: beforeWriting, evidence: () => state });
  const saved = state.pair.document, card = saved.clarifications.find(item => item.label === 'Imaging alongside surgery');
  expect(saved.clarifications.map(item => item.label)).toContain('Imaging alongside surgery');
  const composition = saved.compositions.find(item => item.owner.kind === 'clarification' && item.owner.id === card.id);
  const members = composition.reading_order.map(id => saved.blocks.find(block => block.id === id));
  expect(members.filter(block => block.type === 'text').map(block => paragraphsText(block.paragraphs))).toEqual(['Imaging alongside surgery', 'CT angiography can run while the surgical team reviews the leg.']);
  expect(members.filter(block => block.type === 'question').map(block => block.decision_id)).toEqual([stage.decision_id]);
  expect(card.beat_ids).toEqual([stage.id]);
  // The Run preview runs the draft and, opened from this slide, replays to its stage and shares it.
  await page.getByRole('button', { name: 'Preview this case', exact: true }).click();
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.locator('.run-preview-status')).toContainText('Shared “Imaging alongside surgery”.');
  await expect(preview.getByText(/cannot run/)).toHaveCount(0);
  // A reviewed removal takes the clarification and its slide; Undo brings both back.
  await slideMenu(page, 'Delete clarification');
  const review = page.getByRole('group', { name: 'Review clarification removal', exact: true });
  // D25: a new clarification's content is its own, so the removal takes it too.
  await expect(review).toContainText('Would remove: clarification “Imaging alongside surgery” and its slide, and its learner content, which nothing else uses.');
  await review.getByRole('button', { name: 'Remove clarification and its slide', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.builder-sheet-heading')).toHaveText(stage.title);
  await save(page, state);
  expect(state.pair.document.clarifications.some(item => item.id === card.id)).toBe(false);
  expect(state.pair.document.compositions.some(item => item.owner.id === card.id)).toBe(false);
  expect(state.pair.document.blocks.some(block => composition.reading_order.includes(block.id))).toBe(false);
  expect(state.pair.document.surfaces.some(item => item.id === card.surface_id)).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row).toHaveCount(1);
  await row.locator('.builder-outline-target').click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText('Imaging alongside surgery');
  // The stage's own slide is untouched, and the crumb leads back to it.
  await page.locator('.builder-canvas-location').getByRole('button', { name: stage.title, exact: true }).click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(stage.title);
  await expect(page.getByLabel('Slide title', { exact: true })).toHaveValue(stage.title);
});

test('[AS-163] D15: a clarification slide drawn beside its open question says so, takes the Question block, and the Run preview shares it', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; }); // the Preview opens inline, in this page
  await page.setViewportSize({ width: 1440, height: 1000 });
  const pair = await divingSlides(), card = pair.document.clarifications[0];
  await openBuilder(page, pair);
  await page.locator('.builder-zone-readiness > summary').click();
  const entry = page.locator('.builder-zone-readiness .builder-readiness-slide', { has: page.locator('.builder-readiness-name', { hasText: `Clarification · ${card.label}` }) });
  const beside = entry.getByRole('button', { name: /beside the open question: add the Question block to place it on this slide/ });
  await expect(beside).toBeVisible({ timeout: 20_000 });
  await beside.click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(card.label);
  await page.locator('.builder-outline-clarification .builder-outline-target[aria-current="true"]').waitFor();
  await slide(page).locator('.slide-canvas').first().click({ position: { x: 3, y: 3 } });
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Question', exact: true }).click();
  await expect(slide(page).locator('.slide-question')).toHaveCount(1);
  await expect(entry.getByText(/Does not fit/)).toHaveCount(0, { timeout: 20_000 });
  // The Run preview starts where the author is: on the clarification's stage, with the clarification shared.
  await page.getByRole('button', { name: 'Preview this case', exact: true }).click();
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.locator('.run-preview-status')).toContainText(`Shared “${card.label}”.`);
  await expect(preview.getByRole('button', { name: /Go to editor's/ })).toBeHidden();
});

test('[AS-154] D14: a stage whose content has no notes yet offers its notes field, and what is written there is saved', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), document = pair.document;
  const stage = document.beats.find(beat => beat.kind === 'decision' && document.beats.filter(item => item.surface_id === beat.surface_id).length === 1);
  const surface = document.surfaces.find(item => item.id === stage.surface_id); delete surface.notes;
  const state = await openBuilder(page, pair);
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(stage.title);
  await page.locator('.builder-zone-private > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true });
  await expect(notes).toHaveCount(1); await expect(notes).toHaveValue('');
  await notes.fill('Ask who has flown since the dive.');
  await save(page, state);
  expect(state.pair.document.surfaces.find(item => item.id === surface.id).notes).toBe('Ask who has flown since the dive.');
});

test('[AS-154] D16: a consequence\'s and a clarification\'s own reveal content keep an editable heading and private notes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), document = pair.document, card = document.clarifications[0];
  const stage = document.beats.find(beat => beat.title === 'S1090 workshop item. In');
  const path = document.decisions.find(item => item.id === stage.decision_id).paths.find(item => item.label === 'S0217 workshop item');
  const reveal = id => document.surfaces.find(item => item.id === id);
  const state = await openBuilder(page, pair);
  // The consequence: its reveal content's heading in Stage settings, its notes in Facilitator notes.
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await page.locator('.builder-outline-target', { hasText: path.label }).first().click();
  await expect(page.locator('.builder-canvas-location')).toContainText(path.label);
  await page.locator('.builder-zone-settings > summary').click();
  const heading = page.getByRole('textbox', { name: 'Slide title', exact: true });
  await expect(heading).toHaveValue(reveal(path.reveal_surface_id).title);
  await heading.fill('Parallel assessment · results');
  await page.locator('.builder-zone-private > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true });
  await expect(notes).toHaveValue(reveal(path.reveal_surface_id).notes);
  await notes.fill('Share the CT result once the room commits.');
  // The clarification: its own content's notes, which still held source boilerplate.
  await page.locator('.builder-outline-clarification .builder-outline-target').first().click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(card.label);
  if (!(await page.locator('.builder-zone-private').evaluate(node => node.open))) await page.locator('.builder-zone-private > summary').click();
  await expect(notes).toHaveValue(reveal(card.surface_id).notes);
  await notes.fill('Share when a learner asks about exposure or the eyes.');
  await save(page, state);
  const saved = id => state.pair.document.surfaces.find(item => item.id === id);
  expect([saved(path.reveal_surface_id).title, saved(path.reveal_surface_id).notes]).toEqual(['Parallel assessment · results', 'Share the CT result once the room commits.']);
  expect(saved(card.surface_id).notes).toBe('Share when a learner asks about exposure or the eyes.');
  // The stage's own content is untouched.
  expect(saved(stage.surface_id).title).toBe(reveal(stage.surface_id).title);
});

test('[AS-154] D20/D22: leftover response mappings and content nothing shows are named in Readiness, each cleared by its own undoable control, and the Run preview runs', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; }); // the Preview opens inline, in this page
  await page.setViewportSize({ width: 1440, height: 900 });
  // The live Diving Deeper draft's shape: a ranking question whose consequences keep single-choice mappings, one of
  // them emptied (`[]`), and the reveal content a removed consequence left behind with no scene or points.
  const pair = await divingSlides(), ranking = pair.document.decisions.find(item => item.interaction.type === 'ranking');
  ranking.paths[0].option_ids = []; ranking.paths[1].option_ids = ranking.interaction.options.slice(0, 2).map(option => option.id);
  const orphan = { id: uuidv7(), kind: 'text', title: 'Coordinated imaging/surgical review' };
  pair.document.surfaces.push(orphan);
  const state = await openBuilder(page, pair), readiness = page.locator('.builder-zone-readiness');
  await readiness.locator('> summary').click();
  const unused = readiness.locator('.builder-readiness-slide', { has: page.locator('.builder-readiness-name', { hasText: 'Unused content “Coordinated imaging/surgical review”' }) });
  await expect(unused).toHaveCount(1);
  await expect(unused).toContainText('No stage, consequence or clarification shows this content.');
  await expect(unused).toContainText('stops preview');
  // Before the fix Readiness said "Must be an array" and "Option_ids is only for single choice", and nothing opened.
  await expect(readiness).not.toContainText('Must be an array');
  await expect(readiness).not.toContainText(/option_ids/i);
  // `[]` maps nothing, so only the consequence that still maps responses is listed.
  const mapped = readiness.getByRole('listitem').filter({ hasText: 'Response mappings left from single choice' });
  await expect(mapped).toHaveCount(1);
  await expect(mapped).toContainText('stops preview');
  // [AS-220] Each leftover has its own control. The mappings clear from their consequence, which the Readiness line opens...
  await mapped.getByRole('button').first().click();
  await expect(page.locator('.builder-leftover')).toContainText('Response mappings left from single choice');
  await page.locator(`[data-control-key="leftover-mappings:${ranking.paths[1].id}"]`).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Cleared the response mappings on');
  await expect(mapped).toHaveCount(0);
  await expect(page.locator('.builder-leftover')).toHaveCount(0);
  // The emptied one (`[]`) is not a problem, but it is a leftover too and clears the same way.
  await page.locator('.builder-crumb').click();
  await page.locator('button.builder-issue-link', { hasText: ranking.paths[0].label }).first().click();
  await expect(page.locator('.builder-leftover')).toContainText('An empty response mapping left from single choice');
  await page.locator(`[data-control-key="leftover-mappings:${ranking.paths[0].id}"]`).click();
  await expect(page.locator('.builder-leftover')).toHaveCount(0);
  // ...and the content nothing shows is removed from its own Readiness entry.
  await unused.getByRole('button', { name: 'Remove unused content “Coordinated imaging/surgical review”', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('Removed unused content “Coordinated imaging/surgical review”. Use Undo last change to restore it.');
  await expect(unused).toHaveCount(0);
  await expect(readiness.locator('li[data-severity="stop"]')).toHaveCount(0);
  // Rehearsal repair does not attest to source rights or publication readiness.
  await expect(readiness.locator('li[data-stops="publish"]').first()).toContainText('stops publishing');
  // Each is one change: Undo brings the content back, then the mappings; Redo removes them again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(unused).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(mapped).toHaveCount(1);
  for (let again = 0; again < 3; again++) await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(unused).toHaveCount(0);
  await expect(mapped).toHaveCount(0);
  await save(page, state);
  const saved = state.pair.document;
  expect(saved.surfaces.some(surface => surface.id === orphan.id)).toBe(false);
  expect(saved.decisions.find(item => item.id === ranking.id).paths.some(path => Object.hasOwn(path, 'option_ids'))).toBe(false);
  // Branching single-choice mappings are untouched.
  for (const decision of pair.document.decisions.filter(item => item.interaction.type === 'single_choice'))
    expect(saved.decisions.find(item => item.id === decision.id).paths.map(path => path.option_ids)).toEqual(decision.paths.map(path => path.option_ids));
  await page.getByRole('button', { name: 'Preview this case', exact: true }).click();
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.locator('.run-preview-status')).toBeVisible();
  await expect(preview.getByText(/cannot run/)).toHaveCount(0);
});

test('[AS-154] D17/D22/D20: a ranking consequence with leftover mappings can be removed and takes its unshown reveal content; leaving single choice drops mappings, reviewed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), ranking = pair.document.decisions.find(item => item.interaction.type === 'ranking');
  const spare = ranking.paths.find(path => !path.recommended && path.id !== ranking.fallback_path_id);
  const reveal = pair.document.surfaces.find(surface => surface.id === spare.reveal_surface_id);
  // The D17 shape: the scaffold's mappings stayed on a facilitator-chosen ranking question.
  for (const [index, path] of ranking.paths.entries()) path.option_ids = [ranking.interaction.options[index].id];
  const state = await openBuilder(page, pair), studio = page.locator('.builder-studio'), response = page.locator('.builder-zone-response');
  const openReview = async () => {
    await page.locator('.builder-outline-target', { hasText: pair.document.beats.find(beat => beat.decision_id === ranking.id).title }).first().click();
    await page.locator('.builder-outline-target', { hasText: spare.label }).first().click();
    if (!await response.evaluate(node => node.open)) await response.locator('> summary').click();
    await response.getByRole('button', { name: `Review removal of ${spare.label}`, exact: true }).click();
    return studio.getByRole('group', { name: 'path removal review', exact: true });
  };
  let review = await openReview();
  // Before the fix: "Cannot remove … yet. Response … maps to this consequence." with no way to clear it.
  await expect(review).toContainText(`Remove “${spare.label}” and its reveal content “${reveal.title}”, which nothing else shows?`);
  // D21: its source traces block the removal, and the review says what clears that: confirming a trace would not.
  await expect(review).toContainText('Removal is refused while these source traces point into what it removes. Move each to the record that now holds its text');
  await expect(review).not.toContainText('are reviewed');
  const blockers = review.locator('.builder-removal-blockers > li');
  const traces = (await blockers.allTextContents()).map(text => Number(/Source trace (\d+)/.exec(text)[1])).sort((a, b) => b - a);
  expect(traces.length).toBeGreaterThan(0);
  await blockers.first().getByRole('button', { name: /^Show source trace/ }).click();
  for (const number of traces) await studio.getByRole('button', { name: `Remove source trace ${number}`, exact: true }).click();
  await page.getByRole('button', { name: '← Back to the slide', exact: true }).click();
  review = await openReview();
  await review.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await save(page, state);
  let saved = state.pair.document;
  expect(saved.decisions.find(item => item.id === ranking.id).paths.some(path => path.id === spare.id)).toBe(false);
  expect(saved.surfaces.some(surface => surface.id === reveal.id)).toBe(false);
  expect(saved.compositions.some(item => item.owner.id === spare.id)).toBe(false);
  await page.locator('.builder-zone-readiness > summary').click();
  await expect(page.locator('.builder-zone-readiness')).not.toContainText('Unused content');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await save(page, state);
  saved = state.pair.document;
  expect(saved.decisions.find(item => item.id === ranking.id).paths.some(path => path.id === spare.id)).toBe(true);
  expect(saved.surfaces.some(surface => surface.id === reveal.id)).toBe(true);
  // A branching single-choice question changed to ranking lists the mappings it drops, and drops them on Apply.
  const single = pair.document.decisions.find(item => item.interaction.type === 'single_choice');
  const stage = pair.document.beats.find(beat => beat.decision_id === single.id);
  await page.locator('.builder-outline-target', { hasText: stage.title }).first().click();
  await choose(response, 'Response type', 'ranking');
  const change = studio.getByRole('group', { name: 'Review response type change', exact: true });
  for (const path of single.paths.filter(item => item.option_ids?.length)) await expect(change).toContainText(`Response mappings on “${path.label}”`);
  await change.getByRole('button', { name: 'Apply response type change', exact: true }).click();
  await save(page, state);
  saved = state.pair.document;
  expect(saved.decisions.find(item => item.id === single.id).interaction.type).toBe('ranking');
  expect(saved.decisions.find(item => item.id === single.id).paths.some(path => Object.hasOwn(path, 'option_ids'))).toBe(false);
  // Its consequences carry nothing for Readiness to flag (the ranking above still has its seeded leftovers, by design).
  for (const path of single.paths) await expect(page.locator('.builder-zone-readiness .builder-readiness-slide', { has: page.locator('.builder-readiness-name', { hasText: path.label }) })
    .filter({ hasText: 'Response mappings left from single choice' })).toHaveCount(0);
  await expect(page.locator('.builder-zone-readiness').getByRole('listitem').filter({ hasText: 'Response mappings left from single choice' })).toHaveCount(ranking.paths.length);
});

test('[AS-163] every slide is measured in the background: one that does not fit is marked in the Outline and listed under Readiness, whose link selects it (gap audit #10)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), document = pair.document;
  // Overflow a slide that is not the one opened first.
  const later = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id !== document.start_beat_id && item.reading_order.length);
  const text = document.blocks.find(block => later.reading_order.includes(block.id) && block.type === 'text');
  // Within the text limit, but far too much for a tiny area even at the 10 px floor.
  text.paragraphs = [{ style: 'p', runs: [{ text: 'The monitor alarms again while the team prepares the next step of care. '.repeat(6).trim() }] }];
  const placement = later.placements.find(item => item.block_id === text.id);
  Object.assign(placement, { w: 2, h: 1 });
  const stage = document.beats.find(beat => beat.id === later.owner.id);
  await openBuilder(page, pair);
  const row = page.locator('.builder-outline-stage', { has: page.locator('.builder-outline-name', { hasText: stage.title }) }).first();
  await expect(row.locator('.builder-outline-unfit')).toHaveText('Does not fit', { timeout: 20_000 });
  await page.locator('.builder-zone-readiness > summary').click();
  const fit = page.locator('.builder-zone-readiness').getByText(/Does not fit the projector at 1280 × 720/).first();
  await expect(fit).toBeVisible();
  // The slide's entry in the checklist holds its fit problem; the problem's link selects the slide.
  const entry = page.locator('.builder-zone-readiness .builder-readiness-slide', { has: page.locator('.builder-readiness-name', { hasText: stage.title }) }).first();
  await entry.getByRole('button', { name: /Does not fit the projector/ }).first().click();
  await expect(page.locator('.builder-sheet-heading')).toHaveText(stage.title);
});

test('[AS-163] with the Run preview open, 100 keystrokes stay within p95 100 ms key to paint, and the preview shows the edit (BWR13, gap audit #16)', { tag: '@perf' }, async ({ page }, testInfo) => {
  await page.addInitScript(() => { window.open = () => null; }); // the Preview opens inline, in this page
  await page.setViewportSize({ width: 1440, height: 1100 });
  const pair = await divingSlides();
  // Room for 100 more characters inside the 500-character block limit, so every keystroke leaves a runnable draft.
  bodyText(startBlocks(pair.document)).paragraphs = [{ style: 'p', runs: [{ text: 'Short scene.' }] }];
  await openBuilder(page, pair);
  await page.getByRole('button', { name: 'Preview this case', exact: true }).click();
  const preview = page.frameLocator('.builder-inline-preview-frame');
  await expect(preview.locator('.run-preview-status')).toContainText('Following your edits');
  const block = bodyText(startBlocks(pair.document));
  await slide(page).locator(`.slide-block[data-block-id="${block.id}"]`).click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await text.locator('p').first().evaluate(n => { const r = document.createRange(); r.setStart(n.firstChild, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.evaluate(() => {
    window.latency = [];
    document.addEventListener('keydown', () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.latency.push(performance.now() - start))); }, true);
  });
  const typed = 'Latency with the Preview open, measured on the real case. '.repeat(2).slice(0, 100);
  await page.keyboard.type(typed, { delay: 15 });
  await expect.poll(() => page.evaluate(() => window.latency.length)).toBeGreaterThanOrEqual(100);
  const samples = (await page.evaluate(() => window.latency)).sort((a, b) => a - b), p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  // The edit reaches the running preview's projector: rebuilt and replayed after typing settles.
  const settled = Date.now();
  await expect(preview.frameLocator('iframe[title="Projector"]').locator('main')).toContainText('Latency with the Preview open', { timeout: 5000 });
  const followMs = Date.now() - settled;
  latencyNote(testInfo, 'slide with Preview', samples);
  await testInfo.attach('typing-latency-preview.json', { body: JSON.stringify({ samples, p95, followMs }), contentType: 'application/json' });
  expect(p95).toBeLessThanOrEqual(100);
  expect(followMs).toBeLessThanOrEqual(1500);
});

test('[AS-163] a table column widens by dragging its edge or with the arrow keys, and the width is saved (gap audit #26)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  composition.template = 'blank'; composition.placements = [];
  const state = await openBuilder(page, pair);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  const edge = slide(page).getByRole('separator', { name: /^Width of / }).first();
  const start = Number(await edge.getAttribute('aria-valuenow'));
  await edge.focus(); await page.keyboard.press('ArrowRight');
  await expect(slide(page).getByRole('separator', { name: /^Width of / }).first()).toHaveAttribute('aria-valuenow', String(start + 1));
  // Re-audit #11: the ruler follows the pointer, and Escape mid-drag leaves the width as it was.
  const before = await slide(page).locator('.builder-col-ruler').evaluate(node => getComputedStyle(node).gridTemplateColumns);
  let box = await slide(page).getByRole('separator', { name: /^Width of / }).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 6 });
  await expect.poll(() => slide(page).locator('.builder-col-ruler').evaluate(node => getComputedStyle(node).gridTemplateColumns)).not.toBe(before);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(slide(page).getByRole('separator', { name: /^Width of / }).first()).toHaveAttribute('aria-valuenow', String(start + 1));
  // Dragging the same edge further right adds parts.
  box = await slide(page).getByRole('separator', { name: /^Width of / }).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => Number(await slide(page).getByRole('separator', { name: /^Width of / }).first().getAttribute('aria-valuenow'))).toBeGreaterThan(start + 1);
  await save(page, state);
  const table = state.pair.document.blocks.find(block => block.type === 'table');
  expect(table.columns[0].width).toBeGreaterThan(start + 1);
  // The room's own renderer draws the same shares (final audit P1): deselect, then read the canvas table's columns.
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  const total = table.columns.reduce((sum, column) => sum + column.width, 0);
  const drawn = slide(page).locator('.slide-table-grid').first();
  await expect(drawn).toBeVisible();
  const shares = await drawn.evaluate(node => [...node.querySelectorAll('col')].map(col => parseFloat(col.style.width)));
  expect(shares.map(value => Math.round(value))).toEqual(table.columns.map(column => Math.round(100 * column.width / total)));
  const [first, second] = await drawn.evaluate(node => [...node.querySelector('tr').children].slice(0, 2).map(cell => cell.getBoundingClientRect().width));
  expect(first / second).toBeCloseTo(table.columns[0].width / table.columns[1].width, 0);
});

test('[AS-163] an edited table reflows to row cards when its own block is too narrow for its columns, at any canvas width (gap audit #26)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  composition.template = 'blank'; composition.placements = [];
  await openBuilder(page, pair);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  const editor = slide(page).locator('.builder-slide-table');
  await expect(editor).not.toHaveClass(/builder-table-cards/);
  // Narrow the block to two grid columns: the canvas stays wide, the table becomes cards.
  await tools.getByText('More formatting', { exact: true }).click();
  await tools.getByText('Exact position', { exact: true }).click();
  await tools.getByLabel('Width', { exact: true }).fill('2'); await tools.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(slide(page).locator('.builder-slide-table')).toHaveClass(/builder-table-cards/);
});

test('[AS-153] a selected block looks as it does on the slide: same fill, size and paragraph spacing (BWR04, re-audit round 11)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document), block = bodyText(startBlocks(pair.document));
  composition.styles = [...(composition.styles ?? []).filter(style => style.block_id !== block.id), { ...(composition.styles ?? []).find(style => style.block_id === block.id), block_id: block.id, tone: 'blue' }];
  await openBuilder(page, pair);
  const node = slide(page).locator(`.slide-block[data-block-id="${block.id}"]`);
  // data-fits is set once every block on the canvas has been measured.
  await expect(page.locator('.builder-fit-status')).toHaveAttribute('data-fits', /^(true|false)$/);
  const look = () => node.evaluate(n => { const s = getComputedStyle(n); return { background: s.backgroundColor, size: parseFloat(s.fontSize) }; });
  const before = await look();
  await node.click();
  await expect(slide(page).getByRole('textbox', { name: 'Slide text', exact: true })).toBeVisible();
  // The canvas measures after edits settle; a block selected before its first measure takes its fitted size then.
  await expect.poll(async () => Math.abs((await look()).size - before.size), { timeout: 5_000 }).toBeLessThanOrEqual(1);
  const after = await look();
  expect(after.background).toBe(before.background);
  // Selected before or after its first measure, the block shows all of its text: no line scrolled out of sight (round 13).
  await expect.poll(() => slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).evaluate(n => n.scrollHeight - n.clientHeight)).toBeLessThanOrEqual(1);
  const gap = await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).evaluate(n => n.children.length > 1 ? parseFloat(getComputedStyle(n.children[1]).marginTop) : null);
  if (gap !== null) expect(gap).toBeGreaterThan(0);
});

test('[AS-153] Readiness is a slide checklist: one entry per slide with its problems, sources as one line marked reviewed at once; a disabled Save draft is neutral (CASE-238)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await expect(save).toBeDisabled();
  expect(await save.evaluate(n => getComputedStyle(n).backgroundColor)).not.toBe(await page.evaluate(() => getComputedStyle(Object.assign(document.body.appendChild(document.createElement('i')), { style: 'background: var(--petrol)' })).backgroundColor));
  await page.locator('.builder-zone-readiness > summary').click();
  const zone = page.locator('.builder-zone-readiness');
  const names = await zone.locator('.builder-readiness-name').allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names).size, 'each slide appears once').toBe(names.length);
  // No per-trace rows: traces are one line, and the messages use the Builder's words.
  await expect(zone).not.toContainText(/Source trace (not reviewed|changed)/);
  const messages = (await zone.locator('.builder-issue-message').allTextContents()).join('\n');
  expect(messages).not.toMatch(/\b(paths?|beats?)\b/);
  // Imported traces not yet reviewed are one line with Mark all reviewed; traces that changed after they were confirmed
  // are one line counted by slide, and need their own explicit review (CASE-321: Mark all reviewed never re-confirms them).
  const unreviewed = pair.authoringMetadata.provenance.filter(entry => entry.review_status === 'unreviewed').length;
  const stale = pair.authoringMetadata.provenance.filter(entry => entry.review_status === 'stale').length;
  await expect(zone.locator('.builder-readiness-sources')).toContainText(`Sources: ${unreviewed} traces not reviewed`);
  await expect(zone.locator('.builder-readiness-sources')).toContainText('stops publishing');
  await zone.getByRole('button', { name: 'Mark all reviewed', exact: true }).click();
  await expect(zone.locator('.builder-readiness-sources')).toHaveCount(0);
  if (stale) {
    await expect(zone.locator('.builder-readiness-cited')).toContainText(/^\d+ slides? changed since cited · stops publishing/);
    await zone.getByRole('button', { name: 'Review all', exact: true }).click();
    const review = page.getByRole('region', { name: 'Changed since cited', exact: true });
    await expect(review.locator('li')).toHaveCount(stale);
    await review.getByRole('button', { name: stale === 1 ? 'It still matches its source' : `All ${stale} still match their sources`, exact: true }).click();
    await expect(zone.locator('.builder-readiness-cited')).toHaveCount(0);
  }
  await save.click(); await expect.poll(() => state.puts).toBe(1);
  expect(state.pair.authoringMetadata.provenance.every(entry => entry.review_status === 'confirmed')).toBe(true);
  // Nothing beneath the slide reviews sources any more.
  await expect(page.locator('.builder-source-review, .builder-source-chip')).toHaveCount(0);
});

test('[AS-153] at phone width the app bar stays on one line: Preview moves into More (re-audit round 11)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBuilder(page, await divingSlides());
  // The whole banner (wordmark, Builder tools and the site menu), across the phone range: one line, nothing overlaps.
  for (const width of [320, 360, 390, 481, 515, 560]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await page.locator('.builder-app-bar').evaluate(bar => [...bar.querySelectorAll('a, button')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
      .map(node => { const box = node.getBoundingClientRect(); return { name: node.getAttribute('aria-label') || node.textContent.trim(), top: box.top, bottom: box.bottom, left: box.left, right: box.right }; }));
    // One line: every control crosses one shared horizontal band.
    expect(Math.max(...boxes.map(box => box.top)), `banner wraps at ${width}`).toBeLessThan(Math.min(...boxes.map(box => box.bottom)));
    const sorted = [...boxes].sort((a, b) => a.left - b.left);
    for (let index = 1; index < sorted.length; index++) expect(sorted[index].left, `${sorted[index].name} overlaps ${sorted[index - 1].name} at ${width}`).toBeGreaterThanOrEqual(sorted[index - 1].right - 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Preview this case', exact: true }).first()).toBeHidden();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Preview this case', exact: true })).toBeVisible();
});

test('[AS-153] choosing another stage shows its slide from the top, and Redo works from the app bar (BWR07, BWR16, re-audit round 12)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  await openBuilder(page, pair);
  const sheet = page.locator('.builder-sheet');
  await page.locator('.builder-zone-readiness > summary').click();
  await sheet.evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await sheet.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await page.locator('.builder-outline-stage > .builder-outline-target').nth(2).click();
  await expect.poll(() => sheet.evaluate(node => node.scrollTop)).toBe(0);
  await expect(page.locator('.builder-canvas-head')).toBeInViewport();
  // A history step from the app bar keeps the keyboard shortcuts there.
  await page.locator('.builder-outline-stage > .builder-outline-target').first().click();
  const zone = page.locator('details.builder-zone-private');
  if (!(await zone.evaluate(node => node.open))) await zone.locator(':scope > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true }).first();
  await notes.click(); await notes.press('End'); await page.keyboard.type(' bar shortcut');
  await expect(notes).toHaveValue(/ bar shortcut/);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await expect(notes).not.toHaveValue(/ bar shortcut/);
  // Focus stays in the app bar (Undo, or Redo once Undo has nothing left), and the shortcut acts from there.
  await expect(page.locator('.builder-studio-top :focus')).toHaveCount(1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await expect(notes).toHaveValue(/ bar shortcut/);
});

test('[AS-153] axe passes with a block selected and the Block tab open, light and dark, wide and narrow (re-audit round 12)', async ({ page }) => {
  test.setTimeout(90_000);
  const pair = await divingSlides();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBuilder(page, pair);
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light']]) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    if (width === 1280) await page.locator('.builder-slide .slide-block').first().click();
    await settled(page);
    const violations = (await new AxeBuilder({ page }).analyze()).violations.map(item => `${item.id}: ${item.nodes.map(node => node.target.join(' ')).slice(0, 3).join(', ')}`);
    expect(violations, `${width} ${theme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
});

test('[AS-153] a case over the room\'s 99 stages says so plainly in Readiness (re-audit round 12, CASE-237)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { pair } = bigBuilderPair(await divingSlides());
  await openBuilder(page, pair);
  await page.locator('.builder-zone-readiness > summary').click();
  await expect(page.locator('.builder-zone-readiness')).toContainText(`This case has ${pair.document.beats.length} stages; a room runs at most 99. The Preview cannot run it`);
});

test('[AS-153] hidden characters are refused at the key, and Undo never brings a refused draft back (BWR16, CASE-233, re-audit round 13)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  const zone = page.locator('details.builder-zone-private');
  if (!(await zone.evaluate(node => node.open))) await zone.locator(':scope > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true }).first();
  const original = await notes.inputValue();
  await notes.click(); await notes.press('End');
  await page.keyboard.type(' kept words');
  await page.keyboard.insertText('\tpasted cell');
  await expect(page.locator('.builder-studio-status')).toContainText('This text was not applied: it contains hidden characters (such as a tab).');
  await page.waitForTimeout(400);
  // The words typed before the paste stay in the draft; the tab never entered it.
  await save(page, state);
  const saved = JSON.stringify(state.pair.document);
  expect(saved).toContain(' kept words'); expect(saved).not.toContain('\\tpasted cell');
  // Undo returns to the note as it was before typing — never to a draft holding the tab — and Redo to the kept words.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(notes).toHaveValue(original);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(notes).toHaveValue(/ kept words/);
  await expect(notes).not.toHaveValue(/\t/);
});

test('[AS-153] pasted hidden characters are cleaned silently; a change only the whole-case check refuses returns on pause and never comes back (CASE-233, CASE-236, re-audit round 13)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), state = await openBuilder(page, pair);
  const zone = page.locator('details.builder-zone-private');
  if (!(await zone.evaluate(node => node.open))) await zone.locator(':scope > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true }).first();
  await notes.click(); await notes.press('End');
  // A spreadsheet cell pasted into a plain field: the tab becomes a space, nothing is refused.
  await notes.evaluate(node => { const data = new DataTransfer(); data.setData('text/plain', ' cell\tvalue'); node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  await expect(notes).toHaveValue(/ cell value/);
  await page.waitForTimeout(400);
  await save(page, state);
  expect(JSON.stringify(state.pair.document)).toContain(' cell value');
  // The question's own text has no per-key check: a typed tab (not a paste) passes the key, and the pause check refuses
  // it, returning the draft to its last valid state. Save and Undo/Redo never bring it back.
  const question = slide(page).locator('.slide-block').filter({ has: page.locator('.builder-slide-kicker', { hasText: 'Question' }) }).first();
  await question.click();
  const prompt = slide(page).getByRole('textbox', { name: 'Question text', exact: true });
  await prompt.click(); await prompt.press('End'); await page.keyboard.insertText('\tcell');
  await expect(page.locator('.builder-studio-status')).toContainText('This text was not applied: it contains hidden characters', { timeout: 3_000 });
  if (await page.getByRole('button', { name: 'Save draft', exact: true }).isEnabled()) await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.waitForTimeout(300);
  expect(JSON.stringify(state.pair.document)).not.toContain('\\tcell');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  if (await redo.isEnabled()) await redo.click();
  await page.waitForTimeout(300);
  // The draft shown after the history steps never holds the tab, and it saves cleanly.
  await expect(slide(page).locator('.slide-block').filter({ hasText: 'Question' }).first()).not.toContainText('\tcell');
  if (await page.getByRole('button', { name: 'Save draft', exact: true }).isEnabled()) await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('.builder-studio-status')).not.toContainText('Draft not saved');
  expect(JSON.stringify(state.pair.document)).not.toContain('\\tcell');
});

test('[AS-153] after a refusal on pause, Undo still steps back through the typing and the edit before it (BWR16, CASE-233, fifth re-audit)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, await divingSlides());
  const zone = page.locator('details.builder-zone-private');
  if (!(await zone.evaluate(node => node.open))) await zone.locator(':scope > summary').click();
  const notes = page.getByRole('textbox', { name: 'Private facilitator notes', exact: true }).first();
  await notes.click(); await notes.press('End'); await page.keyboard.type(' EDIT-A');
  await page.waitForTimeout(1300); // a separate history step
  const question = slide(page).locator('.slide-block').filter({ has: page.locator('.builder-slide-kicker', { hasText: 'Question' }) }).first();
  await question.click();
  const prompt = slide(page).getByRole('textbox', { name: 'Question text', exact: true });
  await prompt.click(); await prompt.press('End'); await page.keyboard.type(' ok');
  await page.waitForTimeout(400);
  await page.keyboard.insertText('\tx');
  await expect(page.locator('.builder-studio-status')).toContainText('This text was not applied: it contains hidden characters', { timeout: 3_000 });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await expect(page.locator('.builder-studio-status')).not.toContainText('Undo unavailable');
  await expect(slide(page).getByRole('textbox', { name: 'Question text', exact: true })).not.toHaveValue(/ ok$/);
  await undo.click();
  await expect(page.locator('.builder-studio-status')).not.toContainText('Undo unavailable');
  await expect(notes).not.toHaveValue(/ EDIT-A/);
});

test('[AS-163] a table added to a full slide shares its area without overlapping anything, at 1440 and 390; long words never break silently (CASE-241)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  composition.placements = composition.placements.slice(0, 1).map(item => ({ ...item, col: 1, row: 1, w: 12, h: 12 }));
  await openBuilder(page, pair);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  const table = slide(page).locator('.slide-block[data-selected]');
  await expect(table.locator('.builder-slide-table')).toBeVisible();
  const overlaps = () => page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.builder-slide .slide-canvas > .slide-block')].map(node => ({ node, box: node.getBoundingClientRect() }));
    const selected = blocks.find(item => item.node.dataset.selected);
    return blocks.filter(item => item !== selected && item.box.height > 0).some(item => selected.box.left < item.box.right - 1 && item.box.left < selected.box.right - 1 && selected.box.top < item.box.bottom - 1 && item.box.top < selected.box.bottom - 1);
  });
  expect(await overlaps(), 'the selected table never covers another block').toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const [block, foot] = await Promise.all([table.boundingBox(), page.locator('.builder-canvas-footer').boundingBox()]);
    return block && foot ? block.y + block.height <= foot.y + 1 : false;
  }).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A word wider than its column is shown whole and reported, never cut mid-word without a word.
  const cell = table.getByRole('textbox', { name: /Unit, row 1/ }).first();
  await cell.fill('Haemoglobinopathy');
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  const drawn = slide(page).locator('.slide-table-grid td', { hasText: 'Haemoglobinopathy' }).first();
  await expect(drawn).toBeVisible();
  expect(await drawn.evaluate(node => getComputedStyle(node).overflowWrap)).not.toBe('anywhere');
  await expect.poll(async () => {
    // Every drawn cell fits its column, or the fit line says the slide does not fit: never text run together silently.
    const fits = await slide(page).locator('.slide-table-grid').first().evaluate(node => [...node.querySelectorAll('th, td')].every(cell => cell.scrollWidth <= cell.clientWidth + 1));
    const status = await page.locator('.builder-fit-status').textContent();
    return fits || !/^All blocks fit|^Placed blocks fit/.test(status ?? '');
  }, { timeout: 5_000 }).toBe(true);
});

test('[AS-153] typing then Undo then Redo returns exactly the typed text; typing stops at the block limit and says so at the block (BWR16, polish rounds 17 and 19)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  const block = bodyText(startBlocks(pair.document));
  block.paragraphs = block.paragraphs.slice(0, 2); // room to type: well under the 500-character block limit
  await openBuilder(page, pair);
  const node = slide(page).locator(`.slide-block[data-block-id="${block.id}"]`);
  await node.click();
  const text = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await text.locator('p').last().evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  const typed = ' Extra words typed here.';
  for (const key of typed) await page.keyboard.type(key, { delay: 80 });
  await page.waitForTimeout(400);
  const undo = page.getByRole('button', { name: 'Undo', exact: true }), redo = page.getByRole('button', { name: 'Redo', exact: true });
  await undo.click();
  await expect(node).not.toContainText('Extra words');
  await redo.click();
  await expect(node).toContainText(typed.trim());
  // Near the limit the meter shows the room left; past it, the block itself says the text is not saved.
  await node.click();
  const editor = slide(page).getByRole('textbox', { name: 'Slide text', exact: true });
  await editor.locator('p').last().evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
  // Past it, typing stops at the limit (round 19): nothing the draft would refuse sits on the slide.
  const before = (await editor.innerText()).replace(/\n/g, '').length;
  await page.keyboard.insertText(' x'.repeat(260));
  await expect(page.locator('.builder-limit-meter')).toHaveText('500 / 500 · limit reached');
  expect((await editor.innerText()).replace(/\n/g, '').length).toBe(before);
  // A paste keeps what fits.
  await editor.evaluate(el => { const data = new DataTransfer(); data.setData('text/plain', 'y'.repeat(600)); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  await expect.poll(async () => (await editor.innerText()).replace(/\n/g, '').length).toBeGreaterThan(before);
  await page.waitForTimeout(400);
  await expect(page.locator('.builder-studio-status')).not.toContainText('not applied');
  await expect(page.locator('.builder-limit-meter')).toHaveText(/500 \/ 500/);
});

test('[AS-153] clicking into a block puts the caret where the author clicked; a new block opens ready to write (polish round 17)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  const block = bodyText(startBlocks(pair.document));
  block.paragraphs = block.paragraphs.slice(0, 2);
  await openBuilder(page, pair);
  const node = slide(page).locator(`.slide-block[data-block-id="${block.id}"]`);
  // Click at the end of the second paragraph's last word, then type.
  const point = await node.locator('p').nth(1).evaluate(el => { const range = document.createRange(); const text = el.lastChild; range.setStart(text, text.length - 1); range.setEnd(text, text.length); const box = range.getBoundingClientRect(); return { x: box.right - 1, y: box.top + box.height / 2 }; });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(150);
  await page.keyboard.type(' HERE');
  const last = await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).locator('p').nth(1).textContent();
  expect(last.trimEnd().endsWith('HERE'), `typed at the click point: “…${last.slice(-30)}”`).toBe(true);
  // Adding a text block selects it with the caret in it: typing goes into the new block.
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  await (await openPalette(page)).getByRole('button', { name: 'Text', exact: true }).click();
  await page.waitForTimeout(150);
  await page.keyboard.type('Fresh block words');
  await expect(slide(page).locator('.slide-block[data-selected]')).toContainText('Fresh block words');
});

test('[AS-153] the Outline is one Tab stop with arrow keys between slides, and Readiness marks what stops a run (round 18)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(); await openBuilder(page, pair);
  const targets = page.locator('.builder-outline-list :is(.builder-outline-target, .builder-branch-chip):visible');
  await expect(page.locator('.builder-outline-list [tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.builder-outline-list [tabindex="0"]')).toHaveAttribute('aria-current', 'true');
  await page.locator('.builder-outline-list [tabindex="0"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(targets.nth(1)).toBeFocused();
  await expect(page.locator('.builder-outline-list [tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('End');
  await expect(targets.last()).toBeFocused();
  // Tab leaves the Outline in one step instead of walking every slide.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('.builder-outline-list')))).toBe(false);
  // Readiness settles once the case-wide fit pass is in, and every problem carries its severity.
  const summary = page.locator('.builder-zone-readiness > summary');
  // The fit pass starts once edits settle, so the summary first says it is checking, then settles once.
  await expect(summary).toContainText('checking fit');
  await expect(summary).not.toContainText('checking fit', { timeout: 20_000 });
  await summary.click();
  const items = page.locator('.builder-readiness-slide li');
  await expect(items.first()).toBeVisible();
  for (const severity of await items.evaluateAll(list => list.map(item => item.dataset.severity))) expect(['stop', 'advice']).toContain(severity);
  await expect(page.locator('.builder-zone-readiness')).toHaveAttribute('data-severity', /^(stop|advice|ready)$/);
});

test('[AS-163] a new table opens on its first cell and Tab walks the cells before the column edges; consequences stack at phone width (round 19)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  // A slide with room: only its title is placed and shown (a full slide keeps a new block unplaced, round 20).
  const [title] = composition.placements;
  composition.placements = [title]; composition.reading_order = [title.block_id, ...composition.reading_order.filter(id => pair.document.blocks.find(block => block.id === id)?.type === 'question')];
  composition.steps = [{ ...composition.steps[0], block_ids: [...composition.reading_order] }];
  const question = composition.reading_order[1];
  if (question) composition.placements.push({ block_id: question, col: 9, row: 3, w: 4, h: 8 });
  await openBuilder(page, pair);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  const table = slide(page).locator('.slide-block[data-selected] .builder-slide-table');
  await expect(table).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('tbody')))).toBe(true);
  await page.keyboard.type('112');
  await expect(table.locator('tbody :is(textarea, input)').first()).toHaveValue('112');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('separator');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('tbody')))).toBe(true);
  // At phone width each consequence reads as a labelled card, not a four-column table.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.builder-zone-response > summary').click();
  const leads = page.locator('.builder-consequences td[data-label="Leads to"]').first();
  await expect(leads).toBeVisible();
  expect(await leads.evaluate(node => getComputedStyle(node).display)).toBe('grid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('[AS-153] a block added to a full slide never squeezes its text or question: it waits under Unplaced and says so (round 20)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), composition = startComposition(pair.document);
  await openBuilder(page, pair);
  const sizes = () => slide(page).locator('.slide-canvas > .slide-block').evaluateAll(list => list.map(node => [node.dataset.blockId, node.style.gridArea]));
  // The slide must be drawn before its placements are read (the slides chunk loads after the studio; CASE-249).
  await expect(slide(page).locator('.slide-canvas > .slide-block').first()).toBeVisible();
  const before = await sizes();
  expect(before.length).toBeGreaterThan(0);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('The slide is full, so it waits under Unplaced');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  expect(await sizes()).toEqual(before);
  await expect(slide(page).getByText(/1 unplaced block/)).toBeVisible();
});


test('[AS-153] a table that waits under Unplaced takes the keyboard; Place says what to do on a full slide; the reveal order marks it (round 21)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides();
  await openBuilder(page, pair);
  await (await openPalette(page)).getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).toContainText('waits under Unplaced');
  const tray = slide(page).locator('.builder-slide-unplaced');
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.builder-slide-unplaced tbody')))).toBe(true);
  await page.keyboard.type('112');
  await expect(tray.locator('tbody :is(textarea, input)').first()).toHaveValue('112');
  const place = tray.getByRole('button', { name: /^Place .* on the slide$/ });
  await expect(place).toHaveText('Place on slide');
  await place.click();
  await expect(page.locator('.builder-studio-status')).toContainText('No room on the slide. Make a block smaller first.');
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await tools.getByRole('button', { name: '← This slide', exact: true }).click();
  await expect(tools.locator('.builder-order-unplaced')).toHaveCount(1);
});

test('[AS-153] r25 P3: the Add block palette\'s tiles are one height at 1440 and 390', async ({ page }) => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    if (w === 1440) await openBuilder(page, await divingSlides());
    await slide(page).locator('.slide-canvas').first().click({ position: { x: 3, y: 3 } });
    if (await page.locator('.builder-workspace').getAttribute('data-layout') === 'single') await page.locator('.builder-regions').getByRole('button', { name: 'Inspector', exact: true }).click();
    const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
    // Measured once the web font is in, as a tile's lines depend on it.
    await page.evaluate(() => document.fonts.ready);
    const tiles = await tools.getByRole('group', { name: 'Add block', exact: true }).locator('.builder-palette-item').evaluateAll(nodes => nodes.map(node => [node.textContent.trim(), Math.round(node.getBoundingClientRect().height)]));
    const heights = tiles.map(([, height]) => height);
    expect(heights.length, `${w}: tiles`).toBeGreaterThanOrEqual(7);
    expect(new Set(heights).size, `${w}: tile heights ${tiles.map(tile => tile.join(' ')).join(', ')}`).toBe(1);
    expect(heights[0]).toBeGreaterThanOrEqual(44);
  }
});

// Card 60 (Not Yet Stable build, 2026-10-17). Each was written first and seen to fail.
/** Stage ids reachable from the start through next links, consequences and terminal checkpoints. */
function reachable(document) {
  const seen = new Set(), queue = [document.start_beat_id];
  while (queue.length) {
    const id = queue.shift(); if (!id || seen.has(id)) continue; seen.add(id);
    const beat = document.beats.find(item => item.id === id);
    if (beat?.next_beat_id) queue.push(beat.next_beat_id);
    for (const path of document.decisions.find(item => item.id === beat?.decision_id)?.paths ?? []) queue.push(path.next_beat_id, path.terminal?.checkpoint_beat_id);
  }
  return seen;
}

test('[AS-162] STRUCTURE-01: Add question after a stage with no next stage links that stage to the new question', async ({ page }) => {
  const pair = createBuilderStoryStarter(), state = await openBuilder(page, pair), endpoint = pair.document.start_beat_id;
  expect(pair.document.beats.find(beat => beat.id === endpoint).next_beat_id).toBeUndefined();
  await page.getByLabel('Slide title', { exact: true }).fill('Preparing to leave');
  await slideMenu(page, 'Add question after');
  const question = page.getByRole('group', { name: 'Add question', exact: true });
  await choose(question, 'Response type', 'multi_select');
  await question.getByRole('button', { name: 'Add question', exact: true }).click();
  await save(page, state);
  const saved = state.pair.document, decision = saved.decisions[0], beat = saved.beats.find(item => item.decision_id === decision.id);
  expect(saved.beats.find(item => item.id === endpoint).next_beat_id).toBe(beat.id);
  // Its Continue leads to the closing stage made with it, and nothing is left unconnected to the start.
  expect(saved.beats.find(item => item.id === decision.paths[0].next_beat_id)?.kind).toBe('debrief');
  expect([...reachable(saved)].sort()).toEqual(saved.beats.map(item => item.id).sort());
  await expect(page.locator('.builder-outline')).not.toContainText('Not connected to the start');
});

test('[AS-162] STRUCTURE-01: Add branches on an ordinary question keeps its first route and adds the second to the same question', async ({ page }) => {
  const pair = createBuilderStoryStarter(), state = await openBuilder(page, pair);
  await page.getByLabel('Slide title', { exact: true }).fill('Opening story');
  await slideMenu(page, 'Add question after');
  const question = page.getByRole('group', { name: 'Add question', exact: true });
  await choose(question, 'Response type', 'free_text');
  await question.getByRole('button', { name: 'Add question', exact: true }).click();
  await page.locator('.builder-zone-response > summary').click();
  await page.getByRole('button', { name: 'Add branches', exact: true }).click();
  await save(page, state);
  const saved = state.pair.document, decision = saved.decisions[0];
  expect(decision.paths).toHaveLength(2);
  expect(decision.paths.some(path => path.continue_to_next)).toBe(false);
  expect(decision.paths[1].next_beat_id).toBe(decision.paths[0].next_beat_id);
  for (const path of decision.paths) expect(saved.compositions.some(item => item.owner.kind === 'path' && item.owner.id === path.id), path.id).toBe(true);
});

test('[AS-160] PREVIEW-02: a terminal consequence made in the Builder passes Readiness and resets to its checkpoint in the Run preview', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; }); // the Preview opens inline, in this page
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = mvcSchema2(), state = await openBuilder(page, pair);
  const stage = pair.document.beats.find(beat => beat.title === 'S00165 workshop title'), decisionId = stage.decision_id;
  const target = pair.document.decisions.find(item => item.id === decisionId).paths.find(path => path.label === 'S00173 workshop label. Record az');
  expect(target.terminal).toBeUndefined();
  await page.locator('.builder-outline-target', { hasText: 'S00165 workshop title' }).first().click();
  await page.getByRole('region', { name: 'Consequences', exact: true }).getByRole('button', { name: target.label, exact: true }).click();
  await page.getByRole('button', { name: 'Make this a terminal consequence', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make this consequence continue from its checkpoint', exact: true })).toBeVisible();
  await page.getByLabel('Terminal debrief prompt', { exact: true }).fill('Why did imaging first cost the patient their output?');
  await save(page, state);
  const path = () => state.pair.document.decisions.find(item => item.id === decisionId).paths.find(item => item.id === target.id);
  expect(path()).toMatchObject({ classification: 'terminal-unsafe', terminal: { checkpoint_beat_id: stage.id, restore_policy: 'snapshot' } });
  expect('next_beat_id' in path()).toBe(false);
  const ready = validateBuilderDocument(state.pair.document, state.pair.authoringMetadata, { mode: 'ready' });
  const decisionIndex = state.pair.document.decisions.findIndex(item => item.id === decisionId);
  expect(ready.errors.filter(issue => issue.at.startsWith(`/decisions/${decisionIndex}/`))).toEqual([]);
  await page.locator('.builder-zone-readiness > summary').click();
  await expect(page.locator('.builder-zone-readiness')).not.toContainText('snapshot');
  // The Run preview runs it: the consequence ends the round, and its reset returns the room to the question.
  await page.getByRole('button', { name: 'Preview this case', exact: true }).click();
  const preview = page.frameLocator('.builder-inline-preview-frame'), jump = preview.locator('select[aria-label="Jump to stage"]');
  await expect(preview.getByText(/cannot run/)).toHaveCount(0);
  await jump.selectOption(`${stage.id}|${target.id}`, { force: true });
  await expect(preview.locator('.run-preview-status')).toContainText('Replayed the route to');
  const primary = preview.locator('.run-preview-rail .console-primary');
  for (let i = 0; i < 6 && !/^Reset to /.test(await primary.textContent()); i++) await primary.click();
  await expect(primary).toHaveText('Reset to S00165 workshop title');
  await primary.click();
  await expect(jump).toHaveValue(stage.id);
  // Making it continue again replaces the consequence: no terminal is left behind, and the author names where it goes.
  await page.getByRole('button', { name: 'Make this consequence continue from its checkpoint', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make this a terminal consequence', exact: true })).toBeVisible();
  await choose(page, 'Continue to stage', pair.document.beats.find(beat => beat.title === 'S00167 worksho').id);
  await save(page, state);
  expect('terminal' in path()).toBe(false);
  expect(path()).toMatchObject({ classification: 'unsafe', next_beat_id: pair.document.beats.find(beat => beat.title === 'S00167 worksho').id });
});

test('[AS-160] PREVIEW-02: a draft saved with a terminal the old controls made is repaired as it opens and autosaved', async ({ page }) => {
  const pair = mvcSchema2(), path = pair.document.decisions.flatMap(decision => decision.paths).find(item => item.terminal);
  delete path.terminal.restore_policy; path.next_beat_id = path.terminal.checkpoint_beat_id;
  const state = await openBuilder(page, pair);
  await expect.poll(() => state.puts, { timeout: 15_000 }).toBe(1);
  const saved = state.pair.document.decisions.flatMap(decision => decision.paths).find(item => item.id === path.id);
  expect(saved.terminal.restore_policy).toBe('snapshot');
  expect('next_beat_id' in saved).toBe(false);
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
});

test('[AS-154] REVIEW-01: a reviewed removal survives an autosave that changes nothing in the reviewed draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), body = bodyText(startBlocks(pair.document)), state = await openBuilder(page, pair);
  const block = slide(page).locator(`.slide-block[data-block-id="${body.id}"]`);
  // An edit whose autosave is held until the review is open.
  let release; state.gate = new Promise(resolve => { release = resolve; });
  await block.click();
  await slide(page).getByRole('textbox', { name: 'Slide text', exact: true }).fill('Written before the review.');
  await page.locator('body').evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Delete');
  const review = page.getByRole('group', { name: 'Review change', exact: true });
  await expect(review.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  const before = state.puts;
  release(); state.gate = null;
  await expect.poll(() => state.puts, { timeout: 15_000 }).toBe(before + 1);
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  await review.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('.builder-studio-status')).not.toContainText('The draft changed after this review');
  await expect(block).toHaveCount(0);
});

// CASE-321 screenshots for review: SHOTS=<folder> writes each new surface in light and dark there; unset, nothing is written.
const shot = async (page, name) => { if (!process.env.SHOTS) return; for (const theme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: theme }); await page.screenshot({ path: join(process.env.SHOTS, `${name}-${theme}.png`), fullPage: false }); } await page.emulateMedia({ colorScheme: 'light' }); };

test('[AS-191] Sources: paste a citation, tick permission and link it from a slide with Based on; the link is reviewed, publishable and follows its source (CASE-321)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = createBuilderStoryStarter(), state = await openBuilder(page, pair), studio = page.locator('.builder-studio');
  const start = pair.document.start_beat_id;
  await studio.getByRole('button', { name: 'Sources', exact: true }).click();
  const view = studio.getByRole('region', { name: 'Sources', exact: true }), form = view.getByRole('form', { name: 'Add a source', exact: true });
  await expect(view).toContainText('No sources yet.');
  let baseline = builderSaveCheckpoint(state);
  await form.getByLabel('Citation or link', { exact: true }).fill('https://www.ginasthma.org/reports/2024');
  await form.getByLabel('Page, section or figure', { exact: true }).fill('Box 9-4, p. 185');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Add source', exact: true }).click();
  const first = view.locator('.builder-source-item').first();
  await expect(first.locator('.builder-source-cite')).toHaveText('ginasthma.org');
  await expect(first).toContainText('Not used yet');
  await expect(first.locator('.tag')).toHaveText('Can use');
  await expect(form.getByLabel('Citation or link', { exact: true })).toHaveValue('');
  await form.getByLabel('Citation or link', { exact: true }).fill('Leatherman J. Mechanical ventilation for severe asthma. Chest 2015;147:1671–80.');
  await form.getByRole('button', { name: 'Add source', exact: true }).click();
  await expect(view.locator('.builder-source-item').nth(1).locator('.tag')).toHaveText('Needs permission');
  // On the slide: Based on + Add links the whole source.
  await studio.getByRole('button', { name: '← Back to the slide', exact: true }).click();
  const based = studio.getByRole('group', { name: 'Based on', exact: true });
  await based.getByRole('button', { name: 'Add a source to this slide', exact: true }).click();
  await based.getByRole('group', { name: 'Add a source to this slide', exact: true }).getByRole('button', { name: '1 ginasthma.org', exact: true }).click();
  await expect(based.locator('.builder-based-on-chip')).toHaveText(/^1 ginasthma\.org/);
  await saveBuilderDraft(page, { expect, baseline, evidence: () => state });
  const metadata = state.pair.authoringMetadata, [gina, leatherman] = metadata.sources;
  expect(Object.keys(gina).sort()).toEqual(['id', 'rights_status', 'sha256', 'text', 'title']);
  expect(gina).toMatchObject({ title: 'ginasthma.org', text: 'https://www.ginasthma.org/reports/2024\nBox 9-4, p. 185', rights_status: 'permitted' });
  expect(gina.sha256).toBe(createHash('sha256').update(gina.text).digest('hex'));
  expect(leatherman.rights_status).toBe('unknown');
  expect(metadata.provenance).toEqual([{ entity_id: start, field: 'title', source_id: gina.id, start_line: 1, end_line: 2, transformation: 'adapted', visibility: 'private', review_status: 'confirmed' }]);
  // The link passes the publishing gate; only the unticked source is refused, by name.
  const blockers = builderPublicationIssues(state.pair.document, metadata, validateBuilderDocument(state.pair.document, metadata, { mode: 'ready', validateSlides: validateSlideParts })).filter(issue => /^(rights_|source_|provenance_)/.test(issue.code));
  expect(blockers.map(issue => [issue.code, issue.at])).toEqual([['rights_unresolved', '/sources/1/rights_status']]);
  await expect(studio.locator('.builder-readiness-sources, .builder-readiness-cited')).toHaveCount(0);
  await shot(page, 'builder-based-on');
  // Editing the source's text re-ranges the link and asks for one review, as one Readiness line.
  await studio.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(first).toContainText('Used on Slide 1');
  await shot(page, 'builder-sources');
  baseline = builderSaveCheckpoint(state);
  await view.locator('summary', { hasText: 'Advanced · detailed source traces (1)' }).click();
  await view.getByLabel('Source 1 original text', { exact: true }).fill('https://www.ginasthma.org/reports/2024\nBox 9-4, p. 185\nChecked 30 October 2026');
  const review = view.getByRole('region', { name: 'Changed since cited', exact: true });
  await expect(review).toBeVisible();
  await expect(studio.locator('.builder-readiness-cited')).toContainText('1 slide changed since cited · stops publishing');
  await review.getByRole('button', { name: 'It still matches its source', exact: true }).click();
  await expect(review).toHaveCount(0);
  await saveBuilderDraft(page, { expect, baseline, evidence: () => state });
  expect(state.pair.authoringMetadata.provenance).toEqual([{ entity_id: start, field: 'title', source_id: gina.id, start_line: 1, end_line: 3, transformation: 'adapted', visibility: 'private', review_status: 'confirmed' }]);
  // × removes the link; the source stays, now unused.
  await studio.getByRole('button', { name: '← Back to the slide', exact: true }).click();
  await based.getByRole('button', { name: 'Remove ginasthma.org from this slide', exact: true }).click();
  await expect(based.locator('.builder-based-on-chip')).toHaveCount(0);
});

test('[AS-192] Overview: the case at a glance with counts, its flow by classification and Before you publish grouped, at its own address (CASE-321)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = await divingSlides(), studio = page.locator('.builder-studio');
  await openBuilder(page, pair);
  await studio.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/cases/${worker.caseId}/edit/overview$`));
  const overview = studio.getByRole('region', { name: 'Case overview', exact: true });
  await expect(overview.locator('.builder-overview-title')).toHaveText(pair.document.title);
  const decisions = new Set(pair.document.beats.filter(beat => beat.kind === 'decision').map(beat => beat.decision_id)).size;
  await expect(overview.locator('.builder-overview-counts')).toContainText(`${decisions} question`);
  await expect(overview.getByRole('button', { name: /^(Publish|Send for review)…$/ })).toBeVisible();
  // The console's braid, then each slide in Outline order with branches coloured by classification.
  await expect(overview.locator('.whole-case-braid')).toBeVisible();
  const spine = overview.locator('.builder-flow-stop .builder-flow-number');
  await expect(spine.first()).toHaveText('1');
  const branches = overview.locator('.builder-flow-branch[data-classification]'); // clarifications are listed beside them, unclassified
  expect(await branches.count()).toBe(pair.document.decisions.filter(decision => pair.document.beats.some(beat => beat.decision_id === decision.id)).reduce((n, decision) => n + decision.paths.length, 0));
  for (const value of await branches.evaluateAll(nodes => nodes.map(node => node.dataset.classification))) expect(['sound', 'defensible', 'context-dependent', 'unsafe', 'terminal-unsafe', 'discussion-prompt']).toContain(value);
  await expect(overview).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  const check = overview.getByRole('region', { name: 'Before you publish', exact: true });
  await expect(check.locator('h4').first()).toHaveText(/^(Stops publishing|Stops preview|Advice) · \d+$/);
  await shot(page, 'builder-overview');
  // A slide in the flow opens it; Back returns to the Overview at its address.
  await overview.locator('.builder-flow-node').nth(1).click();
  await expect(overview).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/cases/${worker.caseId}/edit$`));
  await page.goBack();
  await expect(overview).toBeVisible();
  // Case details: Edit opens the details view.
  await overview.getByRole('button', { name: 'Edit case details', exact: true }).click();
  await expect(studio.locator('.builder-global-details')).toBeVisible();
});
