// Public pages load this only on an explicit menu open. Reuse the existing Auth recovery/tab lifecycle.
import { mountAccount, accountRequest } from './auth-ui.mjs';
import { menuIdentity } from './navigation-access.mjs';
import { savedManualKey } from './console-manual-storage.mjs';
export function createMenuAccount(onChange=()=>{}) {
 let ui=null,ready=null,disposed=false,identity=null,resolveLoad=null,rejectLoad=null;
 const host=document.createElement('div');
 const accept=value=>{if(disposed)return;identity=value;onChange(value);resolveLoad?.(value);};
 const refuse=error=>{if(disposed)return;ready=null;rejectLoad?.(error);};
 async function read(auth){try{const me=await accountRequest(auth,['me'],{query:new URLSearchParams({limit:'20'})});accept(menuIdentity(me,()=>ui.signOut.click()));}catch(error){refuse(error);}}
 function load(){
  if(disposed)return Promise.resolve(null);
  if(identity&&ui?.auth.accessToken())return Promise.resolve(identity);
  if(ready)return ready.then(()=>identity);
  ready=new Promise((resolve,reject)=>{resolveLoad=resolve;rejectLoad=reject;});
  if(!ui)ui=mountAccount(host,{idleText:'',preserveSessionKeys:()=>{const key=savedManualKey();return key?[key]:[];},
   onStateChange(state){if(state==='signed-out')accept(null);else if(state==='unavailable')refuse(new Error('account_unavailable'));},
   onSignedOut(){accept(null);},onSignedIn:auth=>void read(auth)});
  else if(ui.auth.accessToken())void read(ui.auth);
  else void ui.auth.restore().then(access=>{if(access)return read(ui.auth);if(ui.auth.hasSavedSession())refuse(new Error('account_unavailable'));else accept(null);}).catch(refuse);
  return ready;
 }
 return {load,dispose(){resolveLoad?.(null);disposed=true;identity=null;host.replaceChildren();}};
}
