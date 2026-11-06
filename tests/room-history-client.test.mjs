import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { historyPage } from '../src/client/room-history.mjs';
import { accountUrl,historyUrl,helpUrl,parseRoute } from '../src/shared/urls.mjs';
const room=()=>({sessionId:uuidv7(),caseVersionId:uuidv7(),title:'A Case',versionNo:1,status:'ended',
 createdAt:'2026-10-08T00:00:00.000Z',startedAt:null,endedAt:'2026-10-08T01:00:00.000Z',expiresAt:'2026-10-08T02:00:00.000Z',archiveState:'pending',own:true});
test('history accepts bounded summaries and refuses person-linked/private fields before rendering',()=>{
 const row=room();assert.equal(historyPage({rooms:[row],nextAfter:null}).rooms[0],row);
 for(const extra of [{notes:'PRIVATE'},{responses:[]},{facilitatorName:'PRIVATE'},{joinCode:'ABC123'},{participantId:uuidv7()}])assert.throws(()=>historyPage({rooms:[{...row,...extra}],nextAfter:null}));
 assert.throws(()=>historyPage({rooms:[row,row],nextAfter:null}));
 assert.throws(()=>historyPage({rooms:[{...row,archiveState:'probably'}],nextAfter:null}));
 assert.throws(()=>historyPage({rooms:[],nextAfter:'cursor'}));
 assert.throws(()=>historyPage({rooms:[row],nextAfter:'a'.repeat(513)}));
 assert.throws(()=>historyPage({rooms:[row],nextAfter:'token=value'}));
 assert.throws(()=>historyPage({rooms:Array.from({length:21},room),nextAfter:null}));
});
test('fixed account/history/help menu URLs carry no private inputs and reject malformed origins',()=>{
 for(const [build,path] of [[accountUrl,'account'],[historyUrl,'sessions'],[helpUrl,'help']]){
 assert.equal(build('http://localhost:4173'),`http://localhost:4173/${path}`);assert.deepEqual(parseRoute('/'+path),{route:path==='sessions'?'history':path});
 for(const origin of ['https://a.test/private','https://user:secret@a.test','https://a.test?token=secret','javascript:alert(1)'])assert.throws(()=>build(origin));
 }
});
