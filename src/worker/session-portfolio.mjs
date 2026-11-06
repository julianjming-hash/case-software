// Private account history only. Every page independently checks JWT, account, membership and starter.
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { actorFor, adminArgs, authorizeSessionRecord,authorizePersonalRecordScope,seesEveryRoom } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { isUuid, isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { readJson } from './request-json.mjs';
import { projectSessionRecord } from '../shared/session-record.mjs';
import { imageResponse } from './media-api.mjs';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
const fail=(error,status)=>reply({error},status);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const time=x=>typeof x==='string'&&x.length<=40&&Number.isFinite(Date.parse(x));
const day=x=>x===null||time(x)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&new Date(x).toISOString()===x;
const hash=async x=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(x))))].map(n=>n.toString(16).padStart(2,'0')).join('');
const encode=x=>btoa(String.fromCharCode(...enc.encode(JSON.stringify(x)))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
function decode(x){try{if(typeof x!=='string'||x.length>512||! /^[A-Za-z0-9_-]+$/.test(x))return null;return JSON.parse(dec.decode(Uint8Array.from(atob(x.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-x.length%4)%4)),c=>c.charCodeAt(0))));}catch{return null;}}
const rpcError=r=>r?.code==='42501'?fail('forbidden',403):r?.code==='40001'?fail('record_changed',409):r?.code==='P0002'?fail('not_found',404):r?.code==='22023'?fail('bad_request',400):r?.code==='23514'?fail('record_unavailable',409):fail('unavailable',503);
function summary(row,teaching=false){return exact(row,['id','case_version_id','case_id','title','version_no','status','created_at','started_at','ended_at','expires_at','archive_state','own',...(teaching?['joined','joined_exact']:[])])&&(!teaching||typeof row.joined_exact==='boolean'&&row.joined_exact===(row.archive_state==='complete')&&(row.joined===null&&!row.joined_exact||integer(row.joined)&&row.joined<=1000000))&&['id','case_version_id','case_id'].every(k=>isUuidV7(row[k]))&&typeof row.title==='string'&&row.title.trim()&&row.title.length<=200&&Number.isSafeInteger(row.version_no)&&row.version_no>0&&['lobby','live','ended','expired'].includes(row.status)&&['pending','limited','complete'].includes(row.archive_state)&&typeof row.own==='boolean'&&time(row.created_at)&&time(row.expires_at)&&(row.started_at===null||time(row.started_at))&&(row.ended_at===null||time(row.ended_at));}
export async function handleSessionPortfolio(request,{env,rpc,verifyUser=verifyFacilitatorJwt,onAlert=null}={}){
 const url=new URL(request.url),m=/^\/api\/v1\/portfolio\/(query|stats|record|media|workspaces)$/.exec(url.pathname);if(!m)return null;
 if(request.method!=='POST')return fail('method_not_allowed',405);
 if(url.search||request.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||request.headers.has('origin')&&request.headers.get('origin')!==url.origin)return fail('bad_request',400);
 let user;try{user=await verifyUser(bearer(request),env);}catch(e){if(e instanceof AuthUnavailableError)return fail('auth_unavailable',503);throw e;}
 if(!user||!isUuid(user.userId))return fail('unauthorised',401);
 const actor=actorFor(user,env),inactive=await accountActive(rpc,actor.userId);if(inactive)return fail(inactive.error,inactive.status);
 const input=await readJson(request,4096);if(input.error)return fail(input.error,input.error==='too_large'?413:400);const b=input.body,route=m[1];
 if(route==='workspaces'){
  if(!exact(b,['after'])||!(b.after===null||isUuidV7(b.after)))return fail('bad_request',400);
  const result=await rpc.call('personal_record_workspaces',{p_user_id:actor.userId,p_after:b.after});if(!result?.ok)return rpcError(result);const v=result.data;
  if(!exact(v,['workspaces','nextAfter'])||!Array.isArray(v.workspaces)||v.workspaces.length>100||v.workspaces.some((r,i)=>!exact(r,['id','name'])||!isUuidV7(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>120||(i&&r.id<=v.workspaces[i-1].id)||(b.after&&r.id<=b.after))||!(v.nextAfter===null||v.workspaces.length===100&&v.nextAfter===v.workspaces.at(-1).id))return fail('unavailable',503);
  return reply(v);
 }
 if(route==='record'){
  // v:2 (card 40) asks for the debrief round fields; a client that does not send it gets the original shape.
  if(!(exact(b,['sessionId','after'])||exact(b,['sessionId','after','v'])&&b.v===2)||!isUuidV7(b.sessionId)||!(b.after===null||typeof b.after==='string'))return fail('bad_request',400);
  const context=await hash(['record-v1',actor.userId,b.sessionId]);let position=0,boundary=null;
  if(b.after!==null){const cursor=decode(b.after);if(!exact(cursor,['context','position','boundary'])||cursor.context!==context||!integer(cursor.position)||cursor.position<1||cursor.position>1010000||! /^[a-f0-9]{64}$/.test(cursor.boundary??''))return fail('bad_request',400);position=cursor.position;boundary=cursor.boundary;}
  const result=await rpc.call('read_session_portfolio',{p_user_id:actor.userId,p_session_id:b.sessionId,p_after:position,p_boundary:boundary,...adminArgs(actor)});if(!result?.ok)return rpcError(result);
  let projected;try{projected=projectSessionRecord(result.data,{debrief:b.v===2});}catch{return fail('unavailable',503);}
  if(projected.session.id!==b.sessionId||boundary&&projected.boundary!==boundary||projected.items.some(x=>x.position<=position))return fail('unavailable',503);
  // On the room's own case (CASE-336); every room only on the admin path or for an owner under managers_see_records.
  const permitted=await authorizeSessionRecord(rpc,actor,projected.session,ACTIONS.readSessionRecord,onAlert);if(!permitted.ok)return fail(permitted.error,permitted.status);
  if(!seesEveryRoom(permitted,ACTIONS.readSessionRecord)&&!projected.session.own)return fail('unavailable',503);
  projected.nextAfter=projected.nextPosition===null?null:encode({context,position:projected.nextPosition,boundary:projected.boundary});delete projected.nextPosition;
  return reply(projected);
 }
 // J10 (card 59 M3): one image the session's own version pins, as a JPEG, for the starter's record export. SQL applies the
 // record read's own rules (P-34) and hands out a key for any live image: approval is gone (CASE-342).
 if(route==='media'){
  if(!exact(b,['sessionId','assetId'])||!isUuidV7(b.sessionId)||!isUuidV7(b.assetId))return fail('bad_request',400);
  if(!env.MEDIA)return fail('unavailable',503);
  const result=await rpc.call('session_media_rendition',{p_user_id:actor.userId,p_session_id:b.sessionId,p_asset_id:b.assetId,...adminArgs(actor)});if(!result?.ok)return rpcError(result);
  const row=Array.isArray(result.data)?result.data[0]:null;if(!row)return fail('not_found',404);
  if(!['quarantined','approved'].includes(row.status)||typeof row.r2_key!=='string'||!/^media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.jpg$/.test(row.r2_key))return fail('withdrawn',410);
  const object=await env.MEDIA.get(row.r2_key);if(!object)return fail('withdrawn',410);
  return imageResponse(object.body,object.size,'image/jpeg');
 }
 if(!isUuidV7(b?.workspaceId))return fail('bad_request',400);
 // A case-only runner reads their own rooms of the cases they hold (anyCase; SQL filters, CASE-336).
 const permitted=await authorizePersonalRecordScope(rpc,actor,b.workspaceId,onAlert);if(!permitted.ok)return fail(permitted.error,permitted.status);
 const everyRoom=seesEveryRoom(permitted,ACTIONS.readRoomHistory);
 if(route==='stats'){
  if(!(exact(b,['workspaceId'])||exact(b,['workspaceId','v'])&&b.v===2))return fail('bad_request',400);
  const result=await rpc.call(b.v===2?'personal_teaching_portfolio_stats':'personal_portfolio_stats',{p_user_id:actor.userId,p_workspace_id:b.workspaceId,...adminArgs(actor)});if(!result?.ok)return rpcError(result);const v=result.data;
  if(!exact(v,['asOf','firstSessionAt','sessions','active','ended','completeRecords','uniqueVersions','recordedTeachingSeconds'])||!time(v.asOf)||!(v.firstSessionAt===null||time(v.firstSessionAt))||!['sessions','active','ended','completeRecords','uniqueVersions','recordedTeachingSeconds'].every(k=>integer(v[k]))||v.completeRecords>v.sessions||v.active+v.ended!==v.sessions)return fail('unavailable',503);
  return reply(v);
 }
 const teaching=b.v===2,keys=base=>teaching?[...base,'v']:base;
 if(!(exact(b,keys(['workspaceId','query','status','from','until','after','personal']))||exact(b,keys(['workspaceId','query','status','from','until','after','personal','caseId']))&&isUuidV7(b.caseId))||typeof b.query!=='string'||b.query.length>200||/[\u0000-\u001f\u007f]/.test(b.query)||!['all','running','ended'].includes(b.status)||!day(b.from)||!day(b.until)||b.from!==null&&b.until!==null&&b.from>=b.until||typeof b.personal!=='boolean'||!(b.after===null||typeof b.after==='string'))return fail('bad_request',400);
 const context=await hash([teaching?'portfolio-v2':'portfolio-v1',actor.userId,b.workspaceId,b.query,b.status,b.from,b.until,b.personal,...(b.caseId?[b.caseId]:[])]);let after=null;
 if(b.after!==null){const cursor=decode(b.after);if(!exact(cursor,['context','id'])||cursor.context!==context||!isUuidV7(cursor.id))return fail('bad_request',400);after=cursor.id;}
 const result=await rpc.call(teaching?'query_teaching_session_portfolio':b.caseId?'query_case_session_portfolio':'query_session_portfolio',{...(teaching?{p_case_id:b.caseId??null}:b.caseId?{p_case_id:b.caseId}:{}),p_user_id:actor.userId,p_workspace_id:b.workspaceId,p_query:b.query,p_status:b.status,p_from:b.from,p_until:b.until,p_after:after,p_personal:b.personal,...adminArgs(actor)});if(!result?.ok)return rpcError(result);const v=result.data;
 if(!exact(v,['rooms','nextAfter'])||!Array.isArray(v.rooms)||v.rooms.length>20||v.rooms.some((row,i)=>!summary(row,teaching)||b.caseId&&row.case_id!==b.caseId||(!everyRoom||b.personal)&&!row.own||i&&row.id>=v.rooms[i-1].id||after&&row.id>=after)||v.nextAfter!==null&&(!v.rooms.length||v.nextAfter!==v.rooms.at(-1).id))return fail('unavailable',503);
 return reply({rooms:v.rooms.map(row=>({sessionId:row.id,caseId:row.case_id,caseVersionId:row.case_version_id,title:row.title,versionNo:row.version_no,status:row.status,createdAt:row.created_at,startedAt:row.started_at,endedAt:row.ended_at,expiresAt:row.expires_at,archiveState:row.archive_state,own:row.own,...(teaching?{joined:row.joined,joinedExact:row.joined_exact}:{})})),nextAfter:v.nextAfter===null?null:encode({context,id:v.nextAfter})});
}
