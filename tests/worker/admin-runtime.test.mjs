import {SELF,env,runInDurableObject} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import {uuidv7} from '../../src/shared/ids.mjs';
import {signTestJwt} from '../../src/worker/auth.mjs';
import {roomFor,directoryFor} from '../../src/worker/directory-do.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
const setup=async()=>{
 const sessionId=uuidv7(),owner=uuidv7(),stub=roomFor(env,sessionId);
 const result=await stub.create({sessionId,joinCode:'AB1234',caseDoc:fixture,ownerUserId:owner,ttlMs:60000});
 expect(result.facilitatorToken).toBeTypeOf('string');return {sessionId,owner,stub,facilitatorToken:result.facilitatorToken};
};
describe('Card21a server-only admin runtime boundaries',()=>{
 it('Directory admin inventory pages live codes and reports actual or unknown registration age without private data',async()=>{
  const directory=directoryFor(env,'A'),now=Date.now();
  await directory.register('A00001',uuidv7(),now+60000);
  await directory.register('A00002',uuidv7(),now+60000);
  const page=await directory.adminInventory({limit:1,afterCode:null},now);
  expect(page.rows).toHaveLength(1);expect(page.rows[0].code).toBe('A00001');expect(page.nextCode).toBe('A00001');
  expect(Object.keys(page.rows[0]).sort()).toEqual(['code','expiresAt','registeredAt','sessionId']);
  expect(Date.parse(page.rows[0].registeredAt)).toBeGreaterThanOrEqual(now);
  const next=await directory.adminInventory({limit:100,afterCode:page.nextCode},now);
  expect(next.rows.map(row=>row.code)).toEqual(['A00002']);expect(next.nextCode).toBeNull();
  await runInDurableObject(directory,instance=>instance.sql.exec('INSERT INTO codes(code,session_id,expires_at) VALUES (?,?,?)','A00003',uuidv7(),Date.now()+60000));
  expect((await directory.adminInventory({limit:100,afterCode:'A00002'},now)).rows[0].registeredAt).toBeNull();
  expect((await directory.adminInventory({limit:101,afterCode:null},now)).error).toBe('bad_request');
 });
 it('Room admin summary rejects foreign session and projects only owner and aggregate runtime metadata',async()=>{
  const {stub,sessionId,owner}=await setup();
  const summary=await stub.adminSummary(sessionId);
  expect(summary).toMatchObject({sessionId,ownerUserId:owner,status:'live',phase:'lobby',participantCount:0});
  expect(Object.keys(summary).sort()).toEqual(['expiresAt','ownerUserId','participantCount','phase','sessionId','status']);
  expect((await stub.adminSummary(uuidv7())).error).toBe('not_found');
 });
 it('Room admin end checks same session and owner then persists server-clock lifecycle and idempotent admin reason',async()=>{
  const {stub,sessionId,owner}=await setup(),eventId=uuidv7(),before=Date.now();
  expect((await stub.adminEnd({sessionId,expectedOwnerUserId:uuidv7(),eventId})).error).toBe('forbidden');
  expect((await stub.adminSummary(sessionId)).status).toBe('live');
  expect(await stub.adminEnd({sessionId,expectedOwnerUserId:owner,eventId})).toEqual({ok:true,status:'ended',reason:'admin'});
  const stored=await runInDurableObject(stub,instance=>({endedAt:instance.state.endedAt,recap:Number(instance.sql.exec("SELECT value FROM meta WHERE key='recap_delete_at'").toArray()[0].value),reason:instance.sql.exec("SELECT value FROM meta WHERE key='admin_end_reason'").toArray()[0].value,revision:instance.state.revision}));
  expect(Date.parse(stored.endedAt)).toBeGreaterThanOrEqual(before);expect(stored.recap).toBeGreaterThanOrEqual(before+86400000);expect(stored.reason).toBe('admin');
  expect(await stub.adminEnd({sessionId,expectedOwnerUserId:owner,eventId:uuidv7()})).toEqual({ok:true,status:'ended',reason:'admin'});
  expect((await stub.adminSummary(sessionId)).status).toBe('ended');
  expect(await runInDurableObject(stub,instance=>instance.state.revision)).toBe(stored.revision);
 });
 it('Admin ending revokes facilitator pack and command capability even already ended while participant recap remains',async()=>{
  const {stub,sessionId,owner,facilitatorToken}=await setup();
  const participant=await stub.join('Sam','shadows-01');expect(participant.token).toBeTypeOf('string');
  await stub.command(facilitatorToken,{v:1,type:'end',epoch:0,clientEventId:uuidv7()});
  // Card 40 slice 5 (red-team R3): the private pack is refused to every credential once the room has ended.
  expect(await stub.casePack(facilitatorToken)).toEqual({error:'room_ended',status:410});
  const before=await runInDurableObject(stub,instance=>Number(instance.sql.exec("SELECT value FROM meta WHERE key='recap_delete_at'").toArray()[0].value));
  expect((await stub.adminEnd({sessionId,expectedOwnerUserId:owner,eventId:uuidv7()})).ok).toBe(true);
  for(const result of [await stub.snapshot(facilitatorToken),await stub.casePack(facilitatorToken),await stub.manualSegment(facilitatorToken,{}),await stub.command(facilitatorToken,{})])
   expect(result).toEqual({error:'unauthorised',status:401});
  const recap=await stub.snapshot(participant.token);expect(recap.snapshot.view.phase).toBe('ended');expect(recap.snapshot.view.you.id).toBe(participant.participantId);
  expect(await runInDurableObject(stub,instance=>Number(instance.sql.exec("SELECT value FROM meta WHERE key='recap_delete_at'").toArray()[0].value))).toBe(before);
 });
 it('mounted facilitator JWT cannot create an inline room while authoritative account RPC is unconfigured',async()=>{
  const token=await signTestJwt({sub:uuidv7(),aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test-only-secret-not-for-production');
  const response=await SELF.fetch('https://case.test/api/v1/sessions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({caseDocument:fixture})});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'auth_unavailable'});
 });
 it('mounted facilitator token mint and console approval refuse unavailable account authority',async()=>{
  const {sessionId,owner}=await setup();
  const token=await signTestJwt({sub:owner,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test-only-secret-not-for-production');
  const responses=await Promise.all([
   SELF.fetch(`https://case.test/api/v1/sessions/${sessionId}/facilitator-token`,{method:'POST',headers:{authorization:`Bearer ${token}`}}),
   SELF.fetch('https://case.test/api/v1/console-pairs/preview',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({code:'A0000001'})})
  ]);
  expect(responses.map(response=>response.status)).toEqual([503,503]);
 });
 it('mounted admin route rejects unauthenticated before absent service configuration',async()=>{
  const response=await SELF.fetch('https://case.test/api/v1/admin/audit');
  expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'unauthorised'});
 });
});
