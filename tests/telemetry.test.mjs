import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTelemetry } from '../src/worker/telemetry.mjs';
const url='https://case.test/api/v1/telemetry';
function fixture(success=true) {
  const points=[],keys=[];
  return {points,keys,env:{CASE_ENV:'staging',BUILD_SHA:'a'.repeat(40),
    TELEMETRY_RATE_LIMITER:{limit:async input=>{keys.push(input);return {success};}},
    METRICS:{writeDataPoint:p=>points.push(p)},
    ALERTS:{idFromName(){throw new Error('client must never reach alerts');}}}};
}
function request(body,headers={}) {return new Request(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});}
test('telemetry admits only anonymous transport events and never sends an alert',async()=> {
  const run=fixture();
  for(const body of [{event:'transport_mode',transport:'ws'},{event:'transport_pin',transport:'poll'},{event:'sync_timeout'}]) {
    const response=await handleTelemetry(request(body),run.env);
    assert.equal(response.status,204);assert.equal(await response.text(),'');
  }
  assert.deepEqual(run.points.map(p=>[p.blobs[0],p.blobs[3],p.doubles[0]]),[['transport_mode','ws',1],['transport_pin','poll',1],['sync_timeout','',1]]);
});
test('telemetry refuses forged server events and private or arbitrary fields without echo',async()=> {
  const run=fixture();
  for(const body of [{event:'rpc_forbidden'},{event:'archive_lag_s',value:300},
    {event:'sync_timeout',token:'private'},{event:'transport_pin',transport:'private'},
    {event:'transport_mode'},{event:'sync_timeout',transport:'ws'},
    {event:'transport_pin',transport:'ws',reason:'private'},null]) {
    const response=await handleTelemetry(request(body),run.env);
    assert.equal(response.status,400);assert.equal(await response.text(),'invalid_telemetry');
  }
  assert.deepEqual(run.points,[]);
});
test('telemetry rate admission precedes body reads and fails closed for missing or failed limiter',async()=> {
  let pulls=0;
  const held={url,method:'POST',headers:new Headers({'content-type':'application/json'}),body:{getReader(){pulls++;throw new Error('must not read');}}};
  const run=fixture(false);
  assert.equal((await handleTelemetry(held,run.env)).status,429);assert.equal(pulls,0);
  assert.equal((await handleTelemetry(held,{})).status,503);assert.equal(pulls,0);
  assert.equal((await handleTelemetry(held,{TELEMETRY_RATE_LIMITER:{limit(){throw new Error('private');}}})).status,503);
  assert.equal(pulls,0);assert.deepEqual(run.points,[]);
});
test('telemetry bounds declared and streamed UTF-8 body bytes and rejects cross-origin or malformed requests',async()=> {
  const run=fixture();let canceled=0;
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('é'.repeat(257)));},cancel(){canceled++;return Promise.reject(new Error('private'));}});
  assert.equal((await handleTelemetry(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}),run.env)).status,413);
  assert.equal(canceled,1);
  assert.equal((await handleTelemetry(request({event:'sync_timeout'},{'content-length':'513'}),run.env)).status,413);
  assert.equal((await handleTelemetry(request({event:'sync_timeout'},{origin:'https://foreign.test'}),run.env)).status,403);
  assert.equal((await handleTelemetry(new Request(url,{method:'GET'}),run.env)).status,405);
  assert.equal((await handleTelemetry(new Request(url,{method:'POST',body:'not JSON'}),run.env)).status,415);
  assert.deepEqual(run.points,[]);
});
test('telemetry whole deadline bounds stalled rate admission and body without awaiting cancellation',{timeout:1000},async()=> {
  const run=fixture();let canceled=0;
  const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled++;return new Promise(()=>{});}});
  const started=Date.now();
  const response=await handleTelemetry(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}),run.env,{timeoutMs:10});
  assert.equal(response.status,408);assert.equal(canceled,1);assert.ok(Date.now()-started<500);
  const stalled={TELEMETRY_RATE_LIMITER:{limit:()=>new Promise(()=>{})}};
  assert.equal((await handleTelemetry(request({event:'sync_timeout'}),stalled,{timeoutMs:10})).status,408);
  assert.deepEqual(run.points,[]);
});
