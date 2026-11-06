// Facilitator-UX A4, ruling R7 (CASE-336): a case-only holder asking for a version of a case they hold no grant on gets a
// clean 403 — no 500, no rpc_forbidden alert — because the Worker checks the version's case (version_case, an id lookup)
// against the held grants BEFORE the version read, so SQL never refuses it. The 42501 -> 500 + alert rule is unchanged for
// every other refusal. Fake RPC clients only (hard rule 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { startPublishedRoom } from '../src/worker/published-rooms.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { POLICIES } from '../src/shared/permissions.mjs';

const USER = uuidv7(), WS = uuidv7(), CASE_A = uuidv7(), CASE_B = uuidv7(), VERSION_B = uuidv7(), VERSION_A = uuidv7();
const actor = Object.freeze({ userId: USER, email: null, admin: false });
const text = JSON.stringify(miniCase().doc);
const hex = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const VERSION_CASE = new Map([[VERSION_A, CASE_A], [VERSION_B, CASE_B]]);

/** A grant-only runner on CASE_A (or a facilitator member when `role` is set). SQL refuses a version of another case. */
function fake({ role = null } = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push(name);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'get_me') return { ok: true, data: [{ user_id: USER, display_name: 'Fay', next_after: null, admin: false,
      memberships: role ? [{ workspace_id: WS, slug: 'ws', name: 'WS', role, policies: POLICIES }] : [],
      grants: [{ workspace_id: WS, workspace_name: 'WS', case_id: CASE_A, title: 'A', level: 'run', policies: POLICIES }] }] };
    if (name === 'version_case') return { ok: true, data: VERSION_CASE.get(args.p_version_id) ?? null };
    if (name === 'get_case_version_for_workspace') {
      if (!role && VERSION_CASE.get(args.p_version_id) !== CASE_A) return { ok: false, kind: 'forbidden', status: 500, code: '42501' };
      return { ok: true, data: [{ case_id: VERSION_CASE.get(args.p_version_id), version_no: 1, schema_version: 1, document: {},
        document_text: text, content_sha256: `\\x${await hex(text)}` }] };
    }
    if (name === 'ensure_profile') return { ok: true, data: null };
    return { ok: false, kind: 'bad_request', status: 400, code: null };
  } };
}

const start = (rpc, events, caseVersionId) => startPublishedRoom({ rpc, actor, workspaceId: WS, caseVersionId, ttlMs: 60_000,
  sessionId: uuidv7(), directory: { register: async () => true, release: async () => {} },
  room: { create: async () => ({ facilitatorToken: 't', expiresAt: '2026-11-04T00:00:00Z' }), abortCreate: async () => {} },
  newCode: () => 'ABC123', onAlert: event => events.push(event) });

test('[AS-206] R7: a grant-only runner starting a version of a case they hold no grant on gets 403, never the version read or an alert', async () => {
  const rpc = fake(), events = [];
  assert.deepEqual(await start(rpc, events, VERSION_B), { ok: false, error: 'forbidden', status: 403 });
  assert.deepEqual(events, []);
  assert.ok(!rpc.calls.includes('get_case_version_for_workspace'), 'SQL is never asked, so no 42501 reaches the rpc alert');
  const unknown = fake();
  assert.deepEqual(await start(unknown, events, uuidv7()), { ok: false, error: 'forbidden', status: 403 }, 'an unknown version reads the same');
  assert.deepEqual(events, []);
});

test('[AS-206] R7: the pack read refuses the same way (403, no alert), and the held case still reads', async () => {
  const pack = (rpc, events, versionId) => handleFacilitatorApi(new Request(`https://case.test/api/v1/workspaces/${WS}/versions/${versionId}/pack`,
    { headers: { authorization: 'Bearer t' } }), { env: {}, rpc, onAlert: event => events.push(event),
    verifyUser: async () => ({ userId: USER, email: 'fay@example.org', sessionId: uuidv7() }) });
  const events = [], refused = fake();
  assert.equal((await pack(refused, events, VERSION_B)).status, 403);
  assert.ok(!refused.calls.includes('get_case_version_for_workspace'));
  assert.equal((await pack(fake(), events, VERSION_A)).status, 200);
  assert.deepEqual(events, []);
});

test('R7 is narrow: a member never needs the lookup, and a real 42501 for a member still alerts as 500', async () => {
  const member = fake({ role: 'facilitator' }), events = [];
  const started = await start(member, events, VERSION_B);
  assert.notEqual(started.status, 403);
  assert.ok(!member.calls.includes('version_case'), 'a membership decides without the lookup');
  const denied = { calls: [], async call(name, args) { return name === 'get_case_version_for_workspace'
    ? { ok: false, kind: 'forbidden', status: 500, code: '42501' } : fake({ role: 'facilitator' }).call(name, args); } };
  assert.deepEqual(await start(denied, events, VERSION_B), { ok: false, error: 'internal_error', status: 500 });
  assert.deepEqual(events.map(e => e.kind), ['rpc_forbidden']);
});
