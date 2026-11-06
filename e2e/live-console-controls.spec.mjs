import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const evidence = join(tmpdir(), 'case-console-final-evidence');
// Combined reviewed authority + console + phone intent + shared menu contracts.
// Every command here reaches the real local Worker/DO; no page-side reducer or synthetic snapshot.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { casesUrl, historyUrl, sessionUrl } from '../src/shared/urls.mjs';
import { controlsCase, startControlsHarness, captureLocalPublicFrames, openControlsDecision,
  primary, undo, route, mirror, snapshot, joinApi, voteApi, openPhone, selectPhone,
  assertPublicPrivacy, openMenu, assertNoHorizontalOverflow, PRIVATE_MARKER, LATER_MARKER,
  FUTURE_MARKER } from '../tests/helpers/live-console-controls.mjs';

test.describe.configure({ mode: 'serial' });
let harness, fixture;
test.beforeAll(async () => { fixture = controlsCase(); harness = await startControlsHarness(fixture); });
test.afterAll(async () => { await harness?.stop(); });

async function consoleContext(browser, options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 },
    reducedMotion: 'reduce', ...options });
  await captureLocalPublicFrames(context); return context;
}
async function lock(page) {
  await expect(primary(page)).toHaveText('Lock responses & review');
  await primary(page).click();
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
}
async function reveal(page) {
  await expect(primary(page)).toHaveText(/^Reveal:/);
  await primary(page).click();
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed');
}
async function assertExactUndo(page, commands, descriptor) {
  const before = commands.length;
  await undo(page).click();
  await expect.poll(() => commands.length).toBe(before + 1);
  expect(commands.at(-1)).toMatchObject({ type: 'undo', targetEventId: descriptor.targetEventId });
  expect(Number.isSafeInteger(commands.at(-1).expectRevision)).toBe(true);
}

test('local plurality preview, override and local Undo send no command; chart Reveal is one exact command', async ({ browser }) => {
  const context = await consoleContext(browser);
  try {
    const { page, projector, room, commands } = await openControlsDecision(context, harness);
    const voter = await joinApi(harness, room, 'Private Voter One');
    await voteApi(harness, room, voter, fixture.o.image);
    await expect(page.locator('.console-live-responses')).toContainText('Private Voter One');
    await lock(page);
    await expect(route(page, 'Image first')).toHaveAttribute('aria-checked', 'true');
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toBeVisible();
    const authority = await mirror(harness, room), count = commands.length;
    expect(authority.selectedPathId).toBeNull();
    await route(page, 'Decompress').click();
    await expect(route(page, 'Decompress')).toHaveAttribute('aria-checked', 'true');
    await expect(undo(page)).toHaveText('Undo route choice');
    await undo(page).click();
    await expect(route(page, 'Image first')).toHaveAttribute('aria-checked', 'true');
    expect(commands.length).toBe(count);
    const untouched = await mirror(harness, room);
    expect(untouched.revision).toBe(authority.revision);
    expect(untouched.selectedPathId).toBeNull();
    await reveal(page);
    expect(commands.slice(count)).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({ type: 'reveal_path', pathId: fixture.p.image,
      expectRevision: authority.revision });
    expect(commands.slice(count).some(command => ['select_path','show_results','reveal'].includes(command.type))).toBe(false);
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toHaveCount(0);
    await expect(projector.locator('body')).toContainText('Worse while imaging');
    await expect(projector.locator('body')).not.toContainText(LATER_MARKER);
    await assertPublicPrivacy(projector, [], ['Private Voter One']);
  } finally { await context.close(); }
});

test('atomic Reveal clears the lobby overlay and chart together without a prerequisite command', async ({ browser }) => {
  const context = await consoleContext(browser);
  try {
    const { page, projector, room, commands } = await openControlsDecision(context, harness);
    await voteApi(harness, room, await joinApi(harness, room, 'Lobby Voter'), fixture.o.decompress);
    await lock(page);
    await page.getByRole('complementary', { name: 'Session' }).getByRole('button', { name: 'Show join screen', exact: true }).click();
    await expect(projector.locator('.joinpanel')).toBeVisible();
    const state = await mirror(harness, room); expect(state.display.lobby).toBe(true);
    const count = commands.length;
    await reveal(page);
    expect(commands.slice(count)).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({ type: 'reveal_path', pathId: fixture.p.decompress,
      expectRevision: state.revision });
    const after = await mirror(harness, room);
    expect(after.display.lobby).toBe(false); expect(after.resultsShown).toBe(false);
    await expect(projector.locator('.joinpanel')).toHaveCount(0);
    await expect(projector.locator('body')).toContainText('Partial response');
    await assertPublicPrivacy(projector, [], ['Lobby Voter']);
  } finally { await context.close(); }
});

test('repeated exact authority Undo retains the saved phone answer, reopens editing, and leaves mistaken routes clear', async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await consoleContext(browser); let phone;
  try {
    const { page, projector, room, commands } = await openControlsDecision(context, harness);
    phone = await openPhone(browser, harness, room);
    await selectPhone(phone, 'Chest X-ray first');
    let originalRound = (await mirror(harness, room)).round.id;
    for (const [index, nextLabel] of ['Decompress the right chest','Chest X-ray first'].entries()) {
      await lock(page); await reveal(page);
      await expect(phone.page.locator('body')).toContainText(index === 0 ? 'Chest X-ray first' : 'Decompress the right chest');
      const revealed = await snapshot(harness, room);
      expect(revealed.view.undo.kind).toBe('reveal');
      await assertExactUndo(page, commands, revealed.view.undo);
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
      const corrected = await mirror(harness, room);
      expect(corrected.round.id).not.toBe(originalRound);
      expect(corrected.selectedPathId).toBeNull();
      await expect(page.locator('.console-route-pick[aria-checked="true"]')).toHaveCount(0);
      await expect(primary(page)).toHaveText('Choose a path');
      await expect(phone.page.locator('.saved-line')).toContainText('Your answer (locked)');
      const locked = await snapshot(harness, room); expect(locked.view.undo.kind).toBe('lock');
      await assertExactUndo(page, commands, locked.view.undo);
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
      await expect(phone.page.getByRole('button', { name: 'Change decision', exact: true })).toBeVisible();
      const fresh = await mirror(harness, room);
      expect(fresh.round.id).not.toBe(corrected.round.id);
      expect(fresh.round.responses[phone.participant.participantId].response.option_id)
        .toBe(index === 0 ? fixture.o.image : fixture.o.decompress);
      const sent = phone.commands.length;
      await selectPhone(phone, nextLabel);
      await expect.poll(() => phone.commands.length).toBe(sent + 1);
      expect(phone.commands.at(-1)).toMatchObject({ type: 'vote', roundId: fresh.round.id });
      expect(phone.commands.at(-1).clientEventId).not.toBe(phone.commands[sent - 1].clientEventId);
      originalRound = fresh.round.id;
      await expect(page.locator('.console-live-responses')).toContainText(nextLabel);
    }
    expect(phone.frames.length).toBeGreaterThan(0);
    await assertPublicPrivacy(projector, phone.frames, ['Learner Private Name']);
  } finally { await phone?.context.close(); await context.close(); }
});

test('presentation tiles preserve each occurrence’s exact then-public groups, including a labelled correction and replay', async ({ browser }) => {
  const context = await consoleContext(browser);
  try {
    const { page, projector, room } = await openControlsDecision(context, harness);
    await voteApi(harness, room, await joinApi(harness, room, 'Timeline Voter'), fixture.o.image);
    await lock(page); await reveal(page);
    const expand = page.getByRole('button', { name: 'Show presentation', exact: true });
    if (await expand.isVisible()) await expand.click();
    const before = await snapshot(harness, room);
    const consequenceIndex = before.view.publicTimeline.length - 1;
    const first = page.locator('.console-presentation-tile').nth(consequenceIndex);
    await expect(first).toContainText('Worse while imaging');
    await expect(first).not.toContainText(LATER_MARKER);
    await primary(page).click();
    await expect(projector.locator('body')).toContainText(LATER_MARKER);
    const grouped = await snapshot(harness, room);
    expect(grouped.view.publicTimeline.at(-1).surface.points).toContain(LATER_MARKER);
    await expect(first).toContainText(LATER_MARKER);
    await undo(page).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    const corrected = await snapshot(harness, room);
    expect(corrected.view.publicTimeline[consequenceIndex]).toEqual(grouped.view.publicTimeline[consequenceIndex]);
    await expect(page.locator('.console-presentation-tile').last()).toContainText(/Correction/i);
    await route(page, 'Decompress').click(); await reveal(page);
    const final = await snapshot(harness, room);
    const tiles = page.locator('.console-presentation-tile');
    await expect(tiles).toHaveCount(final.view.publicTimeline.length);
    for (const row of final.view.publicTimeline) {
      const tile = tiles.nth(row.entryIndex);
      await expect(tile).toContainText(row.surface.title);
      if (row.surface.scene) await expect(tile).toContainText(row.surface.scene);
      for (const point of row.surface.points) await expect(tile).toContainText(point);
      await expect(tile).not.toContainText(PRIVATE_MARKER);
      await expect(tile).not.toContainText(FUTURE_MARKER);
    }
    const live = final.view.publication;
    await tiles.nth(consequenceIndex).click();
    await expect(projector.locator('body')).toContainText('Worse while imaging');
    await expect(projector.locator('body')).toContainText(LATER_MARKER);
    expect((await snapshot(harness, room)).view.publication).toEqual(live);
    await page.getByRole('button', { name: 'Live surface', exact: true }).click();
    await expect(projector.locator('body')).toContainText('Partial response');
    await expect(projector.locator('body')).not.toContainText(LATER_MARKER);
    await assertPublicPrivacy(projector, [], ['Timeline Voter']);
  } finally { await context.close(); }
});

test('named live responses stay private and same-name owners keep distinct rows during live replacement', async ({ browser }) => {
  const context = await consoleContext(browser); let phone;
  try {
    const { page, projector, room } = await openControlsDecision(context, harness);
    phone = await openPhone(browser, harness, room, 'Alex Private Learner');
    const other = await joinApi(harness, room, 'Alex Private Learner');
    await selectPhone(phone, 'Chest X-ray first');
    await voteApi(harness, room, other, fixture.o.decompress);
    const rows = page.locator('.console-live-responses [data-response-owner]');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('strong')).toHaveText(['Alex Private Learner','Alex Private Learner']);
    await expect(page.locator(`[data-response-owner="${phone.participant.participantId}"]`)).toContainText('Chest X-ray first');
    await expect(page.locator(`[data-response-owner="${other.participantId}"]`)).toContainText('Decompress the right chest');
    await selectPhone(phone, 'RSI and intubate');
    await expect(rows).toHaveCount(2);
    await expect(page.locator(`[data-response-owner="${phone.participant.participantId}"]`)).toContainText('RSI and intubate');
    await lock(page);
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toBeVisible();
    const frames = await assertPublicPrivacy(projector, phone.frames, ['Alex Private Learner']);
    expect(JSON.stringify(frames)).not.toContain(other.participantId);
    expect(JSON.stringify(phone.frames)).not.toContain(other.participantId);
    await expect(phone.page.locator('body')).not.toContainText(PRIVATE_MARKER);
  } finally { await phone?.context.close(); await context.close(); }
});

test('menu preserves focused links through votes; same-tab Cases and History protect the live room without claiming it', async ({ browser }) => {
  const context = await consoleContext(browser);
  const oldOwned = harness.worker.fake.replies.get('list_owned_active_sessions');
  const oldHistory = harness.worker.fake.replies.get('list_room_history');
  try {
    const { page, room } = await openControlsDecision(context, harness);
    // Return the actually created room from the fake archive/account boundary, making an implicit
    // re-mint a reachable mistake. The live capability and epoch still belong to the real RoomDO.
    const expires = room.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString();
    const created = new Date().toISOString();
    harness.worker.fake.replies.set('list_owned_active_sessions', [{ session_id: room.sessionId,
      join_code: room.joinCode, expires_at: expires }]);
    harness.worker.fake.replies.set('list_room_history', [{ session_id: room.sessionId,
      case_version_id: harness.worker.versionId, title: fixture.doc.title, version_no: 1,
      status: 'live', created_at: created, started_at: created, ended_at: null,
      expires_at: expires, archive_state: 'pending', own: true }]);
    const menu = await openMenu(page), library = menu.getByRole('link', { name: /^Present$/ });
    await library.focus();
    const before = await mirror(harness, room);
    await voteApi(harness, room, await joinApi(harness, room, 'Menu Voter'), fixture.o.image);
    await expect(page.locator('.console-live-responses')).toContainText('Menu Voter');
    await expect(library).toBeFocused();
    const claims=[];const capture=request=>{if(request.method()==='POST'&&/\/(facilitator-token|sessions)$/.test(new URL(request.url()).pathname))claims.push(request.url());};context.on('request',capture);
    for (const label of ['Present','Sessions']) {
      const link=menu.getByRole('link',{name:label,exact:true});await expect(link).not.toHaveAttribute('target','_blank');
      const question=page.waitForEvent('dialog');const click=link.click();const warning=await question;expect(warning.message()).toContain('session will keep running');await warning.dismiss();await click;
      await expect(page.locator('.console-phase')).toHaveAttribute('data-phase','responses_open');await expect(link).toBeFocused();
    }
    const warning=page.waitForEvent('dialog');const click=library.click();await (await warning).accept();await click;
    await expect(page).toHaveURL(casesUrl(harness.shell.origin));await expect(page.locator('.library-head')).toBeVisible();await expect(page.getByRole('button',{name:/^Rejoin session/})).toBeVisible();
    expect(claims).toEqual([]);expect((await mirror(harness,room)).epoch).toBe(before.epoch);context.off('request',capture);

  } finally {
    if (oldOwned === undefined) harness.worker.fake.replies.delete('list_owned_active_sessions');
    else harness.worker.fake.replies.set('list_owned_active_sessions', oldOwned);
    if (oldHistory === undefined) harness.worker.fake.replies.delete('list_room_history');
    else harness.worker.fake.replies.set('list_room_history', oldHistory);
    await context.close();
  }
});

test('unavailable localStorage getter leaves live controls and timeline choices usable in memory', async ({ browser }) => {
  const context = await consoleContext(browser), errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const { page, projector } = await openControlsDecision(context, harness, { beforeRoomMount: page => page.evaluate(() => Object.defineProperty(window, 'localStorage', { configurable: true,
      get() { throw new DOMException('Storage denied by local test', 'SecurityError'); } })) });
    await expect(primary(page)).toHaveText('Lock responses & review');
    // Console layout v2: the presentation strip is always open (no collapse preference to store).
    await expect(page.locator('.console-presentation-tile').first()).toBeVisible();
    const menu = await openMenu(page);
    await menu.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(menu.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await assertPublicPrivacy(projector);
  } finally { await context.close(); }
});

for (const theme of ['light','dark']) for (const zoom of [1,2]) {
  test(`keyboard routes and shared menu remain usable at 320 CSS px, ${zoom * 100}% zoom, ${theme}; axe`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await consoleContext(browser, { colorScheme: theme,
      viewport: { width: 320 * zoom, height: 900 * zoom } });
    try {
      const { page, room, commands } = await openControlsDecision(context, harness);
      if (zoom === 2) await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      await voteApi(harness, room, await joinApi(harness, room, 'Keyboard Voter'), fixture.o.image);
      await lock(page);
      const count = commands.length, revision = (await mirror(harness, room)).revision;
      const chosen = route(page, 'Image first'); await chosen.focus();
      await page.keyboard.press('Home');
      await expect(route(page, 'Decompress')).toBeFocused();
      await expect(route(page, 'Decompress')).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('End');
      await expect(route(page, 'Intubate first')).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(chosen).toBeFocused();
      const noteSummary = page.locator('.console-route-detail summary').first();
      await expect(noteSummary).toHaveAttribute('aria-label', 'Show private notes');
      expect(await noteSummary.evaluate(node => getComputedStyle(node).listStyleType)).toBe('none');
      expect(await noteSummary.evaluate(node => getComputedStyle(node, '::marker').content)).toBe('""');
      await noteSummary.focus(); await page.keyboard.press('Enter');
      await expect(noteSummary).toHaveAttribute('aria-label', 'Hide private notes');
      await expect(noteSummary).toBeFocused();
      await expect(noteSummary.locator('..')).toHaveAttribute('open', '');
      await page.keyboard.press('Space');
      await expect(noteSummary).toHaveAttribute('aria-label', 'Show private notes');
      await expect(noteSummary).toBeFocused();
      await expect(noteSummary.locator('..')).not.toHaveAttribute('open');
      expect(commands.length).toBe(count); expect((await mirror(harness, room)).revision).toBe(revision);
      expect((await mirror(harness, room)).selectedPathId).toBeNull();
      await assertNoHorizontalOverflow(page);
      const primaryBox = await primary(page).boundingBox();
      const undoBox = await undo(page).boundingBox();
      expect(primaryBox.height).toBeGreaterThanOrEqual(44);
      expect(undoBox.height).toBeGreaterThanOrEqual(44);
      expect(primaryBox.y + primaryBox.height).toBeLessThanOrEqual(900 * zoom + 1);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/route-${theme}-${zoom}.png`, fullPage: true });
      const menu = await openMenu(page);
      const menuBox = await menu.boundingBox();
      expect(menuBox.x, 'menu left edge remains visible at zoom').toBeGreaterThanOrEqual(0);
      expect(menuBox.y, 'menu top edge remains visible at zoom').toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320 * zoom + 1);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(900 * zoom + 1);
      await menu.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(menu.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
      await menu.getByRole('button', { name: 'Close menu', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.open)).toBe(true);
      await page.keyboard.press('Tab');
      await expect(menu.getByRole('button', { name: 'Close menu', exact: true })).toBeFocused();
      await assertNoHorizontalOverflow(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `${evidence}/menu-${theme}-${zoom}.png` });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeFocused();
    } finally { await context.close(); }
  });
}
