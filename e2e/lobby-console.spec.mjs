import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl } from '../src/shared/urls.mjs';
import { test, expect } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from '../tests/helpers/mini-case.mjs';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { serverMirror } from '../tests/helpers/local-worker.mjs';
import { apiUrl, authApiUrl, displayPairUrl, joinUrl, sessionUrl } from '../src/shared/urls.mjs';
import { consoleReady, openRoomSetup, closeRoomSetup, dismissDisplayReminder } from '../tests/helpers/console-v2.mjs';

let auth, worker, shell;
const fixture = miniCase(), decision = fixture.doc.decisions[0];
decision.interaction.type = 'ranking'; decision.interaction.rank_count = 8;
while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: `Additional option ${decision.interaction.options.length + 1}` });
decision.paths.forEach(path => { delete path.option_ids; });
decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null, otp });
  worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: fixture.doc }); auth.setJwt(worker.jwt);
  const base = authApiUrl(auth.origin, 'base');
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: base.slice(0, -1),
    SUPABASE_JWKS_URL: new URL('.well-known/jwks.json', base).href,
  } }); auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

test('Card24 actual console Hide and Show govern the paired projector without choosing a route', async ({ browser }) => {
  const facilitator = await browser.newPage({ ignoreHTTPSErrors: true }); // throwaway self-signed local Auth, as Card12's fixture
  const display = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let releasePage = () => {}, finishPageRoutes = async () => {};
  const phones = await Promise.all([0, 1].map(() => browser.newPage({ viewport: { width: 390, height: 844 } })));
  try {
    await facilitator.goto(casesUrl(shell.origin)); await facilitator.getByLabel('Email').fill('owner@example.invalid');
    await facilitator.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await expect(facilitator.getByLabel('One-time code')).toBeVisible();
    await facilitator.getByLabel('One-time code').fill(otp);
    await facilitator.getByRole('button', { name: 'Sign in', exact: true }).click();
    const created = shell.waitForCreatedRoom();
    await (await openCase(facilitator)).click();
    const room = await created;
    await consoleReady(facilitator);
    const pairingResponse = await display.goto(displayPairUrl('00000000', shell.origin));
    expect(pairingResponse.status()).toBe(200);
    await expect(display.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
    const code = (await display.locator('.pair-code').textContent()).replace(/\s/g, '');
    const paired = await fetch(apiUrl(worker.origin, 'sessions', room.sessionId, 'display-pairs', 'approve'), {
      method: 'POST', headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    }); expect(paired.status).toBe(200);
    await expect(display.locator('.joinpanel')).toBeVisible();
    for (const phone of phones) {
      await phone.goto(joinUrl(room.joinCode, shell.origin)); await phone.getByLabel('Your name', { exact: true }).fill('Same');
      await phone.getByRole('button', { name: 'Join case', exact: true }).click();
      await expect(phone.getByRole('heading', { name: 'Waiting to start', exact: true })).toBeVisible();
      await expect.poll(() => new URL(phone.url()).pathname).toBe(
        new URL(sessionUrl(room.sessionId, 'play', shell.origin)).pathname);
    }
    await expect(display.locator('.names .nm')).toHaveText(['Same', 'Same']);
    await openRoomSetup(facilitator);
    await expect(facilitator.getByRole('button', { name: /^(Show|Hide) names on projector$/ })).toHaveCount(0);
    await closeRoomSetup(facilitator);
    await dismissDisplayReminder(facilitator);
    await facilitator.getByRole('button', { name: 'Start case', exact: true }).click();
    await facilitator.getByRole('button', { name: 'Show decision context', exact: true }).click();
    await facilitator.getByRole('button', { name: 'Open responses', exact: true }).click();
    for (const [index, phone] of phones.entries()) {
      const options = index ? [decision.interaction.options[0], decision.interaction.options[2], decision.interaction.options[1], ...decision.interaction.options.slice(3)] : decision.interaction.options;
      for (const option of options) {
        const control = phone.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true });
        await expect(control).toBeVisible(); await control.click();
      }
      await phone.getByRole('button', { name: 'Send answer', exact: true }).click();
      await expect(phone.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
      await expect(phone.getByRole('region', { name: 'Group result', exact: true })).toHaveCount(0);
    }
    const chart = display.getByRole('region', { name: 'Responses closed', exact: true });
    await expect(chart).toHaveCount(0);
    await openRoomSetup(facilitator);
    await facilitator.getByRole('button', { name: 'Show names on projector', exact: true }).click();
    await closeRoomSetup(facilitator);
    await expect(display.locator('.names .nm')).toHaveText(['Same', 'Same']);
    await facilitator.getByRole('button', { name: 'Lock responses & review', exact: true }).click();
    await expect(display.locator('.names .nm')).toHaveCount(0);
    await openRoomSetup(facilitator);
    await expect(facilitator.getByRole('button', { name: 'Show names on projector', exact: true })).toHaveCount(0);
    await expect(facilitator.getByRole('button', { name: 'Hide names on projector', exact: true })).toHaveCount(0);
    await closeRoomSetup(facilitator);
    await expect(chart).toBeVisible(); await expect(chart.locator('.ranked-overall')).toHaveText('2 responses · 2 orders');
    await expect(facilitator.getByText('Hide responses on projector before showing the next case context.', { exact: true })).toHaveCount(0);
    await expect(facilitator.getByRole('button', { name: /^Reveal:/ })).toBeVisible();
    await expect(facilitator.locator('.console-aggregate')).toContainText('Decompress the right chest · Rank 1: 2 · Rank 2: 0 · Rank 3: 0');
    await expect(facilitator.locator('.console-aggregate')).toContainText('Chest X-ray first · Rank 1: 0 · Rank 2: 1 · Rank 3: 1');
    await expect(facilitator.locator('.console-aggregate')).toContainText('RSI and intubate · Rank 1: 0 · Rank 2: 1 · Rank 3: 1');
    await expect(facilitator.locator('.console-aggregate')).toContainText('Suggested by responses: Decompress');
    const closed = (await serverMirror(worker.origin, room)).round.aggregate;
    // CASE-327: five positions a page, so 8 ranks page 1–5 then 6–8.
    await expect(chart.locator('.ranked-continuation')).toHaveText('Positions 1–5 of 8');
    await expect(facilitator.getByRole('button', { name: 'Next positions', exact: true })).toBeVisible();
    let pageStarted = false;
    const held = new Promise(resolve => { releasePage = resolve; });
    const pageHandlers = [], commandRoute = apiUrl(shell.origin, 'sessions', room.sessionId, 'commands');
    const holdPage = route => {
      const task = (async () => {
        if (route.request().postDataJSON()?.type === 'ranked_page') { pageStarted = true; await held; }
        const response = await route.fetch(); await route.fulfill({ response });
      })();
      pageHandlers.push(task); return task;
    };
    await facilitator.route(commandRoute, holdPage);
    finishPageRoutes = async () => {
      releasePage(); await Promise.all(pageHandlers); await facilitator.unroute(commandRoute, holdPage);
    };
    await facilitator.getByRole('button', { name: 'Next positions', exact: true }).click();
    await expect.poll(() => pageStarted).toBe(true);
    expect(await facilitator.getByRole('button', { name: 'Next positions', exact: true }).isDisabled()).toBe(true);
    expect(await facilitator.getByRole('button', { name: 'Previous positions', exact: true }).isDisabled()).toBe(true);
    await expect(facilitator.getByText('Response orders 1–2 of 2 · Positions 1–5 of 8',{exact:true})).toBeVisible();
    await expect(facilitator.getByRole('combobox',{name:'Select response order',exact:true})).toBeDisabled();
    releasePage();

    await expect(chart.locator('.ranked-continuation')).toHaveText('Positions 6–8 of 8 · continued');
    await expect(chart.locator('.ranked-label')).toHaveText([...decision.interaction.options.slice(5),...decision.interaction.options.slice(5)].map(option=>option.label));
    await expect(chart.locator('.ranked-total')).toHaveText(['1 response','1 response']);
    await expect(chart.locator('.ranked-rank')).toHaveText(['6','7','8','6','7','8']);
    await expect(facilitator.getByText('Response orders 1–2 of 2 · Positions 6–8 of 8',{exact:true})).toBeVisible();
    expect(await facilitator.getByRole('button',{name:'Next positions',exact:true}).isDisabled()).toBe(true);
    await facilitator.getByRole('button',{name:'Previous positions',exact:true}).click();
    await expect(chart.locator('.ranked-continuation')).toHaveText('Positions 1–5 of 8');
    expect(await facilitator.getByRole('button',{name:'Previous positions',exact:true}).isDisabled()).toBe(true);
    await expect(chart.locator('.ranked-label')).toHaveText([0,1,2,3,4,0,2,1,3,4].map(index=>decision.interaction.options[index].label));
    await expect(facilitator.getByRole('button', { name: 'Hide responses on projector', exact: true })).toBeVisible();
    await facilitator.getByRole('button', { name: 'Hide responses on projector', exact: true }).click();
    await expect(chart).toHaveCount(0);
    await expect.poll(async () => (await serverMirror(worker.origin, room)).resultsShown).toBe(false);
    await display.reload(); await expect(chart).toHaveCount(0);
    await facilitator.getByRole('button', { name: 'Show responses on projector', exact: true }).click();
    await expect(chart).toBeVisible();
    const unchanged = await serverMirror(worker.origin, room);
    expect(unchanged.round.aggregate).toEqual(closed); expect(unchanged.selectedPathId).toBeNull();
    for (const phone of phones) await expect(phone.getByRole('region', { name: 'Group result', exact: true })).toHaveCount(0);

    // The draft route remains private. One explicit Reveal replaces the closed chart atomically.
    await chooseLocalRoute(facilitator, room, facilitator.getByRole('radio', { name: 'Choose Decompress', exact: true }));
    await expect.poll(async () => (await serverMirror(worker.origin, room)).phase).toBe('responses_locked');
    await expect(facilitator.locator('.console-phase[data-phase="responses_locked"]')).toBeVisible();
    await expect(facilitator.getByRole('button', { name: /^Reveal:/ })).toBeVisible();
    await expect(chart).toBeVisible();
    await expect(display.getByText('Partial response.', { exact: true })).toHaveCount(0);
    for (const phone of phones) await expect(phone.getByText('Partial response.', { exact: true })).toHaveCount(0);
    await expect(facilitator.getByText('Hide responses on projector before showing the next case context.', { exact: true })).toHaveCount(0);
    await revealAtomic(facilitator, room);
    await expect(display.getByText('Partial response.', { exact: true })).toBeVisible();
    for (const phone of phones) await expect(phone.getByText('Partial response.', { exact: true })).toBeVisible();
    await expect(chart).toHaveCount(0);
    await facilitator.getByRole('button', { name: 'Show responses on projector', exact: true }).click();
    await expect(chart).toBeVisible();
    await expect(chart.locator('.ranked-continuation')).toHaveText('Positions 1–5 of 8');
    await expect(facilitator.locator('.console-phase[data-phase="consequence_revealed"]')).toBeVisible();
    await expect(facilitator.getByRole('button', { name: 'Show decision context', exact: true })).toHaveCount(0);
    await facilitator.getByRole('button', { name: 'Hide responses on projector', exact: true }).click();
    await facilitator.getByRole('button', { name: 'Show decision context', exact: true }).click();
    await expect(display.getByText('Second shock.', { exact: true })).toBeVisible();
    for (const phone of phones) await expect(phone.getByText('Second shock.', { exact: true })).toBeVisible();
  } finally { await finishPageRoutes(); await Promise.all([facilitator, display, ...phones].map(page => page.close())); }
});

// Route cards are page-local until one explicit atomic Reveal. Observe real requests and authority.
async function chooseLocalRoute(page, room, route = page.locator('.console-routes').getByRole('radio', { disabled: false }).first()) {
  const before = await serverMirror(worker.origin, room), commands = [];
  const record = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/sessions/${room.sessionId}/commands`) commands.push(request); };
  page.on('request', record);
  try {
    await route.click(); await expect(route).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    const after = await serverMirror(worker.origin, room);
    expect(after.revision).toBe(before.revision); expect(after.phase).toBe('responses_locked');
    expect(after.selectedPathId).toBeNull(); expect(after.revealed).toEqual(before.revealed);
    expect(commands).toHaveLength(0);
  } finally { page.off('request', record); }
}

// A single native press must send exactly one fenced reveal and clear presentation overlays atomically.
async function revealAtomic(page, room) {
  const pathId = await page.locator('.console-route').filter({ has: page.getByRole('radio', { checked: true }) }).getAttribute('data-path');
  expect(pathId).toBeTruthy();
  const before = await serverMirror(worker.origin, room), commands = [];
  const record = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/sessions/${room.sessionId}/commands`) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.getByRole('button', { name: /^Reveal:/ }).click();
    await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', /^(consequence_revealed|terminal_teaching)$/);
    expect(commands).toHaveLength(1); expect(commands[0].type).toBe('reveal_path');
    expect(commands[0].expectRevision).toBe(before.revision); expect(commands[0].pathId).toBe(pathId);
    const after = await serverMirror(worker.origin, room);
    expect(after.resultsShown).toBe(false); expect(after.display.cursor).toBeNull(); expect(after.display.lobby).toBe(false);
    await expect(page.getByRole('button', { name: 'Show to participants?' })).toHaveCount(0);
  } finally { page.off('request', record); }
}

