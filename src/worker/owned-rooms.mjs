// The verified caller's bounded active room list for fresh-tab shared-PC approval.
// SQL reveals only IDs, join codes and expiry; RoomDO rechecks owner/ended status before mint.
import { isUuidV7 } from '../shared/ids.mjs';
import { AuthUnavailableError, bearer, verifyFacilitatorJwt } from './auth.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { rpcClient } from './rpc.mjs';
import { accountActive } from './admin/account-active.mjs';
import { actorFor, adminArgs } from './authorize.mjs';

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const fail = (error, status) => reply({ error }, status);
const JOIN_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export async function handleOwnedRooms(request, {
  env, rpc = null, verifyUser = verifyFacilitatorJwt, onAlert = null,
} = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/v1/me/rooms' || request.method !== 'GET') return null;
  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user) return fail('unauthorised', 401);
  const rawLimit = url.searchParams.get('limit'), after = url.searchParams.get('after');
  const limit = rawLimit === null ? 20 : /^[1-9]\d{0,2}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (url.searchParams.size > Number(rawLimit !== null) + Number(after !== null) ||
      !Number.isInteger(limit) || limit > 100 || (after !== null && !isUuidV7(after)))
    return fail('bad_request', 400);
  const client = rpc ?? rpcClient(env);
  const refused=await accountActive(client,user.userId);
  if (refused) return fail(refused.error,refused.status);
  const result = await client.call('list_owned_active_sessions', {
    // R-c (card 35): only rooms in workspaces where the person is still a member, or any room for an admin.
    p_user_id: user.userId, p_limit: limit, p_after: after, ...adminArgs(actorFor(user, env)),
  });
  if (!result?.ok) {
    const mapped = rpcFailure('list_owned_active_sessions', result, onAlert);
    return fail(mapped.error, mapped.status);
  }
  const rows = result.data;
  if (!Array.isArray(rows) || rows.length > limit || rows.some(row =>
    !isUuidV7(row?.session_id) || !JOIN_CODE.test(row?.join_code) ||
    typeof row?.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at))))
    return fail('unavailable', 503);
  return reply({ rooms: rows.map(row => ({ sessionId: row.session_id,
    joinCode: row.join_code, expiresAt: row.expires_at })),
  nextAfter: rows.length === limit ? rows.at(-1).session_id : null });
}
