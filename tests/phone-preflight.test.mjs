import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverJoinCapability } from '../src/client/phone-recovery.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
const credential=()=>({sessionId:uuidv7(),token:'x'.repeat(32),expiresAt:Date.now()+60_000});
test('phone QR recovery sends only code and saved room with bearer capability and accepts only that room',async()=>{
 const c=credential();let calls=0;
 const fetch=async(url,options)=>{calls++;assert.equal(url,'/api/v1/join/recover');assert.equal(options.headers.authorization,'Bearer '+c.token);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.deepEqual(JSON.parse(options.body),{code:'ABCDEF',sessionId:c.sessionId});return Response.json({sessionId:c.sessionId});};
 assert.deepEqual(await recoverJoinCapability({code:'ab-cdef',credential:c,fetch}),{status:'recovered',sessionId:c.sessionId});assert.equal(calls,1);
 assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>Response.json({sessionId:uuidv7()})}),{status:'refused'});
 assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>Response.json({sessionId:c.sessionId,token:'private'})}),{status:'refused'});
});
test('phone recovery refuses invalid capabilities while transient failures and stalled bodies cannot resume another room',async()=>{
 const c=credential();let calls=0;
 assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:{...c,expiresAt:0},fetch:async()=>{calls++;}}),{status:'refused'});assert.equal(calls,0);
 for(const status of [401,403,404,410])assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>new Response('',{status})}),{status:'refused'});
 for(const status of [302,307,503])assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>new Response('',{status,headers:{location:'https://external.invalid/capability'}})}),{status:'unavailable'});
 let rejectedBodyCancelled=false;
 assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>new Response(new ReadableStream({cancel(){rejectedBodyCancelled=true;return new Promise(()=>{});}}),{status:503})}),{status:'unavailable'});assert.equal(rejectedBodyCancelled,true);
 let aborted=false,cancelled=false;
 const fetch=async(_url,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}}));};
 assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch,timeoutMs:10}),{status:'unavailable'});assert.equal(aborted,true);assert.equal(cancelled,true);
 let resolveFetch,lateCancelled=false;
 const late=await recoverJoinCapability({code:'ABCDEF',credential:c,timeoutMs:10,fetch:()=>new Promise(resolve=>resolveFetch=resolve)});assert.deepEqual(late,{status:'unavailable'});
 resolveFetch(new Response(new ReadableStream({cancel(){lateCancelled=true;}})));await new Promise(resolve=>setImmediate(resolve));assert.equal(lateCancelled,true);
});

test('only an exact bounded code mismatch refusal preserves a foreign room; wrong-role refusal is definitive',async()=>{
 const c={sessionId:uuidv7(),token:'x'.repeat(32),expiresAt:Date.now()+60000};
 assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>Response.json({error:'code_mismatch'},{status:403})}),{status:'foreign'});
 for(const body of [{error:'forbidden'},{error:'code_mismatch',extra:'unlisted'}])assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>Response.json(body,{status:403})}),{status:'refused'});
});

test('malformed or truncated successful recovery is unavailable while malformed forbidden remains definitive',async()=>{
 const c=credential();
 for(const body of ['not JSON','{"sessionId":']){
  assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>new Response(body,{status:200,headers:{'content-type':'application/json'}})}),{status:'unavailable'});
  assert.deepEqual(await recoverJoinCapability({code:'ABCDEF',credential:c,fetch:async()=>new Response(body,{status:403,headers:{'content-type':'application/json'}})}),{status:'refused'});
 }
});
