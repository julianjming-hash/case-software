// Trusted build-time stylesheet URLs only; share in-flight loads and retry real failures.
const loads=new Map();
export function loadPrivateStyle(href,doc=document){
 const present=[...doc.querySelectorAll('link[rel=stylesheet]')].find(link=>link.href===href);
 if(present?.sheet)return Promise.resolve();
 if(loads.has(href))return loads.get(href);
 const pending=new Promise((resolve,reject)=>{
  const link=present??doc.createElement('link');let timer,done=false;
  const finish=error=>{if(done)return;done=true;clearTimeout(timer);link.removeEventListener('load',loaded);link.removeEventListener('error',failed);if(error){link.remove();reject(Error('private_styles_unavailable'));}else resolve();};
  const loaded=()=>finish(false),failed=()=>finish(true);
  link.rel='stylesheet';link.href=href;link.addEventListener('load',loaded,{once:true});link.addEventListener('error',failed,{once:true});timer=setTimeout(failed,10000);if(!present)doc.head.append(link);
 });
 loads.set(href,pending);const clear=()=>{if(loads.get(href)===pending)loads.delete(href);};void pending.then(clear,clear);return pending;
}
