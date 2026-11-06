// Admin publishes only existing immutable versions; draft authoring stays in the Builder contract.
import {isUuidV7} from '../../shared/ids.mjs';
import {isAdminUser,adminAuditPrefix} from './gate.mjs';
import {verifyElevation} from './stepup.mjs';
import {runAuditedAction} from './actions.mjs';
import {withSecurityHeaders} from '../headers.mjs';
import {cleanGroupName,isTint} from '../../shared/groups.mjs';
const reply=(status,body)=>withSecurityHeaders(Response.json(body,{status}));
const fail=(status,error)=>reply(status,{error});
const fields=['case_id','version_id','version_no','title','status','admin_revision'];
// Card 30: a listed row also names its case's workspace and group (Group column, Change group).
const groupFields=['workspace_id','group_id','group_name','tint','group_revision'];
function metadata(row,{listed=false}={}){
 if(!row||!isUuidV7(row.case_id)||!isUuidV7(row.version_id)||!Number.isSafeInteger(row.version_no)||row.version_no<1||
 typeof row.title!=='string'||row.title.length<1||row.title.length>200||!['published','withdrawn'].includes(row.status)||
 !Number.isSafeInteger(row.admin_revision)||row.admin_revision<0||row.admin_revision>9999999997)return null;
 if(listed&&(!isUuidV7(row.workspace_id)||!Number.isSafeInteger(row.group_revision)||row.group_revision<0||
 !(row.group_id===null?row.group_name===null&&row.tint==='neutral':isUuidV7(row.group_id)&&cleanGroupName(row.group_name)===row.group_name&&isTint(row.tint))))return null;
 return Object.fromEntries((listed?[...fields,...groupFields]:fields).map(key=>[key,row[key]]));
}
export async function handleCaseRequest({request,route,user,env,body,rpc,nowMs=()=>Date.now()}){
 if(!isAdminUser(user,env))return fail(403,'forbidden');
 if(!rpc?.call)return fail(503,'admin_unavailable');
 if(route.key==='cases_list'){
  const query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['limit','after'].includes(key))||query.getAll('limit').length>1||query.getAll('after').length>1)return fail(400,'bad_request');
  const limit=query.get('limit')??'100',after=query.get('after');
  if(!/^[1-9][0-9]{0,2}$/.test(limit)||Number(limit)>100||(after!==null&&!isUuidV7(after)))return fail(400,'bad_request');
  const rows=await rpc.call('list_admin_case_versions',{p_limit:Number(limit),p_after:after});
  if(!rows?.ok||!Array.isArray(rows.data)||rows.data.length>Number(limit))return fail(503,'admin_unavailable');
  const versions=rows.data.map(row=>metadata(row,{listed:true}));
  if(versions.some(row=>row===null)||new Set(versions.map(row=>row.version_id)).size!==versions.length)return fail(503,'admin_unavailable');
  return reply(200,{versions,nextCursor:versions.length===Number(limit)?versions.at(-1).version_id:null});
 }
 const withdraw=route.key==='versions_withdraw';
 if(!withdraw&&route.key!=='cases_publish')return fail(400,'bad_request');
 const id=route.pattern.exec(new URL(request.url).pathname)?.[1];
 if(!isUuidV7(id)||!body||Object.keys(body).some(key=>!['expectedRevision',...(withdraw?[]:['versionId'])].includes(key))||
 !Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.expectedRevision>9999999997||(!withdraw&&!isUuidV7(body.versionId)))return fail(400,'bad_request');
 const versionId=withdraw?id:body.versionId;
 const read=await rpc.call('admin_read_case_version',{p_version_id:versionId});
 if(!read?.ok||!Array.isArray(read.data)||read.data.length!==1)return fail(503,'admin_unavailable');
 const before=metadata(read.data[0]);
 if(!before||before.version_id!==versionId)return fail(503,'admin_unavailable');
 if((!withdraw&&before.case_id!==id)||before.admin_revision!==body.expectedRevision||before.status!==(withdraw?'published':'withdrawn'))return fail(409,'conflict');
 // Withdraw and republish both need this session's elevation (red-team item 4; R-a). The compensating
 // reverse write reuses it, so a revert is never refused for want of a step-up.
 const admitted=()=>verifyElevation(request.headers.get('X-Admin-Elevation'),user.email,user.sessionId,env.STEPUP_SECRET);
 const elevation=await admitted();
 if(!elevation)return fail(403,'forbidden');
 const action=withdraw?'withdraw':'publish',nextStatus=withdraw?'withdrawn':'published';
 const change=async(expectedRevision,nextAction)=>{
  const result=await rpc.call('admin_set_version_state',{p_version_id:versionId,p_expected_revision:expectedRevision,p_action:nextAction,
   p_user_id:user.userId,p_admin:true,p_admin_email:user.email,p_elevation_id:elevation.jti});
  if(!result?.ok)return {ok:false,status:['40001','23514'].includes(result?.code)?409:503};
  const row=result.data?.[0];
  if(!Array.isArray(result.data)||result.data.length!==1||row.version_id!==versionId||row.admin_revision!==expectedRevision+1||row.status!==(nextAction==='withdraw'?'withdrawn':'published'))throw new Error('version_write_outcome_unknown');
  return row;
 };
 const result=await runAuditedAction({rpc,action:withdraw?'version_withdraw':'case_publish',targetType:withdraw?'version':'case',targetId:withdraw?versionId:before.case_id,
 actorEmail:user.email,fromPrefix:adminAuditPrefix(request.headers.get('CF-Connecting-IP')),
 before:{status:before.status,admin_revision:before.admin_revision},
 write:async()=>(await admitted())?.jti!==elevation.jti?{ok:false,status:403}:change(before.admin_revision,action),
 after:row=>({status:nextStatus,admin_revision:row.admin_revision}),
 revert:async row=>({ok:(await change(row.admin_revision,withdraw?'publish':'withdraw'))?.version_id===versionId})});
 return result.ok?reply(200,{version:result.result}):fail(result.status,result.error);
}
