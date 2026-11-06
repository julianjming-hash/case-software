// Shared bounded-record dialog. The list remains in place; browsing follows the caller's filtered rows.
import { node } from './auth-ui.mjs';
import { guardDialog } from './dialog-behaviour.mjs';
import { uiIcon } from './ui-icons.mjs';
const snapshot=root=>JSON.stringify([...root.querySelectorAll('input,textarea,select')].filter(e=>!e.closest('.groups-screen,.case-group')).map(e=>[e.type,e.type==='checkbox'||e.type==='radio'?e.checked:e.value]));
export function recordDialog(dialog,{close,previous=null,next=null,pending=()=>false,dirty=()=>false,opener=()=>null}){
 let initial=snapshot(dialog),continuation=null,disposed=false;
 dialog.classList.add('admin-record-dialog');dialog.classList.remove('admin-drawer');
 const tools=node('div',null,'admin-record-navigation'),position=node('span',null,'small muted');
 const button=(label,icon,fn)=>{const b=node('button',null,'btn quiet icon-button');b.type='button';b.setAttribute('aria-label',label);b.append(uiIcon(icon));b.onclick=fn;return b;};
 const guard=guardDialog(dialog,{pending,dirty:()=>dirty()||snapshot(dialog)!==initial,opener,onClose:()=>{const run=continuation;continuation=null;if(run)run();else close();}});
 function navigate(run){if(disposed||pending())return false;continuation=run;guard.requestClose();return false;}
 const back=button('Previous record','arrow-left',()=>navigate(previous)),forward=button('Next record','arrow-right',()=>navigate(next)),dismiss=button('Close record','x',()=>{continuation=null;guard.requestClose();});
 const sync=()=>{const waiting=pending();for(const [control,disabled]of[[back,waiting||!previous],[forward,waiting||!next],[dismiss,waiting]])if(control.disabled!==disabled)control.disabled=disabled;dialog.setAttribute('aria-busy',String(waiting));};
 tools.append(back,forward,position,dismiss);dialog.prepend(tools);sync();const observer=new MutationObserver(sync);observer.observe(dialog,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
 const unload=e=>{if(pending()||dirty()||snapshot(dialog)!==initial){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',unload);
 dialog.hidden=false;dialog.showModal();dismiss.focus({preventScroll:true});
 return {requestClose:()=>{continuation=null;return guard.requestClose();},beforeNavigate:({resume,href}={})=>{if(pending())return false;if(!dirty()&&snapshot(dialog)===initial)return true;return navigate(resume??(()=>{if(href)location.assign(href);}));},reset(){initial=snapshot(dialog);},dispose(){disposed=true;observer.disconnect();guard.dispose();window.removeEventListener('beforeunload',unload);dialog.close();}};
}
/** Preserve the table and one native button: pointer activation fills the row, keyboard activation stays native. */
export function activateSingleActionRow(row,button){row.classList.add('single-action-row');row.addEventListener('click',event=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||button.disabled)return;if(event.target.closest?.('button,a,input,select,textarea,label,[role=combobox]'))return;if(String(window.getSelection?.()??''))return;button.click();});}
