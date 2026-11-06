// Participant feedback (CASE-284 slice 4, P-35) in a real workerd: the room DO's respondent handler (R8) and the
// Worker's /api/v1/feedback routes against a scripted fake PostgREST and a fake Turnstile verdict.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { newCapabilityToken, newJoinCode, uuidv7 } from '../../src/shared/ids.mjs';
import { apiPath, turnstileSiteverifyUrl } from '../../src/shared/urls.mjs';
const feedbackPath = code => apiPath('feedback', code), feedbackMinePath = code => apiPath('feedback', code, 'mine');
import { nativeAccountFetch } from './admin-fixtures.mjs';

afterEach(() => vi.unstubAllGlobals());
const SECRET = 'test-only-secret-not-for-production';
const BASE = 'https://case.test';
const users = [];
const jwt = sub => signTestJwt({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
const api = async (path, { method = 'GET', token, body } = {}) => nativeAccountFetch(`${BASE}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined }, users);
async function newRoom() {
  const sub = uuidv7(); users.push(sub);
  const res = await api('/sessions', { method: 'POST', token: await jwt(sub), body: { caseDocument: fixture } });
  expect(res.status).toBe(201);
  const room = await res.json();
  return { ...room, ownerUserId:sub, stub: env.ROOM.get(env.ROOM.idFromName(room.sessionId)) };
}
async function join(room, name = 'Sam') {
  const res = await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, displayName: name, avatarId: 'shadows-01' } });
  expect(res.status).toBe(201);
  return res.json();
}

describe('beta report room capability',()=>{
 it('is per-participant, per-room, distinct from Feedback and refuses nonparticipants',async()=>{
  const room=await newRoom(),a=await join(room,'Beta Sam'),b=await join(room,'Beta Kai');
  const proof=await room.stub.issueRespondent(a.token,room.sessionId);
  expect(proof.respondent).toMatch(/^[a-f0-9]{64}$/);
  expect(await room.stub.issueRespondent(a.token,room.sessionId)).toEqual(proof);
  expect((await room.stub.issueRespondent(b.token,room.sessionId)).respondent).not.toBe(proof.respondent);
  expect((await room.stub.feedbackRespondent(a.token,room.sessionId)).respondent).not.toBe(proof.respondent);
  expect(await room.stub.issueRespondent(room.facilitatorToken,room.sessionId)).toMatchObject({error:'forbidden'});
  const display=await room.stub.issueDisplayToken();expect(await room.stub.issueRespondent(display.token,room.sessionId)).toMatchObject({error:'forbidden'});
  expect(await room.stub.issueRespondent(a.token,uuidv7())).toMatchObject({error:'forbidden'});
  const other=await newRoom();expect(await other.stub.issueRespondent(a.token,other.sessionId)).toMatchObject({status:401});
  await room.stub.adminEnd({sessionId:room.sessionId,expectedOwnerUserId:room.ownerUserId,eventId:uuidv7()});
  expect(await room.stub.issueRespondent(a.token,room.sessionId)).toEqual(proof); // recap capability remains current until retirement
 });
});
