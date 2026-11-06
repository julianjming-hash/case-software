import test from 'node:test';
import assert from 'node:assert/strict';
import { connect,testLifecycle,credentialKey } from '../src/client/transport.mjs';
import { uuidv7,newCapabilityToken } from '../src/shared/ids.mjs';

test('closing an actual participant transport drops private memory while leaving its approved stored capability unchanged',async()=>{
 const room=uuidv7(),owner=uuidv7(),token=newCapabilityToken(),rows=new Map(),store={get length(){return rows.size;},key:i=>[...rows.keys()][i],getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};
 const snapshot={v:1,t:'snapshot',epoch:0,revision:1,displayRevision:0,view:{role:'participant',sessionId:room,you:{id:owner,name:'fixture-private-name'}}};
 class Socket {
  callbacks=new Map();constructor(){queueMicrotask(()=>this.fire('open'));}
  addEventListener(kind,fn){this.callbacks.set(kind,fn);}fire(kind,data){this.callbacks.get(kind)?.({data});}
  send(text){if(JSON.parse(text).t==='hello')queueMicrotask(()=>{this.fire('message',JSON.stringify({v:1,t:'welcome'}));this.fire('message',JSON.stringify(snapshot));});}
  close(){this.fire('close');}
 }
 const link=connect({role:'participant',api:'https://case.test',sessionId:room,token,storage:null,persistentStorage:store,lifecycle:testLifecycle(),WebSocketImpl:Socket,telemetryImpl:()=>{},fetchImpl:async()=>Response.json(snapshot)});
 try {
  await new Promise(resolve=>link.on('snapshot',resolve));const saved=store.getItem(credentialKey('participant'));
  assert.equal(link.snapshot.view.you.name,'fixture-private-name');assert.equal(link.participantId,owner);assert.equal(link.hasToken,true);
  link.close();assert.equal(link.hasToken,false);assert.equal(link.snapshot,null);assert.equal(link.participantId,null);assert.equal(link.casePack,null);
  assert.equal(store.getItem(credentialKey('participant')),saved);
 } finally {link.close();}
});

const memoryStore=()=>{const rows=new Map();return {get length(){return rows.size;},key:i=>[...rows.keys()][i],getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};};
class IdleSocket {addEventListener(){}close(){}}
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};};
const base=()=>({role:'participant',api:'https://case.test',sessionId:uuidv7(),token:newCapabilityToken(),storage:null,persistentStorage:memoryStore(),lifecycle:testLifecycle(),WebSocketImpl:IdleSocket,telemetryImpl:()=>{},timings:{RETRY_MS:1}});

test('closed transport refuses held HTTP snapshot and explicit adopt without restoring private memory',async()=>{
 const options=base(),body=deferred(),entered=deferred();
 const link=connect({...options,fetchImpl:async()=>{entered.resolve();return {status:200,json:()=>body.promise};}});
 const pending=link.refetch();await entered.promise;const saved=options.persistentStorage.getItem(credentialKey('participant'));
 link.close();body.resolve({v:1,t:'snapshot',epoch:0,revision:1,displayRevision:0,view:{you:{id:uuidv7(),name:'Private'}}});await pending;
 assert.equal(link.snapshot,null);assert.equal(link.participantId,null);
 link.adopt(uuidv7(),newCapabilityToken());assert.equal(link.hasToken,false);assert.equal(options.persistentStorage.getItem(credentialKey('participant')),saved);
});

test('closed facilitator transport refuses a held case-pack response and emits no private pack callback',async()=>{
 const body=deferred(),entered=deferred();let delivered=0;
 class WelcomeSocket {callbacks=new Map();constructor(){queueMicrotask(()=>this.callbacks.get('open')?.({}));}addEventListener(kind,fn){this.callbacks.set(kind,fn);}send(text){if(JSON.parse(text).t==='hello')queueMicrotask(()=>this.callbacks.get('message')?.({data:JSON.stringify({v:1,t:'welcome'})}));}close(){}}
 const link=connect({...base(),role:'facilitator',WebSocketImpl:WelcomeSocket,fetchImpl:async()=>{entered.resolve();return {status:200,json:()=>body.promise};}});
 link.on('case_pack',()=>delivered++);await entered.promise;link.close();body.resolve({caseDoc:{title:'Private pack'}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(link.casePack,null);assert.equal(delivered,0);assert.equal(link.hasToken,false);
});

test('closing during join never overwrites a newer stored capability or adopts the late identity',async()=>{
 const options=base(),body=deferred(),entered=deferred();
 const link=connect({...options,token:null,sessionId:null,fetchImpl:async()=>{entered.resolve();return {status:201,json:()=>body.promise};}});
 const pending=link.join('ABCDEF','Private name','shadows-01');await entered.promise;link.close();
 const saved=JSON.stringify({sessionId:uuidv7(),token:newCapabilityToken(),expiresAt:Date.now()+60_000});options.persistentStorage.setItem(credentialKey('participant'),saved);
 body.resolve({sessionId:uuidv7(),token:newCapabilityToken(),participantId:uuidv7()});const result=await pending;
 assert.equal(result.ok,false);assert.equal(link.hasToken,false);assert.equal(link.participantId,null);assert.equal(options.persistentStorage.getItem(credentialKey('participant')),saved);
});

test('closed transport ignores held 401 and resolves queued private commands without deleting a newer credential',async()=>{
 const options=base(),body=deferred(),entered=deferred();
 const link=connect({...options,fetchImpl:async()=>{entered.resolve();return {status:401,json:()=>body.promise};}});
 const pending=link.send('vote',{roundId:uuidv7(),response:{text:'Private answer'}});await entered.promise;link.close();
 const saved=JSON.stringify({sessionId:uuidv7(),token:newCapabilityToken(),expiresAt:Date.now()+60_000});options.persistentStorage.setItem(credentialKey('participant'),saved);
 body.resolve({error:'unauthorised'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(link.pendingCount,0);assert.equal((await pending).receipt,'dropped');assert.equal(options.persistentStorage.getItem(credentialKey('participant')),saved);
});

test('fenced participant refusal drops private memory and retains exact persisted ownership until coordinated cleanup',async()=>{
 const options=base(),fence={valid:()=>true,commit:async write=>write(),watch:()=>()=>{}};
 const link=connect({...options,credentialFence:fence,fetchImpl:async()=>Response.json({error:'unauthorised'},{status:401})});
 try{assert.equal(await link.credentialReady,true);const key=credentialKey('participant',options.sessionId),saved=options.persistentStorage.getItem(key);assert.ok(saved);await link.refetch();assert.equal(link.hasToken,false);assert.equal(options.persistentStorage.getItem(key),saved);}finally{link.close();}
});
test('credential readiness reports refused writes instead of declaring missing durable storage ready',async()=>{
 const options=base(),fence={valid:()=>true,commit:async write=>write(),watch:()=>()=>{}};
 const link=connect({...options,persistentStorage:{getItem:()=>null,setItem(){throw Error('local denied');}},credentialFence:fence,fetchImpl:async()=>Response.json({})});
 try{assert.equal(await link.credentialReady,false);}finally{link.close();}
});
