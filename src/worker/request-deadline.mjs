// Every routed API request answers before the client's own ten-second deadline (2026-10-17 incident).
// Inner deadlines (JWKS 3 s, each RPC 5 s) compose serially, so a route with two or three slow upstream calls
// could still be waiting when accountRequest and the room transport abandon it at 10 s. The client then sees a
// hang, and Workers Logs shows only `canceled`. This outer deadline answers a fixed 503 first and logs which
// stage was stuck. It cannot stop work already started; a write it cuts off is uncertain to the client, exactly as
// a client timeout was before, and the clients already treat it so.
export const REQUEST_DEADLINE_MS = 8_000;
// Reading a request body finishes inside the request deadline, so a stalled upload keeps its specific 408.
export const BODY_READ_DEADLINE_MS = 7_000;

// Long-poll and the self-test wait by design; a WebSocket upgrade has its own connect timeout; an image upload
// has the Builder's 20 s client deadline.
const EXEMPT = [/^\/api\/v1\/sessions\/[0-9a-f-]{36}\/(?:updates|ws)$/, /^\/api\/v1\/check\//];
const UPLOAD = /^\/api\/v1\/builder\/workspaces\/[0-9a-f-]{36}\/media\/(?:display|phone|poster)$/;

/** The deadline for this request in ms, or null when it is exempt. Local runs may only shorten it. */
export function requestDeadlineMs(request, env = {}) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (!path.startsWith('/api/') || EXEMPT.some(re => re.test(path))) return null;
  if (request.method === 'PUT' && UPLOAD.test(path)) return null;
  const local = Number(env.CASE_REQUEST_DEADLINE_MS);
  return !env.CASE_ENV && Number.isSafeInteger(local) && local >= 100 && local < REQUEST_DEADLINE_MS ? local : REQUEST_DEADLINE_MS;
}

/** Request-scoped stage marks, written by the observed RPC client and read only when the deadline fires. */
export function requestTrace() {
  return { started: 0, inflight: 0 };
}
export const traceStage = trace => (trace.inflight > 0 ? 'rpc' : trace.started > 0 ? 'after_rpc' : 'before_rpc');

/** Resolves with `work` or, if the deadline passes first, with `onDeadline()`. The timer belongs to this request. */
export async function withRequestDeadline(work, ms, onDeadline) {
  if (ms === null) return work;
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(onDeadline()), ms); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}
