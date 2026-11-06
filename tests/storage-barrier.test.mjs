import test from 'node:test';
import assert from 'node:assert/strict';
import { storageBarrier } from '../src/client/storage-barrier.mjs';
import { openVoteStore } from '../src/client/vote-store.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function originLocks() {
 let tail=Promise.resolve();
 return {request(_name,operation){const flight=tail.then(operation);tail=flight.catch(()=>{});return flight;}};
}
test('late blocked deletion remains one destructive origin fence across tabs and bounded retries',async()=>{
 const locks=originLocks();let request,deleted=0,activated=0;
 const oldIDB={deleteDatabase(){deleted++;request={};queueMicrotask(()=>request.onblocked?.());return request;}};
 const nextIDB={deleteDatabase(){throw Error('new tab cannot delete');}};
 const old=storageBarrier({indexedDB:oldIDB,locks,requireLocks:true,timeoutMs:15});
 const next=storageBarrier({indexedDB:nextIDB,locks,requireLocks:true,timeoutMs:15});
 const deletion=old.delete('case:phone-outbox');await tick();
 const retry=old.delete('case:phone-outbox');
 const activation=next.run(()=>activated++);
 for(const flight of [deletion,retry,activation])await assert.rejects(flight,{code:'storage_unavailable'});
 assert.equal(deleted,1);assert.equal(activated,0);
 request.onsuccess();await tick();
 assert.equal(activated,0,'timed-out queued activation never runs later');
 await next.run(()=>activated++);assert.equal(activated,1);
});
test('deletion awaits actual owned-handle close and terminal error while unsupported cross-tab coordination refuses',async()=>{
 let request,closed=false,release;
 const indexedDB={deleteDatabase(){assert.equal(closed,true);request={};return request;}};
 const barrier=storageBarrier({indexedDB,locks:originLocks(),requireLocks:true,timeoutMs:30});
 barrier.register(()=>new Promise(resolve=>{release=()=>{closed=true;resolve();};}));
 const deleted=barrier.delete('case:phone-outbox');await tick();assert.equal(request,undefined);
 release();await tick();request.onerror();await assert.rejects(deleted,{code:'storage_unavailable'});
 await barrier.wait();
 await assert.rejects(storageBarrier({indexedDB:{},locks:null,requireLocks:true}).wait(),{code:'storage_unavailable'});
});
test('owned outbox close never waits for a store operation queued behind its own destructive fence',async()=>{
 const locks=originLocks(),roomId=uuidv7();let deletion,opened=0,closed=0;
 const indexedDB={deleteDatabase(){deletion={};return deletion;}};
 const store=openVoteStore({indexedDB,locks,requireLocks:true,timeoutMs:80,openDatabase:async()=>{
  opened++;return {close(){closed++;},transaction(){const tx={error:null,objectStore(){return {index(){return {getAll(){const r={result:[]};queueMicrotask(()=>tx.oncomplete?.());return r;}};}};}};return tx;}};
 }});
 await store.read(roomId);assert.equal(opened,1);
 const destructive=storageBarrier({indexedDB,locks,requireLocks:true,timeoutMs:80}).delete('case:phone-outbox');
 const queued=store.update(roomId,rows=>({rows,result:null}));queued.catch(()=>{});
 await tick();assert.equal(closed,1);assert.ok(deletion,'deletion issued without deadlocking on queued store tail');
 deletion.onsuccess();assert.equal(await destructive,true);await assert.rejects(queued,/closed/);
 await assert.rejects(store.read(roomId),/closed/);assert.equal(opened,1);await store.close();
});

test('origin security generation fences old unopened outboxes and late guarded credential commits',async()=>{
 const {participantStorageFence}=await import('../src/client/storage-barrier.mjs');
 const {advanceStorageGeneration}=await import('../src/client/storage-generation.mjs');
 const values=new Map(),localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const indexedDB={},locks=originLocks();
 const old=participantStorageFence({localStorage,indexedDB,locks,requireLocks:true});
 const oldStore=openVoteStore({localStorage,indexedDB,locks,requireLocks:true,openDatabase:async()=>{throw Error('stale unopened store must not open');}});
 await storageBarrier({indexedDB,locks,requireLocks:true}).run(()=>advanceStorageGeneration(localStorage));
 let writes=0;assert.equal(await old.commit(()=>{writes++;}),false);assert.equal(writes,0);assert.equal(old.valid(),false);
 await assert.rejects(oldStore.read(uuidv7()),/closed/);await oldStore.close();
 const next=participantStorageFence({localStorage,indexedDB,locks,requireLocks:true});assert.equal(await next.commit(()=>++writes),1);assert.equal(writes,1);
});

test('restored participant fence binds the captured token immediately and ignores delayed old-key events',async()=>{
 const {participantStorageFence}=await import('../src/client/storage-barrier.mjs');
 const sessionId=uuidv7(),key=`case:participant:${sessionId}:token`,credential={sessionId,token:'a'.repeat(32),expiresAt:Date.now()+60000};
 const values=new Map([[key,JSON.stringify(credential)]]),localStorage={getItem:k=>values.get(k)??null};
 const listeners=new Set(),add=globalThis.addEventListener,remove=globalThis.removeEventListener;
 globalThis.addEventListener=(_type,listener)=>listeners.add(listener);globalThis.removeEventListener=(_type,listener)=>listeners.delete(listener);
 try{
  const fence=participantStorageFence({localStorage,indexedDB:{},locks:originLocks(),requireLocks:true,initialBinding:{key,credential}});let stopped=0;const unwatch=fence.watch(()=>stopped++);
  for(const listener of listeners)listener({key,newValue:null});assert.equal(stopped,0);assert.equal(fence.valid(),true);
  values.set(key,JSON.stringify({...credential,token:'b'.repeat(32)}));for(const listener of listeners)listener({key,newValue:values.get(key)});assert.equal(stopped,1);assert.equal(fence.valid(),false);
  let writes=0;assert.equal(await fence.commit(()=>writes++),false);assert.equal(writes,0);unwatch();assert.equal(listeners.size,0);
 }finally{globalThis.addEventListener=add;globalThis.removeEventListener=remove;}
});
