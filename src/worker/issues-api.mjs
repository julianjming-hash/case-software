// Dedicated beta-report boundary: no teaching-feedback keys and no public guest path.
import {bearer,verifyFacilitatorJwt} from './auth.mjs';
import {isAdminUser,adminEmails} from './admin/gate.mjs';
import {accountActive} from './admin/account-active.mjs';
import {issueDraft,issueDigest,issueOperationCurrent,issueHex,exact,ISSUE_STATES,ISSUE_SEVERITIES,ISSUE_PRIORITIES} from '../shared/issues.mjs';
import {isUuidV7,newJoinCode,uuidv7Time} from '../shared/ids.mjs';
import {cleanText} from '../shared/text.mjs';
import {inspectIssueImage} from './issue-images.mjs';
const deploymentOf=env=>['production','staging'].includes(env?.CASE_ENV)?env.CASE_ENV:'local';
const response=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(status===429?{'retry-after':'3600'}:{})}});
const fail=(error,status)=>response({error},status);
export const isIssuesPath=path=>/^\/api\/v1\/(?:issues|admin\/(?:issues|incidents))(?:\/|$)/.test(path);
export async function issueReadBytes(request,max,timeoutMs=10000){
 if(Number(request.headers.get('content-length'))>max)throw new Error('too_large');
 if(!request.body)throw new Error('bad_request');let reader,timer,size=0;const chunks=[];
 try{reader=request.body.getReader();const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('request_timeout')),timeoutMs);});for(;;){const p=await Promise.race([reader.read(),deadline]);if(p.done)break;size+=p.value.length;if(size>max)throw new Error('too_large');chunks.push(p.value);}const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;
 }finally{clearTimeout(timer);try{void reader?.cancel().catch(()=>{});}catch{}}
}
const incidentAdmin=(user,env)=>isAdminUser(user,env)&&typeof env.INCIDENT_ADMIN_EMAILS==='string'&&env.INCIDENT_ADMIN_EMAILS.split(',').map(s=>s.trim()).filter(Boolean).length===1&&env.INCIDENT_ADMIN_EMAILS.trim()===user.email;
export async function handleIssuesApi(request,{env,rpc,roomFor,verifyUser=verifyFacilitatorJwt,attempt=async()=>false}={}){
 const path=new URL(request.url).pathname;if(!isIssuesPath(path))return null;
 const queryMode=path.endsWith('/query'),routePath=queryMode?path.slice(0,-6):path;
 const route=/^\/api\/v1\/(issues|admin\/issues|admin\/incidents)(?:\/([0-9a-f-]+)(?:\/(receipt|accept|triage|files)(?:\/([0-9a-f-]+))?)?)?$/.exec(routePath);
 if(!route)return fail('not_found',404);
 const [,section,id,part,fileId]=route,adminView=section!=='issues',incidentView=section==='admin/incidents';
 if((id&&!isUuidV7(id))||(fileId&&!isUuidV7(fileId)))return fail('not_found',404);
 const write=request.method!=='GET';
 if(!['GET','POST','PUT'].includes(request.method))return fail('method_not_allowed',405);
 if(write&&request.headers.get('origin')!==env.CASE_PUBLIC_ORIGIN)return fail('forbidden',403);
 if(write&&!(part==='files'&&fileId)&&!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return fail('unsupported_media_type',415);
 if(await attempt())return fail('rate_limited',429);
 let actor;
 try{
  const participant=/^Participant ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get('authorization')??'');
  if(participant){if(adminView)return fail('forbidden',403);const sid=request.headers.get('x-case-session');if(!isUuidV7(sid)||Date.now()-uuidv7Time(sid)>259_200_000||uuidv7Time(sid)>Date.now()+60000)return fail('unauthorised',401);
   const proof=await roomFor(sid).issueRespondent(participant[1],sid);if(proof?.error)return fail('unauthorised',401);
   if(!/^[a-f0-9]{64}$/.test(proof?.respondent))return fail('unavailable',503);actor={principal:`room:${proof.respondent}`,sessionId:sid,admin:false,incident:false};
  }else{const user=await verifyUser(bearer(request),env);if(!user)return fail('unauthorised',401);const denied=await accountActive(rpc,user.userId);if(denied)return fail(denied.error,denied.status);
   actor={principal:`user:${user.userId}`,userId:user.userId,email:user.email,admin:isAdminUser(user,env),incident:incidentAdmin(user,env)};
  }
 }catch{return fail('auth_unavailable',503);}
 if(adminView&&(!actor.admin||(incidentView&&!actor.incident)))return fail('forbidden',403);
 actor.deployment=deploymentOf(env);
 const scope={adminView,incidentView};
 const call=async(action,input)=>{const r=await rpc.call('beta_issue_dispatch',{p_actor:actor,p_action:action,p_input:{...scope,...input,serverBuild:/^[a-f0-9]{40}$/.test(env.BUILD_SHA??'')?env.BUILD_SHA:null,environment:['production','staging'].includes(env.CASE_ENV)?env.CASE_ENV:'unknown'}});if(!r?.ok)return{error:'unavailable',status:503};return r.data;};
 const done=v=>v?.error?fail(v.error,[400,401,403,404,409,410,429,503].includes(v.status)?v.status:503):response(v);
 let input={};
 try{if(write&&!(part==='files'&&fileId))input=JSON.parse(new TextDecoder().decode(await issueReadBytes(request,32768)));}catch(e){return fail(e.message==='too_large'?'too_large':'bad_request',e.message==='too_large'?413:400);}
 try{
  if(!id&&request.method==='POST'&&!adminView&&!queryMode){let draft;try{draft=issueDraft(input);}catch{return fail('bad_request',400);}if(!issueOperationCurrent(draft.operationId))return fail('operation_expired',409);return done(await call('reserve',{draft,digest:await issueDigest(draft),reference:newJoinCode()}));}
  if(!id&&(request.method==='GET'||(queryMode&&request.method==='POST'))){
   const keys=['query','status','severity','owner','build','reproducibility','duplicates','cursor'];
   if(new URL(request.url).search||!exact(input,keys))return fail('bad_request',400);
   const filters={};for(const key of keys){if(key==='cursor'){if(input.cursor!==undefined){if(JSON.stringify(input.cursor).length>2048)return fail('bad_request',400);filters.cursor=input.cursor;}continue;}const value=input[key]??'';if(typeof value!=='string'||value.length>160)return fail('bad_request',400);filters[key]=value;}
   return done(await call('list',filters));
  }
  if(id&&!part&&request.method==='GET')return done(await call('read',{id}));
  if(id&&['receipt','accept'].includes(part)&&request.method==='POST'&&!adminView){if(!exact(input,['digest'])||!/^[a-f0-9]{64}$/.test(input.digest))return fail('bad_request',400);return done(await call(part,{id,digest:input.digest}));}
  if(id&&part==='triage'&&adminView&&request.method==='POST'){
   if(!exact(input,['expectedRevision','change'])||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!exact(input.change,['status','severity','priority','owner','reproducibility','verified_build','summary','reviewedNonpersonal','duplicate_of','note','publicReply','restrict']))return fail('bad_request',400);
   const c=input.change;if(c.restrict!==undefined&&c.restrict!==true)return fail('bad_request',400);for(const [key,values]of [['status',ISSUE_STATES],['severity',ISSUE_SEVERITIES],['priority',ISSUE_PRIORITIES],['reproducibility',['unknown','not_attempted','reproduced','not_reproduced']]])if(c[key]!==undefined&&!values.includes(c[key]))return fail('bad_request',400);
   for(const [key,max]of [['owner',320],['verified_build',40],['summary',2000],['note',2000],['publicReply',2000]])if(c[key]!==undefined){if(typeof c[key]!=='string'||[...c[key]].length>max)return fail('bad_request',400);c[key]=cleanText(c[key],max);}
   if(c.reviewedNonpersonal!==undefined&&typeof c.reviewedNonpersonal!=='boolean')return fail('bad_request',400);
   if(c.duplicate_of!==undefined&&c.duplicate_of!==''&&!isUuidV7(c.duplicate_of))return fail('bad_request',400);
   const owners=[...(adminEmails(env)??[])].filter(email=>!incidentView||email===env.INCIDENT_ADMIN_EMAILS?.trim());
   return done(await call('triage',{id,...input,eligibleOwners:owners}));
  }
  if(id&&part==='files'&&fileId&&['PUT','GET'].includes(request.method)){
   if(!env.MEDIA)return fail('unavailable',503);const upload=request.method==='PUT';if(upload&&adminView)return fail('forbidden',403);
   const allowed=await call(upload?'upload':'file',{id,fileId});if(allowed?.error)return done(allowed);
   if(!/^issues\/[0-9a-f-]+\/[0-9a-f-]+$/.test(allowed?.key))return fail('unavailable',503);
   if(upload){if(request.headers.get('content-type')!==allowed.type)return fail('unsupported_media_type',415);
    let bytes;try{bytes=await issueReadBytes(request,5_000_000);}catch(e){return fail(e.message==='too_large'?'too_large':'bad_request',e.message==='too_large'?413:400);}
    if(bytes.length!==allowed.bytes||issueHex(await crypto.subtle.digest('SHA-256',bytes))!==allowed.sha256||!await inspectIssueImage(bytes,allowed.type))return fail('invalid_image',422);
    await env.MEDIA.put(allowed.key,bytes,{httpMetadata:{contentType:allowed.type}});
    const stored=await call('stored',{id,fileId});if(stored?.error){await env.MEDIA.delete(allowed.key);return done(stored);}return response({stored:true,id:fileId});
   }
   const object=await env.MEDIA.get(allowed.key);if(!object)return fail('not_found',404);
   // Recheck after storage latency: revoked accounts/incident configuration/expiry cannot serve a stale object.
   const gate=await handleIssuesRecheck(request,{env,rpc,actor,verifyUser,call,id,fileId,adminView,incidentView,roomFor});if(gate)return gate;
   return new Response(object.body,{headers:{'content-type':allowed.type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'content-disposition':'inline; filename="screenshot"'}});
  }
  return fail('not_found',404);
 }catch{return fail('unavailable',503);}
}
async function handleIssuesRecheck(request,{env,rpc,actor,verifyUser,call,id,fileId,adminView,incidentView,roomFor}){
 if(!actor.userId){const token=/^Participant ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get('authorization')??'');const proof=token?await roomFor(actor.sessionId).issueRespondent(token[1],actor.sessionId):null;if(!proof||`room:${proof.respondent}`!==actor.principal)return fail('forbidden',403);}
 if(actor.userId){const user=await verifyUser(bearer(request),env);if(!user||user.userId!==actor.userId||(adminView&&(!isAdminUser(user,env)||(incidentView&&!incidentAdmin(user,env)))))return fail('forbidden',403);const denied=await accountActive(rpc,user.userId);if(denied)return fail(denied.error,denied.status);}
 const next=await call('file',{id,fileId});return next?.error?fail('not_found',404):null;
}
export async function sweepIssues({rpc,store,deployment='local'}){
 const sweep=(p_action,p_input={})=>rpc.call('beta_issue_sweep',{p_action,p_input:{...p_input,deployment}});
 const purge=await sweep('purge');if(!purge?.ok)return false;
 if(!store)return false;
 for(let page=0;page<4;page++){
  const due=await sweep('deletes');if(!due?.ok||!Array.isArray(due.data)||due.data.length>1000||due.data.some(key=>typeof key!=='string'||!/^issues\/[0-9a-f-]+\/[0-9a-f-]+$/.test(key)))return false;
  if(!due.data.length)break;await store.delete(due.data);const ack=await sweep('deleted',{keys:due.data});if(!ack?.ok)return false;if(due.data.length<1000)break;
 }
 // Crash-after-put orphans cannot outlive a bounded periodic sweep; uploads close after 24h.
 const cursor=await sweep('cursor');if(!cursor?.ok||(cursor.data!==null&&typeof cursor.data!=='string'))return false;
 const objects=await store.list({prefix:'issues/',limit:200,...(cursor.data?{cursor:cursor.data}:{})});
 for(const object of objects.objects??[]){if(!Number.isFinite(Date.parse(object.uploaded)))return false;if(Date.parse(object.uploaded)>Date.now()-90_000_000)continue;const known=await sweep('known',{key:object.key});if(!known?.ok)return false;if(known.data===false)await store.delete(object.key);}
 const advanced=await sweep('advance',{cursor:objects.truncated?objects.cursor:null});return advanced?.ok===true;
}
