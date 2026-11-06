// Card 40b recap images (Julian's ruling 1, 2026-10-17): the participant's Download recap (PDF) embeds each image the
// phone was shown, the approved phone rendition unchanged, with its credit printed under it, so CC BY / BY-SA licences
// are honoured. An image on a step the room never released, and its credit, never reach the phone or the file. A published
// slide room against local workerd with a simulated MEDIA bucket (hard rule 12).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../src/shared/ids.mjs';
import { cleanJpeg } from '../src/shared/media.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { addBlock } from '../src/shared/slide-edit.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { facilitatorCommand } from '../tests/helpers/local-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { readPdf } from '../tests/helpers/pdf-read.mjs';
import { joinUrl } from '../src/shared/urls.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

const PHOTO = cleanJpeg(new Uint8Array(readFileSync(fileURLToPath(new URL('../tests/fixtures/media/clean-300x200.jpg', import.meta.url)))));
const SHOWN_ALT = 'Chest film on arrival', SHOWN_CREDIT = 'Photo: A. Example, CC BY-SA 4.0';
const LATER_ALT = 'Film from a step never released', LATER_CREDIT = 'Unreleased credit, never on a phone';

function imageCase() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  let doc = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const openingId = doc.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === doc.start_beat_id).id;
  const ids = { shown: uuidv7(), later: uuidv7() };
  for (const [name, alt] of [['shown', SHOWN_ALT], ['later', LATER_ALT]]) {
    const opening = doc.compositions.find(item => item.id === openingId);
    const largest = opening.placements.filter(item => doc.blocks.find(block => block.id === item.block_id)?.type !== 'question').sort((x, y) => y.w * y.h - x.w * x.h)[0];
    largest.h = Math.max(2, largest.h - 4);
    const added = addBlock(doc, openingId, 'image', uuidv7, { image: { assetId: ids[name], alt, ecg: false } });
    if (!added.ok || added.unplaced) throw new Error(`no room for the ${name} image`);
    doc = added.document;
  }
  // The shown image is released On entry; the later one keeps its own last step, which this room never reaches.
  const opening = doc.compositions.find(item => item.id === openingId), shownStep = opening.steps.at(-2);
  opening.steps = opening.steps.filter(step => step !== shownStep);
  opening.steps.find(step => step.block_ids.length).block_ids.push(...shownStep.block_ids);
  return { doc, ids };
}

let worker, shell;
test.beforeAll(async () => {
  const { doc, ids } = imageCase();
  const key = (ws, name) => `media/${ws}/${name.repeat(64)}.jpg`;
  worker = await startPublishedWorker({ caseDocument: doc, media: {
    rows: ws => [
      { asset_id: ids.shown, status: 'approved', width: 300, height: 200, attribution: SHOWN_CREDIT, display_key: key(ws, 'a'), phone_key: key(ws, 'b'), poster_key: null, media_type: 'image/jpeg', duration_ms: null },
      { asset_id: ids.later, status: 'approved', width: 300, height: 200, attribution: LATER_CREDIT, display_key: key(ws, 'c'), phone_key: key(ws, 'd'), poster_key: null, media_type: 'image/jpeg', duration_ms: null }],
    objects: ws => ({ [key(ws, 'a')]: PHOTO, [key(ws, 'b')]: PHOTO, [key(ws, 'c')]: PHOTO, [key(ws, 'd')]: PHOTO }) } });
  shell = await startServedAuthShell({ apiOrigin: worker.origin });
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); });

test('[card 40b recap images] [AS-177] Download recap embeds the image the phone was shown with its credit under it, from what the phone holds; an unreleased image never appears', async ({ browser }) => {
  const started = await fetch(`${worker.origin}/api/v1/sessions`, { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(started.status).toBe(201);
  const room = await started.json();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } }), phone = await context.newPage();
  const media = [], frames = [];
  phone.on('request', request => { if (new URL(request.url()).pathname.includes('/media/')) media.push(request.url()); });
  phone.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))));
  await phone.goto(joinUrl(room.joinCode, shell.origin));
  await phone.getByRole('button', { name: 'Change code', exact: true }).click();
  await phone.getByLabel('Session code').fill(room.joinCode);
  await phone.getByLabel('Your name').fill('Sam');
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();

  const command = async name => expect((await facilitatorCommand(worker.origin, room, name)).receipt).toBe('accepted');
  await command('start');
  await expect(phone.getByRole('img', { name: SHOWN_ALT, exact: true })).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await command('end');
  await expect(phone.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
  // The recap screen stays credit-free; the credit prints under the image (Julian, 2026-10-17) and goes into the PDF.
  expect(await phone.locator('body').innerText()).not.toContain(SHOWN_CREDIT);
  await expect(phone.locator('.recap-credit')).toHaveText([SHOWN_CREDIT]);
  await expect(phone.locator('.recap-credit')).toBeHidden();
  const held = media.length;
  expect(held).toBe(1);

  const [download] = await Promise.all([phone.waitForEvent('download'), phone.getByRole('button', { name: 'Download recap (PDF)', exact: true }).click()]);
  const pdf = readPdf(new Uint8Array(readFileSync(await download.path()))), lines = pdf.lines.map(line => line.replace(/\s+/g, ' ').trim());
  const images = [...pdf.objects.values()].filter(object => object.includes('/Subtype /Image'));
  expect(images).toHaveLength(1);
  expect(images[0]).toContain(`/Width 300 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${PHOTO.length} `);
  expect(pdf.tree.filter(node => node.type === 'Figure').map(node => node.alt)).toEqual([SHOWN_ALT]);
  expect(lines[lines.indexOf(SHOWN_ALT) + 1]).toBe(SHOWN_CREDIT);
  expect(media.length, 'the file uses the image the phone already holds: nothing is fetched again').toBe(held);
  for (const leak of [LATER_ALT, LATER_CREDIT, 'Sam', room.joinCode]) expect(lines.join('\n').includes(leak) || pdf.text.includes(leak), leak).toBe(false);
  for (const leak of [LATER_ALT, LATER_CREDIT]) expect(frames.join('\n'), leak).not.toContain(leak);
  // AS-177 (room PDFs v2): after a reload the phone holds no image; the recap draws it inline as its place comes near, fetched
  // once with the phone's own credential, and never behind a Show image button.
  const before = media.length;
  await phone.reload();
  await expect(phone.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
  await expect(phone.getByRole('button', { name: 'Show image', exact: true })).toHaveCount(0);
  await phone.locator('.recap-figure').first().scrollIntoViewIfNeeded();
  await expect(phone.locator('img.recap-picture')).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await expect(phone.locator('img.recap-picture')).toHaveAttribute('alt', SHOWN_ALT);
  expect(media.length - before, 'one fetch for the one revealed image').toBe(1);
  await context.close();
});
