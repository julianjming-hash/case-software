// Admin → Workspaces: image storage (CASE-342, plan §3 A3 and A7). One workspace's bytes in use against its quota, and
// the images nothing uses (no draft, version, candidate or checkpoint; not taken down; a day old). "Delete unused"
// removes the ones still unused at that moment, with this session's step-up (P-16 admin path, invariant 11); their
// stored files are queued for the hourly media sweep (CASE-270). Admins only; SQL checks the admin flag again.
import { isUuidV7 } from '../../shared/ids.mjs';
import { isAdminUser } from './gate.mjs';
import { verifyElevation } from './stepup.mjs';
import { withSecurityHeaders } from '../headers.mjs';

const reply = (status, body) => withSecurityHeaders(Response.json(body, { status }));
const fail = (status, error) => reply(status, { error });
const count = value => Number.isSafeInteger(value) && value >= 0;
const MEDIA = new Set(['image/jpeg', 'image/gif', 'video/mp4']);
const POLICY_KEYS = ['managers_invite', 'editors_publish', 'runners_share', 'managers_see_records'];
const policySet = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === POLICY_KEYS.length &&
  POLICY_KEYS.every(key => typeof value[key] === 'boolean');
const MAX_QUOTA = 10_000_000_000;

function unusedRow(row) {
  if (!isUuidV7(row?.assetId) || !['image', 'video'].includes(row.kind) || !MEDIA.has(row.mediaType) ||
      !(row.altText === null || typeof row.altText === 'string') || typeof row.createdAt !== 'string' || !count(row.bytes)) return null;
  return { assetId: row.assetId, kind: row.kind, mediaType: row.mediaType, altText: row.altText, createdAt: row.createdAt, bytes: row.bytes };
}

/** GET /api/v1/admin/workspaces/<id>/storage, POST …/storage/delete-unused and POST …/settings. */
export async function handleStorageRequest({ request, route, user, env, body, rpc }) {
  if (!isAdminUser(user, env)) return fail(403, 'forbidden');
  const url = new URL(request.url), workspaceId = route.pattern.exec(url.pathname)?.[1];
  if (!isUuidV7(workspaceId) || [...url.searchParams.keys()].length) return fail(400, 'bad_request');
  const who = { p_user_id: user.userId, p_workspace_id: workspaceId, p_admin: true, p_admin_email: user.email };
  if (route.key === 'workspace_settings_set') {
    // A5 (P-45): policies are JSON booleans for the four known keys (any subset); the quota is a whole byte count or null (unchanged).
    if (!body || Object.keys(body).sort().join() !== 'expectedRevision,mediaQuotaBytes,policies' || !count(body.expectedRevision) ||
        !body.policies || typeof body.policies !== 'object' || Array.isArray(body.policies) ||
        !Object.entries(body.policies).every(([key, value]) => POLICY_KEYS.includes(key) && typeof value === 'boolean') ||
        !(body.mediaQuotaBytes === null || (count(body.mediaQuotaBytes) && body.mediaQuotaBytes <= MAX_QUOTA))) return fail(400, 'bad_request');
    const set = await rpc.call('admin_set_workspace_policies', { ...who, p_expected_revision: body.expectedRevision, p_policies: body.policies, p_media_quota_bytes: body.mediaQuotaBytes });
    if (!set?.ok) {
      if (set?.code === '40001' || set?.kind === 'conflict') return fail(409, 'conflict');
      if (set?.code === '42501' || set?.kind === 'forbidden') return fail(403, 'forbidden');
      if (['22023', '22P02'].includes(set?.code) || set?.kind === 'bad_request') return fail(400, 'bad_request');
      return fail(503, 'admin_unavailable');
    }
    const v = set.data, { revision, mediaQuotaBytes, ...policies } = v ?? {};
    if (!policySet(policies) || !count(revision) || !count(mediaQuotaBytes)) return fail(503, 'manual_reconciliation_needed');
    return reply(200, { policies, revision, mediaQuotaBytes });
  }
  if (route.key === 'workspace_storage') {
    const result = await rpc.call('admin_workspace_storage', who);
    const v = result?.ok ? result.data : null;
    const unused = Array.isArray(v?.unused) && v.unused.length <= 200 ? v.unused.map(unusedRow) : null;
    if (!policySet(v?.policies) || !count(v?.policyRevision)) return fail(503, 'admin_unavailable');
    if (v?.workspaceId !== workspaceId || !count(v.usedBytes) || !count(v.quotaBytes) || !count(v.unusedBytes) || !unused || unused.includes(null))
      return fail(503, 'admin_unavailable');
    return reply(200, { workspaceId, usedBytes: v.usedBytes, quotaBytes: v.quotaBytes, unusedBytes: v.unusedBytes, policies: v.policies, policyRevision: v.policyRevision, unused });
  }
  // Delete unused: the ids the admin was shown (1–200); SQL keeps any that is used again since the listing.
  if (!body || Object.keys(body).join(',') !== 'assetIds' || !Array.isArray(body.assetIds) || body.assetIds.length < 1 ||
      body.assetIds.length > 200 || !body.assetIds.every(isUuidV7) || new Set(body.assetIds).size !== body.assetIds.length) return fail(400, 'bad_request');
  const elevation = await verifyElevation(request.headers.get('X-Admin-Elevation'), user.email, user.sessionId, env.STEPUP_SECRET);
  if (!elevation) return fail(403, 'step_up_required');
  const result = await rpc.call('admin_delete_unused_assets', { p_user_id: user.userId, p_workspace_id: workspaceId, p_asset_ids: body.assetIds,
    p_elevation_id: elevation.jti, p_admin: true, p_admin_email: user.email });
  const v = result?.ok ? result.data : null;
  if (!Array.isArray(v?.deleted) || !v.deleted.every(id => body.assetIds.includes(id)) || !count(v.queuedKeys)) return fail(503, 'admin_unavailable');
  return reply(200, { deleted: v.deleted, kept: body.assetIds.filter(id => !v.deleted.includes(id)) });
}
