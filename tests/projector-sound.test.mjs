import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectorSound, roomLevels } from '../src/client/projector-sound.mjs';
import { readAudioLevel, writeAudioLevel } from '../src/client/audio-preferences.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
function rig(over={}) {
  const elements=[],saved=new Map(),events={},log={loads:0,contexts:0,reconciles:[],stops:0};
  const doc={hidden:false,createElement(tag){const n={tag,dataset:{},attrs:{},handlers:{},children:[],get textContent(){return n.children.length?n.children.map(c=>c.textContent??'').join(''):n.text??'';},set textContent(value){n.text=value;n.children=[];},setAttribute(k,v){n.attrs[k]=v;},addEventListener(k,f){n.handlers[k]=f;},append(...kids){n.children.push(...kids);},focus(){doc.activeElement=n;}};elements.push(n);return n;},addEventListener(k,f){events[k]=f;},removeEventListener(k){delete events[k];}};
  doc.createElementNS = (_ns,tag) => doc.createElement(tag);
  doc.defaultView={addEventListener(k,f){events[k]=f;},removeEventListener(k){delete events[k];}};
  const ctx={state:'running',resume:async()=>{},close:async()=>{}};
  const engine={reconcile:(v,options)=>log.reconciles.push({v,options}),baseline:()=>log.stops++,close:()=>log.stops++};
  const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
  let view={phase:'waiting'};
  const player=createProjectorSound({doc,getView:()=>view,storage,createContext:()=>{log.contexts++;return ctx;},loadMusic:async()=>{log.loads++;return{createRoomMusic:()=>engine};},...over});
  return{player,doc,elements,saved,ctx,log,engine,storage,events,view:value=>view=value,button:elements.find(e=>e.tag==='button'),music:elements.find(e=>e.dataset.soundControl==='music')};
}
test('[AS-202] a local gesture starts the room music at the room level; saved settings alone never load or enable',async()=>{
  const r=rig();assert.equal(r.log.loads,0);await r.button.handlers.click();await settle();assert.equal(r.log.contexts,1);assert.equal(r.log.loads,1,'the gesture starts music at the room level');
  assert.equal(r.button.attrs['aria-pressed'],'true');assert.equal(r.log.reconciles[0].options.baseline,true);r.player.close();
  const saved=rig({storage:{getItem:()=>'.4'}});assert.equal(saved.log.loads,0);assert.equal(saved.log.contexts,0);saved.player.close();
  assert.equal(r.elements.some(e=>e.dataset.soundControl==='music'||e.dataset.soundControl==='effects'),false,'the projector has no level sliders (CASE-335)');
});
test('[AS-202] the console player pauses, resumes and sets the room level; this device\'s saved level scales it',async()=>{
  let volume=null;const r=rig({loadMusic:async()=>{r.log.loads++;return{createRoomMusic:options=>{volume=options.volume;return r.engine;}};}});
  r.view({phase:'waiting',music:{choice:'auto',intensity:70,playing:false,volume:60,effects:true,transport:null}});
  await r.button.handlers.click();await settle();assert.equal(r.log.loads,0,'paused room music loads nothing');
  const playing={phase:'waiting',music:{choice:'auto',intensity:70,playing:true,volume:40,effects:true,transport:null}};r.view(playing);r.player.update(playing);await settle();
  assert.equal(r.log.loads,1,'Play on the console starts it');assert.equal(volume(),.4);
  r.saved.set('case:audio:music-volume','0.5');r.events.storage({type:'storage',key:'case:audio:music-volume'});await settle();assert.equal(volume(),.2,'room 40% × device 50%');
  const stops=r.log.stops,paused={...playing,music:{...playing.music,playing:false}};r.view(paused);r.player.update(paused);assert.ok(r.log.stops>stops,'Pause on the console stops it');
  r.saved.set('case:audio:music-volume','0.9');r.events.storage({type:'storage',key:'unrelated'});assert.equal(volume(),0);r.player.close();assert.deepEqual(Object.keys(r.events),[]);
});
test('context construction/resume failures produce truthful Retry and contain private errors',async()=>{
  for(const createContext of [()=>{throw Error('private room name');},()=>({state:'suspended',resume:async()=>{throw Error('private participant');}})]){
    const r=rig({createContext});await r.button.handlers.click();assert.equal(r.button.textContent,'Retry sound');assert.equal(r.button.attrs['aria-pressed'],'false');assert.doesNotMatch(r.elements.map(n=>n.textContent).join(' '),/private/);assert.equal(r.log.loads,0);r.player.close();
  }
});
test('mute then re-enable while module load is held rebaselines only latest permission/current view',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const r=rig({loadMusic:()=>pending});
  const first=r.button.handlers.click();await settle();r.player.mute();r.view({phase:'ended'});const second=r.button.handlers.click();await settle();release({createRoomMusic:()=>r.engine});await Promise.all([first,second]);await settle();
  assert.equal(r.log.reconciles.length,1);assert.equal(r.log.reconciles[0].v.phase,'ended');assert.equal(r.log.reconciles[0].options.baseline,true);r.player.close();
});
test('audio preferences fail closed on invalid/blocked values without inventing music gain',()=>{
  for(const raw of [null,'',' ','NaN','Infinity','-1','1.1'])assert.equal(readAudioLevel({getItem:()=>raw},'music'),null);
  assert.equal(readAudioLevel({getItem:()=>'.25'},'music'),.25);assert.equal(readAudioLevel({getItem(){throw Error();}},'music'),null);
  for(const value of [NaN,Infinity,-1,1.1,'0.2'])assert.equal(writeAudioLevel({setItem(){throw Error('must not write');}},'music',value),false);
  assert.equal(writeAudioLevel(null,'music',.2),false);assert.equal(writeAudioLevel({},'music',.2),false);
});
test('local gesture baselines current view and does not suppress the next genuine accepted publication',async()=>{
  const r=rig();r.player.update({phase:'waiting'});await r.button.handlers.click();await settle();
  r.player.update({phase:'live',surface:{kind:'reflection'}});assert.equal(r.log.reconciles.at(-1).options.baseline,false);
  r.player.recover();assert.equal(r.player.update({phase:'live',surface:{kind:'reflection'}}),true);r.player.close();
});

test('publication accepted during lazy engine import follows the captured permission baseline',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const r=rig({loadMusic:()=>pending});
  const initial={phase:'live',surface:{kind:'reflection'},publication:{occurrenceId:'old'}};r.view(initial);r.player.update(initial);
  const click=r.button.handlers.click();await settle();
  const next={phase:'live',surface:{kind:'reflection'},publication:{occurrenceId:'new'}};r.view(next);r.player.update(next);
  release({createRoomMusic:()=>r.engine});await click;
  assert.deepEqual(r.log.reconciles,[{v:initial,options:{baseline:true}},{v:next,options:{baseline:false}}]);r.player.close();
});

test('a recovery snapshot received during lazy import replaces the captured quiet baseline',async()=>{
  let release;const r=rig({loadMusic:()=>new Promise(resolve=>release=resolve)});const old={phase:'live',surface:{kind:'reflection'}};
  r.view(old);r.player.update(old);const click=r.button.handlers.click();await settle();
  const restored={phase:'live',surface:{kind:'reflection'},restored:true};r.view(restored);r.player.recover();r.player.update(restored);
  release({createRoomMusic:()=>r.engine});await click;assert.deepEqual(r.log.reconciles,[{v:restored,options:{baseline:true}}]);r.player.close();
});

test('lazy music module failure keeps effects permission and offers honest document reload',async()=>{
  const r=rig({loadMusic:async()=>{throw Error('private module message');}});await r.button.handlers.click();await settle();
  assert.equal(r.button.attrs['aria-pressed'],'true');assert.equal(r.button.textContent,'Mute sound');
  assert.equal(r.elements.find(n=>n.attrs.role==='status').textContent,'Session music could not load. Reload this page to try again.');
  assert.equal(r.elements.find(n=>n.dataset.soundControl==='reload').hidden,false);r.player.mute();await r.button.handlers.click();assert.equal(r.button.attrs['aria-pressed'],'true');r.player.close();
});

test('[AS-202] room levels: pause and Effects off silence this display; defaults when a server sends none; the device scales them',()=>{
  const room={choice:'auto',intensity:70,playing:true,volume:40,effects:true,transport:null};
  assert.deepEqual(roomLevels(room),{music:.4,effects:.6});
  assert.deepEqual(roomLevels({...room,playing:false,effects:false},1,1),{music:0,effects:0});
  assert.deepEqual(roomLevels(undefined),{music:.6,effects:.6});
  const scaled=roomLevels(room,.5,.5);assert.equal(scaled.music,.2);assert.ok(Math.abs(scaled.effects-.3)<1e-12);
});
