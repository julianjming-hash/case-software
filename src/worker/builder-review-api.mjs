// Pending review actions. SQL is the authority for revision, digest, entitlement and idempotent release.
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { isUuid, isUuidV7 } from '../shared/ids.mjs';
import { builderPublicationIssues } from '../shared/builder-publication.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { actorFor, adminArgs, authorize } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';

const MAX_WIRE=2*1_048_576;
const fail=(error,status)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const revision=x=>Number.isSafeInteger(x)&&x>=0;
const digest=x=>typeof x==='string'&&/^\\x[0-9a-f]{64}$/i.test(x);

async function readBounded(request,parseJson) {
  const length=request.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>MAX_WIRE)return {error:'too_large'};
  if(!request.body||typeof parseJson!=='function')return {error:'not_json'};
  const reader=request.body.getReader(),chunks=[];let bytes=0,timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),BODY_READ_DEADLINE_MS);});
  try {
    for(;;){const next=await Promise.race([reader.read(),deadline]);if(next===null){try{void reader.cancel();}catch{}return {error:'request_timeout'};}
      if(next.done)break;if(!(next.value instanceof Uint8Array)||bytes+next.value.byteLength>MAX_WIRE){try{void reader.cancel();}catch{}return {error:'too_large'};}
      chunks.push(next.value);bytes+=next.value.byteLength;}
  } catch{return {error:'not_json'};} finally{clearTimeout(timer);}
  const merged=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  try{const parsed=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(merged),{maxBytes:MAX_WIRE,maxDepth:32,maxNodes:100_000});return parsed?.ok?{body:parsed.value}:{error:parsed?.error?.code==='too_large'?'too_large':'not_json'};}catch{return {error:'not_json'};}
}
function fromRpc(name,result,onAlert){if(result?.ok)return null;const mapped=rpcFailure(name,result,onAlert);return fail(mapped.error,mapped.status);}
function oneRow(name,result,onAlert){const response=fromRpc(name,result,onAlert);if(response)return {response};if(!Array.isArray(result.data)||result.data.length!==1||!record(result.data[0]))return {response:fail('unavailable',503)};return {row:result.data[0]};}
// One read of the caller's access to this case (CASE-336/337/338): the workspace from the case row, the membership,
// a live grant on this case, and the workspace's policies, so an author releases only under editors_publish and an owner
// approves and releases. SQL decides again (authorize_case).
async function entitled(rpc,actor,caseId,action,onAlert){
  const access=await authorize(rpc,actor,{caseId},action,onAlert);
  return access.ok?null:fail(access.error==='not_found'?'forbidden':access.error,access.status===404?403:access.status);
}
function validateRows(name,result,onAlert,validate){const response=fromRpc(name,result,onAlert);if(response)return {response};if(!Array.isArray(result.data)||!result.data.every(validate))return {response:fail('unavailable',503)};return {rows:result.data};}

/** Route adapter is mounted by index.mjs after the reviewed C42 route. */
export async function handleBuilderReviewApi(request,{
  rpc,env,onAlert,verifyUser=verifyFacilitatorJwt,parseJson,validateDraft,hashSources,
}){
  const path=new URL(request.url).pathname.replace(/\/+$/,'');
  const match=/^\/api\/v1\/builder\/cases\/([0-9a-f-]{36})(?:\/(candidates|readiness)(?:\/([0-9a-f-]{36})(?:\/(approve|cancel|release|body))?)?)?$/.exec(path);
  if(!match)return null;
  const caseId=match[1],collection=match[2],candidateId=match[3],action=match[4],method=request.method;
  if(!isUuidV7(caseId)||(candidateId&&!isUuidV7(candidateId)))return fail('bad_request',400);
  if(!rpc||typeof rpc.call!=='function')return fail('unavailable',503);
  let user;try{user=await verifyUser(bearer(request),env);}catch(error){if(error instanceof AuthUnavailableError)return fail('auth_unavailable',503);throw error;}
  if(!user)return fail('unauthorised',401);
  const active=await accountActive(rpc,user.userId);if(active)return fail(active.error,active.status);
  const actor=actorFor(user,env);
  const permission=action==='release'?ACTIONS.publish:action==='approve'||(candidateId&&method==='GET')?ACTIONS.approveReview:ACTIONS.draft;
  const denied=await entitled(rpc,actor,caseId,permission,onAlert);if(denied)return denied;
  const args={p_case_id:caseId,p_user_id:actor.userId,...adminArgs(actor)};

  if(collection==='readiness'&&!candidateId&&method==='POST'){
    const parsed=await readBounded(request,parseJson); if(parsed.error)return fail(parsed.error,400);
    if(!record(parsed.body)||Object.keys(parsed.body).join(',')!=='revision'||!revision(parsed.body.revision))return fail('bad_request',400);
    const saved=oneRow('builder_get_draft',await rpc.call('builder_get_draft',args),onAlert); if(saved.response)return saved.response;
    const row=saved.row;
    if(row.revision!==parsed.body.revision)return json({revision:row.revision,ready:false,issues:[{code:'revision_conflict',message:'Save and reload the current draft before publishing.'}]});
    if(!record(row.document)||!record(row.authoring_metadata)||typeof validateDraft!=='function'||typeof hashSources!=='function')return fail('unavailable',503);
    const validation=validateDraft(row.document,row.authoring_metadata,{mode:'ready'});
    const issues=builderPublicationIssues(row.document,row.authoring_metadata,validation);
    try {if(!await hashSources(row.authoring_metadata))issues.push({code:'source_digest_mismatch',message:'A source changed. Save it again before publishing.'});}catch{return fail('unavailable',503);}
    const result=await rpc.call('builder_publication_readiness',{...args,p_expected_revision:parsed.body.revision});
    const labels={revision_conflict:'The saved draft changed. Reload it before publishing.',builder_review_metadata_unresolved:'Resolve source rights and source traces before publishing.',builder_candidate_history_limit:'The retained submission history is full.',builder_retained_candidate_limit:'Delete an old retained candidate body before submitting another revision.',builder_storage_quota:'The workspace or project storage limit blocks publishing.',asset_not_approved:'An image is missing, belongs to another workspace, or was taken down.'};
    const resources=validateRows('builder_publication_readiness',result,onAlert,item=>Object.hasOwn(labels,item?.code));
    if(resources.response)return resources.response;
    for(const item of resources.rows)issues.push({code:item.code,message:labels[item.code]});
    return json({revision:parsed.body.revision,ready:issues.length===0,issues});
  }

  if(collection==='candidates'&&!candidateId&&method==='GET'){
    const result=await rpc.call('builder_list_candidates',args);
    const parsed=validateRows('builder_list_candidates',result,onAlert,row=>isUuidV7(row?.candidate_id)&&revision(row.revision)&&['pending','approved','superseded','cancelled','released'].includes(row.status)&&typeof row.submitted_at==='string'&&(row.approved_at===null||typeof row.approved_at==='string')&&(row.released_version_id===null||isUuidV7(row.released_version_id)));
    if(parsed.response)return parsed.response;if(parsed.rows.length>1000)return fail('unavailable',503);
    return json({candidates:parsed.rows.map(row=>({candidateId:row.candidate_id,revision:row.revision,status:row.status,submittedAt:row.submitted_at,approvedAt:row.approved_at,releasedVersionId:row.released_version_id}))});
  }
  if(collection==='candidates'&&!candidateId&&method==='POST'){
    const parsed=await readBounded(request,parseJson);if(parsed.error)return fail(parsed.error,parsed.error==='too_large'?413:parsed.error==='request_timeout'?408:400);
    const body=parsed.body;
    if(!record(body)||Object.keys(body).sort().join(',')!=='authoringMetadata,document,requestId,revision'||!isUuidV7(body.requestId)||!revision(body.revision)||body.revision<1||!record(body.document)||!record(body.authoringMetadata))return fail('bad_request',400);
    if(typeof validateDraft!=='function')return fail('unavailable',503);
    const valid=validateDraft(body.document,body.authoringMetadata,{mode:'ready'});
    if(!valid?.ok)return json({error:'not_ready',issues:Array.isArray(valid?.errors)?valid.errors.slice(0,200):[]},422);
    const issues=builderPublicationIssues(body.document,body.authoringMetadata,valid);
    if(issues.length)return json({error:'review_metadata_unresolved',issues:issues.slice(0,200)},422);
    if(typeof hashSources!=='function')return fail('unavailable',503);
    let hashesMatch=false;try{hashesMatch=await hashSources(body.authoringMetadata);}catch{}
    if(!hashesMatch)return fail('source_digest_mismatch',422);
    const result=await rpc.call('builder_submit_candidate',{...args,p_request_id:body.requestId,p_expected_revision:body.revision,p_document:body.document,p_authoring_metadata:body.authoringMetadata});
    const found=oneRow('builder_submit_candidate',result,onAlert);if(found.response)return found.response;const row=found.row;
    if(!isUuidV7(row.candidate_id)||row.revision!==body.revision||!digest(row.intent_digest)||!digest(row.content_sha256)||!['pending','approved','superseded','cancelled','released'].includes(row.status)||typeof row.submitted_at!=='string')return fail('unavailable',503);
    return json({candidateId:row.candidate_id,revision:row.revision,intentDigest:row.intent_digest,contentSha256:row.content_sha256,status:row.status,submittedAt:row.submitted_at},201);
  }
  if(collection==='candidates'&&candidateId&&!action&&method==='GET'){
    const result=await rpc.call('builder_get_review_candidate',{...args,p_candidate_id:candidateId});
    const found=oneRow('builder_get_review_candidate',result,onAlert);if(found.response)return found.response;const row=found.row;
    if(row.candidate_id!==candidateId||!revision(row.revision)||![1,2,3].includes(row.schema_version)||!digest(row.intent_digest)||!digest(row.content_sha256)||!['pending','approved','superseded','cancelled','released'].includes(row.status)||
       !(row.document===null||record(row.document))||!(row.authoring_metadata===null||record(row.authoring_metadata))||typeof row.submitted_at!=='string'||!(row.approved_by===null||isUuid(row.approved_by))||!(row.approved_at===null||typeof row.approved_at==='string'))return fail('unavailable',503);
    return json({candidate:{candidateId:row.candidate_id,revision:row.revision,schemaVersion:row.schema_version,document:row.document,authoringMetadata:row.authoring_metadata,
      intentDigest:row.intent_digest,contentSha256:row.content_sha256,status:row.status,submittedBy:row.submitted_by,submittedAt:row.submitted_at,
      approvedBy:row.approved_by,approvedAt:row.approved_at,approvedIntentDigest:row.approved_intent_digest,approvedContentSha256:row.approved_content_sha256,releasedVersionId:row.released_version_id}});
  }
  if(collection==='candidates'&&candidateId&&action==='cancel'&&method==='POST'){
    const result=await rpc.call('builder_cancel_candidate',{...args,p_candidate_id:candidateId});const found=oneRow('builder_cancel_candidate',result,onAlert);if(found.response)return found.response;
    return found.row.candidate_id===candidateId&&revision(found.row.revision)&&['cancelled','superseded','approved','released'].includes(found.row.status)?json({candidateId,status:found.row.status,revision:found.row.revision}):fail('unavailable',503);
  }
  if(collection==='candidates'&&candidateId&&action==='body'&&method==='DELETE'){
    const result=await rpc.call('builder_delete_candidate_body',{...args,p_candidate_id:candidateId});const found=oneRow('builder_delete_candidate_body',result,onAlert);if(found.response)return found.response;
    return found.row.candidate_id===candidateId&&typeof found.row.deleted==='boolean'?json({candidateId,deleted:found.row.deleted}):fail('unavailable',503);
  }
  if(collection==='candidates'&&candidateId&&action==='approve'&&method==='POST'){
    const parsed=await readBounded(request,parseJson);if(parsed.error)return fail(parsed.error,parsed.error==='too_large'?413:parsed.error==='request_timeout'?408:400);
    const body=parsed.body;if(!record(body)||Object.keys(body).sort().join(',')!=='contentSha256,intentDigest,revision'||!revision(body.revision)||!digest(body.intentDigest)||!digest(body.contentSha256))return fail('bad_request',400);
    const result=await rpc.call('builder_approve_candidate',{...args,p_candidate_id:candidateId,p_expected_revision:body.revision,p_intent_digest:body.intentDigest,p_content_sha256:body.contentSha256});
    const found=oneRow('builder_approve_candidate',result,onAlert);if(found.response)return found.response;const row=found.row;
    return row.candidate_id===candidateId&&row.revision===body.revision&&digest(row.intent_digest)&&digest(row.content_sha256)&&['approved','superseded','cancelled','released'].includes(row.status)&&typeof row.approved_at==='string'
      ?json({candidateId,revision:row.revision,status:row.status,approvedAt:row.approved_at,intentDigest:row.intent_digest,contentSha256:row.content_sha256}):fail('unavailable',503);
  }
  if(collection==='candidates'&&candidateId&&action==='release'&&method==='POST'){
    const parsed=await readBounded(request,parseJson);if(parsed.error)return fail(parsed.error,parsed.error==='too_large'?413:parsed.error==='request_timeout'?408:400);
    const body=parsed.body;if(!record(body)||!['art,assetIds,contentSha256,intentDigest,revision','art,assetIds,contentSha256,intentDigest,newEdition,revision'].includes(Object.keys(body).sort().join(','))||(Object.hasOwn(body,'newEdition')&&typeof body.newEdition!=='boolean')||!revision(body.revision)||!digest(body.intentDigest)||!digest(body.contentSha256)||!Array.isArray(body.assetIds)||body.assetIds.some(id=>!isUuidV7(id))||!record(body.art))return fail('bad_request',400);
    const name=Object.hasOwn(body,'newEdition')?'builder_release_update':'builder_release_candidate';
    const result=await rpc.call(name,{...args,p_candidate_id:candidateId,p_expected_revision:body.revision,p_intent_digest:body.intentDigest,
      p_content_sha256:body.contentSha256,p_asset_ids:body.assetIds,p_art:body.art,...(name==='builder_release_update'?{p_new_edition:body.newEdition}:{})});
    const found=oneRow(name,result,onAlert);if(found.response)return found.response;const row=found.row;
    return row.candidate_id===candidateId&&isUuidV7(row.version_id)&&Number.isSafeInteger(row.version_no)&&row.version_no>0&&digest(row.content_sha256)&&digest(row.intent_digest)&&row.status==='released'
      ?json({candidateId,versionId:row.version_id,versionNo:row.version_no,contentSha256:row.content_sha256,intentDigest:row.intent_digest,status:row.status}):fail('unavailable',503);
  }
  return fail('method_not_allowed',405);
}
