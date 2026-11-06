// Card 59 M3 (CASE-269; Julian's re-ruling, 2026-10-15): a slide room with an animated GIF and a video, through the real
// console, the same-PC projector and a phone, against local workerd with a simulated MEDIA bucket (hard rule 12). The
// projector shows the video when its step is released and follows the console's Play and Pause; the phone shows the
// poster and fetches the video only when tapped; the GIF animates on both; the recap lists what the room was shown.
// This Chromium has no H.264 decoder, so playback is checked as the state the projector was asked for (data-state).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../src/shared/ids.mjs';
import { cleanJpeg } from '../src/shared/media.mjs';
import { cleanMp4 } from '../src/shared/media-mp4.mjs';
import { gifFixture, mp4Fixture } from '../tests/helpers/media-fixtures.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { addBlock } from '../src/shared/slide-edit.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { createParticipantJoinCapture } from '../tests/helpers/participant-join-capture.mjs';
import { signTestJwt } from '../src/worker/auth.mjs';
import { TEST_JWT_SECRET, serverMirror } from '../tests/helpers/local-worker.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl, joinUrl } from '../src/shared/urls.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { closeRoomSetup, dismissDisplayReminder, endCase, openRoomSetup, projectorPage } from '../tests/helpers/console-v2.mjs';

const POSTER = cleanJpeg(new Uint8Array(readFileSync(fileURLToPath(new URL('../tests/fixtures/media/clean-300x200.jpg', import.meta.url)))));
const VIDEO = cleanMp4(mp4Fixture({ width: 1280, height: 720, seconds: 42 })).bytes, GIF = gifFixture();
const VIDEO_ALT = 'Bedside echo, parasternal long axis', GIF_ALT = 'Capillary refill, animated';

function mediaCase() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  let doc = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const opening = doc.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === doc.start_beat_id);
  const ids = {};
  for (const [name, alt] of [['gif', GIF_ALT], ['video', VIDEO_ALT]]) {
    const largest = opening.placements.filter(item => doc.blocks.find(block => block.id === item.block_id)?.type !== 'question').sort((x, y) => y.w * y.h - x.w * x.h)[0];
    largest.h = Math.max(2, largest.h - 4);
    ids[name] = uuidv7();
    const added = addBlock(doc, opening.id, 'image', uuidv7, { image: { assetId: ids[name], alt, ecg: false } });
    if (!added.ok || added.unplaced) throw new Error(`no room for the ${name}`);
    doc = added.document;
  }
  return { doc, ids };
}

let harness;
test.beforeAll(async () => {
  const { doc, ids } = mediaCase();
  const auth = await startLocalAuthStub({ appOrigin: null, jwt: null }), participantJoins = createParticipantJoinCapture();
  const key = (ws, name, ext = 'jpg') => `media/${ws}/${name.repeat(64)}.${ext}`;
  const worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: doc, media: {
    rows: ws => [
      { asset_id: ids.gif, status: 'approved', width: 32, height: 24, attribution: null, display_key: key(ws, 'a', 'gif'), phone_key: key(ws, 'a', 'gif'), poster_key: key(ws, 'b'), media_type: 'image/gif', duration_ms: null },
      { asset_id: ids.video, status: 'approved', width: 1280, height: 720, attribution: 'Echo: own recording', display_key: key(ws, 'c', 'mp4'), phone_key: key(ws, 'c', 'mp4'), poster_key: key(ws, 'd'), media_type: 'video/mp4', duration_ms: 42000 }],
    objects: ws => ({ [key(ws, 'a', 'gif')]: GIF, [key(ws, 'b')]: POSTER, [key(ws, 'c', 'mp4')]: VIDEO, [key(ws, 'd')]: POSTER }) } });
  auth.setJwt(await signTestJwt({ sub: worker.userId, email: 'owner@example.invalid', aud: 'authenticated', role: 'authenticated', session_id: worker.sessionId,
    iss: `${auth.origin}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_JWT_SECRET));
  const shell = await startServedAuthShell({ apiOrigin: worker.origin, participantJoinObserver: participantJoins,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  harness = { auth, worker, shell };
});
test.afterAll(async () => { await harness?.shell.stop(); await harness?.worker.stop(); await harness?.auth.stop(); });

test('[AS-168] a GIF and a video on a later step: the projector plays the video when the console says so; a phone plays its own on tap; the recap lists both', async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(casesUrl(harness.shell.origin));
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const created = harness.shell.waitForCreatedRoom();
  await (await openCase(page)).click();
  const room = await created;
  // Start room opened the same-PC projector in its own click (console layout v2).
  const projector = await projectorPage(page);
  await dismissDisplayReminder(page);

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', ignoreHTTPSErrors: true });
  const phone = await phoneContext.newPage(), phoneMedia = [];
  phone.on('request', request => { const path = new URL(request.url()).pathname; if (path.includes('/media/')) phoneMedia.push(path.split('/').at(-1)); });
  await phone.goto(joinUrl(room.joinCode, harness.shell.origin));
  await phone.getByLabel('Your name', { exact: true }).fill('Learner');
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();

  // Step on until both are released; before that the console offers no video control.
  const video = projector.locator('video[data-video-block]');
  for (let press = 0; press < 12 && !(await video.count()); press++) {
    await expect(page.getByRole('region', { name: 'Video on the projector' })).toHaveCount(0);
    await page.locator('.console-primary').click();
    await page.waitForTimeout(400);
  }
  await expect(video).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await expect(video).toHaveAttribute('aria-label', VIDEO_ALT);
  expect(await video.evaluate(node => [node.controls, node.playsInline])).toEqual([false, true]);
  await expect(projector.getByRole('img', { name: GIF_ALT })).toHaveAttribute('src', /^blob:/);
  await expect(video).toHaveAttribute('data-state', 'idle');

  // The console plays, then pauses, the projector's video.
  const controls = page.locator('.console-video');
  await expect(controls).toContainText(VIDEO_ALT);
  await expect(controls).toContainText('Not started');
  await controls.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(video).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await controls.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(video).toHaveAttribute('data-state', 'paused', { timeout: 10_000 });
  await expect(controls).toContainText(/Paused at 0:\d\d/);

  // The phone (red-team S6): a GIF and a video both show their poster and load only when tapped; the video then has its
  // own controls, the GIF animates as itself.
  const gifPoster = phone.getByRole('img', { name: `Play animation: ${GIF_ALT}` }), poster = phone.getByRole('img', { name: `Play video: ${VIDEO_ALT}` });
  await expect(gifPoster).toBeVisible(); await expect(poster).toBeVisible();
  expect(phoneMedia.filter(rendition => rendition === 'phone')).toHaveLength(0);
  expect(phoneMedia.filter(rendition => rendition === 'display')).toHaveLength(0);
  await gifPoster.click();
  await expect(phone.getByRole('img', { name: GIF_ALT, exact: true })).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await poster.click();
  const own = phone.locator('video[data-video-block]');
  await expect(own).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  expect(await own.evaluate(node => node.controls)).toBe(true);
  expect(phoneMedia.filter(rendition => rendition === 'phone')).toHaveLength(2);
  expect(Object.values((await serverMirror(harness.worker.origin, room)).media).some(asset => asset.credit === 'Echo: own recording')).toBe(true);
  const beforeEnd = phoneMedia.length;

  // End the room: the phone's recap lists the images it was shown, the video as its poster.
  await endCase(page);
  await expect(phone.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Images shown', exact: true })).toBeVisible();
  await expect(phone.locator('.recap-picture')).toHaveCount(2, { timeout: 15_000 });
  await expect(phone.locator('.recap-figure figcaption')).toHaveText([`Animation: ${GIF_ALT}`, `Video: ${VIDEO_ALT}`]);
  // The screen stays credit-free; Print recap credits each revealed image (Julian, 2026-10-17).
  expect(await phone.locator('body').innerText()).not.toContain('Echo: own recording');
  await expect(phone.locator('.recap-credit')).toHaveText(['Echo: own recording']);
  await expect(phone.locator('.recap-credit')).toBeHidden();
  await phone.emulateMedia({ media: 'print' });
  await expect(phone.locator('.recap-credit')).toBeVisible();
  await phone.emulateMedia({ media: 'screen' });
  expect(phoneMedia.length, 'the ended phone fetched nothing again: its recap uses what it holds').toBe(beforeEnd);
  await phoneContext.close(); await context.close();
});
