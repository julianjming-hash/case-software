// Card 35b, PERMISSIONS E27 / P-27 (CASE-177): the room starter lists the room's console credentials and revokes
// one shared computer. Its socket closes at once, its token is dead for every read, write and socket, and it has no
// way to mint again; the starter's own console and every other shared computer carry on. Real workerd (Miniflare).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { nativeAccountFetch } from './admin-fixtures.mjs';

const BASE = 'https://case.test';
const users = new Map();
const userId = label => { if (!users.has(label)) users.set(label, uuidv7()); return users.get(label); };
const jwt = (label = 'starter') => signTestJwt({ sub: userId(label), aud: 'authenticated', role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-only-secret-not-for-production');
const api = (path, { method = 'GET', token, body } = {}) => nativeAccountFetch(`${BASE}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}, [...users.values()]);

async function newRoom() {
  const res = await api('/sessions', { method: 'POST', token: await jwt(), body: { caseDocument: fixture } });
  expect(res.status).toBe(201);
  const room = await res.json();
  return { ...room, stub: env.ROOM.get(env.ROOM.idFromName(room.sessionId)) };
}
/** A shared computer the starter approved (the real pair, approve and pickup routes); no takeover is sent. */
async function sharedPc(room) {
  const pair = await (await api('/console-pairs', { method: 'POST' })).json();
  expect((await api('/console-pairs/approve', { method: 'POST', token: await jwt(), body: { code: pair.code, sessionId: room.sessionId } })).status).toBe(200);
  const picked = await api(`/console-pairs/${pair.pairId}`, { token: pair.secret });
  expect(picked.status).toBe(200);
  return (await picked.json()).facilitatorToken;
}
const list = async (room, label = 'starter') => api(`/sessions/${room.sessionId}/consoles`, { token: await jwt(label) });
const revoke = async (room, id, label = 'starter') => api(`/sessions/${room.sessionId}/consoles/revoke`, { method: 'POST', token: await jwt(label), body: { id } });
const snapshotStatus = async (room, token) => (await api(`/sessions/${room.sessionId}/snapshot`, { token })).status;
async function socket(room, token) {
  const res = await SELF.fetch(`${BASE}/api/v1/sessions/${room.sessionId}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket; ws.accept();
  const frames = [];
  const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code)));
  const snapshot = new Promise(resolve => ws.addEventListener('message', event => {
    frames.push(event.data); if (/"view"/.test(event.data)) resolve(true);
  }));
  ws.send(JSON.stringify({ v: 1, t: 'hello', token, lastRevision: 0, lastEpoch: 0 }));
  return { ws, closed, snapshot, frames };
}

describe('[PM-27] per-credential console revoke (E27)', () => {
  it('[AS-109] the starter lists console credentials with device kind and issue time only', async () => {
    const room = await newRoom();
    await sharedPc(room);
    const res = await list(room);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consoles.map(c => c.kind)).toEqual(['starter', 'shared']);
    for (const entry of body.consoles) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'issuedAt', 'kind']);
      expect(Number.isSafeInteger(entry.id)).toBe(true);
      expect(Number.isFinite(Date.parse(entry.issuedAt))).toBe(true);
    }
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}|token|user/i);
  });

  it('[AS-109] revoking a shared computer closes its socket now and kills its token; the starter and another PC carry on', async () => {
    const room = await newRoom();
    const pcA = await sharedPc(room), pcB = await sharedPc(room);
    const a = await socket(room, pcA), b = await socket(room, pcB), starter = await socket(room, room.facilitatorToken);
    await Promise.all([a.snapshot, b.snapshot, starter.snapshot]);
    const target = (await (await list(room)).json()).consoles.filter(c => c.kind === 'shared')[0];
    const res = await revoke(room, target.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await a.closed).toBe(4006);
    expect(a.frames.some(frame => /"t":"error","error":"unauthorised"/.test(frame))).toBe(true);
    expect(await snapshotStatus(room, pcA)).toBe(401);
    expect((await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token: pcA,
      body: { v: 1, type: 'takeover', epoch: 0, clientEventId: uuidv7() } })).status).toBe(401);
    // It cannot reconnect: a fresh socket with the revoked token is refused at hello.
    const again = await socket(room, pcA);
    expect(await again.closed).toBe(4001);
    // The starter's console and the other shared computer are untouched.
    expect(await snapshotStatus(room, room.facilitatorToken)).toBe(200);
    expect(await snapshotStatus(room, pcB)).toBe(200);
    expect(b.ws.readyState).toBe(1);
    expect(starter.ws.readyState).toBe(1);
    const left = (await (await list(room)).json()).consoles;
    expect(left.map(c => c.kind)).toEqual(['starter', 'shared']);
    expect(left.some(c => c.id === target.id)).toBe(false);
    for (const s of [b, starter]) s.ws.close(1000);
  });

  it('[PM-27] a revoked shared computer has no way to mint again: a re-mint needs the starter\'s sign-in, a pickup a new approval', async () => {
    const room = await newRoom();
    const pc = await sharedPc(room);
    const target = (await (await list(room)).json()).consoles.find(c => c.kind === 'shared');
    expect((await revoke(room, target.id)).status).toBe(200);
    // Its only secret is the room token; no route mints from a room token.
    expect((await api(`/sessions/${room.sessionId}/facilitator-token`, { method: 'POST', token: pc })).status).toBe(401);
    expect((await api(`/sessions/${room.sessionId}/consoles`, { token: pc })).status).toBe(401);
    expect(await snapshotStatus(room, pc)).toBe(401);
    // The credential stays revoked in the room's store.
    const revoked = await runInDurableObject(room.stub, (_i, state) =>
      state.storage.sql.exec("SELECT count(*) AS n FROM credentials WHERE role = 'facilitator' AND revoked_at IS NOT NULL").toArray()[0].n);
    expect(revoked).toBe(1);
  });

  it('[PM-27] only the starter may list or revoke; a shared computer, another user and a signed-out caller are refused', async () => {
    const room = await newRoom();
    const pc = await sharedPc(room);
    const target = (await (await list(room)).json()).consoles.find(c => c.kind === 'shared');
    expect((await list(room, 'stranger')).status).toBe(403);
    expect((await revoke(room, target.id, 'stranger')).status).toBe(403);
    expect((await api(`/sessions/${room.sessionId}/consoles`)).status).toBe(401);
    expect((await api(`/sessions/${room.sessionId}/consoles/revoke`, { method: 'POST', body: { id: target.id } })).status).toBe(401);
    // A shared computer holds a room token, never a sign-in: P-27 is `no` for it.
    expect((await api(`/sessions/${room.sessionId}/consoles/revoke`, { method: 'POST', token: pc, body: { id: target.id } })).status).toBe(401);
    expect(await snapshotStatus(room, pc)).toBe(200);
  });

  it('[PM-27] the starter\'s own device credential, an unknown id and a malformed id are refused; nothing is revoked', async () => {
    const room = await newRoom();
    await sharedPc(room);
    const consoles = (await (await list(room)).json()).consoles;
    const own = consoles.find(c => c.kind === 'starter');
    const refusedOwn = await revoke(room, own.id);
    expect(refusedOwn.status).toBe(409);
    expect((await refusedOwn.json()).error).toBe('not_shared_computer');
    expect((await revoke(room, 999_999)).status).toBe(404);
    for (const id of ['1', -1, 1.5, null]) expect((await revoke(room, id)).status).toBe(400);
    expect(await snapshotStatus(room, room.facilitatorToken)).toBe(200);
    expect((await (await list(room)).json()).consoles).toHaveLength(2);
  });

  it('[PM-27] a room started before shared-console tracking lists its earlier consoles as unknown, never as the starter\'s device', async () => {
    const room = await newRoom();
    await sharedPc(room);
    // Make it a room from the previous build: no tracking marker, no shared_consoles table.
    await runInDurableObject(room.stub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'console_tracking_since'");
      state.storage.sql.exec('DROP TABLE IF EXISTS shared_consoles');
    });
    const before = (await (await list(room)).json()).consoles;
    expect(before.map(c => c.kind)).toEqual(['unknown', 'unknown']);
    const refused = await revoke(room, before[1].id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('console_paired_before_update');
    expect(await snapshotStatus(room, room.facilitatorToken)).toBe(200);
    // Consoles this build mints are identified as usual, and a new shared computer can be stopped.
    await sharedPc(room);
    expect((await api(`/sessions/${room.sessionId}/facilitator-token`, { method: 'POST', token: await jwt() })).status).toBe(201);
    const after = (await (await list(room)).json()).consoles;
    expect(after.map(c => c.kind)).toEqual(['unknown', 'unknown', 'shared', 'starter']);
    expect((await revoke(room, after[2].id)).status).toBe(200);
  });

  it('[PM-27] after the room ends there is nothing to revoke', async () => {
    const room = await newRoom();
    await sharedPc(room);
    const target = (await (await list(room)).json()).consoles.find(c => c.kind === 'shared');
    expect((await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token: room.facilitatorToken,
      body: { v: 1, type: 'end', epoch: 0, expectRevision: 0, clientEventId: uuidv7() } })).status).toBe(200);
    expect((await list(room)).status).toBe(410);
    expect((await revoke(room, target.id)).status).toBe(410);
  });
});
