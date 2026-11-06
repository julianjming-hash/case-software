import { SELF, env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7, newJoinCode, newCapabilityToken } from '../../src/shared/ids.mjs';
import { directoryFor, roomFor, limitsFor, clientPrefix } from '../../src/worker/directory-do.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';

it('verified same-room recovery bypasses exhausted wrong-code fallback without weakening invalid capabilities',async()=>{
 const sessionId=uuidv7(),code=newJoinCode(),ip='192.0.2.187',prefix=clientPrefix(ip);
 const stub=roomFor(env,sessionId),created=await stub.create({sessionId,joinCode:code,caseDoc:fixture,ownerUserId:uuidv7(),ttlMs:3600000});
 expect(created.error).toBeUndefined();await directoryFor(env,code).register(code,sessionId,Date.now()+3600000);
 const joined=await stub.join('Sam','shadows-01');expect(joined.error).toBeUndefined();
 const limits=limitsFor(env,prefix);for(let n=0;n<20;n++)await limits.fail(prefix);expect(await limits.blocked(prefix)).toBe(true);
 const recovery=token=>SELF.fetch('http://case.test/api/v1/join/recover',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':ip,authorization:`Bearer ${token}`},body:JSON.stringify({code,sessionId})});
 const accepted=await recovery(joined.token);expect(accepted.status).toBe(200);expect(await accepted.json()).toEqual({sessionId});
 expect(Object.keys((await stub.snapshot(created.facilitatorToken)).snapshot.mirror.participants)).toHaveLength(1);
 expect(await limits.blocked(prefix)).toBe(true);
 const invalid=await recovery(newCapabilityToken());expect(invalid.status).toBe(429);expect(await invalid.json()).toEqual({error:'rate_limited'});
});
