// Served storage repair proofs use only a throwaway local Worker and browser origin.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startLocalWorker,createRoom,facilitatorCommand,serverMirror,FIXTURE} from '../tests/helpers/local-worker.mjs';
import {joinUrl,joinEntryUrl,privacyUrl} from '../src/shared/urls.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
import {readdirSync} from 'node:fs';
let worker,storageModules;
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{worker=await startLocalWorker();const files=readdirSync(`${worker.assetDir}/assets`);storageModules=Object.fromEntries(['transport','storage-barrier','teardown','vote-store','account-session','phone-cleanup','phone-delivery','outbox'].map(name=>{const file=files.find(file=>file.startsWith(`${name}.`)&&file.endsWith('.mjs'));if(!file)throw Error(`missing_served_storage_module:${name}`);return [name,`/assets/${file}`];}));});
test.afterAll(async()=>{await worker?.stop();});
test.use({viewport:{width:390,height:844}});
const key=id=>`case:participant:${id}:token`;
async function join(page,room,name='Storage participant',avatar='Wine, curls'){
 await page.goto(joinUrl(room.joinCode,worker.origin));
 await page.getByLabel('Your name',{exact:true}).fill(name);
 await page.getByText('Change avatar',{exact:true}).click();
 await page.getByRole('radio',{name:avatar,exact:true}).check();
 await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
}
test('[AS-114] failed joined-document cleanup rebuilds public Retry after clearing private phone UI',async({page})=>{
 const room=await createRoom(worker.origin);let joins=0,faultArmed=false;
 await page.addInitScript(()=>{
  const factory=Object.getPrototypeOf(indexedDB),databases=factory.databases;
  Object.defineProperty(factory,'databases',{configurable:true,writable:true,value:function(){return window.failHandoffInventory?Promise.reject(new Error('local inventory fault')):databases.call(this);}});
 });
 await page.route('**/api/v1/join',async route=>{
  const response=await route.fetch();expect(response.status()).toBe(201);joins++;
  faultArmed=await page.evaluate(async()=>{window.failHandoffInventory=true;try{await indexedDB.databases();return false;}catch{return true;}});
  await route.fulfill({response});
 });
 await page.goto(joinUrl(room.joinCode,worker.origin));
 await page.getByLabel('Your name',{exact:true}).fill('Handoff learner');
 await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect.poll(()=>joins).toBe(1);
 await expect.poll(()=>faultArmed).toBe(true);
 await expect(page.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
 await expect(page.locator('body')).not.toContainText('Handoff learner');
 await expect(page.locator('main')).toHaveCount(1);
 expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 await page.screenshot({path:test.info().outputPath('join-storage-recovery.png')});
 expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(1);
 await page.evaluate(()=>{window.failHandoffInventory=false;});
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 await expect(page.locator('.phone-app')).toHaveCount(1);
 expect(joins).toBe(1);
 expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(1);
});

async function storageHost(page){await page.goto(privacyUrl(worker.origin));await expect(page.getByRole('heading',{name:'Privacy and data notice',exact:true})).toBeVisible();}
async function rows(page,roomId){return page.evaluate(roomId=>new Promise((resolve,reject)=>{
 const request=indexedDB.open('case:phone-outbox',1);request.onerror=()=>reject(request.error);
 request.onsuccess=()=>{const db=request.result,tx=db.transaction('votes','readonly'),read=tx.objectStore('votes').index('roomId').getAll(roomId);tx.oncomplete=()=>{db.close();resolve(read.result);};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};};
}),roomId);}
async function queued(page,room){
 for(const type of ['start','advance','advance','advance','advance','advance'])expect((await facilitatorCommand(worker.origin,room,type)).receipt).toBe('accepted');
 const mirror=await serverMirror(worker.origin,room),participantId=Object.keys(mirror.participants)[0];
 const row={roomId:room.sessionId,participantId,superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:mirror.epoch,clientEventId:uuidv7(),roundId:mirror.round.id,response:{option_id:FIXTURE.decisions[0].interaction.options[0].id}}};
 await page.route('**/api/v1/sessions/*/commands',route=>route.request().postDataJSON()?.type==='vote'?route.abort('connectionfailed'):route.continue());
 await page.evaluate(row=>new Promise((resolve,reject)=>{const request=indexedDB.open('case:phone-outbox',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('votes','readwrite');tx.objectStore('votes').put(row);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};};}),row);
 return row;
}
async function holdUnadmittedDelivery(page,room){
 const owner=Object.keys((await serverMirror(worker.origin,room)).participants)[0],name=`case-vote-delivery:${room.sessionId}:${owner}`;
 const blocker=await page.context().newPage();
 try {
  await storageHost(blocker);
  await blocker.evaluate(name=>new Promise(ready=>{window.storageDeliveryHold=navigator.locks.request(name,()=>new Promise(release=>{window.releaseStorageDelivery=release;ready();}));}),name);
  expect(await blocker.evaluate(async name=>(await navigator.locks.query()).held.some(lock=>lock.name===name),name)).toBe(true);
  return async()=>{try{await blocker.evaluate(async()=>{window.releaseStorageDelivery();await window.storageDeliveryHold;});}finally{await blocker.close();}};
 } catch(error){await blocker.close();throw error;}
}
test('different-room QR and new tab preserve the old exact room credential and durable answer',async({page,context})=>{
 const room=await createRoom(worker.origin),other=await createRoom(worker.origin);await join(page,room);
 const owner=Object.keys((await serverMirror(worker.origin,room)).participants)[0],deliveryLock=`case-vote-delivery:${room.sessionId}:${owner}`;
 const blocker=await context.newPage();await storageHost(blocker);
 try {
 // Keep the deliberately unadmitted fixture stable while the original phone remains live.
 // Actual admission has its own tests; aborting HTTP alone permits admission before dispatch.
 await blocker.evaluate(name=>new Promise(ready=>{window.storageDeliveryHold=navigator.locks.request(name,()=>new Promise(release=>{window.releaseStorageDelivery=release;ready();}));}),deliveryLock);
 expect(await blocker.evaluate(async name=>(await navigator.locks.query()).held.some(lock=>lock.name===name),deliveryLock)).toBe(true);
 const row=await queued(page,room),saved=await page.evaluate(key=>localStorage.getItem(key),key(room.sessionId));
 const next=await context.newPage();await next.goto(joinUrl(other.joinCode,worker.origin));
 await expect(next.getByRole('heading',{name:'Join the case',exact:true})).toBeVisible();
 expect(await next.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBe(saved);expect(await rows(next,room.sessionId)).toEqual([row]);
 await expect(next.getByRole('radio')).toHaveCount(0);await expect(next.getByText('Not sent yet · 1',{exact:true})).toHaveCount(0);
 await page.goto(joinUrl(other.joinCode,worker.origin));await expect(page.getByRole('heading',{name:'Join the case',exact:true})).toBeVisible();
 expect(await page.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBe(saved);expect(await rows(page,room.sessionId)).toEqual([row]);
 expect(Object.keys((await serverMirror(worker.origin,other)).participants)).toHaveLength(0);
 } finally {try{await blocker.evaluate(async()=>{window.releaseStorageDelivery?.();await window.storageDeliveryHold;});}finally{await blocker.close();}}
});
test('old tab pagehide cannot erase a newer same-room capability and owner answer',async({page,context})=>{
 const holds=[];try {
 const room=await createRoom(worker.origin);await join(page,room);
 holds.push(await holdUnadmittedDelivery(page,room));const row=await queued(page,room);
 const writer=await context.newPage();await writer.goto(`${worker.origin}/favicon.ico`);
 const replacement=await writer.evaluate(key=>{const c=JSON.parse(localStorage.getItem(key));c.token='replacement-token-for-local-storage-proof';const value=JSON.stringify(c);localStorage.setItem(key,value);return value;},key(room.sessionId));
 await page.goto(joinEntryUrl(worker.origin));
 expect(await writer.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBe(replacement);expect(await rows(writer,room.sessionId)).toEqual([row]);
 // Deliberate event-delivery fault: native storage operations stay intact; only listener delivery
 // is deferred. This establishes native guard ordering, not an ordinary race-frequency claim.
 await context.addInitScript(()=>{
  const add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window),wrapped=new WeakMap();
  window.deferredOwnerEvents=[];window.ownerEventsDelivered=0;
  window.addEventListener=(type,listener,options)=>{
   if(type!=='storage'||!listener)return add(type,listener,options);
   let wrapper=wrapped.get(listener);if(!wrapper){wrapper=function(event){
    const deliver=()=>{if(event.key===window.deferredOwnerKey)window.ownerEventsDelivered++;if(typeof listener==='function')listener.call(this,event);else listener.handleEvent(event);};
    if(window.deferOwnerEvents&&event.key===window.deferredOwnerKey)window.deferredOwnerEvents.push(deliver);else deliver();
   };wrapped.set(listener,wrapper);}return add(type,wrapper,options);
  };
  window.removeEventListener=(type,listener,options)=>remove(type,type==='storage'?wrapped.get(listener)??listener:listener,options);
 });
 const realRoom=await createRoom(worker.origin);await join(page,realRoom,'Original owner');
 holds.push(await holdUnadmittedDelivery(page,realRoom));const originalRow=await queued(page,realRoom);
 const originalCredential=await page.evaluate(key=>localStorage.getItem(key),key(realRoom.sessionId));expect(originalCredential).not.toBeNull();
 await page.evaluate(key=>{window.deferOwnerEvents=true;window.deferredOwnerKey=key;window.ownerEventsDelivered=0;},key(realRoom.sessionId));
 const stale=await context.newPage();await storageHost(stale);await storageHost(writer);
 await stale.evaluate(async({modules,roomId,owner,credential,credentialKey,input})=>{
  const {guardPhoneVoteStore}=await import(modules['phone-delivery']),{openVoteStore}=await import(modules['vote-store']),{createOutbox}=await import(modules.outbox),{participantStorageFence}=await import(modules['storage-barrier']);
  window.deferOwnerEvents=true;window.deferredOwnerKey=credentialKey;window.ownerEventsDelivered=0;
  const nativeTransaction=IDBDatabase.prototype.transaction;window.nativeOwnerTransactions=0;
  IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')window.nativeOwnerTransactions++;return Reflect.apply(nativeTransaction,this,args);};
  const fence=participantStorageFence({localStorage,indexedDB,initialBinding:{key:credentialKey,credential:JSON.parse(credential)}});
  const store=guardPhoneVoteStore(openVoteStore(),fence),box=createOutbox({store,roomId,participantId:owner,send:async()=>{throw Error('stale send must not occur');}});
  let release;const binding=new Promise(resolve=>release=resolve);window.nativeOldOwner={fence,store,box,release,input,roomId,owner,changed:0,stopped:0,restoreTransactions:()=>{IDBDatabase.prototype.transaction=nativeTransaction;}};
  window.nativeOldOwner.unwatch=fence.watch(()=>window.nativeOldOwner.stopped++);
  window.nativeOldOwner.enqueue=(async()=>{await binding;try{await box.enqueue(input);return 'unexpected write';}catch(error){return error.message;}})();
 },{modules:storageModules,roomId:realRoom.sessionId,owner:originalRow.participantId,credential:originalCredential,credentialKey:key(realRoom.sessionId),input:{roundId:originalRow.envelope.roundId,epoch:originalRow.envelope.epoch,response:originalRow.envelope.response}});
 const joined=await writer.evaluate(async({modules,code})=>{
  const {connect}=await import(modules.transport),{participantStorageFence}=await import(modules['storage-barrier']);
  const fence=participantStorageFence({localStorage,indexedDB}),link=connect({role:'participant',api:location.origin,storage:null,persistentStorage:localStorage,restoreCredential:false,credentialFence:fence});
  window.nativeNewOwner={fence,link};const result=await link.join(code,'Fresh participant','shadows-02');const ready=await link.credentialReady;return {result,ready};
 },{modules:storageModules,code:realRoom.joinCode});
 expect(joined.result.ok).toBe(true);expect(joined.ready).toBe(true);expect(joined.result.participantId).not.toBe(originalRow.participantId);
 await expect.poll(()=>writer.evaluate(()=>window.nativeNewOwner.link.snapshot?.view?.you?.id)).toBe(joined.result.participantId);
 const mirror=await serverMirror(worker.origin,realRoom);expect(mirror.participants[joined.result.participantId]).toBeDefined();
 const genuineReplacement=await writer.evaluate(async({modules,roomId,input,credentialKey})=>{
  const {guardPhoneVoteStore}=await import(modules['phone-delivery']),{openVoteStore}=await import(modules['vote-store']),{createOutbox}=await import(modules.outbox);
  const state=window.nativeNewOwner,owner=state.link.participantId;state.store=guardPhoneVoteStore(openVoteStore(),state.fence);
  await state.store.update(roomId,rows=>({rows:rows.filter(row=>row.participantId===owner),result:null}));
  state.box=createOutbox({store:state.store,roomId,participantId:owner,send:async()=>{throw Error('new fixture answer must stay queued');}});state.envelope=await state.box.enqueue(input);
  return {credential:localStorage.getItem(credentialKey),rows:await state.store.read(roomId),envelope:state.envelope};
 },{modules:storageModules,roomId:realRoom.sessionId,credentialKey:key(realRoom.sessionId),input:{roundId:originalRow.envelope.roundId,epoch:originalRow.envelope.epoch,response:originalRow.envelope.response}});
 expect(genuineReplacement.rows).toHaveLength(1);expect(genuineReplacement.rows[0].participantId).toBe(joined.result.participantId);expect(genuineReplacement.rows[0].envelope).toEqual(genuineReplacement.envelope);expect(genuineReplacement.credential).not.toBe(originalCredential);
 await expect.poll(()=>stale.evaluate(()=>window.deferredOwnerEvents.length)).toBeGreaterThan(0);
 await expect.poll(()=>page.evaluate(()=>window.deferredOwnerEvents.length)).toBeGreaterThan(0);
 // Hold a genuine origin Web Lock after B commits, then release A's binding. A's callback must
 // acquire the lock and begin its genuine IDB transaction before the ownership guard rejects it.
 await writer.evaluate(()=>new Promise(resolve=>{window.ownerLockFlight=navigator.locks.request('case-private-storage',()=>new Promise(release=>{window.releaseOwnerLock=release;resolve();}));}));
 const [staleResult]=await Promise.all([
  stale.evaluate(async()=>{const state=window.nativeOldOwner;state.release();return state.enqueue;}),
  writer.evaluate(async()=>{try{for(let attempt=0;attempt<100;attempt++){const state=await navigator.locks.query();if(state.pending.some(lock=>lock.name==='case-private-storage'))return true;await new Promise(resolve=>setTimeout(resolve,0));}throw Error('old native transaction never queued for the origin lock');}finally{window.releaseOwnerLock();await window.ownerLockFlight;}}),
 ]);
 expect(staleResult).toBe('Vote storage closed');
 const restored=await stale.evaluate(async()=>{const state=window.nativeOldOwner;try{await state.store.update(state.roomId,rows=>{state.changed++;return {rows:rows.filter(row=>row.participantId===state.owner),result:null};});return {error:'unexpected write',changed:state.changed};}catch(error){return {error:error.message,changed:state.changed,valid:state.fence.valid(),stopped:state.stopped,delivered:window.ownerEventsDelivered,deferred:window.deferredOwnerEvents.length,transactions:window.nativeOwnerTransactions};}});
 expect(restored).toMatchObject({error:'Vote storage closed',changed:0,valid:false,stopped:0,delivered:0});expect(restored.deferred).toBeGreaterThan(0);expect(restored.transactions).toBe(2);
 expect(await writer.evaluate(key=>localStorage.getItem(key),key(realRoom.sessionId))).toBe(genuineReplacement.credential);expect(await rows(writer,realRoom.sessionId)).toEqual(genuineReplacement.rows);
 expect(await page.evaluate(()=>window.ownerEventsDelivered)).toBe(0);expect(await page.evaluate(()=>window.deferredOwnerEvents.length)).toBeGreaterThan(0);
 await page.goto(joinEntryUrl(worker.origin));
 expect(await writer.evaluate(key=>localStorage.getItem(key),key(realRoom.sessionId))).toBe(genuineReplacement.credential);expect(await rows(writer,realRoom.sessionId)).toEqual(genuineReplacement.rows);
 await stale.evaluate(async()=>{window.deferOwnerEvents=false;for(const deliver of window.deferredOwnerEvents.splice(0))deliver();const state=window.nativeOldOwner;state.unwatch();state.box.close();await state.store.close();state.restoreTransactions();});
 await writer.evaluate(async()=>{const state=window.nativeNewOwner;state.box.close();await state.store.close();state.link.close();});
 }finally{const results=await Promise.allSettled(holds.reverse().map(release=>release()));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;}
});
test('native blocked deletion fences Retry and another join until the external handle closes',async({page,context})=>{
 const room=await createRoom(worker.origin);await join(page,room);
 const keeper=await context.newPage();await keeper.goto(`${worker.origin}/favicon.ico`);
 await keeper.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('case:phone-outbox',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{window.heldVoteDatabase=r.result;window.heldVoteDatabase.onversionchange=()=>{};resolve();};}));
 await page.evaluate(()=>localStorage.setItem('case:unexpected-private-key','test fixture'));
 await page.goto(joinUrl(room.joinCode,worker.origin));await expect(page.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toBeVisible();
 const next=await context.newPage();await next.goto(joinUrl(room.joinCode,worker.origin));await expect(next.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toBeVisible();await expect(next.getByRole('button',{name:'Join case',exact:true})).toHaveCount(0);
 await keeper.evaluate(()=>window.heldVoteDatabase.close());await next.getByRole('button',{name:'Retry',exact:true}).click();await expect(next.getByRole('heading',{name:'Join the case',exact:true})).toBeVisible();
 await next.getByLabel('Your name',{exact:true}).fill('After deletion');await next.getByText('Change avatar',{exact:true}).click();await next.getByRole('radio',{name:'Wine, curls',exact:true}).check();await next.getByRole('button',{name:'Join case',exact:true}).click();await expect(next.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 const saved=await next.evaluate(key=>localStorage.getItem(key),key(room.sessionId));expect(saved).not.toBeNull();
 await page.getByRole('button',{name:'Retry',exact:true}).click();await expect.poll(()=>next.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBe(saved);
});
test('transient storage enumeration failure retains credentials, hides private drafts and Retry rereads',async({page})=>{
 const room=await createRoom(worker.origin);await join(page,room);const row=await queued(page,room),saved=await page.evaluate(key=>localStorage.getItem(key),key(room.sessionId));
 await page.addInitScript(()=>{const original=indexedDB.databases.bind(indexedDB);window.storageEnumerations=0;window.storageUnavailable=true;indexedDB.databases=()=>{window.storageEnumerations++;return window.storageUnavailable?Promise.reject(new Error('local temporary enumeration failure')):original();};});
 await page.reload();await expect(page.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toBeVisible();await expect(page.getByRole('radio')).toHaveCount(0);expect(await page.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBe(saved);
 const before=await page.evaluate(()=>window.storageEnumerations);await page.evaluate(()=>window.storageUnavailable=false);await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>window.storageEnumerations)).toBeGreaterThan(before);const retained=await rows(page,room.sessionId);expect(retained).toHaveLength(1);expect(retained[0].envelope.clientEventId).toBe(row.envelope.clientEventId);expect(retained[0].envelope.response).toEqual(row.envelope.response);
});
test('browser without Web Locks reports safe unavailable and cannot activate joining',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined,configurable:true}));
 const room=await createRoom(worker.origin);await page.goto(joinUrl(room.joinCode,worker.origin));await expect(page.getByRole('heading',{name:'Answer storage unavailable',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Join case',exact:true})).toHaveCount(0);expect(Object.keys((await serverMirror(worker.origin,room)).participants)).toHaveLength(0);
});

test('same-room QR resolves among multiple valid room slots and leaves the other room answer untouched',async({page,context})=>{
 let release;try {
 const foreign=await createRoom(worker.origin),target=await createRoom(worker.origin);await join(page,foreign);
 const second=await context.newPage();await join(second,target,'Second room');
 release=await holdUnadmittedDelivery(page,foreign);
 const queuedOther=await queued(page,foreign),savedOther=await second.evaluate(key=>localStorage.getItem(key),key(foreign.sessionId)),savedTarget=await second.evaluate(key=>JSON.parse(localStorage.getItem(key)).token,key(target.sessionId));
 // Native Storage.key order is unspecified, and Chromium's changes whenever any other key (such as
 // the long-poll pin) is added between reads, so order sampled on another page cannot predict the
 // QR page's. Present one legal order on the QR page only: the foreign room first, other keys in
 // native order. Every stored value and every write stays native.
 const qr=await context.newPage(),probes=[];qr.on('request',request=>{if(request.url().endsWith('/api/v1/join/recover'))probes.push(request.postDataJSON().sessionId);});
 await qr.addInitScript(first=>{const native=Storage.prototype.key;Storage.prototype.key=function key(index){const keys=Array.from({length:this.length},(_,i)=>native.call(this,i));if(this===window.localStorage&&keys.includes(first))keys.sort((x,y)=>(y===first)-(x===first));return keys[index]??null;};},key(foreign.sessionId));
 await qr.goto(joinUrl(target.joinCode,worker.origin));await expect(qr.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 expect(probes).toEqual([foreign.sessionId,target.sessionId]);expect(await qr.evaluate(key=>localStorage.getItem(key),key(foreign.sessionId))).toBe(savedOther);expect(await qr.evaluate(key=>JSON.parse(localStorage.getItem(key)).token,key(target.sessionId))).toBe(savedTarget);expect(await rows(qr,foreign.sessionId)).toEqual([queuedOther]);expect(Object.keys((await serverMirror(worker.origin,target)).participants)).toHaveLength(1);
 }finally{await release?.();}
});

// These adversarial callers use the exact hashed served modules. Web Locks, transactions,
// versionchange and network cancellation remain native browser operations on the local Worker origin.
test('[AS-114] queued security cleanup survives its deadline, cancels unbound joins and retains the native deletion fence',async({page,context})=>{
 const room=await createRoom(worker.origin),keeper=await context.newPage(),writer=await context.newPage();await storageHost(page);await storageHost(keeper);await storageHost(writer);
 await keeper.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('case:phone-outbox',1);r.onupgradeneeded=()=>{const store=r.result.createObjectStore('votes',{keyPath:'envelope.clientEventId'});store.createIndex('roomId','roomId');};r.onerror=()=>reject(r.error);r.onsuccess=()=>{window.heldVoteDatabase=r.result;window.versionChanges=0;r.result.onversionchange=()=>{window.versionChanges++;};resolve();};}));
 await keeper.evaluate(()=>new Promise(resolve=>{window.heldOriginLock=navigator.locks.request('case-private-storage',()=>{resolve();return new Promise(release=>{window.releaseOriginLock=release;});});}));
 let releaseResponse,receivedResponse;const heldResponse=new Promise(resolve=>{releaseResponse=resolve;}),received=new Promise(resolve=>{receivedResponse=resolve;});
 await page.route('**/api/v1/join',async route=>{const response=await route.fetch();expect(response.status()).toBe(201);receivedResponse();await heldResponse;try{await route.fulfill({response});}catch{/* Native abort may have discarded this response. */}});
 try{
  await page.evaluate(async({modules,code})=>{const {connect}=await import(modules.transport),{participantStorageFence}=await import(modules['storage-barrier']);window.storageRace={};const fence=participantStorageFence({localStorage,indexedDB});const link=connect({role:'participant',api:location.origin,storage:null,persistentStorage:localStorage,restoreCredential:false,credentialFence:fence});window.storageRace.link=link;window.storageRace.join=link.join(code,'Held local join','shadows-01').then(result=>{window.storageRace.result=result;return result;});}, {modules:storageModules,code:room.joinCode});
  await received;const initialGeneration=await page.evaluate(()=>Number(localStorage.getItem('case:storage:fence')??0));
  const outcome=await page.evaluate(async modules=>{const {createTeardown}=await import(modules.teardown);return createTeardown({localStorage,sessionStorage,indexedDB,caches,cleanupTimeoutMs:50})('sign_out');},storageModules);
  expect(outcome).toEqual({complete:false});await expect.poll(()=>page.evaluate(()=>window.storageRace.result?.ok)).toBe(false);
  expect(await page.evaluate(()=>window.storageRace.link.hasToken)).toBe(false);expect(await page.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBeNull();
  await keeper.evaluate(()=>window.releaseOriginLock());await expect.poll(()=>page.evaluate(()=>Number(localStorage.getItem('case:storage:fence')))).toBe(initialGeneration+1);
  await expect.poll(()=>keeper.evaluate(()=>window.versionChanges)).toBe(1);releaseResponse();
  // Advance only the writer's deadline clock; native Web Locks and IndexedDB stay real.
  await writer.clock.install({time:new Date('2026-10-09T00:00:00Z')});
  await writer.clock.pauseAt(new Date('2026-10-09T00:00:01Z'));
  await writer.evaluate(async modules=>{const {participantStorageFence}=await import(modules['storage-barrier']);window.freshStorageFence=participantStorageFence({localStorage,indexedDB,timeoutMs:50});window.freshWrites=0;window.freshStorageAttempt=window.freshStorageFence.commit(()=>{window.freshWrites++;localStorage.setItem('case:transport:pin','fresh');return true;}).then(()=>'written',error=>error.code);},storageModules);
  await writer.clock.runFor(51);
  const attempt=await writer.evaluate(()=>window.freshStorageAttempt);
  expect(attempt).toBe('storage_unavailable');expect(await writer.evaluate(()=>window.freshWrites)).toBe(0);
  // close() releases the blocker but does not synchronously finish native deletion.
  // Drain the same origin lock and verify deletion before testing a fresh bounded write.
  expect(await keeper.evaluate(async()=>{
   window.heldVoteDatabase.close();
   await navigator.locks.request('case-private-storage',()=>true);
   return (await indexedDB.databases()).some(database=>database.name==='case:phone-outbox');
  })).toBe(false);
  expect(await writer.evaluate(()=>window.freshStorageFence.commit(()=>{localStorage.setItem('case:transport:pin','after actual deletion');return true;}))).toBe(true);
  expect(await writer.evaluate(()=>window.freshWrites)).toBe(0); // The abandoned attempt cannot write late.
  const next=await context.newPage();await join(next,room,'Fresh participant','Brown, bun');const saved=await next.evaluate(key=>localStorage.getItem(key),key(room.sessionId));expect(saved).not.toBeNull();
  await writer.evaluate(()=>window.freshStorageFence.commit(()=>true));expect(await next.evaluate(key=>localStorage.getItem(key),key(room.sessionId))).toBe(saved);
 }finally{releaseResponse();await keeper.evaluate(()=>{window.releaseOriginLock?.();window.heldVoteDatabase?.close();});await page.evaluate(()=>window.storageRace?.link?.close());}
});

for(const caller of ['common-role','phone'])test(`native ${caller} expiry cleanup cannot erase a valid scoped replacement after the expired legacy key disappears`,async({page,context})=>{
 await storageHost(page);const writer=await context.newPage();await storageHost(writer);
 const roomId=uuidv7(),otherRoom=uuidv7(),owner=uuidv7(),newOwner=uuidv7(),otherOwner=uuidv7(),now=Date.now();
 const expired={sessionId:roomId,token:'a'.repeat(32),expiresAt:now-1},replacement={sessionId:roomId,token:'b'.repeat(32),expiresAt:now+60000},other={sessionId:otherRoom,token:'c'.repeat(32),expiresAt:now+60000};
 const row=(roomId,participantId,text)=>({roomId,participantId,superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text}}});
 const old=row(roomId,owner,'expired answer'),fresh=row(roomId,newOwner,'replacement own answer'),untouched=row(otherRoom,otherOwner,'another room own answer');
 await page.evaluate(async({modules,expired,other,old,untouched})=>{const {openVoteStore}=await import(modules['vote-store']);localStorage.setItem('case:participant:main:token',JSON.stringify(expired));localStorage.setItem(`case:participant:${other.sessionId}:token`,JSON.stringify(other));const store=openVoteStore();try{await store.update(old.roomId,()=>({rows:[old],result:null}));await store.update(untouched.roomId,()=>({rows:[untouched],result:null}));}finally{await store.close();}}, {modules:storageModules,expired,other,old,untouched});
 await page.evaluate(async({modules,caller})=>{const {openVoteStore}=await import(modules['vote-store']),{assertKnownStorageKeys,TEARDOWN_KEYS}=await import(modules.teardown);window.expiryInspected=false;const openStore=()=>{const store=openVoteStore();return {readAll:inspect=>store.readAll(inspect),update:async(...args)=>{window.expiryInspected=true;await new Promise(resolve=>{window.releaseExpiryUpdate=resolve;});return store.update(...args);},close:()=>store.close()};};const options={localStorage,sessionStorage,indexedDB,caches,openStore,assertKnownStorageKeys,knownDatabases:TEARDOWN_KEYS.knownDatabases};const task=caller==='common-role'?(await import(modules['account-session'])).prepareParticipantPreservation(options):(await import(modules['phone-cleanup'])).createPhoneCleanup(options)('pagehide');window.expiryResult=task;}, {modules:storageModules,caller});
 await expect.poll(()=>page.evaluate(()=>window.expiryInspected)).toBe(true);
 try{
  await writer.evaluate(({old,fresh,replacement})=>navigator.locks.request('case-private-storage',()=>new Promise((resolve,reject)=>{const request=indexedDB.open('case:phone-outbox',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('votes','readwrite'),store=tx.objectStore('votes');store.delete(old.envelope.clientEventId);store.put(fresh);tx.oncomplete=()=>{localStorage.removeItem('case:participant:main:token');localStorage.setItem(`case:participant:${replacement.sessionId}:token`,JSON.stringify(replacement));db.close();resolve();};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};};})),{old,fresh,replacement});
  await page.evaluate(()=>window.releaseExpiryUpdate());const result=await page.evaluate(()=>window.expiryResult);expect(caller==='common-role'?result.status:result.complete).toBe(caller==='common-role'?'known':true);
  expect(await writer.evaluate(key=>localStorage.getItem(key),key(roomId))).toBe(JSON.stringify(replacement));expect(await rows(writer,roomId)).toEqual([fresh]);expect(await rows(writer,otherRoom)).toEqual([untouched]);
 }finally{await page.evaluate(()=>window.releaseExpiryUpdate?.());}
});
test('[AS-061] a vote-storage step that fails once at join (a slow device timing out) is retried, so the learner still reaches the lobby',async({page})=>{
 const room=await createRoom(worker.origin);
 // Fail the first vote-store write after Join: the barrier's 1 s deadline under CI or phone load surfaces exactly so.
 await page.addInitScript(()=>{const native=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function transaction(stores,mode,...rest){if(window.failVoteWrites>0&&stores==='votes'&&mode==='readwrite'){window.failVoteWrites--;sessionStorage.setItem('test:failedVoteWrites',String(Number(sessionStorage.getItem('test:failedVoteWrites')??0)+1));throw new DOMException('transient storage failure','UnknownError');}return native.call(this,stores,mode,...rest);};});
 await page.goto(joinUrl(room.joinCode,worker.origin));
 await page.getByLabel('Your name',{exact:true}).fill('Slow storage');
 await page.evaluate(()=>{window.failVoteWrites=1;});
 await page.getByRole('button',{name:'Join case',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Waiting to start',exact:true})).toBeVisible();
 // The failure really happened (the handoff to Play is a new document, so the count lives in sessionStorage).
 expect(await page.evaluate(()=>sessionStorage.getItem('test:failedVoteWrites'))).toBe('1');
});
