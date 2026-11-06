// Facilitator-UX A6 (CASE-336, CASE-337, CASE-338; plan §3 A6; prototypes/admin-people.html, access-model.html): Share on the case page,
// the library's "Shared with you", a case-only runner's and editor's journeys, and Publish versus Send for review. The real local Worker
// with fakes for PostgREST, GoTrue admin and Resend; no live system. Screenshots go to ACCESS_SHOTS_DIR when it is set.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '../src/shared/ids.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { consoleReady, openRoomSetup } from '../tests/helpers/console-v2.mjs';
import { divingSlides } from '../tests/design-critique/harness.mjs';

const SHOTS = process.env.ACCESS_SHOTS_DIR || null;
const POLICIES = { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true };
const INVITEE = 'sam@example.invalid';
let auth, worker, shell, WS, CASE;
let persona = 'owner', policies = POLICIES, labelConfirmed = true, shared = [];
const state = { accounts: [], emails: [], invitations: [], grants: [], created: [], revoked: [], resent: [], revokedInvites: [] };
test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

// What each person holds on the case: a workspace role, a case grant, or both.
const WHO = { owner: { member: 'owner', grant: null, role: 'owner', scope: 'workspace' }, facilitator: { member: 'facilitator', grant: null, role: 'facilitator', scope: 'workspace' },
  runner: { member: null, grant: 'run', role: 'facilitator', scope: 'case' }, editor: { member: null, grant: 'edit', role: 'author', scope: 'case' },
  author: { member: 'author', grant: null, role: 'author', scope: 'workspace' } };

test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null, email: 'sam@example.invalid' });
  worker = await startPublishedWorker({ authOrigin: auth.origin, email: 'sam@example.invalid', bindings: { RESEND_INVITE_API_KEY: 're_test_only' },
    outbound: async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://api.resend.com' && url.pathname === '/emails' && request.method === 'POST') { state.emails.push(await request.json()); return Response.json({ id: `fake-${state.emails.length}` }); }
      if (url.origin === auth.origin && url.pathname === '/auth/v1/admin/users') {
        if (request.method === 'GET') return Response.json({ users: state.accounts });
        const body = await request.json(), made = { id: uuidv7(), email: body.email, email_confirmed_at: new Date().toISOString(), confirmed_at: new Date().toISOString(), invited_at: null, banned_until: null, created_at: new Date().toISOString() };
        state.accounts.push(made); return Response.json(made);
      }
      return null;
    } });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  WS = worker.workspaceId; CASE = worker.caseId;
  const r = worker.fake.replies, now = () => new Date().toISOString();
  const held = () => WHO[persona];
  r.set('get_me', args => { const w = held(); return [{ user_id: args.p_user_id, display_name: 'Sam Lee', facilitator_role: 'Intensivist', label_confirmed_at: labelConfirmed ? now() : null, next_after: null, admin: false,
    memberships: w.member ? [{ workspace_id: WS, slug: 'nicu', name: 'Northern ICU', role: w.member, policies }] : [],
    grants: w.grant ? [{ case_id: CASE, workspace_id: WS, workspace_name: 'Northern ICU', title: 'Published case', level: w.grant, policies },
      ...shared.filter(row => row.caseId !== CASE).map(row => ({ case_id: row.caseId, workspace_id: row.workspaceId, workspace_name: row.workspaceName, title: row.title, level: row.level, policies }))] : [] }]; });
  r.set('get_access', args => { const w = held(); return args.p_case_id === CASE ? [{ case_id: CASE, workspace_id: WS, member_role: w.member, grant_level: w.grant, role: w.role, scope: w.scope, policies }] : []; });
  r.set('set_own_facilitator_label', args => { labelConfirmed = true; return [{ display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: now() }]; });
  r.set('list_shared_cases', () => shared.map(row => ({ grant_id: row.grantId, case_id: row.caseId, workspace_id: row.workspaceId, workspace_name: row.workspaceName, title: row.title, level: row.level,
    member_role: held().member, version_id: row.versionId ?? null, version_no: row.versionNo ?? null, withdrawn: row.withdrawn === true, has_draft: row.hasDraft === true, granted_at: now() })));
  r.set('list_case_access', () => ({ caseId: CASE, workspaceId: WS,
    members: [{ userId: uuidv7(), name: 'Julian Ming', role: 'owner' }, { userId: uuidv7(), name: 'A. Kaur', role: 'author' }, { userId: uuidv7(), name: 'T. Reid', role: 'facilitator' }],
    grants: state.grants.filter(g => !state.revoked.includes(g.grantId)).map(g => ({ grantId: g.grantId, userId: g.userId, name: g.name, level: g.level, grantedAt: now() })),
    invitations: state.invitations.filter(i => !state.revokedInvites.includes(i.invitationId)).map(i => ({ invitationId: i.invitationId, email: i.email, level: i.level, createdAt: now(), expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), sendState: 'sent' })) }));
  r.set('revoke_case_grant', args => { state.revoked.push(args.p_grant_id); return { outcome: 'revoked', grantId: args.p_grant_id }; });
  r.set('admin_read_profiles', []);
  r.set('create_invitation', args => {
    state.created.push(args);
    const row = { invitationId: uuidv7(), email: args.p_email, level: args.p_level, caseId: args.p_case_id };
    if (args.p_case_id) state.invitations.push(row);
    return { outcome: 'created', invitationId: row.invitationId, email: row.email, level: row.level, workspaceId: WS, workspaceName: 'Northern ICU', caseId: args.p_case_id, caseTitle: args.p_case_id ? 'Published case' : null,
      inviterName: 'Julian Ming', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() };
  });
  r.set('resend_invitation', args => { state.resent.push(args.p_invitation_id); const row = state.invitations.find(i => i.invitationId === args.p_invitation_id);
    return { outcome: 'resend', invitationId: row.invitationId, email: row.email, level: row.level, workspaceId: WS, workspaceName: 'Northern ICU', caseId: CASE, caseTitle: 'Published case', inviterName: 'Julian Ming', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() }; });
  r.set('revoke_invitation', args => { state.revokedInvites.push(args.p_invitation_id); return { outcome: 'revoked' }; });
  r.set('record_invitation_delivery', args => ({ outcome: 'recorded', sendState: args.p_outcome }));
  r.set('version_case', CASE);
  // Records: an empty page for the person's own rooms (SQL filters them; proved in db and unit tests).
  r.set('query_session_portfolio', { rooms: [], nextAfter: null });
  r.set('query_teaching_session_portfolio', args => { expect(args.p_personal).toBe(true);expect(args.p_admin).toBe(false);expect(args.p_workspace_id).toBe(WS);return { rooms: [], nextAfter: null }; });
  r.set('personal_teaching_portfolio_stats', {asOf:now(),firstSessionAt:null,sessions:0,active:0,ended:0,completeRecords:0,uniqueVersions:0,recordedTeachingSeconds:0});
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });
test.beforeEach(() => { persona = 'owner'; policies = POLICIES; labelConfirmed = true; shared = []; Object.assign(state, { accounts: [], emails: [], invitations: [], grants: [], created: [], revoked: [], resent: [], revokedInvites: [] });
  worker.fake.groups.detailRole = null; worker.fake.requests.length = 0; });

async function signIn(page, path = '/cases') {
  page.on('pageerror', error => { throw error; });
  await page.goto(`${shell.origin}${path}`);
  await page.getByLabel('Email').fill('sam@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function settle(page) { await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0); }
async function axe(page) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await settle(page);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await settle(page); await page.screenshot({ path: join(SHOTS, `access-${name}-${scheme}.png`), fullPage: true }); }
  await page.emulateMedia({ colorScheme: 'light' });
}
const detailRole = role => { worker.fake.groups.detailRole = role; };
async function openPublished(page) { await page.locator('.library-list').getByRole('link', { name: 'Published case', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Published case', level: 1 })).toBeVisible(); }

test('[AS-205] an owner shares one case as Can edit: the dialog offers the scope and level, lists who holds it, and ends access in words', async ({ page }) => {
  await signIn(page);
  await openPublished(page);
  await page.getByRole('button', { name: 'Share case', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share “Published case”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The email names you and this case. The invitation lasts 90 days.')).toBeVisible();
  // Scope and level, as in the mockup.
  await expect(dialog.getByRole('radio', { name: /This case only/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /Every case in Northern ICU/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Can run', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Can edit', exact: true }).click();
  await expect(dialog.getByText('They can open, edit and run this case. They cannot create cases or see the rest of the workspace.')).toBeVisible();
  await dialog.getByLabel('Email addresses').fill(INVITEE);
  state.grants.push({ grantId: uuidv7(), userId: uuidv7(), name: 'P. Okoro', level: 'run' });
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText(`Invitation sent to ${INVITEE}: Can edit on this case.`)).toBeVisible();
  expect(state.created).toHaveLength(1);
  expect(state.created[0]).toMatchObject({ p_workspace_id: WS, p_case_id: CASE, p_level: 'edit', p_email: INVITEE });
  expect(state.emails).toHaveLength(1);
  // Who has access: the workspace, the case-only people, and what is waiting, with Resend and Revoke.
  const people = dialog.getByRole('region', { name: 'Who has access' });
  await expect(people.getByText('Everyone in Northern ICU (3) can use this case')).toBeVisible();
  await expect(people.getByText('P. Okoro')).toBeVisible();
  await expect(people.getByText(INVITEE)).toBeVisible();
  await axe(page);
  await shoot(page, 'share');
  await people.getByRole('button', { name: `Resend the invitation to ${INVITEE}` }).click();
  await expect(dialog.getByText(`Invitation sent to ${INVITEE}`).last()).toBeVisible();
  expect(state.resent).toHaveLength(1);
  // Ending access says what it does first, then does it.
  await people.getByRole('button', { name: 'Remove P. Okoro’s access to this case' }).click();
  await expect(people.getByText('Remove P. Okoro’s direct case access? Workspace or other shared access can still apply. Existing records keep their access rules.')).toBeVisible();
  await people.getByRole('button', { name: 'Remove access', exact: true }).click();
  await expect(dialog.getByText('P. Okoro’s direct case access was removed. Other access may still apply.')).toBeVisible();
  expect(state.revoked).toHaveLength(1);
  await people.getByRole('button', { name: `Revoke the invitation to ${INVITEE}` }).click();
  await expect(people.getByText(`The link in the email to ${INVITEE} stops working at once. They can be invited again.`)).toBeVisible();
  await people.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await expect(dialog.getByText(`The invitation to ${INVITEE} is revoked. Its link no longer works.`)).toBeVisible();
  expect(state.revokedInvites).toHaveLength(1);
  // A whole workspace is its own choice, and says that they will see every case.
  await dialog.getByRole('radio', { name: /Every case in Northern ICU/ }).check();
  await expect(dialog.getByText('They will see every case in Northern ICU and can create and edit cases there.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Can run', exact: true }).click();
  await expect(dialog.getByText('They will see and run every case in Northern ICU. They cannot edit.')).toBeVisible();
  await dialog.getByLabel('Email addresses').fill('lee@example.invalid');
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText('Invitation sent to lee@example.invalid: Can run on every case in Northern ICU.')).toBeVisible();
  expect(state.created.at(-1).p_case_id).toBeNull();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog',{name:'Discard changes?',exact:true}).getByRole('button',{name:'Discard changes',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share case', exact: true })).toBeFocused();
});

test('[AS-205] a runner shares only to run, and only where the workspace lets runners share; the page offers nothing else', async ({ page }) => {
  persona = 'facilitator'; detailRole('facilitator');
  await signIn(page);
  await openPublished(page);
  await expect(page.getByRole('button', { name: 'Share case', exact: true })).toHaveCount(0);
  policies = { ...POLICIES, runners_share: true };
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Published case', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Share case', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share “Published case”' });
  await expect(dialog.getByText('Your access lets you share to run only.')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Every case in/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Can edit', exact: true })).toHaveCount(0);
  const people = dialog.getByRole('region', { name: 'Who has access' });
  await expect(people.getByText('Everyone in Northern ICU (3) can use this case')).toBeVisible();
  await expect(people.getByRole('button', { name: /Remove .* access|Revoke|Resend/ })).toHaveCount(0);
  // An empty field and a bad address are said in words, and nothing is sent.
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText('Enter at least one email address.')).toBeVisible();
  await dialog.getByLabel('Email addresses').fill('not-an-address');
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText('not-an-address is not a valid email address.')).toBeVisible();
  expect(state.created).toHaveLength(0);
  await dialog.getByLabel('Email addresses').fill(INVITEE);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText(`Invitation sent to ${INVITEE}: Can run on this case.`)).toBeVisible();
  expect(state.created[0]).toMatchObject({ p_level: 'run', p_case_id: CASE });
});

test('[AS-205] [AS-214] a case-only editor sees the library as "Shared with you", opens the case and its drafts, and cannot create a case', async ({ page }) => {
  persona = 'editor'; detailRole('author');
  shared = [{ grantId: uuidv7(), caseId: CASE, workspaceId: WS, workspaceName: 'Northern ICU', title: 'Published case', level: 'edit', versionId: worker.versionId, versionNo: 1, hasDraft: true },
    { grantId: uuidv7(), caseId: uuidv7(), workspaceId: WS, workspaceName: 'Northern ICU', title: 'Asthma in progress', level: 'edit', hasDraft: true }];
  await signIn(page);
  const shown = page.getByRole('region', { name: 'Shared with you' });
  await expect(shown.getByRole('heading', { name: 'Shared with you', level: 2 })).toBeVisible();
  await expect(shown.getByRole('heading', { name: 'Northern ICU', level: 3 })).toBeVisible();
  await expect(shown.getByRole('link', { name: 'Published case' })).toBeVisible();
  await expect(shown.getByText('Draft, not published yet')).toBeVisible();
  // No workspace, so no picker, search, filters or New case.
  await expect(page.getByRole('button', { name: 'New case', exact: true })).toHaveCount(0);
  await expect(page.getByRole('searchbox',{name:'Search cases'})).toBeHidden();
  await axe(page);
  await shoot(page, 'library-editor');
  await shown.getByRole('link', { name: 'Published case' }).click();
  await expect(page.getByRole('heading', { name: 'Published case', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit case', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
  // The case page for a person who holds the case alone shows no workspace-only group tools.
  await expect(page.getByText('Loading group tools…')).toHaveCount(0);
  expect(worker.fake.requests.filter(req => req.name === 'get_case_group')).toHaveLength(0);
  // Their drafts: the shared draft is listed under Drafts; the Builder entry is in the menu.
  await page.goBack();
  await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('link',{name:'Create',exact:true}).click();
  const drafts = page.getByRole('region', { name: 'Shared drafts' });
  await expect(drafts.getByRole('link', { name: 'Asthma in progress' })).toBeVisible();
  await expect(drafts.getByRole('link', { name: 'Published case' })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: 'Present', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: 'Create', exact: true })).toBeVisible();
});

test('[AS-207] a case-only runner signs in (name and role saved), starts the shared case, re-mints the console and reads only their own records', async ({ page, browser }) => {
  persona = 'runner'; detailRole('facilitator'); labelConfirmed = false;
  shared = [{ grantId: uuidv7(), caseId: CASE, workspaceId: WS, workspaceName: 'Northern ICU', title: 'Published case', level: 'run', versionId: worker.versionId, versionNo: 1 }];
  await signIn(page);
  // First sign-in: the profile step comes before anything else, for a grant as for a membership.
  await expect(page.getByRole('heading', { name: 'Your name and role' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Sam Lee');
  await page.getByLabel('Role', { exact: true }).fill('Intensivist');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  const shown = page.getByRole('region', { name: 'Shared with you' });
  await expect(shown.getByRole('link', { name: 'Published case' })).toBeVisible();
  await expect(shown.getByText('Can run', { exact: true })).toBeVisible();
  expect(worker.fake.requests.some(req => req.name === 'set_own_facilitator_label')).toBe(true);
  await shown.getByRole('link', { name: 'Published case' }).click();
  await expect(page.getByRole('button', { name: 'Edit case', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share case', exact: true })).toHaveCount(0);
  const created = shell.waitForCreatedRoom();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog',{name:'Present case',exact:true}).getByRole('button',{name:'Present',exact:true}).click();
  const { sessionId } = await created;
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true, level: 1 })).toBeVisible();
  await consoleReady(page);
  const pcContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const pc = await pcContext.newPage();
    await pc.goto(`${shell.origin}/P`);
    const pcCode = pc.getByLabel('PC approval code');
    await expect(pcCode).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
    await openRoomSetup(page);
    const section = page.locator('.console-shared-computer');
    await section.getByRole('textbox', { name: 'Computer code' }).fill((await pcCode.textContent()).replace(/\s/g, ''));
    await section.getByRole('button', { name: 'Review computer' }).click();
    await page.getByRole('dialog', { name: /^Use this computer for room/ }).getByRole('button', { name: /^Approve room/ }).click();
    await consoleReady(pc);
    await expect(pc.getByRole('status').filter({ hasText: 'PC ready' })).toBeVisible();
  } finally { await pcContext.close(); }
  // Takeover returns the first console to its case page. Keep the immutable room ID from creation.
  await expect(page).toHaveURL(`${shell.origin}/cases/${CASE}/v/1`);
  // The console credential is minted again for the person who still holds the case.
  const jwt = worker.jwt;
  const again = await fetch(`${worker.origin}/api/v1/sessions/${sessionId}/facilitator-token`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: '{}' });
  const againBody = await again.json();
  expect([200, 201], JSON.stringify(againBody)).toContain(again.status);
  expect(typeof againBody.facilitatorToken).toBe('string');
  // An invitation lands on the bare case address; for a person who holds the case alone it opens the case.
  await page.goto(`${shell.origin}/cases/${CASE}`);
  await expect(page.getByRole('heading', { name: 'Published case', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
  // Their records: the workspace they hold a case in is in the picker, labelled as case access.
  await page.goto(`${shell.origin}/history`);
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveText('Northern ICU · Case access');
  await expect(page.getByText('Sessions are unavailable')).toHaveCount(0);
  await expect.poll(()=>worker.fake.requests.filter(r=>r.name==='query_teaching_session_portfolio'&&r.args.p_personal===true).length).toBeGreaterThan(0);
  await expect(page.locator('.portfolio-rows [data-session]')).toHaveCount(0);
  await expect(page.getByText('No sessions match these filters.',{exact:true})).toBeVisible();
});

test('[AS-214] Shared with you groups by workspace; a withdrawn shared case is listed and cannot be started; a share that ends leaves the library', async ({ page }) => {
  persona = 'runner'; detailRole('facilitator');
  const other = { workspaceId: uuidv7(), name: 'Bondi SLSC' };
  shared = [{ grantId: uuidv7(), caseId: CASE, workspaceId: WS, workspaceName: 'Northern ICU', title: 'Published case', level: 'run', versionId: worker.versionId, versionNo: 1 },
    { grantId: uuidv7(), caseId: uuidv7(), workspaceId: other.workspaceId, workspaceName: other.name, title: 'Drowning at the flags', level: 'run', withdrawn: true },
    { grantId: uuidv7(), caseId: uuidv7(), workspaceId: other.workspaceId, workspaceName: other.name, title: 'Spinal on the beach', level: 'edit', hasDraft: true }];
  await signIn(page);
  const shown = page.getByRole('region', { name: 'Shared with you' });
  await expect(shown.getByRole('heading', { level: 3 })).toHaveText(['Northern ICU', 'Bondi SLSC']);
  const bondi = shown.getByRole('region', { name: 'Bondi SLSC' });
  // Withdrawn: still listed, in words, with no way to open or start it.
  await expect(bondi.getByText('Drowning at the flags')).toBeVisible();
  await expect(bondi.getByText('Withdrawn. It cannot be started until it is republished.')).toBeVisible();
  await expect(bondi.getByRole('link', { name: 'Drowning at the flags' })).toHaveCount(0);
  await expect(bondi.getByText('Withdrawn', { exact: true })).toBeVisible();
  // A draft-only case reaches only a Can edit grant, through its draft.
  await expect(bondi.getByRole('link', { name: 'Spinal on the beach' })).toHaveAttribute('href', /\/cases\/[0-9a-f-]{36}\/edit$/);
  await axe(page);
  await shoot(page, 'library');
  // The live shared case starts.
  await shown.getByRole('link', { name: 'Published case' }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog',{name:'Present case',exact:true}).getByRole('button',{name:'Present',exact:true}).click();
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true, level: 1 })).toBeVisible();
  // A share that ends (revoked, or its case archived: SQL ends both, audited) leaves the list on the next load.
  shared = [];
  persona = 'runner';
  await page.goto(`${shell.origin}/cases`);
  await expect(page.getByRole('region', { name: 'Shared with you' })).toHaveCount(0);
});

// ── Publish versus Send for review, by role and policy ──────────────────────────────────────────────────────
async function openBuilder(page, { role, publishes }) {
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const pair = await divingSlides();
  let revision = 1; const windows = new Map(), readinessCalls = [];
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${CASE}`), async route => {
    const request = route.request(), method = request.method(), suffix = new URL(request.url()).pathname.split(`/cases/${CASE}/`)[1] ?? '';
    if (suffix === 'draft' && method === 'GET') return reply(route, { case: { caseId: CASE, workspaceId: WS, role, publishes, title: pair.document.title, sourceVersion: null, capabilities: ['slide_composition'] },
      revision, draft: { revision, ...structuredClone(pair), intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'save-windows' && method === 'POST') { const id = uuidv7(); windows.set(id, revision); return reply(route, { operationId: id, baseRevision: revision }); }
    if (suffix === 'readiness' && method === 'POST') { readinessCalls.push(request.postDataJSON()); return reply(route, { ready: false, revision, issues: [] }); }
    if (suffix === 'checkpoints') return reply(route, { checkpoints: [] });
    if (suffix === 'candidates' && method === 'GET') return reply(route, { candidates: [] });
    return reply(route, { error: 'not_found' }, 404);
  });
  await signIn(page, `/cases/${CASE}/edit`);
  await expect(page.locator('.builder-studio')).toBeVisible();
  return readinessCalls;
}
for (const [label, persona_, role, policy, publishes, expected] of [
  ['an owner publishes', 'owner', 'owner', POLICIES, true, 'Publish'],
  ['an editor sends for review while editors_publish is off', 'author', 'author', POLICIES, false, 'Send for review'],
  ['an editor publishes once the workspace lets editors publish', 'author', 'author', { ...POLICIES, editors_publish: true }, true, 'Publish'],
  ['a case-only editor sends for review', 'editor', 'author', POLICIES, false, 'Send for review'],
]) {
  test(`[AS-211] ${label}: the Builder says ${expected}`, async ({ page }) => {
    persona = persona_; policies = policy;
    await page.setViewportSize({ width: 1440, height: 900 });
    const readinessCalls = await openBuilder(page, { role, publishes });
    const primary = page.getByRole('button', { name: expected, exact: true });
    await expect(primary.first()).toBeVisible();
    await expect(page.getByRole('button', { name: expected === 'Publish' ? 'Send for review' : 'Publish', exact: true })).toHaveCount(0);
    // Opening the publishing view, its own button says the same thing.
    await primary.first().click();
    const review = page.getByRole('region', { name: 'Awaiting case review' });
    await expect(review.getByRole('button', { name: expected, exact: true })).toBeVisible();
    if (publishes) {
      await expect.poll(() => readinessCalls).toEqual([{ revision: 1 }]);
      await expect(review.getByRole('status')).toContainText('Publishing needs attention');
      await expect(page.getByRole('dialog', { name: 'Confirm publication' })).toHaveCount(0);
    } else {
      expect(readinessCalls).toEqual([]);
    }
  });
}
