import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureTabFrame} from '../src/client/issue-capture.mjs';

function fixture({play=async()=>{},encode,dimensions=[800,450]}={}){
 const stops=[0,0],tracks=stops.map((_,i)=>({stop(){stops[i]++;}})),stream={getTracks:()=>tracks,getVideoTracks:()=>[tracks[0]]};
 const video={videoWidth:dimensions[0],videoHeight:dimensions[1],play,pause(){},remove(){},srcObject:null};
 let draws=0;const canvas={width:0,height:0,getContext:()=>({drawImage(){draws++;}}),toBlob:encode??((callback,type)=>callback(new Blob(['frame'],{type})))};
 return{stream,stops,video,canvas,doc:{createElement:tag=>tag==='video'?video:canvas},get draws(){return draws;}};
}
test('native capture starts in the click turn, asks for no audio and stops every track before encoding',async()=>{
 const f=fixture({encode(callback,type){assert.deepEqual(f.stops,[1,1]);callback(new Blob(['frame'],{type}));}});let called=false;
 const result=captureTabFrame({doc:f.doc,mediaDevices:{getDisplayMedia(options){called=true;assert.deepEqual(options,{video:true,audio:false,preferCurrentTab:true});return Promise.resolve(f.stream);}}});
 assert.equal(called,true);const frame=await result;assert.equal(frame.state,'captured');assert.equal(frame.blob.type,'image/png');assert.equal(f.draws,1);assert.deepEqual(f.stops,[1,1]);assert.equal(f.video.srcObject,null);assert.equal(f.canvas.width,0);assert.equal(frame.width,800);
});
test('permission denial and unsupported capture are explicit text-only outcomes',async()=>{
 assert.deepEqual(await captureTabFrame({mediaDevices:{}}),{state:'unavailable'});
 assert.deepEqual(await captureTabFrame({mediaDevices:{getDisplayMedia(){throw Object.assign(new Error(),{name:'NotAllowedError'});}}}),{state:'cancelled'});
});
test('a chooser resolving after timeout stops its late stream and never draws a frame',async()=>{
 const f=fixture();let resolve;const result=await captureTabFrame({doc:f.doc,timeoutMs:5,mediaDevices:{getDisplayMedia:()=>new Promise(r=>resolve=r)}});
 assert.deepEqual(result,{state:'timeout'});resolve(f.stream);await new Promise(r=>setImmediate(r));assert.deepEqual(f.stops,[1,1]);assert.equal(f.draws,0);
});
test('aborting a draft during a stuck video play stops tracks immediately',async()=>{
 const controller=new AbortController();const f=fixture({play:()=>new Promise(()=>{})});const result=captureTabFrame({doc:f.doc,signal:controller.signal,mediaDevices:{getDisplayMedia:async()=>f.stream}});
 await new Promise(r=>setImmediate(r));controller.abort();assert.deepEqual(f.stops,[1,1]);assert.deepEqual(await result,{state:'cancelled'});assert.equal(f.draws,0);
});
test('an account-generation change rejects a late chooser result without drawing',async()=>{
 const f=fixture();let current=true,resolve;const result=captureTabFrame({doc:f.doc,isCurrent:()=>current,mediaDevices:{getDisplayMedia:()=>new Promise(r=>resolve=r)}});
 current=false;resolve(f.stream);assert.deepEqual(await result,{state:'cancelled'});assert.deepEqual(f.stops,[1,1]);assert.equal(f.draws,0);
});
test('encoding timeout cannot leave a live capture stream',async()=>{
 const f=fixture({encode(){}});assert.deepEqual(await captureTabFrame({doc:f.doc,timeoutMs:5,mediaDevices:{getDisplayMedia:async()=>f.stream}}),{state:'timeout'});assert.deepEqual(f.stops,[1,1]);assert.equal(f.draws,1);
});
test('oversized native frames are refused before allocating a canvas or drawing',async()=>{
 const f=fixture({dimensions:[8193,450]});assert.deepEqual(await captureTabFrame({doc:f.doc,mediaDevices:{getDisplayMedia:async()=>f.stream}}),{state:'too_large'});assert.equal(f.draws,0);assert.deepEqual(f.stops,[1,1]);
});
test('an over-budget PNG gets one JPEG attempt and then refuses oversized evidence',async()=>{
 const formats=[];const f=fixture({encode(callback,type){formats.push(type);callback(new Blob(['oversized'],{type}));}});assert.deepEqual(await captureTabFrame({doc:f.doc,maxBytes:1,mediaDevices:{getDisplayMedia:async()=>f.stream}}),{state:'too_large'});assert.deepEqual(formats,['image/png','image/jpeg']);assert.deepEqual(f.stops,[1,1]);
});
