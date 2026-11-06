import test from 'node:test';
import assert from 'node:assert/strict';
import { installPhonePageRestore } from '../src/client/phone-pageshow.mjs';

test('phone BFCache pageshow reloads a disposed surface once while ordinary pageshow preserves the active session',()=>{
 const events=new EventTarget();let reloads=0;
 const remove=installPhonePageRestore({events,reload:()=>reloads++});
 events.dispatchEvent(new Event('pageshow'));assert.equal(reloads,0);
 const restored=()=>{const event=new Event('pageshow');Object.defineProperty(event,'persisted',{value:true});return event;};
 events.dispatchEvent(restored());events.dispatchEvent(restored());assert.equal(reloads,1);
 remove();events.dispatchEvent(restored());assert.equal(reloads,1);
});
