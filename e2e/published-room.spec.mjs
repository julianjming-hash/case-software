// Card 05: browser joins and votes in a published room against real local workerd/DOs.
// A Miniflare outbound hook supplies only fake PostgREST responses.
import { test, expect } from '@playwright/test';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { facilitatorCommand, serverMirror, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';
import { joinUrl } from '../src/shared/urls.mjs';

let worker, shell, origin;

test.beforeAll(async () => {
  worker = await startPublishedWorker();
  shell = await startServedAuthShell({ apiOrigin: worker.origin });
  origin = shell.origin;
});
test.afterAll(async () => {
  await shell?.stop();
  await worker?.stop();
});

test('[AS-078] an intact published version starts a real room and a browser phone joins and votes without pack leakage', async ({ browser }) => {
  const started = await fetch(`${worker.origin}/api/v1/sessions`, { method: 'POST',
    headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: worker.workspaceId, caseVersionId: worker.versionId, ttlMinutes: 60 }) });
  expect(started.status).toBe(201);
  const room = await started.json();
  expect(worker.fake.requests[0].name).toBe('admin_account_active');
  expect(worker.fake.requests[0].args).toEqual({p_user_id:worker.userId});
  expect(worker.fake.requests.slice(1).map(request => request.name)).toEqual([
    'get_me', 'ensure_profile', 'get_case_version_for_workspace', 'create_session',
    // Card 40 slice 3: one service-role read of the new room's feedback code, before the room's DO is created.
    'session_feedback_code',
  ]);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 900 } });
  const phone = await context.newPage();
  const urls = [];
  context.on('request', request => urls.push(request.url()));
  phone.on('websocket', socket => urls.push(socket.url()));
  await phone.goto(joinUrl(room.joinCode, origin));
  await phone.getByRole('button', { name: 'Change code', exact: true }).click();
  await phone.getByLabel('Session code').fill(room.joinCode);
  await phone.getByLabel('Your name').fill('Sam');
  await phone.getByText('Change avatar', { exact: true }).click();
  await phone.getByRole('radio', { name: 'Wine, curls', exact: true }).check();
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  const participant = (await serverMirror(worker.origin, room)).participants;
  expect(Object.keys(participant)).toHaveLength(1);
  const participantToken = await phone.evaluate(sessionId => JSON.parse(localStorage.getItem(`case:participant:${sessionId}:token`)).token, room.sessionId);
  const deniedPack = await fetch(`${worker.origin}/api/v1/sessions/${room.sessionId}/case-pack`,
    { headers: { authorization: `Bearer ${participantToken}` } });
  expect(deniedPack.status).toBe(403);
  const entitledPack = await fetch(`${worker.origin}/api/v1/sessions/${room.sessionId}/case-pack`,
    { headers: { authorization: `Bearer ${room.facilitatorToken}` } });
  expect(await entitledPack.json()).toEqual(FIXTURE);

  expect((await facilitatorCommand(worker.origin, room, 'start')).receipt).toBe('accepted');
  const advance = async () => expect((await facilitatorCommand(worker.origin, room, 'advance')).receipt).toBe('accepted');
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await advance(); // arrival findings
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await advance(); // decision scene
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await advance(); // decision observations
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await advance(); // decision findings
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  await advance(); // explicitly Open responses after all authored context
  expect((await serverMirror(worker.origin, room)).phase).toBe('responses_open');
  await phone.getByRole('radio', { name: 'S00175 workshop label. Record a s' }).check();
  await expect(phone.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
  await expect(phone.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
  await expect.poll(async () => Object.keys((await serverMirror(worker.origin, room)).round.responses).length).toBe(1);
  expect(urls.every(url => !url.includes(worker.jwt) && !url.includes(room.facilitatorToken) && !url.includes('Sam'))).toBe(true);
  await context.close();
});
