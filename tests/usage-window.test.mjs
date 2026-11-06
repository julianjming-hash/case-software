import test from 'node:test';import assert from 'node:assert/strict';
import {parseUsageOptions,summarizeUsage,collectUsage,stdinToken}from '../scripts/usage-window.mjs';
const args=['--target','https://case-staging.iatrogenic.app/','--i-own-this-origin','--account','a'.repeat(32),'--from','2026-10-05T00:00:00.000Z','--to','2026-10-05T00:01:00.000Z','--rooms','1'];
const dataset=()=>({workers:[{sum:{requests:7}}],invocations:[{sum:{requests:3,wallTime:1000000}}],periodic:[{sum:{duration:2,activeTime:1000000,rowsRead:12,rowsWritten:4}}]});
test('[AS-098] exact usage window sums every group with explicit units and rejects missing or invalid meters',()=>{
 const r=summarizeUsage(dataset());assert.equal(r.worker_requests,7);assert.equal(r.do_requests,3);assert.equal(r.do_invocation_wall_seconds,1);assert.equal(r.do_duration_gb_seconds,2);assert.equal(r.sqlite_rows_read,12);assert.equal(r.sqlite_rows_written,4);
 const both=dataset();both.periodic.push({sum:{duration:3,activeTime:2000000,rowsRead:9,rowsWritten:6}});assert.equal(summarizeUsage(both).sqlite_rows_read,21);assert.equal(summarizeUsage(both).do_duration_gb_seconds,5);
 assert.throws(()=>summarizeUsage({...dataset(),periodic:[]}),/usage_incomplete/);
 assert.throws(()=>summarizeUsage({...dataset(),workers:[{sum:{requests:-1}}]}),/usage_invalid/);
});
test('usage guard refuses deployed production, unknown origins and missing acknowledgement before token or network IO',async()=>{
 for(const target of ['https://case.iatrogenic.app/','https://unknown.test/','https://case-staging.iatrogenic.app/?token=hidden']){
  let reads=0;await assert.rejects(collectUsage({...parseUsageOptions(args),target:{kind:'staging',origin:target}},{readToken:()=>{reads++;},fetchImpl:()=>{reads++;}}));assert.equal(reads,0);
 }
 let reads=0;await assert.rejects(collectUsage({...parseUsageOptions(args),own:false},{readToken:()=>{reads++;return 'throwaway-test-token-long-enough';},fetchImpl:()=>{reads++;throw Error('unexpected_io');}}),/usage_owner_required/);assert.equal(reads,0);
 assert.throws(()=>parseUsageOptions(args.filter(x=>x!=='--i-own-this-origin')));
 assert.throws(()=>parseUsageOptions(args.map(x=>x==='2026-10-05T00:01:00.000Z'?'2026-10-05T00:00:00.000Z':x)));
});
test('usage collection inventories only staging namespaces, verifies units and never persists a bearer',async()=>{
 const calls=[],ns='b'.repeat(32);
 const fake=async(url,init)=>{calls.push({url,init});if(url.includes('/namespaces?'))return Response.json({success:true,result:[{id:ns,script:'case-staging',use_sqlite:true},{id:'c'.repeat(32),script:'case',use_sqlite:true}],result_info:{total_pages:1}});
 const query=JSON.parse(init.body).query;
 if(query.includes('__type'))return Response.json({data:{t0:{fields:[{name:'duration',description:'Duration - GB*s'},{name:'activeTime',description:'microseconds'},{name:'rowsRead'},{name:'rowsWritten'}]},t1:{fields:[{name:'requests'},{name:'wallTime',description:'microseconds'}]},t2:{fields:[{name:'requests'}]},t3:{fields:[{name:'wallTime',description:'Maximum wall time for one request - microseconds'}]}}});
 if(query.includes('workersInvocationsAdaptive'))return Response.json({data:{viewer:{accounts:[{workers:dataset().workers}]}}});
 assert.ok(query.includes(ns));assert.ok(!query.includes('c'.repeat(32)));return Response.json({data:{viewer:{accounts:[{invocations:dataset().invocations,periodic:dataset().periodic}]}}});
 };
 const token='throwaway-test-token-never-a-real-credential';
 const report=await collectUsage(parseUsageOptions(args),{readToken:async()=>token,fetchImpl:fake});
 assert.equal(report.total.sqlite_rows_read,12);assert.equal(report.per_phone.worker_requests,7/25);assert.equal(report.groups.namespaces.length,1);
 assert.ok(!JSON.stringify(report).includes(token));assert.ok(calls.every(c=>!c.url.includes(token)&&c.init.redirect==='manual'));
 assert.ok(calls.some(c=>c.init.body&&JSON.parse(c.init.body).query.includes('datetime_lt:"2026-10-05T00:01:00.000Z"')));
 await assert.rejects(collectUsage(parseUsageOptions(args),{readToken:async()=>token,fetchImpl:async()=>Response.json({errors:[{message:'private provider error'}]})}),/usage_graphql_refused/);
});

test('private stdin refuses an echoing terminal before consuming any credential',async()=>{
 await assert.rejects(stdinToken({isTTY:true}),/usage_private_stdin_required/);
 assert.equal(await stdinToken((async function*(){yield 'throwaway-private-stdin-token';})()),'throwaway-private-stdin-token');
});

test('[AS-098] the wall-time unit is read from the summed field, not a different Max type',async()=>{
 const ns='b'.repeat(32);
 const fake=async(url,init)=>{if(url.includes('/namespaces?'))return Response.json({success:true,result:[{id:ns,script:'case-staging',use_sqlite:true}],result_info:{total_pages:1}});
  const query=JSON.parse(init.body).query;
  if(query.includes('__type'))return Response.json({data:{t0:{fields:[{name:'duration',description:'Duration - GB*s'},{name:'activeTime',description:'microseconds'},{name:'rowsRead'},{name:'rowsWritten'}]},t1:{fields:[{name:'requests'},{name:'wallTime',description:'Wall time in milliseconds'}]},t2:{fields:[{name:'requests'}]},t3:{fields:[{name:'wallTime',description:'Maximum wall time for one request - microseconds'}]}}});
  throw Error('must refuse before any usage query');};
 await assert.rejects(collectUsage(parseUsageOptions(args),{readToken:async()=>'throwaway-test-token-long-enough',fetchImpl:fake}),/usage_units_unverified/);
});

// First live run (2026-10-06) refused usage_units_unverified with no way to see why. The unit patterns
// accept the standard spellings of the same units only, and a refusal names the field and quotes
// Cloudflare's public schema description so the next mismatch is diagnosable from the job log.
test('[AS-098] unit patterns accept standard spellings of the same unit and refuse other units', async () => {
 const { UNIT_PATTERNS } = await import('../scripts/usage-window.mjs');
 for (const d of ['Duration - GB*s', 'GB-s', 'Sum of duration in GB-seconds', 'gigabyte-seconds', 'GB seconds']) assert.match(d, UNIT_PATTERNS.duration, d);
 for (const d of ['MB*s', 'Duration (ms)', 'seconds', '', 'GBs of memory']) assert.doesNotMatch(d, UNIT_PATTERNS.duration, d);
 for (const key of ['activeTime', 'wallTime']) {
  for (const d of ['microseconds', 'Wall time, in microseconds', 'Active time (µs)', 'Active time (μs)', 'time in microsecond']) assert.match(d, UNIT_PATTERNS[key], d);
  for (const d of ['milliseconds', 'Wall time (ms)', 'seconds', 'nanoseconds', 'us dollars', '']) assert.doesNotMatch(d, UNIT_PATTERNS[key], d);
 }
});
test('[AS-098] a unit refusal names the field and quotes the public description, bounded', async () => {
 const ns='b'.repeat(32);
 const fake=async(url,init)=>{if(url.includes('/namespaces?'))return Response.json({success:true,result:[{id:ns,script:'case-staging',use_sqlite:true}],result_info:{total_pages:1}});
  const query=JSON.parse(init.body).query;
  if(query.includes('__type'))return Response.json({data:{t0:{fields:[{name:'duration',description:'Duration - GB*s'},{name:'activeTime',description:`Active time in milliseconds ${'x'.repeat(400)}`},{name:'rowsRead'},{name:'rowsWritten'}]},t1:{fields:[{name:'requests'},{name:'wallTime',description:'microseconds'}]},t2:{fields:[{name:'requests'}]},t3:{fields:[]}}});
  throw Error('must refuse before any usage query');};
 const error=await collectUsage(parseUsageOptions(args),{readToken:async()=>'throwaway-test-token-long-enough',fetchImpl:fake}).then(()=>null,e=>e);
 assert.equal(error?.message,'usage_units_unverified');
 assert.equal(error.field,'activeTime');
 assert.match(error.description,/^Active time in milliseconds x+$/); assert.ok(error.description.length<=200);
});

// Second live read (2026-10-06): Cloudflare describes the summed wallTime only as "Sum of wall time".
// A description that states no unit is reported raw and labelled, never converted; one that names a
// different unit still refuses. Billing meters (requests, GB-s duration, rows) stay unit-verified.
const wallFake=(wallDescription)=>{const ns='b'.repeat(32);return async(url,init)=>{if(url.includes('/namespaces?'))return Response.json({success:true,result:[{id:ns,script:'case-staging',use_sqlite:true}],result_info:{total_pages:1}});
 const query=JSON.parse(init.body).query;
 if(query.includes('__type'))return Response.json({data:{t0:{fields:[{name:'duration',description:'Duration - GB*s'},{name:'activeTime',description:'microseconds'},{name:'rowsRead'},{name:'rowsWritten'}]},t1:{fields:[{name:'requests'},{name:'wallTime',description:wallDescription}]},t2:{fields:[{name:'requests'}]},t3:{fields:[]}}});
 if(query.includes('workersInvocationsAdaptive'))return Response.json({data:{viewer:{accounts:[{workers:dataset().workers}]}}});
 return Response.json({data:{viewer:{accounts:[{invocations:dataset().invocations,periodic:dataset().periodic}]}}});};};
test('[AS-098] an unstated wall-time unit is reported raw and labelled, never converted',async()=>{
 const report=await collectUsage(parseUsageOptions(args),{readToken:async()=>'throwaway-test-token-long-enough',fetchImpl:wallFake('Sum of wall time')});
 assert.equal(report.total.do_invocation_wall_raw,1000000);assert.equal('do_invocation_wall_seconds' in report.total,false);
 assert.match(report.schema_units.wallTime,/^Sum of wall time \(provider states no unit; raw sum, not converted\)$/);
 assert.equal(report.total.do_duration_gb_seconds,2);assert.equal(report.total.sqlite_rows_written,4);
 for(const named of ['Sum of wall time in seconds','Wall time (ms)','Sum of wall time in nanoseconds','Wall time, minutes'])
  await assert.rejects(collectUsage(parseUsageOptions(args),{readToken:async()=>'throwaway-test-token-long-enough',fetchImpl:wallFake(named)}),/usage_units_unverified/,named);
 const verified=await collectUsage(parseUsageOptions(args),{readToken:async()=>'throwaway-test-token-long-enough',fetchImpl:wallFake('Sum of wall time in microseconds')});
 assert.equal(verified.total.do_invocation_wall_seconds,1);assert.equal('do_invocation_wall_raw' in verified.total,false);
});

// Third live read (2026-10-06): a refusal other than units printed nothing diagnosable. The CLI now
// prints the fixed refusal code and, for an empty or invalid meter, which meter; never a token or body.
test('[AS-098] refusal lines name the fixed code and meter only', async () => {
 const { refusalLine } = await import('../scripts/usage-window.mjs');
 assert.throws(()=>summarizeUsage({...dataset(),periodic:[]}),e=>e.message==='usage_incomplete'&&e.meter==='activeTime');
 assert.throws(()=>summarizeUsage({...dataset(),invocations:[{sum:{requests:-1,wallTime:1}}]}),e=>e.message==='usage_invalid'&&e.meter==='requests');
 assert.equal(refusalLine(Object.assign(Error('usage_incomplete'),{meter:'duration'})),'usage-window: refusal usage_incomplete (meter: duration)');
 assert.equal(refusalLine(Error('usage_namespace_inventory_incomplete')),'usage-window: refusal usage_namespace_inventory_incomplete');
 assert.equal(refusalLine(Error('load_deadline')),'usage-window: refusal load_deadline');
 assert.equal(refusalLine(Error('Bearer secret-ish text from a provider')),'usage-window: refusal unexpected');
 assert.equal(refusalLine(Object.assign(Error('usage_incomplete'),{meter:'bad meter; x'})),'usage-window: refusal usage_incomplete');
 assert.equal(refusalLine(Object.assign(Error('usage_units_unverified'),{field:'wallTime',description:'Sum of wall time'})),'usage-window: units unverified for wallTime: "Sum of wall time"');
});

// Fourth live read (2026-10-06): usage_namespace_inventory_incomplete. Cloudflare's namespace listing
// need not report total_pages; completeness is proven by total_pages, else total_count/per_page, else an
// empty page. Every refusal names its reason.
test('[AS-098] namespace inventory proves completeness from any pagination shape', async () => {
 const { stagingNamespaces, refusalLine } = await import('../scripts/usage-window.mjs');
 const id = n => n.toString(16).padStart(32, '0');
 const ns = (n, script = 'case-staging') => ({ id: id(n), script, use_sqlite: true });
 const pages = (list, info) => { const calls = []; return { calls, call: async url => { const page = Number(new URL(url).searchParams.get('page')); calls.push(page); return list[page - 1] ?? { success: true, result: [], result_info: info?.(page) ?? {} }; } }; };
 // total_pages
 let p = pages([{ success: true, result: [ns(1), ns(2, 'case')], result_info: { total_pages: 1 } }]);
 assert.deepEqual(await stagingNamespaces(p.call, 'a'.repeat(32)), [id(1)]); assert.deepEqual(p.calls, [1]);
 // total_count + per_page (provider caps per_page at 2)
 p = pages([{ success: true, result: [ns(1), ns(2)], result_info: { total_count: 3, per_page: 2 } }, { success: true, result: [ns(3, 'case')], result_info: { total_count: 3, per_page: 2 } }]);
 assert.deepEqual(await stagingNamespaces(p.call, 'a'.repeat(32)), [id(1), id(2)]); assert.deepEqual(p.calls, [1, 2]);
 // no totals: continue until an empty page
 p = pages([{ success: true, result: [ns(1)], result_info: {} }, { success: true, result: [ns(2)], result_info: {} }]);
 assert.deepEqual(await stagingNamespaces(p.call, 'a'.repeat(32)), [id(1), id(2)]); assert.deepEqual(p.calls, [1, 2, 3]);
 for (const [list, reason] of [
  [[{ success: false, result: [] }], 'unsuccessful'],
  [[{ success: true, result: [ns(1, 'case')], result_info: { total_pages: 1 } }], 'no_staging_namespaces'],
  [[{ success: true, result: [ns(1), ns(1)], result_info: { total_pages: 1 } }], 'duplicate_namespaces'],
  [[{ success: true, result: [ns(1)], result_info: { total_pages: 21 } }], 'too_many_pages'],
  [Array.from({ length: 21 }, (_, i) => ({ success: true, result: [ns(i + 1)], result_info: {} })), 'too_many_pages'],
 ]) {
  const e = await stagingNamespaces(pages(list).call, 'a'.repeat(32)).then(() => null, x => x);
  assert.equal(e?.message, 'usage_namespace_inventory_incomplete', reason); assert.equal(e.reason, reason);
  assert.equal(refusalLine(e), `usage-window: refusal usage_namespace_inventory_incomplete (reason: ${reason})`);
 }
});
