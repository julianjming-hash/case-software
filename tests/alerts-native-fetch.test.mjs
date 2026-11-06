import { newCapabilityToken } from '../src/shared/ids.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function nativeAlerts(outbound) {
  const result=await build({stdin:{contents:`
    export { AlertDO } from './src/worker/alert-do.mjs';
    export default { async fetch(request, env) {
      const event=await request.json();
      const stub=env.ALERTS.get(env.ALERTS.idFromName('alerts'));
      return Response.json(await stub.send(event));
    }};`,resolveDir:root},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
  return new Miniflare(convertV4MiniflareOptions({script:result.outputFiles[0].text,modules:true,
    compatibilityDate:'2026-08-22',durableObjects:{ALERTS:{className:'AlertDO',useSQLite:true}},
    bindings:{CASE_ENV:'staging',BUILD_SHA:'a'.repeat(40),RESEND_ALERT_API_KEY:newCapabilityToken(),ALERT_EMAIL_TO:'operator@example.test'},
    outboundService:request=> {
      // All native fetches terminate in this local hook; nothing reaches the provider or DNS.
      assert.equal(new URL(request.url).origin,'https://api.resend.com');
      assert.equal(request.method,'POST');return outbound(request);
    },
  }));
}
async function send(mf,event) {
  const response=await mf.dispatchFetch('http://localhost/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});
  assert.equal(response.status,200);return response.json();
}
test('native AlertDO sends counts-only text through supported manual fetch and confirms durable dedup', {timeout:15_000}, async()=> {
  const writes=[];const mf=await nativeAlerts(async request=> {
    writes.push({path:new URL(request.url).pathname,body:await request.json()});return new Response(null,{status:202});
  });
  try {
    const event={kind:'delete_before_archive',counts:{participants:10,rounds:3,responses:15,journal:20,endSession:1}};
    assert.deepEqual(await send(mf,event),{ok:true});
    assert.deepEqual(await send(mf,event),{ok:true,suppressed:true});
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/emails');
    assert.deepEqual(Object.keys(writes[0].body).sort(),['from','html','subject','text','to']);
    assert.deepEqual(JSON.parse(writes[0].body.text),{event,env:'staging',build:'a'.repeat(40)});
    for (const [key, value] of Object.entries(event.counts)) assert.ok(writes[0].body.html.includes(`<b>${key}</b><br><span style="word-break:break-all;">${value}</span>`));
    assert.doesNotMatch(writes[0].body.html, /<script|<a\s|utm_/i);
  }finally{await mf.dispose();}
});
test('native AlertDO refuses redirected provider delivery without following or acknowledging dedup',{timeout:15_000},async()=> {
  const paths=[];const mf=await nativeAlerts(request=> {
    paths.push(new URL(request.url).pathname);
    return new Response(null,{status:302,headers:{location:'https://api.resend.com/redirected'}});
  });
  try {
    assert.deepEqual(await send(mf,{kind:'rpc_forbidden'}),{ok:false});
    assert.deepEqual(await send(mf,{kind:'rpc_forbidden'}),{ok:false});
    assert.deepEqual(paths,['/emails','/emails']);
  }finally{await mf.dispose();}
});
test('native pending AlertDO reports busy non-success then replays uncertain key after failed first delivery',{timeout:15_000},async()=> {
  let release;let ready;let arrivalTimer;const arrived=new Promise(resolve=>{ready=resolve;});const writes=[];
  const mf=await nativeAlerts(async request=> {
    writes.push({key:request.headers.get('idempotency-key'),body:await request.text()});
    if(writes.length===1){ready();return new Promise(resolve=>{release=resolve;});}
    return new Response(null,{status:202});
  });
  try {
    const event={kind:'lockdown_alert'};const pending=send(mf,event);
    await Promise.race([arrived,new Promise((_,reject)=> {arrivalTimer=setTimeout(()=>reject(new Error('native email hook not reached')),2000);})]);
    clearTimeout(arrivalTimer);
    assert.deepEqual(await send(mf,event),{ok:false,kind:'busy'});
    assert.equal(writes.length,1);
    release(new Response(null,{status:503}));assert.deepEqual(await pending,{ok:false});
    assert.deepEqual(await send(mf,event),{ok:true});
    assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
    assert.deepEqual(await send(mf,event),{ok:true,suppressed:true});
  }finally{clearTimeout(arrivalTimer);release?.(new Response(null,{status:503}));await mf.dispose();}
});
