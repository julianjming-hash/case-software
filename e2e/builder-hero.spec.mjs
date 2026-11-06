// D23 hero slides (CASE-264, AS-165). A slide whose whole content is a title and one small card shows the card large:
// every row under the title, centred across, text grown to 1.5×. The Builder's canvas, its fit check, the Run preview
// and the room's own projector draw it the same: the same fit, and the same box as a share of the slide, within 1 px.
// The author's Centred choice and the off switch redraw the canvas, and a block added beside it ends the hero.
import { test, expect } from '@playwright/test';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { displayPairUrl } from '../src/shared/urls.mjs';
import sourceFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { facilitatorCommand } from '../tests/helpers/local-worker.mjs';

test.use({ ignoreHTTPSErrors: true });
const must = result => { if (!result.ok) throw new Error(result.reason); return result.document; };

/** The fixture's opening slide becomes its heading over one small soft card, placed in six columns and three rows. */
function heroCase() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(sourceFixture), { metadata_version: 1 }).candidate;
  for (const surface of converted.surfaces) delete surface.variants;
  let document = convertToSlideDocument(converted, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const opening = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
  const heading = opening.reading_order[0];
  for (const id of opening.reading_order.slice(1)) document = must(edit.removeBlock(document, opening.id, id));
  const card = { id: uuidv7(), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'Referral question', bold: true }] }, { style: 'p', runs: [{ text: 'Possible decompression sickness' }] }] };
  const slide = document.compositions.find(item => item.id === opening.id);
  document.blocks.push(card); slide.reading_order.push(card.id); slide.steps[0].block_ids.push(card.id);
  slide.placements = [{ ...slide.placements.find(item => item.block_id === heading), col: 1, row: 1, w: 12, h: 2 }, { block_id: card.id, col: 1, row: 3, w: 6, h: 3 }];
  slide.styles = [{ block_id: card.id, tone: 'soft' }];
  const checked = validateBuilderDocument(document, { metadata_version: 1 }, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors.slice(0, 3)));
  return { document, cardId: card.id, compositionId: slide.id };
}

let auth, worker, shell, heroSlide;
test.beforeAll(async () => {
  heroSlide = heroCase();
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: heroSlide.document });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

/** In one document: the hero block's fit, type size and box as fractions of the slide's width (so sizes compare). */
const heroDraw = () => {
  // The Builder page also draws Outline thumbnails; its editor canvas is the one in the slide editor.
  const canvas = document.querySelector('.builder-slide .slide-canvas') ?? document.querySelector('.slide-canvas'), block = canvas?.querySelector(':scope > .slide-hero');
  if (!block) return null;
  const c = canvas.getBoundingClientRect(), b = block.getBoundingClientRect(), first = block.querySelector('p, h2, h3, h4, h5');
  const share = value => value / c.width;
  return { width: c.width, fit: Math.round((parseFloat(block.style.getPropertyValue('--fit')) || 1) * 100) / 100, classes: block.className,
    size: share(parseFloat(getComputedStyle(first).fontSize)), box: [b.x - c.x, b.y - c.y, b.width, b.height].map(share) };
};
const heroIn = owner => Promise.all(owner.frames().filter(frame => frame !== owner.mainFrame()).map(frame => frame.evaluate(heroDraw)))
  .then(list => list.find(Boolean) ?? null);

/** Same fit, and the same type size and box as a share of the slide, to within 1 px at the larger slide's width. */
function agree(label, a, b) {
  const px = Math.max(a.width, b.width);
  expect(a.fit, `${label}: fit`).toBe(b.fit);
  expect(Math.abs(a.size - b.size) * px, `${label}: type size`).toBeLessThanOrEqual(1);
  a.box.forEach((value, index) => expect(Math.abs(value - b.box[index]) * px, `${label}: box ${'xywh'[index]}`).toBeLessThanOrEqual(1));
}

test('[AS-165] a title and one card show the card large, the same in the canvas, fit check, Run preview and the room', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  let current = structuredClone(heroSlide.document), revision = 1;
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const request = route.request(), suffix = new URL(request.url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (suffix === 'draft' && request.method() === 'GET') return reply({ case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', title: 'Hero case', sourceVersion: null, capabilities: ['slide_composition'] },
      revision, draft: { revision, document: current, authoringMetadata: { metadata_version: 1 }, intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'save-windows') return reply({ operationId: uuidv7(), baseRevision: revision });
    if (suffix === 'draft' && request.method() === 'PUT') { const body = request.postDataJSON(); current = body.document; revision++; return reply({ operationId: body.operationId, revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' }); }
    if (suffix === 'checkpoints') return reply({ checkpoints: [] });
    return reply({ error: 'not_found' }, 404);
  });
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();

  // The fit check and the Builder's own canvas.
  await expect(page.locator('.builder-fit-status')).toContainText('1280 × 720');
  await expect.poll(async () => (await heroIn(page))?.fit ?? null).toBe(1.5);
  const fitCheck = await heroIn(page);
  const canvasCard = page.locator(`.builder-slide .slide-canvas > .slide-block[data-block-id="${heroSlide.cardId}"]`);
  await expect(canvasCard).toHaveClass(/slide-hero slide-hero-top/);
  await expect.poll(async () => page.evaluate(heroDraw).then(item => item?.fit ?? null)).toBe(1.5);
  const canvas = await page.evaluate(heroDraw);
  // A hero block has no grips: it is placed by the rule, and its stored placement waits for a second block.
  await expect(canvasCard.locator('.builder-block-handle, .builder-block-resize')).toHaveCount(0);

  // The Run preview's projector frame.
  const [child] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  await expect(child.frameLocator('iframe[title="Projector"]').locator('.slide-canvas > .slide-hero')).toBeVisible();
  await child.waitForTimeout(300);
  const preview = await heroIn(child);
  await child.close();

  // The room's own projector, through the public projection (no steps reach it, only the released hero).
  const started = await fetch(`${worker.origin}/api/v1/sessions`, { method: 'POST', headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(started.status).toBe(201);
  const room = await started.json();
  const displayContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } }), display = await displayContext.newPage();
  await display.goto(displayPairUrl('00000000', shell.origin));
  await expect(display.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  const code = (await display.locator('.pair-code').textContent()).replace(/\s/g, '');
  expect((await fetch(`${worker.origin}/api/v1/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST',
    headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).ok).toBe(true);
  await expect(display).toHaveURL(new RegExp(`/sessions/${room.sessionId}/display`), { timeout: 15_000 });
  expect((await facilitatorCommand(worker.origin, room, 'start')).receipt).toBe('accepted');
  await expect(display.locator('main.slide-band .slide-canvas > .slide-hero')).toBeVisible();
  await display.waitForTimeout(300);
  const projector = await display.evaluate(heroDraw);
  await displayContext.close();

  console.log('D23 hero', JSON.stringify({ canvas, fitCheck, preview, projector }));
  expect(projector.fit).toBe(1.5);
  // Centred across the slide, starting under the title (the card was placed in six columns from the left).
  expect(projector.box[0] + projector.box[2] / 2).toBeCloseTo(.5, 2);
  agree('fit check', fitCheck, projector);
  agree('Preview', preview, projector);
  agree('Builder canvas', canvas, projector);

  // Centred: the card moves to the middle of the space under the title; turned off, it is drawn where it was placed.
  // Selecting the hero card moves and resizes nothing (CASE-249): selected blocks elsewhere stretch over their area.
  const resting = await canvasCard.boundingBox();
  await canvasCard.click({ position: { x: 4, y: 4 } });
  await expect(canvasCard).toHaveAttribute('data-selected', 'true');
  await page.waitForTimeout(500);
  const selected = await canvasCard.boundingBox();
  for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(selected[key] - resting[key]), `selected hero ${key}`).toBeLessThanOrEqual(1);
  await page.getByRole('complementary', { name: 'Inspector', exact: true }).getByRole('button', { name: '← This slide', exact: true }).click();
  await page.getByRole('complementary', { name: 'Inspector', exact: true }).getByText('Layout and fill', { exact: false }).click();
  const before = await canvasCard.boundingBox();
  await page.getByRole('button', { name: 'Centred', exact: true }).click();
  await expect(canvasCard).toHaveClass(/slide-hero-centred/);
  expect((await canvasCard.boundingBox()).y).toBeGreaterThan(before.y + 10);
  await page.getByRole('checkbox', { name: 'Enlarge the only block', exact: true }).uncheck();
  await expect(canvasCard).not.toHaveClass(/slide-hero/);
  await expect.poll(async () => page.evaluate(id => document.querySelector(`.builder-slide .slide-canvas > [data-block-id="${id}"]`)?.style.gridArea, heroSlide.cardId))
    .toBe('3 / 1 / span 3 / span 6');
});
