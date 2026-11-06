import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProfileReceipt } from '../src/client/phone-profile.mjs';

test('confirmed profile save updates saved values before collapsing back to the previous surface', () => {
  const view={you:{name:'Old',avatarId:'shadows-01'}};
  let collapsed=false;
  assert.equal(applyProfileReceipt({receipt:'accepted'},view,{displayName:'New',avatarId:'shadows-02'},()=>{
    assert.equal(view.you.name,'New');assert.equal(view.you.avatarId,'shadows-02');collapsed=true;
  }),true);
  assert.equal(collapsed,true);
  assert.equal(applyProfileReceipt({receipt:'already_accepted'},view,{displayName:'Again',avatarId:'shadows-03'},()=>{}),true);
});

test('rejected profile save does not discard the editor or change saved values', () => {
  const view={you:{name:'Old',avatarId:'shadows-01'}};
  assert.equal(applyProfileReceipt({receipt:'rejected'},view,{displayName:'New',avatarId:'shadows-02'},()=>{throw Error('editor closed');}),false);
  assert.deepEqual(view.you,{name:'Old',avatarId:'shadows-01'});
});
