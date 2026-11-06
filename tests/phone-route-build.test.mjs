import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClient } from '../scripts/build-client.mjs';
import { HTML_CSP } from '../src/worker/headers.mjs';
for(const route of ['/join','/privacy','/help']) test(`built participant ${route} has its exact shell rewrite and strict HTML policy`,async()=>{
 const parent=await mkdtemp(join(tmpdir(),'case-phone-route-')),outDir=join(parent,'assets');
 try{
  await buildClient({outDir});
  const redirects=await readFile(join(outDir,'_redirects'),'utf8'),headers=await readFile(join(outDir,'_headers'),'utf8');
  assert.ok(redirects.split('\n').includes(`${route} /index.html 200`));
  const block=headers.split('\n\n').find(block=>block.startsWith(route+'\n'));
  assert.ok(block);assert.ok(block.includes(`content-security-policy: ${HTML_CSP}`));assert.ok(block.includes('cache-control: no-store'));
 }finally{await rm(parent,{recursive:true,force:true});}
});
