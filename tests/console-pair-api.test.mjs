import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { handleConsolePairApi } from '../src/worker/console-pairs.mjs';

const pairId = uuidv7(), sessionId = uuidv7(), workspaceId = uuidv7(), userId = '550e8400-e29b-41d4-a716-446655440000';
const code = 'ABCD2345', secret = 'test-only-pair-secret';
function request(path, { method = 'GET', body, token, cf } = {}) {
  const result = new Request(`https://case.test/api/v1${path}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'Chrome/120.0' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  Object.defineProperty(result, 'cf', { value: cf ?? { country: 'AU', city: 'Perth' } });
  return result;
}
function harness({ owner = true, expired = false, limited = false, member = true } = {}) {
  const calls = [];
  let consumed = false;
  const pairs = {
    async createConsolePair(details) { calls.push('create'); assert.equal(details.browser, 'Chrome');
      return { pairId, code, secret, expiresAt: '2026-10-02T00:05:00.000Z' }; },
    async previewConsolePair(given) { calls.push('preview'); return given === code && !expired
      ? { browser: 'Chrome', country: 'AU', city: 'Perth', requestedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2026-10-02T00:05:00.000Z' }
      : { error: 'unknown_or_expired_code' }; },
    async approveConsolePair(given, roomId, ownerId) { calls.push('approve');
      assert.deepEqual([given, roomId, ownerId], [code, sessionId, userId]); return { ok: true }; },
    async pollConsolePair(givenId, givenSecret) { calls.push('poll');
      if (consumed || givenId !== pairId || givenSecret !== secret) return { error: 'unknown_pair' };
      consumed = true; return { approved: true, sessionId, userId }; },
  };
  const room = {
    async canIssueFacilitatorToken(given) { calls.push('owner-check'); assert.equal(given, userId);
      return owner ? { ok: true, workspaceId, ownerAdminDigest: null } : { error: 'forbidden', status: 403 }; },
    async issueSharedConsoleToken(given) { calls.push('mint'); assert.equal(given, userId);
      return owner ? { facilitatorToken: 'room-only-token' } : { error: 'forbidden', status: 403 }; },
  };
  const dependencies = { env: {}, pairs, roomFor: () => room,
    verifyUser: async token => token === 'account-jwt' ? { userId } : null,
    rateLimited: async () => limited,
    // The Worker's membership-or-admin recheck before any console mint (card 35); here a recorder.
    mayMint: async (actor, roomView, action) => { calls.push(['recheck', actor.userId, actor.admin, roomView.workspaceId, action]);
      return member ? { ok: true } : { ok: false, error: 'forbidden', status: 403 }; } };
  return { calls, dependencies };
}

test('[AS-080] shared PC creates an expiring code; JWT phone previews only coarse details and approves its room', async () => {
  const run = harness();
  const created = await handleConsolePairApi(request('/console-pairs', { method: 'POST' }), run.dependencies);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { pairId, code, secret, expiresAt: '2026-10-02T00:05:00.000Z' });
  const preview = await handleConsolePairApi(request('/console-pairs/preview', { method: 'POST', token: 'account-jwt', body: { code } }), run.dependencies);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { browser: 'Chrome', country: 'AU', city: 'Perth',
    requestedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2026-10-02T00:05:00.000Z' });
  const approved = await handleConsolePairApi(request('/console-pairs/approve', { method: 'POST', token: 'account-jwt', body: { code, sessionId } }), run.dependencies);
  assert.equal(approved.status, 200);
  assert.deepEqual(run.calls, ['create', 'preview', 'owner-check', ['recheck', userId, false, workspaceId, 'P-25'], 'approve']);
});

test('[AS-080] pair pickup gives the PC only a room token once; a reused secret is refused', async () => {
  const run = harness();
  const path = `/console-pairs/${pairId}`;
  const picked = await handleConsolePairApi(request(path, { token: secret }), run.dependencies);
  assert.equal(picked.status, 200);
  assert.deepEqual(await picked.json(), { sessionId, facilitatorToken: 'room-only-token' });
  assert.equal((await handleConsolePairApi(request(path, { token: secret }), run.dependencies)).status, 404);
  assert.deepEqual(run.calls, ['poll', 'owner-check', ['recheck', userId, false, workspaceId, 'P-24'], 'mint', 'poll']);
});

test('[AS-080] a nonowner, missing JWT, expired code and create flood fail before approval or mint', async () => {
  const denied = harness({ owner: false });
  assert.equal((await handleConsolePairApi(request('/console-pairs/approve', { method: 'POST', token: 'account-jwt',
    body: { code, sessionId } }), denied.dependencies)).status, 403);
  assert.deepEqual(denied.calls, ['owner-check']);
  assert.equal((await handleConsolePairApi(request('/console-pairs/preview', { method: 'POST', body: { code } }), denied.dependencies)).status, 401);
  const expired = harness({ expired: true });
  assert.equal((await handleConsolePairApi(request('/console-pairs/preview', { method: 'POST', token: 'account-jwt',
    body: { code } }), expired.dependencies)).status, 404);
  const flood = harness({ limited: true });
  assert.equal((await handleConsolePairApi(request('/console-pairs', { method: 'POST' }), flood.dependencies)).status, 429);
  assert.deepEqual(flood.calls, []);
});

test('[PM-22] a starter taken off the workspace mid-room gets no new shared-PC approval or pickup mint', async () => {
  const removed = harness({ member: false });
  const approve = await handleConsolePairApi(request('/console-pairs/approve', { method: 'POST', token: 'account-jwt',
    body: { code, sessionId } }), removed.dependencies);
  assert.equal(approve.status, 403);
  assert.equal(removed.calls.includes('approve'), false);
  const pickup = await handleConsolePairApi(request(`/console-pairs/${pairId}`, { token: secret }), removed.dependencies);
  assert.equal(pickup.status, 403);
  assert.equal(removed.calls.includes('mint'), false);
  // Without the recheck wired, nothing is minted or approved either (fail closed).
  const unwired = harness();
  delete unwired.dependencies.mayMint;
  assert.equal((await handleConsolePairApi(request('/console-pairs/approve', { method: 'POST', token: 'account-jwt',
    body: { code, sessionId } }), unwired.dependencies)).status, 503);
  assert.equal((await handleConsolePairApi(request(`/console-pairs/${pairId}`, { token: secret }), unwired.dependencies)).status, 503);
  assert.equal(unwired.calls.some(call => call === 'approve' || call === 'mint'), false);
});
