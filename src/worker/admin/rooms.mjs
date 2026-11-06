// Server-only owned-room termination. Prefetch cursors while their rows are still active.
import {isUuid,isUuidV7,uuidv7} from '../../shared/ids.mjs';
import {runAuditedAction} from './actions.mjs';
const failure=()=>({ok:false,error:'manual_reconciliation_needed'});
const code=value=>typeof value==='string'&&/^[0-9A-HJKMNP-TV-Z]{6}$/.test(value);
export function createAdminRooms({rpc,roomFor,nowMs=()=>performance.now(),budgetMs=10000}) {
 const duration=Number.isFinite(budgetMs)&&budgetMs>0?Math.min(budgetMs,10000):10000;
 async function bounded(deadline,operation) {
  const remaining=deadline-nowMs();if(remaining<=0)throw new Error('admin_deadline');
  let timer;try{const value=await Promise.race([Promise.resolve().then(()=>{
   if(nowMs()>=deadline)throw new Error('admin_deadline');return operation();
  }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('admin_deadline')),remaining);})]);if(nowMs()>=deadline)throw new Error('admin_deadline');return value;}
  finally{clearTimeout(timer);}
 }
 async function endOne({sessionId,userId,actorEmail,fromPrefix,admitted=()=>true},deadline=nowMs()+duration) {
  try {
  if(!isUuidV7(sessionId)||!isUuid(userId)||!rpc?.call||typeof roomFor!=='function')return failure();
  const room=roomFor(sessionId),view=await bounded(deadline,()=>room.adminSummary(sessionId));
  if(view?.sessionId!==sessionId||view.ownerUserId!==userId||!['live','ended'].includes(view.status))return failure();
  if(!await bounded(deadline,admitted))return {ok:false,status:403,error:'forbidden'};
  const result=await runAuditedAction({rpc:{call:(...args)=>bounded(deadline,()=>rpc.call(...args))},action:'room_end',targetType:'room',targetId:sessionId,
   actorEmail,fromPrefix,before:{status:view.status==='ended'?'ended':'active'},irreversible:true,
   write:async()=>{
    if(!await bounded(deadline,admitted))return {ok:false,status:403};
    const ended=await bounded(deadline,()=>room.adminEnd({sessionId,expectedOwnerUserId:userId,eventId:uuidv7()}));
    if(ended?.ok!==true||ended.status!=='ended')throw new Error('room_end_outcome_unknown');
    return ended;
   },after:()=>({status:'ended'})});
  return result.ok?{ok:true}:result;
  } catch { return failure(); }
 }
 async function endOwned({userId,actorEmail,fromPrefix,admitted=()=>true}) {
  if(!isUuid(userId)||!rpc?.call)return failure();
  const deadline=nowMs()+duration,seen=new Set();
  async function read(after) {
   if(nowMs()>=deadline)return null;
   const result=await bounded(deadline,()=>rpc.call('list_owned_active_sessions',{p_user_id:userId,p_limit:100,p_after:after,
    // Admin view (R-c): every live room the account started, including where it is no longer a member.
    p_admin:true,p_admin_email:actorEmail}));
   if(!result?.ok||!Array.isArray(result.data)||result.data.length>100||nowMs()>=deadline)return null;
   for(const row of result.data){
    if(!isUuidV7(row.session_id)||!code(row.join_code)||!Number.isFinite(Date.parse(row.expires_at))||seen.has(row.session_id))return null;
    seen.add(row.session_id);
   }
   return result.data;
  }
  try {
   let page=await read(null);
   while(page){
    // Ending a cursor row can invalidate the SQL active-room cursor; read its successor first.
    const next=page.length===100?await read(page.at(-1).session_id):[];
    if(next===null)return failure();
    for(const row of page){
     if(nowMs()>=deadline)return failure();
     const result=await endOne({sessionId:row.session_id,userId,actorEmail,fromPrefix,admitted},deadline);
     if(!result.ok)return failure();
    }
    if(!next.length)return {ok:true};
    page=next;
   }
  } catch { return failure(); }
  return failure();
 }
 return {endOne,endOwned,summary:async sessionId=>{try{return await bounded(nowMs()+duration,()=>roomFor(sessionId).adminSummary(sessionId));}catch{return null;}}};
}
