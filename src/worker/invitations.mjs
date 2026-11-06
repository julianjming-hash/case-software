// Invitations (CASE-339, CASE-340, CASE-341; plan §3 A4; docs/PERMISSIONS.md P-03, P-43, P-44, P-46). Case finds or
// creates the invitee's account itself (GoTrue `email_confirm: true`, no GoTrue email), saves the invitation through
// case_api.create_invitation with only the SHA-256 of a fresh reference, then sends its own email (invite-email.mjs) and
// records the delivery. Every outcome is a stated fact with its reason; a known GoTrue or Resend failure is never
// "manual reconciliation". The reference travels only in the link's fragment and in POST bodies (CASE-341).
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { readJson } from './request-json.mjs';
import { accountActive } from './admin/account-active.mjs';
import { actorFor, adminArgs, authorize } from './authorize.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { inviteMessage, sendInviteEmail } from './invite-email.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { isUuid, isUuidV7 } from '../shared/ids.mjs';
import { INVITE_REF } from '../shared/urls.mjs';

const BODY_BYTES = 4096;
const LEVELS = new Set(['run', 'edit', 'manage']);
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
export const fail = (error, status, extra = {}) => json({ error, ...extra }, status);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

/** A fresh 32-byte reference (base64url, 43 characters) and the bytea literal of its SHA-256, the only form stored. */
export async function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const ref = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { ref, hash: await referenceHash(ref) };
}
export async function referenceHash(ref) {
  return `\\x${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ref)))}`;
}

/** The facts the client may see about an invitation (never its reference or hash). */
function publicInvitation(row) {
  return { id: row.invitationId, email: row.email ?? null, level: row.level, workspaceId: row.workspaceId,
    workspaceName: row.workspaceName ?? null, caseId: row.caseId ?? null, caseTitle: row.caseTitle ?? null,
    inviterName: row.inviterName ?? null, expiresAt: row.expiresAt };
}
const factsOk = row => plain(row) && isUuidV7(row.invitationId) && LEVELS.has(row.level) && isUuidV7(row.workspaceId) &&
  (row.caseId === null || isUuidV7(row.caseId)) && typeof row.email === 'string' && Number.isFinite(Date.parse(row.expiresAt));

/**
 * Find the invitee's account, or say why it cannot be invited. `{ ok, userId|null }` (null: no account yet), or a refusal.
 * A disabled or soft-deleted account is named to an administrator; anyone else hears that the address cannot be invited.
 */
async function existingAccount(gotrue, rpc, email, admin) {
  const found = await gotrue.findUserByEmail(email);
  if (!found?.ok) return { ok: false, error: found?.kind === 'rate_limited' ? 'auth_rate_limited' : 'auth_unavailable', status: 503 };
  const user = found.user;
  if (!user) return { ok: true, userId: null };
  if (!isUuid(user.id) || user.email.toLowerCase() !== email) return { ok: false, error: 'auth_unavailable', status: 503 };
  const profiles = await rpc.call('admin_read_profiles', { p_user_ids: [user.id] });
  if (!profiles?.ok || !Array.isArray(profiles.data)) return { ok: false, error: 'unavailable', status: 503 };
  const profile = profiles.data.find(row => row?.user_id === user.id) ?? null;
  if (profile?.soft_deleted_at) return { ok: false, error: admin ? 'account_deleted' : 'account_unavailable', status: 409 };
  if (profile?.disabled_at) return { ok: false, error: admin ? 'account_disabled' : 'account_unavailable', status: 409 };
  return { ok: true, userId: user.id };
}

/** Create the account for a new address (email already confirmed). `{ ok, userId }` or `{ ok: false, reason }`. */
async function createAccount(gotrue, email) {
  const made = await gotrue.createUser(email);
  if (made?.ok && isUuid(made.userId)) return { ok: true, userId: made.userId };
  if (made?.kind === 'exists') {
    // Another request made it first; the account is the one GoTrue now lists.
    const again = await gotrue.findUserByEmail(email);
    if (again?.ok && again.user && isUuid(again.user.id)) return { ok: true, userId: again.user.id };
  }
  return { ok: false, reason: made?.kind === 'rate_limited' ? 'account_rate_limited' : made?.kind === 'rejected' ? 'account_rejected' : 'account_failed' };
}

/**
 * Make sure the account exists, send the email, record the delivery, and answer the outcome:
 *   sent | email_not_configured (saved; Resend once the key is set) | email_limit (saved; retryAfter) |
 *   saved_not_sent (saved; reason: the account could not be created, or the provider refused) — Resend completes each.
 */
async function deliver({ rpc, gotrue, env, fetchImpl, nowMs, facts, ref, origin, inviterEmail, accountId }) {
  let reason = null, userId = accountId;
  if (userId === null) {
    const account = await createAccount(gotrue, facts.email);
    if (account.ok) userId = account.userId; else reason = account.reason;
  }
  let outcome = 'saved_not_sent', retryAfter = null, record = 'failed';
  if (userId !== null) {
    let message;
    try { message = inviteMessage({ ...facts, ref, origin }); } catch { message = null; }
    const sent = message ? await sendInviteEmail({ env, message, replyTo: inviterEmail, fetchImpl, nowMs: nowMs() }) : { ok: false, kind: 'failed' };
    if (sent.ok) { outcome = 'sent'; record = 'sent'; }
    else if (sent.kind === 'email_not_configured') { outcome = 'email_not_configured'; record = 'email_not_configured'; }
    else if (sent.kind === 'email_limit') { outcome = 'email_limit'; record = 'email_limit'; retryAfter = sent.retryAfter; }
    else reason = 'email_failed';
  }
  // The record is bookkeeping: its failure never turns a sent email into an error (Resend would send again).
  try { await rpc.call('record_invitation_delivery', { p_invitation_id: facts.invitationId, p_outcome: record, p_retry_after: retryAfter }); }
  catch { /* the outcome stands */ }
  return { outcome, ...(reason ? { reason } : {}), ...(retryAfter ? { retryAfter } : {}), account: accountId === null ? 'new' : 'existing',
    invitation: publicInvitation(facts) };
}

/** The canonical origin for links: CASE_PUBLIC_ORIGIN where deployed, else this request's own origin (local, staging). */
function linkOrigin(env, request) {
  try { const set = new URL(env?.CASE_PUBLIC_ORIGIN); if (set.href === `${set.origin}/`) return set.origin; } catch { /* unset */ }
  return new URL(request.url).origin;
}

export async function signedIn(request, { env, rpc, verifyUser }) {
  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return { error: fail('auth_unavailable', 503) }; throw error; }
  if (!user) return { error: fail('unauthorised', 401) };
  const refused = await accountActive(rpc, user.userId);
  if (refused) return { error: fail(refused.error, refused.status) };
  return { user, actor: actorFor(user, env) };
}

async function body(request) {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { error: fail('unsupported_media_type', 415) };
  const read = await readJson(request, BODY_BYTES);
  if (read.error) return { error: fail(read.error === 'too_large' ? 'too_large' : read.error === 'request_timeout' ? 'request_timeout' : 'bad_request',
    read.error === 'too_large' ? 413 : read.error === 'request_timeout' ? 408 : 400) };
  return { body: read.body };
}

const ROUTES = Object.freeze({
  create: /^\/api\/v1\/invitations$/, peek: /^\/api\/v1\/invitations\/peek$/,
  list: /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/invitations$/,
  action: /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/invitations\/([0-9a-f-]{36})\/(resend|revoke)$/,
});

/**
 * Routes: POST /api/v1/invitations (P-03 workspace, P-43 one case), GET /api/v1/workspaces/<id>/invitations and
 * POST …/invitations/<id>/resend|revoke (P-44), POST /api/v1/invitations/peek (P-46, no sign-in, rate-limited).
 * Returns null for any other path.
 */
export async function handleInvitationsApi(request, { env, rpc, gotrue, verifyUser = verifyFacilitatorJwt, fetchImpl = fetch,
  onAlert, peekLimited = async () => false, nowMs = () => Date.now() } = {}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
  const action = ROUTES.action.exec(path), list = ROUTES.list.exec(path);
  if (!(ROUTES.create.test(path) && method === 'POST') && !(ROUTES.peek.test(path) && method === 'POST') &&
      !(list && method === 'GET') && !(action && method === 'POST')) return null;
  if (url.search && !list) return fail('bad_request', 400);

  if (ROUTES.peek.test(path)) return peek(request, { rpc, onAlert, peekLimited });

  const who = await signedIn(request, { env, rpc, verifyUser });
  if (who.error) return who.error;
  const { user, actor } = who;
  const gotrueClient = () => (typeof gotrue === 'function' ? gotrue() : gotrue);

  if (list) {
    const [, workspaceId] = list;
    const after = url.searchParams.get('after');
    if (!isUuidV7(workspaceId) || [...url.searchParams.keys()].some(key => key !== 'after') || url.searchParams.getAll('after').length > 1 ||
        (after !== null && !isUuidV7(after))) return fail('bad_request', 400);
    const access = await authorize(rpc, actor, workspaceId, ACTIONS.manageInvitations, onAlert);
    if (!access.ok) return fail(access.error, access.status);
    const read = await rpc.call('list_invitations', { p_user_id: actor.userId, p_workspace_id: workspaceId, p_after: after, ...adminArgs(actor) });
    if (!read?.ok) { const mapped = rpcFailure('list_invitations', read, onAlert); return fail(mapped.error, mapped.status); }
    if (!plain(read.data) || !Array.isArray(read.data.invitations)) return fail('unavailable', 503);
    return json({ invitations: read.data.invitations.map(row => ({ ...publicInvitation(row), status: row.status, sendState: row.sendState,
      sendCount: row.sendCount, lastSendAt: row.lastSendAt ?? null, retryAfter: row.retryAfter ?? null, createdAt: row.createdAt,
      acceptedAt: row.acceptedAt ?? null, revokedAt: row.revokedAt ?? null, inviterKind: row.inviterKind })), nextAfter: read.data.nextAfter ?? null });
  }

  const parsed = await body(request);
  if (parsed.error) return parsed.error;

  if (action) {
    const [, workspaceId, invitationId, verb] = action;
    if (!isUuidV7(workspaceId) || !isUuidV7(invitationId) || !exactKeys(parsed.body, [])) return fail('bad_request', 400);
    // P-44 on the workspace the path names; SQL decides again on the invitation's own workspace.
    const access = await authorize(rpc, actor, workspaceId, ACTIONS.manageInvitations, onAlert);
    if (!access.ok) return fail(access.error, access.status);
    if (verb === 'revoke') {
      const done = await rpc.call('revoke_invitation', { p_user_id: actor.userId, p_invitation_id: invitationId, ...adminArgs(actor) });
      if (!done?.ok) { const mapped = rpcFailure('revoke_invitation', done, onAlert); return fail(mapped.error, mapped.status); }
      if (done.data?.outcome === 'ended') return fail('invitation_ended', 409);
      return done.data?.outcome === 'revoked' ? json({ outcome: 'revoked' }) : fail('unavailable', 503);
    }
    const fresh = await newReference();
    const resent = await rpc.call('resend_invitation', { p_user_id: actor.userId, p_invitation_id: invitationId, p_ref_hash: fresh.hash, ...adminArgs(actor) });
    if (!resent?.ok) { const mapped = rpcFailure('resend_invitation', resent, onAlert); return fail(mapped.error, mapped.status); }
    if (resent.data?.outcome === 'ended') return fail('invitation_ended', 409);
    if (resent.data?.outcome === 'cap_reached') return fail('cap_reached', 429, { retryAfter: resent.data.retryAfter ?? null });
    if (resent.data?.outcome !== 'resend' || !factsOk(resent.data) || resent.data.workspaceId !== workspaceId) return fail('unavailable', 503);
    const provider = gotrueClient();
    const account = await existingAccount(provider, rpc, resent.data.email, actor.admin);
    if (!account.ok) return fail(account.error, account.status);
    return json(await deliver({ rpc, gotrue: provider, env, fetchImpl, nowMs, facts: resent.data, ref: fresh.ref, origin: linkOrigin(env, request),
      inviterEmail: user.email, accountId: account.userId }));
  }

  // POST /api/v1/invitations
  const input = parsed.body;
  if (!exactKeys(input, ['workspaceId', 'level', 'email'], ['caseId']) || !isUuidV7(input.workspaceId) ||
      !(input.caseId === undefined || input.caseId === null || isUuidV7(input.caseId)) || !LEVELS.has(input.level) ||
      typeof input.email !== 'string' || input.email.length > 320) return fail('bad_request', 400);
  const email = input.email.trim().toLowerCase(), caseId = input.caseId ?? null;
  if (!EMAIL.test(email) || (caseId !== null && input.level === 'manage')) return fail('bad_request', 400);
  const access = await authorize(rpc, actor, caseId === null ? input.workspaceId : { workspaceId: input.workspaceId, caseId },
    caseId === null ? ACTIONS.inviteMember : ACTIONS.shareCase, onAlert);
  if (!access.ok) return fail(access.error, access.status);
  // P-03: only an administrator invites an owner. P-43: below Can manage, a case is shared to run only.
  if (access.role !== 'admin' && ((caseId === null && input.level === 'manage') || (caseId !== null && access.role !== 'owner' && input.level !== 'run')))
    return fail('forbidden', 403);
  const provider = gotrueClient();
  if (!provider?.findUserByEmail || !provider?.createUser) return fail('unavailable', 503);
  const account = await existingAccount(provider, rpc, email, actor.admin);
  if (!account.ok) return fail(account.error, account.status);
  const fresh = await newReference();
  const made = await rpc.call('create_invitation', { p_user_id: actor.userId, p_workspace_id: input.workspaceId, p_case_id: caseId,
    p_level: input.level, p_email: email, p_ref_hash: fresh.hash, p_invitee_user_id: account.userId, ...adminArgs(actor) });
  if (!made?.ok) { const mapped = rpcFailure('create_invitation', made, onAlert); return fail(mapped.error, mapped.status); }
  const outcome = made.data?.outcome;
  if (outcome === 'already_has_access') return json({ outcome, role: made.data.role ?? null });
  if (outcome === 'already_invited') return factsOk(made.data) ? json({ outcome, invitation: publicInvitation(made.data) }) : fail('unavailable', 503);
  if (outcome === 'cap_reached') return fail('cap_reached', 429, { retryAfter: made.data.retryAfter ?? null });
  if (outcome !== 'created' || !factsOk(made.data) || made.data.email !== email) return fail('unavailable', 503);
  return json(await deliver({ rpc, gotrue: provider, env, fetchImpl, nowMs, facts: made.data, ref: fresh.ref, origin: linkOrigin(env, request),
    inviterEmail: user.email, accountId: account.userId }), 201);
}

/** P-46 (CASE-341): the reference holder's read. A live reference answers its facts; an ended or unknown one, nothing. */
async function peek(request, { rpc, onAlert, peekLimited }) {
  if (await peekLimited(request)) return fail('rate_limited', 429);
  const parsed = await body(request);
  if (parsed.error) return parsed.error;
  if (!exactKeys(parsed.body, ['ref']) || typeof parsed.body.ref !== 'string' || !INVITE_REF.test(parsed.body.ref)) return fail('bad_request', 400);
  const read = await rpc.call('peek_invitation', { p_ref_hash: await referenceHash(parsed.body.ref) });
  if (!read?.ok) { const mapped = rpcFailure('peek_invitation', read, onAlert); return fail(mapped.error, mapped.status); }
  if (!Array.isArray(read.data) || read.data.length > 1) return fail('unavailable', 503);
  const [row] = read.data;
  if (!row) return json({ invitation: null });
  if (typeof row.email !== 'string' || !LEVELS.has(row.level)) return fail('unavailable', 503);
  return json({ invitation: { email: row.email, inviterName: row.inviter_name ?? null, workspaceName: row.workspace_name ?? null,
    caseTitle: row.case_title ?? null, level: row.level } });
}

/**
 * Acceptance at sign-in (CASE-339): the verified caller's pending invitations to their exact address become access, from
 * the /me route, before /me is read. Answers what changed (new or raised only) for the first-sign-in landing; a failure
 * never blocks /me (the next sign-in accepts again).
 */
export async function acceptInvitations(rpc, user) {
  const email = typeof user?.email === 'string' ? user.email.toLowerCase() : null;
  if (!email || !EMAIL.test(email) || !isUuid(user.userId)) return [];
  try {
    const result = await rpc.call('accept_invitations', { p_user_id: user.userId, p_email: email });
    if (!result?.ok || !Array.isArray(result.data)) return [];
    return result.data.filter(row => plain(row) && ['new', 'raised'].includes(row.change) && LEVELS.has(row.level) && isUuidV7(row.workspaceId) &&
      (row.caseId === null || isUuidV7(row.caseId))).slice(0, 20).map(row => ({ change: row.change, level: row.level, workspaceId: row.workspaceId,
      workspaceName: row.workspaceName ?? null, caseId: row.caseId ?? null, caseTitle: row.caseTitle ?? null, inviterName: row.inviterName ?? null }));
  } catch { return []; }
}

/** The ADMIN_PURGE_CRON step: ended invitations' addresses are nulled 30 days after they end (hard rule 8). */
export async function runInvitationPurge({ rpc }) {
  try {
    const result = await rpc.call('purge_invitation_addresses', {});
    return result?.ok && Number.isSafeInteger(result.data) && result.data >= 0 ? { ok: true, purged: result.data } : { ok: false };
  } catch { return { ok: false }; }
}
