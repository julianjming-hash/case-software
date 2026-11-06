import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('Card21b offline administration restores only its public document and excludes private APIs',async()=>{
 const handlers={},stored=new Map([['/admin.html',new Response('public admin shell')],['/index.html',new Response('public participant shell')]]);
 const self={location:new URL('http://case.test/sw.mjs'),addEventListener:(type,handler)=>handlers[type]=handler};
 const code=readFileSync(new URL('../src/client/sw.mjs',import.meta.url),'utf8').replace('/*__SHELL__*/[]',JSON.stringify([...stored.keys()]));
 runInNewContext(code,{self,caches:{open:async()=>({match:async key=>stored.get(key)?.clone()})},URL,Request,Response,Set,Promise,AbortController,setTimeout,clearTimeout,fetch:async()=>{throw new TypeError('offline');}});
 const request=async(path,method='GET')=>{let result;handlers.fetch({request:new Request(`http://case.test${path}`,{method}),respondWith:value=>result=value});return result===undefined?undefined:await result;};
 for(const path of ['/admin','/admin.html'])assert.equal(await (await request(path))?.text(),'public admin shell',path);
 for(const path of ['/api/v1/admin/facilitators','/api/v1/admin/audit','/admin/private.json'])assert.equal(await request(path),undefined,path);
 assert.equal(await request('/admin','POST'),undefined);assert.deepEqual([...stored.keys()],['/admin.html','/index.html']);
});
