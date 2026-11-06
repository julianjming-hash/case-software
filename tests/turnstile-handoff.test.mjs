import test from 'node:test';
import assert from 'node:assert/strict';
import { createJoinDocumentHandoff } from '../src/client/join-handoff.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { sessionUrl } from '../src/shared/urls.mjs';

test('join document handoff awaits successful existing cleanup before one token-free full navigation',async()=>{
 let resolve,cleaned=0;const pending=new Promise(ok=>{resolve=ok;}),urls=[],room=uuidv7();
 const handoff=createJoinDocumentHandoff({cleanup:reason=>{assert.equal(reason,'next_load');cleaned++;return pending;},active:()=>true,navigate:url=>urls.push(url),origin:'https://case.test'});
 const first=handoff(room),second=handoff(room);assert.equal(cleaned,1);assert.deepEqual(urls,[]);resolve({complete:true});assert.equal(await first,true);assert.equal(await second,true);assert.deepEqual(urls,[sessionUrl(room,'play','https://case.test')]);
});

test('join document handoff fences navigation and public callbacks after pagehide during held cleanup',async()=>{
 let resolve,active=true;const pending=new Promise(ok=>{resolve=ok;}),urls=[],failures=[];
 const handoff=createJoinDocumentHandoff({cleanup:()=>pending,active:()=>active,navigate:url=>urls.push(url),onUnavailable:()=>failures.push(true),origin:'https://case.test'});
 const work=handoff(uuidv7());active=false;resolve({complete:true});assert.equal(await work,false);assert.deepEqual(urls,[]);assert.deepEqual(failures,[]);
});

test('join document handoff refuses failed cleanup without private navigation or raw error callbacks',async()=>{
 for(const cleanup of [async()=>({complete:false}),async()=>{throw Error('private fixture error');}]){
  const urls=[],failures=[];const handoff=createJoinDocumentHandoff({cleanup,active:()=>true,navigate:url=>urls.push(url),onUnavailable:reason=>failures.push(reason),origin:'https://case.test'});
  assert.equal(await handoff(uuidv7()),false);assert.deepEqual(urls,[]);assert.deepEqual(failures,['storage_unavailable']);
 }
});

test('join document handoff contains rejected navigation with a fixed public failure',async()=>{
 const failures=[];
 const handoff=createJoinDocumentHandoff({cleanup:async()=>({complete:true}),active:()=>true,navigate:()=>{throw Error('private navigation fixture');},onUnavailable:reason=>failures.push(reason),origin:'https://case.test'});
 assert.equal(await handoff(uuidv7()),false);assert.deepEqual(failures,['storage_unavailable']);
});

test('join handoff Retry revalidates storage after failure and only then leaves the entry document',async()=>{
 let attempts=0;const urls=[],failures=[],room=uuidv7();
 const handoff=createJoinDocumentHandoff({cleanup:async()=>({complete:++attempts>1}),active:()=>true,navigate:url=>urls.push(url),onUnavailable:reason=>failures.push(reason),origin:'https://case.test'});
 assert.equal(await handoff(room),false);assert.deepEqual(urls,[]);
 assert.equal(await handoff(room),true);assert.equal(attempts,2);
 assert.deepEqual(urls,[sessionUrl(room,'play','https://case.test')]);assert.deepEqual(failures,['storage_unavailable']);
});
