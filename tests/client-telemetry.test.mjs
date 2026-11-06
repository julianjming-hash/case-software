import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry } from '../src/client/telemetry.mjs';
import { apiPath } from '../src/shared/urls.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('client telemetry uses shared relative API path with anonymous fixed fields and omitted credentials',async()=> {
  const calls=[];const beacon=createTelemetry({origin:'https://case.test',api:'https://case.test',fetchImpl:async(...args)=>{calls.push(args);return new Response(null,{status:204});}});
  assert.equal(beacon({event:'transport_mode',transport:'ws'}),true);await tick();
  assert.equal(calls.length,1);assert.equal(calls[0][0],apiPath('telemetry'));
  const options=calls[0][1];assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');
  assert.equal(options.cache,'no-store');assert.equal(options.keepalive,true);assert.equal(options.referrerPolicy,'no-referrer');
  assert.deepEqual(options.headers,{'content-type':'application/json'});
  assert.deepEqual(JSON.parse(options.body),{event:'transport_mode',transport:'ws'});
});
test('client telemetry suppresses foreign API overrides and rejects private or server event fields',async()=> {
  let calls=0;const fetchImpl=async()=>{calls++;return new Response(null,{status:204});};
  for(const api of ['https://foreign.test','https://case.test/?private=1','https://name:token@case.test']) {
    const beacon=createTelemetry({origin:'https://case.test',api,fetchImpl});assert.equal(beacon({event:'sync_timeout'}),false);
  }
  const beacon=createTelemetry({origin:'https://case.test',fetchImpl});
  for(const bad of [{event:'rpc_forbidden'},{event:'sync_timeout',token:'private'},
    {event:'transport_pin',transport:'ws',network:'private'},{event:'transport_mode',transport:'private'},
    {event:'sync_timeout',transport:'ws'},null]) assert.equal(beacon(bad),false);
  const closed=createTelemetry({origin:'https://case.test',fetchImpl});
  assert.equal(closed({event:'sync_timeout'}),true);closed.close();
  assert.equal(closed({event:'sync_timeout'}),false);
  await tick();assert.equal(calls,0);
});
test('client telemetry bounds each fixed-kind send even when fetch ignores abort',{timeout:1000},async()=> {
  let now=0;const calls=[];
  const beacon=createTelemetry({origin:'https://case.test',now:()=>now,timeoutMs:10,
    fetchImpl:(...args)=>{calls.push(args);return new Promise(()=>{});}});
  try {
    assert.equal(beacon({event:'sync_timeout'}),true);await tick();
    now=500;assert.equal(beacon({event:'transport_pin',transport:'long-poll'}),true);
    now=1000;assert.equal(beacon({event:'sync_timeout'}),false);
    await new Promise(resolve=>setTimeout(resolve,20));assert.ok(calls.every(call=>call[1].signal.aborted));
    now=2000;assert.equal(beacon({event:'transport_pin',transport:'long-poll'}),true);
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls.length,3);
  } finally {beacon.close?.();}
});
test('client telemetry contains synchronous, rejected and unavailable send failures without exposing exceptions',async()=> {
  for(const fetchImpl of [undefined,()=>{throw new Error('private');},()=>Promise.reject(new Error('private'))]) {
    const beacon=createTelemetry({origin:'https://case.test',fetchImpl:fetchImpl??null});
    assert.doesNotThrow(()=>beacon({event:'sync_timeout'}));await tick();
  }
  assert.equal(createTelemetry({origin:'invalid',fetchImpl:()=>{throw new Error('must not fetch');}})({event:'sync_timeout'}),false);
});

test('client telemetry delivers distinct sync mode and pin events in the actual burst',async()=> {
  const calls=[];const beacon=createTelemetry({origin:'https://case.test',fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(null,{status:204});}});
  try {
    for(const event of [{event:'sync_timeout'},{event:'transport_mode',transport:'long-poll'},{event:'transport_pin',transport:'long-poll'}]) assert.equal(beacon(event),true);
    await tick();assert.deepEqual(calls,[{event:'sync_timeout'},{event:'transport_mode',transport:'long-poll'},{event:'transport_pin',transport:'long-poll'}]);
  }finally{beacon.close?.();}
});
test('client telemetry coalesces only the latest pending mode and flushes it finitely',{timeout:2500},async()=> {
  const calls=[];const beacon=createTelemetry({origin:'https://case.test',fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(null,{status:204});}});
  try {
    beacon({event:'transport_mode',transport:'ws'});await tick();
    assert.equal(beacon({event:'transport_mode',transport:'long-poll'}),true);
    assert.equal(beacon({event:'transport_mode',transport:'poll'}),true);
    await new Promise(resolve=>setTimeout(resolve,1550));
    assert.deepEqual(calls,[{event:'transport_mode',transport:'ws'},{event:'transport_mode',transport:'poll'}]);
  }finally{beacon.close?.();}
});
test('client telemetry rate budget admits at most120 attempts per minute across fixed three kinds',async()=> {
  let now=0;const calls=[];const beacon=createTelemetry({origin:'https://case.test',now:()=>now,fetchImpl:async(url,options)=>{calls.push({at:now,event:JSON.parse(options.body).event});return new Response(null,{status:204});}});
  try {
    for(now=0;now<60000;now+=100) {
      beacon({event:'transport_mode',transport:now%200?'ws':'poll'});
      beacon({event:'transport_pin',transport:'long-poll'});beacon({event:'sync_timeout'});await tick();
    }
    assert.equal(calls.length,120);
    for(const event of ['transport_mode','transport_pin','sync_timeout']) {
      const group=calls.filter(call=>call.event===event);assert.equal(group.length,40);
      for(let i=1;i<group.length;i++) assert.ok(group[i].at-group[i-1].at>=1500);
    }
    beacon.close();const count=calls.length;await tick();assert.equal(calls.length,count);
  }finally{beacon.close?.();}
});
