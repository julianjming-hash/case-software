// Card 30 (CASE-168 (3)): groups in the facilitator document and in Administration. The owner's Groups screen
// and the library run against the real local Worker with the in-memory PostgREST group model; Administration
// runs against the Card 21b strict local HTTP contract (admin-shell), extended with the group routes. No metered
// backend is reached. Screenshots for the PR are written only when CASE_C30_SHOTS names a directory.
import { test, expect } from '@playwright/test';
import { chooseOption } from '../tests/helpers/choose-option.mjs';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { mkdirSync } from 'node:fs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { startAdminShell } from '../tests/helpers/admin-shell.mjs';
import { FIXTURE } from '../tests/helpers/local-worker.mjs';
import { casesUrl, caseWorkspaceUrl, apiPath } from '../src/shared/urls.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';

const SHOTS = process.env.CASE_C30_SHOTS || null;
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); } };
const art = withSolution(describeCase(FIXTURE), { attempt: 0, summarised: false });
const CATALOGUE = ['Anaphylaxis', 'Bradycardia', 'Cardiac arrest', 'Diabetic ketoacidosis'].map((title, i) => ({
  version_id: uuidv7(), case_id: uuidv7(), version_no: 1, title, summary: `Summary of ${title}.`, audience: 'Nurses',
  setting: 'Emergency department', duration_min: 15, learning_objectives: [], published_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), art }));
const axe = async (page, label) => {
  await settled(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => `${label}: ${v.id} ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
};

test.describe('owner', () => {
  let auth, worker, shell;
  test.beforeAll(async () => {
    auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
    worker = await startPublishedWorker({ authOrigin: auth.origin, catalogue: CATALOGUE });
    auth.setJwt(worker.jwt);
    shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: { SUPABASE_URL: auth.origin,
      SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
    auth.setAppOrigin(shell.origin);
  });
  test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });
  const setRole = role => (worker.fake.groups.detailRole = role, worker.fake.replies.set('get_me', args => [{ user_id: worker.userId, display_name: 'Facilitator',
    memberships: [{ workspace_id: worker.workspaceId, name: 'Teaching', role: args.p_admin ? 'admin' : role }], next_after: null, admin: args.p_admin === true }]));
  async function signIn(page, href = casesUrl(shell.origin)) {
    await page.goto(href);
    await page.getByLabel('Email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('One-time code').fill('123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.library-head')).toBeVisible();
  }

  test('[C30-owner] an owner creates, retints with a two-theme preview, assigns from case detail, filters and boards by group, then archives with a disposition', async ({ browser }) => {
    setRole('owner');
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const queries = [], groupReads = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (/\/catalogue$/.test(url.pathname)) queries.push(Object.fromEntries(url.searchParams));
      if (/\/groups$/.test(url.pathname) && request.method() === 'GET' && !url.pathname.includes('/catalogue/')) groupReads.push(url.pathname);
    });
    await signIn(page);
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeFocused();
    await expect(page.getByText('No groups yet. Every case is Ungrouped.')).toBeVisible();
    // Create two groups; the tint is chosen from the ten named choices.
    // Card 68 (SURFACE-06): creation sits behind a New group button; the list is the page.
    await expect(page.getByRole('complementary', { name: 'New group' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New group', exact: true })).toHaveAttribute('aria-expanded', 'false');
    const create = page.getByRole('complementary', { name: 'New group' });
    for (const [name, tint] of [['Emergency', 'Petrol'], ['Critical care', 'Coral']]) {
      await page.getByRole('button', { name: 'New group', exact: true }).click();
      await expect(create.getByLabel('Name', { exact: true })).toBeFocused();
      await create.getByLabel('Name', { exact: true }).fill(name);
      await create.getByRole('radio', { name: tint, exact: true }).check();
      await create.getByRole('button', { name: 'Create group' }).click();
      await expect(page.getByRole('button', { name: `Edit ${name}` })).toBeVisible();
    }
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    await expect(create.getByRole('radio')).toHaveCount(10);
    // A duplicate live name in this workspace is refused, with the reason.
    await create.getByLabel('Name', { exact: true }).fill('emergency');
    await create.getByRole('button', { name: 'Create group' }).click();
    await expect(page.locator('.groups-status')).toHaveText('A live group in this workspace already has that name.');
    // The refusal reloads the list, which collapses the form again.
    await expect(create).toHaveCount(0);
    await axe(page, 'groups list light');
    await shot(page, 'owner-groups-light');
    // Edit: the preview is a real cover in both themes and follows the chosen tint before saving.
    await page.getByRole('button', { name: 'Edit Emergency' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Emergency' })).toBeFocused();
    const previews = page.locator('.tint-preview .cover');
    await expect(previews).toHaveCount(2);
    await page.getByRole('radio', { name: 'Sky', exact: true }).check();
    await expect(previews.nth(0)).toHaveAttribute('data-tint', 'sky');
    await expect(previews.nth(1)).toHaveAttribute('data-tint', 'sky');
    await expect(previews.nth(1)).toHaveAttribute('data-theme', 'dark');
    // Refresh pauses during edits: a refresh trigger while the form is open neither reads nor replaces the draft.
    await page.getByLabel('Description', { exact: true }).fill('Undifferentiated presentations');
    const before = groupReads.length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(400);
    expect(groupReads.length).toBe(before);
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Undifferentiated presentations');
    await axe(page, 'group edit light');
    await shot(page, 'owner-group-edit-light');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250); // let theme transitions settle before axe
    await axe(page, 'group edit dark');
    await shot(page, 'owner-group-edit-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: 'Save group' }).click();
    await expect(page.getByRole('button', { name: 'Edit Emergency' })).toBeFocused();
    await expect(page.getByRole('row', { name: /Emergency/ }).getByRole('cell', { name: 'Sky', exact: true })).toBeVisible();
    // With the list showing and nothing typed, a refresh reads again.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => groupReads.length).toBeGreaterThan(before);
    // Assign from case detail: the facts, the cover tint and the library all follow.
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Present', exact: true }).click();
    await page.locator('.library-list').getByRole('link', { name: 'Bradycardia', exact: true }).click();
    await page.getByRole('button',{name:'Workspace details',exact:true}).click();await page.getByRole('dialog',{name:'Workspace',exact:true}).getByRole('button',{name:'Change group',exact:true}).click();
    const picker = page.getByRole('combobox', { name: 'Group for this case', exact: true });
    await expect(picker).toBeEnabled();
    await chooseOption(picker, 'Emergency');
    await page.getByRole('button', { name: 'Change group' }).click();
    await expect(page.locator('.case-group').getByRole('status')).toHaveText('Moved to Emergency.');
    await expect(page.locator('.case-present-meta .tag')).toHaveText('Emergency');
    await expect(page.locator('.case-detail .cover.large')).toHaveAttribute('data-tint', 'sky');
    await page.getByRole('dialog',{name:'Workspace',exact:true}).getByRole('button',{name:'Close workspace',exact:true}).click();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Present', exact: true }).click();
    const card = page.locator('.case-grid > .case-card').filter({ hasText: 'Bradycardia' });
    await expect(card.locator('.case-meta span').filter({hasText:'Emergency'})).toHaveText('Emergency');
    await expect(card.locator('.cover')).toHaveAttribute('data-tint', 'sky');
    await expect(page.locator('.case-grid > .case-card').filter({ hasText: 'Anaphylaxis' }).locator('.cover')).toHaveAttribute('data-tint', 'neutral');
    // The group filter runs on the server, Ungrouped included.
    await page.locator('.library-filters summary').click();
    const filter = page.getByRole('combobox', { name: 'Group', exact: true });
    await chooseOption(filter, 'Emergency');
    await expect(page.locator('.library-status')).toHaveText('Showing 1 of 1 published case');
    expect(queries.at(-1).group).toMatch(/^[0-9a-f-]{36}$/);
    await chooseOption(filter, 'Ungrouped');
    await expect(page.locator('.library-status')).toHaveText('Showing 4 of 4 published cases');
    expect(queries.at(-1).group).toBe('ungrouped');
    await chooseOption(filter, 'All groups');
    await shot(page, 'library-grid-groups-light');
    // Table: a Group column; every view's cover takes the group's tint.
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: 'Group' })).toBeVisible();
    await expect(page.getByRole('row', { name: /Bradycardia/ }).getByRole('cell', { name: 'Emergency', exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /Bradycardia/ }).locator('.cover')).toHaveAttribute('data-tint', 'sky');
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await expect.poll(() => queries.at(-1)?.sort).toBe('group');
    // Board by Group: every live group, an empty one too, and Ungrouped.
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await chooseOption(page.getByRole('combobox', { name: 'Columns', exact: true }), 'Group');
    await expect.poll(() => queries.at(-1)?.sort).toBe('group');
    for (const name of ['Emergency', 'Critical care', 'Ungrouped']) await expect(page.getByRole('region', { name })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Emergency' }).locator('.cover')).toHaveAttribute('data-tint', 'sky');
    await expect(page.getByRole('region', { name: 'Critical care' }).locator('.case-card')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Ungrouped' }).locator('.case-card')).toHaveCount(4);
    await shot(page, 'library-board-groups-light');
    for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(150); await axe(page, `library board groups ${scheme}`); }
    await shot(page, 'library-board-groups-dark');
    await page.getByRole('button', { name: 'Grid', exact: true }).click(); await page.waitForTimeout(200);
    await shot(page, 'library-grid-groups-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    // Archive: an explicit disposition, the exact name typed; no case is deleted; focus returns to the screen.
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Emergency' }).click();
    await page.getByRole('button', { name: 'Archive group' }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive Emergency?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('1 case uses this group.', { exact: false })).toBeVisible();
    await chooseOption(dialog.getByRole('combobox', { name: 'Move its cases to', exact: true }), 'Critical care');
    await dialog.getByLabel('Type Emergency to confirm').fill('emergency');
    await dialog.getByRole('button', { name: 'Archive group' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Type the group name exactly as shown to confirm.');
    await axe(page, 'archive dialog light');
    await shot(page, 'owner-group-archive-light');
    await dialog.getByLabel('Type Emergency to confirm').fill('Emergency');
    await dialog.getByRole('button', { name: 'Archive group' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.groups-status')).toHaveText('Emergency archived. 1 case moved to Critical care.');
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Edit Emergency' })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Critical care/ }).getByRole('cell', { name: '1', exact: true })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250); // let theme transitions settle before axe
    await axe(page, 'groups list dark');
    await shot(page, 'owner-groups-dark');
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Present', exact: true }).click();
    await expect(page.locator('.library-status')).toHaveText('Showing 5 of 5 published cases');
    await context.close();
  });

  for (const surface of ['Groups', 'case details']) test(`${surface} return keeps the second workspace through the breadcrumb and Create`, async ({ browser }) => {
    setRole('owner');
    const firstWorkspace = uuidv7();
    worker.fake.replies.set('get_me', args => [{ user_id: worker.userId, display_name: 'Facilitator', memberships: [
      {workspace_id:firstWorkspace,name:'Teaching',role:args.p_admin?'admin':'owner'},
      {workspace_id:worker.workspaceId,name:'Albany Education',role:args.p_admin?'admin':'owner'}
    ],next_after:null,admin:args.p_admin===true}]);
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
    try {
      const page=await context.newPage(),scope=caseWorkspaceUrl(worker.workspaceId,'published',shell.origin);
      await signIn(page,scope);await expect(page.getByRole('combobox',{name:'Workspace',exact:true})).toContainText('Albany Education');
      await page.evaluate(()=>window.workspaceNavigationProof='retained');
      const writes=()=>worker.fake.requests.filter(r=>r.name==='create_group').length,before=writes();
      if(surface==='Groups'){
        await page.getByRole('button',{name:'Groups',exact:true}).click();await page.getByRole('button',{name:'New group',exact:true}).click();
        const form=page.getByRole('complementary',{name:'New group',exact:true});await form.getByLabel('Name',{exact:true}).fill('Unsaved second-workspace group');await form.getByRole('radio',{name:'Sage',exact:true}).check();
      }else{await page.locator('.library-list').getByText(CATALOGUE[0].title,{exact:true}).click();await expect(page.locator('#caseDetailTitle')).toHaveText(CATALOGUE[0].title);}
      await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Present',exact:true}).click();
      if(surface==='Groups'){const discard=page.getByRole('dialog',{name:'Discard changes?',exact:true});await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();}
      await expect(page.getByRole('combobox',{name:'Workspace',exact:true})).toContainText('Albany Education');await expect(page).toHaveURL(scope);expect(writes()).toBe(before);
      await page.getByRole('button',{name:'Open menu',exact:true}).click();await expect(page.locator('.site-menu-notice')).toHaveText('');await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:'Create',exact:true}).click();
      await expect(page).toHaveURL(caseWorkspaceUrl(worker.workspaceId,'drafts',shell.origin));await expect(page.getByRole('combobox',{name:'Workspace',exact:true})).toContainText('Albany Education');expect(await page.evaluate(()=>window.workspaceNavigationProof)).toBe('retained');
    } finally {setRole('owner');await context.close();}
  });

  test('Groups protects colour-only drafts, edits, browser history and pending writes without replacing the private document',async({browser})=>{
    setRole('owner');const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});try{const page=await context.newPage();await signIn(page);await page.evaluate(()=>window.groupDocumentProof='retained');
    await page.getByRole('button',{name:'Groups',exact:true}).click();await page.getByRole('button',{name:'New group',exact:true}).click();const form=page.getByRole('complementary',{name:'New group',exact:true}),discard=page.getByRole('dialog',{name:'Discard changes?',exact:true});await form.getByRole('radio',{name:'Sage',exact:true}).check();const readCount=()=>worker.fake.requests.filter(r=>r.name==='list_groups').length;const before=readCount();expect(before).toBeGreaterThan(0);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(250);expect(readCount()).toBe(before);expect(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})).toBe(true);await page.getByRole('button',{name:'New group',exact:true}).click();await expect(discard).toBeVisible();await page.keyboard.press('Escape');await expect(form.getByRole('radio',{name:'Sage',exact:true})).toBeChecked();
    await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:/owner@example.invalid/}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(page.getByRole('dialog',{name:'Menu',exact:true})).not.toBeVisible();await expect(form.getByLabel('Name',{exact:true})).toBeFocused();
    await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Present',exact:true}).click();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(page.locator('.library-list')).toBeVisible();expect(await page.evaluate(()=>window.groupDocumentProof)).toBe('retained');
    await page.getByRole('button',{name:'Groups',exact:true}).click();await page.getByRole('button',{name:'New group',exact:true}).click();await form.getByLabel('Name',{exact:true}).fill('Release guard');let release,started;const held=new Promise(r=>release=r),requested=new Promise(r=>started=r);await page.route('**/api/v1/workspaces/*/groups',async route=>{if(route.request().method()!=='POST')return route.continue();started();await held;await route.continue();},{times:1});await form.getByRole('button',{name:'Create group',exact:true}).click();await requested;try{await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Present',exact:true}).click();await expect(page.locator('.groups-status')).toHaveText('Creating group…');await expect(discard).not.toBeVisible();await expect(form.getByRole('button',{name:'Create group',exact:true})).toBeDisabled();}finally{release();}await page.getByRole('button',{name:'Edit Release guard',exact:true}).click();const name=page.locator('.groups-edit').getByLabel('Name',{exact:true});await name.fill('Unsaved edit');await page.getByRole('button',{name:'← Groups',exact:true}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(name).toHaveValue('Unsaved edit');
    await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:/owner@example.invalid/}).click();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(page.locator('.account-profile')).toBeVisible();expect(await page.evaluate(()=>window.groupDocumentProof)).toBe('retained');expect(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})).toBe(false);
    await page.goBack();await expect(page.locator('.library-list')).toBeVisible();await page.getByRole('button',{name:'Groups',exact:true}).click();await page.getByRole('button',{name:'New group',exact:true}).click();await form.getByLabel('Name',{exact:true}).fill('History draft');await page.route('**/api/v1/workspaces/*/groups',route=>route.fulfill({status:503,json:{error:'unavailable'}}),{times:1});await form.getByRole('button',{name:'Create group',exact:true}).click();await expect(form.getByRole('button',{name:'Create group',exact:true})).toBeEnabled();await expect(form.getByLabel('Name',{exact:true})).toHaveValue('History draft');await page.goBack();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(form.getByLabel('Name',{exact:true})).toHaveValue('History draft');expect(new URL(page.url()).pathname).toBe('/present');await axe(page,'protected groups draft');const nativePrompts=[];page.on('dialog',dialog=>{nativePrompts.push(dialog.type());void dialog.dismiss();});await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:'Join',exact:true}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();await expect.poll(()=>new URL(page.url()).pathname).toBe('/');expect(await page.evaluate(()=>window.groupDocumentProof)).toBeUndefined();expect(nativePrompts).toEqual([]);await page.goto(shell.origin+'/account');await page.locator('.account-profile').getByLabel('Name',{exact:true}).fill('Discarded profile');await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:'Help',exact:true}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();await expect.poll(()=>new URL(page.url()).pathname).toBe('/help');expect(nativePrompts).toEqual([]);
    }finally{await context.close();}
  });

  test('Groups tint swatches draw decorative brand artwork for legacy-only and empty catalogues', async ({ browser }) => {
    setRole('owner');
    for (const empty of [false, true]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.route('**/api/v1/workspaces/*/catalogue**', async route => {
        const response = await route.fetch(), body = await response.json();
        if (Array.isArray(body.cases)) {
          body.cases = empty ? [] : body.cases.map(row => ({ ...row, art: null }));
          if (empty) body.total = 0;
        }
        await route.fulfill({ response, json: body });
      });
      await signIn(page);
      await page.getByRole('button', { name: 'Groups', exact: true }).click();
      await page.getByRole('button', { name: 'New group', exact: true }).click();
      const swatches = page.locator('.tint-choice .cover');
      await expect(swatches).toHaveCount(10);
      await expect(swatches.first()).toHaveAttribute('data-art', 'brand');
      await expect(swatches.first()).toHaveAttribute('aria-hidden', 'true');
      await expect.poll(() => swatches.first().locator('canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(1);
      await expect(page.getByRole('radio', { name: 'Petrol', exact: true })).toBeEnabled();
      await shot(page, empty ? 'artwork-empty-groups' : 'artwork-legacy-groups');
      await context.close();
    }
  });

  test('[C30-owner] the Groups screen and Change group are shown only to owners of the selected workspace', async ({ browser }) => {
    for (const role of ['author', 'facilitator']) {
      setRole(role);
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await signIn(page);
      await expect(page.locator('.library-status')).toHaveText(/Showing/);
      await expect(page.getByRole('button', { name: 'Groups', exact: true })).toHaveCount(0);
      await page.locator('.library-list').getByRole('link', { name: 'Anaphylaxis', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
      await expect(page.locator('.case-present-meta .tag')).toHaveCount(1);
      await page.getByRole('button',{name:'Workspace details',exact:true}).click();
      await expect(page.getByRole('dialog',{name:'Workspace',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'Change group',exact:true})).toHaveCount(0);
      await expect(page.getByLabel('Group for this case')).toHaveCount(0);
      await context.close();
    }
    setRole('owner');
  });
});

test.describe('administration', () => {
  let fixture;
  test.beforeEach(async () => { fixture = await startAdminShell(); });
  test.afterEach(async () => { await fixture?.stop(); fixture = null; });
  async function signIn(page) {
    await page.goto(fixture.origin + '/admin');
    await page.getByLabel('Email', { exact: true }).fill(fixture.email);
    await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await page.getByLabel('One-time code', { exact: true }).fill(fixture.otp);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  }
  // A5: Groups open from Workspaces (one workspace at a time), not from a section of their own.
  const adminNav = (page, name) => page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name, exact: true }).click();
  async function openGroups(page, workspaceName) {
    await adminNav(page, 'Workspaces');
    await page.getByRole('button', { name: workspaceName, exact: true }).click();
    await page.getByRole('button', { name: 'Manage groups', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Groups' })).toBeVisible();
  }

  test('[C30-admin] Administration -> Groups: any workspace, create, edit with the tint preview, archive with type-to-confirm and the session step-up', async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    try {
      await signIn(page);
      // A workspace the admin is not a member of: its groups are managed the same way.
      await openGroups(page, 'Bondi SLSC');
      await expect(page.locator('.groups-status')).toHaveText('No groups in Bondi SLSC yet.');
      const oldCreate = page.getByRole('complementary', { name: 'New group' });
      await expect(oldCreate).toHaveCount(0);
      await page.getByRole('button', { name: 'New group', exact: true }).click();
      await expect(oldCreate).toBeVisible();
      await oldCreate.getByLabel('Name', { exact: true }).fill('Pending workspace draft');
      const teaching = fixture.state.workspaces.find(workspace => workspace.name === 'Teaching');
      const heldTeaching = fixture.hold('group_list');
      const teachingRead = page.waitForRequest(request => request.method() === 'GET' &&
        new URL(request.url()).pathname === apiPath('workspaces', teaching.workspace_id, 'groups'));
      try {
        // Choosing another workspace closes this one's groups screen and its draft; the new one loads on its own.
        await page.getByRole('button', { name: 'Close record', exact: true }).click();
        const discard=page.getByRole('dialog',{name:'Discard changes?',exact:true});await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(oldCreate.getByLabel('Name',{exact:true})).toHaveValue('Pending workspace draft');await page.getByRole('button',{name:'Previous record',exact:true}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(oldCreate.getByLabel('Name',{exact:true})).toHaveValue('Pending workspace draft');await page.getByRole('button',{name:'Close record',exact:true}).click();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();
        await page.getByRole('button', { name: 'Teaching', exact: true }).click();
        await page.getByRole('button', { name: 'Manage groups', exact: true }).click();
        await Promise.all([heldTeaching.ready, teachingRead]);
        await expect(page.locator('.groups-status')).toHaveText('Loading groups…');
        await expect(oldCreate).toHaveCount(0);
        await expect(page.locator('.groups-body').getByRole('button', { name: 'Create group', exact: true })).toHaveCount(0);
        expect(fixture.state.calls.filter(call => call.operation === 'group_create')).toHaveLength(0);
      } finally { heldTeaching.release(); }
      await expect(page.locator('.groups-status')).toHaveText('No groups in Teaching yet.');
      const create = page.getByRole('complementary', { name: 'New group' });
      await expect(create).toHaveCount(0);
      for (const [name, tint] of [['Emergency', 'Petrol'], ['Paediatrics', 'Sage']]) {
        await page.getByRole('button', { name: 'New group', exact: true }).click();
        await create.getByLabel('Name', { exact: true }).fill(name);
        await create.getByRole('radio', { name: tint, exact: true }).check();
        await create.getByRole('button', { name: 'Create group' }).click();
        await expect(page.getByRole('button', { name: `Edit ${name}` })).toBeVisible();
      }
      // Refresh pauses during edits: the admin page's own polling never replaces this screen or a draft.
      await page.getByRole('button', { name: 'New group', exact: true }).click();
      await create.getByLabel('Name', { exact: true }).fill('Draft name');
      const reads = fixture.state.calls.filter(call => call.operation === 'group_list').length;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForTimeout(400);
      expect(fixture.state.calls.filter(call => call.operation === 'group_list').length).toBe(reads);
      await expect(create.getByLabel('Name', { exact: true })).toHaveValue('Draft name');
      await create.getByLabel('Name', { exact: true }).fill('');
      await axe(page, 'admin groups light');
      await shot(page, 'admin-groups-light');
      await page.getByRole('button', { name: 'Edit Emergency' }).click();
      await page.getByRole('radio', { name: 'Plum', exact: true }).check();
      await expect(page.locator('.tint-preview .cover').first()).toHaveAttribute('data-tint', 'plum');
      await axe(page, 'admin group edit light');
      await shot(page, 'admin-group-edit-light');
      await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250); // let theme transitions settle before axe
      await shot(page, 'admin-group-edit-dark');
      await axe(page, 'admin group edit dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('button', { name: 'Save group' }).click();
      await expect(page.getByRole('row', { name: /Emergency/ }).getByRole('cell', { name: 'Plum', exact: true })).toBeVisible();
      // Admin -> Cases: close the workspace record before changing sections.
      await page.getByRole('button', { name: 'Close record', exact: true }).click();
      // A Group column and Change group (no step-up: P-20).
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await expect(page.locator('.workbench-rows')).toContainText('Ungrouped');
      await page.getByRole('button', { name: 'Teaching case', exact: true }).click();
      await page.getByRole('button', { name: 'Change group', exact: true }).click();
      const choose = page.getByRole('combobox', { name: 'Group for this case', exact: true });
      await expect(choose).toBeEnabled();
      await chooseOption(choose, 'Emergency');
      await page.locator('.case-group').getByRole('button', { name: 'Change group', exact: true }).click();
      await expect(page.locator('.workbench-rows')).toContainText('Emergency');
      await shot(page, 'admin-cases-group-light');
      // Archive with the destructive-action protections: typed name, then the email code, one request in flight.
      await openGroups(page, 'Teaching');
      await page.getByRole('button', { name: 'Edit Emergency' }).click();
      const opener = page.getByRole('button', { name: 'Archive group' });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Archive Emergency?' });
      await chooseOption(dialog.getByRole('combobox', { name: 'Move its cases to', exact: true }), 'Paediatrics');
      await dialog.getByLabel('Type Emergency to confirm').fill('Emergency');
      await axe(page, 'admin archive light');
      await shot(page, 'admin-archive-light');
      await dialog.getByRole('button', { name: 'Send verification code' }).click();
      await dialog.getByLabel('Six-digit email code').fill(fixture.stepupCode);
      const held = fixture.hold('group_archive');
      await dialog.getByRole('button', { name: 'Confirm action' }).click();
      await held.ready;
      await expect(dialog.getByRole('button', { name: 'Confirm action' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      held.release();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.groups-status')).toHaveText('Emergency archived. 1 case moved to Paediatrics.');
      const archives = fixture.state.calls.filter(call => call.operation === 'group_archive');
      expect(archives).toHaveLength(1);
      expect(archives[0].elevation).not.toBeNull();
      expect(archives[0].body).toEqual({ expectedRevision: 1, confirmName: 'Emergency', moveTo: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      await expect(page.getByRole('heading', { level: 2, name: 'Groups' })).toBeFocused();
      await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250); // let theme transitions settle before axe
      await axe(page, 'admin groups dark');
      await shot(page, 'admin-groups-dark');
      // One code serves the session: a second archive needs only the typed name.
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('button', { name: 'Edit Paediatrics' }).click();
      await page.getByRole('button', { name: 'Archive group' }).click();
      const second = page.getByRole('dialog', { name: 'Archive Paediatrics?' });
      await second.getByLabel('Type Paediatrics to confirm').fill('Paediatrics');
      await second.getByRole('button', { name: 'Archive group' }).click();
      await expect(page.locator('.groups-status')).toHaveText('Paediatrics archived. 1 case moved to Ungrouped.');
      expect(fixture.state.calls.filter(call => call.operation === 'stepup_verify')).toHaveLength(1);
    } finally { await context.close(); }
  });
});
