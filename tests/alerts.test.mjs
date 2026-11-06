import { newCapabilityToken } from '../src/shared/ids.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertDelivery, alertEvent, ALERT_DEDUP_MS } from '../src/worker/alerts.mjs';

const env = { CASE_ENV:'staging', BUILD_SHA:'a'.repeat(40), RESEND_ALERT_API_KEY:newCapabilityToken(), ALERT_EMAIL_TO:'operator@example.test' };
function memoryStore() {
  const rows = new Map();
  return {
    reserve(key, now, event, id, leaseMs) {
      const prior = rows.get(key);
      if (prior?.nextAt > now) return {dedup:true};
      if (prior?.leaseUntil > now) return null;
      const row = prior?.id ? prior : { id, event };
      row.leaseUntil=now+leaseMs; rows.set(key,row); return { ...row };
    },
    success(key, id, now) {
      if (rows.get(key)?.id === id) rows.set(key,{nextAt:now+ALERT_DEDUP_MS});
    },
    failure(key, id) { if (rows.get(key)?.id === id) rows.get(key).leaseUntil=0; },
  };
}
const eventCases = [
  { kind:'rpc_forbidden' }, { kind:'delete_before_archive', counts:{ participants:3, rounds:2, responses:4, journal:8, endSession:1 } },
  { kind:'stale_heartbeat', job:'keepalive', ageS:null }, { kind:'lockdown_alert' },
  { kind:'supabase_unavailable' }, { kind:'archive_fail' }, { kind:'archive_lag_s', value:300 },
  { kind:'case_version_integrity' }, { kind:'healthcheck_failed' }, { kind:'cron_failure' },
];
for (const event of eventCases) test(`alert ${event.kind} sends fixed text once per six hours without identifiers`, async () => {
  let now=1000; const writes=[];
  const delivery = new AlertDelivery({ env, store:memoryStore(), now:() => now,
    fetchImpl:async (url,init) => { writes.push({url,init}); return new Response(null,{status:202}); } });
  assert.deepEqual(await delivery.send(event), {ok:true});
  assert.deepEqual(await delivery.send(event), {ok:true,suppressed:true});
  now+=ALERT_DEDUP_MS-1;
  assert.deepEqual(await delivery.send(event), {ok:true,suppressed:true});
  assert.equal(writes.length,1);
  now++;
  assert.deepEqual(await delivery.send(event), {ok:true});
  assert.equal(writes.length,2);
  for (const {url,init} of writes) {
    assert.equal(url,'https://api.resend.com/emails'); assert.equal(init.redirect,'manual');
    const body=JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(),['from','html','subject','text','to']);
    assert.equal(body.from,'noreply@iatrogenic.app'); assert.deepEqual(body.to,['operator@example.test']);
    assert.equal(body.subject,`Case staging: ${event.kind}`);
    assert.match(body.html, /An operational alert needs review/);
    assert.ok(body.html.includes(event.kind));
    assert.doesNotMatch(body.html, /<script|<a\s/);
    assert.deepEqual(JSON.parse(body.text),{event,env:'staging',build:'a'.repeat(40)});
  }
});
test('alert schema rejects identifiers and unknown fields including inside counts', () => {
  for (const input of [null,{kind:'private'},{kind:'rpc_forbidden',token:'private'},
    {kind:'rpc_forbidden',sessionId:'private'}, {kind:'rpc_forbidden',name:'private'},
    {kind:'delete_before_archive',counts:{participants:1,answer:'private'}},
    {kind:'delete_before_archive',counts:{participants:-1}},
    {kind:'stale_heartbeat',job:'private',ageS:2},{kind:'archive_lag_s',value:NaN}])
    assert.equal(alertEvent(input),null);
  assert.deepEqual(alertEvent({kind:'stale_heartbeat',job:'purge_participant_data',ageS:100}),
    {kind:'stale_heartbeat',job:'purge_participant_data',ageS:100});
});
test('concurrent busy alert never reports success before the first acknowledgement', async () => {
  let resolve; const response=new Promise(r => {resolve=r;}); let calls=0;
  const delivery=new AlertDelivery({env,store:memoryStore(),fetchImpl:() => {calls++;return response;}});
  const pending=delivery.send({kind:'rpc_forbidden'});
  assert.deepEqual(await delivery.send({kind:'rpc_forbidden'}),{ok:false,kind:'busy'});
  assert.equal(calls,1);resolve(new Response(null,{status:202}));assert.deepEqual(await pending,{ok:true});
});
test('uncertain delivery retries the same idempotency key and frozen payload rather than following redirects', async () => {
  const attempts=[]; const store=memoryStore(); let attempt=0;
  const delivery=new AlertDelivery({env,store,fetchImpl:async (url,init) => {
    attempts.push({url,init}); if (attempt++===0) return new Response(null,{status:302,headers:{location:'https://private.test/'}});
    return new Response(null,{status:202});
  }});
  assert.deepEqual(await delivery.send({kind:'archive_lag_s',value:100}),{ok:false});
  assert.deepEqual(await delivery.send({kind:'archive_lag_s',value:200}),{ok:true});
  assert.equal(attempts.length,2);assert.equal(attempts[0].init.body,attempts[1].init.body);
  assert.equal(attempts[0].init.headers['idempotency-key'],attempts[1].init.headers['idempotency-key']);
  assert.ok(attempts[0].init.headers['idempotency-key']);
});
test('alert deadline bounds ignored abort and failures never contain secret or upstream content', async () => {
  let signal;
  const delivery=new AlertDelivery({env,store:memoryStore(),timeoutMs:15,fetchImpl:(_url,init)=> {
    signal=init.signal;return new Promise(()=>{});
  }});
  const result=await Promise.race([delivery.send({kind:'lockdown_alert'}),new Promise(resolve=>setTimeout(()=>resolve('unbounded'),200))]);
  assert.deepEqual(result,{ok:false}); assert.equal(signal.aborted,true);
  const throwing=new AlertDelivery({env,store:memoryStore(),fetchImpl:()=> {throw new Error('private');}});
  assert.deepEqual(await throwing.send({kind:'rpc_forbidden'}),{ok:false});
});
test('unconfigured or invalid alert payload fails closed before contacting email provider', async () => {
  let calls=0;const fetchImpl=()=> {calls++;throw new Error('unexpected');};
  const { ALERT_EMAIL_TO: _recipient, ...noRecipient } = env; // the secret not yet set
  for (const bindings of [{},noRecipient,{...env,ALERT_EMAIL_TO:''},{...env,ALERT_EMAIL_TO:'operator@example.test\nprivate'}]) {
    assert.deepEqual(await new AlertDelivery({env:bindings,store:memoryStore(),fetchImpl}).send({kind:'lockdown_alert'}),{ok:false});
  }
  assert.deepEqual(await new AlertDelivery({env,store:memoryStore(),fetchImpl}).send({kind:'rpc_forbidden',token:'private'}),{ok:false});
  assert.equal(calls,0);
});

test('busy alert cannot mask the unacknowledged delivery failure as a successful dedup', async () => {
  let resolve;
  const delivery=new AlertDelivery({env,store:memoryStore(),fetchImpl:()=>new Promise(r=>{resolve=r;})});
  const pending=delivery.send({kind:'lockdown_alert'});
  const busy=await delivery.send({kind:'lockdown_alert'});
  assert.deepEqual(busy,{ok:false,kind:'busy'});
  resolve(new Response(null,{status:503}));
  assert.deepEqual(await pending,{ok:false});
});
