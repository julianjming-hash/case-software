import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { readMe, readIntactVersion, startPublishedRoom } from '../src/worker/published-rooms.mjs';
import { authorize } from '../src/worker/authorize.mjs';

const userId = uuidv7();
const actor = Object.freeze({ userId, email: null, admin: false });
const workspaceId = uuidv7();
const versionId = uuidv7();
const sessionId = uuidv7();
const hex = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
const member = { workspace_id: workspaceId, slug: 'fsh-icu', name: 'FSH ICU', role: 'facilitator' };
const documentText = JSON.stringify(miniCase().doc);
const version = async () => ({ case_id: uuidv7(), version_no: 1, schema_version: 1,
  document: { malicious_sibling: true }, document_text: documentText, content_sha256: `\\x${await hex(documentText)}` });
const rpc = (handlers = {}) => {
  const calls = [];
  return { calls, call: async (name, args) => {
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === 'get_me') return { ok: true, data: [{ user_id: userId, display_name: 'Owner', memberships: [member], next_after: null, admin: false }] };
    if (name === 'get_case_version_for_workspace') return { ok: true, data: [await version()] };
    if (name === 'create_session') return { ok: true, data: args.p_session_id };
    return { ok: true, data: null };
  } };
};
const failed = (kind, status, code = null) => ({ ok: false, kind, status, code });
const setup = (handlers = {}) => {
  const service = rpc(handlers), events = [], codes = new Set(), released = [], rooms = [];
  const directory = {
    register: async code => { if (codes.has(code)) return false; codes.add(code); return true; },
    release: async code => { released.push(code); codes.delete(code); },
  };
  const room = {
    create: async input => { rooms.push(input); return { facilitatorToken: 'test-only-token', expiresAt: '2026-10-03T00:00:00Z' }; },
    abortCreate: async () => { rooms.length = 0; },
  };
  const options = { rpc: service, actor, workspaceId, caseVersionId: versionId,
    ttlMs: 60_000, sessionId, directory, room, newCode: () => 'ABC123',
    onAlert: event => { events.push(event); } };
  return { service, events, codes, released, rooms, directory, room, options };
};

test('[AS-078] me is caller-scoped, bounded and exposes only the requested membership page', async () => {
  const service = rpc();
  const result = await readMe(service, userId, { limit: 25, after: workspaceId });
  assert.deepEqual(result, { ok: true, profile: { userId, displayName: 'Owner', role: null, labelConfirmed: null }, memberships: [member], nextAfter: null, admin: false, grants: [] });
  assert.deepEqual(service.calls[0], { name: 'get_me', args: { p_user_id: userId, p_limit: 25, p_after: workspaceId, p_workspace_id: null, p_admin: false, p_admin_email: null } });
});

test('a non-member gets 403 before version or session RPC; a real 42501 stays 500 and alerts', async () => {
  const absent = setup({ get_me: async () => ({ ok: true, data: [{ user_id: userId, display_name: 'Owner', memberships: [], next_after: null, admin: false }] }) });
  assert.deepEqual(await authorize(absent.service, actor, workspaceId, 'P-21', absent.options.onAlert), { ok: false, error: 'forbidden', status: 403 });
  assert.deepEqual(await startPublishedRoom(absent.options), { ok: false, error: 'forbidden', status: 403 });
  assert.deepEqual(absent.service.calls.map(c => c.name), ['get_me', 'get_me']);
  assert.equal(absent.codes.size, 0);

  const denied = setup({ get_me: async () => failed('forbidden', 500, '42501') });
  assert.deepEqual(await startPublishedRoom(denied.options), { ok: false, error: 'internal_error', status: 500 });
  assert.deepEqual(denied.events, [{ kind: 'rpc_forbidden', name: 'get_me' }]);
  assert.equal(denied.codes.size, 0);
});

test('[AS-078] version hash covers exact UTF-8 document_text and ignores a sibling document object', async () => {
  const service = rpc();
  const result = await readIntactVersion(service, actor, workspaceId, versionId);
  assert.equal(result.ok, true);
  assert.deepEqual(result.document, JSON.parse(documentText));
  assert.deepEqual(service.calls[0], { name: 'get_case_version_for_workspace', args: { p_version_id: versionId, p_workspace_id: workspaceId, p_user_id: userId, p_admin: false, p_admin_email: null } });
});

test('tampered text or invalid case returns 502 with a safe alert before claiming a code or creating a DO', async () => {
  for (const tampered of [
    { ...(await version()), document_text: documentText + ' ' },
    { ...(await version()), document_text: '{}', content_sha256: `\\x${await hex('{}')}` },
  ]) {
    const run = setup({ get_case_version_for_workspace: async () => ({ ok: true, data: [tampered] }) });
    assert.deepEqual(await startPublishedRoom(run.options), { ok: false, error: 'case_version_integrity', status: 502 });
    assert.deepEqual(run.events, [{ kind: 'case_version_integrity' }]);
    assert.equal(run.codes.size, 0);
    assert.equal(run.rooms.length, 0);
  }
});

test('version/workspace mismatch is 404, while a down PostgREST returns 503 before Directory work', async () => {
  const missing = setup({ get_case_version_for_workspace: async () => ({ ok: true, data: [] }) });
  assert.deepEqual(await startPublishedRoom(missing.options), { ok: false, error: 'not_found', status: 404 });
  assert.equal(missing.codes.size, 0);
  const down = setup({ get_me: async () => failed('unavailable', 503, 'network') });
  assert.deepEqual(await startPublishedRoom(down.options), { ok: false, error: 'unavailable', status: 503 });
  assert.equal(down.codes.size, 0);
});

test('a 23505 DB join-code collision releases the first Directory code and retries with a new one', async () => {
  let attempts = 0;
  const run = setup({ create_session: async args => ++attempts === 1 ? failed('unique', 409, '23505') : { ok: true, data: args.p_session_id } });
  const codes = ['ABC123', 'DEF456'];
  run.options.newCode = () => codes.shift();
  const result = await startPublishedRoom(run.options);
  assert.equal(result.ok, true);
  assert.equal(result.joinCode, 'DEF456');
  assert.deepEqual(run.released, ['ABC123']);
  assert.deepEqual([...run.codes], ['DEF456']);
  assert.equal(run.rooms.length, 1);
  assert.equal(run.rooms[0].archiveSessionId, sessionId);
  assert.deepEqual(run.service.calls.filter(c => c.name === 'create_session').map(c => c.args.p_join_code), ['ABC123', 'DEF456']);
});

test('ambiguous DB insert failure attempts end_session and releases the code; no room is joinable', async () => {
  const run = setup({ create_session: async () => failed('unavailable', 503, 'timeout') });
  assert.deepEqual(await startPublishedRoom(run.options), { ok: false, error: 'unavailable', status: 503 });
  assert.deepEqual(run.released, ['ABC123']);
  assert.equal(run.codes.size, 0);
  assert.equal(run.rooms.length, 0);
  assert.deepEqual(run.service.calls.find(c => c.name === 'end_session')?.args,
    { p_session_id: sessionId, p_final_revision: 0, p_final_epoch: 0 });
});

test('a potentially committed DO creation error aborts DO state, ends DB row and releases code', async () => {
  const run = setup();
  run.room.create = async input => { run.rooms.push(input); throw Error('private DO error'); };
  assert.deepEqual(await startPublishedRoom(run.options), { ok: false, error: 'unavailable', status: 503 });
  assert.equal(run.rooms.length, 0);
  assert.equal(run.codes.size, 0);
  assert.deepEqual(run.released, ['ABC123']);
  assert.equal(run.service.calls.filter(c => c.name === 'end_session').length, 1);
});

test('join-code search stops after eight collisions without inserting a session', async () => {
  const run = setup();
  let tries = 0;
  run.directory.register = async () => { tries++; return false; };
  assert.deepEqual(await startPublishedRoom(run.options), { ok: false, error: 'no_join_code', status: 503 });
  assert.equal(tries, 8);
  assert.equal(run.service.calls.some(c => c.name === 'create_session'), false);
});
