// Console layout v2 (Julian, 2026-10-18): the e2e helpers for a console with no Run/Room tabs. The rarely used
// controls are in the Room setup sheet (open in the lobby, then from the rail); confirms are in place: a first press
// arms the control, and a second press counts only after 600 ms and within 3 s.
import { expect } from '@playwright/test';

/** The console has mounted: its bottom-bar primary is on screen. */
export async function consoleReady(page, options) {
  await expect(page.locator('.console-room .console-action-dock .console-primary')).toBeVisible(options);
}

/** The console is mounted and no command is in flight, so what it shows is the room's settled state. */
async function settledConsole(page) {
  await consoleReady(page);
  await expect(page.locator('.console-room .console-action-dock .console-primary')).not.toHaveAttribute('aria-busy', 'true');
}

/** Open Room setup (already open in the lobby) and return it. */
export async function openRoomSetup(page) {
  await settledConsole(page);
  const sheet = page.locator('#console-setup');
  if (await sheet.isVisible().catch(() => false)) return sheet;
  await page.locator('.console-rail [data-focus-key="room-setup"]').click();
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Close Room setup if it is open over a running case (the lobby's sheet stays). */
export async function closeRoomSetup(page) {
  await settledConsole(page);
  const close = page.locator('#console-setup [data-focus-key="sheet-close"]');
  if (await close.isVisible().catch(() => false)) await close.click();
}

/** Press an in-place confirm twice, as a person would: the second press after the label changed. */
export async function confirmInPlace(page, locator, armedText) {
  await locator.click();
  if (armedText) await expect(locator).toHaveText(armedText);
  await page.waitForTimeout(650);
  await locator.click();
}

/** End case from the rail. */
export async function endCase(page) {
  await confirmInPlace(page, page.locator('.console-rail [data-focus-key="arm-end"]'), 'Press again: End case');
}

/** Enter manual room mode from Room setup (or the rail while reconnecting). */
export async function enterManualRoom(page) {
  await settledConsole(page);
  // Keep using the setup sheet the scenario already opened. The reconnect rail disappears while
  // transport retries are "connecting"; choosing it can expire the three-second confirmation
  // between clicks even though the stable sheet control remains available (AS-061 hosted trace).
  const sheet = page.locator('#console-setup');
  const rail = page.locator('.console-rail [data-focus-key="arm-manual-now"]');
  if (await sheet.isVisible().catch(() => false)) {
    await confirmInPlace(page, sheet.locator('[data-focus-key="arm-manual"]'), 'Press again: manual session');
  } else if (await rail.isVisible().catch(() => false)) {
    await confirmInPlace(page, rail, 'Press again: manual session');
  } else {
    await openRoomSetup(page);
    await confirmInPlace(page, sheet.locator('[data-focus-key="arm-manual"]'), 'Press again: manual session');
  }
  await expect(page.getByRole('button', { name: 'Add spoken marker', exact: true })).toBeVisible();
}

/** Open the pairing card (Use another screen) and return it. */
export async function openPairing(page) {
  await page.locator('.console-rail [data-focus-key="use-another-screen"]').click();
  const card = page.locator('#console-setup .console-pairing');
  await expect(card).toBeVisible();
  return card;
}

const projectorUrl = /\/sessions\/[^/]+\/display\?topology=same-pc/;
/**
 * The same-PC projector page. Start room opens it in its own click (console layout v2); when that window is gone or was
 * never allowed, the rail's Open projector opens it. Returns the page once it is on the room's projector address.
 */
export async function projectorPage(page) {
  const context = page.context();
  await consoleReady(page);
  const candidate = () => context.pages().find(p => p !== page && !p.isClosed() && (projectorUrl.test(p.url()) || p.url() === 'about:blank'));
  let projector = candidate();
  const open = page.locator('.console-rail [data-focus-key="open-projector"]');
  if (!projector && await open.isVisible().catch(() => false)) [projector] = await Promise.all([context.waitForEvent('page'), open.click()]);
  if (!projector) projector = await context.waitForEvent('page', { predicate: p => p !== page });
  await projector.waitForURL(projectorUrl);
  return projector;
}

/** Dismiss the display reminder (it lives in the Use another screen card) and fold Room setup away. */
export async function dismissDisplayReminder(page) {
  const card = await openPairing(page);
  await card.getByRole('button', { name: 'Dismiss display reminder', exact: true }).click();
  await expect(page.locator('#console-setup .console-pairing')).toHaveCount(0);
}
