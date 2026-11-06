import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalWorker } from './helpers/local-worker.mjs';
import { HTML_CSP } from '../src/worker/headers.mjs';
import { joinDocumentCsp } from '../src/worker/join-policy.mjs';

test('actual local Cloudflare assets apply exactly one join policy and preserve strict nonjoin documents', {timeout:30000}, async()=>{
 const worker=await startLocalWorker();
 try{
  for(const path of ['/join','/J/7K3QX9','/j/7k3qx9']){
   const response=await fetch(worker.origin+path);assert.equal(response.status,200);
   assert.equal(response.headers.get('content-security-policy'),joinDocumentCsp(HTML_CSP,path));
   assert.equal(response.headers.get('cache-control'),'no-store');
  }
  for(const path of ['/','/privacy','/help','/check','/P/7K3QX9','/D/7K3QX9','/sessions/room/play','/sessions/room/recap','/sessions/room/facilitate','/sw.mjs','/J/U12345','/J/7K3QX9%0A','/J/7K3QX9/child']){
   const response=await fetch(worker.origin+path);assert.equal(response.status,200);
   assert.equal(response.headers.get('content-security-policy'),HTML_CSP);
  }
 }finally{await worker.stop();}
});
