import test from 'node:test';
import assert from 'node:assert/strict';
import {accountActive} from '../src/worker/admin/account-active.mjs';
import {uuidv7} from '../src/shared/ids.mjs';

test('Card21a typed account authority admits only true and distinguishes inactive false',async()=>{
 const userId=uuidv7(),calls=[];
 const rpc={call:async(name,args)=>{calls.push({name,args});return {ok:true,data:true};}};
 assert.equal(await accountActive(rpc,userId),null);
 assert.deepEqual(calls,[{name:'admin_account_active',args:{p_user_id:userId}}]);
 rpc.call=async()=>({ok:true,data:false});
 assert.deepEqual(await accountActive(rpc,userId),{error:'forbidden',status:403});
});

test('Card21a typed account authority refuses malformed or unavailable data as fixed 503',async()=>{
 for(const result of [null,{}, {ok:false,data:true}, ...[null,'true',1,{},[]].map(data=>({ok:true,data}))])
  assert.deepEqual(await accountActive({call:async()=>result},uuidv7()),{error:'auth_unavailable',status:503});
 assert.deepEqual(await accountActive({call:async()=>{throw new Error('private upstream detail');}},uuidv7()),
  {error:'auth_unavailable',status:503});
});
