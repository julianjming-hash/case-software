import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authoredModel, braidModel, roomRoute } from '../src/shared/case-map.mjs';
import { Rehearsal } from '../src/client/preview-rehearsal.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { project } from '../src/shared/room-machine.mjs';
import { dockControl } from '../src/client/console-actions.mjs';
const doc=JSON.parse(await readFile(new URL('../src/fixtures/synthetic-workshop.case.json',import.meta.url)));
test('[AS-121] authored map includes each reachable exact destination and checkpoint',()=>{
 const graph=authoredModel(doc),braid=braidModel(doc);
 assert.equal(graph.order.length,doc.beats.length);
 for(const g of braid.groups) for(const r of g.routes) {
  assert.equal(r.targetBeatId,r.path.terminal?.checkpoint_beat_id??r.path.next_beat_id??null);
  assert.equal(r.outcome.id,r.path.reveal_surface_id);
 }
 const cyclic=structuredClone(doc);cyclic.beats.at(-1).next_beat_id=cyclic.start_beat_id;
 assert.equal(authoredModel(cyclic).order.length,doc.beats.length);
});
test('[AS-121] Online and Manual use authority action descriptions and atomic reveal, Undo retains disclosure',()=>{
 for(const mode of ['online','manual']){
  const m=new Rehearsal(doc,mode);assert.equal(m.state.phase,'lobby');
  let chosen=false;
  for(let i=0;i<80&&!chosen;i++){
   const v=m.view(),action=dockControl(v,{pickedPathId:m.selection});
   assert.ok(action);
   if(action.local==='focus_resolution'){
    const path=v.decision.paths.find(p=>!p.explored);assert.ok(m.select(path.id));
    const reveal=dockControl(m.view(),{pickedPathId:m.selection});
    assert.equal(reveal.command,'reveal_path');assert.ok(m.command(reveal.command,reveal.payload));chosen=true;
   }else{assert.ok(action.command,JSON.stringify(action));assert.ok(m.command(action.command,action.payload));}
  }
  assert.ok(chosen);const before=m.view().publicTimeline.map(x=>x.occurrenceId);
  const undo=m.view().undo;assert.ok(undo.available);assert.ok(m.command('undo',{targetEventId:undo.targetEventId,expectRevision:m.state.revision}));
  const route=roomRoute(m.state,m.view());assert.ok(route.complete);assert.ok(route.detours.length);
  assert.ok(before.every(id=>m.view().publicTimeline.some(x=>x.occurrenceId===id)));
  m.close();assert.equal(m.state,null);assert.equal(m.doc,null);
 }
});
test('[AS-121] canonical route refuses unavailable evidence; projection excludes private sentinel',()=>{
 const m=new Rehearsal(doc);m.command('start');
 const v=project(m.state,'facilitator');assert.equal(roomRoute(null,v).complete,false);
 const source=structuredClone(doc);source.surfaces[0].notes='PRIVATE_SENTINEL';
 const other=new Rehearsal(source);other.command('start');
 assert.ok(!JSON.stringify(other.view().publicTimeline).includes('PRIVATE_SENTINEL'));
 const malformed=structuredClone(other.state);malformed.revealed[0].occurrenceId=null;
 assert.equal(roomRoute(malformed,other.view()).complete,false);
});

test('[AS-121] every fixture route rehearses in both modes, including terminal reset and explored refusal',()=>{
 for(const mode of ['online','manual'])for(const target of doc.decisions)for(const path of target.paths){
  const sourceBeat=doc.beats.find(b=>b.decision_id===target.id);
  const queue=[{id:doc.start_beat_id,choices:new Map()}],seen=new Set();let choices;
  while(queue.length){const item=queue.shift();if(item.id===sourceBeat.id){choices=item.choices;break;}if(seen.has(item.id))continue;seen.add(item.id);const beat=doc.beats.find(b=>b.id===item.id),decision=doc.decisions.find(d=>d.id===beat.decision_id);
   if(decision)for(const p of decision.paths){const next=p.terminal?.checkpoint_beat_id??p.next_beat_id;if(next)queue.push({id:next,choices:new Map([...item.choices,[decision.id,p.id]])});}
   else if(beat.next_beat_id)queue.push({id:beat.next_beat_id,choices:item.choices});}
  assert.ok(choices,'exact authored source is reachable');
  const m=new Rehearsal(doc,mode);let reached=false;
  for(let i=0;i<100;i++){
   const v=m.view(),action=dockControl(v,{pickedPathId:m.selection});assert.ok(action,`${mode}: ${path.label}`);
   if(action.local==='focus_resolution'){
    const chosen=v.decision.decisionId===target.id?path:v.decision.paths.find(p=>p.id===choices.get(v.decision.decisionId));
    assert.ok(chosen);assert.ok(m.select(chosen.id));const reveal=dockControl(m.view(),{pickedPathId:m.selection});
    assert.equal(reveal.command,'reveal_path');assert.deepEqual(reveal.payload,{pathId:chosen.id,expectRevision:v.revision});assert.ok(m.command(reveal.command,reveal.payload));
    assert.equal(m.state.revealed.at(-1).pathId,chosen.id);
    if(chosen.id===path.id){reached=true;break;}
   }else{assert.ok(!action.disabled,`${mode}: ${path.label}: ${action.label}`);assert.ok(m.command(action.command,action.payload));}
  }
  assert.ok(reached,`${mode}: ${path.label}`);
  const outcome=doc.surfaces.find(s=>s.id===path.reveal_surface_id);
  assert.equal(m.view().publicDisplaySurface.title,outcome.title);
  if(path.terminal){
   for(let i=0;i<15&&!m.view().actions.includes('reset_checkpoint');i++){const a=dockControl(m.view(),{pickedPathId:m.selection});assert.equal(a.command,'advance');assert.ok(m.command(a.command,a.payload));}
   assert.ok(m.command('reset_checkpoint'));assert.equal(m.view().beat.id,path.terminal.checkpoint_beat_id);
   const route=roomRoute(m.state,m.view());assert.ok(route.complete);assert.equal(route.excursions.at(-1).kind,'checkpoint');assert.ok(route.excursions.at(-1).visits.some(r=>r.pathId===path.id));
   for(let i=0;i<20&&!m.view().actions.includes('reveal_path');i++){const a=dockControl(m.view(),{pickedPathId:m.selection});assert.ok(m.command(a.command,a.payload));}
   if(m.view().decision?.decisionId===target.id)assert.equal(m.select(path.id),false,'explored terminal route remains refused');
  }
  m.close();
 }
});
test('[AS-121] repeated exact corrections remain separate excursions, with no visit lost',()=>{
 const m=new Rehearsal(doc);for(let step=0;step<100&&!m.view().actions.includes('reveal_path');step++){const a=dockControl(m.view());assert.ok(m.command(a.command,a.payload));}
 assert.ok(m.view().actions.includes('reveal_path'));
 for(let i=0;i<3;i++){const path=m.view().decision.paths.find(p=>!p.terminal);assert.ok(m.select(path.id));assert.ok(m.command('reveal_path',{pathId:path.id}));const undo=m.view().undo;assert.ok(m.command('undo',{targetEventId:undo.targetEventId}));}
 const route=roomRoute(m.state,m.view());assert.ok(route.complete);assert.equal(route.excursions.length,3);const missing=structuredClone(m.state);missing.revealed.at(-1).restoresOccurrenceId=uuidv7();assert.equal(roomRoute(missing,m.view()).complete,false);assert.equal(route.excursions.length,3);assert.deepEqual(new Set(route.excursions.flatMap(g=>g.visits.map(r=>r.occurrenceId))),new Set(route.detours.map(r=>r.occurrenceId)));
 assert.equal(new Set([...route.spine,...route.detours].map(r=>r.occurrenceId)).size,m.view().publicTimeline.length);
});
