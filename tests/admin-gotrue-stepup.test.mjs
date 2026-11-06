import test from 'node:test';
import assert from 'node:assert/strict';
import { gotrueAdminClient } from '../src/worker/admin/gotrue.mjs';
import { newCapabilityToken, uuidv7 } from '../src/shared/ids.mjs';

const config = { SUPABASE_URL: 'https://auth.invalid', SUPABASE_SECRET_KEY: `sb_secret_${newCapabilityToken()}` };
const email = 'admin@example.test';
const userId = uuidv7();

test('Card 21a step-up start sends one non-signup email OTP through fixed Auth path', async () => {
  const calls = [];
  const client = gotrueAdminClient(config, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({});
  } });
  assert.deepEqual(await client.startStepUp(email), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://auth.invalid/auth/v1/otp');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email, create_user: false });
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.apikey, config.SUPABASE_SECRET_KEY);
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test('Card 21a step-up verify discards GoTrue session and refuses other-email codes', async () => {
  const calls = [];
  let returnedEmail = email;
  const client = gotrueAdminClient(config, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ user: { id: userId, email: returnedEmail },
      access_token: 'private-access', refresh_token: 'private-refresh' });
  } });
  assert.deepEqual(await client.verifyStepUp(email, '123456'), { ok: true });
  assert.equal(calls[0].url, 'https://auth.invalid/auth/v1/verify');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email, token: '123456', type: 'email' });
  assert.equal(JSON.stringify(await client.verifyStepUp(email, '123456')).includes('private'), false);
  returnedEmail = 'other@example.test';
  assert.deepEqual(await client.verifyStepUp(email, '123456'), { ok: false, kind: 'forbidden' });
  assert.equal(JSON.stringify(calls).includes('private-access'), false);
});

test('Card 21a step-up cancels hostile denied response body without waiting', async () => {
  let cancelled = 0;
  const client = gotrueAdminClient(config, { fetchImpl: async () =>
    new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }), { status: 403 }) });
  assert.deepEqual(await client.startStepUp(email), { ok: false, kind: 'unavailable' });
  await Promise.resolve();
  assert.equal(cancelled, 1);
});

test('Card 21a invite sends one email body to supported fixed endpoint and projects only user ID', async () => {
  const calls = [];
  const client = gotrueAdminClient(config, { caseOrigin: 'https://case.invalid',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ id: userId, email, user_metadata: { private: 'not returned' } });
    } });
  assert.deepEqual(await client.inviteUser(email), { ok: true, userId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url,
    'https://auth.invalid/auth/v1/invite?redirect_to=https%3A%2F%2Fcase.invalid%2F');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email });
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.apikey, config.SUPABASE_SECRET_KEY);
  assert.equal(JSON.stringify(await client.inviteUser(email)).includes('private'), false);
});

test('Card 21a ambiguous invite timeout is one-shot and returns no apparent success', async () => {
  let calls = 0;
  const client = gotrueAdminClient(config, { caseOrigin: 'https://case.invalid', timeoutMs: 20,
    fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  assert.deepEqual(await client.inviteUser(email), { ok: false, kind: 'unknown_outcome' });
  assert.equal(calls, 1);
  const serverFailed = gotrueAdminClient(config, { caseOrigin: 'https://case.invalid',
    fetchImpl: async () => { calls++; return Response.json({ error: 'private upstream' }, { status: 500 }); } });
  assert.deepEqual(await serverFailed.inviteUser(email), { ok: false, kind: 'unknown_outcome' });
  assert.equal(calls, 2);
});


test('Card 21a successful OTP cancels its unread hostile body without waiting or exposing it', async () => {
  let cancelled = 0, pulled = 0;
  const client = gotrueAdminClient(config, { timeoutMs: 50, fetchImpl: async () =>
    new Response(new ReadableStream({
      pull() { pulled++; return new Promise(() => {}); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }), { status: 200 }) });
  const result = await Promise.race([client.startStepUp(email),
    new Promise(resolve => setTimeout(() => resolve('did_not_settle'), 200))]);
  assert.deepEqual(result, { ok: true });
  assert.equal(cancelled, 1);
  assert.ok(pulled <= 1);
});

test('Card 21a verify accepts only exactly six ASCII digits before any external request', async () => {
  let calls = 0;
  const client = gotrueAdminClient(config, { fetchImpl: async () => {
    calls++; return Response.json({ user: { id: userId, email } });
  } });
  for (const code of ['123456\n', '123456\r', '123456\u2028', '１２３４５６', '12345', '1234567']) {
    assert.deepEqual(await client.verifyStepUp(email, code), { ok: false, kind: 'bad_request' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await client.verifyStepUp(email, '123456'), { ok: true });
  assert.equal(calls, 1);
});
