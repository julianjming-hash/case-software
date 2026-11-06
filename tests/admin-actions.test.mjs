import test from 'node:test';
import assert from 'node:assert/strict';
import { runAuditedAction } from '../src/worker/admin/actions.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

function fixture({intent=true,outcome=true,revert=true,irreversible=false}={}) {
  const calls=[];
  const input={action:'facilitator_disable',targetType:'facilitator',targetId:uuidv7(),actorEmail:'admin@example.test',fromPrefix:null,before:{status:'active',admin_revision:1},irreversible,
    rpc:{call:async(name,args)=>{calls.push(['audit',args]);return {ok:args.p_phase==='intent'?intent:outcome};}},
    write:async()=>{calls.push(['write']);return {admin_revision:2};},
    revert:async result=>{calls.push(['revert',result]);return {ok:revert};},
    after:result=>({status:'disabled',admin_revision:result.admin_revision})};
  return {calls,input};
}

test('Card 21a audited action records durable intent before mutation and correlated immutable outcome',async()=>{
  const {calls,input}=fixture();
  assert.deepEqual(await runAuditedAction(input),{ok:true,result:{admin_revision:2}});
  assert.deepEqual(calls.map(x=>x[0]),['audit','write','audit']);
  const [intent,,outcome]=calls;
  assert.equal(intent[1].p_event_id,intent[1].p_intent_id);
  assert.equal(outcome[1].p_intent_id,intent[1].p_event_id);
  assert.notEqual(outcome[1].p_event_id,intent[1].p_event_id);
  assert.equal(outcome[1].p_target_id,input.targetId);
  assert.deepEqual(outcome[1].p_after,{status:'disabled',admin_revision:2});
  const refused=fixture({intent:false});
  assert.deepEqual(await runAuditedAction(refused.input),{ok:false,status:503,error:'audit_unavailable'});
  assert.deepEqual(refused.calls.map(x=>x[0]),['audit']);
});

test('Card 21a failed outcome audit reverts reversible change and distinguishes failed reconciliation',async()=>{
  const reverted=fixture({outcome:false});
  assert.deepEqual(await runAuditedAction(reverted.input),{ok:false,status:500,error:'change_reverted_audit_unavailable'});
  assert.deepEqual(reverted.calls.map(x=>x[0]),['audit','write','audit','revert']);
  const failed=fixture({outcome:false,revert:false});
  assert.deepEqual(await runAuditedAction(failed.input),{ok:false,status:500,error:'manual_reconciliation_needed'});
  const irreversible=fixture({outcome:false,irreversible:true});
  assert.deepEqual(await runAuditedAction(irreversible.input),{ok:false,status:500,error:'manual_reconciliation_needed'});
  assert.equal(irreversible.calls.some(x=>x[0]==='revert'),false);
});

test('Card 21a audit snapshots reject private/free-text fields before persistence or mutation',async()=>{
  const {calls,input}=fixture();
  input.before={status:'active',answer:'private clinical text'};
  assert.deepEqual(await runAuditedAction(input),{ok:false,status:400,error:'bad_request'});
  assert.deepEqual(calls,[]);
});

test('Card 21a conditional write conflict records failed outcome without reverting another admin change',async()=>{
  const {calls,input}=fixture();
  input.write=async()=>{calls.push(['write']);return {ok:false,status:409};};
  input.after=()=>{throw Error('must not project a rejected write');};
  assert.deepEqual(await runAuditedAction(input),{ok:false,status:409,error:'conflict'});
  assert.deepEqual(calls.map(x=>x[0]),['audit','write','audit']);
  assert.deepEqual(calls[2][1].p_after,{status:'failed'});
});

test('Card 21a audit revision ceiling matches existing ten-digit SQL bound before mutation',async()=>{
  const invalid=fixture();invalid.input.before={status:'active',admin_revision:10000000000};
  assert.deepEqual(await runAuditedAction(invalid.input),{ok:false,status:400,error:'bad_request'});
  assert.deepEqual(invalid.calls,[]);
  const largest=fixture();largest.input.before={status:'active',admin_revision:9999999999};
  assert.equal((await runAuditedAction(largest.input)).ok,true);
});
test('Card 21a irreversible callback receives its actual durable intent identity',async()=>{
 const {input,calls}=fixture({irreversible:true});let admitted;
 input.write=async context=>{admitted=context?.intentId;return {admin_revision:2};};
 assert.equal((await runAuditedAction(input)).ok,true);
 assert.equal(admitted,calls[0][1].p_event_id);
});
