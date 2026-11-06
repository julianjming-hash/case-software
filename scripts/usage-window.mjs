// Julian only: read Cloudflare analytics. Never call the deployed Worker or Supabase.
import {fileURLToPath}from 'node:url';
import {resolve}from 'node:path';
import {resolvePilotTarget}from './pilot-target.mjs';
import {fetchFixedJson}from './load-room.mjs';
// Same unit, standard spellings only (GB-s / GB*s / GB-seconds; microseconds / µs / μs). Anything else refuses.
export const UNIT_PATTERNS=Object.freeze({duration:/\bGB(?:\s*[-*\u00b7\u00d7]\s*|\s+)(?:s|secs?|seconds?)\b|\bgigabyte[-\s]*seconds?\b/i,activeTime:/\bmicroseconds?\b|[\u00b5\u03bc]s\b/i,wallTime:/\bmicroseconds?\b|[\u00b5\u03bc]s\b/i});
/** One stderr line for a refusal: the fixed code and, when present, the meter or unit field. Never a token or body. */
export function refusalLine(e){
 if(e?.message==='usage_units_unverified'&&/^[A-Za-z]+$/.test(e.field??''))return `usage-window: units unverified for ${e.field}: "${e.description}"`;
 const code=/^(?:usage|load)_[a-z_]+$/.test(e?.message??'')?e.message:'unexpected';
 return `usage-window: refusal ${code}${/^[A-Za-z]+$/.test(e?.meter??'')?` (meter: ${e.meter})`:/^[a-z_]+$/.test(e?.reason??'')?` (reason: ${e.reason})`:''}`;
}
/** Staging DO namespace ids, proven complete by total_pages, else total_count/per_page, else an empty page. */
export async function stagingNamespaces(call,account,{maxPages=20}={}){
 const fail=reason=>Object.assign(Error('usage_namespace_inventory_incomplete'),{reason});const ids=[];
 for(let page=1;;page++){
  if(page>maxPages)throw fail('too_many_pages');
  const r=await call(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=100&page=${page}`);
  if(r?.success!==true||!Array.isArray(r.result))throw fail('unsuccessful');
  for(const ns of r.result)if(ns?.script==='case-staging'){if(!/^[a-f0-9]{32}$/.test(ns.id)||ns.use_sqlite!==true)throw Error('usage_namespace_invalid');ids.push(ns.id);}
  const info=r.result_info??{};
  const total=Number.isInteger(info.total_pages)?info.total_pages:Number.isInteger(info.total_count)&&Number.isInteger(info.per_page)&&info.per_page>0?Math.ceil(info.total_count/info.per_page):null;
  if(total!==null){if(total>maxPages)throw fail('too_many_pages');if(page>=total)break;}
  else if(!r.result.length)break;
 }
 if(!ids.length)throw fail('no_staging_namespaces');
 if(new Set(ids).size!==ids.length)throw fail('duplicate_namespaces');
 return ids;
}
export async function stdinToken(input=process.stdin){
 if(input.isTTY)throw Error('usage_private_stdin_required');
 let text='';for await(const chunk of input){text+=chunk;if(text.length>8192)throw Error('usage_token_invalid');}
 const token=text.trim();if(token.length<20||/\s|[\x00-\x1f\x7f]/.test(token))throw Error('usage_token_invalid');return token;
}
export function parseUsageOptions(args){
 const o={target:null,own:false};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--i-own-this-origin'){o.own=true;continue;}
  if(!['--target','--account','--from','--to','--rooms'].includes(args[i])||!args[i+1])throw Error('usage_options_invalid');
  const key=args[i].slice(2);if(o[key]!==undefined&&o[key]!==null)throw Error('usage_options_invalid');o[key]=args[++i];
 }
 if(o.target==='https://case-staging.iatrogenic.app/')o.target=o.target.slice(0,-1);
 o.target=resolvePilotTarget(o);if(o.target.kind!=='staging')throw Error('usage_staging_required');
 if(!/^[a-f0-9]{32}$/.test(o.account??''))throw Error('usage_account_invalid');
 for(const k of ['from','to'])if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/.test(o[k]??'')||new Date(o[k]).toISOString()!==o[k])throw Error('usage_window_invalid');
 const duration=Date.parse(o.to)-Date.parse(o.from);if(duration<=0||duration>7200000)throw Error('usage_window_invalid');
 o.rooms=Number(o.rooms);if(![1,5,10].includes(o.rooms))throw Error('usage_rooms_invalid');return o;
}
function sum(rows,key){
 const refuse=code=>Object.assign(Error(code),{meter:key});
 if(!Array.isArray(rows)||!rows.length||rows.length>=1000)throw refuse('usage_incomplete');
 let total=0;for(const row of rows){const n=row.sum?.[key];if(!Number.isFinite(n)||n<0)throw refuse('usage_invalid');total+=n;}
 if(!Number.isFinite(total))throw refuse('usage_invalid');return total;
}
// Any time-unit word; a wall-time description without one states no unit (reported raw, not converted).
export const TIME_UNIT_WORD=/\b(?:nano|micro|milli)?seconds?\b|\b(?:ns|ms|s|secs?|mins?|minutes?|hours?|h)\b|[\u00b5\u03bc]s\b/i;
export function summarizeUsage({workers,invocations,periodic,wallUnit='microseconds'}){
 const wall=wallUnit==='unstated'?{do_invocation_wall_raw:sum(invocations,'wallTime')}:{do_invocation_wall_seconds:sum(invocations,'wallTime')/1e6};
 return {worker_requests:sum(workers,'requests'),do_requests:sum(invocations,'requests'),...wall,do_active_seconds:sum(periodic,'activeTime')/1e6,do_duration_gb_seconds:sum(periodic,'duration'),sqlite_rows_read:sum(periodic,'rowsRead'),sqlite_rows_written:sum(periodic,'rowsWritten')};
}
export async function collectUsage(options,{readToken=stdinToken,fetchImpl=fetch}={}){
 if(options.own!==true)throw Error('usage_owner_required');
 const o=parseUsageOptions(['--target',options.target?.origin??'','--i-own-this-origin','--account',options.account,'--from',options.from,'--to',options.to,'--rooms',String(options.rooms)]);
 const token=await readToken();if(typeof token!=='string'||token.length<20||token.length>8192||/\s|[\x00-\x1f\x7f]/.test(token))throw Error('usage_token_invalid');
 const call=(url,init={})=>fetchFixedJson(fetchImpl,url,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},deadlineMs:10000});
 const graphql=async query=>{const result=await call('https://api.cloudflare.com/client/v4/graphql',{method:'POST',body:JSON.stringify({query})});if(result.errors?.length||!result.data)throw Error('usage_graphql_refused');return result.data;};
 // Verify provider field names and units at execution time; a schema change is a refusal, not zero usage.
 const types=['AccountDurableObjectsPeriodicGroupsSum','AccountDurableObjectsInvocationsAdaptiveGroupsSum','AccountWorkersInvocationsAdaptiveSum','AccountDurableObjectsInvocationsAdaptiveGroupsMax'];
 const schema=await graphql(`{${types.map((name,i)=>`t${i}:__type(name:"${name}"){fields{name description}}`).join(' ')}}`);
 const required=[['duration','activeTime','rowsRead','rowsWritten'],['requests','wallTime'],['requests']];
 required.forEach((names,i)=>{if(names.some(name=>!schema[`t${i}`]?.fields?.some(f=>f.name===name)))throw Error('usage_schema_changed');});
 let wallUnit='microseconds';
 for(const[key,unit]of Object.entries(UNIT_PATTERNS)){const type=key==='wallTime'?schema.t1:schema.t0;const description=type.fields.find(f=>f.name===key)?.description??'';
  if(key==='wallTime'&&!unit.test(description)&&!TIME_UNIT_WORD.test(description)){wallUnit='unstated';continue;}
  if(!unit.test(description))throw Object.assign(Error('usage_units_unverified'),{field:key,description:String(description).replace(/[^\x20-\x7e\u00b5\u03bc]/g,' ').slice(0,200)});}
 const namespaces=await stagingNamespaces(call,o.account);
 const account=JSON.stringify(o.account),from=JSON.stringify(o.from),to=JSON.stringify(o.to);
 const filter=`datetime_geq:${from},datetime_lt:${to}`;
 const workers=await graphql(`{viewer{accounts(filter:{accountTag:${account}}){workers:workersInvocationsAdaptive(limit:1000,filter:{${filter},scriptName:"case-staging"}){sum{requests}}}}}`);
 const workerRows=workers.viewer?.accounts?.[0]?.workers;
 const invocations=[],periodic=[],byNamespace=[];
 for(const id of namespaces){
  const result=await graphql(`{viewer{accounts(filter:{accountTag:${account}}){invocations:durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{${filter},namespaceId:"${id}",scriptName:"case-staging"}){sum{requests wallTime}} periodic:durableObjectsPeriodicGroups(limit:1000,filter:{${filter},namespaceId:"${id}"}){sum{duration activeTime rowsRead rowsWritten}}}}}`);
  const data=result.viewer?.accounts?.[0];
  if(!Array.isArray(data?.invocations)||!Array.isArray(data?.periodic)||data.invocations.length>=1000||data.periodic.length>=1000)throw Error('usage_incomplete');
  // Idle namespaces may have no rows; retain that absence explicitly. Entirely empty meters refuse below.
  byNamespace.push({namespace:id,...data});invocations.push(...data.invocations);periodic.push(...data.periodic);
 }
 const total=summarizeUsage({workers:workerRows,invocations,periodic,wallUnit});
 return {source:'Cloudflare GraphQL Analytics (adaptive sampling; not an invoice)',script:'case-staging',from:o.from,to:o.to,observed_at:new Date().toISOString(),rooms:o.rooms,phones:o.rooms*25,total,per_room:Object.fromEntries(Object.entries(total).map(([k,v])=>[k,v/o.rooms])),per_phone:Object.fromEntries(Object.entries(total).map(([k,v])=>[k,v/(o.rooms*25)])),groups:{workers:workerRows,namespaces:byNamespace},schema_units:{duration:schema.t0.fields.find(f=>f.name==='duration').description,activeTime:schema.t0.fields.find(f=>f.name==='activeTime').description,wallTime:`${schema.t1.fields.find(f=>f.name==='wallTime')?.description??''}${wallUnit==='unstated'?' (provider states no unit; raw sum, not converted)':''}`}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 Promise.resolve().then(()=>collectUsage(parseUsageOptions(process.argv.slice(2)))).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error('usage-window: refused or incomplete; no measured report produced');console.error(refusalLine(e));process.exitCode=1;});
}
