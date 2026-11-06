import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankedControlsModel } from '../src/client/console-ranking.mjs';
const closedRoundId='019cc111-1111-7111-8111-111111111111';
const groups=[['012',10],['021',5],['102',2],['210',1]];
function view(){return{actions:['ranked_page'],revision:29,rankedRoundId:closedRoundId,rankedSelection:{group:0,position:0},rankedPresentation:{groups:groups.slice(0,2),groupStart:0,groupCount:2,totalGroups:4,positionStart:0,positionSpan:3,residualTotal:3,orderMeaning:null},round:{aggregate:{completeOrders:groups,rankCount:3,total:18}}};}
test('Card25 console model distinguishes Other Back direct orders and position navigation with revision fences',()=>{
  const v=view(), common=rankedControlsModel(v);
  assert.ok(common,'closed grouped authority has controls');
  assert.deepEqual(common.switch,{label:'Other responses',payload:{group:2,position:0,closedRoundId,expectRevision:29}});
  assert.deepEqual(common.orders.map(x=>x.value),[0,1,2,3]);
  assert.deepEqual(common.orders.map(x=>x.label),['Response order 1 · 10 responses','Response order 2 · 5 responses','Response order 3 · 2 responses','Response order 4 · 1 response']);
  v.rankedSelection={group:2,position:0};v.rankedPresentation={...v.rankedPresentation,groups:groups.slice(2),groupStart:2};
  assert.deepEqual(rankedControlsModel(v).switch,{label:'Back to common responses',payload:{group:0,position:0,closedRoundId,expectRevision:29}});
  v.round.aggregate.rankCount=8;v.rankedPresentation.positionSpan=3;
  assert.deepEqual(rankedControlsModel(v).nextPositions,{group:2,position:3,closedRoundId,expectRevision:29});
  v.rankedSelection.position=6;v.rankedPresentation.positionStart=6;v.rankedPresentation.positionSpan=2;
  assert.equal(rankedControlsModel(v).nextPositions,null);assert.deepEqual(rankedControlsModel(v).previousPositions,{group:2,position:3,closedRoundId,expectRevision:29});
});
test('Card25 console model has no authority when hidden replayed or empty and every compact group remains directly reachable',()=>{
  assert.equal(rankedControlsModel({...view(),actions:[]}),null);
  const v=view();v.rankedPresentation.totalGroups=0;v.round.aggregate.completeOrders=[];assert.equal(rankedControlsModel(v),null);
  const all=[]; const permutations=(prefix,remaining)=>{if(all.length===300)return;if(!remaining.length){all.push([prefix,1]);return;}for(const digit of remaining)permutations(prefix+digit,remaining.filter(x=>x!==digit));};permutations('',[...'01234567']);
  const large=view();large.round.aggregate.completeOrders=all;large.round.aggregate.rankCount=8;large.rankedPresentation.totalGroups=300;
  const model=rankedControlsModel(large);assert.ok(model);assert.equal(model.orders.length,300);assert.equal(model.orders[299].value,299);
  large.rankedPresentation.residualTotal=undefined;assert.equal(rankedControlsModel(large).switch,null,'fragmented/tied results use ordinary orders');
});
