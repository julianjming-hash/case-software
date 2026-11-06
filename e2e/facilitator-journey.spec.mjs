// Facilitator journey through actual served controls, a local Worker, projector and participant.
import { test, expect } from '@playwright/test';
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { FIXTURE, serverMirror } from '../tests/helpers/local-worker.mjs';
import { openCase } from '../tests/helpers/library-flow.mjs';
import { casesUrl, joinUrl, samePcProjectorUrl } from '../src/shared/urls.mjs';
import { closeRoomSetup, endCase, openRoomSetup, projectorPage } from '../tests/helpers/console-v2.mjs';

let auth, worker, shell;
test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin,
    buildAuthBindings: { SUPABASE_URL: auth.origin,
      SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
      SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function roomMenu(page) {
  await page.locator('.console-room').getByRole('button', { name: 'Open menu', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true }); await expect(menu).toBeVisible(); return menu;
}

test('facilitator starts without display confirmation and preserves a desktop answer through join screen, lock and private recap', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const facContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
  const participantContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
  const publicUrls = [], publicFrames = [], publicBodies = [];
  const releaseVote = deferred(), voteRequests = [], commands = [];
  const watchPublic = page => {
    page.on('request', request => publicUrls.push(request.url()));
    page.on('websocket', socket => {
      publicUrls.push(socket.url());
      socket.on('framereceived', frame => publicFrames.push(String(frame.payload)));
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path === '/api/v1/join' || /\/snapshot$/.test(path)) publicBodies.push(response.text().catch(() => ''));
    });
  };
  // Listen before the popup's first publication, including same-PC frames which do not use HTTP.
  await facContext.addInitScript(() => {
    window.__previewPublicViews = [];
    const channel = new BroadcastChannel('case-room-local');
    channel.onmessage = ({ data }) => {
      if (data?.t === 'local_snapshot') window.__previewPublicViews.push(data.view);
    };
    window.__previewPublicChannel = channel;
  });
  try {
    const fac = await facContext.newPage();
    const participant = await participantContext.newPage();
    fac.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/commands')) commands.push(request.postDataJSON()); });
    await participant.route(url => url.pathname.endsWith('/commands'), async route => {
      const body = route.request().postDataJSON(); if (body.type !== 'vote') return route.continue();
      voteRequests.push(body); await releaseVote.promise; await route.continue();
    });
    watchPublic(participant);
    await fac.goto(casesUrl(shell.origin));
    await fac.getByLabel('Email').fill('owner@example.invalid');
    await fac.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await fac.getByLabel('One-time code').fill('123456');
    await fac.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(fac.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    const created = shell.waitForCreatedRoom();
    await (await openCase(fac)).click();
    const room = await created;
    const ownsRoom = () => fac.evaluate(async name => (await navigator.locks.query()).held.some(lock => lock.name === name), `room-owner:${room.sessionId}`);
    await expect.poll(ownsRoom).toBe(true);

    await test.step('default setup leaves alternatives closed and starting available', async () => {
      await expect(fac.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
      await openRoomSetup(fac);
      // Console layout v2: the other-screen alternatives stay folded until Use another screen is pressed.
      await expect(fac.locator('#console-setup .console-pairing')).toHaveCount(0);
      await expect(fac.getByRole('button', { name: 'Dismiss display reminder', exact: true })).toHaveCount(0);
      await closeRoomSetup(fac);
      await expect(fac.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
    });
    // Start room opened the same-PC projector in its own click (console layout v2).
    const projector = await projectorPage(fac);
    watchPublic(projector);
    await expect(projector).toHaveURL(samePcProjectorUrl(room.sessionId, shell.origin));
    await expect(projector.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
    await expect(projector.locator('.names .arrival-note')).toHaveText('0 joined');
    await participant.goto(joinUrl(room.joinCode, shell.origin));
    await participant.getByLabel('Your name', { exact: true }).fill('Preview learner');
    await participant.getByRole('button', { name: 'Join case', exact: true }).click();
    await expect(participant.getByRole('heading', { name: 'Waiting to start', exact: true })).toBeVisible();
    await expect(projector.locator('.names .arrival-note')).toHaveText('1 joined');
    await closeRoomSetup(fac);
    await fac.screenshot({ path: testInfo.outputPath('default-startup-unconfirmed.png'), fullPage: true });
    // Never open setup alternatives or dismiss the advisory check in this journey.
    await fac.getByRole('button', { name: 'Start case', exact: true }).click();
    await expect(fac.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
    for (const name of ['Reveal findings', 'Show decision context', 'Reveal observations', 'Reveal findings', 'Open responses'])
      await fac.getByRole('button', { name, exact: true }).click();
    const decision = FIXTURE.decisions[0], option = decision.interaction.options[0];
    await expect(fac.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
    await expect(projector.locator('#main')).toContainText(decision.prompt);
    const answer = participant.locator('.decision input').first();
    await answer.check();
    await expect.poll(() => voteRequests.length, { message: 'A single-choice selection starts delivery without a Send answer press' }).toBeGreaterThan(0);
    await expect(participant.getByRole('button', { name: 'Send answer', exact: true })).toBeHidden();
    await expect(participant.getByText('Answer saved · you can change it until responses lock', { exact: true })).toHaveCount(0);
    expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
    await answer.evaluate(el => { window.__previewAnswer = el; });
    await answer.focus();
    await test.step('responsive context preserves the selected control and focus', async () => {
      for (const width of [1366, 390, 1366]) {
        await participant.setViewportSize({ width, height: 900 });
        const info = participant.locator('#main > section.stack'), answers = participant.locator('.decision');
        await expect(answers).toBeVisible();
        // Await the actual responsive information rebuild before measuring the selected answer.
        await expect(info.locator('details.ctx')).toHaveCount(width === 1366 ? 0 : 1);
        const [left, right] = await participant.evaluate(() => {
          const rect = node => node?.getClientRects().length && getComputedStyle(node).visibility === 'visible' ? node.getBoundingClientRect().toJSON() : null;
          return [rect(document.querySelector('#main > section.stack')), rect(document.querySelector('.decision'))];
        });
        expect(left).toBeTruthy(); expect(right).toBeTruthy();
        if (width === 1366) {
          expect(left.x + left.width).toBeLessThanOrEqual(right.x);
          expect(Math.abs(left.y - right.y)).toBeLessThan(1);
          await expect(info.locator('details')).toHaveCount(0);
        } else expect(left.y + left.height).toBeLessThanOrEqual(right.y);
        expect(await answer.evaluate(el => el === window.__previewAnswer)).toBe(true);
        await expect(answer).toBeChecked();
        await expect(answer).toBeFocused();
        expect(await participant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 390) await participant.screenshot({ path: testInfo.outputPath('narrow-selected-answer.png'), fullPage: true });
      }
      await participant.screenshot({ path: testInfo.outputPath('desktop-selected-answer.png'), fullPage: true });
    });
    const acceptedVote = participant.waitForResponse(response => new URL(response.url()).pathname.endsWith('/commands') && response.request().postDataJSON()?.type === 'vote');
    releaseVote.resolve();
    const acceptedResponse = await acceptedVote, receipt = (await acceptedResponse.json()).receipt;
    expect(acceptedResponse.status()).toBe(200);
    expect(['accepted', 'already_accepted']).toContain(receipt.receipt);
    expect(voteRequests.some(body => body.clientEventId === receipt.clientEventId)).toBe(true);
    await expect(participant.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
    await expect(participant.getByRole('button', { name: 'Change decision', exact: true })).toBeVisible();
    expect(new Set(voteRequests.map(body => body.clientEventId)).size).toBe(1);
    const beforeLobby = await serverMirror(worker.origin, room);
    expect(Object.keys(beforeLobby.round.responses)).toHaveLength(1);
    await test.step('join screen temporarily replaces only the projector', async () => {
      await fac.getByRole('complementary', { name: 'Session' }).getByRole('button', { name: 'Show join screen', exact: true }).click();
      await expect(projector.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible();
      await expect(projector.locator('.scene, .decision, .tiles, .vitals')).toHaveCount(0);
      await expect(participant.locator('.decision')).toBeVisible();
      await expect(participant.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
      const duringLobby = await serverMirror(worker.origin, room);
      expect(duringLobby.phase).toBe('responses_open');
      expect(duringLobby.round.responses).toEqual(beforeLobby.round.responses);
      expect(duringLobby.revealed).toEqual(beforeLobby.revealed);
      expect(duringLobby.display.cursor).toBe(beforeLobby.display.cursor);
      await expect(projector.locator('#projectorCheck')).toBeHidden({ timeout: 15_000 });
      await projector.screenshot({ path: testInfo.outputPath('mid-case-join-screen.png'), fullPage: true, animations: 'disabled' });
      await fac.screenshot({ path: testInfo.outputPath('mid-case-return-control.png'), fullPage: true });
      await fac.getByRole('complementary', { name: 'Session' }).getByRole('button', { name: 'Hide join screen', exact: true }).click();
      await expect(projector.locator('.joinpanel')).toHaveCount(0);
      await expect(projector.locator('#main')).toContainText(decision.prompt);
      await expect(fac.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
      await projector.screenshot({ path: testInfo.outputPath('returned-case.png'), fullPage: true });
    });

    await test.step('public transports omit facilitator capability and private authored notes', async () => {
      const localViews = await projector.evaluate(() => window.__previewPublicViews);
      expect(localViews.length).toBeGreaterThan(0);
      const publicPayload = JSON.stringify([publicFrames, await Promise.all(publicBodies), localViews]);
      for (const secret of [room.facilitatorToken, worker.jwt, FIXTURE.surfaces[0].notes.slice(0, 60), ...decision.paths.map(path => path.rationale.slice(0, 60))]) {
        expect(publicPayload).not.toContain(secret);
        expect(await projector.locator('body').innerText()).not.toContain(secret);
      }
      for (const key of ['"caseDoc"', '"document_text"', '"rationale"', '"facilitatorToken"']) expect(publicPayload).not.toContain(key);
      expect(publicUrls.length).toBeGreaterThan(0);
      for (const secret of [room.facilitatorToken, worker.jwt, 'Preview learner']) expect(publicUrls.join('\n')).not.toContain(secret);
      const lobbyView = localViews.findLast(view => view.phase === 'waiting');
      expect(lobbyView).toBeTruthy();
      for (const key of ['surface', 'decision', 'responseResult', 'lastResult', 'timer']) expect(lobbyView[key]).toBeNull();
    });

    await closeRoomSetup(fac);
    await fac.getByRole('button', { name: 'Lock responses & review', exact: true }).click();
    await expect(fac.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_locked');
    await expect(participant.getByText(`Your answer (locked): ${option.label}`, { exact: true })).toBeVisible();
    await participant.locator('.strip button').first().click();
    await expect(participant.locator('.decision')).toBeHidden();
    await participant.getByRole('button', { name: 'Live surface', exact: true }).click();
    await expect(participant.getByText(`Your answer (locked): ${option.label}`, { exact: true })).toBeVisible();
    const locked = await serverMirror(worker.origin, room), beforeReveal = commands.length;
    const path = decision.paths.find(row => row.label.startsWith('S00177 workshop label. Record a sensor signal and inspect the selec')); expect(path).toBeTruthy();
    const routePreview = fac.getByRole('radio', { name: `Choose ${path.label}`, exact: true });
    await routePreview.click(); await expect(routePreview).toHaveAttribute('aria-checked', 'true');
    const preview = await serverMirror(worker.origin, room);
    expect(preview.revision).toBe(locked.revision); expect(preview.selectedPathId).toBeNull();
    expect(commands).toHaveLength(beforeReveal);
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toBeVisible();
    await fac.getByRole('button', { name: /^Reveal:/ }).click();
    await expect(fac.locator('.console-phase')).toHaveAttribute('data-phase', 'consequence_revealed');
    expect(commands.slice(beforeReveal)).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({ type: 'reveal_path', pathId: path.id, expectRevision: locked.revision });
    const revealed = await serverMirror(worker.origin, room);
    expect(revealed.phase).toBe('consequence_revealed'); expect(revealed.selectedPathId).toBeNull(); expect(revealed.resultsShown).toBe(false);
    expect(revealed.round).toBeNull();
    expect(revealed.rounds.at(-1)).toMatchObject({ id: locked.round.id, status: 'resolved',
      selectedPathId: path.id, consequenceOccurrenceId: commands.at(-1).clientEventId });
    await expect(projector.getByRole('region', { name: 'Responses closed', exact: true })).toHaveCount(0);
    // Console layout v2: End case confirms in place (press again), never a pop-up.
    await endCase(fac);
    await fac.locator('.ended-summary').getByRole('button', { name: 'Back to Present' }).click(); // card 40 slice 6: the ended summary comes first
    await expect(fac.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
    await expect(participant.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
    await expect(participant.getByText(`Your answer: ${option.label}`, { exact: true })).toBeVisible();
    await expect(projector.locator('body')).not.toContainText(`Your answer: ${option.label}`);
    expect(await fac.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBeNull();
    await expect.poll(ownsRoom).toBe(false);
    const ownershipProbe = await facContext.newPage();
    await ownershipProbe.goto(`${shell.origin}/help`);
    expect(await ownershipProbe.evaluate(name => navigator.locks.request(name, { ifAvailable: true }, lock => Boolean(lock)), `room-owner:${room.sessionId}`)).toBe(true);
    await ownershipProbe.close();
    await participant.screenshot({ path: testInfo.outputPath('private-recap.png'), fullPage: true });
    // Same-PC projection must receive a terminal room state before its console transport closes.
    await expect(projector.getByRole('heading', { name: 'Session ended', exact: true })).toBeVisible();
    await expect.poll(() => projector.evaluate(() => window.__previewPublicViews.at(-1)?.phase)).toBe('ended');
    const terminal = await projector.evaluate(() => window.__previewPublicViews.at(-1));
    expect(terminal.role).toBe('display');
    expect(terminal.sessionId).toBe(room.sessionId);
    const terminalPayload = JSON.stringify(terminal);
    for (const secret of [room.facilitatorToken, worker.jwt, FIXTURE.surfaces[0].notes.slice(0, 60), ...decision.paths.map(path => path.rationale.slice(0, 60))])
      expect(terminalPayload).not.toContain(secret);
    for (const key of ['"caseDoc"', '"document_text"', '"rationale"', '"facilitatorToken"']) expect(terminalPayload).not.toContain(key);
    await expect(projector.locator('.scene, .decision, .tiles, .vitals, .joinpanel')).toHaveCount(0);
    await expect(projector.locator('#projectorCheck')).toBeHidden({ timeout: 15_000 });
    await projector.screenshot({ path: testInfo.outputPath('same-pc-terminal.png'), fullPage: true, animations: 'disabled' });
  } finally { releaseVote.resolve(); await participantContext.close(); await facContext.close(); }
});

test('offline sign-out releases the active room and preserves a deliberate sign-in in another tab behind a held refresh fence', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
  let blocker;
  try {
    const oldConsole = await context.newPage();
    await oldConsole.goto(casesUrl(shell.origin));
    await oldConsole.getByLabel('Email').fill('owner@example.invalid');
    await oldConsole.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await oldConsole.getByLabel('One-time code').fill('123456');
    await oldConsole.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(oldConsole.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    const created = shell.waitForCreatedRoom();
    await (await openCase(oldConsole)).click();
    const room = await created;
    const ownsRoom = () => oldConsole.evaluate(async name => (await navigator.locks.query()).held.some(lock => lock.name === name), `room-owner:${room.sessionId}`);
    await expect.poll(ownsRoom).toBe(true);
    const projector = await projectorPage(oldConsole);
    await expect(projector).toHaveURL(samePcProjectorUrl(room.sessionId, shell.origin));
    await oldConsole.getByRole('button', { name: 'Start case', exact: true }).click();
    await expect(projector.getByRole('heading', { name: FIXTURE.surfaces[0].title, exact: true })).toBeVisible();

    blocker = await context.newPage();
    await blocker.goto(`${shell.origin}/help`);
    await blocker.evaluate(() => new Promise(ready => {
      void navigator.locks.request('case:auth:refresh', () => new Promise(release => {
        window.__releasePreviewRefresh = release; ready();
      }));
    }));
    let failedLogout = 0;
    // Fail only the old session's local provider revocation; keep actual OTP sign-in reachable.
    await context.route(url => url.origin === auth.origin && url.pathname === '/auth/v1/logout', route => {
      failedLogout++; return route.abort('internetdisconnected');
    });
    await (await roomMenu(oldConsole)).getByRole('button', { name: 'Sign out', exact: true }).click();
  await oldConsole.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
    await expect(oldConsole.getByLabel('Email')).toBeVisible();
    expect(await oldConsole.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBeNull();
    expect(await oldConsole.evaluate(() => sessionStorage.getItem('case:console:active-room'))).toBeNull();
    await expect(oldConsole.locator('.console-room')).toHaveCount(0);
    await expect.poll(ownsRoom).toBe(false);
    expect(await blocker.evaluate(name => navigator.locks.request(name, { ifAvailable: true }, lock => Boolean(lock)), `room-owner:${room.sessionId}`)).toBe(true);
    expect(oldConsole.isClosed()).toBe(false);
    await expect(projector.getByRole('heading', { name: 'Waiting for the session…', exact: true })).toBeVisible();
    await expect(projector.locator('.scene, .decision, .tiles, .vitals, .joinpanel')).toHaveCount(0);
    await expect.poll(() => failedLogout).toBe(1);

    const newConsole = await context.newPage();
    await newConsole.goto(casesUrl(shell.origin));
    await expect(newConsole.getByLabel('Email')).toBeVisible();
    // Model a rotation already past its final comparison while the actual browser lock is held.
    await blocker.evaluate(() => localStorage.setItem('case:auth:refresh', 'preview-late-old-rotation'));
    await newConsole.getByLabel('Email').fill('owner@example.invalid');
    await newConsole.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await newConsole.getByLabel('One-time code').fill('123456');
    const verified = newConsole.waitForResponse(response => new URL(response.url()).pathname === '/auth/v1/verify');
    await newConsole.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await verified).status()).toBe(200);
    await expect.poll(() => blocker.evaluate(async () => (await navigator.locks.query()).pending.filter(lock => lock.name === 'case:auth:refresh').length)).toBeGreaterThanOrEqual(2);
    expect(await newConsole.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('preview-late-old-rotation');
    await blocker.evaluate(() => window.__releasePreviewRefresh());
    await expect(newConsole.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    expect(await newConsole.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
    await newConsole.reload();
    await expect(newConsole.getByRole('link', { name: 'Published case', exact: true })).toBeVisible();
    expect(await newConsole.evaluate(() => localStorage.getItem('case:auth:refresh'))).toBe('local-refresh-only');
    await expect(oldConsole.locator('.console-room')).toHaveCount(0);
    await expect.poll(ownsRoom).toBe(false);
    await expect(projector.locator('#projectorCheck')).toBeHidden({ timeout: 15_000 });
    await projector.screenshot({ path: testInfo.outputPath('active-projector-cleared-after-signout.png'), fullPage: true });
    await newConsole.screenshot({ path: testInfo.outputPath('deliberate-other-tab-signin-preserved.png'), fullPage: true });
  } finally {
    if (blocker && !blocker.isClosed()) await blocker.evaluate(() => window.__releasePreviewRefresh?.()).catch(() => {});
    await context.close();
  }
});
