import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteSelection } from '../src/client/console-route-selection.mjs';
const view = (extra = {}) => ({ phase: 'responses_locked', decision: { id: 'decision', paths: [{ id: 'a' }, { id: 'b' }, { id: 'c', explored: true }] },
  round: { id: 'round', responseCount: 3, suggestion: { pathId: 'a', kind: 'plurality' } }, ...extra });
test('[AS-119] frozen eligible suggestion is only local and an explicit override survives repeated snapshots', () => {
  const choice = createRouteSelection(), locked = view();
  assert.equal(choice.sync(locked), 'a'); assert.equal(choice.choose(locked, 'b'), true);
  for (let i = 0; i < 10; i++) assert.equal(choice.sync(structuredClone(locked)), 'b');
  assert.equal(choice.choose(locked, 'c'), false); assert.equal(choice.sync(locked), 'b');
});
test('local Undo consumes one draft change and clearing a default never reselects it on render', () => {
  const choice = createRouteSelection(), locked = view();
  assert.equal(choice.sync(locked), 'a'); assert.equal(choice.undo(locked), true);
  for (let i = 0; i < 10; i++) assert.equal(choice.sync(locked), null);
  assert.equal(choice.undo(locked), false);
  assert.equal(choice.choose(locked, 'b'), true); assert.equal(choice.undo(locked), true);
  assert.equal(choice.sync(locked), null); assert.equal(choice.canUndo(locked), false);
});
test('ties, no votes, fallback, unavailable paths and restored locked seeds stay unselected', () => {
  for (const round of [
    { id: 'r', responseCount: 3, suggestion: { pathId: 'a', kind: 'tie' } },
    { id: 'r', responseCount: 0, suggestion: { pathId: 'a', kind: 'plurality' } },
    { id: 'r', responseCount: 3, suggestion: { pathId: 'a', kind: 'fallback' } },
    { id: 'r', responseCount: 3, suggestion: { pathId: 'c', kind: 'rules' } },
    { id: 'r', responseCount: 3, seededStatus: 'locked', suggestion: { pathId: 'a', kind: 'plurality' } },
    { id: 'r', responseCount: 3, suggestion: null },
  ]) assert.equal(createRouteSelection().sync(view({ round })), null);
});
test('first real lock preselects after open; new rounds reset local suppression and manual contexts have no invented suggestion', () => {
  const choice = createRouteSelection(), locked = view(), open = view({ phase: 'responses_open' });
  assert.equal(choice.sync(open), null); assert.equal(choice.sync(locked), 'a');
  choice.undo(locked); assert.equal(choice.sync(locked), null);
  assert.equal(choice.sync(view({ round: { ...locked.round, id: 'new-round' } })), 'a');
  assert.equal(choice.sync(view({ phase: 'surface_live', manual: true, round: null, publication: { occurrenceId: 'manual-context' } })), null);
});
test('committed authority selection stays exact until its own Undo and unavailable paths cannot become local choices', () => {
  const choice = createRouteSelection(), committed = view({ phase: 'path_selected', selectedPathId: 'a' });
  assert.equal(choice.sync(committed), 'a'); assert.equal(choice.choose(committed, 'b'), false);
  assert.equal(choice.canUndo(committed), false); assert.equal(choice.undo(committed), false);
});

test('accepted selection Undo clears its page-local copy until a new deliberate choice',()=>{
 const choice=createRouteSelection();const committed=view({phase:'path_selected',selectedPathId:'a'});
 assert.equal(choice.sync(committed),'a');
 const undone=view();assert.equal(choice.sync(undone),null);
 for(let i=0;i<10;i++)assert.equal(choice.sync(undone),null);
 assert.equal(choice.canUndo(undone),false);assert.equal(choice.choose(undone,'b'),true);assert.equal(choice.sync(undone),'b');
});

test('[AS-119] sole available route is preselected for unanswered, free-text and manual rounds without committing it',()=>{
 for(const extra of [{round:{id:'one',responseCount:0,suggestion:null}}, {manual:true,phase:'surface_live',round:null}]){
  const choice=createRouteSelection(), one=view({...extra,decision:{id:'decision',paths:[{id:'a'},{id:'b',explored:true}]}});
  assert.equal(choice.sync(one),'a');assert.equal(choice.undo(one),true);
  assert.equal(choice.sync(one),null,'a deliberate Undo stays cleared');
 }
 const choice=createRouteSelection(), open=view({phase:'responses_open',decision:{id:'decision',paths:[{id:'a'}]}});
 assert.equal(choice.sync(open),null,'never choose while responses remain open');
});
