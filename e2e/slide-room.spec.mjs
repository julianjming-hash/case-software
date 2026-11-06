// Card 57 served rendering: a published slide case (schema 3) runs in a real local room. The projector draws only the
// released blocks at 16:9 with the live question in its slot; phones read the same blocks in reading order and vote.
import { test, expect } from '@playwright/test';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { facilitatorCommand, serverMirror } from '../tests/helpers/local-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import * as edit from '../src/shared/slide-edit.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { joinUrl, displayPairUrl } from '../src/shared/urls.mjs';
import sourceFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

let worker, shell, origin, slideCase;

const must = result => { if (!result.ok) throw new Error(result.reason); return result.document; };
function slideDocument() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(sourceFixture), { metadata_version: 1 }).candidate;
  for (const surface of converted.surfaces) delete surface.variants;
  const upgraded = convertToSlideDocument(converted, { metadata_version: 1 }, { createId: uuidv7 });
  if (!upgraded.ok) throw new Error(upgraded.message);
  let document = upgraded.candidate.document;
  // The opening slide's findings list is squeezed into one grid row, so it cannot fit at the ruled projector size.
  const opening = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);
  const list = opening.placements.find(item => document.blocks.find(block => block.id === item.block_id)?.type === 'list');
  document = must(edit.setPlacement(document, opening.id, list.block_id, { ...list, h: 1 }));
  // The first decision slide is re-laid out as an author would: its scene on top, the question given most of the slide.
  const decisionBeat = document.beats.find(beat => beat.decision_id);
  const slide = document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === decisionBeat.id);
  const byId = id => document.blocks.find(block => block.id === id);
  // This slide is hand-laid as scene above question; its values, lists and CASE-222 title block are taken off it.
  const isTitle = block => block.type === 'text' && block.paragraphs.every(p => p.style !== 'p');
  for (const id of slide.reading_order.filter(id => ['values', 'list'].includes(byId(id).type) || isTitle(byId(id)))) document = must(edit.removeBlock(document, slide.id, id));
  const scene = slide.reading_order.find(id => byId(id)?.type === 'text'), question = slide.reading_order.find(id => byId(id)?.type === 'question');
  document = must(edit.applyTemplate(document, slide.id, 'blank'));
  document = must(edit.setPlacement(document, slide.id, scene, { col: 1, row: 1, w: 12, h: 4 }));
  document = must(edit.setPlacement(document, slide.id, question, { col: 1, row: 5, w: 12, h: 8 }));
  return document;
}

test.beforeAll(async () => {
  slideCase = slideDocument();
  worker = await startPublishedWorker({ caseDocument: slideCase });
  shell = await startServedAuthShell({ apiOrigin: worker.origin });
  origin = shell.origin;
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); });

test('[AS-151] a published slide case runs live: each step releases only its blocks to the projector and phones, and the question slot carries the vote', async ({ browser }) => {
  const started = await fetch(`${worker.origin}/api/v1/sessions`, { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(started.status).toBe(201);
  const room = await started.json();
  const start = slideCase.beats.find(beat => beat.id === slideCase.start_beat_id);
  const openingScene = sourceFixture.surfaces[0].scene;
  const scene = slideCase.blocks.find(block => block.paragraphs?.some(p => p.runs.some(run => run.text.startsWith(openingScene))));
  const laterFinding = 'S00016 workshop poi';
  expect(scene && start).toBeTruthy();

  // Projector at the 720p projector target, paired through the real display-pair flow.
  const frames = { display: [], phone: [] };
  const capture = (page, into) => page.on('websocket', socket => socket.on('framereceived', frame => into.push(String(frame.payload))));
  const displayContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } }), display = await displayContext.newPage();
  capture(display, frames.display);
  await display.goto(displayPairUrl('00000000', origin));
  await expect(display.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  const code = (await display.locator('.pair-code').textContent()).replace(/\s/g, '');
  const approved = await fetch(`${worker.origin}/api/v1/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST',
    headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  expect(approved.ok).toBe(true);
  await expect(display).toHaveURL(new RegExp(`/sessions/${room.sessionId}/display`), { timeout: 15_000 });

  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } }), phone = await phoneContext.newPage();
  capture(phone, frames.phone);
  await phone.goto(joinUrl(room.joinCode, origin));
  await phone.getByRole('button', { name: 'Change code', exact: true }).click();
  await phone.getByLabel('Session code').fill(room.joinCode);
  await phone.getByLabel('Your name').fill('Sam');
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();

  const command = async name => expect((await facilitatorCommand(worker.origin, room, name)).receipt).toBe('accepted');
  await command('start');
  // On entry: the projector draws a 16:9 slide with the scene; nothing from a later step exists on either screen.
  const slide = display.locator('main.slide-band .slide-canvas');
  await expect(slide).toBeVisible();
  await expect(slide).toContainText(openingScene);
  await expect(display.locator('main')).not.toContainText(laterFinding);
  const box = await slide.boundingBox();
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
  await expect(phone.locator('.slide-reflow')).toContainText(openingScene);
  await expect(phone.locator('main')).not.toContainText(laterFinding);
  // The converted opening slide is dense: whatever cannot fit at the ruled size says so; nothing is silently clipped.
  const truth = await display.evaluate(() => [...document.querySelectorAll('main .slide-block:not(.slide-question)')].map(block => ({
    over: block.scrollHeight > block.clientHeight + 1 && !block.querySelector('.slide-more'), marked: Boolean(block.querySelector('.slide-more')) })));
  expect(truth.filter(block => block.over)).toEqual([]);
  await expect(display.locator('main')).toHaveAttribute('data-overflow', String(truth.some(block => block.marked)));
  expect(parseFloat(await display.locator('.slide-block').first().evaluate(node => getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(24);
  expect(JSON.stringify(await display.evaluate(() => document.body.innerHTML))).not.toContain(laterFinding);
  // Nothing unreleased crosses the wire either: no later block text in any frame either role has received.
  for (const role of ['display', 'phone']) expect(frames[role].join('\n'), role).not.toContain(laterFinding);

  // The next step releases the findings list. It cannot fit its one-row slot, so the projector says the rest is on phones
  // and reports the overflow; the phone shows the whole list.
  await command('advance');
  await expect(display.locator('.slide-list .slide-more')).toHaveText('More on your phone');
  await expect(display.locator('main')).toHaveAttribute('data-overflow', 'true');
  await expect(display.locator('#announce')).toContainText('New step shared.');
  await expect(phone.locator('.slide-reflow')).toContainText(laterFinding);

  // Advance to the decision slide and through its context; responses open only on a separate press.
  for (let guard = 0; guard < 12 && (await serverMirror(worker.origin, room)).phase !== 'responses_open'; guard++) await command('advance');
  expect((await serverMirror(worker.origin, room)).phase).toBe('responses_open');
  const question = display.locator('.slide-question');
  await expect(question).toContainText('S00172 workshop prompt. Record a sensor');
  await expect(question).toContainText('S00175 workshop label. Record a s');
  // CASE-211 B: the question fits its slot at 720p, at or above the 24 px floor; the projector reports no overflow.
  await expect(display.locator('main')).toHaveAttribute('data-overflow', 'false');
  expect(parseFloat(await question.evaluate(node => getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(24);

  await phone.getByRole('radio', { name: 'S00175 workshop label. Record a s' }).check();
  await expect(phone.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
  await expect.poll(async () => Object.keys((await serverMirror(worker.origin, room)).round.responses).length).toBe(1);
  // No step list, step identity or composition identity ever reached a public role.
  const secrets = [...slideCase.compositions.flatMap(item => [item.id, ...item.steps.map(step => step.id)]), '"block_ids"', '"steps"'];
  for (const role of ['display', 'phone']) for (const secret of secrets) expect(frames[role].join('\n'), `${role} ${secret}`).not.toContain(secret);
  expect(frames.display.length + frames.phone.length).toBeGreaterThan(4);
  await displayContext.close(); await phoneContext.close();
});
