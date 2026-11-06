import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '../src/shared/ids.mjs';
import { adminPageUrl, adminApiUrl } from '../src/shared/urls.mjs';
const origin='https://case.test';
test('Card21b admin URLs expose only the fixed same-origin operation inventory and bounded nonpersonal paging',()=>{
  assert.equal(adminPageUrl(origin),`${origin}/admin`);
  assert.equal(adminApiUrl(origin,'facilitators_list',{page:2,perPage:100}),`${origin}/api/v1/admin/facilitators?page=2&perPage=100`);
  for(const [op,path] of [['stepup_start','stepup/start'],['stepup_verify','stepup'],['facilitators_search','facilitators/search'],['cases_list','cases'],['rooms_list','rooms'],['audit_list','audit']])
    assert.equal(new URL(adminApiUrl(origin,op)).pathname,`/api/v1/admin/${path}`);
  for(const options of [{email:'private@example.invalid'},{code:'123456'},{token:'private'},{search:'private'},{page:0},{perPage:1001},{limit:101}]) assert.throws(()=>adminApiUrl(origin,'facilitators_list',options));
  for(const bad of ['https://case.test/?token=x','https://user:pass@case.test','https://case.test/path','javascript:alert(1)']) assert.throws(()=>adminPageUrl(bad));
  assert.throws(()=>adminApiUrl(origin,'unknown'));
  // CASE-339: invitations left the admin inventory for /api/v1/invitations.
  for(const retired of ['facilitators_invite','facilitators_resend']) assert.throws(()=>adminApiUrl(origin,retired,{id:randomUUID()}));
});
test('Card21b admin target URLs distinguish Auth UUIDs from UUIDv7 clinical identifiers and reject injected target or cursor data',()=>{
  const authId=randomUUID(),clinical=uuidv7();
  for(const action of ['disable','enable','soft_delete','restore']) assert.equal(new URL(adminApiUrl(origin,`facilitators_${action}`,{id:authId})).pathname,`/api/v1/admin/facilitators/${authId}/${action.replace('_','-')}`);
  for(const [op,path] of [['cases_publish','cases'],['versions_withdraw','versions'],['rooms_end','rooms']]) {
    assert.match(adminApiUrl(origin,op,{id:clinical}),new RegExp(`/admin/${path}/${clinical}/`));
    assert.throws(()=>adminApiUrl(origin,op,{id:authId}));
  }
  assert.throws(()=>adminApiUrl(origin,'facilitators_disable',{id:'../../private@example.invalid'}));
  assert.throws(()=>adminApiUrl(origin,'audit_list',{after:'private@example.invalid'}));
  assert.equal(new URL(adminApiUrl(origin,'audit_list',{after:clinical,limit:100})).searchParams.get('after'),clinical);
});
test('Card21b live-room continuation is bounded and bound to its code shard',()=>{
  assert.equal(new URL(adminApiUrl(origin,'rooms_list',{after:'7:7K3QX9',limit:100})).searchParams.get('after'),'7:7K3QX9');
  assert.equal(new URL(adminApiUrl(origin,'rooms_list',{after:'A'})).searchParams.get('after'),'A');
  for(const after of ['0:7K3QX9','I','7:7K3QX9:private','private@example.invalid'])assert.throws(()=>adminApiUrl(origin,'rooms_list',{after}));
});
