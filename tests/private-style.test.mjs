import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPrivateStyle} from '../src/client/private-style.mjs';
function fixture(onAppend=()=>{}){const links=[],appended=[];class Link extends EventTarget{remove(){const i=links.indexOf(this);if(i>=0)links.splice(i,1);}}return{links,appended,doc:{querySelectorAll:()=>links,createElement:()=>new Link(),head:{append(link){links.push(link);appended.push(link);onAppend(link);}}}};}
test('private stylesheet loads are shared only while pending; actual failure retries and loaded sheets are reused',async()=>{
 const f=fixture(),href='https://case.test/assets/admin.fixture.css';const a=loadPrivateStyle(href,f.doc),b=loadPrivateStyle(href,f.doc);assert.equal(a,b);assert.equal(f.appended.length,1);
 f.links[0].dispatchEvent(new Event('error'));await assert.rejects(a,/private_styles_unavailable/);await assert.rejects(b,/private_styles_unavailable/);assert.equal(f.links.length,0);
 const retry=loadPrivateStyle(href,f.doc);assert.equal(f.appended.length,2);f.links[0].sheet={};f.links[0].dispatchEvent(new Event('load'));await retry;await loadPrivateStyle(href,f.doc);assert.equal(f.appended.length,2);
 f.links[0].remove();const replaced=loadPrivateStyle(href,f.doc);assert.equal(f.appended.length,3);f.links[0].dispatchEvent(new Event('load'));await replaced;
});
test('even a synchronous stylesheet failure cannot poison the retry cache',async()=>{
 let fail=true;const f=fixture(link=>{if(fail)link.dispatchEvent(new Event('error'));else link.dispatchEvent(new Event('load'));}),href='https://case.test/assets/admin.sync.css';await assert.rejects(loadPrivateStyle(href,f.doc),/private_styles_unavailable/);fail=false;await loadPrivateStyle(href,f.doc);assert.equal(f.appended.length,2);
});
