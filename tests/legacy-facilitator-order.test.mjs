import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { gzipSync, brotliCompressSync, deflateSync, gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { uuidv7, isUuidV7 } from '../src/shared/ids.mjs';
const source = readFileSync(new URL('./helpers/legacy-facilitator.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  const created = ', source.indexOf('export async function openLegacyRoom'));
const end = source.indexOf('  const opened = context.waitForEvent', start);
assert.ok(start > 0 && end > start);
// Execute the actual helper section, including registration before the real Start click.
const creation = new Function('page', 'harness', `return (async () => {${source.slice(start, end)} return room;})()`);
const captureStart = source.indexOf('export function legacyCreationCapture('), captureEnd = source.indexOf('\nasync function oldShell', captureStart);
function capture(timeout=1000) {
 assert.ok(captureStart>=0 && captureEnd>captureStart, 'actual passive response capture must exist');
 return new Function('Buffer','TextDecoder','setTimeout','clearTimeout','isUuidV7','gunzipSync','brotliDecompressSync','inflateSync',
  `${source.slice(captureStart,captureEnd).replace('export function','function')} return legacyCreationCapture;`)(
  Buffer,TextDecoder,setTimeout,clearTimeout,isUuidV7,gunzipSync,brotliDecompressSync,inflateSync)(timeout);
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const body = {sessionId:uuidv7(),facilitatorToken:'local-fixture-only',joinCode:'7K3QX9',expiresAt:'2026-10-08T12:00:00.000Z'};
const bytes=()=>Buffer.from(JSON.stringify(body));
function stream({status=201,encoding=null}={}) {
 const result=new EventEmitter();result.statusCode=status;result.headers=encoding?{'content-encoding':encoding}:{};result.complete=false;
 result.send=data=>{result.emit('data',data);result.complete=true;result.emit('end');result.emit('close');};return result;
}
const observe=(c,result,method='POST',path='/api/v1/sessions')=>c.observe({method},path,result);
function fixture({failure=false}={}) {
 const c=capture();let registered=false,writes=0,reads=0,predicate;
 const response={request:()=>({method:()=> 'POST'}),url:()=> 'http://127.0.0.1/api/v1/sessions',status:()=>201,
  json:()=>{reads++;return Promise.reject(new Error('Protocol error Network.getResponseBody: body unavailable'));}};
 const page={waitForResponse:check=>{predicate=check;return new Promise(resolve=>page.arrived=resolve);}};
 const harness={shell:{waitForCreatedRoom(){registered=true;return c.waitForCreatedRoom();}}};
 const click=async()=>{
  assert.ok(registered || predicate, 'creation waiter must precede the original click');writes++;
  const original=stream();observe(c,original);
  if(failure)original.emit('error',new Error('private upstream diagnostic'));else original.send(bytes());
  page.arrived?.(response);await nextTurn();
 };
 page.locator=selector=>{assert.equal(selector,'.library-list');return {getByRole(role,options){assert.equal(role,'link');assert.equal(options.name,'Published case');return {async click(){assert.equal(writes,0);}};}};};
 page.getByRole=(role,options)=>{assert.equal(role,'button');assert.equal(options.name,'Start room');return {click};};
 return {page,harness,get writes(){return writes;},get reads(){return reads;}};
}
test('exact helper captures the original 201 before the click settles even when browser body lookup fails',async()=>{
 const f=fixture();assert.deepEqual(await creation(f.page,f.harness),body);
 assert.equal(f.writes,1);assert.equal(f.reads,0);
});
test('exact helper preserves original upstream body failure after pending click without manufacturing a room',async()=>{
 const f=fixture({failure:true});await assert.rejects(creation(f.page,f.harness),{message:'local_creation_response_unavailable'});
 assert.equal(f.writes,1);assert.equal(f.reads,0);
});
test('passive capture binds the first original POST/path response, refuses status and parses exact bytes',async()=>{
 const c=capture(),p=c.waitForCreatedRoom();assert.throws(()=>c.waitForCreatedRoom(),/local_creation_waiter_exists/);
 for(const [method,path] of [['GET','/api/v1/sessions'],['POST','/api/v1/other']]){const ignored=stream();observe(c,ignored,method,path);ignored.send(bytes());}
 const real=stream();observe(c,real);const replacement=stream();observe(c,replacement);replacement.send(Buffer.from('{}'));
 const wire=bytes();real.emit('data',wire.subarray(0,15));real.emit('data',wire.subarray(15));real.complete=true;real.emit('end');real.emit('close');
 assert.deepEqual(await p,body);
 const refused=c.waitForCreatedRoom(),non201=stream({status:200});observe(c,non201);non201.send(bytes());
 await assert.rejects(refused,{message:'local_creation_response_invalid'});
});
test('passive capture handles native encodings, exact byte ceiling and rejects malformed body/encoding/shape',async()=>{
 for(const [encoding,encode] of [['gzip',gzipSync],['br',brotliCompressSync],['deflate',deflateSync],['identity',x=>x]]){
  const c=capture(),p=c.waitForCreatedRoom(),r=stream({encoding});observe(c,r);r.send(encode(bytes()));assert.deepEqual(await p,body);
 }
 const padded=Buffer.concat([bytes(),Buffer.alloc(65536-bytes().length,32)]),boundary=capture(),accepted=boundary.waitForCreatedRoom(),r=stream();observe(boundary,r);r.send(padded);assert.deepEqual(await accepted,body);
 const failures=[
  [Buffer.alloc(65537,32),null],[gzipSync(Buffer.alloc(65537,32)),'gzip'],[bytes(),'unknown'],[bytes(),'toString'],
  [Buffer.from('{'),null],[Buffer.from([0xff]),null],[Buffer.from(JSON.stringify({...body,sessionId:'invalid'})),null],
  [Buffer.from(JSON.stringify({...body,joinCode:'not-code'})),null],[Buffer.from(JSON.stringify({...body,facilitatorToken:''})),null],
  [Buffer.from(JSON.stringify({...body,expiresAt:'invalid'})),null],[Buffer.from(JSON.stringify({...body,privateValue:'never accepted'})),null],
 ];
 for(const [data,encoding] of failures){const c=capture(),p=c.waitForCreatedRoom(),r=stream({encoding});observe(c,r);r.send(data);await assert.rejects(p,{message:'local_creation_response_invalid'});}
});
test('passive capture bounds timeout, closes pending reads and never lets late old bytes settle a new waiter',async()=>{
 const c=capture(5),old=c.waitForCreatedRoom(),oldStream=stream();observe(c,oldStream);
 await assert.rejects(old,{message:'local_creation_response_timeout'});
 const fresh=c.waitForCreatedRoom(),freshStream=stream();observe(c,freshStream);oldStream.send(Buffer.from('{}'));freshStream.send(bytes());assert.deepEqual(await fresh,body);
 for(const event of ['error','aborted','close']){const c=capture(),p=c.waitForCreatedRoom(),r=stream();observe(c,r);r.emit(event,new Error('private detail'));await assert.rejects(p,{message:'local_creation_response_unavailable'});}
 const closing=capture(),pending=closing.waitForCreatedRoom();closing.close();await assert.rejects(pending,{message:'local_creation_response_unavailable'});
});
test('actual proxy observes before forwarding the unchanged original stream; no alternative creation fetch exists',()=>{
 const callback=source.slice(source.indexOf('const proxy = httpRequest'),source.indexOf("const file = ['/'"));
 assert.match(callback,/creation\.observe\(request, path, result\);\s*response\.writeHead\(result\.statusCode, result\.headers\); result\.pipe\(response\)/);
 assert.equal((callback.match(/httpRequest\(/g)||[]).length,1);
 assert.doesNotMatch(source.slice(start,end),/waitForResponse|response\.json|fetch\(/);
});
