import { RECEIPTS } from '../shared/room-machine.mjs';
import { buildInfo } from './headers.mjs';

export const METRIC_EVENTS = Object.freeze(['room_created','room_ended','join_ok','join_fail',
  'transport_mode','transport_pin','sync_timeout','receipt','archive_lag_s','archive_fail',
  'delete_before_archive','turnstile_failopen','supabase_unavailable','rpc_forbidden','console_revoked']);
const events = new Set(METRIC_EVENTS);
const transports = new Set(['ws','long-poll','poll']);
const reasons = new Set([...RECEIPTS,'unknown_code','expired','rate_limited',
  'unavailable','timeout','network','forbidden','invalid','stalled']);
const fields = new Set(['event','value','transport','reason']);

/** Anonymous fixed dimensions only. User inputs and identifiers have no schema slot. */
export function metric(env, input) {
  try {
    if (!input || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => !fields.has(key)) || !events.has(input.event) ||
      (input.transport !== undefined && !transports.has(input.transport)) ||
      (input.reason !== undefined && !reasons.has(input.reason))) return false;
    const value = input.value === undefined ? 1 : input.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      typeof env?.METRICS?.writeDataPoint !== 'function') return false;
    const info = buildInfo(env);
    const result = env.METRICS.writeDataPoint({ blobs: [input.event,info.env,info.build,
      input.transport ?? '',input.reason ?? ''], doubles: [value], indexes: [info.env] });
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    return true;
  } catch { return false; }
}
