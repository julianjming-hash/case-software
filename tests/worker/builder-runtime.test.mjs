import { env, SELF, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { apiUrl } from '../../src/shared/urls.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { miniCase } from '../helpers/mini-case.mjs';
import { convertSchema1ToBuilderDocument } from '../../src/shared/builder-document.mjs';

it('schema2 DO refuses old readers and persists occurrence recovery through a cold rebuild',async()=>{
 const f=miniCase();const doc=convertSchema1ToBuilderDocument(f.doc).candidate;
 doc.required_capabilities=['required_recovery','formatted_text'];
 doc.surfaces[0].scene={blocks:[{type:'paragraph',runs:[{text:'Shared formatted scene',bold:true}]}]};
 doc.decisions[0].paths.find(p=>p.id===f.p.image).recovery={prompt:'PRIVATE recovery confirmation'};
 const sessionId=uuidv7(),stub=env.ROOM.get(env.ROOM.idFromName(sessionId));
 const created=await stub.create({sessionId,joinCode:'7K3QX9',caseDoc:doc,ownerUserId:uuidv7(),inlineDev:true});
 expect(created.error).toBeUndefined();const token=created.facilitatorToken;
 expect((await stub.snapshot(token)).error).toBe('client_upgrade_required');
 expect((await stub.casePack(token)).error).toBe('client_upgrade_required');
 const snapshotUrl=apiUrl('https://case.test','sessions',sessionId,'snapshot');
 const oldHttp=await SELF.fetch(snapshotUrl,{headers:{authorization:`Bearer ${token}`}});
 expect(oldHttp.status).toBe(409);expect((await oldHttp.json()).error).toBe('client_upgrade_required');
 const newHttp=await SELF.fetch(snapshotUrl,{headers:{authorization:`Bearer ${token}`,'x-case-schema':'2'}});
 expect(newHttp.status).toBe(200);

 const view=async()=> (await stub.snapshot(token,2)).snapshot.view;
 const send=async(type,extra={})=>{const v=await view();return stub.command(token,{v:1,type,epoch:v.epoch,expectRevision:v.revision,clientEventId:uuidv7(),...extra},2);};
 expect((await send('start')).receipt.receipt).toBe('accepted');
 // Formatted scene and findings are independent group presses.
 expect((await view()).presentation.nextGroup).toBeTruthy();
 await send('advance');await send('advance');await send('advance');await send('lock');
 expect((await send('reveal_path',{pathId:f.p.image})).receipt.receipt).toBe('accepted');
 expect((await send('advance')).receipt.reason).toBe('recovery_required');
 const occurrenceId=(await view()).recovery.occurrenceId;
 expect((await send('confirm_recovery',{occurrenceId,confirmed:true})).receipt.receipt).toBe('accepted');
 await evictDurableObject(stub);
 expect((await view()).recovery.confirmed).toBe(true);
 expect((await send('confirm_recovery',{occurrenceId,confirmed:false})).receipt.receipt).toBe('accepted');
 expect((await send('advance')).receipt.reason).toBe('recovery_required');
 expect((await stub.command(token,{v:1,type:'advance',epoch:0,clientEventId:uuidv7()})).error).toBe('client_upgrade_required');
 // Test sockets after eviction: the existing ten-second hello timer otherwise prevents hibernation.
 const upgraded=await SELF.fetch(apiUrl('https://case.test','sessions',sessionId,'ws'),{headers:{Upgrade:'websocket'}});
 const ws=upgraded.webSocket;ws.accept();const frames=[];
 const closed=new Promise(resolve=>ws.addEventListener('close',event=>resolve(event.code)));
 ws.addEventListener('message',event=>{const frame=JSON.parse(event.data);frames.push(frame);});
 ws.send(JSON.stringify({v:1,t:'hello',token,lastRevision:0,lastEpoch:0}));
 expect(await closed).toBe(4002);expect(frames).toEqual([{v:1,t:'error',error:'client_upgrade_required'}]);

});

it('schema2 runtime rejects incomplete, unknown-capability and malformed formatted documents',async()=>{
 for(const mutate of [doc=>{doc.required_capabilities=['unknown'];},doc=>{doc.surfaces[0].scene={blocks:[{type:'html',text:'bad'}]};doc.required_capabilities=['formatted_text'];},doc=>{doc.start_beat_id=uuidv7();}]){
  const doc=convertSchema1ToBuilderDocument(miniCase().doc).candidate;mutate(doc);
  const sessionId=uuidv7(),stub=env.ROOM.get(env.ROOM.idFromName(sessionId));
  expect((await stub.create({sessionId,joinCode:'7K3QX9',caseDoc:doc,ownerUserId:uuidv7(),inlineDev:true})).error).toBe('invalid_case');
 }
});
