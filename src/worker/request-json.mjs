import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';

export const REQUEST_JSON_TIMEOUT_MS = BODY_READ_DEADLINE_MS;

/** Capped streamed JSON with one whole-upload deadline; cancellation never delays a fixed error. */
export async function readJson(request, maxBytes, { timeoutMs = REQUEST_JSON_TIMEOUT_MS } = {}) {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return { error: 'too_large' };
  if (!request.body) return { error: 'not_json' };
  const reader = request.body.getReader(); let closed = false, cancelled = false, timer;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* cleanup cannot replace an error */ }
  };
  const delay = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, REQUEST_JSON_TIMEOUT_MS) : REQUEST_JSON_TIMEOUT_MS;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { closed = true; cancel(); resolve({ error: 'request_timeout' }); }, delay);
  });
  const task = (async () => {
    try {
      const chunks = []; let n = 0;
      for (;;) {
        const item = await reader.read();
        if (closed) return { error: 'request_timeout' };
        const { done, value } = item;
        if (done) break;
        n += value.byteLength;
        if (n > maxBytes) { cancel(); return { error: 'too_large' }; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(n); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { body: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch { return { error: 'not_json' }; }
  })();
  try { return await Promise.race([task, deadline]); }
  finally { closed = true; clearTimeout(timer); }
}
