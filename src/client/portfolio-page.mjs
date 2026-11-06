import { createSurfaceNotice } from './surface-notice.mjs';
import { decorateTools, compactTool } from './ui-icons.mjs';
// Private portfolio: personal summaries and server-derived statistics, never live-room control.
import { node, accountRequest, clearPrivate } from './auth-ui.mjs';
import { enhanceSelect } from './accessible-select.mjs';
import { mountSessionDetail } from './session-detail.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { historyUrl, sessionRecordUrl, parseCaseWorkspace } from '../shared/urls.mjs';
import { accessName } from './navigation-access.mjs';
import { collapseSearch, disclosure } from './surface-controls.mjs';
import { caseTile } from './case-tile.mjs';
import { isPlainNavigation } from './shared-menu.mjs';
const button=(text,fn)=>{const b=node('button',text,'btn quiet');b.type='button';b.onclick=fn;return b;};
const field=(text,input)=>{const label=node('label',text);label.append(input);return label;};
const date=x=>x?new Date(x).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not recorded';
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
function pageValue(x){
 const keys=['sessionId','caseId','caseVersionId','title','versionNo','status','createdAt','startedAt','endedAt','expiresAt','archiveState','own','joined','joinedExact'];
 if(!x||Object.keys(x).some(k=>!['rooms','nextAfter'].includes(k))||!Array.isArray(x.rooms)||x.rooms.length>20||!(x.nextAfter===null||typeof x.nextAfter==='string'&&x.nextAfter.length<=512&&/^[A-Za-z0-9_-]+$/.test(x.nextAfter)))throw new Error('invalid_history');
 for(const r of x.rooms)if(!r||Object.keys(r).sort().join()!==keys.slice().sort().join()||!['sessionId','caseId','caseVersionId'].every(k=>isUuidV7(r[k]))||typeof r.title!=='string'||r.title.length>200||!Number.isSafeInteger(r.versionNo)||r.versionNo<1||!['lobby','live','ended','expired'].includes(r.status)||!['pending','complete','limited'].includes(r.archiveState)||r.own!==true||typeof r.joinedExact!=='boolean'||!(r.joined===null&&!r.joinedExact||Number.isSafeInteger(r.joined)&&r.joined>=0&&r.joined<=1000000)||!time(r.createdAt)||!time(r.expiresAt)||![r.startedAt,r.endedAt].every(v=>v===null||time(v)))throw new Error('invalid_history');
 if(new Set(x.rooms.map(r=>r.sessionId)).size!==x.rooms.length)throw new Error('invalid_history');return x;
}
export function mountPortfolio(host,{auth,me,memberships=[],mode='history',requestedRecordId=null,current=()=>true,onContext=()=>{}}={}){
 const askedCase=new URL(location.href).searchParams.get('case'),caseFilter=isUuidV7(askedCase)?askedCase:null;
 let closed=false,generation=0,rows=[],after=null,previous=[],selected=null,detail=null,controller=null,applied=null;
 const root=node('section',null,'portfolio'),heading=node('h1','Sessions','sr-only'),identity=node('p',me.account?.email??'Email unavailable','portfolio-identity');
 const workspace=node('select');workspace.setAttribute('aria-label','Workspace');
 const workspaceLabel=field('Workspace',workspace),form=node('form',null,'portfolio-tools'),query=node('input'),state=node('select'),from=node('input'),until=node('input');query.type='search';query.className=from.className=until.className='input';query.maxLength=200;from.type=until.type='date';
 for(const [value,text]of [['all','All sessions'],['running','Running'],['ended','Ended']])state.append(Object.assign(node('option',text),{value}));
 const submit=node('button','Apply filters','btn');submit.type='submit';form.append(field('Search case title',query),field('Status',state),field('From (UTC)',from),field('Before (UTC)',until),submit,button('Clear',()=>{query.value=from.value=until.value='';state.value='all';void load(true);}));
 const stateChoice=enhanceSelect(state,{label:'Status'}),searchControl=collapseSearch(query,{label:'Search sessions'});
 form.firstChild.replaceWith(searchControl.root);searchControl.addSubmit();
 const dates=node('div',null,'session-date-filters');dates.append(from.closest('label'),until.closest('label'));form.insertBefore(disclosure('date filters',dates,{tool:'date'}),submit);
 const notice=node('p','', 'portfolio-status');notice.setAttribute('role','status');const stats=node('section',null,'portfolio-stats'),list=node('ul',null,'portfolio-rows'),listView=node('div',null,mode==='account'?'portfolio-activity':null),detailHost=node('div');
 const prev=button('Previous page',()=>{if(previous.length){after=previous.pop();void load(false);}}),next=button('Next page',()=>{previous.push(after);after=next.dataset.after;void load(false);}),retry=button('Refresh sessions',()=>void load(true));
 const nav=node('div',null,'portfolio-pagination');nav.append(prev,next,retry);listView.append(...(mode==='account'?[node('h2','Recent session activity')]:[]),notice,list,nav);form.prepend(workspaceLabel);if(caseFilter){const scope=node('div',null,'session-scope');const clear=node('a','All sessions','btn quiet');clear.href=historyUrl(location.origin,parseCaseWorkspace(location.href).workspaceId);scope.append(node('p','Sessions for this case','small muted'),clear);root.append(scope);}
 root.append(heading,form,stats,listView,detailHost);host.replaceChildren(root);decorateTools(root);
 let choice=null;
 function addMemberships(items){for(const row of items){if([...workspace.options].some(o=>o.value===row.workspace_id))continue;const o=node('option',`${row.name??row.workspaceName??'Workspace'} · ${accessName(row.role)}`);o.value=row.workspace_id;workspace.append(o);}if(!choice)choice=enhanceSelect(workspace);}
 addMemberships(memberships);const preferred=parseCaseWorkspace(location.href).workspaceId;if([...workspace.options].some(o=>o.value===preferred))workspace.value=preferred;
 let scopeAfter=null,scopeBusy=false,waitingForPreferred=Boolean(preferred&&![...workspace.options].some(o=>o.value===preferred));
 const scopeAbort=new AbortController(),scopeNotices=createSurfaceNotice(),moreScopes=button('Load more past workspaces',()=>void loadPastScopes());compactTool(moreScopes,'next');moreScopes.hidden=true;workspaceLabel.after(moreScopes);
 async function loadPastScopes(){
  if(closed||scopeBusy)return;scopeBusy=true;moreScopes.disabled=true;
  try{const v=await accountRequest(auth,['portfolio','workspaces'],{method:'POST',body:{after:scopeAfter},signal:scopeAbort.signal});if(closed||!current())return;
   if(!v||!Array.isArray(v.workspaces)||v.workspaces.length>100||!(v.nextAfter===null||isUuidV7(v.nextAfter))||v.workspaces.some(r=>!isUuidV7(r.id)||typeof r.name!=='string'||r.name.length>120))throw Error('invalid_workspaces');
   const wasEmpty=!workspace.options.length;for(const row of v.workspaces)if(![...workspace.options].some(o=>o.value===row.id)){const option=node('option',row.name+' · Past sessions');option.value=row.id;workspace.append(option);}
   scopeAfter=v.nextAfter;moreScopes.hidden=scopeAfter===null;
   if(waitingForPreferred&&[...workspace.options].some(o=>o.value===preferred)){waitingForPreferred=false;workspace.value=preferred;void load(true);}
   else if(wasEmpty&&!requestedRecordId&&!waitingForPreferred&&workspace.value)void load(true);
   else if(waitingForPreferred&&scopeAfter===null){waitingForPreferred=false;scopeNotices.notify('This past workspace is unavailable. Check Account or ask a Case administrator to review your access.',{error:true});}
  }catch{if(!closed&&current()){moreScopes.hidden=false;scopeNotices.notify('Past workspaces could not load. Use Load more past workspaces to retry.',{error:true});}}
  finally{scopeBusy=false;moreScopes.disabled=false;}
 }

 const alive=g=>!closed&&g===generation&&current();
 function body(){return {v:2,...(caseFilter?{caseId:caseFilter}:{}),workspaceId:workspace.value,query:query.value.trim(),status:state.value,from:from.value?new Date(`${from.value}T00:00:00.000Z`).toISOString():null,until:until.value?new Date(`${until.value}T00:00:00.000Z`).toISOString():null,personal:true};}
 async function load(reset){
  if(closed)return;controller?.abort();controller=new AbortController();const g=++generation;detail?.close();detail=null;clearPrivate(detailHost);listView.hidden=false;form.hidden=false;stats.hidden=false;heading.textContent=mode==='account'?'Account':'Sessions';rows=[];clearPrivate(list);clearPrivate(stats);prev.hidden=next.hidden=true;onContext(mode==='account'?'Account':'Sessions');
  if(reset){after=null;previous=[];applied=body();}
  if(!workspace.value){notice.textContent='No workspaces are assigned to this account.';return;}
  notice.textContent='Loading sessions…';
  try{
   const page=pageValue(await accountRequest(auth,['portfolio','query'],{method:'POST',body:{...applied,after},signal:controller.signal,maxResponseBytes:131072}));if(!alive(g))return;rows=page.rooms;
   for(const row of rows){const elapsed=row.startedAt&&row.endedAt?Math.max(0,Math.round((Date.parse(row.endedAt)-Date.parse(row.startedAt))/60000)):null;
    const participants=row.joined===null?'participants not recorded':`${row.joinedExact?'':'≥'}${row.joined} ${row.joined===1?'participant':'participants'}`;const item=node('li');const card=caseTile({title:row.title+' · '+participants,variant:'horizontal',metadata:[`v${row.versionNo}`,date(row.startedAt??row.createdAt),elapsed===null?'Duration not recorded':elapsed+' min'],states:[{label:row.status==='lobby'?'Lobby':row.status==='live'?'Live':row.status==='expired'?'Expired':'Ended',tone:row.status==='live'?'ok':''},{label:row.archiveState==='complete'?'Session record':row.archiveState==='pending'?'Archive pending':'Limited archive evidence'}],href:sessionRecordUrl(row.sessionId,location.origin),onOpen:event=>{if(!isPlainNavigation(event))return;event.preventDefault();openRecord(row.sessionId);}});card.open.dataset.session=row.sessionId;card.open.setAttribute('aria-description',row.joined===null?'Participant total is unavailable.':row.joinedExact?'Distinct participant identities who joined, including those later removed.':'At least '+row.joined+' distinct participant identities are archived so far; this total may increase.');item.append(card.root);list.append(item);}

   notice.textContent=rows.length?'':'No sessions match these filters.';next.dataset.after=page.nextAfter??'';next.hidden=page.nextAfter===null;prev.hidden=!previous.length;
   if(!after&&!caseFilter)await loadStats(g);
  }catch(error){if(alive(g)){rows=[];clearPrivate(list);notice.textContent=error?.status===403?'Current access is no longer permitted.':error?.status===400?'Check the dates or refresh your search.':'Sessions are unavailable. Refresh to recheck access.';}}
 }
 async function loadStats(g){
  try{const v=await accountRequest(auth,['portfolio','stats'],{method:'POST',body:{workspaceId:workspace.value,v:2},signal:controller.signal});if(!alive(g))return;
   if(!v||Object.keys(v).sort().join()!==['asOf','firstSessionAt','sessions','active','ended','completeRecords','uniqueVersions','recordedTeachingSeconds'].sort().join()||!time(v.asOf)||!(v.firstSessionAt===null||time(v.firstSessionAt))||!['sessions','active','ended','completeRecords','uniqueVersions','recordedTeachingSeconds'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0)||v.active+v.ended!==v.sessions||v.completeRecords>v.sessions)throw new Error('invalid_stats');
   const dl=node('dl');for(const [label,value]of [['Sessions',v.sessions],['Active sessions',v.active],['Ended or expired',v.ended],['Finalised records',v.completeRecords],['Case versions taught',v.uniqueVersions],['Recorded teaching minutes',Math.round(v.recordedTeachingSeconds/60)]])dl.append(node('dt',label),node('dd',String(value)));
   stats.append(node('h2','Your workspace totals'),node('p',`Your sessions in this workspace, ${v.firstSessionAt?`from ${date(v.firstSessionAt)}`:'no sessions yet'}. Totals checked ${date(v.asOf)}. Duration includes sessions with a recorded start and end.`, 'muted'),dl);
  }catch{if(alive(g))stats.append(node('p','Portfolio statistics are unavailable; no totals are inferred from this page.','muted'),button('Retry statistics',()=>void loadStats(g)));}
 }
 function openRecord(id,{push=true}={}){if(push)history.pushState({...history.state,privateNavigationIndex:(history.state?.privateNavigationIndex??0)+1,sessionRecordFrom:location.pathname+location.search},'',sessionRecordUrl(id,location.origin));selected=id;listView.hidden=true;form.hidden=true;stats.hidden=true;workspaceLabel.hidden=true;heading.textContent='Session record';onContext('Session record');detail?.close();detail=mountSessionDetail(detailHost,{auth,sessionId:id,current:()=>!closed&&current(),onBack:()=>{if(history.state?.sessionRecordFrom){history.back();return;}location.assign(historyUrl(location.origin));}});}
 const onPop=()=>{const id=location.pathname.match(/^\/sessions\/([0-9a-f-]{36})$/)?.[1];if(id&&isUuidV7(id)){openRecord(id,{push:false});return;}detail?.close();detail=null;clearPrivate(detailHost);listView.hidden=false;form.hidden=false;stats.hidden=false;workspaceLabel.hidden=false;heading.textContent='Sessions';onContext('Sessions');if(!rows.length)void load(true);else [...list.querySelectorAll('[data-session]')].find(b=>b.dataset.session===selected)?.focus({preventScroll:true});};window.addEventListener('popstate',onPop);
 form.onsubmit=e=>{e.preventDefault();void load(true);};workspace.onchange=()=>caseFilter?location.assign(historyUrl(location.origin,workspace.value)):void load(true);
 void loadPastScopes();
 if(requestedRecordId)openRecord(requestedRecordId,{push:false});else if(!waitingForPreferred)void load(true);return {workspaceId:()=>workspace.value||null,addMemberships(items){const empty=!workspace.options.length;addMemberships(items);if(empty&&!requestedRecordId)void load(true);},beforeNavigate:()=>detail?.beforeNavigate?.()??true,close(){closed=true;scopeAbort.abort();scopeNotices.close();generation++;controller?.abort();detail?.close();choice?.dispose();stateChoice.dispose();searchControl.dispose();window.removeEventListener('popstate',onPop);rows=[];applied=null;clearPrivate(root);root.remove();}};
}
