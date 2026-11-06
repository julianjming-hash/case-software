// Summary-only account history. A cursor supplies an ordering anchor, never authority.
import { isUuid, isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { AuthUnavailableError, bearer, verifyFacilitatorJwt } from './auth.mjs';
import { actorFor, adminArgs, authorize, seesEveryRoom } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { rpcClient } from './rpc.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const FILTERS = new Set(['all', 'running', 'ended']);
const time = value => typeof value === 'string' && value.length <= 40 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const micros = value => BigInt(Date.parse(value)) * 1000n + BigInt(Number((/\.(\d{1,6})/.exec(value)?.[1] ?? '').padEnd(6, '0')) % 1000);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const fail = (error, status) => reply({ error }, status);
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function context(actorId, workspaceId, filter) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify([
    'case-room-history-created-desc-v1', actorId, workspaceId, filter,
  ])));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
async function parseAfter(value, actorId, workspaceId, filter) {
  if (value === null) return { id: null, at: null };
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    const claim = JSON.parse(dec.decode(Uint8Array.from(raw, c => c.charCodeAt(0))));
    if (!claim || Object.keys(claim).sort().join() !== 'a,c,t,v' || claim.v !== 1 ||
        !isUuidV7(claim.a) || !time(claim.t) || claim.c !== await context(actorId, workspaceId, filter)) return null;
    return { id: claim.a, at: claim.t };
  } catch { return null; }
}
async function nextAfter(row, actorId, workspaceId, filter) {
  return b64(enc.encode(JSON.stringify({ v: 1, a: row.session_id, t: row.created_at,
    c: await context(actorId, workspaceId, filter) })));
}

export async function handleRoomHistory(request, {
  env, rpc = null, verifyUser = verifyFacilitatorJwt, onAlert = null,
} = {}) {
  const url = new URL(request.url), match = /^\/api\/v1\/workspaces\/([^/]+)\/history$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET') return fail('method_not_allowed', 405);
  const workspaceId = match[1];
  if (!isUuidV7(workspaceId)) return fail('bad_request', 400);
  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user || !isUuid(user.userId)) return fail('unauthorised', 401);
  const rawLimit = url.searchParams.get('limit'), filter = url.searchParams.get('filter') ?? 'all';
  const limit = rawLimit === null ? 20 : /^[1-9]\d{0,2}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if ([...url.searchParams.keys()].some(k => !['limit','filter','after'].includes(k)) ||
      ['limit','filter','after'].some(k => url.searchParams.getAll(k).length > 1) ||
      !Number.isInteger(limit) || limit > 100 || !FILTERS.has(filter)) return fail('bad_request', 400);
  const after = await parseAfter(url.searchParams.get('after'), user.userId, workspaceId, filter);
  if (!after) return fail('bad_request', 400);
  const client = rpc ?? rpcClient(env), actor = actorFor(user, env);
  const inactive = await accountActive(client, actor.userId);
  if (inactive) return fail(inactive.error, inactive.status);
  // A case-only runner reads their own rooms of the cases they hold (CASE-336; SQL filters, authorize_records).
  const permission = await authorize(client, actor, { workspaceId, anyCase: true }, ACTIONS.readRoomHistory, onAlert);
  const everyRoom = seesEveryRoom(permission, ACTIONS.readRoomHistory);
  if (!permission.ok) return fail(permission.error, permission.status);
  const result = await client.call('list_room_history', { p_user_id: actor.userId,
    p_workspace_id: workspaceId, p_filter: filter, p_limit: limit,
    p_after_at: after.at, p_after_id: after.id, ...adminArgs(actor) });
  if (!result?.ok) {
    const mapped = rpcFailure('list_room_history', result, onAlert);
    return fail(mapped.error, mapped.status);
  }
  const rows = result.data;
  if (!Array.isArray(rows) || rows.length > limit) return fail('unavailable', 503);
  let previous = after;
  const ids = new Set();
  for (const row of rows) {
    if (!isUuidV7(row?.session_id) || ids.has(row.session_id) || !isUuidV7(row.case_version_id) ||
        typeof row.title !== 'string' || row.title.length > 200 || /[\u0000-\u001f\u007f]/.test(row.title) ||
        !Number.isSafeInteger(row.version_no) || row.version_no < 1 ||
        !['lobby','live','ended','expired'].includes(row.status) || !time(row.created_at) || !time(row.expires_at) ||
        (row.started_at !== null && !time(row.started_at)) || (row.ended_at !== null && !time(row.ended_at)) ||
        row.archive_state !== 'pending' || typeof row.own !== 'boolean' || (!everyRoom && !row.own) ||
        (previous.id !== null && !(micros(row.created_at) < micros(previous.at) ||
          (micros(row.created_at) === micros(previous.at) && row.session_id < previous.id))))
      return fail('unavailable', 503);
    ids.add(row.session_id); previous = { id: row.session_id, at: row.created_at };
  }
  return reply({ rooms: rows.map(row => ({ sessionId: row.session_id, caseVersionId: row.case_version_id,
    title: row.title, versionNo: row.version_no, status: row.status, createdAt: row.created_at,
    startedAt: row.started_at, endedAt: row.ended_at, expiresAt: row.expires_at,
    archiveState: row.archive_state, own: row.own })),
  nextAfter: rows.length === limit ? await nextAfter(rows.at(-1), actor.userId, workspaceId, filter) : null });
}
