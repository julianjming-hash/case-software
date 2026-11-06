import {loadFeedbackStyle} from './feedback-style.mjs';
// One bounded private record page in memory. Shared by History, Account and Admin inspection.
import { node, accountRequest, clearPrivate } from './auth-ui.mjs';
import { recordPage } from '../shared/session-record-wire.mjs';
import { caseVersionUrl, sessionUrl } from '../shared/urls.mjs';
import { buildDebrief } from './debrief-model.mjs';
import { renderDebrief, debriefPdfRows } from './debrief-render.mjs';
const button=(text,fn)=>{const b=node('button',text,'btn quiet');b.type='button';b.onclick=fn;return b;};
// The History debrief reads as one document (Julian, 2026-10-30): every record page is read in order and joined, so the
// rounds that follow a busy room's events are never split into a second part. The server pins each cursor to the first
// page's boundary, so a record that changes mid-read refuses (409) rather than mixing two states. Bounded at MAX_PAGES.
// Export re-checks only page 1's boundary: it hashes the event count, last seq and every round, so it moves with any change.
const MAX_PAGES=40;
export async function readWholeRecord(request,signal){
 const first=recordPage(await request(null,signal)),items=[...first.items];let next=first.nextAfter,pages=1;
 while(next&&pages<MAX_PAGES){const p=recordPage(await request(next,signal));if(p.session.id!==first.session.id||p.boundary!==first.boundary)throw new Error('record_changed');items.push(...p.items);next=p.nextAfter;pages++;}
 return {...first,items,nextAfter:next,images:first.images};
}
export function mountSessionDetail(host,{auth,sessionId,onBack=()=>{},current=()=>true}={}){
 let closed=false,generation=0,page=null,exporter=null,controller=null,busy=false,feedback=null;
 const root=node('section',null,'session-detail'),back=button('Back to sessions',()=>{close();onBack();}),status=node('p','Loading session record…'),body=node('div'),tools=node('div',null,'session-actions');status.setAttribute('role','status');root.append(back,status,body,tools);host.append(root);
 const alive=g=>!closed&&g===generation&&current();
 const request=(cursor,signal)=>accountRequest(auth,['portfolio','record'],{method:'POST',body:{sessionId,after:cursor,v:2},signal,maxResponseBytes:262144});
 function clearExport(){exporter?.close();exporter=null;}
 async function load(){
  if(closed||busy)return;clearExport();controller?.abort();controller=new AbortController();const g=++generation;page=null;clearPrivate(body);clearPrivate(tools);status.textContent='Loading session record…';
  try{const value=await readWholeRecord(request,controller.signal);if(!alive(g))return;if(value.session.id!==sessionId)throw new Error('wrong_session');page=value;render();}
  catch(error){if(alive(g)){status.textContent=error?.status===403?'Access to this session is no longer permitted.':error?.status===409||error?.message==='record_changed'?'This record changed while loading. Reload it.':'The session record is unavailable.';tools.append(button('Reload',()=>void load()));}}
 }
 function render(){
  const s=page.session;status.textContent=page.completeness==='complete'?'Finalized archive evidence.':page.completeness==='pending'?'Archive pending. Recorded state may lag the live session.':'Limited archive evidence. Older sessions may lack journal or publication references.';
  // Card 40: the History record reads as the counts-only debrief, the same document the PDF and print draw.
  // Rounds follow every event in the record, so a read stopped at MAX_PAGES has no rounds at all: say so, never a partial debrief.
  if(page.nextAfter){body.replaceChildren(node('h2',s.title),node('p',`This record is too large to summarise here (more than ${MAX_PAGES*100} entries).`,'debrief-meta'));clearPrivate(tools);return;}
  const model=buildDebrief(page);body.replaceChildren(node('h2',s.title),renderDebrief(model));
  // Slice 9 (P-37, I5): the room's feedback follows the debrief, on screen and in its PDF; absent when unavailable.
  {const g=generation;feedback=import('./feedback-results.mjs').then(async chunk=>{
    if(!alive(g))return null;const value=await chunk.loadSessionFeedback((parts,options)=>accountRequest(auth,parts,options),sessionId,controller?.signal);if(!value||!alive(g))return null;
    const slot=node('div');body.append(slot);
    async function draw(){if(!alive(g))return;try{await loadFeedbackStyle();if(alive(g))slot.replaceChildren(chunk.feedbackSection(value));}catch{if(alive(g))slot.replaceChildren(node('p','Feedback display could not load. Exports still include its verified results.','supporting-note'),button('Retry feedback display',()=>void draw()));}}
    void draw();return{value,chunk};
  }).catch(()=>null);}
  clearPrivate(tools);
  if(s.own&&['lobby','live'].includes(s.status)&&Date.parse(s.expiresAt)>Date.now()){const a=node('a','Rejoin session','btn');a.href=sessionUrl(s.id,'facilitate',location.origin);tools.append(a);}
  if(['ended','expired'].includes(s.status)||Date.parse(s.expiresAt)<=Date.now()){
   const a=node('a','Teach again: check this version','btn');a.href=caseVersionUrl(s.caseId,s.versionNo,location.origin);tools.append(a);
  }
  tools.append(button('Export',()=>void openExports()));
 }
 async function openExports(){
  if(!page||busy||closed)return;busy=true;const g=generation;status.textContent='Checking export access…';
  try{const [chunk,f]=await Promise.all([import('./session-export.mjs'),feedback]);if(!alive(g))return;clearExport();const model=buildDebrief(page);
   exporter=chunk.mountSessionExport(tools,{page,part:1,lines:[...debriefPdfRows(model),...(f?f.chunk.feedbackPdfRows(f.value):[])],printBody:()=>{const d=renderDebrief(model);if(f)d.append(f.chunk.feedbackSection(f.value));return d;},auth,current:()=>alive(g),revalidate:async signal=>{const fresh=recordPage(await request(null,signal));if(fresh.session.id!==sessionId||fresh.boundary!==page.boundary)throw new Error('record_changed');return fresh;}});status.textContent='Exports cover the whole record.';}
  catch{if(alive(g))status.textContent='Exports are unavailable. Retry to recheck access.';}finally{busy=false;}
 }
 function close(){if(closed)return;closed=true;generation++;controller?.abort();clearExport();page=null;feedback=null;clearPrivate(root);root.remove();}
 void load();return {close,beforeNavigate:()=>{clearExport();return !busy;}};
}
