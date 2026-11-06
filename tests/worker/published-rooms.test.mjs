import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { knownAccountFake } from '../helpers/admin-account-fixture.mjs';
import { directoryFor, roomFor } from '../../src/worker/directory-do.mjs';

const ORIGIN = 'https://case.test';
const SECRET = 'test-only-secret-not-for-production';
const workspaceId = uuidv7(), versionId = uuidv7(), userId = uuidv7();
const localEnv = { ...env, SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: 'sb_secret_test_only' };
const jwt = () => signTestJwt({ sub: userId, aud: 'authenticated', role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
const api = (path, { method = 'GET', token, body, requestEnv = localEnv } = {}) => worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}), requestEnv);
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
async function fakeFor(documentText = JSON.stringify(fixture)) {
  const fake = knownAccountFake({actors:[userId],origin:'https://postgrest.test'});
  // Admission is a separate known-actor stage; original queued faults target the business RPC.
  const authority = knownAccountFake({actors:[userId],origin:'https://postgrest.test'});
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fixture))));
  fake.replies.set('get_me', [{ user_id: userId, display_name: 'Facilitator',
    memberships: [{ workspace_id: workspaceId, role: 'owner' }], next_after: null, admin: false }]);
  fake.replies.set('get_case_version_for_workspace', [{ case_id: uuidv7(), version_no: 1,
    schema_version: 1, document_text: documentText, document: fixture, content_sha256: `\\x${hash}` }]);
  return {...fake,authorityRequests:authority.requests,fetchImpl:(input,init)=>
    new URL(input).pathname==='/rest/v1/rpc/admin_account_active'
      ? authority.fetchImpl(input,init) : fake.fetchImpl(input,init)};
}

function expectAuthority(fake) {
  expect(fake.authorityRequests.map(request=>({name:request.name,args:request.args})))
    .toEqual([{name:'admin_account_active',args:{p_user_id:userId}}]);
}

afterEach(() => vi.unstubAllGlobals());

it('[AS-078] starts an intact published version through real Worker and DO; participant joins without the full document', async () => {
  const fake = await fakeFor();
  vi.stubGlobal('fetch', fake.fetchImpl);
  const started = await api('/sessions', { method: 'POST', token: await jwt(),
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(started.status).toBe(201);
  const created = await started.json();
  expectAuthority(fake);
  expect(fake.requests.map(request => request.name)).toEqual([
    'get_me', 'ensure_profile', 'get_case_version_for_workspace', 'create_session',
    // Card 40 slice 3: one service-role read of the room's feedback code, carried into the ended projections.
    'session_feedback_code',
  ]);
  const joined = await api('/join', { method: 'POST', body: { v: 1, code: created.joinCode,
    displayName: 'Sam', avatarId: 'shadows-01' } });
  expect(joined.status).toBe(201);
  const participant = await joined.json();
  expect(JSON.stringify(participant)).not.toContain(fixture.summary);
  const command = (token, type, extra = {}) => api(`/sessions/${created.sessionId}/commands`, {
    method: 'POST', token, body: { v: 1, type, epoch: 0, clientEventId: uuidv7(), ...extra },
  });
  expect((await (await command(created.facilitatorToken, 'start')).json()).receipt.receipt).toBe('accepted');
  // The published MVC first shares Arrival's finding, then the decision scene,
  // observations and finding. Voting opens on its own observed-revision command.
  for (const nextGroup of ['findings', null, 'observations', 'findings', null]) {
    const observed = await (await api(`/sessions/${created.sessionId}/snapshot`,
      { token: created.facilitatorToken })).json();
    expect(observed.view.phase).toBe('surface_live');
    expect(observed.view.presentation.nextGroup).toBe(nextGroup);
    const advanced = await (await command(created.facilitatorToken, 'advance',
      { expectRevision: observed.view.revision })).json();
    expect(advanced.receipt.receipt).toBe('accepted');
  }
  const snapshot = await (await api(`/sessions/${created.sessionId}/snapshot`, { token: participant.token })).json();
  const decision = snapshot.view.decision;
  const vote = await command(participant.token, 'vote', { roundId: decision.roundId,
    response: { option_id: decision.interaction.options[0].id } });
  expect((await vote.json()).receipt.receipt).toBe('accepted');
  const pack = await api(`/sessions/${created.sessionId}/case-pack`, { token: created.facilitatorToken });
  expect(pack.status).toBe(200);
  expect(await pack.json()).toEqual(fixture);
});

it('the facilitator label: a this-session override is written for the new room and reaches only the ended recap', async () => {
  const fake = await fakeFor();
  vi.stubGlobal('fetch', fake.fetchImpl);
  const bad = await api('/sessions', { method: 'POST', token: await jwt(),
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60, facilitator: { name: 'Sam Lee', role: '' } } });
  expect(bad.status).toBe(400);
  expect(fake.requests).toEqual([]);
  const started = await api('/sessions', { method: 'POST', token: await jwt(),
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60, facilitator: { name: ' Sam  Lee', role: 'Consultant' } } });
  expect(started.status).toBe(201);
  const created = await started.json();
  expect(fake.requests.filter(r => r.name === 'set_session_facilitator_label').map(r => r.args))
    .toEqual([{ p_session_id: created.sessionId, p_label: 'Sam Lee, Consultant' }]);
  expect(fake.requests.some(r => r.name === 'set_own_facilitator_label')).toBe(false);
  const joined = await (await api('/join', { method: 'POST', body: { v: 1, code: created.joinCode, displayName: 'Ann', avatarId: 'shadows-01' } })).json();
  const before = await (await api(`/sessions/${created.sessionId}/snapshot`, { token: joined.token })).json();
  expect(JSON.stringify(before)).not.toContain('Sam Lee');
  const stub = roomFor(localEnv, created.sessionId);
  const live = await stub.snapshot(created.facilitatorToken);
  expect((await stub.command(created.facilitatorToken, { v: 1, type: 'end', epoch: live.snapshot.view.epoch, clientEventId: uuidv7() })).receipt.receipt).toBe('accepted');
  const after = await (await api(`/sessions/${created.sessionId}/snapshot`, { token: joined.token })).json();
  expect(after.view.recap.facilitator).toBe('Sam Lee, Consultant');
});

it('[AS-078] rejects tampered text before Directory or RoomDO storage exists', async () => {
  const fake = await fakeFor(JSON.stringify({ ...fixture, title: 'Tampered' }));
  vi.stubGlobal('fetch', fake.fetchImpl);
  const res = await api('/sessions', { method: 'POST', token: await jwt(),
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe('case_version_integrity');
  expectAuthority(fake);
  expect(fake.requests.map(request => request.name)).toEqual(['get_me', 'ensure_profile', 'get_case_version_for_workspace']);
});

it('[AS-078] denies nonmembers and translates a genuine RPC 42501 to safe 500', async () => {
  const fake = await fakeFor();
  fake.replies.set('get_me', [{ user_id: userId, display_name: null, memberships: [], next_after: null, admin: false }]);
  vi.stubGlobal('fetch', fake.fetchImpl);
  const body = { workspaceId, caseVersionId: versionId, ttlMinutes: 60 };
  expect((await api('/sessions', { method: 'POST', token: await jwt(), body })).status).toBe(403);
  expectAuthority(fake);
  expect(fake.requests.map(request => request.name)).toEqual(['get_me']);
  fake.faults.push({ status: 403, code: '42501' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const denied = await api('/sessions', { method: 'POST', token: await jwt(), body });
    expect(denied.status).toBe(500);
    expect(await denied.json()).toEqual({ error: 'internal_error' });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'facilitator_alert', reason: 'rpc_forbidden' }));
  } finally { log.mockRestore(); }
});

it('[AS-078] returns 503 before claiming a code when PostgREST is unavailable', async () => {
  const fake = await fakeFor();
  fake.faults.push({ status: 503, code: 'network' });
  vi.stubGlobal('fetch', fake.fetchImpl);
  const res = await api('/sessions', { method: 'POST', token: await jwt(),
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'unavailable' });
  expectAuthority(fake);
  expect(fake.requests.map(request => request.name)).toEqual(['get_me']);
});

it('[AS-078] retries a Postgres 23505 with a fresh join code and releases the collided code', async () => {
  const fake = await fakeFor();
  const original = fake.fetchImpl;
  let tries = 0;
  vi.stubGlobal('fetch', async (input, init) => {
    const result = await original(input, init);
    if (String(input).endsWith('/create_session') && tries++ === 0)
      return Response.json({ code: '23505', message: 'collision' }, { status: 409 });
    return result;
  });
  const started = await api('/sessions', { method: 'POST', token: await jwt(),
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(started.status).toBe(201);
  const claims = fake.requests.filter(request => request.name === 'create_session');
  expect(claims).toHaveLength(2);
  expect(claims[0].args.p_join_code).not.toBe(claims[1].args.p_join_code);
  expect((await directoryFor(localEnv, claims[0].args.p_join_code).lookup(claims[0].args.p_join_code)).error).toBe('unknown_code');
  expect((await directoryFor(localEnv, claims[1].args.p_join_code).lookup(claims[1].args.p_join_code)).sessionId)
    .toBe((await started.json()).sessionId);
});

it('[AS-078] leaves no joinable room after ambiguous Postgres insert', async () => {
  // This failure happens before RoomDO creation. Give its Worker Directory calls a fresh real
  // namespace so the whole-shard zero assertion cannot count another test's successful room.
  const namespace = uuidv7();
  const isolatedEnv = { ...localEnv, DIRECTORY: {
    idFromName: name => env.DIRECTORY.idFromName(`${namespace}:${name}`),
    get: (id, options) => env.DIRECTORY.get(id, options),
  } };
  const fake = await fakeFor();
  const original = fake.fetchImpl;
  const unrelatedSessionId = uuidv7();
  let unrelatedCode;
  vi.stubGlobal('fetch', async (input, init) => {
    const result = await original(input, init);
    if (String(input).endsWith('/create_session')) {
      const insertedCode = fake.requests.find(request => request.name === 'create_session').args.p_join_code;
      // Seed an unrelated live room in the shared shard used by this failed start.
      for (let attempt = 0; attempt < 2048; attempt++) {
        const candidate = newJoinCode();
        if (candidate[0] === insertedCode[0] && candidate !== insertedCode) { unrelatedCode = candidate; break; }
      }
      expect(unrelatedCode).toBeTruthy();
      expect(await directoryFor(localEnv, unrelatedCode).register(unrelatedCode, unrelatedSessionId,
        Date.now() + 60_000)).toBe(true);
      throw new Error('after commit response lost');
    }
    return result;
  });
  const res = await api('/sessions', { method: 'POST', token: await jwt(), requestEnv: isolatedEnv,
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(res.status).toBe(503);
  const ended = fake.requests.filter(request => request.name === 'end_session');
  expect(ended).toHaveLength(1);
  const inserted = fake.requests.find(request => request.name === 'create_session');
  expect(await directoryFor(isolatedEnv, inserted.args.p_join_code).countLive()).toBe(0);
  expect((await directoryFor(localEnv, unrelatedCode).lookup(unrelatedCode)).sessionId).toBe(unrelatedSessionId);
  await runInDurableObject(roomFor(localEnv, ended[0].args.p_session_id), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'meta'").toArray()).toEqual([]);
  });
});

it('[AS-078] abortCreate purges a potentially committed RoomDO, including its credential and alarm', async () => {
  const sessionId = uuidv7(), code = 'C5AB07';
  const stub = roomFor(localEnv, sessionId);
  const created = await stub.create({ sessionId, joinCode: code, caseDoc: fixture,
    caseVersionNo: 1, ownerUserId: userId, ttlMs: 60_000 });
  expect(created.facilitatorToken).toBeTruthy();
  expect(await stub.abortCreate(sessionId)).toEqual({ aborted: true });
  expect((await stub.snapshot(created.facilitatorToken)).status).toBe(404);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'meta'").toArray()).toEqual([]);
  });
});

it('[AS-100] a workspace listed in CASE_REFUSED_ROOM_WORKSPACES cannot start a room; others are unaffected', async () => {
  const fake = await fakeFor();
  vi.stubGlobal('fetch', fake.fetchImpl);
  const refusedEnv = { ...localEnv, CASE_REFUSED_ROOM_WORKSPACES: `${uuidv7()}, ${workspaceId}` };
  const refused = await api('/sessions', { method: 'POST', token: await jwt(), requestEnv: refusedEnv,
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: 'workspace_refused' });
  expect(fake.requests).toEqual([]); // refused before any workspace, version or session RPC
  const other = await api('/sessions', { method: 'POST', token: await jwt(),
    requestEnv: { ...localEnv, CASE_REFUSED_ROOM_WORKSPACES: uuidv7() },
    body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(other.status).toBe(201);
});
