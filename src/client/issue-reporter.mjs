import {uuidv7,isUuidV7} from '../shared/ids.mjs';
import {issueDraft,issueDigest,issueHex,issueReceipt,ISSUE_FREQUENCIES,ISSUE_SEVERITIES} from '../shared/issues.mjs';
import {createIssuesClient} from './issues-client.mjs';
import {el,button,field,createIssueUI} from './issues-ui.mjs';
export function mountIssueReporter({auth,participant=null,shot=null,isCurrent=()=>true,opener,ui,onClosed=()=>{}}={}){
 const{issueDialog,showOriginal}=createIssueUI(ui);
 let closed=false,busy=false,frozen=null,files=[],preview=null;const urls=new Set();
 const api=createIssuesClient({auth,participant,isCurrent});const current=()=>!closed&&api.current();
 const form=el('form',null,'issues-content'),description=field('What went wrong?',{required:true,max:2000,area:true}),incident=field('Security or privacy incident',{check:true}),details=el('details'),summary=el('summary','Show optional details');details.append(summary);
 description.input.placeholder='What were you doing, and what went wrong? Include any error you saw.';
 const optional={};for(const [key,label,max,area,choices]of [['context','What were you trying to do?',160],['expected','What did you expect?',1000,true],['steps','Steps to reproduce',1200,true],['frequency','How often?',0,false,ISSUE_FREQUENCIES],['impact','Impact',0,false,ISSUE_SEVERITIES],['occurrence','When did it happen? (estimate)',80]]){optional[key]=field(label,{max,area,choices});details.append(optional[key].wrap);}
 const diagnostics=field('Include basic browser and viewport diagnostics',{check:true}),contact=field('Administrators may contact me about this report',{check:true});details.append(diagnostics.wrap,contact.wrap);
 const fileInput=el('input');fileInput.type='file';fileInput.accept='image/png,image/jpeg';fileInput.multiple=true;const fileLabel=el('label','Add screenshots (up to 3; 5 MB each)');fileLabel.append(fileInput);details.append(fileLabel);
 const attachments=el('div',null,'issues-files'),actions=el('div',null,'issues-actions'),send=button('Send report',()=>void submit(),'primary');send.type='button';
 const modal=issueDialog('Report an issue',{opener,dirty:()=>hasDraft(),discardMessage:()=>frozen?'This report may already have been received. Discard removes only this tab’s draft and retry information; check My reports before sending another report.':'Your entries have not been saved.',pending:()=>busy,onClose:dispose});
 const hasDraft=()=>!!frozen||description.input.value.trim()!==''||files.length>0||incident.input.checked||diagnostics.input.checked||contact.input.checked||Object.entries(optional).some(([key,f])=>f.input.value!==(['frequency','impact'].includes(key)?'unknown':''));
 const note=el('p',shot?.state==='captured'?'Screenshot attached locally. Nothing is uploaded until you send.':'You can send a text report. Screenshots are optional.');
 function revoke(){for(const url of urls)URL.revokeObjectURL(url);urls.clear();preview?.close();preview=null;}
 function renderFiles(){attachments.replaceChildren();files.forEach((f,index)=>{const group=el('div',null,'issues-actions');group.append(el('span',`Screenshot ${index+1} · ${Math.ceil(f.blob.size/1000)} KB`),button('Preview',()=>{preview?.close();let url=URL.createObjectURL(f.blob);urls.add(url);preview=issueDialog('Screenshot preview',{opener:document.activeElement,onClose:()=>{URL.revokeObjectURL(url);urls.delete(url);}});const image=el('img');image.alt='Screenshot attached to this report';image.src=url;preview.content.append(image);}),button('Remove',()=>{if(frozen||busy)return;revoke();files.splice(index,1);renderFiles();}));attachments.append(group);});}
 function add(blob){if(frozen||files.length>=3||!['image/png','image/jpeg'].includes(blob.type)||blob.size<1||blob.size>5_000_000){modal.notify('Use up to 3 PNG/JPEG screenshots of 5 MB or less.',true);return;}files.push({id:uuidv7(),blob});renderFiles();}
 fileInput.onchange=()=>{for(const file of fileInput.files??[])add(file);fileInput.value='';};if(shot?.blob)add(shot.blob);shot=null;
 const mine=button('My reports',()=>{if(busy)return;if(hasDraft()){modal.notify('Send or discard this draft before opening My reports.',true);return;}void listMine();});
 actions.append(mine);modal.actions.append(send);form.append(description.wrap,incident.wrap,details,note,attachments,actions);form.onsubmit=e=>{e.preventDefault();void submit();};modal.content.append(form);description.input.focus();
 const timer=setInterval(()=>{if(!current())modal.close();},500);
 const pagehide=()=>modal.close();window.addEventListener('pagehide',pagehide);window.addEventListener('case-auth-retired',pagehide);
 function dispose(){if(closed)return;closed=true;clearInterval(timer);window.removeEventListener('pagehide',pagehide);window.removeEventListener('case-auth-retired',pagehide);api.close();revoke();files=[];frozen=null;onClosed();}
 function lock(value){busy=value;modal.cancel.disabled=modal.dismiss.disabled=value;send.disabled=value;mine.disabled=value;for(const input of form.querySelectorAll('input,textarea,select,details')){if('disabled'in input)input.disabled=value||!!frozen;}send.textContent=frozen?'Retry report':'Send report';}
 async function submit(){
  if(busy||!current())return;if(!navigator.onLine){modal.notify('Offline. Your draft is still here; reconnect to send.',true);return;}
  if(!frozen&&!form.reportValidity())return;lock(true);modal.status.textContent=frozen?'Checking the original operation…':'Sending report…';
  try{
   if(!frozen){const manifests=[];for(const f of files){const bytes=await f.blob.arrayBuffer();if(!current())return;manifests.push({id:f.id,sha256:issueHex(await crypto.subtle.digest('SHA-256',bytes)),bytes:f.blob.size,type:f.blob.type});}
    const v={operationId:uuidv7(),description:description.input.value,incident:incident.input.checked,contactConsent:contact.input.checked,attachments:manifests};for(const [k,f]of Object.entries(optional))v[k]=f.input.value;
    if(diagnostics.input.checked)v.diagnostics={route:participant?'participant':'private',browser:/Firefox\//.test(navigator.userAgent)?'Firefox':/Chrome\//.test(navigator.userAgent)?'Chromium':'Other',os:/Mac/.test(navigator.platform)?'macOS':/Win/.test(navigator.platform)?'Windows':'Other',viewport:`${innerWidth}x${innerHeight}`};
    const draft=issueDraft(v);frozen={draft,digest:await issueDigest(draft)};
   }
   if(!current())return;const {draft,digest}=frozen;
   let receipt;try{receipt=await api.request([draft.operationId,'receipt'],{method:'POST',body:{digest}});}catch(e){if(e.status!==404)throw e;}
   if(!receipt)receipt=await api.request([],{method:'POST',body:draft});if(!current())return;
   if(!isUuidV7(receipt?.id)||receipt.operationId!==draft.operationId||receipt.digest!==digest||(frozen.id&&frozen.id!==receipt.id))throw new Error('bad_response');frozen.id=receipt.id;
   if(receipt.state!=='accepted'){if(receipt.state!=='pending'||receipt.digest!==digest)throw new Error('bad_response');
    for(const f of files){try{const stored=await api.request([receipt.id,'files',f.id],{method:'PUT',body:f.blob});if(!current())return;if(stored?.stored!==true||stored.id!==f.id)throw new Error('bad_response');}catch(error){if(!current()||[401,403].includes(error.status))throw error;}}
    receipt=await api.request([receipt.id,'accept'],{method:'POST',body:{digest}});
   }
   if(!current())return;if(!issueReceipt(receipt,{operationId:draft.operationId,digest,id:frozen.id,attachments:draft.attachments}))throw new Error('bad_response');
   const missing=receipt.attachmentOutcome.filter(f=>f.state==='missing').length;revoke();files=[];frozen=null;form.reset();form.remove();send.remove();modal.cancel.textContent='Done';modal.content.replaceChildren(el('p',`Report ${receipt.reference} received. This confirms submission, not that an administrator has read it.`),button('My reports',()=>void listMine()));modal.notify(missing?`Report received; ${missing} screenshot${missing===1?' was':'s were'} not attached.`:'Report received.');
  }catch(e){if(!current()){modal.close();return;}modal.notify(!frozen?'Check the report fields and try again. Nothing has been submitted.':e.status===429?'Report limit reached. Keep this original draft and retry after an hour.':e.status===409?'The original operation conflicts or has expired. It has not been resent as a new report.':'Submission is unconfirmed. Your original draft is kept in this tab. Retry report checks and recovers the same operation.',true);}
  finally{if(!closed)lock(false);}
 }
 async function listMine(cursor=null){if(!current())return;modal.status.textContent='Loading your reports…';try{const result=await api.request([],{query:{cursor}});if(!current())return;if(!Array.isArray(result.rows))throw new Error('bad_response');send.remove();modal.cancel.textContent='Done';modal.content.replaceChildren();if(!result.rows.length)modal.content.append(el('p','No reports yet.'));for(const row of result.rows){modal.content.append(button(`${row.reference} · ${row.status} · ${row.title}`,async()=>{modal.status.textContent='Loading report…';try{const issue=await api.request([row.id]);if(!current())return;modal.content.replaceChildren(button('Back to My reports',()=>void listMine()));showOriginal(modal.content,issue,api,{current});modal.status.textContent=`${issue.reference} · ${issue.status}`;}catch{modal.notify('Report unavailable.',true);}}));}if(result.cursor)modal.content.append(button('Next reports',()=>void listMine(result.cursor)));modal.status.textContent=result.rows.length?'Your reports':'No reports yet.';}catch{if(current())modal.notify('Your reports are unavailable.',true);else modal.close();}}
 return{close:modal.close};
}
