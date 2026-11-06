import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeardown} from '../src/client/teardown.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
const storage=entries=>{const map=new Map(Object.entries(entries));return {get length(){return map.size;},key:i=>[...map.keys()][i],getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};
function fixture(invalid=false,legacy=false){
 const sessionId=uuidv7(),key=legacy?'case:participant:main:token':`case:participant:${sessionId}:token`,credential={sessionId,token:'x'.repeat(32),expiresAt:Date.now()+60000};
 const localStorage=storage({[key]:JSON.stringify(credential),'case:auth:refresh':'account'}),sessionStorage=storage({'case:display:main:token':'private display token'});
 const row={roomId:sessionId,participantId:uuidv7(),superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'private participant answer'}}};
 const data=new Map([[row.envelope.clientEventId,invalid?{...row,extra:'unlisted'}:row]]),deleted=[];
 const names=value=>({length:1,contains:name=>name===value});
 const db={objectStoreNames:names('votes'),close(){},transaction(){let pending=0;const tx={};const request=read=>{const r={};pending++;queueMicrotask(()=>{r.result=read();r.onsuccess?.();pending--;queueMicrotask(()=>{if(!pending)tx.oncomplete?.();});});return r;};tx.objectStore=()=>({keyPath:'envelope.clientEventId',indexNames:names('roomId'),index:()=>({keyPath:'roomId',getAll:room=>request(()=>[...data.values()].filter(row=>row.roomId===room))}),getAll:()=>request(()=>[...data.values()]),delete:id=>request(()=>data.delete(id)),put:row=>request(()=>data.set(row.envelope.clientEventId,row))});return tx;}};
 const indexedDB={databases:async()=>[{name:'case:phone-outbox'}],open(){const r={};queueMicrotask(()=>{r.result=db;r.onsuccess?.();});return r;},deleteDatabase(name){deleted.push(name);const r={};queueMicrotask(()=>r.onsuccess?.());return r;}};
 return {localStorage,sessionStorage,indexedDB,key,credential,row,data,deleted};
}
test('ordinary facilitator library and display teardown preserve another exact participant room and durable answer',async()=>{
 for(const reason of ['next_load','pagehide','room_end']){
  const f=fixture(),memory=[];const cleanup=createTeardown({...f,caches:null,clearMemory:()=>memory.push('cleared')});const pending=cleanup(reason);assert.deepEqual(memory,['cleared']);
  assert.deepEqual(await pending,{complete:true});assert.equal(f.localStorage.getItem(f.key),JSON.stringify(f.credential));assert.equal(f.localStorage.getItem('case:auth:refresh'),'account');assert.equal(f.sessionStorage.getItem('case:display:main:token'),null);assert.deepEqual([...f.data.values()],[f.row]);assert.deepEqual(f.deleted,[]);
 }
});
test('common-role preservation never exempts unknown durable fields or origin security cleanup',async()=>{
 for(const [reason,invalid] of [['next_load',true],['sign_out',false],['account_changed',false]]){
  const f=fixture(invalid);assert.deepEqual(await createTeardown({...f,caches:null})(reason),{complete:true});assert.equal(f.localStorage.getItem(f.key),null);assert.deepEqual(f.deleted,['case:phone-outbox']);
  assert.equal(f.localStorage.getItem('case:auth:refresh'),reason==='next_load'?'account':null);
 }
});

test('ordinary navigation preserves strictly validated legacy rooms before phone upgrade and purges malformed legacy',async()=>{
 const f=fixture(false,true);assert.deepEqual(await createTeardown({...f,caches:null})('next_load'),{complete:true});assert.equal(f.localStorage.getItem(f.key),JSON.stringify(f.credential));assert.deepEqual([...f.data.values()],[f.row]);assert.deepEqual(f.deleted,[]);
 const bad=fixture(false,true);bad.localStorage.setItem(bad.key,JSON.stringify({...bad.credential,unlisted:'private'}));assert.deepEqual(await createTeardown({...bad,caches:null})('pagehide'),{complete:true});assert.equal(bad.localStorage.getItem(bad.key),null);assert.deepEqual(bad.deleted,['case:phone-outbox']);assert.equal(bad.localStorage.getItem('case:auth:refresh'),'account');
});
