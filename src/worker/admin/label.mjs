// P-41: an admin corrects another account's facilitator Name & role (Julian, 2026-10-18): a fresh step-up, CAS on the
// account's admin_revision, and an admin_audit_log intent and outcome that record the revision only, never the words
// (CASE-075). The facilitator list carries each account's Name & role beside its admin state.
import { isUuid } from '../../shared/ids.mjs';
import { parseLabelFields } from '../../shared/facilitator-label.mjs';
import { isAdminUser, adminAuditPrefix } from './gate.mjs';
import { verifyElevation } from './stepup.mjs';
import { runAuditedAction } from './actions.mjs';
import { adminProfileMetadata } from './profiles.mjs';
import { withSecurityHeaders } from '../headers.mjs';

const response = (status, body) => withSecurityHeaders(Response.json(body, { status }));
const failure = (status, error) => response(status, { error });
const unavailable = () => failure(503, 'admin_unavailable');
const text = (value, max) => value === null || (typeof value === 'string' && value.length >= 1 && [...value].length <= max);
const when = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

/** One admin_read_facilitator_labels row as the client sees it, or undefined when it is malformed. */
export function labelOf(row) {
  if (!row || !text(row.display_name, 80) || !text(row.facilitator_role, 80) || !when(row.label_confirmed_at)) return undefined;
  return { name: row.display_name, role: row.facilitator_role, confirmed: row.label_confirmed_at !== null };
}

/** Name & role for a page of accounts: Map(id → label). Unavailable (the migration not applied yet) gives an empty map. */
export async function readLabels(rpc, ids) {
  const read = await rpc.call('admin_read_facilitator_labels', { p_user_ids: ids });
  const labels = new Map();
  if (!read?.ok || !Array.isArray(read.data)) return labels;
  for (const row of read.data) {
    const label = labelOf(row);
    if (!ids.includes(row?.user_id) || labels.has(row.user_id) || !label) return new Map();
    labels.set(row.user_id, label);
  }
  return labels;
}

export async function handleLabelEdit({ request, route, user, env, body, rpc }) {
  if (!isAdminUser(user, env)) return failure(403, 'forbidden');
  if (!body || Object.keys(body).some(key => !['expectedRevision', 'name', 'role'].includes(key)) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision > 9999999997)
    return failure(400, 'bad_request');
  const fields = parseLabelFields(body);
  if (!fields.ok) return failure(400, 'bad_request');
  const targetId = route.pattern.exec(new URL(request.url).pathname)?.[1];
  if (!isUuid(targetId)) return failure(400, 'bad_request');
  if (!rpc?.call) return unavailable();
  // This admin's elevation for this sign-in session (card 35, R-a); checked again inside the write.
  const elevated = async () => Boolean(await verifyElevation(request.headers.get('X-Admin-Elevation'), user.email, user.sessionId, env.STEPUP_SECRET));
  if (!await elevated()) return failure(403, 'forbidden');
  const read = await rpc.call('admin_read_profiles', { p_user_ids: [targetId] });
  if (!read?.ok || !Array.isArray(read.data) || read.data.length > 1) return unavailable();
  if (!read.data.length) return failure(404, 'not_found');
  const state = adminProfileMetadata(read.data[0], targetId);
  if (!state) return unavailable();
  if (state.admin_revision !== body.expectedRevision || state.soft_deleted_at !== null) return failure(409, 'conflict');
  const before = (await readLabels(rpc, [targetId])).get(targetId) ?? null;
  const set = (revision, name, role) => rpc.call('admin_set_facilitator_label', { p_user_id: targetId, p_expected_revision: revision,
    p_name: name, p_role: role, p_admin: true, p_admin_email: user.email });
  const written = (result, revision) => result?.ok && Array.isArray(result.data) && result.data.length === 1 &&
    result.data[0]?.user_id === targetId && result.data[0].admin_revision === revision + 1 && labelOf(result.data[0]) ? result.data[0] : null;
  const result = await runAuditedAction({ rpc, action: 'facilitator_label_edit', targetType: 'facilitator', targetId,
    actorEmail: user.email, fromPrefix: adminAuditPrefix(request.headers.get('CF-Connecting-IP')),
    before: { admin_revision: state.admin_revision },
    write: async () => {
      if (!await elevated()) return { ok: false, status: 403 };
      const change = await set(state.admin_revision, fields.name, fields.role);
      if (!change?.ok) return { ok: false, status: change?.kind === 'conflict' || ['23514', '40001'].includes(change?.code) ? 409 : 503 };
      const row = written(change, state.admin_revision);
      if (!row) throw new Error('label_write_outcome_unknown');
      return row;
    },
    after: row => ({ admin_revision: row.admin_revision }),
    // Undo only to a complete earlier Name & role; a placeholder account with no role needs the operator.
    revert: async row => before?.name && before?.role
      ? { ok: Boolean(written(await set(row.admin_revision, before.name, before.role), row.admin_revision)) } : { ok: false },
  });
  if (!result.ok) return failure(result.status, result.error);
  const row = result.result;
  return response(200, { label: { userId: targetId, adminRevision: row.admin_revision, ...labelOf(row) } });
}
