// Every irreversible room end retains fresh admin admission after metadata awaits.
import {isUuid,isUuidV7,uuidv7Time} from '../../shared/ids.mjs';
import {isAdminUser,adminAuditPrefix} from './gate.mjs';
import {verifyElevation} from './stepup.mjs';
import {withSecurityHeaders} from '../headers.mjs';
const reply=(status,body)=>withSecurityHeaders(Response.json(body,{status}));
const fail=(status,error)=>reply(status,{error});
export async function handleRoomRequest({request,route,user,env,body,rooms,rpc,nowMs=()=>Date.now()}){
 if(!isAdminUser(user,env))return fail(403,'forbidden');
 if(route.key==='rooms_list'){
  if(!rooms?.read)return fail(503,'admin_unavailable');
  const result=await rooms.read({query:new URL(request.url).searchParams});
  return result?.ok?reply(200,{rooms:result.rooms,nextCursor:result.nextCursor}):fail(result?.status??503,result?.error??'admin_unavailable');
 }
 if(route.key!=='rooms_end'||!body||Object.keys(body).length)return fail(400,'bad_request');
 const sessionId=route.pattern.exec(new URL(request.url).pathname)?.[1];
 if(!isUuidV7(sessionId)||nowMs()-uuidv7Time(sessionId)>=48*3600000||uuidv7Time(sessionId)>nowMs()+60000)return fail(404,'not_found');
 // This admin's elevation for this sign-in session (card 35, R-a).
 const admitted=async()=>Boolean(await verifyElevation(request.headers.get('X-Admin-Elevation'),user.email,user.sessionId,env.STEPUP_SECRET));
 if(!await admitted())return fail(403,'forbidden');
 if(!rooms?.summary||!rooms?.endOne)return fail(503,'admin_unavailable');
 const view=await rooms.summary(sessionId);
 if(view?.error)return fail(view.status??503,view.error==='not_found'?'not_found':'admin_unavailable');
 if(view?.sessionId!==sessionId||!isUuid(view.ownerUserId))return fail(503,'admin_unavailable');
 const result=await rooms.endOne({sessionId,userId:view.ownerUserId,actorEmail:user.email,
  fromPrefix:adminAuditPrefix(request.headers.get('CF-Connecting-IP')),admitted});
 if(!result?.ok)return fail(result?.status===403?403:500,result?.status===403?'forbidden':'manual_reconciliation_needed');
 return reply(200,{ended:true});
}
