// Strict private wire schema. Reject extra fields rather than carrying them into an export.
import { isUuidV7 } from './ids.mjs';
import { RECORD_SCHEMA } from './session-record.mjs';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,allowed,required=allowed)=>obj(x)&&Object.keys(x).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(x,k));
const count=x=>Number.isSafeInteger(x)&&x>=0;
const text=x=>typeof x==='string'&&x.length<=20000;
const time=x=>typeof x==='string'&&x.length<=40&&Number.isFinite(Date.parse(x));
const nullable=(f,x)=>x===null||f(x);
const cursor=x=>x===null||typeof x==='string'&&x.length>0&&x.length<=512&&/^[A-Za-z0-9_-]+$/.test(x);
const ids=['decisionId','pathId','beatId','checkpointBeatId','roundId','sourceRoundId','targetEventId','occurrenceId','contextOccurrenceId','restoresOccurrenceId','segmentId','clarificationId'];
function details(x){
 if(!keys(x,[...ids,'groupsShown','markerNo','total','roundNo','confirmed','status','resolutionKind','mode','actionKind','prompt','pathLabel','rationale','debriefPrompt','teachingNotes','beatTitle','publication'],[]))return false;
 for(const [k,v]of Object.entries(x)){
  if(ids.includes(k)&&!isUuidV7(v))return false;
  if(['groupsShown','markerNo','total','roundNo'].includes(k)&&!count(v))return false;
  if(['prompt','pathLabel','beatTitle'].includes(k)&&!text(v)||['rationale','debriefPrompt','teachingNotes'].includes(k)&&!nullable(text,v))return false;
  if(k==='resolutionKind'&&!['majority','minority','override','manual'].includes(v)||k==='mode'&&!['online','manual','live'].includes(v)||k==='actionKind'&&!['lock','selection','reveal','reset','clarification','advance'].includes(v))return false;
  if(k==='confirmed'&&typeof v!=='boolean'||k==='status'&&!['open','locked','resolved','abandoned','superseded'].includes(v))return false;
  if(k==='publication'&&(!keys(v,['occurrenceId','surfaceId','beatId','checkpointOf','correctionOf','restoresOccurrenceId','groupsShown','manual'],[])||Object.entries(v).some(([a,b])=>a==='groupsShown'?!count(b):a==='manual'?typeof b!=='boolean':!isUuidV7(b))))return false;
 }return true;
}
function aggregate(x){
 if(x===null)return true;
 if(!keys(x,['total','counts','rankCount','completeOrders'],['total','counts'])||!count(x.total)||!Array.isArray(x.counts)||x.counts.length>8)return false;
 if(x.counts.some(r=>!keys(r,['optionId','label','count','positionCounts'],['optionId','label','count'])||!isUuidV7(r.optionId)||!text(r.label)||!count(r.count)||r.count>x.total||r.positionCounts!==undefined&&(!Array.isArray(r.positionCounts)||r.positionCounts.length>8||r.positionCounts.some(n=>!count(n)||n>x.total))))return false;
 if(x.rankCount!==undefined&&(!count(x.rankCount)||x.rankCount>8||!Array.isArray(x.completeOrders)||x.completeOrders.length>300||x.completeOrders.some(r=>!keys(r,['optionIds','count'])||!Array.isArray(r.optionIds)||r.optionIds.length!==x.rankCount||r.optionIds.some(id=>!x.counts.some(o=>o.optionId===id))||!count(r.count)||r.count<1)))return false;
 return true;
}
export function recordPage(x){
 if(!keys(x,['schema','session','boundary','interpretation','completeness','sourceAvailable','joined','eventCount','intendedObjectives','items','nextAfter','images'],['schema','session','boundary','interpretation','completeness','sourceAvailable','joined','eventCount','intendedObjectives','items','nextAfter'])||
 x.images!==undefined&&(!Array.isArray(x.images)||x.images.length>64||x.images.some(i=>!keys(i,['assetId','alt','caption'])||!isUuidV7(i.assetId)||!text(i.alt)||i.alt.length>300||!text(i.caption)||i.caption.length>200))||x.schema!==RECORD_SCHEMA||x.interpretation!==1||! /^[a-f0-9]{64}$/.test(x.boundary)||!['complete','limited','pending'].includes(x.completeness)||typeof x.sourceAvailable!=='boolean'||!nullable(count,x.joined)||!count(x.eventCount)||!Array.isArray(x.intendedObjectives)||x.intendedObjectives.length>128||x.intendedObjectives.some(o=>!text(o))||!Array.isArray(x.items)||x.items.length>100||!cursor(x.nextAfter))throw new Error('invalid_record_page');
 const s=x.session;
 if(!keys(s,['id','workspaceId','caseId','versionId','versionNo','digest','title','status','sourceStatus','createdAt','startedAt','endedAt','expiresAt','own'])||!['id','workspaceId','caseId','versionId'].every(k=>isUuidV7(s[k]))||!count(s.versionNo)||s.versionNo<1||! /^[a-f0-9]{64}$/.test(s.digest)||!text(s.title)||s.title.length>200||!['lobby','live','ended','expired'].includes(s.status)||!['published','withdrawn'].includes(s.sourceStatus)||typeof s.own!=='boolean'||!time(s.createdAt)||!time(s.expiresAt)||!nullable(time,s.startedAt)||!nullable(time,s.endedAt))throw new Error('invalid_record_session');
 let position=0;
 for(const r of x.items){
  if(!count(r.position)||r.position<=position)throw new Error('invalid_record_order');position=r.position;
  if(r.type==='event'){
   if(!keys(r,['type','position','seq','eventId','epoch','kind','at','details'])||!count(r.seq)||r.seq<1||!isUuidV7(r.eventId)||!count(r.epoch)||!text(r.kind)||!time(r.at)||!details(r.details))throw new Error('invalid_record_event');
  }else if(r.type==='round'){
   const base=['type','position','id','decisionId','number','status','openedAt','closedAt','prompt','pathId','pathLabel','resolution','aggregate'],extra=['interaction','branch','classification','recommended'];
   // Debrief fields come as a set or not at all (card 40 slice 2; requested with v:2).
   const withDebrief=Object.hasOwn(r,'branch');
   if(withDebrief&&(!keys(r,[...base,...extra])||!nullable(x=>['single_choice','multi_select','ranking','free_text'].includes(x),r.interaction)||typeof r.branch!=='boolean'||!nullable(x=>['sound','defensible','context-dependent','unsafe','terminal-unsafe','discussion-prompt'].includes(x),r.classification)||typeof r.recommended!=='boolean'))throw new Error('invalid_record_round');
   if(!keys(r,withDebrief?[...base,...extra]:base)||!isUuidV7(r.id)||!isUuidV7(r.decisionId)||!count(r.number)||r.number<1||!['open','locked','resolved','abandoned','superseded'].includes(r.status)||!time(r.openedAt)||!nullable(time,r.closedAt)||!text(r.prompt)||!nullable(isUuidV7,r.pathId)||!nullable(text,r.pathLabel)||![null,'majority','minority','override'].includes(r.resolution)||!aggregate(r.aggregate))throw new Error('invalid_record_round');
  }else throw new Error('invalid_record_item');
 }
 return x;
}
