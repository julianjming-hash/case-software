import test from'node:test';import assert from'node:assert/strict';import{checkDecisionIndex}from'../scripts/decision-index.mjs';
const row=(id,extra='')=>`| ${id} | 2026-11-05 | Actual ruling | Reason |${extra}`;
test('fresh decisions and attributed legacy witnesses are validated without fabricated history',()=>{
 assert.deepEqual(checkDecisionIndex(row('PUB-001')+'\n'+row('PUB-002')),[]);
 assert.deepEqual(checkDecisionIndex(row('CASE-115'),{prefix:'CASE',contiguous:false}),[]);
 for(const text of ['',row('PUB-002'),row('CASE-001'),row('PUB-001')+'\n'+row('PUB-001'),row('PUB-001').replace('2026-11-05','unknown'),row('PUB-001').replace('Actual ruling',''),row('PUB-001',' extra |')])assert.ok(checkDecisionIndex(text).length,text);
 assert.ok(checkDecisionIndex(row('CASE-115')+'\n'+row('CASE-115'),{prefix:'CASE',contiguous:false}).length);
});
