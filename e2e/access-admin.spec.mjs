// Facilitator-UX A5 (plan §3 A5; AS-212, AS-213 admin parts, AS-209 admin parts): Administration to prototypes/admin-people.html.
// People (roles and grants), Invitations (Revoke says what it does), Workspaces (create, policies, storage and quota, Delete
// unused), Cases and Rooms (live rooms), Activity in words. Step-up errors read differently from an outage, every destructive
// dialog states its consequences first, a failed refresh keeps the last list. The local Admin fixture only (no live system).
// Screenshots go to ACCESS_SHOTS_DIR when it is set; axe runs on every new screen, light and dark.
import { settled } from '../tests/helpers/settled.mjs';
import { fillSearch } from '../tests/helpers/collapsed-search.mjs';
import { test, expect } from '@playwright/test';
import { chooseOption } from '../tests/helpers/choose-option.mjs';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startAdminShell } from '../tests/helpers/admin-shell.mjs';

const SHOTS = process.env.ACCESS_SHOTS_DIR || null;
let fixture;
test.describe.configure({ mode: 'default' });
test.beforeEach(async () => { fixture = await startAdminShell(); });
test.afterEach(async () => { await fixture?.stop(); fixture = null; });
const context = (browser, options = {}) => browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, ...options });
async function signIn(page) {
  await page.goto(fixture.origin + '/admin');
  await page.getByLabel('Email', { exact: true }).fill(fixture.email);
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill(fixture.otp);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name:'People',exact:true})).toHaveAttribute('aria-current','page');
}
const nav = async(page,name)=>{const close=page.getByRole('button',{name:'Close record',exact:true});if(await close.isVisible())await close.click();await page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name,exact:true}).click();};
const dialog = page => page.locator('#adminConfirmation[open]');
const drawer = page => page.getByRole('dialog', { name: 'Selected record' });
const region = page => page.getByRole('dialog', { name: 'Selected record' });
const openPerson = async page => { await page.getByRole('button', { name: 'facilitator@example.invalid', exact: true }).click(); await expect(drawer(page).getByRole('button',{name:'Close record'})).toBeFocused(); };
async function code(page, value = fixture.stepupCode) {
  const input = dialog(page).getByLabel('Six-digit code', { exact: true });
  for (const [name, expected] of Object.entries({ type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}' })) await expect(input).toHaveAttribute(name, expected);
  await input.fill('012345'); await expect(input).toHaveValue('012345');
  await input.fill(value);
}
const settle = settled;
async function checked(page, name, scheme) {
  await settle(page);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map(v => `${v.id} ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `access-admin-${name}-${scheme}.png`), fullPage: true });
}

test('[AS-212] People lists each person with roles and shared cases; a role change states its consequences, and a wrong code, a limit and an outage read differently', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  try {
    await signIn(page);
    const statusFilter = page.getByRole('combobox', { name: 'Status', exact: true });
    await chooseOption(statusFilter, 'Active'); await expect(statusFilter).toBeFocused();
    const workspaceFilter = page.getByRole('combobox', { name: 'Workspace', exact: true });
    await chooseOption(workspaceFilter, 'Teaching'); await expect(workspaceFilter).toBeFocused();
    await expect(page.getByText('Can edit · Teaching', { exact: true })).toBeVisible();
    await expect(page.getByText('Can run · Teaching case', { exact: true })).toBeVisible();
    await openPerson(page);
    await expect(drawer(page).getByRole('heading', { name: 'Access' })).toBeVisible();
    await expect(drawer(page).getByText('Can run · Teaching case (Teaching)')).toBeVisible();
    await chooseOption(drawer(page).getByRole('combobox', { name: 'Access in Teaching' }), 'Can manage');
    await expect(dialog(page).getByRole('heading', { name: 'Change facilitator@example.invalid to Can manage?' })).toBeVisible();
    await expect(dialog(page)).toContainText('changes from Can edit to Can manage');
    await expect(dialog(page)).toContainText('publishing workspace cases');
    // An outage of the sign-in service says nothing was changed, and is not "uncertain".
    fixture.state.stepupMode = 'down';
    await dialog(page).getByRole('button', { name: 'Email me a code', exact: true }).click();
    await expect(page.locator('.surface-toast')).toContainText('Case could not reach the sign-in service. Nothing was changed; try again in a minute.');
    await expect(dialog(page)).not.toContainText(/uncertain/i);
    fixture.state.stepupMode = 'rate_limited';
    await dialog(page).getByRole('button', { name: 'Email me a code', exact: true }).click();
    await expect(page.locator('.surface-toast')).toContainText('Too many code attempts');
    fixture.state.stepupMode = null;
    await dialog(page).getByRole('button', { name: 'Email me a code', exact: true }).click();
    await expect(dialog(page).getByLabel('Six-digit code', { exact: true })).toBeFocused();
    await checked(page, 'people-dialog', 'light');
    await code(page, '000000'); await dialog(page).getByRole('button', { name: 'Set Can manage', exact: true }).click();
    await expect(page.locator('.surface-toast')).toContainText('That code did not work: it is wrong or has expired');
    fixture.state.stepupMode = 'rate_limited';
    await code(page); await dialog(page).getByRole('button', { name: 'Set Can manage', exact: true }).click();
    await expect(page.locator('.surface-toast')).toContainText('Too many code attempts');
    fixture.state.stepupMode = null;
    expect(fixture.state.calls.filter(c => c.operation === 'membership_change')).toHaveLength(0);
    await code(page); await dialog(page).getByRole('button', { name: 'Set Can manage', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('Can manage · Teaching', { exact: true })).toBeVisible();
    expect(fixture.state.calls.filter(c => c.operation === 'membership_change')).toHaveLength(1);
    // The session is now confirmed: removing needs no second code, and the dialog says what Remove does.
    await chooseOption(drawer(page).getByRole('combobox', { name: 'Access in Teaching' }), 'Remove from Teaching');
    await expect(dialog(page)).toContainText('loses access to every case in Teaching');
    await expect(dialog(page)).toContainText('keep going until they end');
    await expect(dialog(page).getByRole('button', { name: 'Remove access', exact: true })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(drawer(page).getByRole('combobox', { name: 'Access in Teaching' })).toContainText('Can manage');
  } finally { await ctx.close(); }
});

test('[AS-212] Disable says it signs the person out and ends their live room before it asks for a code; Soft delete names the 30 days', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  try {
    await signIn(page); await openPerson(page);
    await drawer(page).getByRole('button', { name: 'Soft delete…', exact: true }).click();
    await expect(dialog(page)).toContainText('After 30 days the account is deleted for good. Until then Restore brings it back.');
    await expect(dialog(page).getByRole('button', { name: 'Soft delete and end 1 room', exact: true })).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await drawer(page).getByRole('button', { name: 'Disable…', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Disable facilitator@example.invalid?' })).toBeVisible();
    await expect(dialog(page)).toContainText('They are signed out on every device and cannot sign in.');
    await expect(dialog(page)).toContainText('Their 1 live room ends now (2 phones joined).');
    await expect(dialog(page)).toContainText('Enable gives everything back.');
    await expect(dialog(page)).not.toContainText(/facilitators_|membership_change|soft_delete/);
    expect(fixture.state.calls.filter(c => c.operation === 'stepup_start')).toHaveLength(0);
    await dialog(page).getByRole('button', { name: 'Email me a code', exact: true }).click();
    await code(page); await dialog(page).getByRole('button', { name: 'Disable and end 1 room', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.admin-table').getByText('Disabled', { exact: true })).toBeVisible();
    expect(fixture.state.mutations).toBe(1);
  } finally { await ctx.close(); }
});

test('[AS-212] a whitespace-only search is a plain list; a failed refresh keeps the last list and never flashes Loading', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  try {
    await page.clock.install(); await signIn(page);
    await page.getByRole('button',{name:'Search people by email',exact:true}).click();const search=page.getByRole('searchbox',{name:'Search people by email',exact:true});
    const lists = () => fixture.state.calls.filter(c => c.operation === 'facilitators_list').length;
    const before = lists(), pendingSearch=fixture.hold('facilitators_list');
    await search.fill('    '); await page.getByRole('button', { name: 'Search', exact: true }).click();
    await pendingSearch.ready;await expect.poll(lists).toBe(before + 1);pendingSearch.release();
    expect(fixture.state.calls.filter(c => c.operation === 'facilitators_search')).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'facilitator@example.invalid', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'facilitator@example.invalid', exact: true })).toBeFocused();
    // The poll fails: the table stays, a notice says it is the last list, and "Loading people…" never appears.
    await page.evaluate(() => { window.sawLoading = false; new MutationObserver(() => { if (document.body.innerText.includes('Loading people')) window.sawLoading = true; }).observe(document.body, { childList: true, subtree: true, characterData: true }); });
    fixture.state.mode = 'unavailable';
    const failing = lists();
    await page.clock.fastForward(31000);
    await expect(page.locator('.surface-toast').filter({hasText:'could not refresh this list'})).toBeVisible();
    await expect(page.getByRole('button', { name: 'facilitator@example.invalid', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.sawLoading)).toBe(false);
    expect(lists()).toBe(failing);
    fixture.state.mode = 'ready';
    await page.clock.fastForward(31000);
    await expect(page.locator('.surface-toast').filter({hasText:'could not refresh this list'})).toHaveCount(0);
  } finally { await ctx.close(); }
});

test('[AS-213] Workspaces: create, policies, storage with a warning from 80%, a quota in GB, and Delete unused with its consequences and step-up', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  try {
    await signIn(page); await nav(page, 'Workspaces');
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Teaching', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Selected workspace' });
    await expect(panel.getByRole('heading', { name: 'Who can do what' })).toBeVisible();
    await expect(panel.getByLabel('Managers can invite people')).toBeChecked();
    await expect(panel.getByLabel('Editors publish without review')).not.toBeChecked();
    await expect(panel.getByRole('status')).toContainText('1.7 GB of 2 GB used (85%). Delete unused images or raise the quota before it fills.');
    await checked(page, 'workspaces', 'light');
    await panel.getByLabel('Anyone who can run a case can share it to run').check();
    await panel.getByRole('button', { name: 'Save policies', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Policies saved.' })).toBeVisible();
    const saved = fixture.state.calls.find(c => c.operation === 'workspace_settings');
    expect(saved.body).toEqual({ expectedRevision: 0, policies: { runners_share: true }, mediaQuotaBytes: null });
    await expect(panel.getByLabel('Anyone who can run a case can share it to run')).toBeChecked();
    // A bad quota is said, a good one saved; the warning clears once the quota is raised.
    await panel.getByLabel('Quota (GB, 0 to 10)').fill('abc'); await panel.getByRole('button', { name: 'Save quota', exact: true }).click();
    await expect(page.locator('.surface-toast').filter({hasText:'a whole number of gigabytes'})).toBeVisible();
    await panel.getByLabel('Quota (GB, 0 to 10)').fill('4'); await panel.getByRole('button', { name: 'Save quota', exact: true }).click();
    await expect(panel.getByText('1.7 GB of 4 GB used (42%).', { exact: true })).toBeVisible();
    expect(fixture.state.calls.filter(c => c.operation === 'workspace_settings').at(-1).body).toEqual({ expectedRevision: 1, policies: {}, mediaQuotaBytes: 4e9 });
    // Delete unused: the consequences first, then the code, then the result.
    await expect(panel.getByText('Spare chest film', { exact: false })).toBeVisible();
    await panel.getByRole('button', { name: 'Delete unused', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Delete 2 unused images?' })).toBeVisible();
    await expect(dialog(page)).toContainText('2 images (650 kB) that no draft, version or room uses are deleted.');
    await expect(dialog(page)).toContainText('cannot be recovered');
    await dialog(page).getByRole('button', { name: 'Email me a code', exact: true }).click();
    await code(page, '111111'); await dialog(page).getByRole('button', { name: 'Delete unused', exact: true }).click();
    await expect(page.locator('.surface-toast')).toContainText('wrong or has expired');
    await code(page); await dialog(page).getByRole('button', { name: 'Delete unused', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Deleted 2.' })).toBeVisible();
    await expect(panel.getByText('Every image is used by a draft, a version or a room, or is less than a day old.')).toBeVisible();
    // Close the selected record before using the list's Create action.
    await panel.getByRole('button', { name: 'Close record', exact: true }).click();
    // Create a workspace: the short name follows the name; the creator becomes its owner.
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Critical Care B');
    await expect(page.getByLabel('Short name (lower-case letters, numbers and hyphens)')).toHaveValue('critical-care-b');
    await page.locator('.admin-create').getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Critical Care B is created, and you are its owner.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Critical Care B', exact: true })).toBeVisible();
    expect(fixture.state.calls.find(c => c.operation === 'workspace_create').body).toEqual({ slug: 'critical-care-b', name: 'Critical Care B' });
  } finally { await ctx.close(); }
});

test('[AS-212] Cases withdraw with their consequences; Rooms lists live rooms first and End room says how many phones see the end screen; Activity reads in words', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  try {
    await signIn(page); await nav(page, 'Cases');
    const picker = page.getByRole('combobox', { name: 'Workspace', exact: true }).and(page.locator('button'));
    await picker.click(); await page.getByRole('option', { name: /^Teaching(?: ✓)?$/ }).click();
    await page.getByRole('button', { name: 'Teaching case', exact: true }).click();
    await region(page).getByRole('button', { name: 'Withdraw version', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Withdraw “Teaching case”?' })).toBeVisible();
    await expect(dialog(page)).toContainText('No one can start a new session from “Teaching case” (version 1) until it is republished.');
    await expect(dialog(page)).toContainText('Rooms already running are not ended.');
    await dialog(page).getByRole('button', { name: 'Email me a code', exact: true }).click();
    await code(page); await dialog(page).getByRole('button', { name: 'Withdraw version', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.workbench-rows')).toContainText('Withdrawn');
    await expect(page.getByRole('status').filter({ hasText: 'Version withdrawn. Current information loaded.' })).toBeVisible();
    await nav(page, 'Sessions');
    await expect(page.getByRole('heading', { name: 'Live now', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'facilitator@example.invalid', exact: true })).toBeVisible();
    await checked(page, 'rooms', 'light');
    await page.getByRole('button', { name: 'End the room of facilitator@example.invalid' }).click();
    await expect(dialog(page)).toContainText('2 phones will see the end screen.');
    await expect(dialog(page)).toContainText('The room ends now for everyone in it.');
    await dialog(page).getByRole('button', { name: 'End case', exact: true }).click();
    await expect(page.getByText('No session is live right now.', { exact: true })).toBeVisible();
    await nav(page, 'Activity');
    await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    for (const sentence of ['administrator@example.invalid invited someone', 'An owner ended a case share', 'The system accepted an invitation', 'An author published a version', 'A facilitator sent an invitation again'])
      await expect(page.getByRole('button', { name: new RegExp(`^${sentence}`) })).toBeVisible();
    await expect(page.locator('.workbench-rows')).not.toContainText(/invitation_|case_grant|version_publish/);
    await checked(page, 'activity', 'light');
    await page.getByRole('button', { name: /^An owner ended a case share/ }).click();
    await expect(region(page)).toContainText('Case share ended');
    await expect(region(page)).not.toContainText(/case_grant_revoke|Event key/);
    expect(fixture.state.room).toBeNull();
  } finally { await ctx.close(); }
});

test('[AS-209] Revoke states what it does in a dialog before it revokes', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  try {
    await signIn(page); await nav(page, 'Invitations');
    await expect(page.getByRole('cell', { name: 's.lee@example.invalid', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Revoke the invitation to s.lee@example.invalid' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Revoke the invitation to s.lee@example.invalid?' })).toBeVisible();
    await expect(dialog(page)).toContainText('stops working at once');
    await expect(dialog(page)).toContainText('Nothing they already have changes.');
    await checked(page, 'invitations-dialog', 'light');
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(fixture.state.calls.filter(c => c.operation === 'invitation_revoke')).toHaveLength(0);
    await page.getByRole('button', { name: 'Revoke the invitation to s.lee@example.invalid' }).click();
    await dialog(page).getByRole('button', { name: 'Revoke invitation', exact: true }).click();
    await expect(page.locator('.surface-toast').filter({hasText:'The invitation to s.lee@example.invalid is revoked. Its link no longer works.'})).toBeVisible();
    expect(fixture.state.calls.filter(c => c.operation === 'invitation_revoke')).toHaveLength(1);
  } finally { await ctx.close(); }
});

for (const scheme of ['light', 'dark']) test(`[AS-212] ${scheme}: every new Administration screen passes axe, and the dialogs keep focus`, async ({ browser }) => {
  const ctx = await context(browser, { colorScheme: scheme }), page = await ctx.newPage();
  try {
    await signIn(page);
    await checked(page, 'people', scheme);
    await openPerson(page);
    await checked(page, 'people-drawer', scheme);
    await drawer(page).getByRole('button', { name: 'Disable…', exact: true }).click();
    await expect(dialog(page).getByRole('button', { name: 'Email me a code', exact: true })).toBeFocused();
    await checked(page, 'disable-dialog', scheme);
    await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0);
    await expect(drawer(page).getByRole('button', { name: 'Disable…', exact: true })).toBeFocused();
    await nav(page, 'Invitations');
    await expect(page.getByRole('heading', { name: 'Invitations', exact: true, level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invitations · Teaching', exact: true, level: 3 })).toBeVisible();
    await checked(page, 'invitations', scheme);
    await nav(page, 'Workspaces'); await page.getByRole('button', { name: 'Teaching', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Selected workspace' }).getByRole('heading', { name: 'Image storage' })).toBeVisible(); await checked(page, 'workspaces', scheme);
    await nav(page, 'Sessions'); await expect(page.getByRole('heading', { name: 'Live now', exact: true })).toBeVisible(); await checked(page, 'rooms', scheme);
    await nav(page, 'Activity'); await expect(page.getByRole('button', { name: /^An owner ended a case share/ })).toBeVisible(); await checked(page, 'activity', scheme);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await nav(page, 'People'); await checked(page, 'people-phone', scheme);
  } finally { await ctx.close(); }
});


test('[AS-209] pending invitation locks its workspace and preserves the address after refusal', async ({ browser }) => {
  const ctx = await context(browser), page = await ctx.newPage();
  let release, releaseList = () => {};
  const pending = new Promise(resolve => { release = resolve; });
  let payload;
  try {
    await signIn(page); await nav(page, 'Invitations');
    await expect(page.getByRole('heading', { name: 'Invitations · Teaching', exact: true })).toBeVisible();await page.getByRole('button',{name:'+ Invite person',exact:true}).click();
    await page.route('**/api/v1/invitations', async route => {
      payload = route.request().postDataJSON(); await pending;
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'account_disabled' }) });
    });
    await page.getByLabel('Email address', { exact: true }).fill('new@example.invalid');
    await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
    const workspace = page.locator('.admin-invitations .shared-select-trigger').first();
    await expect(workspace).toBeDisabled();
    await expect(page.getByLabel('Email address', { exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox',{name:'Access',exact:true})).toBeDisabled();
    await expect.poll(() => payload?.workspaceId).toBe(fixture.state.workspaces[0].workspace_id);
    // Disabled controls cannot be changed by a person. A stale dispatched change is refused too.
    await page.locator('.studio-admin-toolbar select').evaluate(select => { select.value = [...select.options][1].value; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(workspace).toContainText('Teaching');
    release();
    await expect(page.locator('.surface-toast')).toContainText('That account is disabled');
    await expect(workspace).toBeEnabled();
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('new@example.invalid');
    await checked(page, 'invitations-refusal', 'light');
    await page.unroute('**/api/v1/invitations');
    await page.route('**/api/v1/invitations', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outcome: 'sent', invitation: { level: 'run' } }) }));
    await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
    await expect(page.locator('.surface-toast')).toContainText('Can run in Teaching');
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Resend the invitation to s.lee@example.invalid' })).toBeEnabled();
    const pendingList = new Promise(resolve => { releaseList = resolve; });
    await page.route('**/api/v1/workspaces/*/invitations', async route => {
      await pendingList;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations: [] }) });
    });
    await chooseOption(workspace, 'Bondi SLSC');
    await expect(page.getByRole('button', { name: 'Resend the invitation to s.lee@example.invalid' })).toHaveCount(0);
    await expect(page.getByRole('caption')).toContainText('Loading invitations');
    releaseList();
    await expect(page.getByRole('caption')).toContainText('No invitations in this workspace yet');
  } finally { release(); releaseList(); await ctx.close(); }
});

test('[AS-209] an uncertain revoke never reports success and keeps its outcome visible after confirmation closes',async({browser})=>{
 const ctx=await context(browser),page=await ctx.newPage();try{
  await signIn(page);await nav(page,'Invitations');await expect(page.getByRole('cell',{name:'s.lee@example.invalid',exact:true})).toBeVisible();
  let writes=0;await page.route('**/api/v1/workspaces/*/invitations/*/revoke',async route=>{writes++;await route.fulfill({status:503,json:{error:'unavailable'}});});
  await page.getByRole('button',{name:'Revoke the invitation to s.lee@example.invalid',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Revoke invitation',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.surface-toast')).toContainText('Case could not confirm this result. Refresh invitations before trying again.');expect(writes).toBe(1);await expect(page.getByRole('row').filter({hasText:'s.lee@example.invalid'})).toContainText('Waiting');expect(fixture.state.calls.filter(c=>c.operation==='invitation_revoke')).toHaveLength(0);
 }finally{await ctx.close();}
});
