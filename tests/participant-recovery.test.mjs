import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverParticipant } from '../src/worker/participant-recovery.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
const request = (body, token = 'x'.repeat(32)) => new Request('http://local.test/api/v1/join/recover', {method:'POST', headers:{authorization:`Bearer ${token}`}, body:JSON.stringify(body)});
function fixture() {
  const sessionId = uuidv7(), calls = [];
  return {sessionId,calls, options:{ lookup:async () => ({sessionId}), blocked:async()=>false, failed:async()=>calls.push('failed'), attempt:async()=>false,
    recover:async (id,token,code)=> {calls.push({id,token,code});return {sessionId:id};} }};
}
test('recovery binds the normalized code to the saved room without minting or exposing participant data',async()=>{
 const f=fixture(); const res=await recoverParticipant(request({code:'ab-cdef',sessionId:f.sessionId}),f.options);
 assert.equal(res.status,200);assert.deepEqual(await res.json(),{sessionId:f.sessionId});assert.deepEqual(f.calls,[{id:f.sessionId,token:'x'.repeat(32),code:'ABCDEF'}]);
 f.options.lookup=async()=>({error:'unknown_code'});
 assert.equal((await recoverParticipant(request({code:'ABCDEF',sessionId:f.sessionId}),f.options)).status,200);
});
test('recovery rejects reused codes and malformed old sessions before touching a room and preserves unavailable failures',async()=>{
 const f=fixture();f.options.lookup=async()=>({sessionId:uuidv7()});
 assert.equal((await recoverParticipant(request({code:'ABCDEF',sessionId:f.sessionId}),f.options)).status,403);assert.deepEqual(f.calls,['failed']);
 for(const body of [{code:'ABCDEF',sessionId:'nope'},{code:'ABCDEF',sessionId:f.sessionId,token:'private'}])assert.equal((await recoverParticipant(request(body),f.options)).status,400);
 f.options.lookup=async()=>{throw Error('backend secret');};const res=await recoverParticipant(request({code:'ABCDEF',sessionId:f.sessionId}),f.options);
 assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'unavailable'});assert.deepEqual(f.calls,['failed']);
});
test('recovery caps streamed bytes and its whole-body deadline without awaiting stalled cancellation',async()=>{
 const f=fixture(); const huge=await recoverParticipant(request({code:'ABCDEF',sessionId:f.sessionId,padding:'x'.repeat(1024)}),f.options);assert.equal(huge.status,413);
 let cancelled=false;
 const stalled=new Request('http://local.test/api/v1/join/recover',{method:'POST',headers:{authorization:'Bearer '+ 'x'.repeat(32)},duplex:'half',body:new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}})});
 const res=await recoverParticipant(stalled,{...f.options,bodyTimeoutMs:10});assert.equal(res.status,408);assert.equal(cancelled,true);assert.deepEqual(f.calls,[]);
});
