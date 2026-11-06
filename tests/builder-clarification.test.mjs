import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, applySegment } from '../src/shared/room-machine.mjs';
import { parseManualSegment, buildEvent } from '../src/shared/wire.mjs';
import { ConsoleManualRoom } from '../src/client/console-manual.mjs';
import { miniCase } from './helpers/mini-case.mjs';

function fixture(){
 const f=miniCase();f.doc.schema_version=2;f.doc.required_capabilities=['early_clarification'];
 const surface={id:uuidv7(),kind:'text',title:'Exposure details',points:['Authored shared detail'],notes:'PRIVATE clarification cue'};
 f.doc.surfaces.push(surface);
 const card={id:uuidv7(),label:'Exposure',surface_id:surface.id,beat_ids:[f.b.d1]}; f.doc.clarifications=[card];
 let state=initialState({sessionId:uuidv7(),caseDoc:f.doc});const ledger=new Map();
 const send=(type,payload={})=>{const e={type,actor:{role:'facilitator'},epoch:state.epoch,expectRevision:state.revision,clientEventId:uuidv7(),at:'2026-10-09T00:00:00Z',...(['start','advance'].includes(type)?{roundId:uuidv7()}:{}),...payload};const r=dispatch(state,e,ledger);state=r.state;return r.effects[0];};
 send('start');send('advance');send('advance');
 return {...f,card,surface,send,get state(){return state;}};
}
test('clarification explicitly shares an authored card during the same open round then restores exact reveal progress',()=>{
 const f=fixture(),before=f.state,context=before.revealed.at(-1),round=before.round.id;
 assert.equal(f.send('show_clarification',{clarificationId:f.card.id}).receipt,'accepted');
 assert.equal(f.state.phase,'responses_open');assert.equal(f.state.round.id,round);
 assert.equal(project(f.state,'display').surface.title,f.surface.title);
 assert.equal(JSON.stringify(project(f.state,'display')).includes('PRIVATE'),false);
 assert.equal(f.send('lock').reason,'return_from_clarification_first');
 assert.equal(f.send('advance').reason,'return_from_clarification_first');
 assert.equal(f.send('show_clarification',{clarificationId:f.card.id}).reason,'clarification_already_shown');
 assert.equal(f.send('return_clarification',{occurrenceId:f.state.revealed.at(-1).occurrenceId}).receipt,'accepted');
 assert.equal(f.state.round.id,round);assert.equal(f.state.revealed.at(-1).surfaceId,context.surfaceId);
 assert.equal(f.state.revealed.at(-1).groupsShown,context.groupsShown);
 assert.notEqual(f.state.revealed.at(-1).occurrenceId,context.occurrenceId);
});
test('clarification refuses unknown, disallowed, stale and legacy requests without changing state',()=>{
 const f=fixture();assert.equal(f.send('show_clarification',{clarificationId:uuidv7()}).reason,'clarification_unavailable');
 f.doc.clarifications[0].beat_ids=[];
 assert.equal(f.send('show_clarification',{clarificationId:f.card.id}).reason,'clarification_unavailable');
 f.doc.clarifications[0].beat_ids=[f.b.d1];
 f.send('show_clarification',{clarificationId:f.card.id});const before=f.state;
 assert.equal(f.send('return_clarification',{occurrenceId:uuidv7()}).reason,'stale_clarification_occurrence');assert.equal(f.state,before);
});

test('clarification releases each authored group only on its own press while votes remain open',()=>{
 const f=fixture();f.surface.scene='First shared scene';f.surface.investigations=['Later investigation'];
 f.send('show_clarification',{clarificationId:f.card.id});
 let display=project(f.state,'display');assert.equal(display.surface.scene,'First shared scene');assert.deepEqual(display.surface.points,[]);assert.deepEqual(display.surface.investigations,[]);
 assert.equal(f.send('advance').receipt,'accepted');display=project(f.state,'display');assert.deepEqual(display.surface.points,['Authored shared detail']);assert.deepEqual(display.surface.investigations,[]);
 assert.equal(f.send('advance').receipt,'accepted');assert.deepEqual(project(f.state,'display').surface.investigations,['Later investigation']);assert.equal(f.state.round.status,'open');
});

test('online clarification chronology survives outage entry; manual sharing is fenced and unavailable',()=>{
 const f=fixture();
 assert.equal(f.send('show_clarification',{clarificationId:f.card.id}).receipt,'accepted');
 const clarificationOccurrence=f.state.revealed.at(-1).occurrenceId;
 assert.equal(f.send('return_clarification',{occurrenceId:clarificationOccurrence}).receipt,'accepted');
 const base=f.state, {caseDoc,...mirror}=base;
 const entries=new Map(), storage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
 const manual=new ConsoleManualRoom(mirror,caseDoc,{storage,channel:{postMessage(){},close(){}}});
 assert.equal(manual.enter().receipt,'accepted');
 const before=manual.state;
 const shown=manual.command('show_clarification',{clarificationId:f.card.id});
 assert.equal(shown.receipt,'rejected'); assert.equal(shown.reason,'clarification_unavailable'); assert.equal(manual.state,before);
 const parsed=parseManualSegment(manual.segmentBody()); assert.equal(parsed.ok,true);
 const events=parsed.events.map(({envelope,at})=>buildEvent(envelope,{actor:{role:'facilitator',id:'facilitator'},at,newId:uuidv7}));
 const uploaded=applySegment(base,events,new Map());
 assert.equal(uploaded.ok,true);
 assert.equal(uploaded.state.phase,'surface_live');
 assert.equal(uploaded.state.round,null);
 assert.equal(uploaded.state.rounds.at(-1).status,'abandoned');
 assert.equal(uploaded.state.revealed.some(entry=>entry.clarificationId===f.card.id),true);
 assert.equal(uploaded.state.revealed.at(-1).clarificationReturnOf,base.revealed.at(-1).clarificationReturnOf);
 assert.equal(uploaded.state.clarification,null);
});
