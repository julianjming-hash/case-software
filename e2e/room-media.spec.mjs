// Card 59 M3 (CASE-269): a live slide room with an ECG on a later step, through the real console, the same-PC projector
// and a phone, against local workerd with a simulated MEDIA bucket (hard rule 12). Before the step: no picture and no
// media request anywhere public. After it: the phone fetches its own copy with its credential, the same-PC projector
// shows the bytes its console relayed, and the phone opens the ECG full size.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../src/shared/ids.mjs';
import { cleanJpeg } from '../src/shared/media.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { addBlock } from '../src/shared/slide-edit.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { createParticipantJoinCapture } from '../tests/helpers/participant-join-capture.mjs';
import { signTestJwt } from '../src/worker/auth.mjs';
import { TEST_JWT_SECRET } from '../tests/helpers/local-worker.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl, joinUrl } from '../src/shared/urls.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { closeRoomSetup, dismissDisplayReminder, openRoomSetup, projectorPage } from '../tests/helpers/console-v2.mjs';

const JPEG = cleanJpeg(new Uint8Array(readFileSync(fileURLToPath(new URL('../tests/fixtures/media/clean-300x200.jpg', import.meta.url)))));
const ALT = 'Sentinel 12-lead ECG on arrival';

function ecgCase() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  let doc = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const opening = doc.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === doc.start_beat_id);
  const largest = opening.placements.filter(item => doc.blocks.find(block => block.id === item.block_id)?.type !== 'question').sort((x, y) => y.w * y.h - x.w * x.h)[0];
  largest.h = Math.max(2, largest.h - 5);
  const assetId = uuidv7(), added = addBlock(doc, opening.id, 'image', uuidv7, { image: { assetId, alt: ALT, ecg: true } });
  if (!added.ok || added.unplaced) throw new Error('no room for the ECG');
  return { doc: added.document, assetId };
}

let harness;
test.beforeAll(async () => {
  const { doc, assetId } = ecgCase();
  const auth = await startLocalAuthStub({ appOrigin: null, jwt: null }), participantJoins = createParticipantJoinCapture();
  const key = (ws, name) => `media/${ws}/${name.repeat(64)}.jpg`;
  const worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: doc, media: {
    rows: ws => [{ asset_id: assetId, status: 'approved', width: 300, height: 200, attribution: null, display_key: key(ws, 'a'), phone_key: key(ws, 'b') }],
    objects: ws => ({ [key(ws, 'a')]: JPEG, [key(ws, 'b')]: JPEG }) } });
  auth.setJwt(await signTestJwt({ sub: worker.userId, email: 'owner@example.invalid', aud: 'authenticated', role: 'authenticated', session_id: worker.sessionId,
    iss: `${auth.origin}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_JWT_SECRET));
  const shell = await startServedAuthShell({ apiOrigin: worker.origin, participantJoinObserver: participantJoins,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  harness = { auth, worker, shell, participantJoins };
});
test.afterAll(async () => { await harness?.shell.stop(); await harness?.worker.stop(); await harness?.auth.stop(); });

test('[AS-168] an ECG stays off every public screen until its step, then the phone and the same-PC projector show it', async ({ browser }) => {
  test.setTimeout(120_000);
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
  const phone = await phoneContext.newPage(), mediaRequests = [];
  phone.on('request', request => { if (new URL(request.url()).pathname.includes('/media/')) mediaRequests.push(request.url()); });
  projector.on('request', request => { if (new URL(request.url()).pathname.includes('/media/')) mediaRequests.push(`projector ${request.url()}`); });
  await phone.goto(joinUrl(room.joinCode, harness.shell.origin));
  await phone.getByLabel('Your name', { exact: true }).fill('Learner');
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();

  // Step by step: until the ECG's step is released, no public screen draws it, names it or asks for it.
  const picture = target => target.locator('img.slide-picture');
  // A page read while that window is still navigating (the phone right after joining) waits for it to settle.
  const content = async target => { for (let attempt = 0; ; attempt++) { try { return await target.content(); } catch (error) { if (attempt > 4) throw error; await target.waitForLoadState(); } } };
  let checked = 0;
  for (let press = 0; press < 12 && !(await picture(phone).count()); press++, checked++) {
    expect(await content(phone)).not.toContain(ALT);
    expect(await content(projector)).not.toContain(ALT);
    expect(mediaRequests).toEqual([]);
    await page.locator('.console-primary').click();
    await page.waitForTimeout(400);
  }
  expect(checked, 'the ECG is on a later step, so some steps were checked before it').toBeGreaterThan(0);
  // Released: the phone fetched its own copy with its credential; the same-PC projector (no credential) made no
  // request and shows the bytes its console relayed.
  await expect(picture(phone)).toHaveAttribute('src', /^blob:/);
  await expect(picture(phone)).toHaveAttribute('alt', ALT);
  await expect(phone.locator('.slide-figure-calibration')).toHaveText('12-lead · 25 mm/s · 10 mm/mV');
  await expect(picture(projector)).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  expect(mediaRequests.every(url => /\/media\/[0-9a-f-]{36}\/phone$/.test(url))).toBe(true);
  expect(mediaRequests.some(url => url.startsWith('projector'))).toBe(false);
  // The phone opens the ECG full size, natural pixels, and closes back to the slide.
  await picture(phone).click();
  const zoom = phone.getByRole('dialog', { name: ALT });
  await expect(zoom.locator('img.phone-zoom-image')).toHaveAttribute('src', /^blob:/);
  await zoom.getByRole('button', { name: 'Close' }).click();
  await expect(zoom).toHaveCount(0);
  await phoneContext.close(); await context.close();
});
