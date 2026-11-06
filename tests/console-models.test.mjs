import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAction } from '../src/client/console-actions.mjs';
import { createDisplayCheck } from '../src/client/console-device.mjs';

test('console primary action uses only authority actions and exact phase copy', () => {
  assert.equal(primaryAction({phase:'ended',actions:[]}), null);
  assert.deepEqual(primaryAction({phase:'responses_open',actions:['lock']}), {command:'lock',label:'Lock responses & review'});
  assert.equal(primaryAction({phase:'responses_open',actions:[]}), null);
  assert.deepEqual(primaryAction({phase:'surface_live',actions:['advance'],nextBeat:{kind:'decision'}}), {command:'advance',label:'Show decision context'});
  assert.deepEqual(primaryAction({phase:'consequence_revealed',actions:['advance'],nextBeat:{kind:'decision'}}), {command:'advance',label:'Show decision context'});
  assert.deepEqual(primaryAction({phase:'discussion_paused',actions:['resume'],resumePhase:'responses_locked'}), {command:'resume',label:'Resume · reviewing'});
});

test('console route choice stays explicit and reveal arms for exactly three seconds', () => {
  const view={phase:'responses_locked',actions:['select_path'],decision:{paths:[{id:'a',label:'Route A'},{id:'b',explored:true}]}};
  assert.deepEqual(primaryAction(view), {local:'focus_resolution',label:'Select path'});
  assert.deepEqual(primaryAction(view,{pickedPathId:'a'}), {command:'select_path',payload:{pathId:'a'},label:'Select this path'});
  assert.deepEqual(primaryAction(view,{pickedPathId:'b'}), {local:'focus_resolution',label:'Select path'});
  const reveal={phase:'path_selected',actions:['reveal'],selectedPathId:'a',decision:{paths:[{id:'a',revealPreview:'A consequence'}]}};
  assert.deepEqual(primaryAction(reveal,{now:100,armedUntil:3099}), {command:'reveal',label:'Show to participants?',armed:true});
  assert.deepEqual(primaryAction(reveal,{now:3099,armedUntil:3099}), {local:'arm_reveal',label:'Reveal: A consequence',armed:false});
});

test('atomic Reveal is one authored-path command even with visible chart and join overlay', () => {
  const view={phase:'responses_locked',revision:42,actions:['reveal_path','show_results','show_lobby'],resultsShown:true,display:{lobby:true},decision:{paths:[{id:'a',label:'Route A',revealPreview:'A consequence'},{id:'b',explored:true}]}};
  assert.deepEqual(primaryAction(view,{pickedPathId:'a'}),{command:'reveal_path',payload:{pathId:'a',expectRevision:42},label:'Reveal: A consequence',pathId:'a'});
  assert.deepEqual(primaryAction(view,{pickedPathId:'b'}),{local:'focus_resolution',label:'Choose a path'});
});

test('console display confirmation resets on disconnect, repair and display-count change', () => {
  const device=createDisplayCheck();
  assert.equal(device.needsCheck(),true);
  device.confirm(); assert.equal(device.needsCheck(),false);
  device.update({connected:true,displayCount:2,pairingId:'first'}); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update({connected:true,displayCount:2,pairingId:'first'}); assert.equal(device.needsCheck(),false);
  device.update({connected:false,displayCount:2,pairingId:'first'}); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update({connected:true,displayCount:2,pairingId:'replacement'}); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update({connected:true,displayCount:1,pairingId:'replacement'}); assert.equal(device.needsCheck(),true);
  device.separate(); assert.equal(device.needsCheck(),false);
});

test('console display confirmation survives the unchanged periodic safety poll (AS-091 race)', () => {
  // console-room polls updateDisplaySafety every 2 s. With no same-PC projector
  // hello (a separate paired display, or the projector not yet opened) every poll
  // reports the same disconnected state. Nothing changed, so a confirmation made
  // between two polls must survive until Start case, not silently expire.
  const device=createDisplayCheck(),idle={connected:false,displayCount:1,pairingId:'same-pc'};
  device.update(idle); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update(idle); assert.equal(device.needsCheck(),false);
  device.update(idle); device.update(idle); assert.equal(device.needsCheck(),false);
  // Any real change after confirming still demands a fresh check.
  device.update({...idle,connected:true}); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update({...idle,connected:true}); device.update(idle); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update(idle); device.update({...idle,displayCount:2}); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update({...idle,displayCount:2,pairingId:'replacement'}); assert.equal(device.needsCheck(),true);
});

test('CASE-167 console display confirmation resets when the screen identity changes, never on an unchanged one', () => {
  const device=createDisplayCheck(),base={connected:true,displayCount:2,pairingId:'pairing-0',screenId:'detailed:A|B'};
  device.update(base); device.confirm(); device.update(base); assert.equal(device.needsCheck(),false);
  device.update({...base,screenId:'detailed:A|C'}); assert.equal(device.needsCheck(),true);
  device.confirm(); for (let i=0;i<50;i+=1) device.update({...base,screenId:'detailed:A|C'});
  assert.equal(device.needsCheck(),false);
});

test('CASE-167 a switch from coarse to detailed screen identity re-baselines and does not clear', () => {
  const device=createDisplayCheck(),coarse={connected:true,displayCount:2,pairingId:'pairing-0',screenId:'coarse:1440x900:x'};
  device.update(coarse); device.confirm(); device.update(coarse);
  device.update({...coarse,displayCount:3,screenId:'detailed:A|B|C>A'}); assert.equal(device.needsCheck(),false);
  device.update({...coarse,displayCount:3,screenId:'detailed:A|B|D>A'}); assert.equal(device.needsCheck(),true);
  device.confirm(); device.update({...coarse,displayCount:3,screenId:'detailed:A|B|D>A',connected:false}); assert.equal(device.needsCheck(),true);
});

const rbCoarse={connected:true,displayCount:2,pairingId:'pairing-0',screenId:'coarse:1440x900:x'};
const rbDetailed=(count,current='Built-in@0,0:1440x900*')=>({...rbCoarse,displayCount:count,
  screenId:`detailed:${['Built-in@0,0:1440x900*','PJ@1440,0:1920x1080'].slice(0,count).join('|')}>${current}`});
const rbConfirmed=from=>{ const device=createDisplayCheck(); device.update(from); device.confirm(); device.update(from); return device; };

test('CASE-167 a source switch from 2 to 1 screen (Duplicate at the grant) clears', () => {
  const device=rbConfirmed(rbCoarse); device.update(rbDetailed(1)); assert.equal(device.needsCheck(),true);
});

test('CASE-167 a source switch from 1 to 2 screens clears', () => {
  const device=rbConfirmed({...rbCoarse,displayCount:1,screenId:'coarse:1440x900:1'});
  device.update(rbDetailed(2)); assert.equal(device.needsCheck(),true);
});

test('CASE-167 a source switch where the console screen size differs clears', () => {
  const device=rbConfirmed(rbCoarse); device.update(rbDetailed(2,'PJ@1440,0:1920x1080')); assert.equal(device.needsCheck(),true);
});

test('CASE-167 a source switch at the same count and console screen size re-baselines', () => {
  const device=rbConfirmed(rbCoarse); device.update(rbDetailed(2)); assert.equal(device.needsCheck(),false);
});

test('console phase model hides open aggregates and live counts when names are projected', async () => {
  const {phaseModel}=await import('../src/client/console-view.mjs');
  const view={phase:'responses_open',namesShown:true,round:{no:2,responseCount:3,participantCount:4,aggregate:{counts:[3],total:3},suggestion:{pathId:'secret'}},actions:['lock']};
  const open=phaseModel(view);
  assert.equal(open.heading,'Team decision open');
  assert.equal(open.count,'Names are shown on the projector · the live count is hidden');
  assert.equal(open.aggregate,null); assert.equal(open.suggestion,null);
  assert.equal(open.reopened,'Reopened as round 2 · earlier answers are kept privately');
  const locked=phaseModel({...view,phase:'responses_locked'});
  assert.deepEqual(locked.aggregate,view.round.aggregate);
  assert.deepEqual(locked.suggestion,view.round.suggestion);
  assert.equal(phaseModel({...view,phase:'path_selected'}).heading,'Path chosen · not yet shown to participants');
  assert.equal(phaseModel({...view,phase:'ended'}).aggregate,null);
});

test('console projector hello is session-bound and fallback appears at three seconds', async () => {
  const {createProjectorHandshake}=await import('../src/client/console-device.mjs');
  const check=createProjectorHandshake('room-a');
  check.opened(100);
  assert.equal(check.fallbackRequired(3099),false);
  assert.equal(check.accept({t:'projector_hello',sessionId:'room-b'},3100),false);
  assert.equal(check.fallbackRequired(3100),true);
  assert.equal(check.accept({t:'projector_hello',sessionId:'room-a',token:'forbidden'},3101),false);
  assert.equal(check.accept({t:'projector_hello',sessionId:'room-a'},3102),true);
  assert.equal(check.fallbackRequired(3102),false);
  assert.equal(check.alive(13101),true);
  assert.equal(check.alive(13102),false);
  // CASE-327: a hello may carry the window's size (Room sees draws that screen); a bad size refuses the hello.
  assert.equal(check.screen(),null);
  assert.equal(check.accept({t:'projector_hello',sessionId:'room-a',width:1920,height:1080},20000),true);
  assert.deepEqual(check.screen(),{width:1920,height:1080});
  for (const bad of [{width:1920},{width:10,height:1080},{width:'1920',height:1080},{width:1920,height:1080.5}])
    assert.equal(check.accept({t:'projector_hello',sessionId:'room-a',...bad},20001),false);
  assert.deepEqual(check.screen(),{width:1920,height:1080});
  check.opened(14000); assert.equal(check.fallbackRequired(17000),true);
});
