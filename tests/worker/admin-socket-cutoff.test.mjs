import {SELF,env,runInDurableObject} from 'cloudflare:test';
import {it,expect} from 'vitest';
import {uuidv7} from '../../src/shared/ids.mjs';
import {apiUrl} from '../../src/shared/urls.mjs';
import {roomFor} from '../../src/worker/directory-do.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
function socketEvent(socket,type,predicate=()=>true) {
 let timer;
 return new Promise((resolve,reject)=>{
  const listener=event=>{if(predicate(event)){clearTimeout(timer);socket.removeEventListener(type,listener);resolve(event);}};
  socket.addEventListener(type,listener);
  timer=setTimeout(()=>{socket.removeEventListener(type,listener);reject(new Error('Expected socket event missing'));},3000);
 });
}
it('Card21a admin end closes authenticated facilitator socket and pending read while participant recap survives',async()=>{
 const sessionId=uuidv7(),owner=uuidv7(),stub=roomFor(env,sessionId);
 const room=await stub.create({sessionId,joinCode:'AB1234',caseDoc:fixture,ownerUserId:owner,ttlMs:60000});
 const participant=await stub.join('Learner','shadows-01');
 const response=await SELF.fetch(apiUrl('https://case.test','sessions',sessionId,'ws'),{headers:{Upgrade:'websocket'}});
 expect(response.status).toBe(101);
 const socket=response.webSocket;socket.accept();
 const welcome=socketEvent(socket,'message',event=>JSON.parse(event.data).t==='welcome');
 socket.send(JSON.stringify({v:1,t:'hello',token:room.facilitatorToken,lastRevision:0,lastEpoch:0}));
 expect(JSON.parse((await welcome).data).role).toBe('facilitator');
 const snapshot=(await stub.snapshot(room.facilitatorToken)).snapshot;
 const pending=stub.updates(room.facilitatorToken,snapshot.revision,snapshot.displayRevision,10);
 await expect.poll(()=>runInDurableObject(stub,instance=>instance.waiters.size)).toBe(1);
 const closed=socketEvent(socket,'close').then(event=>({event}),error=>({error}));
 expect((await stub.adminEnd({sessionId,expectedOwnerUserId:owner,eventId:uuidv7()})).ok).toBe(true);
 const observed=await closed;expect(observed.error).toBeUndefined();
 expect(await pending).toEqual({error:'unauthorised',status:401});
 const close=observed.event;expect(close.code).toBe(4001);expect(close.reason).toBe('unauthorised');
 expect(await runInDurableObject(stub,instance=>instance.waiters.size)).toBe(0);
 const recap=(await stub.snapshot(participant.token)).snapshot.view;
 expect(recap.phase).toBe('ended');expect(recap.you.id).toBe(participant.participantId);
});
