// Administration -> People: what each listed account holds, beside its admin state (facilitator-UX A5). A workspace
// role per membership and a Can run / Can edit grant per case, read by admin_read_access (a deployment read behind the
// admin gate). Unreadable access is null ("not known"), never an empty list ("holds nothing").
import { isUuidV7 } from '../../shared/ids.mjs';

const name = value => typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

/** Access for a page of accounts: Map(id → {memberships, grants}), or null when it cannot be read as a whole. */
export async function readAccess(rpc, ids) {
  let read;
  try { read = await rpc.call('admin_read_access', { p_user_ids: ids }); } catch { return null; }
  if (!read?.ok || !Array.isArray(read.data) || read.data.length > 5000) return null;
  const out = new Map(ids.map(id => [id, { memberships: [], grants: [] }]));
  for (const row of read.data) {
    const held = out.get(row?.userId);
    if (!held || !isUuidV7(row.workspaceId) || !name(row.workspaceName)) return null;
    if (row.kind === 'member' && ['owner', 'author', 'facilitator'].includes(row.role) && row.caseId === null)
      held.memberships.push({ workspaceId: row.workspaceId, workspaceName: row.workspaceName, role: row.role });
    else if (row.kind === 'grant' && ['run', 'edit'].includes(row.role) && isUuidV7(row.caseId) && name(row.caseTitle))
      held.grants.push({ caseId: row.caseId, caseTitle: row.caseTitle, workspaceId: row.workspaceId, workspaceName: row.workspaceName, level: row.role });
    else return null;
  }
  return out;
}
