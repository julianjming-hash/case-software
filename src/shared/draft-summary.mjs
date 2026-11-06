// Private summary scalars and numbers-only art. No draft body, source, identity or digest crosses this projection.
import { isUuidV7 } from './ids.mjs';
import { validStructure,structureOf } from './art-descriptor.mjs';
import { CATALOGUE_DURATIONS } from './catalogue.mjs';
const unsafe=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!unsafe.test(v);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function validDraftSummary(row){
 return !!row&&isUuidV7(row.caseId)&&text(row.title,200)&&Number.isSafeInteger(row.revision)&&row.revision>=0&&time(row.updatedAt)
  &&(row.audience===null||text(row.audience,160))&&(row.durationMin===null||CATALOGUE_DURATIONS.includes(row.durationMin))
  &&(row.artStructure===null||validStructure(row.artStructure)&&JSON.stringify(row.artStructure).length<=4096)
  &&(row.publicationVersion===null?row.publicationAt===null&&row.publicationState==='none':Number.isSafeInteger(row.publicationVersion)&&row.publicationVersion>0&&time(row.publicationAt)&&['changed','unchanged','unknown'].includes(row.publicationState))
  &&[null,'pending','approved'].includes(row.reviewStatus);
}
export function projectDraftSummary(row){
 const out={caseId:row.case_id,title:row.title,revision:row.revision,updatedAt:row.updated_at,audience:row.audience,durationMin:row.duration_min,
  artStructure:row.art_structure,publicationVersion:row.publication_version,publicationAt:row.publication_at,publicationState:row.publication_state,reviewStatus:row.review_status};
 if(!validDraftSummary(out))return null;
 return {...out,artStructure:out.artStructure===null?null:structureOf(out.artStructure)};
}
export function draftPublicationLabel(row){return row.publicationState==='none'?'Not published':row.publicationState==='changed'?'Unpublished changes':row.publicationState==='unchanged'?'Matches last publication':'Publication comparison unavailable';}
export function draftReviewLabel(row){return row.reviewStatus==='approved'?'Review approved':row.reviewStatus==='pending'?'In review':'No current review';}
