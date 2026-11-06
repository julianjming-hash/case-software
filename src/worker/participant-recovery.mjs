// Participant capability recovery: code binding only, never a new join or credential.
import { normalizeCode, JOIN_CODE_LENGTH, isUuidV7, uuidv7Time } from '../shared/ids.mjs';
import { bearer } from './auth.mjs';
import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8'}});
const fail = (error,status) => response({error},status);
const recent = (id) => isUuidV7(id) && Date.now()-uuidv7Time(id)<48*60*60_000 && uuidv7Time(id)<=Date.now()+60_000;
function cancel(reader) {try {Promise.resolve(reader.cancel()).catch(()=>{});}catch {/* Cancellation cannot hold the response. */}}
async function read(request, timeoutMs) {
 if(Number(request.headers.get('content-length')||0)>1024)return {error:'too_large',status:413};
 if(!request.body)return {error:'not_json',status:400};
 const reader=request.body.getReader(), chunks=[];let size=0,timer;
 const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);});
 try {
  for(;;){const next=await Promise.race([reader.read(),deadline]);
   if(next===null){cancel(reader);return {error:'request_timeout',status:408};}
   if(next.done)break;size+=next.value.byteLength;
   if(size>1024){cancel(reader);return {error:'too_large',status:413};}chunks.push(next.value);
  }
 }catch {cancel(reader);return {error:'not_json',status:400};}finally {clearTimeout(timer);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return {body:JSON.parse(new TextDecoder().decode(bytes))};}catch{return {error:'not_json',status:400};}
}
/** Injected DO adapters keep contract tests local and free of network calls. */
export async function recoverParticipant(request,{attempt,blocked,failed,lookup,recover,bodyTimeoutMs=BODY_READ_DEADLINE_MS}) {
 try {
  if(await attempt())return fail('rate_limited',429);
  const token=bearer(request);if(!token||token.length<20||token.length>4096)return fail('unauthorised',401);
  const parsed=await read(request,Number.isSafeInteger(bodyTimeoutMs)&&bodyTimeoutMs>0&&bodyTimeoutMs<=BODY_READ_DEADLINE_MS?bodyTimeoutMs:BODY_READ_DEADLINE_MS);
  if(parsed.error)return fail(parsed.error,parsed.status);
  const body=parsed.body;
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).sort().join(',')!=='code,sessionId'||typeof body.code!=='string'||!recent(body.sessionId))return fail('bad_request',400);
  const code=normalizeCode(body.code,JOIN_CODE_LENGTH);if(!code||code.length!==JOIN_CODE_LENGTH)return fail('bad_request',400);
  const found=await lookup(code);
  if(found?.sessionId!==body.sessionId&&found?.error!=='unknown_code'){
   if(found?.sessionId){if(await blocked())return fail('rate_limited',429);await failed();return fail('code_mismatch',403);}return fail('unavailable',503);
  }
  const result=await recover(body.sessionId,token,code);
  if(result?.error){if(await blocked())return fail('rate_limited',429);if(result.status===401||result.status===403||result.status===404||result.status===410)await failed();return fail(result.error,result.status??503);}
  if(result?.sessionId!==body.sessionId||Object.keys(result).length!==1)return fail('unavailable',503);
  return response({sessionId:body.sessionId});
 }catch{return fail('unavailable',503);}
}
