import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneTerminal } from '../src/client/phone-terminal.mjs';

test('phone terminal state fences private work and waits for common storage cleanup before public status',async()=>{
 const events=[];let finish;
 const terminal=createPhoneTerminal({cleanup:reason=>{events.push(['wipe',reason]);return new Promise(resolve=>{finish=resolve;});},
  show:(reason,complete)=>events.push(['public',reason,complete]),active:()=>true});
 const job=terminal('removed');assert.deepEqual(events,[['wipe','token_loss']]);
 assert.equal(terminal('unauthorised'),job);finish({complete:true});await job;
 assert.deepEqual(events,[['wipe','token_loss'],['public','removed',true]]);
});

test('terminal phone cleanup failure reveals no private error and pagehide suppresses late public DOM',async()=>{
 for(const hide of [false,true]){
  let active=true,fail;const events=[];
  const terminal=createPhoneTerminal({cleanup:()=>new Promise((_,reject)=>{fail=reject;}),active:()=>active,
   show:(reason,complete)=>events.push({reason,complete})});
  const job=terminal('recap_expiry');if(hide)active=false;fail(Error('private answer/token'));await job;
  assert.deepEqual(events,hide?[]:[{reason:'recap_expiry',complete:false}]);
 }
});

test('terminal Retry rechecks cleanup after unavailable storage instead of caching failure', async () => {
 const calls=[];let attempts=0;
 const terminal=createPhoneTerminal({cleanup:async reason=>{calls.push(reason);return {complete:++attempts>1};},active:()=>true,show:(reason,complete)=>calls.push(complete)});
 await terminal('recap_expiry');await terminal('recap_expiry');
 assert.deepEqual(calls,['recap_expiry',false,'recap_expiry',true]);
});
