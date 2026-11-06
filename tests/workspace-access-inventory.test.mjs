import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uuidv7} from '../src/shared/ids.mjs';
import {authorize,onCase,authorizeSessionRecord,authorizePersonalRecordScope,seesEveryRoom} from '../src/worker/authorize.mjs';
import {preCheckVersionCase} from '../src/worker/published-rooms.mjs';
import {ACTIONS} from '../src/shared/permissions.mjs';
const userId=uuidv7(),home=uuidv7(),caseId=uuidv7(),versionId=uuidv7(),actor={userId,admin:false,email:null};
const grants=Array.from({length:200},()=>({case_id:uuidv7(),workspace_id:home,level:'run',policies:{}}));
function fixture({foreign=false,level='edit'}={}){const calls=[];return{calls,client:{call:async(name,args)=>{calls.push({name,args});if(name==='get_me')return{ok:true,data:[{user_id:userId,display_name:'Editor',memberships:[],grants,next_after:null,admin:false}]};if(name==='version_case')return{ok:true,data:caseId};if(name==='get_access')return{ok:true,data:[{case_id:caseId,workspace_id:foreign?uuidv7():home,member_role:null,grant_level:level,role:level==='edit'?'author':'facilitator',scope:'case',policies:{}}]};throw Error('unexpected RPC');}}};}
test('bounded case inventory omission cannot deny an independently authorised 201st shared case',async()=>{const f=fixture(),result=await authorize(f.client,actor,{workspaceId:home,caseId},ACTIONS.draft);assert.equal(result.ok,true);assert.equal(result.role,'author');assert.equal(result.scope,'case');assert.deepEqual(f.calls.map(c=>c.name),['get_me','get_access']);});
test('exact-case inventory fallback still rejects a foreign workspace and lower access',async()=>{for(const options of [{foreign:true},{level:'run'}]){const f=fixture(options),result=await authorize(f.client,actor,{workspaceId:home,caseId},ACTIONS.draft);assert.equal(result.ok,false);assert.equal(result.status,403);}});
test('start precheck binds the omitted case once and preserves the post-pack authorization',async()=>{const f=fixture({level:'run'}),member=await authorize(f.client,actor,{workspaceId:home,anyCase:true},ACTIONS.startRoom);assert.equal(member.ok,true);assert.equal(onCase(member,caseId,ACTIONS.startRoom).ok,false);assert.equal((await preCheckVersionCase(f.client,actor,member,versionId,ACTIONS.startRoom)).ok,true);assert.equal(onCase(member,caseId,ACTIONS.startRoom).ok,true);assert.equal(onCase(member,uuidv7(),ACTIONS.startRoom).ok,false);});

test('historical own-record admission can follow current case access, never another starter or owner policy',async()=>{
 const destination=uuidv7();let accessReads=0;const client={call:async(name)=>{
  if(name==='get_me')return {ok:true,data:[{user_id:userId,display_name:'Starter',memberships:[],grants:[],next_after:null,admin:false}]};
  if(name==='get_access'){accessReads++;return {ok:true,data:[{case_id:caseId,workspace_id:destination,member_role:'owner',grant_level:null,role:'owner',scope:'workspace',policies:{managers_see_records:true}}]};}throw Error(name);
 }};
 const own=await authorizeSessionRecord(client,actor,{workspaceId:home,caseId,own:true},ACTIONS.readSessionRecord);assert.equal(own.ok,true);assert.equal(own.workspaceId,home);assert.equal(own.scope,'case');assert.equal(own.role,'author');assert.equal(seesEveryRoom(own,ACTIONS.readSessionRecord),false);
 const denied=await authorizeSessionRecord(client,actor,{workspaceId:home,caseId,own:false},ACTIONS.readSessionRecord);assert.equal(denied.status,403);assert.equal(accessReads,1,'another starter never triggers current-case fallback');
});
test('historical list admission is exact-workspace and own-only, and malformed claims fail closed',async()=>{
 for(const mode of ['allowed','foreign','unavailable']){const client={call:async(name,args)=>{
 if(name==='get_me')return {ok:true,data:[{user_id:userId,display_name:'Starter',memberships:[],grants:[],next_after:null,admin:false}]};
 if(name==='personal_record_workspace_access'){assert.equal(args.p_user_id,userId);assert.equal(args.p_workspace_id,home);return mode==='unavailable'?{ok:false,code:'42501'}:{ok:true,data:{workspaceId:mode==='foreign'?uuidv7():home,ownOnly:true}};}throw Error(name);
 }};const result=await authorizePersonalRecordScope(client,actor,home);assert.equal(result.ok,mode==='allowed');if(result.ok)assert.equal(seesEveryRoom(result,ACTIONS.readRoomHistory),false);}
});
test('a full grant inventory never overrides valid original-workspace membership for a historical record',async()=>{
 const f=fixture({foreign:true}),call=f.client.call;f.client.call=async(name,args)=>{const result=await call(name,args);if(name==='get_me')result.data[0].memberships=[{workspace_id:home,role:'owner',policies:{managers_see_records:true}}];return result;};
 assert.equal((await authorize(f.client,actor,{workspaceId:home,caseId},ACTIONS.readSessionRecord)).ok,true);assert.deepEqual(f.calls.map(c=>c.name),['get_me']);
});
