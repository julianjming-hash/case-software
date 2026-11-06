import { turnstileSiteverifyUrl } from '../shared/urls.mjs';

export const TURNSTILE_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 65536;
const HOSTNAMES = Object.freeze({ production: 'case.iatrogenic.app', staging: 'case-staging.iatrogenic.app' });
const invalid = () => ({ ok: false, reason: 'invalid' });
const cancel = (reader) => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* optional cleanup */ } };

/** A challenge is demanded only where Turnstile is fully configured; otherwise callers fail open, as Join does. */
export function turnstileConfigured(env) {
  return ['production', 'staging'].includes(env?.CASE_ENV)
    && typeof env.TURNSTILE_SECRET_KEY === 'string' && env.TURNSTILE_SECRET_KEY.trim().length > 0
    && typeof env.TURNSTILE_SITE_KEY === 'string' && env.TURNSTILE_SITE_KEY.length > 0
    && env.TURNSTILE_SITE_KEY.length <= 128 && !/[^A-Za-z0-9_-]/.test(env.TURNSTILE_SITE_KEY);
}

/** Whole headers/body deadline; provider data is never returned or logged. Outages retain coarse join limits. */
export async function verifyTurnstile(token, ip, env, { fetchImpl = fetch, onMetric, timeoutMs = TURNSTILE_TIMEOUT_MS } = {}) {
  if (typeof token !== 'string' || !token.length || token.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(token)) return invalid();
  let metricSent = false;
  const unavailable = () => {
    if (metricSent) return { ok: true, reason: 'unavailable' };
    metricSent = true;
    try { Promise.resolve(onMetric?.({ event: 'turnstile_failopen' })).catch(() => {}); } catch { /* optional metrics */ }
    return { ok: true, reason: 'unavailable' };
  };
  const hostname = HOSTNAMES[env?.CASE_ENV];
  if (!hostname || typeof env?.TURNSTILE_SECRET_KEY !== 'string' || !env.TURNSTILE_SECRET_KEY.length) return unavailable();
  const delay = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TURNSTILE_TIMEOUT_MS) : TURNSTILE_TIMEOUT_MS;
  const controller = new AbortController(); let reader; let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); if (reader) cancel(reader); reject(Error('turnstile_deadline')); }, delay);
  });
  try {
    const task = (async () => {
      const body = { secret: env.TURNSTILE_SECRET_KEY, response: token };
      if (typeof ip === 'string' && ip.length && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip)) body.remoteip = ip;
      const response = await fetchImpl(turnstileSiteverifyUrl(), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok || !response.body) return unavailable();
      reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { cancel(reader); return unavailable(); }
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!result || typeof result.success !== 'boolean') return unavailable();
      if (!result.success) return Array.isArray(result['error-codes']) && result['error-codes'].includes('internal-error') ? unavailable() : invalid();
      return result.hostname === hostname && result.action === 'join' ? { ok: true, reason: 'verified' } : invalid();
    })();
    return await Promise.race([task, expiry]);
  } catch { return unavailable(); }
  finally { clearTimeout(timer); controller.abort(); }
}
