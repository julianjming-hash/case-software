// Bounded private workbench schemas; no account authority is inferred from these values.
import { isUuid, isUuidV7 } from './ids.mjs';
import { isTint } from './tints.mjs';
export const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const text = (v, max=320) => typeof v === 'string' && v.length>0 && v.length<=max && !/[\u0000-\u001f\u007f]/.test(v);
const email = v => text(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const date = v => text(v,40) && Number.isFinite(Date.parse(v));
const nil = (v, check) => v===null || check(v);
const rev = v => Number.isSafeInteger(v) && v>=0 && v<9999999999;
export const workspaceRow = v => exact(v,['id','name','membership_revision']) && isUuidV7(v.id) && text(v.name,120) && rev(v.membership_revision);
const snapshots = v => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>k==='role'?nil(v[k],x=>['owner','author','facilitator'].includes(x)):k==='transferFrom'&&nil(v[k],isUuid));
const operationSnapshot = v => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>['status','email','admin_revision','version_no'].includes(k)&& (['admin_revision','version_no'].includes(k)?rev(v[k]):text(v[k])));
export function workbenchRow(tab,v) {
 if(tab==='members')return exact(v,['id','email','role','created_at','account_state'])&&isUuid(v.id)&&email(v.email)&&['owner','author','facilitator'].includes(v.role)&&date(v.created_at)&&['active','disabled','deleted'].includes(v.account_state);
 if(tab==='cases')return exact(v,['id','case_id','version_no','title','status','admin_revision','group_id','group_name','tint','group_revision'])&&isUuidV7(v.id)&&isUuidV7(v.case_id)&&Number.isSafeInteger(v.version_no)&&v.version_no>0&&text(v.title,200)&&['published','withdrawn'].includes(v.status)&&rev(v.admin_revision)&&rev(v.group_revision)&&isTint(v.tint)&&(v.group_id===null?v.group_name===null&&v.tint==='neutral':isUuidV7(v.group_id)&&text(v.group_name,60));
 if(tab==='rooms')return exact(v,['id','case_version_id','title','version_no','status','created_at','started_at','ended_at','expires_at','own'])&&isUuidV7(v.id)&&isUuidV7(v.case_version_id)&&text(v.title,200)&&Number.isSafeInteger(v.version_no)&&v.version_no>0&&['lobby','live','ended','expired'].includes(v.status)&&date(v.created_at)&&date(v.expires_at)&&nil(v.started_at,date)&&nil(v.ended_at,date)&&typeof v.own==='boolean';
 if(tab==='audit')return exact(v,['id','action','actor_kind','actor_email','target_type','target_id','revision','at','before_state','after_state'])&&isUuidV7(v.id)&&text(v.action,80)&&['admin','owner','author','facilitator','system'].includes(v.actor_kind)&&nil(v.actor_email,email)&&text(v.target_type,40)&&isUuid(v.target_id)&&nil(v.revision,rev)&&date(v.at)&&snapshots(v.before_state)&&snapshots(v.after_state);
 if(tab==='operations')return exact(v,['id','action','actor_email','target_type','target_id','at','before','after','phase','outcome_id','outcome_at'])&&isUuidV7(v.id)&&text(v.action,80)&&email(v.actor_email)&&text(v.target_type,40)&&nil(v.target_id,isUuid)&&date(v.at)&&operationSnapshot(v.before)&&nil(v.after,operationSnapshot)&&['attempt','unresolved','outcome'].includes(v.phase)&&nil(v.outcome_id,isUuidV7)&&nil(v.outcome_at,date)&&(v.phase==='outcome'?v.outcome_id!==null&&v.outcome_at!==null:v.outcome_id===null&&v.outcome_at===null);
 return false;
}
export function workbenchPage(tab,v) {
 const global=tab==='operations';
 if(!exact(v,global?['rows','nextAfter']:['workspace','rows','nextAfter'])||(!global&&!workspaceRow(v.workspace))||!Array.isArray(v.rows)||v.rows.length>20||!v.rows.every(r=>workbenchRow(tab,r))||new Set(v.rows.map(r=>r.id)).size!==v.rows.length||!nil(v.nextAfter,tab==='members'?isUuid:isUuidV7)||v.nextAfter!==null&&v.nextAfter!==v.rows.at(-1)?.id)return null;
 for(let i=1;i<v.rows.length;i++)if(v.rows[i].id>=v.rows[i-1].id)return null;
 return v;
}
export function workspacePage(v) {
 if(!exact(v,['workspaces','nextAfter'])||!Array.isArray(v.workspaces)||v.workspaces.length>50||!v.workspaces.every(workspaceRow)||!nil(v.nextAfter,isUuidV7)||v.nextAfter!==null&&v.nextAfter!==v.workspaces.at(-1)?.id)return null;
 for(let i=1;i<v.workspaces.length;i++)if(v.workspaces[i].id<=v.workspaces[i-1].id)return null;
 return v;
}
// Card 68 (SURFACE-01, SURFACE-02): presentation only. The recorded keys, ids and snapshots are unchanged; the detail keeps the raw key.
const AUDIT={workspace_rename:'Workspace renamed',case_workspace_share:'Case shared with a workspace',case_workspace_revoke:'Workspace case access revoked',case_workspace_move:'Case home workspace changed',workspace_create:'Workspace created',case_create:'Case created',draft_save:'Draft saved',version_publish:'Version published',version_withdraw:'Version withdrawn',version_republish:'Version republished',room_start:'Room started',workspace_ownerless:'Workspace left without an owner',
 member_invite:'Member invited',owner_assign:'Owner assigned',group_create:'Group created',group_edit:'Group edited',group_archive:'Group archived',case_group:'Case group changed',
 draft_checkpoint_create:'Draft checkpoint created',draft_checkpoint_delete:'Draft checkpoint deleted',draft_checkpoint_restore:'Draft checkpoint restored',
 builder_candidate_submit:'Submission sent for approval',builder_candidate_cancel:'Submission cancelled',builder_candidate_approve:'Submission approved',builder_candidate_delete:'Submission deleted',
 member_role:'Member role changed',case_archive:'Case archived',case_grant:'Case access granted',case_grant_revoke:'Case share ended',invitation_create:'Invitation created',invitation_resend:'Invitation resent',invitation_revoke:'Invitation revoked',invitation_accept:'Invitation accepted',policy_set:'Policies changed',quota_set:'Image quota changed',asset_delete_unused:'Unused image deleted',facilitator_label_edit:'Name and role corrected',member_remove:'Member removed',owner_transfer:'Ownership transferred',asset_approve:'Image approved',asset_reject:'Image rejected',asset_withdraw:'Image withdrawn',
 stepup_start:'Verification code requested',stepup_verify:'Verification code checked',facilitator_invite:'Facilitator invited',facilitator_resend:'Invitation resent',facilitator_disable:'Facilitator disabled',facilitator_enable:'Facilitator enabled',
 facilitator_soft_delete:'Facilitator soft-deleted',facilitator_restore:'Facilitator restored',facilitator_hard_delete:'Facilitator permanently deleted',case_publish:'Case version republished',room_end:'Room ended'};
const TARGET={invitation:'Invitation',grant:'Case share',workspace:'Workspace',case:'Case',version:'Case version',room:'Room',member:'Member',group:'Group',checkpoint:'Draft checkpoint',candidate:'Submission',asset:'Image',admin:'Administrator',facilitator:'Facilitator account'};
const sentence=key=>{const words=String(key).replaceAll('_',' ').trim();return words.charAt(0).toUpperCase()+words.slice(1);};
export const auditLabel=action=>AUDIT[action]??sentence(action);
export const auditTarget=(type,id)=>{const kind=TARGET[type]??sentence(type);return typeof id==='string'&&id.length>=8?`${kind} …${id.slice(-8)}`:kind;};
const SNAPSHOT={role:'Role',transferFrom:'Transferred from',status:'Status',email:'Email',admin_revision:'Admin revision',version_no:'Version'};
export const snapshotEntries=snapshot=>snapshot&&typeof snapshot==='object'?Object.entries(snapshot).map(([key,value])=>[SNAPSHOT[key]??sentence(key),value]):[];
// Facilitator-UX A5 (Administration -> Activity): each audit row read as a sentence, "who did what", for both audits.
// The actor is the admin's email when one is recorded, otherwise their kind. Keys the table does not know read as their own words.
const DID={workspace_rename:'renamed a workspace',case_workspace_share:'shared a case with a workspace',case_workspace_revoke:'revoked workspace access to a case',case_workspace_move:'moved a case’s home workspace',workspace_create:'created a workspace',case_create:'created a case',draft_save:'saved a draft',version_publish:'published a version',version_withdraw:'withdrew a version',version_republish:'republished a version',
 room_start:'started a room',workspace_ownerless:'found a workspace without an owner',member_invite:'invited a member',owner_assign:'made someone an owner',group_create:'created a group',group_edit:'edited a group',
 group_archive:'archived a group',case_group:'moved a case to another group',draft_checkpoint_create:'saved a draft checkpoint',draft_checkpoint_delete:'deleted a draft checkpoint',draft_checkpoint_restore:'restored a draft checkpoint',
 builder_candidate_submit:'sent a case for approval',builder_candidate_cancel:'cancelled a submission',builder_candidate_approve:'approved a submission',builder_candidate_delete:'deleted a submission',
 member_role:'changed a member’s role',member_remove:'removed a member',owner_transfer:'transferred ownership',asset_approve:'approved an image',asset_reject:'rejected an image',asset_withdraw:'withdrew an image',
 case_archive:'archived a case',case_grant:'gave someone access to a case',case_grant_revoke:'ended a case share',invitation_create:'invited someone',invitation_resend:'sent an invitation again',
 invitation_revoke:'revoked an invitation',invitation_accept:'accepted an invitation',policy_set:'changed the workspace policies',quota_set:'changed the image storage quota',asset_delete_unused:'deleted an unused image',
 stepup_start:'asked for a verification code',stepup_verify:'entered a verification code',facilitator_invite:'invited an account',facilitator_resend:'sent an account invitation again',facilitator_disable:'disabled an account',
 facilitator_enable:'enabled an account',facilitator_soft_delete:'soft-deleted an account',facilitator_restore:'restored an account',facilitator_hard_delete:'permanently deleted an account',
 facilitator_label_edit:'corrected an account’s name and role',case_publish:'republished a case version',room_end:'ended a room'};
const KIND={owner:'An owner',author:'An author',facilitator:'A facilitator',system:'The system',admin:'An administrator'};
export function activitySentence(row){
 const who=row.actor_email??KIND[row.actor_kind]??'Someone';
 const did=DID[row.action]??String(row.action).replaceAll('_',' ').trim();
 return `${who} ${did}${row.phase==='unresolved'?' (outcome not yet recorded)':''}`;
}
