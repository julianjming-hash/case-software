import { metric } from './metrics.mjs';
import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';

const MAX_BYTES = 512;
const TIMEOUT_MS = BODY_READ_DEADLINE_MS;
const expired = Symbol('expired');
const transports = new Set(['ws','long-poll','poll']);
function event(input) {
  if (!input || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) return null;
  if (input.event === 'sync_timeout')
    return Reflect.ownKeys(input).length === 1 ? {event:input.event} : null;
  if (!['transport_mode','transport_pin'].includes(input.event) || !transports.has(input.transport) ||
    Reflect.ownKeys(input).some(key=>key !== 'event' && key !== 'transport')) return null;
  return {event:input.event,transport:input.transport};
}
const reply = (status, text) => new Response(text,{status});
const cancel = reader => {try {void Promise.resolve(reader.cancel()).catch(()=>{});} catch { /* contained */ }};

/** Public transport-only admission. Client input never reaches AlertDO or a server-event hook. */
export async function handleTelemetry(request, env, {timeoutMs = TIMEOUT_MS} = {}) {
  if (request.method !== 'POST') return reply(405,'method_not_allowed');
  const origin=request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply(403,'forbidden');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(415,'unsupported_media_type');
  if (!env.TELEMETRY_RATE_LIMITER) return reply(503,'unavailable');
  const bounded=Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS ? timeoutMs : TIMEOUT_MS;
  let timer,reader;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(expired),bounded);});
  const wait = work => Promise.race([Promise.resolve(work),deadline]);
  try {
    // This key is used only by the platform limiter; it never enters metrics, alerts or logs.
    const key=(request.headers.get('cf-connecting-ip') ?? 'unknown').slice(0,45);
    const admission=await wait(env.TELEMETRY_RATE_LIMITER.limit({key}));
    if (admission === expired) return reply(408,'request_timeout');
    if (admission?.success !== true) return reply(429,'rate_limited');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return reply(413,'too_large');
    if (!request.body) return reply(400,'invalid_telemetry');
    reader=request.body.getReader();
    const chunks=[];let size=0;
    for (;;) {
      const next=await wait(reader.read());
      if (next === expired) {cancel(reader);reader=null;return reply(408,'request_timeout');}
      if (next.done) break;
      size+=next.value.byteLength;
      if (size > MAX_BYTES) {cancel(reader);reader=null;return reply(413,'too_large');}
      chunks.push(next.value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let input;
    try {input=event(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
    catch {return reply(400,'invalid_telemetry');}
    if (!input) return reply(400,'invalid_telemetry');
    metric(env,input);
    return new Response(null,{status:204});
  } catch {if(reader) cancel(reader);return reply(503,'unavailable');}
  finally {clearTimeout(timer);}
}
