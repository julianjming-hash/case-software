import test from 'node:test';
import assert from 'node:assert/strict';
import {readAdminFixtureBody} from './helpers/admin-worker.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(()=>resolve('still_pending'),ms));
function heldBody(chunk){
 let controller,cancelled=false;
 const body=new ReadableStream({start(value){controller=value;if(chunk)controller.enqueue(chunk);},cancel(){cancelled=true;}});
 return {request:new Request('https://fixture.invalid',{method:'POST',body,duplex:'half'}),get cancelled(){return cancelled;},release(){try{controller.close();}catch{/* cancelled */}}};
}
test('Card21b outbound fixture rejects an oversized streamed body before waiting for its tail and cancels it',async()=>{
 const source=heldBody(new Uint8Array(65537));
 try{const result=await Promise.race([readAdminFixtureBody(source.request,{timeoutMs:1000}),delay(80)]);assert.equal(result,null);assert.equal(source.cancelled,true);}finally{source.release();}
});
test('Card21b outbound fixture bounds the whole stalled body and contains nonsettling cancellation',async()=>{
 let controller,cancelled=false;
 const body=new ReadableStream({start(value){controller=value;controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;return new Promise(()=>{});}});
 const request=new Request('https://fixture.invalid',{method:'POST',body,duplex:'half'});
 try{const result=await Promise.race([readAdminFixtureBody(request,{timeoutMs:10}),delay(80)]);assert.equal(result,null);assert.equal(cancelled,true);}finally{try{controller.close();}catch{/* cancelled */}}
});
