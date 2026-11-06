import {isUuid,isUuidV7,normalizeCode} from '../shared/ids.mjs';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const text=(v,max=320)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const email=v=>text(v)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const nullable=(v,check)=>v===null||check(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0&&v<=9999999999;
const profile=v=>exact(v,['user_id','disabled_at','soft_deleted_at','delete_due_at','admin_revision'])&&isUuid(v.user_id)&&['disabled_at','soft_deleted_at','delete_due_at'].every(k=>nullable(v[k],date))&&revision(v.admin_revision);
const cursor=(v,room=false)=>nullable(v,x=>room?typeof x==='string'&&/^[0-9A-HJKMNP-TV-Z](?::[0-9A-HJKMNP-TV-Z]{6})?$/.test(x)&&(!x.includes(':')||x[0]===x[2]):isUuidV7(x));
const array=(rows,max,check,id)=>Array.isArray(rows)&&rows.length<=max&&rows.every(check)&&new Set(rows.map(r=>r[id])).size===rows.length;
const label=v=>exact(v,['name','role','confirmed'])&&nullable(v.name,x=>text(x,80))&&nullable(v.role,x=>text(x,80))&&typeof v.confirmed==='boolean';
const membership=v=>exact(v,['workspaceId','workspaceName','role'])&&isUuidV7(v.workspaceId)&&text(v.workspaceName,200)&&['owner','author','facilitator'].includes(v.role);
const grant=v=>exact(v,['caseId','caseTitle','workspaceId','workspaceName','level'])&&isUuidV7(v.caseId)&&text(v.caseTitle,200)&&isUuidV7(v.workspaceId)&&text(v.workspaceName,200)&&['run','edit'].includes(v.level);
const access=v=>exact(v,['memberships','grants'])&&Array.isArray(v.memberships)&&v.memberships.length<=200&&v.memberships.every(membership)&&Array.isArray(v.grants)&&v.grants.length<=500&&v.grants.every(grant);
const user=v=>exact(v,['id','email','invitedAt','confirmedAt','bannedUntil','createdAt','profile','label','access'])&&nullable(v.label,label)&&nullable(v.access,access)&&isUuid(v.id)&&email(v.email)&&nullable(v.createdAt,date)&&['invitedAt','confirmedAt','bannedUntil'].every(k=>nullable(v[k],date))&&nullable(v.profile,p=>profile(p)&&p.user_id===v.id);
const room=v=>exact(v,['code','sessionId','registeredAt','expiresAt','ownerEmail','phase','participantCount'])&&normalizeCode(v.code,6)===v.code&&isUuidV7(v.sessionId)&&nullable(v.registeredAt,date)&&date(v.expiresAt)&&nullable(v.ownerEmail,email)&&['lobby','surface_live','responses_open','responses_locked','path_selected','consequence_revealed','terminal_teaching','discussion_paused','ended'].includes(v.phase)&&Number.isInteger(v.participantCount)&&v.participantCount>=0&&v.participantCount<=300;
export function acceptAdminResponse(operation,value){
 let valid=false;
 if(['facilitators_list','facilitators_search'].includes(operation))valid=exact(value,['users','nextPage'])&&array(value.users,1000,user,'id')&&nullable(value.nextPage,x=>Number.isSafeInteger(x)&&x>=1&&x<=100000);
 else if(operation==='rooms_list')valid=exact(value,['rooms','nextCursor'])&&array(value.rooms,100,room,'sessionId')&&cursor(value.nextCursor,true);
 else if(operation==='stepup_start')valid=exact(value,['accepted'])&&value.accepted===true;
 else if(operation==='stepup_verify')valid=exact(value,['elevation'])&&text(value.elevation,2048);
 else if(operation==='facilitators_label')valid=exact(value,['label'])&&exact(value.label,['userId','adminRevision','name','role','confirmed'])&&isUuid(value.label.userId)&&revision(value.label.adminRevision)&&label({name:value.label.name,role:value.label.role,confirmed:value.label.confirmed});
 else if(operation.startsWith('facilitators_'))valid=exact(value,['profile'])&&profile(value.profile);
 else if(['cases_publish','versions_withdraw'].includes(operation))valid=exact(value,['version'])&&exact(value.version,['version_id','status','admin_revision'])&&isUuidV7(value.version.version_id)&&['published','withdrawn'].includes(value.version.status)&&revision(value.version.admin_revision);
 else if(operation==='rooms_end')valid=exact(value,['ended'])&&value.ended===true;
 return valid?value:null;
}
