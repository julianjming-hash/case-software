// Live console controls: production shell and real local Worker; SQL/Auth remain local fakes.
import { expect } from '@playwright/test';
import { startLocalAuthStub } from './local-auth-stub.mjs';
import { startPublishedWorker } from './published-worker.mjs';
import { startServedAuthShell } from './served-auth-shell.mjs';
import { createParticipantJoinCapture } from './participant-join-capture.mjs';
import { openCase } from './library-flow.mjs';
import { projectorPage, dismissDisplayReminder } from './console-v2.mjs';
import { miniCase } from './mini-case.mjs';
import { serverMirror, TEST_JWT_SECRET } from './local-worker.mjs';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { validateCaseDocument } from '../../src/shared/case-document.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { apiUrl, casesUrl, joinUrl, samePcProjectorUrl } from '../../src/shared/urls.mjs';

export const PRIVATE_MARKER = 'FACILITATOR_PRIVATE_SENTINEL';
export const LATER_MARKER = 'LATER_RESULT_GROUP_SENTINEL';
export const FUTURE_MARKER = 'UNREACHED_FUTURE_SCENE_SENTINEL';

export function controlsCase() {
  const fixture = miniCase();
  for (const [index, surface] of fixture.doc.surfaces.entries()) {
    surface.scene = `Public scene ${index + 1}. The team reviews the new situation.`;
    surface.notes = `${PRIVATE_MARKER}: surface ${index + 1}.`;
  }
  for (const decision of fixture.doc.decisions) for (const path of decision.paths) {
    path.rationale = `${PRIVATE_MARKER}: rationale for ${path.label}.`;
    path.cue = `${PRIVATE_MARKER}: ask about ${path.label}.`;
  }
  for (const id of [fixture.s.partial, fixture.s.delay, fixture.s.arrest]) {
    fixture.doc.surfaces.find(surface => surface.id === id).points = [LATER_MARKER];
  }
  fixture.doc.surfaces.find(surface => surface.id === fixture.s.d2ctx).scene = FUTURE_MARKER;
  const validation = validateCaseDocument(fixture.doc);
  if (!validation.ok) throw new Error(`Invalid console controls fixture: ${JSON.stringify(validation.errors)}`);
  return fixture;
}

export async function startControlsHarness(fixture) {
  let auth, worker, shell;
  const participantJoins = createParticipantJoinCapture();
  try {
    auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
    worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: fixture.doc });
    // The existing local helper has no non-admin email claim. Keep its actor, session and issuer,
    // supplying the authenticated email needed by the real verified-account menu adapter.
    const jwt = await signTestJwt({ sub: worker.userId, email: 'owner@example.invalid',
      aud: 'authenticated', role: 'authenticated', session_id: worker.sessionId,
      iss: `${auth.origin}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_JWT_SECRET);
    auth.setJwt(jwt);
    shell = await startServedAuthShell({ apiOrigin: worker.origin, participantJoinObserver: participantJoins,
      buildAuthBindings: { SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
        SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
    auth.setAppOrigin(shell.origin);
    return { auth, worker, shell, fixture, participantJoins, stop: async () => {
      await shell.stop(); await worker.stop(); await auth.stop();
    } };
  } catch (error) {
    await shell?.stop(); await worker?.stop(); await auth?.stop(); throw error;
  }
}

// Observe the native same-PC channel before the production projector validator trims any frame.
// This listener changes neither postMessage nor the receiver's onmessage behavior.
export async function captureLocalPublicFrames(context) {
  await context.addInitScript(() => {
    const NativeChannel = window.BroadcastChannel;
    window.__consoleControlsPublicFrames = [];
    window.BroadcastChannel = class extends NativeChannel {
      constructor(name) {
        super(name);
        if (name === 'case-room-local') this.addEventListener('message', event => {
          if (event.data?.t === 'local_snapshot') {
            const frames = window.__consoleControlsPublicFrames;
            frames.push(structuredClone(event.data));
            if (frames.length > 128) frames.shift();
          }
        });
      }
    };
  });
}

export function captureCommands(page) {
  const commands = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/commands')) {
      try { commands.push(JSON.parse(request.postData())); } catch { /* non-JSON cannot be a valid command */ }
    }
  });
  return commands;
}

export function captureRemotePublicFrames(page) {
  const frames = [];
  const append = data => {
    try {
      const frame = typeof data === 'string' ? JSON.parse(data) : data;
      if (frame?.t === 'snapshot') { frames.push(frame); if (frames.length > 128) frames.shift(); }
    } catch { /* heartbeat or non-snapshot */ }
  };
  page.on('websocket', socket => socket.on('framereceived', event => append(event.payload)));
  page.on('response', async response => {
    if (new URL(response.url()).pathname.endsWith('/snapshot') && response.status() === 200) {
      try { append(await response.json()); } catch { /* navigation cancelled the request */ }
    }
  });
  return frames;
}

export const primary = page => page.locator('.console-primary');
export const undo = page => page.locator('.console-undo');
// A route's choice is named "Choose <route>" (CASE-249 F).
export const route = (page, label) => page.getByRole('radio', { name: `Choose ${label}`, exact: true });
export const mirror = (harness, room) => serverMirror(harness.worker.origin, room);
export async function snapshot(harness, room) {
  const response = await fetch(apiUrl(harness.worker.origin, 'sessions', room.sessionId, 'snapshot'),
    { headers: { authorization: `Bearer ${room.facilitatorToken}` } });
  expect(response.status).toBe(200); return response.json();
}

export async function openControlsDecision(context, harness, { beforeRoomMount = null } = {}) {
  const page = await context.newPage(), commands = captureCommands(page);
  await page.goto(casesUrl(harness.shell.origin));
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const created = harness.shell.waitForCreatedRoom();
  const start = await openCase(page);
  if (beforeRoomMount) await beforeRoomMount(page);
  await start.click();
  const room = await created;
  // Start room opened the same-PC projector in its own click (console layout v2).
  const projector = await projectorPage(page);
  await expect(projector).toHaveURL(samePcProjectorUrl(room.sessionId, harness.shell.origin));
  await expect(projector.locator('.joinpanel')).toBeVisible();
  await dismissDisplayReminder(page);
  for (let count = 0; count < 12; count++) {
    if ((await mirror(harness, room)).phase === 'responses_open') break;
    const before = (await mirror(harness, room)).revision;
    await primary(page).click();
    await expect.poll(async () => (await mirror(harness, room)).revision).toBeGreaterThan(before);
  }
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'responses_open');
  return { page, projector, room, commands };
}

let ipSuffix = 1;
export async function joinApi(harness, room, displayName) {
  const response = await fetch(apiUrl(harness.worker.origin, 'join'), { method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ipSuffix++}` },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName, avatarId: 'shadows-01' }) });
  expect(response.status).toBe(201); return response.json();
}

export async function voteApi(harness, room, participant, optionId) {
  const state = await mirror(harness, room);
  const response = await fetch(apiUrl(harness.worker.origin, 'sessions', room.sessionId, 'commands'), {
    method: 'POST', headers: { authorization: `Bearer ${participant.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'vote', epoch: state.epoch, clientEventId: uuidv7(),
      roundId: state.round.id, response: { option_id: optionId } }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).receipt.receipt).toBe('accepted');
}

export async function openPhone(browser, harness, room, displayName = 'Learner Private Name') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  let captured;
  try {
    const page = await context.newPage(), frames = captureRemotePublicFrames(page), commands = captureCommands(page);
    await page.goto(joinUrl(room.joinCode, harness.shell.origin));
    await page.getByLabel('Your name', { exact: true }).fill(displayName);
    captured = harness.participantJoins.waitForParticipant({ sessionId: room.sessionId, joinCode: room.joinCode, displayName });
    // A click/navigation failure still releases this bounded waiter when the harness closes.
    captured.catch(() => {});
    const joined = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === new URL(apiUrl(harness.shell.origin, 'join')).pathname);
    joined.catch(() => {}); // context cleanup may reject the pending native response waiter
    await page.getByRole('button', { name: 'Join case', exact: true }).click();
    const response = await joined; expect(response.status()).toBe(201);
    const participant = await captured;
    await expect(page.getByRole('radio').first()).toBeVisible();
    return { context, page, participant, frames, commands };
  } catch (error) {
    captured?.cancel();
    try { await context.close(); } catch { /* cleanup must not mask the original join failure */ }
    throw error;
  }
}

export async function selectPhone(phone, optionLabel) {
  const change = phone.page.getByRole('button', { name: 'Change decision', exact: true });
  if (await change.isVisible()) await change.click();
  await phone.page.getByRole('radio', { name: new RegExp(optionLabel) }).check();
  await expect(phone.page.locator('.saved-line')).toContainText(optionLabel);
  await expect(change).toBeVisible();
}

export async function assertPublicPrivacy(projector, phoneFrames = [], extraPrivate = [], forbiddenPhone = []) {
  await expect.poll(async () => projector.evaluate(() => window.__consoleControlsPublicFrames.length)).toBeGreaterThan(0);
  const localFrames = await projector.evaluate(() => window.__consoleControlsPublicFrames);
  expect(localFrames.every(frame => frame.view?.role === 'display')).toBe(true);
  expect(phoneFrames.every(frame => frame.view?.role === 'participant')).toBe(true);
  for (const marker of [PRIVATE_MARKER, FUTURE_MARKER]) {
    expect(JSON.stringify([...localFrames, ...phoneFrames])).not.toContain(marker);
  }
  for (const marker of extraPrivate) expect(JSON.stringify(localFrames)).not.toContain(marker);
  for (const marker of forbiddenPhone) expect(JSON.stringify(phoneFrames)).not.toContain(marker);
  for (const frame of [...localFrames, ...phoneFrames]) {
    for (const field of ['caseDoc','pack','mirror','publicTimeline','undo','paths','responses']) {
      expect(Object.hasOwn(frame.view, field), `public root ${field}`).toBe(false);
    }
    if (frame.view?.decision) expect(frame.view.decision).not.toHaveProperty('paths');
  }
  // Phones deliberately retain their already-revealed timeline and their own profile/answer.
  for (const frame of localFrames) expect(frame.view).not.toHaveProperty('timeline');
  await expect(projector.locator('body')).not.toContainText(PRIVATE_MARKER);
  return localFrames;
}

export async function openMenu(page) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link', { name: /^Present$/ })).toBeVisible();
  return menu;
}

export async function assertNoHorizontalOverflow(page) {
  const result = await page.evaluate(() => ({ available: document.documentElement.clientWidth,
    actual: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  expect(result.actual).toBeLessThanOrEqual(result.available + 1);
}
