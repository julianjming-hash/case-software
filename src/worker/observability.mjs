import { alertEvent } from './alerts.mjs';
import { metric } from './metrics.mjs';
import { RPC_ALLOWLIST, rpcClient } from './rpc.mjs';
import { log } from './log.mjs';

export const ARCHIVE_LAG_ALERT_S = 120;
const rpcNames = new Set(RPC_ALLOWLIST);
const rpcCodes = new Set([null,'42501','PGRST202','timeout','network','redirect','invalid_response','40001','23505','23514','22023','22P02','PGRST116']);
const cronFailures = new Set(['invalid_heartbeat','invalid_ping_data','invalid_alert_data','alert_hook_failed','timeout','config','unavailable']);
const only = (value, fields) => Reflect.ownKeys(value).every(key => fields.includes(key));

/** Adapt trusted internal hooks; unknown fields are rejected before any backend sees them. */
export function normalizeAlert(input) {
  try {
    if (!input || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) return null;
    if (input.kind === 'forbidden' || input.kind === 'unavailable' || (input.kind === 'not_found' && input.code === 'PGRST202')) {
      if (!only(input,['kind','code','name']) || !rpcNames.has(input.name) || !rpcCodes.has(input.code)) return null;
      return {kind:input.kind !== 'unavailable' ? 'rpc_forbidden' : 'supabase_unavailable'};
    }
    if (input.kind === 'rpc_forbidden' && 'name' in input)
      return only(input,['kind','name']) && rpcNames.has(input.name) ? {kind:'rpc_forbidden'} : null;
    if (input.kind === 'archive_deleted_unsent') {
      if (!only(input,['kind','counts'])) return null;
      return alertEvent({kind:'delete_before_archive',counts:input.counts});
    }
    if (!('kind' in input) && only(input,['job','ageS']))
      return alertEvent({kind:'stale_heartbeat',job:input.job,ageS:input.ageS});
    if (input.kind === 'supabase_unreachable') return only(input,['kind']) ? {kind:'supabase_unavailable'} : null;
    if (cronFailures.has(input.kind)) return only(input,['kind']) ? {kind:'cron_failure'} : null;
    return alertEvent(input);
  } catch { return null; }
}

/** Optional hooks start immediately and retain work, but cannot delay or throw into room flows. */
export function createObserver(env = {}, ctx) {
  function alert(input, {required = false} = {}) {
    const event=normalizeAlert(input);
    if (event?.kind === 'rpc_forbidden' || event?.kind === 'supabase_unavailable') metric(env,{event:event.kind});
    if (event?.kind === 'delete_before_archive') metric(env,{event:event.kind,value:Object.values(event.counts).reduce((sum,n)=>sum+n,0)});
    let work;
    try {
      work=event && env.ALERTS ? Promise.resolve(env.ALERTS.get(env.ALERTS.idFromName('alerts'),{locationHint:'oc'}).send(event)) : Promise.resolve({ok:false});
    } catch { work=Promise.resolve({ok:false}); }
    const result=work.then(value=>value?.ok === true ? value : {ok:false},()=>({ok:false}));
    if (!required) {
      try { ctx?.waitUntil(result); } catch { /* retention is optional */ }
      return result;
    }
    return result.then(value=> {
      if (!value.ok) throw new Error('alert_delivery_failed');
      return value;
    });
  }
  function archiveLag(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return Promise.resolve({ok:false});
    metric(env,{event:'archive_lag_s',value});
    return value > ARCHIVE_LAG_ALERT_S ? alert({kind:'archive_lag_s',value}) : Promise.resolve({ok:true});
  }
  return Object.freeze({alert,archiveLag});
}

export const RPC_SLOW_MS = 2_000;
const failureReasons = new Set(['timeout','network','redirect','invalid_response','response_too_large']);
const failureReason = event => event.kind === 'forbidden' ? 'forbidden' : event.code === 'PGRST202' ? 'missing_function'
  : failureReasons.has(event.code) ? event.code : 'unavailable';

/** Request-scoped lazy proxy: unrelated local endpoints need no Supabase configuration.
 * Failures and slow calls are logged as fixed events (the 15:01 incident left Workers Logs empty); `trace`
 * marks the request deadline's stage. */
export function observedRpc(env, observer, options = {}, trace = null) {
  let client;
  const get=()=>client ??= rpcClient(env,{...options,onAlert:event=> {
    log('rpc_failure',{reason:failureReason(event)});
    return observer.alert(event);
  }});
  const call=(...args)=> {
    const client=get(); // a configuration error stays synchronous, as before
    const started=Date.now();
    if (trace) { trace.started++; trace.inflight++; }
    return client.call(...args).finally(()=> {
      if (trace) trace.inflight--;
      if (Date.now() - started > RPC_SLOW_MS) log('rpc_slow');
    });
  };
  // page() uses the client's internal call; each step that may fetch a page counts as in flight.
  async function* page(...args) {
    const rows=get().page(...args);
    for (;;) {
      if (trace) { trace.started++; trace.inflight++; }
      let step;
      try { step=await rows.next(); } finally { if (trace) trace.inflight--; }
      if (step.done) return step.value;
      yield step.value;
    }
  }
  return Object.freeze({call,page});
}
