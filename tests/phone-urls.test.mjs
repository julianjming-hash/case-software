import test from 'node:test';
import assert from 'node:assert/strict';
import { privacyUrl, joinEntryUrl, joinUrl, parseRoute } from '../src/shared/urls.mjs';
test('phone join privacy routes use central builders and round-trip without names or credentials',()=>{
 const origin='http://case.test';
 assert.equal(privacyUrl(origin),origin+'/privacy');assert.equal(joinEntryUrl(origin),origin+'/join');
 assert.deepEqual(parseRoute(privacyUrl(origin)),{route:'privacy'});assert.deepEqual(parseRoute(joinEntryUrl(origin)),{route:'join'});
 assert.deepEqual(parseRoute(joinUrl('ABCDEF',origin)),{route:'join',code:'ABCDEF'});
 for(const path of ['/privacy/private','/join/private'])assert.equal(parseRoute(path),null);
});
