// The facilitator's Name & role (Julian, 2026-10-18) through the served console against the real local Worker: the required
// first-sign-in step, Start room's this-session override, and Account. The outbound PostgREST is the in-memory fake.
import { settled } from '../tests/helpers/settled.mjs';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { casesUrl, accountUrl } from '../src/shared/urls.mjs';
import { ROLE_SUGGESTIONS } from '../src/shared/facilitator-label.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { consoleReady } from '../tests/helpers/console-v2.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';

let auth, worker, shell, profile;
test.use({ ignoreHTTPSErrors: true }); // the local auth stub's self-signed certificate
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  // The account as the database holds it: the invited placeholder until the facilitator saves a Name & role.
  const me = worker.fake.replies.get('get_me');
  worker.fake.replies.set('get_me', args => me(args).map(row => ({ ...row, ...profile })));
  worker.fake.replies.set('set_own_facilitator_label', args => {
    profile = { display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: new Date().toISOString() };
    return [profile];
  });
  worker.fake.replies.set('set_session_facilitator_label', true);
});
test.beforeEach(() => { profile = { display_name: 'Facilitator', facilitator_role: null, label_confirmed_at: null }; });
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

async function signIn(page, url = casesUrl(shell.origin)) {
  await page.goto(url);
  await page.getByLabel('Email').fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
}
const calls = name => worker.fake.requests.filter(request => request.name === name).map(request => request.args);

test('[AS-178] an unconfirmed account states its Name & role before the library; Role suggests the ladder and takes any wording', async ({ page }) => {
  await signIn(page);
  const step = page.locator('form.label-step');
  await expect(step.getByRole('heading', { name: 'Your name and role' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toHaveCount(0);
  await expect(step.getByLabel('Name')).toHaveValue(''); // the placeholder is never offered as a name
  const role = step.getByLabel('Role');
  expect(await page.locator(`datalist#${await role.getAttribute('list')} option`).evaluateAll(options => options.map(o => o.value))).toEqual(ROLE_SUGGESTIONS);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await settled(page);expect((await new AxeBuilder({ page }).include('form.label-step').analyze()).violations).toEqual([]);
  }
  await step.getByRole('button', { name: 'Save and continue' }).click();
  await expect(step.getByText('Enter your name.')).toBeVisible();
  await expect(step.getByLabel('Name')).toBeFocused();
  await step.getByLabel('Name').fill('  Julian   Ming ');
  await role.fill('Emergency registrar');
  await step.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
  expect(calls('set_own_facilitator_label').at(-1)).toEqual({ p_user_id: worker.userId, p_name: 'Julian Ming', p_role: 'Emergency registrar' });
});

test('Start room names the profile, and a change there applies to this room only', async ({ page }) => {
  profile = { display_name: 'Julian Ming', facilitator_role: 'Emergency registrar', label_confirmed_at: new Date().toISOString() };
  await signIn(page);
  await expect(page.locator('form.label-step')).toHaveCount(0);
  const start = await openCase(page);
  const record = page.getByRole('dialog',{name:'Present case',exact:true});
  await expect(record.getByRole('group',{name:'Session profile',exact:true})).toBeVisible();
  await record.getByLabel('Role').fill('Consultant');
  const own = calls('set_own_facilitator_label').length, labels = calls('set_session_facilitator_label').length;
  await start.click();
  await consoleReady(page);
  expect(calls('set_session_facilitator_label').slice(labels).map(args => args.p_label)).toEqual(['Julian Ming, Consultant']);
  expect(calls('set_own_facilitator_label').length, 'the profile is untouched').toBe(own);
});

test('Account edits the Name & role for new rooms', async ({ page }) => {
  profile = { display_name: 'Julian Ming', facilitator_role: 'Registrar', label_confirmed_at: new Date().toISOString() };
  await signIn(page, accountUrl(shell.origin));
  const section = page.locator('form.account-profile');
  await expect(section.getByLabel('Name')).toHaveValue('Julian Ming');
  await expect(section.getByLabel('Role')).toHaveValue('Registrar');
  await section.getByLabel('Role').fill('');
  await section.getByRole('button', { name: 'Save name and role' }).click();
  await expect(section.getByText('Enter your role.')).toBeVisible();
  await section.getByLabel('Role').fill('Senior registrar');
  await section.getByRole('button', { name: 'Save name and role' }).click();
  await expect(page.locator('.surface-toast')).toHaveText('Saved. New sessions use this profile; existing records keep theirs.');
  expect(calls('set_own_facilitator_label').at(-1)).toEqual({ p_user_id: worker.userId, p_name: 'Julian Ming', p_role: 'Senior registrar' });
});
