// Exports are deliberately activated only after a fresh authorized read of this exact page.
import { node, clearPrivate } from './auth-ui.mjs';
import { recordPage } from '../shared/session-record-wire.mjs';
import { sessionRecordObjectUrl, mediaObjectUrl, apiUrl } from '../shared/urls.mjs';
import { pdfFileName } from './pdf-chrome.mjs';
const MAX_BYTES=2*1048576,MAX_IMAGE=600*1024;
/** J10 (card 59 M3): one image of this session's record, as the session's own account may read it, or null. */
async function recordImage(auth,sessionId,assetId,signal){
 for(let attempt=0;attempt<2&&auth;attempt++){
  const token=auth.accessToken()??await auth.restore();if(!token||signal.aborted)return null;
  let response;try{response=await fetch(apiUrl(location.origin,'portfolio','media'),{method:'POST',credentials:'omit',cache:'no-store',redirect:'manual',signal,
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({sessionId,assetId})});}catch{return null;}
  if(response.status===401&&attempt===0&&await auth.refresh())continue;
  if(!response.ok||response.headers.get('content-type')!=='image/jpeg')return null;
  const bytes=new Uint8Array(await response.arrayBuffer());
  return bytes.length<=MAX_IMAGE&&bytes[0]===255&&bytes[1]===216?bytes:null;
 }
 return null;
}
export function mountSessionExport(host,{page,part,lines,printBody,current,revalidate,auth=null}){
 let closed=false,busy=false,controller=null,urls=new Set(),printRoot=null,previousTitle=null;const root=node('section',null,'session-export-tools'),notice=node('p');notice.setAttribute('role','status');
 const controls=[];
 function clearPrint(){if(printRoot){clearPrivate(printRoot);printRoot.remove();}printRoot=null;document.body.classList.remove('printing-session-record');if(previousTitle!==null){document.title=previousTitle;previousTitle=null;}window.removeEventListener('afterprint',clearPrint);}
 // The images on the slides this part reached (J10), fetched fresh with the session's own access; a missing one says so.
 async function imageRows(signal){
  if(!page.images?.length)return [];
  const rows=[['H2','Images on slides this session reached'],['P','A slide’s later steps may not all have been shown in the room.']];
  for(const image of page.images){const bytes=await recordImage(auth,page.session.id,image.assetId,signal);if(!current()||signal.aborted)return [];
   rows.push(bytes?['FIG',{bytes,alt:image.alt,caption:image.caption}]:['P',`Image no longer available: ${image.alt}`]);}
  return rows;
 }
 // The print copy is the same debrief the screen shows (card 40), followed by the reached images.
 function printRecord(rows=[]){clearPrint();printRoot=node('article',null,'private-session-print');printRoot.append(node('h1',page.session.title),printBody());for(const [role,text]of rows){
  if(role==='FIG'){const figure=node('figure'),picture=node('img'),url=mediaObjectUrl(new Blob([text.bytes],{type:'image/jpeg'}));urls.add(url);picture.src=url;picture.alt=text.alt;figure.append(picture);if(text.caption)figure.append(node('figcaption',text.caption));printRoot.append(figure);continue;}
  printRoot.append(node(role==='H1'?'h1':role==='H2'?'h2':'p',text));}previousTitle=document.title;document.title=page.session.title;document.body.append(printRoot);document.body.classList.add('printing-session-record');window.addEventListener('afterprint',clearPrint,{once:true});try{window.print();}finally{clearPrint();}}
 function revoke(){for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
 async function activate(kind){
  if(closed||busy||!current())return;busy=true;controller=new AbortController();revoke();for(const b of controls)b.disabled=true;notice.textContent='Checking current access…';
  try{
   recordPage(await revalidate(controller.signal));if(closed||!current()||controller.signal.aborted)return;
   const images=kind==='json'?[]:await imageRows(controller.signal);if(closed||!current()||controller.signal.aborted)return;
   const imageBytes=images.reduce((n,[role,value])=>n+(role==='FIG'?value.bytes.length:0),0);
   if(kind==='print'){notice.textContent='Use your browser’s print controls. Browser headers and footers are outside Case’s control.';printRecord(images);return;}
   let data,type;
   if(kind==='pdf'){const {sessionPdf}=await import('./session-pdf.mjs');if(closed||!current())return;data=sessionPdf([...lines,...images],{title:page.session.title,maxBytes:MAX_BYTES+imageBytes});type='application/pdf';}
   else {data=new TextEncoder().encode(JSON.stringify({schema:'case.session-record-export.v1',part,lastPart:page.nextAfter===null,record:{...page,nextAfter:null}},null,2));type='application/json';}
   if(data.length>MAX_BYTES+imageBytes)throw new Error('export_budget');
   // Revalidate after generation too: neither a stale blob nor a changed archive becomes downloadable.
   recordPage(await revalidate(controller.signal));if(closed||!current()||controller.signal.aborted)return;
   const url=sessionRecordObjectUrl(new Blob([data],{type}));urls.add(url);const a=node('a');a.href=url;a.download=pdfFileName(page.session.title,'Session record',{version:`${page.session.versionNo}${part>1?` part ${part}`:''}`,ext:kind});a.click();setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},0);
   notice.textContent=page.nextAfter?'Saved. The record was longer than the History view reads, so the export stops at the same point.':'Saved.';
  }catch(error){if(!closed&&current())notice.textContent=error.message==='pdf_font_unsupported'?'This PDF font cannot faithfully represent a character in this record. Use the accessible HTML print fallback or JSON; no text has been substituted.':error.message?.includes('budget')?'This part exceeds the export limit. Use the HTML view or JSON.':'Export cancelled: current access or unchanged evidence could not be verified. Refresh the record to retry.';}
  finally{busy=false;if(!closed)for(const b of controls)b.disabled=false;}
 }
 for(const [kind,label]of [['pdf','Download PDF'],['json','Download JSON'],['print','Print accessible HTML']]){const b=node('button',label,'btn quiet');b.type='button';b.onclick=()=>void activate(kind);controls.push(b);root.append(b);}
 root.append(notice);host.append(root);return {close(){closed=true;controller?.abort();clearPrint();revoke();clearPrivate(root);root.remove();page=lines=null;}};
}
