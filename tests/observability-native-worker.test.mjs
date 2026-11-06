import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { knownAccountFake } from './helpers/admin-account-fixture.mjs';
import { signTestJwt } from '../src/worker/auth.mjs';
import { uuidv7, newCapabilityToken, newJoinCode } from '../src/shared/ids.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function worker(outbound, authSecret = null) {
  const bundled=await build({stdin:{contents:`
    import Worker from './src/worker/index.mjs';
    import { HEALTH_CRONS } from './src/worker/cron-health.mjs';
    export { RoomDO, DirectoryDO } from './src/worker/index.mjs';
    export default {async fetch(request,env,ctx) {
      const points=[],sent=[],pending=[],joinCalls=[];
      const bindings={...env,METRICS:{writeDataPoint:p=>points.push(p)},
        JOIN_ATTEMPTS:{limit:async()=>{joinCalls.push('coarse');return {success:request.headers.get('x-fixture-coarse')!=='1'};}},
        DIRECTORY:{idFromName:name=>name,get:()=>({
          blocked:async()=>{joinCalls.push('blocked');return request.headers.get('x-fixture-blocked')==='1';},
          lookup:async()=>{joinCalls.push('lookup');return {error:'unknown_code'};},
          fail:async()=>{joinCalls.push('fail');},
          challengeRequired:async()=>{joinCalls.push('challengeRequired');return request.headers.get('x-fixture-blocked')==='1';},
          failChallenge:async()=>{joinCalls.push('failChallenge');},
          resetChallenge:async()=>{joinCalls.push('resetChallenge');}})},
        TELEMETRY_RATE_LIMITER:{limit:async()=>({success:request.headers.get('x-fixture-denied')!=='1'})},
        ALERTS:{idFromName:()=> 'alerts',get:()=>({send:async event=>{sent.push(event);return {ok:false,kind:'busy'};}})}};
      if(new URL(request.url).pathname==='/__fixture_cron') {
        await Worker.scheduled({cron:HEALTH_CRONS.weekly},bindings,{waitUntil:p=>pending.push(p)});
        await Promise.all(pending);return Response.json({points,sent,joinCalls});
      }
      const response=await Worker.fetch(request,bindings,{waitUntil:p=>pending.push(p)});
      await Promise.all(pending);
      return Response.json({status:response.status,text:await response.text(),points,sent,joinCalls});
    }};`,resolveDir:root},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'},external:['cloudflare:workers']});
  return new Miniflare(convertV4MiniflareOptions({script:bundled.outputFiles[0].text,modules:true,compatibilityDate:'2026-08-22',
    bindings:{CASE_ENV:'staging',BUILD_SHA:'a'.repeat(40),TURNSTILE_SECRET_KEY:newCapabilityToken(),TURNSTILE_SITE_KEY:newCapabilityToken(),SUPABASE_URL:'https://postgrest.test/',
      SUPABASE_JWT_ISSUER:'https://postgrest.test/auth/v1',SUPABASE_JWKS_URL:'https://postgrest.test/auth/v1/.well-known/jwks.json',
      SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`,HEALTHCHECK_PING_URL:'https://healthcheck.test/ping',
      ...(authSecret ? {CASE_ENV:'',CASE_ALLOW_HS256:'1',SUPABASE_JWT_SECRET:authSecret} : {})},
    outboundService:outbound ?? (()=>{throw new Error('unexpected outbound');})}));
}
const send=async(mf,body,headers={})=>(await mf.dispatchFetch('http://localhost/api/v1/telemetry',{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})).json();
test('native Worker telemetry route writes transport-only metrics after rate admission and never alerts',{timeout:15000},async()=> {
  const mf=await worker();
  try {
    const accepted=await send(mf,{event:'transport_mode',transport:'ws'});
    assert.equal(accepted.status,204);assert.deepEqual(accepted.sent,[]);
    assert.deepEqual(accepted.points,[{blobs:['transport_mode','staging','a'.repeat(40),'ws',''],doubles:[1],indexes:['staging']}]);
    for(const body of [{event:'rpc_forbidden'},{event:'sync_timeout',token:'private'}]) {
      const rejected=await send(mf,body);assert.equal(rejected.status,400);assert.deepEqual(rejected.points,[]);assert.deepEqual(rejected.sent,[]);
    }
    const denied=await send(mf,{event:'sync_timeout'},{'x-fixture-denied':'1'});
    assert.equal(denied.status,429);assert.deepEqual(denied.points,[]);assert.deepEqual(denied.sent,[]);
  } finally {await mf.dispose();}
});
test('native scheduled Worker leaves deadman silent when required stale alert admission is busy',{timeout:15000},async()=> {
  const calls=[];const now=Date.now();
  const mf=await worker(async request=> {
    const url=new URL(request.url);
    assert.ok(['https://postgrest.test','https://healthcheck.test'].includes(url.origin));
    calls.push(url.pathname);
    if(url.origin==='https://healthcheck.test') return new Response('ok');
    if(url.pathname.endsWith('/heartbeats')) return Response.json([
      {job:'keepalive',ran_at:new Date(now).toISOString()},
      {job:'purge_participant_data',ran_at:new Date(now-31*60000).toISOString()}]);
    if(url.pathname.endsWith('/ping')) return Response.json(new Date(now).toISOString());
    if(url.pathname.endsWith('/lockdown_alerts_since')) return Response.json([]);
    throw new Error('unexpected RPC');
  });
  try {
    const result=await(await mf.dispatchFetch('http://localhost/__fixture_cron')).json();
    assert.deepEqual(calls,['/rest/v1/rpc/heartbeats','/rest/v1/rpc/ping','/rest/v1/rpc/lockdown_alerts_since']);
    assert.equal(result.sent.length,1);assert.equal(result.sent[0].kind,'stale_heartbeat');
    assert.equal(result.sent[0].job,'purge_participant_data');assert.ok(result.sent[0].ageS>=1800);
  } finally {await mf.dispose();}
});

test('native Worker facilitator RPC injection delivers forbidden once without duplicate metrics',{timeout:15000},async()=> {
  const secret=newCapabilityToken(),calls=[],actor=uuidv7();
  const authority=knownAccountFake({actors:[actor],origin:'https://postgrest.test'});
  const mf=await worker(async request=> {
    const url=new URL(request.url);assert.equal(url.origin,'https://postgrest.test');
    if(url.pathname==='/rest/v1/rpc/admin_account_active')return authority.fetchImpl(request.url,{method:request.method,headers:request.headers,body:await request.text()});
    assert.ok(['/rest/v1/rpc/get_me','/rest/v1/rpc/list_owned_active_sessions'].includes(url.pathname));calls.push(url.pathname);
    return Response.json({code:'42501',message:'private upstream'},{status:403});
  },secret);
  try {
    const jwt=await signTestJwt({sub:actor,iss:'https://postgrest.test/auth/v1',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+60},secret);
    for(const [path,rpc] of [['/api/v1/me','get_me'],['/api/v1/me/rooms','list_owned_active_sessions']]) {
      const before=calls.length,authorityBefore=authority.requests.length;
      const result=await(await mf.dispatchFetch(`http://localhost${path}`,{headers:{authorization:`Bearer ${jwt}`}})).json();
      assert.equal(result.status,500);assert.equal(result.text,JSON.stringify({error:'internal_error'}));
      assert.deepEqual(calls.slice(before),[`/rest/v1/rpc/${rpc}`]);
      assert.deepEqual(authority.requests.slice(authorityBefore).map(x=>({name:x.name,args:x.args})),[{name:'admin_account_active',args:{p_user_id:actor}}]);
      assert.deepEqual(result.sent,[{kind:'rpc_forbidden'}]);
      assert.deepEqual(result.points.map(p=>[p.blobs[0],p.doubles[0]]),[['rpc_forbidden',1]]);
    }
  }finally{await mf.dispose();}
});

test('native Worker unknown-code and malformed join refusals emit only fixed join failure reasons',{timeout:15000},async()=> {
  const mf=await worker();
  try {
    const body={v:1,code:newJoinCode(),displayName:'Private Name',avatarId:'shadows-01'};
    const request=async input=>(await mf.dispatchFetch('http://localhost/api/v1/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).json();
    const unknown=await request(body);
    assert.equal(unknown.status,404);assert.deepEqual(unknown.joinCalls,['coarse','lookup','challengeRequired','failChallenge']);
    assert.deepEqual(unknown.sent,[]);
    assert.deepEqual(unknown.points,[{blobs:['join_fail','staging','a'.repeat(40),'','unknown_code'],doubles:[1],indexes:['staging']}]);
    const malformed=await request({...body,v:2});
    assert.equal(malformed.status,400);assert.deepEqual(malformed.joinCalls,['coarse']);
    assert.deepEqual(malformed.sent,[]);
    assert.deepEqual(malformed.points,[{blobs:['join_fail','staging','a'.repeat(40),'','invalid'],doubles:[1],indexes:['staging']}]);
    const badJson=await(await mf.dispatchFetch('http://localhost/api/v1/join',{method:'POST',body:'not json'})).json();
    assert.equal(badJson.status,400);assert.deepEqual(badJson.joinCalls,['coarse']);assert.deepEqual(badJson.sent,[]);
    assert.deepEqual(badJson.points,malformed.points);
  }finally{await mf.dispose();}
});
test('native Worker coarse-rate and verifier-outage fallback joins retain exact fixed failure metrics',{timeout:15000},async()=> {
  const mf=await worker(async request=>{
    assert.equal(new URL(request.url).origin,'https://challenges.cloudflare.com');
    assert.equal(new URL(request.url).pathname,'/turnstile/v0/siteverify');
    return new Response(null,{status:503});
  });
  try {
    const body={v:1,code:newJoinCode(),displayName:'Private Name',avatarId:'shadows-01',turnstileToken:newCapabilityToken()};
    for(const [header,order] of [['x-fixture-coarse',['coarse']],['x-fixture-blocked',['coarse','lookup','challengeRequired','blocked']]]) {
      const result=await(await mf.dispatchFetch('http://localhost/api/v1/join',{method:'POST',headers:{'content-type':'application/json',[header]:'1'},body:JSON.stringify(body)})).json();
      assert.equal(result.status,429);assert.deepEqual(result.joinCalls,order);assert.deepEqual(result.sent,[]);
      const ratePoint={blobs:['join_fail','staging','a'.repeat(40),'','rate_limited'],doubles:[1],indexes:['staging']};
      const outagePoint={blobs:['turnstile_failopen','staging','a'.repeat(40),'',''],doubles:[1],indexes:['staging']};
      assert.deepEqual(result.points,header==='x-fixture-blocked'?[outagePoint,ratePoint]:[ratePoint]);
    }
  }finally{await mf.dispose();}
});
