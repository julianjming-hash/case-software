// Single Studio modal frame; unknown outcomes require explicit local reconciliation, never blind retry.
import {enhanceSelect,disposeSelects} from '../../src/client/accessible-select.mjs';
export function createStudioModal({outcome,notify,clearNotice=()=>{}}){
 const dialog=document.querySelector('#modal'),body=document.querySelector('#modal-body'),submit=document.querySelector('#modal-submit'),cancel=document.querySelector('#modal-cancel'),close=document.querySelector('#modal-close');
 const discard=document.createElement('dialog');discard.className='studio-discard';discard.setAttribute('aria-labelledby','discard-title');discard.setAttribute('aria-describedby','discard-copy');
 const title=document.createElement('h2');title.id='discard-title';title.textContent='Discard your changes?';const copy=document.createElement('p');copy.id='discard-copy';copy.textContent='Your unsaved entries will be lost.';
 const footer=document.createElement('div');footer.className='dialog-foot';const keep=document.createElement('button'),remove=document.createElement('button');keep.type=remove.type='button';keep.className='btn quiet';remove.className='btn danger';keep.textContent='Keep editing';remove.textContent='Discard changes';footer.append(keep,remove);discard.append(title,copy,footer);document.body.append(discard);
 let opener=null,initial='',busy=false,uncertain=false,action=null,guard=true,lastEdited=null,outside=false,instant=false,controls=[],disabled=[];
 const snapshot=()=>JSON.stringify([...body.querySelectorAll('input,select,textarea')].filter(e=>!e.closest('[data-transient]')).map(e=>[e.tagName,e.type,e.name,['checkbox','radio'].includes(e.type)?e.checked:e.value]));
 function restore(){if(dialog.open)return;if(opener?.isConnected&&!opener.closest('dialog:not([open])'))opener.focus();else{const name=opener?.getAttribute('aria-label')||opener?.textContent;const replacement=[...document.querySelectorAll('#main button,#main a')].find(e=>opener?.dataset.focusKey?e.dataset.focusKey===opener.dataset.focusKey:(e.getAttribute('aria-label')||e.textContent)===name);(replacement??document.querySelector('#main h1')??document.querySelector('#studio-menu-button'))?.focus();}}
 function finish(){clearNotice();disposeSelects(body);dialog.close();restore();}
 function requestClose(){if(busy||uncertain||!dialog.open||discard.open)return;if(guard&&snapshot()!==initial){discard.showModal();keep.focus();}else finish();}
 function keepEditing(){discard.close();if(lastEdited?.isConnected)lastEdited.focus();else cancel.focus();}
 keep.onclick=keepEditing;remove.onclick=()=>{discard.close();finish();};discard.addEventListener('cancel',e=>{e.preventDefault();keepEditing();});dialog.addEventListener('cancel',e=>{e.preventDefault();requestClose();});
 dialog.addEventListener('pointerdown',e=>{const r=dialog.getBoundingClientRect();outside=e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)&&!document.querySelector('[role="combobox"][aria-expanded="true"]');});
 dialog.addEventListener('pointerup',e=>{const r=dialog.getBoundingClientRect();if(outside&&e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))requestClose();outside=false;});
 body.addEventListener('focusin',e=>{if(e.target.matches('input,select,textarea,[role="combobox"]'))lastEdited=e.target;});cancel.onclick=close.onclick=requestClose;
 function unlock(){controls.forEach((c,i)=>c.disabled=disabled[i]);submit.disabled=cancel.disabled=close.disabled=false;submit.removeAttribute('aria-busy');}
 async function reconcile(button){button.disabled=true;button.textContent='Checking status…';await new Promise(r=>setTimeout(r,350));uncertain=false;outcome.value='success';unlock();notify('Local check confirmed the preview was refused. Your entries are kept; you can retry.',{tone:'error'});submit.focus();}
 document.querySelector('#modal-form').onsubmit=async e=>{
  e.preventDefault();if(busy||uncertain||discard.open)return;const owner=action;if(instant){clearNotice();dialog.close();disposeSelects(body);owner?.();restore();return;}
  busy=true;controls=[...body.querySelectorAll('input,select,textarea,button')];disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);submit.disabled=cancel.disabled=close.disabled=true;submit.setAttribute('aria-busy','true');
  notify('Updating the local preview…',{tone:'pending',persistent:true,dismissible:false});await new Promise(r=>setTimeout(r,650));busy=false;
  if(outcome.value==='unknown'){uncertain=true;submit.removeAttribute('aria-busy');notify('The preview outcome is unconfirmed. Check status before retrying.',{tone:'unknown',persistent:true,dismissible:false,action:{label:'Check status',run:reconcile}});return;}
  unlock();if(outcome.value==='failure'){outcome.value='success';notify('The local preview was refused. Your entries are kept; try again or cancel.',{tone:'error'});submit.focus();return;}
  clearNotice();dialog.close();disposeSelects(body);owner?.();restore();
 };
 return {requestClose,get busy(){return busy||uncertain;},get open(){return dialog.open;},show(title,context,label,build,run,options={}){
  if(busy||uncertain)return false;if(dialog.open){notify('Finish or close the current dialog first.',{tone:'error'});return false;}clearNotice();opener=options.opener??document.activeElement;guard=options.guard!==false;instant=options.instant===true;lastEdited=null;action=run;
  dialog.classList.toggle('studio-feedback-modal',options.wide===true);body.tabIndex=0;body.setAttribute('role','region');body.setAttribute('aria-label',title+' details');document.querySelector('#modal-title').textContent=title;document.querySelector('#modal-context').textContent=context;disposeSelects(body);body.replaceChildren();submit.textContent=label;submit.disabled=cancel.disabled=close.disabled=false;build(body);
  if(options.instant===undefined&&label==='Done'&&!body.querySelector('input,select,textarea'))instant=true;for(const select of body.querySelectorAll('select'))enhanceSelect(select);initial=snapshot();dialog.showModal();(body.querySelector('input:not([type=hidden]),textarea,[role=combobox]')??cancel).focus();return true;
 }};
}
