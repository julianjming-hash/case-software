// Published-room orchestration. Dependencies are supplied by the Worker so tests
// can prove the entire failure path without Supabase, a deployed origin or a DO.
import { validateRuntimeDocument } from '../shared/runtime-document.mjs';
import { validateSlideParts } from '../shared/slide-document.mjs';
import { sanitizeArt } from '../shared/art-descriptor.mjs';
import { tintOf } from '../shared/tints.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { authorize, onCase, adminArgs, emailDigest } from './authorize.mjs';
import { composeLabel, validLabel, parseLabelFields } from '../shared/facilitator-label.mjs';

const fail = (error, status) => ({ ok: false, error, status });
const safeAlert = (hook, event) => {
  if (typeof hook !== 'function') return;
  try { void Promise.resolve(hook(Object.freeze(event))).catch(() => {}); }
  catch { /* alert transport cannot replace an HTTP result */ }
};

export function rpcFailure(name, result, onAlert) {
  if (result?.code === '42501' || result?.code === 'PGRST202') {
    safeAlert(onAlert, { kind: 'rpc_forbidden', name });
    return fail('internal_error', 500);
  }
  if (result?.kind === 'unavailable') return fail('unavailable', 503);
  if (result?.kind === 'conflict') return fail('conflict', 409);
  if (result?.kind === 'unique') return fail('conflict', 409);
  if (result?.kind === 'not_found') return fail('not_found', 404);
  return fail('bad_request', 400);
}

/** get_me for the verified caller. `admin` is adminArgs(actor) from the core; nothing else sets it. */
export async function readMe(rpc, userId, { limit = 100, after = null, workspaceId = null,
  admin = adminArgs(null) } = {}, onAlert) {
  const result = await rpc.call('get_me', {
    p_user_id: userId, p_limit: limit, p_after: after, p_workspace_id: workspaceId, ...admin,
  });
  if (!result?.ok) return rpcFailure('get_me', result, onAlert);
  const rows = Array.isArray(result.data) ? result.data : [];
  const [row] = rows;
  if (rows.length !== 1 || row?.user_id !== userId || !Array.isArray(row.memberships) ||
      row.admin !== admin.p_admin ||
      (row.next_after !== null && typeof row.next_after !== 'string') ||
      (row.display_name !== null && typeof row.display_name !== 'string') ||
      (row.facilitator_role != null && typeof row.facilitator_role !== 'string') ||
      (row.label_confirmed_at != null && typeof row.label_confirmed_at !== 'string') ||
      (row.grants != null && !Array.isArray(row.grants))) return fail('unavailable', 503);
  // The facilitator's Name & role. labelConfirmed is null (unknown) from a database without the label migration, so no
  // client gates on it then; otherwise false until the facilitator saved them (the first-sign-in step).
  const labelConfirmed = row.label_confirmed_at === undefined ? null : row.label_confirmed_at !== null;
  return { ok: true, profile: { userId, displayName: row.display_name, role: row.facilitator_role ?? null, labelConfirmed },
    memberships: row.memberships, nextAfter: row.next_after, admin: row.admin,
    // The caller's live case grants (CASE-336); a database before the access migration answers none.
    grants: Array.isArray(row.grants) ? row.grants : [] };
}

/**
 * Ruling R7 (CASE-336): when only a case grant admitted a start (scope 'case'), the version's case is looked up first
 * (version_case, an id lookup) and decided from the facts already read, so a version of a case the person holds no grant
 * on is a clean 403 and SQL never refuses it (a 42501 there would be a 500 and an rpc_forbidden alert). A membership or
 * the admin path needs no lookup: SQL decides the read as before. An unknown version reads the same as a foreign one.
 */
export async function preCheckVersionCase(rpc, actor, member, versionId, action, onAlert) {
  if (!member?.ok || member.scope !== 'case' || member.role === 'admin') return { ok: true };
  const found = await rpc.call('version_case', { p_version_id: versionId });
  if (!found?.ok) return rpcFailure('version_case', found, onAlert);
  if (found.data !== null && !isUuidV7(found.data)) return fail('unavailable', 503);
  const decided = onCase(member, found.data, action);
  if (!decided.ok && isUuidV7(found.data) && (member.held?.grants?.length ?? 0) >= 200) {
    const exact = await authorize(rpc, actor, { caseId: found.data }, action, onAlert);
    if (!exact.ok) return exact;
    if (exact.workspaceId !== member.workspaceId || !['run', 'edit'].includes(exact.held?.grant)) return fail('forbidden', 403);
    // Keep this one validated case fact for the post-pack check. It is request-local and never client supplied.
    member.held.grants = [...member.held.grants.filter(row => row.case_id !== found.data),
      { case_id: found.data, workspace_id: exact.workspaceId, level: exact.held.grant }];
    return { ok: true };
  }
  return decided;
}

export async function readIntactVersion(rpc, actor, workspaceId, versionId, onAlert) {
  const result = await rpc.call('get_case_version_for_workspace', {
    p_version_id: versionId, p_workspace_id: workspaceId, p_user_id: actor.userId, ...adminArgs(actor),
  });
  if (!result?.ok) return rpcFailure('get_case_version_for_workspace', result, onAlert);
  if (!Array.isArray(result.data) || result.data.length > 1) return fail('unavailable', 503);
  if (!result.data.length) return fail('not_found', 404);
  const row = result.data[0];
  const text = row?.document_text;
  const hash = row?.content_sha256;
  const integrity = () => { safeAlert(onAlert, { kind: 'case_version_integrity' }); return fail('case_version_integrity', 502); };
  if (typeof text !== 'string' || typeof hash !== 'string' || !/^\\x[0-9a-f]{64}$/i.test(hash)) return integrity();
  const bytes = new TextEncoder().encode(text);
  // JSONB text adds whitespace to the bounded canonical Builder document.
  if (bytes.length > 2_097_152) return integrity();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== hash.slice(2).toLowerCase()) return integrity();
  let document;
  try { document = JSON.parse(text); } catch { return integrity(); }
  // Builder documents (schema 2, and schema 3 slides) carry their own bounded size; legacy packs keep the 1 MB text cap.
  if ((![2, 3].includes(document.schema_version) && bytes.length > 1_048_576) ||
      !validateRuntimeDocument(document, { validateSlides: validateSlideParts }).ok || document.schema_version !== row.schema_version) return integrity();
  // The version's stored art descriptor (CASE-164); anything but the exact numbers-only shape is dropped.
  // The case's current group tint (card 30): one of ten names, else neutral; the room freezes it at start.
  // The version's case (CASE-336): a start is authorized on it, and the room records it for later console mints.
  if (row.case_id != null && !isUuidV7(row.case_id)) return integrity();
  return { ok: true, document, versionNo: row.version_no, caseId: row.case_id ?? null, art: sanitizeArt(row.art), tint: tintOf(row.tint) };
}

const MEDIA_KEY = /^media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(jpg|gif|mp4)$/, POSTER_KEY = /^media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.jpg$/;
const ROOM_TYPES = new Set(['image/jpeg', 'image/gif', 'video/mp4']);
/**
 * Card 59 M3 (CASE-269): the images a slide version shows, as the room receives them. Every image block's asset must be
 * pinned by the version in this workspace; a live one (usable at once: no approval, CASE-342) comes with its size, credit
 * and storage keys, a withdrawn or rejected one as withdrawn. A version without images reads nothing.
 */
export async function readRoomMedia(rpc, actor, workspaceId, caseVersionId, document, onAlert) {
  const wanted = new Set((Array.isArray(document?.blocks) ? document.blocks : []).filter(block => block?.type === 'image').map(block => block.asset_id));
  if (!wanted.size) return { ok: true, media: null };
  const result = await rpc.call('room_media_manifest', { p_version_id: caseVersionId, p_workspace_id: workspaceId, p_user_id: actor.userId, ...adminArgs(actor) });
  if (!result?.ok) return rpcFailure('room_media_manifest', result, onAlert);
  if (!Array.isArray(result.data)) return fail('unavailable', 503);
  const media = {};
  for (const row of result.data) {
    if (!wanted.has(row?.asset_id)) continue;
    const type = row.media_type ?? 'image/jpeg', moving = type !== 'image/jpeg';
    if (['quarantined', 'approved'].includes(row.status) && ROOM_TYPES.has(type) && MEDIA_KEY.test(row.display_key ?? '') && MEDIA_KEY.test(row.phone_key ?? '') &&
        (!moving || POSTER_KEY.test(row.poster_key ?? '')) && Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height))
      media[row.asset_id] = { width: row.width, height: row.height, credit: typeof row.attribution === 'string' && row.attribution ? row.attribution : null, type,
        durationMs: type === 'video/mp4' && Number.isSafeInteger(row.duration_ms) ? row.duration_ms : null, displayKey: row.display_key, phoneKey: row.phone_key, posterKey: moving ? row.poster_key : null };
    else if (['withdrawn', 'rejected'].includes(row.status)) media[row.asset_id] = { state: 'withdrawn' };
  }
  // An image the version does not pin (or pins from another workspace) is an integrity failure, never a silent gap.
  if ([...wanted].some(id => !media[id])) { safeAlert(onAlert, { kind: 'case_version_integrity' }); return fail('case_version_integrity', 502); }
  return { ok: true, media };
}

async function compensate({ rpc, directory, room, code, sessionId, endDb, abortRoom, onAlert }) {
  // Close Directory first: no failed start can be joined while other cleanup runs.
  try { await directory.release(code, sessionId); } catch { /* continue cleanup */ }
  if (abortRoom) try { await room.abortCreate(sessionId); } catch { /* expiry alarm remains the backstop */ }
  if (endDb) {
    try {
      const result = await rpc.call('end_session', { p_session_id: sessionId, p_final_revision: 0, p_final_epoch: 0 });
      if (!result?.ok) rpcFailure('end_session', result, onAlert);
    } catch { /* an unavailable DB cannot block Directory cleanup */ }
  }
}

/**
 * The room's facilitator label, fixed at start: the console's this-session override (Julian, 2026-10-18: it never changes
 * the profile), else the confirmed profile's "Name, Role", else none (an unconfirmed placeholder is never a name).
 */
export function roomFacilitatorLabel(profile, override = null) {
  const label = override ? composeLabel(override.name, override.role)
    : profile?.labelConfirmed === true && profile.displayName && profile.role ? composeLabel(profile.displayName, profile.role) : null;
  return validLabel(label) ? label : null;
}

/** The sessions body's optional `facilitator` ({ name, role }): `{ ok, value }` (null when absent), or `{ ok: false }`. */
export function parseFacilitatorOverride(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  const fields = parseLabelFields(value);
  return fields.ok && Object.keys(value).every(key => ['name', 'role'].includes(key)) ? { ok: true, value: { name: fields.name, role: fields.role } } : { ok: false };
}

export async function startPublishedRoom({
  rpc, actor, workspaceId, caseVersionId, ttlMs, sessionId,
  directory, room, newCode, nowMs = Date.now(), onAlert, facilitatorOverride = null,
}) {
  const userId = actor.userId;
  // One read: a membership, or a live grant in this workspace, may start (CASE-336). Nobody else reaches the version.
  const member = await authorize(rpc, actor, { workspaceId, anyCase: true }, ACTIONS.startRoom, onAlert);
  if (!member.ok) return member;
  const profile = await rpc.call('ensure_profile', {
    p_user_id: userId, p_display_name: member.profile.displayName || 'Facilitator',
  });
  if (!profile?.ok) return rpcFailure('ensure_profile', profile, onAlert);
  const held = await preCheckVersionCase(rpc, actor, member, caseVersionId, ACTIONS.startRoom, onAlert);
  if (!held.ok) return held;
  const version = await readIntactVersion(rpc, actor, workspaceId, caseVersionId, onAlert);
  if (!version.ok) return version;
  // Then decided on the version's own case (invariant 6): a grant on another case of the workspace starts nothing.
  const onItsCase = onCase(member, version.caseId, ACTIONS.startRoom);
  if (!onItsCase.ok) return onItsCase;
  const roomMedia = await readRoomMedia(rpc, actor, workspaceId, caseVersionId, version.document, onAlert);
  if (!roomMedia.ok) return roomMedia;
  const expiresAtMs = nowMs + ttlMs;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    let claimed;
    try { claimed = await directory.register(code, sessionId, expiresAtMs); }
    catch {
      await compensate({ rpc, directory, room, code, sessionId, endDb: false, abortRoom: false, onAlert });
      return fail('unavailable', 503);
    }
    if (!claimed) continue;
    let inserted;
    try {
      inserted = await rpc.call('create_session', {
        p_session_id: sessionId, p_case_version_id: caseVersionId, p_workspace_id: workspaceId,
        p_facilitator_id: userId, p_join_code: code, p_ttl: `${ttlMs / 60_000} minutes`, ...adminArgs(actor),
      });
    } catch { inserted = { ok: false, kind: 'unavailable', status: 503, code: 'network' }; }
    if (!inserted?.ok) {
      await compensate({ rpc, directory, room, code, sessionId,
        endDb: inserted?.kind === 'unavailable', abortRoom: false, onAlert });
      if (inserted?.kind === 'unique' && inserted.code === '23505') continue;
      return rpcFailure('create_session', inserted, onAlert);
    }
    if (inserted.data !== sessionId) {
      await compensate({ rpc, directory, room, code, sessionId, endDb: true, abortRoom: false, onAlert });
      return fail('unavailable', 503);
    }
    // The room's feedback code, minted by SQL with the session (CASE-284), so the room can show it at End with no round
    // trip then. Before the migration is applied the read fails and the room simply has none (no QR card, no Copy link).
    let feedbackCode = null;
    try { const read = await rpc.call('session_feedback_code', { p_session_id: sessionId });
      if (read?.ok && typeof read.data?.code === 'string' && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(read.data.code)) feedbackCode = read.data.code; } catch { /* none */ }
    // The label fixed at start, kept on the session row for /F and nulled by the 24 h purge (hard rule 8). Before the
    // migration is applied the write fails and only the room carries it.
    const facilitatorLabel = roomFacilitatorLabel(member.profile, facilitatorOverride);
    if (facilitatorLabel) try { await rpc.call('set_session_facilitator_label', { p_session_id: sessionId, p_label: facilitatorLabel }); } catch { /* the room still has it */ }
    let created;
    const ownerAdminDigest = actor.admin ? await emailDigest(actor.email) : null;
    try { created = await room.create({ sessionId, joinCode: code, caseDoc: version.document,
      caseVersionNo: version.versionNo, caseVersionId, art: version.art, tint: version.tint, ownerUserId: userId, workspaceId, caseId: version.caseId, ownerAdminDigest, ttlMs, archiveSessionId: sessionId, media: roomMedia.media, feedbackCode, facilitatorLabel }); }
    catch { /* a DO may have committed before the response failed */ }
    if (!created || created.error || typeof created.facilitatorToken !== 'string' || typeof created.expiresAt !== 'string') {
      await compensate({ rpc, directory, room, code, sessionId, endDb: true, abortRoom: true, onAlert });
      return fail('unavailable', 503);
    }
    return { ok: true, sessionId, joinCode: code,
      facilitatorToken: created.facilitatorToken, expiresAt: created.expiresAt };
  }
  return fail('no_join_code', 503);
}
