import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
import{inspectBuilderTransfer}from'../src/shared/builder-transfer.mjs';import{validateBuilderDocument}from'../src/shared/builder-document.mjs';import{validateSlideParts}from'../src/shared/slide-document.mjs';
const read=n=>JSON.parse(readFileSync(new URL('./fixtures/synthetic/'+n+'.json',import.meta.url),'utf8'));
const before=read('teaching-base'),fixture=read('teaching-layout'),next=fixture.pair;
const sourceBytes=JSON.stringify(before);
test('synthetic teaching layout preserves interactions, path identities and source text; owner-specific editorial assertions stay private',()=>{
 assert.equal(validateBuilderDocument(next.document,next.authoring_metadata,{mode:'preserve',validateSlides:validateSlideParts}).ok,true);
 assert.equal(next.document.decisions.length,before.document.decisions.length);
 for(const d of before.document.decisions){const revised=next.document.decisions.find(x=>x.id===d.id);assert.deepEqual(revised.interaction,d.interaction);assert.deepEqual(revised.paths.map(p=>p.id),d.paths.map(p=>p.id))}
 assert.deepEqual(next.authoring_metadata.sources,before.authoring_metadata.sources);
 for(const s of fixture.teachingSlides)assert.ok(next.document.surfaces.some(x=>x.title===s.title));
 assert.equal(JSON.stringify(before),sourceBytes);
 assert.ok(next.authoring_metadata.provenance.every(p=>p.review_status!=='confirmed'),'new synthetic data cannot inherit historical confirmation');
});
test('revision-bound synthetic transfer preserves unchanged traces and marks exactly the seven changed traces stale',async()=>{
 const envelope=read('teaching-revision-transfer');
 const checked=await inspectBuilderTransfer(envelope,{current:{document:before.document,authoringMetadata:before.authoring_metadata,revision:243,intentDigest:envelope.base.intent_digest}});
 assert.equal(checked.ok,true);assert.deepEqual(checked.readinessErrors,[]);
 assert.equal(checked.candidate.authoring_metadata.provenance.find(p=>p.entity_id==='01a120ed-4743-73d9-b992-3aeda512bb0a').review_status,'unreviewed');
 assert.equal(checked.staleProvenance.length,7);
 const stale=await inspectBuilderTransfer(envelope,{current:{document:before.document,authoringMetadata:before.authoring_metadata,revision:244,intentDigest:envelope.base.intent_digest}});assert.equal(stale.ok,false);
});
test('synthetic confirmed unchanged clarification survives the complex revision without inheriting a real review claim',async()=>{
 const base=structuredClone(before),envelope=read('teaching-revision-transfer');
 const id='01a120ed-4743-73d9-b992-3aeda512bb0a';
 // Deliberate in-memory test state, never a clinical/rights review receipt in the shipped fixture.
 const trace=base.authoring_metadata.provenance.find(p=>p.entity_id===id);assert.ok(trace);trace.review_status='confirmed';
 const metadata=envelope.operations.find(p=>p.path==='/authoring_metadata').value;
 const sent=metadata.provenance.find(p=>p.entity_id===id);assert.ok(sent);sent.review_status='confirmed';
 const checked=await inspectBuilderTransfer(envelope,{current:{document:base.document,authoringMetadata:base.authoring_metadata,revision:243,intentDigest:envelope.base.intent_digest}});
 assert.equal(checked.ok,true);assert.deepEqual(checked.readinessErrors,[]);
 assert.equal(checked.candidate.authoring_metadata.provenance.find(p=>p.entity_id===id).review_status,'confirmed');
 assert.equal(checked.staleProvenance.length,7);
 assert.ok(before.authoring_metadata.provenance.every(p=>p.review_status!=='confirmed'),'stored synthetic fixture remains unreviewed');
});
