import {env} from 'cloudflare:test';
import {afterEach,it,expect,vi} from 'vitest';
import worker from '../../src/worker/index.mjs';
import {uuidv7,newCapabilityToken} from '../../src/shared/ids.mjs';
import {signTestJwt} from '../../src/worker/auth.mjs';
import {fakePostgrest} from '../helpers/fake-postgrest.mjs';
afterEach(()=>vi.unstubAllGlobals());
const owner=uuidv7(),workspace=uuidv7();
for(const [label,path] of [['profile','/api/v1/me'],['owned rooms','/api/v1/me/rooms'],['workspace versions',`/api/v1/workspaces/${workspace}/versions`]]) {
 it(`Card21a mounted inactive facilitator ${label} read refuses metadata before profile or room RPC`,async()=>{
  const fake=fakePostgrest();
  fake.replies.set('admin_account_active',false);
  fake.replies.set('get_me',[{user_id:owner,display_name:'Private owner',memberships:[{workspace_id:workspace,role:'owner'}],next_after: null, admin: false }]);
  const local={...env,SUPABASE_URL:'https://postgrest.test/',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`};
  vi.stubGlobal('fetch',fake.fetchImpl);
  const jwt=await signTestJwt({sub:owner,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test-only-secret-not-for-production');
  const request=()=>new Request(`https://case.test${path}`,{headers:{authorization:`Bearer ${jwt}`}});
  let response=await worker.fetch(request(),local,{waitUntil:()=>{}});
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'forbidden'});
  expect(fake.requests).toHaveLength(1);expect(fake.requests[0].name).toBe('admin_account_active');
  expect(fake.requests[0].args).toEqual({p_user_id:owner});
  response=await worker.fetch(new Request(`https://case.test${path}`),local,{waitUntil:()=>{}});
  expect(response.status).toBe(401);expect(fake.requests).toHaveLength(1);
  fake.faults.push({status:503,code:'PGRST000'});
  response=await worker.fetch(request(),local,{waitUntil:()=>{}});
  expect(response.status).toBe(503);
 });
}

it('Card21a mounted room creation maps malformed account authority to unavailable rather than inactive',async()=>{
 const fake=fakePostgrest();fake.replies.set('admin_account_active',{active:true});
 vi.stubGlobal('fetch',fake.fetchImpl);
 const jwt=await signTestJwt({sub:owner,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'test-only-secret-not-for-production');
 const response=await worker.fetch(new Request('https://case.test/api/v1/sessions',{method:'POST',
  headers:{authorization:`Bearer ${jwt}`,'content-type':'application/json'},body:'{}'}),
  {...env,SUPABASE_URL:'https://postgrest.test/',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`},{waitUntil:()=>{}});
 expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'auth_unavailable'});
 expect(fake.requests).toHaveLength(1);expect(fake.requests[0].name).toBe('admin_account_active');
});
