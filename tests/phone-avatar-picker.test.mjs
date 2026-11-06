import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATARS, isAvatarId } from '../src/shared/participant.mjs';
import { rankingMoveControl, rankingRemoveControl } from '../src/client/phone-ranking.mjs';
import { joinAvatarPicker } from '../src/client/phone-avatar-picker.mjs';

function withDom(fn) {
  const prior={document:globalThis.document,Node:globalThis.Node};
  class Node {
    constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.checked=false;this.attributes={};}
    setAttribute(key,value){this.attributes[key]=value;if(key==='value')this.value=value;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    addEventListener(event,listener){this.listeners[event]=listener;}
  }
  globalThis.Node=Node;
  globalThis.document={createElement:tag=>new Node(tag),createTextNode:text=>Object.assign(new Node(null),{textContent:text})};
  try{return fn();}finally{globalThis.document=prior.document;globalThis.Node=prior.Node;}
}

test('join picker does not block an unselected avatar and assigns one stable allowlisted default', () => withDom(() => {
  const picker=joinAvatarPicker('join',{randomIndex:()=>3});
  assert.equal(picker.value(),null);
  assert.equal(picker.valid(),true);
  const selected=picker.ensureSelected();
  assert.equal(selected,AVATARS[3].id);
  assert.equal(picker.ensureSelected(),selected);
  assert.equal(isAvatarId(selected),true);
  picker.set(AVATARS[1].id);
  assert.equal(picker.ensureSelected(),AVATARS[1].id);
}));

test('join picker retains every avatar choice and its last tile Randomise updates selection', () => withDom(() => {
  const picker=joinAvatarPicker('join',{randomIndex:()=>7});
  const grid=picker.root.children[1];
  assert.equal(grid.children.length,AVATARS.length+1);
  assert.deepEqual(grid.children.slice(0,-1).map(tile=>tile.children[0].value),AVATARS.map(a=>a.id));
  const last=grid.children.at(-1);
  assert.equal(last.tagName,'button');
  assert.equal(last.textContent,'Randomise');
  let picked=null;picker.onPick(value=>{picked=value;});
  last.listeners.click();
  assert.equal(picker.value(),AVATARS[7].id);
  assert.equal(picked,AVATARS[7].id);
}));


test('ranking movement is a glyph control with an explicit accessible label and boundary state', () => withDom(() => {
  let moved=false;
  const up=rankingMoveControl({id:'a',label:'Needle decompression',direction:'up',disabled:false,onMove:()=>{moved=true;}});
  assert.equal(up.attributes['aria-label'],'Move up: Needle decompression');
  assert.equal(up.children[0].textContent,'↑');assert.equal(up.children[0].attributes['aria-hidden'],'true');
  up.listeners.click();assert.equal(moved,true);
  const down=rankingMoveControl({id:'a',label:'Needle decompression',direction:'down',disabled:true,onMove:()=>{}});
  assert.equal(down.attributes.disabled,'');assert.equal(down.children[0].textContent,'↓');
}));


test('ranking removal is a keyboard button with a named glyph and its real removal callback', () => withDom(() => {
  let removed=false;
  const remove=rankingRemoveControl({label:'Needle decompression',onRemove:()=>{removed=true;}});
  assert.equal(remove.tagName,'button');assert.equal(remove.attributes.type,'button');
  assert.equal(remove.attributes['aria-label'],'Remove from ranking: Needle decompression');
  assert.equal(remove.children[0].textContent,'×');assert.equal(remove.children[0].attributes['aria-hidden'],'true');
  remove.listeners.click();assert.equal(removed,true);
}));
