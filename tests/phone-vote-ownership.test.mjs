// Real phone delivery/store/cleanup modules under a deliberately delayed storage-event fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as delivery from '../src/client/phone-delivery.mjs';
import {openVoteStore} from '../src/client/vote-store.mjs';
import {createOutbox} from '../src/client/outbox.mjs';
import {participantStorageFence} from '../src/client/storage-barrier.mjs';
import {createPhoneCleanup} from '../src/client/phone-cleanup.mjs';
import {participantRoomInventory,validateRoomRows} from '../src/client/storage-policy.mjs';
import {uuidv7} from '../src/shared/ids.mjs';

function fixture(t,{sendA=async()=>({receipt:'accepted'})}={}) {
 const lockTails=new Map(),shared=new Map(),listeners=new Set();
 const previous={add:globalThis.addEventListener,remove:globalThis.removeEventListener};
 globalThis.addEventListener=(type,fn)=>{if(type==='storage')listeners.add(fn);};
 globalThis.removeEventListener=(type,fn)=>{if(type==='storage')listeners.delete(fn);};
 const locks={request(name,run){const task=(lockTails.get(name)??Promise.resolve()).then(run);lockTails.set(name,task.catch(()=>{}));return task;}};
 const storage=(values=shared)=>({get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)});
 let durable=new Map(),exists=true;const handles=new Set(),deleted=[];
 const names=values=>Object.assign(values,{contains:key=>values.includes(key)});
 // Transaction completion/abort and origin-lock ordering are modeled; native browser proof is separate.
 function idb() {return {databases:async()=>exists?[{name:'case:phone-outbox'}]:[],open(){
  exists=true;let closed=false;
  const db={objectStoreNames:names(['votes']),close(){closed=true;handles.delete(db);},transaction(_name,mode){
   if(closed)throw Object.assign(Error('native handle closed'),{name:'InvalidStateError'});
   const working=new Map([...durable].map(([key,row])=>[key,structuredClone(row)]));let aborted=false;
   const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(){
    const getAll=filter=>{const request={result:[...working.values()].filter(filter).sort((a,b)=>a.envelope.clientEventId.localeCompare(b.envelope.clientEventId)).map(row=>structuredClone(row))};
     queueMicrotask(()=>{request.onsuccess?.();queueMicrotask(()=>{if(!aborted){if(mode==='readwrite')durable=working;tx.oncomplete?.();}});});return request;};
    return {keyPath:'envelope.clientEventId',indexNames:names(['roomId']),getAll:()=>getAll(()=>true),index:()=>({keyPath:'roomId',getAll:roomId=>getAll(row=>row.roomId===roomId)}),delete:key=>working.delete(key),put:row=>working.set(row.envelope.clientEventId,structuredClone(row))};
   }};return tx;
  }};
  handles.add(db);const request={result:db};queueMicrotask(()=>request.onsuccess?.());return request;
 },deleteDatabase(name){deleted.push(name);const request={};queueMicrotask(()=>{
  for(const db of [...handles])db.onversionchange?.();
  if(handles.size){request.onblocked?.();return;}exists=false;durable.clear();request.onsuccess?.();
 });return request;}};}
 const roomId=uuidv7(),roundId=uuidv7(),aId=uuidv7(),bId=uuidv7(),key=`case:participant:${roomId}:token`,localA=storage(),localB=storage(),idbA=idb(),idbB=idb();
 const a={sessionId:roomId,token:'a'.repeat(32),expiresAt:Date.now()+60000},b={sessionId:roomId,token:'b'.repeat(32),expiresAt:Date.now()+60000};localA.setItem(key,JSON.stringify(a));
 const fenceA=participantStorageFence({localStorage:localA,indexedDB:idbA,locks,requireLocks:true,initialBinding:{key,credential:a}}),fenceB=participantStorageFence({localStorage:localB,indexedDB:idbB,locks,requireLocks:true});
 const originalA=openVoteStore({indexedDB:idbA,localStorage:localA,locks,requireLocks:true});
 // Missing the guard executes the original source behavior, so these behavioral assertions fail
 // rather than merely failing to import the new export during the before-fix proof.
 const storeA=delivery.guardPhoneVoteStore?.(originalA,fenceA)??originalA;
 const storeB=openVoteStore({indexedDB:idbB,localStorage:localB,locks,requireLocks:true});
 const boxA=createOutbox({store:storeA,roomId,participantId:aId,send:sendA,locks}),boxB=createOutbox({store:storeB,roomId,participantId:bId,send:async()=>({receipt:'accepted'}),locks});
 let storageEvents=0;const unwatch=fenceA.watch(()=>{storageEvents++;boxA.close();void storeA.close();});
 t.after(async()=>{unwatch();boxA.close();boxB.close();await storeA.close();await storeB.close();globalThis.addEventListener=previous.add;globalThis.removeEventListener=previous.remove;});
 const input=text=>({roundId,epoch:0,response:{text}});
 async function replace() {
  assert.equal(await fenceB.commit(()=>{localB.setItem(key,JSON.stringify(b));return true;},{key,credential:b}),true);
  await storeB.update(roomId,rows=>({rows:rows.filter(row=>row.participantId===bId),result:null}));
  await boxB.enqueue(input('replacement own answer'));
  assert.equal(fenceA.valid(),false);assert.equal(fenceB.valid(),true);assert.equal(storageEvents,0);
  return structuredClone([...durable.values()]);
 }
 const cleanup=createPhoneCleanup({selection:()=>({role:'participant',sessionId:roomId,participantId:aId,credential:a,knownInventory:true,queueValidated:true}),localStorage:localA,sessionStorage:storage(new Map()),indexedDB:idbA,locks,requireLocks:true,caches:{keys:async()=>[]},openStore:()=>openVoteStore({indexedDB:idbA,localStorage:localA,locks,requireLocks:true}),clearMemory:()=>{boxA.close();void storeA.close();}});
 return {roomId,roundId,aId,bId,storeA,boxA,input,replace,cleanup,deleted,rows:()=>structuredClone([...durable.values()]),credential:()=>localB.getItem(key),expectedCredential:JSON.stringify(b),validRows:()=>validateRoomRows([...durable.values()],participantRoomInventory(localB))};
}

test('[AS-114] delayed old phone enqueue cannot append after replacement ownership, and old cleanup conserves the replacement',async t=>{
 const f=fixture(t);await f.boxA.enqueue(f.input('original own answer'));
 let release;const binding=new Promise(resolve=>release=resolve);
 const pending=(async()=>{await binding;return f.boxA.enqueue(f.input('delayed old intent'));})();
 const replacement=await f.replace();release();
 await assert.rejects(pending,/Vote storage closed/);
 assert.deepEqual(f.rows(),replacement);assert.equal(f.validRows(),true);assert.equal(f.credential(),f.expectedCredential);
 assert.deepEqual(await f.cleanup('pagehide'),{complete:true});
 assert.deepEqual(f.rows(),replacement);assert.equal(f.credential(),f.expectedCredential);assert.deepEqual(f.deleted,[]);
});

test('[AS-114] stale owner restore, admission and epoch callbacks reject before touching replacement rows',async t=>{
 const f=fixture(t);await f.boxA.enqueue(f.input('original own answer'));const replacement=await f.replace();let changed=0;
 await assert.rejects(f.storeA.update(f.roomId,rows=>{changed++;return {rows:rows.filter(row=>row.participantId===f.aId),result:null};}),/Vote storage closed/);
 assert.equal(changed,0,'the exact old restore callback must never execute');
 await assert.rejects(f.boxA.flush(),/Vote storage closed/);
 await assert.rejects(f.boxA.setEpoch(1),/Vote storage closed/);
 await assert.rejects(f.boxA.latest(f.roundId),/Vote storage closed/);
 assert.deepEqual(f.rows(),replacement);assert.equal(f.credential(),f.expectedCredential);assert.equal(f.validRows(),true);
});

test('[AS-114] a real admitted old vote receipt cannot write after replacement ownership',async t=>{
 let entered,release,dispatched;const sending=new Promise(resolve=>entered=resolve),receipt=new Promise(resolve=>release=resolve);
 const f=fixture(t,{sendA:async envelope=>{dispatched=structuredClone(envelope);entered();return receipt;}});const enqueued=await f.boxA.enqueue(f.input('admitted old answer'));
 const queued=f.rows();assert.equal(queued.length,1);assert.deepEqual(queued[0].envelope,enqueued,'capture the complete persisted envelope before actual dispatch');
 const flight=f.boxA.flush();await sending;
 assert.deepEqual(dispatched,enqueued,'the actual send callback receives the exact durable envelope and client event ID');
 assert.equal(f.rows()[0].envelope.clientEventId,enqueued.clientEventId,'the dispatched event remains durably identified until its receipt');
 const replacement=await f.replace();release({receipt:'accepted'});
 await assert.rejects(flight,/Vote storage closed/);
 assert.deepEqual(f.rows(),replacement);assert.equal(f.credential(),f.expectedCredential);assert.equal(f.validRows(),true);
 assert.deepEqual(await f.cleanup('pagehide'),{complete:true});assert.deepEqual(f.rows(),replacement);assert.deepEqual(f.deleted,[]);
});

test('[AS-114] production phone binds every live store update to its captured credential fence',()=>{
 const source=readFileSync(new URL('../src/client/phone.mjs',import.meta.url),'utf8');
 assert.equal(/guardPhoneVoteStore\(openVoteStore\(\),\s*credentialFence\)/.test(source),true,'the live phone store must bind the captured fence');
 assert.equal((source.match(/openVoteStore\(/g)??[]).length,1,'no second unguarded live phone store');
});
