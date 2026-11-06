import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, FENCEABLE } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { parseCommandEnvelope } from '../src/shared/wire.mjs';
function room() {
  const fixture=miniCase(), d=fixture.doc.decisions[0];
  d.interaction={type:'free_text',max_length:500}; d.rules=[{when:{keywords:['unmatched-keyword']},path_id:d.paths[0].id}]; d.paths.forEach(p=>delete p.option_ids);
  let state=initialState({sessionId:uuidv7(),joinCode:'7K3QX9',caseDoc:fixture.doc});
  const journal=[], ledger=new Map(), facilitator={role:'facilitator',id:uuidv7()}; let tick=0;
  function send(type,payload={},actor=facilitator) {
    const out=dispatch(state,{type,actor,epoch:state.epoch,...(FENCEABLE.has(type)?{expectRevision:state.revision}:{}),clientEventId:uuidv7(),at:new Date(1790000000000+ ++tick*1000).toISOString(),...(['start','advance','reopen'].includes(type)?{roundId:uuidv7()}:{}),...payload},ledger);
    journal.push(...out.effects.filter(e=>e.type==='journal')); state=out.state; return out.effects.find(e=>e.type==='receipt')?.receipt;
  }
  return {send,journal,get state(){return state;},display:()=>project(state,'display'),fixture};
}
test('[AS-089] closed free-text pages expose every answer without identities, and obey hide, replay and round fences',()=>{
  const r=room(), ids=Array.from({length:40},()=>uuidv7());
  for(const id of ids)assert.equal(r.send('join',{displayName:'Private participant'}, {role:'participant',id}),'accepted');
  r.send('start');r.send('advance');r.send('advance');
  const answers=ids.map((_,i)=>`Answer ${String(i).padStart(2,'0')} ${'x'.repeat(470)}`);
  ids.forEach((id,i)=>assert.equal(r.send('vote',{roundId:r.state.round.id,responseId:uuidv7(),response:{text:answers[i]}},{role:'participant',id}),'accepted'));
  assert.equal(r.display().responseResult,null);
  r.send('lock');const closedRoundId=r.state.round.id, seen=[];
  // CASE-318: two ~480-character answers fill a page's 42-line budget (20 lines + chip edge each), so 40 answers make 20 pages.
  for(let page=0;page<20;page++){
    assert.equal(r.send('text_page',{closedRoundId,page}),'accepted');
    const display=r.display(), result=display.responseResult.textPage;
    assert.equal(result.page,page);assert.equal(result.pages,20);assert.equal(result.answers.length,2);seen.push(...result.answers);
    assert.ok(acceptDisplayView(display));assert.equal(display.names,null);
    for(const id of ids)assert.equal(JSON.stringify(display).includes(id),false);
    assert.equal(JSON.stringify(display).includes('Private participant'),false);
    assert.equal(JSON.stringify(project(r.state,'participant',ids[0])).includes(answers[1]),false);
  }
  assert.deepEqual(seen,answers);
  assert.equal(r.send('text_page',{closedRoundId,page:20}),'rejected');
  assert.equal(r.send('text_page',{closedRoundId:uuidv7(),page:0}),'rejected');
  assert.equal(r.send('text_page',{closedRoundId,page:0},{role:'participant',id:ids[0]}),'rejected');
  const bad=structuredClone(r.display());bad.responseResult.textPage.answers[0]={name:'leak',text:'answer'};assert.equal(acceptDisplayView(bad),null);
  r.send('show_results',{on:false});assert.equal(r.display().responseResult,null);assert.equal(r.send('text_page',{closedRoundId,page:0}),'rejected');
  r.send('show_results',{on:true});assert.equal(r.display().responseResult.textPage.page,19);
  r.send('replay',{surfaceId:r.fixture.s.open});assert.equal(r.display().responseResult,null);
  assert.equal(r.send('text_page',{closedRoundId,page:0}),'rejected');
  r.send('replay',{surfaceId:null});r.send('reopen');assert.equal(r.display().responseResult,null);
  assert.equal(r.send('text_page',{closedRoundId,page:0}),'rejected');
  assert.equal(JSON.stringify(r.journal).includes(answers[0]),false);
});
test('free-text page wire is facilitator-only, bounded and revision/round bound',()=>{
 const command={v:1,type:'text_page',epoch:0,clientEventId:uuidv7(),closedRoundId:uuidv7(),expectRevision:1,page:19};
 assert.equal(parseCommandEnvelope(command,'facilitator').ok,true);
 for(const role of ['participant','display'])assert.equal(parseCommandEnvelope(command,role).ok,false);
 for(const page of [-1,300,1.5,'0'])assert.equal(parseCommandEnvelope({...command,page},'facilitator').ok,false);
 assert.equal(parseCommandEnvelope({...command,expectRevision:undefined},'facilitator').ok,false);
});
test('long answers share a bounded page without deduplicating people who gave the same answer',()=>{
 const r=room(),ids=[uuidv7(),uuidv7(),uuidv7()];
 for(const id of ids)r.send('join',{displayName:'Learner'},{role:'participant',id});
 r.send('start');r.send('advance');r.send('advance');
 ids.forEach((id,i)=>r.send('vote',{roundId:r.state.round.id,responseId:uuidv7(),response:{text:i===2?'Beta'.repeat(125):'Alpha'.repeat(100)}},{role:'participant',id}));
 r.send('lock');const closedRoundId=r.state.round.id;
 assert.deepEqual(r.display().responseResult.textPage.answers,['Alpha'.repeat(100),'Alpha'.repeat(100)]);
 assert.equal(r.display().responseResult.textPage.pages,2);
 assert.equal(r.send('text_page',{closedRoundId,page:1,expectRevision:r.state.revision-1}),'rejected');
 assert.equal(r.send('text_page',{closedRoundId,page:1}),'accepted');
 assert.deepEqual(r.display().responseResult.textPage.answers,['Beta'.repeat(125)]);
});

test('[AS-187] twelve prescription-length answers take two projector pages, not six; twelve short ones take one (CASE-318)',()=>{
 const r=room(),ids=Array.from({length:12},()=>uuidv7());
 for(const id of ids)r.send('join',{displayName:'Learner'},{role:'participant',id});
 r.send('start');r.send('advance');r.send('advance');
 const answers=ids.map((_,i)=>`Salbutamol 5 mg nebulised back to back, ipratropium 500 mcg, hydrocortisone 100 mg IV (${i})`);
 ids.forEach((id,i)=>r.send('vote',{roundId:r.state.round.id,responseId:uuidv7(),response:{text:answers[i]}},{role:'participant',id}));
 r.send('lock');const view=r.display();
 // ~92 characters is 4 lines + its chip edge at the 1280×720 floor, so 8 fit the 42-line page and 4 follow.
 assert.equal(view.responseResult.textPage.pages,2);assert.equal(view.responseResult.textPage.answers.length,8);assert.ok(acceptDisplayView(view));
 const over=structuredClone(view);over.responseResult.textPage.answers=[...answers].sort().slice(0,9);assert.equal(acceptDisplayView(over),null,'a page over the line budget is refused');
 const short=room(),sids=Array.from({length:13},()=>uuidv7());
 for(const id of sids)short.send('join',{displayName:'Learner'},{role:'participant',id});
 short.send('start');short.send('advance');short.send('advance');
 sids.forEach((id,i)=>short.send('vote',{roundId:short.state.round.id,responseId:uuidv7(),response:{text:`Recheck the gas ${String(i).padStart(2,'0')}`}},{role:'participant',id}));
 short.send('lock');const s=short.display().responseResult.textPage;
 assert.equal(s.answers.length,12);assert.equal(s.pages,2,'never more than 12 on a page');
});

test('removing a participant after close removes their answer and keeps public counts and pages valid',()=>{
 const r=room(),ids=[uuidv7(),uuidv7(),uuidv7()];
 for(const id of ids)r.send('join',{displayName:'Learner'},{role:'participant',id});
 r.send('start');r.send('advance');r.send('advance');
 ids.forEach((id,i)=>r.send('vote',{roundId:r.state.round.id,responseId:uuidv7(),response:{text:['Alpha','Beta','Gamma'][i].repeat(20)}},{role:'participant',id}));
 r.send('lock');r.send('text_page',{closedRoundId:r.state.round.id,page:1});
 for(let i=2;i>=0;i--){
  assert.equal(r.send('remove_participant',{participantId:ids[i]}),'accepted');
  const view=r.display();assert.ok(acceptDisplayView(view));
  assert.equal(view.responseResult.total,i);assert.equal(view.responseResult.textPage.page,0);
  assert.deepEqual(view.responseResult.textPage.answers,['Alpha','Beta'].slice(0,i).map(t=>t.repeat(20)));
 }
 assert.equal(r.state.round.aggregate.total,3,'frozen review aggregate is unchanged');
});

test('short response chips show twelve distinct contributions per page and retain all forty answers',()=>{
 const r=room(),ids=Array.from({length:40},()=>uuidv7()),answers=ids.map((_,i)=>`Idea ${String(i).padStart(2,'0')}`);
 for(const id of ids)r.send('join',{displayName:'Private learner'},{role:'participant',id});
 r.send('start');r.send('advance');r.send('advance');
 ids.forEach((id,i)=>r.send('vote',{roundId:r.state.round.id,responseId:uuidv7(),response:{text:answers[i]}},{role:'participant',id}));
 r.send('lock');const closedRoundId=r.state.round.id,seen=[];
 assert.equal(r.display().responseResult.textPage.pages,4);
 for(let page=0;page<4;page++){
  assert.equal(r.send('text_page',{closedRoundId,page}),'accepted');
  const view=r.display();assert.ok(acceptDisplayView(view));
  assert.equal(view.responseResult.textPage.answers.length,page===3?4:12);
  seen.push(...view.responseResult.textPage.answers);
 }
 assert.deepEqual(seen,answers);
});

test('projector refuses a thirteenth chip on one page',()=>{
 const r=room(),ids=Array.from({length:13},()=>uuidv7());
 for(const id of ids)r.send('join',{displayName:'Learner'},{role:'participant',id});
 r.send('start');r.send('advance');r.send('advance');
 for(const id of ids)r.send('vote',{roundId:r.state.round.id,responseId:uuidv7(),response:{text:'Idea'}},{role:'participant',id});
 r.send('lock');const view=r.display();assert.ok(acceptDisplayView(view));
 assert.equal(view.responseResult.textPage.answers.length,12);
 view.responseResult.textPage.answers.push('Idea');assert.equal(acceptDisplayView(view),null);
});
