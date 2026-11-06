// CASE-249, R10 and Julian's Q4 (a). Every preview document (the Run preview window, its projector and phone frames and
// the Builder's fit-check frames) is a standards-mode page before anything is drawn, written by the Builder's one
// `case-default` Trusted Types policy: no window or frame creates a policy of its own. In quirks mode a table took the
// frame's 16 px and ignored its block's fit, so the fit check and the preview passed a table slide the room shrinks
// further. Here one 4 × 4 table slide measures the same fit in the fit check, the Run preview and the room's projector.
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

/** The fixture's opening slide becomes its heading over a dense 4 × 4 table, which has to shrink to fit at 720p. */
function tableCase() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(sourceFixture), { metadata_version: 1 }).candidate;
  for (const surface of converted.surfaces) delete surface.variants;
  let document = convertToSlideDocument(converted, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const opening = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
  const heading = opening.reading_order[0];
  for (const id of opening.reading_order.slice(1)) document = must(edit.removeBlock(document, opening.id, id));
  const columns = ['Time', 'Finding', 'Value', 'Response'].map(label => ({ id: uuidv7(), label, width: 1, align: 'start' }));
  const rows = [0, 5, 10, 15].map(minute => ({ id: uuidv7(), cells: [`00:${String(minute).padStart(2, '0')}`, 'Heart rate and rhythm on the monitor', `${110 + minute} beats a minute`, 'Fluids running, reassessed by the team'] }));
  const table = { id: uuidv7(), type: 'table', caption: 'Observations on arrival', header_row: true, first_column_header: false, columns, rows };
  const slide = document.compositions.find(item => item.id === opening.id);
  document.blocks.push(table); slide.reading_order.push(table.id); slide.steps[0].block_ids.push(table.id);
  slide.placements = [{ ...slide.placements.find(item => item.block_id === heading), col: 1, row: 1, w: 12, h: 2 }, { block_id: table.id, col: 1, row: 3, w: 8, h: 6 }];
  const checked = validateBuilderDocument(document, { metadata_version: 1 }, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors.slice(0, 3)));
  return { document, tableId: table.id };
}

let auth, worker, shell, slideCase;
test.beforeAll(async () => {
  slideCase = tableCase();
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: slideCase.document });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

/** In one document: its mode, and the slide's size, the table block's fit and first cell's type size when it draws the slide. */
const tableFit = () => {
  const block = document.querySelector('.slide-canvas > .slide-block.slide-table');
  const canvas = document.querySelector('.slide-canvas')?.getBoundingClientRect();
  return { canvas: canvas && [Math.round(canvas.width), Math.round(canvas.height)], viewport: [innerWidth, innerHeight], mode: document.compatMode, fit: block ? Math.round((parseFloat(block.style.getPropertyValue('--fit')) || 1) * 100) / 100 : null, cell: block?.querySelector('td') ? getComputedStyle(block.querySelector('td')).fontSize : null };
};
const measureFrames = owner => Promise.all(owner.frames().filter(frame => frame !== owner.mainFrame()).map(frame => frame.evaluate(tableFit)));

test('[AS-160] every preview document is standards mode, written by the one Builder policy, and a table fits as the room fits it', async ({ page, context, browser }) => {
  // Count Trusted Types policies in every realm this context creates: windows, popups and frames.
  await context.addInitScript(() => { const native = globalThis.trustedTypes?.createPolicy?.bind(globalThis.trustedTypes); globalThis.__policies = [];
    if (native) globalThis.trustedTypes.createPolicy = (name, rules) => { globalThis.__policies.push(name); return native(name, rules); }; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const suffix = new URL(route.request().url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (route.request().method() !== 'GET') return reply({ error: 'forbidden_in_test' }, 403);
    if (suffix === 'draft') return reply({ case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', title: 'Table case', sourceVersion: null, capabilities: ['slide_composition'] },
      revision: 1, draft: { revision: 1, document: slideCase.document, authoringMetadata: { metadata_version: 1 }, intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'checkpoints') return reply({ checkpoints: [] });
    return reply({ error: 'not_found' }, 404);
  });
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();

  // The Builder's fit check: its frames are standards mode, and the opening slide's table settles at its fit.
  await expect(page.locator('.builder-fit-status')).toContainText('1280 × 720');
  await expect.poll(async () => (await measureFrames(page)).find(item => item.fit !== null)?.fit ?? null).not.toBeNull();
  const checks = await measureFrames(page), fitCheck = checks.find(item => item.fit !== null);
  expect(checks.map(item => item.mode)).toEqual(checks.map(() => 'CSS1Compat'));

  // The Run preview window and its two frames.
  const [child] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  await expect(child.getByRole('heading', { name: /^Preview · / })).toBeVisible();
  await expect(child.frameLocator('iframe[title="Projector"]').locator('.slide-canvas .slide-table')).toBeVisible();
  await child.waitForTimeout(300);
  const frames = await measureFrames(child), preview = frames.find(item => item.fit !== null);
  expect([await child.evaluate(() => document.compatMode), ...frames.map(item => item.mode)]).toEqual(['CSS1Compat', 'CSS1Compat', 'CSS1Compat']);
  // Q4 (a): the popup enforces Trusted Types (a plain HTML string is refused there), yet it is in standards mode with no
  // policy of its own: its doctype page was written with a TrustedHTML made by the Builder realm's one policy.
  expect(await child.evaluate(() => { try { document.body.insertAdjacentHTML('beforeend', '<i></i>'); return 'accepted'; } catch (error) { return error.name; } })).toBe('TypeError');
  expect(await page.evaluate(() => globalThis.__policies)).toEqual(['case-default']);
  // Known answer: each child realm can still create `case-default` once, so none had made one (the CSP allows one per realm).
  for (const realm of child.frames()) expect(await realm.evaluate(() => { try { trustedTypes.createPolicy('case-default', {}); return 'none before'; } catch { return 'already made'; } }), realm.url()).toBe('none before');
  expect(child.frames().length).toBe(3);

  // The room's own projector page, paired through the real display flow, at the same 720p target.
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
  await expect(display.locator('main.slide-band .slide-canvas .slide-table')).toBeVisible();
  await display.waitForTimeout(300);
  const projector = await display.evaluate(tableFit);
  await displayContext.close();

  console.log('R10 fits', JSON.stringify({ fitCheck, preview, projector }));
  // One fit everywhere, and the fit is a real shrink (the quirks frames left it at 0.75 against the room's 0.55).
  expect(projector.mode).toBe('CSS1Compat');
  expect(projector.fit).toBeLessThan(1);
  // The same slide, at the same size (the room's footer height with its join QR), and so the same fit and type.
  const same = ({ canvas, fit, cell }) => ({ canvas, fit, cell });
  expect({ fitCheck: same(fitCheck), preview: same(preview) }).toEqual({ fitCheck: same(projector), preview: same(projector) });
});
