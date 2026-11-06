// Phase 1 room runtime in a real workerd (Miniflare): the Worker, RoomDO and DirectoryDO end to end.
import { SELF, env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7, newCapabilityToken, hashToken } from '../../src/shared/ids.mjs';
import { ledgerKey } from '../../src/shared/room-machine.mjs';
import { PING_FRAME, PONG_FRAME, SYNC_FRAME } from '../../src/shared/wire.mjs';
import { directoryFor, pairsDirectory, limitsFor, roomFor } from '../../src/worker/directory-do.mjs';

import {nativeAccountFetch} from './admin-fixtures.mjs';
const SECRET = 'test-only-secret-not-for-production';
const BASE = 'https://case.test';
const userIds = new Map();
const userId = (label) => {
  if (!userIds.has(label)) userIds.set(label, uuidv7());
  return userIds.get(label);
};
const jwt = (sub = 'user-1', extra = {}) => signTestJwt({ sub: userId(sub), aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, ...extra }, SECRET);
const api = (path, { method = 'GET', token, body, headers = {} } = {}) => nativeAccountFetch(`${BASE}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
},[...userIds.values()]);
// A valid name and avatar (CASE-119): a join without both is refused before the code is looked up.
const ME = { displayName: 'Sam', avatarId: 'shadows-01' };
const cmd = (type, extra = {}, epoch = 0) => ({ v: 1, type, epoch, clientEventId: uuidv7(), ...extra });

async function newRoom(sub = 'user-1') {
  const res = await api('/sessions', { method: 'POST', token: await jwt(sub), body: { caseDocument: fixture } });
  expect(res.status).toBe(201);
  const room = await res.json();
  return { ...room, stub: env.ROOM.get(env.ROOM.idFromName(room.sessionId)) };
}
async function joinRoom(room, name, addr = '203.0.113.7') {
  const res = await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode.toLowerCase(), displayName: name, avatarId: 'shadows-01' }, headers: { 'cf-connecting-ip': addr } });
  expect(res.status).toBe(201);
  return res.json();
}
const snap = async (room, token) => (await api(`/sessions/${room.sessionId}/snapshot`, { token })).json();
const send = async (room, token, body) => (await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token, body })).json();
async function advanceToResponses(room) {
  // This fixture has two opening text groups and three decision text groups. Each action
  // is observed and revision-fenced; the last context reveal does not itself open voting.
  const expected = [[2, 2, 'surface_live'], [1, 3, 'surface_live'], [2, 3, 'surface_live'],
    [3, 3, 'surface_live'], [3, 3, 'responses_open']];
  for (const [shown, total, phase] of expected) {
    const before = await snap(room, room.facilitatorToken);
    expect((await send(room, room.facilitatorToken, cmd('advance', { expectRevision: before.revision }))).receipt.receipt).toBe('accepted');
    const after = await snap(room, room.facilitatorToken);
    expect(after.view.presentation).toMatchObject({ shown, total });
    expect(after.view.phase).toBe(phase);
    expect(Boolean(after.view.round)).toBe(phase === 'responses_open');
  }
}

async function openSocket(room) {
  const res = await SELF.fetch(`${BASE}/api/v1/sessions/${room.sessionId}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  ws.accept();
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const w = waiters.find((x) => x.match(e.data));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e.data); } else inbox.push(e.data);
  });
  const next = (match) => {
    const hit = inbox.find(match);
    if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => { waiters.push({ match, resolve }); setTimeout(() => reject(new Error('socket timeout')), 3000); });
  };
  return { ws, next, frame: (t) => next((d) => d !== PONG_FRAME && JSON.parse(d).t === t).then((d) => JSON.parse(d)) };
}

describe('facilitator sign-in and room creation', () => {
  it('requires a valid facilitator JWT: missing, forged, alg none and expired tokens are refused', async () => {
    expect((await api('/sessions', { method: 'POST', body: { caseDocument: fixture } })).status).toBe(401);
    expect((await api('/sessions', { method: 'POST', token: await signTestJwt({ sub: 'x', aud: 'authenticated', role: 'authenticated', exp: 9e9 }, 'wrong-secret'), body: { caseDocument: fixture } })).status).toBe(401);
    const none = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ sub: 'x', aud: 'authenticated', role: 'authenticated', exp: 9e9 }))}.`.replace(/=/g, '');
    expect((await api('/sessions', { method: 'POST', token: none, body: { caseDocument: fixture } })).status).toBe(401);
    expect((await api('/sessions', { method: 'POST', token: await jwt('x', { exp: 1000 }), body: { caseDocument: fixture } })).status).toBe(401);
  });

  it('creates a room: join code registered, facilitator token issued, invalid cases refused, security headers set', async () => {
    const room = await newRoom();
    expect(room.joinCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(room.facilitatorToken.length).toBeGreaterThan(40);
    const bad = await api('/sessions', { method: 'POST', token: await jwt(), body: { caseDocument: { ...fixture, beats: [] } } });
    expect(bad.status).toBe(422);
    expect(bad.headers.get('cache-control')).toBe('no-store');
    expect(bad.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await api('/sessions', { method: 'POST', token: await jwt(), body: { caseVersionId: uuidv7() } })).status).toBe(400);
  });

  it('stores only token hashes and the room schema in a SQLite Durable Object', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    await runInDurableObject(room.stub, (_instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(['meta', 'case_doc', 'receipts', 'journal', 'credentials']));
      const dump = JSON.stringify(state.storage.sql.exec('SELECT * FROM credentials').toArray());
      expect(dump).not.toContain(room.facilitatorToken);
      expect(dump).not.toContain(p.token);
    });
  });

  it('a second facilitator device gets a token only for the room owner', async () => {
    const room = await newRoom('owner');
    expect((await api(`/sessions/${room.sessionId}/facilitator-token`, { method: 'POST', token: await jwt('someone-else') })).status).toBe(403);
    const ok = await api(`/sessions/${room.sessionId}/facilitator-token`, { method: 'POST', token: await jwt('owner') });
    expect(ok.status).toBe(201);
    expect((await snap(room, (await ok.json()).facilitatorToken)).view.role).toBe('facilitator');
  });
});

describe('joining', () => {
  it('joins by typed code; unconfigured-widget fallback limits wrong codes but never a correct code', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    expect(p.sessionId).toBe(room.sessionId);
    expect((await api('/join', { method: 'POST', body: { v: 1, code: 'ZZZZZZ', ...ME }, headers: { 'cf-connecting-ip': '198.51.100.1' } })).status).toBe(404);
    for (let i = 0; i < 19; i++) expect((await api('/join', { method: 'POST', body: { v: 1, code: 'ZZZZZZ', ...ME }, headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(404);
    expect((await api('/join', { method: 'POST', body: { v: 1, code: 'ZZZZZZ', ...ME }, headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(404);
    const limited = await api('/join', { method: 'POST', body: { v: 1, code: 'ZZZZZZ', ...ME }, headers: { 'cf-connecting-ip': '198.51.100.9' } });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe('rate_limited');
    expect((await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, ...ME }, headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(201);
    // 50 phones behind one hospital NAT all join: successes never count against the address.
    for (let i = 0; i < 50; i++) await joinRoom(room, `Phone ${i}`, '192.0.2.50');
  });

  it('[AS-062] a join needs a valid name and an allow-listed avatar; the server stores and projects both (CASE-119)', async () => {
    const room = await newRoom();
    const post = (body) => api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, ...body }, headers: { 'cf-connecting-ip': '203.0.113.30' } });
    let res = await post({ avatarId: 'shadows-01' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_display_name');
    res = await post({ displayName: 'Al', avatarId: 'shadows-01' });
    expect((await res.json()).error).toBe('bad_display_name');
    res = await post({ displayName: 'Alex' });
    expect((await res.json()).error).toBe('bad_avatar');
    res = await post({ displayName: '  Alex  ', avatarId: 'shadows-09' });
    expect(res.status).toBe(201);
    const view = (await snap(room, room.facilitatorToken)).view;
    expect(view.participants.map((p) => [p.name, p.avatarId])).toEqual([['Alex', 'shadows-09']]);
  });

  it('close_joining refuses new joins with the room\'s own reason', async () => {
    const room = await newRoom();
    await send(room, room.facilitatorToken, cmd('close_joining', { closed: true }));
    const res = await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, ...ME }, headers: { 'cf-connecting-ip': '203.0.113.20' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('joining_closed');
  });
});

describe('commands, receipts and projections over HTTP', () => {
  it('Card 23 live group advances require the observed revision even when two distinct callers omit it', async () => {
    const room = await newRoom('unfenced-presentation-owner');
    expect((await send(room, room.facilitatorToken, cmd('start'))).receipt.receipt).toBe('accepted');
    const before = await snap(room, room.facilitatorToken);
    expect(before.view.presentation).toMatchObject({ shown: 1, total: 2 });
    // An accepted receipt from a pre-progress room may lack the revision field. Its retry
    // still belongs to the existing idempotency ledger, while a fresh omission is refused.
    const legacy = cmd('advance');
    await runInDurableObject(room.stub, (_instance, state) => {
      const key = ledgerKey({ actor: { role: 'facilitator', id: 'facilitator' }, clientEventId: legacy.clientEventId });
      state.storage.sql.exec('INSERT INTO receipts (ledger_key, fingerprint, at) VALUES (?, ?, ?)', key, '{"type":"advance"}', new Date().toISOString());
    });
    expect((await send(room, room.facilitatorToken, legacy)).receipt.receipt).toBe('already_accepted');
    const omitted = await Promise.all([
      send(room, room.facilitatorToken, cmd('advance')),
      send(room, room.facilitatorToken, cmd('advance')),
    ]);
    expect(omitted.map((result) => [result.receipt.receipt, result.receipt.reason])).toEqual([
      ['rejected', 'missing_expect_revision'], ['rejected', 'missing_expect_revision'],
    ]);
    const unchanged = await snap(room, room.facilitatorToken);
    expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.view.presentation).toEqual(before.view.presentation);
    const first = cmd('advance', { expectRevision: before.revision });
    const second = cmd('advance', { expectRevision: before.revision });
    const accepted = await send(room, room.facilitatorToken, first);
    expect(accepted.receipt.receipt).toBe('accepted');
    const stale = await send(room, room.facilitatorToken, second);
    expect([stale.receipt.receipt, stale.receipt.reason]).toEqual(['rejected', 'stale_revision']);
    expect((await send(room, room.facilitatorToken, first)).receipt.receipt).toBe('already_accepted');
    expect((await snap(room, room.facilitatorToken)).view.presentation).toMatchObject({ shown: 2, total: 2 });
  });

  it('Card 23 persists one bounded group reveal across concurrent commands and eviction without journaling content', async () => {
    const doc = structuredClone(fixture);
    doc.surfaces[0].scene = 'PUBLIC_OPENING';
    doc.surfaces[0].points = ['WITHHELD_FINDING'];
    const created = await api('/sessions', { method: 'POST', token: await jwt('presentation-owner'), body: { caseDocument: doc } });
    expect(created.status).toBe(201);
    const room = { ...await created.json() };
    room.stub = env.ROOM.get(env.ROOM.idFromName(room.sessionId));
    const phone = await joinRoom(room, 'Sam');
    expect((await send(room, room.facilitatorToken, cmd('start'))).receipt.receipt).toBe('accepted');
    const before = await snap(room, room.facilitatorToken);
    for (const token of [phone.token, room.facilitatorToken]) {
      const view = (await snap(room, token)).view;
      if (token === phone.token) expect(JSON.stringify(view)).not.toContain('WITHHELD_FINDING');
      else expect(view.presentation).toMatchObject({ shown: 1, total: 2 });
    }
    const first = cmd('advance', { expectRevision: before.revision });
    const second = cmd('advance', { expectRevision: before.revision });
    const results = await Promise.all([send(room, room.facilitatorToken, first), send(room, room.facilitatorToken, second)]);
    expect(results.map((result) => result.receipt.receipt).sort()).toEqual(['accepted', 'rejected']);
    expect(results.find((result) => result.receipt.receipt === 'rejected').receipt.reason).toBe('stale_revision');
    const accepted = results.find((result) => result.receipt.receipt === 'accepted') === results[0] ? first : second;
    expect((await send(room, room.facilitatorToken, accepted)).receipt.receipt).toBe('already_accepted');
    const after = await snap(room, room.facilitatorToken);
    expect(after.view.presentation).toMatchObject({ shown: 2, total: 2 });
    expect(JSON.stringify((await snap(room, phone.token)).view)).toContain('WITHHELD_FINDING');
    await runInDurableObject(room.stub, (_instance, state) => {
      const rows = state.storage.sql.exec("SELECT kind, payload FROM journal WHERE kind = 'presentation_group_revealed'").toArray();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('WITHHELD_FINDING');
    });
    await evictDurableObject(room.stub);
    expect((await snap(room, room.facilitatorToken)).view.presentation).toEqual(after.view.presentation);
    expect((await send(room, room.facilitatorToken, cmd('takeover'))).receipt.receipt).toBe('accepted');
    const taken = await snap(room, room.facilitatorToken);
    expect((await send(room, room.facilitatorToken, cmd('advance', { expectRevision: taken.revision }, 0))).receipt.receipt).toBe('stale_epoch');
    expect((await snap(room, room.facilitatorToken)).view.presentation).toEqual(after.view.presentation);
  });

  it('Card 23 upgrades a pre-progress stored room without hiding text already public before recovery', async () => {
    const room = await newRoom('legacy-presentation-owner');
    await send(room, room.facilitatorToken, cmd('start'));
    const opening = await snap(room, room.facilitatorToken);
    expect((await send(room, room.facilitatorToken, cmd('advance', { expectRevision: opening.revision }))).receipt.receipt).toBe('accepted');
    const before = await snap(room, room.facilitatorToken);
    expect(before.view.presentation.shown).toBe(before.view.presentation.total);
    await runInDurableObject(room.stub, (_instance, state) => {
      const stored = JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").toArray()[0].value);
      delete stored.presentationVersion;
      delete stored.revealed[0].groupsShown;
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'state'", JSON.stringify(stored));
    });
    await evictDurableObject(room.stub);
    const after = await snap(room, room.facilitatorToken);
    expect(after.view.presentation).toMatchObject({ shown: 2, total: 2 });
    const persisted = await runInDurableObject(room.stub, (_instance, state) => JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").toArray()[0].value));
    expect(persisted.presentationVersion).toBe(1);
    expect(persisted.revealed[0].groupsShown).toBe(2);
  });

  it('each role gets only its projection; only the console gets the mirror (CASE-092)', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    const fac = await snap(room, room.facilitatorToken);
    const ph = await snap(room, p.token);
    expect(fac.view.role).toBe('facilitator');
    expect(fac.mirror.sessionId).toBe(room.sessionId);
    expect(ph.view.role).toBe('participant');
    expect(ph.mirror).toBeUndefined();
    expect((await api(`/sessions/${room.sessionId}/case-pack`, { token: p.token })).status).toBe(403);
    expect((await (await api(`/sessions/${room.sessionId}/case-pack`, { token: room.facilitatorToken })).json()).title).toBe(fixture.title);
    expect((await api(`/sessions/${room.sessionId}/snapshot`, { token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('votes are idempotent by client_event_id, a reused id with a new payload is refused, and the server stamps actor and time', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    expect((await send(room, room.facilitatorToken, cmd('start'))).receipt.receipt).toBe('accepted');
    await advanceToResponses(room);
    const d = (await snap(room, p.token)).view.decision;
    const vote = cmd('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[0].id } });
    expect((await send(room, p.token, vote)).receipt.receipt).toBe('accepted');
    expect((await send(room, p.token, vote)).receipt.receipt).toBe('already_accepted');
    const reused = await send(room, p.token, { ...vote, response: { option_id: d.interaction.options[1].id } });
    expect(reused.receipt.reason).toBe('client_event_id_reused');
    expect((await send(room, p.token, { ...cmd('vote', { roundId: d.roundId, response: {} }), actor: { role: 'facilitator' } })).receipt.reason).toBe('unexpected_field:actor');
    expect((await send(room, p.token, cmd('lock'))).receipt.reason).toBe('forbidden');
  });

  it('a stale epoch or revision changes nothing and comes back with a fresh snapshot', async () => {
    const room = await newRoom();
    await send(room, room.facilitatorToken, cmd('takeover'));
    const stale = await send(room, room.facilitatorToken, cmd('start', {}, 0));
    expect(stale.receipt.receipt).toBe('stale_epoch');
    expect(stale.snapshot.epoch).toBe(1);
    const fenced = await send(room, room.facilitatorToken, cmd('start', { expectRevision: 0 }, 1));
    expect(fenced.receipt.reason).toBe('stale_revision');
  });
});

describe('long-poll', () => {
  it('returns at once when behind, waits for a change, and says unchanged after the wait', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    const s0 = await snap(room, p.token);
    const unchanged = await (await api(`/sessions/${room.sessionId}/updates?after=${s0.revision}&afterDisplay=${s0.displayRevision}&wait=1`, { token: p.token })).json();
    expect(unchanged.t).toBe('unchanged');
    const waiting = api(`/sessions/${room.sessionId}/updates?after=${s0.revision}&afterDisplay=${s0.displayRevision}&wait=10`, { token: p.token });
    await send(room, room.facilitatorToken, cmd('start'));
    const woke = await (await waiting).json();
    expect(woke.t).toBe('snapshot');
    expect(woke.view.phase).toBe('live');
  });
});

describe('WebSocket', () => {
  it('hello authenticates from the first frame, ping is auto-answered, and commands broadcast to the room', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    const fac = await openSocket(room);
    const ph = await openSocket(room);
    fac.ws.send(JSON.stringify({ v: 1, t: 'hello', token: room.facilitatorToken, lastRevision: 0, lastEpoch: 0 }));
    ph.ws.send(JSON.stringify({ v: 1, t: 'hello', token: p.token, lastRevision: 0, lastEpoch: 0 }));
    expect((await fac.frame('welcome')).role).toBe('facilitator');
    expect((await ph.frame('welcome')).participantId).toBe(p.participantId);
    await fac.frame('snapshot');
    await ph.frame('snapshot');
    ph.ws.send(PING_FRAME);
    expect(await ph.next((d) => d === PONG_FRAME)).toBe(PONG_FRAME);
    fac.ws.send(JSON.stringify({ v: 1, t: 'command', type: 'start', epoch: 0, clientEventId: uuidv7() }));
    expect((await fac.frame('receipt')).receipt).toBe('accepted');
    expect((await ph.frame('snapshot')).view.phase).toBe('live');
    fac.ws.close(1000); ph.ws.close(1000);
  });

  it('refuses a bad hello, and closes a removed participant\'s socket and revokes the token', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Troll');
    const bad = await openSocket(room);
    const closed = new Promise((r) => bad.ws.addEventListener('close', (e) => r(e.code)));
    bad.ws.send(JSON.stringify({ v: 1, t: 'hello', token: 'y'.repeat(43), lastRevision: 0, lastEpoch: 0 }));
    expect(await closed).toBe(4001);
    const ph = await openSocket(room);
    ph.ws.send(JSON.stringify({ v: 1, t: 'hello', token: p.token, lastRevision: 0, lastEpoch: 0 }));
    await ph.frame('welcome');
    const gone = new Promise((r) => ph.ws.addEventListener('close', (e) => r(e.code)));
    await send(room, room.facilitatorToken, cmd('remove_participant', { participantId: p.participantId }));
    expect(await gone).toBe(4003);
    expect((await api(`/sessions/${room.sessionId}/snapshot`, { token: p.token })).status).toBe(401);
  });
});

describe('eviction, manual segments, pairing and lifecycle', () => {
  it('an evicted room rebuilds from storage with identical projections and keeps its votes (CASE-072)', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    await send(room, room.facilitatorToken, cmd('start'));
    await advanceToResponses(room);
    const d = (await snap(room, p.token)).view.decision;
    await send(room, p.token, cmd('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[2].id } }));
    const before = [await snap(room, room.facilitatorToken), await snap(room, p.token)];
    await evictDurableObject(room.stub);
    const after = [await snap(room, room.facilitatorToken), await snap(room, p.token)];
    expect(after).toEqual(before);
    expect(after[0].view.round.responseCount).toBe(1);
  });

  it('a manual segment applies all-or-nothing; a retry is idempotent; a stale one is refused (CASE-093..095)', async () => {
    const room = await newRoom();
    await send(room, room.facilitatorToken, cmd('start'));
    const segmentId = uuidv7();
    const t = (s) => new Date(Date.now() + s * 1000).toISOString();
    const body = { v: 1, segmentId, events: [
      { ...cmd('enter_manual', { segmentId }, 0), at: t(1) },
      { ...cmd('manual_marker', { text: '' }, 1), at: t(2) },
      { ...cmd('resume_online', {}, 1), at: t(3) },
    ] };
    const ok = await api(`/sessions/${room.sessionId}/manual-segment`, { method: 'POST', token: room.facilitatorToken, body });
    expect(ok.status).toBe(200);
    expect((await ok.json()).epoch).toBe(2);
    expect((await api(`/sessions/${room.sessionId}/manual-segment`, { method: 'POST', token: room.facilitatorToken, body })).status).toBe(200);
    const other = uuidv7();
    const stale = await api(`/sessions/${room.sessionId}/manual-segment`, { method: 'POST', token: room.facilitatorToken, body: { v: 1, segmentId: other, events: [{ ...cmd('enter_manual', { segmentId: other }, 0), at: t(4) }] } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatch(/epoch/);
    const p = await joinRoom(room, 'Sam');
    expect((await api(`/sessions/${room.sessionId}/manual-segment`, { method: 'POST', token: p.token, body })).status).toBe(403);
  });

  it('display pairing is number-matched, single use and expires', async () => {
    const room = await newRoom();
    const pair = await (await api('/display-pairs', { method: 'POST' })).json();
    expect(pair.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect((await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).status).toBe(200);
    expect((await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json()).pending).toBe(true);
    expect((await api(`/display-pairs/${pair.pairId}`, { token: 'z'.repeat(43) })).status).toBe(404);
    expect((await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code.toLowerCase() } })).status).toBe(200);
    const got = await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json();
    expect(got.sessionId).toBe(room.sessionId);
    expect((await snap(room, got.token)).view.role).toBe('display');
    expect((await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).status).toBe(404); // single use
    expect((await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code } })).status).toBe(404);
    const late = await (await api('/display-pairs', { method: 'POST' })).json();
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-pairs'));
    await runInDurableObject(dir, (_i, state) => state.storage.sql.exec('UPDATE pairs SET expires_at = 1 WHERE pair_id = ?', late.pairId));
    expect((await api(`/display-pairs/${late.pairId}`, { token: late.secret })).status).toBe(410);
  });

  it('an expired room is force-ended by its alarm, releases its code, and is deleted 24 h after it ends (CASE-073)', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    await runInDurableObject(room.stub, (_i, state) => state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() - 1000)));
    expect(await runDurableObjectAlarm(room.stub)).toBe(true);
    expect((await snap(room, p.token)).view.phase).toBe('ended');
    expect((await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, ...ME }, headers: { 'cf-connecting-ip': '203.0.113.99' } })).status).toBe(404);
    await runInDurableObject(room.stub, (_i, state) => state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'recap_delete_at'"));
    await runInDurableObject(room.stub, (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(room.stub)).toBe(true);
    expect((await api(`/sessions/${room.sessionId}/snapshot`, { token: p.token })).status).toBe(404);
    await runInDurableObject(room.stub, (_i, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'credentials'").toArray()[0].n).toBe(0);
    });
  });
});

describe('runtime red team regressions (docs/red-team/2026-10-01-runtime-red-team.md)', () => {
  it('[P0-1] a command that would overflow the state is refused, and its receipt is not kept (a retry is not already_accepted)', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    await send(room, room.facilitatorToken, cmd('start'));
    await advanceToResponses(room);
    const d = (await snap(room, p.token)).view.decision;
    await runInDurableObject(room.stub, (instance) => {
      instance.state = { ...instance.state, rounds: [...instance.state.rounds, { pad: 'x'.repeat(1_100_000) }] };
    });
    const vote = cmd('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[0].id } });
    expect((await send(room, p.token, vote)).receipt.reason).toBe('room_state_too_large');
    expect((await send(room, p.token, vote)).receipt.reason).toBe('room_state_too_large'); // not already_accepted
    await runInDurableObject(room.stub, (_i, state) => {
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM receipts WHERE ledger_key LIKE ?', `%${vote.clientEventId}`).toArray()[0].n).toBe(0);
    });
  });

  it('[P0-1] the state budget counts UTF-8 bytes, so multibyte text under a million code units is still refused (CASE-155)', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    await send(room, room.facilitatorToken, cmd('start'));
    await advanceToResponses(room);
    const d = (await snap(room, p.token)).view.decision;
    // 400,000 three-byte characters: 400,000 UTF-16 code units, 1,200,000 UTF-8 bytes.
    const sizes = await runInDurableObject(room.stub, (instance) => {
      instance.state = { ...instance.state, rounds: [...instance.state.rounds, { pad: '\u6f22'.repeat(400_000) }] };
      const { caseDoc: _doc, ...persisted } = instance.state;
      const json = JSON.stringify(persisted);
      return { units: json.length, bytes: new TextEncoder().encode(json).byteLength };
    });
    expect(sizes.units).toBeLessThan(1_000_000);
    expect(sizes.bytes).toBeGreaterThan(1_000_000);
    const vote = cmd('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[0].id } });
    expect((await send(room, p.token, vote)).receipt?.reason).toBe('room_state_too_large');
    expect((await send(room, p.token, vote)).receipt?.reason).toBe('room_state_too_large'); // not already_accepted
    await runInDurableObject(room.stub, (_i, state) => {
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM receipts WHERE ledger_key LIKE ?', `%${vote.clientEventId}`).toArray()[0].n).toBe(0);
      expect(new TextEncoder().encode(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").one().value).byteLength).toBeLessThan(1_000_000);
    });
  });

  it('cold maintenance never re-persists a normalized state whose UTF-8 bytes exceed the budget (CASE-155)', async () => {
    const room = await newRoom();
    await joinRoom(room, 'Sam');
    // A legacy (pre-presentationVersion) stored state under a million code units but over a million bytes.
    const stored = await runInDurableObject(room.stub, (_instance, state) => {
      const legacy = JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").one().value);
      delete legacy.presentationVersion;
      legacy.rounds = [...legacy.rounds, { pad: '\u6f22'.repeat(340_000) }];
      const json = JSON.stringify(legacy);
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'state'", json);
      return json;
    });
    expect(stored.length).toBeLessThan(1_000_000);
    expect(new TextEncoder().encode(stored).byteLength).toBeGreaterThan(1_000_000);
    await evictDurableObject(room.stub);
    // Ordinary access runs the deferred maintenance; any outcome is acceptable except an oversized persist.
    await snap(room, room.facilitatorToken).catch(() => null);
    await runInDurableObject(room.stub, (instance, state) => {
      const after = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").one().value;
      expect(after === stored).toBe(true);
      expect(instance.normalizedStatePending).toBe(true);
    });
  });

  it('a room whose cold maintenance is refused is still hard-deleted on time, and never alarms in a hot loop (CASE-155)', async () => {
    const stuck = async () => {
      const room = await newRoom();
      await joinRoom(room, 'Sam');
      await runInDurableObject(room.stub, (_instance, state) => {
        const legacy = JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").one().value);
        delete legacy.presentationVersion;
        legacy.rounds = [...legacy.rounds, { pad: '\u6f22'.repeat(340_000) }];
        state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'state'", JSON.stringify(legacy));
      });
      await evictDurableObject(room.stub);
      return room;
    };
    // Past its expiry but before expiry + 24 h: no deletion yet, and the next alarm is in the future.
    const waiting = await stuck();
    await runInDurableObject(waiting.stub, (_i, state) => state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() - 1000)));
    await evictDurableObject(waiting.stub);
    expect(await runDurableObjectAlarm(waiting.stub)).toBe(true);
    await runInDurableObject(waiting.stub, async (_i, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM credentials").one().n).toBeGreaterThan(0);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    });
    // At expiry + 24 h: personal data is deleted even though maintenance cannot persist.
    const due = await stuck();
    await runInDurableObject(due.stub, (_i, state) => state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() - 24 * 3600 * 1000 - 1000)));
    await evictDurableObject(due.stub);
    expect(await runDurableObjectAlarm(due.stub)).toBe(true);
    await runInDurableObject(due.stub, async (_i, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'credentials'").one().n).toBe(0);
      expect(await state.storage.getAlarm()).toBe(null);
    });
  });

  it('[P0-2] [P1-3] the expiry end arms deletion from the server clock; an old room is hard-deleted at expiry + 24 h regardless', async () => {
    const room = await newRoom();
    await runInDurableObject(room.stub, (_i, state) => state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() - 1000)));
    await runDurableObjectAlarm(room.stub);
    await runInDurableObject(room.stub, async (_i, state) => {
      const del = Number(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'recap_delete_at'").toArray()[0].value);
      expect(Math.abs(del - (Date.now() + 24 * 3600 * 1000))).toBeLessThan(60_000);
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeLessThanOrEqual(del); // the earlier of endedAt + 24 h and the expiry + 24 h backstop
      expect(del - alarm).toBeLessThan(5_000);
    });
    const other = await newRoom();
    await runInDurableObject(other.stub, async (_i, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() - 25 * 3600 * 1000));
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(other.stub);
    expect((await api(`/sessions/${other.sessionId}/snapshot`, { token: other.facilitatorToken })).status).toBe(404);
  });

  it('[P1-3] a manual segment stamped in the future is refused; [P2-9] marker text is stripped server-side', async () => {
    const room = await newRoom();
    await send(room, room.facilitatorToken, cmd('start'));
    const segmentId = uuidv7();
    const future = await api(`/sessions/${room.sessionId}/manual-segment`, { method: 'POST', token: room.facilitatorToken,
      body: { v: 1, segmentId, events: [{ ...cmd('enter_manual', { segmentId }), at: '2099-12-31T00:00:00Z' }] } });
    expect(future.status).toBe(400);
    expect((await future.json()).error).toBe('event_time_in_future');
    const now = new Date().toISOString();
    expect((await api(`/sessions/${room.sessionId}/manual-segment`, { method: 'POST', token: room.facilitatorToken,
      body: { v: 1, segmentId, events: [{ ...cmd('enter_manual', { segmentId }), at: now }, { ...cmd('manual_marker', { text: 'Dr Smith, patient John Doe' }, 1), at: now }] } })).status).toBe(200);
    await runInDurableObject(room.stub, (_i, state) => {
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'state'").toArray()[0].value).not.toContain('John Doe');
    });
  });

  it('[P1-4] a long-polling phone is not woken by another phone\'s vote, but is by a room change', async () => {
    const room = await newRoom();
    const a = await joinRoom(room, 'Ana');
    const b = await joinRoom(room, 'Ben');
    await send(room, room.facilitatorToken, cmd('start'));
    await advanceToResponses(room);
    const s = await snap(room, a.token);
    const d = s.view.decision;
    const t0 = Date.now();
    const waiting = api(`/sessions/${room.sessionId}/updates?after=${s.revision}&afterDisplay=${s.displayRevision}&wait=2`, { token: a.token });
    // Let the long-poll register before the vote: sent together, the vote could land first, and then
    // the poll is rightly answered at once because it is behind (a race in the test, seen 1 run in 4).
    await new Promise((r) => setTimeout(r, 200));
    await send(room, b.token, cmd('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[0].id } }));
    const r1 = await (await waiting).json();
    expect(r1.t).toBe('unchanged');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    const s2 = await snap(room, a.token);
    const waiting2 = api(`/sessions/${room.sessionId}/updates?after=${s2.revision}&afterDisplay=${s2.displayRevision}&wait=10`, { token: a.token });
    await send(room, room.facilitatorToken, cmd('lock'));
    expect((await (await waiting2).json()).view.decision.status).toBe('locked');
  });

  it('[P1-5] unknown, non-v7 and stale session ids never create Durable Object storage', async () => {
    const fresh = uuidv7();
    expect((await api(`/sessions/${fresh}/snapshot`, { token: 'x'.repeat(43) })).status).toBe(404);
    await runInDurableObject(env.ROOM.get(env.ROOM.idFromName(fresh)), (_i, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").toArray()[0].n).toBe(0);
    });
    expect((await api('/sessions/2f1c9d5e-8b7a-4c3d-9e2f-1a0b9c8d7e6f/snapshot', { token: 'x'.repeat(43) })).status).toBe(404);
    expect((await api(`/sessions/${uuidv7(Date.now() - 72 * 3600 * 1000)}/snapshot`, { token: 'x'.repeat(43) })).status).toBe(404);
  });

  it('[P1-6] takeover revokes every other facilitator token; displays can be revoked', async () => {
    const room = await newRoom('owner');
    const second = (await (await api(`/sessions/${room.sessionId}/facilitator-token`, { method: 'POST', token: await jwt('owner') })).json()).facilitatorToken;
    expect((await send(room, second, cmd('takeover'))).receipt.receipt).toBe('accepted');
    expect((await api(`/sessions/${room.sessionId}/snapshot`, { token: room.facilitatorToken })).status).toBe(401);
    expect((await snap(room, second)).view.role).toBe('facilitator');
    const pair = await (await api('/display-pairs', { method: 'POST' })).json();
    await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: second, body: { code: pair.code } });
    const display = await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json();
    expect((await snap(room, display.token)).view.role).toBe('display');
    expect((await api(`/sessions/${room.sessionId}/display-pairs/revoke`, { method: 'POST', token: second })).status).toBe(200);
    expect((await api(`/sessions/${room.sessionId}/snapshot`, { token: display.token })).status).toBe(401);
  });

  it('[P1-2] failures from one IPv6 /64 share a limit, whatever the interface id', async () => {
    const room = await newRoom();
    for (let i = 0; i < 20; i++) expect((await api('/join', { method: 'POST', body: { v: 1, code: 'ZZZZZZ', ...ME }, headers: { 'cf-connecting-ip': `2001:db8:abcd:12::${(i + 1).toString(16)}` } })).status).toBe(404);
    // Local fixtures intentionally have no widget keys: the legacy fallback remains /64 scoped.
    const res = await api('/join', { method: 'POST', body: { v: 1, code: 'ZZZZZZ', ...ME }, headers: { 'cf-connecting-ip': '2001:db8:abcd:12:ffff::1' } });
    expect(res.status).toBe(429);
    expect((await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, ...ME }, headers: { 'cf-connecting-ip': '2001:db8:abcd:12:ffff::1' } })).status).toBe(201);
    expect((await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, ...ME }, headers: { 'cf-connecting-ip': '2001:db8:abcd:13::1' } })).status).toBe(201);
  });

  it('[P2-1] a display token exists only once the display picks it up', async () => {
    const room = await newRoom();
    const pair = await (await api('/display-pairs', { method: 'POST' })).json();
    await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code } });
    const count = () => runInDurableObject(room.stub, (_i, state) => state.storage.sql.exec("SELECT count(*) AS n FROM credentials WHERE role = 'display'").toArray()[0].n);
    expect(await count()).toBe(0);
    await api(`/display-pairs/${pair.pairId}`, { token: pair.secret });
    expect(await count()).toBe(1);
  });

  it('[P2-4] malformed and anonymous sign-ins are 401; [P2-6] command spam is rate-limited per token', async () => {
    const malformed = `${(await jwt()).split('.').slice(0, 2).join('.')}.!!!`;
    expect((await api('/sessions', { method: 'POST', token: malformed, body: { caseDocument: fixture } })).status).toBe(401);
    expect((await api('/sessions', { method: 'POST', token: await jwt('anon', { is_anonymous: true }), body: { caseDocument: fixture } })).status).toBe(401);
    const room = await newRoom();
    const p = await joinRoom(room, 'Spam');
    const reasons = [];
    for (let i = 0; i < 25; i++) reasons.push((await send(room, p.token, cmd('rename', { displayName: `Name ${i}` }))).receipt.reason ?? 'ok');
    expect(reasons.filter((r) => r === 'rate_limited').length).toBeGreaterThan(0);
  });

  it('[P2-2] a WebSocket frame over the limit closes the socket', async () => {
    const room = await newRoom();
    const s = await openSocket(room);
    const closed = new Promise((r) => s.ws.addEventListener('close', (e) => r(e.code)));
    s.ws.send('x'.repeat(20_000));
    expect(await closed).toBe(1009);
  });
});

describe('spec red team 2 (docs/red-team/2026-10-01-spec-red-team-2.md)', () => {
  const hello = (sock, token) => sock.ws.send(JSON.stringify({ v: 1, t: 'hello', token, lastRevision: 0, lastEpoch: 0 }));

  it('[P1-1] the room itself answers the sync frame with its revisions; a malformed sync is refused', async () => {
    const room = await newRoom();
    const p = await joinRoom(room, 'Sam');
    const ph = await openSocket(room);
    hello(ph, p.token);
    await ph.frame('welcome');
    await ph.frame('snapshot');
    await send(room, room.facilitatorToken, cmd('start'));
    ph.ws.send(SYNC_FRAME);
    const sync = await ph.frame('sync');
    const fac = await snap(room, room.facilitatorToken);
    expect(sync).toEqual({ v: 1, t: 'sync', revision: fac.revision, displayRevision: fac.displayRevision, epoch: fac.epoch });
    ph.ws.send('{"v":1,"t":"sync","extra":1}');
    expect((await ph.frame('error')).error).toBe('bad_sync');
    ph.ws.close(1000);
  });

  it('[P1-7] the answered count is out of the participants connected now, from sockets and recent HTTP', async () => {
    const room = await newRoom();
    const [a, b] = [await joinRoom(room, 'Ana'), await joinRoom(room, 'Ben')];
    await joinRoom(room, 'Cat'); // joined, then never connected again
    const pair = await (await api('/display-pairs', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.60' } })).json();
    await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code } });
    const disp = await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json();
    await send(room, room.facilitatorToken, cmd('start'));
    await advanceToResponses(room);
    const sock = await openSocket(room);
    hello(sock, a.token); // a: an open socket
    await sock.frame('welcome');
    await snap(room, b.token); // b: recent HTTP activity
    const view = (await snap(room, disp.token)).view;
    expect(view.counts).toMatchObject({ participants: 3, present: 2, responded: 0 });
    expect((await snap(room, room.facilitatorToken)).view.round.participantCount).toBe(2);
    sock.ws.close(1000);
  });

  it('[P1-5] every Durable Object is requested with the Oceania location hint', async () => {
    const calls = [];
    const ns = (name) => ({ idFromName: (n) => `${name}:${n}`, get: (id, opts) => { calls.push([id, opts]); return {}; } });
    const fake = { DIRECTORY: ns('dir'), ROOM: ns('room') };
    directoryFor(fake, '7K3QX9'); pairsDirectory(fake); limitsFor(fake, '198.51.100.1'); roomFor(fake, uuidv7());
    expect(calls).toHaveLength(4);
    for (const [, opts] of calls) expect(opts).toEqual({ locationHint: 'oc' });
  });

  it('[P1-4] the network self-test: an echoing socket with no room, and a bounded HTTP wait', async () => {
    const poll = await SELF.fetch(`${BASE}/api/v1/check/poll?wait=0`, { headers: { 'cf-connecting-ip': '203.0.113.70' } });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ v: 1, t: 'check', waitedS: 0 });
    expect(poll.headers.get('cache-control')).toBe('no-store');
    const res = await SELF.fetch(`${BASE}/api/v1/check/ws`, { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.70' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    ws.accept();
    const echo = new Promise((r) => ws.addEventListener('message', (e) => r(e.data)));
    ws.send('check-1');
    expect(await echo).toBe('check-1');
    ws.close(1000);
    expect((await SELF.fetch(`${BASE}/api/v1/check/ws`)).status).toBe(426);
  });

  it('[P1-8] the deploy guard counts live rooms only with the secret in the Authorization header', async () => {
    const path = '/ops/live-rooms';
    expect((await api(path)).status).toBe(404);
    expect((await api(path, { token: 'wrong-token-of-some-length' })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/v1${path}?token=test-only-deploy-guard-token`)).status).toBe(404); // never from a URL
    const before = (await (await api(path, { token: 'test-only-deploy-guard-token' })).json()).live;
    const room = await newRoom();
    expect((await (await api(path, { token: 'test-only-deploy-guard-token' })).json()).live).toBe(before + 1);
    await send(room, room.facilitatorToken, cmd('end'));
    await expect.poll(async () => (await (await api(path, { token: 'test-only-deploy-guard-token' })).json()).live).toBe(before);
  });
});

// Join recovery is private, per-room and hash-only. These assertions log counts/booleans,
// never the opaque capability. Existing legacy, rate and challenge tests remain above.
const joinOnceBody = (room, joinToken, extra = {}) => ({ v: 1, code: room.joinCode, ...ME, joinToken, ...extra });
const joinOnceRequest = (room, joinToken, extra = {}) => api('/join', { method: 'POST', body: joinOnceBody(room, joinToken, extra) });
const joinStore = (room) => runInDurableObject(room.stub, async (instance, state) => {
  // Every user table, so archive outbox columns/tables are compared too (in memory only, never logged).
  const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").toArray().map(row => row.name);
  for (const table of ['meta', 'credentials', 'receipts', 'participants', 'rounds', 'responses', 'journal']) if (!tables.includes(table)) throw new Error('join store missing ' + table);
  const rows = Object.fromEntries(tables.map(table => [table, state.storage.sql.exec('SELECT * FROM ' + table + ' ORDER BY 1').toArray()]));
  const { caseDoc, ...memory } = instance.state ?? {};
  return JSON.stringify({ rows, memory, alarm: await state.storage.getAlarm() });
});
const acceptedJoinOnce = async (room, secret) => {
  const response = await joinOnceRequest(room, secret);
  expect(response.status).toBe(201);
  return response.json();
};

describe('secret-bound participant join recovery', () => {
  it('a new join persists only capability and normalized input hashes', async () => {
    const room = await newRoom('join-once-private');
    const secret = newCapabilityToken();
    const response = await acceptedJoinOnce(room, secret);
    expect(response.token === secret).toBe(true);
    const stored = await joinStore(room);
    expect(stored.includes(secret)).toBe(false);
    const sha = await hashToken(secret);
    // Keyed by the private capability, so the stored value is not a guessable hash of a display name.
    const input = JSON.stringify({ v: 1, displayName: ME.displayName, avatarId: ME.avatarId });
    const fingerprint = await hashToken(secret + '\n' + input);
    const unkeyed = await hashToken(input);
    const matched = await runInDurableObject(room.stub, (_instance, state) => {
      const credential = state.storage.sql.exec('SELECT role, participant_id FROM credentials WHERE token_sha256 = ?', sha).toArray()[0];
      const receipt = state.storage.sql.exec('SELECT fingerprint FROM receipts WHERE ledger_key = ?', 'join:' + sha).toArray()[0];
      return credential?.role === 'participant' && credential.participant_id === response.participantId && receipt?.fingerprint === fingerprint && receipt.fingerprint !== unkeyed;
    });
    expect(matched).toBe(true);
  });

  it('one secret joins once across concurrent requests and cold recovery without refreshing its receipt or archive', async () => {
    const room = await newRoom('join-once-cold');
    const secret = newCapabilityToken();
    const responses = await Promise.all([joinOnceRequest(room, secret), joinOnceRequest(room, secret)]);
    expect(responses.every(response => response.status === 201)).toBe(true);
    const [first, second] = await Promise.all(responses.map(response => response.json()));
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(1);
    expect(first.participantId === second.participantId).toBe(true);
    expect(first.token === secret && second.token === secret).toBe(true);
    const before = await joinStore(room);
    expect(before.includes(secret)).toBe(false);
    const replay = await acceptedJoinOnce(room, secret);
    expect(replay.participantId === first.participantId && replay.token === secret).toBe(true);
    expect((await joinStore(room)) === before).toBe(true);
    await evictDurableObject(room.stub);
    const coldBefore = await joinStore(room);
    const cold = await acceptedJoinOnce(room, secret);
    expect(cold.participantId === first.participantId && cold.token === secret).toBe(true);
    expect((await joinStore(room)) === coldBefore).toBe(true);
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(1);
  });

  it('same-secret input changes refuse while distinct secrets retain distinct same-name participants', async () => {
    const room = await newRoom('join-once-input');
    const secret = newCapabilityToken();
    const first = await acceptedJoinOnce(room, secret);
    const before = await joinStore(room);
    for (const extra of [{ displayName: 'Alex' }, { avatarId: 'shadows-02' }]) {
      const response = await joinOnceRequest(room, secret, extra);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('join_payload_changed');
      expect((await joinStore(room)) === before).toBe(true);
    }
    const normalized = await acceptedJoinOnce(room, secret);
    expect(normalized.participantId === first.participantId).toBe(true);
    const separate = await acceptedJoinOnce(room, newCapabilityToken());
    expect(separate.participantId !== first.participantId).toBe(true);
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(2);
  });

  it('known credentials and receipts cannot become fresh joins when a counterpart or receipt age is invalid', async () => {
    for (const mode of ['missing_receipt', 'missing_credential', 'expired', 'future', 'malformed']) {
      const room = await newRoom('join-once-counterpart-' + mode);
      const secret = newCapabilityToken();
      await acceptedJoinOnce(room, secret);
      const sha = await hashToken(secret);
      await runInDurableObject(room.stub, (_instance, state) => {
        if (mode === 'missing_receipt') state.storage.sql.exec('DELETE FROM receipts WHERE ledger_key = ?', 'join:' + sha);
        else if (mode === 'missing_credential') state.storage.sql.exec('DELETE FROM credentials WHERE token_sha256 = ?', sha);
        else state.storage.sql.exec('UPDATE receipts SET at = ? WHERE ledger_key = ?',
          mode === 'expired' ? new Date(Date.now() - 24 * 3600 * 1000 - 1).toISOString() :
          mode === 'future' ? new Date(Date.now() + 3600 * 1000).toISOString() : 'not-a-date', 'join:' + sha);
      });
      const before = await joinStore(room);
      const response = await joinOnceRequest(room, secret);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('join_retry_unavailable');
      expect((await joinStore(room)) === before).toBe(true);
    }
  });

  it('facilitator and legacy participant capabilities never convert into new join credentials', async () => {
    const room = await newRoom('join-once-role');
    const legacy = await joinRoom(room, 'Sam');
    for (const secret of [room.facilitatorToken, legacy.token]) {
      if (secret === room.facilitatorToken) {
        const sha = await hashToken(secret);
        const fingerprint = await hashToken(secret + '\n' + JSON.stringify({ v: 1, displayName: ME.displayName, avatarId: ME.avatarId }));
        await runInDurableObject(room.stub, (_instance, state) => state.storage.sql.exec('INSERT INTO receipts (ledger_key, fingerprint, at) VALUES (?, ?, ?)', 'join:' + sha, fingerprint, new Date().toISOString()));
      }
      const before = await joinStore(room);
      const response = await joinOnceRequest(room, secret);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('join_retry_unavailable');
      expect((await joinStore(room)) === before).toBe(true);
    }
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(1);
  });

  it('closed joining recovers its accepted live participant without adding state while a fresh secret still refuses', async () => {
    const room = await newRoom('join-once-closed');
    const secret = newCapabilityToken();
    const first = await acceptedJoinOnce(room, secret);
    expect((await send(room, room.facilitatorToken, cmd('close_joining', { closed: true }))).receipt.receipt).toBe('accepted');
    const before = await joinStore(room);
    const replay = await acceptedJoinOnce(room, secret);
    expect(replay.participantId === first.participantId).toBe(true);
    expect((await joinStore(room)) === before).toBe(true);
    const fresh = await joinOnceRequest(room, newCapabilityToken());
    expect(fresh.status).toBe(409);
    expect((await fresh.json()).error).toBe('joining_closed');
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(1);
  });

  it('a restored 300-participant room recovers an accepted secret without consuming another capacity slot', async () => {
    const room = await newRoom('join-once-capacity');
    const secret = newCapabilityToken();
    const first = await acceptedJoinOnce(room, secret);
    // One actual accepted join plus 299 normalized restored participants; this is not
    // a claim of 300 native accepted joins or provider load evidence.
    await runInDurableObject(room.stub, (instance, state) => {
      for (let index = 1; index < 300; index++) instance.state.participants[uuidv7()] = { ...instance.state.participants[first.participantId] };
      instance.state.arrivalCount = 300;
      const { caseDoc, ...stored } = instance.state;
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'state'", JSON.stringify(stored));
    });
    const before = await joinStore(room);
    const replay = await acceptedJoinOnce(room, secret);
    expect(replay.participantId === first.participantId).toBe(true);
    expect((await joinStore(room)) === before).toBe(true);
    const fresh = await joinOnceRequest(room, newCapabilityToken());
    expect(fresh.status).toBe(409);
    expect((await fresh.json()).error).toBe('room_full');
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(300);
  });

  it('removed revoked and ended participants never recover a join or refresh its receipt', async () => {
    for (const mode of ['removed', 'removed_state_only', 'revoked', 'missing_participant', 'ended']) {
      const room = await newRoom('join-once-refuse-' + mode);
      const secret = newCapabilityToken();
      const first = await acceptedJoinOnce(room, secret);
      if (mode === 'removed') await send(room, room.facilitatorToken, cmd('remove_participant', { participantId: first.participantId }));
      else if (mode === 'removed_state_only' || mode === 'missing_participant') await runInDurableObject(room.stub, (instance, state) => {
        if (mode === 'removed_state_only') instance.state.participants[first.participantId].removedAt = new Date().toISOString();
        else delete instance.state.participants[first.participantId];
        const { caseDoc, ...stored } = instance.state;
        state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'state'", JSON.stringify(stored));
      });
      else if (mode === 'revoked') { const sha = await hashToken(secret); await runInDurableObject(room.stub, (_instance, state) => state.storage.sql.exec('UPDATE credentials SET revoked_at = ? WHERE token_sha256 = ?', new Date().toISOString(), sha)); }
      else await send(room, room.facilitatorToken, cmd('end'));
      const before = await joinStore(room);
      const response = await room.stub.join(ME.displayName, ME.avatarId, secret);
      expect(response.status).toBe(mode === 'ended' ? 410 : mode === 'missing_participant' ? 409 : 403);
      expect(response.error).toBe(mode === 'ended' ? 'room_ended' : mode === 'missing_participant' ? 'join_retry_unavailable' : 'removed');
      expect((await joinStore(room)) === before).toBe(true);
    }
  });

  it('expiry metadata and deletion during hashing fail closed before touching an invalid room', async () => {
    for (const mode of ['expired', 'missing', 'nonfinite', 'deleted', 'invalid']) {
      const room = await newRoom('join-once-lifetime-' + mode);
      const secret = newCapabilityToken();
      const result = await runInDurableObject(room.stub, async (instance, state) => {
        const pending = instance.join(ME.displayName, ME.avatarId, secret);
        if (mode === 'deleted') { instance.state = null; await state.storage.deleteAll(); }
        else if (mode === 'invalid') { instance.loadInvalid = true; }
        else if (mode === 'missing') state.storage.sql.exec("DELETE FROM meta WHERE key = 'expires_at'");
        else state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", mode === 'expired' ? String(Date.now() - 1) : 'not-finite');
        return pending;
      });
      expect(result.status).toBe(mode === 'expired' ? 410 : mode === 'deleted' ? 404 : 503);
      expect(result.error).toBe(mode === 'expired' ? 'room_ended' : mode === 'deleted' ? 'unknown_room' : 'unavailable');
      if (mode !== 'deleted') expect((await runInDurableObject(room.stub, instance => Object.keys(instance.state.participants).length))).toBe(0);
    }
  });

  it('a join receipt persistence fault rolls back credentials journal state and archive before a successful retry', async () => {
    const room = await newRoom('join-once-rollback');
    const secret = newCapabilityToken();
    await runInDurableObject(room.stub, (_instance, state) => state.storage.sql.exec("CREATE TRIGGER join_receipt_fault BEFORE INSERT ON receipts WHEN NEW.ledger_key LIKE 'join:%' BEGIN SELECT RAISE(ABORT, 'join_proof_abort'); END"));
    let failed = false;
    let before;
    let after;
    try {
      before = await joinStore(room);
      try { await room.stub.join(ME.displayName, ME.avatarId, secret); }
      catch (error) { failed = /join_proof_abort/.test(String(error)); }
      after = await joinStore(room);
    } finally {
      await runInDurableObject(room.stub, (_instance, state) => state.storage.sql.exec('DROP TRIGGER IF EXISTS join_receipt_fault'));
    }
    expect(failed).toBe(true);
    expect(after === before).toBe(true);
    expect(await runInDurableObject(room.stub, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'join_receipt_fault'").one().n)).toBe(0);
    const first = await acceptedJoinOnce(room, secret);
    expect(first.token === secret).toBe(true);
    expect((await snap(room, room.facilitatorToken)).view.participants.length).toBe(1);
  });
});
