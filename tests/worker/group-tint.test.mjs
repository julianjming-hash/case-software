// Card 30 (CASE-168 (4)): a running room keeps the group tint it started with. Room start reads the case's
// current tint with the published version (case_api.get_case_version_for_workspace) and the room's Durable
// Object stores it beside the case document, so a later retint or regroup never reaches a running room, and
// the recap shows the tint the room ran with. The tint is one of ten enum names; no other group field reaches
// a participant or projector payload. Real Worker and RoomDO in workerd; Supabase is the in-memory fake.
import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { describeCase, withSolution } from '../../src/shared/art-descriptor.mjs';
import { knownAccountFake } from '../helpers/admin-account-fixture.mjs';

const ORIGIN = 'https://case.test';
const workspaceId = uuidv7(), versionId = uuidv7(), userId = uuidv7(), caseId = uuidv7();
const localEnv = { ...env, SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: 'sb_secret_test_only' };
const jwt = () => signTestJwt({ sub: userId, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 },
  'test-only-secret-not-for-production');
const ART = withSolution(describeCase(fixture), { attempt: 1, summarised: false });
const api = (path, { method = 'GET', token, body } = {}) => worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}), localEnv);
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

async function fakeWith(tint) {
  const fake = knownAccountFake({ actors: [userId], origin: 'https://postgrest.test', versions: [] });
  const text = JSON.stringify(fixture);
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  fake.replies.set('get_me', [{ user_id: userId, display_name: 'Facilitator', memberships: [{ workspace_id: workspaceId, role: 'owner' }], next_after: null, admin: false }]);
  fake.replies.set('get_case_version_for_workspace', [{ case_id: caseId, version_no: 1, schema_version: 1,
    document_text: text, document: fixture, content_sha256: `\\x${hash}`, art: ART, tint }]);
  return fake;
}
async function startRoom(fake) {
  vi.stubGlobal('fetch', fake.fetchImpl);
  const started = await api('/sessions', { method: 'POST', token: await jwt(), body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(started.status).toBe(201);
  const room = await started.json();
  const joined = await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, displayName: 'Sam', avatarId: 'shadows-01' } });
  const participant = await joined.json();
  const pair = await (await api('/display-pairs', { method: 'POST' })).json();
  await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code } });
  const display = await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json();
  const view = async token => JSON.parse(await (await api(`/sessions/${room.sessionId}/snapshot`, { token })).text()).view;
  return { room, participant, display, view };
}

afterEach(() => vi.unstubAllGlobals());

it('[C30-tint] a room keeps the tint it started with through a retint, and so does its recap', async () => {
  const fake = await fakeWith('coral');
  const { room, participant, display, view } = await startRoom(fake);
  for (const token of [participant.token, display.token, room.facilitatorToken]) expect((await view(token)).tint).toBe('coral');
  // The group is retinted (and the case regrouped) while the room runs: the room never reads it again.
  fake.replies.set('get_case_version_for_workspace', [{ ...fake.replies.get('get_case_version_for_workspace')[0], tint: 'sky' }]);
  for (const token of [participant.token, display.token, room.facilitatorToken]) expect((await view(token)).tint).toBe('coral');
  const ended = await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token: room.facilitatorToken,
    body: { v: 1, type: 'end', epoch: 0, clientEventId: uuidv7() } });
  expect(ended.status).toBeLessThan(300);
  const recap = await view(participant.token);
  expect(recap.endedAt).not.toBeNull();
  expect(recap.tint).toBe('coral');
  // A new room started after the retint takes the current tint.
  vi.unstubAllGlobals();
  const next = await startRoom(fake);
  expect((await next.view(next.participant.token)).tint).toBe('sky');
});

it('[C30-tint] only the tint enum reaches public payloads; anything outside the ten is neutral', async () => {
  for (const [stored, expected] of [['plum', 'plum'], ['Emergency', 'neutral'], [null, 'neutral'], [undefined, 'neutral']]) {
    vi.unstubAllGlobals();
    const { participant, display, view } = await startRoom(await fakeWith(stored));
    for (const token of [participant.token, display.token]) {
      const seen = await view(token);
      expect(seen.tint).toBe(expected);
      expect(Object.keys(seen).filter(key => /group/i.test(key) && !/^(reveal|result)/i.test(key))).toEqual([]);
      expect(JSON.stringify(seen)).not.toContain('Emergency');
    }
  }
});
