// Facilitator-UX A6 (AS-213, CASE-342; plan §3 A6; ruling R8: a new spec, the Builder track's e2e/builder-media.spec.mjs is not edited): a case-only
// editor adds an image through the one upload dialog. The file, what it shows, an optional credit, and the warning with its confirmation tick;
// the image is usable at once; every request goes to the case's place; no approval word appears anywhere; a refusal names its field and
// its limit, and a full workspace names the bytes used and allowed; Replace image asks for the new description. The real local Worker
// serves the shell; the case routes are fulfilled in the browser (the Worker side is proved in tests/access-storage.test.mjs and
// tests/access-share.test.mjs). Screenshots go to ACCESS_SHOTS_DIR when it is set.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectJpeg, MEDIA_LIMITS } from '../src/shared/media.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { divingSlides, slide } from '../tests/design-critique/harness.mjs';

const SHOTS = process.env.ACCESS_SHOTS_DIR || null;
const FIXTURE = join(fileURLToPath(new URL('..', import.meta.url)), 'tests/fixtures/media/clean-300x200.jpg');
const POLICIES = { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true };
let auth, worker, shell, CASE, WS;
test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null, email: 'editor@example.invalid' });
  worker = await startPublishedWorker({ authOrigin: auth.origin, email: 'editor@example.invalid' });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  CASE = worker.caseId; WS = worker.workspaceId;
  // A case-only editor: a Can edit grant on this case and no membership.
  worker.fake.replies.set('get_me', args => [{ user_id: args.p_user_id, display_name: 'Editor', facilitator_role: 'Intensivist', label_confirmed_at: new Date().toISOString(), next_after: null, admin: false, memberships: [],
    grants: [{ case_id: CASE, workspace_id: WS, workspace_name: 'Northern ICU', title: 'Published case', level: 'edit', policies: POLICIES }] }]);
  worker.fake.replies.set('get_access', args => args.p_case_id === CASE ? [{ case_id: CASE, workspace_id: WS, member_role: null, grant_level: 'edit', role: 'author', scope: 'case', policies: POLICIES }] : []);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
/** The Builder's case routes, fulfilled in the browser: the draft, and the case place's media and assets. `faults` makes one route refuse. */
async function openBuilder(page, faults = {}) {
  const pair = await divingSlides();
  const seen = { puts: [], posts: [], gets: [], workspacePaths: [] }, stored = new Map(), assets = new Map(), windows = new Map();
  let revision = 1;
  await page.route(url => url.pathname.startsWith('/api/v1/builder/'), async route => {
    const request = route.request(), method = request.method(), path = new URL(request.url()).pathname;
    if (path.includes('/workspaces/')) { seen.workspacePaths.push(path); return reply(route, { error: 'not_found' }, 404); }
    const suffix = path.split(`/cases/${CASE}/`)[1] ?? '';
    if (suffix === 'draft' && method === 'GET') return reply(route, { case: { caseId: CASE, workspaceId: WS, role: 'author', publishes: false, title: pair.document.title, sourceVersion: null, capabilities: ['slide_composition'] },
      revision, draft: { revision, ...structuredClone(pair), intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'save-windows' && method === 'POST') { const id = uuidv7(); windows.set(id, revision); return reply(route, { operationId: id, baseRevision: revision }); }
    if (suffix === 'checkpoints') return reply(route, { checkpoints: [] });
    if (method === 'PUT' && /^media\/(display|phone|poster)$/.test(suffix)) {
      if (faults.put) return reply(route, faults.put.body, faults.put.status);
      const bytes = new Uint8Array(request.postDataBuffer()), shape = inspectJpeg(bytes);
      seen.puts.push({ path: suffix, ok: shape.ok, auth: request.headers().authorization });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      stored.set(sha256, { bytes, ...shape });
      return reply(route, { sha256, bytes: bytes.length, width: shape.width, height: shape.height, type: 'image/jpeg' }, 201);
    }
    if (method === 'POST' && suffix === 'assets') {
      const body = request.postDataJSON(); seen.posts.push(body);
      if (faults.post) return reply(route, faults.post.body, faults.post.status);
      const display = stored.get(body.display.sha256);
      const row = { asset_id: uuidv7(), status: 'quarantined', evidence_kind: body.details.evidenceKind ?? null, alt_text: body.details.alt, width: display.width, height: display.height, media_type: 'image/jpeg',
        attribution: body.details.credit || null, attested: body.details.attested, renditions: {}, display: body.display.sha256 };
      assets.set(row.asset_id, row);
      return reply(route, { asset: row, warnings: [] }, 201);
    }
    if (method === 'GET' && suffix === 'assets') return reply(route, { assets: [...assets.values()] });
    const rendition = /^assets\/([0-9a-f-]{36})\/(display|phone|poster)$/.exec(suffix);
    if (method === 'GET' && rendition) {
      seen.gets.push(suffix); const row = assets.get(rendition[1]), object = row && stored.get(row.display);
      return object ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(object.bytes) }) : reply(route, { error: 'not_found' }, 404);
    }
    return reply(route, { error: 'not_found' }, 404);
  });
  await page.goto(`${shell.origin}/cases/${CASE}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('editor@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  await expect(slide(page)).toBeVisible();
  return seen;
}
/** Add an image block: the same two clicks in either Builder layout (a Block tab with "Image or ECG", or the Add block group with "Image"). */
async function openDialog(page) {
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  const group = tools.getByRole('group', { name: 'Add block', exact: true });
  if (!(await group.count())) await tools.getByRole('button', { name: 'Block', exact: true }).click();
  await group.getByRole('button', { name: /^Image( or ECG)?$/ }).click();
  return page.getByRole('dialog', { name: 'Image or ECG' });
}
async function settle(page) { await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0); }
async function axe(page) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await settle(page);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await settle(page); await page.screenshot({ path: join(SHOTS, `access-${name}-${scheme}.png`) }); }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('[AS-213] one dialog: the file, what it shows, an optional credit and the warning with its tick; the image is usable at once, in the case\'s place, with no approval anywhere', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const seen = await openBuilder(page);
  const dialog = await openDialog(page);
  await expect(dialog.getByText('No images yet. Upload one.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Upload new' }).click();
  await dialog.locator('input[type=file]').setInputFiles(FIXTURE);
  const add = dialog.getByRole('button', { name: 'Add image' });
  await expect(add).toBeVisible();
  // The warning is shown, in plain words, with the confirmation tick; there are no rights fields or approval states.
  await expect(dialog.getByText(/shows nothing that identifies a patient/)).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'I confirm this image is de-identified and I may use it.' })).not.toBeChecked();
  await expect(dialog.getByLabel('Credit (optional)')).toBeVisible();
  await expect(dialog.getByLabel('Source and licence')).toHaveCount(0);
  await expect(dialog.getByText('Image details (optional)')).toHaveCount(0);
  expect(await dialog.innerText()).not.toMatch(/approv|awaiting|administrator/i);
  await axe(page);
  await shoot(page, 'upload');
  // Nothing is sent until it is described and confirmed, and the refusal names the field.
  await add.click();
  await expect(dialog.getByRole('status')).toHaveText(`Say what the image shows (up to ${MEDIA_LIMITS.altText} characters).`);
  await dialog.getByLabel(/What it shows/).fill('Chest X-ray, PA');
  await add.click();
  await expect(dialog.getByRole('status')).toHaveText('Tick the box to confirm the image is de-identified and that you may use it.');
  expect(seen.posts).toHaveLength(0);
  await dialog.getByLabel('Credit (optional)').fill('Dr A. Kaur');
  await dialog.getByRole('checkbox').check();
  await add.click();
  await expect(dialog).toHaveCount(0);
  expect(seen.posts).toHaveLength(1);
  expect(seen.posts[0].details).toEqual({ alt: 'Chest X-ray, PA', evidenceKind: 'photo', credit: 'Dr A. Kaur', attested: true });
  expect(seen.puts.map(put => put.path)).toEqual(['media/display', 'media/phone']);
  expect(seen.puts.every(put => put.ok && /^Bearer /.test(put.auth))).toBe(true);
  expect(seen.workspacePaths, 'a case-only editor never touches the workspace place').toEqual([]);
  // Usable at once: it is drawn from a blob handle. (The Inspector's own image text belongs to the Builder PR, which drops its status wording.)
  await expect(slide(page).locator('.slide-block.slide-image img.slide-picture')).toHaveAttribute('src', /^blob:/);
  // The same file again is the same image: the dialog lists it for this case.
  const again = await openDialog(page);
  await expect(again.getByRole('button', { name: 'Use Chest X-ray, PA' })).toBeVisible();
  expect(await again.innerText()).not.toMatch(/approv|awaiting|administrator/i);
});

test('[AS-213] a refused field is named with its limit, and a full workspace says how much is used and allowed', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const faults = {};
  const seen = await openBuilder(page, faults);
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Upload new' }).click();
  await dialog.locator('input[type=file]').setInputFiles(FIXTURE);
  await dialog.getByLabel(/What it shows/).fill('Chest X-ray, PA');
  await dialog.getByRole('checkbox').check();
  const add = dialog.getByRole('button', { name: 'Add image' }), status = dialog.getByRole('status');
  faults.post = { status: 422, body: { error: 'invalid_details:credit' } };
  await add.click();
  await expect(status).toHaveText(`The credit can be at most ${MEDIA_LIMITS.attribution} characters.`);
  await expect(add).toBeEnabled();
  faults.post = { status: 422, body: { error: 'invalid_details:attested' } };
  await add.click();
  await expect(status).toHaveText('Tick the box to confirm the image is de-identified and that you may use it.');
  delete faults.post;
  faults.put = { status: 507, body: { error: 'storage_full', usedBytes: 1_900_000_000, quotaBytes: 2_000_000_000 } };
  await add.click();
  await expect(status).toHaveText('This workspace’s image storage is full: 1.9 GB used of 2.0 GB allowed. Ask an administrator to free space or raise the limit.');
  faults.put = { status: 429, body: { error: 'media_limit' } };
  await add.click();
  await expect(status).toHaveText('Too many uploads this hour (60 an hour). Try again later.');
  expect(seen.posts).toHaveLength(2);
  await shoot(page, 'upload-refused');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test('[AS-213] Replace image asks for the new description and the confirmation again', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const seen = await openBuilder(page);
  const first = await openDialog(page);
  await first.getByRole('button', { name: 'Upload new' }).click();
  await first.locator('input[type=file]').setInputFiles(FIXTURE);
  await first.getByLabel(/What it shows/).fill('Chest X-ray, PA');
  await first.getByRole('checkbox').check();
  await first.getByRole('button', { name: 'Add image' }).click();
  await expect(first).toHaveCount(0);
  const picture = slide(page).locator('.slide-block.slide-image').first();
  await picture.click();
  await page.getByRole('complementary', { name: 'Inspector', exact: true }).getByRole('button', { name: 'Replace image' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace image' });
  await dialog.getByRole('button', { name: 'Upload new' }).click();
  await dialog.locator('input[type=file]').setInputFiles(FIXTURE);
  await expect(dialog.getByText('Replacing an image: describe the new one. The old description is not kept.')).toBeVisible();
  await expect(dialog.getByLabel(/What it shows/)).toHaveValue('');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Add image' }).click();
  await expect(dialog.getByRole('status')).toHaveText(`Say what the image shows (up to ${MEDIA_LIMITS.altText} characters).`);
  expect(seen.posts).toHaveLength(1);
});
