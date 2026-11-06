// Share and "Shared with you" (CASE-336, plan §3 A6; docs/PERMISSIONS.md P-43). Three reads and writes behind the one
// authorize core: who holds a case and what is pending (the Share dialog), ending one person's grant, and the signed-in
// person's own shared cases. SQL decides again on every call (case_api.list_case_access, revoke_case_grant,
// list_shared_cases); the Worker adds the shape checks and the facts the dialog needs to offer only what will work.
import { signedIn, json, fail } from './invitations.mjs';
import { adminArgs, allows, authorize, holds } from './authorize.mjs';
import { verifyFacilitatorJwt } from './auth.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { readJson } from './request-json.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { isUuid, isUuidV7 } from '../shared/ids.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const LEVELS = new Set(['run', 'edit']);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const ROUTES = Object.freeze({
  shared: /^\/api\/v1\/shared-cases$/,
  access: /^\/api\/v1\/cases\/([0-9a-f-]{36})\/access$/,
  revoke: /^\/api\/v1\/cases\/([0-9a-f-]{36})\/access\/([0-9a-f-]{36})\/revoke$/,
});

/**
 * What the Share dialog may offer this person on this case, from the facts one authorize read returned (no second read):
 * the levels they may grant (a manager or administrator: Can run and Can edit; below that, Can run only, under
 * `runners_share`), whether the whole workspace can be shared (P-03), whether pending invitations can be resent or
 * revoked (P-44) and whether a grant can be ended (a manager or administrator only).
 */
export function shareFacts(access, workspaceHeld = access?.held) {
  if (!access?.ok) return null;
  const admin = access.role === 'admin', facts = { role: workspaceHeld?.role ?? null, policies: access.policies ?? null };
  const manager = admin || access.role === 'owner';
  return { levels: manager ? ['run', 'edit'] : ['run'],
    workspaceWide: admin ? allows(ACTIONS.inviteMember, { admin: true }) : holds(ACTIONS.inviteMember, facts) !== null,
    manageInvitations: admin ? allows(ACTIONS.manageInvitations, { admin: true }) : holds(ACTIONS.manageInvitations, facts) !== null,
    revoke: manager };
}

const validMember = row => plain(row) && isUuid(row.userId) && text(row.name, 200) && ['owner', 'author', 'facilitator'].includes(row.role);
const validGrant = row => plain(row) && isUuidV7(row.grantId) && isUuid(row.userId) && text(row.name, 200) && LEVELS.has(row.level) && Number.isFinite(Date.parse(row.grantedAt));
const validInvitation = row => plain(row) && isUuidV7(row.invitationId) && text(row.email, 320) && LEVELS.has(row.level) && Number.isFinite(Date.parse(row.expiresAt));
const validShared = row => plain(row) && isUuidV7(row.grant_id) && isUuidV7(row.case_id) && isUuidV7(row.workspace_id) && text(row.workspace_name, 200) &&
  text(row.title, 200) && LEVELS.has(row.level) && (row.member_role === null || ['owner', 'author', 'facilitator'].includes(row.member_role)) &&
  (row.version_id === null || isUuidV7(row.version_id)) && (row.version_no === null || Number.isSafeInteger(row.version_no)) &&
  typeof row.withdrawn === 'boolean' && typeof row.has_draft === 'boolean' && Number.isFinite(Date.parse(row.granted_at));

/**
 * GET /api/v1/shared-cases (the caller's own live grants), GET /api/v1/cases/<id>/access (P-43) and
 * POST /api/v1/cases/<id>/access/<grant>/revoke (P-43, managers and administrators). Null for any other path.
 */
export async function handleCaseAccessApi(request, { env, rpc, verifyUser = verifyFacilitatorJwt, onAlert } = {}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
  const shared = ROUTES.shared.test(path), access = ROUTES.access.exec(path), revoke = ROUTES.revoke.exec(path);
  if (!((shared || access) && method === 'GET') && !(revoke && method === 'POST')) return null;
  if (url.search) return fail('bad_request', 400);
  const who = await signedIn(request, { env, rpc, verifyUser });
  if (who.error) return who.error;
  const { actor } = who;

  if (shared) {
    const read = await rpc.call('list_shared_cases', { p_user_id: actor.userId });
    if (!read?.ok) { const mapped = rpcFailure('list_shared_cases', read, onAlert); return fail(mapped.error, mapped.status); }
    if (!Array.isArray(read.data) || read.data.length > 200 || !read.data.every(validShared)) return fail('unavailable', 503);
    return json({ cases: read.data.map(row => ({ grantId: row.grant_id, caseId: row.case_id, workspaceId: row.workspace_id,
      workspaceName: row.workspace_name, title: row.title, level: row.level, memberRole: row.member_role, versionId: row.version_id,
      versionNo: row.version_no, withdrawn: row.withdrawn, hasDraft: row.has_draft, grantedAt: row.granted_at })) });
  }

  const caseId = (access ?? revoke)[1];
  if (!isUuidV7(caseId)) return fail('bad_request', 400);
  const entitled = await authorize(rpc, actor, { caseId }, ACTIONS.shareCase, onAlert);
  if (!entitled.ok) return fail(entitled.status === 404 ? 'forbidden' : entitled.error, entitled.status === 404 ? 403 : entitled.status);
  const facts = shareFacts(entitled);

  if (access) {
    const read = await rpc.call('list_case_access', { p_user_id: actor.userId, p_case_id: caseId, ...adminArgs(actor) });
    if (!read?.ok) { const mapped = rpcFailure('list_case_access', read, onAlert); return fail(mapped.error, mapped.status); }
    const data = read.data;
    if (!plain(data) || data.caseId !== caseId || !isUuidV7(data.workspaceId) || !Array.isArray(data.members) || !Array.isArray(data.grants) ||
        !Array.isArray(data.invitations) || data.members.length > 200 || data.grants.length > 500 || data.invitations.length > 500 ||
        !data.members.every(validMember) || !data.grants.every(validGrant) || !data.invitations.every(validInvitation)) return fail('unavailable', 503);
    return json({ caseId, workspaceId: data.workspaceId, you: facts,
      members: data.members.map(({ userId, name, role }) => ({ userId, name, role })),
      grants: data.grants.map(({ grantId, userId, name, level, grantedAt }) => ({ grantId, userId, name, level, grantedAt })),
      invitations: data.invitations.map(({ invitationId, email, level, createdAt, expiresAt, sendState }) => ({ invitationId, email, level, createdAt: createdAt ?? null,
        expiresAt, sendState: sendState ?? null })) });
  }

  // Revoke: only a manager or an administrator ends access; SQL says so again and audits it (case_grant_revoke).
  if (!facts.revoke) return fail('forbidden', 403);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail('unsupported_media_type', 415);
  const parsed = await readJson(request, 1024);
  if (parsed.error || !plain(parsed.body) || Object.keys(parsed.body).length) return fail('bad_request', 400);
  const grantId = revoke[2];
  if (!isUuidV7(grantId)) return fail('bad_request', 400);
  const done = await rpc.call('revoke_case_grant', { p_user_id: actor.userId, p_grant_id: grantId, ...adminArgs(actor) });
  if (!done?.ok) { const mapped = rpcFailure('revoke_case_grant', done, onAlert); return fail(mapped.error, mapped.status); }
  return ['revoked', 'ended'].includes(done.data?.outcome) ? json({ outcome: done.data.outcome }) : fail('unavailable', 503);
}
