// Content-free saved-draft inventory. SQL rechecks P-14 and returns only bounded summary scalars.
import { projectDraftSummary } from '../shared/draft-summary.mjs';
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { actorFor, adminArgs, authorize } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { rpcFailure } from './published-rooms.mjs';

const fail = (error, status) => new Response(JSON.stringify({ error }), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const json = body => new Response(JSON.stringify(body), { status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function validPageRows(value, limit) {
  if (!Array.isArray(value) || value.length > limit + 1) return false;
  return value.every(row => row && isUuidV7(row.case_id) && Number.isSafeInteger(row.revision) && row.revision >= 0 &&
    typeof row.title === 'string' && row.title.length > 0 && row.title.length <= 200 && !unsafeText.test(row.title) &&
    typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at)));
}

/** Route handler for GET /api/v1/builder/workspaces/:workspaceId/drafts. */
export async function handleBuilderListApi(request, {
  rpc, env, onAlert, verifyUser = verifyFacilitatorJwt,
} = {}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
  const match = /^\/api\/v1\/builder\/workspaces\/([0-9a-f-]{36})\/drafts$/.exec(path);
  if (!match) return null;
  const workspaceId = match[1];
  if (!isUuidV7(workspaceId)) return fail('bad_request', 400);
  if (request.method !== 'GET') return fail('method_not_allowed', 405);
  if ([...url.searchParams.keys()].some(key => !['limit', 'offset','v'].includes(key)) ||
      url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('offset').length > 1 || url.searchParams.getAll('v').length>1 || url.searchParams.has('v')&&url.searchParams.get('v')!=='2') return fail('bad_request', 400);
  const parseBound = (key, fallback, min, max) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
  };
  const limit = parseBound('limit', 50, 1, 50), offset = parseBound('offset', 0, 0, 10_000);
  // Keep every valid page addressable. The 10,000 bound is on the largest
  // returned offset, including the final page rather than just its start.
  if (limit === null || offset === null || offset + limit > 10_000) return fail('bad_request', 400);
  if (!rpc || typeof rpc.call !== 'function') return fail('unavailable', 503);

  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user) return fail('unauthorised', 401);
  const active = await accountActive(rpc, user.userId);
  if (active) return fail(active.error, active.status);
  const actor = actorFor(user, env);
  const entitlement = await authorize(rpc, actor, workspaceId, ACTIONS.draft, onAlert);
  if (!entitlement.ok) return fail(entitlement.error, entitlement.status);

  const summary=url.searchParams.get('v')==='2',rpcName=summary?'builder_list_draft_summaries':'builder_list_drafts';
  const result = await rpc.call(rpcName, {
    p_workspace_id: workspaceId, p_limit: limit, p_offset: offset, p_user_id: actor.userId, ...adminArgs(actor),
  });
  if (!result?.ok) {
    const mapped = rpcFailure(rpcName, result, onAlert);
    return fail(mapped.error, mapped.status);
  }
  if (!validPageRows(result.data, limit)) return fail('unavailable', 503);
  const hasMore = result.data.length > limit && offset + limit < 10_000;
  const drafts = result.data.slice(0, limit).map(row => summary?projectDraftSummary(row):({ caseId: row.case_id, title: row.title, revision: row.revision, updatedAt: row.updated_at }));
  if(drafts.some(row=>row===null))return fail('unavailable',503);
  return json({ workspaceId, drafts, limit, offset, hasMore, nextOffset: offset + drafts.length,...(summary?{summaryVersion:2}:{}) });
}
