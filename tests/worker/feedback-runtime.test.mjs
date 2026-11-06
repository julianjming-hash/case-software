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
  return { ...room, stub: env.ROOM.get(env.ROOM.idFromName(room.sessionId)) };
}
async function join(room, name = 'Sam') {
  const res = await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, displayName: name, avatarId: 'shadows-01' } });
  expect(res.status).toBe(201);
  return res.json();
}
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** A scripted PostgREST for the three feedback RPCs, plus a Turnstile siteverify verdict. Records every call. */
function fakeDb({ rooms = {}, mine = null, upsert = null, turnstile = true } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.href === turnstileSiteverifyUrl()) {
      calls.push({ name: 'siteverify' });
      return Response.json({ success: turnstile, hostname: 'case.iatrogenic.app', action: 'join' });
    }
    const name = url.pathname.split('/').at(-1), args = JSON.parse(init.body ?? '{}');
    calls.push({ name, args, url: url.href });
    if (name === 'feedback_resolve') return Response.json(rooms[args.p_code] ?? null);
    if (name === 'feedback_mine') return Response.json(typeof mine === 'function' ? mine(args) : mine);
    if (name === 'feedback_upsert') {
      const r = typeof upsert === 'function' ? upsert(args) : upsert;
      if (r?.sqlstate) return Response.json({ code: r.sqlstate, message: 'feedback refusal', details: null, hint: null }, { status: 400 });
      return Response.json(r ?? { revision: 1, updated_at: '2026-10-17T08:00:00Z', closes_at: '2026-10-18T08:00:00Z' });
    }
    return Response.json({ code: 'PGRST202' }, { status: 404 });
  });
  return calls;
}
const DB_ENV = { SUPABASE_URL: 'https://feedback-db.invalid/', SUPABASE_SECRET_KEY: `sb_secret_${newCapabilityToken()}` };
const call = (path, { method = 'GET', auth, body, extraEnv = {}, ip = '203.0.113.9' } = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { method, headers: { 'cf-connecting-ip': ip, ...(auth ? { authorization: auth } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), { ...env, ...DB_ENV, ...extraEnv });
const open = (sessionId) => ({ state: 'open', session_id: sessionId, title: 'Fixture case', version_no: 1, audience: 'Registrars',
  started_at: '2026-10-17T06:00:00Z', ended_at: '2026-10-17T07:00:00Z', closes_at: '2026-10-18T07:00:00Z', objectives: ['First.'], form_url: null });
// A deployed environment (Turnstile is configured only there) needs its full, test-only auth configuration.
const TURNSTILE_ENV = { CASE_ENV: 'production', TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_SITE_KEY: 'test-site-key',
  CASE_ALLOW_HS256: '0', SUPABASE_JWT_ISSUER: 'https://feedback-db.invalid/auth/v1', SUPABASE_JWKS_URL: 'https://feedback-db.invalid/auth/v1/.well-known/jwks.json' };

describe('feedback respondent in the room DO (R8)', () => {
  it('[P-35] returns only a per-room HMAC for a participant credential, stable per phone and refused for every other role', async () => {
    const room = await newRoom(), a = await join(room, 'Sam'), b = await join(room, 'Kai');
    const first = await room.stub.feedbackRespondent(a.token, room.sessionId);
    expect(Object.keys(first)).toEqual(['respondent']);
    expect(first.respondent).toMatch(/^[0-9a-f]{64}$/);
    expect((await room.stub.feedbackRespondent(a.token, room.sessionId)).respondent).toBe(first.respondent);
    expect((await room.stub.feedbackRespondent(b.token, room.sessionId)).respondent).not.toBe(first.respondent);
    // Not a plain hash of the participant id: without the room's salt the value cannot be enumerated.
    expect(first.respondent).not.toBe(await sha(`joined:${room.sessionId}:${a.participantId}`));
    expect(first.respondent).not.toContain(a.participantId.replaceAll('-', ''));
    expect(await room.stub.feedbackRespondent(room.facilitatorToken, room.sessionId)).toMatchObject({ error: 'forbidden', status: 403 });
    const display = await room.stub.issueDisplayToken();
    expect(await room.stub.feedbackRespondent(display.token, room.sessionId)).toMatchObject({ error: 'forbidden', status: 403 });
    expect(await room.stub.feedbackRespondent(a.token, uuidv7())).toMatchObject({ error: 'forbidden', status: 403 });
    expect(await room.stub.feedbackRespondent(newCapabilityToken(), room.sessionId)).toMatchObject({ status: 401 });
  });

  it('room A\'s participant token is not a respondent in room B', async () => {
    const roomA = await newRoom(), roomB = await newRoom(), a = await join(roomA);
    expect(await roomB.stub.feedbackRespondent(a.token, roomB.sessionId)).toMatchObject({ status: 401 });
  });
});

describe('feedback routes (P-35, AS-171)', () => {
  it('[AS-171] a joined phone is one editable respondent, also when it arrives from the QR; credentials travel only in the header', async () => {
    const room = await newRoom(), p = await join(room), code = newJoinCode();
    const calls = fakeDb({ rooms: { [code]: open(room.sessionId) } });
    const resolved = await call(feedbackPath(code));
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get('cache-control')).toContain('no-store');
    expect(await resolved.json()).toMatchObject({ state: 'open', sessionId: room.sessionId, title: 'Fixture case', versionNo: 1, objectives: ['First.'] });
    const answers = { rating_session: 4, takeaway: '  Re-examine early. ' };
    const put = await call(feedbackPath(code), { method: 'PUT', auth: `Participant ${p.token}`, body: { answers } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ revision: 1, updatedAt: '2026-10-17T08:00:00Z', closesAt: '2026-10-18T08:00:00Z' });
    const again = await call(feedbackPath(code), { method: 'PUT', auth: `Participant ${p.token}`, body: { answers: { rating_session: 3 }, expectedRevision: 1 } });
    expect(again.status).toBe(200);
    const upserts = calls.filter(c => c.name === 'feedback_upsert');
    expect(upserts).toHaveLength(2);
    expect(upserts[0].args).toMatchObject({ p_session_id: room.sessionId, p_source: 'joined', p_answers: { rating_session: 4, takeaway: 'Re-examine early.' } });
    expect(upserts[0].args.p_respondent_sha256).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(upserts[1].args.p_respondent_sha256).toBe(upserts[0].args.p_respondent_sha256);
    expect(calls.some(c => c.name === 'siteverify')).toBe(false); // a joined phone is never challenged
    for (const c of calls) expect(c.url ?? '').not.toContain(p.token);
  });

  it('refuses another room\'s participant token, a facilitator or display token, and a token outside the header', async () => {
    const roomA = await newRoom(), roomB = await newRoom(), a = await join(roomA), code = newJoinCode();
    const calls = fakeDb({ rooms: { [code]: open(roomB.sessionId) } });
    const display = await roomB.stub.issueDisplayToken();
    for (const auth of [`Participant ${a.token}`, `Participant ${roomB.facilitatorToken}`, `Participant ${display.token}`, `Bearer ${a.token}`, 'Participant short']) {
      const r = await call(feedbackPath(code), { method: 'PUT', auth, body: { answers: { rating_app: 3 } } });
      expect([401, 403]).toContain(r.status);
    }
    const query = await call(`${feedbackPath(code)}?token=${a.token}`, { method: 'PUT', body: { answers: { rating_app: 3 } } });
    expect(query.status).toBe(401);
    expect(calls.filter(c => c.name === 'feedback_upsert')).toHaveLength(0);
  });

  it('QR responses are separate, keyed by a browser key, Turnstile-gated on the first send only', async () => {
    const code = newJoinCode(), sessionId = uuidv7(), key = newCapabilityToken();
    let existing = null;
    const calls = fakeDb({ rooms: { [code]: open(sessionId) }, mine: () => existing });
    const first = await call(feedbackPath(code), { method: 'PUT', auth: `Feedback ${key}`, body: { answers: { rating_app: 5 } }, extraEnv: TURNSTILE_ENV });
    expect(first.status).toBe(428);
    expect(await first.json()).toEqual({ error: 'challenge_required', siteKey: 'test-site-key' });
    const verified = await call(feedbackPath(code), { method: 'PUT', auth: `Feedback ${key}`, body: { answers: { rating_app: 5 }, turnstileToken: 'one-use' }, extraEnv: TURNSTILE_ENV });
    expect(verified.status).toBe(200);
    const upsert = calls.find(c => c.name === 'feedback_upsert');
    expect(upsert.args).toMatchObject({ p_session_id: sessionId, p_source: 'qr', p_respondent_sha256: `\\x${await sha(`qr:${key}`)}` });
    existing = { answers: { rating_app: 5 }, revision: 1, closes_at: '2026-10-18T07:00:00Z' };
    const edit = await call(feedbackPath(code), { method: 'PUT', auth: `Feedback ${key}`, body: { answers: { rating_app: 4 }, expectedRevision: 1 }, extraEnv: TURNSTILE_ENV });
    expect(edit.status).toBe(200);
    expect(calls.filter(c => c.name === 'siteverify')).toHaveLength(1);
    const refused = fakeDb({ rooms: { [code]: open(sessionId) }, turnstile: false });
    const bad = await call(feedbackPath(code), { method: 'PUT', auth: `Feedback ${newCapabilityToken()}`, body: { answers: { rating_app: 5 }, turnstileToken: 'wrong' }, extraEnv: TURNSTILE_ENV });
    expect(bad.status).toBe(403);
    expect(refused.filter(c => c.name === 'feedback_upsert')).toHaveLength(0);
  });

  it('answers a bad, unknown or malformed code with one uniform 404', async () => {
    fakeDb();
    const bodies = [];
    for (const path of [feedbackPath(newJoinCode()), '/api/v1/feedback/XX', '/api/v1/feedback/not-a-code-at-all', '/api/v1/feedback/7K3QX9/other']) {
      const r = await call(path);
      expect(r.status).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: 'not_found' });
  });

  it('reports the window, the caps and conflicts without writing, and maps a full QR room', async () => {
    const code = newJoinCode(), early = newJoinCode(), closed = newJoinCode(), sessionId = uuidv7(), key = newCapabilityToken();
    let mine = null;
    const calls = fakeDb({ rooms: { [code]: open(sessionId), [early]: { state: 'not_ended' }, [closed]: { ...open(sessionId), state: 'closed' } },
      mine: () => mine, upsert: () => ({ sqlstate: '23514' }) });
    const before = await call(feedbackPath(early));
    expect(await before.json()).toEqual({ state: 'not_ended' });
    const put = (c, body) => call(feedbackPath(c), { method: 'PUT', auth: `Feedback ${key}`, body });
    expect((await put(early, { answers: { rating_app: 1 } })).status).toBe(409);
    expect(await (await put(closed, { answers: { rating_app: 1 } })).json()).toEqual({ error: 'feedback_closed' });
    expect(await (await put(code, { answers: { rating_app: 9 } })).json()).toEqual({ error: 'invalid_feedback' });
    expect(calls.filter(c => c.name === 'feedback_upsert')).toHaveLength(0);
    expect(await (await put(code, { answers: { rating_app: 2 } })).json()).toEqual({ error: 'feedback_full' });
    mine = { answers: { rating_app: 2 }, revision: 21, closes_at: '2026-10-18T07:00:00Z' };
    expect(await (await put(code, { answers: { rating_app: 3 }, expectedRevision: 21 })).json()).toEqual({ error: 'feedback_edit_cap' });
    mine = { answers: { rating_app: 2 }, revision: 3, closes_at: '2026-10-18T07:00:00Z' };
    expect(await (await put(code, { answers: { rating_app: 3 }, expectedRevision: 2 })).json()).toEqual({ error: 'feedback_conflict' });
  });

  it('reads one\'s own answers only with a credential in the header', async () => {
    const code = newJoinCode(), key = newCapabilityToken();
    fakeDb({ rooms: { [code]: open(uuidv7()) }, mine: { answers: { rating_case: 5 }, revision: 2, closes_at: '2026-10-18T07:00:00Z' } });
    expect((await call(feedbackMinePath(code))).status).toBe(401);
    const r = await call(feedbackMinePath(code), { auth: `Feedback ${key}` });
    expect(await r.json()).toEqual({ answers: { rating_case: 5 }, revision: 2, closesAt: '2026-10-18T07:00:00Z' });
  });
});
