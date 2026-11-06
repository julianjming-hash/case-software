import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareParticipantPreservation} from '../src/client/account-session.mjs';
import {assertKnownStorageKeys,TEARDOWN_KEYS} from '../src/client/teardown.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
import {storageGeneration,advanceStorageGeneration,STORAGE_FENCE_KEY} from '../src/client/storage-generation.mjs';
import {validateParticipantRecovery,participantRoomInventory,validateRoomRows,expiredRoomUpdate} from '../src/client/storage-policy.mjs';
const storage=entries=>{const values=new Map(Object.entries(entries));return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
function fixture(legacy,replace){
 const now=Date.now(),roomId=uuidv7(),otherRoom=uuidv7(),owner=uuidv7(),replacementOwner=uuidv7(),otherOwner=uuidv7();
 const expired={sessionId:roomId,token:'a'.repeat(32),expiresAt:now-1},replacement={sessionId:roomId,token:'b'.repeat(32),expiresAt:now+60000},other={sessionId:otherRoom,token:'c'.repeat(32),expiresAt:now+60000};
 const scopedKey=`case:participant:${roomId}:token`,oldKey=legacy?'case:participant:main:token':scopedKey,otherKey=`case:participant:${otherRoom}:token`;
 const localStorage=storage({[oldKey]:JSON.stringify(expired),[otherKey]:JSON.stringify(other)});
 const row=(scope,participantId,text)=>({roomId:scope,participantId,superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text}}});
 const fresh=row(roomId,replacementOwner,'replacement own answer'),untouched=row(otherRoom,otherOwner,'another saved room own answer');
 let rows=[row(roomId,owner,'expired answer'),untouched],updates=0;
 const openStore=()=>({readAll:async inspect=>{const valid=inspect(rows);assert.equal(valid,true);return valid;},update:async(scope,change)=>{
  updates++;if(replace){localStorage.removeItem(oldKey);localStorage.setItem(scopedKey,JSON.stringify(replacement));rows=[fresh,untouched];}
  const next=change(rows.filter(item=>item.roomId===scope));rows=[...rows.filter(item=>item.roomId!==scope),...next.rows];next.afterCommit?.();return next.result;
 },close:async()=>{}});
 const run=()=>prepareParticipantPreservation({localStorage,sessionStorage:storage({}),openStore,assertKnownStorageKeys,knownDatabases:TEARDOWN_KEYS.knownDatabases,indexedDB:{databases:async()=>[{name:'case:phone-outbox'}]}});
 return {run,localStorage,oldKey,scopedKey,otherKey,replacement,other,fresh,untouched,roomId,rows:()=>rows,updates:()=>updates};
}
for(const legacy of [true,false])test(`common-role expiry cleanup preserves a valid same-room replacement after ${legacy?'legacy removal':'scoped replacement'}`,async()=>{
 const f=fixture(legacy,true),plan=await f.run();assert.equal(plan.status,'known');assert.equal(f.updates(),1);
 assert.equal(f.localStorage.getItem(f.scopedKey),JSON.stringify(f.replacement));assert.equal(f.localStorage.getItem(f.otherKey),JSON.stringify(f.other));
 assert.deepEqual(f.rows().filter(row=>row.roomId===f.roomId),[f.fresh]);assert.deepEqual(f.rows().filter(row=>row.roomId!==f.roomId),[f.untouched]);
 assert.equal(plan.keepCurrent(f.scopedKey,f.localStorage.getItem(f.scopedKey)),true);
});
test('common-role expiry cleanup still removes the exact expired owner and preserves another valid room',async()=>{
 const f=fixture(true,false),plan=await f.run();assert.equal(plan.status,'known');assert.equal(f.updates(),1);
 assert.equal(f.localStorage.getItem(f.oldKey),null);assert.equal(f.localStorage.getItem(f.otherKey),JSON.stringify(f.other));assert.deepEqual(f.rows(),[f.untouched]);
});

test('generation accepts only canonical safe decimal integers and never wraps an exhausted fence',()=>{
 for(const value of ['0','1','123456789','9007199254740991'])assert.equal(storageGeneration(storage({[STORAGE_FENCE_KEY]:value})),Number(value));
 for(const value of ['','00','01','+1','-1','1.0','1e3',' 1','1 ','9007199254740992','10000000000000000','NaN','Infinity'])assert.throws(()=>storageGeneration(storage({[STORAGE_FENCE_KEY]:value})),/Invalid storage generation/);
 const exhausted=storage({[STORAGE_FENCE_KEY]:'9007199254740991'});assert.throws(()=>advanceStorageGeneration(exhausted),/exhausted/);assert.equal(exhausted.getItem(STORAGE_FENCE_KEY),'9007199254740991');
 const fresh=storage({});assert.equal(storageGeneration(fresh),0);advanceStorageGeneration(fresh);assert.equal(storageGeneration(fresh),1);
});
test('factored policy still rejects missing or unknown row fields, nonvote payloads and multiple participant owners',()=>{
 const now=Date.now(),roomId=uuidv7(),credential={sessionId:roomId,token:'x'.repeat(32),expiresAt:now+60000};
 const row={roomId,participantId:uuidv7(),superseded:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'owned answer'}}};
 const state={role:'participant',sessionId:roomId,credential,now,knownInventory:true};
 for(const admitted of [undefined,false,true]){const valid={...row,...(admitted===undefined?{}:{admitted})};assert.equal(validateParticipantRecovery({...state,rows:[valid]}).preserve,true);
  for(const field of Object.keys(row)){const invalid={...valid};delete invalid[field];assert.equal(validateParticipantRecovery({...state,rows:[invalid]}).preserve,false,field);}
  assert.equal(validateParticipantRecovery({...state,rows:[{...valid,unknown:'private'}]}).preserve,false);
 }
 for(const type of ['profile','advance','undo','snapshot',null,undefined])assert.equal(validateParticipantRecovery({...state,rows:[{...row,envelope:{...row.envelope,type}}]}).preserve,false);
 assert.equal(validateParticipantRecovery({...state,rows:[row,{...row,envelope:{...row.envelope,clientEventId:uuidv7()},participantId:uuidv7()}]}).preserve,false);
 const nonV7='00000000-0000-4000-8000-000000000000';
 for(const invalid of [{...row,participantId:nonV7},{...row,envelope:{...row.envelope,clientEventId:nonV7}},{...row,envelope:{...row.envelope,roundId:nonV7}},
  {...row,envelope:{...row.envelope,response:{text:'owned',private:'foreign'}}}, {...row,envelope:{...row.envelope,v:2}}])assert.equal(validateParticipantRecovery({...state,rows:[invalid]}).preserve,false);
 assert.equal(validateParticipantRecovery({...state,rows:[row,{...row}]}).preserve,false,'duplicate identity cannot be replayed as a second row');
 assert.deepEqual(validateParticipantRecovery({...state,rows:[row,{...row,superseded:true,envelope:{...row.envelope,clientEventId:uuidv7()}}]}),{preserve:true,count:1});
 const inventory=participantRoomInventory(storage({[`case:participant:${roomId}:token`]:JSON.stringify(credential)}),now);
 assert.equal(validateRoomRows([row,{...row,envelope:{...row.envelope,clientEventId:uuidv7()},participantId:uuidv7()}],inventory,now),false);
});

test('expiry update snapshots the old token and expiry before its queued transaction runs',()=>{
 const now=Date.now(),roomId=uuidv7(),key=`case:participant:${roomId}:token`;
 const captured={sessionId:roomId,token:'a'.repeat(32),expiresAt:now-10},replacement={sessionId:roomId,token:'b'.repeat(32),expiresAt:now-5};
 const store=storage({[key]:JSON.stringify(replacement)}),rows=[{roomId,participantId:uuidv7(),superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'replacement own answer'}}}];
 const update=expiredRoomUpdate(store,roomId,{credential:captured},()=>now);
 captured.token=replacement.token;captured.expiresAt=replacement.expiresAt;
 const result=update(rows);assert.equal(result.rows,rows);assert.equal(result.afterCommit,undefined);assert.equal(store.getItem(key),JSON.stringify(replacement));
});
