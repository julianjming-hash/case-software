import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, facilitatorActions, applySegment } from '../src/shared/room-machine.mjs';
import { parseCommandEnvelope, parseManualSegment, buildEvent } from '../src/shared/wire.mjs';
import { acceptDisplayView } from '../src/client/projector-view.mjs';
import { validRankedPage } from '../src/shared/ranked-page-view.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { projectorFrame } from '../src/client/console-projection.mjs';
import { ConsoleManualRoom } from '../src/client/console-manual.mjs';
import { LocalAuthority } from '../prototypes/room/lib/local-authority.mjs';

function rankingRoom(count = 3, label = null, prompt = null) {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = count;
  while (decision.interaction.options.length < count) decision.interaction.options.push({ id: uuidv7(), label: `Option ${decision.interaction.options.length + 1}` });
  if (label !== null) decision.interaction.options.forEach(option => { option.label = label; });
  if (prompt !== null) decision.prompt = prompt;
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: fixture.doc });
  const ledger = new Map(), facilitatorId = uuidv7(); let at = Date.parse('2026-10-03T09:00:00Z');
  const send = (type, payload = {}, actor = { role: 'facilitator', id: facilitatorId }) => {
    const output = dispatch(state, { type, epoch: state.epoch, actor, at: new Date(at += 1000).toISOString(), clientEventId: uuidv7(),
      ...(['start','advance','reopen','reset_checkpoint'].includes(type) ? { roundId: uuidv7() } : {}),
      ...(['advance','ranked_page'].includes(type) ? { expectRevision: state.revision } : {}),
      ...(type==='ranked_page'?{closedRoundId:project(state,'facilitator').rankedRoundId}:{}), ...payload }, ledger);
    state = output.state; return output.effects.find(effect => effect.type === 'receipt');
  };
  const join = () => { const id = uuidv7(); assert.equal(send('join', { displayName: 'Private learner' }, { role: 'participant', id }).receipt, 'accepted'); return id; };
  const vote = (id, tuple, payload = {}) => send('vote', { roundId: state.round.id, responseId: uuidv7(), response: { order: [...tuple].map(index => decision.interaction.options[Number(index)].id) }, ...payload }, { role: 'participant', id });
  const open = () => { send('start'); send('advance'); send('advance'); };
  return { fixture, decision, send, join, vote, open, get state() { return state; }, display: () => project(state, 'display'), console: () => project(state, 'facilitator') };
}
function eighteen() {
  const r = rankingRoom(), participants = Array.from({ length: 18 }, r.join); r.open();
  let p = 0; for (const [tuple, count] of [['012',10],['021',5],['102',2],['210',1]]) for (let n = 0; n < count; n++) r.vote(participants[p++], tuple);
  r.send('lock'); return r;
}

test('Card25 authority freezes latest complete orders, excludes removal before lock and retains post-lock removal', () => {
  const r = rankingRoom(3, 'Repeated label'), a = r.join(), b = r.join(), c = r.join(); r.open();
  r.vote(a,'210'); const event = { clientEventId: uuidv7() };
  assert.equal(r.vote(a,'012',event).receipt,'accepted'); assert.equal(r.vote(a,'012',event).receipt,'already_accepted');
  r.vote(b,'021'); r.vote(c,'102'); r.send('remove_participant',{participantId:c});
  assert.equal(r.vote(a,'01').receipt,'rejected'); assert.equal(r.vote(a,'001').receipt,'rejected');
  assert.equal(r.display().responseResult,null); r.send('lock');
  assert.deepEqual(r.state.round.aggregate.completeOrders,[['012',1],['021',1]]);
  assert.equal(r.state.round.suggestion.pathId,r.fixture.p.decompress);
  assert.equal(r.state.selectedPathId,null);
  assert.equal(r.state.round.aggregate.total,2); const frozen=structuredClone(r.state.round.aggregate);
  r.send('remove_participant',{participantId:a}); assert.deepEqual(r.state.round.aggregate,frozen);
  assert.deepEqual(r.display().responseResult.ranked.groups,[['012',1],['021',1]]);
});

test('Card25 exact Other and Back preserve count authority, Hide choice and direct minority selection', () => {
  const r = eighteen(), frozen=structuredClone(r.state.round), result=r.display().responseResult;
  assert.ok(result.ranked,'closed complete-order projection exists');
  assert.deepEqual(result.ranked.groups,[['012',10],['021',5]]); assert.equal(result.total,18);
  assert.equal(result.ranked.residualTotal,3); assert.ok(facilitatorActions(r.state).includes('ranked_page'));
  assert.equal(r.send('ranked_page',{group:2,position:0}).receipt,'accepted');
  assert.deepEqual(r.display().responseResult.ranked.groups,[['102',2],['210',1]]);
  assert.equal(r.display().responseResult.total,18); assert.deepEqual(r.state.round,frozen);
  assert.equal(r.send('ranked_page',{group:3,position:0}).receipt,'accepted');
  assert.deepEqual(r.display().responseResult.ranked.groups,[['210',1]]);
  r.send('show_results',{on:false}); assert.equal(r.send('ranked_page',{group:0,position:0}).receipt,'rejected');
  assert.deepEqual(r.state.rankedSelection,{group:3,position:0}); r.send('show_results',{on:true});
  r.send('ranked_page',{group:0,position:0}); assert.deepEqual(r.display().responseResult.ranked.groups,result.ranked.groups);
  assert.equal(r.state.resultsShown,true); assert.equal(r.state.selectedPathId,null);
});

test('Card25 group authority requires facilitator, exact observed revision and bounded strict wire payloads', () => {
  const r=eighteen(), current=r.state.revision, original=structuredClone(r.state.rankedSelection);
  for (const bad of [{group:4,position:0},{group:0,position:3},{group:-1,position:0},{group:0,position:0,expectRevision:current-1},{group:0,position:0,expectRevision:undefined}]) {
    assert.equal(r.send('ranked_page',bad).receipt,'rejected'); assert.deepEqual(r.state.rankedSelection,original);
  }
  assert.equal(r.send('ranked_page',{group:1,position:0},{role:'display',id:uuidv7()}).receipt,'rejected');
  const e={v:1,type:'ranked_page',epoch:0,clientEventId:uuidv7(),group:299,position:7,closedRoundId:uuidv7(),expectRevision:0};
  assert.equal(parseCommandEnvelope(e,'facilitator').ok,true);
  for (const role of ['display','participant']) assert.equal(parseCommandEnvelope(e,role).ok,false);
  for (const bad of [{group:300},{position:8},{expectRevision:undefined},{group:1.5},{pathId:uuidv7()}]) assert.equal(parseCommandEnvelope({...e,...bad},'facilitator').ok,false);
});

test('Card25 fixed density continuations retain full tuple identity, ranks and original totals for counts two through eight', () => {
  for (let count=2;count<=8;count++) for (const label of ['Short option','界'.repeat(120),'W'.repeat(120)]) {
    const r=rankingRoom(count,label), p=r.join();r.open();r.vote(p,Array.from({length:count},(_,i)=>i).join(''));r.send('lock');
    const first=r.display().responseResult.ranked; assert.ok(first,'closed complete-order projection exists'); const span=label==='Short option'?Math.min(5,count):Math.min(2,count);
    assert.equal(first.positionSpan,span); assert.equal(first.groupCount,1);
    for(let position=0;position<count;position+=span){
      assert.equal(r.send('ranked_page',{group:0,position}).receipt,'accepted'); const page=r.display().responseResult.ranked;
      assert.equal(page.positionStart,position);assert.equal(page.positionSpan,Math.min(span,count-position));
      assert.deepEqual(page.groups,[[Array.from({length:count},(_,i)=>i).join(''),1]]);assert.equal(r.display().responseResult.total,1);
    }
  }
  for(let count=2;count<=8;count++)for(const label of ['Short option','界'.repeat(120),'W'.repeat(120)]){
    const r=rankingRoom(count,label,'界'.repeat(200)),person=r.join();r.open();r.vote(person,Array.from({length:count},(_,index)=>index).join(''));r.send('lock');
    const span=label==='Short option'?Math.min(3,count):1;
    assert.equal(r.display().responseResult.ranked.positionSpan,span);
    assert.equal(r.console().rankedPositionSpan,span);
    for(let position=0;position<count;position+=span){assert.equal(r.send('ranked_page',{group:0,position}).receipt,'accepted');assert.equal(r.display().responseResult.ranked.positionStart,position);}
  }
  const maximum=rankingRoom(8,'界'.repeat(120),'界'.repeat(200)), people=Array.from({length:300},maximum.join), tuples=[];
  const permutations=(prefix,remaining)=>{if(tuples.length===300)return;if(!remaining.length){tuples.push(prefix);return;}for(const digit of remaining)permutations(prefix+digit,remaining.filter(x=>x!==digit));};
  permutations('',[...'01234567']);maximum.open();people.forEach((person,index)=>maximum.vote(person,tuples[index]));maximum.send('lock');
  assert.equal(maximum.state.round.aggregate.completeOrders.length,300);
  const encoded=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const snapshot=role=>({t:'snapshot',epoch:maximum.state.epoch,revision:maximum.state.revision,displayRevision:maximum.state.display.revision,
    view:project(maximum.state,role,people[0]),...(role==='facilitator'?{mirror:(({caseDoc,...mirror})=>mirror)(maximum.state)}:{})});
  const measure={qualifier:'Clean typed legal fixture; unknown observation properties and expanded histories are not bounded by these samples.',
    stateCodeUnits:JSON.stringify(maximum.state).length,stateUtf8:encoded(maximum.state),casePack:encoded({caseDocument:maximum.fixture.doc}),
    facilitatorHttpWs:encoded(snapshot('facilitator')),displayHttpWs:encoded(snapshot('display')),participantHttpWs:encoded(snapshot('participant')),
    samePc:encoded(projectorFrame(snapshot('facilitator'),maximum.fixture.doc))};
  assert.ok(measure.stateCodeUnits<1_000_000);assert.ok(measure.stateUtf8<1_000_000);assert.ok(measure.samePc<measure.facilitatorHttpWs);
  const expected=tuples.slice().sort();
  for(let group=0;group<300;group++){
    assert.equal(maximum.send('ranked_page',{group,position:6}).receipt,'accepted');
    assert.equal(maximum.display().responseResult.ranked.groups[0][0],expected[group]);
    assert.equal(maximum.display().responseResult.ranked.groupCount,1);assert.equal(maximum.display().responseResult.total,300);
  }
  maximum.send('select_path',{pathId:maximum.fixture.p.decompress});maximum.send('show_results',{on:false});maximum.send('reveal');maximum.send('show_results',{on:true});
  const stored=new Map(),channel={postMessage(frame){measure.manualFrame=encoded(frame);}},storage={setItem(k,v){stored.set(k,v);},getItem(k){return stored.get(k)??null;},removeItem(k){stored.delete(k);}};
  const {caseDoc,...mirror}=maximum.state, manual=new ConsoleManualRoom(mirror,caseDoc,{channel,storage});
  assert.equal(manual.enter().receipt,'accepted');
  assert.equal(manual.command('ranked_page',{group:299,position:6,closedRoundId:manual.view().rankedRoundId,expectRevision:manual.state.revision}).receipt,'accepted');
  measure.manualSaved=encoded(ConsoleManualRoom.saved(maximum.state.sessionId,storage));measure.manualUpload=encoded(manual.segmentBody());
  assert.ok(measure.manualSaved<256000);assert.ok(measure.manualUpload<256000);assert.ok(!JSON.stringify(manual.segmentBody()).includes('Private learner'));
  console.log('Card25 clean typed maximum-group measurements',JSON.stringify(measure));manual.close();
});

test('[AS-092] Card25 public selected tuples are strict anonymous closure-only data and legacy marginals never fabricate groups', () => {
  const r=eighteen(), clean=r.display();assert.equal(acceptDisplayView(clean),clean);assert.ok(clean.responseResult.ranked,'closed complete-order projection exists');
  assert.equal(clean.responseResult.ranked.groups.length,2);assert.equal(clean.responseResult.ranked.totalGroups,4);
  assert.equal(r.console().round.aggregate.completeOrders.length,4);
  assert.ok(!JSON.stringify(clean).includes('Private learner'));assert.ok(!Object.hasOwn(clean.responseResult,'completeOrders'));
  const omittedMeaning=structuredClone(clean);delete omittedMeaning.responseResult.ranked.orderMeaning;
  const acceptedLegacy=acceptDisplayView(omittedMeaning);
  assert.ok(acceptedLegacy,'absent legacy meaning remains a valid neutral ranked result');
  assert.equal(acceptedLegacy.responseResult.ranked.orderMeaning,null,'only absence normalizes to explicit neutral meaning');
  const empty=structuredClone(clean.responseResult);empty.total=0;
  empty.counts.forEach(row=>{row.count=0;row.positionCounts=[0,0,0];});
  Object.assign(empty.ranked,{groups:[],groupStart:0,groupCount:0,totalGroups:0});delete empty.ranked.residualTotal;
  assert.equal(validRankedPage(empty.ranked,empty),true,'genuine legal empty ranking remains valid');
  const ninth=structuredClone(empty);ninth.rankCount=9;ninth.counts.forEach(row=>{row.positionCounts=Array(9).fill(0);});
  assert.equal(validRankedPage(ninth.ranked,ninth),false,'reject rank count nine before allocation');
  const huge=structuredClone(empty);huge.rankCount=Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(()=>assert.equal(validRankedPage(huge.ranked,huge),false),'reject enormous rank count without allocating');
  for(const malformed of [{...empty,total:301},{...empty,counts:null},{...empty,prompt:null}])
    assert.equal(validRankedPage(empty.ranked,malformed),false,'bound raw result before layout or allocation');
  const corrupt=change=>{const v=structuredClone(clean);change(v.responseResult.ranked);assert.equal(acceptDisplayView(v),null);};
  for(const change of [x=>x.groups.push(['102',2]),x=>x.groups[0][0]='001',x=>x.groups[0][1]=19,x=>x.positionStart=3,x=>x.groupStart=4,x=>x.orderMeaning='correct',x=>x.orderMeaning=42,x=>x.orderMeaning=undefined,x=>x.participantId=uuidv7()])corrupt(change);
  // Every tuple separately fits these marginals, but the two displayed orders
  // jointly claim eleven first-position A answers where only ten exist.
  const impossible=structuredClone(clean);
  impossible.responseResult.ranked.groups=[['012',6],['021',5]];
  delete impossible.responseResult.ranked.residualTotal;
  const margins=[[10,4,4],[4,7,7],[4,7,7]];
  impossible.responseResult.counts.forEach((row,index)=>{row.count=margins[index][0];row.positionCounts=margins[index];});
  assert.equal(acceptDisplayView(impossible),null,'combined selected tuple counts cannot exceed a position marginal');
  const exhausted=structuredClone(clean);
  exhausted.responseResult.ranked.groups=[['012',10],['021',8]];
  delete exhausted.responseResult.ranked.residualTotal;
  const exhaustedMargins=[[18,0,0],[0,10,8],[0,8,10]];
  exhausted.responseResult.counts.forEach((row,index)=>{row.count=exhaustedMargins[index][0];row.positionCounts=exhaustedMargins[index];});
  assert.equal(acceptDisplayView(exhausted),null,'positive undisplayed groups need remaining responses');
  const tooMany=structuredClone(clean);tooMany.responseResult.ranked.groups=[['012',6],['021',5]];
  tooMany.responseResult.ranked.totalGroups=7;delete tooMany.responseResult.ranked.residualTotal;
  assert.equal(acceptDisplayView(tooMany),null,'group inventory cannot exceed distinct full permutations');
  const impossiblePrefix=structuredClone(tooMany);impossiblePrefix.responseResult.ranked.totalGroups=4;impossiblePrefix.responseResult.ranked.groupStart=2;
  assert.equal(acceptDisplayView(impossiblePrefix),null,'earlier sorted groups each need at least the first selected count');
  const forcedTie=structuredClone(clean);forcedTie.responseResult.total=13;
  const tiedMargins=[[11,1,1],[1,11,1],[1,1,11]];
  forcedTie.responseResult.counts.forEach((row,index)=>{row.count=tiedMargins[index][0];row.positionCounts=tiedMargins[index];});
  forcedTie.responseResult.ranked.groups=[['012',10],['021',1]];forcedTie.responseResult.ranked.residualTotal=2;
  assert.equal(acceptDisplayView(forcedTie),null,'positive hidden orders cannot tie the second group in an Other summary');
  delete r.state.round.aggregate.completeOrders;assert.equal(r.display().responseResult.ranked,undefined,'legacy marginal totals are not tuple evidence');
  r.send('show_results',{on:false});assert.equal(r.display().responseResult,null);r.send('show_names',{on:true});assert.ok(r.display().names);r.send('show_results',{on:true});assert.equal(r.display().names,null);
  r.send('void_round');assert.equal(r.display().responseResult,null);assert.deepEqual(r.state.rankedSelection,{group:0,position:0});
});

test('Card25 navigation survives replay and stable manual but resets on new rounds and end without altering phone result timing', () => {
  const r=eighteen();r.send('ranked_page',{group:2,position:0});
  const person=Object.keys(r.state.participants)[0];assert.equal(project(r.state,'participant',person).lastResult,null);
  r.send('select_path',{pathId:r.fixture.p.decompress});r.send('show_results',{on:false});r.send('reveal');r.send('show_results',{on:true});
  assert.ok(project(r.state,'participant',person).lastResult);assert.equal(project(r.state,'participant',person).lastResult.ranked,undefined);
  r.send('replay',{surfaceId:r.fixture.s.open});assert.equal(r.display().responseResult,null);assert.deepEqual(r.state.rankedSelection,{group:2,position:0});
  r.send('replay',{surfaceId:null});assert.deepEqual(r.display().responseResult.ranked.groups,[['102',2],['210',1]]);
  r.send('enter_manual',{segmentId:uuidv7()});assert.deepEqual(r.state.rankedSelection,{group:2,position:0});
  r.send('show_results',{on:false});r.send('advance');assert.deepEqual(r.state.rankedSelection,{group:0,position:0});
  r.send('end');assert.deepEqual(r.state.rankedSelection,{group:0,position:0});assert.equal(r.display().responseResult,null);
});


test('Card25 manual ranked selection replays after an otherwise legal server participant arrival',()=>{
  const r=eighteen();
  r.send('show_results',{on:false});r.send('select_path',{pathId:r.fixture.p.decompress});r.send('reveal');r.send('show_results',{on:true});
  const {caseDoc,...mirror}=r.state;
  const entries=new Map(), storage={setItem(key,value){entries.set(key,value);},getItem(key){return entries.get(key)??null;},removeItem(key){entries.delete(key);}};
  const manual=new ConsoleManualRoom(mirror,caseDoc,{storage,channel:{postMessage(){}}});
  assert.equal(manual.enter().receipt,'accepted');
  assert.equal(manual.command('ranked_page',{group:2,position:0,closedRoundId:manual.view().rankedRoundId,expectRevision:manual.state.revision}).receipt,'accepted');
  r.join(); // An admitted participant reaches the server after this device's outage.
  const parsed=parseManualSegment(manual.segmentBody());assert.equal(parsed.ok,true);
  const events=parsed.events.map(({envelope,at})=>buildEvent(envelope,{actor:{role:'facilitator',id:'facilitator'},at,newId:uuidv7}));
  const replay=applySegment(r.state,events,new Map());
  assert.equal(replay.ok,true,`legal selection replay failed at ${replay.failedAt}: ${replay.reason}`);
  assert.deepEqual(project(replay.state,'display').responseResult.ranked.groups,[['102',2],['210',1]]);
  assert.equal(Object.hasOwn(manual.segmentBody().events[1],'expectRevision'),false,'transient revision is not persisted');
  const saved=ConsoleManualRoom.saved(r.state.sessionId,manual.storage);
  assert.equal(saved.events[1].closedRoundId,r.state.rounds.at(-1).id);
  const {caseDoc:freshCase,...freshMirror}=r.state;
  const restored=ConsoleManualRoom.restore(freshMirror,freshCase,saved,{storage:manual.storage,channel:{postMessage(){}}});
  assert.ok(restored,'fresh mirror plus late arrival restores the same semantic selection');
  assert.deepEqual(restored.state.rankedSelection,{group:2,position:0});
  restored.close();
  const ledger=new Map(), once=applySegment(r.state,events,ledger);
  assert.equal(once.ok,true);const ledgerSize=ledger.size;
  const repeated=applySegment(once.state,events,ledger);
  assert.equal(repeated.ok,true);assert.deepEqual(repeated.state,once.state);assert.equal(ledger.size,ledgerSize);
  const mutated=events.map(event=>event.type==='ranked_page'?{...event,closedRoundId:uuidv7()}:event);
  const reused=applySegment(once.state,mutated,ledger);
  assert.equal(reused.ok,false);assert.equal(reused.reason,'client_event_id_reused');assert.deepEqual(reused.state,once.state);
  const badTail={...events[1],clientEventId:uuidv7(),closedRoundId:uuidv7()};
  const atomicLedger=new Map(), failed=applySegment(r.state,[...events,badTail],atomicLedger);
  assert.equal(failed.ok,false);assert.equal(failed.failedAt,2);assert.equal(failed.reason,'stale_closed_round');
  assert.deepEqual(failed.state,r.state);assert.deepEqual(failed.effects,[]);assert.equal(atomicLedger.size,0);
  const badSaved=structuredClone(saved);badSaved.events[1].closedRoundId=uuidv7();
  assert.equal(ConsoleManualRoom.restore(freshMirror,freshCase,badSaved,{storage:manual.storage,channel:{postMessage(){}}}),null);
  assert.equal(parseCommandEnvelope(saved.events[1],'facilitator').ok,false,'stored manual envelope cannot bypass the online parser');
  manual.close();
  // The prototype uses its actual BroadcastChannel and sessionStorage branches.
  const priorStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),prototypeEntries=new Map();
  const prototypeStorage={setItem(key,value){prototypeEntries.set(key,value);},getItem(key){return prototypeEntries.get(key)??null;},removeItem(key){prototypeEntries.delete(key);}};
  let local,prototypeRestored;
  try {
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:prototypeStorage});
    local=new LocalAuthority(mirror,caseDoc);
    assert.equal(local.enter().receipt,'accepted');
    assert.equal(local.command('ranked_page',{group:2,position:0,closedRoundId:local.view().rankedRoundId,expectRevision:local.state.revision}).receipt,'accepted');
    const prototypeSaved=LocalAuthority.saved(r.state.sessionId);
    assert.equal(Object.hasOwn(prototypeSaved.events[1],'expectRevision'),false,'prototype transient revision is not persisted');
    assert.equal(prototypeSaved.events[1].closedRoundId,r.state.rounds.at(-1).id);
    assert.equal(parseCommandEnvelope(prototypeSaved.events[1],'facilitator').ok,false,'prototype stored envelope cannot bypass the online parser');
    prototypeRestored=LocalAuthority.restore(freshMirror,freshCase,prototypeSaved);
    assert.ok(prototypeRestored,'prototype fresh mirror plus late arrival restores the same semantic selection');
    assert.deepEqual(prototypeRestored.view().rankedPresentation.groups,[['102',2],['210',1]]);
    assert.deepEqual(prototypeRestored.state.rankedSelection,{group:2,position:0});
    const prototypeBad=structuredClone(prototypeSaved);prototypeBad.events[1].closedRoundId=uuidv7();
    assert.equal(LocalAuthority.restore(freshMirror,freshCase,prototypeBad),null,'prototype cannot restore a different semantic closure');
  } finally {
    prototypeRestored?.close();local?.close();
    if(priorStorage)Object.defineProperty(globalThis,'sessionStorage',priorStorage);else delete globalThis.sessionStorage;
  }
});


test('Card25 closed-round targeting rejects a different closure even with a current online revision',()=>{
  const r=eighteen(), before=structuredClone(r.state.rankedSelection);
  assert.equal(r.send('ranked_page',{group:2,position:0,closedRoundId:uuidv7()}).receipt,'rejected','page authority must bind the frozen response round');
  assert.deepEqual(r.state.rankedSelection,before);
  assert.equal(r.send('ranked_page',{group:2,position:0,closedRoundId:undefined}).receipt,'rejected');
  const previousClosure=r.state.round.id, clientEventId=uuidv7();
  assert.equal(r.send('ranked_page',{group:2,position:0,clientEventId}).receipt,'accepted');
  assert.equal(r.send('ranked_page',{group:2,position:0,clientEventId}).receipt,'already_accepted');
  assert.equal(r.send('ranked_page',{group:2,position:0,clientEventId,closedRoundId:uuidv7()}).reason,'client_event_id_reused');
  r.send('reopen');const learner=Object.keys(r.state.participants)[0];r.vote(learner,'012');r.send('lock');
  assert.notEqual(r.state.round.id,previousClosure);
  assert.equal(r.send('ranked_page',{group:0,position:0,closedRoundId:previousClosure}).reason,'stale_closed_round');
  assert.equal(r.send('ranked_page',{group:0,position:0}).receipt,'accepted');
});
