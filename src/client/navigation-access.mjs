import {bindIssueIdentity} from './issue-auth-binding.mjs';
// Discovery from the verified /me response only. The Worker still authorises every operation.
export const accessName = role => ({owner:'Can manage',author:'Can edit',facilitator:'Can run',admin:'Admin',edit:'Can edit',run:'Can run'})[role] ?? 'Case access';
export const canEditCases = me => me?.account?.administration === true ||
 (Array.isArray(me?.memberships) && me.memberships.some(row=>['admin','owner','author'].includes(row?.role))) ||
 (Array.isArray(me?.grants) && me.grants.some(row=>row?.level==='edit'));
export const canCreateInWorkspace = (memberships,workspaceId) => Array.isArray(memberships) && memberships.some(row=>row?.workspace_id===workspaceId && ['admin','owner','author'].includes(row.role));
export const menuIdentity = (me,signOut) => bindIssueIdentity({email:me?.account?.email,administration:me?.account?.administration===true,builder:canEditCases(me),signOut},me);
