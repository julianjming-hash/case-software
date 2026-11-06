import { apiPath } from '../shared/urls.mjs';

const INTERVAL_MS = 1500;
const TIMEOUT_MS = 2500;
const transports = new Set(['ws','long-poll','poll']);
function transportEvent(input) {
  try {
    if (!input || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) return null;
    if (input.event === 'sync_timeout') return Reflect.ownKeys(input).length === 1 ? {event:input.event} : null;
    if (!['transport_mode','transport_pin'].includes(input.event) || !transports.has(input.transport) ||
      Reflect.ownKeys(input).some(key=>key !== 'event' && key !== 'transport')) return null;
    return {event:input.event,transport:input.transport};
  } catch { return null; }
}

/** A best-effort, memory-only beacon: no credential, identifier, network label or response content. */
export function createTelemetry({api,origin=globalThis.location?.origin,fetchImpl=globalThis.fetch,
  now=()=>globalThis.performance?.now() ?? Date.now(),timeoutMs=TIMEOUT_MS} = {}) {
  let enabled=false;
  try {
    const here=new URL(origin),target=new URL(api ?? origin,origin);
    enabled=['http:','https:'].includes(here.protocol) && target.origin === here.origin &&
      !target.username && !target.password && !target.search && !target.hash && typeof fetchImpl === 'function';
  } catch { /* foreign or unavailable origin disables the optional beacon */ }
  const bounded=Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS ? timeoutMs : TIMEOUT_MS;
  let closed=false;
  const slots=new Map(); // At most the three fixed event kinds, each with one latest pending value.
  const equal=(a,b)=>a?.event === b?.event && a?.transport === b?.transport;
  function drain(slot) {
    if (closed || slot.busy || !slot.pending) return;
    clearTimeout(slot.timer);slot.timer=null;
    const at=now(),delay=Math.max(0,slot.last+INTERVAL_MS-at);
    if (delay > 0) {slot.timer=setTimeout(()=>drain(slot),Math.min(INTERVAL_MS,delay));return;}
    const event=slot.pending;slot.pending=null;slot.current=event;slot.lastEvent=event;
    slot.last=at;slot.busy=true;
    const controller=new AbortController();let timer,finish;
    const deadline=new Promise(resolve=>{finish=resolve;timer=setTimeout(()=>{controller.abort();resolve();},bounded);});
    slot.cancel=()=>{clearTimeout(timer);controller.abort();finish();};
    const request=Promise.resolve().then(()=>closed ? undefined : fetchImpl(apiPath('telemetry'),{method:'POST',
      credentials:'omit',redirect:'manual',cache:'no-store',keepalive:true,referrerPolicy:'no-referrer',
      signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify(event)})).catch(()=>{});
    void Promise.race([request,deadline]).finally(()=> {
      slot.cancel();slot.cancel=null;slot.busy=false;slot.current=null;
      try {drain(slot);} catch {slot.pending=null;}
    });
  }
  const report=input=> {
    try {
      const event=transportEvent(input),at=now();
      if (!enabled || closed || !event || !Number.isFinite(at) || at < 0) return false;
      let slot=slots.get(event.event);
      if (!slot) {slot={last:-Infinity,busy:false,pending:null,timer:null,current:null,lastEvent:null};slots.set(event.event,slot);}
      if ((slot.busy || at-slot.last < INTERVAL_MS) && equal(event,slot.current ?? slot.lastEvent)) {
        slot.pending=null;clearTimeout(slot.timer);slot.timer=null;return false;
      }
      slot.pending=event;drain(slot);return true;
    } catch {return false;}
  };
  report.close=()=> {
    closed=true;
    for(const slot of slots.values()) {slot.pending=null;clearTimeout(slot.timer);slot.cancel?.();}
    slots.clear();
  };
  return report;
}
