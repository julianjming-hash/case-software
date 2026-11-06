// Participant feedback results (card 40 + feedback integration slice 9; docs/plans/PARTICIPANT-FEEDBACK.md §6, §8).
//   GET  /api/v1/portfolio/sessions/<id>/feedback   P-37 a room's feedback: its starter, or a deployment admin
//   GET  /api/v1/cases/<id>/versions/<n>/feedback   P-38 a version's pooled case feedback: workspace owners and authors
//   POST /api/v1/admin/feedback                     P-39 app feedback and everything pooled (the admin route gate, then here)
// The JWT is in the Authorization header and nothing personal is in a URL. SQL authorizes first (R); the Worker then checks
// the shape exactly and authorizes again from the matrix (W), so a hash, an id or a name can never pass through.
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { actorFor, adminArgs, authorize, authorizeSessionRecord, seesEveryRoom } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { isAdminUser } from './admin/gate.mjs';
import { withSecurityHeaders } from './headers.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { validSessionFeedback, validCaseFeedback, validAdminFeedback, validFeedbackFilter } from '../shared/feedback-results.mjs';

const ROOM = /^\/api\/v1\/portfolio\/sessions\/([^/]+)\/feedback$/;
const CASE = /^\/api\/v1\/cases\/([^/]+)\/versions\/([^/]+)\/feedback$/;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const fail = (error, status) => reply({ error }, status);
const rpcError = r => r?.code === '42501' ? fail('forbidden', 403) : r?.code === 'P0002' ? fail('not_found', 404)
  : ['22023', '22P02'].includes(r?.code) ? fail('bad_request', 400) : fail('unavailable', 503);

/** The P-37 and P-38 account routes; null for any other path. */
export async function handleFeedbackResults(request, { env, rpc, verifyUser = verifyFacilitatorJwt, onAlert = null } = {}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
  const room = ROOM.exec(path), kase = room ? null : CASE.exec(path);
  if (!room && !kase) return null;
  if (request.method !== 'GET') return fail('method_not_allowed', 405);
  const versionNo = kase && /^[1-9][0-9]{0,5}$/.test(kase[2]) ? Number(kase[2]) : null;
  if (url.search || !isUuidV7((room ?? kase)[1]) || kase && versionNo === null) return fail('bad_request', 400);
  let user;
  try { user = await verifyUser(bearer(request), env); } catch (e) { if (e instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw e; }
  if (!user?.userId) return fail('unauthorised', 401);
  const actor = actorFor(user, env), inactive = await accountActive(rpc, actor.userId);
  if (inactive) return fail(inactive.error, inactive.status);
  if (room) {
    const sessionId = room[1];
    const result = await rpc.call('session_feedback_summary', { p_user_id: actor.userId, p_session_id: sessionId, ...adminArgs(actor) });
    if (!result?.ok) return rpcError(result);
    const v = result.data;
    if (!validSessionFeedback(v, { internal: true }) || v.session.id !== sessionId) return fail('unavailable', 503);
    // On the room's own case (CASE-336): a case-only runner reads their own room's feedback.
    const permitted = await authorizeSessionRecord(rpc, actor, v.session, ACTIONS.readRoomFeedback, onAlert);
    if (!permitted.ok) return fail(permitted.error, permitted.status);
    // P-37's starter rule: own rooms only, unless the admin path or an owner under managers_see_records (CASE-337).
    if (!seesEveryRoom(permitted, ACTIONS.readRoomFeedback) && !v.session.own) return fail('forbidden', 403);
    const { workspaceId, own, ...session } = v.session;
    return reply({ ...v, session });
  }
  const caseId = kase[1];
  const result = await rpc.call('case_feedback_summary', { p_user_id: actor.userId, p_case_id: caseId, p_version_no: versionNo, ...adminArgs(actor) });
  if (!result?.ok) return rpcError(result);
  const v = result.data;
  if (!validCaseFeedback(v, { internal: true }) || v.case.id !== caseId || v.case.versionNo !== versionNo) return fail('unavailable', 503);
  const permitted = await authorize(rpc, actor, { workspaceId: v.case.workspaceId, caseId }, ACTIONS.readCaseFeedback, onAlert);
  if (!permitted.ok) return fail(permitted.error, permitted.status);
  const { workspaceId, ...head } = v.case;
  return reply({ ...v, case: head });
}

// ─── P-39: the admin's pooled view. The cursor is an offset bound to this admin and this exact filter. ───────────
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(value))))].map(b => b.toString(16).padStart(2, '0')).join('');
const encode = value => btoa(String.fromCharCode(...enc.encode(JSON.stringify(value)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function decode(value) {
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    return JSON.parse(dec.decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))));
  } catch { return null; }
}
const canonical = f => f.scope === 'session' ? [f.scope, f.sessionId] : f.scope === 'case' ? [f.scope, f.caseId, f.versionNo] : [f.scope];

/** Called by the admin handler after its gate (verified admin JWT, active account, same-origin write). */
export async function adminFeedbackQuery({ request, user, env, body, rpc }) {
  const admin = (status, error) => withSecurityHeaders(fail(error, status));
  if (!isAdminUser(user, env)) return admin(403, 'forbidden');
  if (new URL(request.url).search) return admin(400, 'bad_request');
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join() : '';
  if (keys !== 'after,filter' || !validFeedbackFilter(body.filter) || !(body.after === null || typeof body.after === 'string')) return admin(400, 'bad_request');
  const context = await digest(['admin-feedback-v1', user.userId, ...canonical(body.filter)]);
  let after = 0;
  if (body.after !== null) {
    const cursor = decode(body.after);
    if (!cursor || Object.keys(cursor).sort().join() !== 'context,offset' || cursor.context !== context || !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 20 || cursor.offset > 10000 || cursor.offset % 20) return admin(400, 'bad_request');
    after = cursor.offset;
  }
  const result = await rpc.call('admin_feedback_page', { p_user_id: user.userId, p_filter: body.filter, p_after: after, ...adminArgs(actorFor(user, env)) });
  if (!result?.ok) return withSecurityHeaders(rpcError(result));
  const v = result.data;
  if (!validAdminFeedback(v, { internal: true }) || v.scope !== body.filter.scope || v.next !== null && v.next !== after + 20 ||
      v.scope === 'session' && v.result.session.id !== body.filter.sessionId ||
      v.scope === 'case' && (v.result.case.id !== body.filter.caseId || v.result.case.versionNo !== body.filter.versionNo)) return admin(503, 'admin_unavailable');
  return withSecurityHeaders(reply({ scope: v.scope, result: v.result, nextAfter: v.next === null ? null : encode({ context, offset: v.next }) }));
}
