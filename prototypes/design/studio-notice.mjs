// One non-reflowing notice, placed in the active modal's accessible/top layer when needed.
export function createStudioNotice({icon}) {
 const toast=document.querySelector('#toast');toast.setAttribute('popover','manual');toast.setAttribute('aria-atomic','true');
 let timer=null,returnFocus=null,canDismiss=false;
 function clear(){clearTimeout(timer);canDismiss=false;if(toast.matches(':popover-open'))toast.hidePopover();toast.hidden=true;toast.replaceChildren();}
 function position(){if(toast.hidden||toast.contains(document.activeElement))return;const focus=document.activeElement?.getBoundingClientRect(),height=toast.getBoundingClientRect().height;const bottom=innerHeight-height-16;const overlap=focus&&focus.bottom>bottom&&focus.top<innerHeight-16;toast.dataset.edge=overlap?'top':'bottom';}
 function notify(message,{tone='success',persistent=tone!=='success',action=null,dismissible=true}={}){
  clear();canDismiss=dismissible;returnFocus=document.activeElement;const modal=[...document.querySelectorAll('dialog[open]')].at(-1),parent=modal??document.body;parent.append(toast);
  toast.dataset.tone=tone;toast.setAttribute('role',tone==='error'||tone==='unknown'?'alert':'status');toast.setAttribute('aria-live',tone==='error'||tone==='unknown'?'assertive':'polite');
  const text=document.createElement('span');text.textContent=message;toast.append(text);
  if(action){const button=document.createElement('button');button.type='button';button.className='btn toast-action';button.textContent=action.label;button.onclick=()=>action.run(button);toast.append(button);}
  if(dismissible){const close=document.createElement('button');close.type='button';close.className='btn toast-action icon-btn';close.setAttribute('aria-label','Dismiss notification');close.append(icon('x'));close.onclick=()=>{clear();if(returnFocus?.isConnected&&!returnFocus.disabled)returnFocus.focus();};toast.append(close);}
  toast.hidden=false;if(typeof toast.showPopover==='function')toast.showPopover();position();if(!persistent)timer=setTimeout(clear,4500);
 }
 document.addEventListener('keydown',event=>{if(event.key!=='Escape'||toast.hidden||!canDismiss||document.querySelector('[role=combobox][aria-expanded=true]'))return;const top=[...document.querySelectorAll('dialog[open]')].at(-1);if(top&&!top.contains(toast))return;event.preventDefault();event.stopImmediatePropagation();const owned=toast.contains(document.activeElement);clear();if(owned&&returnFocus?.isConnected&&!returnFocus.disabled)returnFocus.focus();},true);
 document.addEventListener('focusin',position);window.addEventListener('resize',position);
 return {notify,clear};
}
