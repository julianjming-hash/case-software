import { newCapabilityToken } from '../src/shared/ids.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createObserver, normalizeAlert, ARCHIVE_LAG_ALERT_S, observedRpc } from '../src/worker/observability.mjs';
function fixture(send=async()=>({ok:true})) {
  const sent=[],points=[],retained=[];
  const env={CASE_ENV:'staging',BUILD_SHA:'a'.repeat(40),METRICS:{writeDataPoint:p=>points.push(p)},
    ALERTS:{idFromName:name=>{assert.equal(name,'alerts');return name;},get:(id,options)=>{
      assert.equal(id,'alerts');assert.deepEqual(options,{locationHint:'oc'});
      return {send:event=>{sent.push(event);return send(event);}};
    }}};
  return {sent,points,retained,observer:createObserver(env,{waitUntil:p=>retained.push(p)})};
}
test('observer maps trusted producer hooks into fixed alert labels and discards RPC metadata',async()=> {
  const run=fixture();
  for(const event of [{kind:'forbidden',code:'42501',name:'get_me'},{kind:'unavailable',code:'timeout',name:'ping'},
    {kind:'archive_deleted_unsent',counts:{participants:2,responses:3,journal:4}},
    {job:'purge_participant_data',ageS:1801},{kind:'lockdown_alert'},{kind:'healthcheck_failed'},
    {kind:'invalid_heartbeat'},{kind:'case_version_integrity'},{kind:'supabase_unreachable'},
    {kind:'rpc_forbidden',name:'get_me'}]) await run.observer.alert(event);
  assert.deepEqual(run.sent,[{kind:'rpc_forbidden'},{kind:'supabase_unavailable'},
    {kind:'delete_before_archive',counts:{participants:2,responses:3,journal:4}},
    {kind:'stale_heartbeat',job:'purge_participant_data',ageS:1801},{kind:'lockdown_alert'},
    {kind:'healthcheck_failed'},{kind:'cron_failure'},{kind:'case_version_integrity'},{kind:'supabase_unavailable'},{kind:'rpc_forbidden'}]);
  assert.deepEqual(run.points.map(p=>[p.blobs[0],p.doubles[0]]),[['rpc_forbidden',1],['supabase_unavailable',1],['delete_before_archive',9],['supabase_unavailable',1],['rpc_forbidden',1]]);
  assert.equal(normalizeAlert({kind:'forbidden',name:'private',token:'private'}),null);
  assert.equal(normalizeAlert({kind:'private'}),null);
});
test('optional observer retains pending alert work without blocking caller or exposing failures',async()=> {
  let finish;const run=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=run.observer.alert({kind:'archive_fail'});
  assert.equal(run.sent.length,1);assert.equal(run.retained.length,1);
  finish({ok:false});assert.deepEqual(await pending,{ok:false});
  const throwing=fixture(()=>{throw new Error('private');});
  assert.deepEqual(await throwing.observer.alert({kind:'rpc_forbidden'}),{ok:false});
});
test('required cron alert delivery treats busy or failed admission as non-success and confirmed dedup as success',async()=> {
  for(const response of [{ok:false},{ok:false,kind:'busy'}]) {
    const run=fixture(async()=>response);
    await assert.rejects(run.observer.alert({kind:'lockdown_alert'},{required:true}),{message:'alert_delivery_failed'});
  }
  const run=fixture(async()=>({ok:true,suppressed:true}));
  assert.deepEqual(await run.observer.alert({kind:'lockdown_alert'},{required:true}),{ok:true,suppressed:true});
});
test('archive lag alerts only above approved 120 seconds while every eligible lag is measured',async()=> {
  const run=fixture();assert.equal(ARCHIVE_LAG_ALERT_S,120);
  for(const lag of [0,119.999,120]) await run.observer.archiveLag(lag);
  assert.equal(run.sent.length,0);
  await run.observer.archiveLag(120.001);
  assert.deepEqual(run.sent,[{kind:'archive_lag_s',value:120.001}]);
  assert.deepEqual(run.points.map(p=>[p.blobs[0],p.doubles[0]]),[0,119.999,120,120.001].map(value=>['archive_lag_s',value]));
});
test('observer rejects unknown fields and invalid lag and fails closed without an alert binding',async()=> {
  const run=fixture();
  assert.deepEqual(await run.observer.alert({kind:'delete_before_archive',counts:{participants:1,name:'private'}}),{ok:false});
  for(const value of [NaN,-1,Infinity,'300']) assert.deepEqual(await run.observer.archiveLag(value),{ok:false});
  assert.deepEqual(run.sent,[]);assert.deepEqual(run.points,[]);
  const missing=createObserver({});
  assert.deepEqual(await missing.alert({kind:'archive_fail'}),{ok:false});
  await assert.rejects(missing.alert({kind:'lockdown_alert'},{required:true}),{message:'alert_delivery_failed'});
});

test('request RPC observation stays lazy and preserves unavailable receipts with one fixed callback',async()=> {
  const sent=[];
  const lazy=observedRpc({}, {alert:event=>sent.push(event)});
  assert.ok(lazy);assert.throws(()=>lazy.call('ping'),{name:'ConfigError'});
  const config={SUPABASE_URL:'https://postgrest.test/',SUPABASE_SECRET_KEY:`sb_secret_${newCapabilityToken()}`};
  const rpc=observedRpc(config,{alert:event=>{sent.push(event);return new Promise(()=>{});}},{fetchImpl:async()=>Response.json({message:'private'},{status:503})});
  assert.deepEqual(await rpc.call('ping'),{ok:false,kind:'unavailable',status:503,code:null});
  assert.deepEqual(sent,[{kind:'unavailable',code:null,name:'ping'}]);
});
