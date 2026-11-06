// The one Worker authorization core (card 35, docs/PERMISSIONS.md §4.1, invariants 1-3, 9).
//
// actorFor() is the ONLY place the admin flag is computed: from the verified JWT and ADMIN_EMAILS (CASE-137),
// never from a body, header, query, cookie or cached /me value. authorize() reads the caller's membership
// once per request and applies the shared matrix (src/shared/permissions.mjs). adminArgs() is the only
// producer of the p_admin/p_admin_email RPC arguments; the RPCs check them again in SQL (case_app.authorize).
import { isAdminUser, adminEmails } from './admin/gate.mjs';
import { accountActive } from './admin/account-active.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { MATRIX, WORKSPACE_ROLES, CASE_GRANT_LEVELS, rolesFor, adminReaches, resolveCell } from '../shared/permissions.mjs';
import { readMe, rpcFailure } from './published-rooms.mjs';

const refuse = (error, status) => ({ ok: false, error, status });

/** The request's actor. `user` must come from verifyFacilitatorJwt; nothing else may set `admin`. */
export function actorFor(user, env) {
  const admin = isAdminUser(user, env);
  return Object.freeze({ userId: user.userId, email: admin ? user.email : null, admin });
}

/** The admin arguments every workspace RPC receives. A non-admin sends false and null. */
export function adminArgs(actor) {
  return actor?.admin === true && typeof actor.email === 'string'
    ? { p_admin: true, p_admin_email: actor.email } : { p_admin: false, p_admin_email: null };
}

/** Pure: may this role (or the admin path) take this action, per the matrix? Step-up is checked by the caller. */
export function allows(action, { admin = false, role = null } = {}) {
  if (!Object.hasOwn(MATRIX, action)) return false;
  if (admin) return adminReaches(action);
  return WORKSPACE_ROLES.includes(role) && rolesFor(action).includes(role);
}

const ALLOWED = new Set(['yes', 'step', 'own']);
const RANK = Object.freeze({ owner: 3, author: 2, facilitator: 1 });
const GRANT_ROLE = Object.freeze({ edit: 'author', run: 'facilitator' });
const LEVELS = Object.freeze(Object.keys(CASE_GRANT_LEVELS));
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure (CASE-336, CASE-337): what one person holds for a row, after the workspace's policies. `role` is their workspace
 * role, `grant` their live grant level on the case the request names (or, for a workspace record list, their strongest
 * grant in the workspace that reaches the row). Returns `{ role, scope }` in the existing vocabulary (the strongest held
 * principal whose cell allows the row; a tie keeps the workspace), or null when nothing they hold allows it.
 * Step-up is checked by the caller, as before.
 */
export function holds(action, { role = null, grant = null, policies = null } = {}) {
  if (!Object.hasOwn(MATRIX, action)) return null;
  const member = WORKSPACE_ROLES.includes(role) && ALLOWED.has(resolveCell(action, role, policies)) ? role : null;
  const granted = LEVELS.includes(grant) && ALLOWED.has(resolveCell(action, CASE_GRANT_LEVELS[grant], policies)) ? GRANT_ROLE[grant] : null;
  if (granted !== null && (member === null || RANK[granted] > RANK[member])) return { role: granted, scope: 'case' };
  return member === null ? null : { role: member, scope: 'workspace' };
}

/** One get_access row (a case place whose workspace the request does not name), checked to the letter. */
async function readAccess(client, actor, caseId, onAlert) {
  const result = await client.call('get_access', { p_user_id: actor.userId, p_workspace_id: null, p_case_id: caseId, ...adminArgs(actor) });
  if (!result?.ok) return rpcFailure('get_access', result, onAlert);
  if (!Array.isArray(result.data) || result.data.length > 1) return refuse('unavailable', 503);
  if (!result.data.length) return { ok: true, workspaceId: null };
  const [row] = result.data;
  if (row?.case_id !== caseId || !isUuidV7(row.workspace_id) || (row.member_role !== null && !WORKSPACE_ROLES.includes(row.member_role)) ||
      (row.grant_level !== null && !LEVELS.includes(row.grant_level)) || !plainObject(row.policies) || (row.role === 'admin') !== actor.admin)
    return refuse('unavailable', 503);
  return { ok: true, workspaceId: row.workspace_id, role: row.member_role, grant: row.grant_level, policies: row.policies, profile: null };
}

/**
 * Authorize (actor, place, action) for one request, reading membership, grant and policies once (plan §3 A3). `place`
 * is a workspace id, or `{ workspaceId, caseId, records }`:
 *   - a workspace id alone: a workspace action, decided by the membership (a case grant never reaches it);
 *   - with `caseId`: a case action; the person's live grant on THAT case counts too, never another case's. With the
 *     workspace named, one get_me read (memberships, grants and policies of that workspace, and the profile); without it,
 *     one get_access read, which takes the workspace from the case row (invariant 2) and has no profile;
 *   - with `anyCase: true` (workspace named, no case): the strongest live grant in the workspace that reaches the row
 *     counts too. For a record list (P-32) a case-only runner reads their own rooms of the cases they hold (SQL
 *     filters, case_app.authorize_records); for a start (P-21) it is the pre-check before the version is read, and
 *     onCase() then decides on the version's own case from the same facts, with no second read.
 * Resolves `{ ok, role, scope, workspaceId, policies, profile, held }` where role is 'admin' on the admin path, or
 * `{ ok: false, error, status }`. `held` is what was read (membership role and the workspace's grants). The SQL core
 * decides again on every RPC.
 */
export async function authorize(client, actor, place, action, onAlert) {
  if (!Object.hasOwn(MATRIX, action)) throw new TypeError(`unknown action ${action}`);
  const { workspaceId = null, caseId = null, anyCase = false } = typeof place === 'string' ? { workspaceId: place } : (place ?? {});
  if (!actor || (workspaceId !== null && !isUuidV7(workspaceId)) || (caseId !== null && !isUuidV7(caseId)) ||
      (workspaceId === null && caseId === null) || (anyCase === true && (caseId !== null || workspaceId === null))) return refuse('forbidden', 403);
  let facts;
  if (workspaceId === null) {
    facts = await readAccess(client, actor, caseId, onAlert);
    if (!facts.ok) return facts;
    if (facts.workspaceId === null) return refuse(actor.admin ? 'not_found' : 'forbidden', actor.admin ? 404 : 403);
  } else {
    const me = await readMe(client, actor.userId, { limit: 1, workspaceId, admin: adminArgs(actor) }, onAlert);
    if (!me.ok) return me;
    const membership = me.memberships.find(row => row?.workspace_id === workspaceId) ?? null;
    const grants = me.grants.filter(row => row?.workspace_id === workspaceId && LEVELS.includes(row.level));
    if (actor.admin && !membership) return refuse('not_found', 404); // an admin's get_me lists every workspace
    const grant = caseId !== null ? grants.find(row => row.case_id === caseId)?.level ?? null
      : anyCase === true ? strongestReaching(action, grants, membership?.policies ?? grants[0]?.policies) : null;
    facts = { workspaceId, role: membership?.role ?? null, grant, grants, policies: membership?.policies ?? grants[0]?.policies ?? null, profile: me.profile };
    // Inventory is bounded, not authority: a workspace may share more than 200 cases. Resolve the requested
    // case directly when a full inventory omitted it; never interpret omission from that page as revocation.
    if (!actor.admin && caseId !== null && grant === null && grants.length >= 200 && !holds(action, facts)) {
      const exact = await readAccess(client, actor, caseId, onAlert);
      if (!exact.ok) return exact;
      if (exact.workspaceId !== workspaceId) return refuse('forbidden', 403);
      facts = { ...facts, role: exact.role, grant: exact.grant, policies: exact.policies };
    }
  }
  if (actor.admin) {
    if (!allows(action, { admin: true })) return refuse('forbidden', 403);
    return { ok: true, role: 'admin', scope: 'workspace', workspaceId: facts.workspaceId, policies: facts.policies, profile: facts.profile, held: facts };
  }
  const decided = holds(action, facts);
  if (!decided) return refuse('forbidden', 403);
  return { ok: true, ...decided, workspaceId: facts.workspaceId, policies: facts.policies, profile: facts.profile, held: facts };
}

/**
 * Whether an authorization reaches every room of its workspace for an `own+pol` row (P-32, P-34, P-37): the admin path,
 * or a membership whose cell resolves to `yes` under the workspace's policies (owners under managers_see_records). Any
 * other holder reads their own rooms only.
 */
export function seesEveryRoom(access, action) {
  if (!access?.ok) return false;
  if (access.role === 'admin') return true;
  const role = access.held?.role ?? null;
  return WORKSPACE_ROLES.includes(role) && resolveCell(action, role, access.policies) === 'yes';
}

/**
 * Re-decide an `anyCase` authorization on one case of its workspace, from the facts it already read: the membership,
 * or the live grant on THAT case (never another case's). `{ ok, role, scope }` or a 403 refusal.
 */
export function onCase(access, caseId, action) {
  if (!access?.ok) return access;
  if (access.role === 'admin') return { ok: true, role: 'admin', scope: 'workspace' };
  const facts = access.held ?? {};
  const grant = isUuidV7(caseId) ? (facts.grants ?? []).find(row => row.case_id === caseId)?.level ?? null : null;
  const decided = holds(action, { role: facts.role ?? null, grant, policies: facts.policies ?? null });
  return decided ? { ok: true, ...decided } : refuse('forbidden', 403);
}

/** The strongest grant level among a person's grants in one workspace that reaches the row (a record list), or null. */
function strongestReaching(action, grants, policies) {
  const levels = new Set(grants.map(row => row.level));
  return LEVELS.filter(level => levels.has(level)).sort((a, b) => RANK[GRANT_ROLE[b]] - RANK[GRANT_ROLE[a]])
    .find(level => ALLOWED.has(resolveCell(action, CASE_GRANT_LEVELS[level], policies))) ?? null;
}

/** SHA-256 hex of an admin's verified email: a room records it so a later mint can re-test ADMIN_EMAILS. */
export async function emailDigest(email) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The room starter as an actor, for a mint with no JWT in hand (shared-PC pickup): the starter's user id,
 * and the admin path only if the digest the room recorded at start still matches a CURRENT ADMIN_EMAILS entry.
 */
export async function starterActor(userId, ownerAdminDigest, env) {
  if (typeof ownerAdminDigest === 'string') {
    for (const email of adminEmails(env) ?? []) {
      if (await emailDigest(email) === ownerAdminDigest) return Object.freeze({ userId, email, admin: true });
    }
  }
  return Object.freeze({ userId, email: null, admin: false });
}

/**
 * Invariant 10: a console credential (re-mint P-24, shared-PC approval P-25, pickup) is minted only for an
 * active account that still holds the room's case (a membership of its workspace, or a live grant on that case), or an admin. `room` is the DO's
 * canIssueFacilitatorToken answer. An inline dev room (marked by its DO) is re-minted only where inline rooms
 * are on. A room started before this Worker records no workspace in its DO; its workspace is then read from its
 * session row (red-team item 3), and a room with neither is refused.
 */
export async function mayMintConsole(client, actor, room, action, env, onAlert, sessionId) {
  if (room?.inlineDev === true) return env?.CASE_DEV_INLINE_CASES === '1' ? { ok: true } : refuse('forbidden', 403);
  let workspaceId = room?.workspaceId;
  if (workspaceId === null || workspaceId === undefined) {
    if (!isUuidV7(sessionId)) return refuse('unavailable', 503);
    const found = await client.call('get_session_workspace', { p_session_id: sessionId });
    if (!found?.ok) return refuse('unavailable', 503);
    if (!isUuidV7(found.data)) return refuse('forbidden', 403);
    workspaceId = found.data;
  }
  if (!isUuidV7(workspaceId)) return refuse('unavailable', 503);
  // The case the room was started from (CASE-336), recorded by its DO: a case-only starter keeps their console while
  // they still hold that case. A room started before this Worker records none and is decided by the membership.
  const caseId = room?.caseId ?? null;
  if (caseId !== null && !isUuidV7(caseId)) return refuse('unavailable', 503);
  const active = await accountActive(client, actor.userId);
  if (active) return refuse(active.error, active.status);
  const member = await authorize(client, actor, caseId === null ? workspaceId : { workspaceId, caseId }, action, onAlert);
  return member.ok ? { ok: true } : refuse(member.status === 404 ? 'forbidden' : member.error, member.status === 404 ? 403 : member.status);
}

/** Historical session scope is authoritative for other readers. Only the starter may fall back to current case access. */
export async function authorizeSessionRecord(client,actor,session,action,onAlert){
 if(!['P-34','P-37'].includes(action)||!isUuidV7(session?.workspaceId)||!isUuidV7(session?.caseId))return refuse('forbidden',403);
 const original=await authorize(client,actor,{workspaceId:session.workspaceId,caseId:session.caseId},action,onAlert);
 if(original.ok||original.status!==403||session.own!==true)return original;
 const current=await authorize(client,actor,{caseId:session.caseId},action,onAlert);
 if(!current.ok)return current;
 return {...current,role:current.role==='owner'?'author':current.role,scope:'case',workspaceId:session.workspaceId,held:{...current.held,role:null}};
}
/** P-32 discovery/preflight grants own records only; it grants no membership or case-start authority. */
export async function authorizePersonalRecordScope(client,actor,workspaceId,onAlert){
 const original=await authorize(client,actor,{workspaceId,anyCase:true},'P-32',onAlert);
 if(original.ok||original.status!==403)return original;
 const result=await client.call('personal_record_workspace_access',{p_user_id:actor.userId,p_workspace_id:workspaceId});
 if(!result?.ok)return result?.code==='42501'?refuse('forbidden',403):rpcFailure('personal_record_workspace_access',result,onAlert);
 const v=result.data;if(!v||Object.keys(v).sort().join()!=='ownOnly,workspaceId'||v.workspaceId!==workspaceId||v.ownOnly!==true)return refuse('unavailable',503);
 return {ok:true,role:'facilitator',scope:'case',workspaceId,policies:{},held:{role:null,grants:[],policies:{}}};
}
