import test from 'node:test';
import assert from 'node:assert/strict';
import { connect,testLifecycle,credentialKey } from '../src/client/transport.mjs';
import { uuidv7,newCapabilityToken } from '../src/shared/ids.mjs';
test('foreign QR transport stays unbound while preserving the other valid room capability',()=>{
 const room=uuidv7(),key=credentialKey('participant',room),value=JSON.stringify({sessionId:room,token:newCapabilityToken(),expiresAt:Date.now()+60000});
 const rows=new Map([[key,value]]),storage={get length(){return rows.size;},key:i=>[...rows.keys()][i],getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)};
 let sockets=0;class Socket{constructor(){sockets++;}addEventListener(){}close(){}}
 const link=connect({role:'participant',api:'https://case.test',restoreCredential:false,storage:null,persistentStorage:storage,lifecycle:testLifecycle(),WebSocketImpl:Socket,telemetryImpl:()=>{}});
 try{assert.equal(link.hasToken,false);assert.equal(link.sessionId,null);assert.equal(sockets,0);assert.equal(storage.getItem(key),value);}finally{link.close();}
});
