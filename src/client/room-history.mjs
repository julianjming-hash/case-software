// Summary-only account history; no room capability or private case pack is fetched here.
import { enhanceSelect } from './accessible-select.mjs';
import { node, accountRequest } from './auth-ui.mjs';
import { cleanText } from '../shared/text.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { sessionUrl } from '../shared/urls.mjs';
const keys=new Set(['sessionId','caseVersionId','title','versionNo','status','createdAt','startedAt','endedAt','expiresAt','archiveState','own']);
const timestamp=(value,nullable=false)=>nullable&&value===null||typeof value==='string'&&Number.isFinite(Date.parse(value));
export function historyPage(value) {
 if(!value||Object.keys(value).some(key=>!['rooms','nextAfter'].includes(key))||!Array.isArray(value.rooms)||value.rooms.length>20||
  value.nextAfter!==null&&(typeof value.nextAfter!=='string'||!value.nextAfter||value.nextAfter.length>512||! /^[A-Za-z0-9_-]+$/.test(value.nextAfter)))throw new Error('invalid_history');
 const seen=new Set();
 for(const row of value.rooms){
  if(!row||Object.keys(row).some(key=>!keys.has(key))||!isUuidV7(row.sessionId)||!isUuidV7(row.caseVersionId)||seen.has(row.sessionId)||
   typeof row.title!=='string'||!row.title.trim()||row.title.length>200||!Number.isSafeInteger(row.versionNo)||row.versionNo<1||
   !['lobby','live','ended','expired'].includes(row.status)||!['pending','complete'].includes(row.archiveState)||typeof row.own!=='boolean'||
   !timestamp(row.createdAt)||!timestamp(row.startedAt,true)||!timestamp(row.endedAt,true)||!timestamp(row.expiresAt))throw new Error('invalid_history');
  seen.add(row.sessionId);
 }
 if(value.nextAfter!==null&&!value.rooms.length)throw new Error('invalid_history');
 return value;
}
export function mountRoomHistory(host,{auth,memberships=[],current=()=>true}={}){
 let generation=0,closed=false,after=null,seen=new Set();
 const heading=node('h1','Sessions','case-catalog-heading'),workspace=node('select'),filter=node('select');
 workspace.setAttribute('aria-label','Workspace');filter.setAttribute('aria-label','Session status');
 for(const membership of memberships){const option=node('option',cleanText(membership.name??membership.workspaceName??'Workspace',200));option.value=membership.workspace_id;workspace.append(option);}
 for(const [value,label] of [['all','Running and ended'],['running','Running rooms'],['ended','Ended rooms']]){const option=node('option',label);option.value=value;filter.append(option);}
 const controls=node('div',null,'history-filters'),workspaceLabel=node('label','Workspace'),filterLabel=node('label','Session status');workspaceLabel.append(workspace);filterLabel.append(filter);controls.append(workspaceLabel,filterLabel);
 const status=node('p','', 'case-catalog-status');status.setAttribute('role','status');
 const list=node('ol',null,'history-rooms'),more=node('button','More sessions','btn'),retry=node('button','Retry sessions','btn');more.type=retry.type='button';more.hidden=retry.hidden=true;
 host.replaceChildren(heading,controls,status,list,more,retry);
 const workspaceSelect=enhanceSelect(workspace),filterSelect=enhanceSelect(filter);
 const alive=version=>!closed&&version===generation&&current();
 async function load(reset){
  const version=++generation;more.disabled=retry.disabled=true;retry.hidden=true;
  if(reset){after=null;seen=new Set();list.replaceChildren();}
  if(!workspace.value){status.textContent='No workspaces are assigned to this account.';more.hidden=true;return;}
  status.textContent='Loading sessions…';workspace.disabled=filter.disabled=true;
  try{
   const raw=await accountRequest(auth,['workspaces',workspace.value,'history'],{query:new URLSearchParams({limit:'20',filter:filter.value,...(after?{after}:{})})});
   if(!alive(version))return;const page=historyPage(raw);
   if(page.rooms.some(row=>seen.has(row.sessionId)))throw new Error('repeated_history');
   for(const row of page.rooms){
    seen.add(row.sessionId);const item=node('li',null,'history-room');item.append(node('h2',cleanText(row.title,200)),node('p',`Version ${row.versionNo} · ${row.status==='live'?'Running':row.status==='lobby'?'Lobby':row.status==='expired'?'Expired':'Ended'}`));
    const time=node('time',new Date(row.endedAt??row.startedAt??row.createdAt).toLocaleString());time.dateTime=row.endedAt??row.startedAt??row.createdAt;item.append(time);
    item.append(node('p',row.archiveState==='complete'?'Archive complete':'Archive pending · recorded status may be behind the live session.','muted'));
    if(row.own&&['lobby','live'].includes(row.status)&&Date.parse(row.expiresAt)>Date.now()){const link=node('a','Open session options','btn');link.href=sessionUrl(row.sessionId,'facilitate',location.origin);link.target='_blank';link.rel='noopener';item.append(link,node('p','Opens a new tab. Rejoin requires a deliberate press.','muted'));}
    list.append(item);
   }
   after=page.nextAfter;more.hidden=after===null;status.textContent=seen.size?'':'No sessions match this view.';
  }catch{if(alive(version)){list.replaceChildren();seen=new Set();after=null;status.textContent='Sessions are unavailable. Retry to check your current access again.';retry.hidden=false;more.hidden=true;}}
  finally{if(alive(version)){workspace.disabled=filter.disabled=false;more.disabled=retry.disabled=false;}}
 }
 workspace.onchange=filter.onchange=()=>void load(true);more.onclick=()=>void load(false);retry.onclick=()=>void load(!after);void load(true);
 return{addMemberships(rows){for(const membership of rows){if([...workspace.options].some(option=>option.value===membership.workspace_id))continue;const option=node('option',cleanText(membership.name??membership.workspaceName??'Workspace',200));option.value=membership.workspace_id;workspace.append(option);}if(!list.children.length)void load(true);},close(){closed=true;generation++;workspaceSelect.dispose();filterSelect.dispose();list.replaceChildren();host.replaceChildren();}};
}
export function mountAccountDetails(host,me,memberships){
 host.replaceChildren(node('h1','Account','case-catalog-heading'),node('p',cleanText(me.account?.email??'Account email unavailable.',320)));
 const list=node('ul');for(const membership of memberships)list.append(node('li',`${cleanText(membership.name??membership.workspaceName??'Workspace',200)} · ${cleanText(membership.role??'Member',30)}`));
 host.append(node('h2','Workspaces'),list);
 return {addMemberships(rows){for(const membership of rows)list.append(node('li',`${cleanText(membership.name??membership.workspaceName??'Workspace',200)} · ${cleanText(membership.role??'Member',30)}`));},close(){host.replaceChildren();}};
}
