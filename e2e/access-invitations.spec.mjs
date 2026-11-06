// Facilitator-UX A4 (CASE-339, CASE-340, CASE-341; plan §3 A4, prototypes/invite-email.html): an administrator invites an
// address as Can run; Case's own email arrives (fake Resend) with one /i/#<ref> link; the page shows "Join <place>" with the
// address filled in; sign-in by code accepts the invitation from /me and lands with "You've joined … as …". Ended, revoked
// and resent references say so without the address. The real local Worker with fakes for PostgREST, GoTrue admin and
// Resend; no live system. Screenshots go to ACCESS_SHOTS_DIR when it is set.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { authEmail, AUTH_EMAIL_KINDS, operationalAlertHtml } from '../src/shared/email-family.mjs';
import { inviteMessage, inviteHtml } from '../src/worker/invite-email.mjs';
import { emailArtUrl } from '../src/shared/urls.mjs';
import { join } from 'node:path';
import { uuidv7 } from '../src/shared/ids.mjs';
import { signTestJwt } from '../src/worker/auth.mjs';
import { TEST_JWT_SECRET } from '../tests/helpers/local-worker.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';

const INVITEE = 'invitee@example.invalid', ADMIN = 'admin@example.invalid', ADMIN_ID = uuidv7();
const SHOTS = process.env.ACCESS_SHOTS_DIR || null;
let auth, worker, shell, adminJwt;
const state = { accounts: [], invitations: [], emails: [], accepted: false };
const hashOf = ref => state.invitations.find(row => row.hash === ref);
test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

// Even the real-Worker invitation preview must never request the deployed branding host.
test.beforeEach(async ({ page }) => {
  await page.route('https://case.iatrogenic.app/**', route => route.request().url() === emailArtUrl()
    ? route.fulfill({ contentType: 'image/jpeg', body: readFileSync(new URL(`../public${new URL(emailArtUrl()).pathname}`, import.meta.url)) })
    : route.abort());
});

test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null, email: INVITEE, otp: '012345' });
  worker = await startPublishedWorker({ authOrigin: auth.origin, actors: [ADMIN_ID], email: INVITEE,
    bindings: { ADMIN_EMAILS: ADMIN, RESEND_INVITE_API_KEY: 're_test_only' },
    // GoTrue admin and Resend, as local fakes: the account Case creates, and the email Case sends.
    outbound: async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://api.resend.com' && url.pathname === '/emails' && request.method === 'POST') {
        state.emails.push({ ...(await request.json()), idempotencyKey: request.headers.get('idempotency-key') });
        return Response.json({ id: `fake-${state.emails.length}` });
      }
      if (url.origin === auth.origin && url.pathname === '/auth/v1/admin/users') {
        if (request.method === 'GET') return Response.json({ users: state.accounts });
        const body = await request.json();
        if (body.email_confirm !== true) return Response.json({ error: 'confirm_required' }, { status: 400 });
        const made = { id: worker.userId, email: body.email, email_confirmed_at: new Date().toISOString(), confirmed_at: new Date().toISOString(), invited_at: null, banned_until: null, created_at: new Date().toISOString() };
        state.accounts.push(made); return Response.json(made);
      }
      return null;
    } });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  adminJwt = await signTestJwt({ sub: ADMIN_ID, aud: 'authenticated', role: 'authenticated', session_id: uuidv7(), email: ADMIN,
    iss: `${auth.origin}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_JWT_SECRET);
  const policies = { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true };
  const facts = row => ({ invitationId: row.id, email: row.email, level: row.level, workspaceId: worker.workspaceId, workspaceName: 'Northern ICU',
    caseId: null, caseTitle: null, inviterName: 'Julian Ming', expiresAt: row.expiresAt });
  const r = worker.fake.replies;
  r.set('get_me', args => [{ user_id: args.p_user_id, display_name: args.p_admin ? 'Julian Ming' : 'Facilitator', next_after: null, admin: args.p_admin === true, grants: [],
    memberships: args.p_admin ? [{ workspace_id: worker.workspaceId, slug: 'nicu', name: 'Northern ICU', role: 'admin', policies }]
      : state.accepted ? [{ workspace_id: worker.workspaceId, slug: 'nicu', name: 'Northern ICU', role: 'facilitator', policies }] : [] }]);
  r.set('admin_read_profiles', []);
  r.set('create_invitation', args => {
    const row = { id: uuidv7(), email: args.p_email, level: args.p_level, hash: args.p_ref_hash, status: 'pending', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() };
    state.invitations.push(row); return { outcome: 'created', ...facts(row) };
  });
  r.set('resend_invitation', args => { const row = state.invitations.find(item => item.id === args.p_invitation_id);
    if (row.status !== 'pending') return { outcome: 'ended' }; row.hash = args.p_ref_hash; return { outcome: 'resend', ...facts(row) }; });
  r.set('revoke_invitation', args => { const row = state.invitations.find(item => item.id === args.p_invitation_id); row.status = 'revoked'; return { outcome: 'revoked' }; });
  r.set('record_invitation_delivery', args => ({ outcome: 'recorded', sendState: args.p_outcome }));
  r.set('peek_invitation', args => { const row = hashOf(args.p_ref_hash);
    return row?.status === 'pending' ? [{ email: row.email, inviter_name: 'Julian Ming', workspace_name: 'Northern ICU', case_title: null, level: row.level }] : []; });
  r.set('accept_invitations', args => {
    const rows = state.invitations.filter(row => row.email === args.p_email && row.status === 'pending');
    for (const row of rows) row.status = 'accepted';
    if (rows.length) state.accepted = true;
    return rows.map(row => { const { email, ...rest } = facts(row); return { ...rest, change: 'new' }; });
  });
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });
// Each case can be selected alone by CI's balanced shard grep.
test.beforeEach(() => { state.accounts.length = 0; state.invitations.length = 0; state.emails.length = 0; state.accepted = false; worker.fake.requests.length = 0; });

const api = (path, body) => fetch(`${worker.origin}/api/v1${path}`, { method: 'POST',
  headers: { authorization: `Bearer ${adminJwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const linkOf = email => new URL(/https?:\/\/[^\s]+\/i\/#[A-Za-z0-9_-]{43}/.exec(email.text)[0]);
const pageFor = link => `${shell.origin}/i/${link.hash}`;
async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0); await page.screenshot({ path: join(SHOTS, `access-invite-${name}-${scheme}.png`), fullPage: true }); }
  await page.emulateMedia({ colorScheme: 'light' });
}
async function axe(page) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    // A theme switch animates colours; axe reads the settled ones.
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('[AS-204] an admin invites an address as Can run: the email, /i/#… with the address, the code, and the landing', async ({ page }) => {
  const created = await api('/invitations', { workspaceId: worker.workspaceId, level: 'run', email: INVITEE });
  const body = await created.json();
  expect(created.status).toBe(201); expect(body.outcome).toBe('sent'); expect(body.account).toBe('new');
  expect(state.accounts.map(a => a.email)).toEqual([INVITEE]);
  // Case's own email: one link, /i/#<ref>, reply-to the inviter; nothing personal in the URL.
  expect(state.emails).toHaveLength(1);
  const [email] = state.emails;
  expect(email.to).toEqual([INVITEE]); expect(email.reply_to).toEqual([ADMIN]); expect(email.idempotencyKey).toMatch(/^case-invite:/);
  const link = linkOf(email);
  expect(link.pathname).toBe('/i/'); expect(link.search).toBe('');
  await page.setContent(email.html);
  await expect.poll(() => page.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await page.locator('a').evaluateAll(as => as.map(a => a.getAttribute('href')))).toEqual([link.href]);
  await expect(page.getByText('Julian Ming invited you to Northern ICU', { exact: true })).toBeVisible();
  await shoot(page, 'email');

  await page.goto(pageFor(link));
  await expect(page.getByRole('heading', { name: 'Join Northern ICU' })).toBeVisible();
  await expect(page.getByText('Julian Ming invited you with Can run access.')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(INVITEE);
  expect(new URL(page.url()).hash, 'the reference leaves the address bar at once').toBe('');
  await axe(page);
  await shoot(page, 'page');

  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  const otp = page.getByLabel('One-time code');
  await expect(otp).toHaveAttribute('type', 'text');
  await expect(otp).toHaveAttribute('inputmode', 'numeric');
  await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(otp).toHaveAttribute('pattern', '[0-9]{6}');
  await expect(otp).toBeFocused();
  await otp.fill('012345');
  await expect(otp).toHaveValue('012345');
  await otp.press('Enter');
  const landing = page.locator('section.invite-landing');
  await expect(landing.getByRole('heading', { name: 'Welcome to Case' })).toBeVisible();
  await expect(landing).toContainText('You’ve joined Northern ICU with Can run access, invited by Julian Ming.');
  expect(new URL(page.url()).pathname).toBe('/present');
  expect(worker.fake.requests.filter(req => req.name === 'accept_invitations').map(req => req.args)).toEqual([{ p_user_id: worker.userId, p_email: INVITEE }]);
  await axe(page);
  await shoot(page, 'landing');
  await landing.getByRole('button', { name: 'Open Present' }).click();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
});

test('[AS-208] signing in with another address explains the mismatch and leaves the invitation pending', async ({ page }) => {
  const previouslyAccepted = state.accepted;
  await api('/invitations', { workspaceId: worker.workspaceId, level: 'run', email: 'someone-else@example.invalid' });
  await page.goto(pageFor(linkOf(state.emails.at(-1))));
  await page.getByLabel('Email').fill(INVITEE);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  const otp = page.getByLabel('One-time code');
  await expect(otp).toHaveAttribute('type', 'text');
  await expect(otp).toHaveAttribute('inputmode', 'numeric');
  await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(otp).toHaveAttribute('pattern', '[0-9]{6}');
  await expect(otp).toBeFocused();
  await otp.fill('012345');
  await expect(otp).toHaveValue('012345');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('This invitation is for a different email address. Sign out and use the invited address to join.', { exact: true })).toBeVisible();
  expect(state.invitations.at(-1).status).toBe('pending');
  expect(state.accepted).toBe(previouslyAccepted);
});

test('[AS-208] an ended, revoked or replaced reference says so in words and never shows the address', async ({ page }) => {
  const ended = async url => {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'This invitation has ended' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(INVITEE);
    await expect(page.getByLabel('Email')).toHaveCount(0);
  };
  await ended(`${shell.origin}/i/#${'Z'.repeat(43)}`);
  await axe(page);
  await ended(`${shell.origin}/i/#not-a-reference`);
  // Create and accept our own invitation: another test may run on a different shard.
  const created = await api('/invitations', { workspaceId: worker.workspaceId, level: 'run', email: INVITEE });
  expect(created.status).toBe(201);
  expect((await created.json()).outcome).toBe('sent');
  const acceptedLink = linkOf(state.emails.at(-1));
  const accepted = await fetch(`${worker.origin}/api/v1/me`, { headers: { authorization: `Bearer ${worker.jwt}` } });
  expect(accepted.status).toBe(200);
  expect(state.invitations.at(-1).status).toBe('accepted');
  await ended(pageFor(acceptedLink));
});

test('[AS-209] Resend sends a fresh link and ends the old one; Revoke ends the new one at once', async ({ page }) => {
  state.accepted = false;
  const created = await (await api('/invitations', { workspaceId: worker.workspaceId, level: 'run', email: 'second@example.invalid' })).json();
  expect(created.outcome).toBe('sent');
  const first = linkOf(state.emails.at(-1));
  const resent = await api(`/workspaces/${worker.workspaceId}/invitations/${created.invitation.id}/resend`, {});
  expect([resent.status, (await resent.json()).outcome]).toEqual([200, 'sent']);
  const second = linkOf(state.emails.at(-1));
  expect(second.hash).not.toBe(first.hash);
  expect(state.emails.at(-1).idempotencyKey).not.toBe(state.emails.at(-2).idempotencyKey);
  await page.goto(pageFor(first));
  await expect(page.getByRole('heading', { name: 'This invitation has ended' })).toBeVisible();
  await page.goto(pageFor(second));
  await expect(page.getByLabel('Email')).toHaveValue('second@example.invalid');
  const revoked = await api(`/workspaces/${worker.workspaceId}/invitations/${created.invitation.id}/revoke`, {});
  expect(await revoked.json()).toEqual({ outcome: 'revoked' });
  await page.goto(pageFor(second));
  await expect(page.getByRole('heading', { name: 'This invitation has ended' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('second@example.invalid');
  const again = await api(`/workspaces/${worker.workspaceId}/invitations/${created.invitation.id}/resend`, {});
  expect([again.status, (await again.json()).error]).toEqual([409, 'invitation_ended']);
});

for (const theme of ['light', 'dark']) test(`shared email family: ${theme}, narrow/desktop, blocked images and stripped CSS`, async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/*', route => route.request().url() === emailArtUrl()
    ? route.fulfill({ contentType: 'image/jpeg', body: readFileSync(new URL(`../public${new URL(emailArtUrl()).pathname}`, import.meta.url)) })
    : route.abort());
  await page.emulateMedia({ colorScheme: theme });
  const bodies = AUTH_EMAIL_KINDS.map(kind => ({ kind, html: authEmail(kind).html.replaceAll('{{ .Token }}', '012345').replaceAll('{{ .ConfirmationURL }}', 'https://example.invalid/confirmation') }));
  for (const level of ['run', 'edit', 'manage']) bodies.push({ kind: level, html: inviteHtml(inviteMessage({ email: 'sam@example.invalid', inviterName: 'Alex Morgan', workspaceName: 'Harbour ICU', level,
    ref: 'F'.repeat(43), origin: 'https://example.invalid', expiresAt: '2027-02-02T00:00:00Z' })) });
  bodies.push({ kind: 'alert', html: operationalAlertHtml({ event: { kind: 'archive_lag_s', value: 125 }, env: 'production', build: 'fictional-build' }) });
  for (const { kind, html } of bodies) {
    for (const width of [320, 660]) for (const mode of ['normal', 'blocked', 'stripped']) {
      await page.setViewportSize({ width, height: 1100 });
      const body = mode === 'blocked' ? html.replace(/<img [^>]+>/, '<p>Case mosaic artwork unavailable</p>') : mode === 'stripped' ? html.replace(/<style>[\s\S]*?<\/style>/, '') : html;
      await page.setContent(body);
      expect(await page.locator('body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${kind}/${theme}/${width}/${mode} reflows`).toBe(true);
      for (const a of await page.locator('a').all()) expect((await a.boundingBox()).height).toBeGreaterThanOrEqual(44);
      if (['magic-link', 'confirm-signup', 'reauthentication'].includes(kind)) {
        const code = page.locator('p').filter({ hasText: /^012345$/ }); await expect(code).toHaveText('012345');
        expect(await code.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString(); })).toBe('012345');
      }
    }
    await page.setContent(html); // 660px, real light/dark contrast for every purpose.
    const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(a11y.violations, `${kind}/${theme} accessibility`).toEqual([]);
  }
});
