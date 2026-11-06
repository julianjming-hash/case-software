const events = new Set(['worker_error','cron_health','room_expiry_end_failed','facilitator_alert','alert_delivery_failed',
  'request_deadline','rpc_failure','rpc_slow']);
const reasons = new Set(['internal','config','timeout','unavailable','invalid_heartbeat','invalid_ping_data',
  'invalid_alert_data','healthcheck_failed','alert_hook_failed','supabase_unreachable','rpc_forbidden',
  'case_version_integrity','lockdown_alert',
  // request_deadline stages and rpc_failure kinds (2026-10-17 reliability audit).
  'rpc','before_rpc','after_rpc','network','redirect','invalid_response','response_too_large','forbidden','missing_function']);

/** One text-only log sink. Unknown fields and raw exception messages never reach it. */
export function log(event, fields = {}, sink = record => console.error(record)) {
  try {
    if (!events.has(event) || !fields || ![Object.prototype,null].includes(Object.getPrototypeOf(fields)) ||
      Reflect.ownKeys(fields).some(key => key !== 'reason') ||
      (fields.reason !== undefined && !reasons.has(fields.reason))) return false;
    sink(JSON.stringify({ event, ...(fields.reason === undefined ? {} : { reason: fields.reason }) }));
    return true;
  } catch { return false; }
}
