import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSimulation, summarizeRooms, assertRoomEvidence, authorityAtRevision, runSimulatedRooms, recordAcceptedVote, disclosurePayload } from '../scripts/simulated-rooms.mjs';
const good=()=>({answer_variety:2,clients:25,expected_votes:75,receipted_votes:75,lost_votes:0,duplicate_votes:0,participants:25,decisions:3,ended:true,public_payloads:4,acknowledgement_ms:{p95:10},samples:[10],fanout_samples:[2],actions:{http:4,ws_in:2,ws_out:1}});
test('[AS-097] multi-room evidence refuses a missing receipt, duplicate join, private projector field and mis-summed totals',()=>{
 const room=good();assert.equal(assertRoomEvidence(room),room);
 assert.throws(()=>assertRoomEvidence({...room,lost_votes:1}),/lost_votes/);
 assert.throws(()=>assertRoomEvidence({...room,participants:26}),/duplicate_join/);
 assert.throws(()=>assertRoomEvidence({...room,duplicate_votes:1}),/duplicate_votes/);
 assert.throws(()=>assertRoomEvidence({...room,public_payloads:0}),/public_payloads/);
 assert.throws(()=>assertRoomEvidence({...room,answer_variety:1}),/answer_variety/);
 assert.throws(()=>assertRoomEvidence({...room,acknowledgement_ms:{p50:640.4,p95:1203.6,p99:2642}}),/^Error: load_p95_exceeded p50=640ms p95=1204ms p99=2642ms$/);
 const total=summarizeRooms([good(),good()]);assert.equal(total.expected_votes,150);assert.equal(total.actions.http,8);
});
test('simulation target and size guard admits only acknowledged staging or local before any IO',()=>{
 assert.equal(parseSimulation(['--rooms','5','--clients','25','--stagger','1']).rooms,5);
 for(const args of [ ['--target','https://case.iatrogenic.app/','--i-own-this-origin'],['--target','https://unknown.test/','--i-own-this-origin'],['--target','https://case-staging.iatrogenic.app/'],['--rooms','11'],['--clients','24'],['--clients','26'],['--stagger','-1']])assert.throws(()=>parseSimulation(args));
 assert.equal(parseSimulation(['--target','https://case-staging.iatrogenic.app/','--i-own-this-origin']).target.kind,'staging');
});
test('shared RT04 public oracle refuses projector private fields and withheld authored values',async()=>{
 const {assertPublicDisclosure}=await import('./helpers/public-disclosure.mjs');
 assert.throws(()=>assertPublicDisclosure({view:{surface:{notes:'leak'}}},[]),/private public field/);
 assert.throws(()=>assertPublicDisclosure({view:{surface:{scene:'hidden'}}},[],['hidden']),/unrevealed/);
 assert.throws(()=>assertPublicDisclosure({view:{surface:{scene:'private cue'}}},['private cue']),/private material/);
 assert.doesNotThrow(()=>assertPublicDisclosure({view:{surface:{observations:[{value:'shown',previous:'14'}]}}},[],['14']));
});

test('a later reveal cannot authorize an older public payload',()=>{
 const early={revision:1},later={revision:3};
 assert.equal(authorityAtRevision([early],2),null);
 assert.equal(authorityAtRevision([early,later],2),early);
 assert.equal(authorityAtRevision([early,later],3),later);
});

test('staging sizing refuses 50 phones before credentials or network because its metering plan is for 25',async()=>{
 const options=parseSimulation(['--target','https://case-staging.iatrogenic.app/','--i-own-this-origin','--clients','50']);
 let calls=0;await assert.rejects(runSimulatedRooms(options,{environment:new Proxy({},{get(){calls++;throw Error('credential read');}}),fetchImpl:()=>{calls++;throw Error('network IO');}}),/staging_load_size_refused/);assert.equal(calls,0);
});

test('[AS-097] the load CLI refuses unsized or unpinned staging runs before it reads the credential from stdin',async()=>{
 const {spawn}=await import('node:child_process');
 const {LOAD_WORKSPACE,LOAD_VERSION}=await import('../scripts/simulated-rooms.mjs');
 const run=(args,env)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['scripts/load-room.mjs',...args],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,...env}});
  let err='';child.stderr.on('data',d=>{err+=d;});
  // stdin is deliberately left open: a process that reads it before admission hangs and trips the timer.
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('read stdin before admission'));},8000);
  child.on('exit',code=>{clearTimeout(timer);resolve({code,err});});
 });
 const base=['--target','https://case-staging.iatrogenic.app/','--i-own-this-origin','--rooms','1','--stagger','1'];
 const pinned={CASE_LOAD_WORKSPACE_ID:LOAD_WORKSPACE,CASE_LOAD_CASE_VERSION_ID:LOAD_VERSION};
 const size=await run([...base,'--clients','50'],pinned);assert.equal(size.code,1);assert.match(size.err,/staging_load_size_refused/);
 const unpinned=await run([...base,'--clients','25'],{});assert.equal(unpinned.code,1);assert.match(unpinned.err,/staging_load_workspace_refused/);
});

test('[AS-097] the first failed room stops later staggered rooms from starting',async()=>{
 let created=0;
 const fake={startLocal:async()=>({origin:'http://127.0.0.1:1',stop:async()=>{}}),createLocalRoom:async()=>{created++;throw Error('load_room_create_failed');}};
 await assert.rejects(runSimulatedRooms({rooms:5,clients:25,stagger:0.2,target:{kind:'local',origin:null},own:false},fake));
 assert.equal(created,1,'later rooms must not start after a failure');
});

test('compact recap oracle requires each owner/round actual accepted vote and rejects wrong owners, answers and teaching',async()=>{
 const {miniCase}=await import('./helpers/mini-case.mjs'),{uuidv7}=await import('../src/shared/ids.mjs');
 const {doc:pack}=miniCase(),decision=pack.decisions[0],path=decision.paths.find(p=>p.recommended),other=decision.paths.find(p=>p!==path);
 const owner=uuidv7(),foreign=uuidv7(),roundId=uuidv7(),ledger=new Map();
 const submission={participantId:owner,roundId,clientEventId:uuidv7(),response:{option_id:path.option_ids[0]}};
 const receipt={clientEventId:submission.clientEventId,receipt:'accepted',revision:42};
 recordAcceptedVote(ledger,submission,receipt);
 const foreignSubmission={participantId:foreign,roundId,clientEventId:uuidv7(),response:{option_id:other.option_ids[0]}};
 recordAcceptedVote(ledger,foreignSubmission,{receipt:'already_accepted',revision:43,clientEventId:foreignSubmission.clientEventId});
 const mirror={phase:'ended',participants:{[owner]:{},[foreign]:{}},rounds:[{id:roundId,decisionId:decision.id,no:1,evidenceRef:1,answers:{}}]};
 const ownRound={decisionId:decision.id,prompt:decision.prompt,roundNo:1,status:'resolved',optionIds:decision.interaction.options.map(o=>o.id),yourResponse:structuredClone(submission.response),yourAnswer:decision.interaction.options.find(o=>o.id===submission.response.option_id).label,yourClassification:path.classification,why:path.rationale,doDifferently:null,teamChoice:'override',whatHappened:'Published consequence',revealIndex:0};
 const payload={view:{role:'participant',you:{id:owner},timeline:[{title:'Published consequence'}],recap:{rounds:[ownRound]}}};
 const original=structuredClone(payload);
 assert.doesNotThrow(()=>disclosurePayload(payload,pack,mirror,ledger));
 assert.deepEqual(payload,original,'privacy oracle never alters the original public frame');
 for(const mutate of [p=>p.view.you.id=foreign,p=>p.view.recap.rounds[0].yourResponse=foreignSubmission.response,p=>p.view.recap.rounds[0].why='PRIVATE_OTHER_RATIONALE',p=>p.view.recap.rounds[0].yourClassification='terminal-unsafe',p=>p.view.recap.rounds[0].doDifferently='PRIVATE_OTHER_ALTERNATIVE',p=>p.view.recap.rounds[0].notes='PRIVATE_EXTRA',p=>p.view.recap.rounds[0].revealIndex=5,p=>{delete p.view.recap.rounds[0].revealIndex;}]){
  const invalid=structuredClone(payload);mutate(invalid);assert.throws(()=>disclosurePayload(invalid,pack,mirror,ledger));
 }
 assert.throws(()=>disclosurePayload(payload,pack,mirror,new Map()),/matching accepted submission/);
 // The facilitator label: exactly the room's on an ended recap; nowhere else, before or after End.
 const label='Load test, Simulation',labelled=structuredClone(payload);labelled.view.recap.facilitator=label;
 assert.doesNotThrow(()=>disclosurePayload(labelled,pack,mirror,ledger,label));
 assert.throws(()=>disclosurePayload(payload,pack,mirror,ledger,label),/recap facilitator label/);
 assert.throws(()=>disclosurePayload(labelled,pack,mirror,ledger,null),/recap facilitator label/);
 assert.throws(()=>disclosurePayload({...labelled,view:{...labelled.view,recap:{...labelled.view.recap,facilitator:'Someone, Else'}}},pack,mirror,ledger,label),/recap facilitator label/);
 assert.throws(()=>disclosurePayload({view:{role:'display',caption:label}},pack,mirror,ledger,label),/outside an ended recap/);
 assert.throws(()=>disclosurePayload({view:{...labelled.view,you:{...labelled.view.you,note:label}}},pack,mirror,ledger,label),/outside an ended recap/);
 // Room PDFs v2: the room split is exact or refused: only for a resolved round the projector drew, with its own total, labels and counts.
 const opts=decision.interaction.options,split={total:2,options:opts.map((o,k)=>({label:o.label,count:k===0?2:0}))};
 const shownMirror={...mirror,rounds:[{...mirror.rounds[0],status:'resolved',shown:true,aggregate:{total:2,counts:{[opts[0].id]:2}}}]};
 const withRoom=structuredClone(payload);withRoom.view.recap.rounds[0].room=structuredClone(split);
 assert.doesNotThrow(()=>disclosurePayload(withRoom,pack,shownMirror,ledger));
 for(const [label,frame,m] of [['never shown',withRoom,{...shownMirror,rounds:[{...shownMirror.rounds[0],shown:false}]}],['superseded',withRoom,{...shownMirror,rounds:[{...shownMirror.rounds[0],status:'superseded'}]}],
   ['wrong total',(()=>{const f=structuredClone(withRoom);f.view.recap.rounds[0].room.total=3;return f;})(),shownMirror],
   ['extra key',(()=>{const f=structuredClone(withRoom);f.view.recap.rounds[0].room.names=['PRIVATE'];return f;})(),shownMirror],
   ['foreign label',(()=>{const f=structuredClone(withRoom);f.view.recap.rounds[0].room.options[0].label='PRIVATE_FREE_TEXT';return f;})(),shownMirror],
   ['position arrays',(()=>{const f=structuredClone(withRoom);f.view.recap.rounds[0].room.options[0].count=[2,0,0];return f;})(),shownMirror]])
  assert.throws(()=>disclosurePayload(frame,pack,m,ledger),undefined,label);
 // Red-team of #307 (P2): a free-text round never carries a split, whatever the mirror holds.
 const freePack=structuredClone(pack);freePack.decisions[0].interaction={type:'free_text',max_length:120};
 assert.throws(()=>disclosurePayload(withRoom,freePack,shownMirror,ledger),/free text/);
 // A ranking's split is its first places: positionCounts[option][0], not the shared counts.
 const rankPack=structuredClone(pack);rankPack.decisions[0].interaction={...rankPack.decisions[0].interaction,type:'ranking',rank_count:2};
 const rankMirror={...shownMirror,rounds:[{...shownMirror.rounds[0],aggregate:{total:2,counts:{},positionCounts:Object.fromEntries(opts.map((o,k)=>[o.id,k===0?[2,0]:[0,1]]))}}]};
 assert.doesNotThrow(()=>disclosurePayload(withRoom,rankPack,rankMirror,ledger));
 const allPositions=structuredClone(withRoom);allPositions.view.recap.rounds[0].room.options.forEach((o,k)=>{o.count=k===0?2:1;});
 assert.throws(()=>disclosurePayload(allPositions,rankPack,rankMirror,ledger),/counts and labels/,'a count other than first places is refused');
 for(const invalid of [{...receipt,clientEventId:uuidv7()},{...receipt,receipt:'rejected'},{...receipt,revision:undefined}])assert.throws(()=>recordAcceptedVote(new Map(),submission,invalid));
 submission.response.option_id=other.option_ids[0];receipt.receipt='rejected';
 assert.deepEqual(ledger.get(`${roundId}:${owner}`).response,ownRound.yourResponse,'ledger owns immutable accepted response bytes');
});
