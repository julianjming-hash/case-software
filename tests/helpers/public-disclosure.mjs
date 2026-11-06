// RT04's serialized-payload rules, shared by the randomized oracle and room simulations.
import assert from 'node:assert/strict';
export function assertPublicDisclosure(payload, secrets, withheld = []) {
 const text=JSON.stringify(payload);
 for(const secret of secrets)if(secret)assert.ok(!text.includes(secret),'serialized public payload leaked private material');
 const strings=value=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
 const surfaces=[payload.view?.surface,payload.view?.liveSurface,...(payload.view?.timeline??[])].filter(Boolean);
 const surfaceStrings=surfaces.flatMap(surface=>strings([surface.scene,surface.observations?.map(o=>({label:o.label,value:o.value})),surface.points,surface.investigations]));
 for(const value of withheld)assert.ok(!surfaceStrings.includes(value),'serialized public payload leaked unrevealed material');
 assert.doesNotMatch(text,/"(?:suggestion|classification|cue|notes|rationale|caseDoc|document_text)"/,'private public field');
}
