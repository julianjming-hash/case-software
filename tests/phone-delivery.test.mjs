import test from 'node:test';
import assert from 'node:assert/strict';
import { settlePhoneDelivery } from '../src/client/phone-delivery.mjs';

test('failed phone flush retains unsent state and exposes only the fixed storage warning without unhandled rejection',async()=>{
 const pending={state:'sending',body:{response:{text:'private answer'}}}, events=[],unhandled=[];
 const listener=error=>unhandled.push(error);process.on('unhandledRejection',listener);
 try {
  await settlePhoneDelivery({flush:()=>Promise.reject(Error('private credential / secret answer')),current:()=>true,
   failed:()=>{pending.state='waiting';events.push('Answer storage unavailable · keep this page open');},settled:()=>events.push('refresh')});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(unhandled,[]);assert.equal(pending.state,'waiting');assert.equal(pending.body.response.text,'private answer');
  assert.deepEqual(events,['Answer storage unavailable · keep this page open','refresh']);
 } finally {process.removeListener('unhandledRejection',listener);}
});

test('phone delivery completion after disposal or supersession cannot resurrect warning or DOM',async()=>{
 for(const fail of [false,true]) {
  let resolve,reject,current=true;const events=[];
  const job=settlePhoneDelivery({flush:()=>new Promise((ok,no)=>{resolve=ok;reject=no;}),current:()=>current,
   failed:()=>events.push('warning'),settled:()=>events.push('DOM')});
  current=false;if(fail)reject(Error('private'));else resolve();await job;assert.deepEqual(events,[]);
 }
});

test('[AS-061] a receipt overtaking an outbox read cannot resurrect Sending or dispatch a completed vote',async()=>{
 const {restorePhoneVote}=await import('../src/client/phone-delivery.mjs');
 const envelope={clientEventId:'same-event',roundId:'same-round'};
 let release, accepted=null, restored=0;
 const read=new Promise(resolve=>{release=resolve;});
 const job=restorePhoneVote({read:()=>read,current:()=>true,accepted:()=>accepted,restore:()=>restored++});
 accepted={clientEventId:envelope.clientEventId}; release(envelope);
 assert.equal(await job,null,'receipt must invalidate the stale pending read');
 assert.equal(restored,0,'no Sending state or duplicate dispatch');
 const changed={...envelope,clientEventId:'new-answer'};
 assert.equal(await restorePhoneVote({read:async()=>changed,current:()=>true,accepted:()=>accepted,restore:()=>restored++}),changed);
 assert.equal(restored,1,'a newer answer still restores');
 assert.equal(await restorePhoneVote({read:async()=>changed,current:()=>false,accepted:()=>null,restore:()=>restored++}),null);
 assert.equal(restored,1,'disposed or changed view cannot restore');
});

test('[AS-061] an outbox read begun before any local answer/receipt change is discarded, including changed answers and non-accepted terminal receipts',async()=>{
 const {restorePhoneVote}=await import('../src/client/phone-delivery.mjs');
 const stale={clientEventId:'evt-1',roundId:'r'};
 // Changed answer: evt-1 accepted, evt-2 accepted, then the read that began at evt-1 returns.
 let version=0,accepted=null,restored=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const job=restorePhoneVote({read:()=>gate,current:()=>true,accepted:()=>accepted,version:()=>version,restore:()=>restored++});
 version++;accepted={clientEventId:'evt-1'};version++;accepted={clientEventId:'evt-2'};release(stale);
 assert.equal(await job,null);assert.equal(restored,0,'older answer must not overwrite a newer accepted one');
 // A terminal non-accepted receipt (locked/rejected) bumps the version without recording accepted.
 version=0;accepted=null;const gate2=new Promise(resolve=>{release=resolve;});
 const job2=restorePhoneVote({read:()=>gate2,current:()=>true,accepted:()=>accepted,version:()=>version,restore:()=>restored++});
 version++;release(stale);
 assert.equal(await job2,null);assert.equal(restored,0,'a read overtaken by a rejected/locked receipt cannot resurrect the row');
 // Unchanged version still restores.
 assert.equal(await restorePhoneVote({read:async()=>stale,current:()=>true,accepted:()=>null,version:()=>version,restore:()=>restored++}),stale);assert.equal(restored,1);
});

test('[AS-061] phone.mjs advances the answer version on every local pending/receipt change and passes it to restore',async()=>{
 const {readFile}=await import('node:fs/promises');
 const src=await readFile(new URL('../src/client/phone.mjs',import.meta.url),'utf8');
 assert.match(src,/version:\s*\(\)\s*=>\s*dec\.ver/);
 const onReceipt=src.slice(src.indexOf('function onReceipt('),src.indexOf('function reconcilePending('));
 assert.match(onReceipt.split('\n').slice(0,3).join('\n'),/dec\.ver\+\+/);
 assert.match(src.slice(src.indexOf('async function onSend()'),src.indexOf('function dispatchPending(')),/dec\.ver\+\+/);
 assert.match(src.slice(src.indexOf('function resetDecision()'),src.indexOf('const ok =')),/dec\.ver\+\+/);
});
