// Built assets and deployed CSP, with a local-only unused API proxy. No Worker/backend is needed.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { startAdminShell } from '../tests/helpers/admin-shell.mjs';
import { homeUrl, adminPageUrl, accountUrl, historyUrl, casesUrl } from '../src/shared/urls.mjs';
test.use({ serviceWorkers: 'block', ignoreHTTPSErrors: true }); // Throwaway local Auth stub uses a self-signed certificate.
let shell, admin, selectAsset, menuAsset;
const evidence = join(tmpdir(), 'case-shared-controls-evidence');
const shot = async (page, name) => { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${name}.png` }); };
test.beforeAll(async () => {
  shell = await startServedAuthShell({ apiOrigin: 'http://127.0.0.1:9' });
  admin = await startAdminShell();
  selectAsset = `/assets/${readdirSync(`${shell.outDir}/assets`).find(name => /^accessible-select\.[a-f0-9]+\.mjs$/.test(name))}`;
  menuAsset = `/assets/${readdirSync(`${shell.outDir}/assets`).find(name => /^shared-menu\.[a-f0-9]+\.mjs$/.test(name))}`;
});
test.afterAll(async () => { await shell?.stop(); await admin?.stop(); });
async function fixture(page, modal = false) {
  await page.goto(homeUrl(shell.origin));
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await page.evaluate(async ({ asset, modal }) => {
    const { enhanceSelect } = await import(asset);
    const host = document.createElement(modal ? 'dialog' : 'section');
    const heading = document.createElement('h2'); heading.textContent = 'Control proof'; heading.id = 'control-proof-heading';
    host.setAttribute('aria-labelledby', heading.id); host.append(heading);
    const form = document.createElement('form'), label = document.createElement('label'), native = document.createElement('select');
    label.textContent = 'Choice'; native.id = 'proof-choice'; native.name = 'choice'; label.htmlFor = native.id;
    const rows = modal ? Array.from({ length: 21 }, (_, i) => [`Choice ${i + 1}`, String(i), false])
      : [['Alpha', 'a', false], ['Blocked', 'b', true], ['Charlie', 'c', false]];
    for (const [text, value, disabled] of rows) {
      const option = document.createElement('option'); option.textContent = text; option.value = value; option.disabled = disabled; native.append(option);
    }
    native.options[0].defaultSelected = true;
    const next = document.createElement('button'); next.type = 'button'; next.textContent = 'Next control';
    form.append(label, native, next); host.append(form); document.body.append(host);
    const control = enhanceSelect(native, { label: 'Choice' }); let changes = 0;
    native.addEventListener('change', () => changes++);
    globalThis.controlProof = { native, form, control, changes: () => changes };
    if (modal) host.showModal();
  }, { asset: selectAsset, modal });
  return page.getByRole('combobox', { name: 'Choice', exact: true });
}
test('select preview/commit, disabled/typeahead/Escape/Tab and native form properties stay exact', async ({ page }) => {
  const choice = await fixture(page);
  expect(await choice.evaluate(node => document.getElementById(node.getAttribute('aria-controls'))?.hidden)).toBe(true);
  await choice.focus(); await choice.press('ArrowDown'); await choice.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Charlie' })).toHaveClass(/active/);
  expect(await page.evaluate(() => [controlProof.native.value, controlProof.changes()])).toEqual(['a', 0]);
  await choice.press('Escape'); await expect(choice).toHaveAttribute('aria-expanded', 'false'); await expect(choice).toBeFocused();
  expect(await choice.evaluate(node => document.getElementById(node.getAttribute('aria-controls'))?.hidden)).toBe(true);
  await choice.press('Enter'); await choice.press('c'); await choice.press('Enter');
  expect(await page.evaluate(() => [new FormData(controlProof.form).get('choice'), controlProof.changes()])).toEqual(['c', 1]);
  await expect(choice).toHaveText('Charlie');
  await choice.press('Enter'); await choice.press('b');
  await expect(page.getByRole('option', { name: 'Blocked' })).toHaveAttribute('aria-disabled', 'true');
  await choice.press('Tab'); await expect(choice).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Next control' })).toBeFocused();
  await page.evaluate(() => { controlProof.native.value = 'a'; }); await expect(choice).toHaveText('Alpha');
  expect(await page.evaluate(() => controlProof.changes())).toBe(1);
  await choice.click(); await page.evaluate(() => { controlProof.native.disabled = true; });
  await expect(choice).toBeDisabled(); await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.evaluate(() => { controlProof.native.disabled = false; controlProof.native.value = 'c'; controlProof.form.reset(); });
  await expect(choice).toHaveText('Alpha');
  expect(await page.evaluate(() => new FormData(controlProof.form).get('choice'))).toBe('a');
  await page.evaluate(() => controlProof.control.dispose());
  await expect(page.getByRole('combobox', { name: 'Choice' })).toHaveCount(1); // Native select restored with its original label.
  await expect(page.locator('#proof-choice')).toBeVisible();
});
test('touch-size popup stays inside viewport and Escape closes it before the containing modal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  const choice = await fixture(page, true), modal = page.getByRole('dialog', { name: 'Control proof' });
  await choice.click(); const popup = page.getByRole('listbox', { name: 'Choice' }); await expect(popup).toBeVisible();
  const box = await popup.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(620);
  await choice.press('Escape'); await expect(popup).toHaveCount(0); await expect(modal).toBeVisible();
  await expect(choice).toBeFocused();
  await choice.click(); await page.getByRole('option', { name: 'Choice 21', exact: true }).click();
  await expect(choice).toHaveText('Choice 21');
  expect(await page.evaluate(() => [controlProof.native.value, controlProof.changes()])).toEqual(['20', 1]);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await choice.click();
    await settled(page);
    const result = await new AxeBuilder({ page }).analyze(); expect(result.violations).toEqual([]);
    await shot(page, `modal-popup-${scheme}`);
    await choice.press('Escape');
  }
});
test('[AS-117] rich grouped choices preserve labels, keyboard preview and native form values', async ({ page }) => {
  const choice = await fixture(page, true);
  await page.evaluate(() => {
    const make = (label, value, tone, icon, description) => {
      const option = document.createElement('option'); option.textContent = label; option.value = value;
      Object.assign(option.dataset, { tone, icon, description }); return option;
    };
    const published = document.createElement('optgroup'); published.label = 'Published';
    published.append(make('Ready to run', 'ready', 'ok', 'check', 'Published version 2'));
    const drafts = document.createElement('optgroup'); drafts.label = 'Drafts';
    drafts.append(make('Needs review', 'review', 'warn', 'alert', '<strong>Three items remain</strong>'));
    const blocked = document.createElement('optgroup'); blocked.label = 'Unavailable'; blocked.disabled = true;
    blocked.append(make('Archived', 'archived', 'bad', 'stop', 'Unavailable in this task'));
    controlProof.native.replaceChildren(published, drafts, blocked); controlProof.native.value = 'ready';
  });
  await expect(choice).toHaveText('Ready to run');
  await choice.click();
  await expect(page.getByRole('group', { name: 'Published', exact: true })).toBeVisible();
  const review = page.getByRole('option', { name: 'Needs review', exact: true });
  await expect(review.locator('.shared-choice-description')).toHaveText('<strong>Three items remain</strong>');
  await expect(review.locator('strong')).toHaveCount(0);
  await expect(review.locator('svg')).toHaveCount(1);
  await expect(page.getByRole('option', { name: 'Archived', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await choice.press('End'); await expect(review).toHaveClass(/active/);
  expect(await page.evaluate(() => controlProof.native.value)).toBe('ready');
  await choice.press('Escape'); await expect(choice).toBeFocused();
  await choice.click(); await review.click(); await expect(choice).toHaveText('Needs review');
  expect(await page.evaluate(() => [new FormData(controlProof.form).get('choice'), controlProof.changes()])).toEqual(['review', 1]);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await choice.click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); await choice.press('Escape');
  }
  await page.evaluate(() => controlProof.control.dispose());
  await expect(page.locator('#proof-choice')).toBeVisible();
  expect(await page.locator('#proof-choice').inputValue()).toBe('review');
});
test('device panel keeps music unset until explicit choice, exact levels and settings sync across tabs', async ({ context }) => {
  const page = await context.newPage(), other = await context.newPage();
  await page.goto(homeUrl(shell.origin)); await other.goto(homeUrl(shell.origin));
  for (const tab of [page, other]) {
    await tab.getByRole('button', { name: 'Open menu' }).click(); await tab.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(tab.getByRole('slider', { name: 'Music volume' })).toHaveAttribute('aria-valuetext', 'Off');
  }
  expect(await page.evaluate(() => localStorage.getItem('case:audio:music-volume'))).toBeNull();
  const music = page.getByRole('slider', { name: 'Music volume' }); await music.focus(); await music.press('Home'); await music.press('ArrowRight');
  await expect(other.getByRole('slider', { name: 'Music volume' })).toHaveAttribute('aria-valuetext', '5%');
  await page.getByRole('switch', { name: 'Interface sounds' }).uncheck();
  await expect(other.getByRole('switch', { name: 'Interface sounds' })).not.toBeChecked();
  // Console layout v2: the console's timeline is one strip, so the collapse preference is gone from Settings.
  await expect(page.getByRole('checkbox', { name: 'Collapse timeline by default' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('case:preferences:ui-tones'))).toBe('false');
  await shot(page, 'device-settings');
  await page.close(); await other.close();
});
test('[AS-125] admin menu uses actual /me identity, guarded same-tab routes and a real account reread after unavailable', async ({ page }) => {
  admin.state.mode = 'ready'; admin.state.meMode = 'ready';
  await page.goto(adminPageUrl(admin.origin));
  await page.getByLabel('Email', { exact: true }).fill(admin.email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code', { exact: true }).fill(admin.otp);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu.getByText(admin.email, { exact: true })).toBeVisible();
  for (const [name, href] of [['Open account', accountUrl(admin.origin)], ['Sessions', historyUrl(admin.origin)], ['Present', casesUrl(admin.origin)]]) {
    const link = menu.getByRole('link', { name: new RegExp(`^${name}`) });
    await expect(link).toHaveAttribute('href', href); await expect(link).not.toHaveAttribute('target', '_blank');
  }
  await expect(menu.getByRole('link', { name: /^Admin$/ })).toBeVisible();
  await shot(page, 'admin-menu');
  await menu.getByRole('button', { name: 'Close menu' }).click();
  admin.state.meMode = 'unavailable'; await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(menu.getByRole('status')).toContainText('Account information is unavailable');
  await expect(menu.getByText(admin.email, { exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await menu.getByRole('button', { name: 'Close menu' }).click();
  admin.state.meMode = 'ready'; await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(menu.getByText(admin.email, { exact: true })).toBeVisible();
});
test('blocked device writes stay unsaved and report the failure', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('case:audio:') || key.startsWith('case:preferences:')) throw new DOMException('Blocked', 'SecurityError');
      return set.call(this, key, value);
    };
  });
  await page.goto(homeUrl(shell.origin)); await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' }), music = menu.getByRole('slider', { name: 'Music volume' });
  await music.focus(); await music.press('ArrowRight');
  await expect(music).toHaveAttribute('aria-valuetext', 'Off');
  await expect(menu.getByRole('status').filter({ hasText: 'Device settings could not be saved' })).toBeVisible();
  await menu.getByRole('switch', { name: 'Interface sounds' }).click();
  await expect(menu.getByRole('switch', { name: 'Interface sounds' })).toBeChecked();
  expect(await page.evaluate(() => [localStorage.getItem('case:audio:music-volume'), localStorage.getItem('case:preferences:ui-tones')])).toEqual([null, null]);
  await shot(page, 'blocked-device-save');
});
test('open menu keeps keyboard focus through repeated room snapshots and invokes the current callback', async ({ page }) => {
  await page.goto(homeUrl(shell.origin)); await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await page.evaluate(async asset => {
    const { attachSiteMenu } = await import(asset), opener = document.createElement('button'); opener.textContent = 'Room menu proof';
    document.querySelector('main').append(opener); const calls = [];
    const menu = attachSiteMenu(opener, { roomActions: [{ label: 'Room action', run: () => calls.push('old') }] });
    globalThis.menuProof = { menu, calls }; await menu.open();
  }, menuAsset);
  const dialog = page.getByRole('dialog', { name: 'Menu', exact: true }), action = dialog.getByRole('button', { name: 'Room action', exact: true });
  await action.focus();
  await page.evaluate(() => { for (let version = 1; version <= 20; version++) menuProof.menu.setRoomActions([{ label: 'Room action', run: () => menuProof.calls.push(version) }]); });
  await expect(action).toBeFocused();
  await page.evaluate(() => menuProof.menu.setRoomActions([{ label: 'Room action', disabled: true, run: () => menuProof.calls.push('disabled') }]));
  await expect(action).toBeDisabled();
  await page.evaluate(() => document.querySelector('[data-room-action="0"]').click());
  expect(await page.evaluate(() => menuProof.calls)).toEqual([]);
  await page.evaluate(() => menuProof.menu.setRoomActions([{ label: 'Room action', run: () => menuProof.calls.push('current') }]));
  await action.focus(); await action.press('Enter');
  expect(await page.evaluate(() => menuProof.calls)).toEqual(['current']);
  await expect(dialog).toBeHidden(); await expect(page.getByRole('button', { name: 'Room menu proof' })).toBeFocused();
});

test('unchanged identity snapshots cannot suppress a failed current account reread', async ({ page }) => {
  await page.goto(homeUrl(shell.origin)); await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await page.evaluate(async asset => {
    const { attachSiteMenu } = await import(asset), opener = document.createElement('button'); opener.textContent = 'Identity menu proof';
    document.querySelector('main').append(opener); let reject;
    const flight = new Promise((resolve, fail) => { reject = fail; });
    const menu = attachSiteMenu(opener, { loadAccount: () => flight });
    const account = () => ({ email: 'verified@example.test', administration: true, signOut() {} });
    menu.setAccount(account()); globalThis.identityProof = { menu, reject, account }; void menu.open();
  }, menuAsset);
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu.getByText('verified@example.test', { exact: true })).toBeVisible();
  await expect(menu.getByRole('status', { name: '' }).filter({ hasText: 'Checking account' })).toBeVisible();
  await page.evaluate(() => {
    for (let version = 0; version < 20; version++) identityProof.menu.setAccount(identityProof.account());
    identityProof.reject(new Error('temporarily unavailable'));
  });
  await expect(menu.getByRole('status').filter({ hasText: 'Account information is unavailable' })).toBeVisible();
  await expect(menu.getByText('verified@example.test', { exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});
