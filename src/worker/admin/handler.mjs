// One server-only tagged dispatch; individual handlers repeat the verified-email gate.
import { matchAdminRoute } from './routes.mjs';
import { authorizeAdmin, isAdminUser, checkAdminWrite, adminAuditPrefix } from './gate.mjs';
import { mintElevation, recordElevation } from './stepup.mjs';
import { uuidv7, isUuidV7, isUuid } from '../../shared/ids.mjs';
import { withSecurityHeaders } from '../headers.mjs';
import { handleProfileAction,adminProfileMetadata } from './profiles.mjs';
import { handleLabelEdit, readLabels } from './label.mjs';
import { readAccess } from './access.mjs';
import { handleCaseRequest } from './cases.mjs';
import { handleWorkbench } from './workbench.mjs';
import { handleRoomRequest } from './room-handler.mjs';
import { handleStorageRequest } from './storage.mjs';
import { adminFeedbackQuery } from '../feedback-results.mjs';
import { BODY_READ_DEADLINE_MS } from '../request-deadline.mjs';

const reply = (status, body) => withSecurityHeaders(Response.json(body, { status }));
const fail = (status, error) => reply(status, { error });
const forbidden = () => fail(403, 'forbidden');
const unavailable = () => fail(503, 'admin_unavailable');

async function readBody(request, timeoutMs) {
  if (!request.body || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BODY_READ_DEADLINE_MS)
    return { error: fail(400, 'bad_request') };
  const reader = request.body.getReader();
  let timer, bytes = 0;
  const chunks = [];
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const cancel = () => { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Contained hostile cancellation. */ } };
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === null) { cancel(); return { error: fail(408, 'request_timeout') }; }
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65_536) { cancel(); return { error: fail(413, 'too_large') }; }
      chunks.push(part.value);
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return { body };
  } catch { cancel(); return { error: fail(400, 'bad_request') }; }
  finally { clearTimeout(timer); }
}

async function stepup({ request, route, user, env, body, rpc, gotrue, nowMs }) {
  if (!isAdminUser(user, env)) return forbidden(); // Defence if called without the outer dispatch.
  if (typeof env.STEPUP_SECRET !== 'string' || env.STEPUP_SECRET.length < 32) return unavailable();
  const verify = route.key === 'stepup_verify';
  if (!rpc?.call || !gotrue?.startStepUp || !gotrue?.verifyStepUp) return unavailable();
  // The persisted limiter also appends the attempt before any one-shot email/verification.
  const claim = await rpc.call('claim_admin_stepup_attempt', {
    p_event_id: uuidv7(), p_actor_email: user.email, p_action: route.key,
    p_from_prefix: adminAuditPrefix(request.headers.get('CF-Connecting-IP')),
  });
  if (!claim?.ok) return unavailable();
  if (claim.data !== true) return fail(429, 'rate_limited');
  if (Object.keys(body).some(key => key !== (verify ? 'code' : null)) ||
      (verify && (typeof body.code !== 'string' || body.code.length !== 6 || !/^[0-9]{6}$/.test(body.code))))
    return fail(400, 'bad_request');
  // R-a: the elevation is bound to this sign-in session; a JWT without a session id cannot hold one.
  if (verify && typeof user.sessionId !== 'string') return forbidden();
  const result = verify ? await gotrue.verifyStepUp(user.email, body.code) : await gotrue.startStepUp(user.email);
  if (!result?.ok) {
    // A5: a rejected code, a rate limit and an outage are told apart (the client says what happened and whether anything changed).
    const kind = result?.kind;
    if (kind === 'rate_limited') return fail(429, 'rate_limited');
    if (kind === 'code_rejected') return fail(422, 'code_rejected');
    if (kind === 'forbidden') return fail(403, 'forbidden');
    return unavailable();
  }
  if (!verify) return reply(202, { accepted: true });
  const minted = await mintElevation(user.email, user.sessionId, env.STEPUP_SECRET, { scope: 'admin' });
  // Recorded before it is handed out, so SQL can match the id a write names (red-team item 5).
  if (!await recordElevation(rpc, { jti: minted.jti, email: user.email, sessionId: user.sessionId })) return unavailable();
  return reply(200, { elevation: minted.token });
}

async function facilitatorRead({request, route, user, env, body, gotrue, rpc}) {
  if (!isAdminUser(user, env)) return forbidden();
  let page = 1, perPage = 100, query = '';
  if (route.key === 'facilitators_search') {
    if (Object.keys(body).some(key => !['query', 'page', 'perPage'].includes(key)) ||
        typeof body.query !== 'string' || body.query.length > 320 || !body.query.trim())
      return fail(400, 'bad_request');
    page = body.page ?? 1; perPage = body.perPage ?? 100;
    query = body.query.trim().toLowerCase();
  } else {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['page', 'perPage'].includes(key)) ||
        params.getAll('page').length > 1 || params.getAll('perPage').length > 1 ||
        [...params.values()].some(value => !/^[0-9]+$/.test(value)))
      return fail(400, 'bad_request');
    page = Number(params.get('page') ?? 1); perPage = Number(params.get('perPage') ?? 100);
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
      !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 1000)
    return fail(400, 'bad_request');
  if (!gotrue?.listUsers) return unavailable();
  // Search is deliberately one explicit page, with truthful sparse-page continuation.
  // Personal input never enters the provider URL or an unbounded inventory scan.
  const result = await gotrue.listUsers({page, perPage});
  if (!result?.ok || !Array.isArray(result.users) || result.users.length > perPage) return unavailable();
  const users = query ? result.users.filter(row => typeof row.email === 'string' &&
    row.email.toLowerCase().includes(query)) : result.users;
  if (!users.length) return reply(200,{users:[],nextPage:result.nextPage});
  if (!rpc?.call || users.some(row=>!isUuid(row.id)) || new Set(users.map(row=>row.id)).size!==users.length) return unavailable();
  const profiles = await rpc.call('admin_read_profiles',{p_user_ids:users.map(row=>row.id)});
  if (!profiles?.ok || !Array.isArray(profiles.data) || profiles.data.length > users.length) return unavailable();
  const byId=new Map();
  for(const row of profiles.data){
    if(!users.some(user=>user.id===row?.user_id)||byId.has(row.user_id))return unavailable();
    const state=adminProfileMetadata(row,row.user_id);
    if(!state)return unavailable();
    byId.set(row.user_id,state);
  }
  // P-41: each account's Name & role beside its admin state (null before the migration, or for an account with no profile).
  const labels=await readLabels(rpc,users.map(row=>row.id));
  // A5: each account's workspace roles and case grants (null when they cannot be read, never "none").
  const access=await readAccess(rpc,users.map(row=>row.id));
  return reply(200, {users:users.map(row=>({...row,profile:byId.get(row.id)??null,label:labels.get(row.id)??null,access:access?.get(row.id)??null})), nextPage:result.nextPage});
}

async function auditRead({request, user, env, rpc}) {
  if (!isAdminUser(user, env)) return forbidden();
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get('limit');
  const after = params.get('after');
  if ([...params.keys()].some(key => !['limit', 'after'].includes(key)) ||
      params.getAll('limit').length > 1 || params.getAll('after').length > 1 ||
      (rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) ||
      (after !== null && !isUuidV7(after))) return fail(400, 'bad_request');
  const limit = Number(rawLimit ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail(400, 'bad_request');
  if (!rpc?.call) return unavailable();
  const result = await rpc.call('list_admin_audit', {p_limit:limit, p_after:after});
  if (!result?.ok || !Array.isArray(result.data) || result.data.length > limit ||
      result.data.some(row => !isUuidV7(row?.event_id))) return unavailable();
  const events = result.data.map(row => ({id:row.event_id, intent_id:row.intent_id,
    phase:row.phase,action:row.action,target_type:row.target_type,target_id:row.target_id,
    actor_email:row.actor_email,before:row.before,after:row.after,at:row.at,from_prefix:row.from_prefix}));
  return reply(200, {events,
    nextCursor:events.length === limit ? events.at(-1).id : null});
}

async function workspaceAuditRead({request, route, user, env, rpc}) {
  if (!isAdminUser(user, env)) return forbidden();
  const workspaceId = route.pattern.exec(new URL(request.url).pathname)?.[1];
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get('limit'), after = params.get('after');
  if (!isUuidV7(workspaceId) || [...params.keys()].some(key => !['limit', 'after'].includes(key)) ||
      params.getAll('limit').length > 1 || params.getAll('after').length > 1 ||
      (rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) || (after !== null && !isUuidV7(after))) return fail(400, 'bad_request');
  const limit = Number(rawLimit ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail(400, 'bad_request');
  const result = await rpc.call('list_workspace_audit', { p_user_id: user.userId, p_workspace_id: workspaceId,
    p_limit: limit, p_after: after, p_admin: true, p_admin_email: user.email });
  if (!result?.ok || !Array.isArray(result.data) || result.data.length > limit ||
      result.data.some(row => !isUuidV7(row?.event_id))) return unavailable();
  const events = result.data.map(row => ({ id: row.event_id, actor_kind: row.actor_kind, actor_user_id: row.actor_user_id,
    actor_email: row.actor_email, action: row.action, target_type: row.target_type, target_id: row.target_id,
    revision: row.revision, elevation_id: row.elevation_id, at: row.at }));
  return reply(200, { events, nextCursor: events.length === limit ? events.at(-1).id : null });
}

// CASE-339: invitations moved to POST /api/v1/invitations (src/worker/invitations.mjs), which names its workspace and level.
// The old facilitator invite and resend routes, and the CASE_TEACHING_WORKSPACE_ID they read, are retired.

export async function handleAdminRequest(request, {
  env, verifyUser, rpc, gotrue, rooms, nowMs = () => Date.now(), bodyTimeoutMs = BODY_READ_DEADLINE_MS,
} = {}) {
  let route;
  try { route = matchAdminRoute(new URL(request.url).pathname, request.method); }
  catch { return fail(400, 'bad_request'); }
  if (!route || route.auth !== 'admin') return fail(404, 'not_found');
  const authorized = await authorizeAdmin(request, { env, verifyUser });
  if (!authorized.ok) return fail(authorized.status, authorized.error);
  let body = null;
  if (request.method === 'POST') {
    const write = checkAdminWrite(request, env?.CASE_PUBLIC_ORIGIN);
    if (!write.ok) return fail(write.status, write.error);
    const parsed = await readBody(request, bodyTimeoutMs);
    if (parsed.error) return parsed.error;
    body = parsed.body;
  }
  try {
    if (!isUuid(authorized.user.userId)) return forbidden();
    if (!rpc?.call) return unavailable();
    const actorActive = await rpc.call('admin_account_active',{p_user_id:authorized.user.userId});
    if (!actorActive?.ok || typeof actorActive.data !== 'boolean') return unavailable();
    if (actorActive.data !== true) return forbidden();
    if (['workspaces_query','workspace_query','membership_change','operations_query'].includes(route.key))
      return await handleWorkbench({request,route,user:authorized.user,env,body,rpc});
    if (route.key === 'feedback_query')
      return await adminFeedbackQuery({request, user:authorized.user, env, body, rpc});
    if (route.key === 'workspace_audit_list')
      return await workspaceAuditRead({request, route, user:authorized.user, env, rpc});
    if (['workspace_storage', 'workspace_storage_delete_unused', 'workspace_settings_set'].includes(route.key))
      return await handleStorageRequest({request, route, user:authorized.user, env, body, rpc});
    if (route.key === 'audit_list')
      return await auditRead({request, user:authorized.user, env, rpc});
    if (['cases_list','cases_publish','versions_withdraw'].includes(route.key))
      return await handleCaseRequest({request, route, user:authorized.user, env, body, rpc, nowMs});
    if (['rooms_list','rooms_end'].includes(route.key))
      return await handleRoomRequest({request, route, user:authorized.user, env, body, rooms, rpc, nowMs});
    const provider = () => typeof gotrue === 'function' ? gotrue() : gotrue;
    if (route.key === 'stepup_start' || route.key === 'stepup_verify')
      return await stepup({ request, route, user: authorized.user, env, body, rpc, gotrue:provider(), nowMs });
    if (['facilitators_list', 'facilitators_search'].includes(route.key))
      return await facilitatorRead({request, route, user:authorized.user, env, body, gotrue:provider(), rpc});
    if (['facilitators_disable','facilitators_enable','facilitators_soft_delete','facilitators_restore'].includes(route.key))
      return await handleProfileAction({request, route, user:authorized.user, env, body, rpc, gotrue:provider(), rooms, nowMs});
    if (route.key === 'facilitators_label')
      return await handleLabelEdit({request, route, user:authorized.user, env, body, rpc});
    // An unrecognized tagged implementation refuses rather than falling through to facilitator APIs.
    return unavailable();
  } catch { return unavailable(); } // Never forward adapter/error bodies or log administrative data.
}
