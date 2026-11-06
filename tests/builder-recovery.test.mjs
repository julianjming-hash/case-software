import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, applySegment } from '../src/shared/room-machine.mjs';
import { parseCommandEnvelope, buildEvent } from '../src/shared/wire.mjs';
import { miniCase } from './helpers/mini-case.mjs';

function room({ terminal = false, legacy = false, manual = false } = {}) {
  const f = miniCase();
  if (!legacy) { f.doc.schema_version = 2; f.doc.required_capabilities = ['required_recovery']; }
  const path = f.doc.decisions[0].paths.find(p => p.id === (terminal ? f.p.intubate : f.p.image));
  path.recovery = { prompt: 'Confirm the authored recovery action.' };
  let state = initialState({ sessionId: uuidv7(), caseDoc: f.doc }), tick = 0;
  const ledger = new Map();
  function send(type, payload = {}, role = 'facilitator') {
    const event = { type, actor: { role }, epoch: state.epoch, clientEventId: uuidv7(),
      expectRevision: state.revision, at: new Date(Date.UTC(2026, 9, 9, 0, 0, tick++)).toISOString(),
      ...(['start','advance','reopen','reset_checkpoint','undo'].includes(type) ? {roundId:uuidv7()} : {}), ...payload };
    if (!['start','advance','lock','select_path','reveal_path','undo','reset_checkpoint','enter_manual','resume_online','end','confirm_recovery'].includes(type)) delete event.expectRevision;
    const result = dispatch(state, event, ledger); state = result.state;
    return { ...result, event, receipt: result.effects.find(e => e.type === 'receipt') };
  }
  if (manual) send('enter_manual',{segmentId:uuidv7()});
  send('start'); send('advance'); send('advance'); send('lock');
  const revealed = send('reveal_path', { pathId: path.id });
  assert.equal(revealed.receipt.receipt, 'accepted');
  return { ...f, path, send, ledger, get state(){return state;} };
}

test('[AS-122] required recovery blocks rejoin and is only confirmed for the current occurrence', () => {
  const a = room(), before = a.state;
  assert.equal(a.send('advance').receipt.reason, 'recovery_required');
  assert.equal(a.state, before);
  const view = project(a.state,'facilitator');
  assert.equal(view.recovery.prompt, a.path.recovery.prompt);
  assert.equal(view.recovery.confirmed,false);
  assert.ok(!view.actions.includes('advance'));
  assert.equal(a.send('confirm_recovery',{occurrenceId:uuidv7(),confirmed:true}).receipt.reason,'stale_recovery_occurrence');
  assert.equal(a.send('confirm_recovery',{occurrenceId:view.recovery.occurrenceId,confirmed:true},'participant').receipt.reason,'forbidden');
  assert.equal(a.send('confirm_recovery',{occurrenceId:view.recovery.occurrenceId,confirmed:true}).receipt.receipt,'accepted');
  assert.equal(project(a.state,'facilitator').recovery.confirmed,true);
  assert.equal(a.send('advance').receipt.receipt,'accepted');
});

test('recovery has a deliberate correction and survives manual authority changes without bypass', () => {
  const a=room(),occurrenceId=a.state.revealed.at(-1).occurrenceId;
  assert.equal(a.send('confirm_recovery',{occurrenceId,confirmed:true}).receipt.receipt,'accepted');
  assert.equal(a.send('confirm_recovery',{occurrenceId,confirmed:false}).receipt.receipt,'accepted');
  assert.equal(a.send('enter_manual',{segmentId:uuidv7()}).receipt.receipt,'accepted');
  assert.equal(a.send('advance').receipt.reason,'recovery_required');
  assert.equal(a.send('confirm_recovery',{occurrenceId,confirmed:true}).receipt.receipt,'accepted');
  assert.equal(a.send('advance').receipt.receipt,'accepted');
  assert.equal(a.state.beatId,a.b.d2);
});

test('terminal reset requires recovery and public projections never expose its private prompt', () => {
  const a=room({terminal:true});
  assert.equal(a.send('reset_checkpoint').receipt.reason,'recovery_required');
  for(const role of ['display','participant']) assert.equal(JSON.stringify(project(a.state,role)).includes(a.path.recovery.prompt),false);
  const occurrenceId=a.state.revealed.at(-1).occurrenceId;
  a.send('confirm_recovery',{occurrenceId,confirmed:true});
  assert.equal(a.send('reset_checkpoint').receipt.receipt,'accepted');
  assert.equal(project(a.state,'facilitator').recovery,null);
});

test('legacy ignored recovery annotations do not silently change pinned schema1 behavior', () => {
  const a=room({legacy:true});
  assert.equal(a.send('advance').receipt.receipt,'accepted');
});

test('recovery wire requires occurrence and revision; replay cannot reuse a confirmation on another occurrence', () => {
  const a=room(),occurrenceId=a.state.revealed.at(-1).occurrenceId;
  const e={v:1,type:'confirm_recovery',epoch:a.state.epoch,clientEventId:uuidv7(),expectRevision:a.state.revision,occurrenceId,confirmed:true};
  assert.equal(parseCommandEnvelope(e,'facilitator').ok,true);
  assert.equal(parseCommandEnvelope({...e,expectRevision:undefined},'facilitator').ok,false);
  assert.equal(parseCommandEnvelope(e,'participant').ok,false);
  const event=buildEvent(e,{actor:{role:'facilitator'},at:'2026-10-09T01:00:00Z',newId:uuidv7});
  const confirmed=dispatch(a.state,event,a.ledger);
  assert.equal(confirmed.effects[0].receipt,'accepted');
  assert.equal(dispatch(confirmed.state,{...event,occurrenceId:uuidv7()},a.ledger).effects[0].reason,'client_event_id_reused');
  const rebuilt=JSON.parse(JSON.stringify(confirmed.state));
  assert.equal(project(rebuilt,'facilitator').recovery.confirmed,true);
});

test('manual upload replays recovery atomically with a staged revision and rejects a bypass segment', () => {
  const a=room(); a.send('enter_manual',{segmentId:uuidv7()});
  const base=a.state, occurrenceId=base.revealed.at(-1).occurrenceId;
  const event=(type,payload={})=>({type,actor:{role:'facilitator'},epoch:base.epoch,clientEventId:uuidv7(),at:'2026-10-09T01:00:00Z',...payload});
  const next=event('advance',{roundId:uuidv7()});
  assert.equal(applySegment(base,[next],new Map()).reason,'recovery_required');
  const confirmed=event('confirm_recovery',{occurrenceId,confirmed:true});
  const replay=applySegment(base,[confirmed,next],new Map());
  assert.equal(replay.ok,true); assert.equal(replay.state.beatId,a.b.d2);
  const bad=applySegment(base,[confirmed,event('confirm_recovery',{occurrenceId:uuidv7(),confirmed:true}),next],new Map());
  assert.equal(bad.ok,false); assert.equal(bad.state,base);
});

test('confirming a new reveal after an actual Undo cannot inherit the former confirmation', () => {
  const a=room({manual:true});
  const occurrenceId=a.state.revealed.at(-1).occurrenceId;
  a.send('confirm_recovery',{occurrenceId,confirmed:true});
  const correction=project(a.state,'facilitator').undo;
  assert.equal(correction.available,true);
  assert.equal(a.send('undo',{targetEventId:correction.targetEventId}).receipt.receipt,'accepted');
  assert.equal(project(a.state,'facilitator').recovery,null);
  assert.equal(a.send('reveal_path',{pathId:a.path.id}).receipt.receipt,'accepted');
  assert.notEqual(a.state.revealed.at(-1).occurrenceId,occurrenceId);
  assert.equal(project(a.state,'facilitator').recovery.confirmed,false);
  assert.equal(a.send('advance').receipt.reason,'recovery_required');
});

test('human interpretation records counts without manufacturing a path suggestion or majority',()=>{
 const f=miniCase();f.doc.schema_version=2;f.doc.required_capabilities=['human_interpretation'];
 const d=f.doc.decisions[0];d.interpretation='facilitator';
 let state=initialState({sessionId:uuidv7(),caseDoc:f.doc});const ledger=new Map();
 const send=(type,payload={})=>{const e={type,actor:{role:'facilitator'},epoch:state.epoch,expectRevision:state.revision,clientEventId:uuidv7(),at:'2026-10-09T00:00:00Z',...(['start','advance'].includes(type)?{roundId:uuidv7()}:{}),...payload};const r=dispatch(state,e,ledger);state=r.state;return r.effects[0];};
 send('start');send('advance');send('advance');send('lock');
 assert.equal(state.round.suggestion.pathId,null);assert.equal(state.round.suggestion.kind,'facilitator');
 assert.equal(send('reveal_path',{pathId:f.p.image}).receipt,'accepted');assert.equal(state.rounds.at(-1).resolutionKind,'override');
});
