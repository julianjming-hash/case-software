import test from 'node:test';
import assert from 'node:assert/strict';
import {knownAccountFake} from './helpers/admin-account-fixture.mjs';
import {uuidv7} from '../src/shared/ids.mjs';
const owner=uuidv7(),other=uuidv7();
const init=args=>({method:'POST',headers:{apikey:'test-only-key','content-profile':'case_api','accept-profile':'case_api'},body:JSON.stringify(args),redirect:'manual'});
test('Card21a known-account fixture permits only explicit actor UUIDs and retains exact RPC admission',async()=>{
 const fake=knownAccountFake({actors:[owner]});
 const url='https://admin-accounts.invalid/rest/v1/rpc/admin_account_active';
 assert.equal(await (await fake.fetchImpl(url,init({p_user_id:owner}))).json(),true);
 assert.equal(await (await fake.fetchImpl(url,init({p_user_id:other}))).json(),false);
 assert.equal((await fake.fetchImpl(url,init({p_user_id:owner,p_extra:true}))).status,404);
 assert.equal((await fake.fetchImpl(url,init({}))).status,404);
 assert.equal((await fake.fetchImpl('https://admin-accounts.invalid/rest/v1/rpc/unknown',init({}))).status,404);
});
test('Card21a known-account fixture preserves service failure and refuses every foreign network host',async()=>{
 const fake=knownAccountFake({actors:[owner]});
 fake.faults.push({status:503,code:'PGRST000'});
 assert.equal((await fake.fetchImpl('https://admin-accounts.invalid/rest/v1/rpc/admin_account_active',init({p_user_id:owner}))).status,503);
 await assert.rejects(fake.fetchImpl('https://unexpected.invalid/rest/v1/rpc/admin_account_active',init({p_user_id:owner})),/Non-fake host/);
 assert.throws(()=>knownAccountFake({actors:['unknown']}),/actor/);
});
