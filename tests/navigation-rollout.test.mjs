import test from 'node:test';
import assert from 'node:assert/strict';
import {uuidv7} from '../src/shared/ids.mjs';
import {canonicalAppUrl,parseRoute,parseCaseWorkspace,caseWorkspaceUrl,presentUrl,createUrl,sessionsUrl,sessionRecordUrl} from '../src/shared/urls.mjs';
import {canEditCases,canCreateInWorkspace,menuIdentity} from '../src/client/navigation-access.mjs';
const origin='https://case.test',workspace=uuidv7(),id=uuidv7();
test('canonical routes preserve legacy bookmarks and validated workspace context without rewriting callbacks or invitation references',()=>{
 for(const [old,next]of [['/cases','/present'],['/cases?view=drafts','/create'],['/cases/new','/create/new'],['/history','/sessions']]){
  const join=old.includes('?')?'&':'?';assert.equal(canonicalAppUrl(origin+old+join+'workspace='+workspace),origin+next+'?workspace='+workspace);
 }
 for(const url of ['/?code=one-use','/i/#one-use-reference','/sessions/'+id+'/display?topology=same-pc','/cases/'+id+'/v/2','/cases/'+id+'/edit'])assert.equal(canonicalAppUrl(origin+url),origin+url);
 assert.equal(canonicalAppUrl(origin+'/cases?workspace=untrusted&token=private'),presentUrl(origin));
 assert.equal(parseCaseWorkspace(createUrl(origin)).drafts,true);assert.equal(parseRoute('/present').route,'cases');assert.equal(parseRoute('/create').route,'cases');assert.equal(parseRoute('/create/new').route,'case-new');assert.equal(parseRoute('/sessions').route,'history');assert.equal(parseRoute('/sessions/'+id).route,'session-record');
 assert.equal(caseWorkspaceUrl(workspace,'drafts',origin),origin+'/create?workspace='+workspace);
 assert.equal(sessionRecordUrl(id,origin),origin+'/sessions/'+id);
 assert.equal(sessionsUrl(origin,workspace,id),origin+'/sessions?workspace='+workspace+'&case='+id);
 assert.throws(()=>sessionsUrl(origin,null,id));assert.throws(()=>sessionRecordUrl('token',origin));
});
test('Create discovery includes case-only editors, while New case remains scoped to an editing workspace and Role grants nothing',()=>{
 const me={profile:{role:'Administrator'},account:{email:'person@example.test',administration:false},memberships:[{workspace_id:workspace,role:'facilitator'}],grants:[{case_id:id,level:'edit'}]};
 assert.equal(canEditCases(me),true);assert.equal(canCreateInWorkspace(me.memberships,workspace),false);assert.equal(menuIdentity(me,()=>{}).administration,false);
 assert.equal(canCreateInWorkspace([{workspace_id:workspace,role:'author'}],workspace),true);assert.equal(canCreateInWorkspace([{workspace_id:uuidv7(),role:'author'}],workspace),false);
 assert.equal(canEditCases({...me,grants:[{level:'run'}]}),false);assert.equal(canEditCases({...me,grants:[],memberships:[],account:{administration:true}}),true);
});
