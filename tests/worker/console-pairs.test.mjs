import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { pairsDirectory, roomFor } from '../../src/worker/directory-do.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';

import {nativeAccountFetch} from './admin-fixtures.mjs';
const nativeActors=new Set();
const BASE = 'https://case.test';
const USER = uuidv7();
const jwt = async (sub = USER) => { nativeActors.add(sub); return signTestJwt({ sub, aud: 'authenticated', role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-only-secret-not-for-production'); };
const api = (path, { method = 'GET', token, body } = {}) => nativeAccountFetch(`${BASE}/api/v1${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
},[...nativeActors]);

describe('shared PC console pairs in real workerd', () => {
  it('[AS-080] owner preflight is read-only and denies other owners and ended rooms', async () => {
    const created = await api('/sessions', { method: 'POST', token: await jwt(), body: { caseDocument: fixture } });
    expect(created.status).toBe(201);
    const room = await created.json();
    const stub = roomFor(env, room.sessionId);
    const before = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT count(*) AS n FROM credentials').toArray()[0].n);
    // An inline dev room records no workspace; the Worker refuses its re-mint outside dev (card 35).
    expect(await stub.canIssueFacilitatorToken(USER)).toEqual({ ok: true, workspaceId: null, caseId: null, ownerAdminDigest: null, inlineDev: true });
    expect(await stub.canIssueFacilitatorToken(uuidv7())).toEqual({ error: 'forbidden', status: 403 });
    const after = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT count(*) AS n FROM credentials').toArray()[0].n);
    expect(after).toBe(before);
    const ended = await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token: room.facilitatorToken,
      body: { v: 1, type: 'end', epoch: 0, expectRevision: 0, clientEventId: uuidv7() } });
    expect(ended.status).toBe(200);
    expect(await stub.canIssueFacilitatorToken(USER)).toEqual({ error: 'room_ended', status: 410 });
  });

  it('[AS-080] a console code expires in five minutes, uses a hashed secret and is single-use', async () => {
    const pairs = pairsDirectory(env);
    const now = Date.now();
    const metadata = { browser: 'Chrome', country: 'AU', city: 'Perth', requestedAt: new Date(now).toISOString() };
    const created = await pairs.createConsolePair(metadata, now);
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(created.expiresAt).toBe(new Date(now + 5 * 60_000).toISOString());
    const dump = await runInDurableObject(pairs, (_instance, state) => JSON.stringify(state.storage.sql.exec('SELECT * FROM console_pairs').toArray()));
    expect(dump).not.toContain(created.secret);
    expect(await pairs.previewConsolePair(created.code, now)).toEqual({ ...metadata, expiresAt: created.expiresAt });
    expect(await pairs.pollConsolePair(created.pairId, created.secret, now)).toEqual({ pending: true, expiresAt: created.expiresAt });
    expect(await pairs.approveConsolePair(created.code, uuidv7(), USER, now)).toEqual({ ok: true });
    expect((await pairs.pollConsolePair(created.pairId, created.secret, now)).approved).toBe(true);
    expect(await pairs.pollConsolePair(created.pairId, created.secret, now)).toEqual({ error: 'unknown_pair' });
    const expired = await pairs.createConsolePair(metadata, now);
    expect(await pairs.previewConsolePair(expired.code, now + 300_000)).toEqual({ error: 'unknown_or_expired_code' });
  });

  it('[AS-080] two concurrent correct-secret pickups consume one console pair only once', async () => {
    const pairs = pairsDirectory(env), now = Date.now();
    const created = await pairs.createConsolePair({ browser: 'Other', country: 'Unknown', city: 'Unknown',
      requestedAt: new Date(now).toISOString() }, now);
    expect(await pairs.approveConsolePair(created.code, uuidv7(), USER, now)).toEqual({ ok: true });
    const results = await runInDurableObject(pairs, instance => Promise.all([
      instance.pollConsolePair(created.pairId, created.secret, now),
      instance.pollConsolePair(created.pairId, created.secret, now),
    ]));
    expect(results.filter(result => result.approved === true)).toHaveLength(1);
    expect(results.filter(result => result.error === 'unknown_pair')).toHaveLength(1);
  });

  it('[AS-080] facilitator token preflight and mint refuse expired and newly ended rooms', async () => {
    const created = await api('/sessions', { method: 'POST', token: await jwt(), body: { caseDocument: fixture } });
    expect(created.status).toBe(201);
    const room = await created.json(), stub = roomFor(env, room.sessionId);
    const expired = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() - 1));
      return { preflight: instance.canIssueFacilitatorToken(USER), mint: await instance.issueFacilitatorToken(USER) };
    });
    expect(expired.preflight).toEqual({ error: 'room_ended', status: 410 });
    expect(expired.mint).toEqual({ error: 'room_ended', status: 410 });
    const endedDuringHash = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'expires_at'", String(Date.now() + 60_000));
      return instance.issueFacilitatorToken(USER, async token => {
        instance.state.endedAt = new Date().toISOString();
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(bytes =>
          Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''));
      });
    });
    expect(endedDuringHash).toEqual({ error: 'room_ended', status: 410 });
  });
});
