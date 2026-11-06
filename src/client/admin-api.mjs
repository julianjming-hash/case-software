import {adminApiUrl} from '../shared/urls.mjs';
import {acceptAdminResponse} from './admin-schema.mjs';
const READS=new Set(['facilitators_list','rooms_list']);
const ERRORS=new Set(['bad_request','unauthorised','forbidden','request_timeout','conflict','too_large','unsupported_media_type','rate_limited','admin_unavailable','audit_unavailable','change_reverted_audit_unavailable','manual_reconciliation_needed','not_found','code_rejected','step_up_required']);
const failure=(error,status=0)=>({ok:false,status,error});
export function createAdminApi({origin,auth,fetchImpl=fetch,timeoutMs=10000}={}){
 let closed=false;const controllers=new Set();
 return {
  close(){closed=true;for(const c of controllers)c.abort();controllers.clear();},
  async call(operation,{options={},body={},elevation=null}={}){
   const generation=auth.sessionGeneration(),current=()=>!closed&&generation===auth.sessionGeneration();
   if(!current())return failure('closed');
   const access=auth.accessToken()??await auth.restore();if(!access)return failure('unauthorised',401);
   let url;try{url=adminApiUrl(origin,operation,options);}catch{return failure('bad_request',400);}
   const controller=new AbortController();controllers.add(controller);let timer,reader;
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('request_timeout'));},timeoutMs);});
   try{
    const read=READS.has(operation),headers={authorization:`Bearer ${access}`,...(read?{}:{'content-type':'application/json'}),...(elevation?{'X-Admin-Elevation':elevation}:{})};
    const response=await Promise.race([fetchImpl(url,{method:read?'GET':'POST',headers,credentials:'omit',cache:'no-store',redirect:'manual',signal:controller.signal,...(read?{}:{body:JSON.stringify(body)})}),deadline]);
    if(!current())return failure('closed');
    if(response.status===401){await Promise.race([auth.handle401(),deadline]);return failure('unauthorised',401);}
    if(response.status>=300&&response.status<400)return failure('admin_unavailable',503);
    let raw='',size=0;const decoder=new TextDecoder();
    if(response.body){reader=response.body.getReader();while(true){const chunk=await Promise.race([reader.read(),deadline]);if(!current())return failure('closed');if(chunk.done)break;size+=chunk.value.byteLength;if(size>262144)return failure('admin_unavailable',503);raw+=decoder.decode(chunk.value,{stream:true});}raw+=decoder.decode();}
    if(!current())return failure('closed');
    let value;try{value=JSON.parse(raw);}catch{return failure('admin_unavailable',503);}
    if(!response.ok)return failure(value&&Object.keys(value).length===1&&ERRORS.has(value.error)?value.error:'admin_unavailable',response.status);
    const accepted=acceptAdminResponse(operation,value);return accepted?{ok:true,data:accepted}:failure('admin_unavailable',503);
   }catch(error){return failure(!current()?'closed':error?.message==='request_timeout'?'request_timeout':'admin_unavailable',503);}
   finally{clearTimeout(timer);controllers.delete(controller);try{void reader?.cancel().catch(()=>{});}catch{}controller.abort();}
  },
 };
}
