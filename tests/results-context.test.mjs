import test from 'node:test';
import assert from 'node:assert/strict';
import {uuidv7} from '../src/shared/ids.mjs';
import {initialState,dispatch,project,facilitatorActions} from '../src/shared/room-machine.mjs';
import {miniCase} from './helpers/mini-case.mjs';
function room(type='single_choice') {
 const fixture=miniCase(),decision=fixture.doc.decisions[0],pid=uuidv7(),fid=uuidv7(),ledger=new Map();
 decision.interaction.type=type;
 if(type==='ranking')decision.interaction.rank_count=3;
 if(type==='free_text')decision.interaction={type,max_length:280};
 for(const id of [fixture.s.partial,fixture.s.arrest])fixture.doc.surfaces.find(row=>row.id===id).scene='New clinical context';
 let state=initialState({sessionId:uuidv7(),joinCode:'7K3QX9',caseDoc:fixture.doc});
 const send=(type,payload={},actor={role:'facilitator',id:fid})=>{
  const next=dispatch(state,{type,...payload,actor,epoch:state.epoch,...(['start','advance','reset_checkpoint','lock','select_path','reveal'].includes(type)?{expectRevision:state.revision}:{}),at:'2026-10-03T10:00:00Z',clientEventId:uuidv7(),...(['start','advance','reset_checkpoint'].includes(type)?{roundId:uuidv7()}:{})},ledger);
  const receipt=next.effects.find(row=>row.type==='receipt');state=next.state;return receipt;
 };
 const accepted=(type,payload={},actor)=>assert.equal(send(type,payload,actor).receipt,'accepted',type);
 accepted('join',{displayName:'Sam'},{role:'participant',id:pid});accepted('start');accepted('advance');accepted('advance');
 const ids=decision.interaction.options?.map(row=>row.id),response=type==='ranking'?{order:ids}:type==='multi_select'?{option_ids:[ids[0]]}:type==='free_text'?{text:'Simulation answer'}:{option_id:ids[0]};
 accepted('vote',{roundId:state.round.id,responseId:uuidv7(),response},{role:'participant',id:pid});accepted('lock');
 const refused=type=>{const before=structuredClone(state),receipt=send(type);assert.equal(receipt.reason,'hide_responses_first',type);assert.deepEqual(state,before,type+' must not publish/mutate');};
 return {fixture,pid,send,accepted,refused,get state(){return state;}};
}
test('[AS-089] Card24 every visible closed chart requires explicit Hide before authored consequence publication',()=>{
 for(const type of ['single_choice','multi_select','ranking','free_text']){
  const r=room(type);r.accepted('select_path',{pathId:r.fixture.p.decompress});
  assert.ok(project(r.state,'display').responseResult,type);
  const chart=project(r.state,'display').responseResult;
  r.accepted('back_to_review');assert.equal(r.state.selectedPathId,null);
  assert.deepEqual(project(r.state,'display').responseResult,chart);
  r.accepted('select_path',{pathId:r.fixture.p.decompress});
  r.refused('reveal');assert.ok(!facilitatorActions(r.state).includes('reveal'),type);
  assert.ok(facilitatorActions(r.state).includes('show_results'));
  r.accepted('show_results',{on:false});r.accepted('reveal');
  assert.equal(project(r.state,'display').surface.scene,'New clinical context');
  assert.equal(project(r.state,'participant',r.pid).liveSurface.scene,'New clinical context');
 }
});
test('Card24 visible consequence results block each next shared group until explicit Hide',()=>{
 const r=room();r.accepted('select_path',{pathId:r.fixture.p.decompress});r.accepted('show_results',{on:false});r.accepted('reveal');r.accepted('show_results',{on:true});
 r.refused('advance');assert.ok(!facilitatorActions(r.state).includes('advance'));
 r.accepted('show_results',{on:false});r.accepted('advance');
 assert.equal(r.state.revealed.at(-1).groupsShown,2);
 for(const role of ['display','participant']){const v=project(r.state,role,r.pid);assert.equal((v.surface??v.liveSurface).points.length,1);}
});
test('Card24 visible terminal results require Hide before checkpoint reset without losing authored history',()=>{
 const r=room();r.accepted('select_path',{pathId:r.fixture.p.intubate});r.accepted('show_results',{on:false});r.accepted('reveal');r.accepted('show_results',{on:true});
 r.refused('reset_checkpoint');assert.ok(!facilitatorActions(r.state).includes('reset_checkpoint'));
 r.accepted('show_results',{on:false});r.accepted('reset_checkpoint');assert.ok(r.state.exploredTerminal.includes(r.fixture.p.intubate));
});
test('Card24 intentional projector replay permits live teaching but Return Live restores Hide prerequisite',()=>{
 for(const terminal of [false,true]){
  const r=room('ranking');r.accepted('select_path',{pathId:terminal?r.fixture.p.intubate:r.fixture.p.decompress});r.accepted('replay',{entryIndex:0});
  assert.equal(project(r.state,'display').responseResult,null);r.accepted('reveal');r.accepted('advance');
  assert.equal(r.state.resultsShown,true);assert.equal(r.state.display.cursor,0);
  if(terminal){assert.ok(facilitatorActions(r.state).includes('reset_checkpoint'));r.accepted('reset_checkpoint');assert.equal(r.state.display.cursor,0);}
  else {r.accepted('replay',{entryIndex:null});assert.ok(project(r.state,'display').responseResult);r.refused('advance');}
 }
});
