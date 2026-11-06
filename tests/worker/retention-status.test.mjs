import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { newJoinCode, uuidv7 } from '../../src/shared/ids.mjs';
import { apiUrl } from '../../src/shared/urls.mjs';

const named = sessionId => env.ROOM.get(env.ROOM.idFromName(sessionId));
const tableCount = state => state.storage.sql.exec(
  "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).toArray()[0].n;

it('[AS-094] Card 20 retention operator route authenticates before parsing and refuses malformed scope before RPC', async () => {
  const url = apiUrl('https://case.test', 'ops', 'retention-status');
  const body = JSON.stringify({ sessionId: uuidv7(), private: 'never forwarded' });
  const headers = { 'content-type': 'application/json' };
  const unauthenticated = await SELF.fetch(url, { method: 'POST', headers, body });
  expect(unauthenticated.status).toBe(404);
  expect(await unauthenticated.json()).toEqual({ error: 'not_found' });
  const authenticated = await SELF.fetch(url, { method: 'POST',
    headers: { ...headers, authorization: 'Bearer test-only-deploy-guard-token' }, body });
  expect(authenticated.status).toBe(400);
  expect(await authenticated.json()).toEqual({ error: 'bad_request' });
});

it('[AS-094] Card 20 orphan cold store cannot be reused and its tables, KV and alarm remain untouched', async () => {
  const sessionId = uuidv7(), stub = named(sessionId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE orphan_marker (value TEXT NOT NULL)');
    state.storage.sql.exec("INSERT INTO orphan_marker(value) VALUES ('old_store')");
    await state.storage.put('orphan-key', 'old_store');
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await evictDurableObject(stub);
  const before = await stub.retentionEvidence(sessionId);
  expect(before.storeEmpty).not.toBe(true);
  const created = await stub.create({ sessionId, joinCode: newJoinCode(),
    caseDoc: fixture, ownerUserId: uuidv7(), ttlMs: 60_000 });
  expect(created.error).toBe('unavailable');
  expect(created.status).toBe(503);
  const after = await stub.retentionEvidence(sessionId);
  expect(after.storeEmpty).not.toBe(true);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.storage.sql.exec('SELECT value FROM orphan_marker').toArray()[0].value).toBe('old_store');
    expect(await state.storage.get('orphan-key')).toBe('old_store');
    expect(await state.storage.getAlarm()).not.toBeNull();
    expect(state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name='meta'").toArray()).toEqual([]);
  });
});

it('[AS-094] Card 20 retention probe leaves never-created named room storage and alarm untouched', async () => {
  const sessionId = uuidv7(), stub = named(sessionId);
  const result = await stub.retentionEvidence(sessionId);
  expect(result).toMatchObject({ sessionId, storeEmpty: true, tableCount: 0,
    kvPresent: false, alarmPresent: false, statePresent: false });
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(tableCount(state)).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it('[AS-094] Card 20 retention probe refuses a different named room and reports live then deleted storage', async () => {
  const sessionId = uuidv7(), otherId = uuidv7(), owner = uuidv7(), stub = named(sessionId);
  const created = await stub.create({ sessionId, joinCode: newJoinCode(),
    caseDoc: fixture, ownerUserId: owner, ttlMs: 60_000 });
  expect(created.facilitatorToken).toBeTruthy();
  expect(await stub.retentionEvidence(otherId)).toEqual({ error: 'unavailable' });
  const live = await stub.retentionEvidence(sessionId);
  expect(live).toMatchObject({ sessionId, storeEmpty: false,
    kvPresent: false, alarmPresent: true, statePresent: true });
  expect(live.tableCount).toBeGreaterThan(0);
  const ended = await stub.adminEnd({ sessionId, expectedOwnerUserId: owner, eventId: uuidv7() });
  expect(ended.ok).toBe(true);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value='1' WHERE key='recap_delete_at'");
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await evictDurableObject(stub);
  const deleted = await stub.retentionEvidence(sessionId);
  expect(deleted).toMatchObject({ sessionId, storeEmpty: true, tableCount: 0,
    kvPresent: false, alarmPresent: false, statePresent: false });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(tableCount(state)).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it('[AS-094] Card 20 cold retention probe does not migrate or normalize persisted state until ordinary access', async () => {
  const sessionId = uuidv7(), stub = named(sessionId);
  const created = await stub.create({ sessionId, joinCode: newJoinCode(),
    caseDoc: fixture, ownerUserId: uuidv7(), ttlMs: 60_000 });
  expect(created.facilitatorToken).toBeTruthy();
  const before = await runInDurableObject(stub, (instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value='1' WHERE key='schema_version'");
    const stateText = instance.sql.exec("SELECT value FROM meta WHERE key='state'").toArray()[0].value;
    return stateText;
  });
  await evictDurableObject(stub);
  const probe = await stub.retentionEvidence(sessionId);
  expect(probe.storeEmpty).toBe(false);
  const cold = await runInDurableObject(stub, (instance, state) => ({
    schema: instance.sql.exec("SELECT value FROM meta WHERE key='schema_version'").toArray()[0].value,
    state: instance.sql.exec("SELECT value FROM meta WHERE key='state'").toArray()[0].value,
    tables: tableCount(state),
  }));
  expect(cold.schema).toBe('1');
  expect(cold.state).toBe(before);
  const snapshot = await stub.snapshot(created.facilitatorToken);
  expect(snapshot.snapshot.view.role).toBe('facilitator');
  const warmed = await runInDurableObject(stub, instance =>
    instance.sql.exec("SELECT value FROM meta WHERE key='schema_version'").toArray()[0].value);
  expect(warmed).not.toBe('1');
  expect(cold.tables).toBeGreaterThan(0);
});
