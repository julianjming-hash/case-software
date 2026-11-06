// Fork-safe aggregate: no GitHub API call and no writable token. Missing evidence is a failure.
export function publicCIResult({event,schedule='',needs}={}){
 const deny=reason=>({ok:false,reason});
 if(!['pull_request','push','schedule'].includes(event)||!needs||typeof needs!=='object')return deny('invalid_context');
 if(needs.changes?.result!=='success')return deny('change_selection_failed');
 const o=needs.changes.outputs??{},cron=event==='schedule';
 if(cron&&!['0 3 * * *','0 4 * * 1'].includes(schedule))return deny('unknown_schedule');
 if(!cron&&['browser','macos','audit','workflows','draft'].some(k=>!['true','false'].includes(o[k])))return deny('invalid_selection');
 const browser=cron?schedule==='0 3 * * *'&&o.nightly!=='false':o.browser==='true';
 const expected={
  'load-gates':!cron,
  verify:!cron,
  'macos-bash32':!cron&&o.macos==='true',
  'browser-harness':browser,
  audit:!cron||schedule==='0 4 * * 1',
  actionlint:!cron&&o.workflows==='true'||cron&&schedule==='0 4 * * 1',
 };
 if(!cron&&o.draft==='true'&&browser)return deny('draft_browser_not_qualified');
 for(const[job,required]of Object.entries(expected)){
  const result=needs[job]?.result;
  if(required&&result!=='success')return deny('required_job_not_success:'+job);
  if(!required&&result!=='skipped'&&result!=='success')return deny('unexpected_job_state:'+job);
 }
 return {ok:true,reason:'all_required_jobs_passed'};
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 try{const result=publicCIResult({event:process.env.CASE_EVENT,schedule:process.env.CASE_SCHEDULE,needs:JSON.parse(process.env.CASE_NEEDS)});console.log(result.reason);if(!result.ok)process.exitCode=1;}
 catch{console.error('invalid_aggregate_evidence');process.exitCode=1;}
}
