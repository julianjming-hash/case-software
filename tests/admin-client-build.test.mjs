import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildClient} from '../scripts/build-client.mjs';
import {HTML_CSP} from '../src/worker/headers.mjs';
async function built(check){const temp=await mkdtemp(join(tmpdir(),'case-admin-build-'));try{const result=await buildClient({outDir:join(temp,'dist')});await check(join(temp,'dist'),result);}finally{await rm(temp,{recursive:true,force:true});}}
test('CASE-364 Admin uses the shared noindex shell and lazy measured Admin module/styles',async()=>built(async(dir,result)=>{
 assert.ok(result.entries.admin,'admin entry must be measured');
 const html=await readFile(join(dir,'admin.html'),'utf8');assert.match(html,/<meta name="robots" content="noindex,nofollow">/);assert.ok(html.includes(result.entries.app));assert.ok(!html.includes(result.entries.admin),'Admin module remains behind private admission');assert.ok(!html.includes(result.entries['admin-css']),'Admin stylesheet is lazy');
 const consoleSource=await readFile(join(dir,result.entries.console),'utf8');assert.ok(consoleSource.includes(result.entries.admin));assert.doesNotMatch(consoleSource,/\/assets\/console-manual\.[a-f0-9]{64}\.mjs/,'saved-note recovery must not eagerly import the manual room engine');assert.ok(consoleSource.includes(result.entries['admin-css']),'build substitutes the trusted hashed stylesheet URL');
 const app=await readFile(join(dir,result.entries.app),'utf8');assert.ok(!/admin(?:[-.]|\.mjs)/.test(app),'public app never imports admin code');
}));
test('Card21b admin route has its own exact HTML rewrite without a catch-all',async()=>built(async(dir)=>{
 const redirects=(await readFile(join(dir,'_redirects'),'utf8')).split('\n');assert.ok(redirects.includes('/admin /admin.html 200'));assert.ok(!redirects.some(line=>line.startsWith('/* ')));
}));
test('Card21b both admin document paths have strict no-store HTML CSP',async()=>built(async(dir)=>{
 const headers=await readFile(join(dir,'_headers'),'utf8');
 for(const route of ['/admin','/admin.html']){const block=headers.split('\n\n').find(value=>value.startsWith(route+'\n'));assert.ok(block,route);assert.ok(block.includes(`content-security-policy: ${HTML_CSP}`));assert.ok(block.includes('cache-control: no-store'));}
}));
