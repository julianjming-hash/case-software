// Private portfolio projections. Never return a raw document, journal payload or individual response.
import { isUuidV7 } from './ids.mjs';
import { validateFormattedText } from './builder-format.mjs';
import { cleanText } from './text.mjs';
import { validateRankedGroups } from './ranked-groups.mjs';
export const RECORD_SCHEMA = 'case.session-record.v1';
export const RECORD_PAGE_BYTES = 256 * 1024;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const number=x=>Number.isSafeInteger(x)&&x>=0;
const time=x=>typeof x==='string'&&x.length<=40&&Number.isFinite(Date.parse(x));
const optionalTime=x=>x===null||time(x);
const text=(x,max=20000)=>{if(plain(x)&&validateFormattedText(x).length===0)x=x.blocks.map(b=>b.type==='list'?b.items.map((i,n)=>`${b.ordered?`${n+1}.`: '•'} ${i.runs.map(r=>r.text).join('')}`).join('\n'):b.runs.map(r=>r.text).join('')).join('\n');return typeof x==='string'&&x.length<=max?cleanText(x,max):null;};
const fieldIds=['decisionId','pathId','beatId','checkpointBeatId','roundId','sourceRoundId','targetEventId','occurrenceId','contextOccurrenceId','restoresOccurrenceId','segmentId','clarificationId'];
const kinds=new Set(['beat_entered','responses_opened','responses_locked','path_selected','selection_cleared','consequence_revealed','teaching_corrected','clarification_shown','clarification_returned','recovery_confirmation','checkpoint_reset','discussion_paused','discussion_resumed','manual_entered','manual_marker','manual_exited','room_ended','round_closed']);
const index=(rows=[])=>new Map(rows.filter(x=>plain(x)&&isUuidV7(x.id)).map(x=>[x.id,x]));
function aggregate(raw,decision){
 if(raw===null)return null;
 if(!plain(raw)||!number(raw.total))throw new Error('invalid_aggregate');
 const options=decision?.interaction?.options??[],counts=[];
 if(plain(raw.counts))for(const option of options){const count=raw.counts[option.id];if(count!==undefined&&!number(count))throw new Error('invalid_aggregate');counts.push({optionId:option.id,label:text(option.label)??'Option text unavailable',count:count??0});}
 // No free-text answer, participant key or arbitrary aggregate member survives this allowlist.
 const result={total:raw.total,counts};
 if(decision?.interaction?.type==='ranking'){
  const rankCount=raw.rankCount,eligible=raw.eligibleOptionIds;
  if(!number(rankCount)||rankCount>8||!Array.isArray(eligible)||eligible.some(id=>!options.some(o=>o.id===id))||!validateRankedGroups(raw.completeOrders,{optionCount:options.length,rankCount,total:raw.total,eligibleIndices:eligible.map(id=>options.findIndex(o=>o.id===id))}))throw new Error('invalid_ranking');
  for(const row of counts){const positions=raw.positionCounts?.[row.optionId];if(!Array.isArray(positions)||positions.length!==rankCount||positions.some(x=>!number(x)||x>raw.total))throw new Error('invalid_ranking');row.positionCounts=[...positions];}
  result.rankCount=rankCount;result.completeOrders=raw.completeOrders.map(([tuple,count])=>({optionIds:[...tuple].map(i=>options[Number(i)].id),count}));
 }
 return result;
}
// Card 40 (slice 2): with { debrief: true } each round also carries what the debrief draws (the question's interaction
// type, whether it changes the route, and the chosen route's classification and recommendation). Old clients never ask
// for it, so their strict wire schema keeps the original round shape.
const CLASSIFICATIONS=['sound','defensible','context-dependent','unsafe','terminal-unsafe','discussion-prompt'],INTERACTIONS=['single_choice','multi_select','ranking','free_text'];
export function projectSessionRecord(raw,{debrief=false}={}){
 if(!plain(raw)||!plain(raw.session)||!Array.isArray(raw.items)||raw.items.length>100||! /^[a-f0-9]{64}$/.test(raw.boundary??'')||!number(raw.eventCount)||!number(raw.maxSeq))throw new Error('invalid_record');
 const s=raw.session;
 if(!['id','workspaceId','caseId','versionId'].every(k=>isUuidV7(s[k]))||!number(s.versionNo)||s.versionNo<1||! /^[a-f0-9]{64}$/.test(s.digest??'')||text(s.title,200)===null||!['lobby','live','ended','expired'].includes(s.status)||!['published','withdrawn'].includes(s.sourceStatus)||typeof s.own!=='boolean'||!time(s.createdAt)||!optionalTime(s.startedAt)||!optionalTime(s.endedAt)||!time(s.expiresAt))throw new Error('invalid_session');
 const doc=raw.document,available=plain(doc)&&[1,2,3].includes(doc.schema_version)&&Array.isArray(doc.beats)&&Array.isArray(doc.decisions);
 const decisions=index(available?doc.decisions:[]),beats=index(available?doc.beats:[]);
 const manifest=s.manifest;
 if(manifest!==null&&(!plain(manifest)||manifest.interpretation!==1||manifest.versionId!==s.versionId||!['revision','epoch','seq','roundCount','joined'].every(k=>number(manifest[k]))||manifest.seq!==manifest.revision||manifest.seq!==raw.maxSeq||manifest.seq!==raw.eventCount))throw new Error('invalid_manifest');
 let limited=!available||raw.interpretationLimited!==false,previous=0;
 const items=raw.items.map(item=>{
  if(!plain(item)||!number(item.position)||item.position<1||item.position<=previous)throw new Error('invalid_item_order');previous=item.position;
  if(item.type==='round'){
   if(!isUuidV7(item.id)||!isUuidV7(item.decisionId)||!number(item.number)||item.number<1||!['open','locked','resolved','abandoned','superseded'].includes(item.status)||!time(item.openedAt)||!optionalTime(item.closedAt)||!(item.pathId===null||isUuidV7(item.pathId))||![null,'majority','minority','override'].includes(item.resolution))throw new Error('invalid_round');
   const decision=decisions.get(item.decisionId),path=decision?.paths?.find(x=>x.id===item.pathId);if(!decision||item.pathId&&!path)limited=true;
   const round={type:'round',position:item.position,id:item.id,decisionId:item.decisionId,number:item.number,status:item.status,openedAt:item.openedAt,closedAt:item.closedAt,prompt:text(decision?.prompt)??'Decision text unavailable',pathId:item.pathId,pathLabel:text(path?.label),resolution:item.resolution,aggregate:aggregate(item.aggregate,decision)};
   if(debrief){const type=decision?.interaction?.type;round.interaction=INTERACTIONS.includes(type)?type:null;round.branch=Array.isArray(decision?.paths)&&decision.paths.length>1;
    round.classification=CLASSIFICATIONS.includes(path?.classification)?path.classification:null;round.recommended=path?.recommended===true;}
   return round;
  }
  if(item.type!=='event'||!number(item.seq)||item.seq<1||!isUuidV7(item.eventId)||!number(item.epoch)||typeof item.kind!=='string'||!time(item.at)||!plain(item.payload))throw new Error('invalid_event');
  if(!kinds.has(item.kind)){if(!['participant_joined','participant_renamed','participant_removed','response_recorded','names_shown','results_shown','results_page','ranked_page','timer_set','media_control','lobby_shown','facilitator_takeover','joining_closed','presentation_group_revealed','debrief_started','debrief_left','responses_closing','lock_cancelled','auto_lock_set','music_set'].includes(item.kind))limited=true;return null;}
  const p=item.payload,details={};
  if(p.publication!==undefined){
   if(!plain(p.publication))throw new Error('invalid_publication');
   const publication={};for(const key of ['occurrenceId','surfaceId','beatId','checkpointOf','correctionOf','restoresOccurrenceId'])if(p.publication[key]!=null){if(!isUuidV7(p.publication[key]))throw new Error('invalid_publication');publication[key]=p.publication[key];}
   if(number(p.publication.groupsShown))publication.groupsShown=p.publication.groupsShown;
   if(typeof p.publication.manual==='boolean')publication.manual=p.publication.manual;
   details.publication=publication;
   if(!publication.occurrenceId)limited=true;
  }
  if(['beat_entered','consequence_revealed'].includes(item.kind)&&!p.publication?.occurrenceId)limited=true;
  for(const key of fieldIds)if(p[key]!==undefined&&p[key]!==null){if(!isUuidV7(p[key]))throw new Error('invalid_event_reference');details[key]=p[key];}
  for(const key of ['groupsShown','markerNo','total','roundNo'])if(p[key]!==undefined){if(!number(p[key]))throw new Error('invalid_event_count');details[key]=p[key];}
  if(p.confirmed!==undefined){if(typeof p.confirmed!=='boolean')throw new Error('invalid_event_boolean');details.confirmed=p.confirmed;}
  if(p.status!==undefined){if(!['open','locked','resolved','abandoned','superseded'].includes(p.status))throw new Error('invalid_event_status');details.status=p.status;}
  for(const [key,values]of [['resolutionKind',['majority','minority','override','manual']],['mode',['online','manual','live']],['actionKind',['lock','selection','reveal','reset','clarification','advance']]])if(p[key]!==undefined&&p[key]!==null){if(!values.includes(p[key]))throw new Error('invalid_event_enum');details[key]=p[key];}
  const decision=decisions.get(details.decisionId),path=decision?.paths?.find(x=>x.id===details.pathId),beat=beats.get(details.beatId??details.checkpointBeatId);
  if(details.decisionId&&!decision||details.pathId&&!path||details.beatId&&!beat)limited=true;
  if(decision)details.prompt=text(decision.prompt)??'Decision text unavailable';
  if(path){details.pathLabel=text(path.label)??'Path text unavailable';if(item.kind==='consequence_revealed'){details.rationale=text(path.rationale);details.debriefPrompt=text(path.terminal?.debrief_prompt);}}
  if(beat)details.beatTitle=text(beat.title,200)??'Teaching beat';
  if(p.publication?.occurrenceId&&p.publication?.surfaceId){const surface=available?doc.surfaces?.find(row=>row.id===p.publication.surfaceId):null;if(surface)details.teachingNotes=text(surface.notes);else limited=true;}
  return {type:'event',position:item.position,seq:item.seq,eventId:item.eventId,epoch:item.epoch,kind:item.kind,at:item.at,details};
 }).filter(Boolean);
 const objectives=available&&Array.isArray(doc.learning_objectives)?doc.learning_objectives.map(x=>text(x)).filter(x=>x!==null):[];
 if(objectives.length>128)throw new Error('record_budget');
 const result={schema:RECORD_SCHEMA,session:{id:s.id,workspaceId:s.workspaceId,caseId:s.caseId,versionId:s.versionId,versionNo:s.versionNo,digest:s.digest,title:text(s.title,200),status:s.status,sourceStatus:s.sourceStatus,createdAt:s.createdAt,startedAt:s.startedAt,endedAt:s.endedAt,expiresAt:s.expiresAt,own:s.own},
 boundary:raw.boundary,interpretation:1,completeness:manifest&&!limited?'complete':s.status==='lobby'||s.status==='live'?'pending':'limited',sourceAvailable:available,joined:manifest?.joined??null,eventCount:raw.eventCount,intendedObjectives:objectives,items,nextAfter:null};
 // J10 (card 59 M3): the images on the slides this part's publications reached, once each, in order. The archive keeps
 // each occurrence but not which later steps it showed, so a slide's later images are listed too: the export says so.
 const imagesOf=list=>{
  if(!available||doc.schema_version!==3||!Array.isArray(doc.compositions)||!Array.isArray(doc.blocks))return [];
  const byOwner=new Map(doc.compositions.map(c=>[`${c?.owner?.kind}:${c?.owner?.id}`,c])),blocks=new Map(doc.blocks.map(b=>[b?.id,b])),seen=new Set(),out=[],direct=new Set((doc.decisions??[]).flatMap(d=>(d.paths??[]).filter(p=>p.continue_to_next).map(p=>p.id)));
  for(const item of list){
   if(item.type!=='event'||!item.details.publication?.occurrenceId&&item.kind!=='clarification_shown')continue;
   const d=item.details,owner=d.clarificationId?`clarification:${d.clarificationId}`:item.kind==='consequence_revealed'&&d.pathId&&!direct.has(d.pathId)?`path:${d.pathId}`:`beat:${d.beatId??d.publication?.beatId}`;
   for(const id of byOwner.get(owner)?.reading_order??[]){const block=blocks.get(id);
    if(block?.type!=='image'||!isUuidV7(block.asset_id)||seen.has(block.asset_id)||out.length>=64)continue;
    seen.add(block.asset_id);out.push({assetId:block.asset_id,alt:text(block.alt,300)??'Image',caption:text(block.caption,200)??''});}
  }
  return out;
 };
 result.images=imagesOf(result.items);
 // Bound the whole wire page. Continuation starts at the last emitted position, never a skipped item.
 const projectedCount=result.items.length;
 while(new TextEncoder().encode(JSON.stringify(result)).length>RECORD_PAGE_BYTES-1024&&result.items.length>1)result.items.pop();
 result.images=imagesOf(result.items);
 if(new TextEncoder().encode(JSON.stringify(result)).length>RECORD_PAGE_BYTES-1024)throw new Error('record_budget');
 result.nextPosition=result.items.length<projectedCount?result.items.at(-1).position:raw.nextPosition;
 if(result.nextPosition!==null&&!number(result.nextPosition))throw new Error('invalid_record_cursor');
 return result;
}
