import {apiUrl} from '../shared/urls.mjs';
export function createIssuesClient({auth,participant=null,isCurrent=()=>true,admin=false,incident=false,fetchImpl=fetch}={}){
 let closed=false;const controllers=new Set(),owner=auth?.sessionGeneration();
 const current=()=>!closed&&isCurrent()&&(!auth||auth.sessionGeneration()===owner);
 async function request(parts=[],{method='GET',body,query,blob=false}={}){
  if(!current())throw new Error('closed');const access=auth?(auth.accessToken()??await auth.restore()):null;if(!current())throw new Error('closed');if(auth&&!access)throw new Error('unauthorised');
  if(query){parts=[...parts,'query'];method='POST';body=query;}
  const url=new URL(apiUrl(location.origin,...(admin?['admin',incident?'incidents':'issues']:['issues']),...parts));
  const c=new AbortController();controllers.add(c);let timer,reader;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(new Error('request_timeout'));},15000);});
  try{const binary=body instanceof Blob;const response=await Promise.race([fetchImpl(url.href,{method,credentials:'omit',cache:'no-store',redirect:'manual',signal:c.signal,
   headers:{authorization:participant?`Participant ${participant.token}`:`Bearer ${access}`,...(participant?{'x-case-session':participant.sessionId}:{}),...(body===undefined?{}:{'content-type':binary?body.type:'application/json'})},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})}),deadline]);
   if(!current())throw new Error('closed');reader=response.body?.getReader();const chunks=[];let size=0;for(;;){const p=await Promise.race([reader.read(),deadline]);if(!current())throw new Error('closed');if(p.done)break;size+=p.value.length;if(size>(blob?5_000_000:262144))throw new Error('bad_response');chunks.push(p.value);}
   const value=new Blob(chunks,{type:response.headers.get('content-type')??''});if(!response.ok){let err;try{err=JSON.parse(await value.text()).error;}catch{}if([401,403].includes(response.status)){close();window.dispatchEvent(new Event('case-issues-denied'));}throw Object.assign(new Error(/^[a-z_]{1,40}$/.test(err)?err:'unavailable'),{status:response.status});}
   if(blob){if(!['image/png','image/jpeg'].includes(value.type))throw new Error('bad_response');return value;}
   return JSON.parse(await value.text());
  }finally{clearTimeout(timer);controllers.delete(c);c.abort();try{void reader?.cancel().catch(()=>{});}catch{}}
 }
 function close(){closed=true;for(const c of controllers)c.abort();controllers.clear();}
 return{request,close,current};
}
