import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRoomRequest} from '../src/worker/admin/room-handler.mjs';
import {matchAdminRoute} from '../src/worker/admin/routes.mjs';
import {mintElevation} from '../src/worker/admin/stepup.mjs';
import {uuidv7,newCapabilityToken} from '../src/shared/ids.mjs';
async function fixture(){const now=Date.now(),id=uuidv7(),owner=uuidv7(),secret=newCapabilityToken(),session=uuidv7(),calls=[];let clock=now;
 const request=new Request(`https://case.invalid/api/v1/admin/rooms/${id}/end`,{method:'POST',headers:{'x-admin-elevation':(await mintElevation('admin@example.test',session,secret)).token}});
 return {calls,id,owner,setClock:value=>clock=value,input:{request,route:matchAdminRoute(new URL(request.url).pathname,'POST'),user:{email:'admin@example.test',sessionId:session},env:{ADMIN_EMAILS:'admin@example.test',STEPUP_SECRET:secret},body:{},nowMs:()=>clock,rooms:{summary:async sessionId=>{calls.push('summary');return {sessionId,ownerUserId:owner,status:'live'};},endOne:async args=>{calls.push(args);return {ok:true};}}}};
}
test('Card 21a room-end handler requires the session elevation and binds actual summary owner to audited adapter',async()=>{
 const f=await fixture(),response=await handleRoomRequest(f.input);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ended:true});
 const action=f.calls[1];assert.equal(f.calls[0],'summary');assert.equal(action.sessionId,f.id);assert.equal(action.userId,f.owner);assert.equal(await action.admitted(),true);
 const missing=await fixture();missing.input.request.headers.delete('x-admin-elevation');assert.equal((await handleRoomRequest(missing.input)).status,403);assert.deepEqual(missing.calls,[]);
});
test('Card 21a room-end reconciliation stays fixed and cannot return success after incomplete end',async()=>{
 const f=await fixture();f.input.rooms.endOne=async()=>({ok:false,error:'manual_reconciliation_needed'});
 const response=await handleRoomRequest(f.input);assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'manual_reconciliation_needed'});
});
test('[PM-38] R-a: a room-end elevation serves the whole session but never another session or admin',async()=>{
 const f=await fixture();assert.equal((await handleRoomRequest(f.input)).status,200);
 f.calls.length=0;assert.equal((await handleRoomRequest(f.input)).status,200);
 for(const user of [{email:'admin@example.test',sessionId:uuidv7()},{email:'other@example.test',sessionId:f.input.user.sessionId}]){
  const g=await fixture();g.input.request.headers.set('x-admin-elevation',f.input.request.headers.get('x-admin-elevation'));g.input.user=user;
  g.input.env={...g.input.env,ADMIN_EMAILS:'admin@example.test,other@example.test',STEPUP_SECRET:f.input.env.STEPUP_SECRET};
  assert.equal((await handleRoomRequest(g.input)).status,403);assert.deepEqual(g.calls,[]);
 }
});
