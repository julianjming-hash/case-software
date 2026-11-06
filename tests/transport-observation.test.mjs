import test from 'node:test';
import assert from 'node:assert/strict';
import { connect,testLifecycle } from '../src/client/transport.mjs';
import { uuidv7,newCapabilityToken } from '../src/shared/ids.mjs';
import { PING_FRAME,PONG_FRAME } from '../src/shared/wire.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Socket {
  listeners=new Map();
  constructor(){queueMicrotask(()=>this.fire('open'));}
  addEventListener(kind,fn){this.listeners.set(kind,[...(this.listeners.get(kind)??[]),fn]);}
  fire(kind,data){for(const fn of this.listeners.get(kind)??[]) fn({data});}
  send(text){
    if(text===PING_FRAME) queueMicrotask(()=>this.fire('message',PONG_FRAME));
    else if(JSON.parse(text).t==='hello') queueMicrotask(()=>this.fire('message',JSON.stringify({v:1,t:'welcome'})));
  }
  close(){this.fire('close');}
}
const options=()=>({role:'participant',api:'https://case.test',sessionId:uuidv7(),token:newCapabilityToken(),
  storage:null,persistentStorage:null,lifecycle:testLifecycle(),WebSocketImpl:Socket,
  timings:{HEARTBEAT_MS:10,DEAD_AFTER_MS:1000,SYNC_MS:10,SYNC_TIMEOUT_MS:20,
    RECONNECT_BASE_MS:10,RECONNECT_MAX_MS:10,WS_FAILURES_TO_FALL_BACK:100},
  fetchImpl:async()=>{await sleep(5);return Response.json({v:1,t:'snapshot',epoch:0,revision:1,displayRevision:1,view:{}});}});
test('transport reports only its initial fixed mode without credential or network metadata',()=> {
  const events=[];const link=connect({role:'display',api:'https://case.test',storage:null,persistentStorage:null,lifecycle:testLifecycle(),telemetryImpl:event=>events.push(event)});
  try{assert.deepEqual(events,[{event:'transport_mode',transport:'long-poll'}]);}finally{link.close();}
});
test('transport observes real missing sync replies and pin transition without changing callback order',{timeout:1500},async()=> {
  const events=[],order=[];const link=connect({...options(),telemetryImpl:event=>{events.push(event);order.push(event.event+':'+(event.transport??''));}});
  link.on('pinned',()=>order.push('pinned-callback'));
  link.on('status',(status,{mode})=>order.push('status:'+mode));
  try {
    const end=Date.now()+1000;
    while(!link.pinned && Date.now()<end) await sleep(5);
    assert.equal(link.pinned,true);
    assert.equal(events.filter(event=>event.event==='sync_timeout').length,2);
    assert.deepEqual(events.filter(event=>event.event==='transport_pin'),[{event:'transport_pin',transport:'long-poll'}]);
    assert.deepEqual(events.filter(event=>event.event==='transport_mode'),[{event:'transport_mode',transport:'ws'},{event:'transport_mode',transport:'long-poll'}]);
    assert.ok(order.indexOf('pinned-callback')<order.indexOf('transport_pin:long-poll'));
    assert.ok(order.indexOf('status:long-poll')<order.indexOf('transport_mode:long-poll'));
    for(const event of events) assert.ok(Object.keys(event).every(key=>key==='event'||key==='transport'));
  }finally{link.close();}
});
test('transport contains observer and user callback failures with a fixed log while preserving later callbacks',{timeout:1000},async()=> {
  const logs=[];let delivered=0,observed=0;const original=console.error;
  console.error=(...args)=>logs.push(args);
  let link;
  try {
    link=connect({...options(),telemetryImpl:()=>{observed++;throw new Error('private telemetry');}});
    link.on('welcome',()=>{throw new Error('private callback');}).on('welcome',()=>delivered++);
    const end=Date.now()+500;while(!delivered&&Date.now()<end)await sleep(5);
    assert.ok(observed>=1);assert.equal(delivered,1);assert.deepEqual(logs,[['transport_callback_error']]);
  }finally{link?.close();console.error=original;}
});
