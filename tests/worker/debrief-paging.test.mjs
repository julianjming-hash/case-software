// Card 40 + feedback integration slice 5: paging the ended projector's debrief (I3; red-team R2–R4), in real workerd.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { nativeAccountFetch } from './admin-fixtures.mjs';

const SECRET = 'test-only-secret-not-for-production', BASE = 'https://case.test';
const ids = new Map(), userId = (l) => { if (!ids.has(l)) ids.set(l, uuidv7()); return ids.get(l); };
const jwt = (sub = 'user-1') => signTestJwt({ sub: userId(sub), aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
const api = (path, { method = 'GET', token, body } = {}) => nativeAccountFetch(`${BASE}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) }, [...ids.values()]);
const cmd = (type, extra = {}, epoch = 0) => ({ v: 1, type, epoch, clientEventId: uuidv7(), ...extra });

async function endedRoom() {
  const res = await api('/sessions', { method: 'POST', token: await jwt(), body: { caseDocument: fixture } });
  expect(res.status).toBe(201);
  const room = await res.json(), stub = env.ROOM.get(env.ROOM.idFromName(room.sessionId));
  const display = (await stub.issueDisplayToken()).token;
  const ended = await (await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token: room.facilitatorToken, body: cmd('end') })).json();
  expect(ended.receipt.receipt).toBe('accepted');
  return { ...room, stub, display };
}
const path = (room, p) => `/sessions/${room.sessionId}${p}`;
const displaySnap = async (room) => (await api(path(room, '/snapshot'), { token: room.display })).json();

describe('[card 40 paging] the ended projector debrief', () => {
  it('needs an ended room and a facilitator credential; a phone cannot mint it', async () => {
    const res = await api('/sessions', { method: 'POST', token: await jwt(), body: { caseDocument: fixture } });
    const room = await res.json();
    expect((await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).status).toBe(409);
    const joined = await (await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, displayName: 'Sam', avatarId: 'shadows-01' } })).json();
    await api(path(room, '/commands'), { method: 'POST', token: room.facilitatorToken, body: cmd('end') });
    expect((await api(path(room, '/debrief/grant'), { method: 'POST', token: joined.token })).status).toBe(403);
  });

  it('a grant moves only the page; each move advances the display revision; results show only while it lives', async () => {
    const room = await endedRoom();
    const before = await displaySnap(room);
    expect(before.view.debrief).toMatchObject({ results: [] });
    expect(before.view.debrief.page).toBeUndefined();
    const grant = await (await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).json();
    expect(typeof grant.token).toBe('string');
    expect(grant.pages).toBeGreaterThanOrEqual(1);
    const granted = await displaySnap(room);
    expect(granted.displayRevision).toBeGreaterThan(before.displayRevision);
    expect(granted.view.debrief.page).toBe(0);
    const moved = await (await api(path(room, '/debrief/page'), { method: 'POST', token: grant.token, body: { page: 99 } })).json();
    expect(moved.page).toBe(grant.pages - 1); // clamped, never past the last page
    const after = await displaySnap(room);
    expect(after.displayRevision).toBeGreaterThan(granted.displayRevision);
    expect(after.view.debrief.page).toBe(moved.page);
    expect(JSON.stringify(after.view)).not.toMatch(/rationale|notes|"cue"|classification/);
  });

  it('a long-poll display wakes on a page change', async () => {
    const room = await endedRoom();
    const grant = await (await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).json();
    const s0 = await displaySnap(room);
    const waiting = api(path(room, `/updates?after=${s0.revision}&afterDisplay=${s0.displayRevision}&wait=10`), { token: room.display });
    await api(path(room, '/debrief/page'), { method: 'POST', token: grant.token, body: { page: 0 } });
    const woke = await (await waiting).json();
    expect(woke.t).toBe('snapshot');
    expect(woke.displayRevision).toBeGreaterThan(s0.displayRevision);
  });

  it('revoke ends results on the projector and the grant itself', async () => {
    const room = await endedRoom();
    const grant = await (await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).json();
    expect((await api(path(room, '/debrief/revoke'), { method: 'POST', token: grant.token })).status).toBe(200);
    expect((await displaySnap(room)).view.debrief.page).toBeUndefined();
    expect((await api(path(room, '/debrief/page'), { method: 'POST', token: grant.token, body: { page: 0 } })).status).toBe(401);
    expect((await api(path(room, '/debrief/view'), { token: grant.token })).status).toBe(401);
  });

  it('dies with its parent: an admin end after End revokes the facilitator and so the grant', async () => {
    const room = await endedRoom();
    const grant = await (await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).json();
    const r = await room.stub.adminEnd({ sessionId: room.sessionId, expectedOwnerUserId: userId('user-1'), eventId: uuidv7() });
    expect(r.ok).toBe(true);
    expect((await api(path(room, '/debrief/page'), { method: 'POST', token: grant.token, body: { page: 0 } })).status).toBe(401);
    expect((await displaySnap(room)).view.debrief.page).toBeUndefined();
    expect((await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).status).toBe(401);
  });

  it('is never a room credential and never works in another room', async () => {
    const a = await endedRoom(), b = await endedRoom();
    const grant = await (await api(path(a, '/debrief/grant'), { method: 'POST', token: a.facilitatorToken })).json();
    for (const p of ['/snapshot', '/case-pack']) expect((await api(path(a, p), { token: grant.token })).status).toBe(401);
    expect((await api(path(a, '/commands'), { method: 'POST', token: grant.token, body: cmd('start') })).status).toBe(401);
    expect((await api(path(b, '/debrief/page'), { method: 'POST', token: grant.token, body: { page: 0 } })).status).toBe(401);
  });

  it('expires at its absolute TTL whatever the console does', async () => {
    const room = await endedRoom();
    const grant = await (await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).json();
    await runInDurableObject(room.stub, (_instance, state) => {
      const row = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'debrief_grant'").toArray()[0];
      const g = JSON.parse(row.value); g.exp = Date.now() - 1;
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'debrief_grant'", JSON.stringify(g));
    });
    expect((await api(path(room, '/debrief/page'), { method: 'POST', token: grant.token, body: { page: 0 } })).status).toBe(401);
  });

  it('the private pack is refused to every credential once the room has ended (red-team R3)', async () => {
    const room = await endedRoom();
    expect((await api(path(room, '/case-pack'), { token: room.facilitatorToken })).status).toBe(410);
  });

  it('the same-PC relay view is the public display view, nothing more', async () => {
    const room = await endedRoom();
    const grant = await (await api(path(room, '/debrief/grant'), { method: 'POST', token: room.facilitatorToken })).json();
    const view = await (await api(path(room, '/debrief/view'), { token: grant.token })).json();
    expect(view.view.role).toBe('display');
    expect(view.mirror).toBeUndefined();
    expect(JSON.stringify(view)).not.toMatch(/rationale|notes|"cue"|classification|facilitatorToken/);
  });
});
