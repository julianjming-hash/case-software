import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode } from '../../src/shared/ids.mjs';
import { miniCase } from '../helpers/mini-case.mjs';
it('[AS-127] native finalization follows acknowledged archive and SQL end; failed proof retries without extending privacy',async()=>{
 const sessionId=uuidv7(),versionId=uuidv7(),stub=env.ROOM.get(env.ROOM.idFromName(sessionId));
 const room=await stub.create({sessionId,joinCode:newJoinCode(),caseDoc:miniCase().doc,caseVersionId:versionId,ownerUserId:uuidv7()});
 await runInDurableObject(stub,instance=>{
  instance.sql.exec("INSERT INTO meta(key,value) VALUES('archive_session_id',?)",instance.state.sessionId);
  instance.proofTest={calls:[],pass:false};
  instance.archiveClient={call:async(name,args)=>{instance.proofTest.calls.push({name,args});return {ok:true,data:name==='archive_session_batch'?Math.max(0,...args.p_batch.events.map(x=>x.seq)):name==='finalize_session_portfolio'?instance.proofTest.pass:null};}};
 });
 await stub.join('Private learner','shadows-01');
 const snapshot=await stub.snapshot(room.facilitatorToken);const result=await stub.command(room.facilitatorToken,{v:1,type:'end',epoch:snapshot.snapshot.view.epoch,clientEventId:uuidv7()});expect(result.receipt.receipt).toBe('accepted');
 for(let i=0;i<4;i++)await runInDurableObject(stub,instance=>instance.flushArchive());
 const before=await runInDurableObject(stub,instance=>{
  const events=instance.proofTest.calls;const final=events.findIndex(x=>x.name==='finalize_session_portfolio'),ended=events.findIndex(x=>x.name==='end_session');expect(final).toBeGreaterThan(ended);expect(ended).toBeGreaterThanOrEqual(0);
  const proof=events[final].args;expect(proof.p_version_id).toBe(instance.sql.exec("SELECT value FROM meta WHERE key='portfolio_version_id'").toArray()[0].value);expect(proof.p_seq).toBe(instance.state.revision);expect(proof.p_joined).toBe(1);
  expect(instance.sql.exec("SELECT value FROM meta WHERE key='portfolio_manifest_sent'").toArray()).toEqual([]);
  const boundary=instance.sql.exec("SELECT key,value FROM meta WHERE key IN ('recap_delete_at','expires_at','archive_personal_delete_at') ORDER BY key").toArray();instance.proofTest.pass=true;return boundary;
 });
 await runInDurableObject(stub,instance=>instance.flushArchive());
 await runInDurableObject(stub,instance=>{
  expect(instance.sql.exec("SELECT value FROM meta WHERE key='portfolio_manifest_sent'").toArray()[0].value).toBe('1');
  expect(instance.sql.exec("SELECT key,value FROM meta WHERE key IN ('recap_delete_at','expires_at','archive_personal_delete_at') ORDER BY key").toArray()).toEqual(before);
 });
});
