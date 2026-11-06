// Recovery checks real credentials and server cutoffs, without minting or joining again.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { directoryFor } from '../../src/worker/directory-do.mjs';
import {nativeAccountFetch} from './admin-fixtures.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
const api=(path,token,body)=>SELF.fetch('http://case.test/api/v1'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
async function room(){
 const actor=uuidv7();
 const jwt=await signTestJwt({sub:actor,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test-only-secret-not-for-production');
 const res=await nativeAccountFetch('http://case.test/api/v1/sessions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${jwt}`},body:JSON.stringify({caseDocument:fixture})},[actor]);expect(res.status).toBe(201);const r=await res.json();
 const joined=await api('/join',null,{v:1,code:r.joinCode,displayName:'Sam',avatarId:'shadows-01'});expect(joined.status).toBe(201);
 return {...r,participant:await joined.json(),stub:env.ROOM.get(env.ROOM.idFromName(r.sessionId))};
}
const recover=(r,token=r.participant.token,code=r.joinCode)=>api('/join/recover',token,{code,sessionId:r.sessionId});
it('participant recovery resumes the same QR without duplicates and refuses facilitator display foreign and reused-code capabilities',async()=>{
 const r=await room();const before=(await r.stub.snapshot(r.facilitatorToken)).snapshot;
 const res=await recover(r);expect(res.status).toBe(200);expect(await res.json()).toEqual({sessionId:r.sessionId});
 expect(Object.keys(((await r.stub.snapshot(r.facilitatorToken)).snapshot).mirror.participants)).toHaveLength(Object.keys(before.mirror.participants).length);
 const display=await r.stub.issueDisplayToken();for(const token of [r.facilitatorToken,display.token])expect((await recover(r,token)).status).toBe(403);
 const foreign=await room();expect((await recover(r,foreign.participant.token)).status).toBe(401);
 expect((await recover(r,r.participant.token,foreign.joinCode)).status).toBe(403);
});
it('participant recovery rejects removed revoked deleted and expired recaps even before a deletion alarm',async()=>{
 for(const mode of ['removed','revoked','deleted','recap','backstop']){
  const r=await room();
  await runInDurableObject(r.stub,(instance,state)=>{
   if(mode==='removed')instance.state.participants[r.participant.participantId].removedAt=new Date().toISOString();
   if(mode==='revoked')state.storage.sql.exec("UPDATE credentials SET revoked_at = ? WHERE role = 'participant'",new Date().toISOString());
   if(mode==='deleted')instance.state=null;
   if(mode==='recap')state.storage.sql.exec("INSERT OR REPLACE INTO meta (key,value) VALUES ('recap_delete_at', ?)",String(Date.now()-1));
   if(mode==='backstop')state.storage.sql.exec("INSERT OR REPLACE INTO meta (key,value) VALUES ('expires_at', ?)",String(Date.now()-24*60*60_000-1));
  });
  expect((await recover(r)).status).toBe({removed:403,revoked:401,deleted:404,recap:410,backstop:410}[mode]);
 }
});
it('participant recovery permits an authorized unexpired ended recap when its directory code is gone',async()=>{
 const r=await room();await api(`/sessions/${r.sessionId}/commands`,r.facilitatorToken,{v:1,type:'end',epoch:0,clientEventId:uuidv7()});
 await directoryFor(env,r.joinCode).release(r.joinCode,r.sessionId);
 const res=await recover(r);expect(res.status).toBe(200);expect(await res.json()).toEqual({sessionId:r.sessionId});
});
it('participant recovery returns real directory failure as 503 without falling back to another room',async()=>{
 const r=await room();
 await runInDurableObject(directoryFor(env,r.joinCode),(_instance,state)=>state.storage.sql.exec('DROP TABLE codes'));
 const res=await recover(r);expect(res.status).toBe(503);expect(await res.json()).toEqual({error:'unavailable'});
 const after=(await r.stub.snapshot(r.facilitatorToken)).snapshot;
 expect(Object.keys(after.mirror.participants)).toHaveLength(1);
});
