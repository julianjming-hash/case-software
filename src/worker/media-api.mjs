// Builder media storage (card 59 M2, CASE-268, CASE-342). Authors (P-14) store a still's two JPEG renditions, or a GIF's
// or video's cleaned file and its JPEG poster, in the private MEDIA bucket; register it with its details; list the media
// and read a rendition's bytes for the canvas. Two places: the workspace (the deployed Builder; members see every image)
// and one case (/builder/cases/<id>/…, CASE-336: a Can edit grant uploads, and a case-only editor sees only that case's
// images). Images are usable at once: there is no approval (CASE-342); takedown stays (P-16, admins). Every request
// re-authorizes in SQL; bytes are checked structurally (shared/media*.mjs) and stored content-addressed before any row
// points at them, so the same file is one object per workspace. Nothing here serves a room (M3 does).
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { actorFor, adminArgs, authorize } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { inspectJpeg, renditionFits, assetDetails, ECG_PHONE, MEDIA_RENDITIONS, MEDIA_TYPES, MOVING_LIMITS } from '../shared/media.mjs';
import { inspectGif } from '../shared/media-gif.mjs';
import { inspectMp4 } from '../shared/media-mp4.mjs';
import { verifyElevation } from './admin/stepup.mjs';

const fail = (error, status) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const SHA = /^[0-9a-f]{64}$/;
// Each stored type: its largest upload, how long the upload may take, and its structural check.
const STORED = {
  'image/jpeg': { max: Math.max(MEDIA_RENDITIONS.display.maxBytes, ECG_PHONE.maxBytes), ms: 10_000, inspect: inspectJpeg },
  'image/gif': { max: MOVING_LIMITS['image/gif'].maxBytes, ms: 60_000, inspect: inspectGif },
  'video/mp4': { max: MOVING_LIMITS['video/mp4'].maxBytes, ms: 120_000, inspect: inspectMp4 },
};
export const mediaKey = (workspaceId, sha256, type = 'image/jpeg') => `media/${workspaceId}/${sha256}.${MEDIA_TYPES[type]}`;

/**
 * Exactly `max` bytes or fewer, within `ms`; anything longer is refused without buffering it. A body that fills its
 * declared length is returned without a further copy (red-team, Low: a 25 MB video is held once, not twice).
 */
async function readBytes(request, max, ms = 10_000) {
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > max) return { error: 'too_large' };
  if (!request.body) return { error: 'empty' };
  // Memory follows the bytes that arrive, never the declared length (re-check): the buffer starts at 1 MiB and doubles,
  // bounded by the declared length (or the cap), so a request that declares 25 MB and sends little holds little.
  const limit = length && /^\d+$/.test(length) ? Number(length) : max;
  const reader = request.body.getReader(); let into = new Uint8Array(Math.min(limit, 1024 * 1024)), bytes = 0, timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === null) { try { void reader.cancel(); } catch { /* already refused */ } return { error: 'request_timeout' }; }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || bytes + next.value.byteLength > limit) { try { void reader.cancel(); } catch { /* already refused */ } return { error: 'too_large' }; }
      if (bytes + next.value.byteLength > into.length) { const grown = new Uint8Array(Math.min(limit, Math.max(into.length * 2, bytes + next.value.byteLength))); grown.set(into.subarray(0, bytes)); into = grown; }
      into.set(next.value, bytes);
      bytes += next.value.byteLength;
    }
  } catch { return { error: 'empty' }; } finally { clearTimeout(timer); }
  if (length && bytes !== limit) return { error: 'empty' };
  return { bytes: bytes === into.length ? into : into.slice(0, bytes) };
}
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** One rendition's bytes as a response that a browser can only show as an image or play as a video. */
export function imageResponse(body, byteSize, type = 'image/jpeg') {
  return new Response(body, { status: 200, headers: { 'content-type': Object.hasOwn(MEDIA_TYPES, type) ? type : 'image/jpeg', 'content-length': String(byteSize), 'content-disposition': 'inline',
    'cache-control': 'private, no-store', 'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox" } });
}

// SQL refusals reach the Worker as codes only (rpc.mjs). Each media RPC uses them for one meaning each:
// 23514 the hourly or workspace limit, 23505 a known file that was rejected or withdrawn, 40001 (on registration) a file
// another image already names. The one refusal that carries numbers is the case place's full storage (rpc.mjs reads
// `storage_full: used N of M bytes`): it names the bytes used and allowed (CASE-342).
const NAMED = { builder_set_asset_attestation: { 40001: ['asset_details_changed', 409] }, builder_create_asset: { 23514: ['media_limit', 429], 23505: ['asset_closed', 409], 40001: ['rendition_in_use', 409] },
  builder_media_put_allowance: { 23514: ['media_limit', 429], 23505: ['asset_closed', 409] },
  builder_create_case_asset: { 23514: ['media_limit', 429], 23505: ['asset_closed', 409], 40001: ['rendition_in_use', 409] },
  builder_case_media_put_allowance: { 23514: ['media_limit', 429], 23505: ['asset_closed', 409] },
  admin_withdraw_asset: { 40001: ['asset_not_withdrawable', 409] } };
/** The full-storage refusal: 507 with the bytes used and allowed, never a guess. */
export const storageFull = (usedBytes, quotaBytes) => json({ error: 'storage_full', usedBytes, quotaBytes }, 507);
function rpcResponse(name, result, onAlert) {
  if (result?.ok) return null;
  if (result?.kind === 'storage_full') return storageFull(result.usedBytes, result.quotaBytes);
  const named = NAMED[name]?.[result?.code];
  if (named) return fail(named[0], named[1]);
  const mapped = rpcFailure(name, result, onAlert);
  return fail(mapped.error, mapped.status);
}

/**
 * Return null outside /api/v1/builder/workspaces/<id>/(media|assets) and /api/v1/builder/cases/<id>/(media|assets).
 * The image approval route (…/assets/<id>/review) is gone with approval (CASE-342): it is no route here.
 */
export async function handleMediaApi(request, { rpc, env, onAlert, verifyUser = verifyFacilitatorJwt }) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
  const inWorkspace = /^\/api\/v1\/builder\/workspaces\/([0-9a-f-]{36})\/(?:media\/(display|phone|poster)|assets(?:\/([0-9a-f-]{36})(?:\/(display|phone|poster|withdraw|attestation))?)?)$/.exec(path);
  const inCase = inWorkspace ? null : /^\/api\/v1\/builder\/cases\/([0-9a-f-]{36})\/(?:media\/(display|phone|poster)|assets(?:\/([0-9a-f-]{36})(?:\/(display|phone|poster))?)?)$/.exec(path);
  const match = inWorkspace ?? inCase;
  if (!match) return null;
  const [, placeId, uploadRendition, assetId, assetPart] = match;
  if (!isUuidV7(placeId) || (assetId && !isUuidV7(assetId))) return fail('bad_request', 400);
  const store = env.MEDIA;
  if (!rpc || typeof rpc.call !== 'function' || !store || typeof store.put !== 'function') return fail('unavailable', 503);
  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user) return fail('unauthorised', 401);
  const active = await accountActive(rpc, user.userId);
  if (active) return fail(active.error, active.status);
  const actor = actorFor(user, env), who = { p_user_id: actor.userId, ...adminArgs(actor) };
  // Every route is P-14 (author, owner, admin; on a case also a Can edit grant) except withdraw (P-16). SQL checks again.
  // On a case the workspace (and so every storage key) comes from the case row, never from the request.
  const entitled = await authorize(rpc, actor, inCase ? { caseId: placeId } : placeId, assetPart === 'withdraw' ? ACTIONS.withdrawRepublish : ACTIONS.draft, onAlert);
  if (!entitled.ok) return fail(entitled.status === 404 ? 'forbidden' : entitled.error, entitled.status === 404 ? 403 : entitled.status);
  const workspaceId = inCase ? entitled.workspaceId : placeId;
  if (!isUuidV7(workspaceId)) return fail('unavailable', 503);
  const place = inCase ? { p_case_id: placeId } : { p_workspace_id: workspaceId };
  const named = { allowance: inCase ? 'builder_case_media_put_allowance' : 'builder_media_put_allowance',
    create: inCase ? 'builder_create_case_asset' : 'builder_create_asset', list: inCase ? 'builder_list_case_assets' : 'builder_list_assets',
    rendition: inCase ? 'builder_case_asset_rendition' : 'builder_asset_rendition' };

  if (inWorkspace && assetId && assetPart === 'attestation' && method === 'POST') {
    const read = await readBytes(request, 2048, 5000);
    if (read.error) return fail(read.error, read.error === 'too_large' ? 413 : read.error === 'request_timeout' ? 408 : 400);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(read.bytes)); } catch { return fail('bad_request', 400); }
    if (!plain(body) || Object.keys(body).sort().join(',') !== 'attested,expected' || typeof body.expected !== 'boolean' || typeof body.attested !== 'boolean') return fail('bad_request', 400);
    const result = await rpc.call('builder_set_asset_attestation', { p_workspace_id: workspaceId, p_asset_id: assetId, p_expected: body.expected, p_attested: body.attested, ...who });
    return rpcResponse('builder_set_asset_attestation', result, onAlert) ?? json({ asset: result.data });
  }

  // Store one rendition. The caller is authorized (P-14) before any byte is read or written. A GIF or video is stored
  // once, as its display rendition (it also serves phones); its poster and every still rendition are JPEG.
  if (uploadRendition && method === 'PUT') {
    const type = (request.headers.get('content-type') ?? '').split(';')[0].trim(), stored = STORED[type];
    if (!stored || (type !== 'image/jpeg' && uploadRendition !== 'display')) return fail('unsupported_type', 415);
    const read = await readBytes(request, stored.max, stored.ms);
    if (read.error) return fail(read.error, read.error === 'too_large' ? 413 : read.error === 'request_timeout' ? 408 : 400);
    const sha256 = hex(await crypto.subtle.digest('SHA-256', read.bytes));
    // Allowed in SQL before the file is even parsed (red-team S1: every attempt counts against the hourly limit), and
    // before a byte is written: the workspace quota, and never a closed file again.
    const allowance = await rpc.call(named.allowance, { ...place, ...who, p_sha256: sha256, p_bytes: read.bytes.byteLength, p_type: type });
    const refused = rpcResponse(named.allowance, allowance, onAlert);
    if (refused) return refused;
    if (allowance.data !== true) return fail('unavailable', 503);
    const shape = stored.inspect(read.bytes);
    if (!shape.ok) return fail(`invalid_image:${shape.reason}`, 422);
    const size = { width: shape.width, height: shape.height, bytes: read.bytes.byteLength };
    // An ECG's phone copy may be larger; the registration step checks the rendition against the image's kind.
    if (!renditionFits(uploadRendition, size, { type }) && !(uploadRendition === 'phone' && renditionFits('phone', size, { ecg: true }))) return fail('image_too_large', 413);
    // Content-addressed: a stored key already holds these exact bytes. Writing it again would refresh its uploaded time,
    // and live rooms read a newer upload as withdrawn (red-team N1), so an object a quarantined or approved image names is
    // left untouched. One no image names (an earlier, unfinished upload) is written again, so its day-old orphan grace
    // starts over and the sweep cannot delete it before this upload is registered (N1-b); no room can hold it.
    const durationMs = type === 'video/mp4' ? Math.round(shape.seconds * 1000) : null;
    const key = mediaKey(workspaceId, sha256, type), existing = await store.head(key);
    let inUse = false;
    if (existing) {
      const known = await rpc.call('media_known_keys', { p_keys: [key] });
      if (!known?.ok || !Array.isArray(known.data)) return fail('unavailable', 503);
      inUse = known.data.some(row => row?.r2_key === key);
    }
    if (!inUse) await store.put(key, read.bytes, { sha256, httpMetadata: { contentType: type },
      customMetadata: { width: String(shape.width), height: String(shape.height), ...(durationMs === null ? {} : { duration_ms: String(durationMs) }) } });
    return json({ sha256, bytes: size.bytes, width: shape.width, height: shape.height, type, ...(durationMs === null ? {} : { durationMs }) }, inUse ? 200 : 201);
  }

  // Register stored media with the author's rights details. A still names its display and phone JPEGs; a GIF or video
  // names its file (as display and phone, one object) and its JPEG poster. Sizes come from the stored objects only.
  if (!assetId && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail('bad_request', 400); }
    const keys = plain(body) ? Object.keys(body).sort().join(',') : '';
    if ((keys !== 'details,display,phone' && keys !== 'details,display,phone,poster') || !plain(body.display) || !plain(body.phone) ||
        !SHA.test(body.display.sha256 ?? '') || !SHA.test(body.phone.sha256 ?? '')) return fail('bad_request', 400);
    const type = body.display.type ?? 'image/jpeg', moving = type === 'image/gif' || type === 'video/mp4';
    if (!Object.hasOwn(STORED, type) || (moving && (body.phone.sha256 !== body.display.sha256 || !plain(body.poster) || !SHA.test(body.poster.sha256 ?? ''))) ||
        (!moving && body.poster !== undefined)) return fail('bad_request', 400);
    const details = assetDetails(body.details, { relaxed: inCase !== null });
    if (!details.ok) return fail(`invalid_details:${details.field}`, 422);
    // On a case the uploader confirms the image is de-identified and that they may use it (CASE-342): one required tick.
    if (inCase && details.value.attested !== true) return fail('invalid_details:attested', 422);
    const stored = {};
    for (const rendition of moving ? ['display', 'phone', 'poster'] : ['display', 'phone']) {
      const renditionType = rendition === 'poster' || !moving ? 'image/jpeg' : type;
      const head = await store.head(mediaKey(workspaceId, body[rendition].sha256, renditionType));
      const width = Number(head?.customMetadata?.width), height = Number(head?.customMetadata?.height);
      if (!head || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return fail('rendition_missing', 409);
      if (!renditionFits(rendition, { width, height, bytes: head.size }, { ecg: details.value.evidenceKind === 'ecg', type: renditionType })) return fail('image_too_large', 413);
      stored[rendition] = { sha256: body[rendition].sha256, bytes: head.size, width, height, type: renditionType };
      if (rendition === 'display' && type === 'video/mp4') {
        stored.durationMs = Number(head.customMetadata.duration_ms);
        if (!Number.isSafeInteger(stored.durationMs)) return fail('rendition_missing', 409);
      }
    }
    const value = details.value;
    const result = await rpc.call(named.create, { ...place, ...who, p_display: stored.display, p_phone: stored.phone,
      p_details: { alt_text: value.alt, evidence_kind: value.evidenceKind, rights_basis: value.rightsBasis, licence: value.licence, creator: value.creator,
        attribution: value.attribution, rights_note: value.rightsNote, source_url: value.sourceUrl, attested: value.attested,
        ...(type === 'video/mp4' ? { duration_ms: stored.durationMs } : {}) }, p_poster: stored.poster ?? null });
    const refused = rpcResponse(named.create, result, onAlert);
    if (refused) return refused;
    return plain(result.data) && isUuidV7(result.data.asset_id) ? json({ asset: result.data, warnings: details.warnings }, result.data.created ? 201 : 200) : fail('unavailable', 503);
  }

  if (!assetId && method === 'GET') {
    const result = await rpc.call(named.list, { ...place, ...who, p_ids: null });
    return rpcResponse(named.list, result, onAlert) ?? (Array.isArray(result.data) ? json({ assets: result.data }) : fail('unavailable', 503));
  }

  // A rendition's bytes for the Builder canvas and the asset library.
  if (assetId && (assetPart === 'display' || assetPart === 'phone' || assetPart === 'poster') && method === 'GET') {
    const result = await rpc.call(named.rendition, { ...place, p_asset_id: assetId, p_rendition: assetPart, ...who });
    const refused = rpcResponse(named.rendition, result, onAlert);
    if (refused) return refused;
    const row = Array.isArray(result.data) ? result.data[0] : null;
    if (!row) return fail('not_found', 404);
    if (!['quarantined', 'approved'].includes(row.status) || typeof row.r2_key !== 'string') return fail('withdrawn', 410);
    const object = await store.get(row.r2_key);
    if (!object) return fail('not_found', 404);
    return imageResponse(object.body, object.size, row.content_type ?? 'image/jpeg');
  }

  // Card 59 M4 (J8): a configured admin takes an image down with this session's step-up. Its bytes are deleted now;
  // the hourly sweep deletes any that remain. Rooms holding the image then answer 410.
  if (inWorkspace && assetId && assetPart === 'withdraw' && method === 'POST') {
    if (!actor.admin) return fail('forbidden', 403);
    const elevation = await verifyElevation(request.headers.get('X-Admin-Elevation'), actor.email, user.sessionId, env.STEPUP_SECRET);
    if (!elevation) return fail('step_up_required', 403);
    let body;
    try { body = await request.json(); } catch { return fail('bad_request', 400); }
    if (!plain(body) || Object.keys(body).join(',') !== 'reason' || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) return fail('bad_request', 400);
    const result = await rpc.call('admin_withdraw_asset', { p_workspace_id: workspaceId, p_asset_id: assetId, p_reason: body.reason.trim(), ...who, p_elevation_id: elevation.jti });
    const refused = rpcResponse('admin_withdraw_asset', result, onAlert);
    if (refused) return refused;
    const keys = (Array.isArray(result.data) ? result.data : []).map(row => row?.r2_key).filter(key => typeof key === 'string' && MEDIA_KEY.test(key));
    // Re-checked just before deleting (red-team S5): a file a quarantined or approved image names now is kept.
    if (keys.length) {
      const named = await rpc.call('media_known_keys', { p_keys: keys });
      const live = named?.ok && Array.isArray(named.data) ? new Set(named.data.map(row => row?.r2_key)) : null;
      // An unavailable lookup deletes nothing now; the queue still holds the keys for the hourly sweep.
      if (live) { const gone = keys.filter(key => !live.has(key)); if (gone.length) await store.delete(gone); }
    }
    return json({ assetId, status: 'withdrawn' });
  }
  return fail('method_not_allowed', 405);
}

const MEDIA_KEY = /^media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(jpg|gif|mp4)$/;
/**
 * The hourly retention sweep (card 59 M4): delete the bytes SQL has queued (withdrawn, rejected, or removed by Delete
 * unused, CASE-342), then walk the stored objects from where the last run stopped (red-team B2), at most `pages` pages, deleting any a
 * day old that no live image names (never registered, or a closed image's file stored again). The position is kept
 * in SQL; a walk that reaches the end starts again at the beginning next time. Answers counts only.
 */
export async function runMediaSweep({ env, rpc, now = Date.now(), pages = 10, pageSize = 500 }) {
  const store = env.MEDIA;
  if (!store || !rpc?.call) return { ok: false };
  const claimed = await rpc.call('media_purge_claim', { p_limit: 100 });
  if (!claimed?.ok || !Array.isArray(claimed.data)) return { ok: false };
  const keys = claimed.data.map(row => row?.r2_key).filter(key => typeof key === 'string' && MEDIA_KEY.test(key));
  let kept = 0;
  if (keys.length) {
    // The same bytes may have been registered again since the lease (re-check): a key a quarantined or approved image now
    // names is kept; its queue entry is still completed, and a later closure queues it afresh.
    const named = await rpc.call('media_known_keys', { p_keys: keys });
    if (!named?.ok || !Array.isArray(named.data)) return { ok: false };
    const live = new Set(named.data.map(row => row?.r2_key)), gone = keys.filter(key => !live.has(key));
    kept = keys.length - gone.length;
    if (gone.length) await store.delete(gone);
    const done = await rpc.call('media_purge_complete', { p_keys: keys });
    if (!done?.ok) return { ok: false };
  }
  const position = await rpc.call('media_sweep_position', { p_start_after: null });
  if (!position?.ok || !Array.isArray(position.data)) return { ok: false };
  let startAfter = typeof position.data[0]?.resume_after === 'string' ? position.data[0].resume_after : '', orphans = 0, walked = 0;
  for (let page = 0; page < pages; page++) {
    const listed = await store.list({ prefix: 'media/', limit: pageSize, ...(startAfter ? { startAfter } : {}) });
    const objects = listed?.objects ?? [];
    walked += objects.length;
    const old = objects.filter(object => MEDIA_KEY.test(object.key) && object.uploaded && now - new Date(object.uploaded).getTime() > 86_400_000).map(object => object.key);
    if (old.length) {
      const known = await rpc.call('media_known_keys', { p_keys: old });
      if (!known?.ok || !Array.isArray(known.data)) return { ok: false };
      const named = new Set(known.data.map(row => row?.r2_key));
      const unnamed = old.filter(key => !named.has(key));
      if (unnamed.length) { await store.delete(unnamed); orphans += unnamed.length; }
    }
    if (!listed?.truncated || !objects.length) { startAfter = ''; break; }
    startAfter = objects.at(-1).key;
  }
  const saved = await rpc.call('media_sweep_position', { p_start_after: startAfter });
  if (!saved?.ok) return { ok: false };
  return { ok: true, deleted: keys.length - kept, orphans, walked };
}
