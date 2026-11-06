import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
const load = () => import('../src/client/phone-telemetry.mjs');
const view = (sessionId, id=uuidv7()) => ({role:'participant',sessionId,you:{id}});

test('participant telemetry makes no reporter or POST before actual same-room identity and emits only its current fixed mode after confirmation', async () => {
  const { createParticipantTelemetry } = await load();
  const room=uuidv7(), events=[];let factories=0;
  const observe=createParticipantTelemetry({createReporter:()=>{factories++;return event=>events.push(event);}});
  observe({event:'transport_mode',transport:'ws'});
  observe({event:'transport_pin',transport:'long-poll'});
  observe({event:'sync_timeout'});
  observe({event:'transport_mode',transport:'long-poll'});
  for(const input of [null,{role:'display',sessionId:room,you:{id:uuidv7()}},view(uuidv7()),view(room,'bad'),{...view(room),you:{id:uuidv7(),removed:true}}])assert.equal(observe.confirm(input,room),false);
  assert.equal(factories,0);assert.deepEqual(events,[]);
  assert.equal(observe.confirm(view(room),room),true);
  assert.equal(factories,1);assert.deepEqual(events,[{event:'transport_mode',transport:'long-poll'}]);
  observe.confirm(view(room),room);assert.equal(factories,1);assert.equal(events.length,1);
  observe({event:'transport_mode',transport:'poll'});observe({event:'transport_pin',transport:'long-poll'});observe({event:'sync_timeout'});
  assert.deepEqual(events.slice(1),[{event:'transport_mode',transport:'poll'},{event:'transport_pin',transport:'long-poll'},{event:'sync_timeout'}]);
});

test('participant telemetry rejects metadata unknown events and malformed modes without carrying identity into analytics', async () => {
  const { createParticipantTelemetry } = await load();const room=uuidv7(),events=[];
  const observe=createParticipantTelemetry({createReporter:()=>event=>events.push(event)});
  observe({event:'transport_mode',transport:'ws'});observe.confirm(view(room),room);
  for(const input of [{event:'transport_mode',transport:'ws',participantId:uuidv7()},{event:'transport_pin',transport:'hotel_wifi'},{event:'sync_timeout',token:'synthetic'},{event:'unknown'},{event:'sync_timeout',url:'/private'},null])assert.equal(observe(input),false);
  assert.deepEqual(events,[{event:'transport_mode',transport:'ws'}]);
});

test('participant telemetry closes reporter once and cannot resurrect after cancel while reporter failures never affect room work', async () => {
  const { createParticipantTelemetry } = await load();const room=uuidv7();let factories=0,closed=0;
  const reporter=()=>Promise.reject(Error('synthetic optional failure'));reporter.close=()=>{closed++;throw Error('synthetic close');};
  const observe=createParticipantTelemetry({createReporter:()=>{factories++;return reporter;}});
  observe({event:'transport_mode',transport:'ws'});assert.equal(observe.confirm(view(room),room),true);
  observe({event:'sync_timeout'});observe.close();observe.close();
  assert.equal(closed,1);assert.equal(observe.confirm(view(room),room),false);assert.equal(observe({event:'sync_timeout'}),false);assert.equal(factories,1);
  let neverFactories=0;const never=createParticipantTelemetry({createReporter:()=>{neverFactories++;return ()=>{};}});never.close();assert.equal(never.confirm(view(room),room),false);assert.equal(neverFactories,0);
  let attempts=0;const failed=createParticipantTelemetry({createReporter:()=>{attempts++;throw Error('optional factory');}});
  assert.equal(failed.confirm(view(room),room),false);assert.equal(failed.confirm(view(room),room),false);assert.equal(attempts,1);
  await new Promise(resolve=>setImmediate(resolve));
});
