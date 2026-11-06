import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stageForPath} from './helpers/startup-network.mjs';
test('measurement stages discard room/account identity while retaining public asset names',()=>{
  assert.equal(stageForPath('/api/v1/me'),'membership');assert.equal(stageForPath('/api/v1/me/rooms'),'owner-list');
  assert.equal(stageForPath('/api/v1/workspaces/0196fa71-0000-7000-8000-000000000001/catalogue'),'catalogue');
  assert.equal(stageForPath('/api/v1/sessions/0196fa71-0000-7000-8000-000000000001/facilitator-token'),'other-api');
  assert.equal(stageForPath('/sessions/0196fa71-0000-7000-8000-000000000001/display'),'public-document');
  assert.equal(stageForPath('/assets/app.'+'a'.repeat(64)+'.mjs'),'app.'+'a'.repeat(64)+'.mjs');
});
