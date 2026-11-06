import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uuidv7} from '../src/shared/ids.mjs';
import {handleWorkbench} from '../src/worker/admin/workbench.mjs';
import {workbenchPage,workspacePage} from '../src/shared/admin-workbench.mjs';
const user={userId:'550e8400-e29b-41d4-a716-446655440000',email:'admin@example.org',sessionId:'550e8400-e29b-41d4-a716-446655440001'},env={ADMIN_EMAILS:'admin@example.org'},ws=uuidv7();
const workspace={id:ws,name:'Teaching',membership_revision:2};
const member=id=>({id,email:'member@example.org',role:'author',created_at:'2026-10-09T00:00:00Z',account_state:'active'});
const request=()=>new Request('https://case.test/api/v1/admin/workspace/query',{method:'POST'});
const body={workspaceId:ws,tab:'members',query:'',status:'all',from:null,until:null,after:null};
test('[AS-126] workbench schemas reject hidden extra payloads, duplicate rows, foreign cursors and invalid ordering',()=>{
 const row=member(user.userId);assert.ok(workbenchPage('members',{workspace,rows:[row],nextAfter:null}));
 assert.equal(workbenchPage('members',{workspace,rows:[{...row,token:'PRIVATE'}],nextAfter:null}),null);
 assert.equal(workbenchPage('members',{workspace,rows:[row,row],nextAfter:null}),null);
 assert.equal(workbenchPage('members',{workspace,rows:[row],nextAfter:uuidv7()}),null);
 assert.equal(workspacePage({workspaces:[workspace,workspace],nextAfter:null}),null);
});
test('admin workspace reads bind cursors to current actor/workspace/query and never accept caller authority',async()=>{
 const calls=[],rpc={async call(name,args){calls.push({name,args});return{ok:true,data:{workspace,rows:[member(user.userId)],nextAfter:user.userId}};}};
 const first=await handleWorkbench({request:request(),route:{key:'workspace_query'},user,env,body,rpc});assert.equal(first.status,200);const page=await first.json();assert.ok(page.nextAfter);
 assert.equal(calls[0].args.p_admin,true);assert.equal(calls[0].args.p_admin_email,user.email);
 for(const change of [{query:'different'},{workspaceId:uuidv7()}])assert.equal((await handleWorkbench({request:request(),route:{key:'workspace_query'},user,env,body:{...body,...change,after:page.nextAfter},rpc})).status,400);
 assert.equal((await handleWorkbench({request:request(),route:{key:'workspace_query'},user,env,body:{...body,admin:true},rpc})).status,400);
 assert.equal((await handleWorkbench({request:request(),route:{key:'workspace_query'},user:{...user,email:'owner@example.org'},env,body,rpc})).status,403);
});
test('workspace reader rejects a swapped upstream workspace and membership writes without elevation',async()=>{
 const rpc={async call(){return{ok:true,data:{workspace:{...workspace,id:uuidv7()},rows:[],nextAfter:null}};}};
 assert.equal((await handleWorkbench({request:request(),route:{key:'workspace_query'},user,env,body,rpc})).status,503);
 assert.equal((await handleWorkbench({request:request(),route:{key:'membership_change'},user,env,body:{workspaceId:ws,email:'member@example.org',role:'owner',transferFrom:null,expectedRevision:2,confirmEmail:'member@example.org'},rpc})).status,403);
});
// Card 68 (SURFACE-01, SURFACE-02): audit rows read as sentences with a readable target; the raw key stays in the detail.
import {readdirSync,readFileSync} from 'node:fs';
import {auditLabel,auditTarget,snapshotEntries} from '../src/shared/admin-workbench.mjs';
const sqlList=(file,after)=>{const text=readFileSync(new URL(`../db/supabase/migrations/${file}`,import.meta.url),'utf8');return [...text.slice(text.lastIndexOf(after)).match(/check\s*\(\s*action in \(([^)]*)\)/s)[1].matchAll(/'([a-z_]+)'/g)].map(m=>m[1]);};
test('[AS-126] every recorded audit action has a readable label, and an unknown key falls back to a sentence',()=>{
 const files=readdirSync(new URL('../db/supabase/migrations/',import.meta.url)).filter(f=>readFileSync(new URL(`../db/supabase/migrations/${f}`,import.meta.url),'utf8').includes('add constraint workspace_audit_action_check')).sort();
 const workspace=sqlList(files.at(-1),'add constraint workspace_audit_action_check'),deployment=sqlList('20261002040000_admin_server.sql','action text not null check');
 assert.ok(workspace.length>=26&&deployment.length===12);
 for(const action of [...workspace,...deployment]){const label=auditLabel(action);assert.match(label,/^[A-Z][a-z]/,action);assert.ok(!label.includes('_'),action);}
 assert.equal(auditLabel('version_publish'),'Version published');assert.equal(auditLabel('case_group'),'Case group changed');assert.equal(auditLabel('stepup_start'),'Verification code requested');
 assert.equal(auditLabel('membership_change'),'Membership change');
});
test('[AS-126] audit targets name their kind and keep a short identifier, never a bare UUID',()=>{
 const id='01a14a36-5ef5-70a9-a2fb-524595c5618f';
 assert.equal(auditTarget('version',id),'Case version …95c5618f');assert.equal(auditTarget('member',id),'Member …95c5618f');assert.equal(auditTarget('mystery',id),'Mystery …95c5618f');
 assert.equal(auditTarget('room',null),'Room');
});
test('[AS-126] an empty or missing audit snapshot yields no entries so the detail can say Not recorded',()=>{
 assert.deepEqual(snapshotEntries(null),[]);assert.deepEqual(snapshotEntries({}),[]);
 assert.deepEqual(snapshotEntries({role:'author',transferFrom:null}),[['Role','author'],['Transferred from',null]]);
 assert.deepEqual(snapshotEntries({status:'published',admin_revision:3}),[['Status','published'],['Admin revision',3]]);
});
