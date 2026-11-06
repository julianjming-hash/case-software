import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { createPhoneCleanup } from '../src/client/phone-cleanup.mjs';
const storage=entries=>{const map=new Map(Object.entries(entries));return {get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};};
function fixture(change={}) {
 const now=Date.now(),credential={sessionId:uuidv7(),token:'x'.repeat(32),expiresAt:now+60000};
 const sessionStorage=storage({'case:auth:refresh':'private','case:phone:join-code-draft':'ABCDEF'}),localStorage=storage({'case:participant:main:token':JSON.stringify(credential),'case:auth:refresh':'private','case:transport:pin':'pin'});
 const deleted=[],events=[];const indexedDB={databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase:name=>{deleted.push(name);const request={};queueMicrotask(()=>request.onsuccess());return request;}};
 const selected={role:'participant',participantId:uuidv7(),sessionId:credential.sessionId,credential,knownInventory:true,queueValidated:true,...change};
 const cleanup=createPhoneCleanup({selection:()=>selected,sessionStorage,localStorage,indexedDB,openStore:()=>({readAll:async inspect=>inspect?inspect([]):[],update:async(id,change)=>{change([]).afterCommit?.();},close:async()=>{}}),caches:{keys:async()=>[]},now:()=>now,clearMemory:()=>events.push('memory')});
 return {cleanup,credential,sessionStorage,localStorage,indexedDB,deleted,events};
}
test('actual common cleanup preserves only validated participant capability and queue on navigation',async()=>{
 for(const reason of ['pagehide','next_load']){
  const f=fixture();const pending=f.cleanup(reason);assert.deepEqual(f.events,['memory']);
  assert.deepEqual(await pending,{complete:true});
  assert.equal(f.localStorage.getItem(`case:participant:${f.credential.sessionId}:token`),JSON.stringify(f.credential));assert.equal(f.localStorage.getItem('case:participant:main:token'),null);assert.deepEqual(f.deleted,[]);
  // Card 38 (CASE-175): a participant page never ends the facilitator account session on the same device.
  assert.equal(f.localStorage.getItem('case:auth:refresh'),'private');assert.equal(f.sessionStorage.getItem('case:phone:join-code-draft'),null);
 }
});
test('origin security wipes participant state and proven room loss preserves unrelated valid rooms',async()=>{
 for(const reason of ['sign_out','unauthorised','account_change','token_loss','recap_expiry']){
  const f=fixture();assert.deepEqual(await f.cleanup(reason),{complete:true});assert.equal(f.localStorage.getItem('case:participant:main:token'),null);assert.deepEqual(f.deleted,reason==='sign_out'||reason==='account_change'?['case:phone-outbox']:[]);
 }
 for(const change of [{role:'display'}]){
  const f=fixture(change);assert.deepEqual(await f.cleanup('pagehide'),{complete:false});assert.deepEqual(f.events,['memory']);assert.equal(f.localStorage.getItem('case:participant:main:token'),JSON.stringify(f.credential));assert.deepEqual(f.deleted,[]); // Unavailable owner-row validation keeps private storage fenced.
 }
 for(const change of [{sessionId:uuidv7()},{knownInventory:false},{queueValidated:false},{credential:{sessionId:uuidv7(),token:'x'.repeat(32),expiresAt:0}}]){
  const f=fixture(change);await f.cleanup('pagehide');assert.equal(f.localStorage.getItem('case:participant:main:token'),JSON.stringify(f.credential));assert.deepEqual(f.deleted,[]);
 }
});
test('privacy return retains an exact public code and a separately validated saved room; malformed drafts are cleared',async()=>{
 for(const code of ['ABCDEF','abcdef','ABCDE!','ABCDEFG']){
  const f=fixture(),roomId=f.credential.sessionId,key=`case:participant:${roomId}:token`;
  f.localStorage.removeItem('case:participant:main:token');f.localStorage.setItem(key,JSON.stringify(f.credential));f.sessionStorage.setItem('case:phone:join-code-draft',code);
  let rows=[{roomId,participantId:uuidv7(),superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'another room own answer'}}}];
  const original=structuredClone(rows);
  const cleanup=createPhoneCleanup({privacyReturn:()=>true,selection:()=>null,sessionStorage:f.sessionStorage,localStorage:f.localStorage,indexedDB:f.indexedDB,caches:{keys:async()=>[]},clearMemory:()=>f.events.push('memory'),
   openStore:()=>({readAll:async inspect=>inspect(rows),update:async(id,change)=>{const next=change(rows);rows=next.rows;next.afterCommit?.();},close:async()=>{}})});
  assert.deepEqual(await cleanup('pagehide'),{complete:true},code);assert.deepEqual(f.events,['memory']);
  assert.equal(f.sessionStorage.getItem('case:phone:join-code-draft'),code==='ABCDEF'?code:null);assert.equal(f.localStorage.getItem(key),JSON.stringify(f.credential));assert.deepEqual(rows,original);assert.deepEqual(f.deleted,[]);
  assert.deepEqual(await cleanup('sign_out'),{complete:true});assert.equal(f.sessionStorage.getItem('case:phone:join-code-draft'),null);assert.equal(f.localStorage.getItem(key),null);assert.deepEqual(f.deleted,['case:phone-outbox']);
 }
});

test('two valid room tabs retain exact ownership and durable answers on new-room navigation and old pagehide',async()=>{
 const now=Date.now(),rooms=[uuidv7(),uuidv7()],owners=[uuidv7(),uuidv7()];
 const credentials=rooms.map((sessionId,i)=>({sessionId,token:String(i+1).repeat(32),expiresAt:now+60_000}));
 const keys=rooms.map(id=>`case:participant:${id}:token`);
 const localStorage=storage(Object.fromEntries(keys.map((key,i)=>[key,JSON.stringify(credentials[i])])));
 localStorage.setItem('case:auth:refresh','account');
 let rows=rooms.map((roomId,i)=>({roomId,participantId:owners[i],superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:1,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:`answer ${i}`}}}));
 const deleted=[];const indexedDB={databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(name){deleted.push(name);throw Error('room cleanup must not delete shared database');}};
 const openStore=()=>({readAll:async inspect=>inspect?inspect(structuredClone(rows)):structuredClone(rows),update:async(roomId,change)=>{const next=change(rows.filter(row=>row.roomId===roomId));rows=[...rows.filter(row=>row.roomId!==roomId),...next.rows];next.afterCommit?.();return next.result;},close:async()=>{}});
 const create=i=>createPhoneCleanup({selection:()=>({role:'participant',sessionId:rooms[i],participantId:owners[i],credential:credentials[i],knownInventory:true,queueValidated:true}),localStorage,sessionStorage:storage({}),indexedDB,openStore,caches:{keys:async()=>[]},now:()=>now});
 assert.deepEqual(await create(1)('next_load'),{complete:true});assert.deepEqual(await create(0)('pagehide'),{complete:true});
 assert.equal(rows.length,2);for(let i=0;i<2;i++)assert.equal(localStorage.getItem(keys[i]),JSON.stringify(credentials[i]));
 assert.deepEqual(await create(0)('token_loss'),{complete:true});
 assert.equal(localStorage.getItem(keys[0]),null);assert.equal(localStorage.getItem(keys[1]),JSON.stringify(credentials[1]));
 assert.deepEqual(rows.map(row=>row.roomId),[rooms[1]]);assert.deepEqual(deleted,[]);assert.equal(localStorage.getItem('case:auth:refresh'),'account');
});

test('unavailable inventory does not erase a valid capability and never reports clean readiness',async()=>{
 const f=fixture();let enumerations=0;
 const cleanup=createPhoneCleanup({selection:()=>({role:'participant',sessionId:f.credential.sessionId,credential:f.credential,knownInventory:true,queueValidated:true}),localStorage:f.localStorage,sessionStorage:f.sessionStorage,caches:null,indexedDB:{databases:async()=>{enumerations++;throw Error('temporarily unavailable');}},openStore:()=>{throw Error('must not open unknown storage');}});
 assert.deepEqual(await cleanup('next_load'),{complete:false});assert.equal(f.localStorage.getItem('case:participant:main:token'),JSON.stringify(f.credential));
 assert.deepEqual(await cleanup('next_load'),{complete:false});assert.equal(enumerations,2);
});

test('mixed expired and valid room ownership removes only expired credentials and their exact durable rows',async()=>{
 const now=Date.now(),expiredRoom=uuidv7(),validRoom=uuidv7(),participantId=uuidv7();
 const expired={sessionId:expiredRoom,token:'a'.repeat(32),expiresAt:now-1},valid={sessionId:validRoom,token:'b'.repeat(32),expiresAt:now+60000};
 const expiredKey=`case:participant:${expiredRoom}:token`,validKey=`case:participant:${validRoom}:token`;
 const localStorage=storage({[expiredKey]:JSON.stringify(expired),[validKey]:JSON.stringify(valid)});
 let rows=[expiredRoom,validRoom].map(roomId=>({roomId,participantId,superseded:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'own'}}}));
 const openStore=()=>({readAll:async inspect=>inspect?inspect(rows):rows,update:async(id,change)=>{const next=change(rows.filter(row=>row.roomId===id));rows=[...rows.filter(row=>row.roomId!==id),...next.rows];next.afterCommit?.();},close:async()=>{}});
 const cleanup=createPhoneCleanup({localStorage,sessionStorage:storage({}),selection:()=>({role:'participant',sessionId:validRoom,credential:valid,participantId,knownInventory:true,queueValidated:true}),openStore,now:()=>now,caches:null,indexedDB:{databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(){throw Error('must not delete other valid room');}}});
 assert.deepEqual(await cleanup('next_load'),{complete:true});assert.equal(localStorage.getItem(expiredKey),null);assert.equal(localStorage.getItem(validKey),JSON.stringify(valid));assert.deepEqual(rows.map(row=>row.roomId),[validRoom]);
});

test('late old-owner room cleanup cannot remove a newer same-room token or that owner durable answer',async()=>{
 const now=Date.now(),sessionId=uuidv7(),oldOwner=uuidv7(),newOwner=uuidv7(),key=`case:participant:${sessionId}:token`;
 const old={sessionId,token:'a'.repeat(32),expiresAt:now+60000},current={...old,token:'b'.repeat(32)};
 const localStorage=storage({[key]:JSON.stringify(current)});let rows=[{roomId:sessionId,participantId:newOwner,superseded:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'new own'}}}];
 const cleanup=createPhoneCleanup({localStorage,sessionStorage:storage({}),selection:()=>({role:'participant',sessionId,credential:old,participantId:oldOwner,knownInventory:true,queueValidated:true}),openStore:()=>({readAll:async inspect=>inspect?inspect(rows):rows,update:async(id,change)=>{const next=change(rows);rows=next.rows;next.afterCommit?.();},close:async()=>{}}),now:()=>now,caches:null,indexedDB:{databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(){throw Error('must not delete new owner');}}});
 assert.deepEqual(await cleanup('token_loss'),{complete:true});assert.equal(localStorage.getItem(key),JSON.stringify(current));assert.equal(rows[0].participantId,newOwner);
});

test('temporarily unavailable owner-row validation retains the exact capability and offers a real later cleanup',async()=>{
 const f=fixture();let reads=0;
 const candidate={role:'participant',sessionId:f.credential.sessionId,participantId:uuidv7(),credential:f.credential,knownInventory:true,queueValidated:true};
 const cleanup=createPhoneCleanup({selection:()=>candidate,localStorage:f.localStorage,sessionStorage:f.sessionStorage,caches:null,indexedDB:{databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(){throw Error('room cleanup must never delete');}},openStore:()=>({readAll:async inspect=>{if(++reads===1)throw Error('temporary read unavailable');return inspect?inspect([]):[];},update:async(id,change)=>{change([]).afterCommit?.();},close:async()=>{}})});
 assert.deepEqual(await cleanup('token_loss'),{complete:false});assert.equal(f.localStorage.getItem('case:participant:main:token'),JSON.stringify(f.credential));
 assert.deepEqual(await cleanup('token_loss'),{complete:true});assert.equal(f.localStorage.getItem('case:participant:main:token'),null);assert.equal(reads,2);
});

test('a concurrent new room committed before locked owner validation survives old pagehide',async()=>{
 const f=fixture(),sessionId=uuidv7(),credential={sessionId,token:'b'.repeat(32),expiresAt:Date.now()+60000},key=`case:participant:${sessionId}:token`;
 const row={roomId:sessionId,participantId:uuidv7(),superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'new private draft'}}};
 const cleanup=createPhoneCleanup({selection:()=>({role:'participant',sessionId:f.credential.sessionId,credential:f.credential,knownInventory:true,queueValidated:true}),localStorage:f.localStorage,sessionStorage:f.sessionStorage,indexedDB:{databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(){throw Error('new room must survive');}},caches:null,openStore:()=>({readAll:async inspect=>{f.localStorage.setItem(key,JSON.stringify(credential));return inspect([row]);},update:async()=>{throw Error('no removal expected');},close:async()=>{}})});
 assert.deepEqual(await cleanup('pagehide'),{complete:true});assert.equal(f.localStorage.getItem(key),JSON.stringify(credential));assert.equal(row.envelope.response.text,'new private draft');
});

test('erasure-only denial cannot remove a concurrently upgraded replacement capability or its owner rows',async()=>{
 const f=fixture(),current={...f.credential,token:'b'.repeat(32)},key=`case:participant:${current.sessionId}:token`;
 let rows=[{roomId:current.sessionId,participantId:uuidv7(),superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'replacement own'}}}];
 const cleanup=createPhoneCleanup({selection:()=>({role:'participant',sessionId:f.credential.sessionId,credential:f.credential,knownInventory:true,queueValidated:true}),localStorage:f.localStorage,sessionStorage:f.sessionStorage,indexedDB:{databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(){throw Error('new owner must survive');}},caches:null,openStore:()=>({readAll:async inspect=>{f.localStorage.removeItem('case:participant:main:token');f.localStorage.setItem(key,JSON.stringify(current));return inspect(rows);},update:async(id,change)=>{const next=change(rows);rows=next.rows;next.afterCommit?.();},close:async()=>{}})});
 assert.deepEqual(await cleanup('token_loss',{provenInvalid:true}),{complete:true});assert.equal(f.localStorage.getItem(key),JSON.stringify(current));assert.equal(rows[0].envelope.response.text,'replacement own');
});

test('late expiry cleanup cannot erase valid same-room replacement rows after the captured legacy key disappears',async()=>{
 const now=Date.now(),expiredRoom=uuidv7(),otherRoom=uuidv7(),oldOwner=uuidv7(),newOwner=uuidv7(),otherOwner=uuidv7();
 const expired={sessionId:expiredRoom,token:'a'.repeat(32),expiresAt:now-1},replacement={sessionId:expiredRoom,token:'b'.repeat(32),expiresAt:now+60000},other={sessionId:otherRoom,token:'c'.repeat(32),expiresAt:now+60000};
 const oldKey='case:participant:main:token',newKey=`case:participant:${expiredRoom}:token`,otherKey=`case:participant:${otherRoom}:token`;
 const localStorage=storage({[oldKey]:JSON.stringify(expired),[otherKey]:JSON.stringify(other)});
 const row=(roomId,participantId,text)=>({roomId,participantId,superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text}}});
 const fresh=row(expiredRoom,newOwner,'replacement own answer'),untouched=row(otherRoom,otherOwner,'another room own answer');
 let rows=[row(expiredRoom,oldOwner,'expired old answer'),untouched];
 const openStore=()=>({readAll:async inspect=>{
  const valid=inspect(rows);assert.equal(valid,true);
  localStorage.removeItem(oldKey);localStorage.setItem(newKey,JSON.stringify(replacement));rows=[fresh,untouched];return valid;
 },update:async(roomId,change)=>{const next=change(rows.filter(item=>item.roomId===roomId));rows=[...rows.filter(item=>item.roomId!==roomId),...next.rows];next.afterCommit?.();},close:async()=>{}});
 const cleanup=createPhoneCleanup({selection:()=>({role:'participant',sessionId:otherRoom,credential:other,participantId:otherOwner,knownInventory:true,queueValidated:true}),localStorage,sessionStorage:storage({}),now:()=>now,openStore,caches:null,
  indexedDB:{databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(){throw Error('must not erase valid shared queue');}}});
 assert.deepEqual(await cleanup('pagehide'),{complete:true});assert.equal(localStorage.getItem(oldKey),null);
 assert.equal(localStorage.getItem(newKey),JSON.stringify(replacement));assert.equal(localStorage.getItem(otherKey),JSON.stringify(other));
 assert.deepEqual(rows.filter(item=>item.roomId===expiredRoom),[fresh]);assert.deepEqual(rows.filter(item=>item.roomId===otherRoom),[untouched]);
});
