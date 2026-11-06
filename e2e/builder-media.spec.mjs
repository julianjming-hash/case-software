// Card 59 M2 (CASE-268): an author uploads an ECG, an animated GIF and a video through the Builder's Image or ECG
// dialog. The browser crops, covers and re-encodes a still, and cleans a GIF or video in place; the fake media routes
// below apply the Worker's own structural check for each type to the exact bytes the browser sent, so a metadata
// segment, a location box or a stray byte fails this test. The covered strip is burned into the stored pixels.
import { chooseOption } from '../tests/helpers/choose-option.mjs';
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectJpeg } from '../src/shared/media.mjs';
import { inspectGif } from '../src/shared/media-gif.mjs';
import { inspectMp4 } from '../src/shared/media-mp4.mjs';
import { gifFixture, mp4Fixture, FIXTURE_LOCATION } from '../tests/helpers/media-fixtures.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { isDeepStrictEqual } from 'node:util';
import { imageWarnings, imageReviewState } from '../src/shared/image-review.mjs';
import { start, stop, env, divingSlides, openBuilder, slide } from '../tests/design-critique/harness.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start);
test.afterAll(stop);
const FIXTURE = join(fileURLToPath(new URL('..', import.meta.url)), 'tests/fixtures/media/clean-300x200.jpg');

async function fakeMedia(page) {
  const stored = new Map(), assets = new Map(), puts = [], gets = [], reviews = [];
  await page.route(url => /^\/api\/v1\/builder\/(?:workspaces|cases)\/[^/]+\/(?:media\/|assets)/.test(url.pathname), async route => {
    const request = route.request(), path = new URL(request.url()).pathname.split('/').slice(6).join('/'), method = request.method();
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (method === 'PUT' && /^media\/(display|phone|poster)$/.test(path)) {
      const type = request.headers()['content-type'], bytes = new Uint8Array(request.postDataBuffer());
      const shape = ({ 'image/jpeg': inspectJpeg, 'image/gif': inspectGif, 'video/mp4': inspectMp4 }[type] ?? (() => ({ ok: false, reason: 'type' })))(bytes);
      puts.push({ path, shape, type, bytes, auth: request.headers().authorization });
      if (!shape.ok) return reply({ error: `invalid_image:${shape.reason}` }, 422);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      stored.set(sha256, { bytes, type, ...shape });
      return reply({ sha256, bytes: bytes.length, width: shape.width, height: shape.height, type }, 201);
    }
    if (method === 'POST' && path === 'assets') {
      const body = request.postDataJSON(), display = stored.get(body.display.sha256);
      const existing = [...assets.values()].find(row => row.display === body.display.sha256);
      if (existing) return reply({ asset: { ...existing, created: false } });
      const row = { asset_id: uuidv7(), status: 'quarantined', evidence_kind: body.details.evidenceKind, alt_text: body.details.alt, width: display.width, height: display.height,
        media_type: display.type, licence: body.details.source === 'unknown' ? 'unknown' : 'own-work', rights_basis: body.details.source === 'unknown' ? 'unlicensed' : 'own_work', attribution: body.details.attribution || null, attested: body.details.attested, created: true,
        renditions: Object.fromEntries(['display', 'phone', 'poster'].filter(name => body[name]).map(name => [name, { sha256: body[name].sha256 }])), display: body.display.sha256, poster: body.poster?.sha256, details: body.details };
      assets.set(row.asset_id, row);
      return reply({ asset: row }, 201);
    }
    if (method === 'GET' && path === 'assets') return reply({ assets: [...assets.values()] });
    const attestation = /^assets\/([0-9a-f-]{36})\/attestation$/.exec(path);
    if (method === 'POST' && attestation) {
      const row = assets.get(attestation[1]), body = request.postDataJSON();
      if (!row || row.status !== 'quarantined' || (row.attested !== body.expected && row.attested !== body.attested)) return reply({ error: 'asset_details_changed' }, 409);
      row.attested = body.attested; return reply({ asset: row });
    }
    // Card 62: the server's fence. An approval must name the stored state and acknowledge exactly its open warnings.
    const review = /^assets\/([0-9a-f-]{36})\/review$/.exec(path);
    if (method === 'POST' && review) {
      const row = assets.get(review[1]), body = request.postDataJSON(); reviews.push(body);
      const fenced = body.decision === 'reject' || (isDeepStrictEqual(body.expected, imageReviewState(row)) && isDeepStrictEqual(body.acknowledged, imageWarnings(row).map(item => item.code)));
      if (!row || row.status !== 'quarantined' || !fenced) return reply({ error: 'asset_details_changed' }, 409);
      row.status = body.decision === 'approve' ? 'approved' : 'rejected'; return reply({ asset: row });
    }
    const rendition = /^assets\/([0-9a-f-]{36})\/(display|phone|poster)$/.exec(path);
    if (method === 'GET' && rendition) {
      gets.push(rendition[2]);
      const row = assets.get(rendition[1]), object = row && stored.get(rendition[2] === 'poster' ? row.poster : row.display);
      return object ? route.fulfill({ status: 200, contentType: object.type, body: Buffer.from(object.bytes) }) : reply({ error: 'not_found' }, 404);
    }
    return reply({ error: 'not_found' }, 404);
  });
  return { stored, assets, puts, gets, reviews };
}

test('[AS-167] an author uploads an ECG: cleaned, covered, re-encoded in the browser, then drawn with its calibration', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fake = await fakeMedia(page);
  await openBuilder(page, await divingSlides());
  await expect(slide(page)).toBeVisible();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Image or ECG' });
  await expect(dialog.getByText('No images yet. Upload one.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Upload new' }).click();
  await dialog.locator('input[type=file]').setInputFiles(FIXTURE);
  await dialog.getByText('Crop and cover', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Cover top strip (10%)' }).click();
  await dialog.getByLabel(/What it shows/).fill('12-lead ECG on arrival');
  await chooseOption(dialog.getByRole('combobox', { name: 'Kind', exact: true }), 'ECG');
  await expect(dialog.getByText(/^Before you add it:/)).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add image' }).click();
  await expect(dialog).toHaveCount(0);
  // Both renditions passed the Worker's structural check exactly as sent, with the token in the header only.
  expect(fake.puts.map(put => [put.path, put.shape.ok, put.type])).toEqual([['media/display', true, 'image/jpeg'], ['media/phone', true, 'image/jpeg']]);
  expect(fake.puts.every(put => /^Bearer /.test(put.auth))).toBe(true);
  // The block draws the stored image from a browser-local handle, with its alt text and the ECG's calibration line.
  const figure = slide(page).locator('.slide-block.slide-image figure');
  const picture = figure.locator('img.slide-picture');
  await expect(picture).toHaveAttribute('src', /^blob:/);
  await expect(picture).toHaveAttribute('alt', '12-lead ECG on arrival');
  await expect(figure.locator('.slide-figure-calibration')).toHaveText('12-lead · 25 mm/s · 10 mm/mV');
  // No approval or status line: image approval is gone (CASE-342), so the panel says nothing about it.
  await expect(tools.getByText(/approval|Approved|Awaiting/i)).toHaveCount(0);
  // The covered top strip is black in the stored pixels; the rest of the trace is not.
  const [top, middle] = await picture.evaluate(async node => {
    await node.decode(); const canvas = new OffscreenCanvas(node.naturalWidth, node.naturalHeight), g = canvas.getContext('2d'); g.drawImage(node, 0, 0);
    const at = y => [...g.getImageData(Math.floor(node.naturalWidth / 2), y, 1, 1).data].slice(0, 3).reduce((a, b) => a + b);
    return [at(2), at(Math.floor(node.naturalHeight / 2))];
  });
  expect(top).toBeLessThan(40);
  expect(middle).toBeGreaterThan(200);
  // The ECG is always shown whole; the Block tab offers calibration, not Fill.
  await expect(tools.getByRole('group', { name: 'Fit' })).toHaveCount(0);
  await tools.getByRole('group', { name: 'Paper speed' }).getByRole('button', { name: '50 mm/s' }).click();
  await expect(figure.locator('.slide-figure-calibration')).toHaveText('12-lead · 50 mm/s · 10 mm/mV');
});

async function openUpload(page, options = {}) {
  const fake = await fakeMedia(page);
  await openBuilder(page, await divingSlides(), options);
  await expect(slide(page)).toBeVisible();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Image or ECG' });
  await dialog.getByRole('button', { name: 'Upload new' }).click();
  return { fake, dialog, tools };
}

test('[AS-167] an animated GIF keeps its frames, loses its comment and XMP, and gets a poster; confirmation is required before upload', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fake, dialog, tools } = await openUpload(page);
  await dialog.locator('input[type=file]').setInputFiles({ name: 'loop.gif', mimeType: 'image/gif', buffer: Buffer.from(gifFixture({ comment: 'Patient J Smith', xmp: 'MRN 1234567' })) });
  await expect(dialog.getByRole('img', { name: 'Animated GIF being prepared' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cover top strip (10%)' })).toHaveCount(0);
  await dialog.getByLabel(/What it shows/).fill('Bounding pulse on palpation');
  await dialog.getByRole('button', { name: 'Add image' }).click();
  await expect(dialog.getByRole('status')).toContainText('Tick the box');
  expect(fake.puts).toHaveLength(0);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add image' }).click();
  await expect(dialog).toHaveCount(0);
  expect(fake.puts.map(put => [put.path, put.type, put.shape.ok])).toEqual([['media/display', 'image/gif', true], ['media/poster', 'image/jpeg', true]]);
  const gif = fake.puts[0].bytes;
  expect(fake.puts[0].shape.frames).toBe(2);
  expect(Buffer.from(gif).includes('Smith') || Buffer.from(gif).includes('MRN')).toBe(false);
  const [row] = fake.assets.values();
  expect([row.details.attested, row.media_type]).toEqual([true, 'image/gif']);
  // The block animates the stored GIF itself (its display file, not the poster).
  const picture = slide(page).locator('.slide-block.slide-image img.slide-picture');
  await expect(picture).toHaveAttribute('src', /^blob:/);
  expect(fake.gets).toContain('display'); expect(fake.gets).not.toContain('poster');
  expect(await picture.evaluate(node => node.decode().then(() => [node.naturalWidth, node.naturalHeight]))).toEqual([32, 24]);
  await expect(tools.getByRole('heading', { name: 'Animated GIF' })).toBeVisible();
});

test('[AS-167] a phone video is cleaned in the browser before upload: location and metadata track gone, poster stored, canvas shows the poster', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fake, dialog } = await openUpload(page);
  const original = mp4Fixture({ udta: true, moovMeta: true, metaTrack: true, times: true, hidden: true });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'IMG_0042.MOV', mimeType: 'video/quicktime', buffer: Buffer.from(original) });
  await expect(dialog.getByText(/Location, device and time data have been removed/)).toBeVisible();
  await dialog.getByLabel(/What it shows/).fill('Echo, parasternal long axis');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add image' }).click();
  await expect(dialog).toHaveCount(0);
  expect(fake.puts.map(put => [put.path, put.type, put.shape.ok])).toEqual([['media/display', 'video/mp4', true], ['media/poster', 'image/jpeg', true]]);
  const video = Buffer.from(fake.puts[0].bytes);
  expect(video.length).toBe(original.length);
  expect(video.includes(FIXTURE_LOCATION) || video.includes('MRN')).toBe(false);
  // The Builder canvas draws the poster (this test browser has no H.264 decoder, so it is the plain poster).
  await expect(slide(page).locator('.slide-block.slide-image img.slide-picture')).toHaveAttribute('src', /^blob:/);
  expect(fake.gets).toContain('poster'); expect(fake.gets).not.toContain('display');
});

test('[AS-167] an HEVC video is refused in the browser with what to do instead; nothing is uploaded', async ({ page }) => {
  const { fake, dialog } = await openUpload(page);
  await dialog.locator('input[type=file]').setInputFiles({ name: 'IMG_0043.MOV', mimeType: 'video/quicktime', buffer: Buffer.from(mp4Fixture({ codec: 'hvc1' })) });
  await expect(dialog.getByRole('status')).toHaveText(/Export it as H\.264/);
  expect(fake.puts).toHaveLength(0);
});

test('[AS-167] D28: the fit check and Run preview draw an image as its picture, never its alt text, once its step is revealed', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeMedia(page);
  await openBuilder(page, await divingSlides());
  await expect(slide(page)).toBeVisible();
  const tools = page.getByRole('complementary', { name: 'Inspector', exact: true });
  // Room for the image on the opening slide: its long text block is removed (an unplaced block would stop the run).
  await slide(page).locator('.slide-canvas .slide-block.slide-text').nth(1).click();
  await tools.getByRole('button', { name: 'Delete', exact: true }).click();
  await tools.getByRole('group', { name: 'Review change' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(slide(page).locator('.slide-canvas .slide-block.slide-text')).toHaveCount(1);
  await page.locator('.builder-slide .slide-canvas').first().click({ position: { x: 3, y: 3 } });
  await tools.getByRole('group', { name: 'Add block', exact: true }).getByRole('button', { name: 'Image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Image or ECG' });
  await dialog.getByRole('button', { name: 'Upload new' }).click();
  await dialog.locator('input[type=file]').setInputFiles(FIXTURE);
  await dialog.getByLabel(/What it shows/).fill('Chest X-ray, PA');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add image' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(slide(page).locator('.slide-canvas .slide-block.slide-image img.slide-picture')).toHaveAttribute('src', /^blob:/);
  // The fit check draws the selected slide with its picture, so fit measures the picture, not the alt-text box.
  const fitFrames = () => page.evaluate(() => [...document.querySelectorAll('iframe[title="Projector fit check"]')].map(frame => [
    frame.contentDocument?.querySelectorAll('.slide-canvas img.slide-picture[src^="blob:"]').length ?? 0, frame.contentDocument?.querySelectorAll('.slide-image-missing').length ?? 0]));
  await expect.poll(fitFrames, { timeout: 15_000 }).toContainEqual([1, 0]);
  // Run preview (the image still quarantined, shown as the canvas shows it): nothing of the image before its step, then
  // the picture on the projector and the phone, as a room shows a released image.
  const [child] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Preview this case', exact: true }).click()]);
  await expect(child.getByRole('heading', { name: /^Preview · / })).toBeVisible();
  const stage = child.frameLocator('iframe[title="Projector"]'), phone = child.frameLocator('iframe[title="Phone"]');
  await expect(stage.locator('.slide-canvas')).toBeVisible();
  await expect(stage.locator('.slide-figure')).toHaveCount(0);
  for (let i = 0; i < 8 && !(await stage.locator('.slide-figure').count()); i++) await child.locator('.run-preview-rail .console-primary').click();
  await expect(stage.locator('.slide-figure img.slide-picture')).toHaveAttribute('src', /^blob:/);
  await expect(stage.locator('.slide-image-missing')).toHaveCount(0);
  await expect(phone.locator('.slide-figure img.slide-picture')).toHaveAttribute('src', /^blob:/);
  await expect(phone.locator('.slide-image-missing')).toHaveCount(0);
  expect(await stage.locator('.slide-figure img.slide-picture').evaluate(node => node.decode().then(() => node.naturalWidth))).toBeGreaterThan(0);
});


test('[AS-167] drop image onto a slide, confirm its description, and report an identical replacement honestly', async ({ page }) => {
  const fake = await fakeMedia(page);
  await openBuilder(page, await divingSlides());
  const canvas = page.locator('.builder-slide').first();
  const transfer = await page.evaluateHandle(bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'patient-name.jpg', { type: 'image/jpeg' }));
    return transfer;
  }, [...readFileSync(FIXTURE)]);
  await canvas.dispatchEvent('drop', { dataTransfer: transfer });
  const dialog = page.getByRole('dialog', { name: 'Image or ECG' });
  await expect(dialog.getByRole('button', { name: 'Add image', exact: true })).toBeVisible();
  await dialog.getByLabel(/What it shows/).fill('Chest X-ray');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add image', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = [...fake.assets.values()][0];
  expect(row.details).toMatchObject({ alt: 'Chest X-ray', attested: true });
  expect(JSON.stringify(row)).not.toContain('patient-name');
  // The Block panel carries no de-identification tick any more: the upload dialog holds that confirmation (CASE-342).
  await expect(page.getByRole('checkbox', { name: 'I checked this image for identifying details', exact: true })).toHaveCount(0);

  const image = page.locator('.builder-slide .slide-image').first();
  await image.dispatchEvent('drop', { dataTransfer: transfer });
  const replace = page.getByRole('dialog', { name: 'Replace image' });
  await replace.getByLabel(/What it shows/).fill('Chest X-ray');
  await replace.getByRole('checkbox').check();
  await replace.getByRole('button', { name: 'Add image', exact: true }).click();
  await expect(replace).toHaveCount(0);
  expect(fake.assets.size).toBe(1);
  await expect(page.locator('.builder-studio-status')).toContainText('same image');
});
