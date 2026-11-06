import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import primaryConfig from '../playwright.config.mjs';
import deviceConfig from '../playwright.devices.config.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const workflow=readFileSync(join(ROOT,'.github/workflows/verify.yml'),'utf8');
const browser=workflow.split('\n  browser-harness:\n')[1]?.split('\n  audit:\n')[0];
function discover(extra,script=['node_modules/@playwright/test/cli.js','test','--config','playwright.config.mjs']){
  const [entry,...rest]=script;
  const text=execFileSync(process.execPath,[join(ROOT,entry),...rest.map(x=>x==='playwright.config.mjs'?join(ROOT,x):x),'--list','--reporter=json',...extra],{cwd:ROOT,env:{...process.env,CI:'true'},encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']});
  const report=JSON.parse(text);
  assert.deepEqual(report.errors,[],'actual pinned discovery must have no setup errors');
  assert.equal(report.config.workers,1,'each shard must use one actual worker');
  for(const project of report.config.projects){assert.equal(project.timeout,60000);assert.equal(project.retries,0,'actual retries must remain zero');}
  const rows=[];
  function walk(suites){for(const suite of suites){for(const spec of suite.specs??[]){for(const entry of spec.tests){rows.push({id:entry.testId??spec.id,title:spec.title,file:spec.file,project:entry.projectName,tags:spec.tags??[]});}}walk(suite.suites??[]);}}
  walk(report.suites);assert.ok(rows.length>0,'actual full discovery must not be empty');
  assert.equal(new Set(rows.map(x=>x.id)).size,rows.length,'actual discovery IDs must be unique');
  return {rows,config:report.config};
}
test('browser CI shards discover every current test exactly once with one worker and unchanged retry limits',async()=>{
  assert.ok(browser,'browser job must exist');
  assert.match(browser,/fail-fast:\s*false\b/,'all shard outcomes must remain observable');
  const encoded=browser.match(/\bshard:\s*(\[[^\]\n]+\])/);
  assert.ok(encoded,'workflow must declare its explicit shard matrix');
  const matrix=JSON.parse(encoded[1]);
  // CASE-213: Julian approved a seventh shard (2026-10-11) when the suite reached the six-shard capacity; CASE-249: an eighth
  // (2026-10-14) when seven reached 7 × 400 s. The 400 s per-shard estimate is unchanged.
  // CASE-266: a separate matrix entry (now the eleventh) runs the @perf timing gates alone, always on a hosted runner.
  // CASE-269: Julian approved a ninth browser shard (2026-10-16) when eight reached 8 × 400 s.
  // CASE-288: Julian approved a tenth (2026-10-18) when nine reached 9 × 400 s (393 s each under #303's weights).
  assert.deepEqual(matrix,[1,2,3,4,5,6,7,8,9,10,11],'browser CI must run the ten browser shards and the perf shard');
  const command=browser.match(/\brun:\s*(npm run test:e2e:shard[^\n]*)/)[1];
  assert.equal(command,"npm run test:e2e:shard -- --workers=1 ${{ matrix.shard == 11 && '--perf' || format('--shard={0}/10', matrix.shard) }}");
  const total=10;
  const argsFor=shard=>shard===11?['--workers=1','--perf']:['--workers=1',`--shard=${shard}/${total}`];
  assert.ok(Number.isSafeInteger(total)&&total>=2,'browser jobs must partition the suite into multiple shards');
  assert.match(browser,/name:\s*playwright-traces-\$\{\{\s*matrix\.shard\s*\}\}/,'shard traces must have independent artifact identities');
  assert.equal((browser.match(/run:\s*npm run test:devices\b/g)??[]).length,1,'device recovery must have one workflow step');
  const device=browser.match(/- name: Device recovery on WebKit and Chromium\n([\s\S]*?)(?=\n      - |$)/)?.[1];
  assert.ok(device,'the device recovery step must remain present');
  assert.match(device,/if:\s*matrix\.shard == 1\s*\n/,'only shard 1 must run the extra device recovery suite');
  const full=discover(['--workers=1']);
  assert.ok(primaryConfig.projects.every(project=>project.use.browserName==='chromium'),'the primary shard suite must require Chromium only');
  const selections=matrix.map(shard=>({shard,...discover(argsFor(shard),['scripts/e2e-shard.mjs'])}));
  const expected=new Set(full.rows.map(x=>x.id)),seen=new Set();
  for(const selection of selections){
    for(const row of selection.rows){assert.ok(expected.has(row.id),'shard must not invent a test');assert.equal(seen.has(row.id),false,'actual shard selections must be disjoint');seen.add(row.id);}
  }
  assert.equal(seen.size,expected.size,'actual shard selections must cover the complete current suite');
  // The final reach assertion reads a process-local ledger populated by the preceding serial tests.
  const reach = full.rows.filter(row => row.file === 'builder-reach.spec.mjs');
  assert.ok(reach.length > 1, 'discover the dependent reach cases');
  const reachIds = new Set(reach.map(row => row.id));
  const reachOwners = selections.filter(selection => selection.rows.some(row => reachIds.has(row.id)));
  assert.equal(reachOwners.length, 1, 'the complete serial reach spec must stay in one shard');
  assert.notEqual(reachOwners[0].shard, 11, 'reach checks are not machine timing gates');
  assert.deepEqual(new Set(reachOwners[0].rows.filter(row => reachIds.has(row.id)).map(row => row.id)), reachIds);

  // The perf shard runs exactly the @perf-tagged tests, and no other shard runs one of them.
  // Playwright's JSON report lists the tag without its '@'.
  const perfIds=new Set(full.rows.filter(row=>row.tags.some(tag=>tag.replace(/^@/,'')==='perf')).map(row=>row.id));
  assert.ok(perfIds.size>=4,'the timing gates must be tagged @perf');
  assert.deepEqual(new Set(selections.find(s=>s.shard===11).rows.map(row=>row.id)),perfIds,'shard 11 is exactly the @perf tests');
  for(const selection of selections.filter(s=>s.shard!==11))assert.ok(selection.rows.every(row=>!perfIds.has(row.id)),`shard ${selection.shard} must not run a timing gate`);
  const geometry=full.rows.filter(row=>row.title.startsWith('Card25 loaded-font full labels count '));
  if(geometry.length){
    assert.equal(geometry.length,28,'all geometry titles (counts 2-8 x four authored-text kinds) must remain discovered');
    // Each geometry test is an independent room; nothing requires them on one shard. They were only
    // "together" because contiguous Playwright sharding put them there, and at ~14 s each that
    // stack is what pushed one shard past its timeout.
    const owners=selections.filter(s=>s.rows.some(row=>geometry.some(g=>g.id===row.id)));
    assert.ok(owners.length>=2,'the 28 geometry tests must be spread across shards, not stacked on one');
  }
  const {assign,discover:keys,WEIGHTS}=await import(join(ROOT,'scripts/e2e-shard.mjs'));
  assert.equal(WEIGHTS.shard1ExtraSeconds,70,'the existing device recovery surcharge must remain 70 seconds');
  for(const [i,shard] of assign(keys().filter(row=>!row.perf),total).entries()){
    const bodySeconds=shard.rows.reduce((sum,row)=>sum+(WEIGHTS.weights[row.key]??WEIGHTS.defaultSeconds),0);
    assert.ok(Math.abs(shard.load-bodySeconds-(i===0?WEIGHTS.shard1ExtraSeconds:0))<1e-8,`shard ${i+1} must include the recovery surcharge only on shard 1`);
    assert.ok(shard.load<=400,`shard ${i+1} estimated ${Math.round(shard.load)}s of test time, over the 400s budget (15 min job cap includes ~2.5 min setup)`);
  }
  console.log(JSON.stringify({ciPartition:'actual-pinned-discovery',full:full.rows.length,shards:selections.map(s=>({shard:s.shard,tests:s.rows.length})),geometryTitles:geometry.map(g=>g.title),geometryShards:[...new Set(selections.filter(s=>s.rows.some(r=>geometry.some(g=>g.id===r.id))).map(s=>s.shard))]}));
});

test('clean hosted browser installation covers every shard without unused WebKit',()=>{
  assert.doesNotMatch(browser,/actions\/cache@|pw-cache|self-hosted/,'no cross-trust cache or persistent runner');
  const installer=browser.match(/- name: Install pinned Playwright browsers and system deps\n\s+run: ([^\n]+)/);
  assert.ok(installer,'clean hosted browser installation path');
  for(const shard of [1,2,3,4,5,6,7,8,9,10,11]) {
    const command=installer[1].replace("${{ matrix.shard == 1 && 'webkit' || '' }}",shard===1?'webkit':'');
    assert.deepEqual(command.trim().split(/\s+/),['npx','playwright','install','--with-deps','chromium',...(shard===1?['webkit']:[])],`shard ${shard}: every required browser family`);
  }
  const deviceDiscovery=execFileSync(process.execPath,[join(ROOT,'node_modules/@playwright/test/cli.js'),'test','--config',join(ROOT,'playwright.devices.config.mjs'),'--list','--reporter=json','--workers=1'],{cwd:ROOT,env:{...process.env,CI:'true'},encoding:'utf8',maxBuffer:16*1024*1024});
  const report=JSON.parse(deviceDiscovery);
  assert.deepEqual(report.errors,[],'actual device discovery must remain valid');
  assert.deepEqual(report.config.projects.map(project=>project.name).sort(),deviceConfig.projects.map(project=>project.name).sort(),'actual device discovery must select every configured device project');
  assert.deepEqual([...new Set(deviceConfig.projects.map(project=>project.use.browserName))].sort(),['chromium','webkit'],'shard 1 must retain both configured device browser families');
});

// CASE-266: a timing gate measures the machine, so it must run in the hosted perf shard. Any test whose
// body measures key-to-paint latency or asserts on a percentile must carry the @perf tag; the shard
// test above then proves tagged tests run only in shard 11, and tests/ci-efficiency.test.mjs that
// shard 11 never leaves a hosted runner. Together: no timing gate can land on a Case Linux VM.
const TIMING=/\bp95\b|\bp50\b|latencyNote\(|typing-latency|keyToPaint|followMs/;
function timingGates(text){
  return text.split(/\n(?=\s*test(?:\.(?:only|skip|fixme|fail))?\()/).slice(1).filter(part=>/^\s*test/.test(part)).map(part=>({
    title:part.match(/^\s*test(?:\.\w+)?\(\s*(['"`])([\s\S]*?)\1/)?.[2]??'',
    timing:TIMING.test(part),
    tagged:/^\s*test(?:\.\w+)?\(\s*(['"`])[\s\S]*?\1\s*,\s*\{[^}]*tag:\s*\[?\s*['"]@perf['"]/.test(part),
  }));
}
test('[CASE-266] every timing gate is tagged @perf, so only the hosted perf shard runs it',async()=>{
  const {readdirSync}=await import('node:fs');
  const found=[];
  for(const file of readdirSync(join(ROOT,'e2e')).filter(f=>f.endsWith('.spec.mjs'))){
    for(const gate of timingGates(readFileSync(join(ROOT,'e2e',file),'utf8'))){
      if(gate.timing&&!gate.tagged)assert.fail(`${file}: "${gate.title.slice(0,80)}" measures timing but is not tagged @perf`);
      if(gate.timing)found.push(gate.title);
    }
  }
  assert.ok(found.length>=4,`the known AS-153/AS-163 gates must be found (found ${found.length})`);
  assert.ok(found.every(title=>/\[AS-1(53|63)\]/.test(title)));
  // Known answer: an untagged percentile test is caught; the tag, in either form, clears it.
  const body="\n  expect(p95).toBeLessThanOrEqual(100);\n});\n";
  assert.deepEqual(timingGates(`x\ntest('new gate', async ({ page }) => {${body}`).map(g=>[g.timing,g.tagged]),[[true,false]]);
  assert.deepEqual(timingGates(`x\ntest('new gate', { tag: '@perf' }, async ({ page }) => {${body}`).map(g=>[g.timing,g.tagged]),[[true,true]]);
  assert.deepEqual(timingGates(`x\ntest('new gate', { tag: ['@perf'] }, async ({ page }) => {${body}`).map(g=>[g.timing,g.tagged]),[[true,true]]);
  assert.deepEqual(timingGates("x\ntest('geometry', async ({ page }) => {\n  expect(box.width).toBeLessThanOrEqual(320);\n});\n").map(g=>g.timing),[false]);
});


test('serial reach assignment is atomic, fully weighted and deterministic', async () => {
  const { assign } = await import('../scripts/e2e-shard.mjs');
  const rows = ['builder-reach.spec.mjs first', 'builder-reach.spec.mjs final', 'other.spec.mjs independent'].map(key => ({ key }));
  const weights = { defaultSeconds: 1, shard1ExtraSeconds: 0, weights: { [rows[0].key]: 8, [rows[1].key]: 7, [rows[2].key]: 1 } };
  const shards = assign(rows, 2, weights);
  const group = shards.find(shard => shard.rows.some(row => row.key === rows[0].key));
  assert.deepEqual(new Set(group.rows.map(row => row.key)), new Set(rows.slice(0, 2).map(row => row.key)));
  assert.equal(group.load, 15);
  assert.deepEqual(shards, assign([...rows].reverse(), 2, weights));
});
