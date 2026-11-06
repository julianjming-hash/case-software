import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildClient} from '../scripts/build-client.mjs';
import {measureEntries,assertBudgets,BASELINE,BUDGETS,ROUTES,DEFERRED_ROUTES} from '../scripts/size-budget.mjs';
test('Approved actual Admin entry and shared-shell union retain fixed measured budgets',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'case-admin-budget-'));
 try{
  const outDir=join(temp,'dist'),built=await buildClient({outDir});
  const measured=await measureEntries(outDir,{...built.entries,sw:'sw.mjs'},ROUTES,DEFERRED_ROUTES);
  assertBudgets(measured);
  assert.ok(Number.isSafeInteger(measured.admin)&&measured.admin>0);assert.equal(BASELINE.admin,30190);
  // The facilitator Name & role editor (Julian's standing rule, 2026-10-18): previous cap 33,209 + 1.1 × 2,672 B measured growth over room PDFs v2's final head.
  // CASE-376/378: approved fixed allocations include authenticated header accounting; unrelated caps and formula stay pinned.
  assert.equal(BUDGETS.admin,41683);assert.equal(BUDGETS['route:/admin'],234875);assert.equal(BUDGETS['admin-workspaces'],32018);assert.equal(BUDGETS['route:/sessions/:id/facilitate'],376176);assert.ok(measured['admin-css']>0);
  assert.equal(BUDGETS['issue-entry'],4088);assert.equal(BUDGETS['issue-reporter'],15605);assert.equal(BUDGETS['admin-issues'],15757);assert.equal(BUDGETS['issues-css'],533);
 }finally{await rm(temp,{recursive:true,force:true});}
});
