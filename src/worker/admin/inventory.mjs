// Directory-derived, explicitly paginated live inventory. No private participant projection.
import {isUuid,isUuidV7} from '../../shared/ids.mjs';
import {parseAdminRoomsCursor} from '../../shared/urls.mjs';
import {MAX_PARTICIPANTS,PHASES} from '../../shared/room-machine.mjs';
const SHARDS=[...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const phases=new Set(PHASES.filter(phase=>phase!=='ended'));
const unavailable=()=>({ok:false,status:503,error:'admin_unavailable'});
export async function readAdminInventory({query,directoryFor,roomFor,gotrue,timeoutMs=10000}){
 if([...query.keys()].some(key=>!['limit','after'].includes(key))||query.getAll('limit').length>1||query.getAll('after').length>1)return {ok:false,status:400,error:'bad_request'};
 let cursor;try{cursor=parseAdminRoomsCursor(query.get('after'));}catch{return {ok:false,status:400,error:'bad_request'};}
 const rawLimit=query.get('limit')??'100';
 if(!/^[1-9][0-9]{0,2}$/.test(rawLimit)||Number(rawLimit)>100)return {ok:false,status:400,error:'bad_request'};
 if(typeof directoryFor!=='function'||typeof roomFor!=='function'||!gotrue?.getUser)return unavailable();
 const limit=Number(rawLimit),rooms=[],owners=new Map(),seen=new Set(),deadline=performance.now()+timeoutMs;
 async function bounded(operation){
  let timer;const remaining=deadline-performance.now();if(remaining<=0)throw new Error('inventory_timeout');
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('inventory_timeout')),remaining);})]);}
  finally{clearTimeout(timer);}
 }
 try{
  let shardIndex=SHARDS.indexOf(cursor.shard),afterCode=cursor.afterCode;
  while(shardIndex<SHARDS.length){
   const shard=SHARDS[shardIndex],key=`${shard}:${afterCode??''}`;
   if(seen.has(key))return unavailable();seen.add(key);
   const page=await bounded(()=>directoryFor(shard).adminInventory({limit:limit-rooms.length,afterCode}));
   if(!page||!Array.isArray(page.rows)||page.rows.length>limit-rooms.length)return unavailable();
   if(page.nextCode!==null){
    const next=parseAdminRoomsCursor(`${shard}:${page.nextCode}`);
    if(next.afterCode===afterCode||!page.rows.length||page.rows.at(-1).code!==next.afterCode)return unavailable();
   }
   for(const entry of page.rows){
    parseAdminRoomsCursor(`${shard}:${entry.code}`);
    if(!isUuidV7(entry.sessionId)||!Number.isFinite(Date.parse(entry.expiresAt))||
       !(entry.registeredAt===null||Number.isFinite(Date.parse(entry.registeredAt))))return unavailable();
    const view=await bounded(()=>roomFor(entry.sessionId).adminSummary(entry.sessionId));
    if(view?.error==='not_found'||view?.status==='ended')continue;
    if(view?.sessionId!==entry.sessionId||!isUuid(view.ownerUserId)||view.status!=='live'||!phases.has(view.phase)||
       !Number.isInteger(view.participantCount)||view.participantCount<0||view.participantCount>MAX_PARTICIPANTS)return unavailable();
    if(!owners.has(view.ownerUserId)){
     const user=await bounded(()=>gotrue.getUser(view.ownerUserId));
     if(user?.ok&&user.user?.id===view.ownerUserId&&typeof user.user.email==='string'&&user.user.email.length<=320)owners.set(view.ownerUserId,user.user.email);
     else if(user?.kind==='not_found')owners.set(view.ownerUserId,null);
     else return unavailable();
    }
    rooms.push({code:entry.code,sessionId:entry.sessionId,registeredAt:entry.registeredAt,expiresAt:entry.expiresAt,
     ownerEmail:owners.get(view.ownerUserId),phase:view.phase,participantCount:view.participantCount});
   }
   if(rooms.length===limit)return {ok:true,rooms,nextCursor:page.nextCode!==null?`${shard}:${page.nextCode}`:SHARDS[shardIndex+1]??null};
   if(page.nextCode!==null){afterCode=page.nextCode;continue;}
   shardIndex++;afterCode=null;
  }
  return {ok:true,rooms,nextCursor:null};
 }catch{return unavailable();}
}
