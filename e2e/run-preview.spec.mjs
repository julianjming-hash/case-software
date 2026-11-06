// Run preview (CASE-226): the draft runs like a live room — the real projector, a real phone for each simulated learner,
// and the console's teaching dock — on the memory-only room machine. Real Chromium, local mocked draft API.
import { test, expect } from '@playwright/test';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import sourceFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { ordinaryQuestions } from '../tests/helpers/ordinary-questions.mjs';
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

/** One saved draft. All API mutations are observed; only the authoring-edit test permits normal private CAS saves. */
async function openBuilder(page, { findings, allowDraftSaves = false, document = null } = {}) {
  const converted = document ? { candidate: structuredClone(document) } : convertSchema1ToBuilderDocument(structuredClone(sourceFixture), { metadata_version: 1 });
  for (const surface of converted.candidate.surfaces) delete surface.variants;
  // AS-150 needs an opening stage that fits once its scene is short; with the CASE-223 block inset the fixture's full
  // findings list alone fills the slide, so that test keeps only the first few findings.
  if (findings) { const opening = converted.candidate.beats.find(beat => beat.id === converted.candidate.start_beat_id); const surface = converted.candidate.surfaces.find(item => item.id === opening.surface_id); surface.points = surface.points.slice(0, findings); }
  const pair = { document: converted.candidate, authoringMetadata: { metadata_version: 1 } }, writes = [], submissions = [], windows = new Map();
  let stored = structuredClone(pair), revision = 1;
  // The preview engine lives in the parent's realm: observe every page/frame, rather than filtering by origin page.
  page.context().on('request', request => {
    const path = new URL(request.url()).pathname;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && path.startsWith('/api/v1/'))
      writes.push(`${request.method()} ${path.startsWith(`/api/v1/builder/cases/${worker.caseId}/`) ? path.split(`/cases/${worker.caseId}/`)[1] : path}`);
  });
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const request = route.request(), method = request.method(), suffix = new URL(request.url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (method !== 'GET') {
      if (!allowDraftSaves) return reply({ error: 'forbidden_in_test' }, 403);
      if (method === 'POST' && suffix === 'save-windows') {
        if (request.postDataJSON().baseRevision !== revision) return reply({ error: 'revision_conflict' }, 409);
        const operationId = uuidv7(); windows.set(operationId, revision); return reply({ operationId, baseRevision: revision });
      }
      if (method === 'PUT' && suffix === 'draft') {
        const body = request.postDataJSON();
        if (windows.get(body.operationId) !== revision) return reply({ error: 'revision_conflict' }, 409);
        const checked = validateBuilderDocument(body.document, body.authoringMetadata, { mode: 'preserve' });
        if (!checked.ok) return reply({ error: 'invalid_draft', issues: checked.errors }, 422);
        stored = structuredClone({ document: body.document, authoringMetadata: body.authoringMetadata }); submissions.push(stored); revision++;
        return reply({ operationId: body.operationId, revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' });
      }
      return reply({ error: 'forbidden_in_test' }, 403);
    }
    if (suffix === 'draft') return reply({ case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', title: stored.document.title, sourceVersion: null, capabilities: ['slide_composition'] },
      revision, draft: { revision, ...structuredClone(stored), intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'checkpoints') return reply({ checkpoints: [] });
    return reply({ error: 'not_found' }, 404);
  });
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  const start = pair.document.beats.find(beat => beat.id === pair.document.start_beat_id);
  return { writes, submissions, start, scene: pair.document.surfaces.find(surface => surface.id === start.surface_id).scene };
}
const previewButton = page => page.getByRole('button', { name: 'Preview this case', exact: true });
const openPreview = async page => { const [child] = await Promise.all([page.waitForEvent('popup'), previewButton(page).click()]); await expect(child.getByRole('heading', { name: /^Preview · / })).toBeVisible(); return child; };

const stage = child => child.frameLocator('iframe[title="Projector"]');
const phone = child => child.frameLocator('iframe[title="Phone"]');
const primary = child => child.locator('.run-preview-rail .console-primary');
/**
 * Resize the preview window and wait for its layout to settle. The preview sizes its projector and phone in its window's
 * resize handler (scaleFrames, builder-inspection.mjs), which runs in a rendering step after setViewportSize resolves; a
 * fixed 250 ms pause once measured the replay row against the previous size's taller stage (main 38685372650: at 1440 ×
 * 900 the row ended at 952 against a dock at 819, the 1080 → 900 height change). So: wait for the new window size, then
 * for two frames in which the stage, rail and dock no longer move.
 */
async function resized(child, width, height) {
  await child.setViewportSize({ width, height });
  await child.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
  await child.evaluate(() => scrollTo(0, 0));
  await child.waitForFunction(() => new Promise(done => {
    const read = () => JSON.stringify(['.run-preview-stage', '.run-preview-rail', '.run-preview-dock'].map(selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null));
    const before = read(); requestAnimationFrame(() => requestAnimationFrame(() => done(read() === before)));
  }));
}
/** Press the dock's primary action until `done` holds (the console's own path through a stage). */
async function advanceUntil(child, done, limit = 8) {
  for (let i = 0; i < limit && !(await done()); i++) await primary(child).click();
  expect(await done()).toBe(true);
}

test('[AS-160] Run preview runs the draft like a room: real projector and phone, simulated and hand answers, results, route, Undo; nothing is saved', async ({ page, context }) => {
  const { writes } = await openBuilder(page, { findings: 4 });
  // The engine runs in the Builder's realm: it must not write storage or open broadcast channels.
  await page.evaluate(() => {
    window.storageBefore = { local: { ...localStorage }, session: { ...sessionStorage } }; window.channels = [];
    const Native = window.BroadcastChannel; window.BroadcastChannel = class extends Native { constructor(name) { super(name); window.channels.push(name); } };
  });
  const child = await openPreview(page);
  // It opens on the stage selected in the editor, replayed from the start, on the real screens at their real sizes.
  await expect(child.locator('.run-preview-status')).toContainText(`Replayed the route to ${sourceFixture.beats.find(beat=>beat.id===sourceFixture.start_beat_id).title}.`);
  await expect(child.locator('iframe[title="Projector"]')).toHaveAttribute('width', '1280');
  await expect(child.locator('iframe[title="Phone"]')).toHaveAttribute('width', '390');
  await expect(stage(child).locator('body.projector .screen header.top')).toBeVisible();
  await expect(stage(child).locator('footer')).toContainText('Preview');
  await expect(phone(child).locator('.phone-app')).toContainText('Ari');
  // The room's own roster: four simulated learners, each with a real avatar.
  await expect(child.getByRole('group', { name: 'Phone of', exact: true }).getByRole('button')).toHaveCount(4);
  await expect(phone(child).locator('#whoAv img.avatar')).toHaveJSProperty('complete', true);
  // The dock walks the stage to the decision; answers open on the projector and on the phone.
  await advanceUntil(child, async () => (await child.getByRole('button', { name: /Simulate answers/ }).count()) > 0);
  await expect(stage(child).locator('header.top')).toContainText('Decision open');
  // Bea answers by hand from her phone; the room counts it.
  // A learner chip names them and whether they have answered (R3); it shows their phone.
  await expect(child.getByRole('group', { name: 'Phone of', exact: true })).toContainText('Bea waiting');
  await child.getByRole('button', { name: /^Bea/ }).click();
  await expect(phone(child).locator('.phone-app')).toContainText('Bea');
  // A single choice sends on the tap, as on the live phone.
  await phone(child).getByRole('radio', { name: /S00175 workshop label. Record a s/ }).check();
  await expect(child.locator('.run-preview-rail')).toContainText('1 of 4 responded');
  await expect(child.getByRole('group', { name: 'Phone of', exact: true })).toContainText('Bea answered');
  await expect(phone(child).getByRole('button', { name: 'Change decision', exact: true })).toBeVisible();
  // The rest are simulated through the room machine's own vote.
  // CASE-255: Pause for discussion is retired; the open round offers no pause.
  await expect(child.getByRole('button', { name: 'Pause for discussion', exact: true })).toHaveCount(0);
  // CASE-255: the live console's Room sound switch is not drawn here: the preview plays no sound (R7).
  await expect(child.getByRole('button', { name: 'Session sound', exact: true })).toHaveCount(0);
  await expect(child.locator('.run-preview-rail h2').first()).toHaveText('Team decision open');
  await child.getByRole('button', { name: 'Simulate answers (3 waiting)', exact: true }).click();
  await expect(child.locator('.run-preview-rail')).toContainText('4 of 4 responded');
  // R4: with everyone answered, that line is text, not a disabled button.
  await expect(child.locator('.run-preview-rail')).toContainText('Everyone has answered');
  await expect(child.getByRole('button', { name: /Simulate answers|Everyone has answered/ })).toHaveCount(0);
  await expect(stage(child).locator('header.top')).toContainText('4 of 4 answered');
  // R5a: private notes start folded to two lines; opened, they stay open while the round runs.
  const notes = child.getByRole('region', { name: 'Private notes', exact: true });
  await expect(notes.locator('.console-private')).toHaveAttribute('data-folded', 'true');
  await notes.getByRole('button', { name: 'Show all', exact: true }).click();
  await expect(notes.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute('aria-expanded', 'true');
  // Lock: the projector shows the room's results; choose and reveal a route.
  await primary(child).click();
  await expect(stage(child).locator('main')).toContainText('4 answered');
  // Q3: when route choices appear, the notes fold again so the routes and the dock stay in reach.
  await expect(child.locator('.run-preview-rail .console-routes')).toBeVisible();
  await expect(notes.getByRole('button', { name: 'Show all', exact: true })).toBeVisible();
  await child.locator('.run-preview-rail .console-routes button').first().click();
  // A click on Reveal is one press, as on the live console; only Space arms first (CASE-251, Julian 2026-10-14).
  await expect(primary(child)).toHaveText(/^Reveal:/);
  await primary(child).click();
  await expect(child.locator('select[aria-label="Jump to stage"]')).toHaveValue(/\|/);
  await expect(phone(child).locator('.phone-app')).toContainText('Timeline');
  // Undo is the room's: the reveal is taken back and the locked answers return.
  await child.locator('.run-preview-rail .console-undo').click();
  await expect(child.locator('.run-preview-rail')).toContainText('Responses locked');
  // A second click on Preview focuses the same window instead of opening another.
  await previewButton(page).click();
  await page.waitForTimeout(300);
  expect(context.pages().length).toBe(2);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, channels: window.channels })))
    .toEqual(await page.evaluate(() => ({ ...window.storageBefore, channels: [] })));
});

// Card 61 (RUNTIME-01): an ordinary question (CASE-280) has no authored route to choose. Lock → Continue, with no route
// card; Space continues on one press, like Next; Undo returns to the locked discussion.
test('[AS-160] an ordinary select-all, ranking or free-text question goes Lock → Continue in the Run preview, with no route card (card 61)', async ({ page }) => {
  const document = ordinaryQuestions(sourceFixture, ['multi_select', 'ranking', 'free_text']);
  const { writes } = await openBuilder(page, { document });
  const child = await openPreview(page), rail = child.locator('.run-preview-rail');
  for (const [index, decision] of document.decisions.entries()) {
    await advanceUntil(child, async () => (await child.getByRole('button', { name: /Simulate answers/ }).count()) > 0);
    await child.getByRole('button', { name: /Simulate answers/ }).click();
    await expect(primary(child)).toHaveText('Lock responses & review');
    await primary(child).click();
    await expect(rail.locator('h2').first()).toHaveText('Responses locked');
    const next = document.beats.find(beat => beat.id === decision.paths[0].next_beat_id);
    await expect(primary(child)).toHaveText(`Continue to ${next.title}`);
    await expect(rail.locator('.console-routes')).toHaveCount(0);
    await expect(rail).not.toContainText(/authored route|route cards|Suggested by responses/);
    if (decision.interaction.type === 'multi_select') await expect(rail.locator('.console-aggregate .console-option-list')).toBeVisible();
    if (index === 0) {
      await primary(child).click();
      await expect(rail.locator('h2').first()).toHaveText('Live surface');
      await expect(stage(child).locator('main')).toContainText(next.title);
      await rail.locator('.console-undo').click();
      await expect(rail.locator('h2').first()).toHaveText('Responses locked');
      await expect(primary(child)).toHaveText(`Continue to ${next.title}`);
      await primary(child).click();
    } else if (index === 1) {
      await primary(child).focus(); await child.keyboard.press('Space');
      await expect(primary(child)).not.toHaveText('Show to participants?');
      await expect(rail.locator('h2').first()).toHaveText('Live surface');
    } else await primary(child).click();
    await expect(rail.locator('h2').first()).toHaveText('Live surface');
  }
  await expect(stage(child).locator('main')).toContainText(document.surfaces.find(surface=>surface.id===document.beats.find(beat=>beat.kind==='debrief').surface_id).title);
  expect(writes).toEqual([]);
});

test('[AS-160] Run preview follows edits live, jumps by replay, restarts, and runs Manual without answers', async ({ page }) => {
  const { writes, submissions, start, scene } = await openBuilder(page, { findings: 4, allowDraftSaves: true });
  const child = await openPreview(page);
  const status = child.locator('.run-preview-status');
  await expect(status).toContainText('Following your edits · saved.');
  expect(writes).toEqual([]);
  // An unsaved edit rebuilds the run where it is: the projector shows the new text at once.
  await page.getByLabel('Learner scene', { exact: true }).fill('Hypotensive after induction, rebuilt live.');
  await expect(stage(child).locator('main')).toContainText('Hypotensive after induction, rebuilt live.');
  await expect(status).toContainText('· unsaved');
  await page.getByLabel('Slide title', { exact: true }).fill('Arrival, re-triaged');
  await expect(child.locator('select[aria-label="Jump to stage"]')).toContainText('Arrival, re-triaged');
  await expect(page.locator('.builder-save-state')).toHaveText('Saved');
  expect(writes).toEqual(['POST save-windows', 'PUT draft']);
  expect(submissions).toHaveLength(1);
  expect(submissions[0].document.beats.find(beat => beat.id === start.id).title).toBe('Arrival, re-triaged');
  expect(submissions[0].document.surfaces.find(surface => surface.id === start.surface_id).scene).toBe('Hypotensive after induction, rebuilt live.');
  // The explicit authoring edits are now acknowledged. Preview commands must cause no further API mutation.
  writes.length = 0;
  // Jump to a consequence: the route is replayed through the room (answers included), not teleported.
  const jump = child.locator('select[aria-label="Jump to stage"]');
  const consequence = await jump.locator('option').filter({ hasText: ' · ' }).first().getAttribute('value');
  await jump.selectOption(consequence, { force: true });
  await expect(status).toContainText('Replayed the route to');
  await expect(jump).toHaveValue(consequence);
  await expect(child.getByRole('button', { name: /^Undo/ })).not.toHaveAttribute('aria-disabled', 'true');
  // The editor's own stage is one click away; its name is the tooltip (R1c).
  const editorStage = child.getByRole('button', { name: "Go to editor's stage", exact: true });
  await expect(editorStage).toHaveAttribute('title', /Arrival, re-triaged/);
  await editorStage.click();
  await expect(editorStage).toBeHidden();
  await expect(jump).toHaveValue(/^[0-9a-f-]+$/);
  // Restart returns to the lobby with the learners in the room.
  await child.getByRole('button', { name: 'Restart preview', exact: true }).click();
  await expect(jump).toHaveValue('lobby');
  await expect(stage(child).locator('.joinpanel')).toContainText('No session code in a preview');
  // Manual: the facilitator chooses the route; there is nothing to simulate.
  await child.getByRole('group', { name: 'Session mode', exact: true }).getByRole('button', { name: 'Manual', exact: true }).click();
  await expect(child.getByRole('button', { name: 'Manual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await advanceUntil(child, async () => (await child.locator('.run-preview-rail .console-routes button').count()) > 0, 10);
  await expect(child.getByRole('button', { name: /Simulate answers/ })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(submissions).toHaveLength(1);
  expect(scene).toBeTruthy();
});

test('[AS-150] closing the window stops it; reopening shows the latest edit; leaving the Builder closes it', async ({ page }) => {
  await openBuilder(page);
  let child = await openPreview(page);
  await child.close();
  await page.getByLabel('Slide title', { exact: true }).fill('Edited while closed');
  child = await openPreview(page);
  await expect(child.locator('select[aria-label="Jump to stage"]')).toContainText('Edited while closed');
  const closed = child.waitForEvent('close');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('unsaved changes'); void dialog.accept(); });
  await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Back to Create', exact: true }).click();
  await closed;
  expect(child.isClosed()).toBe(true);
});

test('[AS-150] signing out in another tab closes the preview window without the Builder navigating', async ({ page, context }) => {
  await openBuilder(page);
  const child = await openPreview(page);
  let navigated = false; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigated = true; });
  const closed = child.waitForEvent('close');
  const other = await context.newPage();
  await other.goto(`${shell.origin}/privacy`);
  await other.evaluate(() => localStorage.removeItem('case:auth:refresh'));
  await closed;
  expect(child.isClosed()).toBe(true);
  expect(navigated, 'the account change, not a page unload, closed the child').toBe(false);
});

test('[AS-150] a blocked pop-up shows Retry and the Run preview inline while the editor stays mounted (BWR08)', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  await openBuilder(page);
  let popups = 0; page.on('popup', () => { popups++; });
  await previewButton(page).click();
  const inline = page.getByRole('region', { name: 'Private preview shown here', exact: true });
  await expect(inline).toBeVisible();
  // R10: the inline frame and the frames inside it are standards-mode pages, as every preview document is.
  await expect(page.frameLocator('.builder-inline-preview-frame').frameLocator('iframe[title="Projector"]').locator('body.projector')).toBeVisible();
  const frames = page.frames().filter(frame => frame !== page.mainFrame());
  expect(await Promise.all(frames.map(frame => frame.evaluate(() => document.compatMode)))).toEqual(frames.map(() => 'CSS1Compat'));
  await expect(page.locator('.builder-studio-status')).toContainText('The preview window was blocked');
  await expect(inline.getByRole('button', { name: 'Retry in a window', exact: true })).toBeVisible();
  const frame = page.frameLocator('.builder-inline-preview-frame');
  await expect(frame.getByRole('heading', { name: /^Preview · shown here · / })).toBeVisible();
  // The editor is still there and still edits; the inline run follows the edit.
  await expect(page.locator('.builder-workspace')).toBeVisible();
  await page.getByLabel('Slide title', { exact: true }).fill('Edited beside the inline preview');
  await expect(frame.locator('select[aria-label="Jump to stage"]')).toContainText('Edited beside the inline preview');
  await inline.getByRole('button', { name: 'Leave preview', exact: true }).click();
  await expect(inline).toBeHidden();
  expect(popups).toBe(0);
});

test('[AS-150] from /edit/preview, Retry in a window opens the Run preview window and closes the inline one', async ({ page }) => {
  await openBuilder(page);
  await page.goto(page.url().replace(/\/edit(\?.*)?$/, '/edit/preview$1'));
  const inline = page.getByRole('region', { name: 'Private preview shown here', exact: true });
  await expect(page.frameLocator('.builder-inline-preview-frame').getByRole('heading', { name: /^Preview · shown here · / })).toBeVisible();
  const [child] = await Promise.all([page.waitForEvent('popup'), inline.getByRole('button', { name: 'Retry in a window', exact: true }).click()]);
  await expect(child.getByRole('heading', { name: /^Preview · / })).toBeVisible();
  await expect(inline).toBeHidden();
  await expect(page.locator('.builder-inline-preview-frame')).toHaveCount(0);
});

test('[AS-160] the projector and a phone sit side by side above the controls; the dock stays on screen at every width (CASE-249)', async ({ page }) => {
  await openBuilder(page);
  const child = await openPreview(page);
  await expect(child.locator('.run-preview-status')).toContainText('Replayed the route');
  const box = async selector => child.locator(selector).boundingBox();
  for (const [width, height, layout] of [[1920, 1080, 'side'], [1440, 900, 'side'], [1280, 720, 'side'], [1024, 768, 'stack'], [390, 844, 'stack']]) {
    await resized(child, width, height);
    await expect(child.locator('.run-preview')).toHaveAttribute('data-layout', layout);
    // The frames are sized on the window's resize; wait until the projector has taken this width.
    await expect.poll(async () => (await box('.run-preview-rail')).y >= (await box('.run-preview-stage .run-preview-frame')).y + (await box('.run-preview-stage .run-preview-frame')).height || layout === 'stack').toBe(true);
    const stage = await box('.run-preview-stage .run-preview-frame'), rail = await box('.run-preview-rail');
    // True 16:9, no sideways scroll, the main action on screen.
    expect(Math.abs(stage.width / stage.height - 16 / 9), `${width}: 16:9`).toBeLessThan(.01);
    expect(await child.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}: sideways`).toBeLessThanOrEqual(0);
    await expect(child.locator('.run-preview-rail .console-primary')).toBeInViewport();
    expect(rail.y, `${width}: controls below the projector`).toBeGreaterThanOrEqual(stage.y + stage.height);
    if (layout === 'side') {
      await expect.poll(async () => (await box('.run-preview-phone')).x > stage.x + stage.width || (await box('.run-preview-stage .run-preview-frame')).width !== stage.width).toBe(true);
      const phone = await box('.run-preview-phone'), settled = await box('.run-preview-stage .run-preview-frame');
      expect(phone.x, `${width}: phone beside`).toBeGreaterThan(settled.x + settled.width);
      expect(Math.abs(phone.y - settled.y)).toBeLessThanOrEqual(1);
      expect(await child.locator('iframe[title="Phone"]').evaluate(frame => frame.style.transform)).toBe('scale(0.9)');
    } else {
      // Narrower, a chip shows that learner's phone in the projector's place, until closed.
      await expect(child.locator('.run-preview-phones')).toBeHidden();
      await child.getByRole('button', { name: /^Bea/ }).click();
      await expect(child.locator('.run-preview-stage')).toBeHidden();
      await expect(child.frameLocator('iframe[title="Phone"]').locator('.phone-app')).toContainText('Bea');
      await child.getByRole('button', { name: 'Back to the projector', exact: true }).click();
      await expect(child.locator('.run-preview-stage')).toBeVisible();
    }
  }
  // R1: one control row; Online/Manual and 720p/1080p are segmented; Restart keeps its plain name, apart.
  await child.setViewportSize({ width: 1280, height: 720 });
  await expect(child.getByRole('group', { name: 'Session mode', exact: true }).getByRole('button')).toHaveCount(2);
  await expect(child.getByRole('group', { name: 'Projector', exact: true }).getByRole('button')).toHaveText(['720p', '1080p']);
  await expect(child.getByRole('group', { name: 'Learners', exact: true })).toContainText('4 learners');
  await expect(child.getByRole('button', { name: 'Restart preview', exact: true })).toBeVisible();
  expect(new Set(await child.locator('.run-preview-tools > *:visible').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)))).size).toBe(1);
});

test('[AS-160] Simulate answers and the replay row sit above the dock, route rows keep a 44 px target, and the empty QR cell is a slot (CASE-251)', async ({ page }) => {
  await openBuilder(page);
  const child = await openPreview(page);
  await child.getByRole('button', { name: 'Restart preview', exact: true }).click();
  const simulate = child.getByRole('button', { name: /^Simulate answers/ }), dock = child.locator('.run-preview-dock');
  await advanceUntil(child, async () => (await simulate.count()) > 0, 12);
  // With no room there is no QR: its cell keeps the square as a dashed slot, not a blank card that reads as a missing image.
  expect(await stage(child).locator('footer .qrcell').evaluate(cell => [cell.childElementCount, getComputedStyle(cell).boxShadow, getComputedStyle(cell).outlineStyle])).toEqual([0, 'none', 'dashed']);
  // The projector has nothing to press, so it is not a Tab stop (the phone's own controls are).
  await expect(child.locator('iframe[title="Projector"]')).toHaveAttribute('tabindex', '-1');
  const sizes = [[1920, 1080], [1440, 900], [1280, 720], [1024, 768], [390, 844]];
  const above = async (locator, what) => {
    for (const [width, height] of sizes) {
      await resized(child, width, height);
      const item = await locator.boundingBox(), top = (await dock.boundingBox()).y;
      expect(item.y + item.height, `${width}: ${what} clear of the dock (${Math.round(item.y + item.height)} ≤ ${Math.round(top)})`).toBeLessThanOrEqual(top);
    }
  };
  await above(simulate, 'Simulate answers');
  await above(child.getByRole('group', { name: 'Presentation', exact: true }), 'the replay row');
  await child.setViewportSize({ width: 1440, height: 900 });
  await simulate.click(); await primary(child).click();
  const routes = child.locator('.run-preview-rail .console-route-pick');
  await expect(routes.first()).toBeVisible();
  for (const height of await routes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) expect(height, 'route row target').toBeGreaterThanOrEqual(44);
  // After the reveal (the critique's 1024 case) the replay row is still clear of the dock.
  await routes.first().click(); await primary(child).click();
  await expect(child.locator('.run-preview-phase h2')).not.toHaveText('Responses locked');
  await above(child.getByRole('group', { name: 'Presentation', exact: true }), 'the replay row after a reveal');
});
