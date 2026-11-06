// A BFCache document has already completed pagehide cleanup. Reload the same
// token-free route so normal participant validation runs before private UI.
export function installPhonePageRestore({events=window,reload=()=>location.reload()}={}) {
 let restoring=false;
 const onShow=event=>{if(event.persisted===true&&!restoring){restoring=true;reload();}};
 events.addEventListener('pageshow',onShow);
 return ()=>events.removeEventListener('pageshow',onShow);
}
