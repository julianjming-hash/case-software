import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminPolling} from '../src/client/admin-polling.mjs';
test('Card21b ten-minute inactivity pauses only polling and explicit activity resumes one fresh read',async()=>{
 let now=0,scheduled,reads=0;const notices=[];
 const poll=createAdminPolling({now:()=>now,refresh:async()=>{reads++;},schedule:fn=>(scheduled=fn,1),cancel:()=>{},onPause:value=>notices.push(value)});
 poll.start();now=600001;await scheduled();assert.equal(reads,0);assert.equal(poll.paused(),true);assert.deepEqual(notices,[true]);
 await poll.activity();assert.equal(reads,1);assert.equal(poll.paused(),false);assert.deepEqual(notices,[true,false]);poll.close();
});
test('Card21b polling is single-flight and close fences queued timers without invoking authentication or mutation',async()=>{
 let scheduled,resolve,reads=0;const poll=createAdminPolling({now:()=>0,refresh:()=>{reads++;return new Promise(done=>resolve=done);},schedule:fn=>(scheduled=fn,1),cancel:()=>{}});
 poll.start();const timer=scheduled;const first=timer();const second=timer();assert.equal(reads,1);poll.close();resolve();await first;await second;const late=timer();assert.equal(reads,1);await late;
});
