import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResponseResult } from '../src/client/projector-result.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
function el(tag, className, text) {
  const node={tag,className:className??'',text,children:[],attrs:{},style:{setProperty(key,value){this[key]=value;}},
    append(...children){this.children.push(...children);},setAttribute(key,value){this.attrs[key]=value;}};
  node.classList={add(...values){node.className+=' '+values.join(' ');}};return node;
}
function flatten(node){return [node,...node.children.flatMap(flatten)];}
function view(){return {replay:false,responseResult:{type:'ranking',prompt:'Full authored question',total:18,rankCount:3,
  counts:['Full label A','Full label B','Full label C'].map((label,index)=>({optionId:uuidv7(),label,count:[15,2,1][index],positionCounts:[[15,2,1],[2,10,6],[1,6,11]][index]})),
  ranked:{groups:[['012',10],['021',5]],groupStart:0,groupCount:2,totalGroups:4,positionStart:0,positionSpan:3,orderMeaning:null,residualTotal:3}}};}

test('[AS-195] Card25 shared renderer draws complete vertical columns with authored marks, one footer and a count per order (CASE-327)',()=>{
  const marks=[],root=renderResponseResult(view(),{el,markSvg(index){marks.push(index);return el('svg','mark',String(index));}}),nodes=flatten(root);
  const columns=nodes.filter(n=>n.className.includes('ranked-column')&&!n.className.includes('ranked-columns'));
  assert.equal(columns.length,2,'one complete order occupies each vertical column');
  assert.deepEqual(marks,[0,1,2,0,2,1]);
  assert.deepEqual(columns.map(column=>flatten(column).filter(n=>n.className.includes('ranked-label')).map(n=>n.text)),[['Full label A','Full label B','Full label C'],['Full label A','Full label C','Full label B']]);
  assert.deepEqual(nodes.filter(n=>n.className.includes('ranked-total')).map(n=>n.text),['10 responses','5 responses']);
  assert.equal(nodes.filter(n=>n.text==='18 responses · 4 orders').length,1);
  assert.ok(nodes.some(n=>n.text==='Orders 1–2 of 4'),'more orders: the paging line');
  assert.equal(nodes.some(n=>/Positions|overall/.test(n.text??'')),false,'every position on the page, one total');
  assert.ok(nodes.some(n=>n.text==='3 other responses'));assert.ok(nodes.some(n=>n.text==='Ranked order'));
  assert.equal(nodes.some(n=>n.tag==='table'),false);
});

test('Card25 shared renderer preserves original ranks in continuations, explicit meaning and honest empty or legacy results',()=>{
  const v=view();v.responseResult.ranked={...v.responseResult.ranked,groups:[['210',1]],groupStart:3,groupCount:1,positionStart:2,positionSpan:1,orderMeaning:'action'};
  const marks=[],nodes=flatten(renderResponseResult(v,{el,markSvg(i){marks.push(i);return el('svg');}}));
  assert.ok(nodes.some(n=>n.text==='Action order'));assert.deepEqual(marks,[0]);
  assert.ok(nodes.some(n=>n.text==='3'));assert.ok(nodes.some(n=>n.text==='Position 3 of 3 · continued'));assert.ok(nodes.some(n=>n.text==='Orders 4–4 of 4'));
  assert.ok(nodes.some(n=>n.text==='1 response'));assert.equal(nodes.filter(n=>n.text==='18 responses · 4 orders').length,1);
  // One order (the asthma run, 1 Nov): no column count and no paging lines, only the footer's total.
  const one=view();one.responseResult.total=1;one.responseResult.ranked={...one.responseResult.ranked,groups:[['012',1]],groupCount:1,totalGroups:1};delete one.responseResult.ranked.residualTotal;
  const solo=flatten(renderResponseResult(one,{el,markSvg(){return el('svg');}}));
  assert.deepEqual(solo.filter(n=>/ranked-(total|overall|continuation|group-page)/.test(n.className)).map(n=>n.text),['1 response']);
  const empty=view();empty.responseResult.total=0;empty.responseResult.counts.forEach(r=>{r.count=0;r.positionCounts=[0,0,0];});empty.responseResult.ranked.groups=[];empty.responseResult.ranked.groupCount=0;empty.responseResult.ranked.totalGroups=0;delete empty.responseResult.ranked.residualTotal;
  assert.ok(flatten(renderResponseResult(empty,{el,markSvg(){assert.fail('empty does not invent option');}})).some(n=>n.text==='No responses submitted.'));
  const omitted=view();delete omitted.responseResult.ranked.orderMeaning;
  assert.ok(flatten(renderResponseResult(omitted,{el,markSvg(){return el('svg');}})).some(n=>n.text==='Ranked order'));
  const legacy=view();delete legacy.responseResult.ranked;
  assert.equal(flatten(renderResponseResult(legacy,{el,markSvg(){return el('svg');}})).some(n=>n.className.includes('ranked-column')),false);
});
