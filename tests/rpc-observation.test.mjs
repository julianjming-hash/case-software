import { newCapabilityToken } from '../src/shared/ids.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcClient } from '../src/worker/rpc.mjs';
const env={SUPABASE_URL:'https://postgrest.test/',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`};
test('RPC fixed unavailable and missing-function hooks never await alert delivery',async()=> {
  for(const [response,expected] of [[Response.json({code:'PGRST202',message:'private'},{status:404}),{kind:'not_found',code:'PGRST202',name:'ping'}],
    [Response.json({message:'private'},{status:503}),{kind:'unavailable',code:null,name:'ping'}]]) {
    const sent=[];const client=rpcClient(env,{fetchImpl:async()=>response,onAlert:meta=>{sent.push(meta);return new Promise(()=>{});}});
    const result=await client.call('ping');
    assert.equal(result.ok,false);assert.deepEqual(sent,[expected]);
  }
});
test('RPC timeout emits fixed unavailable metadata while preserving its existing receipt',async()=> {
  const sent=[];
  const client=rpcClient(env,{timeoutMs:10,fetchImpl:()=>new Promise(()=>{}),onAlert:meta=>{sent.push(meta);throw new Error('private');}});
  assert.deepEqual(await client.call('ping'),{ok:false,kind:'unavailable',status:503,code:'timeout'});
  assert.deepEqual(sent,[{kind:'unavailable',code:'timeout',name:'ping'}]);
});
