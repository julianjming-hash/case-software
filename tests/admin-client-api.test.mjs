import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAdminApi } from '../src/client/admin-api.mjs';
const origin='https://case.test';
const auth=()=>({accessToken:()=>randomBytes(24).toString('hex'),sessionGeneration:()=>0,handle401:async()=>{}});
const list={users:[],nextPage:null};
test('Card21b private API uses Bearer only and refuses redirects, raw errors and malformed success without retries',async()=>{
  let calls=0,init;
  const api=createAdminApi({origin,auth:auth(),fetchImpl:async(_url,options)=>{calls++;init=options;return Response.json(list);}});
  assert.deepEqual(await api.call('facilitators_list'),{ok:true,data:list});
  assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.ok(init.headers.authorization.startsWith('Bearer '));
  for(const response of [new Response(null,{status:302,headers:{location:'https://foreign.test'}}),Response.json({error:'PRIVATE_UPSTREAM_BODY'},{status:500}),Response.json({...list,refresh_token:'PRIVATE'})]){
    const other=createAdminApi({origin,auth:auth(),fetchImpl:async()=>{calls++;return response;}});
    const result=await other.call('facilitators_list');assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('PRIVATE'));other.close();
  }
  assert.equal(calls,4);api.close();
});
test('Card21b private API whole deadline covers a stalled body and signal-ignoring fetch',async()=>{
  for(const fetchImpl of [()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}))]){
    const api=createAdminApi({origin,auth:auth(),fetchImpl,timeoutMs:25});
    const started=performance.now(),result=await api.call('facilitators_list');
    assert.equal(result.error,'request_timeout');assert.ok(performance.now()-started<500);api.close();
  }
});
test('Card21b late results after close or account generation change cannot return private rows or clear a newer account',async()=>{
  for(const close of [true,false]){
    let resolve,generation=0,wipes=0;
    const api=createAdminApi({origin,auth:{accessToken:()=>randomBytes(24).toString('hex'),sessionGeneration:()=>generation,handle401:async()=>{wipes++;}},fetchImpl:()=>new Promise(done=>{resolve=done;})});
    const pending=api.call('facilitators_list');
    if(close)api.close();else generation++;
    resolve(Response.json({error:'unauthorised'},{status:401}));
    const result=await pending;assert.equal(result.error,'closed');assert.equal(wipes,0);
  }
});
test('Card21b current 401 performs common cleanup once and never refreshes or retries',async()=>{
  let calls=0,wipes=0;
  const api=createAdminApi({origin,auth:{accessToken:()=>randomBytes(24).toString('hex'),sessionGeneration:()=>0,handle401:async()=>{wipes++;}},fetchImpl:async()=>{calls++;return Response.json({error:'unauthorised'},{status:401});}});
  assert.deepEqual(await api.call('facilitators_list'),{ok:false,status:401,error:'unauthorised'});
  assert.equal(wipes,1);assert.equal(calls,1);api.close();
});
